import type { PromotionEvidenceSnapshot, PromotionFailedCheck, PromotionReadinessResult } from './rulecode-owner-decision-service.js';

export const REQUIRED_PROMOTION_CHECK_IDS = [
  'activation_eligibility', 'lineage_binding', 'bounded_scope', 'production_compile_load',
  'golden_trace', 'runtime_compatibility', 'host_liveness_composition', 'emergency_controls',
  'runtime_shadow_evidence', 'owner_identity_configuration',
] as const;

export type PromotionCheckId = typeof REQUIRED_PROMOTION_CHECK_IDS[number];
export interface PromotionReadinessCheck {
  checkId: PromotionCheckId;
  status: 'passed' | 'failed';
  reasonCode?: string;
}
export interface PromotionReadinessEvaluationInput {
  evaluationId: string;
  artifactId: string;
  artifactDigest: string;
  evidenceSnapshot: PromotionEvidenceSnapshot;
  checks: readonly PromotionReadinessCheck[];
}

export function evaluateRuleCodePromotionReadiness(input: PromotionReadinessEvaluationInput): PromotionReadinessResult {
  const byId = new Map<PromotionCheckId, PromotionReadinessCheck>();
  const duplicateIds = new Set<PromotionCheckId>();
  for (const check of input.checks) {
    if (byId.has(check.checkId)) duplicateIds.add(check.checkId);
    byId.set(check.checkId, check);
  }

  const unavailable: PromotionFailedCheck[] = [];
  for (const checkId of REQUIRED_PROMOTION_CHECK_IDS) {
    if (!byId.has(checkId)) unavailable.push({ checkId, reasonCode: 'required_check_missing' });
    if (duplicateIds.has(checkId)) unavailable.push({ checkId, reasonCode: 'duplicate_check_result' });
  }
  if (input.evidenceSnapshot.artifactDigest !== input.artifactDigest) {
    unavailable.push({ checkId: 'evidence_binding', reasonCode: 'artifact_digest_mismatch' });
  }

  const {shadowSummary} = input.evidenceSnapshot;
  const safetyGateResults = REQUIRED_PROMOTION_CHECK_IDS.flatMap(checkId => {
    const check = byId.get(checkId);
    if (!check) return [];
    if (checkId === 'runtime_shadow_evidence' && shadowSummary.errors !== null && shadowSummary.errors > 0) {
      return [{ checkId, status: 'failed' as const, reasonCode: 'unresolved_shadow_unhealthy_evidence' }];
    }
    return [{ ...check }];
  });
  const evidenceSnapshot = { ...input.evidenceSnapshot, safetyGateResults };
  if (unavailable.length > 0) {
    return { status: 'unavailable', evaluationId: input.evaluationId, artifactId: input.artifactId,
      artifactDigest: input.artifactDigest, evidenceSnapshot, failedChecks: unavailable };
  }

  const failedChecks = safetyGateResults
    .filter(check => check.status === 'failed')
    .map(check => ({ checkId: check.checkId, reasonCode: check.reasonCode ?? 'hard_check_failed' }));
  const summary = evidenceSnapshot.shadowSummary;
  const shadowAgeMs = summary.firstObservedAt === null
    ? null
    : Date.parse(evidenceSnapshot.createdAt) - Date.parse(summary.firstObservedAt);
  const insufficientEvidence = summary.observed === null || summary.observed < 20
    || summary.matched === null || summary.matched < 3
    || summary.neutralControl === null || summary.neutralControl < 1
    || shadowAgeMs === null || !Number.isFinite(shadowAgeMs) || shadowAgeMs < 24 * 60 * 60 * 1000;
  return {
    status: failedChecks.length > 0 ? 'blocked' : insufficientEvidence ? 'evidence_insufficient' : 'ready', evaluationId: input.evaluationId,
    artifactId: input.artifactId, artifactDigest: input.artifactDigest, evidenceSnapshot, failedChecks,
  };
}
