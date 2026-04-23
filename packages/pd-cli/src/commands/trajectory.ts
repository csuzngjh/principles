/**
 * pd trajectory locate — Locate a trajectory by task ID, run ID, or time range.
 *
 * Usage:
 *   pd trajectory locate --task <taskId> --workspace <path>
 *   pd trajectory locate --run <runId> --workspace <path>
 *   pd trajectory locate --from <date> --to <date> --workspace <path>
 */
import { SqliteConnection, SqliteTrajectoryLocator } from '@principles/core';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface TrajectoryLocateOptions {
  task?: string;
  run?: string;
  from?: string;
  to?: string;
  json?: boolean;
  workspace?: string;
}

export async function handleTrajectoryLocate(opts: TrajectoryLocateOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const connection = new SqliteConnection(workspaceDir);

  try {
    const locator = new SqliteTrajectoryLocator(connection);

    let query: Record<string, unknown> = {};

    if (opts.task) query = { taskId: opts.task };
    else if (opts.run) query = { runId: opts.run };
    else if (opts.from || opts.to) query = { timeRange: { start: opts.from ?? '', end: opts.to ?? '' } };
    else {
      console.error('Error: specify at least one search criterion (--task, --run, --from/--to)');
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
      const reasonsCount = candidate.reasons.length;
      console.log(
        '  %s  confidence=%.1f  reasons=%d',
        candidate.trajectoryRef.substring(0, 36),
        candidate.confidence,
        reasonsCount,
      );
    }
    console.log('');
  } finally {
    connection.close();
  }
}
