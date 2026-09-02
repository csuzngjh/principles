/**
 * Pain Ingress semantic evaluator — PRI-642 SPEC §8. THE single authority
 * for pain ingress semantics across every adapter (OpenClaw funnel, pd-cli,
 * future hosts):
 *
 *   origin classification · bound/unbound correlation semantics ·
 *   provenance derivation · sentinel handling ·
 *   submit / degrade / refuse / observation_only decisions ·
 *   painIngress.v1 construction rules
 *
 * Host adapters differ only in ACQUISITION (how they obtain the session,
 * read the trajectory, and build raw evidence); they MUST NOT re-implement
 * the interpretation. Adapters build a PainIngressReport from their
 * host-specific facts and call evaluatePainIngress.
 *
 * The field parsers, the sentinel constant, the origin/correlation
 * invariant and parsePainIngressReport live in pain-ingress-payload.ts and
 * are shared with the persisted-payload validator (re-entry) — one
 * implementation, no drift.
 *
 * Pure module — no I/O, no persistence, no identity minting (SPEC §6: the
 * ingress mints no canonical identity and owns no task store).
 */
import { deriveProvenanceFromIngressFacts } from './pain-ingress-payload.js';
import { PAIN_INGRESS_PAYLOAD_VERSION } from './pain-ingress-payload.js';
import { validateOriginCorrelationInvariant } from './pain-ingress-payload.js';
import type {
  PainIngressV1Payload,
  PainIngressReport,
  PainCorrelation,
  IngressEvidenceEntry,
} from './pain-ingress-payload.js';
import type { PainProvenance } from './admission-gate.js';

// Single public surface: re-export the shared parsers/invariants so
// adapters can import the whole ingress family from this module.
export {
  SENTINEL_SESSION_IDS,
  isSentinelSessionId,
  parsePainIngressReport,
  validateOriginCorrelationInvariant,
} from './pain-ingress-payload.js';
export type {
  PainOrigin,
  PainCorrelation,
  IngressEvidenceEntry,
  PainEvidenceBundle,
  PainEvidenceUnavailableReason,
  PainIngressReport,
  PainIngressParseResult,
  PainIngressV1Payload,
} from './pain-ingress-payload.js';

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
  provenance: PainProvenance;
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
  const evidenceClass = report.evidence.status === 'available'
    ? { status: 'available' as const, entryCount: report.evidence.entries.length }
    : { status: 'unavailable' as const, reason: report.evidence.reason };
  return {
    version: PAIN_INGRESS_PAYLOAD_VERSION,
    origin: report.origin,
    correlation: report.correlation,
    evidenceClass,
  };
}

function buildLegacy(report: PainIngressReport, evidence: IngressEvidenceEntry[]): LegacyPainSubmission {
  const provenance: PainProvenance = deriveProvenanceFromIngressFacts(report.origin, report.correlation);
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
  // and an explicit-session channel may never be unbound (shared invariant
  // also enforced by the persisted-payload validator on re-entry).
  const invariantViolation = validateOriginCorrelationInvariant(origin, correlation);
  if (invariantViolation !== null) {
    return {
      action: 'refuse',
      reasonCode: invariantViolation,
      warning:
        origin.kind === 'owner_manual' && origin.channel === 'external_cli_unbound'
          ? 'An external unbound Owner report cannot claim a host-bound correlation.'
          : 'An explicit-session report arrived without a bound session.',
      nextAction: 'Record via /pd-pain or pd pain record --session for a bound report, or keep the report unbound.',
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
