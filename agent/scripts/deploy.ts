/**
 * Deploy the creature and hatch its PumpClaw token.
 *
 *   PRIVATE_KEY=0x... npm run deploy
 *
 * After this the creature is fully autonomous: it owns its own token, is the
 * registered recipient of 80% of that token's trading fees, and nobody — the
 * deployer included — can withdraw its treasury. There is no admin key.
 *
 * Env:
 *   PRIVATE_KEY      required — pays gas. Gains NO authority over the creature.
 *   CHAIN            base (default) | baseSepolia
 *   RPC_URL          RPC override
 *   NAME/SYMBOL      token identity (default "Suwappu Tomagachi" / SUWA)
 *   SUPPLY           whole tokens (default 1_000_000_000)
 *   FDV_ETH          initial fully-diluted valuation in ETH (default 2)
 *   IMAGE_URL/SITE   token metadata
 *   METABOLISM_ETH   satiety burned per day (default 0.01)
 *   MAX_SATIETY_ETH  full belly (default 1)
 *   SKIP_HATCH=1     deploy only, hatch later
 */
import { createWalletClient, createPublicClient, http, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const art = (n: string) =>
  JSON.parse(readFileSync(join(here, "..", "artifacts", `${n}.json`), "utf8"));
const artifact = art("Tomagachi");

const ZERO = "0x0000000000000000000000000000000000000000" as const;

const chainKey = process.env.CHAIN ?? "base";
const chain = chainKey === "baseSepolia" ? baseSepolia : base;

const key = process.env.PRIVATE_KEY as `0x${string}` | undefined;
if (!key) throw new Error("set PRIVATE_KEY=0x...");
const account = privateKeyToAccount(key);

const transport = http(process.env.RPC_URL);
const wallet = createWalletClient({ account, chain, transport });
const client = createPublicClient({ chain, transport });

const metabolism = parseEther(process.env.METABOLISM_ETH ?? "0.01");
const maxSatiety = parseEther(process.env.MAX_SATIETY_ETH ?? "1");

// The corpus every worker must train on, pinned on-chain from birth. Defaults
// to hashing the committed dataset; NOM holders can vote in a new one later.
const datasetPath = process.env.DATASET ?? join(here, "..", "..", "data", "market.npz");
let datasetHash = process.env.DATASET_SHA256 as `0x${string}` | undefined;
if (!datasetHash) {
  if (!existsSync(datasetPath)) {
    throw new Error(`no dataset at ${datasetPath}; set DATASET or DATASET_SHA256`);
  }
  datasetHash = `0x${createHash("sha256").update(readFileSync(datasetPath)).digest("hex")}`;
}

// PumpClaw only exists on Base mainnet. On any other chain the creature would
// deploy and then be unable to hatch — and everything economic is gated on
// hatching — so a testnet deploy stands up mocks first.
const isMainnet = chain.id === base.id;
let factory = (process.env.FACTORY ?? ZERO) as `0x${string}`;
let locker = (process.env.LOCKER ?? ZERO) as `0x${string}`;
const wantMocks = !isMainnet && factory === ZERO && locker === ZERO;
if (wantMocks && process.env.NO_MOCKS) {
  throw new Error("no PumpClaw on this chain and NO_MOCKS is set; pass FACTORY/LOCKER");
}
if (isMainnet && (process.env.FACTORY || process.env.LOCKER)) {
  throw new Error(
    "refusing to substitute PumpClaw on mainnet — the creature's income depends " +
      "on the real factory and locker"
  );
}

const name = process.env.NAME ?? "Suwappu Tomagachi";
const symbol = process.env.SYMBOL ?? "SUWA";
const supply = BigInt(process.env.SUPPLY ?? "1000000000") * 10n ** 18n;
const fdv = parseEther(process.env.FDV_ETH ?? "2");
const imageUrl = process.env.IMAGE_URL ?? "";
const siteUrl = process.env.SITE ?? "https://suwappu.bot";

console.log(`deploying the creature to ${chain.name}`);
console.log(`  deployer     : ${account.address} (gains no authority)`);
console.log(`  metabolism   : ${formatEther(metabolism)} ETH/day`);
console.log(`  full belly   : ${formatEther(maxSatiety)} ETH`);
console.log(`  dataset      : ${datasetHash}`);

if (wantMocks) {
  console.log(`\n${chain.name} has no PumpClaw — deploying mocks for the rehearsal`);
  const lockerArt = art("MockPumpClawLocker");
  let h = await wallet.deployContract({
    abi: lockerArt.abi, bytecode: lockerArt.bytecode, args: [account.address],
  });
  locker = (await client.waitForTransactionReceipt({ hash: h })).contractAddress!;

  const facArt = art("MockPumpClawFactory");
  h = await wallet.deployContract({
    abi: facArt.abi, bytecode: facArt.bytecode, args: [locker],
  });
  factory = (await client.waitForTransactionReceipt({ hash: h })).contractAddress!;

  const { request } = await client.simulateContract({
    address: locker, abi: lockerArt.abi, functionName: "setFactory",
    args: [factory], account,
  });
  await client.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
  console.log(`  mock locker  : ${locker}`);
  console.log(`  mock factory : ${factory}`);
}

const deployHash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [metabolism, maxSatiety, datasetHash, factory, locker],
});
const receipt = await client.waitForTransactionReceipt({ hash: deployHash });
const tomagachi = receipt.contractAddress!;
console.log(`  creature     : ${tomagachi}`);

const nom = (await client.readContract({
  address: tomagachi,
  abi: artifact.abi,
  functionName: "nom",
})) as `0x${string}`;
console.log(`  NOM          : ${nom}`);

let token: `0x${string}` | undefined;
if (!process.env.SKIP_HATCH) {
  console.log(`\nhatching "${name}" ($${symbol}) on PumpClaw…`);
  const { request } = await client.simulateContract({
    address: tomagachi,
    abi: artifact.abi,
    functionName: "hatch",
    args: [name, symbol, imageUrl, siteUrl, supply, fdv],
    account,
  });
  const hatchHash = await wallet.writeContract(request);
  await client.waitForTransactionReceipt({ hash: hatchHash });
  token = (await client.readContract({
    address: tomagachi,
    abi: artifact.abi,
    functionName: "token",
  })) as `0x${string}`;
  console.log(`  $${symbol}         : ${token}`);
  console.log(`  the creature now earns 80% of every trade on its own token.`);
}

const out = {
  chain: chainKey,
  chainId: chain.id,
  tomagachi,
  nom,
  token,
  datasetHash,
  pumpclawFactory: factory === ZERO ? "base-mainnet-default" : factory,
  pumpclawLocker: locker === ZERO ? "base-mainnet-default" : locker,
  mocked: wantMocks,
  deployedAt: new Date().toISOString(),
  deployTx: deployHash,
};
const path = join(here, "..", "deployment.json");
writeFileSync(path, JSON.stringify(out, null, 2));
if (wantMocks) {
  console.log(
    `\nNOTE: this creature runs on MOCK PumpClaw. Simulate trading income with\n` +
      `  cast send ${locker} "accrue(address)" ${token} --value 0.01ether\n` +
      `then anyone can call feed() to pull 80% of it into the creature.`
  );
}
console.log(`\nwrote agent/deployment.json — copy it into web/ to light up the page`);
console.log(`explorer: ${chain.blockExplorers.default.url}/address/${tomagachi}`);
