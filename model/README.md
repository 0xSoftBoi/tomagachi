# SUWA-WM — a world model of the on-chain market

The open-source model the [Suwappu Tomagachi](../README.md) exists to train.

**What it actually does.** Given the current state of every asset Suwappu
routes, it forecasts the distribution of each one's next 6 hours: expected
drift and — the part that matters — expected volatility, as a calibrated
Student-t. An execution engine reads that to decide how much slippage to
tolerate, and whether to route now or wait.

It is **not** an LLM. It never sees text. It is an action-conditioned latent
dynamics model over real market state.

## Why risk and not price

Directional alpha over 6 hours is close to unavailable, and this model does not
claim it: measured directional accuracy is 55.8% and R² is +0.018 on 278 test
windows — inside the noise band for a sample that size. Treat the drift output
as approximately zero and do not trade on it.

Execution risk is a different question, and a tractable one. Volatility is
persistent and spills across assets, so "how badly could this move while my
swap is in flight" *is* forecastable — and it is the number an execution
router actually needs.

## Architecture

```
[48h x 19 assets x 6 features]
        |
   AssetEncoder      shared temporal conv, per asset
        |
  CrossAssetBlock    assets attend to each other (x2)
        |            <- BTC moving is context for SOL
   ExecutionHeads    mu, and a bounded correction to a learned
                     blend of trailing vol at 6/24/72/168h
        |
  Student-t(mu, sigma, dof=4)
```

Two design choices carry most of the weight:

- **Student-t, not Gaussian.** Under a Gaussian the optimiser shrinks sigma to
  fit the calm bulk and is then destroyed by the tails. We measured exactly
  that: mean NLL of **+8.38** and calibration off by 4.7x. Swapping in a
  Student-t took the same model to **-2.42**.
- **Anchored sigma.** The head predicts a bounded correction to a learned blend
  of multi-scale trailing volatility, rather than learning volatility from
  scratch. Its whole job is to improve on the benchmark, so it starts level
  with it instead of below.

Pretraining is JEPA: encode a 48h context, predict the *representation* of the
next 24h against an EMA target encoder, with VICReg variance/covariance terms
to prevent collapse. Nothing is reconstructed — predicting raw prices would
spend capacity on unpredictable noise.

## Measured results

Real data: **1,941 hours x 19 assets**, hourly, from CoinGecko. Chronological
70/15/15 split with a gap at each boundary; every feature is causal. 287k
parameters. Test set is 278 windows.

Scored by Student-t NLL in nats (lower is better); both benchmarks are scored
under the same distribution family, so only the forecast differs.

| | test NLL | calibration | risk corr |
|---|---|---|---|
| **SUWA-WM** | **-2.4950** | **1.33** | 0.438 |
| naive (trailing 24h vol) | -2.4792 | 3.29 | 0.461 |
| HAR (fitted on train) | -2.3599 | — | 0.420 |
| no-pretraining ablation | -2.4330 | 1.34 | 0.447 |

- Beats the naive benchmark by **+0.016 nats** and HAR by **+0.135**.
- **Calibration is the real win.** `calibration` is the RMS of
  `(actual - mu) / predicted_sigma`; 1.0 is perfect. The naive forecast
  understates risk by **3.3x** on this window. SUWA-WM understates it by
  **1.33x**. Set slippage from the naive number and you are wrong by a factor
  of three; set it from this model and you are close.
- Pretraining is worth **+0.062 nats** over the identical-budget ablation.
- Per-sample win rate is ~49%: the mean NLL edge comes from being right in the
  moments that matter, not from winning most hours.

**Honest limits.** One seed, 278 test windows, 90 days of history, one market
regime. The NLL edge over the naive benchmark is small and I would not defend
it as significant on this sample; the calibration gap is large and consistent.
The risk correlation is marginally *worse* than naive. Do not size positions on
this without your own validation.

## Reproducibility — the on-chain security model

A challenge is only meaningful if two honest workers agree. Every run pins:

| what | why |
|---|---|
| seed from the contract's `jobSpec` | nobody picks a favourable run |
| **dataset pinned by sha256** | live-fetched data is not reproducible |
| `torch.use_deterministic_algorithms(True)` | forbids nondeterministic kernels |
| `torch.set_num_threads(1)` | thread scheduling reorders float reductions |
| CPU only, float32 | GPU kernels are not bit-reproducible across devices |
| `torch==2.13.0` pinned | reductions can differ between torch/BLAS builds |
| canonical tensor hashing | container/pickle details never enter the hash |

Verified: two runs of the same seeded epoch produce byte-identical weight
hashes.

The dataset hash is recorded in every manifest and published with the weights.
**Known gap:** the contract's `jobSpec` does not yet carry a dataset hash, so a
worker training on different data is caught by the manifest and the NOM court
rather than rejected on-chain. Adding `datasetHash` to the `Epoch` struct is
the next contract change.

## Run it

```bash
pip install -r requirements.txt

# 1. Build the corpus (throttled; ~3 min). Committed at data/market.npz so
#    every worker trains on identical bytes.
python3 suwa_wm/data.py --days 90 --out ../data/market.npz

# 2. Pretrain the world model (self-supervised)
python3 pretrain.py --data ../data/market.npz --steps 3000 --out ../runs/pretrain

# 3. Fine-tune into the execution forecaster, with benchmarks and ablation
python3 finetune.py --backbone ../runs/pretrain/backbone.pt --steps 3000 --ablation

# What an on-chain worker runs (does both, from the contract's seed):
python3 suwa_wm/train.py --epoch 1 --steps 2000 --seed-hex 0x… --out ../runs/epoch-1
```

Note on `pretrain.py`: it keeps the **final** weights, not the lowest-val ones.
In a JEPA the target encoder is a moving goalpost, so prediction loss drifts
upward as the representation gets richer — the lowest loss belongs to the most
*collapsed* encoder. Health is judged by effective rank (52.4/96 dims here) and
by the fine-tune ablation, never by that loss.

## Verify a release against the chain

```bash
python3 verify.py checkpoint.pt 0x<modelHash from latestModel()>
# -> MATCH — these weights are exactly what the chain attests to.
```

Weights: **Apache-2.0**.
