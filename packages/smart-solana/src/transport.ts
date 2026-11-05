import { RequestBudget, abortError } from "./budget.js";
import { ResponseCache } from "./cache.js";
import {
  AllEndpointsFailedError,
  EndpointError,
  isAbortError,
  isRetryableError,
  parseRetryAfter,
  redactUrl,
} from "./errors.js";
import {
  cacheKey,
  defaultCacheTtl,
  isCacheableMethod,
  isHedgeableMethod,
  isRebroadcastMethod,
  isRetryableMethod,
} from "./methods.js";
import { defaultEndpoints, defaultGenesisHash } from "./registry.js";
import { emptyStat, endpointScore, observe, type MethodStat } from "./score.js";
import type {
  BulkOptions,
  Endpoint,
  EndpointSnapshot,
  JsonRpcRequest,
  JsonRpcResponse,
  PoolSnapshot,
  RequestOptions,
  RpcEvent,
  RpcInput,
  SolanaOptions,
  SolanaTransport,
} from "./types.js";

interface RuntimeEndpoint {
  url: string;
  label: string;
  weight: number;
  headers: Readonly<Record<string, string>>;
  batchMode: boolean | "same-method";
  unsupportedMethods: ReadonlySet<string>;
  budget: RequestBudget;
  global: MethodStat;
  methods: Map<string, MethodStat>;
  inFlight: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  cooldownUntil: number;
  quarantined: boolean;
  verified: boolean;
  verification?: Promise<void>;
  lastSlot?: number;
}

interface BatchItem {
  request: JsonRpcRequest;
  signal?: AbortSignal;
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
}

interface NormalizedOptions {
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
  hedgeDelayMs?: number;
  coalesce: boolean;
  batch: false | { maxSize: number; waitMs: number };
  cache:
    | false
    | {
        ttlMs: number;
        methodTtlMs: Readonly<Record<string, number>>;
        staleWhileRevalidate: boolean;
      };
  healthIntervalMs?: number;
  maxSlotLag: number;
  failureThreshold: number;
  breakerCooldownMs: number;
  rebroadcastTransactions: boolean;
  nonRetryableMethods: readonly string[];
  genesisHash: string | false;
}

const RETRYABLE_RPC_CODES = new Set([-32601, -32603, -32000, -32001, -32003, -32004, -32007, -32008, -32009, -32011]);
const RATE_LIMIT_RPC_CODES = new Set([429, -32029]);

function positive(value: number | undefined, fallback: number, name: string, allowZero = false): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || (allowZero ? resolved < 0 : resolved <= 0)) {
    throw new Error(`${name} must be ${allowZero ? "non-negative" : "positive"}`);
  }
  return resolved;
}

function normalizeOptions(options: SolanaOptions): NormalizedOptions {
  const cluster = options.cluster ?? "mainnet-beta";
  const cache =
    options.cache === false
      ? false
      : {
          ttlMs: positive(
            typeof options.cache === "object" ? options.cache.ttlMs : undefined,
            750,
            "cache.ttlMs",
            true,
          ),
          methodTtlMs: (typeof options.cache === "object" ? options.cache.methodTtlMs : undefined) ?? {},
          staleWhileRevalidate:
            (typeof options.cache === "object" ? options.cache.staleWhileRevalidate : undefined) ?? true,
        };
  const health =
    options.health === false
      ? undefined
      : (typeof options.health === "object" ? options.health.intervalMs : undefined) === false
        ? undefined
        : positive(
            typeof options.health === "object" && typeof options.health.intervalMs === "number"
              ? options.health.intervalMs
              : undefined,
            30_000,
            "health.intervalMs",
          );
  return {
    timeoutMs: positive(options.timeoutMs, 5_000, "timeoutMs"),
    retries: Math.floor(positive(options.retries, 3, "retries", true)),
    retryDelayMs: positive(options.retryDelayMs, 150, "retryDelayMs", true),
    hedgeDelayMs:
      options.hedge === false
        ? undefined
        : positive(typeof options.hedge === "object" ? options.hedge.delayMs : undefined, 300, "hedge.delayMs", true),
    coalesce: options.coalesce ?? true,
    batch:
      options.batch === false
        ? false
        : {
            maxSize: Math.floor(
              positive(typeof options.batch === "object" ? options.batch.maxSize : undefined, 20, "batch.maxSize"),
            ),
            waitMs: positive(
              typeof options.batch === "object" ? options.batch.waitMs : undefined,
              0,
              "batch.waitMs",
              true,
            ),
          },
    cache,
    healthIntervalMs: health,
    maxSlotLag: positive(
      typeof options.health === "object" ? options.health.maxSlotLag : undefined,
      150,
      "health.maxSlotLag",
      true,
    ),
    failureThreshold: Math.floor(
      positive(
        typeof options.circuitBreaker === "object" ? options.circuitBreaker.failureThreshold : undefined,
        3,
        "circuitBreaker.failureThreshold",
      ),
    ),
    breakerCooldownMs: positive(
      typeof options.circuitBreaker === "object" ? options.circuitBreaker.cooldownMs : undefined,
      10_000,
      "circuitBreaker.cooldownMs",
      true,
    ),
    rebroadcastTransactions: options.rebroadcastTransactions ?? true,
    nonRetryableMethods: options.nonRetryableMethods ?? [],
    genesisHash: options.genesisHash ?? defaultGenesisHash(cluster),
  };
}

function normalizeEndpoints(options: SolanaOptions): RuntimeEndpoint[] {
  const cluster = options.cluster ?? "mainnet-beta";
  const source = options.endpoints ?? defaultEndpoints(cluster);
  if (source.length === 0) throw new Error("At least one Solana RPC endpoint is required");
  const labels = new Set<string>();
  return source.map((input, index) => {
    const endpoint: Endpoint = typeof input === "string" ? { url: input } : input;
    const url = new URL(endpoint.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`Unsupported Solana RPC protocol: ${url.protocol}`);
    }
    const baseLabel = endpoint.label ?? url.hostname;
    let label = baseLabel;
    for (let suffix = 2; labels.has(label); suffix += 1) label = `${baseLabel}-${suffix}`;
    labels.add(label);
    const rps = positive(endpoint.rps, 5, `endpoints[${index}].rps`);
    const burst = positive(endpoint.burst, Math.max(1, Math.ceil(rps)), `endpoints[${index}].burst`);
    return {
      url: endpoint.url,
      label,
      weight: positive(endpoint.weight, 1, `endpoints[${index}].weight`),
      headers: endpoint.headers ?? {},
      batchMode: endpoint.batch ?? true,
      unsupportedMethods: new Set(endpoint.unsupportedMethods),
      budget: new RequestBudget(rps, burst, endpoint.methodRps),
      global: emptyStat(),
      methods: new Map(),
      inFlight: 0,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      cooldownUntil: 0,
      quarantined: false,
      verified: false,
    };
  });
}

function cloneResponse(response: JsonRpcResponse, id: JsonRpcRequest["id"]): JsonRpcResponse {
  return { ...response, id };
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function linkedSignal(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (!parent) return () => {};
  const onAbort = (): void => child.abort();
  if (parent.aborted) child.abort();
  else parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}

function responseSlot(response: JsonRpcResponse): number | undefined {
  if (typeof response.result === "number") return response.result;
  if (typeof response.result !== "object" || response.result === null || !("context" in response.result)) {
    return undefined;
  }
  const context = response.result.context;
  if (typeof context !== "object" || context === null || !("slot" in context)) return undefined;
  return typeof context.slot === "number" ? context.slot : undefined;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

class RpcPool {
  readonly endpoints: RuntimeEndpoint[];
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly options: NormalizedOptions;
  private readonly onEvent?: (event: RpcEvent) => void;
  private readonly cache: ResponseCache;
  private readonly inFlight = new Map<string, Promise<JsonRpcResponse>>();
  private readonly refreshing = new Set<string>();
  private readonly batches = new Map<string, BatchItem[]>();
  private readonly batchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private healthTimer?: ReturnType<typeof setInterval>;
  private lastActivity = 0;
  private lastProbe = 0;
  private batchId = 0;
  private pendingRequests = 0;
  private highestSlot?: number;
  private closed = false;

  constructor(options: SolanaOptions) {
    this.options = normalizeOptions(options);
    this.endpoints = normalizeEndpoints(options);
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) throw new Error("This runtime requires a fetch implementation");
    this.fetchImpl = fetchImpl.bind(globalThis);
    this.onEvent = options.onEvent;
    const maxEntries =
      this.options.cache === false
        ? 0
        : Math.floor(
            positive(
              typeof options.cache === "object" ? options.cache.maxEntries : undefined,
              1_000,
              "cache.maxEntries",
            ),
          );
    this.cache = new ResponseCache(maxEntries);
  }

  async execute(request: JsonRpcRequest, options: RequestOptions = {}): Promise<JsonRpcResponse> {
    if (this.closed) throw new Error("The Solana RPC transport is closed");
    if (options.signal?.aborted) throw abortError();
    const cacheable = this.options.cache !== false && !options.skipCache && isCacheableMethod(request.method);
    let key: string | undefined;

    if (cacheable) {
      key = cacheKey(request.method, request.params);
      const hit = this.cache.get(key);
      if (hit && !hit.stale) {
        this.emit({ type: "cacheHit", method: request.method });
        return cloneResponse(hit.response, request.id);
      }
      if (hit && this.options.cache !== false && this.options.cache.staleWhileRevalidate) {
        this.refresh(key, request);
        return cloneResponse(hit.response, request.id);
      }
    }

    const canCoalesce = this.options.coalesce && isRetryableMethod(request.method, this.options.nonRetryableMethods);
    if (canCoalesce) {
      key ??= cacheKey(request.method, request.params);
      const coalesceKey = key;
      let pending = this.inFlight.get(coalesceKey);
      if (!pending) {
        pending = this.network(request, options.skipCache ?? false, undefined, coalesceKey);
        this.inFlight.set(coalesceKey, pending);
        void pending.then(
          () => {
            if (this.inFlight.get(coalesceKey) === pending) this.inFlight.delete(coalesceKey);
          },
          () => {
            if (this.inFlight.get(coalesceKey) === pending) this.inFlight.delete(coalesceKey);
          },
        );
      }
      return cloneResponse(await abortable(pending, options.signal), request.id);
    }
    return this.network(request, options.skipCache ?? false, options.signal, key);
  }

  snapshot(): PoolSnapshot {
    const endpoints = this.endpoints.map((endpoint): EndpointSnapshot => {
      const lag =
        endpoint.lastSlot === undefined || this.highestSlot === undefined
          ? undefined
          : Math.max(0, this.highestSlot - endpoint.lastSlot);
      return {
        label: endpoint.label,
        score: endpointScore({
          global: endpoint.global,
          maxSlotLag: this.options.maxSlotLag,
          weight: endpoint.weight,
          ...(lag === undefined ? {} : { slotLag: lag }),
        }),
        latencyMs: endpoint.global.latencyMs,
        tailMs: endpoint.global.tailMs,
        errorRate: endpoint.global.errorRate,
        samples: endpoint.global.samples,
        inFlight: endpoint.inFlight,
        successes: endpoint.successes,
        failures: endpoint.failures,
        consecutiveFailures: endpoint.consecutiveFailures,
        cooldownUntil: endpoint.cooldownUntil,
        quarantined: endpoint.quarantined,
        ...(endpoint.lastSlot === undefined ? {} : { lastSlot: endpoint.lastSlot }),
        ...(lag === undefined ? {} : { slotLag: lag }),
      };
    });
    return {
      ...(this.highestSlot === undefined ? {} : { highestSlot: this.highestSlot }),
      cacheEntries: this.cache.size,
      pendingRequests: this.pendingRequests,
      closed: this.closed,
      endpoints,
    };
  }

  clearCache(): void {
    this.cache.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    for (const [label, timer] of this.batchTimers) {
      clearTimeout(timer);
      this.batchTimers.delete(label);
      const queue = this.batches.get(label) ?? [];
      this.batches.delete(label);
      for (const item of queue) item.reject(new Error("The Solana RPC transport is closed"));
    }
  }

  private emit(event: RpcEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      return;
    }
  }

  private refresh(key: string, request: JsonRpcRequest): void {
    if (this.refreshing.has(key) || this.closed) return;
    this.refreshing.add(key);
    this.emit({ type: "cacheRefresh", method: request.method });
    void this.network(request, false, undefined, key)
      .catch((error: unknown) => {
        this.emit({
          type: "backgroundError",
          method: request.method,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      })
      .finally(() => this.refreshing.delete(key));
  }

  private async network(
    request: JsonRpcRequest,
    skipCache: boolean,
    signal?: AbortSignal,
    key?: string,
  ): Promise<JsonRpcResponse> {
    this.pendingRequests += 1;
    this.lastActivity = Date.now();
    this.startHealth();
    try {
      const response = await this.resilient(request, signal);
      this.observeSlot(response);
      if (!skipCache && this.options.cache !== false && isCacheableMethod(request.method) && !response.error) {
        const ttl =
          this.options.cache.methodTtlMs[request.method] ?? defaultCacheTtl(request.method, this.options.cache.ttlMs);
        this.cache.set(key ?? cacheKey(request.method, request.params), response, ttl);
      }
      return response;
    } finally {
      this.pendingRequests -= 1;
    }
  }

  private async resilient(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    const retryableMethod =
      isRetryableMethod(request.method, this.options.nonRetryableMethods) &&
      (!isRebroadcastMethod(request.method) || this.options.rebroadcastTransactions);
    const canHedge =
      this.options.hedgeDelayMs !== undefined && isHedgeableMethod(request.method, this.options.nonRetryableMethods);

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const errors: Error[] = [];
      const used = new Set<string>();
      const controllers = new Set<AbortController>();
      let active = 0;
      let launched = 0;
      let settled = false;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (retryTimer) clearTimeout(retryTimer);
        if (hedgeTimer) clearTimeout(hedgeTimer);
        signal?.removeEventListener("abort", onAbort);
        for (const controller of controllers) controller.abort();
        controllers.clear();
      };
      const succeed = (response: JsonRpcResponse): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(response);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = (): void => fail(abortError());
      signal?.addEventListener("abort", onAbort, { once: true });

      const scheduleRetry = (): void => {
        if (settled || active > 0) return;
        if (!retryableMethod || launched > this.options.retries) {
          fail(new AllEndpointsFailedError(request.method, errors));
          return;
        }
        const cooldown = this.nextCooldownMs(request.method);
        const delay = Math.max(cooldown, this.options.retryDelayMs * 2 ** Math.max(0, launched - 1));
        this.emit({ type: "retry", method: request.method, attempt: launched + 1 });
        retryTimer = setTimeout(launch, Math.min(delay, 30_000));
      };

      const launch = (): void => {
        if (settled || signal?.aborted) return;
        let endpoint = this.selectEndpoint(request.method, used);
        if (!endpoint && used.size > 0) {
          used.clear();
          endpoint = this.selectEndpoint(request.method, used);
        }
        if (!endpoint) {
          if (
            this.endpoints.every(
              (candidate) => candidate.quarantined || candidate.unsupportedMethods.has(request.method),
            )
          ) {
            launched = this.options.retries + 1;
          }
          scheduleRetry();
          return;
        }
        used.add(endpoint.label);
        launched += 1;
        active += 1;
        const controller = new AbortController();
        controllers.add(controller);
        const unlink = linkedSignal(signal, controller);
        const attempt = launched;
        this.emit({ type: "attempt", method: request.method, endpoint: endpoint.label, attempt });
        void this.attempt(endpoint, request, controller.signal).then(
          (response) => {
            active -= 1;
            controllers.delete(controller);
            unlink();
            succeed(response);
          },
          (error: unknown) => {
            active -= 1;
            controllers.delete(controller);
            unlink();
            const normalized = error instanceof Error ? error : new Error("Unknown endpoint error");
            errors.push(normalized);
            this.emit({
              type: "error",
              method: request.method,
              endpoint: endpoint.label,
              attempt,
              error: normalized.message,
            });
            if (controller.signal.aborted && signal?.aborted) {
              fail(abortError());
              return;
            }
            if (!retryableMethod || !isRetryableError(normalized)) {
              fail(normalized);
              return;
            }
            scheduleRetry();
          },
        );
      };

      launch();
      if (canHedge && this.options.retries > 0) {
        hedgeTimer = setTimeout(() => {
          if (!settled && active > 0 && launched <= this.options.retries) {
            this.emit({ type: "hedge", method: request.method, attempt: launched + 1 });
            launch();
          }
        }, this.options.hedgeDelayMs);
      }
    });
  }

  private nextCooldownMs(method: string): number {
    const now = Date.now();
    const delays = this.endpoints
      .filter((endpoint) => !endpoint.quarantined && !endpoint.unsupportedMethods.has(method))
      .map((endpoint) => Math.max(0, endpoint.cooldownUntil - now));
    return delays.length > 0 && delays.every((delay) => delay > 0) ? Math.min(...delays) : 0;
  }

  private selectEndpoint(method: string, excluded: ReadonlySet<string>): RuntimeEndpoint | undefined {
    const now = Date.now();
    let best: RuntimeEndpoint | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    let hasSampled = false;
    for (const endpoint of this.endpoints) {
      if (
        endpoint.quarantined ||
        endpoint.unsupportedMethods.has(method) ||
        endpoint.cooldownUntil > now ||
        excluded.has(endpoint.label)
      ) {
        continue;
      }
      const sampled = endpoint.global.samples > 0;
      if (hasSampled && !sampled) continue;
      if (sampled && !hasSampled) {
        hasSampled = true;
        best = undefined;
        bestScore = Number.POSITIVE_INFINITY;
      }
      const score = this.score(endpoint, method);
      if (score < bestScore) {
        best = endpoint;
        bestScore = score;
      }
    }
    return best;
  }

  private score(endpoint: RuntimeEndpoint, method: string): number {
    const lag =
      endpoint.lastSlot === undefined || this.highestSlot === undefined
        ? undefined
        : Math.max(0, this.highestSlot - endpoint.lastSlot);
    return endpointScore({
      global: endpoint.global,
      method: endpoint.methods.get(method),
      maxSlotLag: this.options.maxSlotLag,
      weight: endpoint.weight,
      ...(lag === undefined ? {} : { slotLag: lag }),
    });
  }

  private async attempt(
    endpoint: RuntimeEndpoint,
    request: JsonRpcRequest,
    signal: AbortSignal,
  ): Promise<JsonRpcResponse> {
    const started = performance.now();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.options.timeoutMs);
    const attemptController = new AbortController();
    const unlinkCaller = linkedSignal(signal, attemptController);
    const unlinkTimeout = linkedSignal(timeout.signal, attemptController);
    endpoint.inFlight += 1;
    try {
      await endpoint.budget.acquire(request.method, attemptController.signal);
      await this.verify(endpoint, attemptController.signal);
      const response = await this.dispatch(endpoint, request, attemptController.signal);
      if (response.error) {
        const failure = this.rpcError(endpoint, response.error);
        if (failure.retryable) throw failure;
      }
      this.recordSuccess(endpoint, request.method, performance.now() - started);
      this.observeEndpointSlot(endpoint, response);
      return response;
    } catch (error) {
      if (timeout.signal.aborted) {
        const timeoutError = new EndpointError(endpoint.label, `timed out after ${this.options.timeoutMs}ms`);
        this.recordFailure(endpoint, request.method, performance.now() - started, timeoutError);
        throw timeoutError;
      }
      if (signal.aborted || isAbortError(error)) throw error;
      const normalized = error instanceof Error ? error : new Error("Unknown endpoint error");
      this.recordFailure(endpoint, request.method, performance.now() - started, normalized);
      throw normalized;
    } finally {
      clearTimeout(timer);
      unlinkCaller();
      unlinkTimeout();
      endpoint.inFlight -= 1;
    }
  }

  private recordSuccess(endpoint: RuntimeEndpoint, method: string, latencyMs: number): void {
    observe(endpoint.global, latencyMs, true);
    let stat = endpoint.methods.get(method);
    if (!stat) {
      stat = emptyStat();
      endpoint.methods.set(method, stat);
    }
    observe(stat, latencyMs, true);
    endpoint.successes += 1;
    endpoint.consecutiveFailures = 0;
    endpoint.cooldownUntil = 0;
    this.emit({ type: "success", method, endpoint: endpoint.label, latencyMs });
  }

  private recordFailure(endpoint: RuntimeEndpoint, method: string, latencyMs: number, error: Error): void {
    observe(endpoint.global, latencyMs, false);
    let stat = endpoint.methods.get(method);
    if (!stat) {
      stat = emptyStat();
      endpoint.methods.set(method, stat);
    }
    observe(stat, latencyMs, false);
    endpoint.failures += 1;
    endpoint.consecutiveFailures += 1;
    if (error instanceof EndpointError && error.rateLimited) {
      const backoff = Math.min(30_000, 1_000 * 2 ** Math.min(5, endpoint.consecutiveFailures - 1));
      endpoint.cooldownUntil = Date.now() + (error.retryAfterMs ?? backoff);
      this.emit({ type: "rateLimit", method, endpoint: endpoint.label });
    } else if (error instanceof EndpointError && (error.status === 401 || error.status === 403)) {
      endpoint.cooldownUntil = Date.now() + 60_000;
    }
    if (endpoint.consecutiveFailures >= this.options.failureThreshold) {
      endpoint.cooldownUntil = Math.max(endpoint.cooldownUntil, Date.now() + this.options.breakerCooldownMs);
      this.emit({ type: "breakerOpen", method, endpoint: endpoint.label });
    }
  }

  private rpcError(endpoint: RuntimeEndpoint, error: NonNullable<JsonRpcResponse["error"]>): EndpointError {
    const rateLimited = RATE_LIMIT_RPC_CODES.has(error.code) || /too many requests|rate.?limit/i.test(error.message);
    const retryable = rateLimited || RETRYABLE_RPC_CODES.has(error.code);
    return new EndpointError(endpoint.label, error.message, {
      rpcCode: error.code,
      retryable,
      rateLimited,
    });
  }

  private async verify(endpoint: RuntimeEndpoint, signal: AbortSignal): Promise<void> {
    if (this.options.genesisHash === false || endpoint.verified) return;
    if (!endpoint.verification) {
      const expected = this.options.genesisHash;
      endpoint.verification = (async () => {
        await endpoint.budget.acquire("getGenesisHash");
        const response = await this.rawFetch(
          endpoint,
          { jsonrpc: "2.0", id: `verify-${endpoint.label}`, method: "getGenesisHash" },
          undefined,
        );
        if (Array.isArray(response) || response.result !== expected) {
          endpoint.quarantined = true;
          endpoint.cooldownUntil = Number.POSITIVE_INFINITY;
          this.emit({ type: "endpointQuarantined", method: "getGenesisHash", endpoint: endpoint.label });
          throw new EndpointError(endpoint.label, "returned a genesis hash for another cluster");
        }
        endpoint.verified = true;
      })().catch((error: unknown) => {
        endpoint.verification = undefined;
        throw error;
      });
    }
    await abortable(endpoint.verification, signal);
  }

  private dispatch(endpoint: RuntimeEndpoint, request: JsonRpcRequest, signal: AbortSignal): Promise<JsonRpcResponse> {
    if (
      this.options.batch === false ||
      endpoint.batchMode === false ||
      !isHedgeableMethod(request.method, this.options.nonRetryableMethods)
    ) {
      return this.rawFetch(endpoint, request, signal) as Promise<JsonRpcResponse>;
    }
    const pending = new Promise<JsonRpcResponse>((resolve, reject) => {
      const queue = this.batches.get(endpoint.label) ?? [];
      queue.push({ request, signal, resolve, reject });
      this.batches.set(endpoint.label, queue);
      if (!this.batchTimers.has(endpoint.label)) {
        const timer = setTimeout(
          () => this.flushBatch(endpoint),
          this.options.batch === false ? 0 : this.options.batch.waitMs,
        );
        this.batchTimers.set(endpoint.label, timer);
      }
    });
    return abortable(pending, signal);
  }

  private flushBatch(endpoint: RuntimeEndpoint): void {
    this.batchTimers.delete(endpoint.label);
    const queue = this.batches.get(endpoint.label) ?? [];
    const maxSize = this.options.batch === false ? 1 : this.options.batch.maxSize;
    const items: BatchItem[] = [];
    if (endpoint.batchMode === "same-method" && queue.length > 0) {
      const method = queue[0]?.request.method;
      for (let index = 0; index < queue.length && items.length < maxSize; ) {
        if (queue[index]?.request.method === method) items.push(...queue.splice(index, 1));
        else index += 1;
      }
    } else {
      items.push(...queue.splice(0, maxSize));
    }
    if (queue.length > 0) {
      const timer = setTimeout(() => this.flushBatch(endpoint), 0);
      this.batchTimers.set(endpoint.label, timer);
    } else {
      this.batches.delete(endpoint.label);
    }
    const active = items.filter((item) => {
      if (item.signal?.aborted) {
        item.reject(abortError());
        return false;
      }
      return true;
    });
    if (active.length === 0) return;

    const controller = new AbortController();
    let notAborted = active.length;
    const abortHandlers = new Map<AbortSignal, () => void>();
    for (const item of active) {
      if (!item.signal) continue;
      const onAbort = (): void => {
        notAborted -= 1;
        if (notAborted === 0) controller.abort();
      };
      abortHandlers.set(item.signal, onAbort);
      item.signal.addEventListener("abort", onAbort, { once: true });
    }
    const outbound = active.map((item) => ({
      ...item.request,
      id: `batch-${++this.batchId}`,
    }));
    void this.rawFetch(
      endpoint,
      active.length === 1 ? (outbound[0] as JsonRpcRequest) : outbound,
      controller.signal,
    ).then(
      (payload) => {
        for (const [signal, handler] of abortHandlers) signal.removeEventListener("abort", handler);
        if (active.length === 1) {
          const item = active[0] as BatchItem;
          if (Array.isArray(payload)) {
            item.reject(new EndpointError(endpoint.label, "returned an unexpected batch response"));
          } else {
            item.resolve(cloneResponse(payload, item.request.id));
          }
          return;
        }
        if (!Array.isArray(payload)) {
          const error = new EndpointError(endpoint.label, "returned a non-batch response");
          for (const item of active) item.reject(error);
          return;
        }
        const responses = new Map(payload.map((response) => [String(response.id), response]));
        for (let index = 0; index < active.length; index += 1) {
          const item = active[index] as BatchItem;
          const sent = outbound[index] as JsonRpcRequest;
          const response = responses.get(String(sent.id));
          if (response) item.resolve(cloneResponse(response, item.request.id));
          else item.reject(new EndpointError(endpoint.label, "omitted a request from its batch response"));
        }
      },
      (error: unknown) => {
        for (const [signal, handler] of abortHandlers) signal.removeEventListener("abort", handler);
        const normalized = error instanceof Error ? error : new Error("Unknown batch error");
        for (const item of active) item.reject(normalized);
      },
    );
  }

  private async rawFetch(
    endpoint: RuntimeEndpoint,
    payload: JsonRpcRequest | JsonRpcRequest[],
    signal: AbortSignal | undefined,
  ): Promise<JsonRpcResponse | JsonRpcResponse[]> {
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...endpoint.headers },
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      const message = error instanceof Error ? error.message : "network request failed";
      throw new EndpointError(endpoint.label, redactUrl(message, endpoint.url, endpoint.label), { cause: error });
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const rpcError = typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
      const message =
        typeof rpcError === "object" &&
        rpcError !== null &&
        "message" in rpcError &&
        typeof rpcError.message === "string"
          ? rpcError.message
          : `HTTP ${response.status}`;
      const rateLimited = response.status === 429 || /too many requests|rate.?limit/i.test(message);
      throw new EndpointError(endpoint.label, message, {
        status: response.status,
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
        rateLimited,
        retryable: rateLimited || (response.status !== 400 && response.status !== 422),
      });
    }
    if (typeof body !== "object" || body === null) {
      throw new EndpointError(endpoint.label, "returned an invalid JSON-RPC response");
    }
    return body as JsonRpcResponse | JsonRpcResponse[];
  }

  private observeSlot(response: JsonRpcResponse): void {
    const slot = responseSlot(response);
    if (slot !== undefined) this.highestSlot = Math.max(this.highestSlot ?? 0, slot);
  }

  private observeEndpointSlot(endpoint: RuntimeEndpoint, response: JsonRpcResponse): void {
    const slot = responseSlot(response);
    if (slot !== undefined) {
      endpoint.lastSlot = Math.max(endpoint.lastSlot ?? 0, slot);
      this.highestSlot = Math.max(this.highestSlot ?? 0, slot);
    }
  }

  private startHealth(): void {
    if (this.options.healthIntervalMs === undefined || this.healthTimer || this.closed) return;
    this.healthTimer = setInterval(() => {
      if (this.closed) return;
      if (this.lastActivity <= this.lastProbe) return;
      this.lastProbe = Date.now();
      for (const endpoint of this.endpoints) void this.probe(endpoint);
    }, this.options.healthIntervalMs);
    if (typeof this.healthTimer === "object") this.healthTimer.unref();
  }

  private async probe(endpoint: RuntimeEndpoint): Promise<void> {
    if (endpoint.quarantined || endpoint.inFlight > 0) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const started = performance.now();
    try {
      await endpoint.budget.acquire("getSlot", controller.signal);
      const response = await this.rawFetch(
        endpoint,
        { jsonrpc: "2.0", id: `health-${endpoint.label}`, method: "getSlot", params: [{ commitment: "processed" }] },
        controller.signal,
      );
      if (Array.isArray(response) || response.error) throw new EndpointError(endpoint.label, "health probe failed");
      this.recordSuccess(endpoint, "getSlot", performance.now() - started);
      this.observeEndpointSlot(endpoint, response);
    } catch (error) {
      if (!controller.signal.aborted) {
        const normalized = error instanceof Error ? error : new Error("Health probe failed");
        this.recordFailure(endpoint, "getSlot", performance.now() - started, normalized);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

function assertPayload(value: unknown): JsonRpcRequest {
  if (typeof value !== "object" || value === null) throw new Error("Invalid JSON-RPC payload");
  const payload = value as Partial<JsonRpcRequest>;
  if (payload.jsonrpc !== "2.0" || typeof payload.method !== "string" || !("id" in payload)) {
    throw new Error("Invalid JSON-RPC payload");
  }
  return payload as JsonRpcRequest;
}

export function createSolanaTransport(options: SolanaOptions = {}): SolanaTransport {
  const pool = new RpcPool(options);
  let directId = 0;

  const executePayload = async (payload: unknown, signal?: AbortSignal): Promise<unknown> => {
    if (Array.isArray(payload)) {
      return Promise.all(payload.map((item) => pool.execute(assertPayload(item), { signal })));
    }
    return pool.execute(assertPayload(payload), { signal });
  };

  const transport = (async <TResponse>({ payload, signal }: { payload: unknown; signal?: AbortSignal }) => {
    return (await executePayload(payload, signal)) as TResponse;
  }) as SolanaTransport;

  transport.request = async <T>(method: string, params?: unknown, requestOptions: RequestOptions = {}): Promise<T> => {
    const response = await pool.execute(
      { jsonrpc: "2.0", id: `direct-${++directId}`, method, ...(params === undefined ? {} : { params }) },
      requestOptions,
    );
    if (response.error) {
      const { SolanaRpcError } = await import("./errors.js");
      throw new SolanaRpcError(method, response.error);
    }
    return response.result as T;
  };

  transport.requestAll = async <T>(requests: readonly RpcInput[], bulkOptions: BulkOptions = {}): Promise<T[]> => {
    const concurrency = Math.floor(positive(bulkOptions.concurrency, 4, "concurrency"));
    return mapConcurrent(requests, concurrency, (request) =>
      transport.request<T>(request.method, request.params, {
        signal: bulkOptions.signal,
        skipCache: bulkOptions.skipCache,
      }),
    );
  };

  transport.getMultipleAccounts = async <T>(
    addresses: readonly string[],
    config: Record<string, unknown> = {},
    bulkOptions: BulkOptions = {},
  ): Promise<(T | null)[]> => {
    const chunks: string[][] = [];
    for (let index = 0; index < addresses.length; index += 100) chunks.push(addresses.slice(index, index + 100));
    const responses = await transport.requestAll<{ value: (T | null)[] }>(
      chunks.map((chunk) => ({ method: "getMultipleAccounts", params: [chunk, config] })),
      bulkOptions,
    );
    return responses.flatMap((response) => response.value);
  };

  transport.snapshot = (): PoolSnapshot => pool.snapshot();
  transport.clearCache = (): void => pool.clearCache();
  transport.close = (): void => pool.close();
  transport.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let body = init?.body;
    let signal = init?.signal ?? undefined;
    if (body === undefined && input instanceof Request) {
      body = await input.text();
      signal = signal ?? input.signal;
    }
    if (typeof body !== "string") throw new Error("Solana RPC fetch requires a JSON string body");
    const response = await executePayload(JSON.parse(body), signal ?? undefined);
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return transport;
}

export const smartSolana: typeof createSolanaTransport = createSolanaTransport;
