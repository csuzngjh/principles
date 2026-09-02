/**
 * Pain Evidence Ingress — PRI-642 SPEC §8.
 *
 * THIN RE-EXPORT: the ingress semantic authority lives in
 * `@principles/core/runtime-v2` (pain-ingress.ts + pain-ingress-payload.ts)
 * so that EVERY adapter — OpenClaw funnel, pd-cli, and future hosts —
 * evaluates pain ingress facts through ONE implementation. Host adapters
 * differ only in acquisition (session/trajectory/evidence I/O); the
 * interpretation of those facts has a single home in core.
 *
 * This module keeps the existing `@principles/host-runtime` import surface
 * stable for adapters that already import from here. It adds nothing
 * semantic of its own.
 */
export {
  evaluatePainIngress,
  parsePainIngressReport,
  validateOriginCorrelationInvariant,
  SENTINEL_SESSION_IDS,
  isSentinelSessionId,
} from '@principles/core/runtime-v2';
export type {
  PainIngressReport,
  PainIngressDecision,
  PainIngressParseResult,
  LegacyPainSubmission,
  PainOrigin,
  PainCorrelation,
  IngressEvidenceEntry,
  PainEvidenceBundle,
  PainEvidenceUnavailableReason,
  PainIngressV1Payload,
} from '@principles/core/runtime-v2';
