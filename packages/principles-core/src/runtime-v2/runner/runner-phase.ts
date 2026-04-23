/**
 * Internal execution phases for DiagnosticianRunner.
 *
 * Per CONTEXT.md D-01: Phase-based step pipeline.
 * These phases are runner-local tracking, NOT persisted to TaskStore.
 * Only PDTaskStatus values (pending/leased/succeeded/retry_wait/failed) are persisted.
 */
export enum RunnerPhase {
  Idle = 'idle',
  BuildingContext = 'building_context',
  CreatingRun = 'creating_run',
  Invoking = 'invoking',
  Polling = 'polling',
  FetchingOutput = 'fetching_output',
  Validating = 'validating',
  Completed = 'completed',
  Failed = 'failed',
}
