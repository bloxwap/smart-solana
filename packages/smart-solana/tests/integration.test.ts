import { createSolanaRpcFromTransport } from "@solana/kit";
import { Connection } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "bun:test";
import { createSolanaTransport, type SolanaTransport } from "../src/index.js";
import { mockFetch, quietOptions, rpcResult } from "./helpers.js";

let transport: SolanaTransport | undefined;
afterEach(() => {
  transport?.close();
  transport = undefined;
});

describe("Solana client integrations", () => {
  it("works as a @solana/kit transport", async () => {
    const fetch = mockFetch((request) => rpcResult(request, 123_456));
    transport = createSolanaTransport({ ...quietOptions, fetch });
    const rpc = createSolanaRpcFromTransport(transport);
    await expect(rpc.getSlot().send()).resolves.toBe(123_456n);
  });

  it("works as legacy Connection fetch", async () => {
    const fetch = mockFetch((request) => rpcResult(request, 654_321));
    transport = createSolanaTransport({ ...quietOptions, fetch });
    const connection = new Connection("https://unused.invalid", {
      commitment: "confirmed",
      fetch: transport.fetch,
    });
    await expect(connection.getSlot()).resolves.toBe(654_321n);
  });
});
