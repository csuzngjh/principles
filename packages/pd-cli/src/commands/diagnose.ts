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
  type DiagnosticianRunnerLike,
  TestDoubleRuntimeAdapter,
  PDRuntimeError,
  isRuntimeConfigError,
  CandidateIntakeService,
  run as diagnoseRun,
  status as diagnoseStatus,
  PrincipleTreeLedgerAdapter,
  buildDreamerSeedFromCandidate,
  CANDIDATE_KIND_TO_ROUTE,
  ROUTE_CHANNEL_MAP,
  MVP_ENABLED_CHANNELS,
} from '@principles/core/runtime-v2';
import type { PDRuntimeAdapter, OutputLanguage } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { readOutputLanguageFromWorkspace } from '../config-reader.js';
import { loadPdConfig } from '../services/pd-config-loader.js';
import { SPLIT_PIPELINE_TOTAL_TIMEOUT_MS, resolveDiagnosticianCapability } from '@principles/core/runtime-v2';
import { createHash } from 'node:crypto';
/** Layer 0 content-hash (design §6.1); injected so diag writers can attach predecessorSummary hashes. */
const contentHashFn = (input: string): string => createHash('sha256').update(input).digest('hex');
import { resolveRuntimeAdapterFromConfig, ConfigResolutionError } from '../services/runtime-adapter-resolver.js';
import { resolveRuntimeFromPdConfig } from '../services/resolve-runtime-from-pd-config.js';
import { checkAdmissionGate } from './admission-gate.js';
import { resolveSourcePainIdFromDiagnostician } from './candidate.js';
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
 * PRI-431 Step 1d: Build diagnostician-specific test-double payload.
 * Extracted from inline resolution in handleDiagnoseRun to use with shared resolver.
 */
function buildDiagnosticianTestDouble(taskId: string): PDRuntimeAdapter {
  return new TestDoubleRuntimeAdapter({
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
        taskId,
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
    return;
  }

  // PRI-638: this is the CLI's ONLY capability disable check. It reads the
  // canonical authority (internalAgents.agents.diagnostician.enabled) through
  // the same resolver the runtime factory uses, so `pd diagnose` can never
  // mislabel a deliberate Owner kill switch as a missing runtime, a provider
  // failure or a malformed config. No runtime adapter is constructed and no
  // provider is contacted on this path.
  const configLoadResult = loadPdConfig(workspaceDir);
  const capability = resolveDiagnosticianCapability(
    configLoadResult.ok ? configLoadResult.effective : configLoadResult.defaults,
  );
  if (!capability.available) {
    const disabledResult = {
      ok: false,
      status: 'failed',
      reason: capability.reason,
      message: capability.message,
      nextAction: capability.nextAction,
    };
    if (opts.json) {
      console.log(JSON.stringify(disabledResult, null, 2));
    } else {
      console.error(`error: ${capability.message}`);
      console.error(`reason: ${capability.reason}`);
      console.error(`nextAction: ${capability.nextAction}`);
    }
    process.exit(1);
    return;
  }

  // Resolve runtime kind. P1 fix (mirrors pain-retry.ts): pd diagnose run
  // must NOT default to test-double. Without --runtime, the split pipeline
  // would validate the test-double's stale DiagnosticianOutputV1-shaped
  // payload against DiagRootCauseOutputV1Schema and fail with
  // max_attempts_exceeded — silently producing failed/fake diagnostic data
  // in a real workspace. Fall back to .pd/config.yaml first; refuse if
  // nothing is bound. (rc-9-no-silent-fallback / ERR-002; EP-03, EP-04)
  let runtimeKind = opts.runtime;
  if (!runtimeKind) {
    const resolved = resolveRuntimeFromPdConfig(workspaceDir);
    if (!isRuntimeConfigError(resolved.result) && resolved.result.runtimeKind) {
      ({ runtimeKind } = resolved.result);
    }
  }

  if (!runtimeKind) {
    const missingRuntime = {
      ok: false,
      reason: 'missing_runtime',
      message:
        'No --runtime specified and no .pd/config.yaml runtime binding found. pd diagnose run must not default to test-double to prevent fake data in real workspaces.',
      nextAction: `Specify --runtime explicitly: pd diagnose run --task-id ${opts.taskId} --runtime pi-ai --provider <provider> --model <model> --apiKeyEnv <ENV>`,
    };
    if (opts.json) {
      console.log(JSON.stringify(missingRuntime, null, 2));
    } else {
      console.error(`error: ${missingRuntime.message}`);
      console.error(`Next action: ${missingRuntime.nextAction}`);
    }
    process.exit(1);
    return;
  }

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
    // PRI-431: migrated to shared resolveRuntimeAdapterFromConfig
    let runtimeAdapter: PDRuntimeAdapter;
    // Capture config info for telemetry (resolver consumes config internally)
    let telemetryConfig: { provider?: string; model?: string; openclawMode?: string } = {};
    try {
      if (runtimeKind === 'test-double') {
        runtimeAdapter = resolveRuntimeAdapterFromConfig({
          runtimeKind,
          workspaceDir,
          allowTestDouble: true,
          testDoublePayloadBuilder: () => buildDiagnosticianTestDouble(opts.taskId),
        });
      } else if (runtimeKind === 'openclaw-cli') {
        const flagMode: 'local' | 'gateway' | undefined = opts.openclawLocal
          ? 'local'
          : opts.openclawGateway
            ? 'gateway'
            : undefined;
        runtimeAdapter = resolveRuntimeAdapterFromConfig({
          runtimeKind,
          workspaceDir,
          openclawMode: flagMode,
          agentId: opts.agent ?? 'main',
          onConfigResolved: (resolved) => {
            if (!isRuntimeConfigError(resolved.result)) {
              telemetryConfig.openclawMode = flagMode ?? resolved.result.openclawMode;
            } else {
              telemetryConfig.openclawMode = flagMode;
            }
          },
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
            runtimeMode: telemetryConfig.openclawMode ?? 'local',
          },
        });
      } else if (runtimeKind === 'pi-ai') {
        runtimeAdapter = resolveRuntimeAdapterFromConfig({
          runtimeKind,
          workspaceDir,
          configOptional: true,
          validateApiKeyEnv: true,
          piAiOverrides: {
            provider: opts.provider,
            model: opts.model,
            apiKeyEnv: opts.apiKeyEnv,
            baseUrl: opts.baseUrl,
            maxRetries: opts.maxRetries,
          },
          timeoutMs: opts.timeoutMs,
          onConfigResolved: (resolved) => {
            for (const w of resolved.legacyWarnings) console.warn(`[pd diagnose] ${w}`);
            if (isRuntimeConfigError(resolved.result)) {
              console.warn(`[pd diagnose] .pd/config.yaml resolution failed: ${resolved.result.message}. Using CLI flags if provided.`);
            } else {
              telemetryConfig.provider = resolved.result.provider;
              telemetryConfig.model = resolved.result.model;
            }
          },
        });
        // TELE: runtime_adapter_selected telemetry
        const telemetryProvider = opts.provider ?? telemetryConfig.provider;
        const telemetryModel = opts.model ?? telemetryConfig.model;
        storeEmitter.emitTelemetry({
          eventType: 'runtime_adapter_selected',
          traceId: opts.taskId,
          timestamp: new Date().toISOString(),
          sessionId: 'pd-cli-diagnose',
          agentId: 'pi-ai-adapter',
          payload: { runtimeKind: 'pi-ai', provider: telemetryProvider, model: telemetryModel, baseUrlPresent: !!opts.baseUrl },
        });
      } else {
        const unsupportedResult = {
          ok: false,
          reason: `unsupported_runtime_kind: ${runtimeKind}`,
          nextAction: 'Use one of: openclaw-cli, test-double, pi-ai',
        };
        if (opts.json) {
          console.log(JSON.stringify(unsupportedResult, null, 2));
        } else {
          console.error(`error: unknown runtime kind '${runtimeKind}' (supported: openclaw-cli, test-double, pi-ai)`);
          console.error(`Next action: ${unsupportedResult.nextAction}`);
        }
        process.exit(1);
        return;
      }
    } catch (err) {
      if (err instanceof ConfigResolutionError) {
        // Preserve original error format for openclaw-cli missing mode (backward compat)
        if (err.kind === 'missing-fields' && err.missing?.includes('openclawMode')) {
          if (opts.json) {
            console.log(JSON.stringify({
              ok: false,
              reason: 'missing_openclaw_mode',
              message: 'runtimeKind is openclaw-cli but no mode resolved',
              nextAction: 'Provide --openclaw-local or --openclaw-gateway, or set openclawMode in .pd/config.yaml',
            }));
          } else {
            console.error('error: runtimeKind is openclaw-cli but no mode resolved');
            console.error('nextAction: Provide --openclaw-local or --openclaw-gateway, or set openclawMode in .pd/config.yaml');
          }
          process.exit(1);
          return;
        }
        // Default error formatting for other config resolution errors
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, reason: err.kind, message: err.message, missing: err.missing, nextAction: err.nextAction ?? 'Check .pd/config.yaml and retry' }));
        } else {
          console.error(`error: ${err.message}`);
          if (err.nextAction) {
            console.error(`nextAction: ${err.nextAction}`);
          }
        }
        process.exit(1);
        return;
      }
      throw err;
    }

    const eventEmitter = new StoreEventEmitter();
    const committer = new SqliteDiagnosticianCommitter(sqliteConn);

    // PRI-336: Read outputLanguage from workspace config
    const outputLangResult = readOutputLanguageFromWorkspace(workspaceDir);
    const outputLanguage: OutputLanguage | undefined = outputLangResult.outputLanguage;

    // PRI-638: implementation selection is gone. The split pipeline is the only
    // Diagnostician implementation in the tree, so it always runs with its
    // documented 3-stage budget; `diagnostician_split_pipeline` no longer
    // selects a runner nor disables capability.
    const pipelineTimeoutMs = SPLIT_PIPELINE_TOTAL_TIMEOUT_MS;
    // BUG-1 (PRI-442): extract effectiveConfig so ADR-0019 LLM rate-limit
    // degradation (isDegradationEnabled in base-peer-runner) can read the
    // diagnostician_llm_degradation feature flag. Without this, the runners
    // receive no effectiveConfig and degradation silently never fires.
    // CR-1 (CodeRabbit P2, rc-9): warn when config load failed so the
    // fallback to defaults is observable — no silent degradation.
    if (!configLoadResult.ok) {
      const errSummary = configLoadResult.errors
        .map((e) => `${e.path}: ${e.reason}`)
        .join('; ');
      console.warn(
        `[pd diagnose] .pd/config.yaml at ${configLoadResult.configPath} is malformed — falling back to default feature flags. Errors: ${errSummary}. Next action: ${configLoadResult.errors[0]?.nextAction ?? 'fix config errors and retry'}`,
      );
    }
    const effectiveConfig = configLoadResult.ok ? configLoadResult.effective : configLoadResult.defaults;

    const resolvedKind = typeof runtimeAdapter.kind === 'function' ? runtimeAdapter.kind() : runtimeKind;
    const perStageTimeoutMs = pipelineTimeoutMs / 3;
    const rootCauseRunner = new DiagRootCauseRunner(
      { stateManager, runtimeAdapter, eventEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultDiagRootCauseValidator(), contextAssembler, contentHashFn },
      { owner: 'pd-cli-diagnose', runtimeKind: resolvedKind, outputLanguage, timeoutMs: perStageTimeoutMs, effectiveConfig },
    );
    const distillerRunner = new DiagDistillerRunner(
      { stateManager, runtimeAdapter, eventEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultDiagDistillerValidator(), contentHashFn },
      { owner: 'pd-cli-diagnose', runtimeKind: resolvedKind, outputLanguage, timeoutMs: perStageTimeoutMs, effectiveConfig },
    );
    const routerRunner = new DiagRouterRunner(
      { stateManager, runtimeAdapter, eventEmitter, artifactStore: stateManager.piArtifactStore, committer, contentHashFn },
      { owner: 'pd-cli-diagnose', runtimeKind: resolvedKind, outputLanguage, timeoutMs: perStageTimeoutMs, effectiveConfig },
    );

    const runner: DiagnosticianRunnerLike = new SplitDiagnosticianRunner({
      rootCauseRunner,
      distillerRunner,
      routerRunner,
      stateManager,
      committer,
      perStageTimeoutMs,
    });

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

    // P0-1 fix: convert non-terminal `retried` to `failed` with reason
    if (result.status === 'retried') {
      result = {
        ...result,
        status: 'failed',
        failureReason: `Max retry loops (${maxRetryLoops}) exceeded without reaching terminal state. ${result.failureReason ?? ''}`,
      };
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
        // PRI-503: admission gate check — refuse non-admitted candidates before
        // intake, mirroring candidate.ts (intake/repair/backfill). Without this,
        // `pd diagnose --intake` could bypass the gate and intake unreviewed
        // candidates. cli-5-failure-no-mutation: refusal path does not call
        // intake(), does not update candidate status, does not write ledger.
        // cli-6-output-next-action: refusal result carries admissionBlock.nextAction.
        const admissionBlock = checkAdmissionGate(candidate);
        if (admissionBlock) {
          intakeFailed = true;
          intakeResults.push({
            candidateId: candidate.candidateId,
            status: 'intake_failed',
            error: `Admission gate refused: ${admissionBlock.reason}`,
            nextAction: admissionBlock.nextAction,
          });
          continue;
        }
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

    // Defect-004 fix: seed dreamer task for each consumed candidate whose
    // recommendation_kind routes to an MVP-enabled internalization channel.
    // Without this, the chain stops at 'consumed' and never reaches internalization
    // (11 of 18 consumed candidates hit this in production). Mirrors the pattern
    // in PainSignalBridge.onDiagnosisComplete (pain-signal-bridge.ts L310-338).
    //
    // DEFECT-005 (PRI-514): the dreamer seed loop is gated ONLY by `opts.intake`,
    // NOT by a global `intakeFailed` flag. A single defer candidate whose intake
    // is refused by the admission gate must NOT poison dreamer seed for sibling
    // candidates that were successfully consumed (EP-03 / ERR-089 sibling-branch
    // defect). Per-candidate eligibility is checked inside the loop via the
    // intake result's status. `intakeFailed` is retained solely for the
    // nextAction/exit-code signaling below (partial failure still exits non-zero).
    if (opts.intake !== false) {
      for (const candidate of candidates) {
        const kind = candidate.recommendationKind;
        if (kind === 'defer' || kind === 'implementation') continue;
        const intakeResult = intakeResults.find((r) => r.candidateId === candidate.candidateId);
        if (!intakeResult || intakeResult.status !== 'consumed') continue;
        try {
          const route = CANDIDATE_KIND_TO_ROUTE[kind ?? ''];
          if (!route) continue;
          const channel = ROUTE_CHANNEL_MAP[route];
          const ready = !!channel && MVP_ENABLED_CHANNELS.has(channel);
          // BUG-2 (PRI-442): resolve sourcePainId from the diagnostician task
          // chain (rc-6 lineage consistency). The candidate itself doesn't carry
          // sourcePainId; it must be resolved from the diagnostician task's
          // diagnosticJson. ERR-004: never invent lineage.
          const sourcePainId = await resolveSourcePainIdFromDiagnostician(stateManager, candidate);
          const seed = buildDreamerSeedFromCandidate(candidate, { route, ready, sourcePainId: sourcePainId ?? undefined });
          // eslint-disable-next-line no-restricted-syntax -- 'in' required for discriminated union narrowing (BridgeTaskSeed | BridgeDecision)
          if ('decision' in seed) continue; // not_internalizable or invalid — skip
          const existingTask = await stateManager.getTask(seed.taskId);
          if (!existingTask) {
            await stateManager.createTask({
              taskId: seed.taskId,
              taskKind: seed.taskKind,
              inputRef: '',
              status: seed.status,
              attemptCount: seed.attemptCount,
              maxAttempts: seed.maxAttempts,
              diagnosticJson: seed.diagnosticJson,
            });
            intakeResults.push({
              candidateId: candidate.candidateId,
              status: 'dreamer_seeded',
              nextAction: `pd task show ${seed.taskId} | pd dreamer run --task-id ${seed.taskId}`,
            });
          }
        } catch (seedErr) {
          intakeResults.push({
            candidateId: candidate.candidateId,
            status: 'dreamer_seed_failed',
            error: seedErr instanceof Error ? seedErr.message : String(seedErr),
            nextAction: `pd candidate internalize --candidate-id ${candidate.candidateId}`,
          });
        }
      }
    }

    if (opts.json) {
      const candidateIds = candidates.map((c) => c.candidateId);
      // CodeRabbit review fix: reflect dreamer seed status in nextAction so
      // the owner knows whether internalization has already started or still
      // needs manual candidate internalize. Previously the message always
      // said "NOT started automatically" even when dreamer tasks were seeded.
      const dreamerSeededCount = intakeResults.filter((r) => r.status === 'dreamer_seeded').length;
      const dreamerSeedFailedCount = intakeResults.filter((r) => r.status === 'dreamer_seed_failed').length;
      const internalizeNextAction = dreamerSeededCount > 0
        ? `Dreamer tasks seeded automatically for ${dreamerSeededCount} candidate(s). To continue, run the dreamer tasks shown in intake.candidates[].${dreamerSeedFailedCount > 0 ? ` (${dreamerSeedFailedCount} candidate(s) failed seeding — see intake.candidates[] for retry guidance.)` : ''}`
        : candidateIds.length > 0
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
        } else if (ir.status === 'dreamer_seeded') {
          // CodeRabbit review fix: surface dreamer seed success in TTY output
          console.log(`    ${ir.candidateId}: dreamer seeded — ${ir.nextAction}`);
        } else if (ir.status === 'dreamer_seed_failed') {
          // CodeRabbit review fix: surface dreamer seed failure in TTY output
          console.log(`    ${ir.candidateId}: DREAMER SEED FAILED — ${ir.error}`);
          console.log(`      Next action: ${ir.nextAction}`);
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
