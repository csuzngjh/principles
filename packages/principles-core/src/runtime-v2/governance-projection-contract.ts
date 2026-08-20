import { Type, type Static } from '@sinclair/typebox';
import { PDErrorCategorySchema } from './error-categories.js';

const ISO_8601_UTC_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$';
const NonEmptyStringSchema = Type.String({ minLength: 1 });
const TimestampSchema = Type.String({ pattern: ISO_8601_UTC_PATTERN });

export const GovernanceChannelSchema = Type.Union([Type.Literal('prompt'), Type.Literal('code_tool_hook'), Type.Literal('defer_archive')]);
export const LineageConfidenceSchema = Type.Union([Type.Literal('strong'), Type.Literal('weak'), Type.Literal('unknown')]);
export const SourceRefSchema = Type.Object({
  type: Type.Union([Type.Literal('principle'), Type.Literal('artifact'), Type.Literal('task'), Type.Literal('run'), Type.Literal('approval'), Type.Literal('activation'), Type.Literal('trajectory')]),
  id: NonEmptyStringSchema,
}, { additionalProperties: false });

export const RevisionIdentitySchema = Type.Union([
  Type.Object({ kind: Type.Literal('evaluator_repair'), sourceEvaluatorTaskId: NonEmptyStringSchema, sourceArtificerArtifactId: NonEmptyStringSchema, repairIteration: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('rollout_reopen'), causeId: NonEmptyStringSchema, sourceRolloutTaskId: NonEmptyStringSchema, sourceArtifactId: NonEmptyStringSchema, revisionIteration: Type.Integer({ minimum: 0 }), taskRevisionEpoch: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('none') }, { additionalProperties: false }),
]);

const governanceFactBase = {
  schemaVersion: Type.Literal('1'), sourceRef: SourceRefSchema, principleId: NonEmptyStringSchema,
  artifactId: Type.Optional(NonEmptyStringSchema), taskId: Type.Optional(NonEmptyStringSchema),
  lineageKey: Type.Optional(NonEmptyStringSchema), lineageConfidence: LineageConfidenceSchema,
  revisionIdentity: Type.Optional(RevisionIdentitySchema), occurredAt: Type.Optional(TimestampSchema), recordedAt: TimestampSchema,
};

export const PrincipleFactSchema = Type.Object({
  ...governanceFactBase, family: Type.Literal('principle'),
  state: Type.Union([Type.Literal('candidate'), Type.Literal('active'), Type.Literal('archived'), Type.Literal('deprecated'), Type.Literal('probation')]),
}, { additionalProperties: false });
export const TaskFactSchema = Type.Object({
  ...governanceFactBase, family: Type.Literal('task'),
  taskKind: Type.Union([Type.Literal('dreamer'), Type.Literal('philosopher'), Type.Literal('scribe'), Type.Literal('artificer'), Type.Literal('evaluator'), Type.Literal('rollout_reviewer')]),
  channel: GovernanceChannelSchema,
  status: Type.Union([Type.Literal('pending'), Type.Literal('leased'), Type.Literal('succeeded'), Type.Literal('retry_wait'), Type.Literal('failed'), Type.Literal('needs_human_review')]),
  leaseExpiresAt: Type.Optional(TimestampSchema), attemptCount: Type.Integer({ minimum: 0 }), maxAttempts: Type.Integer({ minimum: 1 }),
  lastErrorCategory: Type.Optional(PDErrorCategorySchema),
  completionIntent: Type.Optional(Type.Object({
    status: Type.Union([Type.Literal('pending'), Type.Literal('applied')]), revisionEpoch: Type.Integer({ minimum: 0 }),
    effect: Type.Union([Type.Literal('governance_transition'), Type.Literal('needs_human_review')]),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
export const RunnerVerdictFactSchema = Type.Object({
  ...governanceFactBase, family: Type.Literal('runner_verdict'), runnerKind: Type.Union([Type.Literal('evaluator'), Type.Literal('rollout_reviewer')]),
  outcome: Type.Union([Type.Literal('approved'), Type.Literal('approve_rollout'), Type.Literal('needs_revision'), Type.Literal('rejected'), Type.Literal('reject')]),
}, { additionalProperties: false });
export const ApprovalFactSchema = Type.Object({
  ...governanceFactBase, family: Type.Literal('approval'), approvalId: NonEmptyStringSchema, artifactId: NonEmptyStringSchema,
  channel: GovernanceChannelSchema, outcome: Type.Union([Type.Literal('pending'), Type.Literal('approved'), Type.Literal('rejected'), Type.Literal('cancelled')]),
}, { additionalProperties: false });
export const ActivationFactSchema = Type.Object({
  ...governanceFactBase, family: Type.Literal('activation'), artifactId: NonEmptyStringSchema, activationId: NonEmptyStringSchema,
  channel: GovernanceChannelSchema, outcome: Type.Union([Type.Literal('active'), Type.Literal('deactivated')]), activatedAt: TimestampSchema,
  deactivatedAt: Type.Optional(TimestampSchema),
}, { additionalProperties: false });
export const DerivedRelationFactSchema = Type.Object({
  ...governanceFactBase, family: Type.Literal('derived_relation'),
  relation: Type.Union([Type.Literal('successor_present'), Type.Literal('revision_materialized'), Type.Literal('revision_pending'), Type.Literal('verdict_missing')]),
  evidenceRefs: Type.Array(SourceRefSchema),
}, { additionalProperties: false });
export const TimelineEventSchema = Type.Object({
  code: Type.Union([Type.Literal('pain_created'), Type.Literal('candidate_generated'), Type.Literal('review_started'), Type.Literal('revision_requested'), Type.Literal('revision_reopened'), Type.Literal('approved'), Type.Literal('rejected'), Type.Literal('activated'), Type.Literal('deactivated'), Type.Literal('failed'), Type.Literal('human_review')]),
  occurredAt: Type.Optional(TimestampSchema), recordedAt: TimestampSchema, summaryCode: NonEmptyStringSchema,
  sourceRef: SourceRefSchema, lineageConfidence: LineageConfidenceSchema,
}, { additionalProperties: false });
export const DataQualityIssueSchema = Type.Object({
  source: Type.Union([Type.Literal('ledger'), Type.Literal('artifact'), Type.Literal('task'), Type.Literal('approval'), Type.Literal('activation'), Type.Literal('trajectory'), Type.Literal('lineage')]),
  reasonCode: NonEmptyStringSchema, nextActionCode: NonEmptyStringSchema, sourceRef: Type.Optional(SourceRefSchema),
}, { additionalProperties: false });
export const LineageContextSchema = Type.Object({
  principleId: NonEmptyStringSchema, artifactIds: Type.Array(NonEmptyStringSchema), taskIds: Type.Array(NonEmptyStringSchema),
  revisionIdentities: Type.Array(RevisionIdentitySchema), confidence: LineageConfidenceSchema, sourceRefs: Type.Array(SourceRefSchema),
}, { additionalProperties: false });
export const GovernanceFactsSchema = Type.Object({
  schemaVersion: Type.Literal('1'), principleId: NonEmptyStringSchema, asOf: TimestampSchema, lineage: LineageContextSchema,
  principle: PrincipleFactSchema, tasks: Type.Array(TaskFactSchema), runnerVerdicts: Type.Array(RunnerVerdictFactSchema),
  derivedRelations: Type.Array(DerivedRelationFactSchema), approvals: Type.Array(ApprovalFactSchema), activations: Type.Array(ActivationFactSchema),
  timelineEvents: Type.Array(TimelineEventSchema), collectionIssues: Type.Array(DataQualityIssueSchema),
}, { additionalProperties: false });

export type GovernanceChannel = Static<typeof GovernanceChannelSchema>;
export type LineageConfidence = Static<typeof LineageConfidenceSchema>;
export type SourceRef = Static<typeof SourceRefSchema>;
export type RevisionIdentity = Static<typeof RevisionIdentitySchema>;
export type PrincipleFact = Static<typeof PrincipleFactSchema>;
export type TaskFact = Static<typeof TaskFactSchema>;
export type RunnerVerdictFact = Static<typeof RunnerVerdictFactSchema>;
export type ApprovalFact = Static<typeof ApprovalFactSchema>;
export type ActivationFact = Static<typeof ActivationFactSchema>;
export type DerivedRelationFact = Static<typeof DerivedRelationFactSchema>;
export type TimelineEvent = Static<typeof TimelineEventSchema>;
export type DataQualityIssue = Static<typeof DataQualityIssueSchema>;
export type LineageContext = Static<typeof LineageContextSchema>;
export type GovernanceFacts = Static<typeof GovernanceFactsSchema>;
