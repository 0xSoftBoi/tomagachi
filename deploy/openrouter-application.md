# Listing checklist

Everything a provider application asks for, what the repo already answers, and
the handful of decisions that are yours rather than the code's. The form is at
**https://openrouter.ai/how-to-list**.

Work top to bottom. Nothing here is guesswork about the requirements — it maps
to the published provider integration docs, and `deploy/preflight.mjs` tests the
parts a machine can test.

## A. Technical — done in the repo

| Requirement | Where | State |
|---|---|---|
| List-models endpoint, **schema 2.4** | `agent/src/provider-manifest.ts` → `GET /provider/models` | ✅ built, validated by preflight |
| Typed input + output modalities | same | ✅ text in, text out |
| `cost_usd` as decimal **strings** | same | ✅ `"0.000000600"`, never `6e-7` |
| Declared capacity per minute | same, from the GPU throughput config | ✅ prompt, completion, requests |
| OpenAI-compatible chat completions | `agent/src/serve.ts` | ✅ |
| SSE streaming | same | ✅ with `stream_options.include_usage` |
| Honest `usage` on every response | `agent/src/usage.ts` | ✅ upstream figures, estimate only as fallback |
| 429 under load rather than queueing | `serve.ts` passes upstream 429/503 through | ✅ |
| 400/404 for user errors, not 500 | `serve.ts` | ✅ preflight asserts all three |
| `is_ready` launch control | `PROVIDER_IS_READY`, default `0` | ✅ staged until you flip it |

Run this and paste the result into the application; it is the strongest thing
you can send:

```bash
node deploy/preflight.mjs https://your-public-endpoint
```

## B. Decisions only you can make

Fill each of these in before applying. They are environment variables on the
shop, listed in `agent/.env.example`.

| Decision | Variable | Notes |
|---|---|---|
| Provider slug and display name | `PROVIDER_SLUG`, `PROVIDER_NAME` | becomes `suwappu/suwa-tide` in the manifest |
| Public HTTPS endpoint | — | needs a real certificate; a router will not call plain HTTP |
| Auth for the router | `SERVE_API_KEY` | a bearer token you issue and rotate |
| Datacenter country + region | `DATACENTERS` | ISO 3166-1 alpha-2, e.g. `US:us-east-1`; must be true |
| Deployment region label | `DEPLOYMENT_REGION` | display only; coordinate the vocabulary before publishing |
| Zero data retention claim | `COMPLIANCE_ZDR` | **leave off** while session memory persists to disk |
| Declared capacity | `CAPACITY_REQUESTS_PER_MINUTE` | under-declare and get 429s; over-declare and get timeouts |
| Quantization served | `SERVED_QUANTIZATION` | must match how vLLM was launched |
| Price per character | `model/characters.json` | entry price is $0.60/$1.20 per M — see the plan |

## C. Getting paid — the part that is not code

A router pays providers automatically, by **auto top-up or invoicing**. Both
need an entity that can hold an account and be paid.

- The on-chain treasury **cannot** be the merchant of record. An operating
  entity takes the revenue; the treasury funds compute and holds the game.
- Keep NOM non-revenue-bearing. The moment it carries a claim on these
  proceeds, the conversation stops being about margins.
- **Get actual counsel on the entity and the token before this touches money.**
  Nothing in this repo is legal advice.

The x402 route (Phase 3) is the one where revenue can settle back to the
contract directly. It starts with no distribution, which is why it runs behind
this listing rather than instead of it.

## D. What happens after you are listed

Uptime is `successful ÷ total`, excluding user errors, and it decides how much
traffic you see:

| Uptime | Consequence |
|---|---|
| 95%+ | normal routing |
| 80–94% | degraded, lower priority |
| <80% | fallback only |

Nothing is calculated until 100+ requests, so the first hundred are a free
window to find the failure modes. Use them.

TTFT and throughput are published on your model page. Throughput counts
queueing, so a queue reads as a slow model. Hot-swap adapters rather than
restarting (`deploy/vllm/reload-adapter.sh`) — a restart per training epoch
would be permanent partial downtime.

## E. The week-10 gate

From the operating plan, restated here because it is easy to forget once
something is live:

> **If gross is under $400/week ten weeks after listing, the wedge is wrong.**
> Stop, publish everything, and the treasury is out less than $2,500.

`GET /metrics` reports `grossUsd` for the trailing 7 days and `selfSustaining`
once revenue covers the machine. Those are the two numbers the decision turns
on. Write the date in a calendar now, while it is still cheap to walk away.
