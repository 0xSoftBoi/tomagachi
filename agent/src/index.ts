/**
 * Suwappu Tomagachi — brain daemon entrypoint.
 *
 *   OPERATOR_KEY=0x... npm start
 *
 * See agent/.env.example for all knobs.
 */
import { Brain } from "./brain.js";
import { config } from "./config.js";

const banner = String.raw`
  ／|、     SUWAPPU TOMAGACHI
 (˚ˎ 。7    an on-chain creature that eats stablecoins
  |、˜〵    and trains an open world model
  じしˍ,)ノ
`;

console.log(banner);

const brain = new Brain();

async function loop() {
  try {
    await brain.tick();
  } catch (e: any) {
    console.error(`[tick] ${e.message ?? e}`);
  }
  setTimeout(loop, config.tickMs);
}

loop();
