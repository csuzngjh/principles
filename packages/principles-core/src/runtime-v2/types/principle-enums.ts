/**
 * Principle tree leaf types — pure enums and value types.
 * Extracted from openclaw-plugin principle-tree-schema.ts + nocturnal-dataset.ts (PRI-51).
 */

export type PrincipleStatus =
  | 'candidate'
  | 'active'
  | 'archived'
  | 'deprecated'
  | 'probation';

export type PrinciplePriority = 'P0' | 'P1' | 'P2';

export type PrincipleScope = 'general' | 'domain';

export type PrincipleEvaluability =
  | 'manual_only'
  | 'deterministic'
  | 'weak_heuristic';

export type RuleStatus =
  | 'proposed'
  | 'implemented'
  | 'enforced'
  | 'retired';

export type RuleType =
  | 'hook'
  | 'gate'
  | 'skill'
  | 'lora'
  | 'test'
  | 'prompt';

export type ImplementationLifecycleState =
  | 'candidate'
  | 'active'
  | 'disabled'
  | 'archived';

export type ImplementationType = 'code' | 'skill' | 'lora' | 'test' | 'prompt';

export type SampleClassification =
  | 'pain-negative'
  | 'success-positive'
  | 'principle-anchor';
