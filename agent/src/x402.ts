/**
 * x402 pay-per-call: the machine-payable side of the shop.
 *
 * A caller with no API key gets HTTP 402 plus payment requirements. It signs
 * an EIP-3009 `TransferWithAuthorization` for USDC on Base (gasless for the
 * payer), retries with the signed payload in an X-PAYMENT header, and we
 * settle it on-chain before serving the request. Settled revenue accumulates
 * in a local ledger; the brain periodically eats it through the contract's
 * `earn()`, so pay-per-call revenue becomes satiety — food the creature
 * earned — with the whole path auditable on Base.
 *
 * Scheme: "exact" per the x402 spec. Settlement is one Base tx per call
 * (~2s); at real volume you'd batch or run a facilitator, but the point here
 * is that revenue can settle back to the contract with zero invoicing.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  verifyTypedData,
  parseAbi,
  type PublicClient,
  type WalletClient,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config, loadDeployment, type Deployment } from "./config.js";

const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const usdcAbi = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
]);

interface Authorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}

interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: { signature: `0x${string}`; authorization: Authorization };
}

interface Ledger {
  /** Settled revenue not yet passed to the contract via earn() (USDC 6dp). */
  unfedUsdc: string;
  totalUsdc: string;
  settles: number;
}

const ledgerPath = () => join(config.stateDir, "x402-ledger.json");

function loadLedger(): Ledger {
  if (!existsSync(ledgerPath())) return { unfedUsdc: "0", totalUsdc: "0", settles: 0 };
  return JSON.parse(readFileSync(ledgerPath(), "utf8"));
}

function saveLedger(l: Ledger): void {
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(ledgerPath(), JSON.stringify(l, null, 2));
}

/** Revenue settled but not yet eaten. The brain calls this every tick. */
export function peekUnfed(): bigint {
  return BigInt(loadLedger().unfedUsdc);
}

/** Called by the brain after a successful earn() to zero out what was eaten. */
export function markFed(amount: bigint): void {
  const l = loadLedger();
  const rest = BigInt(l.unfedUsdc) - amount;
  l.unfedUsdc = (rest > 0n ? rest : 0n).toString();
  saveLedger(l);
}

// Lazy on-chain context: serve-main can run without a deployment or key, in
// which case x402 quietly reports itself unavailable instead of crashing.
let ctx:
  | {
      deployment: Deployment;
      networkName: string;
      client: PublicClient;
      wallet: WalletClient;
      account: ReturnType<typeof privateKeyToAccount>;
    }
  | null
  | undefined;

function context() {
  if (ctx !== undefined) return ctx;
  try {
    if (!config.x402Enabled) throw new Error("disabled");
    if (!config.operatorKey) throw new Error("X402=1 needs OPERATOR_KEY to settle");
    const deployment = loadDeployment();
    const chain: Chain = deployment.chain === "baseSepolia" ? baseSepolia : base;
    const transport = http(config.rpcUrl);
    const account = privateKeyToAccount(config.operatorKey);
    ctx = {
      deployment,
      networkName: deployment.chain === "baseSepolia" ? "base-sepolia" : "base",
      client: createPublicClient({ chain, transport }),
      wallet: createWalletClient({ account, chain, transport }),
      account,
    };
  } catch (e: any) {
    if (config.x402Enabled) console.warn(`[x402] unavailable: ${e.message}`);
    ctx = null;
  }
  return ctx;
}

export function x402Available(): boolean {
  return context() !== null;
}

/** The HTTP 402 body: what a payment-capable client needs to retry. */
export function paymentRequirements(resource: string) {
  const c = context()!;
  return {
    x402Version: 1,
    error: "payment required: sign an EIP-3009 USDC authorization and retry with X-PAYMENT",
    accepts: [
      {
        scheme: "exact",
        network: c.networkName,
        maxAmountRequired: config.x402PriceUsdc.toString(),
        asset: c.deployment.usdc,
        payTo: c.account.address,
        resource,
        description: "Suwappu Tomagachi inference — pay-per-call; revenue feeds the creature",
        mimeType: "application/json",
        maxTimeoutSeconds: 60,
        extra: { name: config.x402UsdcName, version: config.x402UsdcVersion },
      },
    ],
  };
}

// Nonces currently being settled, so a double-send can't race the chain.
const inFlight = new Set<string>();

export type SettleResult =
  | { ok: true; txHash: `0x${string}`; payer: `0x${string}`; amount: bigint }
  | { ok: false; reason: string };

/** Verify an X-PAYMENT header and settle it on-chain. */
export async function settlePayment(header: string): Promise<SettleResult> {
  const c = context();
  if (!c) return { ok: false, reason: "x402 not available on this server" };

  let p: PaymentPayload;
  try {
    p = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "X-PAYMENT is not base64-encoded JSON" };
  }
  if (p.scheme !== "exact") return { ok: false, reason: `unsupported scheme ${p.scheme}` };
  if (p.network !== c.networkName) return { ok: false, reason: `wrong network ${p.network}` };

  const a = p.payload?.authorization;
  const signature = p.payload?.signature;
  if (!a || !signature) return { ok: false, reason: "missing authorization or signature" };

  const value = BigInt(a.value);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (a.to.toLowerCase() !== c.account.address.toLowerCase()) {
    return { ok: false, reason: "authorization pays the wrong address" };
  }
  if (value < config.x402PriceUsdc) {
    return { ok: false, reason: `authorized ${value}, price is ${config.x402PriceUsdc}` };
  }
  if (now <= BigInt(a.validAfter)) return { ok: false, reason: "authorization not yet valid" };
  if (now >= BigInt(a.validBefore)) return { ok: false, reason: "authorization expired" };
  if (inFlight.has(a.nonce)) return { ok: false, reason: "nonce already being settled" };

  const valid = await verifyTypedData({
    address: a.from,
    domain: {
      name: config.x402UsdcName,
      version: config.x402UsdcVersion,
      chainId: c.deployment.chainId,
      verifyingContract: c.deployment.usdc,
    },
    types: AUTH_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: a.from,
      to: a.to,
      value,
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce,
    },
    signature,
  }).catch(() => false);
  if (!valid) return { ok: false, reason: "bad EIP-3009 signature" };

  inFlight.add(a.nonce);
  try {
    // USDC itself enforces nonce single-use, so replay dies on-chain.
    const txHash = await c.wallet.writeContract({
      account: c.account,
      chain: c.wallet.chain,
      address: c.deployment.usdc,
      abi: usdcAbi,
      functionName: "transferWithAuthorization",
      args: [a.from, a.to, value, BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, signature],
    });
    const receipt = await c.client.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") return { ok: false, reason: "settlement tx reverted" };

    const l = loadLedger();
    l.unfedUsdc = (BigInt(l.unfedUsdc) + value).toString();
    l.totalUsdc = (BigInt(l.totalUsdc) + value).toString();
    l.settles += 1;
    saveLedger(l);

    console.log(`[x402] settled ${value} from ${a.from}: ${txHash}`);
    return { ok: true, txHash, payer: a.from, amount: value };
  } catch (e: any) {
    return { ok: false, reason: `settlement failed: ${e.shortMessage ?? e.message}` };
  } finally {
    inFlight.delete(a.nonce);
  }
}

/** Header a paid response carries back, per the x402 spec. */
export function paymentResponseHeader(r: Extract<SettleResult, { ok: true }>): string {
  return Buffer.from(
    JSON.stringify({ success: true, transaction: r.txHash, network: context()!.networkName, payer: r.payer })
  ).toString("base64");
}
