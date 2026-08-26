/**
 * Retry and the breaker. The failure being prevented is a single dropped
 * connection becoming a 502, and its opposite: retrying into a dead GPU until
 * every caller has waited out a timeout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker, BreakerOpenError, withRetry, isTransient } from "../src/resilience.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}
const httpError = (status: number) => Object.assign(new Error(`upstream ${status}`), { upstreamStatus: status });

test("a transient failure is retried and the retry's success is returned", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    if (++calls === 1) throw new Error("ECONNRESET");
    return "completed";
  });
  assert.equal(result, "completed");
  assert.equal(calls, 2, "one dropped connection should not reach the caller");
});

test("retries are bounded", async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new Error("down"); }, { retries: 1 }));
  assert.equal(calls, 2);
});

test("a 4xx is not retried — it will be wrong again", async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw httpError(400); }));
  assert.equal(calls, 1);
});

test("a 429 is not retried — saturation is for the caller to hear immediately", async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw httpError(429); }));
  assert.equal(calls, 1);
  assert.equal(isTransient(httpError(429)), false);
  assert.equal(isTransient(httpError(500)), true);
  assert.equal(isTransient(new Error("fetch failed")), true, "a network error has no status");
});

test("the breaker opens after consecutive failures and then fails fast", async () => {
  const c = clock();
  const breaker = new CircuitBreaker(3, 10_000, c.now);
  let calls = 0;
  const boom = () => withRetry(async () => { calls++; throw new Error("down"); }, { retries: 0, breaker });

  for (let i = 0; i < 3; i++) await assert.rejects(boom());
  assert.equal(calls, 3);
  assert.equal(breaker.state, "open");

  await assert.rejects(boom(), (e: any) => e instanceof BreakerOpenError);
  assert.equal(calls, 3, "an open breaker must not open a connection");
});

test("after the cooldown one trial gets through, and success closes it", async () => {
  const c = clock();
  const breaker = new CircuitBreaker(2, 10_000, c.now);
  const fail = () => withRetry(async () => { throw new Error("down"); }, { retries: 0, breaker });
  await assert.rejects(fail());
  await assert.rejects(fail());
  assert.equal(breaker.state, "open");

  c.advance(10_001);
  assert.equal(breaker.state, "half-open");
  const ok = await withRetry(async () => "recovered", { retries: 0, breaker });
  assert.equal(ok, "recovered");
  assert.equal(breaker.state, "closed", "recovery must fully reset the breaker");
});

test("a failed trial re-opens the breaker for another cooldown", async () => {
  const c = clock();
  const breaker = new CircuitBreaker(2, 10_000, c.now);
  const fail = () => withRetry(async () => { throw new Error("down"); }, { retries: 0, breaker });
  await assert.rejects(fail());
  await assert.rejects(fail());
  c.advance(10_001);
  await assert.rejects(fail(), (e: any) => !(e instanceof BreakerOpenError), "the trial reaches upstream");
  assert.equal(breaker.state, "open", "still broken, so stay open");
  await assert.rejects(fail(), (e: any) => e instanceof BreakerOpenError);
});

test("only one trial is admitted while half-open", async () => {
  const c = clock();
  const breaker = new CircuitBreaker(1, 10_000, c.now);
  await assert.rejects(withRetry(async () => { throw new Error("down"); }, { retries: 0, breaker }));
  c.advance(10_001);
  assert.equal(breaker.canAttempt(), true);
  assert.equal(breaker.canAttempt(), false, "a burst must not all become trials");
});

test("client errors never open the breaker", async () => {
  const c = clock();
  const breaker = new CircuitBreaker(2, 10_000, c.now);
  for (let i = 0; i < 10; i++) {
    await assert.rejects(withRetry(async () => { throw httpError(400); }, { retries: 0, breaker }));
  }
  assert.equal(breaker.state, "closed", "one broken caller must not take the shop offline");
});

test("a success resets the failure count", async () => {
  const c = clock();
  const breaker = new CircuitBreaker(3, 10_000, c.now);
  const fail = () => withRetry(async () => { throw new Error("blip"); }, { retries: 0, breaker });
  await assert.rejects(fail());
  await assert.rejects(fail());
  await withRetry(async () => "fine", { retries: 0, breaker });
  await assert.rejects(fail());
  await assert.rejects(fail());
  assert.equal(breaker.state, "closed", "intermittent blips are not an outage");
});
