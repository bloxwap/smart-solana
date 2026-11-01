import { describe, expect, it } from "bun:test";
import { MAINNET_ENDPOINTS, defaultWebSocketEndpoints } from "../src/index.js";

describe("mainnet provider registry", () => {
  it("contains nine distinct providers without hostname aliases", () => {
    expect(MAINNET_ENDPOINTS).toHaveLength(9);
    expect(new Set(MAINNET_ENDPOINTS.map((endpoint) => endpoint.label)).size).toBe(9);
    expect(new Set(MAINNET_ENDPOINTS.map((endpoint) => new URL(endpoint.url).hostname)).size).toBe(9);
  });

  it("starts with providers that sustained load without throttling", () => {
    expect(MAINNET_ENDPOINTS.slice(0, 2).map((endpoint) => endpoint.label)).toEqual(["publicnode", "pocket"]);
  });

  it("only advertises live-probed WebSocket endpoints", () => {
    expect(defaultWebSocketEndpoints("mainnet-beta")).toHaveLength(5);
    for (const endpoint of defaultWebSocketEndpoints("mainnet-beta")) {
      expect(endpoint.url).toMatch(/^wss:\/\//);
    }
  });

  it("records restrictive provider capabilities", () => {
    const tatum = MAINNET_ENDPOINTS.find((endpoint) => endpoint.label === "tatum");
    expect(tatum?.batch).toBe(false);
    expect(tatum?.rps).toBeCloseTo(5 / 60);
    expect(tatum?.unsupportedMethods).toContain("getSignaturesForAddress");
    expect(MAINNET_ENDPOINTS.find((endpoint) => endpoint.label === "solanavibestation")?.batch).toBe("same-method");
    expect(MAINNET_ENDPOINTS.find((endpoint) => endpoint.label === "pocket")?.batch).toBe(false);
  });
});
