import type { Cluster, Endpoint } from "./types.js";

export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const TESTNET_GENESIS_HASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";

/** Keyless mainnet endpoints. Budgets are starting points, not provider guarantees. */
export const MAINNET_ENDPOINTS: readonly Endpoint[] = [
  {
    label: "publicnode",
    url: "https://solana-rpc.publicnode.com",
    webSocketUrl: "wss://solana-rpc.publicnode.com",
    rps: 50,
    burst: 10,
    batch: false,
  },
  {
    label: "pocket",
    url: "https://solana.api.pocket.network",
    rps: 30,
    burst: 10,
    batch: false,
  },
  {
    label: "solana",
    url: "https://api.mainnet-beta.solana.com",
    webSocketUrl: "wss://api.mainnet-beta.solana.com",
    rps: 8,
    burst: 8,
    methodRps: { "*": 4 },
  },
  {
    label: "solanatracker",
    url: "https://rpc.solanatracker.io/public",
    webSocketUrl: "wss://rpc.solanatracker.io/public",
    rps: 4,
    burst: 4,
  },
  {
    label: "tatum",
    url: "https://solana-mainnet.gateway.tatum.io",
    rps: 5 / 60,
    burst: 2,
    batch: false,
    unsupportedMethods: ["getSignaturesForAddress"],
  },
  {
    label: "solanavibestation",
    url: "https://public.rpc.solanavibestation.com",
    webSocketUrl: "wss://public.rpc.solanavibestation.com",
    rps: 1,
    burst: 2,
    batch: "same-method",
  },
  {
    label: "quicknode-docs",
    url: "https://docs-demo.solana-mainnet.quiknode.pro",
    webSocketUrl: "wss://docs-demo.solana-mainnet.quiknode.pro",
    rps: 1,
    burst: 1,
  },
  {
    label: "leorpc",
    url: "https://solana.leorpc.com/?api_key=FREE",
    rps: 1,
    burst: 1,
    batch: "same-method",
    unsupportedMethods: ["getProgramAccounts"],
  },
  {
    label: "uniblock",
    url: "https://api.uniblock.dev/uni/v1/json-rpc?chainId=solana",
    rps: 1,
    burst: 2,
  },
] as const;

export const DEVNET_ENDPOINTS: readonly Endpoint[] = [
  {
    label: "solana-devnet",
    url: "https://api.devnet.solana.com",
    webSocketUrl: "wss://api.devnet.solana.com",
    rps: 8,
    burst: 8,
    methodRps: { "*": 4 },
  },
] as const;

export const TESTNET_ENDPOINTS: readonly Endpoint[] = [
  {
    label: "solana-testnet",
    url: "https://api.testnet.solana.com",
    webSocketUrl: "wss://api.testnet.solana.com",
    rps: 8,
    burst: 8,
    methodRps: { "*": 4 },
  },
] as const;

export function defaultEndpoints(cluster: Cluster): readonly Endpoint[] {
  if (cluster === "mainnet-beta") return MAINNET_ENDPOINTS;
  if (cluster === "devnet") return DEVNET_ENDPOINTS;
  if (cluster === "testnet") return TESTNET_ENDPOINTS;
  throw new Error("Custom clusters require at least one explicit endpoint");
}

export function defaultWebSocketEndpoints(cluster: Cluster): readonly { label: string; url: string }[] {
  return defaultEndpoints(cluster).flatMap((endpoint) =>
    endpoint.webSocketUrl && endpoint.label ? [{ label: endpoint.label, url: endpoint.webSocketUrl }] : [],
  );
}

export function defaultGenesisHash(cluster: Cluster): string | false {
  if (cluster === "mainnet-beta") return MAINNET_GENESIS_HASH;
  if (cluster === "devnet") return DEVNET_GENESIS_HASH;
  if (cluster === "testnet") return TESTNET_GENESIS_HASH;
  return false;
}
