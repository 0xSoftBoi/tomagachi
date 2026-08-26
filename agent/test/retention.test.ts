/**
 * The ledger is the one file that keeps running under every configuration,
 * including the one where we tell a router we retain nothing. That claim rests
 * entirely on the ledger holding counts and no text, so these tests try to get
 * text into it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "suwa-retention-"));
process.env.STATE_DIR = stateDir;

const { record } = await import("../src/usage.js");
const { sanitizeApp, LEDGER_FIELDS } = await import("../src/retention.js");
const { findCharacter } = await import("../src/characters.js");

after(() => rmSync(stateDir, { recursive: true, force: true }));

const tide = findCharacter("suwa-tide")!;
const ledger = () =>
  readFileSync(join(stateDir, "usage.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("a row carries the declared fields and nothing else", () => {
  record({ character: "suwa-tide", app: "SillyTavern", promptTokens: 40, completionTokens: 8, latencyMs: 120 }, tide);
  const row = ledger().at(-1)!;
  assert.deepEqual(Object.keys(row).sort(), [...LEDGER_FIELDS].sort());
});

test("extra fields handed to record are dropped, not written", () => {
  record({
    character: "suwa-tide",
    app: "SillyTavern",
    promptTokens: 10,
    completionTokens: 4,
    latencyMs: 90,
    // What a careless refactor upstream would add, and what an attacker would
    // want added: the conversation itself, and the key that identifies it.
    messages: [{ role: "user", content: "my name is Kit, kit@example.com" }],
    sessionId: "chat-1",
    prompt: "my name is Kit",
  } as any, tide);
  const raw = readFileSync(join(stateDir, "usage.jsonl"), "utf8");
  assert.ok(!raw.includes("Kit"), "prompt content reached the ledger");
  assert.ok(!raw.includes("chat-1"), "a session key reached the ledger");
  assert.deepEqual(Object.keys(ledger().at(-1)!).sort(), [...LEDGER_FIELDS].sort());
});

test("the one caller-controlled field cannot smuggle identifiers in", () => {
  // A referer is a URL, and apps put session tokens and addresses in URLs.
  assert.equal(sanitizeApp("https://chat.example.com/s/abc?user=kit@example.com&t=secret"),
    "chat.example.com/s/abc");
  assert.equal(sanitizeApp("https://user:pw@chat.example.com/"), "chat.example.com");
  // An X-Title is a human-chosen name, and still gets scrubbed.
  assert.equal(sanitizeApp("Kit's client — kit@example.com"), "Kit's client — [email]");
  assert.equal(sanitizeApp(""), "direct");
  assert.ok(sanitizeApp("x".repeat(500)).length <= 80);
  assert.equal(sanitizeApp("multi\nline\ttitle"), "multi line title");
});

test("a referer full of personal data survives the round trip as an origin", () => {
  record({
    character: "suwa-tide",
    app: "https://janitorai.com/chats/9f2?email=kit@example.com",
    promptTokens: 5,
    completionTokens: 2,
    latencyMs: 30,
  }, tide);
  const row = ledger().at(-1)!;
  assert.equal(row.app, "janitorai.com/chats/9f2");
  // Concentration risk still measurable: the logo survives, the person does not.
  assert.ok(row.app.startsWith("janitorai.com"));
});

test("counts are coerced, so a malformed row cannot poison the numbers", () => {
  record({ character: "suwa-tide", app: "x", promptTokens: -5, completionTokens: 1.7, latencyMs: NaN } as any, tide);
  const row = ledger().at(-1)!;
  assert.equal(row.promptTokens, 0);
  assert.equal(row.completionTokens, 2);
  assert.equal(row.latencyMs, 0);
});
