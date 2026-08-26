/**
 * What a request cost us, as opposed to what we charged for it.
 *
 * There are two honest answers and they say different things, so the shop
 * reports both rather than picking one:
 *
 *   marginal — the GPU time this request actually consumed. Answers "is this
 *              character priced above what it costs to serve?" It is almost
 *              always yes, which is why it is the flattering number.
 *
 *   absorbed — the week's whole GPU bill spread across the week's tokens.
 *              Answers "does the traffic pay for the machine?" This is the
 *              number the market scan turned on: the best independent
 *              fine-tune on OpenRouter has a fine marginal margin and an
 *              absorbed margin of roughly nothing, because the GPU bills for
 *              168 hours and the traffic only fills 27 of them.
 *
 * Reporting marginal alone would tell us every SKU is profitable while the
 * treasury drains. Reporting absorbed alone would hide which character is
 * worth keeping. Margin per character decides what to retire; absorbed margin
 * decides whether any of it is a business.
 */
import { config } from "./config.js";

/** Seconds of GPU this token mix occupies: prefill is fast, decode is not. */
export function gpuSeconds(promptTokens: number, completionTokens: number): number {
  return (
    promptTokens / Math.max(config.prefillTokensPerSec, 1) +
    completionTokens / Math.max(config.decodeTokensPerSec, 1)
  );
}

/** What a second of this fleet's GPU costs. */
export function usdPerGpuSecond(): number {
  return (config.gpuUsdPerHour * Math.max(config.gpuCount, 1)) / 3600;
}

/** The marginal cost of one request, in dollars. */
export function marginalCost(promptTokens: number, completionTokens: number): number {
  return gpuSeconds(promptTokens, completionTokens) * usdPerGpuSecond();
}

/** Margin as a fraction of revenue. Null when nothing was charged. */
export function marginPct(revenueUsd: number, costUsd: number): number | null {
  if (revenueUsd <= 0) return null;
  return (revenueUsd - costUsd) / revenueUsd;
}
