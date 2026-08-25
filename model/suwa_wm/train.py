"""Train one epoch of SUWA-WM and emit an auditable artifact.

Called by the creature's brain (agent/src/compute.ts) — locally in bootstrap
mode, or on a decentralized GPU worker it paid on-chain.

Outputs in --out:
  checkpoint.pt   model weights (+ optimizer state for warm resume)
  manifest.json   { epoch, steps, final_loss, sha256, file } — the sha256 is
                  exactly what the brain posts on-chain via checkpoint().

Optionally pushes the artifact to Hugging Face with --push <repo> (HF_TOKEN
env), releasing the weights to the community under Apache-2.0.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

# Allow running as a plain script (`python3 model/suwa_wm/train.py`) from anywhere.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import torch

from suwa_wm.model import SuwaWM
from suwa_wm.world import rollout_batch

BATCH = 16
SEQ = 16


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--epoch", type=int, required=True)
    ap.add_argument("--steps", type=int, default=2000)
    ap.add_argument("--out", type=str, default=None)
    ap.add_argument("--resume", type=str, default=None, help="previous checkpoint.pt")
    ap.add_argument("--push", type=str, default=None, help="HF repo id, e.g. suwappu/suwa-wm")
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()

    out = Path(args.out or f"runs/suwa-wm-epoch-{args.epoch}")
    out.mkdir(parents=True, exist_ok=True)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    seed = args.seed if args.seed is not None else args.epoch
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)

    model = SuwaWM().to(device)
    opt = torch.optim.Adam(model.parameters(), lr=3e-4)

    # Warm-start from the previous epoch if available, so community compute
    # accumulates into one continuously improving model.
    resume = args.resume
    if resume is None and args.epoch > 1:
        prev = out.parent / f"suwa-wm-epoch-{args.epoch - 1}" / "checkpoint.pt"
        if prev.exists():
            resume = str(prev)
    if resume:
        ckpt = torch.load(resume, map_location=device, weights_only=True)
        model.load_state_dict(ckpt["model"])
        opt.load_state_dict(ckpt["opt"])
        print(f"resumed from {resume}")

    print(f"SUWA-WM epoch {args.epoch}: {args.steps} steps on {device}")
    ema_loss = None
    for step in range(1, args.steps + 1):
        O, A, R, N = rollout_batch(BATCH, SEQ, rng)
        obs = torch.from_numpy(O).to(device)
        actions = torch.from_numpy(A).to(device)
        rewards = torch.from_numpy(R).to(device)
        next_obs = torch.from_numpy(N).to(device)

        total, metrics = model.loss(obs, actions, rewards, next_obs)
        opt.zero_grad()
        total.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 10.0)
        opt.step()

        ema_loss = metrics["loss"] if ema_loss is None else 0.98 * ema_loss + 0.02 * metrics["loss"]
        if step % 100 == 0 or step == args.steps:
            print(
                f"  step {step}/{args.steps} loss={ema_loss:.4f} "
                f"(pred={metrics['pred']:.4f} reward={metrics['reward']:.4f})"
            )

    ckpt_path = out / "checkpoint.pt"
    torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "epoch": args.epoch}, ckpt_path)

    sha256 = hashlib.sha256(ckpt_path.read_bytes()).hexdigest()
    manifest = {
        "name": "suwa-wm",
        "epoch": args.epoch,
        "steps": args.steps,
        "final_loss": round(float(ema_loss or 0.0), 6),
        "sha256": sha256,
        "file": "checkpoint.pt",
        "license": "Apache-2.0",
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"artifact {ckpt_path} sha256={sha256}")

    if args.push:
        try:
            from huggingface_hub import HfApi

            api = HfApi(token=os.environ.get("HF_TOKEN"))
            api.create_repo(args.push, exist_ok=True)
            for f in ("checkpoint.pt", "manifest.json"):
                api.upload_file(
                    path_or_fileobj=str(out / f),
                    path_in_repo=f"epochs/{args.epoch}/{f}",
                    repo_id=args.push,
                )
            print(f"pushed open weights to https://huggingface.co/{args.push}")
        except Exception as e:  # release failures must not eat the checkpoint
            print(f"hf push failed (weights kept locally): {e}")


if __name__ == "__main__":
    main()
