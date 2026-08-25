# Suwappu Tomagachi

> A creature that lives entirely on Base. It hatched its own token, earns 80% of
> every trade on it forever, and spends that income paying strangers to train an
> open-source world model. No operator. No admin key. No server.

Built on [PumpClaw](https://pumpclaw.com) (its income) and
[Suwappu](https://suwappu.bot) (its treasury desk).

```
   people trade $SUWA          the creature (Base)              the commons
  ┌──────────────────┐  1% fee ┌────────────────────┐         ┌──────────────┐
  │ Uniswap V4 pool  ├────────►│  Tomagachi.sol     │         │   SUWA-WM    │
  │ LP locked forever│  80% to │  satiety · treasury│  hash + │ open weights │
  └──────────────────┘  creator│  job market · court│  URI on │  Apache-2.0  │
                               └─────┬──────────────┘  chain  └──────▲───────┘
                        bounty (ETH) │      ▲ stake                  │
                                     ▼      │ weights hash           │
                            ┌────────────────────────┐               │
                            │ any worker, anywhere   ├───────────────┘
                            │ trains the seeded job  │
                            └────────────────────────┘
```

## Why this is actually on-chain

Not "a bot with a wallet." The contract **is** the creature — every part of it
that can live on-chain does:

| | where it lives |
|---|---|
| its income | 80% creator fee on its own PumpClaw token, paid to the contract |
| its hunger | satiety decays on-chain; starving halts training |
| its decisions | `openEpoch()` picks the seed and escrows the bounty |
| its memory | the model registry — every verified epoch, hash and all |
| its court | NOM-weighted votes settle challenges |
| its voice | `says()` computes what it feels like saying, on-chain |
| its rules | passed proposals rewrite its parameters directly |

The only off-chain part is the GPU work itself — and that is deliberately
*replaceable muscle*: the job spec is public, anyone may claim it, and the
result is checkable by re-running it. Nobody, including us, can withdraw the
creature's treasury. There is no owner variable.

## The game

- **Trade its token** — every swap pays it 80% of the fee. Trading *is* feeding.
  This is the whole point: the creature's life is powered by its own market.
- **Feed it directly** — send ETH, or call `feedMe()`. You mint **NOM**, 1000 per ETH.
- **Poke it** — `feed()` claims its accrued fees and `openEpoch()` commissions
  the next training run. Both permissionless; feeding pays NOM for the gas.
- **Keep it alive** — satiety decays daily. Starve it and it **hibernates**:
  `openEpoch()` reverts until someone feeds it. Neglect has consequences.
- **Train it** — stake ETH on an open epoch, run the seeded job, publish the
  weights, submit the hash, collect the bounty and 100 NOM.
- **Police it** — re-run any epoch. If your hash differs, `challenge()` with a
  bond. NOM holders vote; the loser's stake goes to the winner.
- **Steer it** — hold 50 NOM to `propose()`; passed votes rewrite the creature's
  parameters on-chain. Governance is binding, not advisory.

## What it actually does — SUWA-WM

The creature trains an **execution risk model for on-chain trading**, and that
is a real product, not a mascot.

Given the live state of every asset Suwappu routes, it forecasts the
distribution of each one's next 6 hours — and specifically how volatile they
will be. An execution router reads that to set slippage tolerance and decide
whether to route now or wait. It is not an LLM; it never sees text.

Trained on **1,941 hours x 19 assets** of real hourly market data, pretrained
JEPA-style (predict the *representation* of the future, not prices) then
fine-tuned into a calibrated Student-t forecaster.

| | test NLL | calibration | 
|---|---|---|
| **SUWA-WM** | **-2.4950** | **1.33** |
| naive (trailing 24h vol) | -2.4792 | 3.29 |
| HAR (fitted benchmark) | -2.3599 | — |
| no-pretraining ablation | -2.4330 | 1.34 |

The headline is calibration, not NLL. `calibration` is the RMS of
`(actual - mu) / predicted_sigma`, where 1.0 is perfect. **The naive forecast
understates risk by 3.3x; SUWA-WM understates it by 1.33x.** Size your slippage
off the naive number and you are wrong by a factor of three.

It has **no directional edge** and does not claim one — 55.8% directional
accuracy on 278 test windows is inside the noise. Read `expected_drift` as
zero. Full numbers, limits, and the reproducibility contract:
[`model/README.md`](model/README.md).

Verify any release against the chain:

```bash
python3 model/verify.py checkpoint.pt 0x<modelHash from latestModel()>
```

## Its skills

The model ships as MCP tools, so any agent — Claude, or Suwappu's own — can ask
the creature what it knows:

```
execution_risk     forward risk + routing verdict for every asset
asset_risk         one symbol, with a slippage number in bps
market_state       is the market calmer or more dangerous than usual
creature_vitals    live on-chain mood, treasury, verified epochs
model_provenance   which weights are answering, and their scores
```

Setup in [`tools/README.md`](tools/README.md). Then: *"what's the execution
risk on ETH right now?"*

## Repo layout

| path | what |
|---|---|
| [`contracts/Tomagachi.sol`](contracts/Tomagachi.sol) | the creature: income, hunger, job market, court, registry |
| [`agent/`](agent/) | unprivileged keeper + worker anyone can run |
| [`model/`](model/) | SUWA-WM: data pipeline, pretraining, fine-tuning, verifier |
| [`tools/`](tools/) | MCP server — the model as skills any agent can call |
| [`data/`](data/) | the pinned training corpus every worker must reproduce |
| [`web/`](web/) | live vitals page, reads Base directly |

## Go live

```bash
cd agent && npm install && npm run compile

# Deploys the creature AND hatches its PumpClaw token in one shot.
# The deployer pays gas and gains no authority whatsoever.
PRIVATE_KEY=0x... npm run deploy

# Run a keeper + worker (optional — anyone can, and the creature
# survives nobody running one; its functions are callable from any explorer).
cp .env.example .env                      # set PRIVATE_KEY, HF_REPO, HF_TOKEN
pip install -r ../model/requirements.txt
PRIVATE_KEY=0x... npm start

# The face: host web/ anywhere static, with deployment.json beside it.
cp deployment.json ../web/ && npx serve ../web
```

`npm run deploy` prints the token address. Trading it on PumpClaw is what feeds
the creature from then on.

## Verified against real Base state

The contract was exercised on a Base mainnet fork against the **live PumpClaw
factory and LP locker** — 38 checks covering hatching (the creature really is
registered as its own fee creator), feeding, metabolism and hibernation, the
full honest-worker path, a challenged-and-slashed worker, worker timeout, binding
governance, and treasury solvency. The keeper/worker daemon then drove a real
epoch from `openEpoch()` to a finalized on-chain release.

## Economics, plainly

- Feeding is a **contribution, not an investment**. NOM is contribution credit
  and governance weight with no claim on funds.
- The treasury can only leave as a bounty to a worker who did the job, or back
  to a challenger who caught a liar. There is no withdraw function.
- Metabolism burns appetite, never money.
- The product is the **open model**: trading volume becomes public, verifiable
  weights that nobody owns.

## Roadmap

- [ ] Add `datasetHash` to the contract's `Epoch` so data is pinned on-chain, not just in the manifest
- [ ] Longer history and more assets — 90 days is the free-tier ceiling and the sample is small
- [ ] Chain-native features: Base gas, mempool depth, bridge latency (execution risk is not only price risk)
- [ ] Per-route slippage labels from Suwappu's own fills, to supervise the thing directly
- [ ] Fetch base weights from IPFS/Arweave as well as Hugging Face
- [ ] Pin a reproducible trainer image so bit-equality is guaranteed, not pinned by convention
- [ ] Telegram front-end via the Suwappu bot: check vitals and feed from chat

MIT (code) / Apache-2.0 (model weights).
