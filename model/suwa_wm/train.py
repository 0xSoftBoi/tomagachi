"""Train one epoch of SUWA-WM against an on-chain job spec.

Run by whoever claimed the epoch. The seed is NOT chosen here — it comes from
the contract, so any other worker can reproduce this exact run and challenge a
dishonest result. Everything that could introduce nondeterminism is pinned.

    python3 train.py --epoch 7 --steps 2000 --seed-hex 0xabc… --out runs/epoch-7

Outputs into --out:
    checkpoint.pt   weights (+ optimizer state, so the next epoch warm-starts)
    manifest.json   { epoch, steps, seed, final_loss, weights_sha256, … }

`weights_sha256` is the canonical tensor hash the worker submits on-chain.
Recompute it from any released file with `python3 model/verify.py`.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import torch

from suwa_wm.canonical import canonical_hash
from suwa_wm.model import SuwaWM
from suwa_wm.world import rollout_batch

BATCH = 16
SEQ = 16


def pin_determinism(seed: int) -> None:
    """Everything two honest workers must agree on."""
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    os.environ.setdefault("PYTHONHASHSEED", str(seed))
    # Thread scheduling is a nondeterminism source in reductions; pin to one.
    torch.set_num_threads(1)
    torch.use_deterministic_algorithms(True)
    torch.manual_seed(seed)
    random.seed(seed)
    np.random.seed(seed % (2**32))


def seed_from_hex(seed_hex: str) -> int:
    return int(seed_hex.lower().removeprefix("0x"), 16) % (2**31 - 1)


def resolve_base(base_uri: str | None, out: Path, epoch: int) -> str | None:
    """Find the checkpoint this epoch warm-starts from."""
    if not base_uri:
        prev = out.parent / f"epoch-{epoch - 1}" / "checkpoint.pt"
        return str(prev) if prev.exists() else None

    if base_uri.startswith("run://"):
        prev = out.parent / base_uri.removeprefix("run://") / "checkpoint.pt"
        return str(prev) if prev.exists() else None

    if "huggingface.co/" in base_uri:
        repo = base_uri.split("huggingface.co/", 1)[1].strip("/")
        try:
            from huggingface_hub import hf_hub_download

            return hf_hub_download(
                repo_id=repo,
                filename=f"epochs/{epoch - 1}/checkpoint.pt",
                token=os.environ.get("HF_TOKEN") or None,
            )
        except Exception as e:
            print(f"could not fetch base weights from {repo}: {e}")
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--epoch", type=int, required=True)
    ap.add_argument("--steps", type=int, default=2000)
    ap.add_argument("--seed-hex", type=str, default=None, help="job seed from the contract")
    ap.add_argument("--seed", type=int, default=None, help="raw int seed (local runs)")
    ap.add_argument("--out", type=str, default=None)
    ap.add_argument("--base-uri", type=str, default=None, help="where the previous release lives")
    ap.add_argument("--base-hash", type=str, default=None, help="expected canonical hash of the base")
    ap.add_argument("--push", type=str, default=None, help="HF repo id, e.g. suwappu/suwa-wm")
    args = ap.parse_args()

    out = Path(args.out or f"runs/epoch-{args.epoch}")
    out.mkdir(parents=True, exist_ok=True)

    if args.seed_hex:
        seed = seed_from_hex(args.seed_hex)
    elif args.seed is not None:
        seed = args.seed
    else:
        seed = args.epoch
    pin_determinism(seed)

    # CPU only: GPU kernels are not bit-reproducible across devices, and this
    # model is small enough that CPU keeps every worker on equal footing.
    device = torch.device("cpu")
    model = SuwaWM().to(device)
    opt = torch.optim.Adam(model.parameters(), lr=3e-4)

    base = resolve_base(args.base_uri, out, args.epoch)
    if base:
        ckpt = torch.load(base, map_location=device, weights_only=True)
        actual = canonical_hash(ckpt["model"])
        if args.base_hash and actual != args.base_hash.lower().removeprefix("0x"):
            raise SystemExit(
                f"base weights do not match the chain: got {actual}, expected {args.base_hash}"
            )
        model.load_state_dict(ckpt["model"])
        opt.load_state_dict(ckpt["opt"])
        print(f"warm-started from {base} (0x{actual[:12]}…)")
    elif args.base_hash:
        # The chain says this epoch continues from an existing model. Training
        # from scratch instead would silently produce a divergent result and
        # get an honest worker slashed on challenge. Refuse to run.
        raise SystemExit(
            f"cannot obtain base weights 0x{args.base_hash.lower().removeprefix('0x')[:12]}… "
            f"from {args.base_uri!r}. Fetch them and retry, or do not claim this epoch."
        )
    else:
        print("no base weights — training from scratch")

    rng = np.random.default_rng(seed)
    print(f"SUWA-WM epoch {args.epoch}: {args.steps} steps, seed 0x{seed:08x}, cpu")

    ema = None
    for step in range(1, args.steps + 1):
        O, A, R, N = rollout_batch(BATCH, SEQ, rng)
        total, metrics = model.loss(
            torch.from_numpy(O), torch.from_numpy(A), torch.from_numpy(R), torch.from_numpy(N)
        )
        opt.zero_grad()
        total.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 10.0)
        opt.step()

        ema = metrics["loss"] if ema is None else 0.98 * ema + 0.02 * metrics["loss"]
        if step % 100 == 0 or step == args.steps:
            print(
                f"  step {step}/{args.steps} loss={ema:.4f} "
                f"(pred={metrics['pred']:.4f} reward={metrics['reward']:.4f})"
            )

    state = model.state_dict()
    weights_hash = canonical_hash(state)
    torch.save({"model": state, "opt": opt.state_dict(), "epoch": args.epoch}, out / "checkpoint.pt")

    manifest = {
        "name": "suwa-wm",
        "epoch": args.epoch,
        "steps": args.steps,
        "seed": f"0x{seed:08x}",
        "seed_hex": args.seed_hex,
        "final_loss": round(float(ema or 0.0), 6),
        # The value submitted on-chain. Verify with model/verify.py.
        "sha256": weights_hash,
        "weights_sha256": weights_hash,
        "file": "checkpoint.pt",
        "torch": torch.__version__,
        "license": "Apache-2.0",
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"weights hash 0x{weights_hash}")

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
            print(f"released open weights: https://huggingface.co/{args.push}")
        except Exception as e:  # a failed release must not destroy the run
            print(f"hf push failed (weights kept locally): {e}")


if __name__ == "__main__":
    main()
