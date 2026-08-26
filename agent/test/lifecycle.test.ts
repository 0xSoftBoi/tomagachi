/**
 * Draining. The bug this prevents is invisible until you look at the uptime
 * score: every redeploy severing live streams, each one a mid-stream error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Lifecycle } from "../src/lifecycle.js";

test("requests are admitted and counted while serving normally", () => {
  const l = new Lifecycle();
  assert.equal(l.enter(), true);
  assert.equal(l.enter(), true);
  assert.equal(l.active, 2);
  l.exit();
  assert.equal(l.active, 1);
});

test("a drain refuses new requests but keeps the running ones", () => {
  const l = new Lifecycle();
  l.enter();
  l.beginDrain();
  assert.equal(l.enter(), false, "new work belongs to whoever is taking over");
  assert.equal(l.active, 1, "the in-flight request is untouched");
});

test("whenIdle resolves once the last request finishes", async () => {
  const l = new Lifecycle();
  l.enter();
  l.enter();
  l.beginDrain();

  let drained = false;
  const wait = l.whenIdle(1000).then((ok) => (drained = ok));
  await new Promise((r) => setImmediate(r));
  assert.equal(drained, false, "still two in flight");

  l.exit();
  await new Promise((r) => setImmediate(r));
  assert.equal(drained, false, "one still in flight");

  l.exit();
  assert.equal(await wait, true);
});

test("an idle process drains immediately", async () => {
  const l = new Lifecycle();
  l.beginDrain();
  assert.equal(await l.whenIdle(1000), true);
});

test("a stuck request cannot hold a deploy open forever", async () => {
  const l = new Lifecycle();
  l.enter();
  l.beginDrain();
  assert.equal(await l.whenIdle(20), false, "the deadline has to win eventually");
});

test("the counter never goes negative on a double exit", () => {
  const l = new Lifecycle();
  l.enter();
  l.exit();
  l.exit();
  assert.equal(l.active, 0);
});

test("several waiters all resolve on the same drain", async () => {
  const l = new Lifecycle();
  l.enter();
  l.beginDrain();
  const waits = [l.whenIdle(1000), l.whenIdle(1000), l.whenIdle(1000)];
  l.exit();
  assert.deepEqual(await Promise.all(waits), [true, true, true]);
});
