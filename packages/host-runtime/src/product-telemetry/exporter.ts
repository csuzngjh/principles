/**
 * Bounded asynchronous telemetry export client — Anonymous Product Telemetry
 * v1 (PRI-599, SPEC §29-§34).
 *
 * One HTTPS POST per invocation, bounded by AbortController, never throwing.
 * Failure mapping is coarse (SPEC §34): codes only, never messages, stacks,
 * or response bodies. The injectable fetchFn keeps unit tests offline.
 */

import type { ProductTelemetrySnapshotV1 } from '@principles/core/runtime-v2';

export const DEFAULT_PRODUCT_TELEMETRY_ENDPOINT = 'https://principles-website.pages.dev/api/product-telemetry/snapshot';
export const PRODUCT_TELEMETRY_TIMEOUT_MS = 8000;
export const PRODUCT_TELEMETRY_MAX_BODY_BYTES = 4096;

export type TelemetryFailureCode =
  | 'timeout'
  | 'network_error'
  | 'http_400'
  | 'http_429'
  | 'http_5xx'
  | 'http_unexpected_status'
  | 'invalid_response';

export type TelemetryExportResult =
  | { ok: true; status: number }
  | { ok: false; code: TelemetryFailureCode; retryable: boolean };

export type TelemetryFetchFn = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number }>;

function defaultFetchFn(url: string, init: Parameters<TelemetryFetchFn>[1]): Promise<{ status: number }> {
  // fetch must be invoked against globalThis inside workers/gateway runtimes
  // ("Illegal invocation" otherwise — same constraint as website relay-core).
  return fetch.call(globalThis, url, init);
}

export interface ExportSnapshotArgs {
  snapshot: ProductTelemetrySnapshotV1;
  endpoint?: string;
  timeoutMs?: number;
  fetchFn?: TelemetryFetchFn;
}

/**
 * Export one snapshot. Never throws; every failure maps to a coarse code
 * with a retryable hint the service uses for backoff.
 */
export async function exportSnapshot(args: ExportSnapshotArgs): Promise<TelemetryExportResult> {
  const endpoint = args.endpoint ?? DEFAULT_PRODUCT_TELEMETRY_ENDPOINT;
  const timeoutMs = args.timeoutMs ?? PRODUCT_TELEMETRY_TIMEOUT_MS;
  const fetchFn = args.fetchFn ?? defaultFetchFn;
  const body = JSON.stringify(args.snapshot);
  if (Buffer.byteLength(body, 'utf8') > PRODUCT_TELEMETRY_MAX_BODY_BYTES) {
    // Safety net: the strict schema keeps snapshots far below 4 KB; a
    // violation here is a programmer error, never worth a network round trip.
    return { ok: false, code: 'invalid_response', retryable: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    });
    const {status} = response;
    if (status >= 200 && status < 300) {
      return { ok: true, status };
    }
    if (status === 400) return { ok: false, code: 'http_400', retryable: false };
    if (status === 429) return { ok: false, code: 'http_429', retryable: true };
    if (status >= 500) return { ok: false, code: 'http_5xx', retryable: true };
    return { ok: false, code: 'http_unexpected_status', retryable: false };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, code: 'timeout', retryable: true };
    }
    // fetch rejects with TypeError on DNS failure / connection refused /
    // TLS errors — indistinguishable at this boundary and equally retryable.
    return { ok: false, code: 'network_error', retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * First failure retries after 1h; any further failure within 24h backs off 6h.
 * Combined with the service's dailyAttemptCount hard cap this bounds a bad day
 * to at most 5 attempts (0h/1h/7h/13h/19h), independent of clock skew.
 */
export function nextRetryDelayMs(previousFailureWithin24h: boolean): number {
  return previousFailureWithin24h ? 6 * 60 * 60 * 1000 : 60 * 60 * 1000;
}
