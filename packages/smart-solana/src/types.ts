export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: T;
  error?: JsonRpcErrorBody;
}

export type Cluster = "mainnet-beta" | "devnet" | "testnet" | "custom";

export interface Endpoint {
  url: string;
  label?: string;
  /** Sustained HTTP/RPC request budget. */
  rps?: number;
  burst?: number;
  /** Optional per-method budgets. Use "*" as a fallback. */
  methodRps?: Readonly<Record<string, number>>;
  /** Higher weights make an endpoint more likely to be selected. */
  weight?: number;
  /** HTTP batching capability. Same-method batches preserve ordering constraints. */
  batch?: boolean | "same-method";
  /** Methods that should never be routed to this endpoint. */
  unsupportedMethods?: readonly string[];
  /** Verified Solana PubSub endpoint, when independently available. */
  webSocketUrl?: string;
  headers?: Readonly<Record<string, string>>;
}

export interface CacheOptions {
  ttlMs?: number;
  methodTtlMs?: Readonly<Record<string, number>>;
  maxEntries?: number;
  staleWhileRevalidate?: boolean;
}

export interface BatchOptions {
  maxSize?: number;
  waitMs?: number;
}

export interface HealthOptions {
  intervalMs?: number | false;
  maxSlotLag?: number;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
}

export interface HedgeOptions {
  delayMs?: number;
}

export interface SolanaOptions {
  endpoints?: readonly (string | Endpoint)[];
  cluster?: Cluster;
  /** Defaults to the well-known genesis hash for the selected public cluster. */
  genesisHash?: string | false;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  hedge?: boolean | HedgeOptions;
  cache?: boolean | CacheOptions;
  coalesce?: boolean;
  batch?: boolean | BatchOptions;
  health?: boolean | HealthOptions;
  circuitBreaker?: boolean | CircuitBreakerOptions;
  rebroadcastTransactions?: boolean;
  nonRetryableMethods?: readonly string[];
  onEvent?: (event: RpcEvent) => void;
}

export interface RpcEvent {
  type:
    | "attempt"
    | "success"
    | "error"
    | "retry"
    | "hedge"
    | "rateLimit"
    | "cacheHit"
    | "cacheRefresh"
    | "breakerOpen"
    | "endpointQuarantined"
    | "backgroundError";
  method: string;
  endpoint?: string;
  latencyMs?: number;
  attempt?: number;
  error?: string;
}

export interface EndpointSnapshot {
  label: string;
  score: number;
  latencyMs: number;
  tailMs: number;
  errorRate: number;
  samples: number;
  inFlight: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  cooldownUntil: number;
  quarantined: boolean;
  lastSlot?: number;
  slotLag?: number;
}

export interface PoolSnapshot {
  highestSlot?: number;
  cacheEntries: number;
  pendingRequests: number;
  closed: boolean;
  endpoints: EndpointSnapshot[];
}

export interface RequestOptions {
  signal?: AbortSignal;
  skipCache?: boolean;
}

export interface RpcInput {
  method: string;
  params?: unknown;
}

export interface BulkOptions extends RequestOptions {
  concurrency?: number;
}

export interface TransportConfig {
  payload: unknown;
  signal?: AbortSignal;
}

export interface SolanaTransport {
  <TResponse>(config: TransportConfig): Promise<TResponse>;
  request<T = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<T>;
  requestAll<T = unknown>(requests: readonly RpcInput[], options?: BulkOptions): Promise<T[]>;
  /** Returns the flattened `value` arrays, preserving address order. */
  getMultipleAccounts<T = unknown>(
    addresses: readonly string[],
    config?: Record<string, unknown>,
    options?: BulkOptions,
  ): Promise<(T | null)[]>;
  snapshot(): PoolSnapshot;
  clearCache(): void;
  close(): void;
  /** Custom fetch for the legacy @solana/web3.js Connection constructor. */
  fetch: typeof globalThis.fetch;
}
