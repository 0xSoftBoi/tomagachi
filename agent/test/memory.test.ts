/**
 * Session memory is half of what the price premium buys. It is also the thing
 * most likely to hurt: a wrong "fact" injected into every future turn is worse
 * for character consistency than having no memory at all.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "suwa-memory-"));
process.env.STATE_DIR = stateDir;

const { extract, remember, recall, forget } = await import("../src/memory.js");

after(() => rmSync(stateDir, { recursive: true, force: true }));

const user = (content: string) => [{ role: "user", content }];

test("extracts a name as one word, not the rest of the sentence", () => {
  const facts = extract("my name is Kit and i like cold water swimming");
  assert.ok(facts.some((f) => f.toLowerCase() === "my name is kit"), facts.join(" | "));
});

test("keeps two distinct facts from one sentence without overlap", () => {
  remember("s1", user("my name is Kit and i like cold water swimming"));
  const facts = recall("s1");
  assert.equal(facts.length, 2, facts.join(" | "));
  assert.ok(facts.some((f) => /kit/i.test(f)));
  assert.ok(facts.some((f) => /cold water swimming/i.test(f)));
});

test("does not store the same fact twice", () => {
  remember("s2", user("i like tea"));
  remember("s2", user("i like tea"));
  assert.equal(recall("s2").length, 1);
});

test("a longer restatement replaces the fact it contains", () => {
  remember("s3", user("i like tea"));
  remember("s3", user("i like tea with too much sugar"));
  const facts = recall("s3");
  assert.equal(facts.length, 1, facts.join(" | "));
  assert.match(facts[0], /too much sugar/);
});

test("only the newest user turn is read", () => {
  remember("s4", [
    { role: "user", content: "i like sailing" },
    { role: "assistant", content: "noted" },
    { role: "user", content: "i like knots" },
  ]);
  const facts = recall("s4");
  assert.equal(facts.length, 1, "earlier turns were already seen on their own request");
  assert.match(facts[0], /knots/);
});

test("assistant text is never mined for facts", () => {
  remember("s5", [{ role: "assistant", content: "my name is Tide and i like the deep" }]);
  assert.deepEqual(recall("s5"), []);
});

test("a request with nothing assertable stores nothing", () => {
  remember("s6", user("what happens next?"));
  assert.deepEqual(recall("s6"), []);
});

test("the fact list is capped, keeping the newest", () => {
  for (let i = 0; i < 20; i++) remember("s7", user(`remember thing number ${i}`));
  const facts = recall("s7");
  assert.ok(facts.length <= 12, `kept ${facts.length}`);
  assert.match(facts[facts.length - 1], /number 19/);
});

test("an unknown session recalls nothing, and forget clears one", () => {
  assert.deepEqual(recall("never-seen"), []);
  remember("s8", user("my name is Ada"));
  assert.equal(recall("s8").length, 1);
  forget("s8");
  assert.deepEqual(recall("s8"), []);
});
