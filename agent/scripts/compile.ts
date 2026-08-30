/**
 * Compile contracts/Tomagachi.sol with solc-js and emit ABI + bytecode
 * artifacts to agent/artifacts/. No Foundry required.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const solc = require("solc");

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

// The real contract plus the test doubles the EVM test suite deploys.
const sources: Record<string, { content: string }> = {
  "Tomagachi.sol": { content: readFileSync(join(root, "contracts", "Tomagachi.sol"), "utf8") },
  "Mocks.sol": { content: readFileSync(join(root, "contracts", "test", "Mocks.sol"), "utf8") },
};

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 500 },
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

for (const file of Object.keys(sources)) {
  for (const [name, artifact] of Object.entries<any>(output.contracts[file] ?? {})) {
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
