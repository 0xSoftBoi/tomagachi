# Who pays an independent character-model operator, in 2026

The Bittensor memo answered a narrow question and left a wider one open: if not
a subnet, then where? This is the scan of the whole agent economy — app stores,
bot platforms, creator programs, enterprise agent marketplaces, model hubs, and
the payment rails underneath all of them — asked from one position: we have five
fine-tuned character adapters and an OpenAI-compatible endpoint that serves
them. Who routes money to that?

`python3 research/agent_channels.py` reproduces the table and the arithmetic.

## The finding

**The channel that pays best is the one with no gatekeeper, and we are already
built for it.** Janitor AI's model setting takes an arbitrary OpenAI-compatible
URL and key. So does SillyTavern. So does every client in the roleplay stack.
Janitor AI alone draws **117 million visits a month**. Nobody approves you,
nobody invoices you, and nobody takes a cut — a user pastes a URL.

That is exactly what `agent/src/serve.ts` is. The thing we thought we were
blocked on — `provider-apply`, an entity that can be invoiced — was a
requirement of *one distribution channel*, not of the business.

Sized against our own list prices and the measured prompt:completion mix of the
closest live comparable:

```
one committed user (200 msgs/day)          $3.77/wk
week-10 gate         $400/wk    needs        106 committed users
scenario B         $1,701/wk    needs        451 committed users
```

A hundred people. Against a hundred and seventeen million monthly visits to one
site whose settings page has a box for our URL.

## The whole table

| channel | pays for | to all creators | gate |
|---|---|---|---|
| OpenRouter | tokens served, invoiced monthly | $1.8B/yr flows through the catalog | entity + HTTPS + approval |
| **Direct (BYO endpoint)** | tokens served, billed by us | not intermediated | **HTTPS only** |
| Poe | per message, creator sets the price | $100k total by mid-2026 | Stripe account, US only |
| Civitai | per generation using your adapter | $43k in March, 254 creators | images only |
| GPT Store | usage revenue share | creators report a $100–500/mo ceiling | OpenAI approval |
| Claude Skills | distribution, not revenue | nothing | — |
| Hugging Face | nothing | no per-query share to authors | — |
| Enterprise agent marketplaces | outcomes, B2B | Intercom Fin: $0.99/resolved ticket | vetting + enterprise sales |
| Bittensor | emissions, not customers | $99/wk per average miner UID | registration TAO + GPU |

### What each one is actually worth

**Civitai is the closest working analogue and the most useful calibration.** It
is a creator program that pays per *use of a fine-tuned adapter* — the exact
transaction we want, one modality over. $43,000 paid in March 2026 across 254
creators: an average of **$226/month**, or $39/wk. The top earner made $8,500 in
a month, which is roughly our scenario B. So the shape works, the median is
pocket money, and the ceiling is a real living. That is the honest distribution
of this business, and it is worth internalising before optimism about volume.

**Poe is a real rail with a small pool.** Creators set a price per message, up
to $10,000 per thousand messages, and get paid through Stripe. But a little over
**$100,000 total** has been paid to all bot makers by mid-2026. The mechanism is
excellent and the market is tiny. Worth a listing for distribution; not worth
planning around.

**The GPT Store pays, badly.** Usage revenue share exists; creators report a
$100–500/month ceiling outside the top fraction of a percent. The commentary
that the actual money is B2B consulting is the tell.

**Hugging Face pays nothing, twice confirmed.** No per-query revenue share to
model authors, then or now. Monetisation there is indirect — a Space as a demo
funnel for something you sell elsewhere. This is the same wall the first scan
hit at 669 downloads: a hub is distribution, never a billing surface.

**Claude Skills is free distribution.** Anthropic launched a marketplace in
March 2026 with Snowflake, GitLab and Harvey as partners. No creator revenue
mechanism yet.

**The enterprise agent marketplaces are where the real money is, and it is not
our money.** Salesforce AgentExchange lists ~14,000 agents; Microsoft
Marketplace 11,000 models and 4,000+ AI apps. Pricing has moved to outcomes —
Intercom's Fin charges $0.99 per *resolved ticket*, which is the single most
interesting pricing fact in this scan, because it prices a result rather than a
token. But the gate is vendor vetting and an enterprise sales motion, and the
product is a support agent, not a character. Right lane, wrong vehicle.

**The companion market itself is real and growing:** ~$120M/yr in consumer
mobile revenue, Character.AI at $50M with ~20M MAU, MiniMax's Talkie at ~$70M,
Janitor AI at 117M visits/month. None of these pay outside creators for models
— they *are* the demand our direct channel serves.

## The rail question, which turned out to be settled

The earlier plan treated x402 as the awkward crypto-flavoured option and
OpenRouter's monthly invoice as the grown-up one. That is out of date:

- x402 has processed roughly **165 million agent transactions**, with v2
  shipping in December 2025.
- **Stripe integrated x402 in February 2026** for USDC on Base. Settlement is
  on-chain; the merchant can take the proceeds in fiat.
- The comparative reading across ACP, AP2, UCP and x402 is explicit: for an API
  that charges per call, x402 is the one to start with. AP2 is an authorization
  framework, ACP negotiates a cart — neither moves money per request.

So `agent/src/x402.ts` is not a hedge against the invoice route. It is the
mainstream rail for exactly our shape of product, with a fiat off-ramp, and it
is already built and verified end to end.

## What this changes

1. **`provider-apply` is not the critical path.** It is one channel, gated on a
   legal entity, and it can proceed whenever that entity exists. The direct
   channel needs none of it.
2. **The critical path is a public HTTPS endpoint.** That single item unblocks
   the direct channel, and it is also the one thing `provider-apply` needs that
   we control. Everything else in the shop — persona, memory, billing, the x402
   gate, rate limits, drain, the manifest — is built and tested.
3. **The gate is ~106 people, not a marketplace listing.** That reframes the
   go-to-market from "get approved by OpenRouter" to "be the endpoint a hundred
   roleplay users paste into their client", which is a distribution problem in
   communities we can reach directly.
4. **Watch outcome pricing.** $0.99 per resolved ticket is the pricing idea
   worth stealing eventually — charging for a result rather than a token is how
   the enterprise lane escaped the commodity trap we measured. It does not fit a
   character today, but it is the direction the market is moving.

## Verdict

Stop treating distribution as a permission problem. The largest gated channel is
worth applying to when there is an entity; the ungated one is worth serving now,
needs about a hundred committed users to cover the machine, and requires exactly
one thing we do not yet have: a public URL.

Sources: [Poe creator monetization](https://creator.poe.com/docs/resources/creator-monetization) ·
[Civitai 2026 Creator Program](https://civitai.com/articles/33294/the-2026-creator-program-the-full-picture) ·
[OpenAI Apps SDK monetization](https://developers.openai.com/apps-sdk/build/monetization) ·
[GPT Store creator economics](https://www.digitalapplied.com/blog/gpt-store-custom-gpts-business-guide-2026) ·
[HF Inference Providers](https://huggingface.co/docs/inference-providers/index) ·
[AI agent marketplaces 2026](https://www.mintmcp.com/blog/ai-agent-marketplaces) ·
[AI companion market](https://www.roborhythms.com/ai-companion-app-market-2026/) ·
[Character.AI statistics](https://www.businessofapps.com/data/character-ai-statistics/) ·
[SillyTavern custom endpoints](https://docs.sillytavern.app/usage/api-connections/openai/) ·
[Janitor AI custom proxies](https://jaiproxy.com/) ·
[agent payment protocols compared](https://atxp.ai/blog/agent-payment-protocols-compared/) ·
[x402 in 2026](https://www.rzlt.io/blog/agentic-payments-2026-x402-explainer)
