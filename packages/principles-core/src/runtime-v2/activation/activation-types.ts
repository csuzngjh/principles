import type { InternalizationChannel, PIArtifactKind, PIArtifactValidationStatus } from '../internalization/peer-runner-contracts.js';

export type { InternalizationChannel, PIArtifactKind, PIArtifactValidationStatus };

export type ActivationRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export const LOW_RISK_CHANNELS: readonly InternalizationChannel[] = ['prompt', 'defer_archive'] as const;

export const HIGH_RISK_CHANNEL_MAP: Readonly<Record<string, ActivationRiskLevel>> = {
  skill: 'medium',
  code_tool_hook: 'high',
  model_training: 'critical',
} as const;

export const AUTO_PROMOTION_CONFIDENCE_THRESHOLD = 0.95;

export const AUTO_PROMOTABLE_CHANNELS: readonly InternalizationChannel[] = ['skill'] as const;

export type ActivationActor =
  | { kind: 'system'; source: 'rollout_reviewer' | 'recovery_sweep' }
  | { kind: 'agent'; agentId: string }
  | { kind: 'human'; userId: string };

export type RolloutActivationDecision = 'auto_activate' | 'require_approval' | 'reject';

export interface DispatchInput {
  artifactId: string;
  channel: InternalizationChannel;
  rolloutDecision: RolloutActivationDecision;
  actor: ActivationActor;
  idempotencyKey?: string;
  now: string;
  confirm: boolean;
  confidence?: number;
}

export type ActivationDecision =
  | { decision: 'would_activate'; activationId: string; action: string; targetRef: string }
  | { decision: 'activated'; activationId: string; action: string; targetRef: string }
  | { decision: 'already_activated'; activationId: string; action: string; targetRef: string }
  | { decision: 'queued_for_approval'; approvalId: string; queuedAt: string; channel: InternalizationChannel; riskLevel: ActivationRiskLevel }
  | { decision: 'refused'; reason: string; riskLevel?: ActivationRiskLevel; channel?: InternalizationChannel }
  | { decision: 'invalid_artifact'; reason: string };

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
  deactivatedAt: string | null;
}

export interface ActivationStateReadModel {
  getActivationStatus(idempotencyKey: string): Promise<ActivationStatusRecord | null>;
  recordActivation(record: ActivationStatusRecord): Promise<void>;
  listPromptActivations(): Promise<ActivationStatusRecord[]>;
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
