/**
 * Internalization module barrel — RuleHost contracts and helpers
 *
 * PRI-42: Pure domain contracts extracted from the plugin layer.
 * These types have zero infrastructure dependency and are reusable
 * by pd-cli and future non-OpenClaw hosts.
 */

// Contracts
export type {
  RuleHostInput,
  RuleHostDecision,
  RuleHostMeta,
  RuleHostResult,
  LoadedImplementation,
} from './rule-host-contracts.js';

// Helpers
export type { RuleHostHelpers } from './rule-host-helpers.js';
export { createRuleHostHelpers } from './rule-host-helpers.js';

// Internalization route model (PRI-43)
export type { InternalizationRouteKind, InternalizationRouteDecision } from './internalization-route.js';
export { decideInternalizationRoute } from './internalization-route.js';

// Template generation (PRI-44)
export type { PainPattern } from './template-generator.js';
export { generateFromTemplate } from './template-generator.js';

// Code validation (PRI-44)
export type { ValidationResult } from './rule-code-validator.js';
export { checkForbiddenPatterns } from './rule-code-validator.js';

// Compile result (PRI-44)
export type { CompileResult } from './compile-result.js';

// Decision merge (PRI-45)
export type { DecisionMergeLogger, RuleHostLogger } from './rule-host-evaluator.js';
export { mergeDecisions } from './rule-host-evaluator.js';

// Adapter interface (PRI-45)
export type { RuleHostImplementationProvider } from './rule-host-adapter.js';

// Lifecycle read model types (PRI-51)
export type {
  LifecycleClassificationTotals,
  RuleReplayEvidence,
  RuleLiveEvidence,
  RuleLineageEvidence,
  ImplementationLifecycleEvidence,
  RuleLifecycleEvidence,
  PrincipleLifecycleEvidence,
  LifecycleReadModel,
} from './lifecycle-types.js';

// Lifecycle metrics (PRI-52)
export type { RuleMetricResult, PrincipleAdherenceResult } from './lifecycle-metrics.js';
export { computeRuleMetrics, computePrincipleAdherence } from './lifecycle-metrics.js';

// Deprecated readiness (PRI-53)
export type { DeprecatedReadinessStatus, DeprecatedReadinessAssessment } from './deprecated-readiness.js';
export { assessDeprecatedReadiness } from './deprecated-readiness.js';

// Routing policy (PRI-54)
export type { LifecycleRoute, LifecycleRouteEvidenceSummary, LifecycleRouteRecommendation } from './routing-policy.js';
export { recommendLifecycleRoute } from './routing-policy.js';
