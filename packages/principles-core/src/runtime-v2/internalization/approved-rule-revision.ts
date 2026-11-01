import { createHash } from 'node:crypto';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { CandidateIdentityPort } from './candidate-identity.js';
import type { CandidatePrincipleIdentityResolution } from '../types/rule-candidate-binding.js';
import type { OwnerPromotionActor } from '../activation/rulecode-owner-decision-service.js';
import { SqliteActivationStateStore } from '../activation/sqlite-activation-state-store.js';
import { SqliteActivationSafetyStore } from '../activation/sqlite-activation-safety-store.js';
import { SqliteApprovalQueueStore } from '../activation/sqlite-approval-store.js';
import { computeArtifactDigest } from '../activation/promotion-evidence-snapshot.js';
import { resolveRuleBindingRevisionTarget } from './rule-binding-revision.js';
import { createPITaskDiagnosticJson, hydratePITaskRecord, mergePITaskMetadata, type ApprovedRuleRevisionReceiptV1 } from './pitask-metadata.js';
import { reopenApprovedRuleInConnection } from '../store/task/sqlite-approved-rule-revision.js';
import { validateCandidateIdentityReceipt } from '../principle-tree/rule-candidate-binding.js';
import { readCandidateIdentityReceipt } from './candidate-identity.js';

export const MAX_APPROVED_RULE_REVISION_FEEDBACK_LENGTH = 4000;
export interface ApprovedRuleRevisionLedger extends CandidateIdentityPort {
  /** Canonical ledger lock held until the synchronous SQLite CAS returns. */
  withLockedRuleCandidateIdentity<T>(candidateId: string, operation: (identity: CandidatePrincipleIdentityResolution) => T): T;
}
interface RevisionBaseArgs {
  readonly stateManager: RuntimeStateManager;
  readonly ledger: ApprovedRuleRevisionLedger;
  readonly activationId: string;
}
type Refused = { status: 'refused'; reason: string; nextAction: string };
const refused = (reason: string): Refused => ({ status: 'refused', reason, nextAction: 'Refresh this activation revision preview and inspect its original approval and task chain.' });
export type ApprovedRuleRevisionPreview = Refused | {
  status: 'ready'; activationId: string; candidateId: string; principleId: string; artificerTaskId: string;
  expectedArtifactId: string; expectedArtifactDigest: string; expectedBindingRevision: number;
  expectedControlVersion: number; expectedTaskRevisionEpoch: number;
};
export interface ReviseApprovedRuleOnceArgs extends RevisionBaseArgs {
  readonly expectedArtifactId: string;
  readonly expectedArtifactDigest: string;
  readonly expectedBindingRevision: number;
  readonly expectedControlVersion: number;
  readonly expectedTaskRevisionEpoch: number;
  readonly requestId: string;
  readonly feedback: string;
  readonly actor: OwnerPromotionActor;
}
export type ApprovedRuleRevisionResult = Refused | {
  status: 'started' | 'already_started'; artificerTaskId: string; causeId: string; taskRevisionEpoch: number;
};

async function resolveTarget(args: RevisionBaseArgs) {
  const { stateManager } = args;
  const activations = await new SqliteActivationStateStore(stateManager.connection).listCodeToolHookActivations();
  const activation = activations.find(row => row.activationId === args.activationId);
  if (!activation || activation.action !== 'code_tool_hook_shadow_activate' || activation.deactivatedAt !== null || activation.promotedAt) return refused('active_shadow_activation_required');
  const artifact = await stateManager.piArtifactStore.getArtifactById(activation.artifactId);
  if (!artifact || artifact.artifactKind !== 'rule' || artifact.validationStatus !== 'validated') return refused('validated_rule_artifact_required');
  const evaluator = await stateManager.getTask(artifact.sourceTaskId);
  const evaluatorPi = evaluator ? hydratePITaskRecord(evaluator) : null;
  if (!evaluator || evaluator.taskKind !== 'evaluator' || !evaluatorPi?.correlationId) return refused('evaluator_lineage_invalid');
  const candidateId = evaluatorPi.correlationId;
  const target = await resolveRuleBindingRevisionTarget(stateManager, candidateId);
  if (target.status !== 'ready') return target;
  const tasks = await stateManager.listTasks();
  const artificers = tasks.filter(task => task.taskKind === 'artificer' && evaluatorPi.dependencyTaskIds.includes(task.taskId)
    && hydratePITaskRecord(task)?.dependencyTaskIds.includes(target.scribeTaskId));
  const rollouts = tasks.filter(task => task.taskKind === 'rollout_reviewer' && hydratePITaskRecord(task)?.dependencyTaskIds.includes(evaluator.taskId));
  const artificer = artificers.length === 1 ? artificers[0] : undefined;
  const rollout = rollouts.length === 1 ? rollouts[0] : undefined;
  const scribe = await stateManager.getTask(target.scribeTaskId);
  const artificerPi = artificer ? hydratePITaskRecord(artificer) : null;
  if (!scribe || !artificer || !artificerPi || !rollout) return refused('approved_rule_chain_not_unique');
  const identity = await args.ledger.resolveForCandidate(candidateId);
  if (identity.status !== 'resolved' || identity.basis !== 'owner_rule_binding'
    || typeof identity.bindingRevision !== 'number' || !Number.isSafeInteger(identity.bindingRevision) || identity.bindingRevision < 1
    || typeof identity.decisionId !== 'string' || identity.decisionId.trim() === '') return refused('owner_rule_binding_required');
  if (artifact.sourcePrincipleId !== identity.principleId || !validateCandidateIdentityReceipt(readCandidateIdentityReceipt(artifact.contentJson), identity)) return refused('artifact_binding_mismatch');
  const artifactDigest = computeArtifactDigest(artifact);
  const approval = (await new SqliteApprovalQueueStore(stateManager.connection).listAll({ status: 'approved', channel: 'code_tool_hook' }))
    .find(row => row.artifactId === artifact.artifactId && row.artifactDigest === artifactDigest);
  if (!approval) return refused('immutable_artifact_approval_required');
  const control = await new SqliteActivationSafetyStore(stateManager.connection).getControlState(activation.activationId);
  if (!control) return refused('activation_control_missing');
  return { status: 'resolved' as const, activation, artifact, artifactDigest, approval, control, candidateId,
    identity, bindingRevision: identity.bindingRevision, bindingDecisionId: identity.decisionId, scribe, artificer, artificerPi, evaluator, rollout };
}

function priorRevision(target: Awaited<ReturnType<typeof resolveTarget>>) {
  if (target.status !== 'resolved') return undefined;
  return target.artificerPi.approvedRuleRevisions?.find(receipt => receipt.artifactId === target.artifact.artifactId || receipt.artifactDigest === target.artifactDigest);
}

function chainRefusal(target: Awaited<ReturnType<typeof resolveTarget>>): Refused | null {
  if (target.status !== 'resolved') return target;
  for (const task of [target.scribe, target.artificer, target.evaluator, target.rollout]) {
    if (task.status !== 'succeeded') return refused(`revision_chain_not_succeeded:${task.taskKind}`);
    if (task.leaseOwner && (!task.leaseExpiresAt || !Number.isFinite(Date.parse(task.leaseExpiresAt)) || Date.parse(task.leaseExpiresAt) > Date.now())) return refused(`revision_chain_leased:${task.taskKind}`);
  }
  return null;
}

export async function previewApprovedRuleRevision(args: RevisionBaseArgs): Promise<ApprovedRuleRevisionPreview> {
  const target = await resolveTarget(args);
  if (target.status !== 'resolved') return target;
  if (priorRevision(target)) return refused('approved_artifact_revision_consumed');
  const stopped = chainRefusal(target);
  if (stopped) return stopped;
  return { status: 'ready', activationId: args.activationId, candidateId: target.candidateId, principleId: target.identity.principleId,
    artificerTaskId: target.artificer.taskId, expectedArtifactId: target.artifact.artifactId,
    expectedArtifactDigest: target.artifactDigest, expectedBindingRevision: target.bindingRevision,
    expectedControlVersion: target.control.version, expectedTaskRevisionEpoch: target.artificerPi.revisionCount ?? 0 };
}

export async function reviseApprovedRuleOnce(args: ReviseApprovedRuleOnceArgs): Promise<ApprovedRuleRevisionResult> {
  if (args.actor.principal.kind !== 'configured_owner'
    || args.actor.authentication.method !== 'console_token') return refused('owner_authentication_required');
  if (typeof args.feedback !== 'string' || args.feedback.trim() === '' || args.feedback.length > MAX_APPROVED_RULE_REVISION_FEEDBACK_LENGTH
    || typeof args.requestId !== 'string' || args.requestId.trim() === '' || args.requestId.length > 200) return refused('revision_request_invalid');
  const target = await resolveTarget(args);
  if (target.status !== 'resolved') return target;
  if (args.expectedArtifactId !== target.artifact.artifactId || args.expectedArtifactDigest !== target.artifactDigest) return refused('approved_artifact_snapshot_stale');
  const previous = priorRevision(target);
  if (previous) return { status: 'already_started', artificerTaskId: target.artificer.taskId, causeId: previous.causeId, taskRevisionEpoch: previous.taskRevisionEpoch };
  const stopped = chainRefusal(target);
  if (stopped) return stopped;
  if (target.artifact.contentJson.length > 64000) return refused('revision_source_exceeds_feedback_bound');
  if (args.expectedBindingRevision !== target.identity.bindingRevision || args.expectedControlVersion !== target.control.version
    || args.expectedTaskRevisionEpoch !== (target.artificerPi.revisionCount ?? 0)) return refused('revision_snapshot_stale');
  if (typeof args.ledger.withLockedRuleCandidateIdentity !== 'function') return refused('binding_lock_unavailable');
  const causeId = `approved-rule:${createHash('sha256').update(target.artifact.artifactId + ':' + target.artifactDigest).digest('hex')}`;
  const epoch = (target.artificerPi.revisionCount ?? 0) + 1;
  const receipt: ApprovedRuleRevisionReceiptV1 = { version: 1, activationId: args.activationId, artifactId: target.artifact.artifactId,
    artifactDigest: target.artifactDigest, approvalId: target.approval.approvalId, candidateId: target.candidateId,
    principleId: target.identity.principleId, bindingRevision: args.expectedBindingRevision, bindingDecisionId: target.bindingDecisionId,
    controlVersion: args.expectedControlVersion, taskRevisionEpoch: epoch, causeId, requestId: args.requestId,
    ownerId: args.actor.principal.ownerId, credentialId: args.actor.authentication.credentialId,
    feedback: args.feedback.trim(), consumedAt: new Date().toISOString() };
  // Existing Artificer buildContext/prompt consumes this exact validated field.
  // Evidence and implementation are data, never a replacement for the intent contract.
  const revisionFeedback = `Owner authorized one revision of approved artifact ${target.artifact.artifactId} (${target.artifactDigest}).\n<owner_revision_feedback>\n${args.feedback.trim()}\n</owner_revision_feedback>\nPreserve the original intent, trusted facts and evidence. Official recovery controls must remain reachable across unavailable context and the rule's applicable fact states: consume the host-owned action.recoveryControl marker and action classification; do not invent a pd-prefix or command whitelist. Keep the original principle's behavior for governed actions and neutral/fault states. Run independent quality and recovery-composition checks; new artifacts require fresh Owner approval.\n<previous_approved_artifact>\n${target.artifact.contentJson}\n</previous_approved_artifact>`;
  const metadata = mergePITaskMetadata(target.artificerPi, { revisionCount: epoch, revisionCauseId: causeId, revisionFeedback,
    runnerDecision: undefined, completionIntent: undefined, humanReviewContext: undefined,
    approvedRuleRevisions: [...(target.artificerPi.approvedRuleRevisions ?? []), receipt] });
  const committed = args.ledger.withLockedRuleCandidateIdentity(target.candidateId, identity => {
    if (identity.status !== 'resolved' || identity.basis !== 'owner_rule_binding' || identity.bindingRevision !== args.expectedBindingRevision
      || identity.principleId !== target.identity.principleId || identity.decisionId !== target.identity.decisionId) return false;
    return reopenApprovedRuleInConnection(args.stateManager.connection, { activation: target.activation, artifact: target.artifact,
      approvalId: target.approval.approvalId, artifactDigest: target.artifactDigest, controlVersion: args.expectedControlVersion,
      tasks: [target.scribe, target.artificer, target.evaluator, target.rollout], artificerTaskId: target.artificer.taskId,
      diagnosticJson: createPITaskDiagnosticJson(metadata) });
  });
  if (!committed) {
    const current = await args.stateManager.getTask(target.artificer.taskId);
    const same = current && hydratePITaskRecord(current)?.approvedRuleRevisions?.find(row => row.causeId === causeId);
    if (same) return { status: 'already_started', artificerTaskId: target.artificer.taskId, causeId, taskRevisionEpoch: same.taskRevisionEpoch };
    return refused('revision_snapshot_stale');
  }
  return { status: 'started', artificerTaskId: target.artificer.taskId, causeId, taskRevisionEpoch: epoch };
}
