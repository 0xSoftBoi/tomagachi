/**
 * Behavior tests for the creature, run against an in-process EVM.
 *
 *   npm test          (compiles contracts first via pretest)
 *
 * Covers the whole metabolism: feeding and NOM, decay and hibernation,
 * compute spending, the real-yield treasury (invest/divest/harvest — including
 * a creature waking itself from hibernation on its own yield), the earn()
 * revenue path, governance, and the feeder registry the leaderboard reads.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { TestChain, expectRevert, artifact, type Deployed } from "./evm.js";

const OWNER = "0x1000000000000000000000000000000000000001";
const OPERATOR = "0x2000000000000000000000000000000000000002";
const ALICE = "0x3000000000000000000000000000000000000003";
const BOB = "0x4000000000000000000000000000000000000004";
const PROVIDER = "0x5000000000000000000000000000000000000005";

const MOODS = ["EGG", "HAPPY", "PECKISH", "STARVING", "HIBERNATING"] as const;
const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const NOM = (n: number) => BigInt(n) * 10n ** 18n;
const DAY = 86_400;

let chain: TestChain;
let usdc: Deployed;
let vault: Deployed;
let creature: Deployed;
let nom: Deployed;

async function mood(): Promise<(typeof MOODS)[number]> {
  return MOODS[Number(await chain.read<bigint>(creature, "mood"))];
}

async function feedAs(who: string, amount: bigint): Promise<void> {
  await chain.write(who, usdc, "approve", [creature.address, amount]);
  await chain.write(who, creature, "feed", [amount]);
}

beforeEach(async () => {
  chain = await TestChain.create();
  usdc = await chain.deploy("MockUSDC");
  vault = await chain.deploy("MockVault4626", [usdc.address]);
  // 5 USDC of appetite a day, 500 USDC max satiety — the deploy defaults.
  creature = await chain.deploy("Tomagachi", [
    usdc.address, OWNER, OPERATOR, "Suwa", USDC(5), USDC(500),
  ]);
  nom = { address: await chain.read<`0x${string}`>(creature, "nom"), abi: artifact("NomToken").abi };
  for (const who of [ALICE, BOB, OPERATOR]) {
    await chain.write(who, usdc, "mint", [who, USDC(1_000)]);
  }
});

test("feeding hatches the egg, mints NOM 1:1, and registers the feeder", async () => {
  assert.equal(await mood(), "EGG");

  await feedAs(ALICE, USDC(300)); // 60% of max satiety — a happy creature

  assert.equal(await mood(), "HAPPY");
  assert.equal(await chain.read(creature, "satiety"), USDC(300));
  assert.equal(await chain.read(creature, "energy"), USDC(300));
  assert.equal(await chain.read(nom, "balanceOf", [ALICE]), NOM(300));
  assert.equal(await chain.read(creature, "fedBy", [ALICE]), USDC(300));
  assert.equal(await chain.read(creature, "feederCount"), 1n);

  // Feeding twice does not duplicate the registry entry; a new feeder does.
  await feedAs(ALICE, USDC(10));
  assert.equal(await chain.read(creature, "feederCount"), 1n);
  await feedAs(BOB, USDC(50));
  assert.equal(await chain.read(creature, "feederCount"), 2n);
  const second = await chain.read<string>(creature, "feeders", [1n]);
  assert.equal(second.toLowerCase(), BOB.toLowerCase());
});

test("metabolism decays satiety over time and starves into hibernation", async () => {
  await feedAs(ALICE, USDC(50)); // 10 days of life at 5/day

  chain.advance(5 * DAY);
  assert.equal(await chain.read(creature, "satiety"), USDC(25));
  assert.equal(await mood(), "STARVING"); // 25/500 of max — under the 20% line

  chain.advance(5 * DAY);
  assert.equal(await chain.read(creature, "satiety"), 0n);
  assert.equal(await mood(), "HIBERNATING");

  // Hibernation halts training: the belly still holds USDC but none may leave.
  await expectRevert(
    chain.write(OPERATOR, creature, "buyCompute", [PROVIDER, USDC(1), "test", "job-1"]),
    "hibernating: feed me"
  );

  // Metabolism is virtual: not one cent of energy was burned.
  assert.equal(await chain.read(creature, "energy"), USDC(50));
});

test("buyCompute pays a provider, records it, and is operator-only", async () => {
  await feedAs(ALICE, USDC(100));

  await expectRevert(
    chain.write(ALICE, creature, "buyCompute", [PROVIDER, USDC(10), "gpu", "job-1"]),
    "not operator"
  );

  await chain.write(OPERATOR, creature, "buyCompute", [PROVIDER, USDC(10), "gpu", "job-1"]);
  assert.equal(await chain.read(creature, "energy"), USDC(90));
  assert.equal(await chain.read(usdc, "balanceOf", [PROVIDER]), USDC(10));
  assert.equal(await chain.read(creature, "totalComputeSpent"), USDC(10));
  assert.equal(await chain.read(creature, "purchaseCount"), 1n);
});

test("treasury: invest moves energy into the vault, divest recalls it", async () => {
  await feedAs(ALICE, USDC(100));

  // Only whitelisted vaults, only the operator.
  await expectRevert(
    chain.write(OPERATOR, creature, "invest", [vault.address, USDC(60)]),
    "invest: vault not allowed"
  );
  await expectRevert(chain.write(ALICE, creature, "allowVault", [vault.address, true]), "not owner");
  await chain.write(OWNER, creature, "allowVault", [vault.address, true]);

  await chain.write(OPERATOR, creature, "invest", [vault.address, USDC(60)]);
  assert.equal(await chain.read(creature, "energy"), USDC(40));
  const [liquid, invested, principal] = await chain.read<bigint[]>(creature, "treasury");
  assert.equal(liquid, USDC(40));
  assert.equal(invested, USDC(60));
  assert.equal(principal, USDC(60));

  await chain.write(OPERATOR, creature, "divest", [vault.address, USDC(20)]);
  assert.equal(await chain.read(creature, "energy"), USDC(60));
  assert.equal(await chain.read(creature, "principalOf", [vault.address]), USDC(40));

  await expectRevert(
    chain.write(OPERATOR, creature, "divest", [vault.address, USDC(41)]),
    "divest: bad amount"
  );
});

test("vault concentration cap: bootstraps freely, then keeps a vault from dominating", async () => {
  await feedAs(ALICE, USDC(1_000)); // Alice's whole minted balance
  await chain.write(OWNER, creature, "allowVault", [vault.address, true]);

  // Only one vault allowed: the owner's single-vault choice stands, even at
  // 100% concentration — there is no alternative to diversify into.
  await chain.write(OPERATOR, creature, "invest", [vault.address, USDC(300)]);
  assert.equal(await chain.read(creature, "principalOf", [vault.address]), USDC(300));

  // A second vault makes diversification possible. totalInvested is already
  // non-zero (300), so the 60% default cap now applies going forward.
  const vault2 = await chain.deploy("MockVault4626", [usdc.address]);
  await chain.write(OWNER, creature, "allowVault", [vault2.address, true]);
  assert.equal(await chain.read(creature, "allowedVaultCount"), 2n);

  // 450 into vault2 lands it at exactly 60% of the new 750 total — the cap
  // boundary is inclusive (<=), so this succeeds. 250 USDC stays liquid.
  await chain.write(OPERATOR, creature, "invest", [vault2.address, USDC(450)]);
  assert.equal(await chain.read(creature, "principalOf", [vault2.address]), USDC(450));

  // One more USDC into the already-60% vault2 would push it over the line.
  await expectRevert(
    chain.write(OPERATOR, creature, "invest", [vault2.address, USDC(1)]),
    "invest: concentration cap"
  );
  // The same USDC is fine going to the less-concentrated vault (now 40%).
  await chain.write(OPERATOR, creature, "invest", [vault.address, USDC(1)]);

  await expectRevert(chain.write(ALICE, creature, "setMaxVaultConcentration", [10000n]), "not owner");
  await chain.write(OWNER, creature, "setMaxVaultConcentration", [10000n]); // owner can loosen it
  await chain.write(OPERATOR, creature, "invest", [vault2.address, USDC(1)]); // now fine at any share
});

test("harvest eats real yield: satiety rises, no NOM mints, and it can wake the creature", async () => {
  await feedAs(ALICE, USDC(20)); // 4 days of life
  await chain.write(OWNER, creature, "allowVault", [vault.address, true]);
  await chain.write(OPERATOR, creature, "invest", [vault.address, USDC(15)]);

  await expectRevert(
    chain.write(OPERATOR, creature, "harvest", [vault.address]),
    "harvest: nothing to harvest"
  );

  // Starve it, then let the farm work: the vault earns 30 USDC.
  chain.advance(5 * DAY);
  assert.equal(await mood(), "HIBERNATING");
  await chain.write(ALICE, usdc, "mint", [vault.address, USDC(30)]);

  const nomBefore = await chain.read<bigint>(nom, "totalSupply");
  await chain.write(OPERATOR, creature, "harvest", [vault.address]);

  // Yield became food and liquid energy; the creature woke itself up.
  assert.notEqual(await mood(), "HIBERNATING");
  const satiety = await chain.read<bigint>(creature, "satiety");
  assert.ok(satiety >= USDC(29) && satiety <= USDC(30), `satiety ${satiety}`);
  const earned = await chain.read<bigint>(creature, "totalYieldEarned");
  assert.ok(earned >= USDC(29) && earned <= USDC(30), `yield ${earned}`);
  assert.equal(await chain.read(nom, "totalSupply"), nomBefore); // yield mints nothing
  assert.equal(await chain.read(creature, "principalOf", [vault.address]), USDC(15)); // intact
});

test("earn() eats revenue: satiety and energy rise, NOM does not", async () => {
  await feedAs(ALICE, USDC(10));
  const nomBefore = await chain.read<bigint>(nom, "totalSupply");

  await chain.write(OPERATOR, usdc, "approve", [creature.address, USDC(25)]);
  await chain.write(OPERATOR, creature, "earn", [USDC(25), "x402"]);

  assert.equal(await chain.read(creature, "satiety"), USDC(35));
  assert.equal(await chain.read(creature, "energy"), USDC(35));
  assert.equal(await chain.read(creature, "totalRevenueEarned"), USDC(25));
  assert.equal(await chain.read(nom, "totalSupply"), nomBefore);

  await expectRevert(chain.write(ALICE, creature, "earn", [USDC(1), "nope"]), "not operator");
});

test("governance: 10 NOM to propose, NOM-weighted votes, one vote each", async () => {
  await feedAs(ALICE, USDC(100));
  await feedAs(BOB, USDC(5)); // below the 10 NOM threshold

  await expectRevert(
    chain.write(BOB, creature, "propose", ["train a pirate"]),
    "propose: need 10 NOM"
  );
  await chain.write(ALICE, creature, "propose", ["scale the reef"]);
  assert.equal(await chain.read(creature, "proposalCount"), 1n);

  await chain.write(ALICE, creature, "vote", [0n, true]);
  await chain.write(BOB, creature, "vote", [0n, false]);
  await expectRevert(chain.write(ALICE, creature, "vote", [0n, true]), "vote: already");

  const p = await chain.read<any[]>(creature, "proposals", [0n]);
  assert.equal(p[3], NOM(100)); // yes
  assert.equal(p[4], NOM(5)); // no

  chain.advance(4 * DAY);
  await expectRevert(chain.write(BOB, creature, "vote", [0n, true]), "vote: closed");
});

test("speak() stores lastWords for the vitals page", async () => {
  await expectRevert(chain.write(ALICE, creature, "speak", ["gm"]), "not operator");
  await chain.write(OPERATOR, creature, "speak", ["i farm, therefore i am fed"]);
  assert.equal(await chain.read(creature, "lastWords"), "i farm, therefore i am fed");
});
