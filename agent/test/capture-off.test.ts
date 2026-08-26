/**
 * The default. This runs in its own file because the setting is read at import
 * time, and "off unless asked" is the claim most worth proving separately.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "suwa-capture-off-"));
process.env.STATE_DIR = join(dir, "state");
process.env.CAPTURE_DIR = join(dir, "captured");
delete process.env.CAPTURE_TRANSCRIPTS; // the shipping default

const { capture } = await import("../src/capture.js");
after(() => rmSync(dir, { recursive: true, force: true }));

test("nothing is captured unless capture was explicitly turned on", () => {
  const row = capture({
    character: "suwa-tide",
    app: "SillyTavern",
    messages: [{ role: "user", content: "something private" }],
    completion: "a reply",
    refused: false,
  });
  assert.equal(row, null);
  assert.equal(existsSync(join(dir, "captured")), false, "not even the directory should appear");
});
