# The creature's models

Two things live here, and only one of them is a business.

| | what | why |
|---|---|---|
| [`suwa_lm/`](suwa_lm/) | **SUWA-LM** — character adapters | the product: what the creature sells |
| [`suwa_wm/`](suwa_wm/) | **SUWA-WM** — the Reef world model | the dream: what the creature is *for* |

The split is deliberate and the reasoning is in
[`../research/model-economics.md`](../research/model-economics.md): a world model
has no per-token market to sell into, and the best-known one on the Hub has 669
downloads. Character models do have a market, and the operating plan for
capturing a piece of it is in
[`../research/operating-plan.md`](../research/operating-plan.md).

---

# SUWA-LM

One frozen base, one small LoRA adapter per character, defined in
[`characters.json`](characters.json) — the same file the serving layer prices
and serves from, so a SKU is defined exactly once.

**The fleet is the product.** A single fine-tune is not a business: the best
independent one on OpenRouter generates 27 GPU-hours of work a week against a
machine that bills for 168, and the idle eats the margin. Adapters share the
base, so the second character is served out of capacity the first already paid
for. Five of them fill the same GPU and turn $71/week of contribution into
$1,701.

## Train a character

```bash
pip install -r requirements.txt

# Once: a shared backbone for adapters to steer (CPU, a few minutes).
python3 suwa_lm/pretrain_tiny.py --steps 1500

python3 suwa_lm/train_lora.py --character suwa-tide --epoch 1 --tiny
```

Drop `--tiny` to train against the real base named in `characters.json`
(requires `transformers`; a GPU is strongly advised). The tiny byte-level
backbone exists so the whole loop — train, score, hash, post on-chain, serve —
runs on a laptop with nothing to download. **It is a smoke test.** An adapter
trained on the seed corpus is wired correctly and worth nothing.

Outputs in `--out`:

| file | what |
|---|---|
| `adapter.pt` | LoRA weights only — kilobytes, not gigabytes |
| `manifest.json` | `sha256` (posted on-chain), `score`, `held_out_loss`, and the exact command to reproduce it |
| `eval.json` | every held-out prompt, its reply, and whether the voice held |

## Where training data comes from

In order of preference, recorded in the manifest as `data_source`:

1. **collected** — `model/data/<character>.jsonl`, one `{"messages": [...]}` per
   line. Real sessions and community preference labels; what a NOM vote decides.
   The shop produces these when `CAPTURE_TRANSCRIPTS=1`, writing raw traffic to
   the gitignored `model/data/captured/` with identifiers redacted; a review
   step promotes what is worth keeping into the curated file above. Callers can
   refuse per request with `X-Suwa-No-Capture: 1`, and capture is off by default.

   ```bash
   python3 suwa_lm/review.py --character suwa-tide --dry-run   # see the verdict
   python3 suwa_lm/review.py --character suwa-tide             # write the set
   ```

   The review is a gate, not a converter. It drops replies that broke
   character — the one thing that must never be learned from, since warm
   starting compounds it — along with short acknowledgements, runaway replies,
   near-duplicates, and rows that are mostly redaction placeholders. Every
   rejection is counted by reason, because a run that keeps 3 of 400 is telling
   you something about the adapter that silently writing three rows would hide.

   Whether to *publish* a curated set derived from real sessions is a decision,
   not a default. Nothing here commits one for you.
2. **distilled** — generated against any OpenAI-compatible teacher with
   `--teacher-url`. How a new SKU bootstraps before it has traffic.
3. **seed** — a deterministic template corpus built from the character's own
   spec. Teaches the shape of the voice and nothing else.

## The score is the point

Anyone can verify a released adapter end to end:

```bash
sha256sum adapter.pt        # must equal the modelHash in the on-chain Checkpoint
# then re-run the command in manifest.json's `reproduce` field
```

```
turn    = in_character_rate * (1 - break_rate)
session = memory_adherence * (1 - drift)
score   = mean(turn, session)
```

The turn half asks whether one reply sounds like the character, measured on
held-out prompts. The session half runs a scripted conversation that plants a
fact early and asks for it back at the end, and compares voice in the first
half of the session against the second — that is the question the price is
actually justified by: **is the same person still there later, and do they
remember what you told them?**

A model can ace the turn score and fail the session score badly. That is the
familiar roleplay failure — charming for five minutes, a stranger by turn
thirty — and scoring only single replies hid exactly the thing being sold.

Greedy decoding, fixed prompts, no sampling and no network, so the number is
reproducible. `eval_version` is stamped into every manifest because scores from
different scoring shapes are not comparable, and a release gate that compared
them anyway would either block a good epoch or wave through a bad one. That
makes the on-chain checkpoint a **performance claim a buyer can re-derive**,
not just a provenance receipt.

## An epoch that got worse is not released

Warm-starting is what makes community compute compound into one improving
character. It compounds regressions the same way, so the trainer refuses to
release an epoch scoring below its parent:

- no `manifest.json`, so the brain has nothing to checkpoint on-chain
- no `adapter.pt` either — the weights are kept as `rejected-adapter.pt` so the
  *next* epoch cannot warm-start from a regression and compound it
- `rejected.json` records the comparison, and the trainer exits 3
- the previous epoch stays live and the epoch number is not consumed, so the
  next attempt starts from the same parent

Only like is compared with like: a parent scored under a different
`eval_version` is not a baseline, and the gate says so rather than guessing.
`--score-tolerance` widens the margin, `--no-gate` bypasses it entirely.

Weights are Apache-2.0 on a **90-day lag** (`license_effective_after_days`).
Releasing on day one hands the revenue to whichever host picks the weights up
first; the lag keeps the promise and keeps the quarter.

---

# SUWA-WM — the dream

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
