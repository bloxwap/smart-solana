import { afterAll, describe, expect, it } from "bun:test";
import { MAINNET_ENDPOINTS, MAINNET_GENESIS_HASH, defaultWebSocketEndpoints, smartSolana } from "../src/index.js";

const live = process.env.LIVE_RPC === "1" ? describe : describe.skip;
const transport = smartSolana({ health: false, hedge: false, timeoutMs: 10_000 });

afterAll(() => transport.close());

function subscribe(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out subscribing to ${new URL(url).hostname}`));
    }, 8_000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "slotSubscribe" }));
    });
    socket.addEventListener("message", (event) => {
      const body = JSON.parse(String(event.data)) as { id?: number; result?: number; error?: { message: string } };
      if (body.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (typeof body.result === "number") resolve(body.result);
      else reject(new Error(body.error?.message ?? "Subscription failed"));
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket connection failed for ${new URL(url).hostname}`));
    });
  });
}

live("live keyless mainnet registry", () => {
  it("reads the current slot and validates mainnet", async () => {
    await expect(transport.request("getGenesisHash")).resolves.toBe(MAINNET_GENESIS_HASH);
    await expect(transport.request<number>("getSlot", undefined, { skipCache: true })).resolves.toBeGreaterThan(0);
  }, 30_000);

  it("performs a real bulk account read", async () => {
    const accounts = await transport.getMultipleAccounts(
      ["11111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
      { encoding: "base64", commitment: "finalized" },
    );
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).not.toBeNull();
    expect(accounts[1]).not.toBeNull();
  }, 30_000);

  it("answers a core read on every registered HTTP provider", async () => {
    for (const endpoint of MAINNET_ENDPOINTS) {
      const provider = smartSolana({
        endpoints: [endpoint],
        health: false,
        hedge: false,
        cache: false,
        retries: 1,
        timeoutMs: 12_000,
      });
      try {
        await expect(provider.request<number>("getSlot"), endpoint.label).resolves.toBeGreaterThan(0);
      } finally {
        provider.close();
      }
    }
  }, 90_000);

  it("completes slotSubscribe on every advertised WebSocket provider", async () => {
    for (const endpoint of defaultWebSocketEndpoints("mainnet-beta")) {
      await expect(subscribe(endpoint.url), endpoint.label).resolves.toEqual(expect.any(Number));
    }
  }, 60_000);
});
