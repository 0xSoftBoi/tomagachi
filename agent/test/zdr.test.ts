/**
 * Zero data retention, checked as behaviour rather than as a claim.
 *
 * A router publishes this flag next to the price and routes ZDR-only traffic
 * on it. It used to be its own environment variable, which meant the sentence
 * could be changed without changing what reached disk. These tests hold the
 * two together: with the switch on, nothing that could carry a customer's
 * words is written, and only then does the manifest say so.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "suwa-zdr-"));
process.env.STATE_DIR = join(dir, "state");
process.env.CAPTURE_DIR = join(dir, "captured");
// Deliberately left on: a stale capture flag from an earlier deployment must
// not be able to defeat the stronger claim.
process.env.CAPTURE_TRANSCRIPTS = "1";
process.env.ZERO_DATA_RETENTION = "1";

const { remember, recall, sessionCount, forget } = await import("../src/memory.js");
const { capture } = await import("../src/capture.js");
const { record } = await import("../src/usage.js");
const { providerManifest } = await import("../src/provider-manifest.js");
const { findCharacter } = await import("../src/characters.js");

after(() => rmSync(dir, { recursive: true, force: true }));

const tide = findCharacter("suwa-tide")!;
const secrets = ["my name is Kit", "kit@example.com", "i live in Porthcawl"];

test("session facts are not stored, recalled, or counted", () => {
  remember("s1", [{ role: "user", content: "my name is Kit and i live in Porthcawl" }]);
  assert.deepEqual(recall("s1"), []);
  assert.equal(sessionCount(), 0);
  assert.equal(forget("s1"), false, "there is nothing to forget");
});

test("a stale CAPTURE_TRANSCRIPTS=1 does not defeat the stronger claim", () => {
  const written = capture({
    character: "suwa-tide",
    app: "SillyTavern",
    messages: [{ role: "user", content: "kit@example.com" }],
    completion: "Still here.",
    refused: false,
  });
  assert.equal(written, null, "capture must refuse under ZDR");
});

test("nothing customer-shaped reached disk", () => {
  record({ character: "suwa-tide", app: "SillyTavern", promptTokens: 40, completionTokens: 8, latencyMs: 120 }, tide);
  const files: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      e.isDirectory() ? walk(p) : files.push(p);
    }
  };
  walk(dir);
  // The ledger is allowed to exist -- it holds counts. Nothing else should.
  assert.ok(!files.some((f) => f.endsWith("sessions.json")), `session store written: ${files}`);
  assert.ok(!files.some((f) => f.includes("captured")), `transcript written: ${files}`);
  const all = files.map((f) => readFileSync(f, "utf8")).join("\n");
  for (const s of secrets) assert.ok(!all.includes(s), `"${s}" is on disk under ZDR`);
});

test("only then does the manifest say so", () => {
  for (const doc of providerManifest().data) {
    assert.equal(doc.compliance.zdr, true, `${doc.id} should claim zdr once the switch is on`);
  }
});
