import { afterEach, describe, expect, it, vi } from "bun:test";
import {
  AllEndpointsFailedError,
  MAINNET_GENESIS_HASH,
  SolanaRpcError,
  createSolanaTransport,
  type SolanaOptions,
  type SolanaTransport,
} from "../src/index.js";
import type { JsonRpcRequest } from "../src/types.js";
import { jsonResponse, mockFetch, quietOptions, rpcResult } from "./helpers.js";

const active = new Set<SolanaTransport>();

function make(options: SolanaOptions): SolanaTransport {
  const transport = createSolanaTransport(options);
  active.add(transport);
  return transport;
}

afterEach(() => {
  for (const transport of active) transport.close();
  active.clear();
  vi.restoreAllMocks();
});

describe("request execution", () => {
  it("returns direct results", async () => {
    const fetch = mockFetch((request) => rpcResult(request, 42));
    const transport = make({ ...quietOptions, fetch });
    await expect(transport.request("getSlot")).resolves.toBe(42);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a healthy sampled endpoint instead of exploring unknown providers", async () => {
    const fetch = mockFetch(async (request, url) => {
      if (url.includes("fast")) await new Promise((resolve) => setTimeout(resolve, 300));
      return rpcResult(request, 42);
    });
    const transport = make({
      ...quietOptions,
      fetch,
      endpoints: ["https://fast.example", "https://unknown.example"],
    });
    await expect(transport.request("getSlot")).resolves.toBe(42);
    await expect(transport.request("getSlot")).resolves.toBe(42);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith("https://fast.example", expect.objectContaining({ method: "POST" }));
  });

  it("fails over on provider errors", async () => {
    const fetch = mockFetch((request, url) => {
      if (url.includes("slow")) return jsonResponse({ error: "unavailable" }, 503);
      return rpcResult(request, 99);
    });
    const transport = make({
      ...quietOptions,
      fetch,
      retries: 1,
      retryDelayMs: 0,
      endpoints: ["https://slow.example", "https://healthy.example"],
    });
    await expect(transport.request("getSlot")).resolves.toBe(99);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not fail over on invalid params", async () => {
    const fetch = mockFetch((request) =>
      jsonResponse({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Invalid params" } }),
    );
    const transport = make({
      ...quietOptions,
      fetch,
      retries: 3,
      endpoints: ["https://one.example", "https://two.example"],
    });
    const error = await transport.request("getAccountInfo", ["invalid"]).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(SolanaRpcError);
    expect((error as SolanaRpcError).code).toBe(-32602);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cools down a rate-limited endpoint", async () => {
    const fetch = mockFetch((request, url) => {
      if (url.includes("limited")) return jsonResponse({ error: "slow down" }, 429, { "retry-after": "60" });
      return rpcResult(request, 7);
    });
    const transport = make({
      ...quietOptions,
      fetch,
      retries: 1,
      retryDelayMs: 0,
      endpoints: ["https://limited.example", "https://healthy.example"],
    });
    await expect(transport.request("getSlot")).resolves.toBe(7);
    await expect(transport.request("getSlot")).resolves.toBe(7);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenLastCalledWith("https://healthy.example", expect.objectContaining({ method: "POST" }));
  });

  it("quarantines endpoints on another cluster", async () => {
    const fetch = mockFetch((request, url) => {
      if (request.method === "getGenesisHash") {
        return rpcResult(request, url.includes("wrong") ? "wrong-hash" : MAINNET_GENESIS_HASH);
      }
      return rpcResult(request, 100);
    });
    const transport = make({
      ...quietOptions,
      fetch,
      genesisHash: MAINNET_GENESIS_HASH,
      retries: 1,
      retryDelayMs: 0,
      endpoints: [
        { url: "https://wrong.example", label: "wrong" },
        { url: "https://right.example", label: "right" },
      ],
    });
    await expect(transport.request("getSlot")).resolves.toBe(100);
    const snapshot = transport.snapshot();
    expect(snapshot.endpoints.find((endpoint) => endpoint.label === "wrong")?.quarantined).toBe(true);
    expect(snapshot.endpoints.find((endpoint) => endpoint.label === "right")?.quarantined).toBe(false);
  });

  it("does not wait forever after every endpoint is quarantined", async () => {
    const fetch = mockFetch((request) => rpcResult(request, "wrong-hash"));
    const transport = make({
      ...quietOptions,
      fetch,
      genesisHash: MAINNET_GENESIS_HASH,
      retries: 3,
      retryDelayMs: 0,
      endpoints: ["https://wrong.example"],
    });
    await expect(transport.request("getSlot")).rejects.toBeInstanceOf(AllEndpointsFailedError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects calls after close", async () => {
    const transport = make({ ...quietOptions, fetch: mockFetch((request) => rpcResult(request, 1)) });
    transport.close();
    await expect(transport.request("getSlot")).rejects.toThrow("closed");
  });
});

describe("request efficiency", () => {
  it("coalesces identical in-flight reads and restores each id", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    let captured: JsonRpcRequest | undefined;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as JsonRpcRequest;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    }) as unknown as typeof globalThis.fetch;
    const transport = make({ ...quietOptions, fetch });
    const first = transport.request<number>("getBalance", ["address"]);
    const second = transport.request<number>("getBalance", ["address"]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledTimes(1);
    resolveFetch?.(rpcResult(captured as JsonRpcRequest, 55));
    await expect(Promise.all([first, second])).resolves.toEqual([55, 55]);
  });

  it("serves warm cache hits without another network request", async () => {
    const fetch = mockFetch((request) => rpcResult(request, 10));
    const transport = make({
      ...quietOptions,
      fetch,
      cache: { ttlMs: 10_000, staleWhileRevalidate: false },
    });
    await expect(transport.request("getSlot")).resolves.toBe(10);
    await expect(transport.request("getSlot")).resolves.toBe(10);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(transport.snapshot().cacheEntries).toBe(1);
  });

  it("does not build cache keys when caching and coalescing are disabled", async () => {
    const fetch = (async () =>
      new Response('{"jsonrpc":"2.0","id":1,"result":42}', {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    const transport = make({ ...quietOptions, fetch, coalesce: false });
    const stringify = vi.spyOn(JSON, "stringify");
    await transport.request("getProgramAccounts", ["address"]);
    expect(stringify).toHaveBeenCalledTimes(1);
  });

  it("batches concurrent calls and maps out-of-order responses", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as JsonRpcRequest[];
      expect(payload).toHaveLength(3);
      return jsonResponse(
        payload
          .slice()
          .reverse()
          .map((request) => ({ jsonrpc: "2.0", id: request.id, result: request.params })),
      );
    }) as unknown as typeof globalThis.fetch;
    const transport = make({
      ...quietOptions,
      fetch,
      endpoints: ["https://one.example"],
      batch: { maxSize: 20, waitMs: 0 },
    });
    await expect(
      Promise.all([
        transport.request("getBalance", ["a"]),
        transport.request("getBalance", ["b"]),
        transport.request("getBalance", ["c"]),
      ]),
    ).resolves.toEqual([["a"], ["b"], ["c"]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("honors endpoints that disable HTTP batching", async () => {
    const fetch = mockFetch((request) => rpcResult(request, request.params));
    const transport = make({
      ...quietOptions,
      fetch,
      endpoints: [{ url: "https://one.example", batch: false }],
      batch: { maxSize: 20, waitMs: 0 },
    });
    await expect(
      Promise.all([
        transport.request("getBalance", ["a"]),
        transport.request("getBalance", ["b"]),
        transport.request("getBalance", ["c"]),
      ]),
    ).resolves.toEqual([["a"], ["b"], ["c"]]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("separates same-method batches", async () => {
    const batchMethods: string[][] = [];
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as JsonRpcRequest | JsonRpcRequest[];
      const requests = Array.isArray(payload) ? payload : [payload];
      batchMethods.push([...new Set(requests.map((request) => request.method))]);
      const responses = requests.map((request) => ({
        jsonrpc: "2.0",
        id: request.id,
        result: request.method === "getSlot" ? 1 : request.params,
      }));
      return jsonResponse(Array.isArray(payload) ? responses : responses[0]);
    }) as unknown as typeof globalThis.fetch;
    const transport = make({
      ...quietOptions,
      fetch,
      endpoints: [{ url: "https://one.example", batch: "same-method" }],
      batch: { maxSize: 20, waitMs: 0 },
    });
    await expect(
      Promise.all([
        transport.request("getBalance", ["a"]),
        transport.request("getSlot"),
        transport.request("getBalance", ["b"]),
        transport.request("getSlot"),
      ]),
    ).resolves.toEqual([["a"], 1, ["b"], 1]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(batchMethods).toEqual([["getBalance"], ["getSlot"]]);
  });

  it("never routes unsupported methods to an endpoint", async () => {
    const fetch = mockFetch((request) => rpcResult(request, 12));
    const transport = make({
      ...quietOptions,
      fetch,
      endpoints: [
        { url: "https://unsupported.example", unsupportedMethods: ["getSlot"] },
        { url: "https://supported.example" },
      ],
    });
    await expect(transport.request("getSlot")).resolves.toBe(12);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenLastCalledWith("https://supported.example", expect.objectContaining({ method: "POST" }));
  });

  it("chunks and orders bulk account reads", async () => {
    const sizes: number[] = [];
    const fetch = mockFetch((request) => {
      const params = request.params as [string[], Record<string, unknown>];
      sizes.push(params[0].length);
      return rpcResult(request, {
        context: { slot: 1 },
        value: params[0].map((address) => ({ address })),
      });
    });
    const transport = make({ ...quietOptions, fetch });
    const addresses = Array.from({ length: 250 }, (_, index) => `address-${index}`);
    const result = await transport.getMultipleAccounts<{ address: string }>(addresses);
    expect(sizes.sort((a, b) => a - b)).toEqual([50, 100, 100]);
    expect(result).toHaveLength(250);
    expect(result[0]).toEqual({ address: "address-0" });
    expect(result[249]).toEqual({ address: "address-249" });
  });
});

describe("racing and cancellation", () => {
  it("hedges a slow read to another provider", async () => {
    const fetch = mockFetch((request, url, init) => {
      if (!url.includes("slow")) return rpcResult(request, 88);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      });
    });
    const transport = make({
      ...quietOptions,
      fetch,
      retries: 1,
      hedge: { delayMs: 5 },
      endpoints: ["https://slow.example", "https://fast.example"],
    });
    await expect(transport.request("getSlot")).resolves.toBe(88);
  });

  it("rebroadcasts sends sequentially without hedging", async () => {
    const events: string[] = [];
    const fetch = mockFetch((request, url, init) => {
      if (!url.includes("slow")) return rpcResult(request, "signature");
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      });
    });
    const transport = make({
      ...quietOptions,
      fetch,
      retries: 1,
      timeoutMs: 20,
      retryDelayMs: 0,
      hedge: { delayMs: 1 },
      endpoints: ["https://slow.example", "https://fast.example"],
      onEvent: (event) => events.push(event.type),
    });
    await expect(transport.request("sendTransaction", ["signed-bytes"])).resolves.toBe("signature");
    expect(events).not.toContain("hedge");
  });

  it("honors caller cancellation", async () => {
    const fetch = mockFetch((_request, _url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      });
    });
    const transport = make({ ...quietOptions, fetch, retries: 3 });
    const controller = new AbortController();
    const pending = transport.request("getSlot", undefined, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
