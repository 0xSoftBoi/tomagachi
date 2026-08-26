# Deploying the shop

One GPU serving the shared base with every character adapter, and the billing
layer in front of it. This is Phase 0 of
[`../research/operating-plan.md`](../research/operating-plan.md): get listed,
prove demand, and decide at week 10.

```
   router / any OpenAI client
             │
             ▼
   ┌──────────────────────┐    the product and billing layer
   │  shop  (agent/)      │    persona + session memory + usage ledger
   │  :8080  /v1  /metrics│    GET /provider/models  ← schema 2.4 manifest
   └──────────┬───────────┘
              │ OpenAI-compatible
   ┌──────────▼───────────┐    one base, five LoRAs, one GPU
   │  vLLM   :8000        │    --enable-lora --lora-modules …
   └──────────────────────┘
```

## 1. Train something worth serving

```bash
python3 model/suwa_lm/train_lora.py --character suwa-tide --epoch 1
```

Repeat per character. Five is where the GPU fills up and the margin appears —
one adapter alone reaches ~16% utilization and clears about $71 a week, which
is not a business.

## 2. Export the adapters vLLM will load

```bash
python3 deploy/vllm/prepare.py
```

Takes the highest epoch per character out of `runs/`, converts it into the PEFT
layout (`adapter_config.json` + weights) under `serving/`, and prints the
`--lora-modules` flags. Characters with no adapter yet are reported and skipped.

Each exported directory carries `suwa_provenance.json` with the sha256 of the
`adapter.pt` it came from — the same hash the chain records, so what is served
can always be tied back to a checkpoint.

## 3. Bring up the GPU

```bash
./deploy/vllm/serve.sh                                  # bare metal
docker compose -f deploy/docker-compose.yml up -d       # or containers
```

A 24B base in bf16 wants ~48GB with headroom for KV cache and adapters — one
H100 or A100 80GB. Budget ~10 minutes for the first model download.

## 4. Bring up the shop

```bash
cd agent
UPSTREAM_BASE_URL=http://localhost:8000/v1 npm run serve
```

| route | what |
|---|---|
| `GET /provider/models` | the schema 2.4 manifest a router reads |
| `GET /v1/models` | the OpenAI-shaped list for everyone else |
| `POST /v1/chat/completions` | streaming and non-streaming, with real `usage` |
| `GET /metrics` | realized $/M, GPU utilization, tokens, apps, runway |
| `GET /healthz` | liveness — never touches the network |
| `GET /ready` | readiness — 503 when the GPU behind it is not answering |

## 5. Prove it before anyone looks

```bash
node deploy/preflight.mjs http://localhost:8080
```

116 checks: manifest validity against the published value domains, both model
lists, streaming and non-streaming completions with usage, and the error codes
that matter. It also prints TTFT and throughput — the two numbers published on
your model page. **Do not send anyone the URL until this exits zero.**

## 5b. Put the numbers where people see them

The vitals page reads `/metrics` straight from the shop:

```
https://your-vitals-page/?shop=https://your-endpoint
```

It colours the three figures that are gates — realized $/M, GPU utilization,
gross — and prints the burn underneath. `STATUS_CORS_ORIGIN` controls which
origin may read `/healthz` and `/metrics`; the billing routes are never shared
cross-origin. The panel renders whether or not the contract is reachable: the
shop and the chain are separate systems and should not share a failure mode.

## 6. Go live, deliberately

Everything ships with `is_ready: false`, so models are staged and invisible.
When preflight passes against the public URL and you have watched it survive
real traffic:

```bash
PROVIDER_IS_READY=1   # in the shop's environment, then restart
```

## Retraining without downtime

The creature trains an epoch every tick. Restarting vLLM per epoch would mean
permanent partial downtime, and under 95% uptime costs routing priority — so
hot-swap instead:

```bash
./deploy/vllm/reload-adapter.sh suwa-tide
```

Requires `VLLM_ALLOW_RUNTIME_LORA_UPDATING=True`, which `serve.sh` and the
compose file both set.

## What this costs, and when it stops costing

| | |
|---|---|
| One H100, on demand | ~$2/hr → **$336/week**, billed idle or not |
| Break-even | ~1.1B tokens/week at the entry price — about 13% utilization |
| Phase 1 gate | **$400/week gross**, ten weeks after listing |

`GET /metrics` reports `selfSustaining` the moment gross covers the machine.
That boolean is the gate, and `weeksOfRunway` is what is left if it does not.

## Operational rules worth keeping

- **Return 429, never queue.** Throughput is measured as output tokens ÷
  generation time *including* queueing, so a queue is indistinguishable from a
  slow model. The shop already passes upstream 429/503 through as 429, which is
  tracked separately from uptime.
- **400 and 404 are free; 500 is not.** User errors are excluded from the
  uptime score, server errors are not. Preflight checks the shop returns the
  right one.
- **Never declare `zdr: true` while `memory.ts` is persisting session facts.**
  It would be a false compliance claim. `COMPLIANCE_ZDR` stays off by default.
- **Point the load balancer at `/ready`, not `/healthz`.** Liveness answering
  200 over a dead GPU is how every routed request becomes a 5xx. `/healthz` is
  for the process supervisor; `/ready` is for anything deciding where traffic goes.
- **Stream immediately.** TTFT is public. Send tokens as they arrive.
