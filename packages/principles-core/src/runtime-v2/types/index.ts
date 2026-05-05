/**
 * Type definitions barrel — principle tree domain types extracted from plugin (PRI-51).
 */

export type {
  PrinciplePriority,
  PrincipleScope,
  PrincipleEvaluability,
  RuleStatus,
  RuleType,
  ImplementationLifecycleState,
  ImplementationType,
  SampleClassification,
} from './principle-enums.js';

export type {
  Principle,
  Rule,
  Implementation,
} from './principle-schema.js';

export type {
  ArtifactKind,
  ArtifactLineageRecord,
} from './artifact-lineage.js';

export type {
  ReplayResult,
  ClassificationSummary,
  ReplayReport,
} from './replay-types.js';
