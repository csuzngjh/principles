/**
 * TrajectoryLocator -- abstract interface for trajectory locate operations.
 *
 * A "trajectory" is a group of runs for a single task. The
 * TrajectoryCandidate.trajectoryRef maps to the taskId. When locating by runId,
 * the locator finds the run's task_id, then returns all runs for that task as a
 * single trajectory.
 *
 * All trajectory locate operations go through this interface, enabling
 * swap between SQLite (default) and test doubles.
 */
import type { TrajectoryLocateQuery, TrajectoryLocateResult } from '../context-payload.js';

export interface TrajectoryLocator {
  /**
   * Locate trajectories matching the given query.
   *
   * The query may contain one or more criteria. Supported modes:
   *   - painId: exact match on run.run_id (treated as trajectory identifier)
   *   - taskId: find all runs for task via idx_runs_task_id
   *   - runId: find run, then return all runs for its task_id
   *   - timeRange: query runs.started_at BETWEEN start AND end, group by task_id
   *   - sessionId + workspace: PD-managed hints, workspace-scoped
   *   - executionStatus: filter runs by status via idx_runs_status
   *
   * Returns TrajectoryLocateResult with candidates array.
   * No match -> empty candidates, never throws.
   */
  locate(query: TrajectoryLocateQuery): Promise<TrajectoryLocateResult>;
}
