"""Convert a trained adapter into the PEFT layout vLLM loads.

`train_lora.py` writes `adapter.pt` — our own state dict, plus optimizer state
for warm-starting the next epoch. vLLM wants a directory with
`adapter_config.json` at its root and PEFT-named weights, so this is the
bridge between what the creature trains and what the shop serves.

The whole conversion is a rename:

    <module>.a.weight  ->  base_model.model.<module>.lora_A.weight
    <module>.b.weight  ->  base_model.model.<module>.lora_B.weight

    python3 suwa_lm/export_peft.py runs/suwa-tide-epoch-3 --out serving/suwa-tide

The hash of the released `adapter.pt` is what goes on-chain; this directory is
a serving artifact derived from it, so the export records the source sha256 in
`suwa_provenance.json` and anyone can check the two match.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import torch

from suwa_lm.lora import DEFAULT_TARGETS

DEFAULT_ALPHA = 16.0


def to_peft(state: dict[str, torch.Tensor]) -> dict[str, torch.Tensor]:
    out: dict[str, torch.Tensor] = {}
    for key, tensor in state.items():
        if key.endswith(".a.weight"):
            name = key[: -len(".a.weight")] + ".lora_A.weight"
        elif key.endswith(".b.weight"):
            name = key[: -len(".b.weight")] + ".lora_B.weight"
        else:
            continue  # not a LoRA weight; nothing for PEFT to do with it
        # PEFT wraps the base model twice: once for the tuner, once for the LM.
        out["base_model.model." + name] = tensor.contiguous()
    if not out:
        raise ValueError("no LoRA weights found — is this an adapter.pt?")
    return out


def write_weights(peft_state: dict[str, torch.Tensor], out_dir: Path) -> str:
    """safetensors when available (what vLLM prefers), .bin otherwise."""
    try:
        from safetensors.torch import save_file

        save_file(peft_state, str(out_dir / "adapter_model.safetensors"))
        return "adapter_model.safetensors"
    except ImportError:
        torch.save(peft_state, out_dir / "adapter_model.bin")
        return "adapter_model.bin"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("run", help="a training run directory containing adapter.pt")
    ap.add_argument("--out", required=True, help="directory vLLM will load")
    ap.add_argument("--base", default=None, help="override base_model_name_or_path")
    args = ap.parse_args()

    run = Path(args.run)
    adapter_path = run / "adapter.pt"
    if not adapter_path.exists():
        raise SystemExit(f"no adapter.pt in {run}")

    ckpt = torch.load(adapter_path, map_location="cpu", weights_only=True)
    peft_state = to_peft(ckpt["adapter"])

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    weights_file = write_weights(peft_state, out_dir)

    base = args.base or ckpt.get("base")
    rank = int(ckpt.get("rank", 8))
    alpha = float(ckpt.get("alpha", DEFAULT_ALPHA))
    (out_dir / "adapter_config.json").write_text(json.dumps({
        "peft_type": "LORA",
        "task_type": "CAUSAL_LM",
        "base_model_name_or_path": base,
        "r": rank,
        "lora_alpha": alpha,
        "lora_dropout": 0.0,
        "bias": "none",
        "fan_in_fan_out": False,
        "inference_mode": True,
        "target_modules": list(DEFAULT_TARGETS),
    }, indent=2))

    # The chain records the hash of adapter.pt, not of this directory. Keeping
    # the link explicit is what lets a buyer tie what they are served back to
    # the on-chain checkpoint.
    manifest = {}
    manifest_path = run / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
    (out_dir / "suwa_provenance.json").write_text(json.dumps({
        "character": ckpt.get("character"),
        "epoch": ckpt.get("epoch"),
        "base": base,
        "source_file": "adapter.pt",
        "source_sha256": hashlib.sha256(adapter_path.read_bytes()).hexdigest(),
        "manifest_sha256": manifest.get("sha256"),
        "score": manifest.get("score"),
        "held_out_loss": manifest.get("held_out_loss"),
        "weights_file": weights_file,
    }, indent=2))

    print(
        f"{ckpt.get('character')} epoch {ckpt.get('epoch')} -> {out_dir} "
        f"({len(peft_state)} tensors, r={rank}, alpha={alpha:g}, {weights_file})"
    )


if __name__ == "__main__":
    main()
