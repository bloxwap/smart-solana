import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { smartSolana, type RpcEvent, type SolanaTransport } from "../../dist/index.js";

const OFFICIAL_RPC = "https://api.mainnet-beta.solana.com";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TIMEOUT_MS = 5_000;
const SEQUENTIAL_ITERATIONS = Number(process.env.BENCH_SEQUENTIAL ?? 20);
const CONCURRENT_ITERATIONS = Number(process.env.BENCH_CONCURRENT ?? 10);
const PACE_MS = Number(process.env.BENCH_PACE_MS ?? 2_000);

const CALLS: readonly { method: string; params?: unknown }[] = [
  { method: "getSlot", params: [{ commitment: "confirmed" }] },
  { method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] },
  { method: "getBalance", params: [SYSTEM_PROGRAM, { commitment: "confirmed" }] },
  {
    method: "getAccountInfo",
    params: [TOKEN_PROGRAM, { encoding: "base64", commitment: "confirmed" }],
  },
  {
    method: "getMultipleAccounts",
    params: [[SYSTEM_PROGRAM, TOKEN_PROGRAM], { encoding: "base64", commitment: "confirmed" }],
  },
];

interface Client {
  label: string;
  request: (method: string, params?: unknown) => Promise<unknown>;
  close: () => void;
  stats: () => { attempts: number; cacheHits: number; hedges: number };
}

interface Sample {
  iteration: number;
  method: string;
  latencyMs: number;
  ok: boolean;
  error?: string;
}

interface Summary {
  requests: number;
  errors: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

interface PhaseReport {
  all: Summary;
  warm: Summary;
  methods: Record<string, Summary>;
  attempts: number;
  cacheHits: number;
  hedges: number;
  samples: Sample[];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function quantile(values: readonly number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function summarize(samples: readonly Sample[]): Summary {
  const latencies = samples.map((sample) => sample.latencyMs);
  const errors = samples.filter((sample) => !sample.ok).length;
  return {
    requests: samples.length,
    errors,
    errorRate: samples.length === 0 ? 0 : round(errors / samples.length),
    p50: round(quantile(latencies, 50)),
    p95: round(quantile(latencies, 95)),
    p99: round(quantile(latencies, 99)),
    max: round(Math.max(0, ...latencies)),
  };
}

function phaseReport(
  samples: Sample[],
  before: ReturnType<Client["stats"]>,
  after: ReturnType<Client["stats"]>,
): PhaseReport {
  const methods: Record<string, Summary> = {};
  for (const call of CALLS) {
    methods[call.method] = summarize(samples.filter((sample) => sample.method === call.method));
  }
  return {
    all: summarize(samples),
    warm: summarize(samples.filter((sample) => sample.iteration > 0)),
    methods,
    attempts: after.attempts - before.attempts,
    cacheHits: after.cacheHits - before.cacheHits,
    hedges: after.hedges - before.hedges,
    samples,
  };
}

function directClient(): Client {
  let id = 0;
  let attempts = 0;
  return {
    label: "Solana RPC direct",
    request: async (method, params) => {
      attempts += 1;
      const response = await fetch(OFFICIAL_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params === undefined ? {} : { params }) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await response.json()) as {
        result?: unknown;
        error?: { code: number; message: string };
      };
      if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
      if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
      return body.result;
    },
    close: () => {},
    stats: () => ({ attempts, cacheHits: 0, hedges: 0 }),
  };
}

function pooledClient(label: string, cache: boolean): Client {
  let attempts = 0;
  let cacheHits = 0;
  let hedges = 0;
  const transport: SolanaTransport = smartSolana({
    cache,
    timeoutMs: TIMEOUT_MS,
    onEvent: (event: RpcEvent) => {
      if (event.type === "attempt") attempts += 1;
      if (event.type === "cacheHit") cacheHits += 1;
      if (event.type === "hedge") hedges += 1;
    },
  });
  return {
    label,
    request: (method, params) => transport.request(method, params),
    close: () => transport.close(),
    stats: () => ({ attempts, cacheHits, hedges }),
  };
}

async function runCall(client: Client, call: (typeof CALLS)[number], iteration: number): Promise<Sample> {
  const started = performance.now();
  try {
    await client.request(call.method, call.params);
    return { iteration, method: call.method, latencyMs: performance.now() - started, ok: true };
  } catch (error) {
    return {
      iteration,
      method: call.method,
      latencyMs: performance.now() - started,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pace(started: number): Promise<void> {
  await sleep(Math.max(0, PACE_MS - (performance.now() - started)));
}

async function runSequential(client: Client, iterations: number, offset = 0): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const started = performance.now();
    for (const call of CALLS) samples.push(await runCall(client, call, iteration + offset));
    await pace(started);
  }
  return samples;
}

async function runConcurrent(client: Client, iterations: number, offset = 0): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const started = performance.now();
    const groups = await Promise.all([
      Promise.all(CALLS.map((call) => runCall(client, call, iteration + offset))),
      Promise.all(CALLS.map((call) => runCall(client, call, iteration + offset))),
    ]);
    samples.push(...groups.flat());
    await pace(started);
  }
  return samples;
}

function ordered(clients: readonly Client[], iteration: number): Client[] {
  return clients.map((_, index) => clients[(index + iteration) % clients.length] as Client);
}

function validateCount(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

validateCount(SEQUENTIAL_ITERATIONS, "BENCH_SEQUENTIAL");
validateCount(CONCURRENT_ITERATIONS, "BENCH_CONCURRENT");
validateCount(PACE_MS, "BENCH_PACE_MS");

const clients = [
  directClient(),
  pooledClient("smartSolana() uncached", false),
  pooledClient("smartSolana() defaults", true),
];
const sequential = new Map<string, Sample[]>();
const concurrent = new Map<string, Sample[]>();
const sequentialBefore = new Map<string, ReturnType<Client["stats"]>>();
const sequentialAfter = new Map<string, ReturnType<Client["stats"]>>();
const concurrentBefore = new Map<string, ReturnType<Client["stats"]>>();
const concurrentAfter = new Map<string, ReturnType<Client["stats"]>>();

try {
  for (let iteration = 0; iteration < SEQUENTIAL_ITERATIONS; iteration += 1) {
    for (const client of ordered(clients, iteration)) {
      if (!sequentialBefore.has(client.label)) sequentialBefore.set(client.label, client.stats());
      const samples = await runSequential(client, 1, iteration);
      sequential.set(client.label, [...(sequential.get(client.label) ?? []), ...samples]);
      if (iteration === SEQUENTIAL_ITERATIONS - 1) sequentialAfter.set(client.label, client.stats());
      console.error(`sequential ${iteration + 1}/${SEQUENTIAL_ITERATIONS}: ${client.label}`);
    }
  }
  for (let iteration = 0; iteration < CONCURRENT_ITERATIONS; iteration += 1) {
    for (const client of ordered(clients, iteration)) {
      if (!concurrentBefore.has(client.label)) concurrentBefore.set(client.label, client.stats());
      const samples = await runConcurrent(client, 1, iteration);
      concurrent.set(client.label, [...(concurrent.get(client.label) ?? []), ...samples]);
      if (iteration === CONCURRENT_ITERATIONS - 1) concurrentAfter.set(client.label, client.stats());
      console.error(`concurrent ${iteration + 1}/${CONCURRENT_ITERATIONS}: ${client.label}`);
    }
  }
} finally {
  for (const client of clients) client.close();
}

const report = {
  ranAt: new Date().toISOString(),
  endpoint: OFFICIAL_RPC,
  timeoutMs: TIMEOUT_MS,
  paceMs: PACE_MS,
  iterations: { sequential: SEQUENTIAL_ITERATIONS, concurrent: CONCURRENT_ITERATIONS },
  calls: CALLS,
  note: "Transport order rotates each iteration. Warm excludes the first iteration of each phase. Direct and uncached clients perform network reads; the default client also caches and coalesces identical reads. cacheHits counts fresh hits only; stale-while-revalidate responses are not emitted as cacheHit events. This is a single-machine live comparison, not a load test.",
  results: Object.fromEntries(
    clients.map((client) => [
      client.label,
      {
        sequential: phaseReport(
          sequential.get(client.label) ?? [],
          sequentialBefore.get(client.label) ?? client.stats(),
          sequentialAfter.get(client.label) ?? client.stats(),
        ),
        concurrent: phaseReport(
          concurrent.get(client.label) ?? [],
          concurrentBefore.get(client.label) ?? client.stats(),
          concurrentAfter.get(client.label) ?? client.stats(),
        ),
      },
    ]),
  ),
};

const json = JSON.stringify(report, null, 2);
const out = process.env.BENCH_OUT;
if (out) {
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${json}\n`);
  console.error(`wrote ${out}`);
}
console.log(json);
