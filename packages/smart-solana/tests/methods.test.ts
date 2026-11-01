import { describe, expect, it } from "bun:test";
import { isCacheableMethod, isHedgeableMethod, isRebroadcastMethod, isRetryableMethod } from "../src/methods.js";

describe("Solana method policy", () => {
  it("allows safe read retries and hedges", () => {
    expect(isRetryableMethod("getAccountInfo")).toBe(true);
    expect(isHedgeableMethod("getMultipleAccounts")).toBe(true);
    expect(isCacheableMethod("getAccountInfo")).toBe(true);
  });

  it("does not retry airdrops or cache simulations", () => {
    expect(isRetryableMethod("requestAirdrop")).toBe(false);
    expect(isCacheableMethod("simulateTransaction")).toBe(false);
  });

  it("rebroadcasts signed transactions without hedging them", () => {
    expect(isRebroadcastMethod("sendTransaction")).toBe(true);
    expect(isRetryableMethod("sendTransaction")).toBe(true);
    expect(isHedgeableMethod("sendTransaction")).toBe(false);
  });
});
