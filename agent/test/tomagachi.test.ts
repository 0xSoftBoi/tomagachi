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

// ------------------------------------------------------------------------
// Starvation boundary
// ------------------------------------------------------------------------

test("starvation boundary: hibernates exactly at zero, resumes on a re-feed smaller than a day's decay, and re-hibernates when that decays away", async () => {
  await feedAs(ALICE, USDC(10)); // exactly 2 days of runway at 5 USDC/day

  chain.advance(2 * DAY);
  assert.equal(await chain.read(creature, "satiety"), 0n); // crosses to exactly zero
  assert.equal(await mood(), "HIBERNATING");
  await expectRevert(
    chain.write(OPERATOR, creature, "buyCompute", [PROVIDER, USDC(1), "gpu", "job-1"]),
    "hibernating: feed me"
  );

  // Re-feed with less than one day's metabolism (5 USDC/day) — still wakes it.
  await feedAs(BOB, USDC(1));
  assert.equal(await chain.read(creature, "satiety"), USDC(1));
  assert.notEqual(await mood(), "HIBERNATING");

  // Awake again: buyCompute now succeeds.
  await chain.write(OPERATOR, creature, "buyCompute", [PROVIDER, USDC(1), "gpu", "job-2"]);
  assert.equal(await chain.read(creature, "energy"), USDC(10)); // 11 fed - 1 spent

  // That 1 USDC of appetite decays away in well under a day at 5 USDC/day.
  chain.advance(DAY);
  assert.equal(await chain.read(creature, "satiety"), 0n);
  assert.equal(await mood(), "HIBERNATING");
  await expectRevert(
    chain.write(OPERATOR, creature, "buyCompute", [PROVIDER, USDC(1), "gpu", "job-3"]),
    "hibernating: feed me"
  );
});

// ------------------------------------------------------------------------
// Treasury: vault whitelisting and a malicious/reverting vault
// ------------------------------------------------------------------------

test("allowVault rejects a vault whose underlying asset is not the creature's stable", async () => {
  const otherToken = await chain.deploy("MockUSDC"); // stands in for a foreign asset
  const wrongVault = await chain.deploy("MockVault4626", [otherToken.address]);
  await expectRevert(
    chain.write(OWNER, creature, "allowVault", [wrongVault.address, true]),
    "vault: wrong asset"
  );
  assert.equal(await chain.read(creature, "allowedVault", [wrongVault.address]), false);
});

test("delisting a vault blocks new invests but existing principal stays divestable and harvestable", async () => {
  await feedAs(ALICE, USDC(100));
  await chain.write(OWNER, creature, "allowVault", [vault.address, true]);
  await chain.write(OPERATOR, creature, "invest", [vault.address, USDC(50)]);

  await chain.write(OWNER, creature, "allowVault", [vault.address, false]);
  assert.equal(await chain.read(creature, "allowedVault", [vault.address]), false);
  await expectRevert(
    chain.write(OPERATOR, creature, "invest", [vault.address, USDC(1)]),
    "invest: vault not allowed"
  );

  // Existing position is still fully manageable: divest and harvest both work.
  await chain.write(OPERATOR, creature, "divest", [vault.address, USDC(20)]);
  assert.equal(await chain.read(creature, "principalOf", [vault.address]), USDC(30));

  await chain.write(ALICE, usdc, "mint", [vault.address, USDC(10)]); // simulated yield
  await chain.write(OPERATOR, creature, "harvest", [vault.address]);
  assert.equal(await chain.read(creature, "totalYieldEarned"), USDC(10));
});

test("a vault that reverts on withdraw degrades gracefully: it bricks only its own divest/harvest, not the treasury", async () => {
  const badVault = await chain.deploy("MaliciousVault4626", [usdc.address]);
  await feedAs(ALICE, USDC(200));
  await chain.write(OWNER, creature, "allowVault", [vault.address, true]);
  await chain.write(OWNER, creature, "allowVault", [badVault.address, true]);
  await chain.write(OPERATOR, creature, "invest", [vault.address, USDC(50)]);
  await chain.write(OPERATOR, creature, "invest", [badVault.address, USDC(50)]);

  // Fund yield on the bad vault, then have it turn hostile.
  await chain.write(ALICE, usdc, "mint", [badVault.address, USDC(20)]);
  await chain.write(ALICE, badVault, "setBroken", [true]);

  const yieldBefore = await chain.read<bigint>(creature, "totalYieldEarned");
  await expectRevert(chain.write(OPERATOR, creature, "harvest", [badVault.address]), "vault: broken");
  await expectRevert(
    chain.write(OPERATOR, creature, "divest", [badVault.address, USDC(10)]),
    "vault: broken"
  );
  // The failed calls left no trace: reverts are atomic.
  assert.equal(await chain.read(creature, "totalYieldEarned"), yieldBefore);
  assert.equal(await chain.read(creature, "principalOf", [badVault.address]), USDC(50));

  // The rest of the treasury is unaffected — the good vault still works fine.
  await chain.write(OPERATOR, creature, "divest", [vault.address, USDC(10)]);
  assert.equal(await chain.read(creature, "principalOf", [vault.address]), USDC(40));
  await chain.write(ALICE, usdc, "mint", [vault.address, USDC(5)]);
  await chain.write(OPERATOR, creature, "harvest", [vault.address]);
  assert.equal(await chain.read(creature, "totalYieldEarned"), USDC(5));
});

// ------------------------------------------------------------------------
// earn() edge cases
// ------------------------------------------------------------------------

test("earn() rejects a zero amount, and repeated settlements never mint NOM no matter the amount", async () => {
  await chain.write(OPERATOR, usdc, "approve", [creature.address, USDC(1000)]);
  await expectRevert(chain.write(OPERATOR, creature, "earn", [0n, "x402"]), "earn: zero");

  const nomBefore = await chain.read<bigint>(nom, "totalSupply");
  // A "replayed" settlement (same source, submitted twice) is just two earns:
  // the contract has no payment-id dedup, so both apply — dedup against
  // double-crediting the same off-chain settlement is the caller's job.
  await chain.write(OPERATOR, creature, "earn", [USDC(7), "x402"]);
  await chain.write(OPERATOR, creature, "earn", [USDC(7), "x402"]);
  assert.equal(await chain.read(creature, "totalRevenueEarned"), USDC(14));
  assert.equal(await chain.read(creature, "satiety"), USDC(14));
  assert.equal(await chain.read(nom, "totalSupply"), nomBefore); // still zero minted
});

// ------------------------------------------------------------------------
// Governance edge cases
// ------------------------------------------------------------------------

test("vote() rejects an address holding no NOM", async () => {
  await feedAs(ALICE, USDC(100));
  await chain.write(ALICE, creature, "propose", ["scale the reef"]);
  await expectRevert(chain.write(BOB, creature, "vote", [0n, true]), "vote: no NOM");
});

test("governance weight is read live, not snapshotted: transferring NOM after voting lets the same tokens vote again", async () => {
  // Alice feeds once (100 NOM), votes yes, then hands the same NOM to Bob who
  // votes yes too — 200 NOM of "yes" backed by only 100 NOM of contribution.
  // This documents that vote() has no per-proposal balance snapshot; a
  // real fix would need checkpointed voting weight (e.g. ERC20Votes-style).
  await feedAs(ALICE, USDC(100));
  await chain.write(ALICE, creature, "propose", ["scale the reef"]);

  await chain.write(ALICE, creature, "vote", [0n, true]);
  await chain.write(ALICE, nom, "transfer", [BOB, NOM(100)]);
  await chain.write(BOB, creature, "vote", [0n, true]);

  const p = await chain.read<any[]>(creature, "proposals", [0n]);
  assert.equal(p[3], NOM(200)); // double-counted from one contribution
});

// ------------------------------------------------------------------------
// Checkpoints
// ------------------------------------------------------------------------

test("checkpoint(): operator-only, and re-posting an already-recorded epoch is not rejected", async () => {
  await expectRevert(
    chain.write(ALICE, creature, "checkpoint", [1n, `0x${"11".repeat(32)}`, "run://1", 500n, USDC(1)]),
    "not operator"
  );

  await chain.write(OPERATOR, creature, "checkpoint", [1n, `0x${"11".repeat(32)}`, "run://1", 500n, USDC(1)]);
  assert.equal(await chain.read(creature, "checkpointCount"), 1n);
  const cp = await chain.read<any>(creature, "latestCheckpoint");
  assert.equal(cp.epoch, 1n);
  assert.equal(cp.lossMilli, 500n);

  // Replaying epoch 1 (e.g. a retried tx, or an operator mistake) is
  // currently accepted rather than rejected — there is no epoch-uniqueness
  // guard. Documented here since it means the checkpoint history is not
  // tamper-evident against reordering/duplication by the (trusted) operator.
  await chain.write(OPERATOR, creature, "checkpoint", [1n, `0x${"22".repeat(32)}`, "run://1-again", 400n, USDC(1)]);
  assert.equal(await chain.read(creature, "checkpointCount"), 2n);
});
