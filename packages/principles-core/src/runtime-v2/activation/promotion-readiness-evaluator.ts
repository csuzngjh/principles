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

  const safetyGateResults = REQUIRED_PROMOTION_CHECK_IDS.flatMap(checkId => {
    const check = byId.get(checkId);
    return check ? [{ ...check }] : [];
  });
  const evidenceSnapshot = { ...input.evidenceSnapshot, safetyGateResults };
  if (unavailable.length > 0) {
    return { status: 'unavailable', evaluationId: input.evaluationId, artifactId: input.artifactId,
      artifactDigest: input.artifactDigest, evidenceSnapshot, failedChecks: unavailable };
  }

  const failedChecks = safetyGateResults
    .filter(check => check.status === 'failed')
    .map(check => ({ checkId: check.checkId, reasonCode: check.reasonCode ?? 'hard_check_failed' }));
  return {
    status: failedChecks.length > 0 ? 'blocked' : 'ready', evaluationId: input.evaluationId,
    artifactId: input.artifactId, artifactDigest: input.artifactDigest, evidenceSnapshot, failedChecks,
  };
}
