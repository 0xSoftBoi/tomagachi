/**
 * Liveness and readiness are different questions, and answering only the first
 * one is how a router keeps feeding traffic into a dead GPU.
 *
 *   /healthz  is this process alive?        — never touches the network
 *   /ready    can this process serve?       — is the GPU behind it answering?
 *
 * Every request routed at an unready shop comes back 5xx, and 5xx is the error
 * class that costs routing priority. Saying "not ready" early is the same
 * trade as returning 429 under load: refuse cheaply rather than fail expensively.
 *
 * The probe is cached. A readiness endpoint that opens a connection to the GPU
 * on every call becomes its own load source, and orchestrators poll hard.
 */

export interface Readiness {
  ready: boolean;
  detail: string;
  checkedAt: number;
}

export class UpstreamHealth {
  private cached: Readiness | undefined;
  private inFlight: Promise<Readiness> | undefined;

  /**
   * @param probe performs one check; injected so tests do not need a socket
   * @param ttlMs how long a result stands before another probe is worth it
   * @param now injectable clock
   */
  constructor(
    private readonly probe: () => Promise<void>,
    private readonly ttlMs = 5_000,
    private readonly now: () => number = Date.now
  ) {}

  async status(): Promise<Readiness> {
    const t = this.now();
    if (this.cached && t - this.cached.checkedAt < this.ttlMs) return this.cached;
    // Collapse concurrent probes: a burst of readiness polls is one question.
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.probe()
      .then(() => ({ ready: true, detail: "upstream reachable", checkedAt: this.now() }))
      .catch((e: any) => ({
        ready: false,
        detail: `upstream unreachable: ${e?.message ?? e}`,
        checkedAt: this.now(),
      }))
      .then((result) => {
        this.cached = result;
        this.inFlight = undefined;
        return result;
      });
    return this.inFlight;
  }
}

/** The default probe: an OpenAI-compatible server always answers /models. */
export function httpProbe(baseUrl: string, apiKey?: string, timeoutMs = 3_000) {
  return async (): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const res = await fetch(`${baseUrl}/models`, { headers, signal: controller.signal });
      if (!res.ok) throw new Error(`status ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  };
}
