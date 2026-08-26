"""Train one character adapter and emit an auditable, sellable artifact.

Called by the creature's brain (agent/src/compute.ts) the same way the world
model was — locally in bootstrap mode, or on a GPU it paid for on-chain.

Outputs in --out:
  adapter.pt     LoRA weights only (kilobytes), plus optimizer state for resume
  manifest.json  { character, base, epoch, steps, held_out_loss, score,
                   sha256, file } -- sha256 goes on-chain via checkpoint(),
                   and `score` is the claim a buyer can re-derive by running
                   evaluate.py against the released file.

    python3 suwa_lm/train_lora.py --character suwa-tide --epoch 1 --tiny

Adapters warm-start from the previous epoch, so community compute compounds
into one improving character rather than a pile of restarts.
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

from suwa_lm import catalog as catalog_mod
from suwa_lm import data as data_mod
from suwa_lm import evaluate
from suwa_lm.lora import adapter_state_dict, apply_lora, load_adapter, load_base

BATCH = 4
HOLDOUT_FRACTION = 0.15


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--character", required=True, help="id from model/characters.json")
    ap.add_argument("--epoch", type=int, required=True)
    ap.add_argument("--steps", type=int, default=300)
    ap.add_argument("--out", type=str, default=None)
    ap.add_argument("--resume", type=str, default=None, help="previous adapter.pt")
    ap.add_argument("--base", type=str, default=None, help="override the catalog base model")
    ap.add_argument("--tiny", action="store_true", help="local byte-level backbone, no downloads")
    ap.add_argument("--examples", type=int, default=256)
    ap.add_argument("--rank", type=int, default=8)
    ap.add_argument("--alpha", type=float, default=16.0)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--teacher-url", type=str, default=os.environ.get("TEACHER_URL"))
    ap.add_argument("--teacher-model", type=str, default=os.environ.get("TEACHER_MODEL", ""))
    ap.add_argument("--push", type=str, default=None, help="HF repo id for the open release")
    args = ap.parse_args()

    cat = catalog_mod.load()
    character = cat.get(args.character)
    out = Path(args.out or f"runs/{character.id}-epoch-{args.epoch}")
    out.mkdir(parents=True, exist_ok=True)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    seed = args.seed if args.seed is not None else args.epoch
    torch.manual_seed(seed)
    generator = torch.Generator().manual_seed(seed)

    backbone = load_base(args.base or cat.base, tiny=args.tiny, device=device)
    trainable = apply_lora(backbone.model, r=args.rank, alpha=args.alpha)
    backbone.model.to(device)
    total = sum(p.numel() for p in backbone.model.parameters())
    print(
        f"SUWA-LM {character.id} epoch {args.epoch} on {device} | base={backbone.name} "
        f"| trainable {trainable:,} of {total:,} ({100 * trainable / total:.2f}%)"
    )

    rows, source = data_mod.build(
        character,
        args.examples,
        teacher_url=args.teacher_url,
        teacher_key=os.environ.get("TEACHER_KEY"),
        teacher_model=args.teacher_model,
    )
    split = max(1, int(len(rows) * HOLDOUT_FRACTION))
    holdout, train_rows = rows[:split], rows[split:]
    print(f"[data] {len(train_rows)} train / {len(holdout)} held out (source: {source})")
    encoded = data_mod.encode(train_rows, backbone)

    # Only the adapter moves. The base is frozen, which is what makes eight of
    # these shareable on one GPU at serving time.
    params = [p for p in backbone.model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=args.lr)

    resume = args.resume
    if resume is None and args.epoch > 1:
        prev = out.parent / f"{character.id}-epoch-{args.epoch - 1}" / "adapter.pt"
        if prev.exists():
            resume = str(prev)
    if resume:
        ckpt = torch.load(resume, map_location=device, weights_only=True)
        load_adapter(backbone.model, ckpt["adapter"])
        if "opt" in ckpt:
            opt.load_state_dict(ckpt["opt"])
        print(f"resumed from {resume}")

    backbone.model.train()
    ema = None
    step = 0
    while step < args.steps:
        for ids, mask in data_mod.batches(encoded, BATCH, generator):
            if step >= args.steps:
                break
            step += 1
            ids, mask = ids.to(device), mask.to(device)
            logits = backbone.logits(ids)
            loss_flat = torch.nn.functional.cross_entropy(
                logits[:, :-1].reshape(-1, logits.shape[-1]),
                ids[:, 1:].reshape(-1),
                reduction="none",
            )
            weights = mask[:, 1:].reshape(-1)
            loss = (loss_flat * weights).sum() / weights.sum().clamp(min=1.0)

            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            opt.step()

            step_loss = float(loss.detach())
            ema = step_loss if ema is None else 0.95 * ema + 0.05 * step_loss
            if step % 50 == 0 or step == args.steps:
                print(f"  step {step}/{args.steps} loss={ema:.4f}")

    scores = evaluate.run(backbone, character, holdout)
    print(
        f"[eval] score={scores['score']:.3f} "
        f"= turn {scores['turn_score']:.3f} (in-character {scores['in_character_rate']:.2f}, "
        f"breaks {scores['break_rate']:.2f}) + session {scores['session_score']:.3f} "
        f"(memory {scores['memory_adherence']:.0f}, drift {scores['drift']:.2f}) "
        f"| held-out loss={scores['held_out_loss']:.4f}"
    )

    adapter_path = out / "adapter.pt"
    torch.save(
        {
            "adapter": adapter_state_dict(backbone.model),
            "opt": opt.state_dict(),
            "character": character.id,
            "base": backbone.name,
            "rank": args.rank,
            "alpha": args.alpha,
            "epoch": args.epoch,
        },
        adapter_path,
    )

    sha256 = hashlib.sha256(adapter_path.read_bytes()).hexdigest()
    manifest = {
        "name": character.id,
        "character": character.id,
        "base": backbone.name,
        "backbone": backbone.kind,
        "epoch": args.epoch,
        "steps": args.steps,
        "data_source": source,
        "train_examples": len(train_rows),
        "final_loss": round(float(ema or 0.0), 6),
        "held_out_loss": scores["held_out_loss"],
        "score": scores["score"],
        "eval_version": scores["eval_version"],
        "turn_score": scores["turn_score"],
        "session_score": scores["session_score"],
        "in_character_rate": scores["in_character_rate"],
        "break_rate": scores["break_rate"],
        "memory_adherence": scores["memory_adherence"],
        "drift": scores["drift"],
        "sha256": sha256,
        "file": "adapter.pt",
        "license": "Apache-2.0",
        "license_effective_after_days": cat.license_delay_days,
        "reproduce": (
            f"python3 suwa_lm/train_lora.py --character {character.id} "
            f"--epoch {args.epoch} --steps {args.steps} --seed {seed}"
            + (" --tiny" if args.tiny else "")
        ),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    (out / "eval.json").write_text(json.dumps(scores, indent=2))
    print(f"artifact {adapter_path} sha256={sha256}")

    if args.push:
        _push(args.push, out, character.id, args.epoch)


def _push(repo: str, out: Path, character_id: str, epoch: int) -> None:
    """Open release. Runs on the 90-day lag in production -- see characters.json."""
    try:
        from huggingface_hub import HfApi

        api = HfApi(token=os.environ.get("HF_TOKEN"))
        api.create_repo(repo, exist_ok=True)
        for f in ("adapter.pt", "manifest.json", "eval.json"):
            api.upload_file(
                path_or_fileobj=str(out / f),
                path_in_repo=f"{character_id}/epochs/{epoch}/{f}",
                repo_id=repo,
            )
        print(f"pushed open weights to https://huggingface.co/{repo}")
    except Exception as e:  # a failed release must never eat the adapter
        print(f"hf push failed (adapter kept locally): {e}")


if __name__ == "__main__":
    main()
