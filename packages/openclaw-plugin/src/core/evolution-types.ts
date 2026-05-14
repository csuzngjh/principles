/**
 * Evolution Points System V2.0 - MVP
 *
 * Canonical definitions moved to @principles/core/runtime-v2/evolution/
 * This file re-exports everything for backward compatibility.
 *
 * NOTE: Principle → EvolutionPrinciple, PrincipleStatus → EvolutionPrincipleStatus
 *       to avoid collision with runtime-v2/types/principle-schema.ts Principle.
 *       Backward-compatible aliases are provided below.
 */

import type { TaskKind, TaskPriority } from './trajectory-types.js';

import type {
  EvolutionPrinciple as EvolutionPrincipleType,
  EvolutionPrincipleStatus as EvolutionPrincipleStatusType,
  EvolutionPrincipleSuggestedRule as EvolutionPrincipleSuggestedRuleType,
  EvolutionPrincipleValueMetricsSnapshot as EvolutionPrincipleValueMetricsSnapshotType,
  EvolutionPainDetectedData as EvolutionPainDetectedDataType,
} from '@principles/core/runtime-v2';

export {
  EvolutionTier,
  TIER_DEFINITIONS,
  getTierDefinition,
  getTierByPoints,
  TASK_DIFFICULTY_CONFIG,
  DEFAULT_EVOLUTION_CONFIG,
  isCompleteDetectorMetadata,
} from '@principles/core/runtime-v2';

export type {
  TierPermissions,
  TierDefinition,
  TaskDifficulty,
  TaskDifficultyConfig,
  EvolutionEventType,
  EvolutionEvent,
  EvolutionScorecard,
  EvolutionStats,
  EvolutionStorage,
  EvolutionConfig,
  ArchivedEventStats,
  GateDecision,
  ToolCallContext,
  TierPromotionEvent,
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

// ── V2 Queue Types (kept in plugin — depends on trajectory-types) ────────────

export type QueueStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled';
export type TaskResolution = 'marker_detected' | 'auto_completed_timeout' | 'failed_max_retries' | 'runtime_unavailable' | 'canceled' | 'late_marker_principle_created' | 'late_marker_no_principle' | 'stub_fallback' | 'skipped_thin_violation' | 'success' | 'failure' | 'skipped' | 'noise_classified';

export interface EvolutionQueueItem {
  id: string;
  taskKind: TaskKind;
  priority: TaskPriority;
  source: string;
  traceId?: string;
  task?: string;
  score: number;
  reason: string;
  timestamp: string;
  enqueued_at?: string;
  started_at?: string;
  completed_at?: string;
  assigned_session_key?: string;
  trigger_text_preview?: string;
  status: QueueStatus;
  resolution?: TaskResolution;
  session_id?: string;
  agent_id?: string;
  retryCount: number;
  maxRetries: number;
  lastError?: string;
  resultRef?: string;
}
