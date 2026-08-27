# Can the creature eat on Bittensor?

Asked because the three items left in the graph are all blocked on *off-chain*
things — an entity that can be invoiced, a public certificate, a rented GPU —
and Bittensor pays emissions to a hotkey with none of that. If a subnet paid
for what we already built, the entity problem would evaporate.

Short answer: **no, and we already solved the problem it would solve.**

Run `python3 research/tao_economics.py` to reproduce every number below.
TAO at $237.48 (CoinGecko, live, 2026-08-27).

## 1. The one subnet that fit is gone

Subnet 11 was Dippy Roleplay. Miners fine-tuned roleplay LLMs, pushed them to
Hugging Face, and validators scored them on coherence, creativity, latency and
a judge LLM's read — which is, almost line for line, what `model/train_lora.py`
produces and `model/suwa_lm/evaluate.py` scores. It powered the Dippy companion
app, 1M+ users, #3 on the App Store in Germany.

It rebranded to Dippy Studio (generative media), and netuid 11 is now
TrajectoryRL, "a decentralized prompt optimization tournament" for cost-efficient
agent policies. It does not accept roleplay miners. The old subnet repo 404s.

That is the strongest available signal, and it points the wrong way: the one
incentive mechanism on the network that paid for this exact artifact stopped
paying for it.

## 2. The inference subnets buy GPU-seconds, not characters

Targon (SN4) and Chutes (SN64) are where the LLM traffic is, and on both a
miner serves the model the validator specifies. You are selling GPU time, not a
character — which deletes the whole thesis. The finding in
`research/model-economics.md` was that the money is in *owning the endpoint and
selling a job at 5–40× commodity price*; renting a GPU to someone else's
scheduler is the commodity side of that trade, by construction.

Worth noting where the money actually goes: Chutes is itself an OpenRouter
provider. Even the biggest revenue subnet on Bittensor bills its customers
through the market we already scanned.

## 3. The emissions do not cover the machine

```
network emissions      $845,191/day   $308.5M/yr
  of which to miners   $126.5M/yr
  per subnet (avg)     $980,487/yr
  per miner UID (avg)  $5,160/yr = $99/wk
```

Against `$336/wk` for one H100 billed idle or not. An average UID on an average
subnet is **$99/wk** — which is our own scenario A, the near-idle shop, except
with a registration fee and a deregistration clock.

And $99 is the mean, not the median. Emissions are allocated in proportion to
each subnet's alpha-price EMA, so the distribution is top-heavy; most subnets
are well under it. A UID is also not tenure: each tempo the neuron with the
lowest pruning score outside its immunity window is replaced by whoever
registered next, and the TAO recycled to register is not returned when that
happens. It is an operating cost, paid to keep competing.

## 4. It is a smaller market, not a bigger one

```
verified CUSTOMER revenue, whole network:  $1.1M-$5.6M/yr
  as a share of emissions paid out:        0.4%-1.8%
openrouter customer spend:                 $1,800M/yr
  bittensor's real market is               321x-1,636x smaller
```

Roughly 99% of what a Bittensor miner earns is token issuance, not a customer.
That is not a criticism of the design — it is a bootstrap subsidy doing its job
— but it changes what "revenue" means. A creature that eats emissions is eating
dilution, and the number on the wall would measure how convincing the subnet's
stakers find it, not whether anyone wanted to talk to Tide.

## 5. Our own subnet costs $356,220

1,500 TAO to register, up 6.5× from 230 TAO in May 2026, doubling with every
successful registration and decaying only if nobody registers. Not a candidate.

## The part that matters: we already have on-chain money

The reason to want a subnet was to get paid without a bank account. `agent/src/x402.ts`
already does that, and it is built and verified: a caller with no API key gets a
402 carrying a quote in USDC on Base, retries with a signed `X-PAYMENT` header,
we verify with the facilitator before doing any work, serve, then settle on
actual usage and hand back `X-PAYMENT-RESPONSE`. Money lands where the contract
can see it. No entity, no invoice, no KYC — the same property a hotkey has,
against a market three orders of magnitude larger.

`provider-apply` is blocked on an entity. **The x402 route is not.** That is the
asymmetry worth acting on, and it does not need Bittensor.

## What is actually worth taking from the TAO ecosystem

One thing: **Chutes as the GPU.** Serverless per-second inference with custom
model deployment, claiming up to 20× cheaper than the usual clouds, and it
scales to zero when idle — which attacks the constraint the whole plan turns on
(a GPU billing 168 hours a week whether or not anyone shows up). It does not
dodge the payment rail: their published pricing is USD, with no crypto option
for end users. Cheaper GPU, not an entity-free one.

Unverified and worth an hour before relying on it: whether a custom chute can
serve five LoRA adapters off one shared base, which is the arrangement
`deploy/vllm/serve.sh` depends on.

## Verdict

Mining is not a revenue path for this project, it is an emissions path into a
market ~300–1,600× smaller than the one we already measured, for an artifact
whose matching subnet shut down. Finish the x402 route instead: that is the
on-chain money, and it is already written.

Sources: CoinGecko (TAO price, live), Pine Analytics via ownyourmind.ai
(verified subnet revenue), subnetalpha.ai (netuid 11 current state), DL News /
Bitget (subnet registration cost), learnbittensor.org docs (emission split,
deregistration, immunity), chutes.ai/llms.txt (custom deployment and pricing).
