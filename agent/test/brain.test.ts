/**
 * Regression tests for the brain's crash/retry safety around on-chain
 * state-mutating calls. These exercise pure decision functions extracted
 * from brain.ts — no chain, no provider — so a network failure mid-epoch or
 * mid-earn() can be simulated deterministically.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planEpoch, reconcileEarn, pickRecallVault } from "../src/brain.js";

test("planEpoch: a fresh job pays for compute", () => {
  const plan = planEpoch({}, "pirate-epoch-1", 5_000_000n);
  assert.equal(plan.resuming, false);
  assert.equal(plan.paidUsdc, 5_000_000n);
});

test("planEpoch: resumes instead of re-buying compute for an interrupted job", () => {
  // Simulates state left behind when buyCompute() landed on-chain but the
  // process crashed (or checkpoint() threw) before the epoch completed.
  const state = {
    activeJob: {
      id: "pirate-epoch-1",
      provider: "gpu-worker",
      startedAt: new Date().toISOString(),
      paidUsdc: "5000000",
    },
  };
  const plan = planEpoch(state, "pirate-epoch-1", 5_000_000n);
  assert.equal(plan.resuming, true);
  assert.equal(plan.paidUsdc, 5_000_000n, "must reuse the amount already paid, not re-quote");
});

test("planEpoch: does not resume a stale job left over from a different epoch", () => {
  const state = {
    activeJob: {
      id: "pirate-epoch-1",
      provider: "gpu-worker",
      startedAt: new Date().toISOString(),
      paidUsdc: "5000000",
    },
  };
  const plan = planEpoch(state, "pirate-epoch-2", 5_000_000n);
  assert.equal(plan.resuming, false);
  assert.equal(plan.paidUsdc, 5_000_000n);
});

test("reconcileEarn: reports a landed earn() when the chain's counter already moved", () => {
  const pending = { amount: "1000000", revenueBefore: "9000000" };
  // totalRevenueEarned already advanced by >= the attempted amount: the tx
  // that we lost track of locally did in fact land.
  const r = reconcileEarn(pending, 10_000_000n);
  assert.equal(r.alreadyLanded, true);
  assert.equal(r.amount, 1_000_000n);
});

test("reconcileEarn: reports a lost earn() as safe to retry when the counter never moved", () => {
  const pending = { amount: "1000000", revenueBefore: "9000000" };
  // Nothing changed on-chain: the earn() tx never landed (e.g. it never
  // broadcast), so retrying is safe and will not double-count revenue.
  const r = reconcileEarn(pending, 9_000_000n);
  assert.equal(r.alreadyLanded, false);
  assert.equal(r.amount, 1_000_000n);
});

test("pickRecallVault: picks the currently-allowed vault with the lowest APY", () => {
  const positions = {
    a: { principal: 10n },
    b: { principal: 20n },
  };
  const apy = { a: 0.05, b: 0.02 };
  assert.equal(pickRecallVault(["a", "b"], positions, apy), "b");
});

test("pickRecallVault: returns undefined instead of crashing when treasury().principal " +
  "reflects a vault that has since been de-whitelisted", () => {
  // Regression: treasury().principal > 0 does not imply some vault in the
  // *currently allowed* list has principal — a de-whitelisted vault can
  // still hold funds. The old code did `funded.reduce(...)` on a possibly
  // empty array here, which throws on an empty array with no initial value.
  const positions = { a: { principal: 0n } };
  const apy = { a: 0.05 };
  assert.equal(pickRecallVault(["a"], positions, apy), undefined);
});
