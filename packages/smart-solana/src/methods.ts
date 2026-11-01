const NON_RETRYABLE = new Set(["requestAirdrop"]);
const REBROADCAST = new Set(["sendTransaction", "sendRawTransaction"]);

const DEFAULT_TTL: Readonly<Record<string, number>> = {
  getBalance: 750,
  getBlock: 1_000,
  getBlockHeight: 400,
  getBlockProduction: 1_000,
  getBlockTime: 30_000,
  getBlocks: 1_000,
  getEpochInfo: 1_000,
  getEpochSchedule: 300_000,
  getFeeForMessage: 750,
  getFirstAvailableBlock: 30_000,
  getGenesisHash: 3_600_000,
  getHealth: 1_000,
  getIdentity: 60_000,
  getLatestBlockhash: 750,
  getMultipleAccounts: 750,
  getAccountInfo: 750,
  getProgramAccounts: 1_000,
  getSignaturesForAddress: 1_000,
  getSlot: 400,
  getSupply: 1_000,
  getTokenAccountBalance: 750,
  getTokenAccountsByDelegate: 750,
  getTokenAccountsByOwner: 750,
  getTokenLargestAccounts: 750,
  getTokenSupply: 750,
  getTransaction: 5_000,
  getTransactionCount: 400,
  getVersion: 60_000,
  getVoteAccounts: 1_000,
  isBlockhashValid: 750,
};

export function isRetryableMethod(method: string, extraNonRetryable: readonly string[] = []): boolean {
  return !NON_RETRYABLE.has(method) && !extraNonRetryable.includes(method);
}

export function isRebroadcastMethod(method: string): boolean {
  return REBROADCAST.has(method);
}

export function isHedgeableMethod(method: string, extraNonRetryable: readonly string[] = []): boolean {
  return isRetryableMethod(method, extraNonRetryable) && !isRebroadcastMethod(method);
}

export function isCacheableMethod(method: string): boolean {
  return Object.hasOwn(DEFAULT_TTL, method);
}

export function defaultCacheTtl(method: string, fallback: number): number {
  return DEFAULT_TTL[method] ?? fallback;
}

export function cacheKey(method: string, params: unknown): string {
  return `${method}:${JSON.stringify(params) ?? "undefined"}`;
}
