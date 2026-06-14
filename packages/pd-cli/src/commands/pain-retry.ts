/**
 * pd pain retry command — Retry a failed diagnosis by pain ID.
 *
 * Looks up the diagnostician task for a given painId, validates retry eligibility,
 * then delegates to the existing diagnose run logic.
 *
 * Usage:
 *   pd pain retry --pain-id <painId> --workspace <path> --runtime <kind> [runtime flags] [--json] [--force]
 *
 * IMPORTANT: --runtime is required (no default). test-double would generate fake
 * candidates/ledger in a real workspace, so it must be explicitly requested.
 */
import {
  RuntimeStateManager,
  SqliteHistoryQuery,
  SqliteContextAssembler,
  SqliteDiagnosticianCommitter,
  SqliteTrajectoryLocator,
  SqliteSourceTraceLocator,
  StoreEventEmitter,
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
  isFeatureEnabled,
  SPLIT_PIPELINE_TOTAL_TIMEOUT_MS,
} from '@principles/core/runtime-v2';
import type { PDRuntimeAdapter, RuntimeConfig, OutputLanguage } from '@principles/core/runtime-v2';
import { loadPdConfig, computeFlagsFromLoadResult } from '../services/pd-config-loader.js';
import { resolveRuntimeFromPdConfig } from '../services/resolve-runtime-from-pd-config.js';
import type { PDTaskStatus } from '@principles/core/runtime-v2';
import { PrincipleTreeLedgerAdapter } from '../principle-tree-ledger-adapter.js';
import { readOutputLanguageFromWorkspace } from '../config-reader.js';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import * as path from 'path';

// ── Types ──────────────────────────────────────────────────────────────────────

interface PainRetryOptions {
  painId: string;
  workspace?: string;
  json?: boolean;
  force?: boolean;
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
}

/** Allowed task statuses for retry without --force. */
const RETRYABLE_STATUSES: ReadonlySet<PDTaskStatus> = new Set([
  'retry_wait',
  'failed',
  'needs_human_review',
]);

/**
 * Resolve a painId to a diagnostician taskId.
 *
 * Convention: task_id = `diagnosis_<painId>` (see PainToPrincipleService).
 * If the painId already has the `diagnosis_` prefix, reject to avoid double-prefixing.
 */
function resolveTaskIdFromPainId(painId: string): { taskId: string } | { reason: string; nextAction: string } {
  if (painId.startsWith('diagnosis_')) {
    return {
      reason: `painId '${painId}' already has 'diagnosis_' prefix — this looks like a taskId, not a painId`,
      nextAction: `Use the raw painId (without 'diagnosis_' prefix), or use 'pd diagnose run --task-id ${painId}' directly`,
    };
  }
  return { taskId: `diagnosis_${painId}` };
}

/** Return value as a non-blank string if it is one, otherwise null. */
function readNonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** Output a refused/not_found result, respecting --json mode. Exits with code 1. */
function refuseExit(opts: PainRetryOptions, payload: { status?: string; painId: string; taskId?: string; reason: string; message?: string; nextAction: string }): never {
  if (opts.json) {
    console.log(JSON.stringify({
      status: payload.status ?? 'refused',
      painId: payload.painId,
      taskId: payload.taskId ?? null,
      reason: payload.reason,
      ...(payload.message ? { message: payload.message } : {}),
      nextAction: payload.nextAction,
    }));
  } else {
    console.error(`error: ${payload.message ?? payload.reason}`);
    console.error(`nextAction: ${payload.nextAction}`);
  }
  process.exit(1);
}

// ── Handler ────────────────────────────────────────────────────────────────────

export async function handlePainRetry(opts: PainRetryOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);

  // Step 1: Resolve painId → taskId
  const resolution = resolveTaskIdFromPainId(opts.painId);
  if ('reason' in resolution) {
    refuseExit(opts, { painId: opts.painId, reason: resolution.reason, nextAction: resolution.nextAction });
  }

  const { taskId } = resolution;

  // Step 2: Look up task and validate
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    const task = await stateManager.getTask(taskId);
    if (!task) {
      refuseExit(opts, {
        status: 'not_found',
        painId: opts.painId,
        taskId,
        reason: 'task_not_found',
        message: `No task found for painId '${opts.painId}' (looked for taskId '${taskId}')`,
        nextAction: `Verify the painId is correct. Use 'pd task list --kind diagnostician' to see all diagnostician tasks.`,
      });
    }

    if (task.taskKind !== 'diagnostician') {
      refuseExit(opts, {
        painId: opts.painId,
        taskId,
        reason: 'wrong_task_kind',
        message: `Task '${taskId}' is not a diagnostician task (taskKind='${task.taskKind}')`,
        nextAction: `pd pain retry only retries diagnostician tasks. Use 'pd diagnose run --task-id ${taskId}' for other task kinds.`,
      });
    }

    const previousTaskStatus = task.status;
    const previousLastError = task.lastError ?? null;

    if (task.status === 'succeeded' && !opts.force) {
      refuseExit(opts, {
        painId: opts.painId,
        taskId,
        reason: 'already_succeeded',
        message: `Task '${taskId}' already succeeded. Use --force to re-run a succeeded task.`,
        nextAction: `Add --force to retry: pd pain retry --pain-id ${opts.painId} --force`,
      });
    }

    if (!RETRYABLE_STATUSES.has(task.status) && task.status !== 'succeeded') {
      refuseExit(opts, {
        painId: opts.painId,
        taskId,
        reason: 'status_not_retryable',
        message: `Task '${taskId}' has status '${task.status}' which is not retryable. Retryable statuses: ${[...RETRYABLE_STATUSES].join(', ')}`,
        nextAction: `Wait for the task to reach a terminal state, or use 'pd diagnose run --task-id ${taskId}' directly.`,
      });
    }

    // Step 3: Resolve runtime kind
    // P1 fix: --openclaw-local and --openclaw-gateway are mutually exclusive.
    // Must output JSON when --json is set (CLI operator gate).
    if (opts.openclawLocal && opts.openclawGateway) {
      refuseExit(opts, {
        painId: opts.painId,
        taskId,
        reason: 'conflicting_flags',
        message: '--openclaw-local and --openclaw-gateway are mutually exclusive',
        nextAction: 'Provide exactly one of --openclaw-local or --openclaw-gateway, not both.',
      });
    }

    // P1 fix: pd pain retry must NOT default to test-double.
    // This command is for real workspace pain fixes — test-double would generate
    // fake candidates/ledger in a real .pd/state.db. Require explicit --runtime
    // or fall back to .pd/config.yaml.
    let runtimeKind = opts.runtime;
    if (!runtimeKind) {
      const resolved = resolveRuntimeFromPdConfig(workspaceDir);
      if (!isRuntimeConfigError(resolved.result) && resolved.result.runtimeKind) {
        ({ runtimeKind } = resolved.result);
      }
    }

    if (!runtimeKind) {
      refuseExit(opts, {
        painId: opts.painId,
        taskId,
        reason: 'missing_runtime',
        message: 'No --runtime specified and no .pd/config.yaml runtime binding found. pd pain retry must not default to test-double to prevent fake data in real workspaces.',
        nextAction: `Specify --runtime explicitly: pd pain retry --pain-id ${opts.painId} --runtime pi-ai --provider <provider> --model <model> --apiKeyEnv <ENV>`,
      });
    }

    // Step 4: Build runtime adapter
    let runtimeAdapter: PDRuntimeAdapter;

    if (runtimeKind === 'openclaw-cli') {
      const resolved = resolveRuntimeFromPdConfig(workspaceDir);
      const configResult = resolved.result;
      if (isRuntimeConfigError(configResult)) {
        refuseExit(opts, { painId: opts.painId, taskId, reason: configResult.reason, message: configResult.message, nextAction: configResult.nextAction });
      }
      const { openclawMode } = configResult;
      if (!openclawMode) {
        refuseExit(opts, {
          painId: opts.painId,
          taskId,
          reason: 'missing_openclaw_mode',
          message: 'runtimeKind is openclaw-cli but no mode resolved',
          nextAction: 'Provide --openclaw-local or --openclaw-gateway',
        });
      }

      runtimeAdapter = new OpenClawCliRuntimeAdapter({
        runtimeMode: openclawMode,
        workspaceDir,
        agentId: opts.agent ?? 'main',
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
            diagnosisId: `diag-retry-${Date.now()}`,
            taskId,
            summary: 'CLI retry test diagnosis — validate tool arguments before execution',
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
      for (const w of resolved.legacyWarnings) console.warn(`[pd pain retry] ${w}`);

      let policyConfig: RuntimeConfig | null = null;
      if (!isRuntimeConfigError(resolved.result)) {
        policyConfig = resolved.result;
      } else {
        console.warn(`[pd pain retry] .pd/config.yaml resolution failed: ${resolved.result.message}. Using CLI flags if provided.`);
      }

      const provider = opts.provider ?? policyConfig?.provider;
      const model = opts.model ?? policyConfig?.model;
      const apiKeyEnv = opts.apiKeyEnv ?? policyConfig?.apiKeyEnv;
      const baseUrl = opts.baseUrl ?? policyConfig?.baseUrl;
      const maxRetries = opts.maxRetries ?? policyConfig?.maxRetries;
      const effectiveTimeoutMs = opts.timeoutMs ?? policyConfig?.timeoutMs;

      // Validate required string fields: must be non-blank strings
      const missing: string[] = [];
      if (readNonBlankString(provider) === null) missing.push('provider');
      if (readNonBlankString(model) === null) missing.push('model');
      if (readNonBlankString(apiKeyEnv) === null) missing.push('apiKeyEnv');
      if (missing.length > 0) {
        refuseExit(opts, {
          painId: opts.painId,
          taskId,
          reason: `missing_required_config: ${missing.join(', ')}`,
          message: `Missing or blank required pi-ai config: ${missing.join(', ')}`,
          nextAction: `Pass via --flag or add to workflows.yaml. Example: pd pain retry --pain-id ${opts.painId} --runtime pi-ai --provider openrouter --model anthropic/claude-sonnet-4 --apiKeyEnv OPENROUTER_API_KEY`,
        });
      }

      // Validate numeric options: must be finite, integer, non-negative if provided
      const invalidNumeric: string[] = [];
      if (maxRetries !== undefined && maxRetries !== null && !(Number.isFinite(maxRetries) && Number.isInteger(maxRetries) && maxRetries >= 0)) {
        invalidNumeric.push(`maxRetries (got: ${maxRetries})`);
      }
      if (effectiveTimeoutMs !== undefined && effectiveTimeoutMs !== null && !(Number.isFinite(effectiveTimeoutMs) && effectiveTimeoutMs > 0)) {
        invalidNumeric.push(`timeoutMs (got: ${effectiveTimeoutMs})`);
      }
      if (invalidNumeric.length > 0) {
        refuseExit(opts, {
          painId: opts.painId,
          taskId,
          reason: `invalid_numeric_config: ${invalidNumeric.join(', ')}`,
          message: `Invalid numeric pi-ai config: ${invalidNumeric.join(', ')}. maxRetries must be a non-negative integer; timeoutMs must be a positive number.`,
          nextAction: 'Fix the numeric values and retry.',
        });
      }

      // After validation, these are guaranteed non-blank strings.
      const validProvider = readNonBlankString(provider);
      const validModel = readNonBlankString(model);
      const validApiKeyEnv = readNonBlankString(apiKeyEnv);
      if (validProvider === null || validModel === null || validApiKeyEnv === null) {
        refuseExit(opts, {
          painId: opts.painId,
          taskId,
          reason: 'internal_validation_error',
          message: 'Internal error: validated string fields became null after validation.',
          nextAction: 'This should not happen. Please report this bug.',
        });
      }

      if (!process.env[validApiKeyEnv]) {
        refuseExit(opts, {
          painId: opts.painId,
          taskId,
          reason: 'missing_api_key',
          message: `Environment variable '${validApiKeyEnv}' is not set`,
          nextAction: `Set the environment variable: export ${validApiKeyEnv}=<your-api-key>`,
        });
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
    } else {
      refuseExit(opts, {
        painId: opts.painId,
        taskId,
        reason: `unknown_runtime: '${runtimeKind}'`,
        message: `Unknown runtime kind '${runtimeKind}'`,
        nextAction: 'Supported runtimes: openclaw-cli, test-double, pi-ai',
      });
    }

    // Step 5: Build runner and execute (same as diagnose run)
    const sqliteConn = stateManager.connection;
    const { taskStore } = stateManager;
    const { runStore } = stateManager;
    const historyQuery = new SqliteHistoryQuery(sqliteConn);
    const trajectoryLocator = new SqliteTrajectoryLocator(sqliteConn);
    const sourceTraceLocator = new SqliteSourceTraceLocator(taskStore, trajectoryLocator);
    const contextAssembler = new SqliteContextAssembler(taskStore, historyQuery, runStore, { sourceTraceLocator });

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
      const rootCauseRunner = new DiagRootCauseRunner(
        { stateManager, runtimeAdapter, eventEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultDiagRootCauseValidator(), contextAssembler },
        { owner: 'pd-cli-pain-retry', runtimeKind: resolvedKind, outputLanguage },
      );
      const distillerRunner = new DiagDistillerRunner(
        { stateManager, runtimeAdapter, eventEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultDiagDistillerValidator() },
        { owner: 'pd-cli-pain-retry', runtimeKind: resolvedKind, outputLanguage },
      );
      const routerRunner = new DiagRouterRunner(
        { stateManager, runtimeAdapter, eventEmitter, artifactStore: stateManager.piArtifactStore, committer },
        { owner: 'pd-cli-pain-retry', runtimeKind: resolvedKind, outputLanguage },
      );

      runner = new SplitDiagnosticianRunner({
        rootCauseRunner,
        distillerRunner,
        routerRunner,
        stateManager,
        committer,
        perStageTimeoutMs: pipelineTimeoutMs / 3,
      });
    } else {
      runner = new DisabledDiagnosticianRunner();
    }

    if (!opts.json) {
      console.log(`\nRetrying diagnosis for pain: ${opts.painId}`);
      console.log(`  Task ID:  ${taskId}`);
      console.log(`  Previous: ${previousTaskStatus}${previousLastError ? ` (${previousLastError})` : ''}`);
      console.log(`  Runtime:  ${runtimeKind}`);
      console.log(`  Workspace: ${workspaceDir}\n`);
    }

    const result = await diagnoseRun({
      taskId,
      stateManager,
      runner,
    });

    if (result.status !== 'succeeded') {
      if (opts.json) {
        console.log(JSON.stringify({
          status: 'failed',
          painId: opts.painId,
          taskId,
          runId: null,
          runtimeKind,
          previousTaskStatus,
          previousLastError,
          newTaskStatus: result.status,
          errorCategory: result.errorCategory ?? null,
          failureReason: result.failureReason ?? null,
          nextAction: result.errorCategory === 'output_invalid'
            ? 'The LLM output failed validation. Try a different model or provider.'
            : 'Check the error category and retry with adjusted parameters.',
        }, null, 2));
      } else {
        console.log(`\nRetry failed:`);
        console.log(`  Status:         ${result.status}`);
        console.log(`  Task ID:        ${result.taskId}`);
        if (result.errorCategory) {
          console.log(`  Error Category: ${result.errorCategory}`);
        }
        if (result.failureReason) {
          console.log(`  Failure Reason: ${result.failureReason}`);
        }
        console.log('');
      }
      process.exit(1);
      return;
    }

    // Step 6: Intake candidates
    const candidates = await stateManager.getCandidatesByTaskId(taskId);
    const intakeResults: { candidateId: string; ledgerEntryId?: string; status: string; error?: string; nextAction?: string }[] = [];
    let intakeFailed = false;

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

    const candidateIds = candidates.map((c) => c.candidateId);
    const ledgerEntryIds = intakeResults
      .filter((ir): ir is { candidateId: string; ledgerEntryId: string; status: string } => ir.status === 'consumed' && typeof ir.ledgerEntryId === 'string')
      .map((ir) => ir.ledgerEntryId);

    // Build nextAction: candidates generated but internalization not automatic
    const internalizeNextAction = candidateIds.length > 0
      ? `Candidates generated but internalization has NOT started automatically. To begin internalization, run:\n  ${candidateIds.map((id) => `pd candidate internalize --candidate-id ${id} --workspace "${workspaceDir}"`).join('\n  ')}`
      : 'No candidates were generated from this diagnosis.';

    if (opts.json) {
      // Strict single JSON object output
      console.log(JSON.stringify({
        status: 'succeeded',
        painId: opts.painId,
        taskId,
        runId: null,
        runtimeKind,
        previousTaskStatus,
        previousLastError,
        newTaskStatus: 'succeeded',
        candidateIds,
        ledgerEntryIds,
        intake: {
          candidates: intakeResults,
        },
        nextAction: internalizeNextAction,
      }, null, 2));
      if (intakeFailed) {
        process.exit(1);
      }
      return;
    }

    // Text output
    console.log(`\nRetry succeeded:`);
    console.log(`  Pain ID:         ${opts.painId}`);
    console.log(`  Task ID:         ${taskId}`);
    console.log(`  Previous Status: ${previousTaskStatus}${previousLastError ? ` (${previousLastError})` : ''}`);
    console.log(`  New Status:      succeeded`);
    console.log(`  Candidates:      ${candidateIds.length}`);
    if (result.contextHash) {
      console.log(`  Context Hash:    ${result.contextHash.substring(0, 16)}...`);
    }

    if (intakeResults.length > 0) {
      console.log(`\n  Candidate Intake:`);
      for (const ir of intakeResults) {
        if (ir.status === 'consumed') {
          console.log(`    ${ir.candidateId}: consumed (ledger: ${ir.ledgerEntryId})`);
        } else if (ir.status === 'intake_failed') {
          console.log(`    ${ir.candidateId}: INTAKE FAILED — ${ir.error}`);
          console.log(`      Next action: ${ir.nextAction}`);
        }
      }
    }

    console.log(`\n  Next Action:`);
    console.log(`  ${internalizeNextAction}`);
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
        painId: opts.painId,
        taskId: `diagnosis_${opts.painId}`,
        errorCategory,
        message,
        nextAction: 'Check the error message and retry with adjusted parameters.',
      }, null, 2));
    } else {
      console.error(`error: ${message} (${errorCategory})`);
    }
    process.exit(1);
  } finally {
    await stateManager.close();
  }
}
