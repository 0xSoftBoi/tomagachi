# Operating plan: turning the creature into a business

*Companion to [`model-economics.md`](model-economics.md), which establishes that the
world model has no buyer. This one answers the follow-up: what would work instead.
Numbers from [`unit_economics.py`](unit_economics.py) and the 2026-08-25 market scan.*

---

## The bet, in one paragraph

The creature stops being a compute incinerator and becomes an inference business with a
game attached. It trains a **fleet of small character models**, serves them itself from
one shared GPU, and is discovered through OpenRouter's routing rather than through a
sales team it cannot afford. The game raises the capital and supplies the attention;
the inference pays the game back. Weights go open on a 90-day lag, so the repo keeps
its promise without donating its revenue to a hosting provider on day one.

**Target: $150–300k/yr gross by month 12, on <$2,500 of at-risk capital, with a kill
decision at week 10.**

## 1. Why this segment and not the obvious one

The obvious move is coding. The data says don't.

| segment (OpenRouter apps, 7 days) | tokens | share | realized $/M | who buys |
|---|---:|---:|---:|---|
| Coding / agents | 29.2T | **72%** | ~$0.08–0.20 | 10 apps = 78% of all volume |
| Uncategorised | 9.2T | 23% | — | — |
| Roleplay / creative | 1.33T | **3.3%** | **$0.31–$3.27** | hundreds of consumer apps |
| Personal agent / chat | 0.78T | 1.9% | — | — |

Coding is 22× the tokens and roughly **one fortieth the revenue per token**. Three
reasons that gap is structural, not a temporary mispricing:

- **The buyer's economics are opposite.** A coding harness is a developer tool
  optimising cost per token; it routes to whatever is cheapest that passes. A
  companion app is a consumer subscription with 70–80% gross margins; it routes to
  whatever keeps users subscribed, and inference is a minority of its COGS. One buyer
  is squeezing you, the other is not.
- **Coding demand is concentrated and negotiated.** Top ten apps are 78% of volume.
  You do not get that traffic by listing a model; you get it by closing Cline, Kilo,
  Cursor. That is enterprise BD, which an anonymous team with $2k cannot run.
- **Coding is a compute war; character is a taste war.** Winning at code means beating
  a frontier model on a verifiable task. Winning at character means being *different* —
  and difference is cheap. That is why the independent tier on OpenRouter is almost
  entirely roleplay tunes: it is the one place small teams beat large ones.

The prize is already proven inside this segment: **`aion-labs/aion-3.0` grosses
$28,470/week — roughly $1.5M/yr — from an OpenRouter listing**, with Janitor AI,
SillyTavern and ISEKAI ZERO as its top buyers. No sales team is visible anywhere in
that number.

### Sizing it honestly

| | |
|---|---|
| **TAM** — all OpenRouter inference | ~$34M/week gross (top 20 models) |
| **SAM** — roleplay/creative apps | 1.33T tokens/wk; at $0.5–1.0/M ≈ **$35–70M/yr** |
| **SOM** — year one, 25–50% of aion's volume at half aion's price | 2–4B tokens/wk ≈ **$150–300k/yr gross** |

## 2. Why one fine-tune fails and five succeed

This is the finding that changes the plan. `thedrummer/cydonia-24b-v4.1` is the
highest-grossing independent fine-tune on the platform. A full week of its traffic is
**27 GPU-hours — 16% of one H100**. It grosses $409 against a $336 machine that bills
for all 168 hours.

**The 84% that sits idle is the entire margin.** Price is not the problem.

| scenario | tokens/wk | GPU util | revenue | COGS/M | contribution | margin |
|---|---:|---:|---:|---:|---:|---:|
| A · match cydonia exactly, dedicated GPU | 1.31B | 16% | $407 | $0.256 | **$71** | 18% |
| B · five tunes that size, one shared GPU | 6.55B | 82% | $2,037 | $0.051 | **$1,701** | 84% |
| C · same fleet, priced as a system ($1.50/M) | 6.55B | 82% | $9,825 | $0.051 | **$9,489** | 97% |
| D · match aion volume, no GPUs, upstream APIs | 8.70B | n/a | $28,475 | $1.200 | $18,035 | 63% |
| E · task specialist, balanced prompt:completion | 1.00B | 42% | $1,200 | $0.336 | $864 | 72% |

Read A→B: **the second product on a shared base is worth more than the first**, because
it is sold out of idle capacity that is already paid for. Read B→C: **repricing is worth
5× what any amount of GPU tuning is worth.** That is the whole strategy in two lines —
a LoRA fleet on one base model, priced as a system rather than as a personality.

Three conditions have to hold:

1. **Fill the GPU.** Break-even is 1.1B tokens/wk (13% utilization). One tune reaches
   16%. Five reach 82%.
2. **Realized price ≥ $0.60/M** — double the community-tune tier, still 5× below aion.
3. **~6.5B tokens/wk arrives without a sales team.** This is the binding constraint and
   the only one money cannot solve.

## 3. The product

Not "a fine-tune." Three layers, only the first of which the community tier ships:

- **Characters** — 8–10 LoRA adapters on one 24B base, each a distinct voice. Cheap
  ($100–400 each in GPU time), fast to iterate, and the reason anyone tries you.
- **The system** — persona and state memory across a long session, the thing every RP
  app hand-rolls badly and the actual reason aion charges $3/M. This is the layer that
  justifies price, and it is software, not weights, so it does not leak when the
  weights are released.
- **The proof** — per-adapter eval scores published on-chain with the weight hash.
  `checkpoint(epoch, sha256, uri, score)` becomes a claim a buyer can verify rather
  than a provenance receipt for something nobody bid on.

**Pricing: $0.60–1.50/M**, entering at the low end and moving up as the memory layer
lands. That is 2–5× the community tier and 50–80% below aion — a deliberately easy
switch for an app already paying aion.

**Weights policy: commercial while fresh, Apache-2.0 at 90 days.** This resolves the
tension in the current README. Releasing on day one hands 100% of revenue to whichever
host picks the weights up — that is exactly how TheDrummer's $409/week becomes
Parasail's $409/week. A 90-day lag keeps the open-model promise and keeps the quarter.

## 4. Go to market: the only zero-CAC channel

An anonymous team has exactly one distribution channel that does not require a
salesperson, and it is the reason this plan is viable at all: **OpenRouter's own
routing.** Apps expose a model picker; users pick; traffic arrives.

Becoming a provider requires an OpenAI-compatible `/chat/completions` with streaming
and usage reporting, an endpoint listing your models, and passing a test-traffic
onboarding. You set your own per-token price. **Payment is by monthly invoice** — see
the structural note below.

The demand-side names are already in the scan: HammerAI, SillyTavern, Janitor AI,
ISEKAI ZERO, StoryNexus, muah.ai, HammerAI, Halluna. These are the accounts that
appear as top consumers across the independent RP tier — they are not prospects to be
sourced, they are apps whose users will find us in a dropdown.

**The game is the marketing budget.** The community tier competes for attention on
Discord and Reddit. "An on-chain creature that eats stablecoins and trains the models
you're using" is a better story than a model card, in a category that runs on stories.
CAC is approximately zero, which is the only CAC this plan can afford.

## 5. What the crypto layer is actually for

Treat it as three real business functions and one real liability.

**Non-dilutive capital.** Feeding is prepaid compute from people who want the thing
built. No equity, no debt, no investor. That is a genuinely good financing instrument
for a $2,500 experiment.

**Distribution and QA.** NOM holders vote on which characters get trained and, more
usefully, generate the eval data. Community preference labelling is the expensive part
of RP tuning, and the game makes it free.

**Machine-payable revenue.** x402 gives a direct pay-per-call endpoint that settles
on-chain, which is the only route where money can return to the contract. It starts
with zero distribution, so it runs *behind* OpenRouter, not instead of it.

**The liability: the treasury cannot be the merchant.** OpenRouter pays providers by
monthly invoice, which needs a legal entity, a bank account and a counterparty who can
be identified. So the shape is: an operating entity is the provider of record and
receives the revenue; the on-chain treasury funds compute and holds the game. Keep NOM
strictly non-revenue-bearing — the moment it carries a claim on those proceeds, the
analysis stops being about margins. **Get actual counsel on the token and on the
entity before any of this touches revenue; nothing here is legal advice.**

**One product decision to make early.** The highest-paying corner of this segment is
uncensored (muah.ai, NoFilterGPT, Spicy Chat all appear in the scan). It also carries
payment-processor, hosting-policy and brand exposure — and it sits badly next to a
cute tamagotchi. Recommendation: **SFW-leaning, sold on character consistency rather
than permissiveness.** It costs some TAM. Make the call deliberately rather than
drifting into it.

## 6. Phases, capital, and the kill decision

| phase | weeks | spend | do | gate to continue |
|---|---|---|---|---|
| **0 · Ship** | 0–3 | ~$400 | 2 adapters, OpenAI-compatible endpoint, provider application | listed on OpenRouter |
| **1 · Prove demand** | 3–10 | ~$1,500 | 5 adapters, published evals, serve from one GPU | **$400/wk gross** — the GPU pays for itself |
| **2 · Reprice** | 10–20 | from revenue | memory layer, fleet to 8–10, move to $0.60–1.00/M | $2,000/wk gross, >50% utilization |
| **3 · Close the loop** | 20+ | from revenue | x402 direct endpoint, 90-day weight releases begin | revenue returning to the contract |

**Kill criterion: if gross is under $400/week ten weeks after listing, the wedge is
wrong.** Stop, publish everything, and the treasury is out less than $2,500. Write
that number down now, before anyone is emotionally invested in the fleet.

## 7. The dashboard

The vitals page currently shows satiety. It should show the P&L, because in this design
they are the same quantity — revenue *is* food.

| metric | why | target |
|---|---|---|
| Realized $/M | the pricing-power number; everything else is downstream | > $0.60 |
| GPU utilization | the margin number | > 50% |
| Tokens/wk routed | the demand number, and the only one we don't control | 6.5B |
| Apps routing to us | concentration risk; each logo is worth a lot | ≥ 5 |
| Weeks of runway | literally satiety, now denominated in weeks not USDC | > 8 |

## 8. What kills this

- **Demand never arrives.** The real risk, and the reason for a 10-week gate. Everything
  else in the plan is arithmetic; this is the only genuine unknown.
- **Aion already owns the premium slot.** They are three products deep and two years
  in. Undercutting at $0.60–1.50/M is the entry, but it is entering an occupied position.
- **The channel is thinner than the segment.** Roleplay is 3.3% of OpenRouter tokens.
  If our share of a $35–70M/yr market stalls at 0.1%, that is $35–70k/yr — a good side
  income, not a company.
- **Frontier models absorb the category.** Cheap frontier models are already the
  default in most RP apps; the independent tier survives on personality and permissive
  policy. If a $0.08/M frontier model becomes good enough at character, the premium
  compresses.
- **The token becomes the story.** If NOM starts trading and the community optimises
  for price rather than product, the operating discipline above evaporates. This has
  killed more crypto-native projects than any market risk.

## 9. What this changes in the repo

Nothing in `contracts/`. Metabolism, NOM, `buyCompute`, hibernation and checkpoints are
agnostic to what gets trained. The changes are:

1. `model/` — swap the RSSM world model for a LoRA fine-tune pipeline on a 24B base.
2. `agent/` — add a serving path: an OpenAI-compatible endpoint with usage reporting,
   plus the x402 route for phase 3.
3. `web/` — vitals page reports the dashboard above alongside satiety.
4. `README.md` — the economics section gains a revenue term, and the weights policy
   states the 90-day lag.
