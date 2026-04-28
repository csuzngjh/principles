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
import { DefaultDiagnosticianValidator } from './runner/default-validator.js';
import { storeEmitter } from './store/event-emitter.js';
import { WorkflowFunnelLoader } from '../workflow-funnel-loader.js';
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

/**
 * Resolve runner options from the pd-runtime-v2-diagnosis funnel policy.
 * Falls back to DEFAULT_TIMEOUT_MS if no funnel is found.
 * Silently ignores missing files and schema errors (factory should not crash
 * if workflows.yaml is absent or malformed).
 */
function resolveRunnerOptions(stateDir: string): { timeoutMs: number; agentId: string } {
  try {
    const loader = new WorkflowFunnelLoader(stateDir);
    const funnel = loader.getFunnel(DIAGNOSTIC_FUNNEL_ID);
    if (!funnel || !funnel.policy) {
      return { timeoutMs: DEFAULT_TIMEOUT_MS, agentId: 'main' };
    }
    return {
      timeoutMs: funnel.policy.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      agentId: 'main', // agentId resolution reserved for future stage-level policy
    };
  } catch (err) {
    // Best-effort: do not crash factory on funnel loading errors
    console.warn(`[PainSignalRuntimeFactory] Funnel loading failed for ${DIAGNOSTIC_FUNNEL_ID}, using defaults: ${String(err)}`);
    return { timeoutMs: DEFAULT_TIMEOUT_MS, agentId: 'main' };
  }
}

// Per-workspace bridge cache — same lifetime as process
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
  const cached = bridgeCache.get(opts.workspaceDir);
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

  const runtimeAdapter = new OpenClawCliRuntimeAdapter({
    runtimeMode: 'local',
    workspaceDir: opts.workspaceDir,
  });

  const { timeoutMs, agentId } = resolveRunnerOptions(opts.stateDir);

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
      runtimeKind: 'openclaw-cli',
      pollIntervalMs: 5000,
      timeoutMs,
      agentId,
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

  bridgeCache.set(opts.workspaceDir, bridge);
  return bridge;
}

/**
 * Invalidate the cached bridge for a workspace (for testing).
 */
export function invalidatePainSignalBridge(workspaceDir: string): void {
  bridgeCache.delete(workspaceDir);
}
