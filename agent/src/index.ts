/**
 * Suwappu Tomagachi — brain daemon entrypoint.
 *
 *   OPERATOR_KEY=0x... npm start
 *
 * See agent/.env.example for all knobs.
 */
import { Brain } from "./brain.js";
import { config } from "./config.js";
import { startServer } from "./serve.js";
import { startTelegram } from "./telegram.js";

const banner = String.raw`
  ／|、     SUWAPPU TOMAGACHI
 (˚ˎ 。7    an on-chain creature that eats stablecoins,
  |、˜〵    trains character models, and sells them
  じしˍ,)ノ
`;

console.log(banner);

// The shop pays for the training. Run it unless something else is serving.
if (process.env.SERVE !== "0") startServer();

const brain = new Brain();

// The community chat, if configured: /vitals, /treasury, /feed + broadcasts.
startTelegram(brain.creature);

async function loop() {
  try {
    await brain.tick();
  } catch (e: any) {
    console.error(`[tick] ${e.message ?? e}`);
  }
  setTimeout(loop, config.tickMs);
}

loop();
