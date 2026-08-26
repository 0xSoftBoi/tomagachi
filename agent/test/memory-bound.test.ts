/**
 * The session store is keyed by something the caller controls, so its size is
 * something the caller controls too. A client that sends a fresh session id
 * per request costs itself nothing and costs us the process.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "suwa-membound-"));
process.env.STATE_DIR = stateDir;
process.env.MEMORY_MAX_SESSIONS = "5";

const { remember, recall, sessionCount } = await import("../src/memory.js");

after(() => rmSync(stateDir, { recursive: true, force: true }));

const user = (content: string) => [{ role: "user", content }];

test("a flood of unique session ids cannot grow the store past its cap", () => {
  for (let i = 0; i < 500; i++) remember(`flood-${i}`, user(`my name is Kit${i}`));
  assert.equal(sessionCount(), 5, "the store must stay bounded no matter what the caller sends");
});

test("eviction drops the oldest, so the live conversation is the one that survives", () => {
  assert.deepEqual(recall("flood-0"), [], "the first session should be long gone");
  assert.deepEqual(recall("flood-499"), ["My name is Kit499"], "the newest must still be there");
});
