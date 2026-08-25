# SUWA-WM

The open-source **world model** trained by the [Suwappu Tomagachi](../README.md) —
a creature on Base that funds its own training out of its token's trading fees
and pays strangers to do the work.

**This is not an LLM.** SUWA-WM is an action-conditioned latent dynamics model:

- **Encoder** — a conv net mapping observations of the Reef (a procedural ocean
  world with currents, plankton, and a swimmer) to a 128-d embedding.
- **Dynamics** — a GRU belief state over `(embedding, action)` predicting the
  *embedding* of the next observation (JEPA-style, non-generative — no pixel
  reconstruction), plus a reward head so the latent is usable for planning.
- **Anti-collapse** — a VICReg-style variance hinge keeps the embedding space
  alive without a target-network EMA.

The lineage: Dreamer/RSSM latent world models, JEPA's predict-in-representation
objective, and the open-weights culture proven out by the Chinese open-source
wave (DeepSeek, Qwen, OpenDriveLab's driving world models) — release everything,
let the community compound it.

## Why so small?

v0 trains in CPU-minutes, on purpose. The economy has to close the loop first:
trade → fee → food → bounty → training → verified on-chain release. Every epoch
warm-starts from the last, so community compute **accumulates into one model**.
How far to scale the Reef is a governance vote, not a decision by us.

## The reproducibility contract

This is the security model, not a nicety. The contract picks the seed, so any
worker can re-run an epoch and challenge a liar. That only works if honest
workers agree bit-for-bit, so every run pins:

| what | why |
|---|---|
| seed from the on-chain `jobSpec` | nobody chooses their own favourable run |
| `torch.use_deterministic_algorithms(True)` | forbids nondeterministic kernels |
| `torch.set_num_threads(1)` | thread scheduling reorders float reductions |
| CPU only, float32 | GPU kernels are not bit-reproducible across devices |
| canonical tensor hashing | container/pickle details never enter the hash |

The hash on-chain is **not** `sha256(checkpoint.pt)`. It is a canonical hash
over the sorted state dict — each tensor's name, dtype, shape, and raw bytes
(see `suwa_wm/canonical.py`). Two runs producing identical weights produce an
identical hash on any machine, whatever the file container looks like.

Residual risk: different torch versions or BLAS backends can still diverge in
the last bits. That is exactly why a challenge is settled by a **NOM-holder
vote** rather than by automatic hash equality — determinism makes cheating
*detectable*, and the court decides. Pin the `torch` version in
`requirements.txt` when you work real epochs.

## Train an epoch

```bash
pip install -r requirements.txt
python3 suwa_wm/train.py --epoch 1 --steps 2000 \
  --seed-hex 0x<seed from jobSpec> --out ../runs/epoch-1
```

Continuing the community model (the worker passes these automatically):

```bash
python3 suwa_wm/train.py --epoch 2 --steps 2000 --seed-hex 0x… \
  --base-uri https://huggingface.co/suwappu/suwa-wm \
  --base-hash 0x<previous release hash> --out ../runs/epoch-2
```

If the chain says an epoch continues from existing weights and you cannot fetch
them, the trainer **refuses to run** rather than silently training from scratch
and producing a result that would get you slashed.

Release open weights while training:

```bash
HF_TOKEN=hf_... python3 suwa_wm/train.py --epoch 1 --seed-hex 0x… --push suwappu/suwa-wm
```

## Verify any release against the chain

```bash
python3 verify.py checkpoint.pt 0x<modelHash from latestModel()>
# → MATCH — these weights are exactly what the chain attests to.
```

Weights are released under **Apache-2.0**.
