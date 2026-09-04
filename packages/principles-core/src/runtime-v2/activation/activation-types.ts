import type { InternalizationChannel, PIArtifactKind, PIArtifactValidationStatus } from '../internalization/peer-runner-contracts.js';
import type { RuleReliabilityFailure } from '../internalization/rule-reliability-validation.js';

export type { InternalizationChannel, PIArtifactKind, PIArtifactValidationStatus };

export type ActivationRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export const LOW_RISK_CHANNELS: readonly InternalizationChannel[] = ['prompt', 'defer_archive'] as const;

export const HIGH_RISK_CHANNEL_MAP: Readonly<Record<string, ActivationRiskLevel>> = {
  skill: 'medium',
  code_tool_hook: 'high',
} as const;

export const AUTO_PROMOTION_CONFIDENCE_THRESHOLD = 0.95;

export const AUTO_PROMOTABLE_CHANNELS: readonly InternalizationChannel[] = ['skill'] as const;

export type ActivationActor =
  | { kind: 'system'; source: 'rollout_reviewer' | 'recovery_sweep' }
  | { kind: 'agent'; agentId: string }
  | { kind: 'human'; userId: string };

/**
 * Rollout activation decision from the rollout reviewer.
 * - 'auto_activate': low-risk channel, activate directly
 * - 'require_approval': enqueue for owner approval
 * - 'reject': refuse activation
 * - 'approved': approval already granted externally (ApprovalCompletionService).
 *   Bypasses the approval queue check and activates directly. This is the
 *   post-approval dispatch path for high-risk channels.
 */
export type RolloutActivationDecision = 'auto_activate' | 'require_approval' | 'reject' | 'approved';

export interface DispatchInput {
  artifactId: string;
  channel: InternalizationChannel;
  rolloutDecision: RolloutActivationDecision;
  actor: ActivationActor;
  idempotencyKey?: string;
  now: string;
  confirm: boolean;
  confidence?: number;
  /**
   * Required when rolloutDecision === 'approved'.
   * The dispatcher independently verifies this approval record exists,
   * is in 'approved' status, and matches the artifactId + channel.
   * This prevents callers from bypassing the owner approval boundary.
   */
  approvalId?: string;
}

export type ActivationDecision =
  | { decision: 'would_activate'; activationId: string; action: string; targetRef: string }
  | { decision: 'activated'; activationId: string; action: string; targetRef: string }
  | { decision: 'already_activated'; activationId: string; action: string; targetRef: string }
  | { decision: 'queued_for_approval'; approvalId: string; queuedAt: string; channel: InternalizationChannel; riskLevel: ActivationRiskLevel }
  | { decision: 'refused'; reason: string; nextAction?: string; riskLevel?: ActivationRiskLevel; channel?: InternalizationChannel; details?: { originalError: string; errorCategory: string }; /** PRI-634-F R2: structured reliability failure (layer/reasonCode/evidence/nextAction) preserved from the writer's gate/reliability result. */ failure?: RuleReliabilityFailure }
  | { decision: 'invalid_artifact'; reason: string; nextAction?: string };

export interface PIArtifactSnapshot {
  artifactId: string;
  artifactKind: PIArtifactKind;
  sourceTaskId: string;
  sourcePrincipleId?: string;
  sourceRuleId?: string;
  lineageArtifactIds: string[];
  validationStatus: PIArtifactValidationStatus;
  contentJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActivationArtifactReadModel {
  getArtifactById(artifactId: string): Promise<PIArtifactSnapshot | null>;
}

export interface ActivationStatusRecord {
  activationId: string;
  idempotencyKey: string;
  artifactId: string;
  channel: InternalizationChannel;
  action: string;
  targetRef: string;
  activatedAt: string;
  promotedAt?: string | null;
  deactivatedAt: string | null;
}

export interface ActivationStateReadModel {
  getActivationStatus(idempotencyKey: string): Promise<ActivationStatusRecord | null>;
  recordActivation(record: ActivationStatusRecord): Promise<void>;
  listPromptActivations(includeDeactivated?: boolean): Promise<ActivationStatusRecord[]>;
  listCodeToolHookActivations(includeDeactivated?: boolean): Promise<ActivationStatusRecord[]>;
  listAllActivations(): Promise<ActivationStatusRecord[]>;
  deactivateActivation(activationId: string, deactivatedAt: string): Promise<boolean>;
}

export interface WriterInput {
  artifactId: string;
  channel: InternalizationChannel;
  principleId: string;
  idempotencyKey: string;
  now: string;
}

export interface WriterResult {
  activationId: string;
  action: string;
  targetRef: string;
}

export interface CanActivateResult {
  ok: boolean;
  reason?: string;
  riskLevel: ActivationRiskLevel;
  /**
   * PRI-634-F R2 (review P2): structured reliability failure
   * ({layer, reasonCode, evidence, nextAction}) from the reliability
   * validation or the replay gate — surfaced alongside the flattened reason
   * so CLI/Console/operator surfaces can consume the layer without parsing
   * strings.
   */
  failure?: RuleReliabilityFailure;
}

export interface ChannelWriter {
  readonly channel: InternalizationChannel;
  canActivate(artifact: PIArtifactSnapshot): Promise<CanActivateResult>;
  activate(input: WriterInput, artifact: PIArtifactSnapshot): Promise<WriterResult>;
  buildApprovalContext?(
    input: WriterInput,
    artifact: PIArtifactSnapshot,
    confidence?: number,
  ): Pick<ApprovalEnqueueInput, 'summary' | 'triggerReason' | 'confidenceExplanation' | 'effectDescription' | 'rejectionEffect'>;
}

// ── Approval Queue Types ──────────────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface ApprovalRecord {
  approvalId: string;
  artifactId: string;
  channel: InternalizationChannel;
  riskLevel: ActivationRiskLevel;
  status: ApprovalStatus;
  confidence?: number;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
  rejectionReason?: string;
  summary?: string;
  triggerReason?: string;
  confidenceExplanation?: string;
  effectDescription?: string;
  rejectionEffect?: string;
  /** Story A (PRI-408): Edit tracking — when owner edits the principle/rule before approving */
  editedAt?: string;
  editedBy?: string;
  editReason?: string;
  /** The previous artifactId before the edit (for lineage tracking) */
  previousArtifactId?: string;
}

export type ConfidenceLabel = 'high' | 'medium' | 'low';

export function mapConfidenceToLabel(confidence: number | undefined): ConfidenceLabel {
  if (confidence === undefined || confidence === null) return 'medium';
  if (confidence >= 0.8) return 'high';
  if (confidence >= 0.5) return 'medium';
  return 'low';
}

export interface ApprovalWithContext extends ApprovalRecord {
  summary?: string;
  triggerReason?: string;
  confidenceLabel: ConfidenceLabel;
  confidenceExplanation?: string;
  effectDescription?: string;
  rejectionEffect?: string;
}

export interface ApprovalListFilter {
  status?: ApprovalStatus;
  channel?: InternalizationChannel;
  page?: number;
  pageSize?: number;
}

export interface ApprovalStats {
  pending: number;
  approved: number;
  rejected: number;
  cancelled: number;
}

export interface ApprovalListResult {
  items: ApprovalWithContext[];
  total: number;
  stats: ApprovalStats;
}

export interface ApprovalEnqueueInput {
  artifactId: string;
  channel: InternalizationChannel;
  riskLevel: ActivationRiskLevel;
  confidence?: number;
  summary?: string;
  triggerReason?: string;
  confidenceExplanation?: string;
  effectDescription?: string;
  rejectionEffect?: string;
}

export interface ApprovalFilter {
  channel?: InternalizationChannel;
  riskLevel?: ActivationRiskLevel;
}

export type ApprovalDecisionResult =
  | { ok: true; record: ApprovalRecord }
  | { ok: false; error: 'already_decided'; status: ApprovalStatus }
  | { ok: false; error: 'not_found' };

export interface ApprovalQueueStore {
  enqueue(input: ApprovalEnqueueInput, now: string): Promise<ApprovalRecord>;
  getById(approvalId: string): Promise<ApprovalRecord | null>;
  listPending(filter?: ApprovalFilter): Promise<ApprovalRecord[]>;
  listAll(filter?: ApprovalListFilter): Promise<ApprovalRecord[]>;
  countByStatus(): Promise<ApprovalStats>;
  approve(approvalId: string, decidedBy: string, note?: string): Promise<ApprovalDecisionResult>;
  reject(approvalId: string, decidedBy: string, reason: string): Promise<ApprovalDecisionResult>;
  /** Roll back an approved approval to pending so it can be re-approved. Used when post-approval activation dispatch fails. */
  resetToPending(approvalId: string): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'not_approved' }>;
  /**
   * Story A (PRI-408): Edit a pending approval's artifact to a new version.
   * Updates artifactId, records edit metadata, keeps status as pending.
   * The caller is responsible for creating the new artifact and performing
   * schema validation + sandbox replay BEFORE calling this method.
   * Returns error if the approval is not in 'pending' status.
   */
  edit(input: ApprovalEditInput): Promise<ApprovalDecisionResult>;
}

export interface ApprovalEditInput {
  approvalId: string;
  editedBy: string;
  newArtifactId: string;
  editReason: string;
  now: string;
}

export interface ArtifactLineageIdentity {
  artifactId: string;
  sourceTaskId: string;
  sourcePrincipleId?: string;
  lineageArtifactIds: string[];
}

export function isArtifactRevisionOf(candidate: ArtifactLineageIdentity, original: ArtifactLineageIdentity): boolean {
  const referencesOriginal = candidate.lineageArtifactIds.includes(original.artifactId);
  const samePrinciple = Boolean(candidate.sourcePrincipleId)
    && candidate.sourcePrincipleId === original.sourcePrincipleId;
  return candidate.sourceTaskId === original.sourceTaskId || referencesOriginal || samePrinciple;
}
export function makeIdempotencyKey(artifactId: string, channel: InternalizationChannel): string {
  return `${artifactId}::${channel}`;
}

export function isLowRiskChannel(channel: InternalizationChannel): boolean {
  return LOW_RISK_CHANNELS.includes(channel);
}

export function getChannelRiskLevel(channel: InternalizationChannel): ActivationRiskLevel {
  if (isLowRiskChannel(channel)) return 'low';
  return HIGH_RISK_CHANNEL_MAP[channel] ?? 'high';
}
