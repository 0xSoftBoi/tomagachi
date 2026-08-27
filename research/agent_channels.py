#!/usr/bin/env python3
"""Every channel that could pay for a character model, with what it pays.

The scan in model-economics.md answered "who earns on OpenRouter". This one
asks the wider question: across the whole 2026 agent economy -- app stores,
bot platforms, creator programs, enterprise agent marketplaces, model hubs --
which channels actually route money to an independent operator of a fine-tuned
character model, and how much.

Figures are measured or published, each sourced in agent-ecosystem.md. Where a
channel publishes only totals, the per-creator number is the total divided by
the creator count, and is labelled as such.

Stdlib only.  python3 research/agent_channels.py
"""

WK = 52.0

# (channel, what it pays for, evidence, $/yr to ALL creators, creators, gate)
CHANNELS = [
    ("OpenRouter",        "tokens served, invoiced monthly",
     "$1.8B/yr customer spend across catalog",      None,   None, "entity + HTTPS + approval"),
    ("Direct (BYO endpoint)", "tokens served, billed by us",
     "Janitor AI 117M visits/mo; custom OpenAI URL", None,   None, "HTTPS only"),
    ("Poe",               "per message, creator sets price",
     "$100k paid to bot makers by mid-2026",       100_000,   None, "Stripe account, US only"),
    ("Civitai",           "per generation using your LoRA",
     "$43k in March 2026, 254 creators",           43_000*12, 254, "images only -- no text equivalent"),
    ("GPT Store",         "usage revenue share",
     "creators report $100-500/mo ceiling",         None,   None, "OpenAI approval"),
    ("Claude Skills",     "distribution, not revenue",
     "free distribution as of 2026",                    0,   None, "n/a"),
    ("Hugging Face",      "nothing",
     "no per-query share to model authors",             0,   None, "n/a"),
    ("Enterprise agent mkts", "outcome pricing, B2B",
     "Intercom Fin $0.99/resolved ticket",          None,   None, "vendor vetting, enterprise sales"),
    ("Bittensor",         "emissions, not customers",
     "$99/wk per avg miner UID",                    None,   None, "registration TAO + GPU"),
]

# --- what the direct channel would take -----------------------------------
# Priced from characters.json; the mix is cydonia-24b's measured p:c, the
# closest live comparable (a community RP tune) in unit_economics.py.
PROMPT_USD_M, COMPLETION_USD_M = 0.60, 1.20
PC_RATIO = 16.7
MSGS_DAY = 200          # a committed roleplay user; the tail is much lighter
CTX_TOKENS = 4_000      # a card plus scrollback, resent every turn
REPLY_TOKENS = 250

GATE_WK = 400.0         # operating-plan.md week-10 gate
SCENARIO_B_WK = 1_701.0 # unit_economics.py scenario B


def blended_per_m():
    p = PC_RATIO / (1.0 + PC_RATIO)
    return p * PROMPT_USD_M + (1 - p) * COMPLETION_USD_M


def user_week_usd():
    tokens_day = MSGS_DAY * (CTX_TOKENS + REPLY_TOKENS)
    return tokens_day * 7 / 1e6 * blended_per_m()


def main():
    print("# Where an independent character-model operator can actually get paid\n")
    w = 22
    print(f"{'channel':{w}s}{'pays for':34s}{'to all creators':>18s}  {'gate'}")
    print("-" * 118)
    for name, pays, ev, total, n, gate in CHANNELS:
        amount = "not published" if total is None else (f"${total:,.0f}/yr" if total else "nothing")
        print(f"{name:{w}s}{pays:34s}{amount:>18s}  {gate}")
        print(f"{'':{w}s}{'  ' + ev}")
    print()

    civ = [c for c in CHANNELS if c[0] == "Civitai"][0]
    print(f"Civitai is the closest working analogue -- a creator program that pays per")
    print(f"use of a fine-tuned adapter. Divided across its {civ[4]} paid creators that is")
    print(f"${civ[3]/civ[4]:,.0f}/yr each, or ${civ[3]/civ[4]/WK:,.0f}/wk. Its top earner made $8,500 in one month.")
    print()

    print("## The direct channel, sized\n")
    print(f"Blended price at our list rates and a {PC_RATIO:.1f}:1 prompt:completion mix:")
    print(f"  ${blended_per_m():.3f}/M\n")
    print(f"One committed user: {MSGS_DAY} msgs/day x ({CTX_TOKENS:,} ctx + {REPLY_TOKENS} reply) tokens")
    print(f"  = ${user_week_usd():.2f}/wk\n")
    for label, target in (("week-10 gate", GATE_WK), ("scenario B", SCENARIO_B_WK)):
        print(f"  {label:14s} ${target:>7,.0f}/wk  needs {target/user_week_usd():>6,.0f} committed users")
    print()
    print(f"For scale: Janitor AI alone draws 117,000,000 visits a month, and its")
    print(f"proxy setting takes any OpenAI-compatible URL. The gate is ~{GATE_WK/user_week_usd():,.0f} people.")


if __name__ == "__main__":
    main()
