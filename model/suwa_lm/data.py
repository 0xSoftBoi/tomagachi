"""Where an adapter's training data comes from, in order of preference.

1. **Collected** — `model/data/<character>.jsonl`, one JSON object per line with
   a `messages` array. This is the product path: real sessions, community
   preference labels, anything a NOM vote decided was in character.
2. **Distilled** — generated against any OpenAI-compatible teacher endpoint
   (`--teacher-url`). This is how a new SKU bootstraps before it has traffic.
3. **Seed** — a deterministic template corpus built from the character's own
   spec, below. It teaches the model the *shape* of the character and nothing
   else. It exists so the pipeline runs end to end with no network and no data;
   it is not a product dataset and an adapter trained only on it is a smoke test.

Loss is masked to assistant tokens: the model is graded on what it says, never
on the prompt it was handed.
"""

from __future__ import annotations

import json
from pathlib import Path

import torch

from .catalog import Character

DATA_DIR = Path(__file__).resolve().parents[1] / "data"

# Openers the seed corpus answers. Deliberately generic -- the character's voice
# has to come from the reply, not from a matched question.
_OPENERS = [
    "hey, you around?",
    "what happens next?",
    "i had a long day.",
    "tell me where we are.",
    "should i go left or right?",
    "are you still there?",
    "what do you think of that?",
    "i'm not sure about this.",
    "go on.",
    "what would you do?",
]


def _seed_reply(character: Character, opener: str, i: int) -> str:
    """A reply in the character's shape, assembled from its own anchors.

    Every anchor appears often enough for the eval to be able to detect whether
    training moved the model toward this voice or away from it.
    """
    anchors = character.in_character
    a, b = anchors[i % len(anchors)], anchors[(i + 1) % len(anchors)]
    voice = character.voice[i % len(character.voice)] if character.voice else "steady"
    return f"{a.capitalize()}. {b} — {voice}, and the thread from before still holds."


def seed_corpus(character: Character, n: int) -> list[dict]:
    return [
        {
            "messages": [
                {"role": "system", "content": character.system},
                {"role": "user", "content": _OPENERS[i % len(_OPENERS)]},
                {"role": "assistant", "content": _seed_reply(character, _OPENERS[i % len(_OPENERS)], i)},
            ]
        }
        for i in range(n)
    ]


def collected(character: Character) -> list[dict]:
    path = DATA_DIR / f"{character.id}.jsonl"
    if not path.exists():
        return []
    rows = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def distil(character: Character, n: int, teacher_url: str, teacher_key: str | None,
           teacher_model: str) -> list[dict]:
    """Ask a teacher endpoint for in-character replies to the seed openers.

    Any OpenAI-compatible base URL works, OpenRouter included. Failures are not
    fatal: a short dataset beats a crashed training run.
    """
    import urllib.error
    import urllib.request

    rows: list[dict] = []
    for i in range(n):
        opener = _OPENERS[i % len(_OPENERS)]
        payload = json.dumps({
            "model": teacher_model,
            "messages": [
                {"role": "system", "content": character.system},
                {"role": "user", "content": opener},
            ],
            "temperature": 0.9,
            "max_tokens": 160,
        }).encode()
        headers = {"content-type": "application/json"}
        if teacher_key:
            headers["authorization"] = f"Bearer {teacher_key}"
        req = urllib.request.Request(
            teacher_url.rstrip("/") + "/chat/completions", data=payload, headers=headers
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = json.loads(r.read())
            reply = body["choices"][0]["message"]["content"].strip()
        except (urllib.error.URLError, KeyError, ValueError, TimeoutError) as e:
            print(f"[data] teacher call {i + 1}/{n} failed ({e}); stopping distillation")
            break
        rows.append({
            "messages": [
                {"role": "system", "content": character.system},
                {"role": "user", "content": opener},
                {"role": "assistant", "content": reply},
            ]
        })
    return rows


def build(character: Character, n: int, teacher_url: str | None = None,
          teacher_key: str | None = None, teacher_model: str = "") -> tuple[list[dict], str]:
    """Best available source, and the name of the one we used (goes in the manifest)."""
    rows = collected(character)
    if rows:
        return rows[:n] if n else rows, "collected"
    if teacher_url:
        rows = distil(character, n, teacher_url, teacher_key, teacher_model)
        if rows:
            return rows, "distilled"
    return seed_corpus(character, n), "seed"


def render(messages: list[dict], kind: str, tokenizer) -> tuple[str, str]:
    """Return (full_text, prompt_prefix) so the mask can be placed exactly."""
    if kind == "hosted" and hasattr(tokenizer, "apply_chat_template"):
        prompt = tokenizer.apply_chat_template(
            messages[:-1], tokenize=False, add_generation_prompt=True
        )
        return prompt + messages[-1]["content"], prompt

    parts = [f"<|{m['role']}|>{m['content']}\n" for m in messages[:-1]]
    prompt = "".join(parts) + "<|assistant|>"
    return prompt + messages[-1]["content"], prompt


def encode(rows: list[dict], backbone, max_len: int = 512) -> list[tuple[torch.Tensor, torch.Tensor]]:
    """(input_ids, loss_mask) per example. Mask is 1 only on assistant tokens.

    Over-long examples are trimmed from the *front*. A system prompt is easily
    longer than the window on the tiny backbone, and trimming from the back
    would drop the assistant span -- leaving an all-zero mask and a loss of
    exactly zero, which trains nothing and looks like success.
    """
    tok = backbone.tokenizer
    out = []
    for row in rows:
        full, prompt = render(row["messages"], backbone.kind, tok)
        if backbone.kind == "hosted":
            ids = tok(full, return_tensors="pt")["input_ids"][0].tolist()
            plen = len(tok(prompt)["input_ids"])
        else:
            ids = tok.encode(full, bos=True) + [tok.eos_id]
            plen = len(tok.encode(prompt, bos=True))

        if len(ids) > max_len:
            cut = len(ids) - max_len
            ids = ids[cut:]
            plen = max(plen - cut, 0)

        answer_len = len(ids) - plen
        if answer_len <= 0:
            continue  # nothing of the reply survived; the example teaches nothing
        mask = [0.0] * plen + [1.0] * answer_len
        out.append((torch.tensor(ids), torch.tensor(mask, dtype=torch.float32)))
    if not out:
        raise ValueError("every example was longer than the context window")
    return out


def batches(encoded, batch_size: int, generator: torch.Generator):
    """Padded batches in a shuffled order fixed by `generator`, so runs replay."""
    order = torch.randperm(len(encoded), generator=generator).tolist()
    for start in range(0, len(order), batch_size):
        chunk = [encoded[i] for i in order[start:start + batch_size]]
        width = max(len(ids) for ids, _ in chunk)
        ids = torch.zeros(len(chunk), width, dtype=torch.long)
        mask = torch.zeros(len(chunk), width)
        for row, (seq, m) in enumerate(chunk):
            ids[row, : len(seq)] = seq
            mask[row, : len(m)] = m
        yield ids, mask
