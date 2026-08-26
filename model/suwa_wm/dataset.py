"""Windowing, causal features, and honest evaluation splits.

Every split here is chronological. Shuffling market data across time leaks the
future into training and produces results that evaporate live, so splits are
contiguous blocks with a gap at each boundary wide enough that no training
sample can see into the block that follows.
"""

from __future__ import annotations

import numpy as np

CONTEXT = 48   # hours the model looks back
TARGET = 24    # hours ahead whose representation JEPA predicts
HORIZON = 6    # hours ahead the execution heads forecast

# Look-backs for the volatility anchors. Volatility is persistent at several
# horizons at once, which is the premise behind HAR-style models.
VOL_SCALES = (6, 24, 72, 168)

# A high-low range implies an hourly sigma of hl / (2*sqrt(ln 2)).
_PK = 1.0 / (2.0 * np.sqrt(np.log(2.0)))


def _rolling_rms(x: np.ndarray, window: int) -> np.ndarray:
    """Causal rolling root-mean-square, vectorised over the whole series."""
    T = x.shape[0]
    c2 = np.cumsum(np.vstack([np.zeros((1, x.shape[1])), x**2]), axis=0)
    idx = np.arange(T)
    lo = np.maximum(0, idx - window + 1)
    n = (idx - lo + 1).reshape(-1, 1)
    return np.sqrt(np.maximum((c2[idx + 1] - c2[lo]) / n, 0.0))


class Windows:
    """Index bookkeeping over a [T, A, F] feature tensor."""

    VOL_SCALES = VOL_SCALES

    def __init__(self, feats, price, context: int = CONTEXT, high=None, low=None):
        self.feats = feats
        self.price = price
        self.context = context
        self.T, self.A, self.F = feats.shape

        # Hourly log returns — labels and benchmarks only, never model input here.
        self.logret = np.zeros_like(price)
        self.logret[1:] = np.log(
            np.maximum(price[1:], 1e-12) / np.maximum(price[:-1], 1e-12)
        )

        # Range-based hourly sigma. For the same sample it is several times more
        # efficient than close-to-close, so it makes both the model's anchor and
        # the benchmark it must beat materially stronger.
        if high is not None and low is not None:
            hl = np.log(np.maximum(high, 1e-12) / np.maximum(low, 1e-12))
            self.pk_hourly = (hl * _PK).astype(np.float64)
        else:
            self.pk_hourly = np.abs(self.logret)

        # Precompute every trailing scale once; the naive loops were the
        # dominant cost of an evaluation pass.
        self._cc = {w: _rolling_rms(self.logret, w) for w in VOL_SCALES}
        self._pk = {w: _rolling_rms(self.pk_hourly, w) for w in VOL_SCALES}

    # ---------------------------------------------------------------- splits

    def splits(self, train: float = 0.70, val: float = 0.15, lookahead: int = 0):
        """A single chronological train/val/test split."""
        first, last = self.context, self.T - lookahead - 1
        n = last - first
        n_tr, n_va = int(n * train), int(n * val)
        tr = np.arange(first, first + n_tr)
        va = np.arange(first + n_tr + lookahead, first + n_tr + n_va)
        te = np.arange(first + n_tr + n_va + lookahead, last)
        return tr, va, te

    def walk_forward(self, n_folds: int = 5, lookahead: int = 0):
        """Expanding-window walk-forward folds.

        Fold k trains on everything before its own validation block and is
        tested on the block after that, so each fold is evaluated on a period
        the model has never seen and the folds together cover several distinct
        market regimes. A single held-out block cannot distinguish skill from
        one lucky quarter; this can.
        """
        first, last = self.context, self.T - lookahead - 1
        n = last - first
        block = n // (n_folds + 3)      # reserve the first chunk for training
        if block < 50:
            raise SystemExit(f"not enough history for {n_folds} folds ({n} usable hours)")

        folds = []
        for k in range(n_folds):
            test_end = last - (n_folds - 1 - k) * block
            test_start = test_end - block
            val_end = test_start - lookahead
            val_start = val_end - block
            train_end = val_start - lookahead
            folds.append((
                np.arange(first, train_end),
                np.arange(val_start, val_end),
                np.arange(test_start, test_end),
            ))
        return folds

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
        """Forward drift and forward realised volatility, per asset.

        ret: log(price[t+H] / price[t])           — what drift actually was
        vol: std of hourly log returns in (t, t+H] — what risk actually was
        """
        ret = np.log(
            np.maximum(self.price[idx + horizon], 1e-12) / np.maximum(self.price[idx], 1e-12)
        ).astype(np.float32)
        vol = np.stack(
            [self.logret[t + 1 : t + horizon + 1].std(axis=0) for t in idx]
        ).astype(np.float32)
        return ret, vol

    # ------------------------------------------------------------ benchmarks

    def baseline_vol(self, idx: np.ndarray, window: int = 24) -> np.ndarray:
        """The obvious benchmark: the next few hours look like the last 24."""
        return self._cc[window][idx]

    def parkinson_vol(self, idx: np.ndarray, window: int = 24) -> np.ndarray:
        """The same idea using the efficient range estimator — a harder bar."""
        return self._pk[window][idx]

    def vol_scales(self, idx: np.ndarray) -> np.ndarray:
        """[B, A, 2S] trailing vol at every look-back, close-to-close and
        range-based. These are the anchors the execution head corrects."""
        cc = [self._cc[w][idx] for w in VOL_SCALES]
        pk = [self._pk[w][idx] for w in VOL_SCALES]
        return np.stack(cc + pk, axis=-1).astype(np.float32)


def batches(idx: np.ndarray, size: int, rng: np.random.Generator, shuffle: bool = True):
    """Shuffling *within* a split is fine — the split itself is chronological."""
    order = rng.permutation(len(idx)) if shuffle else np.arange(len(idx))
    for i in range(0, len(order), size):
        yield idx[order[i : i + size]]
