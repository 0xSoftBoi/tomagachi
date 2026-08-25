"""SUWA-WM MCP server — the creature's skills, exposed to any agent.

Speaks MCP over stdio (JSON-RPC 2.0), stdlib only, no framework. Point any MCP
client at it:

    {"mcpServers": {"suwa-wm": {"command": "python3",
      "args": ["tools/mcp_server.py"], "env": {"SUWA_MODEL": "runs/finetune/execution.pt"}}}}

Tools it offers:
    execution_risk    forward risk + routing guidance for every asset
    asset_risk        the same for one asset, with a slippage number
    market_state      one-line read on how dangerous the market is right now
    creature_vitals   the on-chain creature: mood, treasury, training progress
    model_provenance  which weights these are, and the hash the chain attests to
"""

from __future__ import annotations

import json
import os
import sys
import traceback
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "model"))

PROTOCOL = "2025-06-18"
# Prefer a locally trained model; fall back to the weights shipped in the repo
# so a fresh clone works with no training step.
_TRAINED = ROOT / "runs" / "finetune" / "execution.pt"
_SHIPPED = ROOT / "model" / "weights" / "execution.pt"
MODEL_PATH = os.environ.get("SUWA_MODEL", str(_TRAINED if _TRAINED.exists() else _SHIPPED))
RPC_URL = os.environ.get("RPC_URL", "https://mainnet.base.org")
DEPLOYMENT = os.environ.get("DEPLOYMENT", str(ROOT / "agent" / "deployment.json"))

_forecaster = None
_cached: dict | None = None


def forecaster():
    global _forecaster
    if _forecaster is None:
        from suwa_wm.infer import Forecaster

        if not Path(MODEL_PATH).exists():
            raise RuntimeError(
                f"no model at {MODEL_PATH} — train one with model/finetune.py "
                f"or set SUWA_MODEL"
            )
        _forecaster = Forecaster(MODEL_PATH)
    return _forecaster


def forecast(refresh: bool = False) -> dict:
    """Cached inside the process: each call otherwise re-pulls hourly history."""
    global _cached
    if _cached is None or refresh:
        _cached = forecaster().forecast_live(use_cache=not refresh)
    return _cached


# ----------------------------------------------------------------- chain reads

def _eth_call(to: str, data: str) -> str:
    payload = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "eth_call",
        "params": [{"to": to, "data": data}, "latest"],
    }).encode()
    req = urllib.request.Request(
        RPC_URL, data=payload, headers={"content-type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=25) as r:
        out = json.loads(r.read().decode())
    if "error" in out:
        raise RuntimeError(out["error"])
    return out["result"]


MOODS = ["EGG", "HAPPY", "PECKISH", "STARVING", "HIBERNATING"]
# keccak selectors of vitals() and says()
SEL_VITALS = "0xc999fa9c"
SEL_SAYS = "0xc8c0bb14"


def _word(hexstr: str, i: int) -> int:
    return int(hexstr[2 + i * 64 : 2 + (i + 1) * 64], 16)


def creature_vitals() -> dict:
    dep_path = Path(DEPLOYMENT)
    if not dep_path.exists():
        return {"error": f"no deployment.json at {dep_path}; the creature is not deployed yet"}
    dep = json.loads(dep_path.read_text())
    addr = dep["tomagachi"]
    raw = _eth_call(addr, SEL_VITALS)
    wei = 10**18
    return {
        "address": addr,
        "token": dep.get("token"),
        "mood": MOODS[_word(raw, 0)] if _word(raw, 0) < len(MOODS) else "?",
        "satiety_eth": _word(raw, 1) / wei,
        "treasury_eth": _word(raw, 2) / wei,
        "total_fed_eth": _word(raw, 3) / wei,
        "paid_to_workers_eth": _word(raw, 4) / wei,
        "verified_releases": _word(raw, 5),
        "epochs": _word(raw, 6),
        "training_in_flight": bool(_word(raw, 7)),
    }


# ----------------------------------------------------------------------- tools

TOOLS = [
    {
        "name": "execution_risk",
        "description": (
            "Forward risk forecast for every asset Suwappu routes. Returns, per "
            "asset, the expected 6-hour move (1 sigma), how that compares with "
            "its own recent volatility, a slippage hint in bps, and a routing "
            "verdict. Use before executing a swap to decide whether to route "
            "now, widen slippage, or wait."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "refresh": {"type": "boolean", "description": "bypass the 10-minute cache"},
                "limit": {"type": "integer", "description": "return only the N riskiest"},
            },
        },
    },
    {
        "name": "asset_risk",
        "description": (
            "Forward risk forecast for one asset by symbol (e.g. ETH, SOL, ARB), "
            "including a concrete slippage recommendation in basis points."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"symbol": {"type": "string"}, "refresh": {"type": "boolean"}},
            "required": ["symbol"],
        },
    },
    {
        "name": "market_state",
        "description": (
            "One read on the whole market: is it calmer or more dangerous than "
            "its own recent baseline, and which assets are driving that."
        ),
        "inputSchema": {"type": "object", "properties": {"refresh": {"type": "boolean"}}},
    },
    {
        "name": "creature_vitals",
        "description": (
            "Live on-chain state of the Suwappu Tomagachi on Base: mood, satiety, "
            "treasury, how much it has paid workers, and how many verified "
            "training epochs its open model has."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "model_provenance",
        "description": (
            "Which weights are answering: asset universe, horizon, parameter "
            "count, and the measured test-set performance against the naive "
            "volatility benchmark."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def call_tool(name: str, args: dict) -> str:
    if name == "execution_risk":
        out = forecast(bool(args.get("refresh")))
        assets = out["assets"]
        if args.get("limit"):
            assets = assets[: int(args["limit"])]
        return json.dumps({**out, "assets": assets}, indent=2)

    if name == "asset_risk":
        sym = str(args.get("symbol", "")).upper()
        out = forecast(bool(args.get("refresh")))
        for a in out["assets"]:
            if a["symbol"] == sym:
                return json.dumps(a, indent=2)
        known = ", ".join(a["symbol"] for a in out["assets"])
        return f"{sym} is not in the model's universe. Known assets: {known}"

    if name == "market_state":
        out = forecast(bool(args.get("refresh")))
        ratio = out["market_risk_ratio"]
        mood = "calmer than usual" if ratio < 0.9 else (
            "more dangerous than usual" if ratio > 1.1 else "about normal")
        top = out["assets"][:3]
        return json.dumps({
            "market_risk_ratio": ratio,
            "reading": f"The market is {mood} ({ratio:.2f}x its own recent volatility).",
            "riskiest": [{"symbol": a["symbol"], "risk_ratio": a["risk_ratio"],
                          "expected_move": a["expected_move"]} for a in top],
            "horizon_hours": out["horizon_hours"],
        }, indent=2)

    if name == "creature_vitals":
        return json.dumps(creature_vitals(), indent=2)

    if name == "model_provenance":
        info = {"model_path": MODEL_PATH}
        metrics = Path(MODEL_PATH).parent / "metrics.json"
        if metrics.exists():
            m = json.loads(metrics.read_text())
            info["horizon_hours"] = m.get("horizon_hours")
            info["assets"] = m.get("symbols")
            info["test_metrics"] = m.get("pretrained")
            if "pretraining_gain_nll" in m:
                info["pretraining_gain_nll"] = m["pretraining_gain_nll"]
        return json.dumps(info, indent=2)

    raise ValueError(f"unknown tool: {name}")


# ------------------------------------------------------------------ MCP plumbing

def respond(msg_id, result=None, error=None) -> None:
    out = {"jsonrpc": "2.0", "id": msg_id}
    if error is not None:
        out["error"] = error
    else:
        out["result"] = result
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        method, msg_id = msg.get("method"), msg.get("id")

        # Notifications carry no id and must never get a response.
        if msg_id is None:
            continue

        try:
            if method == "initialize":
                respond(msg_id, {
                    "protocolVersion": PROTOCOL,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "suwa-wm", "version": "1.0.0"},
                })
            elif method == "tools/list":
                respond(msg_id, {"tools": TOOLS})
            elif method == "tools/call":
                params = msg.get("params") or {}
                text = call_tool(params.get("name", ""), params.get("arguments") or {})
                respond(msg_id, {"content": [{"type": "text", "text": text}]})
            elif method == "ping":
                respond(msg_id, {})
            else:
                respond(msg_id, error={"code": -32601, "message": f"method not found: {method}"})
        except Exception as e:
            # Tool failures come back as tool results, not protocol errors, so the
            # agent can read what went wrong instead of the session dying.
            if method == "tools/call":
                respond(msg_id, {
                    "content": [{"type": "text", "text": f"error: {e}\n{traceback.format_exc()}"}],
                    "isError": True,
                })
            else:
                respond(msg_id, error={"code": -32603, "message": str(e)})


if __name__ == "__main__":
    main()
