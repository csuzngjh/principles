/**
 * Principle tree leaf types — pure enums and value types.
 * Extracted from openclaw-plugin principle-tree-schema.ts + nocturnal-dataset.ts (PRI-51).
 */
import { Type } from '@sinclair/typebox';

// PRI-612: canonical PrincipleStatus authority. Every other representation
// (EvolutionPrincipleStatus, console models, Sets/validators) must DERIVE from
// PRINCIPLE_STATUSES — never re-type the literals.
export const PRINCIPLE_STATUSES = [
  'candidate',
  'active',
  'archived',
  'deprecated',
  'probation',
] as const;

export type PrincipleStatus = (typeof PRINCIPLE_STATUSES)[number];

export const PrincipleStatusSchema = Type.Union([
  ...PRINCIPLE_STATUSES.map((status) => Type.Literal(status)),
]);

export type PrinciplePriority = 'P0' | 'P1' | 'P2';

export const PrinciplePrioritySchema = Type.Union([
  Type.Literal('P0'),
  Type.Literal('P1'),
  Type.Literal('P2'),
]);

export type PrincipleScope = 'general' | 'domain' | 'scenario';

export const PrincipleScopeSchema = Type.Union([
  Type.Literal('general'),
  Type.Literal('domain'),
  Type.Literal('scenario'),
]);

export type PrincipleEvaluability =
  | 'manual_only'
  | 'deterministic'
  | 'weak_heuristic';

export const PrincipleEvaluabilitySchema = Type.Union([
  Type.Literal('manual_only'),
  Type.Literal('deterministic'),
  Type.Literal('weak_heuristic'),
]);

export type RuleStatus =
  | 'proposed'
  | 'implemented'
  | 'enforced'
  | 'retired';

export const RuleStatusSchema = Type.Union([
  Type.Literal('proposed'),
  Type.Literal('implemented'),
  Type.Literal('enforced'),
  Type.Literal('retired'),
]);

export type RuleType =
  | 'hook'
  | 'gate'
  | 'skill'
  | 'lora'
  | 'test'
  | 'prompt';

export const RuleTypeSchema = Type.Union([
  Type.Literal('hook'),
  Type.Literal('gate'),
  Type.Literal('skill'),
  Type.Literal('lora'),
  Type.Literal('test'),
  Type.Literal('prompt'),
]);

export type ImplementationLifecycleState =
  | 'candidate'
  | 'active'
  | 'disabled'
  | 'archived';

export const ImplementationLifecycleStateSchema = Type.Union([
  Type.Literal('candidate'),
  Type.Literal('active'),
  Type.Literal('disabled'),
  Type.Literal('archived'),
]);

export type ImplementationType = 'code' | 'skill' | 'lora' | 'test' | 'prompt';

export const ImplementationTypeSchema = Type.Union([
  Type.Literal('code'),
  Type.Literal('skill'),
  Type.Literal('lora'),
  Type.Literal('test'),
  Type.Literal('prompt'),
]);

export type SampleClassification =
  | 'pain-negative'
  | 'success-positive'
  | 'principle-anchor';

export const SampleClassificationSchema = Type.Union([
  Type.Literal('pain-negative'),
  Type.Literal('success-positive'),
  Type.Literal('principle-anchor'),
]);
