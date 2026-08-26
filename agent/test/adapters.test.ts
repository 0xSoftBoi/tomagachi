/**
 * Publishing a trained epoch to the running GPU.
 *
 * The rule under test is mostly about what must NOT happen: by the time this
 * runs the weights exist, the eval passed the gate, and the hash is on-chain.
 * A serving hiccup must never cost a good epoch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.STATE_DIR = process.env.STATE_DIR ?? "/tmp/suwa-adapters-test";
process.env.UPSTREAM_BASE_URL = "http://gpu.invalid/v1";

const { reloadAdapter } = await import("../src/adapters.js");

const okResponse = () => new Response("{}", { status: 200 });

test("asks the server to swap the adapter in place", async () => {
  let seen: any;
  await reloadAdapter("suwa-tide", "/serving/suwa-tide", (async (url: any, init: any) => {
    seen = { url: String(url), body: JSON.parse(init.body) };
    return okResponse();
  }) as any);

  assert.match(seen.url, /\/load_lora_adapter$/);
  assert.equal(seen.body.lora_name, "suwa-tide");
  assert.equal(seen.body.lora_path, "/serving/suwa-tide");
  assert.equal(seen.body.load_inplace, true,
    "without in-place, the second epoch is a duplicate-name error rather than an upgrade");
});

test("a successful swap is reported as one", async () => {
  const r = await reloadAdapter("suwa-tide", "/p", (async () => okResponse()) as any);
  assert.equal(r.ok, true);
});

test("a rejected swap is reported, not thrown", async () => {
  const r = await reloadAdapter("suwa-tide", "/p", (async () =>
    new Response("adapter not found", { status: 400 })) as any);
  assert.equal(r.ok, false);
  assert.match(r.detail, /400/);
});

test("an unreachable GPU is reported, not thrown", async () => {
  const r = await reloadAdapter("suwa-tide", "/p", (async () => {
    throw new Error("ECONNREFUSED");
  }) as any);
  assert.equal(r.ok, false, "a serving problem must never cost an epoch that already passed the gate");
  assert.match(r.detail, /ECONNREFUSED/);
});
