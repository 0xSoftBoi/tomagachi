/**
 * What gets written down, and what makes "zero data retention" true.
 *
 * A router asks providers whether they retain customer data, publishes the
 * answer next to the price, and routes ZDR-only traffic on the strength of it.
 * That answer used to be its own environment variable here, which meant the
 * advertisement could be flipped without changing a single line of what
 * actually reaches disk. This module exists so that the claim is derived from
 * the behaviour instead of asserted alongside it.
 *
 * Three things can hold customer text:
 *
 *   - `memory.ts`   session facts, extracted from user turns
 *   - `capture.ts`  transcripts, redacted, for training the next adapter
 *   - `usage.ts`    the revenue ledger
 *
 * The first two are off under ZDR. The third stays on, because it holds token
 * counts and no text — and this file is where that is enforced rather than
 * hoped for. See agent/RETENTION.md.
 */
import { config } from "./config.js";
import { redact } from "./capture.js";

/**
 * The claim the manifest publishes. True only when the switch that actually
 * disables retention is on — there is deliberately no way to say yes without
 * turning the behaviour off.
 */
export function zeroDataRetention(): boolean {
  return config.zeroDataRetention;
}

/**
 * The exact set of fields a ledger row may carry.
 *
 * `record` builds a row from this list rather than spreading its argument, so
 * a caller that hands it an extra field — a message, a header, a session id —
 * finds it dropped rather than persisted. The type system already says this;
 * the list is what says it at runtime, where the untrusted input is.
 */
export const LEDGER_FIELDS = [
  "at",
  "character",
  "app",
  "promptTokens",
  "completionTokens",
  "revenueUsd",
  "gpuSeconds",
  "costUsd",
  "latencyMs",
] as const;

/**
 * Clean the one ledger field a stranger controls.
 *
 * `app` comes from `HTTP-Referer` / `X-Title`, which routers pass through from
 * whatever the app set. It is the only free text in a row, and a referer is a
 * URL: `https://chat.example.com/s/abc?user=kit@example.com` would put an
 * address and a session token in the ledger forever. Keep the origin and the
 * path — that is what concentration risk is measured on — and drop the rest.
 */
export function sanitizeApp(raw: string): string {
  let value = raw.trim();
  try {
    const url = new URL(value);
    // Credentials in a URL are a mistake we should not copy into a file.
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    value = url.host + (url.pathname === "/" ? "" : url.pathname);
  } catch {
    // Not a URL: an X-Title, which is a human-chosen app name.
  }
  // Belt and braces: an app name is short, single-line, and free of the
  // identifiers people paste into chat.
  return redact(value.replace(/\s+/g, " ")).slice(0, 80) || "direct";
}
