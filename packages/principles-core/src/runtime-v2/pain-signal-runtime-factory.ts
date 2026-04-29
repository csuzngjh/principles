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

import { PainSignalBridge } from './pain-signal-bridge.js';
import { RuntimeStateManager } from './store/runtime-state-manager.js';
import { DiagnosticianRunner } from './runner/diagnostician-runner.js';
import { CandidateIntakeService } from './candidate-intake-service.js';
import { SqliteDiagnosticianCommitter } from './store/diagnostician-committer.js';
import { SqliteContextAssembler } from './store/sqlite-context-assembler.js';
import { SqliteHistoryQuery } from './store/sqlite-history-query.js';
import { SqliteConnection } from './store/sqlite-connection.js';
import { OpenClawCliRuntimeAdapter } from './adapter/openclaw-cli-runtime-adapter.js';
import { PiAiRuntimeAdapter } from './adapter/pi-ai-runtime-adapter.js';
import { getProviders } from '@mariozechner/pi-ai';
import type { KnownProvider } from '@mariozechner/pi-ai';
import { DefaultDiagnosticianValidator } from './runner/default-validator.js';
import { storeEmitter } from './store/event-emitter.js';
import { WorkflowFunnelLoader } from '../workflow-funnel-loader.js';
import type { RuntimeKind, PDRuntimeAdapter } from './runtime-protocol.js';
import type { LedgerAdapter } from './candidate-intake.js';

export interface PainSignalRuntimeFactoryOptions {
  workspaceDir: string;
  stateDir: string;
  ledgerAdapter: LedgerAdapter;
  owner?: string;
  autoIntakeEnabled?: boolean;
}

/** Funnel name for the Runtime v2 diagnosis path. */
const DIAGNOSTIC_FUNNEL_ID = 'pd-runtime-v2-diagnosis';

/** Defaults when no funnel policy is defined. */
const DEFAULT_TIMEOUT_MS = 300_000;

/** Resolved runtime configuration from funnel policy. */
export interface RuntimeConfig {
  runtimeKind: RuntimeKind;
  timeoutMs: number;
  agentId: string;
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  maxRetries?: number;
  /** Custom base URL for OpenAI-compatible providers not in pi-ai's built-in registry. */
  baseUrl?: string;
}

/**
 * Resolve runtime configuration from the pd-runtime-v2-diagnosis funnel policy.
 * Falls back to defaults if no funnel is found.
 * Silently ignores missing files and schema errors (factory should not crash
 * if workflows.yaml is absent or malformed).
 */
export function resolveRuntimeConfig(stateDir: string): RuntimeConfig {
  try {
    const loader = new WorkflowFunnelLoader(stateDir);
    const funnel = loader.getFunnel(DIAGNOSTIC_FUNNEL_ID);
    if (!funnel || !funnel.policy) {
      return {
        runtimeKind: 'pi-ai',
        timeoutMs: DEFAULT_TIMEOUT_MS,
        agentId: 'main',
      };
    }
    const {policy} = funnel;
    return {
      runtimeKind: policy.runtimeKind ?? 'pi-ai',
      timeoutMs: policy.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      agentId: 'main',
      provider: policy.provider,
      model: policy.model,
      apiKeyEnv: policy.apiKeyEnv,
      maxRetries: policy.maxRetries,
      baseUrl: policy.baseUrl,
    };
  } catch (err) {
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
  if (config.runtimeKind === 'pi-ai') {
    const missing: string[] = [];
    if (!config.provider) missing.push('provider');
    if (!config.model) missing.push('model');
    if (!config.apiKeyEnv) missing.push('apiKeyEnv');

    // Non-built-in providers require baseUrl
    if (config.provider) {
      const knownProviders = getProviders();
      if (!knownProviders.includes(config.provider as KnownProvider) && !config.baseUrl) {
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

// Per-workspace+runtime bridge cache — same lifetime as process
// Key format: `${workspaceDir}:${runtimeKind}` (D-03)
const bridgeCache = new Map<string, PainSignalBridge>();

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
  const runtimeConfig = resolveRuntimeConfig(opts.stateDir);
  validateRuntimeConfig(runtimeConfig);
  const cacheKey = `${opts.workspaceDir}:${runtimeConfig.runtimeKind}`;
  const cached = bridgeCache.get(cacheKey);
  if (cached) return cached;

  const stateManager = new RuntimeStateManager({ workspaceDir: opts.workspaceDir });
  await stateManager.initialize();

  const connection = new SqliteConnection(opts.workspaceDir);
  const historyQuery = new SqliteHistoryQuery(connection);
  const committer = new SqliteDiagnosticianCommitter(connection);
  const validator = new DefaultDiagnosticianValidator();

  const contextAssembler = new SqliteContextAssembler(
    stateManager.taskStore,
    historyQuery,
    stateManager.runStore,
  );

  const runtimeAdapter: PDRuntimeAdapter = runtimeConfig.runtimeKind === 'pi-ai'
    ? new PiAiRuntimeAdapter({
        provider: String(runtimeConfig.provider),
        model: String(runtimeConfig.model),
        apiKeyEnv: String(runtimeConfig.apiKeyEnv),
        maxRetries: runtimeConfig.maxRetries,
        timeoutMs: runtimeConfig.timeoutMs,
        baseUrl: runtimeConfig.baseUrl,
        workspace: opts.workspaceDir,
      })
    : new OpenClawCliRuntimeAdapter({
        runtimeMode: 'local',
        workspaceDir: opts.workspaceDir,
      });

  const runner = new DiagnosticianRunner(
    {
      stateManager,
      contextAssembler,
      runtimeAdapter,
      eventEmitter: storeEmitter,
      validator,
      committer,
    },
    {
      owner: opts.owner ?? 'pain-signal-bridge',
      runtimeKind: runtimeConfig.runtimeKind,
      pollIntervalMs: 5000,
      timeoutMs: runtimeConfig.timeoutMs,
      agentId: runtimeConfig.agentId,
    },
  );

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
  });

  bridgeCache.set(cacheKey, bridge);
  return bridge;
}

/**
 * Invalidate the cached bridge for a workspace (for testing).
 */
export function invalidatePainSignalBridge(workspaceDir: string, runtimeKind?: string): void {
  const effectiveKind = runtimeKind ?? 'pi-ai';
  bridgeCache.delete(`${workspaceDir}:${effectiveKind}`);
}
