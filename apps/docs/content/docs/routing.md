---

title: Routing and caching
description: How Smart Solana selects providers and reduces repeated network work.
---

# Routing and caching

## Provider selection

Smart Solana records global and per-method latency, tail latency, and error rates for every provider. Scores also include slot lag beyond the configured limit and endpoint weights.

A healthy sampled provider stays eligible even with several requests in flight. Actual measured latency reveals congestion; a speculative connection-count penalty would divert calls to slower idle nodes. Unknown providers are sampled by background health probes or explicit failover rather than displacing a working provider on the user path.

Rate-limited endpoints cool down, repeatedly failing endpoints open a circuit breaker, and endpoints returning the wrong genesis hash are quarantined. Retries select another eligible provider.

## Read cache

Cacheable reads use method-specific TTLs and stable keys derived from the method and JSON parameters. Fresh entries return without network work. Expired entries use stale-while-revalidate by default: the caller receives the cached response while one background request refreshes it.

```ts
const transport = smartSolana({
  cache: {
    ttlMs: 500,
    methodTtlMs: { getAccountInfo: 250, getGenesisHash: 3_600_000 },
    maxEntries: 5_000,
    staleWhileRevalidate: true,
  },
});
```

The cache improves repeated-read latency; it does not make cold network calls faster. Cached data may be stale, so disable it or use `skipCache` for freshness-sensitive paths.

## Coalescing and batching

Identical in-flight reads share one upstream promise. Concurrent eligible calls may also share an HTTP batch. Batching restores out-of-order responses and respects endpoint capabilities. PublicNode batching is disabled in the default registry because single requests produced a better sustained p95 in the live comparison.

`sendTransaction` is never hedged or automatically batched. The same signed transaction may be rebroadcast after transport errors because its signature remains the same and it can execute only once.

## Bulk reads

`getMultipleAccounts()` splits arbitrary address lists into Solana's 100-address limit, runs bounded parallel requests, and returns flattened values in input order. `requestAll()` provides bounded concurrency for arbitrary RPC inputs.
