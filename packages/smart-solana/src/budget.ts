export function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly rate: number,
    private readonly capacity: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.updatedAt = now();
  }

  private refill(): void {
    const current = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((current - this.updatedAt) / 1_000) * this.rate);
    this.updatedAt = current;
  }

  delayMs(cost = 1): number {
    this.refill();
    if (this.tokens >= cost) return 0;
    return ((cost - this.tokens) / this.rate) * 1_000;
  }

  take(cost = 1): void {
    this.refill();
    this.deduct(cost);
  }

  deduct(cost = 1): void {
    this.tokens -= cost;
  }
}

export class RequestBudget {
  private readonly global: TokenBucket;
  private readonly methods = new Map<string, TokenBucket>();

  constructor(
    rps: number,
    burst: number,
    private readonly methodRps: Readonly<Record<string, number>> = {},
    now: () => number = Date.now,
  ) {
    this.global = new TokenBucket(rps, burst, now);
    this.now = now;
  }

  private readonly now: () => number;

  private methodBucket(method: string): TokenBucket | undefined {
    const rate = this.methodRps[method] ?? this.methodRps["*"];
    if (rate === undefined) return undefined;
    let bucket = this.methods.get(method);
    if (!bucket) {
      bucket = new TokenBucket(rate, Math.max(1, Math.ceil(rate)), this.now);
      this.methods.set(method, bucket);
    }
    return bucket;
  }

  async acquire(method: string, signal?: AbortSignal): Promise<void> {
    const methodBucket = this.methodBucket(method);
    for (;;) {
      if (signal?.aborted) throw abortError();
      const delay = Math.max(this.global.delayMs(), methodBucket?.delayMs() ?? 0);
      if (delay <= 0) {
        this.global.deduct();
        methodBucket?.deduct();
        return;
      }
      await sleep(Math.max(1, delay), signal);
    }
  }
}
