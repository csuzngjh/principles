/**
 * Pain Ingress shared invariants + persisted payload contract — PRI-642.
 *
 * This module is THE single source for:
 *  - the report field parsers (origin / correlation / evidence / score)
 *    shared by write-time evaluation and persisted-payload re-entry;
 *  - the origin/correlation invariant (`validateOriginCorrelationInvariant`)
 *    — the valid-combination rules of SPEC §8.2 that must never diverge
 *    between write time and re-entry;
 *  - the sentinel session constant (frozen decision #4);
 *  - the versioned `painIngress.v1` persisted namespace (SPEC §9) written
 *    by PainSignalBridge.buildDiagnosticJson beside the legacy top-level
 *    fields, and re-validated by executePendingDiagnosis / retry paths.
 *
 * INVARIANT EQUIVALENCE (review blocker 2): re-entry validation is NOT
 * weaker than write-time validation. parsePainIngressV1Payload shares the
 * field parsers and the invariant with evaluatePainIngress
 * (pain-ingress.ts), so every state illegal at write time — sentinel
 * session ids, empty "available" evidence, impossible origin/correlation
 * combinations — is also rejected on re-entry.
 *
 * Legacy compatibility (SPEC §9): payloads WITHOUT a painIngress.v1 block
 * keep the tolerant legacy normalization branch in pain-signal-bridge.ts;
 * this strictness applies only to payloads CLAIMING the v1 namespace.
 *
 * Pure module — no I/O. @principles/host-runtime and other adapters depend
 * on core; core depends on no adapter.
 */

import type { PainProvenance } from './admission-gate.js';
import { normalizePainProvenance } from './admission-gate.js';

export const PAIN_INGRESS_PAYLOAD_VERSION = 'v1';

// ── Report-level shared types (SPEC §8.1) ──────────────────────────────────

export type PainIngressOriginV1 =
  | {
      kind: 'owner_manual';
      channel: 'openclaw_command' | 'cli_explicit_session' | 'external_cli_unbound';
    }
  | { kind: 'automatic_hook'; source: string };

export type PainIngressCorrelationV1 =
  | { status: 'bound'; hostKind: 'openclaw'; sessionId: string; traceId?: string }
  | {
      status: 'bound';
      hostKind: 'codex';
      rootSessionId: string;
      rolloutIdentity: string;
      logicalObservationKey: string;
      hostTurnId: string;
      traceId?: string;
    }
  | { status: 'unbound'; reason: 'external_cli' | 'missing_host_session' };

export type PainIngressEvidenceClassV1 =
  | { status: 'available'; entryCount: number }
  | {
      status: 'unavailable';
      reason:
        | 'trajectory_unavailable'
        | 'session_not_found'
        | 'empty_trajectory'
        | 'evidence_read_failed'
        | 'evidence_invalid'
        /** Unbound Owner reports never consult a trajectory — no evidence is sought. */
        | 'not_applicable_unbound';
    };

export type PainEvidenceUnavailableReason =
  | 'trajectory_unavailable'
  | 'session_not_found'
  | 'empty_trajectory'
  | 'evidence_read_failed'
  | 'evidence_invalid'
  /** Unbound Owner reports never consult a trajectory — no evidence is sought. */
  | 'not_applicable_unbound';

export interface IngressEvidenceEntry {
  kind: 'behavior_trace' | 'system_event';
  sourceRef: string;
  note: string;
}

export type PainEvidenceBundle =
  | { status: 'available'; entries: readonly [IngressEvidenceEntry, ...IngressEvidenceEntry[]] }
  | { status: 'unavailable'; reason: PainEvidenceUnavailableReason };

export type PainOrigin = PainIngressOriginV1;
export type PainCorrelation = PainIngressCorrelationV1;

export interface PainIngressReport {
  identity:
    | { kind: 'manual_pain_id'; painId: string }
    | { kind: 'host_observation'; observationId: string };
  painType: 'tool_failure' | 'subagent_error' | 'user_frustration';
  source: string;
  reason: string;
  score?: number;
  origin: PainOrigin;
  correlation: PainCorrelation;
  evidence: PainEvidenceBundle;
}

// ── Shared invariants and parsers (ONE implementation for write time AND
//    re-entry) ───────────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwnString(obj: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(obj, key) && typeof obj[key] === 'string' && (obj[key]).length > 0;
}

/**
 * Sentinel session ids are never real correlations (frozen decision #4).
 * Import this constant instead of re-declaring the set in another module.
 */
export const SENTINEL_SESSION_IDS: ReadonlySet<string> = new Set(['cli', 'unknown']);

export function isSentinelSessionId(value: string): boolean {
  return SENTINEL_SESSION_IDS.has(value);
}

export function parseOrigin(value: unknown): PainOrigin | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'owner_manual') {
    const {channel} = value;
    if (channel === 'openclaw_command' || channel === 'cli_explicit_session' || channel === 'external_cli_unbound') {
      return { kind: 'owner_manual', channel };
    }
    return null;
  }
  if (value.kind === 'automatic_hook' && typeof value.source === 'string' && value.source.length > 0) {
    return { kind: 'automatic_hook', source: value.source };
  }
  return null;
}

/**
 * THE correlation parser — used by report validation (write time) and the
 * persisted-payload validator (re-entry) so sentinel rejection and lineage
 * completeness cannot drift between the two.
 */
export function parseCorrelation(value: unknown): { value: PainCorrelation; error?: undefined } | { value?: undefined; error: string } {
  if (!isRecord(value)) return { error: 'correlation_invalid' };
  if (value.status === 'unbound') {
    if (value.reason === 'external_cli' || value.reason === 'missing_host_session') {
      return { value: { status: 'unbound', reason: value.reason } };
    }
    return { error: 'correlation_invalid' };
  }
  if (value.status !== 'bound') return { error: 'correlation_invalid' };
  if (value.hostKind === 'openclaw') {
    if (!hasOwnString(value, 'sessionId')) return { error: 'correlation_invalid' };
    if (isSentinelSessionId(value.sessionId as string)) return { error: 'session_sentinel_invalid' };
    const correlation: PainCorrelation = { status: 'bound', hostKind: 'openclaw', sessionId: value.sessionId as string };
    if (typeof value.traceId === 'string') correlation.traceId = value.traceId;
    return { value: correlation };
  }
  if (value.hostKind === 'codex') {
    if (!hasOwnString(value, 'rootSessionId')) return { error: 'codex_lineage_incomplete' };
    if (!hasOwnString(value, 'rolloutIdentity')) return { error: 'codex_lineage_incomplete' };
    if (!hasOwnString(value, 'logicalObservationKey')) return { error: 'codex_lineage_incomplete' };
    if (!hasOwnString(value, 'hostTurnId')) return { error: 'codex_lineage_incomplete' };
    const correlation: PainCorrelation = {
      status: 'bound',
      hostKind: 'codex',
      rootSessionId: value.rootSessionId as string,
      rolloutIdentity: value.rolloutIdentity as string,
      logicalObservationKey: value.logicalObservationKey as string,
      hostTurnId: value.hostTurnId as string,
    };
    if (typeof value.traceId === 'string') correlation.traceId = value.traceId;
    return { value: correlation };
  }
  return { error: 'correlation_invalid' };
}

const EVIDENCE_UNAVAILABLE_REASONS = [
  'trajectory_unavailable',
  'session_not_found',
  'empty_trajectory',
  'evidence_read_failed',
  'evidence_invalid',
  'not_applicable_unbound',
] as const;

type EvidenceUnavailableReason = (typeof EVIDENCE_UNAVAILABLE_REASONS)[number];

function isEvidenceUnavailableReason(value: unknown): value is EvidenceUnavailableReason {
  return (EVIDENCE_UNAVAILABLE_REASONS as readonly unknown[]).includes(value);
}

export function parseEvidence(value: unknown): { value: PainEvidenceBundle; error?: undefined } | { value?: undefined; error: string } {
  if (!isRecord(value)) return { error: 'evidence_invalid' };
  if (value.status === 'available') {
    if (!Array.isArray(value.entries) || value.entries.length === 0) return { error: 'evidence_invalid' };
    const entries: IngressEvidenceEntry[] = [];
    for (const entry of value.entries) {
      if (!isRecord(entry)) return { error: 'evidence_invalid' };
      if (entry.kind !== 'behavior_trace' && entry.kind !== 'system_event') return { error: 'evidence_invalid' };
      if (typeof entry.sourceRef !== 'string' || entry.sourceRef.length === 0) return { error: 'evidence_invalid' };
      if (typeof entry.note !== 'string') return { error: 'evidence_invalid' };
      entries.push({ kind: entry.kind, sourceRef: entry.sourceRef, note: entry.note });
    }
    return { value: { status: 'available', entries: entries as [IngressEvidenceEntry, ...IngressEvidenceEntry[]] } };
  }
  const reasons = EVIDENCE_UNAVAILABLE_REASONS;
  if (value.status === 'unavailable' && (reasons as readonly unknown[]).includes(value.reason)) {
    return { value: { status: 'unavailable', reason: value.reason as EvidenceUnavailableReason } };
  }
  return { error: 'evidence_invalid' };
}

/** rc-3/rc-9: a present-but-invalid score is rejected, not silently dropped. */
export function parseScore(value: unknown): { score: number | undefined; scoreInvalid?: undefined } | { score: undefined; scoreInvalid: true } {
  if (value === undefined) return { score: undefined };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    return { score: undefined, scoreInvalid: true };
  }
  return { score: value };
}

export type PainIngressParseResult =
  | { ok: true; report: PainIngressReport }
  | { ok: false; reasonCode: string; message: string };

/**
 * Validate an untrusted report (parsed JSON / host payload) into a typed
 * PainIngressReport. Fails loud with a structured reasonCode (rc-3); uses
 * the SAME field parsers and invariant as the persisted-payload validator
 * (rc-1/rc-2/rc-3/rc-4).
 */
export function parsePainIngressReport(input: unknown): PainIngressParseResult {
  if (!isRecord(input)) {
    return { ok: false, reasonCode: 'report_invalid', message: 'ingress report must be an object' };
  }
  if (!isRecord(input.identity)) return { ok: false, reasonCode: 'identity_invalid', message: 'identity must be an object' };
  if (input.identity.kind === 'manual_pain_id') {
    if (!hasOwnString(input.identity, 'painId')) return { ok: false, reasonCode: 'identity_invalid', message: 'manual_pain_id requires painId' };
  } else if (input.identity.kind === 'host_observation') {
    if (!hasOwnString(input.identity, 'observationId')) return { ok: false, reasonCode: 'identity_invalid', message: 'host_observation requires observationId' };
  } else {
    return { ok: false, reasonCode: 'identity_invalid', message: 'identity.kind must be manual_pain_id or host_observation' };
  }

  const painTypes = ['tool_failure', 'subagent_error', 'user_frustration'] as const;
  if (!(painTypes as readonly unknown[]).includes(input.painType)) {
    return { ok: false, reasonCode: 'pain_type_invalid', message: 'painType must be tool_failure | subagent_error | user_frustration' };
  }
  if (!hasOwnString(input, 'source')) return { ok: false, reasonCode: 'source_invalid', message: 'source is required' };
  if (!hasOwnString(input, 'reason')) return { ok: false, reasonCode: 'reason_invalid', message: 'reason is required' };

  const origin = parseOrigin(input.origin);
  if (origin === null) return { ok: false, reasonCode: 'origin_invalid', message: 'origin must be owner_manual{channel} or automatic_hook{source}' };

  const correlation = parseCorrelation(input.correlation);
  if (correlation.error !== undefined) {
    return { ok: false, reasonCode: correlation.error, message: `correlation rejected: ${correlation.error}` };
  }

  const evidence = parseEvidence(input.evidence);
  if (evidence.error !== undefined) {
    return { ok: false, reasonCode: evidence.error, message: `evidence rejected: ${evidence.error}` };
  }

  // rc-3/rc-9: a present-but-invalid score is rejected, not silently dropped.
  const { score, scoreInvalid } = parseScore(input.score);
  if (scoreInvalid) {
    return { ok: false, reasonCode: 'score_invalid', message: 'score must be a number between 0 and 100' };
  }

  return {
    ok: true,
    report: {
      identity: input.identity as PainIngressReport['identity'],
      painType: input.painType as PainIngressReport['painType'],
      source: input.source as string,
      reason: input.reason as string,
      score,
      origin,
      correlation: correlation.value,
      evidence: evidence.value,
    },
  };
}

/**
 * Origin/correlation combinations the matrix (SPEC §8.2) declares invalid.
 * Shared by evaluatePainIngress (write time) and parsePainIngressV1Payload
 * (re-entry) so an illegal state can never become legal across a
 * persistence round trip. Returns a reasonCode string when invalid, null
 * when the combination is valid.
 */
export function validateOriginCorrelationInvariant(
  origin: PainOrigin,
  correlation: PainCorrelation,
): string | null {
  if (origin.kind !== 'owner_manual') return null;
  if (origin.channel === 'external_cli_unbound' && correlation.status === 'bound') {
    return 'origin_correlation_mismatch';
  }
  if (origin.channel === 'cli_explicit_session' && correlation.status === 'unbound') {
    return 'origin_correlation_mismatch';
  }
  return null;
}

// ── Persisted painIngress.v1 namespace (SPEC §9) ───────────────────────────

/**
 * The persisted v1 block. Evidence ENTRIES are intentionally not duplicated
 * here — they remain in the legacy top-level `evidence` field; this block
 * records their validated classification only (SPEC §9: one versioned
 * namespace for the rev-2 facts, legacy fields stay authoritative for
 * their own consumers).
 */
export interface PainIngressV1Payload {
  version: typeof PAIN_INGRESS_PAYLOAD_VERSION;
  origin: PainIngressOriginV1;
  correlation: PainIngressCorrelationV1;
  evidenceClass: PainIngressEvidenceClassV1;
}

export type PainIngressV1ParseResult =
  | { ok: true; payload: PainIngressV1Payload }
  | { ok: false; reasonCode: string };

/**
 * Persisted mirror of the write-time evidence bundle classification
 * (PainEvidenceBundle). `available` requires entryCount >= 1 — the same
 * invariant the write-time bundle enforces (a non-empty entries tuple), so
 * an "available with zero entries" state can never pass here.
 */
function parseEvidenceClass(value: unknown): PainIngressEvidenceClassV1 | null {
  if (!isRecord(value)) return null;
  if (value.status === 'available') {
    if (Object.hasOwn(value, 'entryCount') && typeof value.entryCount === 'number' && Number.isInteger(value.entryCount) && value.entryCount >= 1) {
      return { status: 'available', entryCount: value.entryCount };
    }
    return null;
  }
  if (value.status === 'unavailable' && isEvidenceUnavailableReason(value.reason)) {
    return { status: 'unavailable', reason: value.reason };
  }
  return null;
}

/**
 * Runtime validation of an untrusted persisted painIngress block
 * (rc-1/rc-2/rc-3). Shares parseOrigin/parseCorrelation and the
 * origin/correlation invariant with the write-time evaluator, so sentinel
 * sessions, incomplete Codex lineage and impossible combinations are
 * rejected identically at write time and on re-entry.
 */
export function parsePainIngressV1Payload(value: unknown): PainIngressV1ParseResult {
  if (!isRecord(value)) return { ok: false, reasonCode: 'ingress_payload_invalid' };
  if (value.version !== PAIN_INGRESS_PAYLOAD_VERSION) return { ok: false, reasonCode: 'ingress_payload_version_unsupported' };
  const origin = parseOrigin(value.origin);
  if (origin === null) return { ok: false, reasonCode: 'ingress_origin_invalid' };
  const correlation = parseCorrelation(value.correlation);
  if (correlation.error !== undefined) return { ok: false, reasonCode: correlation.error };
  const evidenceClass = parseEvidenceClass(value.evidenceClass);
  if (evidenceClass === null) return { ok: false, reasonCode: 'ingress_evidence_class_invalid' };
  const invariantViolation = validateOriginCorrelationInvariant(origin, correlation.value);
  if (invariantViolation !== null) return { ok: false, reasonCode: invariantViolation };
  return { ok: true, payload: { version: PAIN_INGRESS_PAYLOAD_VERSION, origin, correlation: correlation.value, evidenceClass } };
}

/**
 * Derive the legacy provenance from validated rev-2 facts (SPEC §8.3).
 * Adapters do not supply provenance independently; this is the one
 * derivation shared by writers and re-entry validation.
 */
export function deriveProvenanceFromIngressFacts(
  origin: PainIngressOriginV1,
  correlation: PainIngressCorrelationV1,
): PainProvenance {
  if (origin.kind === 'automatic_hook') return 'automatic_hook';
  if (correlation.status === 'bound') return 'host_context_bound';
  return 'owner_reported_no_host_trace';
}

/**
 * Re-entry consistency check between the nested v1 block and the legacy
 * top-level fields produced by the same builder (SPEC §9, §12.2.4).
 * Returns null when consistent; a reasonCode string otherwise.
 */
export function checkIngressTopLevelConsistency(input: {
  payload: PainIngressV1Payload;
  topLevelProvenance: unknown;
  topLevelSessionIdHint: unknown;
  topLevelEvidenceCount: number;
}): string | null {
  const { payload, topLevelProvenance, topLevelSessionIdHint, topLevelEvidenceCount } = input;

  const expectedProvenance = deriveProvenanceFromIngressFacts(payload.origin, payload.correlation);
  const actualProvenance = typeof topLevelProvenance === 'string' ? normalizePainProvenance(topLevelProvenance) : undefined;
  if (actualProvenance !== expectedProvenance) {
    return 'ingress_payload_mismatch:provenance';
  }

  if (payload.correlation.status === 'bound' && payload.correlation.hostKind === 'openclaw') {
    if (topLevelSessionIdHint !== payload.correlation.sessionId) {
      return 'ingress_payload_mismatch:session';
    }
  }

  if (payload.evidenceClass.status === 'available') {
    if (payload.evidenceClass.entryCount !== topLevelEvidenceCount) {
      return 'ingress_payload_mismatch:evidence_count';
    }
  }

  return null;
}
