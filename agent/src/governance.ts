/**
 * Letting the votes decide what trains next.
 *
 * The plan counts on community labour — preference labels, character
 * direction, the attention that makes any of this discoverable. That labour is
 * not free if voting does nothing, and until now the rotation was a fixed
 * round-robin that ignored every proposal on-chain. Governance was decoration.
 *
 * The rule is deliberately simple and legible, because a governance mechanism
 * nobody can predict is worse than none: among open proposals that name a
 * character, whichever has the most net support trains next. Everything else
 * falls back to round-robin, so the fleet keeps improving evenly when the room
 * is quiet.
 */
import type { Proposal } from "./chain.js";
import type { Character } from "./characters.js";

export interface Choice {
  character: string;
  reason: string;
  proposalId?: number;
}

/**
 * Which character does this proposal ask for?
 *
 * The SKU id only — "suwa-tide", not "Tide". Matching display names looked
 * friendlier and was wrong: "scale the reef to 32x32", the contract's own
 * example of a world-model proposal, matches the character Reef, so a vote
 * about the ocean would have quietly redirected character training. Requiring
 * the id costs a proposer a few characters and makes the outcome predictable,
 * which is the whole point of a governance rule.
 *
 * A proposal naming several characters is ambiguous and is ignored rather than
 * guessed at.
 */
export function namedCharacter(direction: string, characters: Character[]): string | undefined {
  const text = direction.toLowerCase();
  const hits = characters.filter((c) => text.includes(c.id.toLowerCase()));
  return hits.length === 1 ? hits[0].id : undefined;
}

/**
 * The next character to train. Votes win when the room has spoken; otherwise
 * the rotation carries on.
 */
export function chooseCharacter(
  epoch: number,
  rotation: string[],
  proposals: Proposal[],
  characters: Character[]
): Choice {
  if (rotation.length === 0) throw new Error("no characters to train");

  const fallback = {
    character: rotation[(epoch - 1) % rotation.length],
    reason: "round-robin — no open proposal names a character",
  };

  const candidates = proposals
    .filter((p) => p.open && p.net > 0n)
    .map((p) => ({ p, character: namedCharacter(p.direction, characters) }))
    .filter((c): c is { p: Proposal; character: string } =>
      Boolean(c.character) && rotation.includes(c.character!)
    );

  if (candidates.length === 0) return fallback;

  // Most net support wins; the older proposal breaks a tie, so a late
  // duplicate cannot jump the queue by matching an existing total.
  candidates.sort((a, b) => {
    if (a.p.net === b.p.net) return a.p.id - b.p.id;
    return b.p.net > a.p.net ? 1 : -1;
  });

  const winner = candidates[0];
  return {
    character: winner.character,
    reason: `proposal ${winner.p.id} — ${winner.p.net} NOM net support for "${winner.p.direction}"`,
    proposalId: winner.p.id,
  };
}
