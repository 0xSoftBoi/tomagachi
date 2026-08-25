/**
 * Suwappu Agent API client — the worker's treasury desk.
 *
 * The creature pays its bounties in ETH, but GPUs are rented in stablecoins.
 * This converts a worker's winnings ETH → USDC on Base through Suwappu's
 * self-custody path: quote → unsigned transaction → signed locally here →
 * broadcast. Keys never leave this process.
 *
 * Entirely optional: it touches the worker's own wallet, never the creature.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { formatEther } from "viem";
import { config } from "./config.js";
import type { Creature } from "./chain.js";

const keyPath = join(config.stateDir, "suwappu.json");

function loadKey(): string | undefined {
  if (!existsSync(keyPath)) return undefined;
  return JSON.parse(readFileSync(keyPath, "utf8")).apiKey;
}

function saveKey(apiKey: string, agentId?: string): void {
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(keyPath, JSON.stringify({ apiKey, agentId }, null, 2));
}

async function api<T>(
  path: string,
  opts: { body?: unknown; auth?: boolean; idempotencyKey?: string } = {}
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = loadKey();
  if (opts.auth !== false && key) headers.authorization = `Bearer ${key}`;
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;

  const res = await fetch(`${config.suwappuBase}${path}`, {
    method: opts.body ? "POST" : "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`suwappu ${res.status}: ${JSON.stringify(body)}`);
  return body as T;
}

/** Register once; the key is persisted locally and never committed. */
export async function ensureRegistered(): Promise<void> {
  if (loadKey()) return;
  const out = await api<any>("/register", { body: { name: config.agentName }, auth: false });
  const key = out.api_key ?? out.apiKey ?? out.key;
  if (!key) throw new Error(`register: no api key in ${JSON.stringify(out)}`);
  saveKey(key, out.agent_id ?? out.id);
  console.log(`[suwappu] registered "${config.agentName}"`);
}

/**
 * Swap the worker's surplus ETH into USDC so it can pay for GPU time.
 * Called opportunistically; failures are never fatal to training.
 */
export async function cashOut(creature: Creature, amountWei: bigint): Promise<void> {
  await ensureRegistered();
  const chainKey = creature.chain.id === 8453 ? "base" : "base-sepolia";
  const human = formatEther(amountWei);

  const quote = await api<any>("/quote", {
    body: {
      chain: chainKey,
      from_token: "ETH",
      to_token: "USDC",
      amount: human,
      wallet_address: creature.account.address,
      slippage: 0.03,
    },
  });
  const swap = await api<any>("/swap", {
    body: { quote_id: quote.quote_id, wallet_address: creature.account.address },
    idempotencyKey: randomUUID(),
  });
  const tx = swap.transaction ?? swap.tx;
  if (!tx?.to) throw new Error("suwappu: no transaction in swap response");

  const hash = await creature.wallet.sendTransaction({
    account: creature.account,
    chain: creature.chain,
    to: tx.to,
    data: tx.data,
    value: tx.value ? BigInt(tx.value) : undefined,
  });
  await creature.client.waitForTransactionReceipt({ hash });
  console.log(`[suwappu] cashed out ${human} ETH → USDC for compute: ${hash}`);
}
