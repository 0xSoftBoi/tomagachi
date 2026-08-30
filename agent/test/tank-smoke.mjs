/**
 * Smoke test for The Tank (web/game.html): serves the web dir, runs the game
 * in headless Chromium, plays a demo round (pet → feed → shrimp chase), and
 * fails on any page error. Screenshots land in runs/.
 *
 *   npm run smoke        (needs a Chromium; CHROMIUM=/path/to/chromium to point at one)
 */
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "web");
const shots = join(here, "..", "..", "runs");
mkdirSync(shots, { recursive: true });

const executablePath = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium";
if (!existsSync(executablePath)) {
  console.log(`no chromium at ${executablePath} — set CHROMIUM=…; skipping tank smoke`);
  process.exit(0);
}

const server = createServer((req, res) => {
  const p = join(root, req.url === "/" ? "game.html" : req.url.split("?")[0]);
  if (!existsSync(p)) { res.writeHead(404); return res.end("nope"); }
  res.writeHead(200, { "content-type": p.endsWith(".html") ? "text/html" : "application/octet-stream" });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(8899, r));

const browser = await chromium.launch({
  executablePath,
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto("http://localhost:8899/");
await page.waitForTimeout(2500);
await page.screenshot({ path: join(shots, "tank-idle.png") });

// one demo round: pet, feed, chase the shrimp
await page.click("#btnPet");
await page.waitForTimeout(600);
await page.click("#btnFeed");
await page.waitForTimeout(1800);
await page.click("#btnPlay");
await page.waitForTimeout(1500);
await page.mouse.move(700, 300);
await page.waitForTimeout(1200);
await page.screenshot({ path: join(shots, "tank-playing.png") });

const hud = await page.evaluate(() => ({
  mood: document.getElementById("moodline").textContent,
  xp: document.getElementById("xpline").textContent,
  status: document.getElementById("statustext").textContent,
  badges: document.getElementById("badges").textContent,
}));
console.log("HUD:", JSON.stringify(hud));

await browser.close();
server.close();

if (errors.length) {
  console.error("tank smoke FAILED:\n" + errors.join("\n"));
  process.exit(1);
}
if (!hud.xp.includes("/") || !hud.mood) {
  console.error("tank smoke FAILED: HUD did not populate");
  process.exit(1);
}
console.log("tank smoke OK — no page errors, HUD live, screenshots in runs/");
