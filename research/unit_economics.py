#!/usr/bin/env python3
"""Unit economics for selling inference, calibrated against live comparables.

The scan (research/model-economics.md) says who earns. This says whether we
could, at what volume, and where the money leaks. Every comparable in the
CALIBRATION table is measured -- realized $/M and prompt:completion mix come
from each model's own 7-day usage series priced at its list rate.

The finding the model exists to make legible: for a small fine-tune the
binding constraint is NOT price, it is GPU utilization. A dedicated H100 bills
168 hours a week whether or not traffic shows up, and the best community
fine-tune on OpenRouter only generates ~8 hours of work in that week.

Stdlib only.  python3 research/unit_economics.py
"""

GPU_USD_HR = 2.00       # rented H100, mid-market on-demand
HOURS_WK = 168.0

# Throughput for a ~12-24B model on one H100 under vLLM-style continuous
# batching. ASSUMPTIONS -- the sensitivity table below exists because these
# are the least certain numbers here.
PREFILL_TOK_S = 20_000  # prompt tokens (compute-bound, fast)
DECODE_TOK_S = 2_000    # completion tokens (memory-bound, slow, aggregate)

# (label, realized $/M blended, prompt:completion ratio, tokens/wk observed)
CALIBRATION = [
    ("sakana/fugu-ultra        orchestrated agents", 5.586, 41.7, 1.46e9),
    ("anthropic/claude-opus-5  frontier",            5.535, 36.4, 1.49e12),
    ("aion-labs/aion-3.0       orchestrated RP",     3.273, 10.0, 8.70e9),
    ("anthracite/magnum-v4-72b premium RP tune",     3.120, 15.6, 0.12e9),
    ("morph/morph-v3-large     apply specialist",    1.375, 1.1,  0.10e9),
    ("relace/relace-apply-3    apply specialist",    1.035, 1.2,  0.39e9),
    ("thedrummer/cydonia-24b   community RP tune",   0.311, 16.7, 1.31e9),
    ("deepseek/deepseek-v4-flash commodity",         0.084, 18.0, 5.53e12),
    ("sao10k/l3-lunaris-8b     commodity RP tune",   0.041, 13.0, 5.44e9),
]


def tokens_per_gpu_hour(pc_ratio):
    """A blended token is mostly prompt at high p:c, and prompt is cheap to serve."""
    p = pc_ratio / (1.0 + pc_ratio)
    seconds_per_m = 1e6 * p / PREFILL_TOK_S + 1e6 * (1 - p) / DECODE_TOK_S
    return 3600.0 / seconds_per_m * 1e6


def economics(price_per_m, pc_ratio, served_wk, gpus=1.0, upstream_cogs_per_m=0.0):
    """Weekly P&L for a given volume on `gpus` dedicated GPUs.

    Volume drives the model, not utilization -- because demand is the thing we
    do not control. gpus=0 models an orchestration product with no hardware:
    COGS is upstream API tokens and there is no idle to pay for.
    """
    cap = tokens_per_gpu_hour(pc_ratio) * HOURS_WK * gpus
    revenue = served_wk / 1e6 * price_per_m
    gpu_cost = GPU_USD_HR * HOURS_WK * gpus                     # billed regardless
    upstream = served_wk / 1e6 * upstream_cogs_per_m
    contribution = revenue - gpu_cost - upstream
    return {
        "capacity_wk": cap, "served_wk": served_wk, "revenue": revenue,
        "utilization": served_wk / cap if cap else 0.0,
        "gpu_cost": gpu_cost, "upstream": upstream, "contribution": contribution,
        "margin": contribution / revenue if revenue else float("-inf"),
        "cogs_per_m": (gpu_cost + upstream) / (served_wk / 1e6) if served_wk else float("inf"),
    }


def usd(x):
    return ("-$" if x < 0 else "$") + format(abs(x), ",.0f")


def main():
    print("# Unit economics -- selling inference from the creature\n")
    print("Rented H100 at $%.2f/hr = %s/week, billed whether traffic arrives or not.\n"
          % (GPU_USD_HR, usd(GPU_USD_HR * HOURS_WK)))

    print("## Calibration: what a token is actually worth, by archetype\n")
    print("Realized $/M is blended over prompt+completion at list price. A high")
    print("prompt:completion ratio means most billed tokens are cheap prompt tokens.\n")
    print(f"{'comparable':52s}{'$/M':>7s}{'p:c':>7s}{'tok/wk':>10s}{'GPU-hrs/wk':>12s}{'H100s needed':>14s}")
    for label, price, pc, vol in CALIBRATION:
        hrs = vol / tokens_per_gpu_hour(pc)
        print(f"{label:52s}{price:7.2f}{pc:7.1f}{vol/1e9:9.2f}B{hrs:12.1f}{hrs/HOURS_WK:14.2f}")

    print("\n**The leak.** cydonia-24b is the best-performing independent fine-tune on")
    print("the platform, and a full week of its traffic is ~27 GPU-hours -- 16% of one")
    print("H100. It grosses $409 against a $336 machine that bills for all 168 hours.")
    print("The 84% that sits idle is the entire margin. Price is not the problem.\n")

    print("## Scenarios\n")
    scenarios = [
        # label, $/M, p:c, served tokens/wk, GPUs, upstream COGS/M
        ("A  match cydonia exactly, dedicated GPU", 0.311, 16.7, 1.31e9, 1.0, 0.0),
        ("B  5 tunes of that size, one shared GPU", 0.311, 16.7, 6.55e9, 1.0, 0.0),
        ("C  same fleet, priced as a premium system", 1.500, 16.7, 6.55e9, 1.0, 0.0),
        ("D  match aion volume, no GPUs, upstream API", 3.273, 10.0, 8.70e9, 0.0, 1.20),
        ("E  task specialist, balanced p:c", 1.200, 1.2, 1.00e9, 1.0, 0.0),
    ]
    print(f"{'scenario':44s}{'served/wk':>11s}{'util':>7s}{'revenue':>10s}"
          f"{'COGS/M':>9s}{'contrib/wk':>12s}{'margin':>8s}")
    for label, price, pc, served, gpus, upstream in scenarios:
        e = economics(price, pc, served, gpus, upstream)
        util = "n/a" if not gpus else "%.0f%%" % (e["utilization"] * 100)
        print(f"{label:44s}{e['served_wk']/1e9:10.2f}B{util:>7s}{usd(e['revenue']):>10s}"
              f"{e['cogs_per_m']:9.3f}{usd(e['contribution']):>12s}{e['margin']*100:7.0f}%")

    print("\nA is what the best independent fine-tune actually earns: $73 a week of")
    print("contribution, which is not a business. B is the same product with the")
    print("idle sold to four siblings. C is B plus the pricing power that only comes")
    print("from selling a system rather than a personality. D runs no hardware at")
    print("all -- COGS is upstream API tokens, so it scales from zero with no idle")
    print("risk, but it has no weights to release, which is why it cannot be the")
    print("whole answer for this repo.\n")

    print("## Sensitivity: weekly contribution, one GPU, RP mix (p:c 16.7)\n")
    prices = [0.30, 0.60, 1.00, 2.00, 3.00]
    utils = [0.05, 0.16, 0.30, 0.60, 0.90]
    cap = tokens_per_gpu_hour(16.7) * HOURS_WK
    header = "util \\ $/M"
    print("%12s" % header + "".join(f"{p:>11.2f}" for p in prices))
    for u in utils:
        cells = "".join(
            f"{usd(economics(p, 16.7, cap * u)['contribution']):>11s}" for p in prices)
        print(f"{u*100:11.0f}%" + cells)
    print("\n(16%% is where cydonia sits: %.2fB tokens/wk on one H100.)" % (cap * 0.16 / 1e9))
    print("\nEverything above the zero line is a utilization story or a pricing story.")
    print("Winning on both is the only quadrant that pays a team.\n")

    print("## Where these numbers are soft\n")
    print("Throughput is the least certain input. Halving both prefill and decode")
    print("doubles COGS/M -- at scenario B that moves $0.05/M to $0.10/M against a")
    print("$0.31 price, so the ranking of the scenarios does not change. The")
    print("conclusion is robust to being wrong about the GPU by 2x; it is not")
    print("robust to being wrong about demand.")
    print("\nRealized $/M ignores prompt-cache discounts, so heavily-cached")
    print("comparables (opus at 86% cached, ox-alpha at 89%) are overstated. It")
    print("does not affect the independents, which cache little or not at all.\n")

    print("## What has to be true\n")
    for i, line in enumerate([
        "Fill the GPU. Break-even on one H100 is 1.1B tokens/wk at the "
        "community-tune price -- 13% utilization. One tune reaches 16% and "
        "clears $71. A fleet of five reaches 82% and clears $1,701. The "
        "second product on a shared base is worth more than the first.",
        "Realized price >= $0.60/M, double the community-tune tier. That is "
        "the gap between selling a personality ($0.31) and selling a system "
        "($3.27), and it is worth more than any amount of GPU tuning.",
        "Demand without a sales team: ~6.5B tokens/wk routed to us. This is "
        "the binding constraint and the only one we cannot buy our way out "
        "of. OpenRouter discovery is the only zero-CAC channel an anonymous "
        "team has.",
    ], 1):
        print(f"{i}. {line}")
    print()


if __name__ == "__main__":
    main()
