"""Real market data for SUWA-WM.

The creature's world is the cross-asset crypto market Suwappu routes through.
This pulls years of real hourly OHLCV from the Coinbase Exchange public API
(no key, paginated) and turns it into the tensor the world model trains on.

Why OHLCV and not just closes: with a high and a low you can use range-based
volatility estimators (Parkinson, Garman-Klass), which are several times more
statistically efficient than close-to-close for the same sample. Volatility is
what this model is for, so the inputs and the benchmark both get better.

Cache: data/market.npz — fetch once, train many times.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

CB = "https://api.exchange.coinbase.com"
MAX_CANDLES = 300          # Coinbase's per-request ceiling
HOUR = 3600

# Liquid USD pairs with long Coinbase history, spanning the majors Suwappu
# routes plus enough mid-caps to give the cross-asset attention something to
# learn from. Anything that 404s or is too short is dropped automatically.
UNIVERSE: list[str] = [
    "BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LTC", "BCH", "LINK", "DOT",
    "AVAX", "ATOM", "UNI", "AAVE", "ALGO", "XLM", "ETC", "FIL", "ICP", "NEAR",
    "APT", "ARB", "OP", "INJ", "GRT", "MKR", "SNX", "CRV", "COMP", "LDO",
    "IMX", "SAND", "MANA", "AXS", "CHZ", "XTZ", "ZEC", "BAT", "ENS", "SHIB",
    "SUI", "SEI", "TIA", "RNDR", "STX",
]

FEATURES = [
    "logret",        # close-to-close log return
    "parkinson",     # range-based vol (high/low), the efficient estimator
    "gk",            # Garman-Klass vol (open/high/low/close)
    "rvol_24h",      # trailing realised vol
    "logvol_chg",    # change in log dollar volume
    "ret_z_168h",    # weekly-standardised return
    "vol_z_168h",    # weekly-standardised volume change
    "range_ratio",   # (high-low)/close, raw intrabar travel
]
N_FEATURES = len(FEATURES)


def _get(url: str, retries: int = 4) -> list | dict | None:
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "suwa-wm/2.0"})
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None                     # pair does not exist
            if e.code == 429:
                time.sleep(2 * (attempt + 1))   # rate limited: back off
                continue
            if attempt == retries - 1:
                return None
            time.sleep(1 + attempt)
        except Exception:
            if attempt == retries - 1:
                return None
            time.sleep(1 + attempt)
    return None


def fetch_candles(symbol: str, days: int, throttle: float = 0.22) -> dict[int, tuple] | None:
    """Hourly OHLCV for one pair, walking backwards 300 candles at a time.

    Returns {unix_hour: (low, high, open, close, volume)} or None if the pair
    is unavailable.
    """
    end = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    start_limit = end - timedelta(days=days)
    out: dict[int, tuple] = {}
    cursor = end
    empty_streak = 0

    while cursor > start_limit:
        window_start = max(cursor - timedelta(hours=MAX_CANDLES), start_limit)
        url = (
            f"{CB}/products/{symbol}-USD/candles?granularity={HOUR}"
            f"&start={window_start.isoformat().replace('+00:00', 'Z')}"
            f"&end={cursor.isoformat().replace('+00:00', 'Z')}"
        )
        rows = _get(url)
        if rows is None and not out:
            return None                          # pair does not exist at all
        if not rows:
            empty_streak += 1
            # A few gaps are normal (halts); a long run means history ended.
            if empty_streak >= 3:
                break
        else:
            empty_streak = 0
            for t, low, high, op, close, vol in rows:
                out[int(t) // HOUR] = (low, high, op, close, vol)
        cursor = window_start
        time.sleep(throttle)

    return out or None


def fetch_raw(days: int = 730, throttle: float = 0.55, workers: int = 4) -> dict[str, dict]:
    """Fetch every pair concurrently.

    Two years of hourly candles is ~59 paginated requests per pair; serially
    that is over an hour. Coinbase's public limit is around 10 req/s, so a
    handful of workers each throttled well below that stays polite and cuts
    wall time by roughly the worker count.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    series: dict[str, dict] = {}
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fetch_candles, sym, days, throttle): sym for sym in UNIVERSE}
        for fut in as_completed(futures):
            sym = futures[fut]
            done += 1
            try:
                candles = fut.result()
            except Exception as e:
                print(f"  [{done}/{len(UNIVERSE)}] {sym:6s} failed: {e}", flush=True)
                continue
            if not candles:
                print(f"  [{done}/{len(UNIVERSE)}] {sym:6s} unavailable, skipping", flush=True)
                continue
            series[sym] = candles
            span = (max(candles) - min(candles)) / 24
            print(f"  [{done}/{len(UNIVERSE)}] {sym:6s} {len(candles):6d} hours "
                  f"({span:.0f}d)", flush=True)
    return series


def _align(series: dict[str, dict], min_hours: int = 500, coverage: float = 0.9):
    """Put every asset on one hourly grid.

    Assets are kept only if they cover most of the window: a pair that listed
    halfway through would otherwise force the shared grid to be short, or drag
    in long stretches of forward-filled prices that look like zero volatility.
    """
    if not series:
        raise SystemExit("no data fetched")

    spans = {s: (min(c), max(c)) for s, c in series.items()}
    grid_end = min(hi for _, hi in spans.values())
    longest = max(hi - lo for lo, hi in spans.values())
    grid_start = grid_end - longest

    keep = [
        s for s, c in series.items()
        if len([h for h in c if grid_start <= h <= grid_end]) >= coverage * (grid_end - grid_start)
    ]
    dropped = sorted(set(series) - set(keep))
    if dropped:
        print(f"  dropped for short history: {', '.join(dropped)}")
    if not keep:
        raise SystemExit("no asset covers the requested window")

    symbols = sorted(keep)
    hours = list(range(grid_start, grid_end + 1))
    T, A = len(hours), len(symbols)
    if T < min_hours:
        raise SystemExit(f"only {T} shared hours, need {min_hours}")

    idx = {h: i for i, h in enumerate(hours)}
    low = np.full((T, A), np.nan)
    high = np.full((T, A), np.nan)
    op = np.full((T, A), np.nan)
    close = np.full((T, A), np.nan)
    vol = np.full((T, A), np.nan)

    for a, s in enumerate(symbols):
        for h, (lo_, hi_, o_, c_, v_) in series[s].items():
            j = idx.get(h)
            if j is not None:
                low[j, a], high[j, a], op[j, a], close[j, a], vol[j, a] = lo_, hi_, o_, c_, v_

    # Forward-fill isolated gaps; a filled bar has no range and zero volume,
    # which is the truth for a halted hour.
    for a in range(A):
        last = None
        for t in range(T):
            if np.isnan(close[t, a]):
                if last is not None:
                    close[t, a] = last
                    low[t, a] = high[t, a] = op[t, a] = last
                    vol[t, a] = 0.0
            else:
                last = close[t, a]

    good = ~np.isnan(close).any(axis=1)
    return (low[good], high[good], op[good], close[good],
            np.nan_to_num(vol[good]), symbols)


def _zscore(x: np.ndarray, window: int) -> np.ndarray:
    """Causal rolling z-score, vectorised. Only ever looks backwards."""
    T = x.shape[0]
    csum = np.cumsum(np.vstack([np.zeros((1, x.shape[1])), x]), axis=0)
    csum2 = np.cumsum(np.vstack([np.zeros((1, x.shape[1])), x**2]), axis=0)
    idx = np.arange(T)
    lo = np.maximum(0, idx - window + 1)
    n = (idx - lo + 1).reshape(-1, 1)
    s = csum[idx + 1] - csum[lo]
    s2 = csum2[idx + 1] - csum2[lo]
    mean = s / n
    var = np.maximum(s2 / n - mean**2, 0.0)
    return (x - mean) / (np.sqrt(var) + 1e-8)


def _rolling_std(x: np.ndarray, window: int) -> np.ndarray:
    T = x.shape[0]
    csum = np.cumsum(np.vstack([np.zeros((1, x.shape[1])), x]), axis=0)
    csum2 = np.cumsum(np.vstack([np.zeros((1, x.shape[1])), x**2]), axis=0)
    idx = np.arange(T)
    lo = np.maximum(0, idx - window + 1)
    n = (idx - lo + 1).reshape(-1, 1)
    s = csum[idx + 1] - csum[lo]
    s2 = csum2[idx + 1] - csum2[lo]
    return np.sqrt(np.maximum(s2 / n - (s / n) ** 2, 0.0))


def build_features(low, high, op, close, vol) -> np.ndarray:
    """[T, A, F] causal features. Nothing here may see the future."""
    logret = np.zeros_like(close)
    logret[1:] = np.log(np.maximum(close[1:], 1e-12) / np.maximum(close[:-1], 1e-12))

    hl = np.log(np.maximum(high, 1e-12) / np.maximum(low, 1e-12))
    # Parkinson: range-based vol, ~5x more efficient than close-to-close.
    parkinson = np.sqrt(np.maximum(hl**2 / (4 * np.log(2)), 0.0))
    # Garman-Klass: adds the open-close leg.
    co = np.log(np.maximum(close, 1e-12) / np.maximum(op, 1e-12))
    gk = np.sqrt(np.maximum(0.5 * hl**2 - (2 * np.log(2) - 1) * co**2, 0.0))

    dollar_vol = vol * close
    logvol = np.log(np.maximum(dollar_vol, 1.0))
    logvol_chg = np.zeros_like(logvol)
    logvol_chg[1:] = logvol[1:] - logvol[:-1]

    rvol = _rolling_std(logret, 24)
    ret_z = _zscore(logret, 168)
    vol_z = _zscore(logvol_chg, 168)
    range_ratio = (high - low) / np.maximum(close, 1e-12)

    feats = np.stack(
        [logret, parkinson, gk, rvol, logvol_chg, ret_z, vol_z, range_ratio], axis=-1
    )
    feats = np.clip(feats, -10.0, 10.0)
    return np.nan_to_num(feats).astype(np.float32)


def build(days: int = 730, out: str = "data/market.npz", throttle: float = 0.55,
          workers: int = 4) -> str:
    raw = fetch_raw(days=days, throttle=throttle, workers=workers)
    low, high, op, close, vol, symbols = _align(raw)
    feats = build_features(low, high, op, close, vol)
    path = Path(out)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        path,
        features=feats,
        price=close.astype(np.float32),
        high=high.astype(np.float32),
        low=low.astype(np.float32),
        symbols=np.array(symbols),
        feature_names=np.array(FEATURES),
    )
    print(
        f"\n{feats.shape[0]} hours x {feats.shape[1]} assets x {feats.shape[2]} features "
        f"({feats.shape[0] * feats.shape[1]:,} asset-hours) -> {path}"
    )
    return str(path)


def load(path: str = "data/market.npz"):
    d = np.load(path, allow_pickle=False)
    return d["features"], d["price"], [str(s) for s in d["symbols"]]


def load_hl(path: str = "data/market.npz"):
    """Highs and lows, for range-based volatility benchmarks."""
    d = np.load(path, allow_pickle=False)
    return d["high"], d["low"]


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=730)
    ap.add_argument("--out", type=str, default="data/market.npz")
    ap.add_argument("--throttle", type=float, default=0.55)
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    build(days=a.days, out=a.out, throttle=a.throttle, workers=a.workers)
