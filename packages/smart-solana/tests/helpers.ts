import { vi } from "bun:test";
import type { JsonRpcRequest } from "../src/types.js";

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function rpcResult(request: JsonRpcRequest, result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id: request.id, result });
}

export function requests(body: string): JsonRpcRequest[] {
  const payload = JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[];
  return Array.isArray(payload) ? payload : [payload];
}

export function mockFetch(
  handler: (request: JsonRpcRequest, url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof globalThis.fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const payload = requests(String(init?.body));
    if (payload.length > 1) throw new Error("Unexpected HTTP batch");
    return handler(payload[0] as JsonRpcRequest, url, init);
  }) as unknown as typeof globalThis.fetch;
}

export const quietOptions = {
  genesisHash: false,
  health: false,
  cache: false,
  hedge: false,
  retries: 0,
  batch: false,
} as const;
