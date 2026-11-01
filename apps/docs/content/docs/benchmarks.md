---

title: Benchmarks
description: Reproduce Smart Solana provider comparisons and sustained-load results.
---

# Benchmarks

Live benchmarks use public mainnet endpoints, so results vary by machine, network, time, and provider rate limits. They are comparisons from one environment, not provider SLAs or load-test guarantees. Run them conservatively.

## Sustained comparison

The optimized transport was compared with a direct PublicNode connection using ten concurrent workers for 15 seconds. Each worker requested `getSlot`, waited 100 ms after each call, and kept at most one request in flight. The pool used one retry with cache, coalescing, hedging, and health probes disabled so the measurement covers network routing rather than cache hits.

| Transport                | Requests | Errors |  Throughput |           p50 |           p95 |       p99 |
| ------------------------ | -------: | -----: | ----------: | ------------: | ------------: | --------: |
| `smartSolana()` uncached |      682 |      0 | 45.47 req/s | **116.07 ms** | **140.00 ms** | 260.27 ms |
| PublicNode direct        |      664 |      0 | 44.27 req/s |     121.12 ms |     152.46 ms | 264.77 ms |

The earlier router reached a 383.77 ms p50 and 2,994.63 ms p95 under the same workload. Removing speculative in-flight penalties, keeping unknown providers off the healthy user path, and disabling PublicNode HTTP batching removed that overhead.

## Reproduce

From the repository root:

```sh
BENCH_REGISTRY=1 \
BENCH_PROVIDER=publicnode \
BENCH_CONCURRENCY_LEVELS=10 \
BENCH_OUT=sustained-optimized-results.json \
bun run bench:sustained
```

`BENCH_STAGE_MS`, `BENCH_WORKER_DELAY_MS`, and `BENCH_CONCURRENCY_LEVELS` control the load. Omit `BENCH_PROVIDER` to compare every default provider. Set `BENCH_REGISTRY=0` for the official Solana endpoint comparison.

## Read-mix comparison

```sh
BENCH_OUT=benchmark-results.json bun run bench:live
```

This runner compares the direct public Solana RPC, an uncached pool, and the default cached pool over rotating sequential and concurrent phases. It reports cold and warm percentiles, errors, cache hits, hedges, attempts, and per-method results. `BENCH_SEQUENTIAL`, `BENCH_CONCURRENT`, and `BENCH_PACE_MS` adjust the workload.
