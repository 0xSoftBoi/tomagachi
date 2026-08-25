/**
 * A permissionless keeper.
 *
 * The creature cannot act on its own — nothing on-chain can. The keeper is
 * whoever pokes it: it claims the creature's PumpClaw trading fees into its
 * belly (earning NOM for the gas), digests stray donations, and opens the next
 * training epoch when the creature is fed enough to afford one.
 *
 * Running it is optional and unprivileged. If nobody runs it, anyone can call
 * the same functions by hand from a block explorer.
 */
import { formatEther } from "viem";
import { Creature, tomagachiAbi } from "./chain.js";

/** PumpClawFeeViewer on Base — read-only view of unclaimed creator fees. */
const FEE_VIEWER = "0xd25Da746946531F6d8Ba42c4bC0CbF25A39b4b39" as const;
const FEE_VIEWER_ABI = [
  {
    name: "getPendingFees",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "amount0", type: "uint256" },
          { name: "amount1", type: "uint256" },
          { name: "creatorAmount0", type: "uint256" },
          { name: "creatorAmount1", type: "uint256" },
          { name: "adminAmount0", type: "uint256" },
          { name: "adminAmount1", type: "uint256" },
        ],
      },
    ],
  },
] as const;

export class Keeper {
  constructor(private creature: Creature) {}

  async tick(): Promise<void> {
    const v = await this.creature.vitals();
    console.log(
      `[vitals] ${v.mood} satiety=${formatEther(v.satiety)} treasury=${formatEther(v.available)} ETH ` +
        `epochs=${v.epochs} releases=${v.releases} — "${await this.creature.says()}"`
    );

    await this.claimFees();
    await this.digest();
    await this.openEpoch(v.liveEpoch);
  }

  /**
   * Pull the creature's 80% PumpClaw creator fees — its whole income.
   * `claimFees` succeeds even with nothing accrued, so check the fee viewer
   * first rather than paying gas to do nothing on every tick.
   */
  private async claimFees(): Promise<void> {
    const token = (await this.creature.client.readContract({
      address: this.creature.address,
      abi: tomagachiAbi,
      functionName: "token",
    })) as `0x${string}`;
    if (token === "0x0000000000000000000000000000000000000000") return;

    const pending = await this.pendingFees(token);
    if (pending === 0n) return;

    const hash = await this.creature.write("feed");
    console.log(`[keeper] claimed ${formatEther(pending)} ETH of PumpClaw fees: ${hash}`);
  }

  /** Creator's share of fees waiting in the LP locker, in wei of native ETH. */
  private async pendingFees(token: `0x${string}`): Promise<bigint> {
    try {
      const fees = (await this.creature.client.readContract({
        address: FEE_VIEWER,
        abi: FEE_VIEWER_ABI,
        functionName: "getPendingFees",
        args: [token],
      })) as { token0: string; creatorAmount0: bigint; creatorAmount1: bigint };
      // token0 is native ETH (address zero) in PumpClaw's V4 pools.
      return fees.token0 === "0x0000000000000000000000000000000000000000"
        ? fees.creatorAmount0
        : fees.creatorAmount1;
    } catch {
      return 0n; // viewer unavailable (e.g. a non-Base chain) — skip quietly
    }
  }

  /** Fold ETH that arrived by bare transfer into satiety, if any has. */
  private async digest(): Promise<void> {
    const [balance, accounted] = await Promise.all([
      this.creature.client.getBalance({ address: this.creature.address }),
      this.creature.client.readContract({
        address: this.creature.address,
        abi: tomagachiAbi,
        functionName: "accounted",
      }) as Promise<bigint>,
    ]);
    if (balance <= accounted) return;
    const hash = await this.creature.write("sync");
    console.log(`[keeper] digested ${formatEther(balance - accounted)} ETH of donations: ${hash}`);
  }

  /** Commission the next epoch if the creature is awake and can afford it. */
  private async openEpoch(liveEpoch: boolean): Promise<void> {
    if (liveEpoch) return;
    if (!(await this.creature.canWrite("openEpoch"))) {
      return; // hibernating, on cooldown, or treasury too thin
    }
    const hash = await this.creature.write("openEpoch");
    console.log(`[keeper] opened a new training epoch: ${hash}`);
  }
}
