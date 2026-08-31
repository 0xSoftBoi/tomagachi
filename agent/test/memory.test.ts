/**
 * Unit tests for the per-session memory module — pure logic, no chain, no
 * model call. Covers categorized extraction, per-category caps (a chatty
 * run of preferences shouldn't evict identity facts), the old-shape
 * migration path, and the Bounding/Enacting instruction the prompt builder
 * attaches. See src/memory.ts's header for the arXiv:2603.19313 citation
 * this structure is grounded in.
 *
 * Runs against a scratch STATE_DIR (set by the `test` npm script), isolated
 * from the real agent/state/ directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { extract, remember, recall, forget, formatMemoryForPrompt } from "../src/memory.js";

const msg = (content: string) => [{ role: "user", content }];
const sid = () => `test-${randomUUID()}`;

test("extract tags facts by category", () => {
  const facts = extract("my name is Kit and I live in Reno");
  const categories = facts.map((f) => f.category).sort();
  assert.deepEqual(categories, ["identity", "identity"]);
  assert.ok(facts.some((f) => f.text.startsWith("My name is Kit")));

  assert.equal(extract("I like long walks on the beach")[0].category, "preference");
  assert.equal(extract("remember that my cat is named Biscuit")[0].category, "note");
  assert.equal(extract("just saying hello").length, 0);
});

test("remember + recall round-trips into the right buckets", () => {
  const s = sid();
  remember(s, msg("my name is Kit"));
  remember(s, msg("I love spicy food"));
  remember(s, msg("remember that my birthday is in March"));

  const memory = recall(s);
  assert.equal(memory.identity.length, 1);
  assert.ok(memory.identity[0].includes("Kit"));
  assert.equal(memory.preference.length, 1);
  assert.ok(memory.preference[0].toLowerCase().includes("spicy"));
  assert.equal(memory.note.length, 1);
  assert.ok(memory.note[0].includes("March"));

  forget(s);
  const cleared = recall(s);
  assert.deepEqual(cleared, { identity: [], preference: [], note: [] });
});

test("per-category caps: a flood of preferences can't evict identity facts", () => {
  const s = sid();
  remember(s, msg("my name is Kit"));
  remember(s, msg("I work as a lighthouse keeper"));
  // Two identity facts already at the cap (3 is the cap, so one more still fits).
  for (let i = 0; i < 10; i++) {
    remember(s, msg(`I like thing number ${i}`));
  }
  const memory = recall(s);
  assert.ok(memory.identity.some((f) => f.includes("Kit")), "name survives the preference flood");
  assert.ok(
    memory.identity.some((f) => f.toLowerCase().includes("lighthouse")),
    "occupation survives the preference flood"
  );
  assert.ok(memory.preference.length <= 6, "preferences stay within their own cap");
  // Newest preferences win when the cap truncates.
  assert.ok(memory.preference.some((f) => f.includes("thing number 9")));
  assert.ok(!memory.preference.some((f) => f.includes("thing number 0")));
});

test("overlapping matches within one message dedupe instead of double-storing", () => {
  const s = sid();
  remember(s, msg("my name is Kit and I like spicy food"));
  const memory = recall(s);
  assert.equal(memory.identity.length, 1);
  assert.equal(memory.preference.length, 1);
});

test("formatMemoryForPrompt: empty memory yields no block, non-empty carries the anti-leak instruction", () => {
  assert.equal(formatMemoryForPrompt({ identity: [], preference: [], note: [] }), undefined);

  const block = formatMemoryForPrompt({
    identity: ["My name is Kit"],
    preference: ["I like spicy food"],
    note: [],
  })!;
  assert.match(block, /Who they are: My name is Kit/);
  assert.match(block, /Their tastes: I like spicy food/);
  assert.doesNotMatch(block, /They specifically asked/); // no notes: that line is omitted
  assert.match(block, /never contradict/i);
  assert.match(block, /never .*(recite|mention).*memory/i);
});

test("an old-shape sessions.json (plain string facts) loads without throwing", async () => {
  // Simulate a pre-categorization session already on disk, then confirm a
  // fresh module load migrates it into the note bucket rather than crashing.
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { config } = await import("../src/config.js");
  const { join } = await import("node:path");
  const { mkdirSync } = await import("node:fs");

  mkdirSync(config.stateDir, { recursive: true });
  const path = join(config.stateDir, "sessions.json");
  const before = (() => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  })();

  const legacyId = sid();
  const existing = before ? JSON.parse(before) : {};
  existing[legacyId] = { facts: ["An old-shape fact"], updatedAt: Date.now() };
  writeFileSync(path, JSON.stringify(existing, null, 2));

  // memory.ts caches `loaded` at module scope and this file's process has
  // already loaded once (from earlier tests in this file) — force a reload
  // via a fresh module instance so the migration path actually runs.
  const fresh = await import(`../src/memory.js?cachebust=${randomUUID()}`);
  const migrated = fresh.recall(legacyId);
  assert.deepEqual(migrated, { identity: [], preference: [], note: [migrated.note[0]] });
  assert.equal(migrated.note[0], "An old-shape fact");
});
