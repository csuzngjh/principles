/**
 * pd trajectory locate — Locate a trajectory by various criteria.
 *
 * Usage:
 *   pd trajectory locate --task <taskId>
 *   pd trajectory locate --run <runId>
 *   pd trajectory locate --pain <painId>
 *   pd trajectory locate --from <date> --to <date>
 *   pd trajectory locate --status <executionStatus>
 */
import { SqliteConnection, SqliteTrajectoryLocator } from '@principles/core';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface TrajectoryLocateOptions {
  task?: string;
  run?: string;
  pain?: string;
  from?: string;
  to?: string;
  status?: string;
  json?: boolean;
}

export async function handleTrajectoryLocate(opts: TrajectoryLocateOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir();
  const connection = new SqliteConnection(workspaceDir);

  try {
    const locator = new SqliteTrajectoryLocator(connection);

    let query: Record<string, unknown> = {};

    if (opts.task) query = { taskId: opts.task };
    else if (opts.run) query = { runId: opts.run };
    else if (opts.pain) query = { painId: opts.pain };
    else if (opts.from || opts.to) query = { timeRangeStart: opts.from, timeRangeEnd: opts.to };
    else if (opts.status) query = { executionStatus: opts.status };
    else {
      console.error('Error: specify at least one search criterion (--task, --run, --pain, --from/--to, --status)');
      process.exit(1);
    }

    const result = await locator.locate(query);

    if (result.candidates.length === 0) {
      console.log('No trajectories found.');
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`\nTrajectories (${result.candidates.length}):\n`);
    for (const candidate of result.candidates) {
      const runCount = candidate.runIds.length;
      console.log(
        '  %s  confidence=%.1f  runs=%d  task=%s',
        candidate.trajectoryRef.substring(0, 36),
        candidate.confidence,
        runCount,
        candidate.taskId.substring(0, 22),
      );
    }
    console.log('');
  } finally {
    connection.close();
  }
}
