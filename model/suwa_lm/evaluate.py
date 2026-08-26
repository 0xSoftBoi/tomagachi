"""Score an adapter, reproducibly.

The score is the point of the whole design. A hash proves *which* weights were
released; a score anyone can recompute proves they are worth serving. Both go
out with the release, and the hash goes on-chain, so a buyer can download the
adapter, check it against the chain, re-run this file, and get the same number.

That means no sampling, no wall-clock, no network: fixed held-out prompts and
greedy decoding only.

    score = in_character_rate * (1 - break_rate)

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


def run(backbone: Backbone, character: Character, holdout_rows: list[dict]) -> dict:
    result = consistency(backbone, character)
    result["held_out_loss"] = round(held_out_loss(backbone, character, holdout_rows), 6)
    return result
