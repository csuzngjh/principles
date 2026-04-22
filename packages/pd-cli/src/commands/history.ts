/**
 * pd history query — Query run history for a task with pagination.
 *
 * Usage:
 *   pd history query <taskId> [--limit N] [--cursor <cursor>]
 */
import { SqliteConnection, SqliteHistoryQuery } from '@principles/core';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface HistoryQueryOptions {
  limit?: number;
  cursor?: string;
  json?: boolean;
}

export async function handleHistoryQuery(taskId: string, opts: HistoryQueryOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir();
  const connection = new SqliteConnection(workspaceDir);

  try {
    const historyQuery = new SqliteHistoryQuery(connection);

    const queryOpts = opts.limit ? { limit: opts.limit } : undefined;
    const result = await historyQuery.query(taskId, opts.cursor, queryOpts);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.entries.length === 0) {
      console.log('No history entries found.');
      return;
    }

    console.log(`\nHistory for ${taskId} (${result.entries.length} entries${result.truncated ? ', truncated' : ''}):\n`);
    for (const entry of result.entries) {
      const text = entry.text ? (entry.text.length > 60 ? entry.text.substring(0, 57) + '...' : entry.text) : '<empty>';
      console.log('  [%s] %-8s %s', entry.ts.substring(11, 19), entry.role, text);
    }

    if (result.nextCursor) {
      console.log(`\n  nextCursor: ${result.nextCursor}`);
    }
    console.log('');
  } finally {
    connection.close();
  }
}
