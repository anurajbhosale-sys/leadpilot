// Realistic misbehavior for mock providers: rate limits and occasional outages,
// so the pipeline's retry logic gets exercised the way a real API would exercise it.

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number, // HTTP-style: 429 rate limited, 503 unavailable, 401 unauthorized
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** Rate limits and server errors are worth retrying; auth and bad requests are not. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export type FaultOptions = {
  failureRate?: number; // share of requests that fail with a 503 (0 = never)
  maxRequestsPerSecond?: number; // beyond this, requests get a 429 with Retry-After
  random?: () => number; // injectable for deterministic tests
};

/** Default failure rate for mock providers: MOCK_PROVIDER_FAILURE_RATE, else 5%. */
export function defaultFailureRate(): number {
  const raw = process.env.MOCK_PROVIDER_FAILURE_RATE;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : 0.05;
}

export class MockFaults {
  private windowStart = 0;
  private requestsInWindow = 0;

  constructor(private opts: FaultOptions = {}) {}

  /** Call at the start of every mock API request. Throws like a real API would. */
  check(name: string): void {
    const now = Date.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.requestsInWindow = 0;
    }
    this.requestsInWindow++;
    const limit = this.opts.maxRequestsPerSecond;
    if (limit && this.requestsInWindow > limit) {
      throw new ProviderError(`${name}: 429 Too Many Requests`, 429, 1000 - (now - this.windowStart));
    }
    const random = this.opts.random ?? Math.random;
    if (this.opts.failureRate && random() < this.opts.failureRate) {
      throw new ProviderError(`${name}: 503 Service Unavailable (simulated)`, 503);
    }
  }
}
