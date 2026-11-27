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
import { isAutomaticPainSubmissionAuthorized } from './auto-pain-authorization.js';
import { resolveWorkspacePipelineHostDeps } from './workspace-pipeline-host-deps.js';

/** Quiet flag that owns the L3 half of the ladder. */
export const DIAGNOSTICIAN_AUTO_RUN_FLAG = 'openclaw_diagnostician_consumer';

/** Owner string used for the diagnostics this module starts. */
export const DIAGNOSTICIAN_AUTO_RUN_OWNER = 'pd-auto-diagnostician';

export type PendingDiagnosticianSkipReason =
  | 'flag_off'
  | 'capability_disabled'
  | 'service_not_running'
  | 'no_candidate'
  | 'auto_pain_unauthorized';

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

/**
 * The persisted top-level provenance is the admission authority for both
 * legacy and v1 payloads (pain-signal-bridge's persisted-facts validator
 * requires the two namespaces to agree). A malformed/missing payload is not
 * an automatic submission — it is left for the normal execution path, which
 * owns its own payload validation.
 */
function persistedCandidateProvenance(diagnosticJson: string | undefined): string | null {
  if (typeof diagnosticJson !== 'string' || diagnosticJson.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(diagnosticJson);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const provenance = Reflect.get(parsed, 'provenance');
    return typeof provenance === 'string' ? provenance : null;
  } catch {
    return null;
  }
}

export async function runPendingDiagnosticianOnce(
  options: RunPendingDiagnosticianOptions,
): Promise<PendingDiagnosticianRunResult> {
  if (options.serviceStarted === false) {
    return {
      served: false,
      reason: 'service_not_running',
      message: 'the internalization consumer cycle is not running in this workspace',
      nextAction: 'Verify the PD Service Host is enabled (pd service status), or diagnose from Console (L2) which does not need a worker cycle.',
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

    // B-class authorization (Pain Ingress SPEC §9.6): a persisted automatic
    // submission may not execute after the Owner revoked (or never granted)
    // the Workspace flag — background recovery cannot bypass the gate. The
    // task stays pending, retryable once the flag is enabled. owner_manual /
    // host_context_bound / agent_reported_owner_approved tasks are exempt:
    // their Owner authorization is intrinsic.
    if (persistedCandidateProvenance(candidate.diagnosticJson) === 'automatic_hook'
      && !isAutomaticPainSubmissionAuthorized(options.workspaceDir)) {
      return {
        served: false,
        reason: 'auto_pain_unauthorized',
        taskId: candidate.taskId,
        message: 'candidate is an automatic_hook submission and features.automatic_pain_submission is off',
        nextAction: 'The task stays pending; enable features.automatic_pain_submission in .pd/config.yaml to allow automatic-Pain diagnosis.',
      };
    }

    const stateDir = path.join(options.workspaceDir, '.state');
    try {
      let releaseBridge: (() => Promise<void>) | undefined;
      try {
        // SPEC-PD-PIPELINE-SPINE-001 §4.2 (PRI-1292 Phase 2A): ONE assembly
        // point for the five host collaborators. The trajectory reader and the
        // source-material gate now share the SAME consent-ledger authorization
        // instance (previously two separate instances were created per call).
        // PRI-1233 / SPEC §9.2: this path executes Stage A for
        // governance-admitted pains, so the neutral host reader must ride
        // along (flag-off keeps zero filesystem access); PRI-1265: the
        // auto-run path sees the bound session's ORIGINAL turns.
        const hostDeps = resolveWorkspacePipelineHostDeps({
          workspaceDir: options.workspaceDir,
          effectiveConfig: config.effective,
        });
        const bridge = await createPainSignalBridge({
          workspaceDir: options.workspaceDir,
          stateDir,
          ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir }),
          owner: options.owner ?? DIAGNOSTICIAN_AUTO_RUN_OWNER,
          effectiveConfig: config.effective,
          getEnvVar: options.getEnvVar ?? ((name: string) => process.env[name]),
          intentDocReader: hostDeps.intentDocReader,
          trajectoryTurnReader: hostDeps.trajectoryTurnReader,
          sourceMaterialAuthorization: hostDeps.sourceMaterialAuthorization,
          // PRI-939 Option A: allowlisted runner/bridge events persist to the
          // workspace sink instead of vanishing in the unsubscribed singleton.
          telemetrySink: hostDeps.telemetrySink,
          // SPEC §9.6: lazy probe — a flag revoked between candidate pick and
          // execution still stops the run at the bridge boundary.
          isAutoPainSubmissionAuthorized: hostDeps.isAutoPainSubmissionAuthorized,
        }, (release) => { releaseBridge = release; });
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
      } finally {
        await releaseBridge?.();
      }

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
