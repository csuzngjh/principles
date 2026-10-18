/**
 * SPEC-PD-PI12-COMPAT-001 Phase 3 (AC-6) — real-LLM wire observation harness.
 *
 * AC-6's faux blind spot (audit R1/SPEC §12) is the onPayload → real-HTTP
 * rewrite surface: the faux provider bypasses the per-API HTTP adapters, so
 * tool_choice / response_format mutations and the exact wire transcript are
 * only observable on a real provider call. This harness adds OBSERVATION ONLY:
 *
 *   - it wraps the REAL `getPiAiFetchForApi` transport (same undici path as
 *     production, real HTTP in both directions — nothing is stubbed);
 *   - it counts every outbound LLM HTTP request so the authorized budget is
 *     enforceable (a hard cap fails loud BEFORE the request is sent);
 *   - it records a bounded, redacted snapshot of each request (message roles,
 *     declared tool names, tool_choice, response_format). Header VALUES are
 *     never read — only whether an Authorization header was present — so the
 *     API key can never reach logs, reports, or git (rc-8 bounded output).
 *
 * Usage in a test file:
 *
 *   vi.mock('../../pi-ai-http-transport.js', async (importActual) => {
 *     const actual = await importActual<typeof import('../../pi-ai-http-transport.js')>();
 *     const harness = await import('./pi12-ac6-harness.js');
 *     return {
 *       ...actual,
 *       getPiAiFetchForApi: harness.wrapGetPiAiFetchForApi(actual.getPiAiFetchForApi),
 *     };
 *   });
 *
 * With no active recorder (the default — including the whole regular suite)
 * the wrapper forwards to the real transport with zero behavior change.
 */
import type { FetchFunction } from '@earendil-works/pi-ai';

/** One redacted wire request. Never carries credentials or raw bodies. */
export interface RecordedRequest {
  url: string;
  method: string;
  /** Header PRESENCE only — the value (API key) is never read or stored. */
  hasAuthorizationHeader: boolean;
  /** Wire message roles in order (e.g. ['system','user']). */
  messageRoles: string[];
  /** Bounded preview of the first system message (PD-authored prompt text). */
  systemTextPreview?: string;
  /** Bounded preview of the first user message. */
  userTextPreview?: string;
  /** Names from the wire `tools` array, when declared. */
  declaredToolNames: string[];
  /** Post-onPayload `tool_choice`, when the request carries one. */
  toolChoice?: unknown;
  /** Post-onPayload `response_format`, when the request carries one. */
  responseFormat?: unknown;
  bodyBytes: number;
}

export interface WireRecorder {
  /** Hard cap — the wrapper throws BEFORE sending request maxRequests+1. */
  readonly maxRequests: number;
  readonly startedAtMs: number;
  readonly requests: RecordedRequest[];
  /** Stop recording (later calls flow through unobserved). */
  stop(): void;
}

const PREVIEW_CHARS = 600;

/** Module-local recorder for THIS test file's module graph (vitest isolates per file). */
let currentRecorder: WireRecorder | undefined;

/** Guarded accessor — the repo forbids non-null assertions. */
export function activeRecorder(): WireRecorder | undefined {
  return currentRecorder;
}

/** Arm the recorder for the next scenario. One scenario records at a time. */
export function startRecorder(maxRequests: number): WireRecorder {
  if (currentRecorder) {
    currentRecorder.stop();
  }
  const recorder: WireRecorder = {
    maxRequests,
    startedAtMs: Date.now(),
    requests: [],
    stop(): void {
      if (currentRecorder === recorder) {
        currentRecorder = undefined;
      }
    },
  };
  currentRecorder = recorder;
  return recorder;
}

function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const textBlock = content.find((block): block is { type: 'text'; text: string } => {
      return typeof block === 'object' && block !== null && Object.hasOwn(block, 'type') && (block as { type?: unknown }).type === 'text';
    });
    return textBlock?.text;
  }
  return undefined;
}

function bounded(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS)}…`;
}

/**
 * Header PRESENCE check without DOM types (node tsconfig has no lib.dom):
 * reads key names only — header VALUES (the API key) are never touched.
 */
function hasAuthorizationHeader(headersInit: unknown): boolean {
  if (headersInit === undefined || headersInit === null) {
    return false;
  }
  if (typeof headersInit === 'object' && !Array.isArray(headersInit)) {
    const asRecord = headersInit as Record<string, unknown>;
    const hasFn = asRecord.has;
    if (typeof hasFn === 'function') {
      return (hasFn as (name: string) => boolean).call(headersInit, 'authorization');
    }
    return Object.keys(asRecord).some((key) => key.toLowerCase() === 'authorization');
  }
  if (Array.isArray(headersInit)) {
    return headersInit.some((entry) => Array.isArray(entry) && String(entry[0]).toLowerCase() === 'authorization');
  }
  return false;
}

/**
 * Structural record guard (rc-2): rebuilds a plain string-keyed record from a
 * JSON-parsed value instead of asserting. Own enumerable members only; arrays
 * and primitives are rejected.
 */
function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    record[key] = member;
  }
  return record;
}

/**
 * Redact-and-bounds a wire request. Best-effort by design: when the body is
 * not a JSON string the snapshot degrades to url/method/headers-presence and
 * the assertions that need the body fail loudly on their own terms (rc-9).
 */
export function observeRequest(input: Parameters<FetchFunction>[0], init: Parameters<FetchFunction>[1] | undefined): RecordedRequest {
  const rawBody = typeof init?.body === 'string' ? init.body : '';

  let parsed: Record<string, unknown> | undefined;
  if (rawBody.length > 0) {
    try {
      parsed = asPlainRecord(JSON.parse(rawBody));
    } catch {
      parsed = undefined;
    }
  }

  const rawMessages = parsed !== undefined && Array.isArray(parsed.messages) ? (parsed.messages as unknown[]) : [];
  const messageRoles = rawMessages.map((message) => {
    if (typeof message === 'object' && message !== null && Object.hasOwn(message, 'role')) {
      return String((message as { role: unknown }).role);
    }
    return 'unknown';
  });

  const declaredToolNames: string[] = [];
  if (parsed !== undefined && Array.isArray(parsed.tools)) {
    for (const tool of parsed.tools as unknown[]) {
      if (typeof tool !== 'object' || tool === null) {
        continue;
      }
      const toolRecord = tool as Record<string, unknown>;
      const fn = toolRecord.function;
      if (typeof fn === 'object' && fn !== null) {
        const fnRecord = fn as Record<string, unknown>;
        if (Object.hasOwn(fnRecord, 'name')) {
          declaredToolNames.push(String(fnRecord.name));
        }
      } else if (Object.hasOwn(toolRecord, 'name')) {
        declaredToolNames.push(String(toolRecord.name));
      }
    }
  }

  return {
    url: String(input),
    method: init?.method ?? 'POST',
    hasAuthorizationHeader: hasAuthorizationHeader(init?.headers),
    messageRoles,
    systemTextPreview: bounded(textOf(rawMessages[0])),
    userTextPreview: bounded(textOf(rawMessages.find((m) => typeof m === 'object' && m !== null && (m as { role?: unknown }).role === 'user'))),
    declaredToolNames,
    toolChoice: parsed?.tool_choice,
    responseFormat: parsed?.response_format,
    bodyBytes: rawBody.length,
  };
}

/**
 * Wrap the REAL transport getter. Observation + hard cap only — the returned
 * fetch forwards every call (and its response) untouched to the real transport.
 */
export function wrapGetPiAiFetchForApi(
  realGet: (api: string | undefined) => FetchFunction,
): (api: string | undefined) => FetchFunction {
  return (api: string | undefined): FetchFunction => {
    const realFetch = realGet(api);
    return async (input, init) => {
      const recorder = currentRecorder;
      if (recorder === undefined) {
        return realFetch(input, init);
      }
      if (recorder.requests.length >= recorder.maxRequests) {
        throw new Error(
          `[ac6] hard request cap exceeded (${recorder.maxRequests}) — failing loud before sending to protect the authorized budget`,
        );
      }
      recorder.requests.push(observeRequest(input, init));
      return realFetch(input, init);
    };
  };
}
