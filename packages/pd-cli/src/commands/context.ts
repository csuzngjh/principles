/**
 * pd context build — Assemble diagnostician context payload for a task.
 *
 * Usage:
 *   pd context build <taskId>
 */
import {
  SqliteConnection,
  SqliteTaskStore,
  SqliteRunStore,
  SqliteHistoryQuery,
  SqliteContextAssembler,
} from '@principles/core';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface ContextBuildOptions {
  json?: boolean;
  workspace?: string;
}

export async function handleContextBuild(taskId: string, opts: ContextBuildOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const connection = new SqliteConnection(workspaceDir);

  try {
    const taskStore = new SqliteTaskStore(connection);
    const runStore = new SqliteRunStore(connection);
    const historyQuery = new SqliteHistoryQuery(connection);
    const assembler = new SqliteContextAssembler(taskStore, historyQuery, runStore);

    const payload = await assembler.assemble(taskId);

    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`\nContext for ${taskId}:\n`);
    console.log(`  contextId:      ${payload.contextId}`);
    console.log(`  contextHash:    ${payload.contextHash.substring(0, 16)}...`);
    console.log(`  workspaceDir:   ${payload.workspaceDir}`);
    console.log(`  sourceRefs:     ${payload.sourceRefs.join(', ')}`);
    console.log(`  entries:        ${payload.conversationWindow.length}`);

    if (payload.ambiguityNotes && payload.ambiguityNotes.length > 0) {
      console.log(`  ambiguityNotes:`);
      for (const note of payload.ambiguityNotes) {
        console.log(`    - ${note}`);
      }
    }

    const target = payload.diagnosisTarget;
    const targetFields = Object.entries(target).filter(([, v]) => v !== undefined);
    if (targetFields.length > 0) {
      console.log(`  diagnosisTarget:`);
      for (const [key, value] of targetFields) {
        console.log(`    ${key}: ${value}`);
      }
    }
    console.log('');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  } finally {
    connection.close();
  }
}
