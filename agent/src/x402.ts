/**
 * Pay-per-call, so revenue can reach the contract.
 *
 * The listing route pays providers by monthly invoice to a legal entity, which
 * is fine for distribution and fatal to the premise: money that lands in a
 * company bank account is not money the creature ate. x402 is the only path
 * where a caller pays per request and the settlement is on-chain.
 *
 * The shape is plain HTTP. An unpaid request gets 402 with a quote — what it
 * costs, to whom, on which network, in which asset. The caller retries with an
 * `X-PAYMENT` header carrying a signed payload. We verify that payload with a
 * facilitator before doing any work, serve the completion, then settle for
 * what was actually used and report it back in `X-PAYMENT-RESPONSE`.
 *
 * Two rules this file exists to enforce:
 *
 *   **Fail closed.** A facilitator that is unreachable, slow, or confused
 *   means no completion. An inference endpoint that serves free work whenever
 *   its payment check errors is not a paid endpoint, it is a free one with
 *   extra steps.
 *
 *   **Quote before work, settle after.** The 402 advertises the most a call
 *   can cost, derived from the character's real prices and the caller's own
 *   max_tokens. Settlement uses actual usage, so nobody is charged for tokens
 *   they did not receive.
 */
import { config } from "./config.js";
import type { Character } from "./characters.js";

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  asset: string;
  payTo: string;
  /** Atomic units of the asset — USDC has 6 decimals. */
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: "application/json";
  maxTimeoutSeconds: number;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  payer?: string;
}

export interface SettleResult {
  settled: boolean;
  reason?: string;
  txHash?: string;
  amount?: string;
}

/** USDC atomic units from a dollar amount, rounded up: never under-quote. */
export function toAtomic(usd: number, decimals = 6): string {
  return String(Math.ceil(usd * 10 ** decimals));
}

/**
 * The most this call can cost, from the character's own prices and the
 * caller's max_tokens. A quote the caller can check against the manifest.
 */
export function quote(character: Character, promptTokens: number, maxTokens: number): number {
  const { prompt, completion } = character.price_usd_per_m;
  const amount = (promptTokens * prompt + maxTokens * completion) / 1e6;
  return Math.max(amount, config.x402MinChargeUsd);
}

export function requirements(
  character: Character,
  promptTokens: number,
  maxTokens: number
): PaymentRequirements {
  const usd = quote(character, promptTokens, maxTokens);
  return {
    scheme: "exact",
    network: config.x402Network,
    asset: config.x402Asset,
    payTo: config.x402PayTo,
    maxAmountRequired: toAtomic(usd),
    resource: `/v1/chat/completions#${character.id}`,
    description: `${character.name} — up to ${maxTokens} completion tokens`,
    mimeType: "application/json",
    maxTimeoutSeconds: config.x402TimeoutSeconds,
  };
}

/** The 402 body: everything a caller needs to pay without asking us anything. */
export function challenge(reqs: PaymentRequirements) {
  return { x402Version: 1, error: "payment required", accepts: [reqs] };
}

async function facilitator(
  path: string,
  body: unknown,
  fetchImpl: typeof fetch
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.x402TimeoutSeconds * 1000);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.x402FacilitatorKey) headers.authorization = `Bearer ${config.x402FacilitatorKey}`;
    const res = await fetchImpl(`${config.x402FacilitatorUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`facilitator ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Is this payment good? Anything other than an explicit yes is a no. */
export async function verify(
  payment: string,
  reqs: PaymentRequirements,
  fetchImpl: typeof fetch = fetch
): Promise<VerifyResult> {
  try {
    const body = await facilitator("/verify", { x402Version: 1, paymentPayload: payment, paymentRequirements: reqs }, fetchImpl);
    if (body?.isValid === true) return { ok: true, payer: body.payer };
    return { ok: false, reason: body?.invalidReason ?? "facilitator did not accept the payment" };
  } catch (e: any) {
    // Fail closed. A payment layer that opens on error is not a payment layer.
    return { ok: false, reason: `verification unavailable: ${e?.message ?? e}` };
  }
}

/** Settle for what was actually used, after the completion was produced. */
export async function settle(
  payment: string,
  reqs: PaymentRequirements,
  actualUsd: number,
  fetchImpl: typeof fetch = fetch
): Promise<SettleResult> {
  const amount = toAtomic(actualUsd);
  try {
    const body = await facilitator(
      "/settle",
      { x402Version: 1, paymentPayload: payment, paymentRequirements: { ...reqs, maxAmountRequired: amount } },
      fetchImpl
    );
    if (body?.success === true) return { settled: true, txHash: body.transaction, amount };
    return { settled: false, reason: body?.errorReason ?? "settlement refused", amount };
  } catch (e: any) {
    // The completion has already been delivered. Losing the settlement is a
    // debt to chase, not a reason to pretend the work did not happen.
    return { settled: false, reason: `settlement failed: ${e?.message ?? e}`, amount };
  }
}

/** Header value clients send back with the settlement outcome. */
export function paymentResponseHeader(result: SettleResult): string {
  return Buffer.from(JSON.stringify({
    success: result.settled,
    transaction: result.txHash ?? null,
    amount: result.amount ?? null,
    ...(result.reason ? { reason: result.reason } : {}),
  })).toString("base64");
}
