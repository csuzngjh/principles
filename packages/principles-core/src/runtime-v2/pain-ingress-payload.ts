/**
 * Pain Ingress persisted payload contract — PRI-642 SPEC §9.
 *
 * The versioned `painIngress.v1` namespace written into the diagnostic
 * task payload alongside the legacy top-level fields. The canonical types
 * and validators live here (principles-core) because BOTH sides of the
 * contract are core-owned:
 *  - PainSignalBridge.buildDiagnosticJson writes the nested block together
 *    with the legacy top-level fields from one builder;
 *  - executePendingDiagnosis / retry paths re-validate the persisted block
 *    on re-entry (no host-binding defaults, nested/top-level mismatch
 *    rejection).
 *
 * @principles/host-runtime's shared ingress produces these payloads; it
 * depends on core, never the reverse.
 */

import type { PainProvenance } from './admission-gate.js';
import { normalizePainProvenance } from './admission-gate.js';

export const PAIN_INGRESS_PAYLOAD_VERSION = 'v1';

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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwnString(obj: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(obj, key) && typeof obj[key] === 'string' && (obj[key]).length > 0;
}

function parseOrigin(value: unknown): PainIngressOriginV1 | null {
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

function parseCorrelation(value: unknown): PainIngressCorrelationV1 | null {
  if (!isRecord(value)) return null;
  if (value.status === 'unbound') {
    if (value.reason === 'external_cli' || value.reason === 'missing_host_session') {
      return { status: 'unbound', reason: value.reason };
    }
    return null;
  }
  if (value.status !== 'bound') return null;
  if (value.hostKind === 'openclaw') {
    if (!hasOwnString(value, 'sessionId')) return null;
    const correlation: PainIngressCorrelationV1 = { status: 'bound', hostKind: 'openclaw', sessionId: value.sessionId as string };
    if (Object.hasOwn(value, 'traceId') && typeof value.traceId === 'string') correlation.traceId = value.traceId;
    return correlation;
  }
  if (value.hostKind === 'codex') {
    if (!hasOwnString(value, 'rootSessionId')) return null;
    if (!hasOwnString(value, 'rolloutIdentity')) return null;
    if (!hasOwnString(value, 'logicalObservationKey')) return null;
    if (!hasOwnString(value, 'hostTurnId')) return null;
    const correlation: PainIngressCorrelationV1 = {
      status: 'bound',
      hostKind: 'codex',
      rootSessionId: value.rootSessionId as string,
      rolloutIdentity: value.rolloutIdentity as string,
      logicalObservationKey: value.logicalObservationKey as string,
      hostTurnId: value.hostTurnId as string,
    };
    if (Object.hasOwn(value, 'traceId') && typeof value.traceId === 'string') correlation.traceId = value.traceId;
    return correlation;
  }
  return null;
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

function parseEvidenceClass(value: unknown): PainIngressEvidenceClassV1 | null {
  if (!isRecord(value)) return null;
  if (value.status === 'available') {
    if (Object.hasOwn(value, 'entryCount') && typeof value.entryCount === 'number' && Number.isInteger(value.entryCount) && value.entryCount >= 0) {
      return { status: 'available', entryCount: value.entryCount };
    }
    return null;
  }
  if (value.status === 'unavailable' && isEvidenceUnavailableReason(value.reason)) {
    return { status: 'unavailable', reason: value.reason };
  }
  return null;
}

/** Runtime validation of an untrusted persisted painIngress block (rc-1/rc-2/rc-3). */
export function parsePainIngressV1Payload(value: unknown): PainIngressV1ParseResult {
  if (!isRecord(value)) return { ok: false, reasonCode: 'ingress_payload_invalid' };
  if (value.version !== PAIN_INGRESS_PAYLOAD_VERSION) return { ok: false, reasonCode: 'ingress_payload_version_unsupported' };
  const origin = parseOrigin(value.origin);
  if (origin === null) return { ok: false, reasonCode: 'ingress_origin_invalid' };
  const correlation = parseCorrelation(value.correlation);
  if (correlation === null) return { ok: false, reasonCode: 'ingress_correlation_invalid' };
  const evidenceClass = parseEvidenceClass(value.evidenceClass);
  if (evidenceClass === null) return { ok: false, reasonCode: 'ingress_evidence_class_invalid' };
  return { ok: true, payload: { version: PAIN_INGRESS_PAYLOAD_VERSION, origin, correlation, evidenceClass } };
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
