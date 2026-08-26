"""Aggregate walk-forward runs into the numbers we are willing to defend.

Reports mean +/- std across folds and seeds, and how often the model beat the
best benchmark. A win on one fold is an anecdote; a consistent win across
several regimes is a result.
"""

from __future__ import annotations

import argparse
import json
import statistics as st
from pathlib import Path


def spread(values: list[float]) -> str:
    if len(values) < 2:
        return f"{values[0]:8.4f}"
    return f"{st.mean(values):8.4f} +/-{st.stdev(values):.4f}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", type=str, default="../runs/bench")
    ap.add_argument("--out", type=str, default=None)
    args = ap.parse_args()

    runs = [json.loads(p.read_text()) for p in sorted(Path(args.dir).glob("fold*_seed*.json"))]
    if not runs:
        raise SystemExit(f"no results in {args.dir}")

    keys = ["nll", "naive_cc_nll", "naive_pk_nll", "har_nll",
            "qlike", "naive_cc_qlike", "naive_pk_qlike", "har_qlike",
            "sigma_corr", "naive_cc_sigma_corr", "naive_pk_sigma_corr",
            "calibration_z_rms", "naive_cc_calibration", "naive_pk_calibration",
            "direction_acc", "nll_vs_best", "qlike_vs_best"]
    agg = {k: [r["pretrained"][k] for r in runs if k in r["pretrained"]] for k in keys}

    n_folds = len({r["fold"] for r in runs})
    n_seeds = len({r["seed"] for r in runs})
    print(f"{len(runs)} runs — {n_folds} folds x {n_seeds} seeds, "
          f"{runs[0]['assets']} assets, {runs[0]['test']} test windows per fold\n")

    print("                        NLL (nats)          QLIKE            risk corr   calib")
    def row(label, nll, ql, corr, cal):
        print(f"  {label:20s} {spread(agg[nll])}  {spread(agg[ql])}  "
              f"{spread(agg[corr]) if corr else '':>18s}  {spread(agg[cal]) if cal else '':>16s}")

    row("SUWA-WM", "nll", "qlike", "sigma_corr", "calibration_z_rms")
    row("naive close-to-close", "naive_cc_nll", "naive_cc_qlike",
        "naive_cc_sigma_corr", "naive_cc_calibration")
    row("naive Parkinson", "naive_pk_nll", "naive_pk_qlike",
        "naive_pk_sigma_corr", "naive_pk_calibration")
    print(f"  {'HAR (fitted)':20s} {spread(agg['har_nll'])}  {spread(agg['har_qlike'])}")

    wins_nll = sum(1 for v in agg["nll_vs_best"] if v > 0)
    wins_ql = sum(1 for v in agg["qlike_vs_best"] if v > 0)
    print(f"\n  vs the BEST benchmark on each run:")
    print(f"    NLL   {spread(agg['nll_vs_best'])}   beat it in {wins_nll}/{len(runs)} runs")
    print(f"    QLIKE {spread(agg['qlike_vs_best'])}   beat it in {wins_ql}/{len(runs)} runs")
    print(f"    directional accuracy {spread(agg['direction_acc'])} "
          f"(0.5 = no edge; this model does not claim one)")

    gains = [r["pretraining_gain_nll"] for r in runs if "pretraining_gain_nll" in r]
    if gains:
        pos = sum(1 for g in gains if g > 0)
        print(f"\n  pretraining vs identical-budget scratch: {spread(gains)} nats, "
              f"helped in {pos}/{len(gains)} runs")

    summary = {
        "runs": len(runs), "folds": n_folds, "seeds": n_seeds,
        "assets": runs[0]["assets"],
        "metrics": {k: {"mean": st.mean(v), "std": st.stdev(v) if len(v) > 1 else 0.0}
                    for k, v in agg.items() if v},
        "nll_wins_vs_best": f"{wins_nll}/{len(runs)}",
        "qlike_wins_vs_best": f"{wins_ql}/{len(runs)}",
        "pretraining_gain_nll": {"mean": st.mean(gains),
                                 "std": st.stdev(gains) if len(gains) > 1 else 0.0} if gains else None,
    }
    dest = Path(args.out) if args.out else Path(args.dir) / "summary.json"
    dest.write_text(json.dumps(summary, indent=2))
    print(f"\nwrote {dest}")


if __name__ == "__main__":
    main()
