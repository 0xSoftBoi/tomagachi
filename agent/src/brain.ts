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
import { EpochRejectedError, makeProvider } from "./compute.js";
import { publishEpoch } from "./adapters.js";
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

      if (v.mood === "HIBERNATING" || v.mood === "EGG") {
        console.log(`[brain] ${say(v.mood)}`);
        return;
      }

      const cost = this.provider.priceUsdc;
      if (v.energy < config.minEnergyToTrain || v.energy < cost) {
        console.log(`[brain] not enough energy to train (${formatUnits(v.energy, 6)} USDC)`);
        return;
      }

      await this.trainEpoch(cost);
    } finally {
      this.busy = false;
    }
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
    let result;
    try {
      result = await this.provider.run({ epoch, steps, outDir, character });
    } catch (e) {
      if (e instanceof EpochRejectedError) {
        // The gate did its job. Nothing goes on-chain and nothing is served;
        // the epoch number is not consumed, so the next tick tries again from
        // the same parent. The compute was still bought and still logged.
        state.activeJob = undefined;
        saveState(state);
        console.log(`[gate] ${jobRef} scored below its parent — not checkpointed, will retrain`);
        await this.creature
          .speak(`${character ?? "that epoch"} came out worse. i am not shipping it.`)
          .catch(() => {});
        return;
      }
      state.activeJob = undefined;
      saveState(state);
      throw e;
    }

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

    // 4. Serve what we just trained. The compounding only pays off if the GPU
    // is running the epoch we paid for, and swapping in place avoids the
    // downtime a restart per epoch would cost.
    if (character) {
      const published = await publishEpoch(outDir, character);
      if (published.reloaded) {
        console.log(`[serve] ${character} epoch ${epoch} swapped in at ${published.path}`);
      } else if (published.error !== "publishing disabled") {
        // Not fatal: the weights exist, the eval passed, the hash is on-chain.
        console.warn(
          `[serve] ${character} epoch ${epoch} trained but not swapped in ` +
            `(${published.error}) — the previous epoch keeps serving`
        );
      }
    }

    const words = character
      ? `${character} epoch ${epoch}: score ${(result.manifest.score ?? 0).toFixed(3)}. ` +
        `i am a little more myself.`
      : `epoch ${epoch} complete. loss ${reportedLoss.toFixed(3)}. i dream a little sharper now.`;
    await this.creature.speak(words).catch(() => {});
  }
}
