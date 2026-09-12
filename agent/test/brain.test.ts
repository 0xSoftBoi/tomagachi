/**
 * Brain-side unit test for Brain.manageTreasury() — the off-chain rebalancing
 * logic in agent/src/brain.ts — run against the same in-process EVM as the
 * contract suite, via a fake Creature adapter that forwards every call the
 * method makes (vaultAllowed/vaultSharePrice/vaultPosition/harvest/treasury/
 * invest/divest/speak) onto the real Tomagachi + mock-vault contracts.
 *
 * This is deliberately the one test in the suite that exercises production
 * TypeScript logic (not just the Solidity contract): the contract has no
 * concept of "best APY" or "rebalance" — that decision lives entirely in
 * manageTreasury(), so it can only be checked by running it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { TestChain, artifact, type Deployed } from "./evm.js";
import { config } from "../src/config.js";
import { saveState } from "../src/state.js";
import { Brain } from "../src/brain.js";

const OWNER = "0x1000000000000000000000000000000000000001";
const OPERATOR = "0x2000000000000000000000000000000000000002";
const ALICE = "0x3000000000000000000000000000000000000003";

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const NOM = (n: number) => BigInt(n) * 10n ** 18n;

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
