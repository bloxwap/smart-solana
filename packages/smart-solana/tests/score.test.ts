import { describe, expect, it } from "bun:test";
import { emptyStat, endpointScore, observe, serviceMs } from "../src/score.js";

describe("adaptive endpoint scores", () => {
  it("learns latency and converges toward measurements", () => {
    const stat = emptyStat();
    expect(serviceMs(stat)).toBe(250);
    for (let index = 0; index < 20; index += 1) observe(stat, 40, true);
    expect(serviceMs(stat)).toBeCloseTo(40, 5);
    expect(stat.errorRate).toBe(0);
  });

  it("penalizes errors and slot lag", () => {
    const healthy = emptyStat();
    const failing = emptyStat();
    for (let index = 0; index < 10; index += 1) {
      observe(healthy, 50, true);
      observe(failing, 50, false);
    }
    const base = { maxSlotLag: 100, weight: 1 };
    expect(endpointScore({ global: failing, ...base })).toBeGreaterThan(endpointScore({ global: healthy, ...base }));
    expect(endpointScore({ global: healthy, ...base, slotLag: 500 })).toBeGreaterThan(
      endpointScore({ global: healthy, ...base }),
    );
  });
});
