/**
 * Minimal client for the Suwappu Agent API (https://api.suwappu.bot/v1/agent).
 *
 * Flow used by the brain (self-custody, keys never leave this process):
 *   POST /register        -> API key (once, persisted to state)
 *   GET  /tokens?chain=   -> resolve symbols to addresses/decimals
 *   GET  /prices          -> USD values for donation sweeping
 *   POST /quote           -> quote_id (valid ~60s)
 *   POST /swap            -> unsigned self-custody tx; we sign + broadcast with viem
 */
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { loadState, saveState } from "./state.js";

export class SuwappuError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`suwappu ${status}: ${JSON.stringify(body)}`);
  }
}

async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean; idempotencyKey?: string } = {}
): Promise<T> {
  const state = loadState();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth !== false && state.suwappuApiKey) {
    headers.authorization = `Bearer ${state.suwappuApiKey}`;
  }
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;

  const res = await fetch(`${config.suwappuBase}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new SuwappuError(res.status, body);
  return body as T;
}

/** Register the agent once and persist the API key locally (never committed). */
export async function ensureRegistered(): Promise<void> {
  const state = loadState();
  if (state.suwappuApiKey) return;
  const out = await api<any>("/register", {
    body: { name: config.agentName },
    auth: false,
  });
  const key = out.api_key ?? out.apiKey ?? out.key;
  if (!key) throw new Error(`register: no api key in response ${JSON.stringify(out)}`);
  state.suwappuApiKey = key;
  state.suwappuAgentId = out.agent_id ?? out.id;
  saveState(state);
  console.log(`[suwappu] registered agent "${config.agentName}"`);
}

export interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
}

export async function tokens(chain: string): Promise<TokenInfo[]> {
  const out = await api<any>(`/tokens?chain=${encodeURIComponent(chain)}`);
  return out.tokens ?? out.data ?? out;
}

export async function prices(symbols: string[]): Promise<Record<string, number>> {
  const out = await api<any>(`/prices?symbols=${encodeURIComponent(symbols.join(","))}`);
  const map: Record<string, number> = {};
  const rows = out.prices ?? out.data ?? out;
  if (Array.isArray(rows)) {
    for (const r of rows) map[r.symbol] = Number(r.price ?? r.usd);
  } else {
    for (const [k, v] of Object.entries<any>(rows)) map[k] = Number(v.price ?? v.usd ?? v);
  }
  return map;
}

export interface Quote {
  quote_id: string;
  [k: string]: unknown;
}

/** Same-chain quote. `amount` is human-readable (e.g. "0.5"), per the API. */
export async function quote(params: {
  chain: string;
  fromToken: string;
  toToken: string;
  amount: string;
  walletAddress: string;
}): Promise<Quote> {
  return api<Quote>("/quote", {
    body: {
      chain: params.chain,
      from_token: params.fromToken,
      to_token: params.toToken,
      amount: params.amount,
      wallet_address: params.walletAddress,
      slippage: 0.03,
    },
  });
}

export interface UnsignedTx {
  to: `0x${string}`;
  data: `0x${string}`;
  value?: string;
  gas_limit?: string;
  [k: string]: unknown;
}

/** Build an unsigned self-custody transaction from a quote. Never signs. */
export async function buildSwapTx(
  quoteId: string,
  walletAddress: string
): Promise<UnsignedTx> {
  const out = await api<any>("/swap", {
    body: { quote_id: quoteId, wallet_address: walletAddress },
    idempotencyKey: randomUUID(),
  });
  return out.transaction ?? out.tx ?? out;
}
