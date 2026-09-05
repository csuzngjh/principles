/**
 * pi-ai HTTP transport owner (PRI-683).
 *
 * Node's global fetch (built-in undici dispatcher) applies implicit default
 * `headersTimeout`/`bodyTimeout` of 300s per request. LLM repair-wave requests
 * with large payloads can exceed 300s on server prefill before response
 * headers arrive, so the request is aborted at exactly 300.0s even when the
 * runtime profile's timeoutMs is 600s/900s — the configured deadline never
 * gets a chance to fire (lab evidence: every repair attempt died at
 * 300.02-300.04s with "Request was aborted", PRI-683).
 *
 * The fix reuses pi-ai's official `options.fetch` injection point
 * (ProviderRequestOptions.fetch) to route PD's LLM requests through a
 * dedicated undici Agent with both idle/header caps disabled. The only
 * remaining timeout authorities are then the ones the pipeline already
 * configures and has verified (adapter AbortSignal.timeout + SDK request
 * `timeout` + runner deadline, PR #1512). Scoped per-request: the host
 * process's global dispatcher and globalThis.fetch are left untouched, so
 * non-PD fetches in the OpenClaw host keep their previous behavior.
 *
 * This file is a registered I/O seam (io-seam-registry.json, `pi-ai-http-transport`)
 * because it imports undici — a transport-layer library import, not business I/O.
 */
import * as undici from 'undici';
import { EventEmitter } from 'node:events';
import type { FetchFunction } from '@earendil-works/pi-ai';

/**
 * undici mid-stream body errors (e.g. headersTimeout abort) surface as an
 * EventEmitter "error" on the dispatcher. Without a listener, Node would
 * crash the process (same mitigation pi-coding-agent applies to its
 * dispatcher, commit 2117b61c). undici's own `on()` typings only cover its
 * documented events, so attach through the EventEmitter base.
 */
const ignoreDispatcherError = (_error: unknown): void => {
  // Deliberately empty: undici "error" events on a dispatcher are mid-stream
  // body errors that already surface through the request promise; this
  // listener only prevents EventEmitter's unhandled-"error" crash.
};

/**
 * Create a fetch bound to a dedicated undici Agent with the 300s
 * headers/body idle caps disabled. Exported for the mechanism regression
 * test, which recreates the exact PRI-683 failure at 1s scale by passing a
 * small timeout here. Production callers use `getPiAiFetch()` (caps disabled).
 */
export function createBoundPiAiFetch(
  agentOptions: Pick<undici.Agent.Options, 'bodyTimeout' | 'headersTimeout'> = {
    bodyTimeout: 0,
    headersTimeout: 0,
  },
): FetchFunction {
  const agent = new undici.Agent(agentOptions);
  EventEmitter.prototype.on.call(agent, 'error', ignoreDispatcherError);
  const boundFetch: FetchFunction = (input, init) =>
    undici.fetch(input, { ...init, dispatcher: agent });
  return boundFetch;
}

let cachedPiAiFetch: FetchFunction | undefined;

/**
 * Process-wide singleton fetch for all PD pi-ai LLM requests. The Agent is
 * reused so its connection pool is shared across every adapter instance
 * (a per-request Agent would leak sockets).
 */
export function getPiAiFetch(): FetchFunction {
  cachedPiAiFetch ??= createBoundPiAiFetch();
  return cachedPiAiFetch;
}

/** Test-only: reset the singleton (vitest module state isolation). */
export function resetPiAiFetchForTest(): void {
  cachedPiAiFetch = undefined;
}
