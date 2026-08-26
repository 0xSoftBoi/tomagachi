/**
 * Daily rollups. The gate at week ten asks whether this is growing, and a
 * running total cannot answer that — flat and climbing produce the same one.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "suwa-history-"));
process.env.STATE_DIR = dir;
process.env.HISTORY_DAYS = "28";
process.env.GPU_USD_PER_HOUR = "2";
process.env.GPU_COUNT = "1";

const DAY = 24 * 60 * 60 * 1000;
const day = (ago: number) => new Date(Date.now() - ago * DAY).toISOString();

// Written before import, because the ledger is read once at first use.
writeFileSync(
  join(dir, "usage.jsonl"),
  [
    { at: day(0), character: "suwa-tide", app: "A", promptTokens: 300, completionTokens: 30, revenueUsd: 0.00021, costUsd: 0.00001, latencyMs: 5 },
    { at: day(0), character: "suwa-abyss", app: "B", promptTokens: 100, completionTokens: 10, revenueUsd: 0.00007, costUsd: 0.000005, latencyMs: 5 },
    { at: day(2), character: "suwa-tide", app: "A", promptTokens: 200, completionTokens: 20, revenueUsd: 0.00014, costUsd: 0.000008, latencyMs: 5 },
    // Beyond the window: the file keeps it, the report and memory should not.
    { at: day(40), character: "suwa-tide", app: "A", promptTokens: 999_999, completionTokens: 0, revenueUsd: 99, costUsd: 1, latencyMs: 5 },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n"
);

const { daily, metrics } = await import("../src/usage.js");
after(() => rmSync(dir, { recursive: true, force: true }));

test("one point per day, oldest first, spanning the window", () => {
  const series = daily();
  assert.equal(series.length, 28);
  assert.ok(series[0].date < series[series.length - 1].date, "oldest first");
});

test("empty days are zeros rather than gaps", () => {
  const series = daily();
  const yesterday = series[series.length - 2];
  assert.equal(yesterday.requests, 0);
  assert.equal(yesterday.tokens, 0);
  assert.ok("grossUsd" in yesterday, "a silently closed-up gap reads as continuity");
});

test("a day sums every character that served that day", () => {
  const today = daily()[27];
  assert.equal(today.requests, 2);
  assert.equal(today.tokens, 300 + 30 + 100 + 10);
  assert.ok(Math.abs(today.grossUsd - 0.00028) < 1e-9);
});

test("a quiet day two days back is still on the chart", () => {
  const series = daily();
  const twoBack = series[25];
  assert.equal(twoBack.requests, 1);
  assert.equal(twoBack.tokens, 220);
});

test("realized $/M is computed per day, not carried from the total", () => {
  const today = daily()[27];
  assert.ok(today.realizedUsdPerM > 0.6, `got ${today.realizedUsdPerM}`);
  const empty = daily()[26];
  assert.equal(empty.realizedUsdPerM, 0, "no traffic is not an infinite price");
});

test("rows past the window are excluded from the series and the totals", () => {
  assert.ok(!daily().some((d) => d.grossUsd > 1), "a 40-day-old row must not appear");
  assert.ok(metrics().grossUsd < 1, "nor inflate the trailing week");
});

test("a shorter window can be asked for", () => {
  assert.equal(daily(7).length, 7);
});
