---

title: Get started
description: Install and use the Smart Solana RPC transport with Solana Kit or web3.js.
---

# Smart Solana

`@bloxwap/smart-solana` is an adaptive Solana JSON-RPC transport. It routes by measured provider latency and errors, stays on healthy sampled endpoints, and fails over when providers throttle or time out. Repeated reads can be answered from a local cache.

## Install

```sh
bun add @bloxwap/smart-solana @solana/kit
```

npm, pnpm, and Yarn work too. Node.js 22.12 or later is required. The transport has zero runtime dependencies; install the Solana client you use.

## Create a client

```ts
import { createSolanaRpcFromTransport } from "@solana/kit";
import { smartSolana } from "@bloxwap/smart-solana";

const transport = smartSolana();
const rpc = createSolanaRpcFromTransport(transport);

const slot = await rpc.getSlot().send();
```

With no arguments, `smartSolana()` uses nine keyless mainnet providers. Call `transport.close()` during application shutdown.

## Defaults

| Feature    | Default behavior                                                                     |
| ---------- | ------------------------------------------------------------------------------------ |
| Routing    | Uses per-method latency, errors, and slot lag to select a healthy sampled endpoint.  |
| Failover   | Retries transport and provider errors, with endpoint cooldowns and circuit breakers. |
| Hedging    | Copies slow idempotent reads to another provider after 300 ms.                       |
| Coalescing | Shares identical in-flight reads.                                                    |
| Batching   | Combines concurrent calls where provider support and latency measurements allow.     |
| Cache      | Serves recent reads and refreshes stale entries in the background.                   |
| Validation | Checks each endpoint's genesis hash before its first user request.                   |

These defaults trade additional upstream requests for lower latency and better availability. Disable individual features when request cost or freshness matters more.

## Next steps

- [Configure endpoints and production runtimes](configuration.md)
- [Understand routing, caching, and request efficiency](routing.md)
- [Review benchmark methodology and results](benchmarks.md)
- [Inspect direct requests, telemetry, and errors](api.md)
