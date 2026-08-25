/**
 * Deploy Tomagachi to Base (or any EVM chain) with viem.
 *
 * Usage:
 *   DEPLOYER_KEY=0x... npm run deploy                # Base mainnet, native USDC
 *   DEPLOYER_KEY=0x... CHAIN=baseSepolia npm run deploy
 *
 * Env:
 *   DEPLOYER_KEY   required — deployer private key (becomes owner)
 *   OPERATOR       optional — brain wallet address (defaults to deployer)
 *   USDC           optional — stablecoin address override
 *   RPC_URL        optional — RPC override
 *   CREATURE_NAME  optional — default "Suwa"
 */
import { createWalletClient, createPublicClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const artifact = JSON.parse(
  readFileSync(join(here, "..", "artifacts", "Tomagachi.json"), "utf8")
);

const USDC_BY_CHAIN: Record<string, `0x${string}`> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // native USDC on Base
  baseSepolia: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

const chainKey = process.env.CHAIN ?? "base";
const chain = chainKey === "baseSepolia" ? baseSepolia : base;
const usdc = (process.env.USDC ?? USDC_BY_CHAIN[chainKey]) as `0x${string}`;
if (!usdc) throw new Error(`no USDC address known for chain ${chainKey}; set USDC=`);

const key = process.env.DEPLOYER_KEY as `0x${string}` | undefined;
if (!key) throw new Error("set DEPLOYER_KEY=0x...");

const account = privateKeyToAccount(key);
const operator = (process.env.OPERATOR ?? account.address) as `0x${string}`;
const name = process.env.CREATURE_NAME ?? "Suwa";

const transport = http(process.env.RPC_URL);
const wallet = createWalletClient({ account, chain, transport });
const client = createPublicClient({ chain, transport });

// Metabolism: 5 USDC of appetite per day; full belly = 500 USDC of satiety
// (~100 days of nap-free life on a full stomach). Tune via setMetabolism later.
const metabolismPerDay = parseUnits("5", 6);
const maxSatiety = parseUnits("500", 6);

console.log(`deploying Tomagachi "${name}" to ${chain.name}`);
console.log(`  owner/deployer: ${account.address}`);
console.log(`  operator:       ${operator}`);
console.log(`  stable (USDC):  ${usdc}`);

const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [usdc, account.address, operator, name, metabolismPerDay, maxSatiety],
});
console.log(`deploy tx: ${hash}`);

const receipt = await client.waitForTransactionReceipt({ hash });
const address = receipt.contractAddress!;
console.log(`Tomagachi: ${address}`);

const nom = await client.readContract({
  address,
  abi: artifact.abi,
  functionName: "nom",
});
console.log(`NOM token: ${nom}`);

const out = {
  chain: chainKey,
  chainId: chain.id,
  tomagachi: address,
  nom,
  usdc,
  operator,
  deployedAt: new Date().toISOString(),
  deployTx: hash,
};
writeFileSync(join(here, "..", "deployment.json"), JSON.stringify(out, null, 2));
console.log("wrote agent/deployment.json — the brain and the web page read this");
