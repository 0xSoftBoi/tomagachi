/**
 * The stream tally decides what a streamed completion is billed. Every case
 * here is one that would silently bill zero, or bill twice, if it regressed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SseTally } from "../src/stream.js";

const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (content: string) => frame({ choices: [{ delta: { content } }] });

test("counts delta characters across frames", () => {
  const sse = new SseTally();
  sse.push(delta("hello ") + delta("world"));
  assert.equal(sse.tally.completionChars, 11);
});

test("takes token counts from the usage frame", () => {
  const sse = new SseTally();
  sse.push(delta("hi") + frame({ choices: [], usage: { prompt_tokens: 321, completion_tokens: 47 } }));
  assert.equal(sse.tally.promptTokens, 321);
  assert.equal(sse.tally.completionTokens, 47);
});

test("holds a frame split across chunk boundaries", () => {
  const whole = frame({ choices: [{ delta: { content: "split" } }], usage: { prompt_tokens: 9, completion_tokens: 3 } });
  const sse = new SseTally();
  // Split mid-JSON: the first half must not be parsed or discarded.
  const cut = Math.floor(whole.length / 2);
  sse.push(whole.slice(0, cut));
  assert.equal(sse.tally.completionChars, 0, "half a frame must count for nothing yet");
  sse.push(whole.slice(cut));
  assert.equal(sse.tally.completionChars, 5);
  assert.equal(sse.tally.promptTokens, 9);
});

test("survives a byte-at-a-time stream", () => {
  const whole = delta("abc") + frame({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }) + "data: [DONE]\n\n";
  const sse = new SseTally();
  for (const ch of whole) sse.push(ch);
  assert.equal(sse.tally.completionChars, 3);
  assert.equal(sse.tally.completionTokens, 2);
  assert.equal(sse.tally.sawDone, true);
});

test("ignores keep-alive comments and blank lines", () => {
  const sse = new SseTally();
  sse.push(": keep-alive\n\n" + delta("x") + "\n\n");
  assert.equal(sse.tally.completionChars, 1);
});

test("does not double-count when usage arrives twice", () => {
  const sse = new SseTally();
  sse.push(frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } }));
  sse.push(frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 6 } }));
  assert.equal(sse.tally.promptTokens, 10, "usage replaces, never accumulates");
  assert.equal(sse.tally.completionTokens, 6, "the last frame wins");
});

test("malformed JSON in a frame does not throw or stop the tally", () => {
  const sse = new SseTally();
  sse.push("data: {not json}\n\n" + delta("still counted"));
  assert.equal(sse.tally.completionChars, 13);
});
