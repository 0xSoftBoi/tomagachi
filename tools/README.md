# The creature's skills

SUWA-WM as tools any agent can call. `mcp_server.py` speaks MCP over stdio
(JSON-RPC 2.0), stdlib only — no framework, no install.

## Tools

| tool | what it answers |
|---|---|
| `execution_risk` | forward risk + routing verdict for every asset, ranked |
| `asset_risk` | the same for one symbol, with a slippage number in bps |
| `market_state` | is the market calmer or more dangerous than usual, and why |
| `creature_vitals` | live on-chain state: mood, treasury, verified epochs |
| `model_provenance` | which weights are answering, and their measured scores |

## Wire it up

Claude Code / Claude Desktop:

```json
{
  "mcpServers": {
    "suwa-wm": {
      "command": "python3",
      "args": ["/abs/path/to/tomagachi/tools/mcp_server.py"],
      "env": {
        "SUWA_MODEL": "/abs/path/to/tomagachi/runs/finetune/execution.pt",
        "RPC_URL": "https://mainnet.base.org"
      }
    }
  }
}
```

Then ask: *"what's the execution risk on ETH right now?"* or *"is this a good
window to route a swap?"*

## What a call looks like

```json
{
  "symbol": "ETH",
  "price_usd": 2449.32,
  "horizon_hours": 6,
  "expected_drift": -0.0004,
  "expected_move": 0.0160,
  "baseline_move": 0.0113,
  "risk_ratio": 1.42,
  "slippage_hint_bps": 80.0,
  "verdict": "elevated risk - widen slippage or wait"
}
```

`expected_move` is a 1-sigma 6-hour log return. `risk_ratio` compares it with
the asset's own trailing volatility, so >1 means unusually dangerous *for that
asset*. `slippage_hint_bps` is half a sigma in basis points — a starting point,
not a guarantee.

**Read `expected_drift` as noise.** The model has no measurable directional
edge (see [`../model/README.md`](../model/README.md)); it is published for
completeness, not for trading.

## Environment

| var | default |
|---|---|
| `SUWA_MODEL` | `runs/finetune/execution.pt` |
| `RPC_URL` | `https://mainnet.base.org` |
| `DEPLOYMENT` | `agent/deployment.json` |

Live market data is fetched from CoinGecko and cached for 10 minutes; pass
`{"refresh": true}` to force a re-pull. `creature_vitals` needs a deployed
creature — it reports plainly when there isn't one instead of failing.
