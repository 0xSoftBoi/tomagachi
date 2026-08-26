/**
 * Readiness. The failure this prevents is silent: a shop that answers 200 to
 * every health check while every real request behind it comes back 5xx.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { UpstreamHealth } from "../src/health.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("a reachable upstream is ready", async () => {
  const h = new UpstreamHealth(async () => {}, 5000, clock().now);
  const r = await h.status();
  assert.equal(r.ready, true);
});

test("an unreachable upstream is not ready, and says why", async () => {
  const h = new UpstreamHealth(async () => { throw new Error("ECONNREFUSED"); }, 5000, clock().now);
  const r = await h.status();
  assert.equal(r.ready, false);
  assert.match(r.detail, /ECONNREFUSED/);
});

test("a probe failure never throws out of status()", async () => {
  const h = new UpstreamHealth(async () => { throw "not even an Error"; }, 5000, clock().now);
  const r = await h.status(); // must not reject: an unready shop is still a live one
  assert.equal(r.ready, false);
});

test("results are cached, so polling does not become its own load", async () => {
  let probes = 0;
  const c = clock();
  const h = new UpstreamHealth(async () => { probes++; }, 5000, c.now);
  await h.status();
  await h.status();
  await h.status();
  assert.equal(probes, 1, "three polls inside the TTL is one question");
});

test("the cache expires and the upstream is asked again", async () => {
  let probes = 0;
  const c = clock();
  const h = new UpstreamHealth(async () => { probes++; }, 5000, c.now);
  await h.status();
  c.advance(5_001);
  await h.status();
  assert.equal(probes, 2);
});

test("recovery is noticed once the cache clears", async () => {
  let up = false;
  const c = clock();
  const h = new UpstreamHealth(async () => { if (!up) throw new Error("down"); }, 5000, c.now);
  assert.equal((await h.status()).ready, false);
  up = true;
  assert.equal((await h.status()).ready, false, "still inside the TTL");
  c.advance(5_001);
  assert.equal((await h.status()).ready, true);
});

test("concurrent polls collapse into a single probe", async () => {
  let probes = 0;
  const c = clock();
  const h = new UpstreamHealth(async () => {
    probes++;
    await new Promise((r) => setImmediate(r));
  }, 5000, c.now);
  const results = await Promise.all([h.status(), h.status(), h.status(), h.status()]);
  assert.equal(probes, 1, "an orchestrator burst must not become four connections");
  assert.ok(results.every((r) => r.ready));
});
