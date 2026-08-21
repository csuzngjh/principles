import type { ActivationStatusRecord, CanActivateResult, PIArtifactSnapshot } from './activation-types.js';
import type { OwnerPromotionRequest, PromotionEvidenceSnapshot, PromotionReadinessResult } from './rulecode-owner-decision-service.js';
import { evaluateRuleCodePromotionReadiness, type PromotionReadinessCheck } from './promotion-readiness-evaluator.js';

export interface PromotionReadinessReaderDeps {
  listCodeToolHookActivations(): Promise<ActivationStatusRecord[]>;
  getArtifactById(artifactId: string): Promise<PIArtifactSnapshot | null>;
  computeArtifactDigest(artifact: PIArtifactSnapshot): string;
  validateProductionArtifact(artifact: PIArtifactSnapshot): Promise<CanActivateResult>;
  collectHostChecks(artifact: PIArtifactSnapshot): Promise<PromotionReadinessCheck[]>;
  buildEvidenceSnapshot(checks: PromotionReadinessCheck[], artifact?: PIArtifactSnapshot, evaluationId?: string): PromotionEvidenceSnapshot;
  newEvaluationId(): string;
}

type ReadinessRequest = Pick<OwnerPromotionRequest, 'activationId' | 'expectedArtifactId' | 'expectedArtifactDigest'>;

export class PromotionReadinessReader {
  constructor(private readonly deps: PromotionReadinessReaderDeps) {}

  async evaluate(request: ReadinessRequest): Promise<PromotionReadinessResult> {
    const evaluationId = this.deps.newEvaluationId();
    const matches = (await this.deps.listCodeToolHookActivations()).filter(record => record.activationId === request.activationId);
    const activation = matches.length === 1 ? matches[0] : undefined;
    if (!activation || activation.action !== 'code_tool_hook_shadow_activate' || activation.deactivatedAt !== null) {
      return this.blocked(evaluationId, request, [{ checkId: 'activation_eligibility', status: 'failed', reasonCode: matches.length > 1 ? 'activation_not_unique' : 'active_shadow_activation_required' }]);
    }
    if (activation.artifactId !== request.expectedArtifactId) {
      return this.blocked(evaluationId, request, [{ checkId: 'lineage_binding', status: 'failed', reasonCode: 'activation_artifact_mismatch' }]);
    }
    const artifact = await this.deps.getArtifactById(activation.artifactId);
    if (!artifact) {
      return this.blocked(evaluationId, request, [{ checkId: 'lineage_binding', status: 'failed', reasonCode: 'artifact_not_found' }]);
    }
    const artifactDigest = this.deps.computeArtifactDigest(artifact);
    if (artifactDigest !== request.expectedArtifactDigest) {
      return this.blocked(evaluationId, { ...request, expectedArtifactDigest: artifactDigest }, [{ checkId: 'lineage_binding', status: 'failed', reasonCode: 'artifact_digest_mismatch' }]);
    }

    const checks: PromotionReadinessCheck[] = [
      { checkId: 'activation_eligibility', status: 'passed' },
      { checkId: 'lineage_binding', status: artifact.sourceTaskId && artifact.lineageArtifactIds.length > 0 ? 'passed' : 'failed',
        ...(artifact.sourceTaskId && artifact.lineageArtifactIds.length > 0 ? {} : { reasonCode: 'artifact_lineage_missing' }) },
    ];
    const gate = await this.deps.validateProductionArtifact(artifact);
    checks.push(
      { checkId: 'production_compile_load', status: gate.ok ? 'passed' : 'failed', ...(!gate.ok ? { reasonCode: gate.reason } : {}) },
      { checkId: 'golden_trace', status: gate.ok ? 'passed' : 'failed', ...(!gate.ok ? { reasonCode: gate.reason } : {}) },
      ...await this.deps.collectHostChecks(artifact),
    );
    const evidenceSnapshot = this.deps.buildEvidenceSnapshot(checks, artifact, evaluationId);
    return evaluateRuleCodePromotionReadiness({ evaluationId, artifactId: artifact.artifactId, artifactDigest, evidenceSnapshot, checks });
  }

  private blocked(evaluationId: string, request: ReadinessRequest, checks: PromotionReadinessCheck[]): PromotionReadinessResult {
    const evidenceSnapshot = this.deps.buildEvidenceSnapshot(checks, undefined, evaluationId);
    return {
      status: 'blocked', evaluationId, artifactId: request.expectedArtifactId,
      artifactDigest: request.expectedArtifactDigest, evidenceSnapshot,
      failedChecks: checks.map(check => ({ checkId: check.checkId, reasonCode: check.reasonCode ?? 'hard_check_failed' })),
    };
  }
}
