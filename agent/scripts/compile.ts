/**
 * Compile contracts/Tomagachi.sol with solc-js and emit ABI + bytecode
 * artifacts to agent/artifacts/. No Foundry required.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const solc = require("solc");

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
// Compile every contract in the directory: the mocks are needed for testnet
// deploys, where PumpClaw does not exist.
const contractsDir = join(root, "contracts");
const sources: Record<string, { content: string }> = {};
for (const f of readdirSync(contractsDir).filter((f) => f.endsWith(".sol"))) {
  sources[f] = { content: readFileSync(join(contractsDir, f), "utf8") };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    // viaIR: the creature's wide `vitals()` return blows the legacy stack.
    viaIR: true,
    // Shanghai, not solc's Cancun default: MCOPY/TSTORE would make the
    // creature undeployable on any chain that hasn't shipped Cancun.
    evmVersion: "shanghai",
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

const errors = (output.errors ?? []).filter((e: any) => e.severity === "error");
for (const e of output.errors ?? []) console.error(e.formattedMessage);
if (errors.length) {
  console.error(`compile failed with ${errors.length} error(s)`);
  process.exit(1);
}

const outDir = join(here, "..", "artifacts");
mkdirSync(outDir, { recursive: true });

for (const file of Object.keys(output.contracts)) {
  for (const [name, artifact] of Object.entries<any>(output.contracts[file])) {
    writeFileSync(
      join(outDir, `${name}.json`),
      JSON.stringify(
        { abi: artifact.abi, bytecode: "0x" + artifact.evm.bytecode.object },
        null,
        2
      )
    );
    console.log(`artifact: artifacts/${name}.json`);
  }
}
console.log("compiled OK");
