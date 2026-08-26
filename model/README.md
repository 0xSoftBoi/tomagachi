# SUWA-WM — a world model of the on-chain market

The open-source model the [Suwappu Tomagachi](../README.md) exists to train.

**What it actually does.** Given the current state of every asset Suwappu
routes, it forecasts the distribution of each one's next 6 hours: expected
drift and — the part that matters — expected volatility, as a calibrated
Student-t. An execution engine reads that to size slippage and decide whether
to route now or wait.

It is **not** an LLM. It never sees text.

## Why risk and not price

Directional alpha over 6 hours is close to unavailable and this model does not
claim it: directional accuracy is **0.504 ± 0.008** across 8 independent runs.
That is a coin flip, measured. Treat the drift output as zero.

Execution risk is a different question and a tractable one. Volatility is
persistent and spills across assets, so "how far could this move while my swap
is in flight" *is* forecastable — and it is the number a router needs.

## Measured results

Real data: **17,520 hours x 43 assets** of hourly OHLCV from Coinbase — 753,360
asset-hours over two years. Evaluated by **walk-forward**: 4 expanding-window
folds x 2 seeds = 8 independent runs, 2,492 test windows each, spanning several
distinct market regimes. Every fold pretrains and fine-tunes on that fold's own
training block only, so no test period ever touches the representation.

Mean ± std across the 8 runs. NLL and QLIKE lower is better; calibration 1.0 is
perfect. Every benchmark is scored under the same Student-t family, so the only
thing under test is the forecast.

| | NLL (nats) | QLIKE | risk corr | calibration |
|---|---|---|---|---|
| **SUWA-WM** | **−2.5510 ± 0.0946** | **0.5745 ± 0.0279** | **0.322 ± 0.031** | **1.004 ± 0.041** |
| naive close-to-close | −2.5216 ± 0.1015 | 0.6526 ± 0.0581 | 0.295 ± 0.041 | 1.209 ± 0.059 |
| naive Parkinson | −2.5328 ± 0.0995 | 0.6260 ± 0.0450 | 0.292 ± 0.056 | 1.175 ± 0.040 |
| HAR (fitted on train) | −2.4945 ± 0.0937 | 0.6838 ± 0.0330 | — | — |

Against the **best** benchmark on each run:

- NLL **+0.0182 ± 0.0066**, better in **8/8 runs**
- QLIKE **+0.0515 ± 0.0208**, better in **8/8 runs**
- Calibration **1.004** — essentially perfect, against 1.18–1.21 for the naive
  forecasts. Predicted risk matches realised risk.
- Risk correlation **0.322 vs 0.292–0.295**: it tracks realised move size
  better than either naive estimator.

Winning every fold and both metrics, with the spread quoted, is the part worth
trusting. A single fold could be a lucky quarter.

### What did not work

- **JEPA pretraining is now worth nothing measurable: +0.0004 ± 0.0012 nats**
  over an identical-budget model trained from scratch, helping in 3/4 runs.
  Self-supervision pays when labels are scarce; here every hour is labelled, so
  there is nothing for it to buy. It is kept because it initialises the
  backbone and costs little, but the on-chain genesis epoch now spends only a
  fifth of its budget on it. Earlier, on a 20x smaller corpus, it was worth
  +0.062 nats — that gain did not survive more data.
- **An earlier version of this README claimed the naive benchmark understates
  risk by 3.3x.** That came from a single 278-window test block that happened
  to be unusually violent. Under walk-forward the naive forecasts calibrate at
  ~1.18–1.21, not 3.3. The model still wins, by much less than that number
  implied.

## Architecture

```
[48h x 43 assets x 8 features]
        |
   AssetEncoder      shared temporal conv, per asset
        |
  CrossAssetBlock    assets attend to each other (x2)
        |            <- BTC moving is context for SOL
   ExecutionHeads    mu, plus a bounded correction to a learned blend of
                     8 volatility anchors: close-to-close AND range-based
        |            at 6/24/72/168h
  Student-t(mu, scale, dof=4)
```

Three choices carry most of the result:

- **Student-t, not Gaussian.** Under a Gaussian the optimiser shrinks sigma to
  fit the calm bulk and is then destroyed by the tails. Measured: mean NLL
  **+8.38** and calibration off by 4.7x. The Student-t took the same model to
  **−2.42**.
- **Range-based volatility.** With a high and a low you can use Parkinson and
  Garman-Klass estimators, several times more statistically efficient than
  close-to-close. This improves the model's inputs *and* raises the bar it must
  clear — naive-Parkinson is the strongest of the three benchmarks.
- **Anchored sigma.** The head predicts a bounded correction to a learned blend
  of those anchors rather than learning volatility from scratch, so its whole
  job is to improve on the benchmark and it starts level with it.

Pretraining is JEPA: encode a 48h context, predict the *representation* of the
next 24h against an EMA target encoder, with VICReg terms against collapse.
Nothing is reconstructed — predicting raw prices would spend capacity on
unpredictable noise.

## Honest limits

- Two years, one asset class, 43 assets. Crypto only.
- The absolute effect is modest: +0.018 nats and +0.05 QLIKE. It is consistent
  (8/8) rather than large.
- Calibration is measured in aggregate across assets; a single illiquid asset
  can still be badly served.
- The two seeds share a fold structure, so the ± is not a full confidence
  interval.
- Do not size positions on this without your own validation.

## Reproducibility — the on-chain security model

A challenge is only meaningful if two honest workers agree. Every run pins:

| what | why |
|---|---|
| seed from the contract's `jobSpec` | nobody picks a favourable run |
| **dataset hash from the contract** | live-fetched data is not reproducible |
| `torch.use_deterministic_algorithms(True)` | forbids nondeterministic kernels |
| `torch.set_num_threads(1)` | thread scheduling reorders float reductions |
| CPU only, float32 | GPU kernels are not bit-reproducible across devices |
| `torch==2.13.0` pinned | reductions differ between torch/BLAS builds |
| canonical tensor hashing | container/pickle details never enter the hash |

Verified: two runs of the same seeded epoch produce byte-identical weight
hashes, and the trainer refuses to start when the dataset does not hash to what
the chain requires.

## Run it

```bash
pip install -r requirements.txt

# 1. Build the corpus (parallel, ~40 min). Committed at data/market.npz so
#    every worker trains on identical bytes.
python3 suwa_wm/data.py --days 730 --out ../data/market.npz

# 2. The headline evaluation: walk-forward across folds and seeds
DATA=../data/market.npz OUT=../runs/bench ./run_benchmark.sh

# 3. A single split, for a quick read or a release build
python3 pretrain.py --data ../data/market.npz --steps 3000 --out ../runs/pretrain
python3 finetune.py --backbone ../runs/pretrain/backbone.pt --steps 1500 --ablation

# What an on-chain worker runs (from the contract's seed and dataset hash):
python3 suwa_wm/train.py --epoch 1 --steps 2000 --seed-hex 0x… --data-sha256 0x…
```

Note on `pretrain.py`: it keeps the **final** weights, not the lowest-val ones.
In a JEPA the target encoder is a moving goalpost, so prediction loss drifts
upward as the representation gets richer — the lowest loss belongs to the most
*collapsed* encoder. Health is judged by effective rank, never by that loss.

## Verify a release against the chain

```bash
python3 verify.py checkpoint.pt 0x<modelHash from latestModel()>
# -> MATCH — these weights are exactly what the chain attests to.
```

Weights: **Apache-2.0**.
