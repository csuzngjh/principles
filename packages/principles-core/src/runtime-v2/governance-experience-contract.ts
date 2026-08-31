import { Type, type Static } from '@sinclair/typebox';
import {
  LineageConfidenceSchema,
  OwnerGovernanceViewSchema,
  SourceRefSchema,
} from './governance-projection-contract.js';

// Governance Experience Snapshot v1.5.1 contract (PRI-584).
//
// Read-only experience layer OVER the existing governance projection
// (GovernanceFacts -> deriveOwnerGovernanceView -> OwnerGovernanceView).
// This layer explains; it never authorizes (ERR-102) and never introduces a
// second lifecycle model: every activity judgment below is derived from
// fields the projection already computed.

const NonEmptyStringSchema = Type.String({ minLength: 1 });
// Reuses the ISO-8601 UTC format registered by governance-projection-contract.js
// at import time; Value.Check fails loud if the two registrations ever diverge.
const TimestampSchema = Type.String({ format: 'governance-iso-utc' });

export const GovernancePrimaryAttentionSchema = Type.Union([
  Type.Literal('setup_required'),
  Type.Literal('owner_decision_required'),
  Type.Literal('recovery_required'),
  Type.Literal('degraded'),
  Type.Literal('background_processing'),
  Type.Literal('all_clear'),
]);
export const GovernanceExperienceReasonCodeSchema = Type.Union([
  Type.Literal('governance.exp.reason.owner_identity_missing'),
  Type.Literal('governance.exp.reason.owner_identity_invalid'),
  Type.Literal('governance.exp.reason.owner_authentication_missing'),
  Type.Literal('governance.exp.reason.approval_pending'),
  Type.Literal('governance.exp.reason.rulecode_owner_decision'),
  Type.Literal('governance.exp.reason.no_pending_decision'),
  Type.Literal('governance.exp.reason.owner_decision_available'),
  Type.Literal('governance.exp.reason.break_glass_entry'),
  Type.Literal('governance.exp.reason.recovery_required'),
  Type.Literal('governance.exp.reason.source_unavailable'),
  Type.Literal('governance.exp.reason.config_invalid'),
  Type.Literal('governance.exp.reason.processing'),
  Type.Literal('governance.exp.reason.workspace_clear'),
  Type.Literal('governance.exp.reason.workspace_empty'),
]);
export const GovernanceExperienceNextActionCodeSchema = Type.Union([
  Type.Literal('governance.exp.next.configure_owner'),
  Type.Literal('governance.exp.next.authenticate_console'),
  Type.Literal('governance.exp.next.review_approvals'),
  Type.Literal('governance.exp.next.inspect_recovery'),
  Type.Literal('governance.exp.next.inspect_sources'),
  Type.Literal('governance.exp.next.fix_config'),
  Type.Literal('governance.exp.next.monitor'),
  Type.Literal('governance.exp.next.none'),
]);

// ── Inputs (request-scoped validated envelope, SPEC §5) ─────────────────────

export const WorkspaceEnvironmentSchema = Type.Union([
  Type.Literal('production'),
  Type.Literal('development'),
  Type.Literal('demo'),
  Type.Literal('test'),
]);
export const EnvironmentContextInputSchema = Type.Object({
  environment: Type.Union([WorkspaceEnvironmentSchema, Type.Literal('unknown')]),
  source: Type.Union([Type.Literal('workspace_config'), Type.Literal('missing')]),
  configIssue: Type.Optional(NonEmptyStringSchema),
}, { additionalProperties: false });
export const SourceAvailabilityInputSchema = Type.Object({
  sourceId: Type.Union([Type.Literal('state_db'), Type.Literal('principle_ledger')]),
  available: Type.Boolean(),
  reasonCode: Type.Optional(NonEmptyStringSchema),
}, { additionalProperties: false });
export const UnlinkedRecordGroupSchema = Type.Object({
  source: Type.Union([
    Type.Literal('approval'),
    Type.Literal('task'),
    Type.Literal('artifact'),
    Type.Literal('principle'),
    Type.Literal('activation'),
  ]),
  reasonCode: NonEmptyStringSchema,
  count: Type.Integer({ minimum: 0 }),
  sampleRefs: Type.Array(SourceRefSchema, { maxItems: 10 }),
}, { additionalProperties: false });
export const OwnerConfigSnapshotSchema = Type.Object({
  authenticationMode: Type.Union([Type.Literal('authenticated'), Type.Literal('no_auth')]),
  ownerIdentityConfiguration: Type.Union([Type.Literal('configured'), Type.Literal('missing'), Type.Literal('invalid')]),
}, { additionalProperties: false });
export const GovernanceViewInputSchema = Type.Object({
  view: OwnerGovernanceViewSchema,
  lineageConfidence: LineageConfidenceSchema,
}, { additionalProperties: false });
/**
 * Frontier evidence read directly from the tasks table. Present only when
 * state_db is readable. Used exclusively for the `blocked` classification:
 * blocked requires BOTH current-frontier evidence and a blocking source
 * (SPEC §8.1/§9.1) — orphan rows alone can never produce `blocked`.
 */
export const FrontierEvidenceSchema = Type.Object({
  sourceId: Type.Literal('state_db'),
  activeTaskCount: Type.Integer({ minimum: 0 }),
  sampleRefs: Type.Array(SourceRefSchema, { maxItems: 10 }),
}, { additionalProperties: false });
export const GovernanceExperienceInputsSchema = Type.Object({
  schemaVersion: Type.Literal('1'),
  asOf: TimestampSchema,
  workspaceHash: NonEmptyStringSchema,
  governanceViews: Type.Array(GovernanceViewInputSchema),
  ownerConfigSnapshot: OwnerConfigSnapshotSchema,
  environmentContext: EnvironmentContextInputSchema,
  sourceAvailability: Type.Array(SourceAvailabilityInputSchema),
  dataQualityInputs: Type.Array(UnlinkedRecordGroupSchema),
  frontierEvidence: Type.Optional(FrontierEvidenceSchema),
  /**
   * RuleCode owner decisions awaiting action (SPEC §8.3 needs_decision source).
   * Counted from non-deactivated shadow activations in the same batched
   * `activations` rows — no extra query. Absent when state_db is unavailable.
   */
  rulecodeDecisionEvidence: Type.Optional(Type.Object({
    pendingCount: Type.Integer({ minimum: 0 }),
    sampleRefs: Type.Array(SourceRefSchema, { maxItems: 10 }),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

// ── Readiness (SPEC §6) ──────────────────────────────────────────────────────

export const GovernanceActionKindSchema = Type.Union([
  Type.Literal('principle_approval'),
  Type.Literal('rulecode_owner_decision'),
  Type.Literal('emergency_pause'),
]);
export const GovernanceObservedAuthoritySchema = Type.Union([
  Type.Literal('operator_legacy'),
  Type.Literal('configured_owner'),
  Type.Literal('break_glass'),
]);
export const GovernanceActionReadinessSchema = Type.Object({
  kind: GovernanceActionKindSchema,
  observedAuthority: GovernanceObservedAuthoritySchema,
  status: Type.Union([Type.Literal('entry_conditions_met'), Type.Literal('blocked')]),
  reasonCode: GovernanceExperienceReasonCodeSchema,
  nextActionCode: GovernanceExperienceNextActionCodeSchema,
}, { additionalProperties: false });
export const OwnerGovernanceReadinessSchema = Type.Object({
  authenticationMode: OwnerConfigSnapshotSchema.properties.authenticationMode,
  ownerIdentityConfiguration: OwnerConfigSnapshotSchema.properties.ownerIdentityConfiguration,
  governanceActions: Type.Array(GovernanceActionReadinessSchema, { minItems: 3, maxItems: 3 }),
}, { additionalProperties: false });

// ── Activity (SPEC §7-§9) ────────────────────────────────────────────────────

export const GovernanceActivityCategorySchema = Type.Union([
  Type.Literal('blocked'),
  Type.Literal('needs_recovery'),
  Type.Literal('needs_decision'),
  Type.Literal('processing'),
]);
export const GovernanceActivityItemSchema = Type.Object({
  principleId: Type.Optional(NonEmptyStringSchema),
  category: GovernanceActivityCategorySchema,
  reasonCode: NonEmptyStringSchema,
  sourceRefs: Type.Array(SourceRefSchema, { maxItems: 10 }),
}, { additionalProperties: false });
export const GovernanceActivityCategorySummarySchema = Type.Object({
  category: GovernanceActivityCategorySchema,
  count: Type.Integer({ minimum: 0 }),
  items: Type.Array(GovernanceActivityItemSchema, { maxItems: 10 }),
  hasMore: Type.Boolean(),
}, { additionalProperties: false });
export const GovernanceActivitySnapshotSchema = Type.Object({
  primaryAttention: GovernancePrimaryAttentionSchema,
  categories: Type.Array(GovernanceActivityCategorySummarySchema),
}, { additionalProperties: false });

// ── Trust & data quality (SPEC §11-§15) ──────────────────────────────────────

export const GovernanceLineageTransparencySchema = Type.Object({
  confidence: LineageConfidenceSchema,
  strongViewCount: Type.Integer({ minimum: 0 }),
  weakViewCount: Type.Integer({ minimum: 0 }),
  unknownViewCount: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export const GovernanceTrustContextSchema = Type.Object({
  environmentContext: EnvironmentContextInputSchema,
  lineageTransparency: GovernanceLineageTransparencySchema,
}, { additionalProperties: false });
export const GovernanceDataQualityIssueGroupSchema = Type.Object({
  source: Type.Union([
    Type.Literal('ledger'),
    Type.Literal('artifact'),
    Type.Literal('task'),
    Type.Literal('approval'),
    Type.Literal('activation'),
    Type.Literal('trajectory'),
    Type.Literal('lineage'),
    Type.Literal('workspace'),
  ]),
  reasonCode: NonEmptyStringSchema,
  nextActionCode: NonEmptyStringSchema,
  count: Type.Integer({ minimum: 1 }),
  sampleRefs: Type.Array(SourceRefSchema, { maxItems: 3 }),
}, { additionalProperties: false });
export const GovernanceDataQualitySchema = Type.Object({
  degraded: Type.Boolean(),
  issueGroups: Type.Array(GovernanceDataQualityIssueGroupSchema, { maxItems: 10 }),
  hasMore: Type.Boolean(),
}, { additionalProperties: false });

// ── Snapshot (SPEC §12) ──────────────────────────────────────────────────────

export const GovernanceExperienceSummarySchema = Type.Object({
  primaryAttention: GovernancePrimaryAttentionSchema,
  headlineCode: NonEmptyStringSchema,
  reasonCode: GovernanceExperienceReasonCodeSchema,
  nextActionCode: GovernanceExperienceNextActionCodeSchema,
}, { additionalProperties: false });
export const GovernanceExperienceSnapshotSchema = Type.Object({
  schemaVersion: Type.Literal('1'),
  snapshotId: NonEmptyStringSchema,
  asOf: TimestampSchema,
  summary: GovernanceExperienceSummarySchema,
  readiness: OwnerGovernanceReadinessSchema,
  activity: GovernanceActivitySnapshotSchema,
  trustContext: GovernanceTrustContextSchema,
  dataQuality: GovernanceDataQualitySchema,
}, { additionalProperties: false });

export type WorkspaceEnvironment = Static<typeof WorkspaceEnvironmentSchema>;
export type EnvironmentContextInput = Static<typeof EnvironmentContextInputSchema>;
export type SourceAvailabilityInput = Static<typeof SourceAvailabilityInputSchema>;
export type UnlinkedRecordGroup = Static<typeof UnlinkedRecordGroupSchema>;
export type OwnerConfigSnapshot = Static<typeof OwnerConfigSnapshotSchema>;
export type GovernanceViewInput = Static<typeof GovernanceViewInputSchema>;
export type FrontierEvidence = Static<typeof FrontierEvidenceSchema>;
export type GovernanceExperienceInputs = Static<typeof GovernanceExperienceInputsSchema>;
export type GovernanceActionKind = Static<typeof GovernanceActionKindSchema>;
export type GovernanceObservedAuthority = Static<typeof GovernanceObservedAuthoritySchema>;
export type GovernanceActionReadiness = Static<typeof GovernanceActionReadinessSchema>;
export type OwnerGovernanceReadiness = Static<typeof OwnerGovernanceReadinessSchema>;
export type GovernancePrimaryAttention = Static<typeof GovernancePrimaryAttentionSchema>;
export type GovernanceActivityCategory = Static<typeof GovernanceActivityCategorySchema>;
export type GovernanceActivityItem = Static<typeof GovernanceActivityItemSchema>;
export type GovernanceActivityCategorySummary = Static<typeof GovernanceActivityCategorySummarySchema>;
export type GovernanceActivitySnapshot = Static<typeof GovernanceActivitySnapshotSchema>;
export type GovernanceLineageTransparency = Static<typeof GovernanceLineageTransparencySchema>;
export type GovernanceTrustContext = Static<typeof GovernanceTrustContextSchema>;
export type GovernanceDataQualityIssueGroup = Static<typeof GovernanceDataQualityIssueGroupSchema>;
export type GovernanceDataQuality = Static<typeof GovernanceDataQualitySchema>;
export type GovernanceExperienceReasonCode = Static<typeof GovernanceExperienceReasonCodeSchema>;
export type GovernanceExperienceNextActionCode = Static<typeof GovernanceExperienceNextActionCodeSchema>;
export type GovernanceExperienceSummary = Static<typeof GovernanceExperienceSummarySchema>;
export type GovernanceExperienceSnapshot = Static<typeof GovernanceExperienceSnapshotSchema>;
