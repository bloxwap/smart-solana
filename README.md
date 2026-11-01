<h1 align="center">Smart Solana</h1>

<p align="center"><strong>Adaptive, latency-aware Solana JSON-RPC transport for Solana Kit and web3.js.</strong></p>

<p align="center">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/bloxwap/smart-solana?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/@bloxwap/smart-solana"><img alt="npm" src="https://img.shields.io/npm/v/@bloxwap/smart-solana?style=flat-square"></a>
</p>

## Features

| Feature            | Value                                                                           |
| ------------------ | ------------------------------------------------------------------------------- |
| Adaptive routing   | Per-method latency, errors, slot lag, and provider weights.                     |
| Fast healthy path  | Stays on the fastest sampled provider without speculative congestion penalties. |
| Resilience         | Rate-limit budgets, retries, hedging, cooldowns, and circuit breakers.          |
| Request efficiency | Response caching, in-flight coalescing, and capability-aware HTTP batching.     |
| Solana clients     | Works with `createSolanaRpcFromTransport` and legacy `Connection`.              |
| Safety             | Genesis-hash validation and bounded transaction rebroadcasting.                 |
| Runtimes           | Bun, Node.js, browsers, and edge; zero runtime dependencies.                    |

## Performance

A sustained 15-second comparison used ten concurrent `getSlot` workers against the optimized uncached pool and a direct PublicNode connection. The pool used one retry with cache, coalescing, hedging, and health probes disabled.

| Transport                    | Requests | Errors |      Throughput |           p50 |           p95 |
| ---------------------------- | -------: | -----: | --------------: | ------------: | ------------: |
| **`smartSolana()` uncached** |      682 |  **0** | **45.47 req/s** | **116.07 ms** | **140.00 ms** |
| PublicNode direct            |      664 |      0 |     44.27 req/s |     121.12 ms |     152.46 ms |

Live public-provider measurements vary by network and time. See the [benchmark methodology and reproduction commands](https://bloxwap.github.io/smart-solana/docs/benchmarks/).

## Installation

### Bun

```sh
bun add @bloxwap/smart-solana @solana/kit
```

### Node.js 22.12+

```sh
npm install @bloxwap/smart-solana @solana/kit
```

### pnpm

```sh
pnpm add @bloxwap/smart-solana @solana/kit
```

### Yarn

```sh
yarn add @bloxwap/smart-solana @solana/kit
```

The transport has zero runtime dependencies. Install the Solana client library your application uses.

## Usage

```ts
import { createSolanaRpcFromTransport } from "@solana/kit";
import { smartSolana } from "@bloxwap/smart-solana";

const transport = smartSolana();
const rpc = createSolanaRpcFromTransport(transport);

const slot = await rpc.getSlot().send();

transport.close();
```

With no arguments, `smartSolana()` uses nine keyless mainnet providers from [`packages/smart-solana/src/registry.ts`](packages/smart-solana/src/registry.ts).

### Configure

```ts
const transport = smartSolana({
  endpoints: [
    { url: process.env.HELIUS_RPC_URL!, label: "helius", rps: 10, burst: 10 },
    "https://solana-rpc.publicnode.com",
  ],
  timeoutMs: 3_500,
  hedge: { delayMs: 250 },
});
```

Labels appear in telemetry instead of keyed URLs. Explicit endpoints are checked against the selected cluster's genesis hash before use. Production and latency-critical workloads should include trusted private endpoints.

### Direct and bulk reads

```ts
const slot = await transport.request<number>("getSlot");

const accounts = await transport.getMultipleAccounts(
  addresses,
  { encoding: "base64", commitment: "confirmed" },
  { concurrency: 4 },
);
```

### Legacy web3.js

```ts
import { Connection } from "@solana/web3.js";

const connection = new Connection("https://api.mainnet-beta.solana.com", {
  commitment: "confirmed",
  fetch: transport.fetch,
});
```

## Documentation

Browse the [full documentation](https://bloxwap.github.io/smart-solana/docs/) for configuration, routing, caching, benchmarks, and the API. Release and development instructions are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Requires Bun 1.4.4 and Node.js 22.12 or newer.

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run build
```

Run `bun dev` or `bun run docs:dev` to start the documentation site at [localhost:3916](http://localhost:3916). `bun run docs:build` writes its static export. The Documentation workflow deploys `main` to GitHub Pages.

## Security

- Load private RPC URLs from the environment and never commit credentials.
- Runtime events and snapshots expose labels rather than keyed URLs.
- Signed transactions may be rebroadcast after transport errors; set `rebroadcastTransactions: false` to send only once.
- This package routes JSON-RPC; it does not sign transactions or hold a wallet.

## License

[MIT](LICENSE)
