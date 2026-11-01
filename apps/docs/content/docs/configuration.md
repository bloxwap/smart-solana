---

title: Configuration
description: Configure Solana endpoints, budgets, timeouts, caching, and production behavior.
---

# Configuration

Create one transport per process or Worker isolate and share it. Labels, rather than keyed URLs, appear in telemetry and routing snapshots.

## Endpoints

```ts
import { smartSolana } from "@bloxwap/smart-solana";

const transport = smartSolana({
  endpoints: [
    { url: process.env.HELIUS_RPC_URL!, label: "helius", rps: 10, burst: 10 },
    { url: process.env.QUICKNODE_RPC_URL!, label: "quicknode", rps: 15 },
    "https://solana-rpc.publicnode.com",
    "https://solana.api.pocket.network",
  ],
  timeoutMs: 3_500,
  retries: 3,
  hedge: { delayMs: 250 },
});
```

Explicit endpoints are checked against the selected cluster's genesis hash. Use `cluster: "devnet"` or `cluster: "testnet"` for those public clusters. Custom clusters require explicit endpoints and normally a `genesisHash`; set `genesisHash: false` only when validation is intentionally unnecessary.

## Options

| Option                    | Default                                  | Behavior                                                           |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `timeoutMs`               | `5000`                                   | Deadline for each provider attempt.                                |
| `retries`                 | `3`                                      | Additional attempts, including hedges.                             |
| `retryDelayMs`            | `150`                                    | Exponential failover backoff; provider cooldowns take precedence.  |
| `hedge`                   | `{ delayMs: 300 }`                       | Copies slow idempotent reads. Set `false` to save quota.           |
| `batch`                   | `{ maxSize: 20, waitMs: 0 }`             | Batches concurrent calls when enabled for the selected endpoint.   |
| `coalesce`                | `true`                                   | Shares identical in-flight reads.                                  |
| `cache`                   | enabled                                  | Method-aware TTLs, LRU storage, and stale-while-revalidate.        |
| `health`                  | `{ intervalMs: 30000, maxSlotLag: 150 }` | Probes providers and penalizes excessive slot lag.                 |
| `circuitBreaker`          | 3 failures, 10s cooldown                 | Temporarily removes repeatedly failing providers.                  |
| `rebroadcastTransactions` | `true`                                   | Fails over signed sends after transport errors, never hedges them. |

## Freshness and request cost

```ts
const fresh = smartSolana({ cache: false, hedge: false });
```

Cached responses can be stale, and background refreshes and hedging increase upstream traffic. Use `skipCache: true` for one direct request or disable caching for a client that must always read current state. Endpoint `rps`, `burst`, and `methodRps` values control local request budgets; they do not raise provider limits.

Public endpoints have no SLA. Production and latency-critical workloads should include trusted private endpoints. Set `health: false` in runtimes where background timers are inappropriate.
