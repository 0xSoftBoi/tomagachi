/**
 * On-chain half of the brain: reads the creature's vitals, feeds it swept
 * donations, buys compute, posts checkpoints. All via viem on Base.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  erc20Abi,
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

export interface Proposal {
  id: number;
  proposer: string;
  direction: string;
  deadline: number;
  yes: bigint;
  no: bigint;
  /** Net support in NOM. Negative means the room said no. */
  net: bigint;
  open: boolean;
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

  /**
   * Open proposals with their vote weights. Read-only: the brain never votes,
   * it only listens. Returns [] on any read failure — governance informing the
   * rotation must never be able to stop the creature training.
   */
  async proposals(limit = 32): Promise<Proposal[]> {
    try {
      const count = (await this.client.readContract({
        address: this.deployment.tomagachi,
        abi: tomagachiAbi,
        functionName: "proposalCount",
      })) as bigint;

      const now = Math.floor(Date.now() / 1000);
      const out: Proposal[] = [];
      const from = count > BigInt(limit) ? count - BigInt(limit) : 0n;
      for (let i = count; i > from; i--) {
        const id = i - 1n;
        const [proposer, direction, deadline, yes, no] = (await this.client.readContract({
          address: this.deployment.tomagachi,
          abi: tomagachiAbi,
          functionName: "proposals",
          args: [id],
        })) as [string, string, bigint, bigint, bigint];
        out.push({
          id: Number(id),
          proposer,
          direction,
          deadline: Number(deadline),
          yes,
          no,
          net: yes - no,
          open: Number(deadline) > now,
        });
      }
      return out;
    } catch (e: any) {
      console.warn(`[governance] could not read proposals: ${e.message ?? e}`);
      return [];
    }
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
