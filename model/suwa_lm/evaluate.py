"""Score an adapter, reproducibly.

The score is the point of the whole design. A hash proves *which* weights were
released; a score anyone can recompute proves they are worth serving. Both go
out with the release, and the hash goes on-chain, so a buyer can download the
adapter, check it against the chain, re-run this file, and get the same number.

That means no sampling, no wall-clock, no network: fixed held-out prompts and
greedy decoding only.

    turn    = in_character_rate * (1 - break_rate)
    session = memory_adherence * (1 - drift)
    score   = mean(turn, session)

The turn half asks whether one reply sounds like the character. The session
half asks the question the price is actually justified by: is the same person
still there twenty turns later, and do they remember what you told them?

A model can ace the turn score and fail the session score badly — that is the
familiar failure of a roleplay model that is charming for five minutes and a
stranger by turn thirty. Scoring only the first half would have hidden exactly
the thing we sell.

`in_character_rate` is the share of replies carrying the character's own voice
anchors; `break_rate` is the share that step outside it ("as an AI", naming the
system prompt). Both come from `characters.json`, so a SKU defines how it is
judged at the same time it defines how it speaks.
"""

from __future__ import annotations

import torch

from .catalog import Character
from .data import encode, render
from .lora import Backbone, greedy

# Bumped whenever the scoring changes shape. Scores from different versions are
# not comparable, and a release gate that compares them anyway would either
# block a good epoch or wave through a bad one.
EVAL_VERSION = 2

# Held out from every training source. Deliberately plain, so a reply can only
# be in character because the adapter made it so.
HELD_OUT = [
    "hey.",
    "what now?",
    "i don't know what to say.",
    "keep going.",
    "is this a good idea?",
    "what do you make of it?",
    "say something.",
    "and then?",
]


@torch.no_grad()
def held_out_loss(backbone: Backbone, character: Character, rows: list[dict]) -> float:
    """Masked cross-entropy on assistant tokens. Lower is better; goes on-chain."""
    if not rows:
        return 0.0
    backbone.model.eval()
    device = next(backbone.model.parameters()).device
    total, counted = 0.0, 0.0
    for ids, mask in encode(rows, backbone):
        ids, mask = ids[None].to(device), mask[None].to(device)
        logits = backbone.logits(ids)
        loss = torch.nn.functional.cross_entropy(
            logits[:, :-1].reshape(-1, logits.shape[-1]),
            ids[:, 1:].reshape(-1),
            reduction="none",
        )
        weights = mask[:, 1:].reshape(-1)
        total += float((loss * weights).sum())
        counted += float(weights.sum())
    return total / max(counted, 1.0)


@torch.no_grad()
def consistency(backbone: Backbone, character: Character, max_new_tokens: int = 48) -> dict:
    """Greedy-decode the held-out prompts and check the voice held."""
    in_character, broke = 0, 0
    samples = []
    for prompt in HELD_OUT:
        messages = [
            {"role": "system", "content": character.system},
            {"role": "user", "content": prompt},
            {"role": "assistant", "content": ""},
        ]
        _, prefix = render(messages, backbone.kind, backbone.tokenizer)
        reply = greedy(backbone, prefix, max_new_tokens=max_new_tokens)
        low = reply.lower()

        hit = any(a.lower() in low for a in character.in_character)
        broken = any(b.lower() in low for b in character.out_of_character)
        in_character += int(hit)
        broke += int(broken)
        samples.append({"prompt": prompt, "reply": reply, "in_character": hit, "broke": broken})

    n = len(HELD_OUT)
    rate = in_character / n
    break_rate = broke / n
    return {
        "in_character_rate": round(rate, 4),
        "break_rate": round(break_rate, 4),
        "score": round(rate * (1.0 - break_rate), 4),
        "samples": samples,
    }


# A scripted session. One turn plants a fact, a later one asks for it back, and
# the rest are ordinary conversation so drift has room to show up. Fixed, because
# a score anyone can reproduce cannot depend on what the prompts happened to be.
SESSION_SCRIPT = [
    "hey.",
    "my name is Kit.",
    "long day. the water was cold.",
    "what do you make of that?",
    "keep going.",
    "i'm not sure about any of this.",
    "and then?",
    "what's my name?",
]
MEMORY_PROBE_INDEX = len(SESSION_SCRIPT) - 1  # the last turn asks for the fact
MEMORY_FACT = "kit"


@torch.no_grad()
def session(backbone: Backbone, character: Character, max_new_tokens: int = 48) -> dict:
    """Run one scripted conversation and watch whether the character holds.

    The history is fed back in each turn, exactly as a client would, so this
    measures the model under the conditions it is actually sold for.
    """
    history: list[dict] = [{"role": "system", "content": character.system}]
    turns = []

    for i, prompt in enumerate(SESSION_SCRIPT):
        history.append({"role": "user", "content": prompt})
        messages = [*history, {"role": "assistant", "content": ""}]
        _, prefix = render(messages, backbone.kind, backbone.tokenizer)
        reply = greedy(backbone, prefix, max_new_tokens=max_new_tokens)
        history.append({"role": "assistant", "content": reply})

        low = reply.lower()
        turns.append({
            "prompt": prompt,
            "reply": reply,
            "in_character": any(a.lower() in low for a in character.in_character),
            "broke": any(b.lower() in low for b in character.out_of_character),
        })

    # Did it still know the name eight turns after being told?
    remembered = MEMORY_FACT in turns[MEMORY_PROBE_INDEX]["reply"].lower()

    # Drift: how much of the voice survives into the back half of the session.
    half = len(turns) // 2
    early = sum(t["in_character"] for t in turns[:half]) / max(half, 1)
    late = sum(t["in_character"] for t in turns[half:]) / max(len(turns) - half, 1)
    drift = max(0.0, early - late)

    memory_adherence = 1.0 if remembered else 0.0
    return {
        "memory_adherence": memory_adherence,
        "voice_early": round(early, 4),
        "voice_late": round(late, 4),
        "drift": round(drift, 4),
        "session_score": round(memory_adherence * (1.0 - drift), 4),
        "turns": turns,
    }


def run(backbone: Backbone, character: Character, holdout_rows: list[dict]) -> dict:
    turn = consistency(backbone, character)
    multi = session(backbone, character)

    # Weighted evenly on purpose. Sounding right once and staying the same
    # person are both necessary, and neither substitutes for the other.
    turn_score = turn["score"]
    composite = round((turn_score + multi["session_score"]) / 2, 4)

    return {
        "eval_version": EVAL_VERSION,
        "score": composite,
        "turn_score": turn_score,
        "session_score": multi["session_score"],
        "in_character_rate": turn["in_character_rate"],
        "break_rate": turn["break_rate"],
        "memory_adherence": multi["memory_adherence"],
        "drift": multi["drift"],
        "voice_early": multi["voice_early"],
        "voice_late": multi["voice_late"],
        "held_out_loss": round(held_out_loss(backbone, character, holdout_rows), 6),
        "samples": turn["samples"],
        "session_turns": multi["turns"],
    }
