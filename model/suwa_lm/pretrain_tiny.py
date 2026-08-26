"""Pretrain the shared tiny backbone once, so adapters have something to steer.

The fleet only works because many characters share one frozen base. That is
true of the hosted base (someone else paid to pretrain it) and it has to be
true here too: LoRA on a randomly initialised network can move ~1% of the
parameters and learns nothing worth scoring.

So the tiny path gets its own miniature of the same arrangement — one base
trained on every character's corpus at once, written to `runs/tiny-base.pt`,
then frozen. `train_lora.py --tiny` picks it up automatically.

    python3 suwa_lm/pretrain_tiny.py --steps 1500
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import torch

from suwa_lm import catalog as catalog_mod
from suwa_lm import data as data_mod
from suwa_lm.lora import TINY_BASE_PATH, Backbone, ByteTokenizer, TinyLM

BATCH = 8


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=1500)
    ap.add_argument("--examples", type=int, default=120, help="per character")
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", type=str, default=str(TINY_BASE_PATH))
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    generator = torch.Generator().manual_seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    cat = catalog_mod.load()
    model = TinyLM().to(device)
    backbone = Backbone(name="suwa-tiny-v0", model=model, tokenizer=ByteTokenizer(), kind="tiny")

    rows = []
    for character in cat.characters:
        rows.extend(data_mod.seed_corpus(character, args.examples))
    encoded = data_mod.encode(rows, backbone)
    print(f"tiny base: {len(encoded)} examples across {len(cat.characters)} characters on {device}")

    opt = torch.optim.AdamW(model.parameters(), lr=args.lr)
    model.train()
    ema, step = None, 0
    while step < args.steps:
        for ids, mask in data_mod.batches(encoded, BATCH, generator):
            if step >= args.steps:
                break
            step += 1
            ids, mask = ids.to(device), mask.to(device)
            logits = backbone.logits(ids)
            per_token = torch.nn.functional.cross_entropy(
                logits[:, :-1].reshape(-1, logits.shape[-1]),
                ids[:, 1:].reshape(-1),
                reduction="none",
            )
            weights = mask[:, 1:].reshape(-1)
            loss = (per_token * weights).sum() / weights.sum().clamp(min=1.0)

            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()

            value = float(loss.detach())
            ema = value if ema is None else 0.95 * ema + 0.05 * value
            if step % 250 == 0 or step == args.steps:
                print(f"  step {step}/{args.steps} loss={ema:.4f}")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"model": model.state_dict(), "steps": args.steps}, out)
    print(f"shared tiny base -> {out}")


if __name__ == "__main__":
    main()
