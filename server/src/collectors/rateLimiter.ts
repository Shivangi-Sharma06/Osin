export interface RateLimiterOptions {
  nowFn?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Sequential min-interval limiter: guarantees at least `60_000 / rpm` ms
 * between successive acquires. Each collector owns one instance.
 */
export class RateLimiter {
  private readonly minIntervalMs: number;
  private lastAcquire = Number.NEGATIVE_INFINITY;
  private readonly nowFn: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(requestsPerMinute: number, options: RateLimiterOptions = {}) {
    if (!Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0) {
      throw new Error('requestsPerMinute must be a positive number');
    }
    this.minIntervalMs = 60_000 / requestsPerMinute;
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.sleepFn =
      options.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async acquire(): Promise<void> {
    const now = this.nowFn();
    const waitMs = this.lastAcquire + this.minIntervalMs - now;
    if (waitMs > 0) {
      await this.sleepFn(waitMs);
      this.lastAcquire = this.nowFn();
    } else {
      this.lastAcquire = now;
    }
  }
}
