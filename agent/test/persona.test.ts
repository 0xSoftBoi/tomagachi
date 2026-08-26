/**
 * How the character's system prompt meets the caller's. Getting this wrong
 * either fights the app's own character card or ships a bare base model at a
 * character's price.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.STATE_DIR = process.env.STATE_DIR ?? "/tmp/suwa-persona-test";

const { composeMessages } = await import("../src/serve.js");
const { findCharacter } = await import("../src/characters.js");

const tide = findCharacter("suwa-tide")!;
const body = (messages: { role: string; content: string }[]) =>
  ({ model: "suwa-tide", messages }) as any;

test("with no system prompt, the character speaks in full", () => {
  const out = composeMessages(tide, body([{ role: "user", content: "hey" }]));
  assert.equal(out[0].role, "system");
  assert.match(out[0].content, /You are Tide/);
  assert.equal(out[out.length - 1].content, "hey");
});

test("merge keeps the caller's card first and adds consistency rules", () => {
  const out = composeMessages(tide, body([
    { role: "system", content: "You are Marla, a lighthouse keeper." },
    { role: "user", content: "is anyone out there?" },
  ]));
  assert.match(out[0].content, /Marla/, "the app's character must win");
  assert.match(out[1].content, /Stay in the character above/);
  assert.ok(!out.some((m) => /You are Tide/.test(m.content)), "our persona must not fight theirs");
});

test("the user's turns survive in order", () => {
  const out = composeMessages(tide, body([
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" },
  ]));
  const nonSystem = out.filter((m) => m.role !== "system").map((m) => m.content);
  assert.deepEqual(nonSystem, ["one", "two", "three"]);
});

test("a namespaced model id resolves to the same character", () => {
  assert.equal(findCharacter("suwappu/suwa-tide")?.id, "suwa-tide");
  assert.equal(findCharacter("suwa-tide")?.id, "suwa-tide");
  assert.equal(findCharacter("not-a-character"), undefined);
});
