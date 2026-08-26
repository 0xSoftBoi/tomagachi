#!/usr/bin/env python3
"""Pick the newest adapter per character, export it, and print the vLLM flags.

The creature retrains continuously, so `runs/` accumulates epochs. This walks
the catalog, takes the highest epoch for each character, converts it into the
PEFT layout vLLM loads, and writes everything under `serving/`.

    python3 deploy/vllm/prepare.py                  # export + print the flags
    python3 deploy/vllm/prepare.py --print-only     # just the flags

Adapters that fail to export are reported and skipped rather than taking the
whole fleet down with them: four characters serving beats five not serving.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "model"))

from suwa_lm import catalog as catalog_mod  # noqa: E402
from suwa_lm.export_peft import to_peft, write_weights  # noqa: E402

EPOCH_DIR = re.compile(r"^(?P<character>.+)-epoch-(?P<epoch>\d+)$")


def latest_runs(runs_dir: Path, character_ids: list[str]) -> dict[str, Path]:
    """Highest epoch per character. Directory names are the only index we need."""
    best: dict[str, tuple[int, Path]] = {}
    if not runs_dir.exists():
        return {}
    for entry in runs_dir.iterdir():
        m = EPOCH_DIR.match(entry.name)
        if not m or not (entry / "adapter.pt").exists():
            continue
        character = m.group("character")
        if character not in character_ids:
            continue
        epoch = int(m.group("epoch"))
        if character not in best or epoch > best[character][0]:
            best[character] = (epoch, entry)
    return {c: path for c, (_, path) in best.items()}


def export(run: Path, out_dir: Path, base: str) -> None:
    import json

    import torch

    ckpt = torch.load(run / "adapter.pt", map_location="cpu", weights_only=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    weights_file = write_weights(to_peft(ckpt["adapter"]), out_dir)
    (out_dir / "adapter_config.json").write_text(json.dumps({
        "peft_type": "LORA",
        "task_type": "CAUSAL_LM",
        "base_model_name_or_path": base,
        "r": int(ckpt.get("rank", 8)),
        "lora_alpha": float(ckpt.get("alpha", 16.0)),
        "lora_dropout": 0.0,
        "bias": "none",
        "fan_in_fan_out": False,
        "inference_mode": True,
        "target_modules": ["q_proj", "v_proj"],
    }, indent=2))
    (out_dir / "suwa_provenance.json").write_text(json.dumps({
        "character": ckpt.get("character"),
        "epoch": ckpt.get("epoch"),
        "source_run": str(run),
        "weights_file": weights_file,
    }, indent=2))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", default=str(REPO / "runs"))
    ap.add_argument("--serving", default=str(REPO / "serving"))
    ap.add_argument("--print-only", action="store_true")
    args = ap.parse_args()

    cat = catalog_mod.load()
    ids = [c.id for c in cat.characters]
    found = latest_runs(Path(args.runs), ids)

    missing = [c for c in ids if c not in found]
    if missing:
        print(f"# no trained adapter yet for: {', '.join(missing)}", file=sys.stderr)
    if not found:
        raise SystemExit(
            f"no adapters in {args.runs} — train one first:\n"
            f"  python3 model/suwa_lm/train_lora.py --character {ids[0]} --epoch 1"
        )

    serving = Path(args.serving)
    modules = []
    for character in ids:
        run = found.get(character)
        if run is None:
            continue
        out_dir = serving / character
        if not args.print_only:
            try:
                export(run, out_dir, cat.base)
                print(f"# {character}: {run.name} -> {out_dir}", file=sys.stderr)
            except Exception as e:
                print(f"# {character}: export failed ({e}) — skipping", file=sys.stderr)
                continue
        modules.append(f"{character}={out_dir}")

    max_rank = 16  # room for r=8 today and a rank bump without a restart
    print(" ".join([
        "--enable-lora",
        f"--max-loras {len(modules)}",
        f"--max-lora-rank {max_rank}",
        "--lora-modules",
        *modules,
    ]))


if __name__ == "__main__":
    main()
