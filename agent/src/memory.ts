/**
 * Per-session memory — the cheap half of what the price premium is for.
 *
 * Roleplay clients truncate history aggressively, and the character forgets
 * your name around turn thirty. That is the complaint the apps in the scan
 * (SillyTavern, Janitor AI, HammerAI) all work around by hand. Holding a few
 * durable facts across a session is most of the perceived difference between a
 * $0.31/M tune and a $3.27/M system.
 *
 * This is the Phase 1 version: pattern extraction, no model call, no latency.
 * Phase 2 replaces `extract` with a summarizer running on the same GPU — the
 * interface here does not change when it does.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

interface Session {
  facts: string[];
  updatedAt: number;
}

const MAX_FACTS = 12;
const MAX_FACT_CHARS = 160;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const sessions = new Map<string, Session>();
const storePath = () => join(config.stateDir, "sessions.json");
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  const p = storePath();
  if (!existsSync(p)) return;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, Session>;
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, s] of Object.entries(raw)) {
      if (s.updatedAt >= cutoff) sessions.set(id, s);
    }
  } catch {
    // A corrupt store costs memory, not availability. Start fresh.
  }
}

function persist(): void {
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(storePath(), JSON.stringify(Object.fromEntries(sessions), null, 2));
}

/**
 * Facts worth carrying: things the user asserted about themselves, or asked to
 * be remembered. Deliberately narrow — a wrong "fact" injected into every turn
 * is worse for character consistency than no memory at all.
 */
const PATTERNS: RegExp[] = [
  // A name is one word, not the rest of the sentence -- stopping at the first
  // clause keeps "my name is Kit and i like X" from swallowing the next fact.
  /\bmy name is ([A-Za-z][\w'-]{0,30})/i,
  /\bi(?:'m| am) (?:called )?([A-Z][\w'-]{0,30})\b/,
  /\bremember (?:that )?([^.!?\n,]{1,120})/i,
  /\bi (?:like|love|hate|prefer|can't stand) ([^.!?\n,]{1,80})/i,
  /\bi (?:work|live) (?:as|in|at) ([^.!?\n,]{1,80})/i,
];

export function extract(text: string): string[] {
  const found: string[] = [];
  for (const pattern of PATTERNS) {
    const m = pattern.exec(text);
    if (m?.[1]) {
      const fact = m[0].trim().slice(0, MAX_FACT_CHARS);
      found.push(fact.charAt(0).toUpperCase() + fact.slice(1));
    }
  }
  return found;
}

export function remember(sessionId: string, messages: { role: string; content: string }[]): void {
  load();
  // Only the newest user turn: earlier ones were seen on the calls that carried them.
  const latest = [...messages].reverse().find((m) => m.role === "user");
  if (!latest?.content) return;

  const facts = extract(latest.content);
  if (!facts.length) return;

  const session = sessions.get(sessionId) ?? { facts: [], updatedAt: 0 };
  for (const fact of facts) {
    const key = fact.toLowerCase();
    // Drop a fact already contained in one we hold, and replace one it contains:
    // two patterns often match overlapping spans of the same sentence.
    if (session.facts.some((f) => f.toLowerCase().includes(key))) continue;
    session.facts = session.facts.filter((f) => !key.includes(f.toLowerCase()));
    session.facts.push(fact);
  }
  // Newest wins when the list is full: people revise what they tell you.
  session.facts = session.facts.slice(-MAX_FACTS);
  session.updatedAt = Date.now();
  sessions.set(sessionId, session);
  persist();
}

export function recall(sessionId: string): string[] {
  load();
  return sessions.get(sessionId)?.facts ?? [];
}

export function forget(sessionId: string): void {
  load();
  if (sessions.delete(sessionId)) persist();
}
