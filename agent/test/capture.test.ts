/**
 * Capture is the front half of the flywheel and the part of this codebase most
 * able to do harm. Every test here is a way it could hurt someone or lie about
 * what it keeps.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "suwa-capture-"));
process.env.STATE_DIR = join(dir, "state");
process.env.CAPTURE_DIR = join(dir, "captured");
process.env.CAPTURE_TRANSCRIPTS = "1";

const { capture, redact, callerRefused } = await import("../src/capture.js");

after(() => rmSync(dir, { recursive: true, force: true }));

const read = (character: string) => {
  const p = join(dir, "captured", `${character}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

test("redacts the identifiers people actually paste into chat", () => {
  assert.match(redact("mail me at kit@example.com"), /\[email\]/);
  assert.ok(!redact("mail me at kit@example.com").includes("example.com"));
  assert.match(redact("card 4111 1111 1111 1111"), /\[number\]/);
  assert.match(redact("call +1 (555) 123-4567"), /\[phone\]/);
  assert.match(redact("my key is sk-abcdefghijklmnop"), /\[secret\]/);
  assert.match(redact("send to 0x" + "a".repeat(40)), /\[address\]/);
  assert.match(redact("see https://example.com/reset?token=abc"), /\[url\]/);
});

test("redaction leaves ordinary conversation alone", () => {
  const line = "i had a long day and the sea was grey";
  assert.equal(redact(line), line);
});

test("a captured row holds the turns and the reply", () => {
  capture({
    character: "suwa-tide",
    app: "SillyTavern",
    messages: [
      { role: "system", content: "You are Tide." },
      { role: "user", content: "hey" },
    ],
    completion: "Still here.",
    refused: false,
  });
  const rows = read("suwa-tide");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].messages.map((m: any) => m.role), ["user", "assistant"]);
  assert.equal(rows[0].messages[1].content, "Still here.");
  assert.equal(rows[0].app, "SillyTavern");
});

test("our own system prompt is not stored back", () => {
  const rows = read("suwa-tide");
  assert.ok(
    !rows.some((r: any) => r.messages.some((m: any) => m.role === "system")),
    "storing the persona per row bloats the file and teaches the model to recite it"
  );
});

test("prompts are redacted before they reach disk", () => {
  capture({
    character: "suwa-abyss",
    app: "direct",
    messages: [{ role: "user", content: "i'm kit@example.com, remember that" }],
    completion: "Noted.",
    refused: false,
  });
  const raw = readFileSync(join(dir, "captured", "suwa-abyss.jsonl"), "utf8");
  assert.ok(!raw.includes("kit@example.com"), "an address must never be written down");
  assert.match(raw, /\[email\]/);
});

test("a caller that refuses is never captured", () => {
  capture({
    character: "suwa-reef",
    app: "direct",
    messages: [{ role: "user", content: "private" }],
    completion: "ok",
    refused: true,
  });
  assert.deepEqual(read("suwa-reef"), [], "no means no, before anything else");
});

test("the refusal header is recognised in the forms clients send", () => {
  assert.equal(callerRefused({ "x-suwa-no-capture": "1" }), true);
  assert.equal(callerRefused({ "x-suwa-no-capture": "true" }), true);
  assert.equal(callerRefused({ "x-suwa-no-capture": ["1"] }), true);
  assert.equal(callerRefused({}), false);
  assert.equal(callerRefused({ "x-suwa-no-capture": "0" }), false);
});

test("an empty reply is not worth keeping", () => {
  capture({ character: "suwa-drift", app: "d", messages: [{ role: "user", content: "hi" }], completion: "   ", refused: false });
  assert.deepEqual(read("suwa-drift"), []);
});

test("a turn-less request is not worth keeping", () => {
  capture({ character: "suwa-current", app: "d", messages: [{ role: "system", content: "only a system prompt" }], completion: "hi", refused: false });
  assert.deepEqual(read("suwa-current"), []);
});
