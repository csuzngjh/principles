/**
 * pd pain retry command — Retry a failed diagnosis by pain ID.
 *
 * Looks up the diagnostician task for a given painId, validates retry eligibility,
 * then delegates to the existing diagnose run logic.
 *
 * Usage:
 *   pd pain retry --pain-id <painId> --workspace <path> [runtime flags] [--json] [--force]
 */
import {
  RuntimeStateManager,
  SqliteHistoryQuery,
  SqliteContextAssembler,
  SqliteDiagnosticianCommitter,
  SqliteTrajectoryLocator,
  SqliteSourceTraceLocator,
  StoreEventEmitter,
  DiagnosticianRunner,
  DefaultDiagnosticianValidator,
  TestDoubleRuntimeAdapter,
  OpenClawCliRuntimeAdapter,
  PiAiRuntimeAdapter,
  PDRuntimeError,
  resolveRuntimeConfig,
  isRuntimeConfigError,
  CandidateIntakeService,
  run as diagnoseRun,
} from '@principles/core/runtime-v2';
import type { PDRuntimeAdapter, RuntimeConfig } from '@principles/core/runtime-v2';
import type { PDTaskStatus } from '@principles/core/runtime-v2';
import { PrincipleTreeLedgerAdapter } from '../principle-tree-ledger-adapter.js';
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

// ── Handler ────────────────────────────────────────────────────────────────────

export async function handlePainRetry(opts: PainRetryOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);

  // Step 1: Resolve painId → taskId
  const resolution = resolveTaskIdFromPainId(opts.painId);
  if ('reason' in resolution) {
    if (opts.json) {
      console.log(JSON.stringify({
        status: 'refused',
        painId: opts.painId,
        reason: resolution.reason,
        nextAction: resolution.nextAction,
      }));
    } else {
      console.error(`error: ${resolution.reason}`);
      console.error(`nextAction: ${resolution.nextAction}`);
    }
    process.exit(1);
    return;
  }

  const { taskId } = resolution;

  // Step 2: Look up task and validate
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    const task = await stateManager.getTask(taskId);
    if (!task) {
      if (opts.json) {
        console.log(JSON.stringify({
          status: 'not_found',
          painId: opts.painId,
          taskId,
          reason: `No task found for painId '${opts.painId}' (looked for taskId '${taskId}')`,
          nextAction: `Verify the painId is correct. Use 'pd task list --kind diagnostician' to see all diagnostician tasks.`,
        }));
      } else {
        console.error(`error: No task found for painId '${opts.painId}' (looked for taskId '${taskId}')`);
        console.error(`nextAction: Verify the painId is correct. Use 'pd task list --kind diagnostician' to see all diagnostician tasks.`);
      }
      process.exit(1);
      return;
    }

    if (task.taskKind !== 'diagnostician') {
      if (opts.json) {
        console.log(JSON.stringify({
          status: 'refused',
          painId: opts.painId,
          taskId,
          reason: `Task '${taskId}' is not a diagnostician task (taskKind='${task.taskKind}')`,
          nextAction: `pd pain retry only retries diagnostician tasks. Use 'pd diagnose run --task-id ${taskId}' for other task kinds.`,
        }));
      } else {
        console.error(`error: Task '${taskId}' is not a diagnostician task (taskKind='${task.taskKind}')`);
        console.error(`nextAction: pd pain retry only retries diagnostician tasks.`);
      }
      process.exit(1);
      return;
    }

    const previousTaskStatus = task.status;
    const previousLastError = task.lastError ?? null;

    if (task.status === 'succeeded' && !opts.force) {
      if (opts.json) {
        console.log(JSON.stringify({
          status: 'refused',
          painId: opts.painId,
          taskId,
          reason: `Task '${taskId}' already succeeded. Use --force to re-run a succeeded task.`,
          nextAction: `Add --force to retry: pd pain retry --pain-id ${opts.painId} --force`,
        }));
      } else {
        console.error(`error: Task '${taskId}' already succeeded. Use --force to re-run.`);
        console.error(`nextAction: Add --force to retry: pd pain retry --pain-id ${opts.painId} --force`);
      }
      process.exit(1);
      return;
    }

    if (!RETRYABLE_STATUSES.has(task.status) && task.status !== 'succeeded') {
      // Status like 'pending' or 'leased' — not retryable
      if (opts.json) {
        console.log(JSON.stringify({
          status: 'refused',
          painId: opts.painId,
          taskId,
          reason: `Task '${taskId}' has status '${task.status}' which is not retryable. Retryable statuses: ${[...RETRYABLE_STATUSES].join(', ')}`,
          nextAction: `Wait for the task to reach a terminal state, or use 'pd diagnose run --task-id ${taskId}' directly.`,
        }));
      } else {
        console.error(`error: Task '${taskId}' has status '${task.status}' which is not retryable.`);
        console.error(`nextAction: Wait for the task to reach a terminal state (retry_wait, failed, needs_human_review).`);
      }
      process.exit(1);
      return;
    }

    // Step 3: Build runtime adapter (same logic as diagnose run)
    if (opts.openclawLocal && opts.openclawGateway) {
      console.error('error: --openclaw-local and --openclaw-gateway are mutually exclusive');
      process.exit(1);
      return;
    }

    const runtimeKind = opts.runtime ?? 'test-double';

    let runtimeAdapter: PDRuntimeAdapter;
    if (runtimeKind === 'openclaw-cli') {
      const stateDir = `${workspaceDir}/.state`;
      const configResult = resolveRuntimeConfig(stateDir, { openclawLocal: opts.openclawLocal, openclawGateway: opts.openclawGateway, requestedRuntimeKind: 'openclaw-cli' });
      if (isRuntimeConfigError(configResult)) {
        if (opts.json) {
          console.log(JSON.stringify({ status: 'refused', painId: opts.painId, taskId, reason: configResult.reason, message: configResult.message, nextAction: configResult.nextAction }));
        } else {
          console.error(`error: ${configResult.message}`);
          console.error(`nextAction: ${configResult.nextAction}`);
        }
        process.exit(1);
        return;
      }
      const { openclawMode } = configResult;
      if (!openclawMode) {
        if (opts.json) {
          console.log(JSON.stringify({ status: 'refused', painId: opts.painId, taskId, reason: 'missing_openclaw_mode', message: 'runtimeKind is openclaw-cli but no mode resolved', nextAction: 'Provide --openclaw-local or --openclaw-gateway' }));
        } else {
          console.error('error: runtimeKind is openclaw-cli but no mode resolved');
          console.error('nextAction: Provide --openclaw-local or --openclaw-gateway');
        }
        process.exit(1);
        return;
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
      const stateDir = `${workspaceDir}/.state`;
      let policyConfig: RuntimeConfig | null = null;
      try {
        const configResult = resolveRuntimeConfig(stateDir);
        if (!isRuntimeConfigError(configResult)) {
          policyConfig = configResult;
        } else {
          console.warn(`[pd pain retry] workflows.yaml policy load failed: ${configResult.message}. Using CLI flags if provided.`);
        }
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(`[pd pain retry] workflows.yaml policy load failed: ${detail}. Using CLI flags if provided.`);
      }

      const provider = opts.provider ?? policyConfig?.provider;
      const model = opts.model ?? policyConfig?.model;
      const apiKeyEnv = opts.apiKeyEnv ?? policyConfig?.apiKeyEnv;
      const baseUrl = opts.baseUrl ?? policyConfig?.baseUrl;
      const maxRetries = opts.maxRetries ?? policyConfig?.maxRetries;
      const effectiveTimeoutMs = opts.timeoutMs ?? policyConfig?.timeoutMs;

      const missing: string[] = [];
      if (!provider) missing.push('provider');
      if (!model) missing.push('model');
      if (!apiKeyEnv) missing.push('apiKeyEnv');
      if (missing.length > 0) {
        if (opts.json) {
          console.log(JSON.stringify({
            status: 'refused',
            painId: opts.painId,
            taskId,
            reason: `missing_required_config: ${missing.join(', ')}`,
            message: `Missing required pi-ai config: ${missing.join(', ')}`,
            nextAction: `Pass via --flag or add to workflows.yaml. Example: pd pain retry --pain-id ${opts.painId} --runtime pi-ai --provider openrouter --model anthropic/claude-sonnet-4 --apiKeyEnv OPENROUTER_API_KEY`,
          }));
        } else {
          console.error(`error: missing required pi-ai config: ${missing.join(', ')}.`);
          console.error(`nextAction: Pass via --flag or add to workflows.yaml.`);
        }
        process.exit(1);
        return;
      }

      if (typeof provider !== 'string' || typeof model !== 'string' || typeof apiKeyEnv !== 'string') {
        // Should be unreachable after the missing check above, but guard for type safety
        if (opts.json) {
          console.log(JSON.stringify({
            status: 'refused',
            painId: opts.painId,
            taskId,
            reason: 'invalid_config_type',
            message: 'Provider, model, or apiKeyEnv resolved to a non-string value',
            nextAction: 'Ensure provider, model, and apiKeyEnv are string values.',
          }));
        } else {
          console.error('error: provider, model, or apiKeyEnv resolved to a non-string value');
          console.error('nextAction: Ensure provider, model, and apiKeyEnv are string values.');
        }
        process.exit(1);
        return;
      }

      if (!process.env[apiKeyEnv]) {
        if (opts.json) {
          console.log(JSON.stringify({
            status: 'refused',
            painId: opts.painId,
            taskId,
            reason: 'missing_api_key',
            message: `Environment variable '${apiKeyEnv}' is not set`,
            nextAction: `Set the environment variable: export ${apiKeyEnv}=<your-api-key>`,
          }));
        } else {
          console.error(`error: environment variable '${apiKeyEnv}' is not set`);
          console.error(`nextAction: Set the environment variable: export ${apiKeyEnv}=<your-api-key>`);
        }
        process.exit(1);
        return;
      }

      runtimeAdapter = new PiAiRuntimeAdapter({
        provider,
        model,
        apiKeyEnv,
        baseUrl,
        maxRetries,
        timeoutMs: effectiveTimeoutMs,
        workspace: workspaceDir,
      });
    } else {
      if (opts.json) {
        console.log(JSON.stringify({
          status: 'refused',
          painId: opts.painId,
          taskId,
          reason: `unknown_runtime: '${runtimeKind}'`,
          message: `Unknown runtime kind '${runtimeKind}'`,
          nextAction: `Supported runtimes: openclaw-cli, test-double, pi-ai`,
        }));
      } else {
        console.error(`error: unknown runtime kind '${runtimeKind}' (supported: openclaw-cli, test-double, pi-ai)`);
      }
      process.exit(1);
      return;
    }

    // Step 4: Build runner and execute (same as diagnose run)
    const sqliteConn = stateManager.connection;
    const { taskStore } = stateManager;
    const { runStore } = stateManager;
    const historyQuery = new SqliteHistoryQuery(sqliteConn);
    const trajectoryLocator = new SqliteTrajectoryLocator(sqliteConn);
    const sourceTraceLocator = new SqliteSourceTraceLocator(taskStore, trajectoryLocator);
    const contextAssembler = new SqliteContextAssembler(taskStore, historyQuery, runStore, { sourceTraceLocator });

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
        owner: 'pd-cli-pain-retry',
        runtimeKind,
        pollIntervalMs: 100,
        timeoutMs: 300_000,
        agentId: opts.agent,
      },
    );

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

    // Step 5: Intake candidates
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
