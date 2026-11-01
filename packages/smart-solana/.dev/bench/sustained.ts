import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MAINNET_ENDPOINTS, smartSolana } from "../../dist/index.js";

const OFFICIAL_RPC = "https://api.mainnet-beta.solana.com";
const TIMEOUT_MS = 5_000;
const STAGE_DURATION_MS = Number(process.env.BENCH_STAGE_MS ?? 15_000);
const WORKER_DELAY_MS = Number(process.env.BENCH_WORKER_DELAY_MS ?? 100);
const CONCURRENCY = (process.env.BENCH_CONCURRENCY_LEVELS ?? "1,5,10,25")
  .split(",")
  .map((value) => Number(value.trim()));

interface Client {
  label: string;
  request: () => Promise<void>;
  close: () => void;
}

interface Sample {
  second: number;
  latencyMs: number;
  ok: boolean;
  kind: "success" | "rateLimit" | "timeout" | "http" | "rpc" | "network";
  status?: number;
  message?: string;
}

interface Summary {
  requests: number;
  errors: number;
  errorRate: number;
  requestsPerSecond: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

interface Bucket extends Summary {
  second: number;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

positiveInteger(STAGE_DURATION_MS, "BENCH_STAGE_MS");
positiveInteger(TIMEOUT_MS, "TIMEOUT_MS");
if (!Number.isInteger(WORKER_DELAY_MS) || WORKER_DELAY_MS < 0) {
  throw new Error("BENCH_WORKER_DELAY_MS must be a non-negative integer");
}
if (CONCURRENCY.length === 0) throw new Error("BENCH_CONCURRENCY_LEVELS must not be empty");
for (const level of CONCURRENCY) positiveInteger(level, "BENCH_CONCURRENCY_LEVELS");

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function quantile(values: readonly number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function summarize(samples: readonly Sample[], durationMs = STAGE_DURATION_MS): Summary {
  const latencies = samples.map((sample) => sample.latencyMs);
  const errors = samples.filter((sample) => !sample.ok).length;
  return {
    requests: samples.length,
    errors,
    errorRate: samples.length === 0 ? 0 : round(errors / samples.length),
    requestsPerSecond: round(samples.length / (durationMs / 1_000)),
    p50: round(quantile(latencies, 50)),
    p95: round(quantile(latencies, 95)),
    p99: round(quantile(latencies, 99)),
    max: round(Math.max(0, ...latencies)),
  };
}

function errorKind(error: unknown): Sample["kind"] {
  const message = error instanceof Error ? error.message : String(error);
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  if (status === 429 || /429|too many requests|rate.?limit/i.test(message)) return "rateLimit";
  if (/timed? ?out|timeout|aborted/i.test(message)) return "timeout";
  if (/HTTP \d/i.test(message)) return "http";
  if (/All Solana RPC attempts|fetch failed|network|socket|connect/i.test(message)) return "network";
  return "rpc";
}

async function directRequest(url: string): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSlot",
      params: [{ commitment: "confirmed" }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let body: { result?: number; error?: { code: number; message: string } } = {};
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      if (response.ok) throw new Error("Invalid JSON-RPC response");
    }
  }
  if (!response.ok) {
    const error = new Error(body.error?.message ?? `HTTP ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
}

function directClient(url = OFFICIAL_RPC, label = "Solana RPC direct"): Client {
  return { label, request: () => directRequest(url), close: () => {} };
}

function pooledClient(): Client {
  const transport = smartSolana({
    cache: false,
    coalesce: false,
    health: false,
    hedge: false,
    retries: 1,
    timeoutMs: TIMEOUT_MS,
  });
  return {
    label: "smartSolana() uncached",
    request: async () => {
      await transport.request("getSlot", [{ commitment: "confirmed" }], { skipCache: true });
    },
    close: () => transport.close(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runStage(
  client: Client,
  concurrency: number,
): Promise<{
  concurrency: number;
  summary: Summary;
  outcomes: Record<string, number>;
  httpStatuses: Record<string, number>;
  timeline: Bucket[];
}> {
  const samples: Sample[] = [];
  const stageStarted = performance.now();
  const workers = Array.from({ length: concurrency }, async () => {
    while (performance.now() - stageStarted < STAGE_DURATION_MS) {
      const started = performance.now();
      const second = Math.floor((started - stageStarted) / 1_000);
      try {
        await client.request();
        samples.push({ second, latencyMs: performance.now() - started, ok: true, kind: "success" });
      } catch (error) {
        const status =
          typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
            ? error.status
            : undefined;
        samples.push({
          second,
          latencyMs: performance.now() - started,
          ok: false,
          kind: errorKind(error),
          ...(status === undefined ? {} : { status }),
          message: error instanceof Error ? error.message : String(error),
        });
      }
      await sleep(WORKER_DELAY_MS);
    }
  });
  await Promise.all(workers);
  const outcomes: Record<string, number> = {};
  const httpStatuses: Record<string, number> = {};
  for (const sample of samples) {
    outcomes[sample.kind] = (outcomes[sample.kind] ?? 0) + 1;
    if (sample.status !== undefined) {
      const status = String(sample.status);
      httpStatuses[status] = (httpStatuses[status] ?? 0) + 1;
    }
  }
  const seconds = Math.ceil(STAGE_DURATION_MS / 1_000);
  const timeline = Array.from(
    { length: seconds },
    (_, second): Bucket => ({
      second,
      ...summarize(
        samples.filter((sample) => sample.second === second),
        1_000,
      ),
    }),
  );
  return { concurrency, summary: summarize(samples), outcomes, httpStatuses, timeline };
}

const registry = process.env.BENCH_REGISTRY === "1";
const provider = process.env.BENCH_PROVIDER;
const selectedEndpoints = provider
  ? MAINNET_ENDPOINTS.filter((endpoint) => endpoint.label === provider)
  : MAINNET_ENDPOINTS;
if (provider && selectedEndpoints.length === 0) throw new Error(`Unknown default provider: ${provider}`);
const clients = registry
  ? [
      ...selectedEndpoints.map((endpoint) => directClient(endpoint.url, `${endpoint.label ?? endpoint.url} direct`)),
      pooledClient(),
    ]
  : [directClient(), pooledClient()];

const report = {
  ranAt: new Date().toISOString(),
  registry,
  endpoint: OFFICIAL_RPC,
  method: "getSlot",
  stageDurationMs: STAGE_DURATION_MS,
  workerDelayMs: WORKER_DELAY_MS,
  timeoutMs: TIMEOUT_MS,
  concurrency: CONCURRENCY,
  note: "Closed-loop concurrent HTTP requests, not a TCP-connection-count test; Node fetch may reuse connections. Each worker waits 100ms after a call by default. The pool has one retry and no cache, coalescing, hedging, or health probes. Public endpoint results vary by network and provider rate limits.",
  results: [] as {
    label: string;
    stages: Awaited<ReturnType<typeof runStage>>[];
  }[],
};

for (const client of clients) {
  const result = { label: client.label, stages: [] as Awaited<ReturnType<typeof runStage>>[] };
  try {
    for (const concurrency of CONCURRENCY) {
      const stage = await runStage(client, concurrency);
      result.stages.push(stage);
      console.error(JSON.stringify({ client: client.label, concurrency, ...stage.summary, outcomes: stage.outcomes }));
    }
  } finally {
    client.close();
  }
  report.results.push(result);
}

const json = JSON.stringify(report, null, 2);
const out = process.env.BENCH_OUT;
if (out) {
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${json}\n`);
  console.error(`wrote ${out}`);
}
console.log(json);
