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
}

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
