import type { JsonRpcErrorBody } from "./types.js";

export class SolanaRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly method: string;

  constructor(method: string, error: JsonRpcErrorBody) {
    super(`Solana RPC ${method} failed: ${error.message}`);
    this.name = "SolanaRpcError";
    this.code = error.code;
    this.data = error.data;
    this.method = method;
  }
}

export class AllEndpointsFailedError extends Error {
  readonly errors: readonly Error[];

  constructor(method: string, errors: readonly Error[]) {
    super(`All Solana RPC attempts for ${method} failed (${errors.length} attempts)`);
    this.name = "AllEndpointsFailedError";
    this.errors = errors;
  }
}

export class EndpointError extends Error {
  readonly endpoint: string;
  readonly status?: number;
  readonly rpcCode?: number;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly rateLimited: boolean;

  constructor(
    endpoint: string,
    message: string,
    options: {
      status?: number;
      rpcCode?: number;
      retryAfterMs?: number;
      retryable?: boolean;
      rateLimited?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(`${endpoint}: ${message}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "EndpointError";
    this.endpoint = endpoint;
    this.status = options.status;
    this.rpcCode = options.rpcCode;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable ?? true;
    this.rateLimited = options.rateLimited ?? false;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function isRetryableError(error: unknown): boolean {
  return error instanceof EndpointError && error.retryable;
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function redactUrl(message: string, url: string, label: string): string {
  return message.split(url).join(`[${label}]`);
}
