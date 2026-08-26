/**
 * Enforcing the capacity we declare.
 *
 * The manifest promises a requests-per-minute ceiling. Without something
 * holding us to it, a burst does not get refused — it gets queued behind a
 * full GPU, and queueing is indistinguishable from a slow model in the
 * throughput figure published on the model page. A 429 is the cheaper answer
 * in every direction: it is tracked apart from uptime, it tells the router to
 * go elsewhere for that request, and it arrives immediately.
 *
 * One limiter, not one per character. There is one GPU behind all five
 * adapters, so the ceiling is shared and the manifest's per-model capacity is
 * the most any single character may take of it.
 *
 * A sliding window rather than a fixed one: a fixed window lets twice the
 * limit through across a boundary, which is exactly the burst the GPU cannot
 * absorb.
 */

const WINDOW_MS = 60_000;

export class RateLimiter {
  private hits: number[] = [];

  /**
   * @param limitPerMinute requests allowed in any 60s window; 0 disables the limit
   * @param now injectable clock — the window edge is the interesting case to test
   */
  constructor(
    private readonly limitPerMinute: number,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Returns null when the request may proceed (and counts it), or the number
   * of seconds to wait when it may not. Never throws: a limiter that fails
   * open is better than one that takes the shop down.
   */
  take(): number | null {
    if (this.limitPerMinute <= 0) return null;

    const t = this.now();
    const cutoff = t - WINDOW_MS;
    // Timestamps are pushed in order, so the expired ones are always a prefix.
    let expired = 0;
    while (expired < this.hits.length && this.hits[expired] <= cutoff) expired++;
    if (expired) this.hits.splice(0, expired);

    if (this.hits.length >= this.limitPerMinute) {
      const oldest = this.hits[0];
      // Ceil so we never advise a retry that would still be refused.
      return Math.max(1, Math.ceil((oldest + WINDOW_MS - t) / 1000));
    }

    this.hits.push(t);
    return null;
  }

  /** Requests counted in the current window — reported by /metrics. */
  get inWindow(): number {
    const cutoff = this.now() - WINDOW_MS;
    return this.hits.filter((t) => t > cutoff).length;
  }

  get limit(): number {
    return this.limitPerMinute;
  }
}
