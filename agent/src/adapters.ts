/**
 * Serving the epoch we just trained.
 *
 * The compounding story — community compute accumulating into one improving
 * character — only pays off if what was trained is what gets served. Until now
 * a released epoch sat on disk while the GPU kept serving the previous one,
 * and the gap closed whenever somebody happened to run a script.
 *
 * Two steps: convert the adapter into the PEFT layout vLLM loads, then ask
 * vLLM to swap it in place. In place matters — restarting the server per epoch
 * would mean permanent partial downtime, and under 95% uptime costs routing
 * priority.
 *
 * Neither step is allowed to fail the epoch. By the time this runs the weights
 * exist, the eval passed the gate, and the hash is on-chain. A reload that
 * fails is a serving problem to retry, not a reason to lose a good epoch.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { config } from "./config.js";

export interface PublishResult {
  exported: boolean;
  reloaded: boolean;
  path?: string;
  error?: string;
}

/** Run the PEFT export for one run directory. Resolves false rather than throwing. */
export function exportAdapter(runDir: string, characterId: string): Promise<string | null> {
  const outDir = join(config.servingDir, characterId);
  const script = join(config.modelDir, "suwa_lm", "export_peft.py");
  return new Promise((resolve) => {
    const p = spawn("python3", [script, runDir, "--out", outDir], { stdio: "inherit" });
    p.on("exit", (code) => resolve(code === 0 ? outDir : null));
    p.on("error", () => resolve(null));
  });
}

/**
 * Ask the inference server to swap this adapter in without a restart.
 * Requires VLLM_ALLOW_RUNTIME_LORA_UPDATING on the server side.
 */
export async function reloadAdapter(
  characterId: string,
  path: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; detail: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.upstreamApiKey) headers.authorization = `Bearer ${config.upstreamApiKey}`;
  try {
    const res = await fetchImpl(`${config.upstreamBaseUrl}/load_lora_adapter`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        lora_name: characterId,
        lora_path: path,
        // Replace the adapter already registered under this name; without it a
        // second epoch is a duplicate-name error rather than an upgrade.
        load_inplace: true,
      }),
    });
    if (!res.ok) return { ok: false, detail: `status ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { ok: true, detail: "swapped in place" };
  } catch (e: any) {
    return { ok: false, detail: e?.message ?? String(e) };
  }
}

/** Export then reload. Reports what happened; never throws. */
export async function publishEpoch(
  runDir: string,
  characterId: string,
  fetchImpl: typeof fetch = fetch
): Promise<PublishResult> {
  if (!config.publishAdapters) {
    return { exported: false, reloaded: false, error: "publishing disabled" };
  }

  const path = await exportAdapter(runDir, characterId);
  if (!path) return { exported: false, reloaded: false, error: "export failed" };

  const reload = await reloadAdapter(characterId, path, fetchImpl);
  return { exported: true, reloaded: reload.ok, path, error: reload.ok ? undefined : reload.detail };
}
