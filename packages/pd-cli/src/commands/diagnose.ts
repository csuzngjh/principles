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
  SplitDiagnosticianRunner,
  DiagRootCauseRunner,
  DiagDistillerRunner,
  DiagRouterRunner,
  DefaultDiagRootCauseValidator,
  DefaultDiagDistillerValidator,
  DisabledDiagnosticianRunner,
  type DiagnosticianRunnerLike,
  TestDoubleRuntimeAdapter,
  OpenClawCliRuntimeAdapter,
  PiAiRuntimeAdapter,
  PDRuntimeError,
  isRuntimeConfigError,
  CandidateIntakeService,
  run as diagnoseRun,
  status as diagnoseStatus,
} from '@principles/core/runtime-v2';
import type { PDRuntimeAdapter, RuntimeConfig, OutputLanguage } from '@principles/core/runtime-v2';
import { PrincipleTreeLedgerAdapter } from '../principle-tree-ledger-adapter.js';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { readOutputLanguageFromWorkspace } from '../config-reader.js';
import { loadPdConfig, computeFlagsFromLoadResult } from '../services/pd-config-loader.js';
import { resolveRuntimeFromPdConfig } from '../services/resolve-runtime-from-pd-config.js';
import { isFeatureEnabled, SPLIT_PIPELINE_TOTAL_TIMEOUT_MS } from '@principles/core/runtime-v2';
import * as path from 'path';

function validateStalledThreshold(val: unknown): number | undefined {
  if (val === undefined) {
    return undefined;
  }
  const str = String(val).trim();
  if (!/^[1-9]\d*$/.test(str)) {
    throw new Error('stalled-threshold must be a positive integer.');
  }
  const num = parseInt(str, 10);
  if (isNaN(num)) {
    throw new Error('stalled-threshold must be a positive integer.');
  }
  return num;
}

interface DiagnoseStatusOptions {
  taskId: string;
  workspace?: string;
  json?: boolean;
  stalledThreshold?: unknown;
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
  let stalledThresholdSeconds: number | undefined;
  try {
    stalledThresholdSeconds = validateStalledThreshold(opts.stalledThreshold);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      console.log(JSON.stringify({
        ok: false,
        reason: 'invalid_stalled_threshold',
        nextAction: 'Provide a valid positive integer for --stalled-threshold (e.g., --stalled-threshold 300).',
      }));
    } else {
      console.error(`error: ${msg}`);
      console.error('nextAction: Provide a valid positive integer for --stalled-threshold (e.g., --stalled-threshold 300).');
    }
    process.exit(1);
    return;
  }

  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();
    const result = await diagnoseStatus({
      taskId: opts.taskId,
      stateManager,
      stalledThresholdSeconds,
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
    if (result.reason) {
      console.log(`  Reason:       ${result.reason}`);
    }
    if (result.age !== undefined && result.age !== null) {
      console.log(`  Age:          ${result.age}s`);
    }
    if (result.nextAction) {
      console.log(`  Next Action:  ${result.nextAction}`);
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

  const runtimeKind = opts.runtime ?? 'test-double';

  const stateManager = new RuntimeStateManager({ workspaceDir });

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

    // Select runtime adapter based on --runtime flag (CLI-02)
     
    let runtimeAdapter: PDRuntimeAdapter;
    if (runtimeKind === 'openclaw-cli') {
      const resolved = resolveRuntimeFromPdConfig(workspaceDir);
      const configResult = resolved.result;
      if (isRuntimeConfigError(configResult)) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, reason: configResult.reason, message: configResult.message, nextAction: configResult.nextAction }));
        } else {
          console.error(`error: ${configResult.message}`);
          console.error(`nextAction: ${configResult.nextAction}`);
        }
        process.exit(1);
        return;
      }
      const { openclawMode } = configResult;
      // CLI flags override config (PRI-393)
      const flagMode = opts.openclawLocal ? 'local' as const : opts.openclawGateway ? 'gateway' as const : undefined;
      const effectiveMode = flagMode ?? openclawMode;
      if (!effectiveMode) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, reason: 'missing_openclaw_mode', message: 'runtimeKind is openclaw-cli but no mode resolved', nextAction: 'Provide --openclaw-local or --openclaw-gateway, or set openclawMode in .pd/config.yaml' }));
        } else {
          console.error('error: runtimeKind is openclaw-cli but no mode resolved');
          console.error('nextAction: Provide --openclaw-local or --openclaw-gateway, or set openclawMode in .pd/config.yaml');
        }
        process.exit(1);
        return;
      }

      runtimeAdapter = new OpenClawCliRuntimeAdapter({
        runtimeMode: effectiveMode,
        workspaceDir,
        agentId: opts.agent ?? 'main',
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
          runtimeMode: effectiveMode,
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
    } else if (runtimeKind === 'pi-ai') {
      const resolved = resolveRuntimeFromPdConfig(workspaceDir);
      for (const w of resolved.legacyWarnings) console.warn(`[pd diagnose] ${w}`);

      let policyConfig: RuntimeConfig | null = null;
      if (!isRuntimeConfigError(resolved.result)) {
        policyConfig = resolved.result;
      } else {
        console.warn(`[pd diagnose] .pd/config.yaml resolution failed: ${resolved.result.message}. Using CLI flags if provided.`);
      }

      const provider = opts.provider ?? policyConfig?.provider;
      const model = opts.model ?? policyConfig?.model;
      const apiKeyEnv = opts.apiKeyEnv ?? policyConfig?.apiKeyEnv;
      const baseUrl = opts.baseUrl ?? policyConfig?.baseUrl;
      const maxRetries = opts.maxRetries ?? policyConfig?.maxRetries;
      const effectiveTimeoutMs = opts.timeoutMs ?? policyConfig?.timeoutMs;

      // D-11: validate config — missing fields + fix suggestion
      const missing: string[] = [];
      if (!provider) missing.push('provider');
      if (!model) missing.push('model');
      if (!apiKeyEnv) missing.push('apiKeyEnv');
      if (missing.length > 0) {
        console.error(
          `error: missing required pi-ai config: ${missing.join(', ')}.\n` +
          `Pass via --flag or add to .pd/config.yaml runtime profile.\n` +
          `Example:\n` +
          `  pd diagnose run --runtime pi-ai --provider openrouter --model anthropic/claude-sonnet-4 --apiKeyEnv OPENROUTER_API_KEY\n` +
          `  Or add to .pd/config.yaml:\n` +
          `    runtimeProfiles:\n` +
          `      - id: openrouter\n` +
          `        type: pi-ai\n` +
          `        provider: openrouter\n` +
          `        model: anthropic/claude-sonnet-4\n` +
          `        apiKeyEnv: OPENROUTER_API_KEY`,
        );
        process.exit(1);
      }

      // After validation: all fields are confirmed non-null
      const validProvider: string = provider as string;
      const validModel: string = model as string;
      const validApiKeyEnv: string = apiKeyEnv as string;

      // D-09: validate env var exists
      if (!process.env[validApiKeyEnv]) {
        console.error(`error: environment variable '${validApiKeyEnv}' is not set`);
        process.exit(1);
      }

      runtimeAdapter = new PiAiRuntimeAdapter({
        provider: validProvider,
        model: validModel,
        apiKeyEnv: validApiKeyEnv,
        baseUrl,
        maxRetries,
        timeoutMs: effectiveTimeoutMs,
        workspace: workspaceDir,
      });

      // TELE: runtime_adapter_selected telemetry
      storeEmitter.emitTelemetry({
        eventType: 'runtime_adapter_selected',
        traceId: opts.taskId,
        timestamp: new Date().toISOString(),
        sessionId: 'pd-cli-diagnose',
        agentId: 'pi-ai-adapter',
        payload: { runtimeKind: 'pi-ai', provider: validProvider, model: validModel, baseUrlPresent: !!baseUrl },
      });
    } else {
      console.error(`error: unknown runtime kind '${runtimeKind}' (supported: openclaw-cli, test-double, pi-ai)`);
      process.exit(1);
    }

    const eventEmitter = new StoreEventEmitter();
    const committer = new SqliteDiagnosticianCommitter(sqliteConn);

    // PRI-336: Read outputLanguage from workspace config
    const outputLangResult = readOutputLanguageFromWorkspace(workspaceDir);
    const outputLanguage: OutputLanguage | undefined = outputLangResult.outputLanguage;

    // Check if split pipeline is enabled — 3 serial LLM calls need more time
    const configLoadResult = loadPdConfig(workspaceDir);
    const featureFlags = computeFlagsFromLoadResult(configLoadResult);
    const isSplitPipeline = isFeatureEnabled(featureFlags, 'diagnostician_split_pipeline');
    const pipelineTimeoutMs = isSplitPipeline ? SPLIT_PIPELINE_TOTAL_TIMEOUT_MS : 300_000;

    let runner: DiagnosticianRunnerLike;
    if (isSplitPipeline) {
      const resolvedKind = typeof runtimeAdapter.kind === 'function' ? runtimeAdapter.kind() : runtimeKind;
      const perStageTimeoutMs = pipelineTimeoutMs / 3;
      const rootCauseRunner = new DiagRootCauseRunner(
        { stateManager, runtimeAdapter, eventEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultDiagRootCauseValidator(), contextAssembler },
        { owner: 'pd-cli-diagnose', runtimeKind: resolvedKind, outputLanguage, timeoutMs: perStageTimeoutMs },
      );
      const distillerRunner = new DiagDistillerRunner(
        { stateManager, runtimeAdapter, eventEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultDiagDistillerValidator() },
        { owner: 'pd-cli-diagnose', runtimeKind: resolvedKind, outputLanguage, timeoutMs: perStageTimeoutMs },
      );
      const routerRunner = new DiagRouterRunner(
        { stateManager, runtimeAdapter, eventEmitter, artifactStore: stateManager.piArtifactStore, committer },
        { owner: 'pd-cli-diagnose', runtimeKind: resolvedKind, outputLanguage, timeoutMs: perStageTimeoutMs },
      );

      runner = new SplitDiagnosticianRunner({
        rootCauseRunner,
        distillerRunner,
        routerRunner,
        stateManager,
        committer,
        perStageTimeoutMs,
      });
    } else {
      runner = new DisabledDiagnosticianRunner();
    }

    if (!opts.json) {
      console.log(`\nRunning diagnostician for task: ${opts.taskId}`);
      console.log(`Workspace: ${workspaceDir}\n`);
    }

    // ERR-067 fix: loop on `retried` status — the SplitDiagnosticianRunner
    // handles per-stage retry internally, but the CLI must also loop in case
    // the top-level result is `retried` (e.g., from a non-split pipeline).
    const retryPolicy = stateManager.getRetryPolicy();
    let result = await diagnoseRun({
      taskId: opts.taskId,
      stateManager,
      runner,
    });

    let retryLoopCount = 0;
    const maxRetryLoops = 10; // Safety limit
    while (result.status === 'retried' && retryLoopCount < maxRetryLoops) {
      retryLoopCount++;
      const task = await stateManager.getTask(opts.taskId);
      const backoffMs = task ? retryPolicy.calculateBackoff(task.attemptCount) : 30_000;

      if (!opts.json) {
        console.log(`  Retry ${retryLoopCount}: waiting ${Math.round(backoffMs / 1000)}s before re-running...`);
      }

      await new Promise((resolve) => setTimeout(resolve, backoffMs));

      result = await diagnoseRun({
        taskId: opts.taskId,
        stateManager,
        runner,
      });
    }

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

    if (opts.intake === false) {
      for (const candidate of candidates) {
        intakeResults.push({
          candidateId: candidate.candidateId,
          status: 'skipped',
        });
      }
    } else {
      const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: path.join(workspaceDir, '.state') });
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
            nextAction: `pd candidate intake --candidate-id ${candidate.candidateId} --workspace "${workspaceDir}"`,
          });
        }
      }
    }

    if (opts.json) {
      const candidateIds = candidates.map((c) => c.candidateId);
      const internalizeNextAction = candidateIds.length > 0
        ? `Candidates generated but internalization has NOT started automatically. To begin internalization, run:\n  ${candidateIds.map((id) => `pd candidate internalize --candidate-id ${id} --workspace "${workspaceDir}"`).join('\n  ')}`
        : 'No candidates were generated from this diagnosis.';
      const jsonOutput = {
        ...result,
        intake: {
          enabled: opts.intake !== false,
          candidates: intakeResults,
        },
        nextAction: internalizeNextAction,
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
          console.log(`      Next action: pd candidate intake --candidate-id ${ir.candidateId} --workspace "${workspaceDir}"`);
        }
      }
    }

    if (opts.intake === false && candidates.length > 0) {
      console.log(`\n  Note: --no-intake was set. Candidates remain at 'pending'.`);
      console.log(`  To intake manually:`);
      for (const c of candidates) {
        console.log(`    pd candidate intake --candidate-id ${c.candidateId} --workspace "${workspaceDir}"`);
      }
    }

    if (candidates.length > 0) {
      console.log(`\n  Next Action:`);
      console.log(`  Candidates generated but internalization has NOT started automatically.`);
      console.log(`  To begin internalization:`);
      for (const c of candidates) {
        console.log(`    pd candidate internalize --candidate-id ${c.candidateId} --workspace "${workspaceDir}"`);
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
