/**
 * Two costs, two different questions. The whole market analysis turned on the
 * gap between them: a fine marginal margin sitting on top of an absorbed
 * margin of roughly nothing, because the GPU bills for 168 hours a week and
 * the traffic only fills 27 of them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.STATE_DIR = process.env.STATE_DIR ?? "/tmp/suwa-cost-test";
process.env.GPU_USD_PER_HOUR = "2";
process.env.GPU_COUNT = "1";
process.env.PREFILL_TOKENS_PER_SEC = "20000";
process.env.DECODE_TOKENS_PER_SEC = "2000";

const { gpuSeconds, usdPerGpuSecond, marginalCost, marginPct } = await import("../src/cost.js");

test("prompt tokens are an order of magnitude cheaper to serve than completions", () => {
  assert.equal(gpuSeconds(20_000, 0), 1, "20k prompt tokens prefill in a second");
  assert.equal(gpuSeconds(0, 2_000), 1, "2k completion tokens take the same second");
  assert.equal(gpuSeconds(20_000, 2_000), 2);
});

test("a GPU second is priced from the hourly rate", () => {
  assert.equal(usdPerGpuSecond(), 2 / 3600);
});

test("marginal cost is GPU time at that price", () => {
  // One second of GPU on a $2/hr machine.
  assert.equal(marginalCost(20_000, 0), 2 / 3600);
});

test("a typical roleplay request costs a fraction of a cent to serve", () => {
  // The observed mix: prompt-heavy, ~3,700 tokens per request.
  const cost = marginalCost(3_500, 200);
  assert.ok(cost < 0.001, `expected well under a cent, got ${cost}`);
});

test("margin is a fraction of revenue, and can be negative", () => {
  assert.equal(marginPct(1, 0.25), 0.75);
  assert.equal(marginPct(1, 2), -1);
});

test("margin on no revenue is unknown rather than zero", () => {
  assert.equal(marginPct(0, 5), null, "free traffic has no margin, not a 0% one");
});

test("the flattering number and the real one disagree, which is the point", () => {
  // A week that looks wonderful per request and cannot pay for the machine:
  // one billion prompt tokens at $0.60/M is $600 of revenue...
  const revenue = 600;
  const marginal = marginalCost(1_000_000_000, 0); // ...costing ~$27 of GPU time
  const gpuBill = 2 * 168; // ...against a $336 weekly bill

  assert.ok(marginPct(revenue, marginal)! > 0.9, "marginal margin looks excellent");
  assert.ok(marginPct(revenue, gpuBill)! > 0, "and here the week does clear the bill");

  // Now the same excellent marginal margin on a tenth of the traffic.
  const thinRevenue = 60;
  assert.ok(marginPct(thinRevenue, marginalCost(100_000_000, 0))! > 0.9, "still excellent per request");
  assert.ok(marginPct(thinRevenue, gpuBill)! < 0, "while the machine goes unpaid");
});
