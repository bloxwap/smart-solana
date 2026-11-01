# @bloxwap/smart-solana

Adaptive, rate-limit-aware Solana JSON-RPC transport for [`@solana/kit`](https://github.com/anza-xyz/kit) and legacy `@solana/web3.js`. Zero runtime dependencies.

It combines free public endpoints or your own free-tier provider URLs into one pool with per-method latency scoring, load-aware routing, retries, hedged reads, circuit breakers, request coalescing, HTTP batching, warm caching, and slot-lag tracking.

> Free RPC capacity is not unlimited or guaranteed. This library reduces request volume and fails over when providers throttle; it does not bypass provider limits. Public endpoints have no SLA, and production or latency-critical trading workloads should include trusted private endpoints.

## Install

```sh
npm install @bloxwap/smart-solana @solana/kit
```

Node.js 22.12+, Bun, browsers, and edge runtimes with `fetch` are supported. This package routes HTTP JSON-RPC; it does not manage wallets or WebSocket subscriptions.

## Use with `@solana/kit`

```ts
import { address, createSolanaRpcFromTransport } from "@solana/kit";
import { smartSolana } from "@bloxwap/smart-solana";

const transport = smartSolana();
const rpc = createSolanaRpcFromTransport(transport);

const slot = await rpc.getSlot().send();
const { value: accounts } = await rpc
  .getMultipleAccounts(
    [address("11111111111111111111111111111111"), address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")],
    { encoding: "base64" },
  )
  .send();

// During application shutdown.
transport.close();
```

With no options, `smartSolana()` uses nine keyless mainnet providers from `src/registry.ts`. Budgets and capabilities can be tuned per endpoint.

| Provider            | HTTP routing notes                                                        | WebSocket      |
| ------------------- | ------------------------------------------------------------------------- | -------------- |
| Solana              | Documented global and per-method budgets                                  | Verified       |
| PublicNode          | No batches                                                                | Verified       |
| Solana Tracker      | Mixed batches                                                             | Verified       |
| Tatum               | No batches; 5 requests/minute; no anonymous `getSignaturesForAddress`     | Not advertised |
| Solana Vibe Station | Same-method batches; about 1 RPS                                          | Verified       |
| QuickNode docs      | Shared documentation endpoint; mixed batches                              | Verified       |
| Pocket Network      | No batches                                                                | Not available  |
| LeoRPC              | Published shared `FREE` key; same-method batches; no `getProgramAccounts` | Not available  |
| Uniblock            | Mixed batches                                                             | Not available  |

Providers marked “Not available” remain useful for HTTP reads but are not included in the WebSocket registry. OnFinality, Web3CDN, Ankr, dRPC, ERPC, GoldRush, Blast API, and several other commonly listed endpoints were not added because live probes returned rate limits, timeouts, authentication requirements, or paid-plan errors.

### WebSocket endpoints

Five providers passed a live `slotSubscribe` probe. Their verified URLs are exported separately for subscription clients:

```ts
import { defaultWebSocketEndpoints } from "@bloxwap/smart-solana";

const subscriptions = defaultWebSocketEndpoints("mainnet-beta");
const socket = new WebSocket(subscriptions[0].url);

socket.addEventListener("open", () => {
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "slotSubscribe" }));
});
```

The transport currently pools HTTP requests only; it does not reconnect, deduplicate, or fail over WebSocket subscriptions automatically.

## Use with legacy `Connection`

```ts
import { Connection } from "@solana/web3.js";
import { smartSolana } from "@bloxwap/smart-solana";

const transport = smartSolana();
const connection = new Connection("https://api.mainnet-beta.solana.com", {
  commitment: "confirmed",
  fetch: transport.fetch,
});

const slot = await connection.getSlot();
```

The `Connection` URL is not used for routing when custom `fetch` is supplied; the transport's pool selects the provider.

## Direct requests and bulk reads

```ts
const slot = await transport.request<number>("getSlot");

const accounts = await transport.getMultipleAccounts(
  addresses,
  { encoding: "base64", commitment: "confirmed" },
  { concurrency: 4 },
);
```

`getMultipleAccounts()` splits arbitrary address lists into Solana's 100-address limit, runs bounded parallel requests, and returns flattened account values in input order. `requestAll()` provides the same bounded concurrency for arbitrary RPC inputs.

## Add free-tier or private providers

```ts
const transport = smartSolana({
  endpoints: [
    { url: process.env.HELIUS_RPC_URL!, label: "helius", rps: 10, burst: 10 },
    { url: process.env.QUICKNODE_RPC_URL!, label: "quicknode", rps: 15 },
    "https://solana-rpc.publicnode.com",
    "https://rpc.solanatracker.io/public",
  ],
  timeoutMs: 3_500,
  retries: 3,
  hedge: { delayMs: 250 },
});
```

Create one transport per process or Worker isolate and share it. Labels, rather than URLs, appear in telemetry and routing snapshots so API keys are not exposed. Explicit endpoints are checked against the selected cluster's genesis hash before use.

For devnet or testnet, set `cluster: "devnet"` or `cluster: "testnet"`. Custom clusters require explicit endpoints and normally a `genesisHash`; set `genesisHash: false` only if validation is intentionally unnecessary.

## Configuration

| Option                    | Default                                  | Behavior                                                                                                                                     |
| ------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeoutMs`               | `5000`                                   | Deadline for each provider attempt.                                                                                                          |
| `retries`                 | `3`                                      | Additional attempts, including hedges.                                                                                                       |
| `retryDelayMs`            | `150`                                    | Exponential failover backoff; provider cooldowns take precedence.                                                                            |
| `hedge`                   | `{ delayMs: 300 }`                       | Copies slow idempotent reads to another provider. Set `false` to save quota.                                                                 |
| `batch`                   | `{ maxSize: 20, waitMs: 0 }`             | Batches concurrent calls and restores out-of-order responses. Endpoint `batch: false` or `batch: "same-method"` restricts the payload shape. |
| `coalesce`                | `true`                                   | Shares identical in-flight read requests.                                                                                                    |
| `cache`                   | enabled                                  | Method-aware TTLs, LRU bound, and stale-while-revalidate.                                                                                    |
| `health`                  | `{ intervalMs: 30000, maxSlotLag: 150 }` | Probes active pools and penalizes lagging providers. Set `false` in Workers without timer support.                                           |
| `circuitBreaker`          | 3 failures, 10s cooldown                 | Temporarily removes repeatedly failing providers.                                                                                            |
| `rebroadcastTransactions` | `true`                                   | Fails over signed sends after transport errors, never hedges them.                                                                           |

Examples:

```ts
// Freshness-sensitive scanner or trading path.
const fresh = smartSolana({ cache: false, hedge: false });

// Keep caching but tune one method.
const cached = smartSolana({
  cache: {
    ttlMs: 500,
    methodTtlMs: { getAccountInfo: 250, getGenesisHash: 3_600_000 },
    maxEntries: 5_000,
    staleWhileRevalidate: true,
  },
});

// Inspect routing without exposing keyed URLs.
console.log(transport.snapshot());
transport.clearCache();
```

Cached account and balance responses can be hundreds of milliseconds old. Hedging and background cache refreshes increase upstream traffic. Use `skipCache: true` for one direct request, or disable caching for a client that must always read current state.

## Transactions and errors

`sendTransaction` is never hedged or automatically batched. The same signed transaction may be rebroadcast to another endpoint after a timeout, connection loss, or provider error because its signature remains the same and it can execute only once. Set `rebroadcastTransactions: false` to allow only one attempt. JSON-RPC transaction validation errors are returned to the caller rather than retried.

`transport.request()` throws `SolanaRpcError` for JSON-RPC errors and `AllEndpointsFailedError` after exhausted transport attempts. Kit and legacy clients apply their own normal error handling.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
bun run test:live
bun run bench:live
bun run bench:sustained
```

The default tests are offline. `bun run test:live` makes real calls through the free mainnet registry. `bun run bench:live` compares the direct public Solana RPC with uncached and default pooled transports over rotating sequential and concurrent read phases. Set `BENCH_OUT=benchmark-results.json` to save the full report; `BENCH_SEQUENTIAL`, `BENCH_CONCURRENT`, and `BENCH_PACE_MS` adjust the workload.

`bun run bench:sustained` applies increasing concurrency to the direct RPC and an uncached pool, reporting per-second failures and latency. Set `BENCH_OUT=sustained-results.json` to save its report. `BENCH_STAGE_MS`, `BENCH_CONCURRENCY_LEVELS`, and `BENCH_WORKER_DELAY_MS` control the load. Set `BENCH_REGISTRY=1` to compare every default provider individually with the pool, and optionally `BENCH_PROVIDER=publicnode` to select one provider. Use these live benchmarks conservatively because public providers enforce rate limits.

## License

MIT
