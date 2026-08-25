"""Fine-tune the pretrained world model into an execution risk forecaster.

This is the part that does something useful. Given the current market state,
the heads predict the distribution of each asset's next-H-hour log return:
mu (drift) and sigma (risk). An execution engine reads sigma to decide how
much slippage to tolerate and whether to route now or wait.

Scored against the honest benchmark — "the next few hours look like the last
24" — using Gaussian NLL, a proper scoring rule. If the model cannot beat that
it is worthless, and this script will say so.

    python3 finetune.py --backbone ../runs/pretrain/backbone.pt --steps 2000
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

from suwa_wm.data import load
from suwa_wm.dataset import CONTEXT, HORIZON, Windows, batches
from suwa_wm.model import (
    D_MODEL, STUDENT_T_DOF, SuwaExecutionModel, student_t_nll, t_scale_to_std
)
from suwa_wm.repro import pin_determinism, seed_from_hex

LOG_2PI = math.log(2 * math.pi)
# Floor the naive forecast: a trailing window can print a near-zero vol, and an
# unfloored sigma turns one tail event into thousands of nats. Both the model's
# anchor and the benchmark use the same floor, so the comparison stays fair.
SIGMA_FLOOR = 1e-4


def anchor(w: Windows, idx: np.ndarray) -> np.ndarray:
    """Naive H-hour forecast as a Student-t *scale*: trailing 24h realised
    vol, scaled by sqrt(H), then converted from a std into a t scale."""
    std = w.baseline_vol(idx) * math.sqrt(HORIZON)
    return np.maximum(std / t_scale_to_std(), SIGMA_FLOOR)


def log_scales(w: Windows, idx: np.ndarray) -> np.ndarray:
    """[B, A, S] log t-scales at every look-back — the model's anchor inputs."""
    std = w.vol_scales(idx) * math.sqrt(HORIZON)
    return np.log(np.maximum(std / t_scale_to_std(), SIGMA_FLOOR)).astype(np.float32)


def fit_har(w: Windows, idx: np.ndarray):
    """Fit a HAR-style volatility model on the TRAINING split only.

    This is the strong benchmark. HAR (heterogeneous autoregressive realised
    volatility) is the standard hard-to-beat baseline in volatility
    forecasting: log forward vol regressed on log trailing vol at several
    horizons. If the neural world model cannot beat this, it is not earning
    its keep, and saying so is the point of measuring it.
    """
    X = log_scales(w, idx).reshape(-1, len(Windows.VOL_SCALES))
    _, realized = w.labels(idx, HORIZON)
    y = np.log(np.maximum(realized * math.sqrt(HORIZON) / t_scale_to_std(), SIGMA_FLOOR)).ravel()
    A = np.concatenate([X, np.ones((X.shape[0], 1), dtype=np.float32)], axis=1)
    coef, *_ = np.linalg.lstsq(A, y, rcond=None)
    return coef


def har_scale(w: Windows, idx: np.ndarray, coef: np.ndarray) -> np.ndarray:
    X = log_scales(w, idx)
    B, Aa, S = X.shape
    flat = np.concatenate([X.reshape(-1, S), np.ones((B * Aa, 1), dtype=np.float32)], axis=1)
    return np.maximum(np.exp(flat @ coef).reshape(B, Aa), SIGMA_FLOOR)


_T_CONST = (
    math.lgamma((STUDENT_T_DOF + 1) / 2)
    - math.lgamma(STUDENT_T_DOF / 2)
    - 0.5 * math.log(STUDENT_T_DOF * math.pi)
)


def nll_pointwise(mu: np.ndarray, scale: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Student-t NLL. The baseline is scored under the SAME family and dof, so
    the comparison isolates the forecast, not the distributional assumption."""
    scale = np.maximum(scale, SIGMA_FLOOR)
    z = (y - mu) / scale
    return -_T_CONST + np.log(scale) + 0.5 * (STUDENT_T_DOF + 1) * np.log1p(z**2 / STUDENT_T_DOF)


def nll_of(mu: np.ndarray, scale: np.ndarray, y: np.ndarray) -> float:
    """Mean Student-t NLL in nats. Tails still matter here, which is why the
    report also carries the median and a per-sample win rate."""
    return float(nll_pointwise(mu, scale, y).mean())


@torch.no_grad()
def collect(model, w: Windows, idx: np.ndarray, batch: int):
    model.eval()
    mus, sigmas = [], []
    for b in batches(idx, batch, np.random.default_rng(0), shuffle=False):
        mu, log_sigma = model(
            torch.from_numpy(w.context_batch(b)), torch.from_numpy(log_scales(w, b))
        )
        mus.append(mu.numpy())
        sigmas.append(np.exp(log_sigma.numpy()))
    model.train()
    return np.concatenate(mus), np.concatenate(sigmas)


def report(name: str, model, w: Windows, idx: np.ndarray, batch: int, har=None) -> dict:
    mu, sigma = collect(model, w, idx, batch)
    y, _ = w.labels(idx, HORIZON)

    # Baseline: trailing realised vol scaled to the horizon, zero drift. This
    # is what a sensible engineer ships without a model.
    base_sigma = anchor(w, idx)
    zeros = np.zeros_like(y)
    base_nll = nll_of(zeros, base_sigma, y)
    model_nll = nll_of(mu, sigma, y)

    # Tail-robust companions to the mean: a mean NLL gap can be one bad hour.
    pm = nll_pointwise(mu, sigma, y)
    pb = nll_pointwise(zeros, base_sigma, y)
    median_gap = float(np.median(pb) - np.median(pm))
    win_rate = float((pm < pb).mean())

    har_nll = har_corr = har_win = float("nan")
    if har is not None:
        hs = har_scale(w, idx, har)
        ph = nll_pointwise(zeros, hs, y)
        har_nll = float(ph.mean())
        har_win = float((pm < ph).mean())
        har_corr = float(np.corrcoef(hs.ravel(), np.abs(y).ravel())[0, 1])

    # Does predicted risk track realised move size?
    realized = np.abs(y)
    corr = float(np.corrcoef(sigma.ravel(), realized.ravel())[0, 1])
    base_corr = float(np.corrcoef(base_sigma.ravel(), realized.ravel())[0, 1])

    # Drift skill, measured honestly against "always predict zero".
    ss_res = float(((y - mu) ** 2).sum())
    ss_tot = float((y**2).sum())
    r2 = 1.0 - ss_res / max(ss_tot, 1e-12)
    direction = float(((mu > 0) == (y > 0)).mean())

    # Calibration: with well-fit sigma, this ratio sits near 1.0.
    implied_std = np.maximum(sigma, SIGMA_FLOOR) * t_scale_to_std()
    calib = float(np.sqrt((((y - mu) / implied_std) ** 2).mean()))
    # The same number for the benchmark: if it is also far from 1.0 the test
    # window simply moved more than any trailing estimate could have known.
    base_std = base_sigma * t_scale_to_std()
    base_calib = float(np.sqrt(((y / base_std) ** 2).mean()))

    m = {
        "nll": model_nll, "baseline_nll": base_nll, "nll_improvement": base_nll - model_nll,
        "median_nll_improvement": median_gap, "win_rate": win_rate,
        "har_nll": har_nll, "har_win_rate": har_win, "har_sigma_corr": har_corr,
        "beats_har": bool(model_nll < har_nll) if har is not None else None,
        "sigma_corr": corr, "baseline_sigma_corr": base_corr,
        "return_r2": r2, "direction_acc": direction, "calibration_z_rms": calib,
        "baseline_calibration_z_rms": base_calib,
    }
    print(
        f"  {name}\n"
        f"    NLL   model {model_nll:8.4f} | naive {base_nll:8.4f} "
        f"({base_nll - model_nll:+.4f}) | HAR {har_nll:8.4f} ({har_nll - model_nll:+.4f})\n"
        f"    wins  {win_rate:.1%} vs naive | {har_win:.1%} vs HAR | median gap {median_gap:+.4f}\n"
        f"    risk  corr {corr:.3f} | naive {base_corr:.3f} | HAR {har_corr:.3f}\n"
        f"    calib {calib:.2f} vs naive {base_calib:.2f} | dir {direction:.3f} | R2 {r2:+.4f}"
    )
    return m


def train_model(w, tr, va, steps, batch, lr, seed, backbone_path=None, freeze=False):
    """Returns (model, best_val_nll). backbone_path=None => no pretraining."""
    torch.manual_seed(seed)
    model = SuwaExecutionModel(w.A, w.F, D_MODEL)
    if backbone_path:
        ckpt = torch.load(backbone_path, map_location="cpu", weights_only=False)
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
        mu, log_sigma = model(
            torch.from_numpy(w.context_batch(b)), torch.from_numpy(log_scales(w, b))
        )
        loss = student_t_nll(mu, log_sigma, torch.from_numpy(y))

        opt.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(params, 5.0)
        opt.step()
        sched.step()

        if step % 200 == 0 or step == steps:
            mu_v, sig_v = collect(model, w, va, batch)
            y_v, _ = w.labels(va, HORIZON)
            val = nll_of(mu_v, sig_v, y_v)
            flag = ""
            if val < best:
                best, best_state = val, deepcopy(model.state_dict())
                flag = " *"
            print(f"    step {step:5d} train {loss.item():7.4f} val {val:7.4f}{flag}")

    if best_state:
        model.load_state_dict(best_state)
    return model, best


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=str, default="../data/market.npz")
    ap.add_argument("--backbone", type=str, default="../runs/pretrain/backbone.pt")
    ap.add_argument("--steps", type=int, default=2000)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--seed-hex", type=str, default=None)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", type=str, default="../runs/finetune")
    ap.add_argument("--ablation", action="store_true", help="also train without pretraining")
    args = ap.parse_args()

    seed = seed_from_hex(args.seed_hex) if args.seed_hex else args.seed
    pin_determinism(seed)

    feats, price, symbols = load(args.data)
    w = Windows(feats, price, CONTEXT)
    tr, va, te = w.splits(lookahead=HORIZON)
    print(f"train={len(tr)} val={len(va)} test={len(te)} | horizon={HORIZON}h assets={w.A}")

    har = fit_har(w, tr)
    print(f"HAR benchmark fitted on train: weights {np.round(har[:-1], 3)} "
          f"intercept {har[-1]:.3f}")

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
        print(f"\npretraining changed test NLL by {gain:+.4f} nats "
              f"({'pretraining helped' if gain > 0 else 'pretraining did not help'})")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    torch.save({"model": model.state_dict(), "n_assets": w.A, "n_features": w.F,
                "d_model": D_MODEL, "symbols": symbols, "horizon": HORIZON}, out / "execution.pt")
    (out / "metrics.json").write_text(json.dumps(results, indent=2))
    print(f"\nwrote {out}/execution.pt and metrics.json")


if __name__ == "__main__":
    main()
