/**
 * The shop, standalone.
 *
 *   UPSTREAM_BASE_URL=http://localhost:8000/v1 npm run serve
 *
 * Runs on its own so the GPU box can serve traffic without holding the
 * operator key. `npm start` runs the brain and, unless SERVE=0, the shop too.
 */
import { startServer } from "./serve.js";

startServer();
