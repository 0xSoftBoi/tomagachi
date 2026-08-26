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
| its data | the corpus hash is pinned on-chain; the trainer refuses anything else |

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
- **Train it** — stake ETH on an open epoch, run the job against the seed *and
  dataset hash* the contract names, publish the weights, submit the hash,
  collect the bounty and 100 NOM.
- **Police it** — re-run any epoch. If your hash differs, `challenge()` with a
  bond. NOM holders vote; the loser's stake goes to the winner.
- **Steer it** — hold 50 NOM to `propose()`; passed votes rewrite the creature's
  parameters on-chain. Governance is binding, not advisory.

## What it actually does — SUWA-WM

The creature trains an **execution risk model for on-chain trading**. That is a
real product, not a mascot.

Given the live state of the 43 assets Suwappu routes, it forecasts each one's
next-6h return distribution — specifically how volatile it will be. A router
reads that to set slippage and decide whether to route now or wait. It is not
an LLM; it never sees text.

Trained on **17,520 hours x 43 assets** of real hourly OHLCV (753,360
asset-hours, two years). Evaluated **walk-forward**: 4 expanding-window folds x
2 seeds, 2,492 test windows each, spanning several market regimes — with every
fold trained only on data preceding its own test block.

| | NLL (nats) | QLIKE | calibration |
|---|---|---|---|
| **SUWA-WM** | **−2.5510 ± 0.0946** | **0.5745 ± 0.0279** | **1.004 ± 0.041** |
| naive close-to-close | −2.5216 ± 0.1015 | 0.6526 ± 0.0581 | 1.209 ± 0.059 |
| naive Parkinson | −2.5328 ± 0.0995 | 0.6260 ± 0.0450 | 1.175 ± 0.040 |
| HAR (fitted) | −2.4945 ± 0.0937 | 0.6838 ± 0.0330 | — |

Against the **best** benchmark on each run: NLL **+0.018 ± 0.007** and QLIKE
**+0.052 ± 0.021**, better in **8 of 8 runs**. Calibration lands at **1.004**,
where 1.0 is perfect — predicted risk matches realised risk, while the naive
forecasts understate it by ~18%.

It has **no directional edge** and does not claim one: 0.504 ± 0.008
directional accuracy. Read `expected_drift` as zero. Full numbers, what did
*not* work, and the limits: [`model/README.md`](model/README.md).

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
| [`data/`](data/) | the pinned corpus — hashed on-chain, every worker must match it |
| [`web/`](web/) | live vitals page — reads Base directly, no CDN, no backend |

## Go live

```bash
cd agent && npm install && npm run compile

# Deploys the creature AND hatches its PumpClaw token in one shot.
# The deployer pays gas and gains no authority whatsoever.
# Measured on a Base mainnet fork: 5,918,441 gas total, ~$0.09 at 0.006 gwei.
PRIVATE_KEY=0x... npm run deploy

# Run a keeper + worker (optional — anyone can, and the creature
# survives nobody running one; its functions are callable from any explorer).
cp .env.example .env                      # set PRIVATE_KEY, HF_REPO, HF_TOKEN
pip install -r ../model/requirements.txt
PRIVATE_KEY=0x... npm start

# The face: host web/ anywhere static, with deployment.json beside it.
# Self-contained — viem is vendored, so it works offline of any CDN.
cp deployment.json ../web/ && npx serve ../web
```

`npm run deploy` prints the token address. Trading it on PumpClaw is what feeds
the creature from then on.

### Rehearsing on a testnet

PumpClaw is deployed on **Base mainnet only**. Since `hatch()` needs it and
every economic function is gated on `hatched`, a naive testnet deploy would
produce a creature that can never do anything. So the PumpClaw addresses are
constructor-injected, and a testnet deploy stands up mocks automatically:

```bash
PRIVATE_KEY=0x... CHAIN=baseSepolia npm run deploy
```

That deploys `MockPumpClawFactory` / `MockPumpClawLocker` — same interfaces,
same 80/20 creator split, same native-ETH payout — then the creature against
them. The mock locker adds one function the real one has no need for:

```bash
# stand in for trading volume, so the testnet creature earns its own income
cast send <locker> "accrue(address)" <token> --value 0.05ether
# then anyone can pull the 80% creator share into the creature
cast send <creature> "feed()"
```

The deploy script **refuses to substitute mocks on mainnet** — the creature's
income depends on the real factory and locker, and a mocked mainnet creature
would be worthless. Mocks live in
[`contracts/MockPumpClaw.sol`](contracts/MockPumpClaw.sol) and are never
deployed by the mainnet path.

## Verified against real Base state

The contract was exercised on a Base mainnet fork against the **live PumpClaw
factory and LP locker** — 40 checks covering hatching (the creature really is
registered as its own fee creator), feeding, metabolism and hibernation, the
full honest-worker path, a challenged-and-slashed worker, worker timeout,
binding governance including voting in a new training corpus, the on-chain
dataset pin, and treasury solvency. The keeper/worker daemon then drove a real
epoch from `openEpoch()` to a finalized on-chain release.

The testnet path is verified separately on a bare Base-Sepolia-shaped chain: the
creature is born hibernating, simulated trading fees are accrued on its token,
a permissionless `feed()` pulls exactly the 80% creator share, it wakes, and
`openEpoch()` becomes reachable — the thing that was impossible while the
PumpClaw addresses were hardcoded.

### The whole system, once, for real

Every piece has also been run together on a live chain, in order:

1. Deployed and hatched; the creature is born **hibernating**.
2. `accrue()` simulates 0.25 ETH of trading on `$SUWA`; a permissionless
   `feed()` pulls exactly the 0.2 ETH creator share into it.
3. A contributor calls `feedMe()`, earns NOM, **proposes and passes a
   governance vote** that rewrites `stepsPerEpoch` on-chain.
4. The unprivileged daemon opens an epoch, stakes, and trains the real
   SUWA-WM against the seed *and* dataset hash the contract published.
5. It submits the weight hash, waits out the challenge window, finalizes and
   collects the bounty. The creature pays out 0.002 ETH.
6. `latestModel()` returns `0x9c8b3dc3…`; `model/verify.py` recomputes the same
   hash from the weights on disk — **MATCH**.
7. `creature_vitals` over MCP and the web page both read it live.
8. Epoch 1 opens automatically, warm-starting from epoch 0's verified hash.

That is the full loop: trading volume becomes compute, compute becomes an open
model, and anyone can verify the model against the chain.

## Economics, plainly

- Feeding is a **contribution, not an investment**. NOM is contribution credit
  and governance weight with no claim on funds.
- The treasury can only leave as a bounty to a worker who did the job, or back
  to a challenger who caught a liar. There is no withdraw function.
- Metabolism burns appetite, never money.
- The product is the **open model**: trading volume becomes public, verifiable
  weights that nobody owns.

## Roadmap

- [ ] Chain-native features: Base gas, mempool depth, bridge latency (execution risk is not only price risk)
- [ ] Per-asset calibration — the aggregate is good, thin assets may not be
- [ ] More than two years and more than one asset class
- [ ] Per-route slippage labels from Suwappu's own fills, to supervise the thing directly
- [ ] Fetch base weights from IPFS/Arweave as well as Hugging Face
- [ ] Pin a reproducible trainer image so bit-equality is guaranteed, not pinned by convention
- [ ] Telegram front-end via the Suwappu bot: check vitals and feed from chat

MIT (code) / Apache-2.0 (model weights).
