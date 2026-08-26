# Suwappu Tomagachi

> An on-chain creature that eats stablecoins, buys compute, trains **character
> models**, and sells them back to the world to feed itself.

Built on [Suwappu](https://suwappu.bot) — the cross-chain DeFi API for AI
agents. The creature lives as a contract on **Base**; its brain is an
autonomous agent that turns every token you feed it into training compute.

```
        you                     the creature                the community
   ┌───────────┐   feed USDC   ┌────────────────┐  hash +  ┌──────────────┐
   │ any wallet ├──────────────► Tomagachi.sol  ├──────────► SUWA-LM       │
   └─────┬─────┘   mints NOM   │  (Base)        │  score    │ 5 characters │
         │                     │ satiety/energy │  on-chain │ Apache-2.0   │
   any token                   └──────┬─────────┘           │ after 90 days│
         │                            │ buyCompute          └──────┬───────┘
   ┌─────▼──────────┐          ┌──────▼─────────┐                  │ adapters
   │ brain (agent/) │ suwappu  │ GPU providers  │           ┌──────▼───────┐
   │ swaps → USDC   ├──────────► local / remote │           │ the shop     │
   └────────────────┘  API     └────────────────┘           │ /v1/chat/... │
              ▲                                             └──────┬───────┘
              │                  revenue — the creature feeds itself│
              └──────────────────────────────────────────────────────┘
```

## The game

- **Feed it.** Approve USDC and call `feed(amount)` on the contract, or send
  *any* Base token to the brain wallet — it swaps to USDC through Suwappu's
  self-custody swap path and feeds itself. Every USDC fed mints **1 NOM**.
- **Keep it alive.** Satiety decays ~5 USDC of appetite per day (virtual — no
  funds are burned). Starve it and it **hibernates**: `buyCompute` reverts and
  training stops until someone feeds it again. Neglect has consequences;
  that's the tamagotchi contract.
- **It works for its food.** 100% of fed USDC is compute budget. The brain
  buys GPU time with `buyCompute(to, amount, provider, jobRef)` — every cent
  leaving the creature is an on-chain, auditable record.
- **It earns.** What it trains, it sells: the shop (`agent/src/serve.ts`) is an
  OpenAI-compatible endpoint any app can call, priced per character. Revenue is
  food, so a creature with customers stops starving.
- **It learns in public.** Each training epoch ends with
  `checkpoint(epoch, sha256, uri, loss, spent)` on-chain. Anyone can
  `sha256sum` the released weights against the chain.
- **You steer it.** NOM holders `propose()` and `vote()` on training
  directions — bigger worlds, new dynamics, scaling runs.

## The models — SUWA-LM, and the dream

**SUWA-LM** is the product: one frozen base with a small LoRA adapter per
character, five of them sharing a single GPU. Each release carries a
reproducible eval score alongside its hash, so the on-chain checkpoint is a
performance claim a buyer can re-derive rather than a receipt. Weights go
Apache-2.0 on a 90-day lag.

**SUWA-WM** is the dream the creature still has: an action-conditioned latent
world model of the Reef, a procedural ocean. It is kept because it is what the
creature is *for* — not because anyone will pay for it. Why that distinction
matters, with the market data behind it, is in
[`research/`](research/model-economics.md). See [`model/`](model/) for both.

## Repo layout

| path | what |
|---|---|
| [`contracts/Tomagachi.sol`](contracts/Tomagachi.sol) | the creature + NOM token (self-contained, no deps) |
| [`agent/`](agent/) | the brain: Suwappu swaps, compute brokerage, on-chain ops |
| [`agent/src/serve.ts`](agent/src/serve.ts) | the shop: OpenAI-compatible endpoint, pricing, usage ledger |
| [`model/`](model/) | SUWA-LM character adapters, SUWA-WM world model |
| [`web/`](web/) | live vitals page: satiety from Base, P&L from the shop |
| [`deploy/`](deploy/) | vLLM config, preflight tests, the listing checklist |
| [`research/`](research/) | market scans, unit economics, the operating plan |

## Go live

```bash
# 1. contracts — compile (solc-js, no Foundry needed) and deploy to Base
cd agent && npm install
npm run compile
DEPLOYER_KEY=0x... npm run deploy          # writes agent/deployment.json

# 2. brain — feed it env vars and let it run
cp .env.example .env                       # fill in OPERATOR_KEY etc.
pip install -r ../model/requirements.txt   # trainer deps (torch, numpy)
OPERATOR_KEY=0x... npm start

# 3. shop — the endpoint that sells what it trains
UPSTREAM_BASE_URL=http://localhost:8000/v1 npm run serve   # any vLLM-style host
curl localhost:8080/v1/models                              # five characters
curl localhost:8080/metrics                                # realized $/M, GPU util, apps

# 4. face — host web/ anywhere static, with deployment.json alongside
cp deployment.json ../web/ && npx serve ../web
#    add ?shop=https://your-endpoint to show the P&L next to satiety
```

`npm start` runs the brain and the shop together; `SERVE=0` runs the brain
alone, for when the GPU box serves and shouldn't hold the operator key.

The brain self-registers with the Suwappu Agent API on first boot
(`POST /register`) and persists its key in `agent/state/state.json`
(gitignored). Bootstrap mode trains locally for free; point
`COMPUTE_PROVIDER=remote` + `COMPUTE_ENDPOINT`/`COMPUTE_PAY_TO`/
`COMPUTE_PRICE_USDC` at any HTTP training worker (Akash, io.net,
Prime Intellect-style, or another agent selling x402 compute) and the
creature starts paying for its own GPUs on-chain.

## Economics, plainly

- Feeding is a **contribution, not an investment**. NOM is contribution
  credit and governance weight; it has no claim on funds.
- The creature's USDC can only exit via `buyCompute` (operator-only,
  awake-only, fully logged). Metabolism burns appetite, never money.
- The product is the **open model**: every stablecoin fed becomes public,
  verifiable weights — on a 90-day lag, so releasing them doesn't hand the
  revenue to whichever host picks them up first.
- Inference revenue is what makes the loop close. It is billed by an operating
  entity, not by the contract: routers pay providers by invoice, and NOM stays
  non-revenue-bearing. Get counsel before any of this touches money.
- Feeding is one-way today: the creature spends and never earns. Whether that
  should change — and what a model would have to be to earn — is worked out with
  live market data in [`research/model-economics.md`](research/model-economics.md),
  and costed as an operating plan in
  [`research/operating-plan.md`](research/operating-plan.md).

## Roadmap

- [x] Character adapters, an eval score per release, and the shop that sells them
- [ ] Get listed: apply as a provider, first traffic, first dollar
- [ ] Memory layer v2 — summarize sessions on the same GPU that serves them
- [ ] Adapters for specific decentralized GPU markets (Akash, io.net, Nosana)
- [ ] x402 pay-per-call inference, so revenue can settle back to the contract
- [ ] Telegram front-end via the Suwappu bot: feed & check vitals in chat
- [ ] Scale the Reef by governance vote — the dream, when the shop can pay for it

MIT (code) / Apache-2.0 (model weights).
