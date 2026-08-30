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

  // --- real-yield treasury ----------------------------------------------
  // Idle USDC is farmed in an owner-whitelisted ERC-4626 vault; harvested
  // yield is food the creature earns itself. See contracts/Tomagachi.sol.

  /**
   * ERC-4626 USDC vaults to farm, comma separated. The brain samples each
   * vault's share price, computes trailing APY, sends new capital to the best
   * one and rebalances when the spread justifies the gas. Empty => off.
   */
  yieldVaults: (process.env.YIELD_VAULTS ?? process.env.YIELD_VAULT ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as `0x${string}`[],
  /** Move principal between vaults only when best APY beats funded APY by this many bps. */
  rebalanceMinBps: Number(process.env.REBALANCE_MIN_BPS ?? 200),
  /** Keep at least this much USDC liquid (6dp) before farming the rest. */
  liquidTargetUsdc: BigInt(process.env.LIQUID_TARGET_USDC ?? String(25_000_000)), // 25 USDC
  /** Don't harvest until pending yield reaches this (6dp) — saves gas. */
  harvestMinUsdc: BigInt(process.env.HARVEST_MIN_USDC ?? String(1_000_000)), // 1 USDC

  // --- telegram front-end (src/telegram.ts) -----------------------------

  /** Bot token from @BotFather. Unset => no Telegram. */
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  /** Chat/channel id for proactive broadcasts (mood changes, harvests, epochs). */
  telegramChatId: process.env.TELEGRAM_CHAT_ID,

  // --- x402 pay-per-call (src/x402.ts) ----------------------------------
  // Keyless callers pay per request with signed EIP-3009 USDC transfers;
  // settled revenue is eaten by the contract via earn(). Revenue is food.

  x402Enabled: process.env.X402 === "1",
  /** USDC (6dp) per request. $0.01 default. */
  x402PriceUsdc: BigInt(process.env.X402_PRICE_USDC ?? "10000"),
  /** EIP-712 domain of the USDC deployment being settled against. */
  x402UsdcName: process.env.X402_USDC_NAME ?? "USD Coin",
  x402UsdcVersion: process.env.X402_USDC_VERSION ?? "2",
  /** Don't call earn() until settled revenue reaches this (6dp) — gas hygiene. */
  earnMinUsdc: BigInt(process.env.EARN_MIN_USDC ?? String(1_000_000)), // 1 USDC

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

  stateDir: join(agentDir, "state"),
  runsDir: join(repoRoot, "runs"),
  modelDir: join(repoRoot, "model"),
};
