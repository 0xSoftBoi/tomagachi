/**
 * A tiny EVM harness for the contract tests: @ethereumjs/evm `runCall` with a
 * fake block header, which gives the suite three things a public testnet
 * can't — arbitrary callers (no keys, no gas money), full control of
 * `block.timestamp` (metabolism runs on it), and zero network.
 */
import { createEVM, type EVM } from "@ethereumjs/evm";
import { createAddressFromString, type Address } from "@ethereumjs/util";
import {
  encodeFunctionData,
  encodeDeployData,
  decodeFunctionResult,
  decodeAbiParameters,
  type Abi,
} from "viem";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const artifactsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "artifacts");

export function artifact(name: string): { abi: Abi; bytecode: `0x${string}` } {
  return JSON.parse(readFileSync(join(artifactsDir, `${name}.json`), "utf8"));
}

export interface Deployed {
  address: `0x${string}`;
  abi: Abi;
}

const hexToBytes = (s: string) => Uint8Array.from(Buffer.from(s.slice(2), "hex"));
const bytesToHex = (b: Uint8Array) => ("0x" + Buffer.from(b).toString("hex")) as `0x${string}`;

export class RevertError extends Error {
  constructor(public reason: string) {
    super(`reverted: ${reason}`);
  }
}

export class TestChain {
  evm!: EVM;
  /** The suite's clock. Every call executes at this timestamp. */
  now = 1_800_000_000n;

  static async create(): Promise<TestChain> {
    const chain = new TestChain();
    chain.evm = await createEVM();
    return chain;
  }

  advance(seconds: number | bigint): void {
    this.now += BigInt(seconds);
  }

  private block(): any {
    return {
      header: {
        timestamp: this.now,
        number: 1n,
        coinbase: createAddressFromString("0x0000000000000000000000000000000000000000"),
        difficulty: 0n,
        gasLimit: 30_000_000n,
        baseFeePerGas: 0n,
        getBlobGasPrice: () => 0n,
      },
    };
  }

  private async run(caller: string, data: `0x${string}`, to?: string) {
    const res = await this.evm.runCall({
      caller: createAddressFromString(caller),
      to: to ? createAddressFromString(to) : undefined,
      data: hexToBytes(data),
      gasLimit: 30_000_000n,
      block: this.block(),
    });
    if (res.execResult.exceptionError) {
      const ret = bytesToHex(res.execResult.returnValue);
      // Error(string) selector; anything else surfaces raw.
      if (ret.startsWith("0x08c379a0")) {
        const [reason] = decodeAbiParameters([{ type: "string" }], `0x${ret.slice(10)}`);
        throw new RevertError(reason as string);
      }
      throw new RevertError(`${res.execResult.exceptionError.error} ${ret}`);
    }
    return res;
  }

  async deploy(name: string, args: unknown[] = [], from = ZERO_CALLER): Promise<Deployed> {
    const { abi, bytecode } = artifact(name);
    const data = encodeDeployData({ abi, bytecode, args });
    const res = await this.run(from, data);
    if (!res.createdAddress) throw new Error(`deploy ${name}: no address`);
    return { address: res.createdAddress.toString() as `0x${string}`, abi };
  }

  async write(from: string, c: Deployed, functionName: string, args: unknown[] = []): Promise<void> {
    await this.run(from, encodeFunctionData({ abi: c.abi, functionName, args }), c.address);
  }

  async read<T = unknown>(c: Deployed, functionName: string, args: unknown[] = []): Promise<T> {
    const res = await this.run(
      ZERO_CALLER,
      encodeFunctionData({ abi: c.abi, functionName, args }),
      c.address
    );
    return decodeFunctionResult({
      abi: c.abi,
      functionName,
      data: bytesToHex(res.execResult.returnValue),
    }) as T;
  }
}

export const ZERO_CALLER = "0x00000000000000000000000000000000000000ff";

/** Assert that a write reverts with the given reason. */
export async function expectRevert(p: Promise<unknown>, reason: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RevertError && e.reason === reason) return;
    throw new Error(`expected revert "${reason}", got: ${(e as Error).message}`);
  }
  throw new Error(`expected revert "${reason}", but the call succeeded`);
}
