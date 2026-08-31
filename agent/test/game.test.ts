/**
 * Behavior tests for TomagachiGame — the care layer.
 *
 * Same in-process EVM harness as tomagachi.test.ts: arbitrary callers and a
 * fake clock, which is everything a tamagotchi game needs (cooldowns, daily
 * streaks, happiness decay, starving the creature on schedule).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { TestChain, expectRevert, artifact, type Deployed } from "./evm.js";

const OWNER = "0x1000000000000000000000000000000000000001";
const OPERATOR = "0x2000000000000000000000000000000000000002";
const ALICE = "0x3000000000000000000000000000000000000003";
const BOB = "0x4000000000000000000000000000000000000004";

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const DAY = 86_400;
const HOUR = 3_600;

const BADGE_FIRST_TOUCH = 1 << 0;
const BADGE_CLUTCH = 1 << 1;
const BADGE_REVIVER = 1 << 2;
const BADGE_WEEK_STREAK = 1 << 3;

let chain: TestChain;
let usdc: Deployed;
let creature: Deployed;
let game: Deployed;
let nom: Deployed;

const MOODS = ["EGG", "HAPPY", "PECKISH", "STARVING", "HIBERNATING"] as const;
const mood = async () => MOODS[Number(await chain.read<bigint>(creature, "mood"))];

/** playerState tuple: [xp, streakDays, careActions, badges, fedViaGame, ...cooldowns] */
const player = (who: string) => chain.read<bigint[]>(game, "playerState", [who]);

async function gameFeedAs(who: string, amount: bigint): Promise<void> {
  await chain.write(who, usdc, "approve", [game.address, amount]);
  await chain.write(who, game, "gameFeed", [amount]);
}

beforeEach(async () => {
  chain = await TestChain.create();
  usdc = await chain.deploy("MockUSDC");
  creature = await chain.deploy("Tomagachi", [
    usdc.address, OWNER, OPERATOR, "Suwa", USDC(5), USDC(500),
  ]);
  game = await chain.deploy("TomagachiGame", [creature.address]);
  nom = { address: await chain.read<`0x${string}`>(creature, "nom"), abi: artifact("NomToken").abi };
  for (const who of [ALICE, BOB]) await chain.write(who, usdc, "mint", [who, USDC(2_000)]);
});

test("an egg cannot be petted; care actions earn XP, happiness, and cooldowns", async () => {
  await expectRevert(chain.write(ALICE, game, "pet"), "game: still an egg");

  await gameFeedAs(ALICE, USDC(150)); // hatches it through the game — 30% satiety
  assert.equal(await mood(), "PECKISH");

  await chain.write(ALICE, game, "pet");
  let [xp, streak, actions, badges] = await player(ALICE);
  // gameFeed at 1x: 150 USDC * 10 XP = 1500; pet: 5 * 110% (streak day 1) = 5
  assert.equal(xp, 1505n);
  assert.equal(streak, 1);
  assert.equal(actions, 1);
  assert.equal(BigInt(badges) & BigInt(BADGE_FIRST_TOUCH), BigInt(BADGE_FIRST_TOUCH));

  await expectRevert(chain.write(ALICE, game, "pet"), "game: pet cooldown");
  chain.advance(4 * HOUR);
  await chain.write(ALICE, game, "pet"); // same day: streak stays 1
  [xp, streak] = await player(ALICE);
  assert.equal(xp, 1510n);
  assert.equal(streak, 1);

  // play and groom run their own cooldowns
  await chain.write(ALICE, game, "play");
  await chain.write(ALICE, game, "groom");
  await expectRevert(chain.write(ALICE, game, "play"), "game: play cooldown");
  await expectRevert(chain.write(ALICE, game, "groom"), "game: groom cooldown");

  assert.ok((await chain.read<bigint>(game, "happiness")) > 0n);
});

test("happiness decays with neglect, whatever the satiety", async () => {
  await gameFeedAs(ALICE, USDC(400)); // very well fed
  await chain.write(ALICE, game, "play");
  await chain.write(ALICE, game, "pet");
  const before = await chain.read<bigint>(game, "happiness");
  assert.ok(before >= 20n, `happiness ${before}`);

  chain.advance(3 * DAY); // -10/day
  const after = await chain.read<bigint>(game, "happiness");
  assert.equal(after, before - 30n < 0n ? 0n : before - 30n);
  assert.equal(await mood(), "HAPPY"); // still fed — loved and fed are different
});

test("mood gates: no playing with a hibernating creature, but petting it pays double", async () => {
  await gameFeedAs(ALICE, USDC(10)); // 2 days of life
  chain.advance(3 * DAY);
  assert.equal(await mood(), "HIBERNATING");

  await expectRevert(chain.write(ALICE, game, "play"), "game: it is hibernating");

  const [xpBefore] = await player(ALICE);
  await chain.write(ALICE, game, "pet"); // keeping it company: 2x5 * 110% = 11
  const [xpAfter] = await player(ALICE);
  assert.equal(xpAfter - xpBefore, 11n);
});

test("daily streaks: consecutive days climb, a missed day resets", async () => {
  await gameFeedAs(ALICE, USDC(400));

  await chain.write(ALICE, game, "groom");
  chain.advance(DAY);
  await chain.write(ALICE, game, "groom");
  chain.advance(DAY);
  await chain.write(ALICE, game, "groom");
  let [, streak] = await player(ALICE);
  assert.equal(streak, 3);

  chain.advance(3 * DAY); // gap
  await chain.write(ALICE, game, "groom");
  [, streak] = await player(ALICE);
  assert.equal(streak, 1);

  // a 7-day streak earns the badge (and +170% XP by day 7)
  for (let i = 0; i < 6; i++) {
    chain.advance(DAY);
    await chain.write(ALICE, game, "groom");
  }
  const [, streak2, , badges] = await player(ALICE);
  assert.equal(streak2, 7);
  assert.equal(BigInt(badges) & BigInt(BADGE_WEEK_STREAK), BigInt(BADGE_WEEK_STREAK));
});

test("streak freeze: a banked grace charge survives one missed day, but not two", async () => {
  await gameFeedAs(ALICE, USDC(400));

  // Build a 7-day streak — day 7 both earns the Week Streak badge and banks
  // a grace charge (streakDays % 7 == 0).
  await chain.write(ALICE, game, "groom");
  for (let i = 0; i < 6; i++) {
    chain.advance(DAY);
    await chain.write(ALICE, game, "groom");
  }
  let [, streak, , , , , , , grace] = await player(ALICE);
  assert.equal(streak, 7);
  assert.equal(grace, 1);

  // Miss exactly one day (a 2-day gap): the grace charge is spent instead of
  // resetting the streak, and it keeps climbing rather than restarting at 1.
  chain.advance(2 * DAY);
  await chain.write(ALICE, game, "groom");
  [, streak, , , , , , , grace] = await player(ALICE);
  assert.equal(streak, 8);
  assert.equal(grace, 0);

  // No grace left: the next 2-day gap really does reset the streak.
  chain.advance(2 * DAY);
  await chain.write(ALICE, game, "groom");
  [, streak] = await player(ALICE);
  assert.equal(streak, 1);
});

test("feeding through the game: mood multipliers, badges, and NOM still mints 1:1", async () => {
  await gameFeedAs(ALICE, USDC(50)); // EGG => 1x: 500 XP
  let [xp] = await player(ALICE);
  assert.equal(xp, 500n);
  assert.equal(await chain.read(nom, "balanceOf", [ALICE]), 50n * 10n ** 18n);

  chain.advance(9 * DAY); // 50 - 45 = 5 USDC satiety = 1% => STARVING
  assert.equal(await mood(), "STARVING");
  await gameFeedAs(BOB, USDC(10)); // clutch: 10 * 10 * 3 = 300 XP
  let [bobXp, , , bobBadges] = await player(BOB);
  assert.equal(bobXp, 300n);
  assert.equal(BigInt(bobBadges) & BigInt(BADGE_CLUTCH), BigInt(BADGE_CLUTCH));

  chain.advance(4 * DAY); // burn through it => HIBERNATING
  assert.equal(await mood(), "HIBERNATING");
  await gameFeedAs(BOB, USDC(10)); // revival: 10 * 10 * 5 = 500 XP
  [bobXp, , , bobBadges] = await player(BOB);
  assert.equal(bobXp, 800n);
  assert.equal(BigInt(bobBadges) & BigInt(BADGE_REVIVER), BigInt(BADGE_REVIVER));
  assert.notEqual(await mood(), "HIBERNATING"); // the feed woke it
});

test("claimFeedXp credits direct feeds once and never double-counts gameFeed", async () => {
  await gameFeedAs(ALICE, USDC(50));
  await expectRevert(chain.write(ALICE, game, "claimFeedXp"), "game: nothing to claim");

  // a direct feed, outside the game
  await chain.write(BOB, usdc, "approve", [creature.address, USDC(30)]);
  await chain.write(BOB, creature, "feed", [USDC(30)]);
  await chain.write(BOB, game, "claimFeedXp");
  const [bobXp] = await player(BOB);
  assert.equal(bobXp, 300n); // 30 USDC * 10 XP at 1x

  await expectRevert(chain.write(BOB, game, "claimFeedXp"), "game: nothing to claim");
});

test("everyone's XP accrues to the creature: quadratic levels, one gameState read", async () => {
  assert.equal(await chain.read(game, "xpForLevel", [1]), 500n);
  assert.equal(await chain.read(game, "xpForLevel", [3]), 4_500n);

  await gameFeedAs(ALICE, USDC(150)); // PECKISH after: 1500 XP => level 1
  assert.equal(await chain.read(game, "level"), 1);

  await gameFeedAs(BOB, USDC(60)); // fed at PECKISH (1x): total 2100 => level 2
  assert.equal(await chain.read(game, "level"), 2);

  const [h, lvl, xpTotal, xpNext, nPlayers] = await chain.read<bigint[]>(game, "gameState");
  assert.ok(h > 0n);
  assert.equal(lvl, 2);
  assert.equal(xpTotal, 2_100n);
  assert.equal(xpNext, 4_500n);
  assert.equal(nPlayers, 2n);
  assert.equal(await chain.read(game, "playerCount"), 2n);
});
