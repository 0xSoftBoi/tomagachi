"""Walk-forward evaluation: one (fold, seed) per process.

A single held-out block and a single seed cannot tell skill from a lucky
quarter. This runs the whole pipeline independently on each fold — pretraining
the backbone on THAT FOLD'S TRAINING BLOCK ONLY, so the test period never
touches the representation — and writes one JSON per run for aggregation.

    python3 benchmark.py --fold 0 --n-folds 4 --seed 1 --out ../runs/bench
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import torch

from suwa_wm.dataset import HORIZON, TARGET
from suwa_wm.repro import pin_determinism
from finetune import build_windows, fit_har, report, train_model
from pretrain import run_pretrain


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=str, default="../data/market.npz")
    ap.add_argument("--fold", type=int, required=True)
    ap.add_argument("--n-folds", type=int, default=4)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--pretrain-steps", type=int, default=800)
    ap.add_argument("--steps", type=int, default=1200)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--ablation", action="store_true")
    ap.add_argument("--out", type=str, default="../runs/bench")
    args = ap.parse_args()

    pin_determinism(args.seed)
    w, symbols = build_windows(args.data)

    # The fold layout must be identical whichever lookahead is longer, so use
    # the larger of the two the pipeline needs.
    folds = w.walk_forward(args.n_folds, lookahead=max(HORIZON, TARGET))
    tr, va, te = folds[args.fold]
    tag = f"fold{args.fold}_seed{args.seed}"
    print(f"[{tag}] train={len(tr)} val={len(va)} test={len(te)} assets={w.A}")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    backbone = run_pretrain(
        w, args.pretrain_steps, args.batch, args.lr, args.seed,
        out / f"{tag}_backbone.pt", train_idx=tr,
    )

    har = fit_har(w, tr)
    model, _ = train_model(
        w, tr, va, args.steps, args.batch, args.lr, args.seed, backbone, quiet=True
    )
    metrics = report(f"[{tag}] pretrained", model, w, te, args.batch, har)

    result = {"fold": args.fold, "seed": args.seed, "n_folds": args.n_folds,
              "assets": w.A, "train": len(tr), "test": len(te),
              "pretrained": metrics}

    if args.ablation:
        scratch, _ = train_model(
            w, tr, va, args.steps, args.batch, args.lr, args.seed, None, quiet=True
        )
        result["scratch"] = report(f"[{tag}] scratch", scratch, w, te, args.batch, har)
        result["pretraining_gain_nll"] = result["scratch"]["nll"] - metrics["nll"]

    (out / f"{tag}.json").write_text(json.dumps(result, indent=2))
    torch.save({"model": model.state_dict(), "n_assets": w.A, "n_features": w.F,
                "symbols": symbols, "horizon": HORIZON}, out / f"{tag}_execution.pt")
    print(f"[{tag}] wrote {out}/{tag}.json")


if __name__ == "__main__":
    main()
