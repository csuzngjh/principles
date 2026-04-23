/**
 * pd legacy import openclaw — Import OpenClaw legacy data into PD runtime-v2 store.
 *
 * Usage:
 *   pd legacy import openclaw --workspace <path>
 *
 * This command is the formal operator path for migrating OpenClaw workspace data
 * into PD runtime-v2 SQLite. It must be run before trajectory/history/context commands
 * can return results on a workspace that only has OpenClaw legacy data.
 *
 * Two import stages:
 *   1. Task/Run metadata from .state/diagnostician_tasks.json
 *   2. Session history from .state/trajectory.db (assistant_turns, user_turns, tool_calls)
 */
import { SqliteConnection } from '@principles/core';
import { syncOpenClawWorkspace } from '../legacy/legacy-import.js';
import { importSessionHistory } from '../legacy/session-history-import.js';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface LegacyImportOptions {
  workspace?: string;
  json?: boolean;
}

export async function handleLegacyImportOpenClaw(opts: LegacyImportOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const connection = new SqliteConnection(workspaceDir);

  try {
    const openclawWorkspace = workspaceDir; // same workspace for now

    // Stage 1: Task/Run metadata import
    if (opts.json) {
      console.log(JSON.stringify({ stage: 1, source: '.state/diagnostician_tasks.json' }));
    } else {
      console.log('Stage 1: Importing diagnostician tasks and runs...');
    }
    const syncResult = await syncOpenClawWorkspace(workspaceDir, connection);

    if (opts.json) {
      console.log(
        JSON.stringify({
          stage: 1,
          tasksImported: syncResult.tasksSynced,
          runsImported: syncResult.runsSynced,
        }),
      );
    } else {
      console.log(`  → ${syncResult.tasksSynced} tasks, ${syncResult.runsSynced} runs synced`);
    }

    // Stage 2: Session history import (if better-sqlite3 is available)
    try {
      if (opts.json) {
        console.log(JSON.stringify({ stage: 2, source: '.state/trajectory.db' }));
      } else {
        console.log('Stage 2: Importing session history from trajectory.db...');
      }

       
      const historyResult = await importSessionHistory(
        openclawWorkspace,
        workspaceDir,
        () => connection.getDb(),
      );

      if (opts.json) {
        console.log(
          JSON.stringify({
            stage: 2,
            sessionsProcessed: historyResult.sessionsProcessed,
            entriesImported: historyResult.entriesImported,
          }),
        );
      } else {
        console.log(
          `  → ${historyResult.sessionsProcessed} sessions, ${historyResult.entriesImported} entries imported`,
        );
      }
    } catch (historyError) {
      const msg = historyError instanceof Error ? historyError.message : String(historyError);
      if (opts.json) {
        console.log(
          JSON.stringify({
            stage: 2,
            skipped: true,
            reason: `better-sqlite3 not available: ${msg}`,
          }),
        );
      } else {
        console.log(`  → Stage 2 skipped (better-sqlite3 not available: ${msg})`);
      }
    }

    if (!opts.json) {
      console.log('\nImport complete. You can now run:');
      console.log('  pd trajectory locate --task <id> --workspace <path>');
      console.log('  pd history query <id> --workspace <path>');
      console.log('  pd context build <id> --workspace <path>');
    }
  } finally {
    connection.close();
  }
}
