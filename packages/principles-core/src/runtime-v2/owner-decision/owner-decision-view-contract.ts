/**
 * OwnerDecisionViewCore contract — Owner Decision Experience v1 (SPEC §7).
 *
 * READ PROJECTION ONLY. This module defines the canonical Owner-facing read
 * contract and its input facts. It is NOT:
 *   - a new persisted state machine (decision_state is derived per read);
 *   - an authorization token (mutation services re-validate every write);
 *   - a global atomic snapshot (`source_read_status=complete` means only that
 *     the sources THIS view requested were read successfully).
 *
 * Pure contract: no I/O. The collector side (Console server model) gathers
 * facts; `deriveOwnerDecisionView` (owner-decision-view.ts) derives the view.
 */
import { Type, type Static } from '@sinclair/typebox';
import { GovernanceTimestampSchema } from '../governance-timestamp-schema.js';

const NonEmptyString = Type.String({ minLength: 1 });
const Timestamp = GovernanceTimestampSchema;

// ── §7.1 provenance primitives ───────────────────────────────────────────────

export const ClaimClassSchema = Type.Union([
  Type.Literal('observed_fact'),
  Type.Literal('pd_interpretation'),
  Type.Literal('proposed_behavior'),
  Type.Literal('system_state'),
]);
export type ClaimClass = Static<typeof ClaimClassSchema>;

export const ProducerRefSchema = Type.Union([
  Type.Object({ status: Type.Literal('known'), value: NonEmptyString }, { additionalProperties: false }),
  Type.Object({ status: Type.Literal('unknown'), reasonCode: NonEmptyString }, { additionalProperties: false }),
]);
export type ProducerRef = Static<typeof ProducerRefSchema>;

export const SourceRelationSchema = Type.Union([
  Type.Literal('exact_id'),
  Type.Literal('derived_relation'),
  Type.Literal('heuristic'),
  Type.Literal('unknown'),
]);
export type SourceRelation = Static<typeof SourceRelationSchema>;

export const OwnerSourceKindSchema = Type.Union([
  Type.Literal('ledger'), Type.Literal('candidate'), Type.Literal('generic_artifact'),
  Type.Literal('run'), Type.Literal('pi_artifact'), Type.Literal('task'), Type.Literal('pain'),
  Type.Literal('user_turn'), Type.Literal('assistant_turn'), Type.Literal('correction_sample'),
  Type.Literal('approval'), Type.Literal('activation'), Type.Literal('decision'),
  Type.Literal('application'), Type.Literal('evidence_snapshot'),
]);
export type OwnerSourceKind = Static<typeof OwnerSourceKindSchema>;

export const OwnerSourceRefSchema = Type.Object({
  kind: OwnerSourceKindSchema,
  id: NonEmptyString,
  fieldPath: Type.String(),
  relation: SourceRelationSchema,
  claimClass: ClaimClassSchema,
  producer: ProducerRefSchema,
  recordedAt: Type.Optional(Timestamp),
  capturedAt: Timestamp,
  truncated: Type.Boolean(),
});
export type OwnerSourceRef = Static<typeof OwnerSourceRefSchema>;

export const ReasonSchema = Type.Object({
  code: NonEmptyString,
  ownerText: NonEmptyString,
  sourceRefs: Type.Array(OwnerSourceRefSchema),
});
export type Reason = Static<typeof ReasonSchema>;

// ── §7.3 semantic types: narrative primitives ───────────────────────────────

export const NarrativeItemSchema = Type.Object({
  text: NonEmptyString,
  claimClass: ClaimClassSchema,
  sourceRefs: Type.Array(OwnerSourceRefSchema, { minItems: 1 }),
});
export type NarrativeItem = Static<typeof NarrativeItemSchema>;

export const NarrativeSchema = Type.Object({ items: Type.Array(NarrativeItemSchema) });
export type Narrative = Static<typeof NarrativeSchema>;

// ── §7.1 Field<T> envelope ──────────────────────────────────────────────────
//
// `known` with an empty array value means the source explicitly provided an
// empty list — never "no risk/no exceptions". `unknown` carries no fabricated
// value. `not_applicable` requires positive evidence.

export const StringFieldSchema = Type.Union([
  Type.Object({
    status: Type.Literal('known'),
    value: NonEmptyString,
    provenance: Type.Array(OwnerSourceRefSchema, { minItems: 1 }),
    warnings: Type.Array(ReasonSchema),
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal('unknown'),
    reason: ReasonSchema,
    provenance: Type.Array(OwnerSourceRefSchema),
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal('not_applicable'),
    reason: ReasonSchema,
    provenance: Type.Array(OwnerSourceRefSchema, { minItems: 1 }),
  }, { additionalProperties: false }),
]);
export type StringField = Static<typeof StringFieldSchema>;

export const NumberFieldSchema = Type.Union([
  Type.Object({
    status: Type.Literal('known'),
    value: Type.Integer({ minimum: 0 }),
    provenance: Type.Array(OwnerSourceRefSchema, { minItems: 1 }),
    warnings: Type.Array(ReasonSchema),
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal('unknown'),
    reason: ReasonSchema,
    provenance: Type.Array(OwnerSourceRefSchema),
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal('not_applicable'),
    reason: ReasonSchema,
    provenance: Type.Array(OwnerSourceRefSchema, { minItems: 1 }),
  }, { additionalProperties: false }),
]);
export type NumberField = Static<typeof NumberFieldSchema>;

export const NarrativeListFieldSchema = Type.Union([
  Type.Object({
    status: Type.Literal('known'),
    value: Type.Array(NarrativeItemSchema),
    provenance: Type.Array(OwnerSourceRefSchema, { minItems: 1 }),
    warnings: Type.Array(ReasonSchema),
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal('unknown'),
    reason: ReasonSchema,
    provenance: Type.Array(OwnerSourceRefSchema),
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal('not_applicable'),
    reason: ReasonSchema,
    provenance: Type.Array(OwnerSourceRefSchema, { minItems: 1 }),
  }, { additionalProperties: false }),
]);
export type NarrativeListField = Static<typeof NarrativeListFieldSchema>;
export const NarrativeFieldSchema = NarrativeListFieldSchema;
export type NarrativeField = NarrativeListField;

export const PrincipleTextSchema = Type.Object({
  text: NonEmptyString,
  sourceTier: Type.Union([
    Type.Literal('scribe'), Type.Literal('distiller'),
    Type.Literal('philosopher'), Type.Literal('candidate_principle'),
  ]),
  selectionMode: Type.Union([Type.Literal('whole_field'), Type.Literal('extracted_sentence')]),
  selectionReason: NonEmptyString,
  sourceVersion: NonEmptyString,
  decisionArtifactRef: Type.Optional(OwnerSourceRefSchema),
});
export type PrincipleText = Static<typeof PrincipleTextSchema>;

export const RiskSummarySchema = Type.Object({
  items: Type.Array(NarrativeItemSchema),
  completeness: Type.Union([Type.Literal('partial'), Type.Literal('not_assessed')]),
});
export type RiskSummary = Static<typeof RiskSummarySchema>;

export const EnforcementItemSchema = Type.Object({
  activationRef: OwnerSourceRefSchema,
  artifactRef: Type.Optional(OwnerSourceRefSchema),
  channel: Type.Union([
    Type.Literal('prompt'), Type.Literal('code_tool_hook'), Type.Literal('defer_archive'),
  ]),
  effectKind: Type.Union([
    Type.Literal('context_guidance'), Type.Literal('runtime_rule'), Type.Literal('non_enforcing_outcome'),
  ]),
  mode: StringFieldSchema,
  active: Type.Boolean(),
  since: StringFieldSchema,
});
export type EnforcementItem = Static<typeof EnforcementItemSchema>;

export const EnforcementSummarySchema = Type.Object({
  state: Type.Union([
    Type.Literal('none'), Type.Literal('active'),
    Type.Literal('partially_active'), Type.Literal('deactivated'),
  ]),
  items: Type.Array(EnforcementItemSchema),
});
export type EnforcementSummary = Static<typeof EnforcementSummarySchema>;

export const EvidenceSummarySchema = Type.Object({
  ownerExplanation: NonEmptyString,
  sourceAvailability: StringFieldSchema,
  retainedBehaviorCount: NumberFieldSchema,
  sourceReferenceCount: NumberFieldSchema,
  governanceLineage: StringFieldSchema,
  promotionSufficiency: StringFieldSchema,
  observation: Type.Object({
    deterministicEffects: NumberFieldSchema,
    selfReportedEffects: NumberFieldSchema,
    contextPresence: NumberFieldSchema,
    window: StringFieldSchema,
    recentExamples: Type.Array(NarrativeItemSchema),
  }),
});
export type EvidenceSummary = Static<typeof EvidenceSummarySchema>;

export const CapabilitySchema = Type.Object({
  targetRef: OwnerSourceRefSchema,
  actionKey: NonEmptyString,
  scope: NonEmptyString,
  limitation: NonEmptyString,
  successfulPastReceipt: Type.Optional(OwnerSourceRefSchema),
});
export type Capability = Static<typeof CapabilitySchema>;

export const RollbackSummarySchema = Type.Object({
  stopFuture: NarrativeListFieldSchema,
  restoreConfiguration: NarrativeListFieldSchema,
  undoPastExternalEffects: NarrativeListFieldSchema,
  ownerText: NonEmptyString,
});
export type RollbackSummary = Static<typeof RollbackSummarySchema>;

// ── §7.4 decision machinery ─────────────────────────────────────────────────

export const MaterialGateItemSchema = Type.Object({
  key: Type.Union([
    Type.Literal('target_identity'), Type.Literal('human_readable_subject'),
    Type.Literal('expected_consequence'), Type.Literal('current_revision'),
    Type.Literal('action_specific_requirement'),
  ]),
  status: Type.Union([Type.Literal('satisfied'), Type.Literal('missing'), Type.Literal('conflicting')]),
  ownerText: NonEmptyString,
  sourceRefs: Type.Array(OwnerSourceRefSchema),
});
export type MaterialGateItem = Static<typeof MaterialGateItemSchema>;

export const DecisionMaterialGateSchema = Type.Object({
  actionSemantic: NonEmptyString,
  status: Type.Union([Type.Literal('ready'), Type.Literal('blocked')]),
  requiredItems: Type.Array(MaterialGateItemSchema),
});
export type DecisionMaterialGate = Static<typeof DecisionMaterialGateSchema>;

export const DecisionSubjectSchema = Type.Object({
  key: NonEmptyString,
  targetRefs: Type.Array(OwnerSourceRefSchema),
  channel: Type.Union([
    Type.Literal('prompt'), Type.Literal('code_tool_hook'), Type.Literal('defer_archive'),
  ]),
  /** The artifact id this subject decides on (revision anchor). */
  revisionArtifactId: StringFieldSchema,
  /** pending | approved | rejected | cancelled — the subject's durable state. */
  state: Type.Union([
    Type.Literal('pending'), Type.Literal('approved'), Type.Literal('rejected'), Type.Literal('cancelled'),
  ]),
  reason: ReasonSchema,
  materialGates: Type.Array(DecisionMaterialGateSchema),
  /**
   * Fix 1 (review P1): subject-SCOPED decision material. Approval decisions
   * are made on artifact+channel — the material shown for this subject must
   * come from THIS subject's own revision (its scribe statement/rationale, or
   * the candidate-wide tier when the selected material is not
   * revision-scoped). Never borrowed from another revision's pending
   * subject. The principle-level `learnedPrinciple` on the view remains the
   * Library/overview summary only.
   */
  decisionMaterial: Type.Object({
    learnedPrinciple: NarrativeFieldSchema,
    rationale: NarrativeFieldSchema,
    consequence: NarrativeFieldSchema,
  }, { additionalProperties: false }),
});
export type DecisionSubject = Static<typeof DecisionSubjectSchema>;

export const ActionSchema = Type.Object({
  key: NonEmptyString,
  semantic: NonEmptyString,
  label: NonEmptyString,
  targetRefs: Type.Array(OwnerSourceRefSchema, { minItems: 1 }),
  serviceOperation: NonEmptyString,
  channel: Type.String(),
  assessedAt: Timestamp,
  requirements: Type.Array(Type.Object({
    name: NonEmptyString,
    ownerText: NonEmptyString,
    required: Type.Boolean(),
  })),
  expectedConsequence: NarrativeFieldSchema,
  confirmation: Type.Object({ required: Type.Boolean(), text: NonEmptyString }),
  sourceRefs: Type.Array(OwnerSourceRefSchema, { minItems: 1 }),
});
export type Action = Static<typeof ActionSchema>;

export const BlockerSchema = Type.Object({
  subjectKey: NonEmptyString,
  actionSemantic: Type.Union([NonEmptyString, Type.Literal('judgment')]),
  kind: Type.Union([
    Type.Literal('data'), Type.Literal('authorization'),
    Type.Literal('safety'), Type.Literal('runtime'), Type.Literal('unsupported'),
  ]),
  reason: ReasonSchema,
  requiredAudience: Type.Union([
    Type.Literal('owner'), Type.Literal('operator'), Type.Literal('system'),
  ]),
});
export type Blocker = Static<typeof BlockerSchema>;

export const NextActionSchema = Type.Object({
  code: Type.Union([
    Type.Literal('review'), Type.Literal('wait'), Type.Literal('inspect_data'),
    Type.Literal('inspect_recovery'), Type.Literal('monitor'), Type.Literal('none'),
  ]),
  ownerText: NonEmptyString,
  targetRefs: Type.Array(OwnerSourceRefSchema),
  actionKey: Type.Optional(NonEmptyString),
});
export type NextAction = Static<typeof NextActionSchema>;

// ── §7.2 OwnerDecisionViewCore ──────────────────────────────────────────────

export const SourceReadStatusSchema = Type.Union([Type.Literal('complete'), Type.Literal('partial')]);

export const SourceReadSchema = Type.Object({
  source: NonEmptyString,
  status: Type.Union([
    Type.Literal('available'), Type.Literal('unavailable'), Type.Literal('not_requested'),
  ]),
  capturedAt: Timestamp,
  scope: NonEmptyString,
  reason: Type.Optional(NonEmptyString),
});
export type SourceRead = Static<typeof SourceReadSchema>;

export const InboxPlacementSchema = Type.Object({
  group: Type.Union([
    Type.Literal('decision'), Type.Literal('blocked'),
    Type.Literal('recovery'), Type.Literal('none'),
  ]),
  attention: Type.Union([
    Type.Literal('individual'), Type.Literal('aggregate'), Type.Literal('none'),
  ]),
  reason: ReasonSchema,
});
export type InboxPlacement = Static<typeof InboxPlacementSchema>;

export const TechnicalDetailsSchema = Type.Object({
  available: Type.Boolean(),
  links: Type.Array(Type.Object({
    kind: NonEmptyString,
    target: NonEmptyString,
    reason: NonEmptyString,
  })),
  warnings: Type.Array(ReasonSchema),
});
export type TechnicalDetails = Static<typeof TechnicalDetailsSchema>;

export const DecisionStateSchema = Type.Union([
  Type.Literal('needs_owner_decision'), Type.Literal('processing'), Type.Literal('blocked'),
  Type.Literal('recovery_needed'), Type.Literal('decided'), Type.Literal('no_action'),
]);
export type DecisionState = Static<typeof DecisionStateSchema>;

export const OwnerDecisionViewCoreSchema = Type.Object({
  schemaVersion: Type.Literal('1'),
  principleId: NonEmptyString,
  asOf: Timestamp,
  sourceReadStatus: SourceReadStatusSchema,
  sourceReads: Type.Array(SourceReadSchema),
  incidentSummary: NarrativeFieldSchema,
  learnedPrinciple: Type.Union([
    Type.Object({
      status: Type.Literal('known'),
      value: PrincipleTextSchema,
      provenance: Type.Array(OwnerSourceRefSchema, { minItems: 1 }),
      warnings: Type.Array(ReasonSchema),
    }, { additionalProperties: false }),
    Type.Object({
      status: Type.Literal('unknown'),
      reason: ReasonSchema,
      provenance: Type.Array(OwnerSourceRefSchema),
    }, { additionalProperties: false }),
  ]),
  rationale: NarrativeFieldSchema,
  applicability: NarrativeListFieldSchema,
  nonApplicabilityOrUnknown: NarrativeListFieldSchema,
  expectedBehavior: NarrativeFieldSchema,
  currentEnforcement: Type.Object({
    status: Type.Union([Type.Literal('known'), Type.Literal('unknown')]),
    value: Type.Optional(EnforcementSummarySchema),
    reason: Type.Optional(ReasonSchema),
    provenance: Type.Array(OwnerSourceRefSchema),
    warnings: Type.Array(ReasonSchema),
  }),
  evidenceSummary: Type.Object({
    status: Type.Union([Type.Literal('known'), Type.Literal('unknown')]),
    value: Type.Optional(EvidenceSummarySchema),
    reason: Type.Optional(ReasonSchema),
    provenance: Type.Array(OwnerSourceRefSchema),
    warnings: Type.Array(ReasonSchema),
  }),
  uncertainty: NarrativeListFieldSchema,
  risk: Type.Object({
    status: Type.Union([Type.Literal('known'), Type.Literal('unknown')]),
    value: Type.Optional(RiskSummarySchema),
    reason: Type.Optional(ReasonSchema),
    provenance: Type.Array(OwnerSourceRefSchema),
    warnings: Type.Array(ReasonSchema),
  }),
  rollback: Type.Object({
    status: Type.Union([Type.Literal('known'), Type.Literal('unknown')]),
    value: Type.Optional(RollbackSummarySchema),
    reason: Type.Optional(ReasonSchema),
    provenance: Type.Array(OwnerSourceRefSchema),
    warnings: Type.Array(ReasonSchema),
  }),
  decisionState: DecisionStateSchema,
  decisionSubjects: Type.Array(DecisionSubjectSchema),
  availableActions: Type.Array(ActionSchema),
  blockers: Type.Array(BlockerSchema),
  nextAction: NextActionSchema,
  inbox: InboxPlacementSchema,
  technicalDetails: TechnicalDetailsSchema,
});
export type OwnerDecisionViewCore = Static<typeof OwnerDecisionViewCoreSchema>;

export { NonEmptyString as OwnerNonEmptyStringSchema, Timestamp as OwnerTimestampSchema };
