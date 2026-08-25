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

  stateDir: join(agentDir, "state"),
  runsDir: join(repoRoot, "runs"),
  modelDir: join(repoRoot, "model"),
};
