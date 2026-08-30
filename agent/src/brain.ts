/**
 * The creature's brain — one tick every TICK_MS:
 *
 *   1. Read vitals from Base.
 *   2. Sweep donations: any allowlisted token sitting in the operator wallet
 *      gets swapped to USDC through Suwappu (self-custody: quote -> unsigned
 *      tx -> sign locally -> broadcast), then fed to the creature.
 *   3. Feed any loose USDC in the wallet straight in.
 *   4. If awake and energetic, buy compute (on-chain record first) and train
 *      one epoch of the next character adapter in the rotation.
 *   5. Post the checkpoint hash on-chain. Say something.
 *
 * The shop (src/serve.ts) runs alongside and sells what these epochs produce;
 * its week shows up in the [shop] line next to vitals, because in this design
 * revenue is food.
 */
import { formatUnits, erc20Abi } from "viem";
import { join } from "node:path";
import { config } from "./config.js";
import { loadState, saveState } from "./state.js";
import { Creature } from "./chain.js";
import { makeProvider } from "./compute.js";
import { catalog as characterCatalog } from "./characters.js";
import { metrics } from "./usage.js";
import * as suwappu from "./suwappu.js";

const LINES: Record<string, string[]> = {
  HAPPY: ["*happy gurgle* training epoch soon!", "the reef is warm today. i am learning."],
  PECKISH: ["a little hungry... a few USDC would help the next epoch."],
  STARVING: ["so hungry... my gradients are fading..."],
  HIBERNATING: ["*zzz* ... feed me to wake the training loop ..."],
  EGG: ["*the egg wobbles*"],
};

function say(mood: string): string {
  const lines = LINES[mood] ?? LINES.HAPPY;
  return lines[Math.floor(Math.random() * lines.length)];
}

export class Brain {
  creature = new Creature();
  provider = makeProvider();
  private busy = false;

  async tick(): Promise<void> {
    if (this.busy) return; // a training run is still going
    this.busy = true;
    try {
      await suwappu.ensureRegistered().catch((e) =>
        console.warn(`[suwappu] register failed (will retry): ${e.message}`)
      );

      const v = await this.creature.vitals();
      console.log(
        `[vitals] mood=${v.mood} satiety=${formatUnits(v.satiety, 6)} ` +
          `energy=${formatUnits(v.energy, 6)} USDC epochs=${v.epochs}`
      );

      const m = metrics();
      if (m.requests > 0) {
        console.log(
          `[shop] 7d: ${(m.tokens / 1e6).toFixed(1)}M tokens $${m.grossUsd.toFixed(2)} ` +
            `at $${m.realizedUsdPerM.toFixed(2)}/M · gpu ${(m.gpuUtilization * 100).toFixed(0)}% ` +
            `· ${m.apps.length} apps`
        );
      }

      await this.sweepDonations().catch((e) =>
        console.warn(`[sweep] ${e.message}`)
      );

      // Farm before the mood check: a harvest raises satiety, so real yield
      // can wake a hibernating creature all by itself.
      const harvested = await this.manageTreasury().catch((e) => {
        console.warn(`[treasury] ${e.message}`);
        return false;
      });
      const mood = harvested ? (await this.creature.vitals()).mood : v.mood;

      if (mood === "HIBERNATING" || mood === "EGG") {
        console.log(`[brain] ${say(mood)}`);
        return;
      }

      const cost = this.provider.priceUsdc;
      // treasury() only exists on contracts deployed with the yield layer, so
      // fall back to the vitals read on older deployments (no vault set).
      const liquid = config.yieldVault ? (await this.creature.treasury()).liquid : v.energy;
      if (liquid < config.minEnergyToTrain || liquid < cost) {
        console.log(`[brain] not enough liquid energy to train (${formatUnits(liquid, 6)} USDC)`);
        return;
      }

      await this.trainEpoch(cost);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Real-yield treasury: harvest what the vault earned (yield is food), keep
   * a liquidity buffer for training, and farm everything above it. Principal
   * never leaves the creature — it moves between liquid and invested.
   * Returns true if a harvest landed (satiety changed).
   */
  async manageTreasury(): Promise<boolean> {
    const vault = config.yieldVault;
    if (!vault) return false;
    if (!(await this.creature.vaultAllowed(vault))) {
      console.warn(`[treasury] ${vault} not whitelisted — owner must call allowVault`);
      return false;
    }

    let harvested = false;
    const pos = await this.creature.vaultPosition(vault);
    const pending = pos.value > pos.principal ? pos.value - pos.principal : 0n;
    if (pending >= config.harvestMinUsdc) {
      const h = await this.creature.harvest(vault);
      console.log(`[treasury] harvested ${formatUnits(pending, 6)} USDC of yield: ${h}`);
      await this.creature
        .speak(`harvested ${formatUnits(pending, 6)} USDC of real yield. i farm, therefore i am fed.`)
        .catch(() => {});
      harvested = true;
    }

    // The liquidity buffer can never sit below the training threshold.
    const target =
      config.liquidTargetUsdc > config.minEnergyToTrain
        ? config.liquidTargetUsdc
        : config.minEnergyToTrain;

    const t = await this.creature.treasury();
    if (t.liquid > target) {
      const excess = t.liquid - target;
      const h = await this.creature.invest(vault, excess);
      console.log(`[treasury] farmed ${formatUnits(excess, 6)} idle USDC into ${vault}: ${h}`);
    } else if (t.liquid < config.minEnergyToTrain && t.principal > 0n) {
      const shortfall = target - t.liquid;
      const recall = shortfall < t.principal ? shortfall : t.principal;
      const h = await this.creature.divest(vault, recall);
      console.log(`[treasury] recalled ${formatUnits(recall, 6)} USDC of principal: ${h}`);
    }
    return harvested;
  }

  /** Swap donated tokens in the operator wallet to USDC via Suwappu, then feed. */
  async sweepDonations(): Promise<void> {
    const chainKey = this.creature.deployment.chain === "baseSepolia" ? "base-sepolia" : "base";
    const catalog = await suwappu.tokens(chainKey).catch(() => [] as suwappu.TokenInfo[]);

    for (const symbol of config.sweepTokens) {
      const info = catalog.find((t) => t.symbol?.toUpperCase() === symbol.toUpperCase());
      if (!info) continue;
      const bal = await this.creature.walletBalance(info.address as `0x${string}`);
      if (bal === 0n) continue;

      const px = await suwappu.prices([symbol]).catch(() => ({} as Record<string, number>));
      const usd = Number(formatUnits(bal, info.decimals)) * (px[symbol] ?? 0);
      if (usd < config.sweepMinUsd) continue;

      const human = formatUnits(bal, info.decimals);
      console.log(`[sweep] ${human} ${symbol} (~$${usd.toFixed(2)}) -> USDC`);
      const q = await suwappu.quote({
        chain: chainKey,
        fromToken: symbol,
        toToken: "USDC",
        amount: human,
        walletAddress: this.creature.account.address,
      });
      const tx = await suwappu.buildSwapTx(q.quote_id, this.creature.account.address);

      // Self-custody: approve router if needed, then sign + broadcast locally.
      const allowance = await this.creature.client.readContract({
        address: info.address as `0x${string}`,
        abi: erc20Abi,
        functionName: "allowance",
        args: [this.creature.account.address, tx.to],
      });
      if (allowance < bal) {
        const { request } = await this.creature.client.simulateContract({
          address: info.address as `0x${string}`,
          abi: erc20Abi,
          functionName: "approve",
          args: [tx.to, bal],
          account: this.creature.account,
        });
        const h = await this.creature.wallet.writeContract(request);
        await this.creature.client.waitForTransactionReceipt({ hash: h });
      }
      const swapHash = await this.creature.sendPrepared(tx);
      console.log(`[sweep] swapped via suwappu: ${swapHash}`);
    }

    // Any USDC now in the wallet is food. Contributor = operator = community pool.
    const usdcBal = await this.creature.walletBalance(this.creature.deployment.usdc);
    if (usdcBal > 0n) {
      const h = await this.creature.feedFor(this.creature.account.address, usdcBal);
      console.log(`[feed] fed ${formatUnits(usdcBal, 6)} USDC to the creature: ${h}`);
    }
  }

  /** Which SKU this epoch belongs to: round-robin, so the fleet grows evenly. */
  nextCharacter(epoch: number): string | undefined {
    if (config.trainTarget !== "adapter") return undefined;
    const rotation = config.characterRotation.length
      ? config.characterRotation
      : characterCatalog().characters.map((c) => c.id);
    if (!rotation.length) throw new Error("no characters in model/characters.json");
    return rotation[(epoch - 1) % rotation.length];
  }

  async trainEpoch(cost: bigint): Promise<void> {
    const state = loadState();
    const epoch = state.epoch + 1;
    const character = this.nextCharacter(epoch);
    const jobRef = character ? `${character}-epoch-${epoch}` : `suwa-wm-epoch-${epoch}`;
    const outDir = join(config.runsDir, jobRef);

    // 1. Pay for compute ON-CHAIN first — the purchase is the public record.
    if (cost > 0n) {
      if (!this.provider.payTo) throw new Error("remote provider needs COMPUTE_PAY_TO");
      const h = await this.creature.buyCompute(this.provider.payTo, cost, this.provider.name, jobRef);
      console.log(`[compute] bought ${formatUnits(cost, 6)} USDC of ${this.provider.name}: ${h}`);
    } else {
      console.log(`[compute] bootstrap mode: training locally at no charge`);
    }

    state.activeJob = {
      id: jobRef,
      provider: this.provider.name,
      startedAt: new Date().toISOString(),
      paidUsdc: cost.toString(),
    };
    saveState(state);

    // 2. Train.
    const steps = character ? config.stepsPerAdapterEpoch : config.stepsPerEpoch;
    const result = await this.provider.run({ epoch, steps, outDir, character });

    // 3. Checkpoint on-chain: hash of the open weights + where to get them.
    const uri = config.hfRepo
      ? `https://huggingface.co/${config.hfRepo}`
      : `run://${jobRef}`;
    // Adapters post held-out loss, which is the number a buyer can reproduce;
    // the world model only ever had a training loss to give.
    const reportedLoss = result.manifest.held_out_loss ?? result.manifest.final_loss;
    const lossMilli = BigInt(Math.round(reportedLoss * 1000));
    const h = await this.creature.checkpoint(
      BigInt(epoch),
      `0x${result.manifest.sha256}` as `0x${string}`,
      uri,
      lossMilli,
      cost
    );
    const scoreNote =
      result.manifest.score !== undefined ? ` score=${result.manifest.score.toFixed(3)}` : "";
    console.log(
      `[checkpoint] ${jobRef} loss=${reportedLoss.toFixed(4)}${scoreNote} ` +
        `sha256=${result.manifest.sha256.slice(0, 12)}… tx=${h}`
    );

    state.epoch = epoch;
    state.activeJob = undefined;
    saveState(state);

    const words = character
      ? `${character} epoch ${epoch}: score ${(result.manifest.score ?? 0).toFixed(3)}. ` +
        `i am a little more myself.`
      : `epoch ${epoch} complete. loss ${reportedLoss.toFixed(3)}. i dream a little sharper now.`;
    await this.creature.speak(words).catch(() => {});
  }
}
