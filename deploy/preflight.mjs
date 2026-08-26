#!/usr/bin/env node
/**
 * Acceptance tests to run before telling anyone the endpoint exists.
 *
 *   node deploy/preflight.mjs http://localhost:8080 [--key sk-...] [--model suwa-tide]
 *
 * Checks the things onboarding actually fails on:
 *
 *   1. the provider manifest validates against schema 2.4 — required fields,
 *      enum membership, and every cost_usd a decimal string with no exponent
 *   2. /v1/models answers for everyone who is not a router
 *   3. a non-streaming completion reports honest `usage`
 *   4. a streaming completion emits deltas, a usage frame, and [DONE]
 *   5. a bad request is a 400 and an unknown model is a 404 — both are excluded
 *      from the uptime score, while a 500 would not be
 *   6. TTFT and throughput, the two numbers published on the model page
 *
 * Exits non-zero if anything fails. No dependencies.
 */

const BASE = (process.argv[2] ?? "http://localhost:8080").replace(/\/+$/, "");
const KEY = argFlag("--key");
const MODEL = argFlag("--model");

function argFlag(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

// Value domains lifted from the provider OpenAPI schema. Kept here so preflight
// runs with nothing installed and no network beyond the endpoint under test.
const INPUT_PRICING_TYPES = ["prompt", "cached_prompt", "cache_write"];
const OUTPUT_PRICING_TYPES = ["completion", "internal_reasoning"];
const PRICING_UNITS = ["token", "image", "megapixel", "second", "character", "request", "search"];
const CAPACITY_WINDOWS = ["minute", "hour", "day"];
const QUANTIZATIONS = [
  "int4", "int8", "fp4", "mxfp4", "nvfp4", "fp6", "fp8", "mxfp8", "fp16", "bf16", "fp32",
];

let failures = 0;
let checks = 0;

function check(ok, label, detail = "") {
  checks++;
  if (ok) {
    console.log(`  \x1b[32mpass\x1b[0m  ${label}`);
  } else {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? ` — ${detail}` : ""}`);
  }
  return ok;
}

function section(title) {
  console.log(`\n${title}`);
}

const headers = () => {
  const h = { "content-type": "application/json", "x-title": "suwa-preflight" };
  if (KEY) h.authorization = `Bearer ${KEY}`;
  return h;
};

/** A price must be a plain decimal string: "0.0000006", never 6e-7 or a number. */
function validPriceString(v) {
  return typeof v === "string" && /^\d+(\.\d+)?$/.test(v);
}

function validateModelDocument(doc, index) {
  const where = `model[${index}]${doc?.id ? ` ${doc.id}` : ""}`;
  for (const field of ["schema_version", "id", "name", "input_modalities", "output_modalities"]) {
    check(doc?.[field] !== undefined, `${where}: has ${field}`);
  }
  check(doc?.schema_version === "2.4", `${where}: schema_version is "2.4"`, String(doc?.schema_version));
  check(Array.isArray(doc?.input_modalities) && doc.input_modalities.length > 0,
    `${where}: at least one input modality`);
  check(Array.isArray(doc?.output_modalities) && doc.output_modalities.length > 0,
    `${where}: at least one output modality`);

  if (doc?.quantization != null) {
    check(QUANTIZATIONS.includes(doc.quantization),
      `${where}: quantization is a known value`, String(doc.quantization));
  }

  const walk = (modalities, kind, allowedTypes) => {
    for (const modality of modalities ?? []) {
      for (const price of modality.pricing ?? []) {
        check(allowedTypes.includes(price.type),
          `${where}: ${kind} pricing type "${price.type}" is valid`);
        check(PRICING_UNITS.includes(price.unit),
          `${where}: ${kind} pricing unit "${price.unit}" is valid`);
        check(validPriceString(price.cost_usd),
          `${where}: ${kind} cost_usd is a decimal string`, JSON.stringify(price.cost_usd));
      }
      for (const cap of modality.capacity ?? []) {
        check(CAPACITY_WINDOWS.includes(cap.per),
          `${where}: capacity window "${cap.per}" is valid`);
        check(Number.isInteger(cap.value) && cap.value > 0,
          `${where}: capacity value is a positive integer`, String(cap.value));
      }
    }
  };
  walk(doc?.input_modalities, "input", INPUT_PRICING_TYPES);
  walk(doc?.output_modalities, "output", OUTPUT_PRICING_TYPES);

  const text = (doc?.output_modalities ?? []).find((m) => m.type === "text");
  check(text?.streaming === true, `${where}: text output declares streaming`);

  if (doc?.compliance?.zdr === true) {
    console.log(`  \x1b[33mnote\x1b[0m  ${where}: declares zero data retention — ` +
      `make sure no session store is persisting prompts`);
  }
  return doc?.id;
}

async function main() {
  console.log(`preflight → ${BASE}`);

  // 1. provider manifest --------------------------------------------------
  section("provider manifest (schema 2.4)");
  let firstId = MODEL;
  let staged = 0;
  try {
    const res = await fetch(`${BASE}/provider/models`, { headers: headers() });
    check(res.ok, "GET /provider/models responds 200", `got ${res.status}`);
    const body = await res.json();
    check(Array.isArray(body?.data) && body.data.length > 0, "manifest has a non-empty data array");
    (body.data ?? []).forEach((doc, i) => {
      const id = validateModelDocument(doc, i);
      if (!firstId && i === 0) firstId = id;
      if (doc?.is_ready === false) staged++;
    });
    if (staged) {
      console.log(`  \x1b[33mnote\x1b[0m  ${staged}/${body.data.length} models have ` +
        `is_ready:false — staged, and invisible until you flip PROVIDER_IS_READY=1`);
    }
  } catch (e) {
    check(false, "GET /provider/models", e.message);
  }

  // 2. openai-compatible model list ---------------------------------------
  section("openai-compatible surface");
  try {
    const res = await fetch(`${BASE}/v1/models`, { headers: headers() });
    check(res.ok, "GET /v1/models responds 200", `got ${res.status}`);
    const body = await res.json();
    check(Array.isArray(body?.data) && body.data.length > 0, "/v1/models lists models");
    if (!firstId) firstId = body?.data?.[0]?.id;
  } catch (e) {
    check(false, "GET /v1/models", e.message);
  }

  if (!firstId) {
    console.log("\nno model id to exercise — stopping");
    return finish();
  }
  console.log(`  using model: ${firstId}`);

  const messages = [{ role: "user", content: "say one short sentence." }];

  // 3. non-streaming ------------------------------------------------------
  section("non-streaming completion");
  try {
    const started = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: firstId, messages, max_tokens: 40 }),
    });
    check(res.ok, "responds 200", `got ${res.status}: ${(await res.clone().text()).slice(0, 160)}`);
    const body = await res.json();
    check(Boolean(body?.choices?.[0]?.message?.content), "returns message content");
    check(Number.isFinite(body?.usage?.prompt_tokens), "usage.prompt_tokens present");
    check(Number.isFinite(body?.usage?.completion_tokens), "usage.completion_tokens present");
    console.log(`  \x1b[90minfo\x1b[0m  round trip ${Date.now() - started}ms, ` +
      `${body?.usage?.prompt_tokens}+${body?.usage?.completion_tokens} tokens`);
  } catch (e) {
    check(false, "non-streaming completion", e.message);
  }

  // 4. streaming ----------------------------------------------------------
  section("streaming completion");
  try {
    const started = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: firstId, messages, max_tokens: 64, stream: true }),
    });
    check(res.ok, "responds 200", `got ${res.status}`);
    check((res.headers.get("content-type") ?? "").includes("text/event-stream"),
      "content-type is text/event-stream", res.headers.get("content-type") ?? "");

    let ttft = null;
    let deltas = 0;
    let sawDone = false;
    let usage = null;
    let buffered = "";
    for await (const chunk of res.body) {
      buffered += new TextDecoder().decode(chunk);
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { sawDone = true; continue; }
        if (!data) continue;
        try {
          const frame = JSON.parse(data);
          for (const choice of frame.choices ?? []) {
            if (choice.delta?.content) {
              deltas++;
              if (ttft === null) ttft = Date.now() - started;
            }
          }
          if (frame.usage) usage = frame.usage;
        } catch { /* frame split across chunks */ }
      }
    }
    const elapsed = Date.now() - started;
    check(deltas > 0, "emitted content deltas", `${deltas}`);
    check(sawDone, "terminated with [DONE]");
    check(usage !== null, "sent a usage frame (stream_options.include_usage)");
    if (ttft !== null) {
      const completion = usage?.completion_tokens ?? deltas;
      const genMs = Math.max(elapsed - ttft, 1);
      console.log(`  \x1b[90minfo\x1b[0m  TTFT ${ttft}ms, ` +
        `throughput ${(completion / (genMs / 1000)).toFixed(1)} tok/s ` +
        `(both are published on your model page)`);
    }
  } catch (e) {
    check(false, "streaming completion", e.message);
  }

  // 5. error shapes -------------------------------------------------------
  section("error handling (400/404 are free; 500 is not)");
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST", headers: headers(), body: "{not json",
    });
    check(res.status === 400, "malformed body returns 400, not 500", `got ${res.status}`);
  } catch (e) {
    check(false, "malformed body", e.message);
  }
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "definitely-not-a-model", messages }),
    });
    check(res.status === 404, "unknown model returns 404", `got ${res.status}`);
  } catch (e) {
    check(false, "unknown model", e.message);
  }
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST", headers: headers(), body: JSON.stringify({ model: firstId }),
    });
    check(res.status === 400, "missing messages returns 400", `got ${res.status}`);
  } catch (e) {
    check(false, "missing messages", e.message);
  }

  finish();
}

function finish() {
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) {
    console.log("\x1b[31mnot ready to list\x1b[0m");
    process.exit(1);
  }
  console.log("\x1b[32mready to list\x1b[0m — next: deploy/openrouter-application.md");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
