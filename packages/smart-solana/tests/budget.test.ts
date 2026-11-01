import { describe, expect, it } from "bun:test";
import { RequestBudget, TokenBucket } from "../src/budget.js";

describe("request budgets", () => {
  it("refills tokens continuously", () => {
    let now = 0;
    const bucket = new TokenBucket(10, 2, () => now);
    bucket.take();
    bucket.take();
    expect(bucket.delayMs()).toBe(100);
    now = 50;
    expect(bucket.delayMs()).toBe(50);
    now = 100;
    expect(bucket.delayMs()).toBe(0);
  });

  it("enforces global and per-method budgets", async () => {
    let now = 0;
    const waits: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    try {
      globalThis.setTimeout = ((handler: () => void, ms?: number) => {
        waits.push(ms ?? 0);
        now += ms ?? 0;
        handler();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;
      const budget = new RequestBudget(100, 100, { getSlot: 1 }, () => now);
      for (let index = 0; index < 3; index += 1) await budget.acquire("getSlot");
      expect(waits).toEqual([1_000, 1_000]);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});
