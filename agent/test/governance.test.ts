/**
 * Votes choosing what trains next.
 *
 * The rule has to be legible: a governance mechanism nobody can predict is
 * worse than none, because then the labour it was meant to buy stops arriving.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.STATE_DIR = process.env.STATE_DIR ?? "/tmp/suwa-gov-test";

const { chooseCharacter, namedCharacter } = await import("../src/governance.js");
const { catalog } = await import("../src/characters.js");

const characters = catalog().characters;
const rotation = characters.map((c) => c.id);
const OPEN = Math.floor(Date.now() / 1000) + 86_400;
const CLOSED = Math.floor(Date.now() / 1000) - 86_400;

const proposal = (o: Partial<any> & { id: number; direction: string; net: bigint }) => ({
  proposer: "0x1",
  deadline: OPEN,
  yes: o.net > 0n ? o.net : 0n,
  no: 0n,
  open: o.deadline ? o.deadline > Math.floor(Date.now() / 1000) : true,
  ...o,
});

test("a proposal naming a character by id is understood", () => {
  assert.equal(namedCharacter("more epochs for suwa-abyss please", characters), "suwa-abyss");
});

test("a display name alone is not enough — the id is required", () => {
  assert.equal(namedCharacter("train Tide harder", characters), undefined,
    "friendlier matching is what let a world-model proposal steer a character");
});

test("a proposal about the reef does not train the character Reef", () => {
  // The contract's own example of a governance proposal. Matching display
  // names made this select suwa-reef, which is not remotely what it asks for.
  assert.equal(namedCharacter("scale the reef to 32x32", characters), undefined);
});

test("a proposal naming two characters is ambiguous, not a guess", () => {
  assert.equal(namedCharacter("suwa-tide and suwa-abyss together", characters), undefined);
});

test("the winning proposal decides the epoch", () => {
  const choice = chooseCharacter(1, rotation, [
    proposal({ id: 1, direction: "more suwa-abyss", net: 50n }),
    proposal({ id: 2, direction: "more suwa-reef", net: 10n }),
  ] as any, characters);
  assert.equal(choice.character, "suwa-abyss");
  assert.equal(choice.proposalId, 1);
  assert.match(choice.reason, /50 NOM/);
});

test("a quiet room falls back to round-robin", () => {
  const first = chooseCharacter(1, rotation, [], characters);
  const second = chooseCharacter(2, rotation, [], characters);
  assert.equal(first.character, rotation[0]);
  assert.equal(second.character, rotation[1]);
  assert.match(first.reason, /round-robin/);
});

test("a closed proposal no longer steers anything", () => {
  const choice = chooseCharacter(1, rotation, [
    { id: 1, proposer: "0x1", direction: "more suwa-abyss", deadline: CLOSED, yes: 90n, no: 0n, net: 90n, open: false },
  ] as any, characters);
  assert.match(choice.reason, /round-robin/, "voting closed means the decision is spent");
});

test("a proposal the room voted down does not win", () => {
  const choice = chooseCharacter(1, rotation, [
    { id: 1, proposer: "0x1", direction: "more suwa-abyss", deadline: OPEN, yes: 5n, no: 40n, net: -35n, open: true },
  ] as any, characters);
  assert.match(choice.reason, /round-robin/, "net support means net");
});

test("a proposal for something that is not a character is ignored", () => {
  const choice = chooseCharacter(1, rotation, [
    proposal({ id: 1, direction: "scale the reef to 32x32", net: 100n }),
  ] as any, characters);
  assert.match(choice.reason, /round-robin/);
});

test("ties go to the older proposal", () => {
  const choice = chooseCharacter(1, rotation, [
    proposal({ id: 7, direction: "more suwa-drift", net: 20n }),
    proposal({ id: 3, direction: "more suwa-reef", net: 20n }),
  ] as any, characters);
  assert.equal(choice.proposalId, 3, "a late duplicate must not jump the queue by matching a total");
});

test("a proposal for a character outside the configured rotation is ignored", () => {
  const choice = chooseCharacter(1, ["suwa-tide"], [
    proposal({ id: 1, direction: "more suwa-abyss", net: 99n }),
  ] as any, characters);
  assert.equal(choice.character, "suwa-tide");
});
