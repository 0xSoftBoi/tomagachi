"""Pretrain SUWA-WM on real market history (self-supervised, no labels).

JEPA: encode a 48h context window, predict the *representation* of the 24h
that follows, as produced by an EMA copy of the encoder. Variance and
covariance regularisers stop the trivial constant solution.

    python3 pretrain.py --data ../data/market.npz --steps 3000 --out ../runs/pretrain

Produces backbone weights the execution fine-tune starts from.
"""

from __future__ import annotations

import argparse
import json
import sys
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
import torch

from suwa_wm.canonical import canonical_hash
from suwa_wm.data import load
from suwa_wm.dataset import CONTEXT, TARGET, Windows, batches
from suwa_wm.model import D_MODEL, Predictor, SuwaWM, vicreg_terms
from suwa_wm.repro import pin_determinism, seed_from_hex


@torch.no_grad()
def ema_update(target: torch.nn.Module, online: torch.nn.Module, m: float) -> None:
    for tp, op in zip(target.parameters(), online.parameters()):
        tp.mul_(m).add_(op.detach(), alpha=1 - m)
    for tb, ob in zip(target.buffers(), online.buffers()):
        tb.copy_(ob)


@torch.no_grad()
def evaluate(online, target, predictor, w: Windows, idx: np.ndarray, batch: int) -> float:
    online.eval(); target.eval(); predictor.eval()
    total, n = 0.0, 0
    for b in batches(idx, batch, np.random.default_rng(0), shuffle=False):
        ctx = torch.from_numpy(w.context_batch(b))
        fut = torch.from_numpy(w.future_batch(b, TARGET))
        pred = predictor(online(ctx), float(TARGET))
        tgt = target(fut)
        total += torch.nn.functional.smooth_l1_loss(pred, tgt).item() * len(b)
        n += len(b)
    online.train(); predictor.train()
    return total / max(n, 1)


@torch.no_grad()
def effective_rank(model, w: Windows, idx: np.ndarray) -> float:
    """Participation ratio of the embedding covariance spectrum. A collapsed
    encoder concentrates all variance in a few directions; a healthy one
    spreads it. This, not the prediction loss, is the honest health check."""
    model.eval()
    z = model(torch.from_numpy(w.context_batch(idx)))
    z = z.reshape(-1, z.shape[-1])
    z = z - z.mean(dim=0, keepdim=True)
    cov = (z.T @ z) / max(z.shape[0] - 1, 1)
    ev = torch.linalg.eigvalsh(cov).clamp(min=0)
    model.train()
    return float((ev.sum() ** 2) / (ev**2).sum().clamp(min=1e-12))


def run_pretrain(w: Windows, steps: int, batch: int, lr: float, seed: int,
                 out_path, train_idx=None) -> str:
    """Reusable JEPA pretraining, for the on-chain genesis epoch.

    Same procedure as the CLI, minus the reporting. Returns the path of the
    backbone written, ready to hand to the execution fine-tune.
    """
    from pathlib import Path as _Path

    online = SuwaWM(w.A, w.F, D_MODEL)
    target = deepcopy(online)
    for p_ in target.parameters():
        p_.requires_grad_(False)
    predictor = Predictor(D_MODEL)

    params = list(online.parameters()) + list(predictor.parameters())
    opt = torch.optim.AdamW(params, lr=lr, weight_decay=0.01)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=steps)

    # Walk-forward folds MUST pass their own training indices: pretraining on
    # the full series would put the fold's test period into the backbone and
    # quietly invalidate the whole evaluation.
    tr = w.splits(lookahead=TARGET)[0] if train_idx is None else train_idx
    rng = np.random.default_rng(seed)
    gen = batches(tr, batch, rng)

    for step in range(1, steps + 1):
        try:
            b = next(gen)
        except StopIteration:
            gen = batches(tr, batch, rng)
            b = next(gen)
        ctx = torch.from_numpy(w.context_batch(b))
        fut = torch.from_numpy(w.future_batch(b, TARGET))
        z = online(ctx)
        pred = predictor(z, float(TARGET))
        with torch.no_grad():
            tgt = target(fut)
        var_loss, cov_loss = vicreg_terms(z)
        loss = torch.nn.functional.smooth_l1_loss(pred, tgt) + var_loss + 0.04 * cov_loss
        opt.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(params, 5.0)
        opt.step()
        sched.step()
        ema_update(target, online, 0.996 + 0.003 * (step / steps))
        if step % 250 == 0 or step == steps:
            print(f"  pretrain {step}/{steps} loss={loss.item():.4f}")

    out_path = _Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"backbone": online.state_dict(), "n_assets": w.A,
                "n_features": w.F, "d_model": D_MODEL}, out_path)
    return str(out_path)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=str, default="../data/market.npz")
    ap.add_argument("--steps", type=int, default=3000)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--seed-hex", type=str, default=None)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", type=str, default="../runs/pretrain")
    args = ap.parse_args()

    seed = seed_from_hex(args.seed_hex) if args.seed_hex else args.seed
    pin_determinism(seed)

    from finetune import build_windows

    w, symbols = build_windows(args.data)
    tr, va, te = w.splits(lookahead=TARGET)
    print(f"assets={w.A} features={w.F} hours={w.T}")
    print(f"train={len(tr)} val={len(va)} test={len(te)} (chronological)")

    online = SuwaWM(w.A, w.F, D_MODEL)
    target = deepcopy(online)
    for p in target.parameters():
        p.requires_grad_(False)
    predictor = Predictor(D_MODEL)

    params = list(online.parameters()) + list(predictor.parameters())
    n_params = sum(p.numel() for p in params)
    print(f"parameters: {n_params/1e6:.2f}M")
    opt = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.01)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=args.steps)

    rng = np.random.default_rng(seed)
    gen = batches(tr, args.batch, rng)
    history = []

    for step in range(1, args.steps + 1):
        try:
            b = next(gen)
        except StopIteration:
            gen = batches(tr, args.batch, rng)
            b = next(gen)

        ctx = torch.from_numpy(w.context_batch(b))
        fut = torch.from_numpy(w.future_batch(b, TARGET))

        z = online(ctx)
        pred = predictor(z, float(TARGET))
        with torch.no_grad():
            tgt = target(fut)

        pred_loss = torch.nn.functional.smooth_l1_loss(pred, tgt)
        var_loss, cov_loss = vicreg_terms(z)
        loss = pred_loss + 1.0 * var_loss + 0.04 * cov_loss

        opt.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(params, 5.0)
        opt.step()
        sched.step()
        # Ramp the EMA toward 1: fast early so the target keeps up, slow later
        # so it becomes a stable teacher.
        ema_update(target, online, 0.996 + 0.003 * (step / args.steps))

        if step % 250 == 0 or step == args.steps:
            val = evaluate(online, target, predictor, w, va, args.batch)
            rank = effective_rank(online, w, va[:256])
            history.append({"step": step, "train": float(pred_loss.item()), "val": float(val),
                            "var": float(var_loss.item()), "cov": float(cov_loss.item()),
                            "effective_rank": rank})
            print(f"  step {step:5d} pred={pred_loss.item():.4f} var={var_loss.item():.4f} "
                  f"cov={cov_loss.item():.4f} val={val:.4f} rank={rank:.1f}")

    # NOTE: we deliberately keep the FINAL weights, not the lowest-val ones.
    # In a JEPA the target encoder is a moving goalpost, so prediction loss
    # drifts upward as the representation gets richer — and the LOWEST loss is
    # achieved by the most COLLAPSED encoder, which is worthless downstream.
    # Representation health is judged by effective rank here, and by the
    # fine-tune ablation, never by this loss.
    test = evaluate(online, target, predictor, w, te, args.batch)
    print(f"\nfinal val {history[-1]['val']:.4f} | test {test:.4f}")

    # A collapsed encoder predicts everything perfectly and means nothing.
    with torch.no_grad():
        z = online(torch.from_numpy(w.context_batch(te[:256])))
        spread = z.reshape(-1, z.shape[-1]).std(dim=0).mean().item()
    print(f"embedding std {spread:.4f} " + ("(healthy)" if spread > 0.1 else "(COLLAPSED)"))

    rank = effective_rank(online, w, te[:256])
    print(f"effective rank {rank:.1f} / {D_MODEL} dims")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    torch.save({"backbone": online.state_dict(), "n_assets": w.A, "n_features": w.F,
                "d_model": D_MODEL, "symbols": symbols}, out / "backbone.pt")
    (out / "pretrain.json").write_text(json.dumps({
        "steps": args.steps, "seed": seed, "params": n_params,
        "final_val": history[-1]["val"], "test": test, "embedding_std": spread,
        "effective_rank": rank,
        "symbols": symbols, "history": history,
        "backbone_sha256": canonical_hash(online.state_dict()),
    }, indent=2))
    print(f"wrote {out}/backbone.pt")


if __name__ == "__main__":
    main()
