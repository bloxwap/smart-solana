import type { JsonRpcResponse } from "./types.js";

interface CacheEntry {
  response: JsonRpcResponse;
  expiresAt: number;
}

export interface CacheHit {
  response: JsonRpcResponse;
  stale: boolean;
}

export class ResponseCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly maxEntries: number) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string, now = Date.now()): CacheHit | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { response: entry.response, stale: entry.expiresAt <= now };
  }

  set(key: string, response: JsonRpcResponse, ttlMs: number): void {
    if (response.error) return;
    this.entries.delete(key);
    this.entries.set(key, { response, expiresAt: Date.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
