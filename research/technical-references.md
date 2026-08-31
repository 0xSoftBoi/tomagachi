# Technical references and what they changed here

*Research pass requested when the Consensus tool's quota was out, so this one is web-search-sourced
and independently verified rather than pulled through that connector. Every citation below was
fetched and read (not just returned as a search snippet) before being relied on — two supposedly
relevant items didn't survive that check and are recorded below as what they actually were, since
"the search said so" isn't a citation.*

## What actually changed in the repo because of this pass

1. **`contracts/Tomagachi.sol`** — a vault concentration cap (`maxVaultConcentrationBps`,
   default 60%), enforced in `invest()` once 2+ vaults are whitelisted and the treasury has
   bootstrapped. `agent/src/brain.ts`'s allocator now fills vaults in APY order up to each one's
   headroom instead of dumping everything into whichever vault has the best trailing APY.
2. **`contracts/TomagachiGame.sol`** — a streak-freeze grace charge: missing exactly one day
   spends a banked charge instead of resetting the streak to 1. Charges are earned back every
   7-day streak milestone, capped at 2 held at once.
3. **`agent/src/memory.ts` / `serve.ts`** (a follow-up pass, once the S-LoRA and memory
   directions below were flagged as "informing, not yet implemented" — the memory one turned out
   to be well-scoped enough to just do) — session memory is now categorized (identity /
   preference / note) with independent per-category caps instead of one flat, recency-only list,
   and the composed system message explicitly instructs the model not to contradict or recite the
   memory back. See §4 below for the citation.

All three are covered by new tests (`agent/test/tomagachi.test.ts`, `agent/test/game.test.ts`,
`agent/test/memory.test.ts`) — 23/23 passing — and don't change the shape of anything else: NOM
minting, the metabolism, and the zero-admin/zero-custody posture of the game are untouched.

## 1. DeFi vault curation and concentration risk — directly actionable

The multi-vault treasury (`invest`/`divest`/`harvest`, APY-chasing allocation in `brain.ts`) is,
structurally, exactly what this literature calls a "yield aggregator" allocating across a
"curator layer." Two papers are squarely about the failure mode the old code had — always
sending 100% of new capital to whichever vault had the best trailing APY.

- **Zbandut & Goldstein, "Institutionalizing risk curation in decentralized credit"**
  ([arXiv:2512.11976](https://arxiv.org/abs/2512.11976), Dec 2025). Empirical finding: a small
  cohort of curators intermediates a disproportionate share of system TVL, with **clustered tail
  co-movement** — correlated losses in stress events — and fee margins that vary widely despite
  similar collateral. Their recommendation is standardized, comparable on-chain disclosure so
  depositors can actually compare curator risk. This is the direct citation behind the new
  concentration cap: "best APY wins, unconditionally" is precisely the allocation rule that
  produces curator concentration.
- **"DeFi Yield Aggregators: Analysing Investment Strategies and Structural Dependencies"**
  ([arXiv:2605.23298](https://arxiv.org/abs/2605.23298), May 2026). A year-long empirical
  comparison of two real aggregators (Yearn's USDC vault at 5.41% APY vs. Cian's leveraged stETH
  strategy at 4.22%) found that **strategic complexity does not reliably improve returns and
  materially expands risk exposure** — the simpler strategy outperformed the more sophisticated,
  leveraged one. This is the citation for *not* over-engineering the treasury (no leverage, no
  recursive strategies, no cross-protocol hops) even though it would be easy to bolt on: the
  research says that's a worse trade, not a more sophisticated one.

**Verification note:** both papers are real, dated after this session's earlier turns but before
today (Dec 2025 / May 2026 against an Aug 2026 "now") — a WebFetch summarization pass on a
different, unrelated citation below flagged a March-2026 date as "the future" and concluded the
paper might be fictional. That was the summarizing model's own stale clock, not a real red flag;
today's date is 2026-08-31, so a March 2026 submission is already five months old. Don't repeat
that mistake when re-checking any of these later — check today's actual date before reasoning
about "future" submissions.

## 2. Habit formation and streak design — directly actionable

- **Ferster & Skinner, *Schedules of Reinforcement*** (1957) — foundational, not something that
  needed re-verifying on the web. Variable-ratio reinforcement produces the most persistent
  behavior of any schedule, more resistant to extinction than fixed schedules, because the
  organism can't predict which action pays off. `TomagachiGame.sol`'s streak bonus is a **fixed**
  schedule (deterministic +10%/day) — that's fine for predictability and fairness, but the
  classic finding says a fixed schedule is also the one that extinguishes fastest once the pattern
  is learned. Noted here as a real, considered-and-rejected option: adding true variable rewards
  on-chain would need a secure randomness source (Chainlink VRF or similar), and gambling on-chain
  "unpredictability" without one is exploitable via simulate-then-only-broadcast-if-profitable
  front-running. Not worth the attack surface for XP that has no monetary value — skipped
  deliberately, not by oversight.
- **Duolingo's own blog**, verified directly (not through a secondary SEO summary):
  ["How Streaks keep Duolingo learners committed"](https://blog.duolingo.com/how-streaks-keep-duolingo-learners-committed-to-their-language-goals/) —
  nearly 8 million learners hold a 365+ day streak, over 6 million hold a 7+ day streak, and
  streaks are one of the most-shared, most-defended features in the product. This is solid
  primary-source evidence that streak mechanics work at scale. What's **not** in that post, and
  what several secondary blogs (trophy.so, apptitude.io, digia.tech) attributed to it without a
  traceable primary source, are specific numbers like "21% churn reduction" or "47% higher
  retention from Deloitte's 2024 Digital Banking Report" — repeated across marketing blogs with no
  link back to an actual report. Those numbers are **not used** anywhere in this repo or its docs;
  treat them as unverified if you see them cited elsewhere. The directionally-real, useful idea —
  Duolingo's own streak-freeze consumable, which exists specifically because a bare streak counter
  is fragile (one bad day erases weeks of investment) — is what motivated the grace-charge
  mechanic, sourced as a described product mechanic rather than a specific disputed statistic.

## 3. Multi-LoRA serving — informs, not yet implemented

- **Sheng et al., "S-LoRA: Serving Thousands of Concurrent LoRA Adapters"**
  ([arXiv:2311.03285](https://arxiv.org/abs/2311.03285), MLSys 2024 — verified, well-established).
  Unified Paging (one memory pool for adapter weights *and* KV cache) plus custom batching kernels
  serve **thousands of adapters on one GPU** with **up to 4x the throughput** of naive vLLM/PEFT
  multi-LoRA and orders-of-magnitude more concurrent adapters. This is the real ceiling behind
  `research/operating-plan.md`'s "five characters, one shared GPU, 82% utilization" claim — the
  current SUWA-LM fleet (5-10 adapters) is nowhere near what a properly-optimized multi-LoRA
  server can hold, meaning the fleet can grow substantially before hitting a serving bottleneck.
  **Not implemented in this pass**: `deploy/vllm/` already uses vLLM's own multi-LoRA support,
  and whether it needs S-LoRA-specific techniques on top depends on measuring actual GPU
  utilization against the unit-economics model first (`research/unit_economics.py`) — worth a
  follow-up research task, not a blind swap.

## 4. Persona memory in long roleplay sessions — implemented in the follow-up pass

- **Wang, You, Zhang & Wang, "Memory-Driven Role-Playing: Evaluation and Enhancement of Persona
  Knowledge Utilization in LLMs"** ([arXiv:2603.19313](https://arxiv.org/abs/2603.19313), March
  2026 — independently verified real, despite the false-alarm noted above). Frames persona
  knowledge as something a model must *retrieve and apply* from memory rather than lean on
  explicit reminders, with a four-part evaluation (Anchoring, Recalling, Bounding, Enacting) and a
  prompting method (MRPrompt) that let a smaller model (Qwen3-8B) match much larger models'
  persona fidelity — directly relevant to unit economics (persona quality without needing a
  bigger, more expensive base model).

  Originally flagged here as "not yet implemented — a genuine architecture change, not a small
  tweak." On revisiting, the well-scoped slice of it (structured categorization + an explicit
  non-leak instruction) turned out to be a bounded, independently testable change after all,
  distinct from the bigger, riskier slice (an actual summarizer model call, which is still not
  done — see below). What shipped:

  - `agent/src/memory.ts`: facts are now tagged `identity` / `preference` / `note` at extraction
    time, each with its own retention cap, so a long run of "I like X" turns can no longer evict
    the name/occupation facts that anchor who the model is talking to (the paper's *Anchoring*).
  - A new `formatMemoryForPrompt` builds the injected system message with per-category framing
    ("Who they are" / "Their tastes" / "They specifically asked you to remember") and an explicit
    instruction not to contradict the memory or recite it back — operationalizing *Bounding*
    (stay consistent, don't leak the mechanism) and *Enacting* (use it as lived knowledge, not a
    checklist) rather than trusting the model to infer both from a flat fact list.
  - An old-shape `sessions.json` (plain string facts, pre-categorization) migrates into the `note`
    bucket on load instead of throwing — a real deployment could have live session data before a
    redeploy, and a crash on read is worse than a mis-bucketed fact.

  **Still not done, and still the bigger lift**: replacing pattern-extraction with an actual
  summarizer call (the paper's *Recalling* as a learned retrieval rather than regex matching) is
  the "Phase 2" already named in `memory.ts`'s header — that needs a model call in the hot path
  and its own latency/cost budget, not a prompt-shape change.

## 5. World models — informs the "dream," no action taken

- **Alles, Zhang, van der Smagt & Becker-Ehmck, "Latent Action World Models for Control with
  Unlabeled Trajectories"** ([arXiv:2512.10016](https://arxiv.org/abs/2512.10016), Dec 2025 —
  verified real). A shared latent-action representation lets one dynamics model train on mostly
  action-free video plus a small action-labeled set, cutting labeled-trajectory requirements by
  roughly an order of magnitude on DeepMind Control Suite benchmarks. If SUWA-WM (the Reef world
  model) ever gets funded past the "dream" stage per `research/operating-plan.md`'s phase gates,
  this is a real, current way to make it far cheaper: the Reef's action-free exploration footage
  could do most of the work, with only a small amount of actually-labeled interaction data needed.
  No code changed here — this is exactly the kind of result worth having on file for when/if the
  shop earns enough to fund phase 3.

## Rejected direction

**On-chain pseudo-randomness for variable-ratio XP bonuses.** The Skinner citation above is a real
argument for it, and it would make the game meaningfully "stickier." Rejected anyway: any source
of on-chain randomness cheap enough to fit a zero-admin contract (block hash, timestamp, a simple
PRNG) can be gamed by simulating the outcome before broadcasting and only submitting the
profitable roll — trivial with a private mempool or even just local simulation against a public
RPC. A real fix needs an oracle (Chainlink VRF or equivalent), which is a dependency and a cost
this project doesn't currently carry. If the game ever wants true variable rewards, that's the
prerequisite, not a shortcut around it.
