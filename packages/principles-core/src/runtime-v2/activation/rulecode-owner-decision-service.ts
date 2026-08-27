import type { ActivationDecisionRecord } from './activation-control-types.js';

export interface PromotionEvidenceSnapshot {
  snapshotId: string;
  snapshotDigest: string;
  artifactDigest: string;
  lineageRefs: string[];
  hostRuntimeVersion: string;
  safetyGateResults: { checkId: string; status: 'passed' | 'failed'; reasonCode?: string }[];
  shadowSummary: {
    observed: number | null;
    matched: number | null;
    wouldBlock: number | null;
    wouldAllow: number | null;
    requireApproval: number | null;
    autoCorrect: number | null;
    errors: number | null;
    neutralControl: number | null;
    firstObservedAt: string | null;
    lastObservedAt: string | null;
  };
  configurationVersion: string;
  redaction: { version: string; rawParametersStored: false };
  createdAt: string;
}

export interface PromotionFailedCheck {
  checkId: string;
  reasonCode: string;
}

export interface PromotionReadinessResult {
  status: 'ready' | 'evidence_insufficient' | 'blocked' | 'unavailable';
  evaluationId: string;
  artifactId: string;
  artifactDigest: string;
  evidenceSnapshot: PromotionEvidenceSnapshot;
  failedChecks: PromotionFailedCheck[];
}

export interface OwnerPromotionActor {
  principal: ActivationDecisionRecord['principal'];
  authentication: ActivationDecisionRecord['authentication'];
  operator?: ActivationDecisionRecord['operator'];
}

export interface OwnerPromotionRequest {
  activationId: string;
  expectedArtifactId: string;
  expectedArtifactDigest: string;
  expectedControlVersion: number;
  idempotencyKey: string;
  reasonCode: string;
  note?: string;
  confirmed: boolean;
  dryRun?: boolean;
}

export interface PromotionCommitInput {
  decision: ActivationDecisionRecord;
  evidenceSnapshot: PromotionEvidenceSnapshot;
  readinessEvaluationId: string;
  evidenceSnapshotDigest: string;
  expectedControlVersion: number;
  idempotencyKey: string;
}

export type OwnerPromotionResult =
  | { ok: true; decision: 'promoted'; activationId: string; decisionId: string; promotedAt: string }
  | { ok: true; decision: 'would_promote'; activationId: string; readinessEvaluationId: string; evidenceSnapshotDigest: string }
  | { ok: false; reasonCode: string; summary: string; failedChecks: PromotionFailedCheck[]; nextAction: string };

export interface RuleCodeOwnerDecisionServiceDeps {
  ownerLiveDecisionEnabled(): boolean;
  safetyControlsEnabled(): boolean;
  evaluateReadiness(input: OwnerPromotionRequest): Promise<PromotionReadinessResult>;
  commitPromotion(input: PromotionCommitInput): Promise<{ activationId: string; decisionId: string; promotedAt: string }>;
  newDecisionId(): string;
  now(): string;
}

function refused(input: { reasonCode: string; summary: string; nextAction: string; failedChecks?: PromotionFailedCheck[] }): OwnerPromotionResult {
  return { ok: false, ...input, failedChecks: input.failedChecks ?? [] };
}

export class RuleCodeOwnerDecisionService {
  constructor(private readonly deps: RuleCodeOwnerDecisionServiceDeps) {}

  async promote(request: OwnerPromotionRequest, actor: OwnerPromotionActor): Promise<OwnerPromotionResult> {
    if (!this.deps.ownerLiveDecisionEnabled()) {
      return refused({ reasonCode: 'feature_not_enabled', summary: 'Owner live decisions are disabled.', nextAction: 'Enable rulecode_owner_live_decision after completing its rollout gate.' });
    }
    if (!this.deps.safetyControlsEnabled()) {
      return refused({ reasonCode: 'safety_controls_unavailable', summary: 'Durable RuleCode safety controls are unavailable.', nextAction: 'Restore rulecode_safety_controls or disable code_tool_hook enforcement.' });
    }
    const authenticatedOwner = actor.principal.kind === 'configured_owner'
      && (actor.authentication.method === 'console_token' || actor.authentication.method === 'cli_owner_credential');
    if (!authenticatedOwner) {
      return refused({ reasonCode: 'owner_authentication_required', summary: 'Promotion requires the configured Owner credential.', nextAction: 'Authenticate as the configured Owner; local break-glass authority may only stop enforcement.' });
    }
    if (actor.authentication.method === 'cli_owner_credential' && (!request.note || request.note.trim().length === 0)) {
      return refused({ reasonCode: 'cli_owner_note_required', summary: 'CLI promotion requires an Owner review note.', nextAction: 'Provide a concise --note explaining the live decision.' });
    }
    if (!request.confirmed && request.dryRun !== true) {
      return refused({ reasonCode: 'confirmation_required', summary: 'Live enforcement was not confirmed.', nextAction: 'Refresh the review evidence and explicitly confirm promotion.' });
    }
    if (!request.activationId || !request.expectedArtifactId || !request.expectedArtifactDigest || !request.idempotencyKey || !request.reasonCode) {
      return refused({ reasonCode: 'promotion_request_invalid', summary: 'Required promotion binding fields are missing.', nextAction: 'Refresh the Owner review and submit all optimistic preconditions.' });
    }

    const readiness = await this.deps.evaluateReadiness(request);
    if (readiness.status === 'blocked' || readiness.status === 'unavailable') {
      return refused({
        reasonCode: readiness.status === 'blocked' ? 'promotion_safety_gate_blocked' : 'promotion_readiness_unavailable',
        summary: readiness.status === 'blocked' ? 'One or more hard promotion checks failed.' : 'Promotion readiness could not be established.',
        nextAction: 'Review the failed checks, repair them, and refresh the Owner review before retrying.',
        failedChecks: readiness.failedChecks,
      });
    }
    if (readiness.artifactId !== request.expectedArtifactId || readiness.artifactDigest !== request.expectedArtifactDigest
      || readiness.evidenceSnapshot.artifactDigest !== readiness.artifactDigest) {
      return refused({ reasonCode: 'promotion_snapshot_stale', summary: 'The activation artifact changed during review.', nextAction: 'Refresh the Owner review and evaluate the current artifact version.' });
    }
    if (readiness.status === 'evidence_insufficient') {
      const allowedOverrideReasons = new Set(['rare_behavior', 'controlled_rollout', 'owner_accepts_limited_evidence']);
      if (!allowedOverrideReasons.has(request.reasonCode)) {
        return refused({ reasonCode: 'evidence_override_reason_required', summary: 'Evidence-insufficient promotion requires a predefined Owner reason.', nextAction: 'Choose rare_behavior, controlled_rollout, or owner_accepts_limited_evidence.' });
      }
      if (!request.note || request.note.trim().length === 0) {
        return refused({ reasonCode: 'evidence_override_note_required', summary: 'Evidence-insufficient promotion requires an Owner note.', nextAction: 'Explain why promotion is acceptable despite insufficient evidence.' });
      }
    }
    if (request.dryRun === true) {
      return {
        ok: true, decision: 'would_promote', activationId: request.activationId,
        readinessEvaluationId: readiness.evaluationId,
        evidenceSnapshotDigest: readiness.evidenceSnapshot.snapshotDigest,
      };
    }

    const decidedAt = this.deps.now();
    const decision: ActivationDecisionRecord = {
      decisionId: this.deps.newDecisionId(),
      subject: {
        kind: 'activation', activationId: request.activationId,
        artifactId: readiness.artifactId, artifactDigest: readiness.artifactDigest,
      },
      decision: 'promote_live',
      principal: actor.principal,
      authentication: actor.authentication,
      operator: actor.operator,
      reasonCode: request.reasonCode,
      note: request.note?.trim() || null,
      evidenceSnapshotId: readiness.evidenceSnapshot.snapshotId,
      decidedAt,
    };
    try {
      const committed = await this.deps.commitPromotion({
        decision,
        evidenceSnapshot: readiness.evidenceSnapshot,
        readinessEvaluationId: readiness.evaluationId,
        evidenceSnapshotDigest: readiness.evidenceSnapshot.snapshotDigest,
        expectedControlVersion: request.expectedControlVersion,
        idempotencyKey: request.idempotencyKey,
      });
      return { ok: true, decision: 'promoted', ...committed };
    } catch (error) {
      return refused({
        reasonCode: 'promotion_commit_failed',
        summary: `Failed to record the promotion decision in the durable safety store: ${error instanceof Error ? error.message : String(error)}`,
        nextAction: 'Resolve the reported store error (refresh the control version if it changed), then retry the Owner review.',
      });
    }
  }
}
