# Suwappu Tomagachi

> An on-chain creature that eats stablecoins, buys decentralized compute, and
> trains an open-source **world model** for its community.

Built on [Suwappu](https://suwappu.bot) — the cross-chain DeFi API for AI
agents. The creature lives as a contract on **Base**; its brain is an
autonomous agent that turns every token you feed it into training compute.

```
        you                     the creature                the community
   ┌───────────┐   feed USDC   ┌────────────────┐  weights ┌──────────────┐
   │ any wallet ├──────────────► Tomagachi.sol  ├──────────► SUWA-WM       │
   └─────┬─────┘   mints NOM   │  (Base)        │  + hash   │ open weights │
         │                     │ satiety/energy │  on-chain │ Apache-2.0   │
   any token                   └──────┬─────────┘           └──────────────┘
         │                            │ buyCompute (USDC, audited)
   ┌─────▼──────────┐          ┌──────▼─────────┐
   │ brain (agent/) │ suwappu  │ GPU providers  │
   │ swaps → USDC   ├──────────► local / remote │
   └────────────────┘  API     └────────────────┘
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
- **It learns in public.** Each training epoch ends with
  `checkpoint(epoch, sha256, uri, loss, spent)` on-chain. Anyone can
  `sha256sum` the released weights against the chain.
- **You steer it.** NOM holders `propose()` and `vote()` on training
  directions — bigger worlds, new dynamics, scaling runs.

## The model — SUWA-WM

Not an LLM. An action-conditioned **latent world model** (Dreamer/RSSM lineage
with a JEPA-style predict-the-embedding objective) trained on the Reef, a
procedural ocean world. Fully open weights, Apache-2.0, warm-started every
epoch so community compute compounds into one model. See [`model/`](model/).

## Repo layout

| path | what |
|---|---|
| [`contracts/Tomagachi.sol`](contracts/Tomagachi.sol) | the creature + NOM token (self-contained, no deps) |
| [`agent/`](agent/) | the brain: Suwappu swaps, compute brokerage, on-chain ops |
| [`model/`](model/) | SUWA-WM: env, model, training, HF release |
| [`web/`](web/) | live vitals page (static, reads Base directly) |
| [`research/`](research/) | market scans: where inference revenue actually lands |

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

# 3. face — host web/ anywhere static, with deployment.json alongside
cp deployment.json ../web/ && npx serve ../web
```

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
  verifiable weights.
- Feeding is one-way today: the creature spends and never earns. Whether that
  should change — and what a model would have to be to earn — is worked out with
  live market data in [`research/model-economics.md`](research/model-economics.md).

## Roadmap

- [ ] Adapters for specific decentralized GPU markets (Akash, io.net, Nosana)
- [ ] x402 pay-per-job compute settlement (Suwappu already speaks it)
- [ ] Scale the Reef by governance vote: 32×32, pixel obs, multi-agent
- [ ] Telegram front-end via the Suwappu bot: feed & check vitals in chat
- [ ] Verifiable training (proof-of-learning attestations per epoch)

MIT (code) / Apache-2.0 (model weights).
