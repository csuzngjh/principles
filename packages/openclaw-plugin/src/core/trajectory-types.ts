/**
 * Trajectory database type definitions.
 * 
 * PURPOSE: Track task outcomes, trust changes, and evolution progress over time.
 * USAGE: Insights, trends, and Phase 3 supporting evidence (where explicitly allowed).
 * NOT FOR: Control decisions, Phase 3 eligibility, or real-time operations.
 */

export type CorrectionSampleReviewStatus = 'pending' | 'approved' | 'rejected';
export type CorrectionExportMode = 'raw' | 'redacted';

export interface TrajectoryDataStats {
  dbPath: string;
  dbSizeBytes: number;
  assistantTurns: number;
  userTurns: number;
  toolCalls: number;
  painEvents: number;
  pendingSamples: number;
  approvedSamples: number;
  blobBytes: number;
  lastIngestAt: string | null;
}

export interface TrajectoryAssistantTurnInput {
  sessionId: string;
  runId: string;
  provider: string;
  model: string;
  rawText: string;
  sanitizedText: string;
  usageJson: unknown;
  empathySignalJson: unknown;
  createdAt?: string;
}

export interface TrajectoryUserTurnInput {
  sessionId: string;
  turnIndex: number;
  rawText: string;
  correctionDetected: boolean;
  correctionCue?: string | null;
  referencesAssistantTurnId?: number | null;
  createdAt?: string;
}

export interface TrajectoryToolCallInput {
  sessionId: string;
  toolName: string;
  outcome: 'success' | 'failure' | 'blocked';
  durationMs?: number | null;
  exitCode?: number | null;
  errorType?: string | null;
  errorMessage?: string | null;
  gfiBefore?: number | null;
  gfiAfter?: number | null;
  paramsJson?: unknown;
  createdAt?: string;
}

export interface TrajectoryPainEventInput {
  sessionId: string;
  source: string;
  score: number;
  reason?: string | null;
  severity?: string | null;
  origin?: string | null;
  confidence?: number | null;
  createdAt?: string;
}

export interface TrajectoryGateBlockInput {
  sessionId?: string | null;
  toolName: string;
  filePath?: string | null;
  reason: string;
  planStatus?: string | null;
  createdAt?: string;
}

type DailyMetricRow = {
  day: string;
  tool_calls: number;
  failures: number;
  user_corrections: number;
};

export interface TrajectoryTrustChangeInput {
  sessionId?: string | null;
  previousScore: number;
  newScore: number;
  delta: number;
  reason: string;
  createdAt?: string;
}

export interface TrajectoryPrincipleEventInput {
  principleId?: string | null;
  eventType: string;
  payload: unknown;
  createdAt?: string;
}

export interface TrajectoryTaskOutcomeInput {
  sessionId: string;
  taskId?: string | null;
  outcome: string;
  summary?: string | null;
  principleIdsJson?: unknown;
  createdAt?: string;
}

export interface TrajectorySessionInput {
  sessionId: string;
  startedAt?: string;
}

// V2: Task kind and priority types for queue schema
export type TaskKind = 'pain_diagnosis' | 'sleep_reflection' | 'model_eval';
export type TaskPriority = 'high' | 'medium' | 'low';

// V2: EvolutionTaskInput with all V2 fields
interface EvolutionTaskInputBase {
  taskId: string;
  traceId: string;
  source: string;
  reason?: string | null;
  score?: number;
  status?: string;
  enqueuedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  resolution?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface EvolutionTaskInputV2 extends EvolutionTaskInputBase {
  taskKind?: TaskKind;
  priority?: TaskPriority;
  retryCount?: number;
  maxRetries?: number;
  lastError?: string | null;
  resultRef?: string | null;
}

export type EvolutionTaskInput = EvolutionTaskInputV2;

export interface EvolutionEventInput {
  traceId: string;
  taskId?: string | null;
  stage: string;
  level?: string;
  message: string;
  summary?: string | null;
  metadata?: unknown;
  createdAt?: string;
}

export interface EvolutionTaskRecord {
  id: number;
  taskId: string;
  traceId: string;
  source: string;
  reason: string | null;
  score: number;
  status: string;
  enqueuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
  taskKind: TaskKind | null;
  priority: TaskPriority | null;
  retryCount: number | null;
  maxRetries: number | null;
  lastError: string | null;
  resultRef: string | null;
}

export interface EvolutionEventRecord {
  id: number;
  traceId: string;
  taskId: string | null;
  stage: string;
  level: string;
  message: string;
  summary: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface EvolutionTaskFilters {
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
}

export interface AssistantTurnRecord {
  id: number;
  sessionId: string;
  runId: string;
  provider: string;
  model: string;
  rawText: string;
  sanitizedText: string;
  blobRef: string | null;
  createdAt: string;
}

export interface CorrectionSampleRecord {
  sampleId: string;
  sessionId: string;
  badAssistantTurnId: number;
  userCorrectionTurnId: number;
  recoveryToolSpanJson: string;
  diffExcerpt: string;
  principleIdsJson: string;
  qualityScore: number;
  reviewStatus: CorrectionSampleReviewStatus;
  exportMode: CorrectionExportMode;
  createdAt: string;
  updatedAt: string;
}

export interface TrajectoryExportResult {
  filePath: string;
  count: number;
  mode?: CorrectionExportMode;
}

export interface TrajectoryDatabaseOptions {
  workspaceDir: string;
  blobInlineThresholdBytes?: number;
  busyTimeoutMs?: number;
  orphanBlobGraceDays?: number;
}

export type { DailyMetricRow };
