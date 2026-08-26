/**
 * The provider manifest — schema 2.4, served at GET /provider/models.
 *
 * This is not the OpenAI-shaped `/v1/models` list, and mistaking one for the
 * other is the easiest way to fail onboarding. A router discovers what we sell
 * from *this* document: typed input and output modalities, each owning its own
 * constraints, pricing and capacity, with every `cost_usd` as a string so no
 * price ever goes through a float.
 *
 * Two fields decide whether traffic arrives, and both default to safe:
 *   is_ready  — false keeps a model staged and invisible. Flip it deliberately.
 *   capacity  — declared per minute; exceeding it should return 429, which is
 *               tracked separately from uptime. Queueing instead would show up
 *               as bad throughput on the public model page.
 *
 * Validate before sending anyone the URL: `node deploy/preflight.mjs <base>`.
 */
import { config } from "./config.js";
import { zeroDataRetention } from "./retention.js";
import { catalog, type Character } from "./characters.js";

/** A decimal string, never exponent notation: "0.0000006", not "6e-7". */
function usdPerToken(usdPerMillion: number): string {
  const perToken = usdPerMillion / 1e6;
  const fixed = perToken.toFixed(12).replace(/0+$/, "");
  return fixed.endsWith(".") ? fixed + "0" : fixed;
}

/**
 * What one GPU can take in a minute, from the same throughput assumptions the
 * dashboard and research/unit_economics.py use. Declaring capacity honestly is
 * how we get 429s instead of timeouts when the fleet is full.
 */
function capacityPerMinute(): { prompt: number; completion: number; requests: number } {
  const gpus = Math.max(config.gpuCount, 1);
  return {
    prompt: Math.floor(config.prefillTokensPerSec * 60 * gpus),
    completion: Math.floor(config.decodeTokensPerSec * 60 * gpus),
    requests: config.capacityRequestsPerMinute,
  };
}

function modelDocument(character: Character, base: string) {
  const cap = capacityPerMinute();
  const maxOutput = Math.min(config.serveMaxOutputTokens, config.serveContextLength);

  return {
    schema_version: "2.4",

    // The exact identifier a router will send back to us in `model`.
    id: `${config.providerSlug}/${character.id}`,
    name: `${config.providerName}: ${character.name}`,
    // Set once the 90-day window has passed and the weights are public.
    hugging_face_id: config.hfRepo ?? "",
    created: config.modelsCreatedAt,
    quantization: config.servedQuantization,
    description: character.blurb,

    input_modalities: [
      {
        type: "text",
        supported_inputs: {
          max_context_length: { value: config.serveContextLength, unit: "token" },
        },
        pricing: [
          { type: "prompt", unit: "token", cost_usd: usdPerToken(character.price_usd_per_m.prompt) },
        ],
        capacity: [{ type: "prompt", unit: "token", per: "minute", value: cap.prompt }],
      },
    ],

    output_modalities: [
      {
        type: "text",
        max_length: { value: maxOutput, unit: "token" },
        streaming: true,
        // Only what we actually forward upstream. Claiming a parameter we drop
        // is a silent quality bug for whoever sets it.
        supported_parameters: {
          temperature: { type: "range", min: 0, max: 2 },
          top_p: { type: "range", min: 0, max: 1 },
          max_tokens: { type: "integer", min: 1, max: maxOutput, unit: "token" },
          stop: { type: "array", max_items: 4 },
          frequency_penalty: { type: "range", min: -2, max: 2 },
          presence_penalty: { type: "range", min: -2, max: 2 },
          seed: { type: "integer", min: 0 },
        },
        pricing: [
          {
            type: "completion",
            unit: "token",
            cost_usd: usdPerToken(character.price_usd_per_m.completion),
          },
        ],
        capacity: [{ type: "completion", unit: "token", per: "minute", value: cap.completion }],
      },
    ],

    capacity: [{ type: "request", unit: "request", per: "minute", value: cap.requests }],

    is_ready: config.providerIsReady,
    is_free: false,
    discount_to_user: 0,
    datacenters: config.datacenters,
    deployment_region: config.deploymentRegion,
    // Read from what the process actually does, not from a separate promise:
    // ZERO_DATA_RETENTION=1 is what turns off session memory and capture, and
    // it is the only thing that can turn this true.
    compliance: { zdr: zeroDataRetention(), hipaa: false },
  };
}

export function providerManifest(): { data: ReturnType<typeof modelDocument>[] } {
  const cat = catalog();
  return { data: cat.characters.map((c) => modelDocument(c, cat.base)) };
}
