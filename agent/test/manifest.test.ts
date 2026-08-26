/**
 * The provider manifest. Deliberately independent of deploy/preflight.mjs:
 * preflight tests a live URL (possibly not even ours), this tests the function
 * that builds the document. A rule worth enforcing is worth enforcing twice.
 *
 * Value domains are from the published provider OpenAPI schema.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.STATE_DIR = process.env.STATE_DIR ?? "/tmp/suwa-manifest-test";
process.env.PROVIDER_SLUG = "suwappu";

const { providerManifest } = await import("../src/provider-manifest.js");
const { catalog } = await import("../src/characters.js");

const INPUT_PRICING_TYPES = ["prompt", "cached_prompt", "cache_write"];
const OUTPUT_PRICING_TYPES = ["completion", "internal_reasoning"];
const PRICING_UNITS = ["token", "image", "megapixel", "second", "character", "request", "search"];
const CAPACITY_WINDOWS = ["minute", "hour", "day"];
const QUANTIZATIONS = ["int4", "int8", "fp4", "mxfp4", "nvfp4", "fp6", "fp8", "mxfp8", "fp16", "bf16", "fp32"];

const docs = providerManifest().data;

test("one document per character in the catalog", () => {
  assert.equal(docs.length, catalog().characters.length);
  assert.ok(docs.length > 0);
});

test("every document carries the required root fields", () => {
  for (const doc of docs) {
    for (const field of ["schema_version", "id", "name", "input_modalities", "output_modalities"]) {
      assert.ok((doc as any)[field] !== undefined, `${doc.id} is missing ${field}`);
    }
    assert.equal(doc.schema_version, "2.4");
    assert.ok(doc.input_modalities.length > 0);
    assert.ok(doc.output_modalities.length > 0);
  }
});

test("ids are namespaced with the provider slug", () => {
  for (const doc of docs) assert.match(doc.id, /^suwappu\/suwa-/);
});

test("every price is a decimal string, never a number or exponent", () => {
  for (const doc of docs) {
    const prices = [
      ...doc.input_modalities.flatMap((m: any) => m.pricing ?? []),
      ...doc.output_modalities.flatMap((m: any) => m.pricing ?? []),
    ];
    assert.ok(prices.length > 0, `${doc.id} declares no prices`);
    for (const p of prices) {
      assert.equal(typeof p.cost_usd, "string", `${doc.id} ${p.type} cost_usd is not a string`);
      assert.match(p.cost_usd, /^\d+(\.\d+)?$/, `${doc.id} ${p.type} cost_usd "${p.cost_usd}" is not decimal`);
      assert.ok(!/e/i.test(p.cost_usd), `${doc.id} ${p.type} used exponent notation`);
    }
  }
});

test("prices round-trip to the catalog figures", () => {
  for (const doc of docs) {
    const id = doc.id.split("/")[1];
    const character = catalog().characters.find((c) => c.id === id)!;
    const prompt = doc.input_modalities[0].pricing.find((p: any) => p.type === "prompt");
    const completion = doc.output_modalities[0].pricing.find((p: any) => p.type === "completion");
    assert.equal(Number(prompt.cost_usd) * 1e6, character.price_usd_per_m.prompt);
    assert.equal(Number(completion.cost_usd) * 1e6, character.price_usd_per_m.completion);
  }
});

test("pricing types, units, capacity windows and quantization are in the schema's domains", () => {
  for (const doc of docs) {
    assert.ok(QUANTIZATIONS.includes(doc.quantization), `${doc.id} quantization "${doc.quantization}"`);
    for (const m of doc.input_modalities) {
      for (const p of m.pricing ?? []) {
        assert.ok(INPUT_PRICING_TYPES.includes(p.type));
        assert.ok(PRICING_UNITS.includes(p.unit));
      }
      for (const c of m.capacity ?? []) {
        assert.ok(CAPACITY_WINDOWS.includes(c.per));
        assert.ok(Number.isInteger(c.value) && c.value > 0);
      }
    }
    for (const m of doc.output_modalities) {
      for (const p of m.pricing ?? []) {
        assert.ok(OUTPUT_PRICING_TYPES.includes(p.type));
        assert.ok(PRICING_UNITS.includes(p.unit));
      }
    }
  }
});

test("text output declares streaming", () => {
  for (const doc of docs) {
    const text = doc.output_modalities.find((m: any) => m.type === "text");
    assert.equal(text?.streaming, true, `${doc.id} does not declare streaming`);
  }
});

test("nothing is live by default", () => {
  for (const doc of docs) {
    assert.equal(doc.is_ready, false, `${doc.id} would go live without PROVIDER_IS_READY=1`);
  }
});

test("zero data retention is not claimed while session memory persists", () => {
  // This process runs without ZERO_DATA_RETENTION, so memory.ts and capture.ts
  // are both live and the honest answer is no. test/zdr.test.ts is the other
  // half: with the switch on, both are off and the answer flips.
  for (const doc of docs) {
    assert.equal(doc.compliance.zdr, false,
      `${doc.id} claims zdr — memory.ts writes session facts to disk, so that would be false`);
  }
});

test("max_tokens never exceeds the declared context length", () => {
  for (const doc of docs) {
    const text = doc.output_modalities.find((m: any) => m.type === "text")!;
    const ctx = doc.input_modalities[0].supported_inputs.max_context_length.value;
    assert.ok(text.max_length.value <= ctx, `${doc.id} promises more output than context`);
    assert.equal(text.supported_parameters.max_tokens.max, text.max_length.value);
  }
});
