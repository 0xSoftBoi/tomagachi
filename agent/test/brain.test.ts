/**
 * Brain-side tests for agent/src/brain.ts. Two kinds live here:
 *
 * 1. An integration test for Brain.manageTreasury() — the off-chain
 *    rebalancing logic — run against the same in-process EVM as the
 *    contract suite, via a fake Creature adapter that forwards every call
 *    the method makes onto the real Tomagachi + mock-vault contracts. This
 *    is the one test in the suite that exercises production TypeScript
 *    logic (not just the Solidity contract): the contract has no concept
 *    of "best APY" or "rebalance" — that decision lives entirely in
 *    manageTreasury(), so it can only be checked by running it.
 *
 * 2. Regression tests for the brain's crash/retry safety around on-chain
 *    state-mutating calls (planEpoch, reconcileEarn, pickRecallVault) —
 *    pure decision functions extracted from brain.ts, no chain, no
 *    provider, so a network failure mid-epoch or mid-earn() can be
 *    simulated deterministically.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { TestChain, artifact, type Deployed } from "./evm.js";
import { config } from "../src/config.js";
import { loadState, saveState } from "../src/state.js";
import { Brain, planEpoch, reconcileEarn, pickRecallVault } from "../src/brain.js";

const OWNER = "0x1000000000000000000000000000000000000001";
const OPERATOR = "0x2000000000000000000000000000000000000002";
const ALICE = "0x3000000000000000000000000000000000000003";

const USDC = (n: number) => BigInt(Math.round(n * 1e6));

/** Adapts the real chain.Creature interface that Brain.manageTreasury() calls
 *  onto our in-process EVM, so the production rebalancing logic runs against
 *  real contract state instead of a real RPC. */
function fakeCreature(chain: TestChain, creature: Deployed, vaults: Record<string, Deployed>) {
  return {
    async vaultAllowed(vault: `0x${string}`) {
      return chain.read<boolean>(creature, "allowedVault", [vault]);
    },
    async vaultSharePrice(vault: `0x${string}`) {
      return chain.read<bigint>(vaults[vault], "convertToAssets", [10n ** 12n]);
    },
    async vaultPosition(vault: `0x${string}`) {
      const shares = await chain.read<bigint>(vaults[vault], "balanceOf", [creature.address]);
      const value =
        shares === 0n ? 0n : await chain.read<bigint>(vaults[vault], "convertToAssets", [shares]);
      const principal = await chain.read<bigint>(creature, "principalOf", [vault]);
      return { value, principal };
    },
    async harvest(vault: `0x${string}`) {
      await chain.write(OPERATOR, creature, "harvest", [vault]);
      return "0x00" as `0x${string}`;
    },
    async treasury() {
      const [liquid, invested, principal, yieldEarned] = await chain.read<bigint[]>(
        creature,
        "treasury"
      );
      return { liquid, invested, principal, yieldEarned };
    },
    async invest(vault: `0x${string}`, amount: bigint) {
      await chain.write(OPERATOR, creature, "invest", [vault, amount]);
      return "0x00" as `0x${string}`;
    },
    async divest(vault: `0x${string}`, amount: bigint) {
      await chain.write(OPERATOR, creature, "divest", [vault, amount]);
      return "0x00" as `0x${string}`;
    },
    async speak(words: string) {
      await chain.write(OPERATOR, creature, "speak", [words]);
      return "0x00" as `0x${string}`;
    },
  };
}

test("manageTreasury(): harvests every vault above minimum (minting no NOM), farms idle liquidity into the best-APY vault, and rebalances the laggard's principal into it", async () => {
  const savedConfig = {
    yieldVaults: config.yieldVaults,
    liquidTargetUsdc: config.liquidTargetUsdc,
    minEnergyToTrain: config.minEnergyToTrain,
    harvestMinUsdc: config.harvestMinUsdc,
    rebalanceMinBps: config.rebalanceMinBps,
  };

  try {
    const chain = await TestChain.create();
    const usdc = await chain.deploy("MockUSDC");
    const vaultA = await chain.deploy("MockVault4626", [usdc.address]); // will lag (no yield)
    const vaultB = await chain.deploy("MockVault4626", [usdc.address]); // modest yield
    const vaultC = await chain.deploy("MockVault4626", [usdc.address]); // best yield
    const creature = await chain.deploy("Tomagachi", [
      usdc.address, OWNER, OPERATOR, "Suwa", USDC(5), USDC(1_000_000),
    ]);
    const nom = { address: await chain.read<`0x${string}`>(creature, "nom"), abi: artifact("NomToken").abi };

    await chain.write(ALICE, usdc, "mint", [ALICE, USDC(1_000)]);
    await chain.write(ALICE, usdc, "approve", [creature.address, USDC(1_000)]);
    await chain.write(ALICE, creature, "feed", [USDC(400)]);

    for (const v of [vaultA, vaultB, vaultC]) {
      await chain.write(OWNER, creature, "allowVault", [v.address, true]);
      await chain.write(OPERATOR, creature, "invest", [v.address, USDC(100)]);
    }
    // Liquid = 400 fed - 300 invested = 100.

    // Seed a same-price sample two hours in the past for every vault, so this
    // tick both takes a fresh sample (>=1h gap) and can compute a trailing
    // APY from the price drift below. All three start at parity (1:1).
    const t0 = Date.now() - 2 * 3_600_000;
    const pps0 = await chain.read<bigint>(vaultA, "convertToAssets", [10n ** 12n]);
    saveState({
      epoch: 0,
      vaultSamples: {
        [vaultA.address]: [{ t: t0, ppsE12: pps0.toString() }],
        [vaultB.address]: [{ t: t0, ppsE12: pps0.toString() }],
        [vaultC.address]: [{ t: t0, ppsE12: pps0.toString() }],
      },
    });

    // Simulate trailing yield by donating straight to the vaults: A gets
    // nothing (the laggard), B a little, C the most (the best APY).
    await chain.write(ALICE, usdc, "mint", [vaultB.address, USDC(5)]);
    await chain.write(ALICE, usdc, "mint", [vaultC.address, USDC(30)]);

    (config as any).yieldVaults = [vaultA.address, vaultB.address, vaultC.address];
    (config as any).liquidTargetUsdc = USDC(10);
    (config as any).minEnergyToTrain = USDC(1);
    (config as any).harvestMinUsdc = USDC(1);
    (config as any).rebalanceMinBps = 200;

    const brain = Object.create(Brain.prototype) as Brain;
    (brain as any).creature = fakeCreature(chain, creature, {
      [vaultA.address]: vaultA,
      [vaultB.address]: vaultB,
      [vaultC.address]: vaultC,
    });

    const nomBefore = await chain.read<bigint>(nom, "totalSupply");
    const satietyBefore = await chain.read<bigint>(creature, "satiety"); // 400, from the initial feed
    const harvested = await brain.manageTreasury();

    assert.equal(harvested, true, "pending yield on B and C should trigger a harvest");
    assert.equal(await chain.read(nom, "totalSupply"), nomBefore, "harvest must mint no NOM");

    // Both harvests landed as satiety on top of what was already there (5 + 30 = 35).
    const satiety = await chain.read<bigint>(creature, "satiety");
    assert.equal(satiety, satietyBefore + USDC(35));
    assert.equal(await chain.read(creature, "totalYieldEarned"), USDC(35));

    // Best-APY vault (C) is the one that both the new liquidity AND the
    // laggard's (A's) rebalanced principal land in.
    assert.equal(await chain.read(creature, "principalOf", [vaultA.address]), 0n, "laggard fully rebalanced out");
    assert.equal(await chain.read(creature, "principalOf", [vaultB.address]), USDC(100), "untouched — only one rebalance per tick");
    assert.equal(
      await chain.read(creature, "principalOf", [vaultC.address]),
      USDC(325), // 100 original + 125 excess liquidity + 100 rebalanced from A
      "best-APY vault should receive both the new liquidity and the laggard's principal"
    );

    // The liquidity buffer is topped back down to the configured target.
    assert.equal(await chain.read(creature, "energy"), USDC(10));
  } finally {
    Object.assign(config, savedConfig);
    rmSync(config.stateDir, { recursive: true, force: true });
  }
});

test("trainEpoch(): an epoch already recorded on-chain is not retrained or resubmitted", async () => {
  // Simulates the crash-retry window checkpoint()'s dedup guard closes: a
  // previous run's checkpoint() landed on-chain (chain now has 3 epochs) but
  // local state was never updated past epoch 2, so a naive resume would
  // retrain epoch 3 for nothing and then have checkpoint() revert on-chain
  // (epochs must strictly increase). trainEpoch() must instead recognize the
  // chain is already ahead and just catch up local state.
  try {
    saveState({ epoch: 2 });

    const brain = Object.create(Brain.prototype) as Brain;
    (brain as any).creature = {
      async vitals() {
        return { epochs: 3n, mood: "HAPPY", satiety: 0n, energy: 0n, totalFed: 0n, totalComputeSpent: 0n };
      },
    };
    // No provider/nextCharacter dependencies are set — if the skip path
    // didn't return before touching them, this would throw.

    await brain.trainEpoch(0n);

    const state = loadState();
    assert.equal(state.epoch, 3, "local state catches up to the on-chain count");
    assert.equal(state.activeJob, undefined, "no job left dangling for an epoch that was never (re)started");
  } finally {
    rmSync(config.stateDir, { recursive: true, force: true });
  }
});

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
