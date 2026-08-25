/**
 * Compute brokerage. The creature buys GPU/CPU time with USDC; the purchase
 * itself is recorded on-chain by the brain (buyCompute) before dispatch.
 *
 * Providers:
 *  - LocalProvider:  trains on this machine (bootstrap mode, price 0). The
 *    creature starts life training on whatever host runs its brain.
 *  - RemoteProvider: POSTs the job spec to any HTTP training endpoint (an
 *    Akash / io.net / Prime Intellect style worker, or another Suwappu agent
 *    selling x402 pay-per-job compute) and polls for the artifact.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export interface JobSpec {
  epoch: number;
  steps: number;
  outDir: string; // where checkpoint.pt + manifest.json land
}

export interface JobResult {
  manifest: {
    epoch: number;
    steps: number;
    final_loss: number;
    sha256: string;
    file: string;
  };
  artifactPath: string;
}

export interface ComputeProvider {
  readonly name: string;
  readonly priceUsdc: bigint; // 6dp; 0 => no on-chain purchase needed
  readonly payTo?: `0x${string}`;
  run(spec: JobSpec): Promise<JobResult>;
}

function readManifest(outDir: string): JobResult {
  const manifestPath = join(outDir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`no manifest at ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const artifactPath = join(outDir, manifest.file ?? "checkpoint.pt");
  // Verify the hash the trainer claims — this is what goes on-chain.
  const actual = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
  if (actual !== manifest.sha256) {
    throw new Error(`artifact hash mismatch: manifest=${manifest.sha256} actual=${actual}`);
  }
  return { manifest, artifactPath };
}

export class LocalProvider implements ComputeProvider {
  readonly name = "local";
  readonly priceUsdc = 0n;

  async run(spec: JobSpec): Promise<JobResult> {
    mkdirSync(spec.outDir, { recursive: true });
    const args = [
      join(config.modelDir, "suwa_wm", "train.py"),
      "--epoch", String(spec.epoch),
      "--steps", String(spec.steps),
      "--out", spec.outDir,
    ];
    if (config.hfRepo && config.hfToken) args.push("--push", config.hfRepo);

    console.log(`[compute:local] python3 ${args.join(" ")}`);
    await new Promise<void>((resolve, reject) => {
      const p = spawn("python3", args, {
        stdio: "inherit",
        env: { ...process.env, HF_TOKEN: config.hfToken ?? "" },
      });
      p.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`trainer exited ${code}`))
      );
      p.on("error", reject);
    });
    return readManifest(spec.outDir);
  }
}

export class RemoteProvider implements ComputeProvider {
  readonly name: string;
  readonly priceUsdc: bigint;
  readonly payTo?: `0x${string}`;

  constructor() {
    if (!config.computeEndpoint) throw new Error("set COMPUTE_ENDPOINT for remote compute");
    this.name = new URL(config.computeEndpoint).host;
    this.priceUsdc = config.computePriceUsdc;
    this.payTo = config.computePayTo;
  }

  async run(spec: JobSpec): Promise<JobResult> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.computeApiKey) headers.authorization = `Bearer ${config.computeApiKey}`;

    const submit = await fetch(`${config.computeEndpoint}/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        image: "tomagachi/suwa-wm-trainer",
        cmd: ["python3", "train.py", "--epoch", String(spec.epoch), "--steps", String(spec.steps)],
        epoch: spec.epoch,
        steps: spec.steps,
      }),
    });
    if (!submit.ok) throw new Error(`compute submit ${submit.status}: ${await submit.text()}`);
    const { id } = (await submit.json()) as { id: string };
    console.log(`[compute:${this.name}] job ${id} submitted`);

    // Poll until the worker reports done, then download the artifact + manifest.
    for (;;) {
      await new Promise((r) => setTimeout(r, 30_000));
      const res = await fetch(`${config.computeEndpoint}/jobs/${id}`, { headers });
      if (!res.ok) throw new Error(`compute poll ${res.status}`);
      const job = (await res.json()) as { status: string; error?: string };
      if (job.status === "failed") throw new Error(`remote job failed: ${job.error}`);
      if (job.status === "done") break;
    }

    mkdirSync(spec.outDir, { recursive: true });
    for (const f of ["manifest.json", "checkpoint.pt"]) {
      const res = await fetch(`${config.computeEndpoint}/jobs/${id}/artifacts/${f}`, { headers });
      if (!res.ok) throw new Error(`artifact ${f}: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(spec.outDir, f), buf);
    }
    return readManifest(spec.outDir);
  }
}

export function makeProvider(): ComputeProvider {
  return config.computeProvider === "remote" ? new RemoteProvider() : new LocalProvider();
}
