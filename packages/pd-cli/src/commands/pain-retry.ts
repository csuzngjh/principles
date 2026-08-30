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
  PrincipleTreeLedgerAdapter,
  SqliteDeadLetterStore,
  PainSignalBridge,
  type PainDetectedData,
  type PainSignalBridgeResult,
  type DeadLetterRow,
} from '@principles/core/runtime-v2';
import type { PDRuntimeAdapter, RuntimeConfig, OutputLanguage } from '@principles/core/runtime-v2';
import type { Command } from 'commander';
import { loadPdConfig, computeFlagsFromLoadResult } from '../services/pd-config-loader.js';
import { resolveRuntimeFromPdConfig } from '../services/resolve-runtime-from-pd-config.js';
import { createHash } from 'node:crypto';
/** Layer 0 content-hash (design §6.1); injected so diag writers can attach predecessorSummary hashes. */
const contentHashFn = (input: string): string => createHash('sha256').update(input).digest('hex');
import type { PDTaskStatus } from '@principles/core/runtime-v2';
import { readOutputLanguageFromWorkspace } from '../config-reader.js';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { checkAdmissionGate } from './admission-gate.js';
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
  maxTokens?: number;
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

/**
 * Validate that an unknown value (read from dead_letter_pains.pain_data) has
 * the shape of PainDetectedData.
 *
 * rc-1: Treat parsed JSON as unknown.
 * rc-2: No `as` bypass — use typeof checks and literal narrowing.
 * rc-3: Required fields (painId, painType, source, reason) fail loud.
 * rc-5: Use Object.hasOwn for field presence checks on untrusted objects.
 */
function parsePainDetectedData(value: unknown):
  | { valid: true; data: PainDetectedData }
  | { valid: false; error: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      valid: false,
      error: `painData is not an object (got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value})`,
    };
  }
  const obj = value as Record<string, unknown>;

  // Detect dead-letter error envelopes from SqliteDeadLetterStore parse/serialize failures.
  if (Object.hasOwn(obj, '__deadLetterParseError') || Object.hasOwn(obj, '__deadLetterSerializeError')) {
    return {
      valid: false,
      error: `painData contains dead-letter error envelope: ${JSON.stringify(obj)}`,
    };
  }

  // Required string fields
  if (typeof obj.painId !== 'string' || obj.painId.trim().length === 0) {
    return { valid: false, error: `painData.painId is not a non-blank string (got ${JSON.stringify(obj.painId)})` };
  }
  if (typeof obj.source !== 'string') {
    return { valid: false, error: `painData.source is not a string (got ${JSON.stringify(obj.source)})` };
  }
  if (typeof obj.reason !== 'string') {
    return { valid: false, error: `painData.reason is not a string (got ${JSON.stringify(obj.reason)})` };
  }

  // painType: narrow to literal union without `as`.
  const painTypeRaw = obj.painType;
  if (painTypeRaw !== 'tool_failure' && painTypeRaw !== 'dispatch_error'
      && painTypeRaw !== 'subagent_error' && painTypeRaw !== 'user_frustration') {
    return { valid: false, error: `painData.painType is not a valid pain type (got ${JSON.stringify(painTypeRaw)})` };
  }
  // After the narrowing check above, TypeScript infers painTypeRaw as the literal union.
  const painType: PainDetectedData['painType'] = painTypeRaw === 'dispatch_error' ? 'tool_failure' : painTypeRaw;

  // Build the typed object field-by-field. Optional fields are added only when present and valid.
  const data: PainDetectedData = {
    painId: obj.painId,
    painType,
    source: obj.source,
    reason: obj.reason,
  };

  if (Object.hasOwn(obj, 'score')) {
    if (typeof obj.score !== 'number' || !Number.isFinite(obj.score)) {
      return { valid: false, error: `painData.score is not a finite number (got ${JSON.stringify(obj.score)})` };
    }
    data.score = obj.score;
  }
  if (Object.hasOwn(obj, 'sessionId')) {
    if (typeof obj.sessionId !== 'string') return { valid: false, error: 'painData.sessionId is not a string' };
    data.sessionId = obj.sessionId;
  }
  if (Object.hasOwn(obj, 'agentId')) {
    if (typeof obj.agentId !== 'string') return { valid: false, error: 'painData.agentId is not a string' };
    data.agentId = obj.agentId;
  }
  if (Object.hasOwn(obj, 'taskId')) {
    if (typeof obj.taskId !== 'string') return { valid: false, error: 'painData.taskId is not a string' };
    data.taskId = obj.taskId;
  }
  if (Object.hasOwn(obj, 'traceId')) {
    if (typeof obj.traceId !== 'string') return { valid: false, error: 'painData.traceId is not a string' };
    data.traceId = obj.traceId;
  }
  if (Object.hasOwn(obj, 'provenance')) {
    const prov = obj.provenance;
    // host_context_bound is the current value (SPEC §12); the legacy
    // openclaw_context_bound spelling remains valid for replay of old dead letters.
    if (prov !== 'host_context_bound' && prov !== 'openclaw_context_bound' && prov !== 'owner_reported_no_host_trace' && prov !== 'automatic_hook') {
      return { valid: false, error: `painData.provenance is not a known literal (got ${JSON.stringify(prov)})` };
    }
    data.provenance = prov === 'openclaw_context_bound' ? 'host_context_bound' : prov;
  }
  if (Object.hasOwn(obj, 'evidence')) {
    if (!Array.isArray(obj.evidence)) {
      return { valid: false, error: 'painData.evidence is not an array' };
    }
    // Validate each entry has the PainEvidenceEntry shape { sourceRef: string, note: string }.
    const evidence: { sourceRef: string; note: string }[] = [];
    for (let i = 0; i < obj.evidence.length; i++) {
      const entry = obj.evidence[i];
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return { valid: false, error: `painData.evidence[${i}] is not an object` };
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.sourceRef !== 'string' || typeof e.note !== 'string') {
        return { valid: false, error: `painData.evidence[${i}] missing string fields sourceRef/note` };
      }
      evidence.push({ sourceRef: e.sourceRef, note: e.note });
    }
    data.evidence = evidence;
  }

  return { valid: true, data };
}

/** Output a refused/not_found result, respecting --json mode. Exits with code 1. */
function refuseExit(opts: PainRetryOptions, payload: { status?: string; painId: string; taskId?: string; reason: string; message?: string; nextAction: string }): void {
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
  // eslint-disable-next-line no-restricted-syntax -- 'in' required for discriminated union narrowing (taskId vs reason/nextAction)
  if ('reason' in resolution) {
    return refuseExit(opts, { painId: opts.painId, reason: resolution.reason, nextAction: resolution.nextAction });
  }

  const { taskId } = resolution;

  // Step 2: Look up task and validate
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    const task = await stateManager.getTask(taskId);

    // Dead letter replay: when no task exists, check if the pain signal was
    // persisted to dead_letter_pains (rc-9: no silent failure in pain.ts).
    // If found, replay it through PainSignalBridge.onPainDetected.
    let deadLetterReplay: { data: PainDetectedData; row: DeadLetterRow } | null = null;
    if (!task) {
      const dlStore = new SqliteDeadLetterStore(stateManager.connection);
      const dlRow = dlStore.getByPainId(opts.painId);
      if (!dlRow) {
        return refuseExit(opts, {
          status: 'not_found',
          painId: opts.painId,
          taskId,
          reason: 'task_not_found',
          message: `No task found for painId '${opts.painId}' (looked for taskId '${taskId}') and no dead letter found`,
          nextAction: `Verify the painId is correct. Use 'pd task list --kind diagnostician' to see all diagnostician tasks.`,
        });
      }
      const parseResult = parsePainDetectedData(dlRow.painData);
      if (!parseResult.valid) {
        return refuseExit(opts, {
          painId: opts.painId,
          taskId,
          reason: 'dead_letter_corrupt',
          message: `Dead letter for painId '${opts.painId}' has corrupt painData: ${parseResult.error}`,
          nextAction: `The dead letter row cannot be replayed. Inspect the dead_letter_pains table directly: SELECT * FROM dead_letter_pains WHERE pain_id = '${opts.painId}'`,
        });
      }
      deadLetterReplay = { data: parseResult.data, row: dlRow };
    }

    if (task && task.taskKind !== 'diagnostician') {
      return refuseExit(opts, {
        painId: opts.painId,
        taskId,
        reason: 'wrong_task_kind',
        message: `Task '${taskId}' is not a diagnostician task (taskKind='${task.taskKind}')`,
        nextAction: `pd pain retry only retries diagnostician tasks. Use 'pd diagnose run --task-id ${taskId}' for other task kinds.`,
      });
    }

    // For dead letter replay there is no prior task; synthesize a status so the
    // existing logging/output paths have a non-null value to print.
    const previousTaskStatus: PDTaskStatus | 'dead_lettered' = task ? task.status : 'dead_lettered';
    const previousLastError = task ? (task.lastError ?? null) : null;

    if (task && task.status === 'succeeded' && !opts.force) {
      return refuseExit(opts, {
        painId: opts.painId,
        taskId,
        reason: 'already_succeeded',
        message: `Task '${taskId}' already succeeded. Use --force to re-run a succeeded task.`,
        nextAction: `Add --force to retry: pd pain retry --pain-id ${opts.painId} --force`,
      });
    }

    if (task && !RETRYABLE_STATUSES.has(task.status) && task.status !== 'succeeded') {
      return refuseExit(opts, {
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
      return refuseExit(opts, {
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
      return refuseExit(opts, {
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
        return refuseExit(opts, { painId: opts.painId, taskId, reason: configResult.reason, message: configResult.message, nextAction: configResult.nextAction });
      }
      const { openclawMode } = configResult;
      // CLI flags override config (PRI-393)
      const flagMode = opts.openclawLocal ? 'local' as const : opts.openclawGateway ? 'gateway' as const : undefined;
      const effectiveMode = flagMode ?? openclawMode;
      if (!effectiveMode) {
        return refuseExit(opts, {
          painId: opts.painId,
          taskId,
          reason: 'missing_openclaw_mode',
          message: 'runtimeKind is openclaw-cli but no mode resolved',
          nextAction: 'Provide --openclaw-local or --openclaw-gateway',
        });
      }

      runtimeAdapter = new OpenClawCliRuntimeAdapter({
        runtimeMode: effectiveMode,
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
      const maxTokens = opts.maxTokens ?? policyConfig?.maxTokens;
      const effectiveTimeoutMs = opts.timeoutMs ?? policyConfig?.timeoutMs;

      // Validate required string fields: must be non-blank strings
      const missing: string[] = [];
      if (readNonBlankString(provider) === null) missing.push('provider');
      if (readNonBlankString(model) === null) missing.push('model');
      if (readNonBlankString(apiKeyEnv) === null) missing.push('apiKeyEnv');
      if (missing.length > 0) {
        return refuseExit(opts, {
          painId: opts.painId,
          taskId,
          reason: `missing_required_config: ${missing.join(', ')}`,
          message: `Missing or blank required pi-ai config: ${missing.join(', ')}`,
          nextAction: `Pass via --flag or add to .pd/config.yaml. Example: pd pain retry --pain-id ${opts.painId} --runtime pi-ai --provider openrouter --model anthropic/claude-sonnet-4 --apiKeyEnv OPENROUTER_API_KEY`,
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
      if (maxTokens !== undefined && maxTokens !== null && !(Number.isFinite(maxTokens) && maxTokens > 0)) {
        invalidNumeric.push(`maxTokens (got: ${maxTokens})`);
      }
      if (invalidNumeric.length > 0) {
        return refuseExit(opts, {
          painId: opts.painId,
          taskId,
          reason: `invalid_numeric_config: ${invalidNumeric.join(', ')}`,
          message: `Invalid numeric pi-ai config: ${invalidNumeric.join(', ')}. maxRetries must be a non-negative integer; timeoutMs and maxTokens must be positive numbers.`,
          nextAction: 'Fix the numeric values and retry.',
        });
      }

      // After validation, these are guaranteed non-blank strings.
      const validProvider = readNonBlankString(provider);
      const validModel = readNonBlankString(model);
      const validApiKeyEnv = readNonBlankString(apiKeyEnv);
      if (validProvider === null || validModel === null || validApiKeyEnv === null) {
        return refuseExit(opts, {
          painId: opts.painId,
          taskId,
          reason: 'internal_validation_error',
          message: 'Internal error: validated string fields became null after validation.',
          nextAction: 'This should not happen. Please report this bug.',
        });
      }

      if (!process.env[validApiKeyEnv]) {
        return refuseExit(opts, {
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
        maxTokens,
        timeoutMs: effectiveTimeoutMs,
        workspace: workspaceDir,
      });
    } else {
      return refuseExit(opts, {
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
        `[pd pain retry] .pd/config.yaml at ${configLoadResult.configPath} is malformed — falling back to default feature flags. Errors: ${errSummary}. Next action: ${configLoadResult.errors[0]?.nextAction ?? 'fix config errors and retry'}`,
      );
    }
    const effectiveConfig = configLoadResult.ok ? configLoadResult.effective : configLoadResult.defaults;

    let runner: DiagnosticianRunnerLike;
    if (isSplitPipeline) {
      const resolvedKind = typeof runtimeAdapter.kind === 'function' ? runtimeAdapter.kind() : runtimeKind;
      const perStageTimeoutMs = pipelineTimeoutMs / 3;
      const rootCauseRunner = new DiagRootCauseRunner(
        { stateManager, runtimeAdapter, eventEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultDiagRootCauseValidator(), contextAssembler, contentHashFn },
        { owner: 'pd-cli-pain-retry', runtimeKind: resolvedKind, outputLanguage, timeoutMs: perStageTimeoutMs, effectiveConfig },
      );
      const distillerRunner = new DiagDistillerRunner(
        { stateManager, runtimeAdapter, eventEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultDiagDistillerValidator(), contentHashFn },
        { owner: 'pd-cli-pain-retry', runtimeKind: resolvedKind, outputLanguage, timeoutMs: perStageTimeoutMs, effectiveConfig },
      );
      const routerRunner = new DiagRouterRunner(
        { stateManager, runtimeAdapter, eventEmitter, artifactStore: stateManager.piArtifactStore, committer, contentHashFn },
        { owner: 'pd-cli-pain-retry', runtimeKind: resolvedKind, outputLanguage, timeoutMs: perStageTimeoutMs, effectiveConfig },
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

    // ── Dead letter replay branch ──────────────────────────────────────────
    // When task was null but a dead letter was found, replay the pain signal
    // through PainSignalBridge.onPainDetected instead of calling diagnoseRun.
    // On success/failure, markRetried updates the dead_letter_pains row.
    if (deadLetterReplay) {
      const dlStore = new SqliteDeadLetterStore(stateManager.connection);
      if (!opts.json) {
        console.log(`\nReplaying dead letter pain: ${opts.painId}`);
        console.log(`  Task ID:        ${taskId}`);
        console.log(`  Dead Letter ID: ${deadLetterReplay.row.id}`);
        console.log(`  Failed At:      ${deadLetterReplay.row.failedAt}`);
        console.log(`  Retry Count:    ${deadLetterReplay.row.retryCount}`);
        console.log(`  Runtime:        ${runtimeKind}`);
        console.log(`  Workspace:      ${workspaceDir}\n`);
      }

      const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: path.join(workspaceDir, '.state') });
      const intakeService = new CandidateIntakeService({ stateManager, ledgerAdapter });
      const bridge = new PainSignalBridge({
        stateManager,
        runner,
        intakeService,
        ledgerAdapter,
        owner: 'pd-cli-pain-retry-dead-letter',
        workspaceDir,
      });

      let bridgeResult: PainSignalBridgeResult;
      try {
        bridgeResult = await bridge.onPainDetected(deadLetterReplay.data);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const markFail = dlStore.markRetried(opts.painId, false);
        if (opts.json) {
          console.log(JSON.stringify({
            status: 'failed',
            painId: opts.painId,
            taskId,
            source: 'dead_letter',
            deadLetterId: deadLetterReplay.row.id,
            runtimeKind,
            errorCategory: 'execution_failed',
            message: errorMessage,
            markRetriedOk: markFail.ok,
            nextAction: 'Replay threw; retry_count incremented. Adjust parameters and run pd pain retry --pain-id again.',
          }, null, 2));
        } else {
          console.error(`error: ${errorMessage}`);
          console.error(`nextAction: Replay threw; retry_count incremented. Adjust parameters and try again.`);
        }
        process.exit(1);
        return;
      }

      const success = bridgeResult.status === 'succeeded';
      const markResult = dlStore.markRetried(opts.painId, success);

      if (opts.json) {
        // cli-1-strict-json: exactly one parseable JSON object on stdout.
        console.log(JSON.stringify({
          status: success ? 'succeeded' : 'failed',
          painId: opts.painId,
          taskId,
          source: 'dead_letter',
          deadLetterId: deadLetterReplay.row.id,
          runtimeKind,
          bridgeStatus: bridgeResult.status,
          candidateIds: bridgeResult.candidateIds,
          ledgerEntryIds: bridgeResult.ledgerEntryIds,
          markRetriedOk: markResult.ok,
          message: bridgeResult.message ?? null,
          nextAction: success
            ? (bridgeResult.candidateIds.length > 0
              ? `Dead letter replayed. Internalize candidates:\n  ${bridgeResult.candidateIds.map((id) => `pd candidate internalize --candidate-id ${id} --workspace "${workspaceDir}"`).join('\n  ')}`
              : 'Dead letter replayed. No candidates generated.')
            : `Replay did not succeed (status=${bridgeResult.status}). The dead letter remains available for future retry.`,
        }, null, 2));
        if (!success) {
          process.exit(1);
        }
        return;
      }

      // Text output
      console.log(`\nReplay ${success ? 'succeeded' : 'failed'}:`);
      console.log(`  Pain ID:         ${opts.painId}`);
      console.log(`  Task ID:         ${taskId}`);
      console.log(`  Dead Letter ID:  ${deadLetterReplay.row.id}`);
      console.log(`  Bridge Status:   ${bridgeResult.status}`);
      if (bridgeResult.message) {
        console.log(`  Message:         ${bridgeResult.message}`);
      }
      if (success) {
        console.log(`  Candidates:      ${bridgeResult.candidateIds.length}`);
        if (bridgeResult.candidateIds.length > 0) {
          console.log(`  Ledger Entries:  ${bridgeResult.ledgerEntryIds.length}`);
        }
      }
      console.log(`  Mark Retried:    ${markResult.ok ? 'ok' : `FAILED: ${markResult.error}`}`);
      if (!success) {
        console.log(`\n  Next Action:`);
        console.log(`  Replay did not succeed. The dead letter remains available for future retry.`);
        process.exit(1);
      }
      return;
    }

    // ── Normal retry branch ─────────────────────────────────────────────────
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
      // PRI-503: admission gate check — refuse non-admitted candidates before
      // intake, mirroring candidate.ts (intake/repair/backfill). Without this,
      // `pd pain retry` could bypass the gate and intake unreviewed candidates.
      // cli-5-failure-no-mutation: refusal path does not call intake(), does
      // not update candidate status, does not write ledger.
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
      return;
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
    return;
  } finally {
    await stateManager.close();
  }
}

/** Register the production `pd pain retry` command and its complete option contract. */
export function registerPainRetryCommand(
  painCmd: Command,
  handler: (opts: PainRetryOptions) => Promise<void> = handlePainRetry,
): Command {
  return painCmd
    .command('retry')
    .description('Retry a failed diagnosis by pain ID')
    .requiredOption('-p, --pain-id <painId>', 'Pain ID to retry diagnosis for')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('-r, --runtime <kind>', "Runtime kind: 'openclaw-cli', 'test-double', 'pi-ai'")
    .option('--openclaw-local', 'Use local OpenClaw (mutually exclusive with --openclaw-gateway)')
    .option('--openclaw-gateway', 'Use gateway OpenClaw (mutually exclusive with --openclaw-local)')
    .option('-a, --agent <agentId>', 'Agent ID to invoke')
    .option('--provider <name>', 'LLM provider (e.g., openrouter) — for pi-ai, falls back to policy')
    .option('--model <id>', 'Model ID (e.g., anthropic/claude-sonnet-4) — for pi-ai, falls back to policy')
    .option('--apiKeyEnv <name>', 'Env var name for API key — for pi-ai, falls back to policy')
    .option('--baseUrl <url>', 'Custom base URL — for pi-ai, falls back to policy')
    .option('--maxRetries <n>', 'Max retry attempts for LLM failures — for pi-ai, falls back to policy', parseInt)
    .option('--maxTokens <n>', 'Max output tokens (max_tokens) for pi-ai LLM calls — for pi-ai, falls back to policy', parseInt)
    .option('--timeoutMs <ms>', 'Timeout in milliseconds — for pi-ai, falls back to policy', parseInt)
    .option('--force', 'Allow retry of already-succeeded tasks')
    .option('--json', 'Output raw JSON')
    .action(async (opts: PainRetryOptions) => {
      await handler(opts);
    });
}
