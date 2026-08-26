/**
 * A permissionless training worker.
 *
 * Anyone can run this. It watches the creature for open epochs, stakes ETH to
 * claim one, trains SUWA-WM off-chain using the seed the CONTRACT chose,
 * publishes the weights, and submits their hash. After the challenge window it
 * finalizes and collects the bounty.
 *
 * The seed comes from the chain, so any other worker can reproduce the same run
 * and challenge a liar. Determinism is the whole security model — see
 * model/README.md for the reproducibility contract.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { formatEther } from "viem";
import { config } from "./config.js";
import { Creature, type JobSpec } from "./chain.js";

const ZERO_HASH = `0x${"0".repeat(64)}`;

export interface TrainedArtifact {
  sha256: string;
  finalLoss: number;
  dir: string;
}

/** Recompute a checkpoint's canonical weights hash — the value the chain holds. */
function canonicalHash(checkpoint: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("python3", [join(config.modelDir, "verify.py"), checkpoint]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("exit", (code) => {
      const m = out.match(/canonical weights hash: 0x([0-9a-f]{64})/);
      if (code === 0 && m) resolve(m[1]);
      else reject(new Error(`verify.py failed (${code}): ${out.trim()}`));
    });
  });
}

export class Worker {
  constructor(private creature: Creature) {
    if (!config.hfRepo) {
      console.warn(
        "[worker] HF_REPO is unset: releases will be tagged run:// and nobody " +
          "else can fetch or verify your weights. Set it before working real epochs."
      );
    }
  }

  /** One pass: advance whatever the creature currently needs. */
  async tick(): Promise<void> {
    const v = await this.creature.vitals();
    if (v.epochs === 0n) return;

    // Walk backwards over recent epochs; act on the first that concerns us.
    const newest = v.epochs - 1n;
    const oldest = newest > 5n ? newest - 5n : 0n;
    for (let id = newest; id >= oldest; id--) {
      const job = await this.creature.jobSpec(id);
      await this.act(job);
      if (id === 0n) break;
    }
  }

  private async act(job: JobSpec): Promise<void> {
    const me = this.creature.account.address.toLowerCase();

    if (job.state === "OPEN") {
      if (job.bounty < config.minBountyWei) {
        console.log(`[worker] epoch ${job.id}: bounty ${formatEther(job.bounty)} below floor, skipping`);
        return;
      }
      if (!(await this.canWarmStart(job))) return;
      await this.claimAndTrain(job);
      return;
    }

    if (job.state === "CLAIMED") {
      const e = await this.creature.epoch(job.id);
      // Someone else's job, or ours from a previous process that died.
      if (e.worker.toLowerCase() === me) await this.train(job);
      return;
    }

    if (job.state === "SUBMITTED") {
      const e = await this.creature.epoch(job.id);
      if (e.worker.toLowerCase() !== me) return;
      // Try to finalize; it reverts until the challenge window closes.
      if (await this.creature.canWrite("finalize", [job.id])) {
        const hash = await this.creature.write("finalize", [job.id]);
        console.log(`[worker] epoch ${job.id} finalized, bounty collected: ${hash}`);
      }
      return;
    }

    if (job.state === "CHALLENGED") {
      const e = await this.creature.epoch(job.id);
      if (e.worker.toLowerCase() === me) {
        console.warn(
          `[worker] epoch ${job.id} CHALLENGED by ${e.challenger}. ` +
            `NOM holders now vote. Re-run the seed to prove your result.`
        );
      }
    }
  }

  /**
   * Never stake on an epoch whose base weights we cannot get: training from
   * scratch would diverge from every honest worker and lose the stake on
   * challenge. A `run://` URI only exists on the machine that produced it.
   */
  private async canWarmStart(job: JobSpec): Promise<boolean> {
    if (job.baseHash === ZERO_HASH) return true;
    const base = await this.creature.latestRelease();
    if (!base || base.hash !== job.baseHash) {
      console.log(`[worker] epoch ${job.id}: chain's base weights are unknown to me, skipping`);
      return false;
    }
    if (base.uri.startsWith("run://")) {
      const local = join(config.runsDir, base.uri.replace("run://", ""), "checkpoint.pt");
      if (!existsSync(local)) {
        console.log(
          `[worker] epoch ${job.id}: base weights were published as "${base.uri}" ` +
            `(local-only, not fetchable) and I don't have them — skipping`
        );
        return false;
      }
    }
    return true;
  }

  private async claimAndTrain(job: JobSpec): Promise<void> {
    const stake = config.stakeWei ?? (await this.creature.minStake());
    console.log(`[worker] claiming epoch ${job.id} (bounty ${formatEther(job.bounty)} ETH, stake ${formatEther(stake)})`);
    try {
      await this.creature.write("claimJob", [job.id], stake);
    } catch (e: any) {
      console.log(`[worker] lost the race for epoch ${job.id}: ${e.shortMessage ?? e.message}`);
      return;
    }
    await this.train(job);
  }

  private async train(job: JobSpec): Promise<void> {
    const dir = join(config.runsDir, `epoch-${job.id}`);
    const manifestPath = join(dir, "manifest.json");

    let artifact: TrainedArtifact;
    if (existsSync(manifestPath)) {
      const m = JSON.parse(readFileSync(manifestPath, "utf8"));
      artifact = { sha256: m.sha256, finalLoss: m.final_loss, dir };
      console.log(`[worker] reusing existing run for epoch ${job.id}`);
    } else {
      artifact = await this.runTrainer(job, dir);
    }

    const uri = config.hfRepo ? `https://huggingface.co/${config.hfRepo}` : `run://epoch-${job.id}`;
    const lossMilli = BigInt(Math.round(artifact.finalLoss * 1000));
    const hash = await this.creature.write("submitResult", [
      job.id,
      `0x${artifact.sha256}`,
      lossMilli,
      uri,
    ]);
    console.log(
      `[worker] epoch ${job.id} submitted: loss=${artifact.finalLoss.toFixed(4)} ` +
        `sha256=${artifact.sha256.slice(0, 12)}… tx=${hash}`
    );
  }

  private async runTrainer(job: JobSpec, dir: string): Promise<TrainedArtifact> {
    mkdirSync(dir, { recursive: true });
    const args = [
      join(config.modelDir, "suwa_wm", "train.py"),
      "--epoch", job.id.toString(),
      "--steps", String(job.steps),
      "--seed-hex", job.seed,
      "--out", dir,
    ];
    // The chain names the corpus. The trainer refuses to run on anything else,
    // so a worker cannot accidentally produce an unreproducible result.
    if (job.datasetHash && job.datasetHash !== ZERO_HASH) {
      args.push("--data-sha256", job.datasetHash);
    }
    // Warm-start from the model the chain says is current.
    const base = await this.creature.latestRelease();
    if (base && base.hash === job.baseHash) {
      args.push("--base-uri", base.uri, "--base-hash", base.hash.slice(2));
    }
    if (config.hfRepo && config.hfToken) args.push("--push", config.hfRepo);

    console.log(`[worker] training epoch ${job.id}: python3 ${args.join(" ")}`);
    await new Promise<void>((resolve, reject) => {
      const p = spawn("python3", args, {
        stdio: "inherit",
        env: { ...process.env, HF_TOKEN: config.hfToken ?? "" },
      });
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`trainer exited ${code}`))));
      p.on("error", reject);
    });

    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    // Never submit a hash we haven't independently recomputed from the weights
    // themselves. This is the canonical tensor hash, not a hash of the file.
    const actual = await canonicalHash(join(dir, manifest.file ?? "checkpoint.pt"));
    if (actual !== manifest.sha256) {
      throw new Error(`weights hash mismatch: manifest=${manifest.sha256} recomputed=${actual}`);
    }
    return { sha256: actual, finalLoss: manifest.final_loss, dir };
  }
}
