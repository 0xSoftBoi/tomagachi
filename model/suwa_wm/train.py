"""Epoch entrypoint — what an on-chain worker actually runs.

Called by agent/src/worker.ts with the job spec the contract published:

    python3 train.py --epoch 7 --steps 2000 --seed-hex 0x… --out runs/epoch-7 \
        [--base-uri … --base-hash …] [--push suwappu/suwa-wm]

Epoch 1 (no base weights) bootstraps: JEPA pretraining, then execution
fine-tuning. Every later epoch warm-starts from the model the chain names and
continues fine-tuning, so community compute compounds into one model.

Outputs into --out:
    checkpoint.pt   weights
    manifest.json   { sha256, dataset_sha256, metrics, … }

`sha256` is the canonical tensor hash the worker submits on-chain.

REPRODUCIBILITY: the seed comes from the contract, and the dataset is pinned by
hash. Two honest workers on the same seed AND the same dataset produce the same
weights. The dataset hash is recorded in the manifest so a challenger can see
immediately when someone trained on something else.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import torch

from suwa_wm.canonical import canonical_hash
from suwa_wm.repro import pin_determinism, seed_from_hex

REPO = Path(__file__).resolve().parents[2]
DEFAULT_DATA = REPO / "data" / "market.npz"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def resolve_base(base_uri: str | None, out: Path, epoch: int) -> str | None:
    """Find the checkpoint this epoch continues from."""
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
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--out", type=str, default=None)
    ap.add_argument("--data", type=str, default=str(DEFAULT_DATA))
    ap.add_argument("--data-sha256", type=str, default=None, help="pin the dataset")
    ap.add_argument("--base-uri", type=str, default=None)
    ap.add_argument("--base-hash", type=str, default=None)
    ap.add_argument("--push", type=str, default=None)
    args = ap.parse_args()

    out = Path(args.out or REPO / "runs" / f"epoch-{args.epoch}")
    out.mkdir(parents=True, exist_ok=True)

    seed = seed_from_hex(args.seed_hex) if args.seed_hex else (args.seed or args.epoch)
    pin_determinism(seed)

    data_path = Path(args.data)
    if not data_path.exists():
        raise SystemExit(
            f"no dataset at {data_path}. Build it with "
            f"`python3 model/suwa_wm/data.py --out {data_path}` — but note that a "
            f"freshly fetched dataset will NOT match other workers. Use the "
            f"dataset the epoch's base release published."
        )
    data_sha = sha256_file(data_path)
    if args.data_sha256 and data_sha != args.data_sha256.lower().removeprefix("0x"):
        raise SystemExit(
            f"dataset hash mismatch: have {data_sha}, epoch requires {args.data_sha256}"
        )
    print(f"dataset {data_path.name} sha256={data_sha[:12]}…")

    # Imported here so --help stays fast and torch is only loaded when training.
    from suwa_wm.data import load
    from suwa_wm.dataset import CONTEXT, HORIZON, Windows
    from suwa_wm.model import D_MODEL, SuwaExecutionModel

    sys.path.insert(0, str(REPO / "model"))
    from finetune import fit_har, report, train_model

    feats, price, symbols = load(str(data_path))
    w = Windows(feats, price, CONTEXT)
    tr, va, te = w.splits(lookahead=HORIZON)

    base = resolve_base(args.base_uri, out, args.epoch)
    if base:
        ckpt = torch.load(base, map_location="cpu", weights_only=False)
        actual = canonical_hash(ckpt["model"])
        if args.base_hash and actual != args.base_hash.lower().removeprefix("0x"):
            raise SystemExit(
                f"base weights do not match the chain: got {actual}, expected {args.base_hash}"
            )
        print(f"warm-starting from {base} (0x{actual[:12]}…)")
        model = SuwaExecutionModel(w.A, w.F, D_MODEL)
        model.load_state_dict(ckpt["model"])
        tmp = out / "_base.pt"
        torch.save({"backbone": model.backbone.state_dict()}, tmp)
        model, _ = train_model(w, tr, va, args.steps, 32, 1e-4, seed, str(tmp))
        tmp.unlink(missing_ok=True)
    elif args.base_hash:
        # Training from scratch when the chain named a base would silently
        # diverge from every honest worker and lose the stake on challenge.
        raise SystemExit(
            f"cannot obtain base weights 0x{args.base_hash.lower().removeprefix('0x')[:12]}… "
            f"from {args.base_uri!r}. Fetch them and retry, or do not claim this epoch."
        )
    else:
        print("genesis epoch: pretraining the world model, then fine-tuning")
        from pretrain import run_pretrain

        backbone = run_pretrain(w, max(args.steps // 2, 250), 32, 3e-4, seed, out / "backbone.pt")
        model, _ = train_model(w, tr, va, max(args.steps // 2, 250), 32, 3e-4, seed, str(backbone))

    print("\ntest set:")
    # Fit the HAR benchmark on the training split so every on-chain epoch
    # records how it compares with the standard volatility model, not just
    # with the naive one.
    metrics = report("epoch", model, w, te, 32, fit_har(w, tr))

    state = model.state_dict()
    weights_hash = canonical_hash(state)
    torch.save(
        {"model": state, "epoch": args.epoch, "n_assets": w.A, "n_features": w.F,
         "d_model": D_MODEL, "symbols": symbols, "horizon": HORIZON},
        out / "checkpoint.pt",
    )
    manifest = {
        "name": "suwa-wm",
        "epoch": args.epoch,
        "steps": args.steps,
        "seed": f"0x{seed:08x}",
        "seed_hex": args.seed_hex,
        "dataset": data_path.name,
        "dataset_sha256": data_sha,
        "symbols": symbols,
        "horizon_hours": HORIZON,
        # final_loss is what goes on-chain as the epoch's loss: test NLL,
        # shifted positive so it fits the contract's unsigned lossMilli.
        "final_loss": round(metrics["nll"] + 10.0, 6),
        "metrics": metrics,
        "sha256": weights_hash,
        "weights_sha256": weights_hash,
        "file": "checkpoint.pt",
        "torch": torch.__version__,
        "license": "Apache-2.0",
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nweights hash 0x{weights_hash}")

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
            # Ship the dataset too, or the next worker cannot reproduce this.
            api.upload_file(
                path_or_fileobj=str(data_path),
                path_in_repo=f"epochs/{args.epoch}/{data_path.name}",
                repo_id=args.push,
            )
            print(f"released open weights: https://huggingface.co/{args.push}")
        except Exception as e:
            print(f"hf push failed (weights kept locally): {e}")


if __name__ == "__main__":
    main()
