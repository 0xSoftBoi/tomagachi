TAO_USD = 237.48          # coingecko, live
EMISSION_TAO_DAY = 3559   # post Dec-2025 halving
SUBNETS = 129
MINER_SHARE = 0.41
MINER_UIDS = 190          # of 256 neurons; rest are validators

day = EMISSION_TAO_DAY * TAO_USD
year = day * 365
miners = year * MINER_SHARE
per_subnet = miners / SUBNETS
per_uid_year = per_subnet / MINER_UIDS

print(f"network emissions      ${day:,.0f}/day   ${year/1e6:,.1f}M/yr")
print(f"  of which to miners   ${miners/1e6:,.1f}M/yr")
print(f"  per subnet (avg)     ${per_subnet:,.0f}/yr")
print(f"  per miner UID (avg)  ${per_uid_year:,.0f}/yr = ${per_uid_year/52:,.0f}/wk")
print()
print(f"one H100, billed idle or not          $336/wk   (research/unit_economics.py)")
print(f"repo scenario A (near-idle shop)      $71/wk")
print(f"repo scenario B (the week-10 gate)    $1,701/wk")
print()
for lo, hi in [(1.1e6, 5.6e6)]:
    print(f"verified CUSTOMER revenue, whole network:  ${lo/1e6:.1f}M-${hi/1e6:.1f}M/yr")
    print(f"  as a share of emissions paid out:        {lo/year*100:.1f}%-{hi/year*100:.1f}%")
print(f"openrouter customer spend (research/model-economics.md): $1,800M/yr")
print(f"  bittensor's real market is             {1800e6/hi:,.0f}x-{1800e6/lo:,.0f}x smaller")
print()
print(f"own subnet: 1,500 TAO = ${1500*TAO_USD:,.0f}  (doubles per registration, never refunded)")
