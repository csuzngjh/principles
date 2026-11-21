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
  SqliteTrajectoryLocator,
  SqliteSourceTraceLocator,
} from '@principles/core';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { createConsentLedgerSourceMaterialAuthorization, createGovernanceTrajectoryTurnReader } from '@principles/host-runtime';

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
    const trajectoryLocator = new SqliteTrajectoryLocator(connection);
    const sourceTraceLocator = new SqliteSourceTraceLocator(taskStore, trajectoryLocator);
    // PRI-1283 R2: latest-consent gate — context assembly refuses
    // governance-sourced material whose host consent is not granted.
    const sourceMaterialAuthorization = createConsentLedgerSourceMaterialAuthorization(workspaceDir);
    const assembler = new SqliteContextAssembler(taskStore, historyQuery, runStore, {
      sourceTraceLocator,
      trajectoryTurnReader: createGovernanceTrajectoryTurnReader({ workspaceDir, sourceMaterialAuthorization }),
      sourceMaterialAuthorization,
    });

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
