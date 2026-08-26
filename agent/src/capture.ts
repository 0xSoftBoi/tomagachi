/**
 * Keeping the traffic that would otherwise be thrown away.
 *
 * Every adapter today trains on the seed corpus, which teaches the shape of a
 * character and nothing else. Real sessions are the only source of genuinely
 * in-character data this project will ever have, and they were being served
 * and forgotten. Capture is the front half of the flywheel: traffic becomes
 * data, data becomes a better adapter, a better adapter earns more traffic.
 *
 * It is also the part of this codebase most able to do harm, so:
 *
 *   - off unless CAPTURE_TRANSCRIPTS=1, with no default-on path anywhere
 *   - a caller can refuse per request with `X-Suwa-No-Capture: 1`
 *   - obvious identifiers are redacted before anything touches disk
 *   - captures land in their own directory, gitignored, never the curated set
 *
 * Redaction is best-effort pattern matching, not anonymisation, and it is
 * documented as such. It removes the identifiers that show up in practice; it
 * cannot promise a transcript contains nothing identifying. That is exactly
 * why the manifest declares zdr:false and why tools/backlog.py carries a
 * follow-up node for retention.
 */
import { appendFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export interface CaptureRow {
  at: string;
  character: string;
  app: string;
  messages: { role: string; content: string }[];
}

/** Patterns worth removing before anything is written down. */
const REDACTIONS: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]"],
  // Long digit runs: card numbers, account numbers, IDs.
  [/\b(?:\d[ -]?){13,19}\b/g, "[number]"],
  [/\+?\d[\d\s().-]{8,}\d/g, "[phone]"],
  // Anything that looks like a credential, which people do paste into chat.
  [/\b(?:sk|pk|api|key|token|bearer)[-_][A-Za-z0-9_-]{12,}/gi, "[secret]"],
  [/\b0x[a-fA-F0-9]{40}\b/g, "[address]"],
  [/https?:\/\/\S+/g, "[url]"],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

/** A caller saying no is the end of it — checked before anything else. */
export function callerRefused(headers: Record<string, string | string[] | undefined>): boolean {
  const raw = headers["x-suwa-no-capture"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "1" || value === "true";
}

function capturePath(characterId: string): string {
  return join(config.captureDir, `${characterId}.jsonl`);
}

/** Rough guard against one busy day filling the disk. */
function withinSizeBudget(path: string): boolean {
  try {
    return statSync(path).size < config.captureMaxBytesPerCharacter;
  } catch {
    return true; // no file yet
  }
}

export interface CaptureInput {
  character: string;
  app: string;
  messages: { role: string; content: string }[];
  completion: string;
  refused: boolean;
}

/**
 * Returns the row written, or null when nothing was captured — which is the
 * expected outcome most of the time, since this is off by default.
 */
export function capture(input: CaptureInput): CaptureRow | null {
  if (!config.captureTranscripts) return null;
  if (input.refused) return null;
  if (!input.completion.trim()) return null; // an empty reply teaches nothing

  // System prompts are ours, not the user's, and re-storing them per row would
  // bloat the file and teach the model to repeat its own instructions.
  const turns = input.messages.filter((m) => m.role !== "system");
  if (!turns.length) return null;

  const messages = [...turns, { role: "assistant", content: input.completion }]
    .map((m) => ({
      role: m.role,
      content: redact(String(m.content ?? "")).slice(0, config.captureMaxCharsPerMessage),
    }))
    .filter((m) => m.content.length > 0);

  const path = capturePath(input.character);
  if (!withinSizeBudget(path)) return null;

  const row: CaptureRow = {
    at: new Date().toISOString(),
    character: input.character,
    app: input.app,
    messages,
  };
  mkdirSync(config.captureDir, { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n");
  return row;
}

/** What has been captured so far, for the review step and for /metrics. */
export function captureCounts(): Record<string, number> {
  try {
    const counts: Record<string, number> = {};
    for (const file of readdirSync(config.captureDir)) {
      if (!file.endsWith(".jsonl")) continue;
      counts[file.replace(/\.jsonl$/, "")] = statSync(join(config.captureDir, file)).size;
    }
    return counts;
  } catch {
    return {};
  }
}
