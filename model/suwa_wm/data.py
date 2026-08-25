"""Real market data for SUWA-WM.

The creature's world is not a toy grid — it is the cross-asset crypto market
that Suwappu actually routes through. This pulls real hourly history for the
assets on Suwappu's supported chains and turns it into the tensor the world
model trains on.

Source: CoinGecko public API (no key needed, throttled).
Cache:  data/market.npz — fetch once, train many times.
"""

from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path

import numpy as np

# Assets covering Suwappu's routing universe: the native token of each
# supported chain, plus the majors that actually carry cross-chain volume.
UNIVERSE: list[tuple[str, str]] = [
    ("bitcoin", "BTC"),
    ("ethereum", "ETH"),
    ("solana", "SOL"),
    ("binancecoin", "BNB"),
    ("avalanche-2", "AVAX"),
    ("matic-network", "POL"),
    ("fantom", "FTM"),
    ("sui", "SUI"),
    ("the-open-network", "TON"),
    ("optimism", "OP"),
    ("arbitrum", "ARB"),
    ("mantle", "MNT"),
    ("chainlink", "LINK"),
    ("uniswap", "UNI"),
    ("aave", "AAVE"),
    ("ripple", "XRP"),
    ("dogecoin", "DOGE"),
    ("litecoin", "LTC"),
    ("cardano", "ADA"),
    ("polkadot", "DOT"),
]

FEATURES = ["logret", "logvol_chg", "rvol_24h", "ret_z_168h", "vol_z_168h", "mcap_share"]
N_FEATURES = len(FEATURES)

CG = "https://api.coingecko.com/api/v3"


def _get(url: str, retries: int = 4) -> dict:
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "suwa-wm/1.0"})
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            if attempt == retries - 1:
                raise
            wait = 10 * (attempt + 1)
            print(f"    retry in {wait}s ({e})")
            time.sleep(wait)
    raise RuntimeError("unreachable")


def fetch_raw(days: int = 90, throttle: float = 8.0) -> dict:
    """Hourly price / volume / market-cap per asset, on a shared time grid."""
    series: dict[str, dict] = {}
    for i, (cg_id, symbol) in enumerate(UNIVERSE):
        url = f"{CG}/coins/{cg_id}/market_chart?vs_currency=usd&days={days}&interval=hourly"
        print(f"  [{i+1}/{len(UNIVERSE)}] {symbol} …", flush=True)
        d = _get(url)
        if not d.get("prices"):
            print(f"    no data for {symbol}, skipping")
            continue
        series[symbol] = d
        if i < len(UNIVERSE) - 1:
            time.sleep(throttle)
    return series


def _align(
    series: dict[str, dict], min_hours: int = 500
) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[str]]:
    """Align every asset onto the hourly timestamps they all share.

    `min_hours` guards against a truncated fetch silently producing a tiny
    corpus. Training wants a lot; live inference needs only enough history to
    fill the longest feature look-back, so it passes a smaller floor.
    """
    symbols = sorted(series.keys())
    # Round to the hour so tiny timestamp jitter still lines up.
    stamp_sets = []
    for s in symbols:
        stamp_sets.append({int(round(p[0] / 3_600_000)) for p in series[s]["prices"]})
    common = sorted(set.intersection(*stamp_sets))
    if len(common) < min_hours:
        raise SystemExit(
            f"only {len(common)} shared hours across assets, need {min_hours}"
        )

    idx = {t: i for i, t in enumerate(common)}
    T, A = len(common), len(symbols)
    price = np.full((T, A), np.nan, dtype=np.float64)
    vol = np.full((T, A), np.nan, dtype=np.float64)
    mcap = np.full((T, A), np.nan, dtype=np.float64)

    for a, s in enumerate(symbols):
        d = series[s]
        for key, arr in (("prices", price), ("total_volumes", vol), ("market_caps", mcap)):
            for ts, value in d[key]:
                h = int(round(ts / 3_600_000))
                if h in idx:
                    arr[idx[h], a] = value

    # Forward-fill the occasional gap, then drop any row still incomplete.
    for arr in (price, vol, mcap):
        for a in range(A):
            col = arr[:, a]
            last = np.nan
            for t in range(T):
                if np.isnan(col[t]):
                    col[t] = last
                else:
                    last = col[t]
    good = ~np.isnan(price).any(axis=1) & ~np.isnan(vol).any(axis=1) & ~np.isnan(mcap).any(axis=1)
    return price[good], vol[good], mcap[good], symbols


def _zscore(x: np.ndarray, window: int) -> np.ndarray:
    """Causal rolling z-score — only ever looks backwards."""
    T = x.shape[0]
    out = np.zeros_like(x)
    for t in range(T):
        lo = max(0, t - window + 1)
        w = x[lo : t + 1]
        mu = w.mean(axis=0)
        sd = w.std(axis=0) + 1e-8
        out[t] = (x[t] - mu) / sd
    return out


def build_features(price: np.ndarray, vol: np.ndarray, mcap: np.ndarray) -> np.ndarray:
    """[T, A, F] causal features. Nothing here may see the future."""
    logret = np.zeros_like(price)
    logret[1:] = np.log(price[1:] / np.maximum(price[:-1], 1e-12))

    logvol = np.log(np.maximum(vol, 1.0))
    logvol_chg = np.zeros_like(logvol)
    logvol_chg[1:] = logvol[1:] - logvol[:-1]

    # Trailing 24h realized volatility.
    rvol = np.zeros_like(price)
    for t in range(price.shape[0]):
        lo = max(0, t - 23)
        rvol[t] = logret[lo : t + 1].std(axis=0)

    ret_z = _zscore(logret, 168)
    vol_z = _zscore(logvol_chg, 168)
    share = mcap / np.maximum(mcap.sum(axis=1, keepdims=True), 1e-12)

    feats = np.stack([logret, logvol_chg, rvol, ret_z, vol_z, share], axis=-1)
    # Clip fat tails so a single wick cannot dominate training.
    feats = np.clip(feats, -10.0, 10.0)
    return np.nan_to_num(feats).astype(np.float32)


def build(days: int = 90, out: str = "data/market.npz", throttle: float = 8.0) -> str:
    raw = fetch_raw(days=days, throttle=throttle)
    price, vol, mcap, symbols = _align(raw)
    feats = build_features(price, vol, mcap)
    path = Path(out)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        path,
        features=feats,
        price=price.astype(np.float32),
        symbols=np.array(symbols),
        feature_names=np.array(FEATURES),
    )
    print(f"\n{feats.shape[0]} hours x {feats.shape[1]} assets x {feats.shape[2]} features -> {path}")
    return str(path)


def load(path: str = "data/market.npz"):
    d = np.load(path, allow_pickle=False)
    return d["features"], d["price"], [str(s) for s in d["symbols"]]


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=90)
    ap.add_argument("--out", type=str, default="data/market.npz")
    ap.add_argument("--throttle", type=float, default=8.0)
    a = ap.parse_args()
    build(days=a.days, out=a.out, throttle=a.throttle)
