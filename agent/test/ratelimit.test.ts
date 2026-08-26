/**
 * The declared ceiling. Getting this wrong in one direction refuses paying
 * traffic; in the other it queues behind a full GPU, which reads as a slow
 * model on the public page. The window edge is where both happen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/ratelimit.js";

/** A clock we control — real time makes the boundary untestable. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("allows exactly the limit, then refuses", () => {
  const c = clock();
  const rl = new RateLimiter(3, c.now);
  assert.equal(rl.take(), null);
  assert.equal(rl.take(), null);
  assert.equal(rl.take(), null);
  assert.equal(typeof rl.take(), "number", "the fourth in the window is refused");
});

test("retry-after points past the oldest request in the window", () => {
  const c = clock();
  const rl = new RateLimiter(2, c.now);
  rl.take();                 // t = 0
  c.advance(10_000);
  rl.take();                 // t = 10s
  c.advance(5_000);          // t = 15s; the oldest expires at t = 60s
  assert.equal(rl.take(), 45);
});

test("the window slides rather than resetting", () => {
  const c = clock();
  const rl = new RateLimiter(2, c.now);
  rl.take();
  c.advance(30_000);
  rl.take();
  c.advance(31_000); // the first has now aged out, the second has not
  assert.equal(rl.take(), null, "one slot freed as one request expired");
  assert.ok(rl.take() !== null, "the second slot is still held");
});

test("a fixed window would let a double burst through; this does not", () => {
  const c = clock();
  const rl = new RateLimiter(10, c.now);
  // Ten at the end of one notional minute...
  c.advance(59_000);
  for (let i = 0; i < 10; i++) assert.equal(rl.take(), null);
  // ...and ten more just after it. A fixed window resets and allows all ten.
  c.advance(1_500);
  assert.ok(rl.take() !== null, "20 requests in 1.5s must not be allowed");
});

test("everything is allowed again once the window clears", () => {
  const c = clock();
  const rl = new RateLimiter(2, c.now);
  rl.take();
  rl.take();
  assert.ok(rl.take() !== null);
  c.advance(60_001);
  assert.equal(rl.take(), null);
  assert.equal(rl.inWindow, 1);
});

test("a limit of zero disables the ceiling", () => {
  const c = clock();
  const rl = new RateLimiter(0, c.now);
  for (let i = 0; i < 1000; i++) assert.equal(rl.take(), null);
});

test("retry-after is never zero", () => {
  const c = clock();
  const rl = new RateLimiter(1, c.now);
  rl.take();
  c.advance(59_999); // 1ms of window left; advising 0 would invite an instant retry
  assert.equal(rl.take(), 1);
});

test("the window does not grow without bound", () => {
  const c = clock();
  const rl = new RateLimiter(5, c.now);
  for (let i = 0; i < 500; i++) {
    rl.take();
    c.advance(1_000);
  }
  assert.ok(rl.inWindow <= 5, `kept ${rl.inWindow} timestamps`);
});
