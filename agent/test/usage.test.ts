/**
 * The revenue ledger. A bug here does not crash anything — it quietly bills
 * the wrong amount and makes the dashboard lie, which is worse.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "suwa-usage-"));
process.env.STATE_DIR = stateDir;
process.env.GPU_USD_PER_HOUR = "2";
process.env.GPU_COUNT = "1";

const { record, metrics, priceOf } = await import("../src/usage.js");
const { catalog, findCharacter } = await import("../src/characters.js");

after(() => rmSync(stateDir, { recursive: true, force: true }));

const tide = findCharacter("suwa-tide")!;

test("prices prompt and completion tokens separately", () => {
  // $0.60/M in, $1.20/M out.
  assert.equal(priceOf(tide, 1_000_000, 0), 0.6);
  assert.equal(priceOf(tide, 0, 1_000_000), 1.2);
  assert.equal(priceOf(tide, 500_000, 500_000), 0.9);
});

test("every catalog character has a price above the plan's floor", () => {
  for (const c of catalog().characters) {
    assert.ok(
      c.price_usd_per_m.prompt >= 0.6,
      `${c.id} prompt price ${c.price_usd_per_m.prompt} is below the $0.60/M gate`
    );
    assert.ok(c.price_usd_per_m.completion >= c.price_usd_per_m.prompt,
      `${c.id} sells output cheaper than input`);
  }
});

test("metrics aggregate a week of traffic", () => {
  record({ character: "suwa-tide", app: "SillyTavern", promptTokens: 1_000_000, completionTokens: 100_000, latencyMs: 10 }, tide);
  record({ character: "suwa-tide", app: "Janitor AI", promptTokens: 500_000, completionTokens: 50_000, latencyMs: 10 }, tide);

  const m = metrics();
  assert.equal(m.requests, 2);
  assert.equal(m.promptTokens, 1_500_000);
  assert.equal(m.completionTokens, 150_000);
  // (1.5M x 0.6 + 150k x 1.2) / 1e6 = 0.9 + 0.18
  assert.equal(m.grossUsd, 1.08);
  assert.equal(m.realizedUsdPerM, Number((1.08 / 1.65).toFixed(4)));
  assert.equal(m.apps.length, 2);
  assert.equal(m.apps[0].app, "SillyTavern", "apps sort by volume");
});

test("realized $/M clears the pricing gate at catalog prices", () => {
  const m = metrics();
  assert.ok(m.realizedUsdPerM >= 0.6, `realized ${m.realizedUsdPerM} is below the $0.60/M gate`);
});

test("a week of two requests is nowhere near self-sustaining", () => {
  const m = metrics();
  assert.equal(m.gpuCostUsd, 336, "one H100 at $2/hr for 168 hours");
  assert.equal(m.selfSustaining, false);
  assert.ok(m.contributionUsd < 0);
});

test("runway is only known when a treasury is supplied", () => {
  assert.equal(metrics().weeksOfRunway, null);
  const m = metrics(1000);
  // burn = 336 - 1.08
  assert.ok(m.weeksOfRunway !== null && m.weeksOfRunway > 2.9 && m.weeksOfRunway < 3.1);
});

test("a shop covering its machine reports no burn and self-sustaining", () => {
  record({ character: "suwa-tide", app: "HammerAI", promptTokens: 600_000_000, completionTokens: 0, latencyMs: 10 }, tide);
  const m = metrics(1000);
  assert.equal(m.selfSustaining, true, "600M prompt tokens at $0.60/M is $360 > $336");
  assert.equal(m.weeksOfRunway, null, "nothing is burning, so runway is not a number");
});

test("capacity depends on the prompt:completion mix", () => {
  // Prompt tokens prefill ~10x faster than completions decode, so the same
  // token count is a smaller share of the GPU when it is prompt-heavy.
  const promptHeavy = metrics().gpuUtilization;
  assert.ok(promptHeavy > 0 && promptHeavy < 1, `utilization ${promptHeavy} out of range`);
});
