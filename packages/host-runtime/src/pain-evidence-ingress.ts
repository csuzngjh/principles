/**
 * Pain Evidence Ingress — PRI-642 SPEC §8.
 *
 * One shared, host-neutral gate for every pain emitter. It validates the
 * origin, host-context correlation and evidence of a report BEFORE any LLM
 * execution or persistence, derives the legacy payload values (adapters no
 * longer assemble provenance themselves, SPEC §8.3), and classifies the
 * decision for the valid-combination matrix (SPEC §8.2).
 *
 * Boundary (SPEC §6): the ingress mints no canonical identity and owns no
 * task store — manual pain ids pass through validated; automatic canonical
 * identity stays with the existing identity/admission owners (Codex lineage
 * is never flattened to a session id).
 */
import {
  PAIN_INGRESS_PAYLOAD_VERSION,
  deriveProvenanceFromIngressFacts,
} from '@principles/core/runtime-v2';
import type {
  PainIngressV1Payload,
  PainIngressOriginV1,
  PainIngressCorrelationV1,
  PainIngressEvidenceClassV1,
} from '@principles/core/runtime-v2';

// ── Report types (SPEC §8.1; semantic shape normative) ─────────────────────

export type PainOrigin = PainIngressOriginV1;
export type PainCorrelation = PainIngressCorrelationV1;

export interface IngressEvidenceEntry {
  kind: 'behavior_trace' | 'system_event';
  sourceRef: string;
  note: string;
}

export type PainEvidenceUnavailableReason =
  | 'trajectory_unavailable'
  | 'session_not_found'
  | 'empty_trajectory'
  | 'evidence_read_failed'
  | 'evidence_invalid'
  | 'not_applicable_unbound';

export type PainEvidenceBundle =
  | { status: 'available'; entries: readonly [IngressEvidenceEntry, ...IngressEvidenceEntry[]] }
  | { status: 'unavailable'; reason: PainEvidenceUnavailableReason };

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

// ── Decision types ─────────────────────────────────────────────────────────

/**
 * The legacy write-side shape handed to PainToPrincipleService. Derived by
 * the ingress — callers do not assemble provenance/evidence themselves.
 */
export interface LegacyPainSubmission {
  painId: string;
  painType: PainIngressReport['painType'];
  source: string;
  reason: string;
  score?: number;
  sessionId?: string;
  agentId?: string;
  traceId?: string;
  provenance: 'host_context_bound' | 'owner_reported_no_host_trace' | 'automatic_hook';
  hostKind?: 'openclaw' | 'codex';
  evidence: IngressEvidenceEntry[];
  /** Versioned rev-2 facts persisted beside the legacy top-level fields. */
  painIngress: PainIngressV1Payload;
}

export type PainIngressDecision =
  | { action: 'submit'; legacy: LegacyPainSubmission; painIngress: PainIngressV1Payload; warnings: string[]; reasonCode?: undefined }
  | {
      /** Explicit degradation: submission is still allowed (honest empty evidence + warning). */
      action: 'degrade';
      reasonCode: string;
      warning: string;
      nextAction: string;
      legacy: LegacyPainSubmission;
      painIngress: PainIngressV1Payload;
    }
  | { action: 'refuse'; reasonCode: string; warning: string; nextAction: string }
  | {
      /**
       * Automatic signal without binding/evidence — no LLM, no diagnostic
       * task. `legacy` still carries the derived (empty-evidence) submission
       * shape so host funnels can keep their observability projection via
       * the bridge's empty-evidence short-circuit (SPEC §12.2.1/§12.2.2).
       */
      action: 'observation_only';
      reasonCode: string;
      note: string;
      legacy: LegacyPainSubmission;
      painIngress: PainIngressV1Payload;
    };

export type PainIngressParseResult =
  | { ok: true; report: PainIngressReport }
  | { ok: false; reasonCode: string; message: string };

// ── Runtime validation of untrusted input (rc-1/rc-2/rc-3/rc-4) ────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwnString(obj: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(obj, key) && typeof obj[key] === 'string' && (obj[key]).length > 0;
}

const SENTINEL_SESSION_IDS = new Set(['cli', 'unknown']);

function parseOrigin(value: unknown): PainOrigin | null {
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

function parseCorrelation(value: unknown): { value: PainCorrelation; error?: undefined } | { value?: undefined; error: string } {
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
    if (SENTINEL_SESSION_IDS.has(value.sessionId as string)) return { error: 'session_sentinel_invalid' };
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

function parseEvidence(value: unknown): { value: PainEvidenceBundle; error?: undefined } | { value?: undefined; error: string } {
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
  const reasons = ['trajectory_unavailable', 'session_not_found', 'empty_trajectory', 'evidence_read_failed', 'evidence_invalid', 'not_applicable_unbound'] as const;
  if (value.status === 'unavailable' && (reasons as readonly unknown[]).includes(value.reason)) {
    return { value: { status: 'unavailable', reason: value.reason as (typeof reasons)[number] } };
  }
  return { error: 'evidence_invalid' };
}

/**
 * Validate an untrusted report (parsed JSON / host payload) into a typed
 * PainIngressReport. Fails loud with a structured reasonCode (rc-3); sentinel
 * sessions are rejected as real sessions (frozen decision #4).
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

  const score = input.score === undefined ? undefined : (typeof input.score === 'number' && input.score >= 0 && input.score <= 100 ? input.score : undefined);

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

// ── Evaluation (SPEC §8.2 valid-combination matrix) ────────────────────────

/**
 * rc-6 lineage consistency: the Codex logical observation key embeds the
 * rollout identity (`codex|<rolloutIdentity>|<turnId>|<kind>`) — identifiers
 * from different events must be rejected, not averaged into one report.
 */
function isCodexLineageConsistent(correlation: PainCorrelation): boolean {
  if (correlation.status !== 'bound' || correlation.hostKind !== 'codex') return true;
  const prefix = `codex|${correlation.rolloutIdentity}|`;
  return correlation.logicalObservationKey.startsWith(prefix);
}

function buildV1Payload(report: PainIngressReport): PainIngressV1Payload {
  const evidenceClass: PainIngressEvidenceClassV1 = report.evidence.status === 'available'
    ? { status: 'available', entryCount: report.evidence.entries.length }
    : { status: 'unavailable', reason: report.evidence.reason };
  return {
    version: PAIN_INGRESS_PAYLOAD_VERSION,
    origin: report.origin,
    correlation: report.correlation,
    evidenceClass,
  };
}

function buildLegacy(report: PainIngressReport, evidence: IngressEvidenceEntry[]): LegacyPainSubmission {
  const provenance = deriveProvenanceFromIngressFacts(report.origin, report.correlation);
  const legacy: LegacyPainSubmission = {
    painId: report.identity.kind === 'manual_pain_id' ? report.identity.painId : report.identity.observationId,
    painType: report.painType,
    source: report.source,
    reason: report.reason,
    score: report.score,
    provenance,
    evidence,
    painIngress: buildV1Payload(report),
  };
  if (report.correlation.status === 'bound') {
    legacy.hostKind = report.correlation.hostKind;
    if (report.correlation.hostKind === 'openclaw') {
      legacy.sessionId = report.correlation.sessionId;
    } else {
      // Parity with the existing Codex admission path (it passes the root
      // session as the legacy sessionId); the FULL unflattened lineage
      // (rolloutIdentity / logicalObservationKey / hostTurnId) is retained
      // in the versioned painIngress payload (frozen decision #8).
      legacy.sessionId = report.correlation.rootSessionId;
    }
    if (report.correlation.traceId !== undefined) legacy.traceId = report.correlation.traceId;
  }
  return legacy;
}

/**
 * Decide the pre-LLM action for a validated report, per SPEC §8.2. Pure —
 * no I/O, no persistence, no identity minting.
 */
export function evaluatePainIngress(report: PainIngressReport): PainIngressDecision {
  const { origin, correlation, evidence } = report;

  // rc-6: lineage identifiers must come from one consistent event.
  if (!isCodexLineageConsistent(correlation)) {
    return {
      action: 'refuse',
      reasonCode: 'lineage_mismatch',
      warning: 'Lineage identifiers disagree (logical observation key does not embed the rollout identity).',
      nextAction: 'Re-emit the observation from the event that owns the full lineage tuple.',
    };
  }

  // Row 7 / row 5: an unbound-channel report may never claim host binding,
  // and an explicit-session channel may never be unbound.
  if (origin.kind === 'owner_manual' && origin.channel === 'external_cli_unbound' && correlation.status === 'bound') {
    return {
      action: 'refuse',
      reasonCode: 'origin_correlation_mismatch',
      warning: 'An external unbound Owner report cannot claim a host-bound correlation.',
      nextAction: 'Record via /pd-pain or pd pain record --session for a bound report, or keep the report unbound.',
    };
  }
  if (origin.kind === 'owner_manual' && origin.channel === 'cli_explicit_session' && correlation.status === 'unbound') {
    return {
      action: 'refuse',
      reasonCode: 'origin_correlation_mismatch',
      warning: 'An explicit-session report arrived without a bound session.',
      nextAction: 'Supply a validated --session, or record an unbound Owner report explicitly.',
    };
  }

  // Automatic hooks: no evidence or no binding → observation-only, no LLM.
  if (origin.kind === 'automatic_hook') {
    if (correlation.status === 'unbound') {
      const legacy = buildLegacy(report, []);
      return {
        action: 'observation_only',
        reasonCode: correlation.reason,
        note: 'Automatic signal without host binding recorded as observation only; no diagnostic task, no LLM run.',
        legacy,
        painIngress: legacy.painIngress,
      };
    }
    if (evidence.status === 'unavailable') {
      const legacy = buildLegacy(report, []);
      return {
        action: 'observation_only',
        reasonCode: evidence.reason,
        note: 'Automatic signal without usable evidence recorded as observation only; no diagnostic task, no LLM run.',
        legacy,
        painIngress: legacy.painIngress,
      };
    }
    const legacy = buildLegacy(report, [...evidence.entries]);
    return { action: 'submit', legacy, painIngress: legacy.painIngress, warnings: [] };
  }

  // Owner manual, bound (openclaw_command / cli_explicit_session).
  if (correlation.status === 'bound') {
    if (evidence.status === 'available') {
      const legacy = buildLegacy(report, [...evidence.entries]);
      return { action: 'submit', legacy, painIngress: legacy.painIngress, warnings: [] };
    }
    const legacy = buildLegacy(report, []);
    return {
      action: 'degrade',
      reasonCode: evidence.reason,
      warning: `Session bound, but trajectory evidence is unavailable (${evidence.reason}); the report is submitted with honest empty evidence and candidates may be gated by the admission threshold.`,
      nextAction: 'Verify the session has recorded turns/tool calls, or re-record when evidence exists.',
      legacy,
      painIngress: legacy.painIngress,
    };
  }

  // Row 6: external unbound Owner report — manual exception with disclosure.
  const legacy = buildLegacy(report, []);
  return {
    action: 'submit',
    legacy,
    painIngress: legacy.painIngress,
    warnings: [
      'context_unbound: no session bound — no trajectory evidence attached; candidates will likely be blocked by the admission gate. Re-run with --session <id> for trace-backed diagnosis.',
    ],
  };
}
