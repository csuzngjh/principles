/**
 * pd diagnose run/status commands — Diagnostician execution and status inspection.
 *
 * Usage:
 *   pd diagnose status --task-id <taskId> --workspace <path>
 *   pd diagnose run --task-id <taskId> --workspace <path>
 */
import {
  RuntimeStateManager,
  SqliteHistoryQuery,
  SqliteContextAssembler,
  SqliteDiagnosticianCommitter,
  SqliteTrajectoryLocator,
  SqliteSourceTraceLocator,
  StoreEventEmitter,
  storeEmitter,
  DiagnosticianRunner,
  DefaultDiagnosticianValidator,
  TestDoubleRuntimeAdapter,
  OpenClawCliRuntimeAdapter,
  PiAiRuntimeAdapter,
  PDRuntimeError,
  CandidateIntakeService,
  run as diagnoseRun,
  status as diagnoseStatus,
} from '@principles/core/runtime-v2';
import type { PDRuntimeAdapter } from '@principles/core/runtime-v2';
import { PrincipleTreeLedgerAdapter } from '../principle-tree-ledger-adapter.js';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { loadAndResolvePDConfig } from '../pd-config-loader.js';
import * as path from 'path';


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
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
  intake?: boolean;
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
      return;
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
  const configResult = await loadAndResolvePDConfig(opts, opts.workspace);
  if (!configResult.success) {
    if (opts.json) {
      console.log(JSON.stringify({
        status: 'failed',
        errorCategory: 'config_failed',
        message: configResult.failure.error,
        nextAction: configResult.failure.nextAction,
      }, null, 2));
    } else {
      console.error(`error: ${configResult.failure.error}`);
      console.error(`Next Action: ${configResult.failure.nextAction}`);
    }
    process.exit(1);
    return;
  }

  const { config } = configResult;
  const stateManager = new RuntimeStateManager({ workspaceDir: config.workspaceDir });

  try {
    await stateManager.initialize();

    // Build context assembler from internal stores
    const sqliteConn = stateManager.connection;
    const {taskStore} = stateManager;
    const {runStore} = stateManager;
    const historyQuery = new SqliteHistoryQuery(sqliteConn);
    const trajectoryLocator = new SqliteTrajectoryLocator(sqliteConn);
    const sourceTraceLocator = new SqliteSourceTraceLocator(taskStore, trajectoryLocator);
    const contextAssembler = new SqliteContextAssembler(taskStore, historyQuery, runStore, { sourceTraceLocator });

    // Select runtime adapter based on resolved config runtimeKind
    let runtimeAdapter: PDRuntimeAdapter | undefined = undefined;
    if (config.runtimeKind === 'openclaw-cli') {
      runtimeAdapter = new OpenClawCliRuntimeAdapter({
        runtimeMode: config.openclawLocal ? 'local' : 'gateway',
        workspaceDir: config.workspaceDir,
        agentId: config.agent ?? 'main',
      });

      // TELE-01: runtime_adapter_selected
      storeEmitter.emitTelemetry({
        eventType: 'runtime_adapter_selected',
        traceId: opts.taskId,
        timestamp: new Date().toISOString(),
        sessionId: 'pd-cli-diagnose',
        agentId: 'openclaw-cli-adapter',
        payload: {
          runtimeKind: 'openclaw-cli',
          runtimeMode: config.openclawLocal ? 'local' : 'gateway',
        },
      });
    } else if (config.runtimeKind === 'test-double') {
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
    } else if (config.runtimeKind === 'pi-ai') {
      const provider = config.provider ?? '';
      const model = config.model ?? '';
      const apiKeyEnv = config.apiKeyEnv ?? '';
      runtimeAdapter = new PiAiRuntimeAdapter({
        provider,
        model,
        apiKeyEnv,
        baseUrl: config.baseUrl,
        maxRetries: config.maxRetries,
        timeoutMs: config.timeoutMs,
        workspace: config.workspaceDir,
      });

      // TELE: runtime_adapter_selected telemetry
      storeEmitter.emitTelemetry({
        eventType: 'runtime_adapter_selected',
        traceId: opts.taskId,
        timestamp: new Date().toISOString(),
        sessionId: 'pd-cli-diagnose',
        agentId: 'pi-ai-adapter',
        payload: { runtimeKind: 'pi-ai', provider, model, baseUrlPresent: !!config.baseUrl },
      });
    }

    if (!runtimeAdapter) {
      console.error(`error: unknown runtime kind '${config.runtimeKind}'`);
      process.exit(1);
      return;
    }

    const eventEmitter = new StoreEventEmitter();
    const committer = new SqliteDiagnosticianCommitter(sqliteConn);
    const runner = new DiagnosticianRunner(
      {
        stateManager,
        contextAssembler,
        runtimeAdapter,
        eventEmitter,
        validator: new DefaultDiagnosticianValidator(),
        committer,
      },
      {
        owner: 'pd-cli-diagnose',
        runtimeKind: config.runtimeKind,
        pollIntervalMs: 100,
        timeoutMs: config.timeoutMs ?? 300_000,
        agentId: config.agent,
      },
    );

    if (!opts.json) {
      console.log(`\nRunning diagnostician for task: ${opts.taskId}`);
      console.log(`Workspace: ${config.workspaceDir}\n`);
    }

    const result = await diagnoseRun({
      taskId: opts.taskId,
      stateManager,
      runner,
    });

    if (result.status !== 'succeeded') {
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\nResult:`);
        console.log(`  Status:         ${result.status}`);
        console.log(`  Task ID:        ${result.taskId}`);
        if (result.errorCategory) {
          console.log(`  Error Category: ${result.errorCategory}`);
        }
        if (result.failureReason) {
          console.log(`  Failure Reason: ${result.failureReason}`);
        }
        console.log(`  Attempt Count:  ${result.attemptCount}`);
        console.log('');
      }
      process.exit(1);
      return;
    }

    const candidates = await stateManager.getCandidatesByTaskId(opts.taskId);
    const intakeResults: { candidateId: string; ledgerEntryId?: string; status: string; error?: string; nextAction?: string }[] = [];
    let intakeFailed = false;

    if (config.intake === false) {
      for (const candidate of candidates) {
        intakeResults.push({
          candidateId: candidate.candidateId,
          status: 'skipped',
        });
      }
    } else {
      const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: path.join(config.workspaceDir, '.state') });

      const intakeService = new CandidateIntakeService({ stateManager, ledgerAdapter });

      for (const candidate of candidates) {
        try {
          const entry = await intakeService.intake(candidate.candidateId);
          if (candidate.status !== 'consumed') {
            await stateManager.updateCandidateStatus(candidate.candidateId, { status: 'consumed' });
          }
          intakeResults.push({
            candidateId: candidate.candidateId,
            ledgerEntryId: entry.id,
            status: 'consumed',
          });
        } catch (intakeErr: unknown) {
          intakeFailed = true;
          const intakeErrorMessage = intakeErr instanceof Error ? intakeErr.message : String(intakeErr);
          intakeResults.push({
            candidateId: candidate.candidateId,
            status: 'intake_failed',
            error: intakeErrorMessage,
            nextAction: `pd candidate intake --candidate-id ${candidate.candidateId} --workspace "${config.workspaceDir}"`,
          });
        }
      }
    }

    if (opts.json) {
      const jsonOutput = {
        ...result,
        intake: {
          enabled: opts.intake !== false,
          candidates: intakeResults,
        },
      };
      console.log(JSON.stringify(jsonOutput, null, 2));
      if (intakeFailed) {
        process.exit(1);
      }
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
    console.log(`  Attempt Count:  ${result.attemptCount}`);

    if (intakeResults.length > 0) {
      console.log(`\n  Candidate Intake:`);
      for (const ir of intakeResults) {
        if (ir.status === 'consumed') {
          console.log(`    ${ir.candidateId}: consumed (ledger: ${ir.ledgerEntryId})`);
        } else if (ir.status === 'skipped') {
          console.log(`    ${ir.candidateId}: skipped (--no-intake)`);
        } else if (ir.status === 'intake_failed') {
          console.log(`    ${ir.candidateId}: INTAKE FAILED — ${ir.error}`);
          console.log(`      Next action: pd candidate intake --candidate-id ${ir.candidateId} --workspace "${config.workspaceDir}"`);
        }
      }
    }

    if (config.intake === false && candidates.length > 0) {
      console.log(`\n  Note: --no-intake was set. Candidates remain at 'pending'.`);
      console.log(`  To intake manually:`);
      for (const c of candidates) {
        console.log(`    pd candidate intake --candidate-id ${c.candidateId} --workspace "${config.workspaceDir}"`);
      }
    }

    console.log('');

    if (intakeFailed) {
      process.exit(1);
    }
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
        runtimeKind: config.runtimeKind,
      }, null, 2));
    } else {
      console.error(`error: ${message} (${errorCategory})`);
    }
    process.exit(1);
  } finally {
    await stateManager.close();
  }
}

