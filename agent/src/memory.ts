/**
 * Per-session memory — the cheap half of what the price premium is for.
 *
 * Roleplay clients truncate history aggressively, and the character forgets
 * your name around turn thirty. That is the complaint the apps in the scan
 * (SillyTavern, Janitor AI, HammerAI) all work around by hand. Holding a few
 * durable facts across a session is most of the perceived difference between a
 * $0.31/M tune and a $3.27/M system.
 *
 * Facts are tagged by category (identity / preference / note) rather than
 * kept as one flat list, and the composer in serve.ts frames each category
 * differently and tells the model explicitly not to contradict or recite
 * them — structured retrieval plus an explicit non-leak instruction, rather
 * than trusting a bigger model to infer both on its own. That split follows
 * arXiv:2603.19313 ("Memory-Driven Role-Playing"), which frames persona
 * memory as something a model must independently retrieve and apply across
 * four capabilities (Anchoring, Recalling, Bounding, Enacting) and finds a
 * much smaller model can hold persona fidelity with the right structure —
 * see research/technical-references.md for the citation and what it changed.
 *
 * This is the Phase 1 version: pattern extraction, no model call, no latency.
 * Phase 2 replaces `extract` with a summarizer running on the same GPU — the
 * interface here does not change when it does.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export type FactCategory = "identity" | "preference" | "note";

export interface Fact {
  category: FactCategory;
  text: string;
}

interface Session {
  facts: Fact[];
  updatedAt: number;
}

/** How structured memory looks to the composer — one bucket per category. */
export interface Memory {
  identity: string[];
  preference: string[];
  note: string[];
}

// Capped independently per category: a chatty run of "i like X" turns should
// never crowd out the identity facts that anchor who the model is talking to.
const CATEGORY_CAP: Record<FactCategory, number> = {
  identity: 3,
  preference: 6,
  note: 4,
};
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
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, s] of Object.entries(raw)) {
      const session = migrate(s);
      if (session && session.updatedAt >= cutoff) sessions.set(id, session);
    }
  } catch {
    // A corrupt store costs memory, not availability. Start fresh.
  }
}

/** Accepts the pre-categorization shape (facts: string[]) so an older
 *  sessions.json on disk degrades gracefully instead of throwing on first use. */
function migrate(raw: unknown): Session | undefined {
  const s = raw as { facts?: unknown; updatedAt?: unknown };
  if (!Array.isArray(s.facts) || typeof s.updatedAt !== "number") return undefined;
  const facts: Fact[] = s.facts.map((f) =>
    typeof f === "string" ? { category: "note" as const, text: f } : (f as Fact)
  );
  return { facts, updatedAt: s.updatedAt };
}

function persist(): void {
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(storePath(), JSON.stringify(Object.fromEntries(sessions), null, 2));
}

/**
 * Facts worth carrying: things the user asserted about themselves, or asked to
 * be remembered. Deliberately narrow — a wrong "fact" injected into every turn
 * is worse for character consistency than no memory at all.
 *
 *  - identity:   who they are — name, occupation, location. Anchors the
 *                character's model of the person; almost never evicted.
 *  - preference: tastes — likes/dislikes. Colors tone, not identity.
 *  - note:       an explicit "remember that X" ask — open-ended, but weighted
 *                like identity because the user asked directly.
 */
const PATTERNS: { category: FactCategory; re: RegExp }[] = [
  // A name is one word, not the rest of the sentence -- stopping at the first
  // clause keeps "my name is Kit and i like X" from swallowing the next fact.
  { category: "identity", re: /\bmy name is ([A-Za-z][\w'-]{0,30})/i },
  { category: "identity", re: /\bi(?:'m| am) (?:called )?([A-Z][\w'-]{0,30})\b/ },
  { category: "note", re: /\bremember (?:that )?([^.!?\n,]{1,120})/i },
  { category: "preference", re: /\bi (?:like|love|hate|prefer|can't stand) ([^.!?\n,]{1,80})/i },
  { category: "identity", re: /\bi (?:work|live) (?:as|in|at) ([^.!?\n,]{1,80})/i },
];

export function extract(text: string): Fact[] {
  const found: Fact[] = [];
  for (const { category, re } of PATTERNS) {
    const m = re.exec(text);
    if (m?.[1]) {
      const fact = m[0].trim().slice(0, MAX_FACT_CHARS);
      found.push({ category, text: fact.charAt(0).toUpperCase() + fact.slice(1) });
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
    const key = fact.text.toLowerCase();
    // Drop a fact already contained in one we hold, and replace one it contains:
    // two patterns often match overlapping spans of the same sentence.
    if (session.facts.some((f) => f.text.toLowerCase().includes(key))) continue;
    session.facts = session.facts.filter((f) => !key.includes(f.text.toLowerCase()));
    session.facts.push(fact);
  }
  // Newest wins within each category when it's full: people revise what they
  // tell you, and one category filling up shouldn't evict another's facts.
  for (const category of Object.keys(CATEGORY_CAP) as FactCategory[]) {
    const cap = CATEGORY_CAP[category];
    const inCategory = session.facts.filter((f) => f.category === category);
    if (inCategory.length <= cap) continue;
    const drop = new Set(inCategory.slice(0, inCategory.length - cap));
    session.facts = session.facts.filter((f) => !drop.has(f));
  }
  session.updatedAt = Date.now();
  sessions.set(sessionId, session);
  persist();
}

export function recall(sessionId: string): Memory {
  load();
  const facts = sessions.get(sessionId)?.facts ?? [];
  return {
    identity: facts.filter((f) => f.category === "identity").map((f) => f.text),
    preference: facts.filter((f) => f.category === "preference").map((f) => f.text),
    note: facts.filter((f) => f.category === "note").map((f) => f.text),
  };
}

export function forget(sessionId: string): void {
  load();
  if (sessions.delete(sessionId)) persist();
}

/**
 * Turn structured memory into the system-prompt block the composer injects.
 * Each category gets its own framing (Anchoring), and the instruction tells
 * the model explicitly not to contradict or recite the list back (Bounding)
 * and to use it as lived knowledge rather than a checklist (Enacting) —
 * the two capabilities a flat "here are some facts" dump leaves the model to
 * infer on its own. Returns undefined when there's nothing to say: no memory
 * block beats an empty one.
 */
export function formatMemoryForPrompt(memory: Memory): string | undefined {
  const lines: string[] = [];
  if (memory.identity.length) lines.push(`Who they are: ${memory.identity.join("; ")}`);
  if (memory.preference.length) lines.push(`Their tastes: ${memory.preference.join("; ")}`);
  if (memory.note.length) {
    lines.push(`They specifically asked you to remember: ${memory.note.join("; ")}`);
  }
  if (!lines.length) return undefined;

  return (
    "What you know about this person, from earlier in the conversation:\n" +
    lines.map((l) => `- ${l}`).join("\n") +
    "\n\nUse this naturally and stay consistent with it — never contradict it. " +
    "Never recite this list back to them or mention that you were given a memory of them; " +
    "just be the character who already knows these things."
  );
}
