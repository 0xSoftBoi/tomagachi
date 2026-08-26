/**
 * Tomagachi node — runs the two unprivileged roles that keep the creature
 * moving: a keeper (feeds it, opens epochs) and a worker (trains, earns).
 *
 *   PRIVATE_KEY=0x... npm start
 *
 * Neither role has authority over the creature's money. See agent/.env.example.
 */
import { config } from "./config.js";
import { Creature } from "./chain.js";
import { Keeper } from "./keeper.js";
import { Worker } from "./worker.js";

const banner = String.raw`
  ／|、     SUWAPPU TOMAGACHI
 (˚ˎ 。7    a creature that lives on Base, eats its own trading fees,
  |、˜〵    and pays strangers to teach it about the world
  じしˍ,)ノ
`;
console.log(banner);

const creature = new Creature();
const keeper = new Keeper(creature);
const worker = new Worker(creature);

console.log(`creature : ${creature.address} on ${creature.chain.name}`);
console.log(`wallet   : ${creature.account.address}`);
console.log(`roles    : ${[config.runKeeper && "keeper", config.runWorker && "worker"]
  .filter(Boolean)
  .join(" + ")}\n`);

/** Convert surplus winnings into stablecoins for GPU rental, if configured. */
async function cashOutIfFlush() {
  if (config.cashOutAboveWei === 0n) return;
  const bal = await creature.client.getBalance({ address: creature.account.address });
  if (bal <= config.cashOutAboveWei) return;
  const { cashOut } = await import("./suwappu.js");
  await cashOut(creature, bal - config.cashOutAboveWei);
}

/** An unreachable RPC is the common failure in the wild, and viem reports it
 *  as a bare "HTTP request failed" that tells an operator nothing. */
function describe(e: any): string {
  const raw = String(e?.details ?? e?.cause?.message ?? e?.message ?? e);
  if (/ECONNREFUSED|ECONNRESET|fetch failed|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(raw)) {
    return `RPC unreachable at ${config.rpcUrl ?? creature.chain.rpcUrls.default.http[0]}`;
  }
  return e?.shortMessage ?? e?.message ?? raw;
}

const MAX_BACKOFF_MS = 10 * 60 * 1000;
let failures = 0;

async function loop() {
  let delay = config.pollMs;
  try {
    if (config.runKeeper) await keeper.tick();
    if (config.runWorker) await worker.tick();
    await cashOutIfFlush().catch((e) => console.warn(`[suwappu] ${e.message}`));
    if (failures > 0) {
      console.log(`[tick] recovered after ${failures} failed poll(s)`);
      failures = 0;
    }
  } catch (e: any) {
    failures++;
    // Back off instead of hammering a dead endpoint, and stop repeating
    // ourselves — an outage should not bury the log it is reported in.
    delay = Math.min(config.pollMs * 2 ** Math.min(failures, 6), MAX_BACKOFF_MS);
    if (failures === 1 || failures % 10 === 0) {
      console.error(
        `[tick] ${describe(e)} (failure ${failures}, retrying in ${Math.round(delay / 1000)}s)`
      );
    }
  }
  setTimeout(loop, delay);
}

loop();
