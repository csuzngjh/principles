/**
 * Intervention Evidence Contract — PD v2 Phase 1 Evidence Foundation
 * (ADR-0027 §2, receipt-design SPEC §13.3–13.5).
 *
 * This contract records WHAT HAPPENED along one intervention chain:
 *
 *   Activation → Delivery → Application → Behavior Episode → Effect → Outcome
 *
 * It is a relationship model over observed facts, NOT a scoring pipeline:
 * no field here may express effectiveness, success rate, ranking or any
 * automatic governance consequence (SPEC §13.1 Excluded). Missing links stay
 * explicit (`pending_association` / `revision_reference_unresolved` / Unknown
 * capability) and never silently become successful links (ADR-0027 §2.1).
 *
 * Writer authority (ADR-0027 §2.3): the source role decides what a record can
 * claim — an agent's self-report is only ever `agent_claimed`; only a trusted
 * runtime execution event may produce `runtime_verified`. The normalizer
 * (intervention-evidence-normalizer.ts) enforces these rules at the boundary.
 *
 * Pure types, zero I/O. Runtime input validation of untrusted batch payloads
 * is rc-1/rc-2 territory and lives in the normalizer
 * (intervention-evidence-normalizer.ts), which enforces the closed field sets
 * defined here.
 */

// ── Record kinds ────────────────────────────────────────────────────────────

export const INTERVENTION_RECORD_KINDS = [
  'delivery',
  'application',
  'behavior_episode',
  'effect',
  'outcome',
] as const;
export type InterventionRecordKind = (typeof INTERVENTION_RECORD_KINDS)[number];

// ── Source identity (ADR-0027 §2.2) ─────────────────────────────────────────

/**
 * Closed set of raw source families. Each existing durable source keeps its
 * own authority; the normalized ledger never becomes a second writer of the
 * raw fact (SPEC §13.7).
 */
export const INTERVENTION_SOURCE_KINDS = [
  'openclaw_plugin_event_log',
  'openclaw_application_ledger',
  'openclaw_trajectory',
  'codex_pd_hook_event_log',
  'codex_governance_observation',
  'host_runtime_dispatch',
  'owner_console_input',
] as const;
export type InterventionSourceKind = (typeof INTERVENTION_SOURCE_KINDS)[number];

// ── Delivery semantics (ADR-0027 §2.4, SPEC §13.5) ─────────────────────────

/** Confirmation ladder, weakest → strongest. prepared/submitted ≠ delivered. */
export const DELIVERY_CONFIRMATIONS = [
  'prepared',
  'submitted',
  'host_accepted',
  'context_present',
  'runtime_loaded',
] as const;
export type DeliveryConfirmation = (typeof DELIVERY_CONFIRMATIONS)[number];

/** Confirmations strong enough to record outcome=delivered. */
export const DELIVERED_CONFIRMATIONS: readonly DeliveryConfirmation[] = [
  'host_accepted',
  'context_present',
  'runtime_loaded',
];

export type InterventionDeliveryTarget = 'agent_context' | 'runtime_enforcement';

/** Phase 1 delivery outcomes. `unsupported` is a capability fact, not an attempt. */
export const DELIVERY_OUTCOMES = ['attempted', 'delivered', 'failed', 'unsupported'] as const;
export type InterventionDeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

// ── Application semantics (ADR-0027 §2.3, SPEC §13.4) ──────────────────────

export type InterventionApplicationProof = 'agent_claimed' | 'runtime_verified';

/**
 * Rule match, shadow evaluation and auto_correct PROPOSALS are deliberately
 * absent — none of them prove application (SPEC §13.4).
 */
export type InterventionApplicationAction =
  | 'self_reported' // agent_claimed only
  | 'tool_blocked' // runtime_verified only
  | 'auto_correct_applied'; // runtime_verified only

// ── Lifecycle states ────────────────────────────────────────────────────────

export type InterventionEpisodeStatus = 'open' | 'closed' | 'interrupted';
export type InterventionEffectStatus = 'observed' | 'disputed' | 'invalidated';
export type InterventionOutcomeSource = 'authorized_result_observation' | 'owner_feedback';

// ── Capability contract (ADR-0027 §2.4) ─────────────────────────────────────

export type InterventionCapabilityStatus = 'supported' | 'unsupported' | 'unknown';

export const INTERVENTION_CAPABILITIES = [
  'agent_context_delivery',
  'enforcement_delivery',
  'application_self_report',
  'application_runtime_verified',
  'behavior_observation',
  'outcome_observation',
] as const;
export type InterventionCapability = (typeof INTERVENTION_CAPABILITIES)[number];

// ── Reference snapshots ─────────────────────────────────────────────────────

/**
 * Content reference snapshot at observation time. A digest identifies
 * observed bytes; it never mints a Principle identity or grants approval
 * (ADR-0027 §2.2). `revision_reference_unresolved` is an explicit gap, not an
 * error to hide.
 */
export interface InterventionContentRef {
  principleId: string;
  artifactId?: string;
  version?: string;
  /** Missing only when resolution is revision_reference_unresolved. */
  payloadDigest?: string;
  approvalRef?: string;
  resolution: 'resolved' | 'revision_reference_unresolved';
}

/**
 * Activation occurrence snapshot. A reusable activation_id alone cannot
 * silently replace the historical activation associated with evidence
 * (ADR-0027 §2.2) — the observed source row is digested at record time.
 */
export interface InterventionActivationOccurrenceRef {
  activationId: string;
  idempotencyKey?: string;
  artifactId?: string;
  channel?: string;
  activatedAt?: string;
  sourceSnapshotDigest: string;
}

/** Native host identities available on the observed event. */
export interface InterventionNativeRefs {
  hostKind: 'openclaw' | 'codex';
  sessionId?: string;
  runId?: string;
  turnId?: string;
  toolCallId?: string;
  toolName?: string;
  rolloutIdentity?: string;
}

// ── Per-kind payloads (closed field sets) ───────────────────────────────────

export interface InterventionDeliveryPayload {
  targetKind: InterventionDeliveryTarget;
  confirmation: DeliveryConfirmation;
  outcome: InterventionDeliveryOutcome;
  /** Required when outcome=failed (explicit failure source). */
  failureReason?: string;
  /** Known non-attempt reason (e.g. budget exclusion) — never a runtime failure. */
  nonAttemptReason?: string;
  /** Required when outcome=unsupported — states the unsupported boundary. */
  unsupportedNote?: string;
}

export interface InterventionApplicationPayload {
  proofMethod: InterventionApplicationProof;
  action: InterventionApplicationAction;
  /** Bounded verbatim claim; required for agent_claimed, forbidden otherwise. */
  claimText?: string;
  /**
   * What the runtime_verified proof actually establishes (e.g.
   * 'pd_gate_block_returned'). Required for runtime_verified — states the
   * proof boundary instead of implying the host executed anything broader.
   */
  enforcementBoundary?: string;
}

export interface InterventionEpisodePayload {
  status: InterventionEpisodeStatus;
  /** Bounded description of the observed bounded action. */
  actionSummary: string;
  /** Sanitized bounded preview of the tool request / output event. */
  inputPreview?: string;
  resultSummary?: string;
}

export interface InterventionEffectPayload {
  status: InterventionEffectStatus;
  /** Bounded observation content. `observed` means the source contract was accepted — not that the Principle works. */
  observationSummary: string;
  /** Required when status=disputed|invalidated. Original fact stays recorded. */
  disputeReason?: string;
}

export interface InterventionOutcomePayload {
  outcomeSource: InterventionOutcomeSource;
  observationSummary: string;
  /** Owner's raw bounded feedback. An Owner report proves the Owner supplied it — nothing more (ADR-0027 §2.3). */
  feedbackText?: string;
  /** Server-side resolved owner identity; required for owner_feedback. */
  actorId?: string;
}

export type InterventionPayload =
  | InterventionDeliveryPayload
  | InterventionApplicationPayload
  | InterventionEpisodePayload
  | InterventionEffectPayload
  | InterventionOutcomePayload;

// ── Observation input (single record, pre-normalization) ────────────────────

export interface InterventionObservationInput {
  /**
   * Producer-minted stable key, generated ONCE and persisted in the raw
   * source (SPEC §13.3) — never re-minted per replay. Natural identity is
   * (sourceKind, sourceLocator, observationKey).
   */
  observationKey: string;
  /** Locator of the raw record within the source (file + line identity, table row id, …). */
  sourceLocator: string;
  kind: InterventionRecordKind;
  /** Occurrence time when the source supplies it. */
  occurredAt?: string;
  nativeRefs: InterventionNativeRefs;
  principleId?: string;
  contentRef?: InterventionContentRef;
  /** Source-known activation ID; this alone does not claim the occurrence is resolved. */
  activationId?: string;
  activationRef?: InterventionActivationOccurrenceRef;
  /** observationKey of the related record, when known — exact references only. */
  deliveryKey?: string;
  episodeKey?: string;
  effectKey?: string;
  /** evidenceId of the record this one corrects; requires correctionReason. */
  correctionOf?: string;
  correctionReason?: string;
  payload: InterventionPayload;
}

// ── Batch input (the single ingress entry shape) ────────────────────────────

export interface InterventionCapabilityDeclaration {
  hostKind: 'openclaw' | 'codex';
  capability: InterventionCapability;
  status: InterventionCapabilityStatus;
  adapterVersion: string;
  channel: string;
  /** Strongest confirmation this adapter can prove for delivery capabilities. */
  maxConfirmation?: DeliveryConfirmation;
  note?: string;
}

export interface InterventionEvidenceBatchInput {
  /** Established once per workspace ledger; retains the governance workspace scope. */
  evidenceScopeId: string;
  sourceKind: InterventionSourceKind;
  adapterVersion: string;
  recordedAt: string;
  observations: InterventionObservationInput[];
  /** Adapter capability facts; upserted declaratively, never inferred from gaps. */
  capabilityDeclarations?: InterventionCapabilityDeclaration[];
}

// ── Normalized record (post-normalization, what the store persists) ─────────

export interface NormalizedInterventionRecord {
  evidenceId: string;
  evidenceScopeId: string;
  sourceKind: InterventionSourceKind;
  observationKey: string;
  sourceLocator: string;
  kind: InterventionRecordKind;
  recordedAt: string;
  occurredAt?: string;
  nativeRefs: InterventionNativeRefs;
  principleId?: string;
  contentRef?: InterventionContentRef;
  /** Source-known activation ID; this alone does not claim the occurrence is resolved. */
  activationId?: string;
  activationRef?: InterventionActivationOccurrenceRef;
  deliveryKey?: string;
  episodeKey?: string;
  effectKey?: string;
  correctionOf?: string;
  correctionReason?: string;
  payload: InterventionPayload;
  /** Deterministic digest over the canonical record — idempotency/conflict anchor. */
  recordDigest: string;
}

// ── Audit read contract (SPEC §13.8 four queries) ───────────────────────────

export type InterventionAuditSelector =
  | { type: 'principle'; principleId: string }
  | { type: 'activation'; activationId: string }
  | { type: 'episode'; observationKey: string }
  | { type: 'effect'; observationKey: string };

export interface InterventionAuditRecordSummary {
  evidenceId: string;
  kind: InterventionRecordKind;
  observationKey: string;
  sourceKind: InterventionSourceKind;
  sourceLocator: string;
  recordedAt: string;
  occurredAt?: string;
  principleId?: string;
  activationId?: string;
  deliveryKey?: string;
  episodeKey?: string;
  effectKey?: string;
  correctionOf?: string;
  /** Exact source-time references; their resolution is not inferred from linked peer rows. */
  nativeRefs: InterventionNativeRefs;
  contentRef?: InterventionContentRef;
  activationRef?: InterventionActivationOccurrenceRef;
  /** Sensitive text fields were removed under the existing receipt retention boundary. */
  contentRedactedAt?: string;
  payload: InterventionPayload;
  recordDigest: string;
  /** Whether referenced peer records exist in the ledger at read time. */
  associationStatus: 'linked' | 'pending_association';
}

export interface InterventionAuditCursor {
  recordedAt: string;
  evidenceId: string;
}

export interface InterventionAuditKindPage {
  hasMore: boolean;
  nextCursor: InterventionAuditCursor | null;
}

export interface InterventionAuditRelations {
  selector: InterventionAuditSelector;
  deliveries: InterventionAuditRecordSummary[];
  applications: InterventionAuditRecordSummary[];
  episodes: InterventionAuditRecordSummary[];
  effects: InterventionAuditRecordSummary[];
  outcomes: InterventionAuditRecordSummary[];
  /** Independent per-kind bounds prevent a busy kind from starving another. */
  pages: Record<InterventionRecordKind, InterventionAuditKindPage>;
  /** Records whose references point at keys not (yet) present — explicit gaps. */
  unresolvedReferences: { evidenceId: string; missingKey: string; field: string }[];
  capabilityDeclarations: InterventionCapabilityDeclaration[];
  asOf: string;
}

// ── Field bounds (shared with the normalizer) ───────────────────────────────

export const INTERVENTION_TEXT_BOUNDS = {
  observationKey: 256,
  sourceLocator: 512,
  summary: 400,
  claimText: 200,
  feedbackText: 400,
  reason: 400,
  adapterVersion: 64,
  evidenceScopeId: 128,
} as const;
