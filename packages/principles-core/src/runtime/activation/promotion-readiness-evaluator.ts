import type { PromotionEvidenceSnapshot, PromotionFailedCheck, PromotionReadinessCriterion, PromotionReadinessResult } from './rulecode-owner-decision-service.js';

export const REQUIRED_PROMOTION_CHECK_IDS = [
  'activation_eligibility', 'lineage_binding', 'bounded_scope', 'production_compile_load',
  'golden_trace', 'runtime_compatibility', 'host_liveness_composition', 'emergency_controls',
  'runtime_shadow_evidence', 'owner_identity_configuration',
] as const;

export type PromotionCheckId = typeof REQUIRED_PROMOTION_CHECK_IDS[number];

/**
 * The four numeric evidence thresholds for promotion. THE single definition:
 * the evaluator, the explanation projection and every consumer (tests
 * included) read their numbers from here, so no second set of constants can
 * drift from the judgment it describes.
 */
export const PROMOTION_EVIDENCE_THRESHOLDS = Object.freeze({
  minObservedSamples: 20,
  minMatchedSamples: 3,
  minNeutralControlSamples: 1,
  minShadowAgeMs: 24 * 60 * 60 * 1000,
});

export type PromotionEvidenceCriterionId =
  | 'shadow_observed'
  | 'shadow_matched'
  | 'shadow_neutral_control'
  | 'shadow_age';

export interface PromotionEvidenceCriterion {
  criterionId: PromotionEvidenceCriterionId;
  /** Measured value; null when the snapshot carries no measurement at all. */
  current: number | null;
  threshold: number;
  /** Distance to the threshold. Absent once the criterion is satisfied. */
  shortfall?: number;
}

function criterionFor(
  criterionId: PromotionEvidenceCriterionId,
  current: number | null,
  threshold: number,
): PromotionEvidenceCriterion {
  const measured = current !== null && Number.isFinite(current) ? current : null;
  if (measured !== null && measured >= threshold) {
    return { criterionId, current: measured, threshold };
  }
  return { criterionId, current: measured, threshold, shortfall: threshold - (measured ?? 0) };
}

/**
 * Explain the numeric evidence dimension: what each threshold currently is,
 * what it must reach, and how far it still is. Pure — the same snapshot always
 * yields the same criteria.
 */
export function evaluatePromotionEvidenceCriteria(
  evidenceSnapshot: PromotionEvidenceSnapshot,
): PromotionEvidenceCriterion[] {
  const summary = evidenceSnapshot.shadowSummary;
  const shadowAgeMs = summary.firstObservedAt === null
    ? null
    : Date.parse(evidenceSnapshot.createdAt) - Date.parse(summary.firstObservedAt);
  return [
    criterionFor('shadow_observed', summary.observed, PROMOTION_EVIDENCE_THRESHOLDS.minObservedSamples),
    criterionFor('shadow_matched', summary.matched, PROMOTION_EVIDENCE_THRESHOLDS.minMatchedSamples),
    criterionFor('shadow_neutral_control', summary.neutralControl, PROMOTION_EVIDENCE_THRESHOLDS.minNeutralControlSamples),
    criterionFor('shadow_age', shadowAgeMs, PROMOTION_EVIDENCE_THRESHOLDS.minShadowAgeMs),
  ];
}

/**
 * Project the gaps a consumer may display for a readiness result. Returns null
 * unless the result is `evidence_insufficient`: a blocked hard check or an
 * unavailable telemetry source is a different obstacle, and "still need N
 * samples" would describe the wrong reason.
 */
export function explainPromotionReadiness(
  evidenceSnapshot: PromotionEvidenceSnapshot,
  status: PromotionReadinessResult['status'],
): PromotionEvidenceCriterion[] | null {
  if (status !== 'evidence_insufficient') return null;
  return evaluatePromotionEvidenceCriteria(evidenceSnapshot);
}

export interface PromotionCriteriaProjectionInput {
  /** The gate results the evaluator recorded on the snapshot. */
  safetyGateResults: readonly { checkId: string; status: 'passed' | 'failed'; reasonCode?: string }[];
  failedChecks: readonly PromotionFailedCheck[];
  evidenceSnapshot: PromotionEvidenceSnapshot;
}

/**
 * Project ONE explainable line per required hard check plus the measurable
 * evidence dimensions (5B). Pure and derived: it never changes a status or a
 * threshold, it only states what the evaluation already decided.
 *
 * - Every required check appears exactly once; a check the evaluation never
 *   reached is `not_evaluated`, not a silent `passed`.
 * - An extra failure the evaluator recorded (for example `evidence_binding`)
 *   is appended so nothing is dropped from `failedChecks`.
 * - Numeric evidence is only projected when the telemetry source actually
 *   produced a measurement; an unavailable source is already explained by the
 *   `runtime_shadow_evidence` hard check.
 */
export function projectPromotionReadinessCriteria(input: PromotionCriteriaProjectionInput): PromotionReadinessCriterion[] {
  const gateById = new Map<string, PromotionCriteriaProjectionInput['safetyGateResults'][number]>();
  for (const gate of input.safetyGateResults) gateById.set(gate.checkId, gate);
  const failedReasonById = new Map<string, string>();
  for (const failed of input.failedChecks) {
    if (!failedReasonById.has(failed.checkId)) failedReasonById.set(failed.checkId, failed.reasonCode);
  }

  const criteria: PromotionReadinessCriterion[] = REQUIRED_PROMOTION_CHECK_IDS.map(checkId => {
    const recordedFailure = failedReasonById.get(checkId);
    if (recordedFailure !== undefined) {
      return { criterionId: checkId, kind: 'hard_check', status: 'failed', reasonCode: recordedFailure };
    }
    const gate = gateById.get(checkId);
    if (!gate) return { criterionId: checkId, kind: 'hard_check', status: 'not_evaluated' };
    return {
      criterionId: checkId, kind: 'hard_check', status: gate.status,
      ...(gate.status === 'failed' ? { reasonCode: gate.reasonCode ?? 'hard_check_failed' } : {}),
    };
  });

  const required = new Set<string>(REQUIRED_PROMOTION_CHECK_IDS);
  for (const failed of input.failedChecks) {
    if (required.has(failed.checkId)) continue;
    criteria.push({ criterionId: failed.checkId, kind: 'hard_check', status: 'failed', reasonCode: failed.reasonCode });
  }

  if (input.evidenceSnapshot.shadowSummary.observed !== null) {
    for (const evidence of evaluatePromotionEvidenceCriteria(input.evidenceSnapshot)) {
      criteria.push({
        criterionId: evidence.criterionId,
        kind: 'evidence',
        status: evidence.shortfall === undefined ? 'passed' : 'failed',
        current: evidence.current,
        threshold: evidence.threshold,
        ...(evidence.shortfall === undefined ? {} : { shortfall: evidence.shortfall }),
      });
    }
  }
  return criteria;
}

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
  if (shadowSummary.observed === null) {
    unavailable.push({ checkId: 'runtime_shadow_evidence', reasonCode: 'shadow_telemetry_source_unavailable' });
  }
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
      artifactDigest: input.artifactDigest, evidenceSnapshot, failedChecks: unavailable,
      criteria: projectPromotionReadinessCriteria({ safetyGateResults, failedChecks: unavailable, evidenceSnapshot }) };
  }

  const failedChecks = safetyGateResults
    .filter(check => check.status === 'failed')
    .map(check => ({ checkId: check.checkId, reasonCode: check.reasonCode ?? 'hard_check_failed' }));
  const criteria = evaluatePromotionEvidenceCriteria(evidenceSnapshot);
  const insufficientEvidence = criteria.some(criterion => criterion.shortfall !== undefined);
  return {
    status: failedChecks.length > 0 ? 'blocked' : insufficientEvidence ? 'evidence_insufficient' : 'ready', evaluationId: input.evaluationId,
    artifactId: input.artifactId, artifactDigest: input.artifactDigest, evidenceSnapshot, failedChecks,
    criteria: projectPromotionReadinessCriteria({ safetyGateResults, failedChecks, evidenceSnapshot }),
  };
}
