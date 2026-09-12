/**
 * Evolution domain type surface for the plugin.
 *
 * Canonical definitions live in @principles/core/runtime-v2 (evolution/).
 * This file keeps the plugin-facing backward-compatible aliases.
 *
 * NOTE: Principle → EvolutionPrinciple, PrincipleStatus → EvolutionPrincipleStatus
 *       to avoid collision with runtime-v2/types/principle-schema.ts Principle.
 *       Backward-compatible aliases are provided below.
 *
 * PRI-770: the Evolution Points/Tier re-exports (tiers, scorecards, storage /
 * config contracts) and the V2 queue item types were removed — their
 * subsystems were retired (PRI-737) and no consumer remained.
 */

import type {
  EvolutionPrinciple as EvolutionPrincipleType,
  EvolutionPrincipleStatus as EvolutionPrincipleStatusType,
  EvolutionPrincipleSuggestedRule as EvolutionPrincipleSuggestedRuleType,
  EvolutionPrincipleValueMetricsSnapshot as EvolutionPrincipleValueMetricsSnapshotType,
  EvolutionPainDetectedData as EvolutionPainDetectedDataType,
} from '@principles/core/runtime-v2';

export {
  isCompleteDetectorMetadata,
} from '@principles/core/runtime-v2';

export type {
  EvolutionPrincipleStatus,
  PrincipleEvaluatorLevel,
  Evaluability,
  PrincipleDetectorSpec,
  EvolutionPrinciple,
  EvolutionPrincipleSuggestedRule,
  EvolutionPrincipleValueMetricsSnapshot,
  EvolutionLoopEventType,
  EvolutionPainDetectedData,
  CandidateCreatedData,
  PrinciplePromotedData,
  PrincipleDeprecatedData,
  PrincipleRolledBackData,
  CircuitBreakerOpenedData,
  LegacyImportData,
  EvolutionLoopEvent,
} from '@principles/core/runtime-v2';

// ── Backward-compatible aliases ──────────────────────────────────────────────

/** @deprecated Use EvolutionPrinciple instead. Alias for backward compatibility. */
export type Principle = EvolutionPrincipleType;

/** @deprecated Use EvolutionPrincipleStatus instead. Alias for backward compatibility. */
export type PrincipleStatus = EvolutionPrincipleStatusType;

/** @deprecated Use EvolutionPrincipleSuggestedRule instead. Alias for backward compatibility. */
export type PrincipleSuggestedRule = EvolutionPrincipleSuggestedRuleType;

/** @deprecated Use EvolutionPrincipleValueMetricsSnapshot instead. Alias for backward compatibility. */
export type PrincipleValueMetricsSnapshot = EvolutionPrincipleValueMetricsSnapshotType;

/** @deprecated Use EvolutionPainDetectedData instead. Alias for backward compatibility. */
export type PainDetectedData = EvolutionPainDetectedDataType;
