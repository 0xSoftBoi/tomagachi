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
  token?: `0x${string}`;
}

export function loadDeployment(): Deployment {
  const p = process.env.DEPLOYMENT ?? join(agentDir, "deployment.json");
  if (!existsSync(p)) {
    throw new Error("deployment.json not found — run `npm run compile && npm run deploy`");
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

export const config = {
  /** Worker/keeper wallet. Holds no authority over the creature — it just
   *  stakes on jobs and pushes the creature's public functions. */
  privateKey: process.env.PRIVATE_KEY as `0x${string}` | undefined,
  rpcUrl: process.env.RPC_URL,

  /** Roles this process performs. Both are permissionless. */
  runWorker: process.env.RUN_WORKER !== "false",
  runKeeper: process.env.RUN_KEEPER !== "false",

  pollMs: Number(process.env.POLL_MS ?? 60_000),

  /** Refuse jobs whose bounty doesn't cover the compute you'd spend. */
  minBountyWei: BigInt(process.env.MIN_BOUNTY_WEI ?? "0"),
  /** Extra stake above the contract minimum (signals seriousness). */
  stakeWei: process.env.STAKE_WEI ? BigInt(process.env.STAKE_WEI) : undefined,

  /** Suwappu Agent API — used to convert earned ETH into USDC for GPU rental. */
  suwappuBase: process.env.SUWAPPU_API ?? "https://api.suwappu.bot/v1/agent",
  agentName: process.env.AGENT_NAME ?? "tomagachi-worker",
  /** Convert winnings to USDC once the wallet holds more than this (wei). */
  cashOutAboveWei: BigInt(process.env.CASH_OUT_ABOVE_WEI ?? "0"),

  /** Open-weight release target. Workers must publish what they trained. */
  hfRepo: process.env.HF_REPO,
  hfToken: process.env.HF_TOKEN,

  stateDir: join(agentDir, "state"),
  runsDir: join(repoRoot, "runs"),
  modelDir: join(repoRoot, "model"),
};
