# SUWA-WM

The open-source **world model** trained by the [Suwappu Tomagachi](../README.md) —
an on-chain creature that converts fed stablecoins into decentralized compute
and releases every checkpoint to the community.

**This is not an LLM.** SUWA-WM is an action-conditioned latent dynamics model:

- **Encoder** — conv net mapping grid observations of the Reef (a procedural
  ocean world with currents, plankton, and a swimmer) into a 128-d embedding.
- **Dynamics** — a GRU belief state over `(embedding, action)` that predicts
  the *embedding* of the next observation (JEPA-style, non-generative — no
  pixel reconstruction), plus reward and continuation heads for planning.
- **Anti-collapse** — a VICReg-style variance hinge keeps the latent space alive
  without needing a target-network EMA.

The lineage we're building in: Dreamer/RSSM latent world models, JEPA's
predict-in-representation-space objective, and the open-weights ethos proven
out by the Chinese open-source wave (DeepSeek, Qwen, OpenDriveLab's driving
world models) — release everything, let the community compound it.

## Why so small?

v0 trains in CPU-minutes. That's deliberate: the creature's economy has to
close the loop end-to-end first — feed → buy compute → train → on-chain
checkpoint → open weights. Every epoch warm-starts from the last, so community
compute *accumulates into one model*. Scaling the Reef (bigger grids, pixel
observations, multi-agent) is what NOM-holder governance votes on.

## Train an epoch

```bash
pip install -r requirements.txt
python3 suwa_wm/train.py --epoch 1 --steps 2000 --out ../runs/epoch-1
```

Outputs `checkpoint.pt` and `manifest.json`; the manifest's `sha256` is exactly
the hash the creature posts on-chain via `checkpoint()`, so anyone can verify
that released weights match the chain record.

Push open weights to Hugging Face:

```bash
HF_TOKEN=hf_... python3 suwa_wm/train.py --epoch 1 --push suwappu/suwa-wm
```

## Verify a release against the chain

```bash
sha256sum checkpoint.pt   # must equal the modelHash in the on-chain Checkpoint
```

Weights are released under **Apache-2.0**.
