# Does SUWA-WM make money? No. Here is what does.

*Scan date: 2026-08-25. Raw tables: [`market-2026-08-25.md`](market-2026-08-25.md).
Reproduce: `python3 research/scan_market.py`.*

**Verdict in three lines.**

1. The world model cannot make money, and not because it is bad — because there is
   no place to sell it. OpenRouter bills text tokens; an action-conditioned latent
   world model cannot be listed on it at all. On the Hub, the most-downloaded thing
   called a world model has **669 downloads**.
2. Community fine-tunes are famous and broke. The single highest-earning independent
   fine-tune on OpenRouter grosses **$409/week** — and the money is billed by
   Parasail, who hosts it, not by the person who trained it.
3. The independents who do earn (up to **$28,470/week**) have one thing in common,
   and it is not better weights: **they run their own endpoint and sell a job, not a
   model.**

---

## 1. Where the money actually is

Top 20 models on OpenRouter, one day of traffic (2026-08-24):

| | |
|---|---|
| Tokens/day | 81 trillion |
| Gross billings/day | ~$33.9M (~$12.4B/yr run-rate) |
| Models in the top 20 trained by an independent | **0** |

Every slot is a frontier lab (Anthropic, OpenAI, Google) or a well-capitalised open-weight
lab (DeepSeek, Moonshot, Z.ai, Tencent, Xiaomi, NVIDIA, MiniMax). The single largest
line by volume, `stealth/ox-alpha` at 17.5T tokens/day, is priced at **$0** — somebody
is buying 17.5T tokens/day of evaluation data with free inference. That is the actual
business model at the top of the board, and it is not one we can run.

## 2. The community fine-tune tier: attention without revenue

Seven complete days, every non-lab model on OpenRouter, joined against list price:

| model | $/M in→out | tokens/wk | gross/wk | billed by | trainer paid? |
|---|---|---:|---:|---|---|
| `aion-labs/aion-3.0` | 3.00 → 6.00 | 8.70B | **$28,470** | AionLabs | **yes** |
| `sakana/fugu-ultra` | 5.00 → 30.00 | 1.46B | **$8,131** | Sakana AI | **yes** |
| `aion-labs/aion-3.0-mini` | 0.70 → 1.40 | 2.01B | $1,548 | AionLabs | **yes** |
| `inception/mercury-2` | 0.25 → 0.75 | 2.98B | $982 | Inception | **yes** |
| `nousresearch/hermes-4-405b` | 1.00 → 3.00 | 0.56B | $623 | Nebius | no |
| `thedrummer/cydonia-24b-v4.1` | 0.30 → 0.50 | 1.31B | $409 | Parasail | no |
| `relace/relace-apply-3` | 0.85 → 1.25 | 0.39B | $406 | Relace | **yes** |
| `sao10k/l3-lunaris-8b` | 0.04 → 0.05 | 5.44B | $221 | Parasail, DeepInfra, Novita | no |
| `morph/morph-v3-fast` | 0.80 → 1.20 | 0.12B | $126 | Morph | **yes** |
| `gryphe/mythomax-l2-13b` | 0.06 → 0.06 | 0.66B | $40 | 4 hosts | no |

One rented H100 costs **$336/week** at $2/hr. Read the table against that line.

- **`cydonia-24b-v4.1` — the top independent fine-tune anywhere on the platform —
  grosses $409/wk. It barely out-earns the single GPU it runs on.** And TheDrummer
  does not collect that $409; Parasail does.
- `l3-lunaris-8b` moved **5.44 billion tokens** in a week and produced **$221**.
  Volume without price is not a business.
- Sao10K's own model description on OpenRouter links to a **ko-fi donation page**.
  The most-used independent roleplay fine-tuner on the internet monetises through tips.
  That is the ceiling of the "train a great fine-tune and release it" strategy, stated
  by the person at the top of it.

## 3. Who does earn, and what they sell

Sort the same table by "trainer paid?" and a rule falls out. Every independent earning
real money satisfies all three:

1. **They serve it themselves.** AionLabs, Sakana, Morph, Relace, Inception, Perceptron
   are all their own provider. Publishing weights and letting a host serve them
   converts 100% of revenue into somebody else's revenue.
2. **They sell a job, not a personality.** Morph and Relace sell *apply this diff
   correctly at 10,000 tok/s*. Aion sells *run a multi-model roleplay pipeline*.
   Sakana Fugu sells *orchestrate agents*. None of them are selling "a nice 24B".
3. **They price 5–40× commodity**, because the buyer is comparing against a frontier
   model's bill, not against a cheap open-weight one.

The price ladder, from the same catalog:

| tier | example | $/M out | vs commodity |
|---|---|---:|---:|
| commodity open weights | `mistral-small-3.2-24b` | 0.20 | 1× |
| flavoured fine-tune | `cydonia-24b-v4.1` (a tune of that Mistral) | 0.50 | 2.5× |
| task specialist, self-hosted | `morph-v3-large` | 1.90 | 9.5× |
| orchestrated system | `aion-3.0` | 6.00 | 30× |
| frontier | `claude-opus-5` | 25.00 | 125× |

A fine-tune buys you roughly a 2.5× price premium over the base model you tuned.
Owning the endpoint and defining the job buys you 10–30×.

## 4. Hugging Face is distribution, not revenue

Today's trending page is GGUF quants, MLX ports and uncensored variants of
`Qwen/Qwen3.8-27B`, a base model days old. `unsloth/Qwen3.8-27B-GGUF` has **7.3M
downloads**. Downloads pay **$0**. The Hub is how a model gets *found* by a host who
will then serve it — it is the top of the funnel that ends, for most people, at
Parasail billing the tokens.

## 5. So is the world model a bad idea?

**As a revenue engine, yes — decisively.** Four independent reasons, any one of which
is sufficient:

- **No billing surface exists.** OpenRouter — the entire market this repo could
  plausibly reach — is `text in → text out`, priced per token. SUWA-WM has no
  listable interface there. There is no OpenRouter for latent dynamics models.
- **No demand signal.** Best "world model" on the Hub by downloads: 669, and it is a
  quantisation of somebody's research checkpoint. NVIDIA's *PhysicalAI* world-model
  datasets — professionally produced, heavily promoted — peak at 47K downloads.
  Compare: 7.3M for one week-old Qwen quant.
- **The best competing product is free.** NVIDIA gives away Cosmos weights *and* the
  synthetic datasets. 1X publishes its challenge data. The buyers (robotics, AV) train
  on proprietary data they will not replace with a public model trained on a
  procedural ocean.
- **The compute doesn't reach.** ~5 USDC/day of appetite ≈ 2.5 H100-hours/day ≈ 75
  GPU-hours/month. Enough for a Reef-scale RSSM; three orders of magnitude short of
  anything a robotics team would pay for. Compounding warm-starts is a real advantage
  compounding toward an artifact with no market.

**As the story, it is not a bad idea at all.** "Creature eats stablecoins, buys GPUs,
dreams an ocean, publishes the dream's weights on-chain" is a good game. If the
product is the game, keep it and stop asking it to earn.

The thing to stop believing is that both are true at once. The on-chain checkpoint
hashes prove provenance of something nobody is bidding on.

## 6. The options, priced

| | build cost | realistic revenue | notes |
|---|---|---|---|
| **A. Keep SUWA-WM** | current burn | $0 | Art project. Legitimate — just not a business. |
| **B. Roleplay / companion fine-tune** | LoRA on Mistral Small 24B, ~50–200 GPU-hrs ≈ **$100–400** (1–3 months of feeding) | $0 if released; ~$400/wk gross ≈ GPU cost if self-hosted | Real distribution (HammerAI, SillyTavern, Janitor AI, muah.ai). This is the *marketing* strategy, not the revenue one. |
| **C. Task specialist + own endpoint** ⭐ | fine-tune 8–24B on self-generated traces, ~100–300 GPU-hrs ≈ **$200–600** | $0.85–3.00/M, self-billed; Relace/Morph shape | Correctness is checkable, so quality is *provable* — publish eval score + weights hash on-chain and the claim verifies. |
| **D. Orchestration sold as a model** | ~0 GPUs; COGS is upstream tokens | highest observed ($1.5M/yr run-rate for AionLabs) | But there are no weights to release, which deletes the open-model premise of the repo. |

## 7. Recommendation

**Keep the contract. Replace the payload. Close the loop.**

The tamagotchi mechanics — metabolism, NOM, `buyCompute`, hibernation, checkpoint
hashes — are agnostic to what gets trained. None of that has to change.

What should change is that the creature currently only ever *spends*. Feeding is
described as a contribution, so the design has no revenue term at all; the creature is
a compute incinerator with good manners. Option C closes it:

```
feed → USDC → buyCompute → train → SERVE → earn → feeds itself
```

Concretely:

- **Pick a checkable job in an agent loop.** Apply-a-diff, file selection for a
  codebase query, structured extraction, guard/classify. What makes these work as
  a creature-trained product: the eval is exact-match, so an on-chain
  `checkpoint(epoch, sha256, uri, score)` is a *verifiable performance claim*, not
  just a provenance hash. That is a genuinely better use of the chain than what the
  world model gives it.
- **Serve it from the creature.** x402 pay-per-call is already on the roadmap and
  already spoken by Suwappu — that is the on-chain-native route and the money can
  return to the contract directly.
- **Use OpenRouter for distribution, knowing the catch.** Providers need an
  OpenAI-compatible endpoint with usage reporting, set their own price, and get paid
  **by monthly invoice** — which requires a legal entity and cannot settle to a
  contract. Distribution-rich, but it breaks the on-chain loop; x402 keeps the loop
  and starts with no distribution. Pick deliberately.
- **Keep the Reef as flavour.** The creature can still dream an ocean. It just
  shouldn't be what we tell people it sells.

If the answer is "no, the world model *is* the point" — that is a fine answer. Then
the honest move is to delete the economics section from the README rather than
have it imply a return that the market does not offer.

## 8. Method and caveats

Sources: [OpenRouter model catalog](https://openrouter.ai/api/v1/models),
[rankings](https://openrouter.ai/rankings), per-model usage and provider data from
each model's page, [Hugging Face Hub API](https://huggingface.co/api/models),
[provider onboarding terms](https://openrouter.ai/docs/guides/get-started/for-providers),
H100 street prices ($1.49–$6.98/hr, ~$2 mid-market) from public GPU-cloud comparisons.

- **Gross ≠ net.** Volume × list price. It does not subtract the provider's COGS or
  OpenRouter's cut. Real margins are lower than every number here.
- **OpenRouter is a slice.** First-party API traffic (most of Anthropic's and
  OpenAI's actual revenue) is not in this data. The leaderboard measures OpenRouter,
  not the industry.
- **Snapshots.** Leaderboard is one day; the independent table is seven complete
  days. Weekly figures in the low hundreds of dollars are noisy — but the argument
  turns on order of magnitude ($400/wk vs $28,000/wk), not on precision.
- **"Trainer paid?" is inferred** by matching the model's author against its serving
  provider. It flags who bills the tokens; private revenue-share deals would not show up.
