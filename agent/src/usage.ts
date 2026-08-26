/**
 * The revenue ledger, and the five numbers on the wall.
 *
 * Every completion appends one line to state/usage.jsonl and updates the
 * in-memory rollup behind GET /metrics. The metrics are the ones the operating
 * plan says decide whether this works — realized $/M, GPU utilization, tokens
 * routed, apps routing, weeks of runway — because in this design revenue is
 * literally the creature's food.
 *
 * Realized $/M is the number to watch. Token volume without it is how the
 * community tier ends up moving 5B tokens a week for $221.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import type { Character } from "./characters.js";

export interface UsageRow {
  at: string;
  character: string;
  app: string; // from HTTP-Referer / X-Title, the way routers identify callers
  promptTokens: number;
  completionTokens: number;
  revenueUsd: number;
  latencyMs: number;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ledgerPath = () => join(config.stateDir, "usage.jsonl");

let rows: UsageRow[] = [];
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  const p = ledgerPath();
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A truncated final line after a hard kill is not worth crashing over.
    }
  }
}

export function priceOf(character: Character, promptTokens: number, completionTokens: number): number {
  const { prompt, completion } = character.price_usd_per_m;
  return (promptTokens * prompt + completionTokens * completion) / 1e6;
}

export function record(row: Omit<UsageRow, "at" | "revenueUsd">, character: Character): UsageRow {
  load();
  const full: UsageRow = {
    at: new Date().toISOString(),
    revenueUsd: priceOf(character, row.promptTokens, row.completionTokens),
    ...row,
  };
  rows.push(full);
  mkdirSync(config.stateDir, { recursive: true });
  appendFileSync(ledgerPath(), JSON.stringify(full) + "\n");
  return full;
}

export interface Metrics {
  window: "7d";
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  requests: number;
  grossUsd: number;
  /** The pricing-power number. Target > $0.60 — see research/operating-plan.md. */
  realizedUsdPerM: number;
  /** The margin number. Target > 50%. */
  gpuUtilization: number;
  gpuCostUsd: number;
  contributionUsd: number;
  /** Concentration risk: each logo is worth a lot when ten apps are 78% of a market. */
  apps: { app: string; tokens: number; grossUsd: number }[];
  byCharacter: { character: string; tokens: number; grossUsd: number }[];
  /** Satiety in weeks. Null when no treasury was passed, or when nothing is burning. */
  weeksOfRunway: number | null;
  /** Revenue covers the machine. Phase 1's gate, as a boolean. */
  selfSustaining: boolean;
}

/** `treasuryUsd` comes from the chain, so runway is only known when the brain asks. */
export function metrics(treasuryUsd?: number): Metrics {
  load();
  const since = Date.now() - WEEK_MS;
  const recent = rows.filter((r) => Date.parse(r.at) >= since);

  const promptTokens = recent.reduce((n, r) => n + r.promptTokens, 0);
  const completionTokens = recent.reduce((n, r) => n + r.completionTokens, 0);
  const tokens = promptTokens + completionTokens;
  const grossUsd = recent.reduce((n, r) => n + r.revenueUsd, 0);

  // Capacity depends on the mix: prompt tokens prefill fast, completions decode
  // slowly, so a prompt-heavy week fits far more tokens on the same GPU.
  const ratio = completionTokens > 0 ? promptTokens / completionTokens : 1;
  const promptShare = ratio / (1 + ratio);
  const secondsPerM = (1e6 * promptShare) / config.prefillTokensPerSec
    + (1e6 * (1 - promptShare)) / config.decodeTokensPerSec;
  const capacity = (3600 / secondsPerM) * 1e6 * 168 * config.gpuCount;
  const gpuCostUsd = config.gpuUsdPerHour * 168 * config.gpuCount;

  const group = (key: (r: UsageRow) => string) => {
    const m = new Map<string, { tokens: number; grossUsd: number }>();
    for (const r of recent) {
      const k = key(r);
      const cur = m.get(k) ?? { tokens: 0, grossUsd: 0 };
      cur.tokens += r.promptTokens + r.completionTokens;
      cur.grossUsd += r.revenueUsd;
      m.set(k, cur);
    }
    return [...m.entries()]
      .map(([k, v]) => ({ ...v, key: k }))
      .sort((a, b) => b.tokens - a.tokens);
  };

  const contributionUsd = grossUsd - gpuCostUsd;
  return {
    window: "7d",
    tokens,
    promptTokens,
    completionTokens,
    requests: recent.length,
    grossUsd: round(grossUsd, 4),
    realizedUsdPerM: tokens ? round((grossUsd / tokens) * 1e6, 4) : 0,
    gpuUtilization: capacity ? round(tokens / capacity, 6) : 0,
    gpuCostUsd: round(gpuCostUsd, 2),
    contributionUsd: round(contributionUsd, 4),
    apps: group((r) => r.app).map(({ key, ...v }) => ({ app: key, ...round2(v) })),
    byCharacter: group((r) => r.character).map(({ key, ...v }) => ({ character: key, ...round2(v) })),
    weeksOfRunway: weeksOfRunway(treasuryUsd, grossUsd, gpuCostUsd),
    selfSustaining: grossUsd >= gpuCostUsd,
  };
}

/**
 * How many weeks the creature survives at this burn. Revenue offsets the GPU,
 * so a shop that covers its own machine never starves — which is the whole
 * point of Phase 1's $400/wk gate.
 */
function weeksOfRunway(treasuryUsd: number | undefined, grossUsd: number, gpuCostUsd: number): number | null {
  if (treasuryUsd === undefined) return null;
  const burn = gpuCostUsd - grossUsd;
  if (burn <= 0) return null; // nothing is burning; read `selfSustaining` instead
  return round(treasuryUsd / burn, 2);
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function round2<T extends { tokens: number; grossUsd: number }>(v: T): T {
  return { ...v, grossUsd: round(v.grossUsd, 4) };
}
