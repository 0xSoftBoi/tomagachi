#!/usr/bin/env python3
"""Scan the open-model market for where inference revenue actually lands.

Answers one question with live data: which models make money, and who
captures it. Pulls three public sources, joins them, prints markdown.

  1. OpenRouter model catalog   -> per-token list prices
  2. OpenRouter rankings page   -> daily token volume per model
  3. OpenRouter model pages     -> 7-day volume, serving providers, top apps
  4. Hugging Face trending API  -> what gets downloaded (note: downloads pay $0)

Gross revenue is volume x list price. It is an upper bound on what the
*serving provider* bills, and it is NOT what the person who trained the
weights earns -- unless they are also the provider. That gap is the whole
finding; the report prints the `serves` column so it stays visible.

Stdlib only, no API key.

    python3 research/scan_market.py > research/market-YYYY-MM-DD.md
"""

import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

OR = "https://openrouter.ai"
HF = "https://huggingface.co"
UA = {"User-Agent": "suwa-tomagachi-market-scan/1.0"}

# Authors that are not frontier labs: community fine-tuners, and small teams
# selling a specialist model or an orchestration system as if it were one.
INDIE_AUTHORS = [
    "thedrummer", "sao10k", "nousresearch", "anthracite-org", "undi95",
    "gryphe", "cognitivecomputations", "aion-labs", "mancer", "arcee-ai",
    "morph", "relace", "inception", "sakana", "perceptron", "allenai",
]

# Rented H100, mid-market on-demand, for the break-even column.
GPU_USD_PER_HOUR = 2.00


def get(url, raw=False):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read().decode("utf-8", "replace")
    return body if raw else json.loads(body)


def embedded_array(html, key):
    """Pull a JSON array out of a Next.js RSC payload by key name."""
    marker = '"%s":[' % key
    i = html.find(marker)
    if i < 0:
        return None
    start = html.index("[", i + len(marker) - 1)
    depth = 0
    for j in range(start, len(html)):
        if html[j] == "[":
            depth += 1
        elif html[j] == "]":
            depth -= 1
            if depth == 0:
                break
    else:
        return None
    try:
        return json.loads(html[start:j + 1])
    except json.JSONDecodeError:
        return None


def catalog():
    """id -> model, plus canonical_slug -> model, preferring standard variants.

    Variant ids (`:free`, `:batch`) carry different prices than the standard
    endpoint; the rankings feed reports one slug for all of them, so match to
    the standard variant or the revenue estimate is off by orders of magnitude.
    """
    data = get(OR + "/api/v1/models")["data"]
    by_id, by_slug = {}, {}
    for m in data:
        by_id[m["id"]] = m
        slug = m.get("canonical_slug") or ""
        if slug and (slug not in by_slug or ":" not in m["id"]):
            by_slug[slug] = m
    return data, by_id, by_slug


def price(model):
    p = model["pricing"]
    return float(p["prompt"]), float(p["completion"])


def gross(rec, model):
    if model is None:
        return 0.0
    pin, pout = price(model)
    return rec["total_prompt_tokens"] * pin + rec["total_completion_tokens"] * pout


def leaderboard(by_slug):
    """Top models platform-wide, one day of traffic, with gross billings."""
    html = get(OR + "/rankings", raw=True).replace('\\"', '"')
    recs = embedded_array(html, "rankingData") or []
    rows = []
    for r in recs:
        slug = r["model_permaslug"]
        m = by_slug.get(slug)
        if m is None:  # dated slugs: nemotron-3-ultra-...-20260604
            base = slug.rsplit("-", 1)[0]
            m = next((v for k, v in by_slug.items() if k.startswith(base)), None)
        rows.append({
            "id": m["id"] if m else slug,
            "tokens": r["total_prompt_tokens"] + r["total_completion_tokens"],
            "requests": r["count"],
            "gross_day": gross(r, m),
        })
    rows.sort(key=lambda r: -r["gross_day"])
    return rows


def model_detail(slug, by_slug, by_id):
    """7 complete days of volume for one model, who serves it, who buys it."""
    html = get("%s/%s" % (OR, slug), raw=True).replace('\\"', '"')
    series = embedded_array(html, "model_chart") or embedded_array(html, "top_apps_chart")
    if not series:
        return None
    week = sorted(series, key=lambda r: r["date"])[-8:-1]  # drop today (partial)
    agg = {
        "total_prompt_tokens": sum(r["total_prompt_tokens"] for r in week),
        "total_completion_tokens": sum(r["total_completion_tokens"] for r in week),
    }
    requests = sum(r["count"] for r in week)

    apps = []
    for a in (embedded_array(html, "top_apps") or [])[:3]:
        title = (a.get("app") or {}).get("title")
        if title:
            apps.append(title)

    try:
        eps = get("%s/api/v1/models/%s/endpoints" % (OR, slug))["data"]["endpoints"]
        serves = [e.get("provider_name") for e in eps]
    except Exception:
        serves = []

    m = by_id.get(slug) or by_slug.get(slug) or next(
        (v for k, v in by_id.items() if k.startswith(slug + ":")), None)
    return {
        "id": slug,
        "tokens": agg["total_prompt_tokens"] + agg["total_completion_tokens"],
        "requests": requests,
        "gross_week": gross(agg, m),
        "price": price(m) if m else (0.0, 0.0),
        "serves": serves,
        "apps": apps,
        # Self-served means the trainer bills the tokens. Otherwise a host does,
        # and the trainer's cut of this number is zero.
        "self_served": bool(serves) and any(
            slug.split("/")[0].replace("-", "") in (s or "").lower().replace(" ", "").replace("-", "")
            for s in serves),
    }


def hf_trending(limit=15):
    url = "%s/api/models?sort=trendingScore&direction=-1&limit=%d" % (HF, limit)
    return [{
        "id": m["id"],
        "downloads": m.get("downloads") or 0,
        "likes": m.get("likes") or 0,
        "task": m.get("pipeline_tag") or "-",
    } for m in get(url)]


def hf_search(query, limit=10):
    url = "%s/api/models?search=%s&sort=downloads&direction=-1&limit=%d" % (
        HF, urllib.parse.quote(query), limit)
    return [{
        "id": m["id"],
        "downloads": m.get("downloads") or 0,
        "likes": m.get("likes") or 0,
    } for m in get(url)]


def usd(x):
    return "$" + format(x, ",.0f")


def main():
    out = sys.stdout.write
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out("# Model market scan -- %s\n\n" % stamp)
    out("Gross = volume x list price. It is billed by whoever *serves* the model.\n")
    out("A fine-tuner who does not run the endpoint earns none of it.\n\n")

    data, by_id, by_slug = catalog()

    out("## Platform leaderboard (OpenRouter, 1 day)\n\n")
    out("| model | tokens/day | requests/day | gross/day |\n|---|---:|---:|---:|\n")
    board = leaderboard(by_slug)
    for r in board:
        out("| `%s` | %.2fT | %.1fM | %s |\n" % (
            r["id"], r["tokens"] / 1e12, r["requests"] / 1e6, usd(r["gross_day"])))
    out("\n**Top-20 total: %.0fT tokens/day, %s/day gross (~$%.1fB/yr run-rate).**\n\n" % (
        sum(r["tokens"] for r in board) / 1e12,
        usd(sum(r["gross_day"] for r in board)),
        sum(r["gross_day"] for r in board) * 365 / 1e9))

    out("## Non-lab models: who earns, and who actually collects it\n\n")
    slugs = [m["id"].split(":")[0] for m in data
             if m["id"].split("/")[0] in INDIE_AUTHORS]
    rows = []
    for slug in sorted(set(slugs)):
        try:
            d = model_detail(slug, by_slug, by_id)
        except Exception as e:  # a single dead page must not kill the scan
            sys.stderr.write("skip %s: %s\n" % (slug, e))
            continue
        if d:
            rows.append(d)
    rows.sort(key=lambda r: -r["gross_week"])

    breakeven = GPU_USD_PER_HOUR * 24 * 7
    out("| model | $/M in-out | tokens/wk | gross/wk | served by | trainer paid? | top buyers |\n")
    out("|---|---|---:|---:|---|---|---|\n")
    for r in rows:
        out("| `%s` | %.2f / %.2f | %.2fB | %s | %s | %s | %s |\n" % (
            r["id"], r["price"][0] * 1e6, r["price"][1] * 1e6,
            r["tokens"] / 1e9, usd(r["gross_week"]),
            ", ".join(x for x in r["serves"] if x) or "-",
            "yes" if r["self_served"] else "no",
            ", ".join(r["apps"]) or "-"))
    out("\nOne rented H100 costs %s/week at $%.2f/hr. Models grossing less than "
        "that cannot pay for the GPU they run on, let alone the training.\n\n"
        % (usd(breakeven), GPU_USD_PER_HOUR))

    out("## Hugging Face trending -- attention, not revenue\n\n")
    out("| repo | downloads | likes | task |\n|---|---:|---:|---|\n")
    for m in hf_trending():
        out("| `%s` | %s | %s | %s |\n" % (
            m["id"], format(m["downloads"], ","), m["likes"], m["task"]))

    out("\n## World models on the Hub, by downloads\n\n")
    out("| repo | downloads | likes |\n|---|---:|---:|\n")
    for m in hf_search("world model"):
        out("| `%s` | %s | %s |\n" % (m["id"], format(m["downloads"], ","), m["likes"]))
    out("\n")


if __name__ == "__main__":
    main()
