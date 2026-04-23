/**
 * pd diagnose run/status commands — Diagnostician execution and status inspection.
 *
 * Usage:
 *   pd diagnose status --task-id <taskId> --workspace <path>
 *   pd diagnose run --task-id <taskId> --workspace <path>
 */
import type {
  SqliteTaskStore,
  SqliteRunStore} from '@principles/core/runtime-v2/index.js';
import {
  RuntimeStateManager,
  SqliteHistoryQuery,
  SqliteContextAssembler,
  StoreEventEmitter,
  DiagnosticianRunner,
  PassThroughValidator,
  TestDoubleRuntimeAdapter,
  run as diagnoseRun,
  status as diagnoseStatus,
} from '@principles/core/runtime-v2/index.js';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface DiagnoseStatusOptions {
  taskId: string;
  workspace?: string;
  json?: boolean;
}

interface DiagnoseRunOptions {
  taskId: string;
  workspace?: string;
  json?: boolean;
}

/**
 * pd diagnose status --task-id <taskId> [--workspace <path>] [--json]
 *
 * Inspects the current status of a diagnostician task.
 */
export async function handleDiagnoseStatus(opts: DiagnoseStatusOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();
    const result = await diagnoseStatus({
      taskId: opts.taskId,
      stateManager,
    });

    if (!result) {
      console.error(`Task not found: ${opts.taskId}`);
      process.exit(1);
    }

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`\nDiagnostician Task: ${result.taskId}\n`);
    console.log(`  Status:       ${result.status}`);
    console.log(`  Attempts:     ${result.attemptCount} / ${result.maxAttempts}`);
    if (result.lastError) {
      console.log(`  Last Error:   ${result.lastError}`);
    }
    console.log('');
  } finally {
    await stateManager.close();
  }
}

/**
 * pd diagnose run --task-id <taskId> [--workspace <path>] [--json]
 *
 * Executes the diagnostician runner for a task.
 * Uses TestDoubleRuntimeAdapter (no real LLM) — M5 scope adds real adapter.
 */
export async function handleDiagnoseRun(opts: DiagnoseRunOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    // Build context assembler from internal stores
    const sqliteConn = (stateManager as unknown as { connection: unknown }).connection;
    const taskStore = (stateManager as unknown as { taskStore: unknown }).taskStore as SqliteTaskStore;
    const runStore = (stateManager as unknown as { runStore: unknown }).runStore as SqliteRunStore;
    const historyQuery = new SqliteHistoryQuery(sqliteConn as never);
    const contextAssembler = new SqliteContextAssembler(taskStore, historyQuery, runStore);

    // Use TestDoubleRuntimeAdapter with success-on-first-poll behavior for CLI testing
    const runtimeAdapter = new TestDoubleRuntimeAdapter({
      onPollRun: (_runId: string) => ({
        runId: _runId,
        status: 'succeeded',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      }),
      onFetchOutput: (_runId: string) => ({
        runId: _runId,
        payload: {
          valid: true,
          diagnosisId: `diag-cli-${Date.now()}`,
          taskId: opts.taskId,
          summary: 'CLI test diagnosis',
          rootCause: 'Test root cause',
          violatedPrinciples: [],
          evidence: [],
          recommendations: [],
          confidence: 0.9,
        },
      }),
    });

    const eventEmitter = new StoreEventEmitter();
    const runner = new DiagnosticianRunner(
      {
        stateManager,
        contextAssembler,
        runtimeAdapter,
        eventEmitter,
        validator: new PassThroughValidator(),
      },
      {
        owner: 'pd-cli-diagnose',
        runtimeKind: 'test-double',
        pollIntervalMs: 100,
        timeoutMs: 30000,
      },
    );

    console.log(`\nRunning diagnostician for task: ${opts.taskId}`);
    console.log(`Workspace: ${workspaceDir}\n`);

    const result = await diagnoseRun({
      taskId: opts.taskId,
      stateManager,
      runner,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`\nResult:`);
    console.log(`  Status:         ${result.status}`);
    console.log(`  Task ID:        ${result.taskId}`);
    if (result.contextHash) {
      console.log(`  Context Hash:  ${result.contextHash.substring(0, 16)}...`);
    }
    if (result.output) {
      console.log(`  Diagnosis ID:   ${result.output.diagnosisId}`);
      console.log(`  Summary:        ${result.output.summary}`);
    }
    if (result.errorCategory) {
      console.log(`  Error Category: ${result.errorCategory}`);
    }
    if (result.failureReason) {
      console.log(`  Failure Reason: ${result.failureReason}`);
    }
    console.log(`  Attempt Count:  ${result.attemptCount}`);
    console.log('');
  } finally {
    await stateManager.close();
  }
}
