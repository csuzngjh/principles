/**
 * Principle tree schema — rich domain model interfaces.
 * Extracted from openclaw-plugin principle-tree-schema.ts (PRI-51).
 * These are the full-featured versions matching the plugin's schema,
 * used by lifecycle computation modules (PRI-52/53/54).
 */
import { Type, type Static } from '@sinclair/typebox';
import type {
  PrincipleStatus,
  PrinciplePriority,
  PrincipleScope,
  PrincipleEvaluability,
  RuleStatus,
  RuleType,
  ImplementationLifecycleState,
  ImplementationType,
} from './principle-enums.js';
import {
  PrincipleStatusSchema,
  PrinciplePrioritySchema,
  PrincipleScopeSchema,
  PrincipleEvaluabilitySchema,
  RuleStatusSchema,
  RuleTypeSchema,
  ImplementationLifecycleStateSchema,
  ImplementationTypeSchema,
} from './principle-enums.js';

/**
 * Who took a reuse decision (PRI-917, SPEC v0.2.1 §11/§12). The same shape as
 * the decision-exchange contract's actor so the verdict and the evidence it
 * produced cannot disagree about who decided.
 */
export interface ReuseEvidenceActor {
  kind: 'owner' | 'ai_owner';
  id: string;
}

/**
 * One durable REUSE resolution (PRI-917 PR3B, SPEC v0.2.1 §12): a Candidate —
 * and the Pain behind it — was resolved into the ENCLOSING Principle instead of
 * creating a new one. The relation target is the enclosing Principle.id by
 * construction and is deliberately NOT repeated inside the entry, so it cannot
 * drift from its parent.
 *
 * Append-only (INV-R05): entries are never rewritten or removed. `decisionId`
 * is an optional correlation id only — never an identity, never a second SSOT.
 */
export interface ReuseEvidenceEntry {
  painId: string;
  candidateId: string;
  decision: 'reuse';
  actor: ReuseEvidenceActor;
  reason: string;
  decidedAt: string;
  decisionId?: string;
}

export interface Principle {
  id: string;
  version: number;
  text: string;
  coreAxiomId?: string;
  triggerPattern: string;
  action: string;
  status: PrincipleStatus;
  priority: PrinciplePriority;
  scope: PrincipleScope;
  domain?: string;
  evaluability: PrincipleEvaluability;
  valueScore: number;
  adherenceRate: number;
  painPreventedCount: number;
  lastPainPreventedAt?: string;
  derivedFromPainIds: string[];
  ruleIds: string[];
  conflictsWithPrincipleIds: string[];
  supersedesPrincipleId?: string;
  createdAt: string;
  updatedAt: string;
  deprecatedAt?: string;
  deprecatedReason?: string;
  compilationRetryCount?: number;
  /**
   * Reuse evidence accumulated by explicit Owner/AI-Owner REUSE decisions
   * (PRI-917, SPEC v0.2.1 §12). Additive and optional: absent on every
   * pre-existing entry, read as [] by consumers. Written only by
   * appendReuseEvidence — never by the intake path, and never by rewriting
   * `derivedFromPainIds`, which keeps its candidate-provenance/idempotency
   * semantics untouched.
   */
  reuseEvidence?: ReuseEvidenceEntry[];
}

export const ReuseEvidenceActorSchema = Type.Object({
  kind: Type.Union([Type.Literal('owner'), Type.Literal('ai_owner')]),
  id: Type.String(),
});

export const ReuseEvidenceEntrySchema = Type.Object({
  painId: Type.String(),
  candidateId: Type.String(),
  decision: Type.Literal('reuse'),
  actor: ReuseEvidenceActorSchema,
  reason: Type.String(),
  decidedAt: Type.String(),
  decisionId: Type.Optional(Type.String()),
});

export const PrincipleSchema = Type.Object({
  id: Type.String(),
  version: Type.Number(),
  text: Type.String(),
  coreAxiomId: Type.Optional(Type.String()),
  triggerPattern: Type.String(),
  action: Type.String(),
  status: PrincipleStatusSchema,
  priority: PrinciplePrioritySchema,
  scope: PrincipleScopeSchema,
  domain: Type.Optional(Type.String()),
  evaluability: PrincipleEvaluabilitySchema,
  valueScore: Type.Number(),
  adherenceRate: Type.Number(),
  painPreventedCount: Type.Number(),
  lastPainPreventedAt: Type.Optional(Type.String()),
  derivedFromPainIds: Type.Array(Type.String()),
  ruleIds: Type.Array(Type.String()),
  conflictsWithPrincipleIds: Type.Array(Type.String()),
  supersedesPrincipleId: Type.Optional(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  deprecatedAt: Type.Optional(Type.String()),
  deprecatedReason: Type.Optional(Type.String()),
  compilationRetryCount: Type.Optional(Type.Number()),
  reuseEvidence: Type.Optional(Type.Array(ReuseEvidenceEntrySchema)),
});
export type PrincipleStatic = Static<typeof PrincipleSchema>;

export interface Rule {
  id: string;
  version: number;
  name: string;
  description: string;
  type: RuleType;
  triggerCondition: string;
  enforcement: 'block' | 'warn' | 'log';
  action: string;
  principleId: string;
  parentRuleId?: string;
  status: RuleStatus;
  coverageRate: number;
  falsePositiveRate: number;
  implementationPath?: string;
  testPath?: string;
  createdAt: string;
  updatedAt: string;
}

export const RuleSchema = Type.Object({
  id: Type.String(),
  version: Type.Number(),
  name: Type.String(),
  description: Type.String(),
  type: RuleTypeSchema,
  triggerCondition: Type.String(),
  enforcement: Type.Union([Type.Literal('block'), Type.Literal('warn'), Type.Literal('log')]),
  action: Type.String(),
  principleId: Type.String(),
  parentRuleId: Type.Optional(Type.String()),
  status: RuleStatusSchema,
  coverageRate: Type.Number(),
  falsePositiveRate: Type.Number(),
  implementationPath: Type.Optional(Type.String()),
  testPath: Type.Optional(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type RuleStatic = Static<typeof RuleSchema>;

export interface Implementation {
  id: string;
  ruleId: string;
  type: ImplementationType;
  path: string;
  version: string;
  coversCondition: string;
  coveragePercentage: number;
  lifecycleState: ImplementationLifecycleState;
  previousActive?: string;
  disabledAt?: string;
  disabledBy?: string;
  disabledReason?: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export const ImplementationSchema = Type.Object({
  id: Type.String(),
  ruleId: Type.String(),
  type: ImplementationTypeSchema,
  path: Type.String(),
  version: Type.String(),
  coversCondition: Type.String(),
  coveragePercentage: Type.Number(),
  lifecycleState: ImplementationLifecycleStateSchema,
  previousActive: Type.Optional(Type.String()),
  disabledAt: Type.Optional(Type.String()),
  disabledBy: Type.Optional(Type.String()),
  disabledReason: Type.Optional(Type.String()),
  archivedAt: Type.Optional(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type ImplementationStatic = Static<typeof ImplementationSchema>;
