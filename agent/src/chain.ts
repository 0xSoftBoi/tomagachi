/**
 * Typed client for the creature. Every method here is a public, permissionless
 * function on the contract — this process has no privileged access, and the
 * creature keeps running whether or not anyone runs this code.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
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

const artifact = JSON.parse(readFileSync(join(agentDir, "artifacts", "Tomagachi.json"), "utf8"));
export const tomagachiAbi = artifact.abi;

export const MOODS = ["EGG", "HAPPY", "PECKISH", "STARVING", "HIBERNATING"] as const;
export const EPOCH_STATES = [
  "NONE", "OPEN", "CLAIMED", "SUBMITTED", "CHALLENGED", "FINALIZED",
] as const;

export type MoodName = (typeof MOODS)[number];
export type EpochStateName = (typeof EPOCH_STATES)[number];

export interface Vitals {
  mood: MoodName;
  satiety: bigint;
  available: bigint;
  totalFed: bigint;
  totalPaidOut: bigint;
  releases: bigint;
  epochs: bigint;
  liveEpoch: boolean;
}

export interface JobSpec {
  id: bigint;
  seed: `0x${string}`;
  baseHash: `0x${string}`;
  /** The corpus the chain requires this epoch to be trained on. */
  datasetHash: `0x${string}`;
  steps: number;
  bounty: bigint;
  state: EpochStateName;
  deadline: bigint;
}

export class Creature {
  readonly deployment: Deployment;
  readonly chain: Chain;
  readonly client: PublicClient;
  readonly wallet: WalletClient;
  readonly account: Account;
  readonly address: `0x${string}`;

  constructor() {
    this.deployment = loadDeployment();
    this.chain = this.deployment.chainId === baseSepolia.id ? baseSepolia : base;
    if (!config.privateKey) throw new Error("set PRIVATE_KEY=0x...");
    this.account = privateKeyToAccount(config.privateKey);
    const transport = http(config.rpcUrl);
    this.client = createPublicClient({ chain: this.chain, transport });
    this.wallet = createWalletClient({ account: this.account, chain: this.chain, transport });
    this.address = this.deployment.tomagachi;
  }

  private read(functionName: string, args: unknown[] = []) {
    return this.client.readContract({
      address: this.address,
      abi: tomagachiAbi,
      functionName,
      args,
    });
  }

  async write(functionName: string, args: unknown[] = [], value = 0n): Promise<`0x${string}`> {
    const { request } = await this.client.simulateContract({
      address: this.address,
      abi: tomagachiAbi,
      functionName,
      args,
      account: this.account,
      value,
    });
    const hash = await this.wallet.writeContract(request);
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
    return hash;
  }

  /** Simulate first so we never burn gas on a call the creature will reject. */
  async canWrite(functionName: string, args: unknown[] = [], value = 0n): Promise<boolean> {
    try {
      await this.client.simulateContract({
        address: this.address,
        abi: tomagachiAbi,
        functionName,
        args,
        account: this.account,
        value,
      });
      return true;
    } catch {
      return false;
    }
  }

  async vitals(): Promise<Vitals> {
    const v = (await this.read("vitals")) as [
      number, bigint, bigint, bigint, bigint, bigint, bigint, boolean
    ];
    return {
      mood: MOODS[v[0]],
      satiety: v[1],
      available: v[2],
      totalFed: v[3],
      totalPaidOut: v[4],
      releases: v[5],
      epochs: v[6],
      liveEpoch: v[7],
    };
  }

  says(): Promise<string> {
    return this.read("says") as Promise<string>;
  }

  async jobSpec(id: bigint): Promise<JobSpec> {
    const s = (await this.read("jobSpec", [id])) as [
      `0x${string}`, `0x${string}`, `0x${string}`, number, bigint, number, bigint
    ];
    return {
      id,
      seed: s[0],
      baseHash: s[1],
      datasetHash: s[2],
      steps: s[3],
      bounty: s[4],
      state: EPOCH_STATES[s[5]],
      deadline: s[6],
    };
  }

  async latestRelease(): Promise<{ epoch: bigint; hash: `0x${string}`; uri: string } | null> {
    const n = (await this.read("releaseCount")) as bigint;
    if (n === 0n) return null;
    const r = (await this.read("latestModel")) as [bigint, `0x${string}`, string, bigint];
    return { epoch: r[0], hash: r[1], uri: r[2] };
  }

  minStake(): Promise<bigint> {
    return this.read("minStakeWei") as Promise<bigint>;
  }

  /** Full epoch record, for reading the submitted result and its timings. */
  async epoch(id: bigint): Promise<Record<string, any>> {
    const e = (await this.read("epochs", [id])) as any[];
    return {
      openedAt: e[0], deadline: e[1], submittedAt: e[2], voteEnd: e[3],
      seed: e[4], baseHash: e[5], datasetHash: e[6], steps: e[7], bounty: e[8],
      worker: e[9], workerStake: e[10], modelHash: e[11], uri: e[12],
      lossMilli: e[13], challenger: e[14],
    };
  }
}
