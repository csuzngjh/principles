/**
 * HostSubmissionContext — the unified, host-generated MCP request identity
 * (SPEC-PD-FEEDBACK-RESILIENCE-001 v0.7 §G2, PRI-1274 B1).
 *
 * A `pd_submit_pain` `tools/call` request may carry host-injected `_meta`.
 * When the MCP server was started by the host against the current workspace
 * binding (startup-bound `PD_MCP_WORKSPACE_DIR` / `PD_MCP_HOST`, resolved by
 * the caller — never here), that `_meta` is the ONLY model-invisible identity
 * source PD treats as trusted for pre-write session binding. This module is
 * the pure normalizer: per-host field mapping, shape/sentinel validation and
 * a three-way verdict (`present` / `missing` / `invalid`). It performs no I/O,
 * knows nothing about transports, and never imports the MCP SDK (the Core
 * SDK-free architecture guard stays intact).
 *
 * Field mapping is per-host and verified — no cross-host guessing:
 *  - Codex: native `threadId` (preferred) / `sessionId`;
 *    `x-codex-turn-metadata.turn_id` is the OPTIONAL submission turn.
 *    `windowId`/`itemId` are NOT turn ids and are never mapped.
 *  - OpenClaw: the namespaced `_meta["pd.host-context.v1"]` object
 *    (`sessionId` required; `submissionTurnId`/`toolCallId` optional).
 *    Producers arrive with PRI-1276; the consumer contract lives here so all
 *    hosts normalize to one shape.
 *  - WorkBuddy: the namespaced key AND (since PRI-1275) the probe-verified
 *    native engine field `_meta.baggage` entry
 *    `codebuddy.session_id=<uuid>` (installed CodeBuddy Code 2.165.0 injects
 *    it on every `tools/call`; the value equals the hook payload's
 *    `session_id`). When both sources are present they must agree — a
 *    disagreement fails closed. `baggage` never maps a submission turn:
 *    `codebuddy.conversation_request_id` equivalence is unproven.
 *
 * Identity fields that are NOT proven equivalent (`sessionKey`,
 * `generation_id`, `conversation_request_id`, `runId`, `turn_index`,
 * recent-message ids) must never be mapped by callers into this context.
 */

import { isSentinelSessionId } from './pain-ingress-payload.js';

/** The only trusted source for a HostSubmissionContext (PRI-1274). */
export const HOST_SUBMISSION_CONTEXT_SOURCE = 'mcp_request_meta' as const;

/** Namespaced `_meta` key non-Codex hosts use (host-runtime contract). */
export const PD_HOST_CONTEXT_META_KEY = 'pd.host-context.v1' as const;

/** Host kinds that carry the unified submission context (matches
 * `PdMcpHost` in pd-mcp-server without importing it). */
export type HostSubmissionHostKind = 'codex' | 'openclaw' | 'workbuddy';

/**
 * The normalized trusted submission context. `sessionId` is required and
 * pre-validated (non-empty, bounded, non-sentinel); the turn/call ids are
 * optional — their absence never negates the session binding (SPEC §G2:
 * "submissionTurnId 缺失不能否定 Session 绑定").
 */
export interface HostSubmissionContext {
  readonly sessionId: string;
  readonly submissionTurnId?: string;
  readonly toolCallId?: string;
  readonly source: typeof HOST_SUBMISSION_CONTEXT_SOURCE;
}

export type HostSubmissionContextResolution =
  | { readonly status: 'present'; readonly context: HostSubmissionContext }
  /** No host metadata usable — the legal unbound path (receipt fallback). */
  | { readonly status: 'missing' }
  /**
   * Metadata was present but malformed (wrong shape / sentinel / unknown
   * fields). Fail closed: never silently degrade to a trusted identity and
   * never fall back to model parameters (SPEC TD §1.3 step 6).
   */
  | { readonly status: 'invalid'; readonly reasonCode: string };

/** Bounded host identifier check (1..200 chars, non-sentinel). */
function readHostId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return id.length > 0 && id.length <= 200 && !isSentinelSessionId(id) ? id : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate the optional turn/call ids inside `pd.host-context.v1`. */
function readOptionalContextIds(container: Record<string, unknown>): { submissionTurnId?: string; toolCallId?: string } {
  const submissionTurnId = Object.hasOwn(container, 'submissionTurnId')
    ? readHostId(container.submissionTurnId)
    : undefined;
  const toolCallId = Object.hasOwn(container, 'toolCallId')
    ? readHostId(container.toolCallId)
    : undefined;
  return {
    ...(submissionTurnId === undefined ? {} : { submissionTurnId }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
  };
}

/**
 * Codex normalization: native `_meta.threadId`/`_meta.sessionId` (threadId
 * preferred — it is the trajectory rollout identity), optional
 * `x-codex-turn-metadata.turn_id`. A present-but-malformed turn metadata
 * object is `invalid`, not silently ignored.
 */
function resolveCodexContext(meta: Readonly<Record<string, unknown>>): HostSubmissionContextResolution {
  // A PRESENT identity field is validated in place — present-but-unusable
  // (sentinel spelling, oversized, empty, wrong type) is `invalid`, NEVER a
  // silent fallback to the other field: `{threadId:'cli', sessionId:'ok'}`
  // is a half-broken identity, not a session-only one (P2 review round).
  let sessionId: string | undefined;
  if (Object.hasOwn(meta, 'threadId')) {
    sessionId = readHostId(meta.threadId);
    if (sessionId === undefined) {
      return { status: 'invalid', reasonCode: 'codex_thread_id_invalid' };
    }
  } else if (Object.hasOwn(meta, 'sessionId')) {
    sessionId = readHostId(meta.sessionId);
    if (sessionId === undefined) {
      return { status: 'invalid', reasonCode: 'codex_session_id_invalid' };
    }
  }
  if (sessionId === undefined) {
    // Metadata existed but carried no identity field value at all — invalid,
    // not missing: a half-present identity must never trigger the "no
    // metadata" fallback.
    return { status: 'invalid', reasonCode: 'codex_host_metadata_missing_session' };
  }
  let submissionTurnId: string | undefined;
  if (Object.hasOwn(meta, 'x-codex-turn-metadata')) {
    const turnMeta = meta['x-codex-turn-metadata'];
    if (!isRecord(turnMeta)) return { status: 'invalid', reasonCode: 'codex_turn_metadata_invalid' };
    if (Object.hasOwn(turnMeta, 'turn_id')) {
      submissionTurnId = readHostId(turnMeta.turn_id);
      if (submissionTurnId === undefined) {
        return { status: 'invalid', reasonCode: 'codex_submission_turn_invalid' };
      }
    }
  }
  return {
    status: 'present',
    context: {
      sessionId,
      ...(submissionTurnId === undefined ? {} : { submissionTurnId }),
      source: HOST_SUBMISSION_CONTEXT_SOURCE,
    },
  };
}

/**
 * Non-Codex normalization: `_meta["pd.host-context.v1"]` with the exact
 * allowed fields. Unknown extra fields make the whole context invalid (a
 * trusted host producer follows the contract; anything else is not one).
 */
function resolveNamespacedContext(meta: Readonly<Record<string, unknown>>): HostSubmissionContextResolution {
  const raw = meta[PD_HOST_CONTEXT_META_KEY];
  if (!isRecord(raw)) return { status: 'invalid', reasonCode: 'host_context_v1_invalid_shape' };
  const allowed = ['sessionId', 'submissionTurnId', 'toolCallId'] as const;
  for (const key of Object.keys(raw)) {
    if (!(allowed as readonly string[]).includes(key)) {
      return { status: 'invalid', reasonCode: 'host_context_v1_unknown_field' };
    }
  }
  const sessionId = readHostId(raw.sessionId);
  if (sessionId === undefined) return { status: 'invalid', reasonCode: 'host_context_v1_missing_session' };
  const optional = readOptionalContextIds(raw);
  // A PRESENT but malformed optional id fails closed (rc-3), it is not
  // silently dropped.
  if (Object.hasOwn(raw, 'submissionTurnId') && optional.submissionTurnId === undefined) {
    return { status: 'invalid', reasonCode: 'host_context_v1_turn_invalid' };
  }
  if (Object.hasOwn(raw, 'toolCallId') && optional.toolCallId === undefined) {
    return { status: 'invalid', reasonCode: 'host_context_v1_tool_call_invalid' };
  }
  return {
    status: 'present',
    context: { sessionId, ...optional, source: HOST_SUBMISSION_CONTEXT_SOURCE },
  };
}

/** The W3C baggage entry key the REAL WorkBuddy engine (CodeBuddy Code
 * 2.165.0, probe-verified 2026-11-24, scripts under `.pd-tmp/pri1275-probe`)
 * injects into `tools/call` `_meta` alongside `modelId`/`traceparent`/
 * `progressToken`: `baggage: "codebuddy.session_id=<uuid>,…"`. The value
 * equals the hook payload's `session_id` (cross-verified on the same run) —
 * a host-GENERATED identity field of the same trust tier as Codex's native
 * `threadId`. `codebuddy.conversation_request_id` is NOT mapped: its
 * equivalence to a PD submission turn is unproven (SPEC §G2 field rules). */
const WORKBUDDY_BAGGAGE_SESSION_PREFIX = 'codebuddy.session_id=';

/**
 * Read the engine-injected session identity from `_meta.baggage`:
 * `undefined` = the field is absent or carries no `codebuddy.session_id`
 * entry (NOT an identity attempt — unrelated baggage never gates anything);
 * `null` = the field is present as an identity attempt but malformed
 * (non-string baggage, or a session value failing the bounded-id check) —
 * fail closed like every other present-but-unusable identity.
 */
function readWorkbuddyBaggageSession(
  meta: Readonly<Record<string, unknown>>,
): string | undefined | null {
  if (!Object.hasOwn(meta, 'baggage')) return undefined;
  const raw = meta.baggage;
  if (typeof raw !== 'string') return null;
  for (const entry of raw.split(',')) {
    const item = entry.trim();
    if (!item.startsWith(WORKBUDDY_BAGGAGE_SESSION_PREFIX)) continue;
    // Baggage entries may carry `;key=value` properties after the value —
    // the session id itself ends at the first `;`.
    const withoutProps = item.slice(WORKBUDDY_BAGGAGE_SESSION_PREFIX.length).split(';', 1)[0] ?? '';
    const value = withoutProps.trim();
    return readHostId(value) ?? null;
  }
  return undefined;
}

/**
 * WorkBuddy normalization: the documented namespaced producer contract
 * (`pd.host-context.v1`, PRI-1275 pi-mono producers) AND the probe-verified
 * native engine field (`_meta.baggage` → `codebuddy.session_id`). The
 * namespaced key wins as the explicit contract; when both identity sources
 * are present they must AGREE — a disagreement between two host-generated
 * identities on one request is a half-broken identity, not a pick-one.
 */
function resolveWorkbuddyContext(meta: Readonly<Record<string, unknown>>): HostSubmissionContextResolution {
  const baggageSession = readWorkbuddyBaggageSession(meta);
  if (baggageSession === null) {
    return { status: 'invalid', reasonCode: 'workbuddy_baggage_session_invalid' };
  }
  if (!Object.hasOwn(meta, PD_HOST_CONTEXT_META_KEY)) {
    if (baggageSession === undefined) return { status: 'missing' };
    return {
      status: 'present',
      context: { sessionId: baggageSession, source: HOST_SUBMISSION_CONTEXT_SOURCE },
    };
  }
  const named = resolveNamespacedContext(meta);
  if (named.status !== 'present' || baggageSession === undefined) return named;
  if (named.context.sessionId !== baggageSession) {
    return { status: 'invalid', reasonCode: 'workbuddy_context_conflict' };
  }
  return named;
}

/**
 * Normalize host-injected `tools/call` `_meta` into a
 * {@link HostSubmissionContext}. `undefined` meta means the host attached no
 * metadata at all → `missing` (the receipt-fallback path). A meta object
 * without any recognized host field is ALSO `missing`: hosts legitimately
 * attach unrelated `_meta` (progress tokens etc.), and only recognized
 * identity fields gate the trusted path. A meta object WITH recognized
 * identity fields but malformed values is `invalid`.
 */
export function resolveHostSubmissionContext(
  host: HostSubmissionHostKind,
  meta: Readonly<Record<string, unknown>> | undefined,
): HostSubmissionContextResolution {
  if (meta === undefined) return { status: 'missing' };
  const hasCodexIdentity = Object.hasOwn(meta, 'threadId') || Object.hasOwn(meta, 'sessionId')
    || Object.hasOwn(meta, 'x-codex-turn-metadata');
  const hasNamespaced = Object.hasOwn(meta, PD_HOST_CONTEXT_META_KEY);
  if (host === 'codex') {
    if (!hasCodexIdentity && !hasNamespaced) return { status: 'missing' };
    // Codex is the native-field host; the namespaced key from a foreign
    // producer is not a Codex identity source — ignore it, use native fields.
    if (!hasCodexIdentity) return { status: 'missing' };
    return resolveCodexContext(meta);
  }
  if (!hasNamespaced && host !== 'workbuddy') return { status: 'missing' };
  return host === 'workbuddy' ? resolveWorkbuddyContext(meta) : resolveNamespacedContext(meta);
}

/**
 * Model-supplied `hostSession` claim vs trusted `_meta` context conflict
 * check (fail closed): the claim's own identifier candidates must either
 * agree with the trusted session or be absent. Never trusts the claim.
 */
export function hostSessionClaimConflictsWithContext(
  claim: { readonly threadId?: unknown; readonly sessionId?: unknown } | undefined,
  context: HostSubmissionContext,
): boolean {
  if (claim === undefined) return false;
  const candidates = [claim.threadId, claim.sessionId].filter((value): value is string =>
    typeof value === 'string' && value.trim().length > 0 && !isSentinelSessionId(value.trim()));
  if (candidates.length === 0) return false;
  // ANY usable claim candidate that disagrees with the trusted session is a
  // conflict: one matching value must never launder a second, foreign one
  // (`{threadId:'foreign', sessionId:'trusted'}` fails closed, P2 review).
  return candidates.some((value) => value !== context.sessionId);
}
