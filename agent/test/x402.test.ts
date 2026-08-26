/**
 * Pay-per-call. This is the only file in the repo that decides whether work
 * gets done for free, so every test here is a way it could give away
 * inference or overcharge for it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.STATE_DIR = process.env.STATE_DIR ?? "/tmp/suwa-x402-test";
process.env.X402_FACILITATOR_URL = "https://facilitator.invalid";
process.env.X402_PAY_TO = "0xCreature";
process.env.X402_MIN_CHARGE_USD = "0.0001";

const x402 = await import("../src/x402.js");
const { findCharacter } = await import("../src/characters.js");
const tide = findCharacter("suwa-tide")!;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a quote is built from the character's real prices", () => {
  // $0.60/M prompt, $1.20/M completion.
  assert.equal(x402.quote(tide, 1_000_000, 0), 0.6);
  assert.equal(x402.quote(tide, 0, 1_000_000), 1.2);
});

test("a dust call still costs something", () => {
  assert.equal(x402.quote(tide, 1, 1), 0.0001, "rounding must not make a call free");
});

test("atomic amounts round up, so a quote is never short", () => {
  assert.equal(x402.toAtomic(1), "1000000");
  assert.equal(x402.toAtomic(0.0000001), "1", "a fraction of a unit still owes a unit");
});

test("the challenge tells a caller everything needed to pay", () => {
  const reqs = x402.requirements(tide, 1000, 500);
  const body = x402.challenge(reqs);
  assert.equal(body.x402Version, 1);
  const accept = body.accepts[0];
  assert.equal(accept.payTo, "0xCreature");
  assert.equal(accept.network, "base");
  assert.equal(accept.scheme, "exact");
  assert.ok(Number(accept.maxAmountRequired) > 0);
  assert.match(accept.resource, /suwa-tide/);
});

test("a valid payment verifies", async () => {
  const r = await x402.verify("payload", x402.requirements(tide, 10, 10),
    (async () => json({ isValid: true, payer: "0xKit" })) as any);
  assert.equal(r.ok, true);
  assert.equal(r.payer, "0xKit");
});

test("an invalid payment is refused with the facilitator's reason", async () => {
  const r = await x402.verify("payload", x402.requirements(tide, 10, 10),
    (async () => json({ isValid: false, invalidReason: "insufficient_funds" })) as any);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "insufficient_funds");
});

test("an unreachable facilitator refuses the request rather than allowing it", async () => {
  const r = await x402.verify("payload", x402.requirements(tide, 10, 10),
    (async () => { throw new Error("ECONNREFUSED"); }) as any);
  assert.equal(r.ok, false, "an endpoint that opens when its payment check errors is a free endpoint");
  assert.match(r.reason!, /verification unavailable/);
});

test("a facilitator answering nonsense is not a yes", async () => {
  for (const body of [{}, { isValid: "true" }, { ok: true }, null]) {
    const r = await x402.verify("p", x402.requirements(tide, 10, 10), (async () => json(body)) as any);
    assert.equal(r.ok, false, `treated ${JSON.stringify(body)} as valid`);
  }
});

test("a facilitator error status is not a yes", async () => {
  const r = await x402.verify("p", x402.requirements(tide, 10, 10),
    (async () => json({ isValid: true }, 500)) as any);
  assert.equal(r.ok, false, "a 500 carrying a valid-looking body is still a failure");
});

test("settlement charges actual usage, not the quote", async () => {
  let sent: any;
  const reqs = x402.requirements(tide, 1000, 4000); // quoted for 4000 completion tokens
  await x402.settle("p", reqs, 0.0005, (async (_u: any, init: any) => {
    sent = JSON.parse(init.body);
    return json({ success: true, transaction: "0xabc" });
  }) as any);
  assert.equal(sent.paymentRequirements.maxAmountRequired, "500",
    "nobody is charged for tokens they did not receive");
  assert.notEqual(sent.paymentRequirements.maxAmountRequired, reqs.maxAmountRequired);
});

test("a failed settlement is reported, not thrown — the completion already shipped", async () => {
  const r = await x402.settle("p", x402.requirements(tide, 10, 10), 0.001,
    (async () => { throw new Error("chain reorg"); }) as any);
  assert.equal(r.settled, false);
  assert.match(r.reason!, /chain reorg/);
  assert.equal(r.amount, "1000", "the debt is still recorded at the right size");
});

test("the payment-response header round-trips the outcome", () => {
  const header = x402.paymentResponseHeader({ settled: true, txHash: "0xabc", amount: "500" });
  const decoded = JSON.parse(Buffer.from(header, "base64").toString());
  assert.deepEqual(decoded, { success: true, transaction: "0xabc", amount: "500" });
});
