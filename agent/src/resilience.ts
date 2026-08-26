/**
 * Surviving a bad moment without making it a bad minute.
 *
 * Two failure shapes need different answers. A single dropped connection is
 * noise: retrying once costs milliseconds and turns a 502 into a completion,
 * and 5xx is the error class that costs routing priority. A GPU that is
 * genuinely down is not noise: retrying into it doubles the load on something
 * already failing and makes every caller wait out a timeout first.
 *
 * So: retry once, and after enough consecutive failures stop trying at all
 * until a cooldown has passed. The breaker's open state is also the honest
 * answer for /ready — if we are not attempting requests, we are not ready.
 */

export type BreakerState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;

  /**
   * @param threshold consecutive failures before the breaker opens
   * @param cooldownMs how long to stay open before allowing one trial through
   */
  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 10_000,
    private readonly now: () => number = Date.now
  ) {}

  get state(): BreakerState {
    if (this.failures < this.threshold) return "closed";
    if (this.now() - this.openedAt >= this.cooldownMs) return "half-open";
    return "open";
  }

  /** False means fail fast: do not open a connection to something that is down. */
  canAttempt(): boolean {
    const state = this.state;
    if (state === "closed") return true;
    if (state === "open") return false;
    // Half-open: exactly one request gets to find out whether it recovered.
    if (this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  onSuccess(): void {
    this.failures = 0;
    this.trialInFlight = false;
  }

  onFailure(): void {
    this.failures++;
    this.trialInFlight = false;
    // Restart the cooldown on the failure that opens it, and on a failed trial.
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }
}

export class BreakerOpenError extends Error {
  readonly status = 503;
  constructor(cooldownMs: number) {
    super(`upstream circuit open — not attempting for up to ${Math.ceil(cooldownMs / 1000)}s`);
  }
}

export interface RetryOptions {
  /** Extra attempts after the first. One is almost always the right number. */
  retries?: number;
  /** Transient failures are worth another try; a rejected request is not. */
  shouldRetry?: (error: any) => boolean;
  breaker?: CircuitBreaker;
  onRetry?: (error: any, attempt: number) => void;
  cooldownMs?: number;
}

/**
 * A 4xx means the request was wrong and will be wrong again. A 429 means
 * saturation, which the caller should hear about immediately rather than after
 * we have queued a retry behind the same full GPU.
 */
export function isTransient(error: any): boolean {
  const status = error?.status ?? error?.upstreamStatus;
  if (status === 429) return false;
  if (typeof status === "number" && status >= 400 && status < 500) return false;
  return true;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 1;
  const shouldRetry = opts.shouldRetry ?? isTransient;
  const breaker = opts.breaker;

  if (breaker && !breaker.canAttempt()) {
    throw new BreakerOpenError(opts.cooldownMs ?? 10_000);
  }

  let lastError: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await fn();
      breaker?.onSuccess();
      return result;
    } catch (e) {
      lastError = e;
      const more = attempt < retries && shouldRetry(e);
      if (!more) break;
      opts.onRetry?.(e, attempt + 1);
    }
  }
  // Only a genuinely transient failure counts toward opening the breaker: a
  // stream of 400s from one broken caller must not take the shop offline.
  if (shouldRetry(lastError)) breaker?.onFailure();
  else breaker?.onSuccess();
  throw lastError;
}
