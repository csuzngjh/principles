/**
 * Trajectory domain type surface for the plugin.
 *
 * SINGLE HOME since PRI-774: all trajectory types live in
 * `@principles/core/trajectory-types` (principles-core/src/trajectory-types.ts).
 * This file is a compatibility re-export shim for existing plugin importers —
 * do NOT add new type definitions here.
 */

export type {
  AssistantTurnRecord,
  CorrectionExportMode,
  CorrectionSampleRecord,
  CorrectionSampleReviewStatus,
  DailyMetricRow,
  EvolutionEventInput,
  EvolutionEventRecord,
  EvolutionTaskFilters,
  EvolutionTaskInput,
  EvolutionTaskInputV2,
  EvolutionTaskRecord,
  RuleHostContextResult,
  RuleHostContextRow,
  RuleHostEvidenceRow,
  SignalConfirmationInput,
  SignalConfirmationRow,
  SignalConfirmationStatus,
  TrajectoryAssistantTurnInput,
  TrajectoryDataStats,
  TrajectoryDatabaseOptions,
  TrajectoryExportResult,
  TrajectoryGateBlockInput,
  TrajectoryPainEventInput,
  TrajectoryPrincipleEventInput,
  TrajectorySessionInput,
  TrajectoryTaskOutcomeInput,
  TrajectoryToolCallInput,
  TrajectoryTrustChangeInput,
  TrajectoryUserTurnInput,
  TaskKind,
  TaskPriority,
} from '@principles/core/trajectory-types';
