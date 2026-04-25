/**
 * pd diagnose run/status commands — Diagnostician execution and status inspection.
 *
 * Usage:
 *   pd diagnose status --task-id <taskId> --workspace <path>
 *   pd diagnose run --task-id <taskId> --workspace <path>
 */
import type {
  SqliteTaskStore,
  SqliteRunStore,
  SqliteConnection,
} from '@principles/core/runtime-v2/index.js';
import {
  RuntimeStateManager,
  SqliteHistoryQuery,
  SqliteContextAssembler,
  SqliteDiagnosticianCommitter,
  StoreEventEmitter,
  storeEmitter,
  DiagnosticianRunner,
  PassThroughValidator,
  TestDoubleRuntimeAdapter,
  OpenClawCliRuntimeAdapter,
  PDRuntimeError,
  run as diagnoseRun,
  status as diagnoseStatus,
} from '@principles/core/runtime-v2/index.js';
import type { PDRuntimeAdapter } from '@principles/core/runtime-v2/index.js';
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
  runtime?: string;
  openclawLocal?: boolean;
  openclawGateway?: boolean;
  agent?: string;
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
    if (result.commitId) {
      console.log(`  Result Ref:   commit://${result.commitId}`);
      console.log(`  Commit ID:    ${result.commitId}`);
      console.log(`  Artifact ID:  ${result.artifactId ?? 'N/A'}`);
      console.log(`  Candidates:   ${result.candidateCount ?? 0}`);
    }
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
 */
export async function handleDiagnoseRun(opts: DiagnoseRunOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);

  // Validate mutually exclusive flags (HG-03)
  if (opts.openclawLocal && opts.openclawGateway) {
    console.error('error: --openclaw-local and --openclaw-gateway are mutually exclusive');
    process.exit(1);
  }

  // Require explicit runtime mode for openclaw-cli (HG-03, DPB-09)
  const runtimeKind = opts.runtime ?? 'test-double';
  if (runtimeKind === 'openclaw-cli' && !opts.openclawLocal && !opts.openclawGateway) {
    console.error('error: --openclaw-local or --openclaw-gateway is required when using --runtime openclaw-cli');
    process.exit(1);
  }

  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    // Build context assembler from internal stores
    const sqliteConn = (stateManager as unknown as { connection: unknown }).connection as SqliteConnection;
    const taskStore = (stateManager as unknown as { taskStore: unknown }).taskStore as SqliteTaskStore;
    const runStore = (stateManager as unknown as { runStore: unknown }).runStore as SqliteRunStore;
    const historyQuery = new SqliteHistoryQuery(sqliteConn);
    const contextAssembler = new SqliteContextAssembler(taskStore, historyQuery, runStore);

    // Select runtime adapter based on --runtime flag (CLI-02)
     
    let runtimeAdapter: PDRuntimeAdapter = null as PDRuntimeAdapter;
    if (runtimeKind === 'openclaw-cli') {
      runtimeAdapter = new OpenClawCliRuntimeAdapter({
        runtimeMode: opts.openclawLocal ? 'local' : 'gateway',
        workspaceDir,
      });

      // TELE-01: runtime_adapter_selected — user explicitly chose openclaw-cli runtime
      storeEmitter.emitTelemetry({
        eventType: 'runtime_adapter_selected',
        traceId: opts.taskId,
        timestamp: new Date().toISOString(),
        sessionId: 'pd-cli-diagnose',
        agentId: 'openclaw-cli-adapter',
        payload: {
          runtimeKind: 'openclaw-cli',
          runtimeMode: opts.openclawLocal ? 'local' : 'gateway',
        },
      });
    } else if (runtimeKind === 'test-double') {
      runtimeAdapter = new TestDoubleRuntimeAdapter({
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
            summary: 'CLI test diagnosis — validate tool arguments before execution',
            rootCause: 'Test root cause — missing argument validation',
            violatedPrinciples: [],
            evidence: [],
            recommendations: [
              { kind: 'principle', description: 'Always validate tool arguments before execution to prevent silent failures' },
              { kind: 'rule', description: 'Use schema validation for external inputs' },
            ],
            confidence: 0.9,
          },
        }),
      });
    } else {
      console.error(`error: unknown runtime kind '${runtimeKind}'`);
      process.exit(1);
    }

    const eventEmitter = new StoreEventEmitter();
    const committer = new SqliteDiagnosticianCommitter(sqliteConn);
    const runner = new DiagnosticianRunner(
      {
        stateManager,
        contextAssembler,
        runtimeAdapter,
        eventEmitter,
        validator: new PassThroughValidator(),
        committer,
      },
      {
        owner: 'pd-cli-diagnose',
        runtimeKind,
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
      if (result.output.recommendations) {
        const principleCount = result.output.recommendations.filter((r: { kind: string }) => r.kind === 'principle').length;
        if (principleCount > 0) {
          console.log(`  Principles:     ${principleCount} candidate(s) generated`);
        }
      }
    }
    if (result.errorCategory) {
      console.log(`  Error Category: ${result.errorCategory}`);
    }
    if (result.failureReason) {
      console.log(`  Failure Reason: ${result.failureReason}`);
    }
    console.log(`  Attempt Count:  ${result.attemptCount}`);
    console.log('');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    let errorCategory = 'execution_failed';
    if (error instanceof PDRuntimeError) {
      errorCategory = error.category;
    }
    if (opts.json) {
      console.log(JSON.stringify({
        status: 'failed',
        errorCategory,
        message,
        runtimeKind,
      }, null, 2));
    } else {
      console.error(`error: ${message} (${errorCategory})`);
    }
    process.exit(1);
  } finally {
    await stateManager.close();
  }
}
