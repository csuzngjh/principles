/**
 * L3 — one bounded automatic-diagnosis round (SPEC-PD-AGENT-PAIN-INGRESS-001
 * §8.4 / TECHNICAL-DESIGN §8.4).
 *
 * The degradation ladder is: L2 Console request-driven, L3 OpenClaw automatic,
 * L4 offline/manual. This module is ONLY the L3 body: it is called from the
 * existing `internalization_auto_consumer` timer (no new timer, no new
 * background process) and serves at most one diagnostician task per call.
 *
 * Three preconditions, each with its own reason so the Owner can tell WHY
 * nothing happened:
 *   1. `serviceStarted` — the tick that calls us is by definition the service;
 *      the flag exists so a non-service caller can state it is not running.
 *   2. `openclaw_diagnostician_consumer` flag (quiet, default on).
 *   3. Diagnostician capability (`internalAgents.agents.diagnostician.enabled`).
 *
 * A skip is never a failure: the task keeps its pending state and L2 can still
 * serve it. Nothing is marked, mutated or deleted on any skip path.
 */
import * as path from 'node:path';
import {
  PrincipleTreeLedgerAdapter,
  createPainSignalBridge,
  createRuntimeStateHandle,
  pickDiagnosticianCandidate,
  resolveDiagnosticianCapability,
} from '@principles/core/runtime';
import { loadFeatureFlagFromConfig, loadPdConfigForPlugin } from './pd-config.js';

/** Quiet flag that owns the L3 half of the ladder. */
export const DIAGNOSTICIAN_AUTO_RUN_FLAG = 'openclaw_diagnostician_consumer';

/** Owner string used for the diagnostics this module starts. */
export const DIAGNOSTICIAN_AUTO_RUN_OWNER = 'pd-auto-diagnostician';

export type PendingDiagnosticianSkipReason =
  | 'flag_off'
  | 'capability_disabled'
  | 'service_not_running'
  | 'no_candidate';

export interface PendingDiagnosticianRunResult {
  readonly served: boolean;
  readonly taskId?: string;
  /** Present when nothing was served. */
  readonly reason?: PendingDiagnosticianSkipReason | 'execution_failed';
  readonly message?: string;
  readonly nextAction?: string;
}

export interface RunPendingDiagnosticianOptions {
  readonly workspaceDir: string;
  readonly owner?: string;
  readonly limit?: number;
  readonly now?: string;
  /**
   * Precondition 1. Defaults to `true`: the only production caller IS the
   * consumer timer. A non-service caller must pass `false` to get the
   * `service_not_running` skip instead of silently starting work it has no
   * timer to continue.
   */
  readonly serviceStarted?: boolean;
  readonly getEnvVar?: (name: string) => string | undefined;
}

const DEFAULT_CANDIDATE_LIMIT = 1;

export async function runPendingDiagnosticianOnce(
  options: RunPendingDiagnosticianOptions,
): Promise<PendingDiagnosticianRunResult> {
  if (options.serviceStarted === false) {
    return {
      served: false,
      reason: 'service_not_running',
      message: 'the internalization_auto_consumer service is not running',
      nextAction: 'Start the OpenClaw service, or diagnose from Console (L2) which does not need a timer.',
    };
  }

  const config = loadPdConfigForPlugin(options.workspaceDir);
  const flag = loadFeatureFlagFromConfig(options.workspaceDir, DIAGNOSTICIAN_AUTO_RUN_FLAG);
  if (!flag.enabled) {
    return {
      served: false,
      reason: 'flag_off',
      message: `features.${DIAGNOSTICIAN_AUTO_RUN_FLAG} is off`,
      nextAction: 'Tasks stay pending for the Console request-driven path (L2); set the flag to true to re-enable automatic diagnosis.',
    };
  }

  const capability = resolveDiagnosticianCapability(config.effective);
  if (!capability.available) {
    return {
      served: false,
      reason: 'capability_disabled',
      message: capability.message,
      nextAction: capability.nextAction,
    };
  }

  const handle = await createRuntimeStateHandle({ workspaceDir: options.workspaceDir, readonly: false });
  try {
    const now = options.now ?? new Date().toISOString();
    const candidate = await pickDiagnosticianCandidate(
      handle.stateManager,
      options.limit ?? DEFAULT_CANDIDATE_LIMIT,
      now,
    );
    if (candidate === null) {
      return { served: false, reason: 'no_candidate' };
    }

    const stateDir = path.join(options.workspaceDir, '.state');
    try {
      const bridge = await createPainSignalBridge({
        workspaceDir: options.workspaceDir,
        stateDir,
        ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir }),
        owner: options.owner ?? DIAGNOSTICIAN_AUTO_RUN_OWNER,
        effectiveConfig: config.effective,
        getEnvVar: options.getEnvVar ?? ((name: string) => process.env[name]),
      });
      const executed = await bridge.executePendingDiagnosis({ taskId: candidate.taskId });
      if (executed.status === 'failed') {
        return {
          served: false,
          taskId: candidate.taskId,
          reason: 'execution_failed',
          ...(executed.message !== undefined ? { message: executed.message.slice(0, 200) } : {}),
          nextAction: 'Inspect the workspace runtime profile; the task keeps its pending/retry state for the next tick or Console (L2).',
        };
      }
      return { served: true, taskId: candidate.taskId };
    } catch (error) {
      // A missing/!invalid runtime profile must not throw out of the timer that
      // hosts us, and must not silently look like "no work" (rc-9).
      return {
        served: false,
        taskId: candidate.taskId,
        reason: 'execution_failed',
        message: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
        nextAction: 'Configure the workspace runtime profile; the task keeps its pending state for the next tick or Console (L2).',
      };
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}
