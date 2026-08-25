"""Windowing and strictly time-ordered splits.

Every split boundary here is chronological. Shuffling market data across time
leaks the future into training and produces results that evaporate live, so
train/val/test are contiguous blocks in that order, and every feature is
causal (see data.build_features).
"""

from __future__ import annotations

import numpy as np

CONTEXT = 48   # hours the model looks back
TARGET = 24    # hours ahead whose representation JEPA predicts
HORIZON = 6    # hours ahead the execution heads forecast


class Windows:
    """Index bookkeeping over a [T, A, F] feature tensor."""

    def __init__(self, feats: np.ndarray, price: np.ndarray, context: int = CONTEXT):
        self.feats = feats
        self.price = price
        self.context = context
        self.T = feats.shape[0]
        self.A = feats.shape[1]
        self.F = feats.shape[2]

        # Hourly log returns, used for labels only — never as an input here.
        self.logret = np.zeros_like(price)
        self.logret[1:] = np.log(np.maximum(price[1:], 1e-12) / np.maximum(price[:-1], 1e-12))

    # ---------------------------------------------------------------- splits

    def splits(self, train: float = 0.70, val: float = 0.15, lookahead: int = 0):
        """Contiguous, chronological. `lookahead` is how far past t a sample
        reads, so the blocks are separated by a gap and cannot overlap."""
        first = self.context
        last = self.T - lookahead - 1
        n = last - first
        n_tr = int(n * train)
        n_va = int(n * val)
        tr = np.arange(first, first + n_tr)
        # Gap of `lookahead` hours so no training sample sees into validation.
        va = np.arange(first + n_tr + lookahead, first + n_tr + n_va)
        te = np.arange(first + n_tr + n_va + lookahead, last)
        return tr, va, te

    # ----------------------------------------------------------------- batch

    def context_batch(self, idx: np.ndarray) -> np.ndarray:
        """[B, A, C, F] — the window ending at (and excluding) each t."""
        out = np.empty((len(idx), self.A, self.context, self.F), dtype=np.float32)
        for i, t in enumerate(idx):
            out[i] = self.feats[t - self.context : t].transpose(1, 0, 2)
        return out

    def future_batch(self, idx: np.ndarray, length: int = TARGET) -> np.ndarray:
        """[B, A, L, F] — the window starting at t. JEPA target only."""
        out = np.empty((len(idx), self.A, length, self.F), dtype=np.float32)
        for i, t in enumerate(idx):
            out[i] = self.feats[t : t + length].transpose(1, 0, 2)
        return out

    # ---------------------------------------------------------------- labels

    def labels(self, idx: np.ndarray, horizon: int = HORIZON):
        """Forward drift and forward realized volatility, per asset.

        ret:  log(price[t+H] / price[t])          -> what drift actually was
        vol:  std of hourly log returns in (t, t+H] -> what risk actually was
        """
        ret = np.empty((len(idx), self.A), dtype=np.float32)
        vol = np.empty((len(idx), self.A), dtype=np.float32)
        for i, t in enumerate(idx):
            ret[i] = np.log(
                np.maximum(self.price[t + horizon], 1e-12) / np.maximum(self.price[t], 1e-12)
            )
            vol[i] = self.logret[t + 1 : t + horizon + 1].std(axis=0)
        return ret, vol

    VOL_SCALES = (6, 24, 72, 168)

    def vol_scales(self, idx: np.ndarray, scales: tuple = VOL_SCALES) -> np.ndarray:
        """[B, A, S] trailing realised volatility at several look-backs.

        One trailing window is a weak view of risk; volatility is persistent at
        multiple horizons at once, which is the whole premise of HAR-style
        models. Giving the model every scale lets it learn the mix instead of
        being handed one guess.
        """
        out = np.empty((len(idx), self.A, len(scales)), dtype=np.float32)
        for i, t in enumerate(idx):
            for j, win in enumerate(scales):
                lo = max(0, t - win + 1)
                out[i, :, j] = self.logret[lo : t + 1].std(axis=0)
        return out

    def baseline_vol(self, idx: np.ndarray, window: int = 24) -> np.ndarray:
        """The honest benchmark: tomorrow's volatility looks like today's.
        Beating this is the bar for the model being worth anything."""
        out = np.empty((len(idx), self.A), dtype=np.float32)
        for i, t in enumerate(idx):
            out[i] = self.logret[max(0, t - window + 1) : t + 1].std(axis=0)
        return out


def batches(idx: np.ndarray, size: int, rng: np.random.Generator, shuffle: bool = True):
    """Shuffling *within* a split is fine — the split itself is chronological."""
    order = rng.permutation(len(idx)) if shuffle else np.arange(len(idx))
    for i in range(0, len(order), size):
        yield idx[order[i : i + size]]
