---

title: API
description: Direct requests, bulk reads, telemetry, errors, and legacy client integration.
---

# API

## Direct requests

```ts
const slot = await transport.request<number>("getSlot");
const accounts = await transport.getMultipleAccounts(
  addresses,
  { encoding: "base64", commitment: "confirmed" },
  { concurrency: 4 },
);
```

`requestAll()` accepts RPC input objects and bounded concurrency. `getMultipleAccounts()` chunks addresses into groups of 100 and preserves input order. Use `{ signal }` to cancel and `{ skipCache: true }` to bypass cached responses.

## Solana clients

For Kit, pass the transport to `createSolanaRpcFromTransport`. For legacy web3.js, supply `transport.fetch` as the `Connection` fetch implementation:

```ts
import { Connection } from "@solana/web3.js";
import { smartSolana } from "@bloxwap/smart-solana";

const transport = smartSolana();
const connection = new Connection("https://api.mainnet-beta.solana.com", {
  commitment: "confirmed",
  fetch: transport.fetch,
});
```

The `Connection` URL is not used for routing when custom fetch is supplied.

## Telemetry

```ts
const transport = smartSolana({
  onEvent(event) {
    if (event.type === "rateLimit") console.log(event.endpoint);
  },
});

console.log(transport.snapshot());
transport.clearCache();
transport.close();
```

Events cover attempts, successes, errors, retries, hedges, cache activity, rate limits, circuit breakers, and quarantined endpoints. Snapshots include per-endpoint scores, latency, errors, in-flight calls, cooldowns, and slot lag without exposing keyed URLs.

## Errors

`request()` throws `SolanaRpcError` for JSON-RPC errors and `AllEndpointsFailedError` after exhausted transport attempts. `AllEndpointsFailedError.errors` contains the underlying provider errors. Kit and legacy clients apply their normal error handling.

Signed sends may be rebroadcast after transport errors; JSON-RPC validation errors are returned to the caller rather than retried. Set `rebroadcastTransactions: false` to allow only one attempt.

## Registry exports

`MAINNET_ENDPOINTS`, `DEVNET_ENDPOINTS`, `TESTNET_ENDPOINTS`, genesis hashes, and `defaultWebSocketEndpoints()` are exported from `@bloxwap/smart-solana/registry`. WebSocket URLs are provided for subscription clients; the transport itself pools HTTP requests only.
