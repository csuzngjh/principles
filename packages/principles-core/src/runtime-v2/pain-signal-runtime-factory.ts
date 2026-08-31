/**
 * PainSignalRuntimeFactory — creates PainSignalBridge for a given workspace.
 *
 * M8 direction: both openclaw-plugin (after_tool_call hook) and pd-cli
 * use the same PainSignalBridge to enter the Runtime v2 pain chain.
 * pd-cli can call this factory without importing openclaw-plugin private code.
 *
 * Usage:
 *   import { createPainSignalBridge } from '@principles/core/runtime-v2';
 *   const bridge = await createPainSignalBridge({ workspaceDir, stateDir, ledgerAdapter });
 *   await bridge.onPainDetected(data);
 */

import { PainSignalBridge, type DiagnosticianRunnerLike } from './pain-signal-bridge.js';
import type { RunnerResult } from './runner/runner-result.js';
import { RuntimeStateManager } from './store/runtime-state-manager.js';
import { SplitDiagnosticianRunner } from './internalization/split-diagnostician-runner.js';
import { DiagRootCauseRunner } from './internalization/diag-rootcause-runner.js';
import { DiagDistillerRunner } from './internalization/diag-distiller-runner.js';
import { DiagRouterRunner } from './internalization/diag-router-runner.js';
import { DefaultDiagRootCauseValidator } from './diagnostician/diag-rootcause-output.js';
import { DefaultDiagDistillerValidator } from './diagnostician/diag-distiller-output.js';
import { resolveOutputLanguage } from './language-directive.js';
import type { OutputLanguage } from './language-directive.js';
import { computeFeatureFlagsFromConfig, isFeatureEnabled } from './config/pd-config-feature-flags.js';
import { PDRuntimeError } from './error-categories.js';
import { CandidateIntakeService } from './candidate-intake-service.js';
import { SqliteDiagnosticianCommitter } from './store/commit/diagnostician-committer.js';
import { SqliteContextAssembler } from './store/context/sqlite-context-assembler.js';
import type { TrajectoryTurnReader } from './store/context/trajectory-turn-reader.js';
import { SqliteHistoryQuery } from './store/history/sqlite-history-query.js';
import { SqliteConnection } from './store/sqlite-connection.js';
import { SqliteTrajectoryLocator } from './store/trajectory/sqlite-trajectory-locator.js';
import { SqliteSourceTraceLocator } from './store/trajectory/sqlite-source-trace-locator.js';
import { OpenClawCliRuntimeAdapter } from './adapter/openclaw-cli-runtime-adapter.js';
import { PiAiRuntimeAdapter } from './adapter/pi-ai-runtime-adapter.js';
import { isBuiltinPiAiProvider } from './adapter/pi-ai-catalog.js';
import { storeEmitter } from './store/event-emitter.js';
import type { TelemetryEvent } from '../telemetry-event.js';
import { WorkflowFunnelLoader } from '../workflow-funnel-loader.js';
import type { RuntimeKind, PDRuntimeAdapter } from './runtime-protocol.js';
import type { LedgerAdapter } from './candidate-intake.js';
import type { IntentDocReader } from './intent/intent-doc-reader-port.js';
import {
  resolveAgentRuntimeBinding,
  checkAgentRuntimeReadiness,
  createAdapterConfigFromProfile,
} from './config/pd-config-agent-binding.js';
import type { EffectivePdConfig } from './config/pd-config-types.js';

export interface PainSignalRuntimeFactoryOptions {
  workspaceDir: string;
  stateDir: string;
  ledgerAdapter: LedgerAdapter;
  owner?: string;
  autoIntakeEnabled?: boolean;
  /** PRI-306: Effective PD config for config-driven runtime binding.
   *  When provided, takes precedence over WorkflowFunnelLoader. */
  effectiveConfig?: EffectivePdConfig;
  /** PRI-306: Env var accessor for readiness checks. Defaults to process.env. */
  getEnvVar?: (name: string) => string | undefined;
  /**
   * PRI-468: Optional INTENT.md reader for Stage A intent tension check.
   *
   * Provided by the plugin layer (which owns filesystem I/O). When present
   * AND `intent_engineering` flag is on, Stage A reads INTENT.md and
   * injects it into the prompt. When absent, intent_engineering degrades
   * silently to off (telemetry emitted by the runner).
   *
   * Core never performs filesystem I/O — it only consumes the port.
   */
  intentDocReader?: IntentDocReader;
  trajectoryTurnReader?: TrajectoryTurnReader;
}

/** Funnel name for the Runtime v2 diagnosis path. */
const DIAGNOSTIC_FUNNEL_ID = 'pd-runtime-v2-diagnosis';

/** Default per-stage timeout (5 min). Same for monolith and split-per-stage. */
const DEFAULT_TIMEOUT_MS = 300_000;

/** Total timeout for the 3-stage split pipeline (3 × 20 min = 60 min).
 *  Local GPU inference (e.g. qwen3.6-27b-mtp with 200K context) needs
 *  10-18 min per stage; 20 min per stage provides headroom.
 *  Shared with pd-cli diagnose command. */
export const SPLIT_PIPELINE_TOTAL_TIMEOUT_MS = 3_600_000;

/** Resolved runtime configuration from funnel policy. */
export interface RuntimeConfig {
  runtimeKind: RuntimeKind;
  openclawMode?: 'local' | 'gateway';
  timeoutMs: number;
  agentId: string;
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  maxRetries?: number;
  /** Max output tokens (max_tokens) for pi-ai LLM calls. */
  maxTokens?: number;
  /** Custom base URL for OpenAI-compatible providers not in pi-ai's built-in registry. */
  baseUrl?: string;
  /** Optional system prompt (flows from profile to PiAiRuntimeAdapter). */
  systemPrompt?: string;
}

export interface RuntimeConfigError {
  ok: false;
  reason: string;
  message: string;
  nextAction: string;
}

export type RuntimeConfigResult = RuntimeConfig | RuntimeConfigError;

export function isRuntimeConfigError(result: RuntimeConfigResult): result is RuntimeConfigError {
  // eslint-disable-next-line no-restricted-syntax -- 'in' required for discriminated union narrowing (RuntimeConfig | RuntimeConfigError)
  return 'ok' in result && result.ok === false;
}

export interface ResolveRuntimeConfigOptions {
  openclawLocal?: boolean;
  openclawGateway?: boolean;
  requestedRuntimeKind?: string;
}

/**
 * Resolve runtime configuration from the pd-runtime-v2-diagnosis funnel policy.
 * Falls back to defaults if no funnel is found.
 *
 * @deprecated PRI-393: This function reads .state/workflows.yaml and MUST NOT be
 * called by production execution paths (probe, run-once, diagnose, pain-retry).
 * Use resolveRuntimeConfigFromPdConfig() with loadPdConfig() instead.
 * Retained only for legacy warning / migration detection.
 *
 * When `requestedRuntimeKind === 'openclaw-cli'` or policy `runtimeKind === 'openclaw-cli'`:
 *   - CLI flag or file config must provide exactly one mode (local or gateway).
 *   - Both provided: fail loud (conflicting mode).
 *   - Neither provided: fail loud (missing mode).
 *
 * When `requestedRuntimeKind === 'config'` (explicit config):
 *   - Config load failure, missing config, or schema error must fail loud.
 *   - Only non-explicit config compatibility paths allow fallback.
 */
export function resolveRuntimeConfig(stateDir: string, explicitConfig?: ResolveRuntimeConfigOptions): RuntimeConfigResult {
  const requestedRuntimeKind = explicitConfig?.requestedRuntimeKind;

  try {
    const loader = new WorkflowFunnelLoader(stateDir);
    const funnel = loader.getFunnel(DIAGNOSTIC_FUNNEL_ID);
    if (!funnel || !funnel.policy) {
      if (requestedRuntimeKind === 'config') {
        return {
          ok: false,
          reason: 'explicit_config_missing',
          message: 'runtime=config requested but no workflows.yaml funnel policy found',
          nextAction: 'Create a pd-runtime-v2-diagnosis funnel policy in workflows.yaml, or use --runtime pi-ai / openclaw-cli with explicit flags',
        };
      }

      if (requestedRuntimeKind === 'openclaw-cli') {
        if (explicitConfig?.openclawLocal && explicitConfig?.openclawGateway) {
          return {
            ok: false,
            reason: 'conflicting_openclaw_mode',
            message: 'Both --openclaw-local and --openclaw-gateway specified — provide exactly one',
            nextAction: 'Use only one of --openclaw-local or --openclaw-gateway',
          };
        }
        const flagMode = explicitConfig?.openclawLocal ? 'local' as const : explicitConfig?.openclawGateway ? 'gateway' as const : undefined;
        if (!flagMode) {
          return {
            ok: false,
            reason: 'missing_openclaw_mode',
            message: 'runtimeKind is openclaw-cli but no mode specified — need --openclaw-local or --openclaw-gateway, or openclawMode in workflows.yaml',
            nextAction: 'Provide exactly one mode: --openclaw-local, --openclaw-gateway, or openclawMode: local|gateway in workflows.yaml',
          };
        }
        return {
          runtimeKind: 'openclaw-cli',
          openclawMode: flagMode,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          agentId: 'main',
        };
      }

      return {
        runtimeKind: 'pi-ai',
        timeoutMs: DEFAULT_TIMEOUT_MS,
        agentId: 'main',
      };
    }
    const {policy} = funnel;
    const config: RuntimeConfig = {
      runtimeKind: policy.runtimeKind ?? 'pi-ai',
      openclawMode: policy.openclawMode,
      timeoutMs: policy.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      agentId: 'main',
      provider: policy.provider,
      model: policy.model,
      apiKeyEnv: policy.apiKeyEnv,
      maxRetries: policy.maxRetries,
      baseUrl: policy.baseUrl,
    };

    if (config.runtimeKind === 'openclaw-cli') {
      const fileMode = config.openclawMode;
      if (explicitConfig?.openclawLocal && explicitConfig?.openclawGateway) {
        return {
          ok: false,
          reason: 'conflicting_openclaw_mode',
          message: 'Both --openclaw-local and --openclaw-gateway specified — provide exactly one',
          nextAction: 'Use only one of --openclaw-local or --openclaw-gateway',
        };
      }
      const flagMode = explicitConfig?.openclawLocal ? 'local' as const : explicitConfig?.openclawGateway ? 'gateway' as const : undefined;

      if (flagMode && fileMode && flagMode !== fileMode) {
        return {
          ok: false,
          reason: 'conflicting_openclaw_mode',
          message: `CLI flag specifies --openclaw-${flagMode} but workflows.yaml specifies openclawMode: ${fileMode}`,
          nextAction: 'Remove one of the conflicting mode specifications, or align them',
        };
      }

      const effectiveMode = flagMode ?? fileMode;
      if (!effectiveMode) {
        return {
          ok: false,
          reason: 'missing_openclaw_mode',
          message: 'runtimeKind is openclaw-cli but no mode specified — need --openclaw-local or --openclaw-gateway, or openclawMode in workflows.yaml',
          nextAction: 'Provide exactly one mode: --openclaw-local, --openclaw-gateway, or openclawMode: local|gateway in workflows.yaml',
        };
      }

      config.openclawMode = effectiveMode;
    }

    return config;
  } catch (err) {
    if (requestedRuntimeKind === 'config') {
      return {
        ok: false,
        reason: 'explicit_config_load_failed',
        message: `runtime=config requested but config load failed: ${err instanceof Error ? err.message : String(err)}`,
        nextAction: 'Fix the workflows.yaml funnel policy, or use --runtime pi-ai / openclaw-cli with explicit flags',
      };
    }

    console.warn(`[PainSignalRuntimeFactory] Funnel loading failed for ${DIAGNOSTIC_FUNNEL_ID}, using defaults: ${String(err)}`);
    return {
      runtimeKind: 'pi-ai',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      agentId: 'main',
    };
  }
}

/**
 * Validate runtime configuration before adapter creation (D-02).
 * Throws plain Error (not PDRuntimeError) for config issues (D-06).
 * Includes migration guidance for D-05 breaking change.
 */
export function validateRuntimeConfig(config: RuntimeConfig): void {
  if (config.runtimeKind === 'openclaw-cli') {
    // PRI-306: openclawMode may be undefined when source='default' (delegated).
    // The adapter will not append any mode flag, letting OpenClaw decide.
    // Only reject an explicit invalid string value.
    if (config.openclawMode !== undefined
      && config.openclawMode !== 'local'
      && config.openclawMode !== 'gateway') {
      throw new Error(
        `[PainSignalRuntimeFactory] Invalid openclawMode '${String(config.openclawMode)}'. ` +
        `Must be 'local', 'gateway', or undefined (delegate to OpenClaw). ` +
        `nextAction: Set openclawMode: local|gateway in your config, or omit for delegated mode.`,
      );
    }
  }

  if (config.runtimeKind === 'pi-ai') {
    const missing: string[] = [];
    if (!config.provider) missing.push('provider');
    if (!config.model) missing.push('model');
    if (!config.apiKeyEnv) missing.push('apiKeyEnv');

    // Non-built-in providers require baseUrl
    if (config.provider) {
      if (!isBuiltinPiAiProvider(config.provider) && !config.baseUrl) {
        missing.push('baseUrl');
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `[PainSignalRuntimeFactory] Missing required fields for runtimeKind 'pi-ai': ${missing.join(', ')}. ` +
        `Add these fields to your workflows.yaml pd-runtime-v2-diagnosis funnel policy. ` +
        `Example:\n` +
        `  policy:\n` +
        `    runtimeKind: pi-ai\n` +
        `    provider: xiaomi-coding\n` +
        `    model: mimo-v2.5-pro\n` +
        `    apiKeyEnv: ANTHROPIC_AUTH_TOKEN\n` +
        `    baseUrl: https://token-plan-cn.xiaomimimo.com/v1\n` +
        `\nIf you want to use the OpenClaw CLI runtime instead, set runtimeKind: openclaw-cli`,
      );
    }
  }
}

/**
 * PRI-306: Resolve runtime configuration from EffectivePdConfig.
 *
 * Uses resolveAgentRuntimeBinding() to determine which profile the diagnostician
 * should use, then checks readiness and produces adapter config.
 *
 * This is the new config-driven path that replaces WorkflowFunnelLoader.
 * When effectiveConfig is provided, this path takes precedence.
 */
export function resolveRuntimeConfigFromPdConfig(
  effectiveConfig: EffectivePdConfig,
  getEnvVar: (name: string) => string | undefined,
): RuntimeConfigResult {
  // Resolve binding for the diagnostician agent
  const bindingResult = resolveAgentRuntimeBinding(effectiveConfig, 'diagnostician');
  if (!bindingResult.ok) {
    return {
      ok: false,
      reason: bindingResult.readiness,
      message: bindingResult.reason,
      nextAction: bindingResult.nextAction,
    };
  }

  // Check readiness (env vars, provider, etc.)
  const readiness = checkAgentRuntimeReadiness(bindingResult.profile, getEnvVar);
  if (readiness.readiness !== 'ready') {
    return {
      ok: false,
      reason: readiness.readiness,
      message: readiness.reason ?? `Agent runtime profile '${bindingResult.profileId}' is not ready`,
      nextAction: readiness.nextAction ?? 'Check .pd/config.yaml runtime profile configuration',
    };
  }

  // Convert profile to adapter config
  const adapterConfig = createAdapterConfigFromProfile(bindingResult.profile, '');

  if (adapterConfig.runtimeKind === 'pi-ai') {
    return {
      runtimeKind: 'pi-ai',
      provider: adapterConfig.provider,
      model: adapterConfig.model,
      apiKeyEnv: adapterConfig.apiKeyEnv,
      baseUrl: adapterConfig.baseUrl,
      timeoutMs: adapterConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: adapterConfig.maxRetries,
      maxTokens: adapterConfig.maxTokens,
      agentId: 'main',
      ...(adapterConfig.systemPrompt ? { systemPrompt: adapterConfig.systemPrompt } : {}),
    };
  }

  // openclaw-cli
  // openclawMode='default' means "delegate to OpenClaw's own mode resolution" → omit openclawMode
  // so the factory's existing mode resolution (CLI flags, workflows.yaml) decides
  const result: RuntimeConfig = {
    runtimeKind: 'openclaw-cli',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    agentId: 'main',
  };
  if (adapterConfig.openclawMode !== 'default') {
    result.openclawMode = adapterConfig.openclawMode;
  }
  return result;
}

// Per-workspace+runtime+mode bridge cache — same lifetime as process
// Key format: `${workspaceDir}:${runtimeKind}:${openclawMode ?? ''}` (D-03)
const bridgeCache = new Map<string, PainSignalBridge>();

/**
 * DisabledDiagnosticianRunner — used when the split pipeline feature flag is disabled (PRI-373).
 * Fails loud with capability_missing, preventing silent monlith fallback.
 */
export class DisabledDiagnosticianRunner implements DiagnosticianRunnerLike {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async run(taskId: string): Promise<RunnerResult> {
    return {
      status: 'failed',
      taskId,
      errorCategory: 'capability_missing',
      failureReason: 'Diagnostician pipeline is disabled by feature flag (diagnostician_split_pipeline=false)',
      attemptCount: 1,
    };
  }
}

// Pain Diagnosis Persistence: the bridge emits ad-hoc event names that are not
// in the closed TelemetryEventType union, so only the two persistence
// degradation events are mapped onto the registered degradation_triggered
// channel. The bridge's OTHER event names (candidate_admission_decision,
// candidate_dreamer_task_seeded, candidate_dreamer_task_seed_failed,
// candidate_not_internalizable) were dormant on main — no emitter was wired
// there — and must STAY dormant here: forwarding them as degradation_triggered
// would mislabel routine admission decisions as degradations and change
// flag-off behavior (PR contract: flag off = zero effective surface).
const BRIDGE_DEGRADATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'pain_diagnosis_persist_skipped',
  'pain_diagnosis_persist_failed',
]);

/**
 * Map a PainSignalBridge telemetry event onto a storable TelemetryEvent.
 * Returns null for bridge events that were not emitted in production before
 * the persistence feature (they keep their pre-main dormant status).
 */
export function mapBridgeTelemetryToStoreEvent(event: {
  eventType: string;
  traceId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}): TelemetryEvent | null {
  if (!BRIDGE_DEGRADATION_EVENT_TYPES.has(event.eventType)) return null;
  return {
    eventType: 'degradation_triggered',
    traceId: event.traceId,
    timestamp: event.timestamp,
    sessionId: '',
    payload: { component: 'PainSignalBridge', originalEventType: event.eventType, ...event.payload },
  };
}

async function constructBridge(
  opts: PainSignalRuntimeFactoryOptions,
  runtimeConfig: RuntimeConfig,
  pipeline: { useSplitPipeline: boolean; diagnosisPersistenceEnabled: boolean },
): Promise<PainSignalBridge> {
  const stateManager = new RuntimeStateManager({ workspaceDir: opts.workspaceDir });
  await stateManager.initialize();

  const connection = new SqliteConnection(opts.workspaceDir);
  const historyQuery = new SqliteHistoryQuery(connection);
  const committer = new SqliteDiagnosticianCommitter(connection);
  const trajectoryLocator = new SqliteTrajectoryLocator(connection);
  const sourceTraceLocator = new SqliteSourceTraceLocator(stateManager.taskStore, trajectoryLocator);

  const contextAssembler = new SqliteContextAssembler(
    stateManager.taskStore,
    historyQuery,
    stateManager.runStore,
    { sourceTraceLocator, trajectoryTurnReader: opts.trajectoryTurnReader },
  );

  const runtimeAdapter: PDRuntimeAdapter = runtimeConfig.runtimeKind === 'pi-ai'
    ? new PiAiRuntimeAdapter({
        provider: String(runtimeConfig.provider),
        model: String(runtimeConfig.model),
        apiKeyEnv: String(runtimeConfig.apiKeyEnv),
        maxRetries: runtimeConfig.maxRetries,
        maxTokens: runtimeConfig.maxTokens,
        timeoutMs: runtimeConfig.timeoutMs,
        baseUrl: runtimeConfig.baseUrl,
        workspace: opts.workspaceDir,
        ...(runtimeConfig.systemPrompt ? { systemPrompt: runtimeConfig.systemPrompt } : {}),
      })
    : new OpenClawCliRuntimeAdapter({
        runtimeMode: runtimeConfig.openclawMode ?? 'default',
        workspaceDir: opts.workspaceDir,
      });

  // PRI-336: Resolve outputLanguage from effective config
  // Per EP-07: use canonical resolved value, not raw input
  const resolvedLang = resolveOutputLanguage(opts.effectiveConfig?.config.principles?.outputLanguage);
  const outputLanguage: OutputLanguage = resolvedLang.outputLanguage;

  // Per ERR-002: degradation must be observable, not silent fallback
  if (resolvedLang.degradationWarning) {
    storeEmitter.emitTelemetry({
      eventType: 'degradation_triggered',
      traceId: `output-language-config-${Date.now()}`,
      timestamp: new Date().toISOString(),
      sessionId: '',
      payload: {
        component: 'PainSignalRuntimeFactory',
        reason: 'invalid_output_language_config',
        warning: resolvedLang.degradationWarning,
        fallbackValue: resolvedLang.outputLanguage,
      },
    });
  }

  let runner: DiagnosticianRunnerLike;

  if (pipeline.useSplitPipeline) {
    // P0-1 fix: onDiagnosisComplete is no longer wired into the router.
    // The bridge (PainSignalBridge.onPainDetected) is the sole invocation point.

    const rootCauseRunner = new DiagRootCauseRunner(
      { stateManager, runtimeAdapter, eventEmitter: storeEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultDiagRootCauseValidator(), contextAssembler, intentDocReader: opts.intentDocReader },
      { owner: opts.owner ?? 'pain-signal-bridge', runtimeKind: runtimeConfig.runtimeKind, outputLanguage, effectiveConfig: opts.effectiveConfig },
    );
    const distillerRunner = new DiagDistillerRunner(
      { stateManager, runtimeAdapter, eventEmitter: storeEmitter, artifactStore: stateManager.piArtifactStore, validator: new DefaultDiagDistillerValidator() },
      { owner: opts.owner ?? 'pain-signal-bridge', runtimeKind: runtimeConfig.runtimeKind, outputLanguage, effectiveConfig: opts.effectiveConfig },
    );
    const routerRunner = new DiagRouterRunner(
      { stateManager, runtimeAdapter, eventEmitter: storeEmitter, artifactStore: stateManager.piArtifactStore, committer },
      { owner: opts.owner ?? 'pain-signal-bridge', runtimeKind: runtimeConfig.runtimeKind, outputLanguage },
    );

    runner = new SplitDiagnosticianRunner({
      rootCauseRunner,
      distillerRunner,
      routerRunner,
      stateManager,
      committer,
      perStageTimeoutMs: runtimeConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  } else {
    runner = new DisabledDiagnosticianRunner();
  }

  const intakeService = new CandidateIntakeService({
    stateManager,
    ledgerAdapter: opts.ledgerAdapter,
  });

  const bridge = new PainSignalBridge({
    stateManager,
    runner,
    intakeService,
    ledgerAdapter: opts.ledgerAdapter,
    autoIntakeEnabled: opts.autoIntakeEnabled ?? true,
    workspaceDir: opts.workspaceDir,
    diagnosisPersistenceEnabled: pipeline.diagnosisPersistenceEnabled,
    // rc-9: the persistence path must degrade observably in production. Only
    // the persistence degradation events are forwarded (see
    // mapBridgeTelemetryToStoreEvent); other bridge events stay dormant as on main.
    eventEmitter: {
      emitTelemetry: (event) => {
        const mapped = mapBridgeTelemetryToStoreEvent(event);
        if (mapped) storeEmitter.emitTelemetry(mapped);
      },
    },
    // PRI-624: the factory opens one extra connection (history/committer/
    // context assemblers) beyond the state manager — dispose() releases both.
    ownedResources: [connection],
  });

  return bridge;
}

/**
 * PRI-624: dispose + drop every cached bridge for a workspace, releasing
 * their SQLite handles. Per-cycle workers (Companion workspace worker) call
 * this after execution; long-lived hosts that reuse the cached bridge do not.
 */
export async function disposePainSignalBridgesForWorkspace(workspaceDir: string): Promise<void> {
  const prefix = `${workspaceDir}:`;
  const doomed: PainSignalBridge[] = [];
  for (const [key, bridge] of bridgeCache) {
    if (key.startsWith(prefix)) {
      doomed.push(bridge);
      bridgeCache.delete(key);
    }
  }
  for (const bridge of doomed) {
    try { await bridge.dispose(); } catch { /* best-effort cleanup */ }
  }
}

/**
 * Invalidate the cached bridge for a workspace (for testing).
 * Covers both split and disabled pipeline variants.
 */
/**
 * Create (or return cached) PainSignalBridge for a workspace.
 *
 * Initialization is performed on first call for a workspace (async).
 * Subsequent calls for the same workspace return the cached bridge synchronously.
 *
 * Cache key is workspaceDir — one bridge per workspace per process.
 */
export async function createPainSignalBridge(
  opts: PainSignalRuntimeFactoryOptions,
): Promise<PainSignalBridge> {
  // PRI-306: Prefer config-driven binding when effectiveConfig is provided
  let runtimeConfig: RuntimeConfigResult;
  if (opts.effectiveConfig) {
    const getEnv = opts.getEnvVar ?? ((name: string) => process.env[name]);
    runtimeConfig = resolveRuntimeConfigFromPdConfig(opts.effectiveConfig, getEnv);
  } else {
    runtimeConfig = resolveRuntimeConfig(opts.stateDir);
  }

  if (isRuntimeConfigError(runtimeConfig)) {
    throw new Error(
      `[PainSignalRuntimeFactory] Config resolution failed: ${runtimeConfig.reason}. ` +
      `${runtimeConfig.message}. nextAction: ${runtimeConfig.nextAction}`,
    );
  }
  validateRuntimeConfig(runtimeConfig);

  // PRI-373: Resolve split pipeline flag BEFORE cache key to include it in the key.
  // This prevents cache collision when same workspaceDir+runtimeKind+openclawMode
  // is called with different effectiveConfig (e.g., split on vs off).
  let useSplitPipeline = true;
  // Pain Diagnosis Persistence: resolve the flag before the cache key for the
  // same collision reason (same workspace, flag toggled between calls).
  let diagnosisPersistenceEnabled = false;
  if (opts.effectiveConfig) {
    const featureFlags = computeFeatureFlagsFromConfig(opts.effectiveConfig);
    const splitPipeline = isFeatureEnabled(featureFlags, 'diagnostician_split_pipeline');
    const asyncCli = isFeatureEnabled(featureFlags, 'diagnostician_async_cli');
    diagnosisPersistenceEnabled = isFeatureEnabled(featureFlags, 'pain_diagnosis_persistence');

    if (splitPipeline && !asyncCli) {
      const isExplicitSplit = opts.effectiveConfig.featuresChangedFromDefault?.includes('diagnostician_split_pipeline') ?? false;
      const isExplicitAsync = opts.effectiveConfig.featuresChangedFromDefault?.includes('diagnostician_async_cli') ?? false;
      if (isExplicitSplit || isExplicitAsync) {
        throw new PDRuntimeError(
          'input_invalid',
          'diagnostician_split_pipeline requires diagnostician_async_cli=on (3 serial LLM calls would block the sync CLI 540s+)',
        );
      }
    }

    useSplitPipeline = splitPipeline;
  }

  const cacheKey = `${opts.workspaceDir}:${runtimeConfig.runtimeKind}:${runtimeConfig.openclawMode ?? ''}:${useSplitPipeline ? 'split' : 'disabled'}:${diagnosisPersistenceEnabled ? 'pdp' : 'nopdp'}`;
  const cached = bridgeCache.get(cacheKey);
  if (cached) return cached;

  const bridge = await constructBridge(opts, runtimeConfig, { useSplitPipeline, diagnosisPersistenceEnabled });
  // PRI-624: a concurrent constructor may have won the cache slot while we
  // were building — the loser self-disposes so its handles never leak.
  const winner = bridgeCache.get(cacheKey);
  if (winner !== undefined && winner !== bridge) {
    await bridge.dispose().catch(() => undefined);
    return winner;
  }
  bridgeCache.set(cacheKey, bridge);
  return bridge;
}

export function invalidatePainSignalBridge(workspaceDir: string, runtimeKind?: string): void {
  const effectiveKind = runtimeKind ?? 'pi-ai';
  for (const mode of ['local', 'gateway', '']) {
    for (const pipeline of ['split', 'disabled']) {
      for (const pdp of ['pdp', 'nopdp']) {
        bridgeCache.delete(`${workspaceDir}:${effectiveKind}:${mode}:${pipeline}:${pdp}`);
      }
    }
  }
}
