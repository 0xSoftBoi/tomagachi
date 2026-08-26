import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const agentDir = join(here, "..");
export const repoRoot = join(agentDir, "..");

export interface Deployment {
  chain: string;
  chainId: number;
  tomagachi: `0x${string}`;
  nom: `0x${string}`;
  usdc: `0x${string}`;
  operator: `0x${string}`;
}

export function loadDeployment(): Deployment {
  const p = join(agentDir, "deployment.json");
  if (!existsSync(p)) {
    throw new Error(
      "agent/deployment.json not found — run `npm run compile && npm run deploy` first"
    );
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

export const config = {
  /** Operator private key — signs buyCompute/checkpoint/feedFor and Suwappu self-custody swaps. */
  operatorKey: process.env.OPERATOR_KEY as `0x${string}` | undefined,
  rpcUrl: process.env.RPC_URL,

  /** Suwappu Agent API. */
  suwappuBase: process.env.SUWAPPU_API ?? "https://api.suwappu.bot/v1/agent",
  agentName: process.env.AGENT_NAME ?? "suwappu-tomagachi",

  /** Brain cadence. */
  tickMs: Number(process.env.TICK_MS ?? 5 * 60 * 1000),

  /**
   * Compute provider:
   *  - "local": run training on this machine (dev / bootstrap mode, cost 0)
   *  - "remote": POST the job to COMPUTE_ENDPOINT and pay COMPUTE_PAY_TO on-chain
   */
  computeProvider: process.env.COMPUTE_PROVIDER ?? "local",
  computeEndpoint: process.env.COMPUTE_ENDPOINT,
  computeApiKey: process.env.COMPUTE_API_KEY,
  computePayTo: process.env.COMPUTE_PAY_TO as `0x${string}` | undefined,
  /** USDC (6dp) paid per training run when using a remote provider. */
  computePriceUsdc: BigInt(process.env.COMPUTE_PRICE_USDC ?? "0"),
  /** Don't start a run unless the creature holds at least this much USDC (6dp). */
  minEnergyToTrain: BigInt(process.env.MIN_ENERGY_TO_TRAIN ?? String(1_000_000)), // 1 USDC

  /** Training shape per epoch. */
  stepsPerEpoch: Number(process.env.STEPS_PER_EPOCH ?? 2000),

  /**
   * What the creature trains with its food.
   *  - "adapter": a character LoRA from model/characters.json — the product
   *  - "world":   SUWA-WM, the Reef world model — the dream, and free to keep
   * See research/operating-plan.md for why the adapters are what get sold.
   */
  trainTarget: (process.env.TRAIN_TARGET ?? "adapter") as "adapter" | "world",
  /** Characters to train, in order, one per epoch. Empty => every SKU in the catalog. */
  characterRotation: (process.env.CHARACTER_ROTATION ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** Steps per adapter epoch — far fewer than the world model needed. */
  stepsPerAdapterEpoch: Number(process.env.STEPS_PER_ADAPTER_EPOCH ?? 300),
  /** Train against the local byte-level backbone: no downloads, no GPU, smoke test only. */
  tinyBackbone: process.env.TINY_BACKBONE === "1",
  /** Optional teacher endpoint used to bootstrap a SKU's dataset. */
  teacherUrl: process.env.TEACHER_URL,
  teacherModel: process.env.TEACHER_MODEL,

  /** Optional: push weights to Hugging Face (open source release). */
  hfRepo: process.env.HF_REPO, // e.g. "suwappu/suwa-wm"
  hfToken: process.env.HF_TOKEN,

  /** Tokens the brain will sweep from donations and swap to USDC via Suwappu. */
  sweepTokens: (process.env.SWEEP_TOKENS ?? "WETH,DEGEN,AERO")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** Minimum USD value before a donated token is worth swapping. */
  sweepMinUsd: Number(process.env.SWEEP_MIN_USD ?? 1),

  // --- serving: the shop window (src/serve.ts) --------------------------

  servePort: Number(process.env.SERVE_PORT ?? 8080),
  serveHost: process.env.SERVE_HOST ?? "0.0.0.0",
  /** Shared secret a router presents. Unset => open, which is fine behind a proxy. */
  serveApiKey: process.env.SERVE_API_KEY,
  serveContextLength: Number(process.env.SERVE_CONTEXT_LENGTH ?? 32768),
  serveMaxBodyBytes: Number(process.env.SERVE_MAX_BODY_BYTES ?? 2_000_000),
  /** Origin allowed to read /healthz and /metrics — the vitals page. Billing routes never share. */
  statusCorsOrigin: process.env.STATUS_CORS_ORIGIN ?? "*",

  /** The GPU underneath: any OpenAI-compatible server (vLLM with one LoRA per SKU). */
  upstreamBaseUrl: process.env.UPSTREAM_BASE_URL ?? "http://localhost:8000/v1",
  upstreamApiKey: process.env.UPSTREAM_API_KEY,
  /** Force one upstream model name instead of routing by adapter id (single-model hosts). */
  upstreamModelOverride: process.env.UPSTREAM_MODEL,

  /**
   * How the character's system prompt meets the caller's.
   *  - "merge":    caller's card wins, our consistency rules ride behind it (default)
   *  - "override": always speak as the catalog character
   *  - "off":      serve the adapter bare
   */
  personaMode: (process.env.SUWA_PERSONA ?? "merge") as "merge" | "override" | "off",

  /**
   * Cost model behind GET /metrics. Defaults match research/unit_economics.py,
   * so the dashboard and the plan cannot drift apart silently.
   */
  gpuUsdPerHour: Number(process.env.GPU_USD_PER_HOUR ?? 2),
  gpuCount: Number(process.env.GPU_COUNT ?? 1),
  prefillTokensPerSec: Number(process.env.PREFILL_TOKENS_PER_SEC ?? 20_000),
  decodeTokensPerSec: Number(process.env.DECODE_TOKENS_PER_SEC ?? 2_000),

  // --- provider manifest (src/provider-manifest.ts) ---------------------
  // What a router reads to decide what we sell. Defaults are deliberately
  // conservative: nothing goes live until providerIsReady is flipped.

  providerSlug: process.env.PROVIDER_SLUG ?? "suwappu",
  providerName: process.env.PROVIDER_NAME ?? "Suwappu",
  /** false keeps every model staged and invisible while onboarding is tested. */
  providerIsReady: process.env.PROVIDER_IS_READY === "1",
  /** Precision actually served. Must match how vLLM is launched. */
  servedQuantization: process.env.SERVED_QUANTIZATION ?? "bf16",
  /** Unix seconds; stable across restarts, so set it once at first listing. */
  modelsCreatedAt: Number(process.env.MODELS_CREATED_AT ?? 1787000000),
  serveMaxOutputTokens: Number(process.env.SERVE_MAX_OUTPUT_TOKENS ?? 4096),
  /** Declared request ceiling. Past it we return 429, which is tracked apart from uptime. */
  capacityRequestsPerMinute: Number(process.env.CAPACITY_REQUESTS_PER_MINUTE ?? 600),
  /** Where the GPU physically is. ISO 3166-1 alpha-2 plus a provider-scoped region. */
  datacenters: (process.env.DATACENTERS ?? "US:us-east-1").split(",").map((entry) => {
    const [country_code, region] = entry.split(":");
    return region ? { country_code, region } : { country_code };
  }),
  deploymentRegion: process.env.DEPLOYMENT_REGION ?? "US",
  /**
   * Zero data retention. Keep false while memory.ts persists session facts —
   * claiming zdr with a session store on disk would be a false statement.
   */
  complianceZdr: process.env.COMPLIANCE_ZDR === "1",

  /** Ledger and session store. Overridable so tests and containers can isolate it. */
  stateDir: process.env.STATE_DIR ?? join(agentDir, "state"),
  runsDir: join(repoRoot, "runs"),
  modelDir: join(repoRoot, "model"),
};
