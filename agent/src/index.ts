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

async function loop() {
  try {
    if (config.runKeeper) await keeper.tick();
    if (config.runWorker) await worker.tick();
    await cashOutIfFlush().catch((e) => console.warn(`[suwappu] ${e.message}`));
  } catch (e: any) {
    console.error(`[tick] ${e.shortMessage ?? e.message ?? e}`);
  }
  setTimeout(loop, config.pollMs);
}

loop();
