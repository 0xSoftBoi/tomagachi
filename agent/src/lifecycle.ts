/**
 * Shutting down without cutting anyone off mid-sentence.
 *
 * A completion in flight is a token stream someone is reading. Killing the
 * process under it produces a mid-stream error, which counts against uptime
 * the same as a crash — so every redeploy costs reliability, and a team that
 * notices that starts shipping less. Draining makes deploys free.
 *
 * The order matters: stop being routed to, then stop accepting, then wait for
 * what is already running, then exit. Readiness flips first so a load balancer
 * has a moment to look away before the door actually closes.
 */

export class Lifecycle {
  private inFlight = 0;
  private draining = false;
  private waiters: Array<() => void> = [];

  /** Called as a request starts. Returns false if we are already draining. */
  enter(): boolean {
    if (this.draining) return false;
    this.inFlight++;
    return true;
  }

  /** Called exactly once per successful enter(), including on the error path. */
  exit(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.inFlight === 0 && this.draining) {
      const waiting = this.waiters;
      this.waiters = [];
      for (const resolve of waiting) resolve();
    }
  }

  beginDrain(): void {
    this.draining = true;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  get active(): number {
    return this.inFlight;
  }

  /**
   * Resolves true once nothing is in flight, or false if the deadline passes
   * first. A stuck stream must not hold a deploy open forever.
   */
  whenIdle(timeoutMs: number): Promise<boolean> {
    if (this.inFlight === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      // Deliberately not unref'd: an unreferenced timer lets the event loop
      // empty and the process exit before the deadline can fire, which is the
      // one moment this timeout exists for. The wait is bounded and the caller
      // exits immediately after it, so nothing is held open.
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
