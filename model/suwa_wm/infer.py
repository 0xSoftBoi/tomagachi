"""Run the trained world model on the live market.

Loads a fine-tuned execution model, pulls the most recent hours of real market
data, and returns — per asset — the forecast distribution of the next H hours
plus the execution guidance that follows from it.

This is the creature's actual product surface.
"""

from __future__ import annotations

import json
import math
import time
from pathlib import Path

import numpy as np
import torch

from .data import _align, build_features, fetch_raw
from .dataset import CONTEXT, HORIZON, Windows
from .model import D_MODEL, SuwaExecutionModel, t_scale_to_std

CACHE = Path("data/live_cache.json")
CACHE_TTL = 600  # seconds; CoinGecko is rate-limited and hourly bars move slowly


def _load_cache() -> dict | None:
    if not CACHE.exists():
        return None
    try:
        blob = json.loads(CACHE.read_text())
    except Exception:
        return None
    if time.time() - blob.get("fetched_at", 0) > CACHE_TTL:
        return None
    return blob["raw"]


def _save_cache(raw: dict) -> None:
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps({"fetched_at": time.time(), "raw": raw}))


def live_features(days: int = 14, throttle: float = 3.0, use_cache: bool = True):
    """Most recent [T, A, F] features plus the price grid and symbol order.

    `days` must cover the longest look-back any feature uses (168h z-scores),
    or the leading rows would be computed from a truncated window.
    """
    raw = _load_cache() if use_cache else None
    if raw is None:
        raw = fetch_raw(days=days, throttle=throttle)
        _save_cache(raw)
    # Enough history for the longest look-back (168h z-score) plus the
    # context window, and nothing more — live fetches should stay cheap.
    price, vol, mcap, symbols = _align(raw, min_hours=CONTEXT + 168 + 24)
    feats = build_features(price, vol, mcap)
    return feats, price, symbols


def _verdict(ratio: float) -> str:
    """Turn the forecast into the decision an execution engine actually makes."""
    if ratio >= 1.25:
        return "elevated risk - widen slippage or wait"
    if ratio <= 0.8:
        return "calm - tighten slippage, good window to route"
    return "normal - route on standard settings"


class Forecaster:
    def __init__(self, checkpoint: str):
        ckpt = torch.load(checkpoint, map_location="cpu", weights_only=False)
        self.symbols: list[str] = list(ckpt["symbols"])
        self.horizon: int = int(ckpt.get("horizon", HORIZON))
        self.model = SuwaExecutionModel(
            ckpt["n_assets"], ckpt["n_features"], ckpt.get("d_model", D_MODEL)
        )
        self.model.load_state_dict(ckpt["model"])
        self.model.eval()
        torch.set_num_threads(1)

    def forecast(self, feats: np.ndarray, price: np.ndarray, symbols: list[str]) -> dict:
        """Forecast from an aligned feature history.

        The live symbol order must be mapped onto the order the model was
        trained with: the model holds a learned embedding per asset slot, so a
        shuffled column order is silently, badly wrong rather than an error.
        """
        missing = [s for s in self.symbols if s not in symbols]
        if missing:
            raise RuntimeError(f"live data is missing trained assets: {missing}")
        cols = [symbols.index(s) for s in self.symbols]

        window = feats[-CONTEXT:, cols, :]
        if window.shape[0] < CONTEXT:
            raise RuntimeError(f"need {CONTEXT}h of history, got {window.shape[0]}")
        x = torch.from_numpy(window.transpose(1, 0, 2)[None].astype(np.float32))

        # Multi-scale anchors, computed exactly as in training. These must
        # match dataset.Windows.vol_scales or the head is fed nonsense.
        px = price[:, cols]
        logret = np.zeros_like(px)
        logret[1:] = np.log(np.maximum(px[1:], 1e-12) / np.maximum(px[:-1], 1e-12))

        scales = np.stack(
            [logret[-win:].std(axis=0) for win in Windows.VOL_SCALES], axis=-1
        )  # [A, S]
        scale_std = scales * math.sqrt(self.horizon)
        log_scales = np.log(
            np.maximum(scale_std / t_scale_to_std(), 1e-4)
        )[None].astype(np.float32)  # [1, A, S]

        # The naive 24h benchmark, kept for the risk ratio the caller reads.
        base_std = logret[-24:].std(axis=0) * math.sqrt(self.horizon)

        with torch.no_grad():
            mu, log_scale = self.model(x, torch.from_numpy(log_scales))
        mu = mu[0].numpy()
        std = np.exp(log_scale[0].numpy()) * t_scale_to_std()

        assets = []
        for i, sym in enumerate(self.symbols):
            ratio = float(std[i] / max(base_std[i], 1e-12))
            assets.append({
                "symbol": sym,
                "price_usd": float(px[-1, i]),
                "horizon_hours": self.horizon,
                "expected_drift": float(mu[i]),
                "expected_move": float(std[i]),
                "baseline_move": float(base_std[i]),
                "risk_ratio": ratio,
                "slippage_hint_bps": round(float(std[i]) * 10_000 / 2, 1),
                "verdict": _verdict(ratio),
            })
        assets.sort(key=lambda a: a["risk_ratio"], reverse=True)
        return {
            "horizon_hours": self.horizon,
            "market_risk_ratio": float(np.mean([a["risk_ratio"] for a in assets])),
            "assets": assets,
        }

    def forecast_live(self, **kw) -> dict:
        feats, price, symbols = live_features(**kw)
        return self.forecast(feats, price, symbols)
