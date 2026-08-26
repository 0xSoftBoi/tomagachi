"""Fine-tune the pretrained world model into an execution risk forecaster.

Given the current market state the heads predict the distribution of each
asset's next-H-hour log return: mu (drift) and a Student-t scale (risk). An
execution engine reads the scale to size slippage and decide whether to route
now or wait.

Scored against three benchmarks, all under the SAME distribution family so the
only thing under test is the forecast:

    naive-cc   trailing 24h close-to-close volatility
    naive-pk   trailing 24h Parkinson (range) volatility — the harder bar
    HAR        fitted on the training split, the standard volatility model

If the model cannot beat the best of those it is not earning its keep, and this
script says so plainly.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
import torch

from suwa_wm.data import load, load_hl
from suwa_wm.dataset import CONTEXT, HORIZON, VOL_SCALES, Windows, batches
from suwa_wm.model import (
    D_MODEL, STUDENT_T_DOF, SuwaExecutionModel, student_t_nll, t_scale_to_std,
)
from suwa_wm.repro import pin_determinism, seed_from_hex

# Floor the scale: a trailing window can print a near-zero vol, and an
# unfloored sigma turns one tail event into thousands of nats. Model and every
# benchmark share this floor, so the comparison stays fair.
SIGMA_FLOOR = 1e-4
N_SCALES = len(VOL_SCALES) * 2

_T_CONST = (
    math.lgamma((STUDENT_T_DOF + 1) / 2)
    - math.lgamma(STUDENT_T_DOF / 2)
    - 0.5 * math.log(STUDENT_T_DOF * math.pi)
)


def _to_scale(std: np.ndarray) -> np.ndarray:
    """A standard deviation is not a Student-t scale; convert and floor."""
    return np.maximum(std / t_scale_to_std(), SIGMA_FLOOR)


def log_scales(w: Windows, idx: np.ndarray) -> np.ndarray:
    """[B, A, 2S] log anchors — the model's volatility inputs."""
    return np.log(_to_scale(w.vol_scales(idx) * math.sqrt(HORIZON))).astype(np.float32)


def nll_pointwise(mu, scale, y) -> np.ndarray:
    scale = np.maximum(scale, SIGMA_FLOOR)
    z = (y - mu) / scale
    return -_T_CONST + np.log(scale) + 0.5 * (STUDENT_T_DOF + 1) * np.log1p(z**2 / STUDENT_T_DOF)


def qlike(scale: np.ndarray, realized_var: np.ndarray) -> float:
    """QLIKE loss — the standard robust score for volatility forecasts.
    Unlike squared error it is insensitive to the noise in the realised proxy."""
    var = np.maximum(scale * t_scale_to_std(), SIGMA_FLOOR) ** 2
    r = np.maximum(realized_var, 1e-12) / var
    return float(np.mean(r - np.log(r) - 1.0))


def fit_har(w: Windows, idx: np.ndarray) -> np.ndarray:
    """HAR: log forward vol regressed on log trailing vol at several horizons.
    Fitted on the training split only."""
    X = log_scales(w, idx).reshape(-1, N_SCALES)
    _, realized = w.labels(idx, HORIZON)
    y = np.log(_to_scale(realized * math.sqrt(HORIZON))).ravel()
    A = np.concatenate([X, np.ones((X.shape[0], 1), dtype=np.float32)], axis=1)
    coef, *_ = np.linalg.lstsq(A, y, rcond=None)
    return coef


def har_scale(w: Windows, idx: np.ndarray, coef: np.ndarray) -> np.ndarray:
    X = log_scales(w, idx)
    B, A, S = X.shape
    flat = np.concatenate([X.reshape(-1, S), np.ones((B * A, 1), dtype=np.float32)], axis=1)
    return np.maximum(np.exp(flat @ coef).reshape(B, A), SIGMA_FLOOR)


@torch.no_grad()
def collect(model, w: Windows, idx: np.ndarray, batch: int):
    model.eval()
    mus, scales = [], []
    for b in batches(idx, batch, np.random.default_rng(0), shuffle=False):
        mu, log_s = model(
            torch.from_numpy(w.context_batch(b)), torch.from_numpy(log_scales(w, b))
        )
        mus.append(mu.numpy())
        scales.append(np.exp(log_s.numpy()))
    model.train()
    return np.concatenate(mus), np.concatenate(scales)


def report(name: str, model, w: Windows, idx: np.ndarray, batch: int,
           har=None, quiet: bool = False) -> dict:
    mu, scale = collect(model, w, idx, batch)
    y, realized = w.labels(idx, HORIZON)
    zeros = np.zeros_like(y)
    realized_var = (realized * math.sqrt(HORIZON)) ** 2

    bench = {
        "naive_cc": _to_scale(w.baseline_vol(idx) * math.sqrt(HORIZON)),
        "naive_pk": _to_scale(w.parkinson_vol(idx) * math.sqrt(HORIZON)),
    }
    if har is not None:
        bench["har"] = har_scale(w, idx, har)

    pm = nll_pointwise(mu, scale, y)
    m = {
        "nll": float(pm.mean()),
        "qlike": qlike(scale, realized_var),
        "sigma_corr": float(np.corrcoef(scale.ravel(), np.abs(y).ravel())[0, 1]),
        "calibration_z_rms": float(
            np.sqrt((((y - mu) / (np.maximum(scale, SIGMA_FLOOR) * t_scale_to_std())) ** 2).mean())
        ),
        "direction_acc": float(((mu > 0) == (y > 0)).mean()),
        "return_r2": float(1.0 - ((y - mu) ** 2).sum() / max((y**2).sum(), 1e-12)),
    }
    for key, s in bench.items():
        pb = nll_pointwise(zeros, s, y)
        m[f"{key}_nll"] = float(pb.mean())
        m[f"{key}_qlike"] = qlike(s, realized_var)
        m[f"{key}_win_rate"] = float((pm < pb).mean())
        m[f"{key}_sigma_corr"] = float(np.corrcoef(s.ravel(), np.abs(y).ravel())[0, 1])
        m[f"{key}_calibration"] = float(
            np.sqrt(((y / (s * t_scale_to_std())) ** 2).mean())
        )
    best = min(bench, key=lambda k: m[f"{k}_nll"])
    m["best_benchmark"] = best
    m["nll_vs_best"] = m[f"{best}_nll"] - m["nll"]
    m["qlike_vs_best"] = m[f"{best}_qlike"] - m["qlike"]

    if not quiet:
        print(f"  {name}")
        print(f"    NLL    model {m['nll']:8.4f} | " + " | ".join(
            f"{k} {m[k + '_nll']:8.4f}" for k in bench))
        print(f"    QLIKE  model {m['qlike']:8.4f} | " + " | ".join(
            f"{k} {m[k + '_qlike']:8.4f}" for k in bench))
        print(f"    corr   model {m['sigma_corr']:.3f} | " + " | ".join(
            f"{k} {m[k + '_sigma_corr']:.3f}" for k in bench))
        print(f"    calib  model {m['calibration_z_rms']:.2f} | " + " | ".join(
            f"{k} {m[k + '_calibration']:.2f}" for k in bench))
        print(f"    vs best ({best}): NLL {m['nll_vs_best']:+.4f} "
              f"QLIKE {m['qlike_vs_best']:+.4f} | dir {m['direction_acc']:.3f}")
    return m


def train_model(w, tr, va, steps, batch, lr, seed, backbone_path=None,
                freeze=False, quiet=False):
    """Returns (model, best_val_nll). backbone_path=None => no pretraining."""
    torch.manual_seed(seed)
    model = SuwaExecutionModel(w.A, w.F, D_MODEL, n_scales=N_SCALES)
    if backbone_path:
        ckpt = torch.load(backbone_path, map_location="cpu", weights_only=True)
        model.backbone.load_state_dict(ckpt["backbone"])
    if freeze:
        for p in model.backbone.parameters():
            p.requires_grad_(False)

    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=lr, weight_decay=0.01)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=steps)

    rng = np.random.default_rng(seed)
    gen = batches(tr, batch, rng)
    best, best_state = float("inf"), None

    for step in range(1, steps + 1):
        try:
            b = next(gen)
        except StopIteration:
            gen = batches(tr, batch, rng)
            b = next(gen)

        y, _ = w.labels(b, HORIZON)
        mu, log_s = model(
            torch.from_numpy(w.context_batch(b)), torch.from_numpy(log_scales(w, b))
        )
        loss = student_t_nll(mu, log_s, torch.from_numpy(y))

        opt.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(params, 5.0)
        opt.step()
        sched.step()

        if step % 250 == 0 or step == steps:
            mu_v, s_v = collect(model, w, va, batch)
            y_v, _ = w.labels(va, HORIZON)
            val = float(nll_pointwise(mu_v, s_v, y_v).mean())
            flag = ""
            if val < best:
                best, best_state = val, deepcopy(model.state_dict())
                flag = " *"
            if not quiet:
                print(f"    step {step:5d} train {loss.item():7.4f} val {val:7.4f}{flag}")

    if best_state:
        model.load_state_dict(best_state)
    return model, best


def build_windows(data_path: str):
    feats, price, symbols = load(data_path)
    try:
        high, low = load_hl(data_path)
    except KeyError:
        high = low = None       # older corpus without OHLC
    return Windows(feats, price, CONTEXT, high, low), symbols


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=str, default="../data/market.npz")
    ap.add_argument("--backbone", type=str, default="../runs/pretrain/backbone.pt")
    ap.add_argument("--steps", type=int, default=3000)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--seed-hex", type=str, default=None)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", type=str, default="../runs/finetune")
    ap.add_argument("--ablation", action="store_true")
    args = ap.parse_args()

    seed = seed_from_hex(args.seed_hex) if args.seed_hex else args.seed
    pin_determinism(seed)

    w, symbols = build_windows(args.data)
    tr, va, te = w.splits(lookahead=HORIZON)
    print(f"train={len(tr)} val={len(va)} test={len(te)} | horizon={HORIZON}h assets={w.A}")

    har = fit_har(w, tr)
    print("\nfine-tuning from pretrained world model")
    model, _ = train_model(w, tr, va, args.steps, args.batch, args.lr, seed, args.backbone)
    print("\ntest set:")
    metrics = report("pretrained", model, w, te, args.batch, har)

    results = {"horizon_hours": HORIZON, "seed": seed, "symbols": symbols,
               "har_coef": har.tolist(), "pretrained": metrics}

    if args.ablation:
        print("\nablation: identical budget, no pretraining")
        scratch, _ = train_model(w, tr, va, args.steps, args.batch, args.lr, seed, None)
        print("\ntest set:")
        results["scratch"] = report("scratch", scratch, w, te, args.batch, har)
        gain = results["scratch"]["nll"] - metrics["nll"]
        results["pretraining_gain_nll"] = gain
        print(f"\npretraining changed test NLL by {gain:+.4f} nats")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    torch.save({"model": model.state_dict(), "n_assets": w.A, "n_features": w.F,
                "d_model": D_MODEL, "n_scales": N_SCALES, "symbols": symbols,
                "horizon": HORIZON}, out / "execution.pt")
    (out / "metrics.json").write_text(json.dumps(results, indent=2))
    print(f"\nwrote {out}/execution.pt and metrics.json")


if __name__ == "__main__":
    main()
