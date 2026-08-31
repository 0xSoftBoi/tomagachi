/**
 * On-chain half of the brain: reads the creature's vitals, feeds it swept
 * donations, buys compute, posts checkpoints. All via viem on Base.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  erc20Abi,
  parseAbi,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir, config, loadDeployment, type Deployment } from "./config.js";

const artifact = JSON.parse(
  readFileSync(join(agentDir, "artifacts", "Tomagachi.json"), "utf8")
);
export const tomagachiAbi = artifact.abi;

const erc4626Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
]);

export const MOODS = ["EGG", "HAPPY", "PECKISH", "STARVING", "HIBERNATING"] as const;
export type MoodName = (typeof MOODS)[number];

export interface Vitals {
  mood: MoodName;
  satiety: bigint;
  energy: bigint;
  totalFed: bigint;
  totalComputeSpent: bigint;
  epochs: bigint;
}

export class Creature {
  readonly deployment: Deployment;
  readonly chain: Chain;
  readonly client: PublicClient;
  readonly wallet: WalletClient;
  readonly account: Account;

  constructor() {
    this.deployment = loadDeployment();
    this.chain = this.deployment.chain === "baseSepolia" ? baseSepolia : base;
    if (!config.operatorKey) throw new Error("set OPERATOR_KEY=0x...");
    this.account = privateKeyToAccount(config.operatorKey);
    const transport = http(config.rpcUrl);
    this.client = createPublicClient({ chain: this.chain, transport });
    this.wallet = createWalletClient({ account: this.account, chain: this.chain, transport });
  }

  async vitals(): Promise<Vitals> {
    const [m, s, e, fed, spent, epochs] = (await this.client.readContract({
      address: this.deployment.tomagachi,
      abi: tomagachiAbi,
      functionName: "vitals",
    })) as [number, bigint, bigint, bigint, bigint, bigint];
    return {
      mood: MOODS[m],
      satiety: s,
      energy: e,
      totalFed: fed,
      totalComputeSpent: spent,
      epochs,
    };
  }

  private async write(functionName: string, args: unknown[]): Promise<`0x${string}`> {
    const { request } = await this.client.simulateContract({
      address: this.deployment.tomagachi,
      abi: tomagachiAbi,
      functionName,
      args,
      account: this.account,
    });
    const hash = await this.wallet.writeContract(request);
    await this.client.waitForTransactionReceipt({ hash });
    return hash;
  }

  /** Approve USDC (if needed) and feed the creature from the operator wallet. */
  async feedFor(contributor: `0x${string}`, amount: bigint): Promise<`0x${string}`> {
    const allowance = await this.client.readContract({
      address: this.deployment.usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.account.address, this.deployment.tomagachi],
    });
    if (allowance < amount) {
      const { request } = await this.client.simulateContract({
        address: this.deployment.usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [this.deployment.tomagachi, amount * 1000n],
        account: this.account,
      });
      const hash = await this.wallet.writeContract(request);
      await this.client.waitForTransactionReceipt({ hash });
    }
    return this.write("feedFor", [contributor, amount]);
  }

  /** Approve USDC (if needed) and pass earned revenue to the contract: food
   *  the creature worked for. Mints no NOM. */
  async earn(amount: bigint, source: string): Promise<`0x${string}`> {
    const allowance = await this.client.readContract({
      address: this.deployment.usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.account.address, this.deployment.tomagachi],
    });
    if (allowance < amount) {
      const { request } = await this.client.simulateContract({
        address: this.deployment.usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [this.deployment.tomagachi, amount * 1000n],
        account: this.account,
      });
      const hash = await this.wallet.writeContract(request);
      await this.client.waitForTransactionReceipt({ hash });
    }
    return this.write("earn", [amount, source]);
  }

  async buyCompute(
    to: `0x${string}`,
    amount: bigint,
    provider: string,
    jobRef: string
  ): Promise<`0x${string}`> {
    return this.write("buyCompute", [to, amount, provider, jobRef]);
  }

  async checkpoint(
    epoch: bigint,
    modelHash: `0x${string}`,
    uri: string,
    lossMilli: bigint,
    computeSpent: bigint
  ): Promise<`0x${string}`> {
    return this.write("checkpoint", [epoch, modelHash, uri, lossMilli, computeSpent]);
  }

  async speak(words: string): Promise<`0x${string}`> {
    return this.write("speak", [words]);
  }

  // --- real-yield treasury ------------------------------------------------

  /** The whole balance sheet: liquid, invested, principal, lifetime yield. */
  async treasury(): Promise<{
    liquid: bigint;
    invested: bigint;
    principal: bigint;
    yieldEarned: bigint;
  }> {
    const [liquid, invested, principal, yieldEarned] = (await this.client.readContract({
      address: this.deployment.tomagachi,
      abi: tomagachiAbi,
      functionName: "treasury",
    })) as [bigint, bigint, bigint, bigint];
    return { liquid, invested, principal, yieldEarned };
  }

  /** Diversification cap the brain must respect: mirrors invest()'s on-chain check. */
  async concentrationCap(): Promise<{ bps: bigint; allowedCount: bigint }> {
    const [bps, allowedCount] = (await Promise.all([
      this.client.readContract({
        address: this.deployment.tomagachi,
        abi: tomagachiAbi,
        functionName: "maxVaultConcentrationBps",
      }),
      this.client.readContract({
        address: this.deployment.tomagachi,
        abi: tomagachiAbi,
        functionName: "allowedVaultCount",
      }),
    ])) as [bigint, bigint];
    return { bps, allowedCount };
  }

  async vaultAllowed(vault: `0x${string}`): Promise<boolean> {
    return this.client.readContract({
      address: this.deployment.tomagachi,
      abi: tomagachiAbi,
      functionName: "allowedVault",
      args: [vault],
    }) as Promise<boolean>;
  }

  /** Marked value + tracked principal of the creature's position in a vault. */
  async vaultPosition(
    vault: `0x${string}`
  ): Promise<{ value: bigint; principal: bigint }> {
    const shares = (await this.client.readContract({
      address: vault,
      abi: erc4626Abi,
      functionName: "balanceOf",
      args: [this.deployment.tomagachi],
    })) as bigint;
    const value =
      shares === 0n
        ? 0n
        : ((await this.client.readContract({
            address: vault,
            abi: erc4626Abi,
            functionName: "convertToAssets",
            args: [shares],
          })) as bigint);
    const principal = (await this.client.readContract({
      address: this.deployment.tomagachi,
      abi: tomagachiAbi,
      functionName: "principalOf",
      args: [vault],
    })) as bigint;
    return { value, principal };
  }

  /** Assets per 1e12 shares — the ratio's drift over time is the vault's APY. */
  async vaultSharePrice(vault: `0x${string}`): Promise<bigint> {
    return (await this.client.readContract({
      address: vault,
      abi: erc4626Abi,
      functionName: "convertToAssets",
      args: [10n ** 12n],
    })) as bigint;
  }

  async invest(vault: `0x${string}`, amount: bigint): Promise<`0x${string}`> {
    return this.write("invest", [vault, amount]);
  }

  async divest(vault: `0x${string}`, amount: bigint): Promise<`0x${string}`> {
    return this.write("divest", [vault, amount]);
  }

  async harvest(vault: `0x${string}`): Promise<`0x${string}`> {
    return this.write("harvest", [vault]);
  }

  /** ERC-20 balance of the operator wallet (donation inbox). */
  async walletBalance(token: `0x${string}`): Promise<bigint> {
    return this.client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.account.address],
    });
  }

  /** Sign and broadcast an unsigned tx prepared by Suwappu's self-custody path. */
  async sendPrepared(tx: {
    to: `0x${string}`;
    data: `0x${string}`;
    value?: string;
  }): Promise<`0x${string}`> {
    const hash = await this.wallet.sendTransaction({
      account: this.account,
      chain: this.chain,
      to: tx.to,
      data: tx.data,
      value: tx.value ? BigInt(tx.value) : undefined,
    });
    await this.client.waitForTransactionReceipt({ hash });
    return hash;
  }
}
