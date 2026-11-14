/**
 * OpenClaw internalization auto-consumer service.
 *
 * PRI-624 (Codex Closure Slice C): the downstream execution logic now lives in
 * the shared host-neutral `runInternalizationConsumerCycle`
 * (`@principles/host-runtime`), extracted verbatim from this service so the
 * OpenClaw scheduler and the Companion workspace worker execute ONE
 * implementation. This module keeps only what is genuinely OpenClaw-specific:
 * the service lifecycle (timer chain per workspace), the OpenClaw tool
 * catalog, the plugin logger, and SystemLogger event emission.
 */
import type { OpenClawPluginServiceContext, PluginLogger } from '../openclaw-sdk.js';
import { READ_ONLY_TOOL_NAMES, LOW_RISK_WRITE_TOOL_NAMES, HIGH_RISK_TOOL_NAMES, AGENT_TOOL_NAMES } from '../constants/tools.js';
import { OPENCLAW_TOOL_SEMANTICS, OPENCLAW_TOOL_SEMANTIC_MAPPINGS } from '../constants/tool-semantics.js';
import {
  runInternalizationConsumerCycle,
  runPendingDiagnosticianOnce,
  nextConsumerDelay,
  INTERNALIZATION_AUTO_CONSUMER_FLAG_ID,
  saveHostToolDeclaration,
  HOST_TOOL_DECLARATION_VERSION,
  type AdaptiveConsumerSignals,
  type AdaptiveConsumerScheduleDecision,
  type InternalizationConsumerCycleOutcome,
} from '@principles/host-runtime';
import { BehaviorExamplePackAssembler } from '../core/behavior-example-pack-assembler.js';
import path from 'node:path';
import { loadFeatureFlagFromConfig } from '../core/pd-config-loader.js';
import { SystemLogger } from '../core/system-logger.js';
import { describeExperimentWorkspaceViolation } from '../core/experiment-workspace-guard.js';

// SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §4: the interval is no longer
// a fixed constant. The FIRST cycle keeps its original delay; every later delay
// is decided by the pure `nextConsumerDelay` policy from the facts the previous
// cycle observed (empty queue → the baseline 120s sleep, backlog → shorter).
const INTERNALIZATION_AUTO_CONSUMER_INITIAL_DELAY_MS = 30_000;

export interface InternalizationAutoConsumerServiceShape {
  id: string;
  start: (ctx: OpenClawPluginServiceContext) => void;
  stop?: (ctx: OpenClawPluginServiceContext) => void;
}

interface WorkspaceConsumerState {
  stopped: boolean;
  timeoutId: ReturnType<typeof setTimeout> | null;
  /** Adaptive-scheduler inputs, owned by this workspace's timer chain only. */
  consecutiveEmptyCycles: number;
  consecutiveFailures: number;
  lastCycleDurationMs: number | null;
  lastDecision: AdaptiveConsumerScheduleDecision | null;
}

const workspaceStates = new Map<string, WorkspaceConsumerState>();

function getWorkspaceState(workspaceDir: string): WorkspaceConsumerState {
  let state = workspaceStates.get(workspaceDir);
  if (!state) {
    state = {
      stopped: false,
      timeoutId: null,
      consecutiveEmptyCycles: 0,
      consecutiveFailures: 0,
      lastCycleDurationMs: null,
      lastDecision: null,
    };
    workspaceStates.set(workspaceDir, state);
  }
  return state;
}

function formatRunOnceCommand(workspaceDir: string): string {
  return `pd runtime internalization run-once --workspace "${workspaceDir}" --runner dreamer --runtime config --json`;
}

/**
 * PRI-741 (review round): persist the OpenClaw tool declaration as workspace
 * provenance — host-neutral consumers (pd-cli activation / run-once) load it
 * to run reliability validation with the SAME registry instead of guessing
 * the host. The declaration derives from this package's constants (single
 * source) and is a FACT about the host: it is refreshed on EVERY gateway
 * start, independent of the internalization consumer flag, so a flag-off
 * workspace never keeps a stale declaration whose phantom names defeat the
 * activation gate's hasHostTool check.
 */
export function persistOpenClawToolDeclaration(
  workspaceDir: string,
  logger: { warn: (msg: string) => void },
): void {
  // Containment (PRI-595 pattern): declaration persistence is an optimization
  // on top of gateway startup — an fs-level throw here must never break
  // plugin registration itself.
  try {
    const declared = saveHostToolDeclaration(workspaceDir, {
      version: HOST_TOOL_DECLARATION_VERSION,
      hostKind: 'openclaw',
      mappings: OPENCLAW_TOOL_SEMANTIC_MAPPINGS,
      declaredAt: new Date().toISOString(),
    });
    if (!declared.ok) {
      logger.warn(`[PD:AutoConsumer] Failed to persist OpenClaw tool declaration: ${declared.reason} — pd-cli reliability validation will not find it (rc-9)`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[PD:AutoConsumer] Failed to persist OpenClaw tool declaration: ${message} — pd-cli reliability validation will not find it (rc-9)`);
  }
}

export async function runConsumerCycle(
  workspaceDir: string,
  logger: PluginLogger,
  onOutcome?: (outcome: InternalizationConsumerCycleOutcome) => void,
): Promise<void> {
  const outcome = await runInternalizationConsumerCycle(workspaceDir, {
    owner: 'auto-consumer',
    logLabel: 'AutoConsumer',
    logger,
    emitEvent: (event, payload) => SystemLogger.log(workspaceDir, event, payload),
    hostToolCatalog: {
      readOnlyTools: READ_ONLY_TOOL_NAMES,
      writeTools: [...LOW_RISK_WRITE_TOOL_NAMES, ...HIGH_RISK_TOOL_NAMES, ...AGENT_TOOL_NAMES],
    },
    // PRI-634-F: OpenClaw tool semantics (derived from constants/tools.ts) —
    // the activation gate replays with production-identical tool resolution.
    toolSemantics: OPENCLAW_TOOL_SEMANTICS,
    // PRI-741: artificer generation gets the same host projection.
    hostKinds: ['openclaw'],
    // PRI-982 (SPEC-PD-IAER-001 FR-02/FR-03): Owner evidence assembly for
    // code_tool_hook artificer tasks. Lazily wraps the production
    // BehaviorExamplePackAssembler so the TrajectoryDatabase (registry
    // singleton; dispose stays with the registry, as in run-rulehost) is only
    // opened when a task actually needs assembly. Construction parameters are
    // IDENTICAL to the run-rulehost CLI (stateDir under .state, projectDir =
    // workspaceDir) so consumer and CLI assemble one contract (FR-07).
    behaviorEvidence: {
      assemble: (selection) =>
        new BehaviorExamplePackAssembler({
          workspaceDir,
          stateDir: path.join(workspaceDir, '.state'),
        }).assemble({
          sourcePainId: selection.sourcePainId,
          ownerDesiredOutcome: selection.ownerDesiredOutcome,
          sourceNegativeToolCallId: selection.sourceNegativeToolCallId,
          positiveToolCallIds: selection.positiveToolCallIds,
          projectDir: workspaceDir,
        }),
    },
  });
  // SPEC §4: hand the cycle's own queue/recovery facts to the scheduler before
  // the (bounded, non-fatal) diagnostician step so a slow L3 pass cannot delay
  // the next scheduling decision.
  onOutcome?.(outcome);
  // L3 — one bounded automatic diagnosis per tick (SPEC-PD-AGENT-PAIN-INGRESS-001
  // §8.4). Reuses THIS timer: no new interval, no new background process, and
  // at most one task per tick. Every skip is observable; a skipped task keeps
  // its pending state for the Console request-driven path (L2).
  try {
    const diagnostician = await runPendingDiagnosticianOnce({ workspaceDir });
    if (diagnostician.served) {
      SystemLogger.log(workspaceDir, 'DIAGNOSTICIAN_AUTO_RUN', JSON.stringify({ served: true, taskId: diagnostician.taskId }));
    } else if (diagnostician.reason !== 'no_candidate') {
      SystemLogger.log(workspaceDir, 'DIAGNOSTICIAN_AUTO_RUN_SKIPPED', JSON.stringify({
        reason: diagnostician.reason,
        ...(diagnostician.taskId !== undefined ? { taskId: diagnostician.taskId } : {}),
        ...(diagnostician.message !== undefined ? { message: diagnostician.message } : {}),
        ...(diagnostician.nextAction !== undefined ? { nextAction: diagnostician.nextAction } : {}),
      }));
    }
  } catch (error) {
    // L3 must never break the internalization tick that hosts it.
    SystemLogger.log(workspaceDir, 'DIAGNOSTICIAN_AUTO_RUN_FAILED', JSON.stringify({
      message: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    }));
  }
}

export const InternalizationAutoConsumerService: InternalizationAutoConsumerServiceShape = {
  id: 'principles-internalization-auto-consumer',

  start(ctx: OpenClawPluginServiceContext): void {
    const maybeWorkspaceDir = ctx?.workspaceDir;
    const logger = ctx?.logger || console;

    if (!maybeWorkspaceDir) {
      logger.warn('[PD:AutoConsumer] No workspace directory, not starting.');
      return;
    }

    const workspaceDir: string = maybeWorkspaceDir;

    // P0-1 second line of defence: never start the consumer (which writes the
    // state DB, the host-tool declaration and diagnostician tasks) for a
    // workspace outside the experiment root. Production mode is unaffected.
    const isolationViolation = describeExperimentWorkspaceViolation(workspaceDir);
    if (isolationViolation) {
      logger.error?.(
        `[PD:AutoConsumer] Experiment isolation refused workspace ${workspaceDir}: ${isolationViolation.message} ${isolationViolation.nextAction}`,
      );
      return;
    }

    const state = getWorkspaceState(workspaceDir);

    // PRI-741 (review round): the tool declaration is a FACT about the host
    // (derived from code constants), NOT consumer behavior — it must persist
    // even when the auto-consumer flag is off, otherwise flag-off workspaces
    // keep a stale `.pd/host-tool-semantics/openclaw.json` whose phantom names
    // keep the activation gate's hasHostTool check defeated. Idempotent:
    // a full rewrite of the same content on every gateway start.
    persistOpenClawToolDeclaration(workspaceDir, logger);

    if (!state.stopped && state.timeoutId !== null) {
      logger.info(`[PD:AutoConsumer] Already started for workspace: ${workspaceDir}`);
      return;
    }

    const flag = loadFeatureFlagFromConfig(workspaceDir, INTERNALIZATION_AUTO_CONSUMER_FLAG_ID, {
      info: (msg: string) => logger.info(msg),
      warn: (msg: string) => logger.warn(msg),
    });

    if (!flag.enabled) {
      const disabledInfo = JSON.stringify({
        reason: 'internalization_auto_consumer_disabled',
        nextAction: formatRunOnceCommand(workspaceDir),
        flagSource: flag.source,
      });
      SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_DISABLED', disabledInfo);
      logger.info(
        `[PD:AutoConsumer] NOT started for workspace: ${workspaceDir}. Disabled (source: ${flag.source}).`,
      );
      return;
    }

    state.stopped = false;
    state.consecutiveEmptyCycles = 0;
    state.consecutiveFailures = 0;
    state.lastCycleDurationMs = null;

    function scheduleNext(decision: AdaptiveConsumerScheduleDecision): void {
      if (state.stopped) return;
      state.lastDecision = decision;
      state.timeoutId = setTimeout(runCycle, decision.delayMs);
      state.timeoutId?.unref();
    }

    /**
     * Turn the finished cycle into scheduling signals. Only facts the cycle
     * actually observed are used; a cycle that never reached the queue reports
     * depth 0 and contributes to the empty-cycle counter (which is what makes
     * the idle branch stable instead of oscillating).
     */
    function buildSignals(outcome: InternalizationConsumerCycleOutcome | undefined, durationMs: number): AdaptiveConsumerSignals {
      const signals = outcome?.signals;
      return {
        readyQueueDepth: signals?.readyQueueDepth ?? 0,
        retryQueueDepth: signals?.retryQueueDepth ?? 0,
        oldestReadyAgeMs: signals?.oldestReadyAgeMs ?? null,
        lastCycleWorked: outcome?.ran === true,
        lastCycleDurationMs: durationMs,
        consecutiveEmptyCycles: state.consecutiveEmptyCycles,
        consecutiveFailures: state.consecutiveFailures,
        providerLimited: outcome?.errorCategory === 'rate_limit',
        recoveredLastCycle: signals?.recovered ?? 0,
      };
    }

    // PRI-655: the chain dies silently if a single cycle rejects — scheduleNext
    // would never run again (the startup .catch below only guards round one).
    // Mirror correction-observer: catch inside the cycle, log
    // on both channels (rc-9), and let reschedule run on BOTH paths.
    async function runCycle(): Promise<void> {
      if (state.stopped) return;
      const startedAtMs = Date.now();
      const outcomeHolder: { current: InternalizationConsumerCycleOutcome | undefined } = { current: undefined };
      try {
        await runConsumerCycle(workspaceDir, logger, (cycleOutcome) => {
          outcomeHolder.current = cycleOutcome;
        });
        const outcome = outcomeHolder.current;
        if (outcome?.ran === true && outcome.runStatus === 'succeeded') {
          state.consecutiveFailures = 0;
        } else if (outcome?.runStatus === 'failed') {
          state.consecutiveFailures += 1;
        } else if (outcome?.runStatus === 'retried') {
          // A retried task is a failure of this attempt but not a provider
          // cooldown signal — keep the counter convergent instead of clearing it.
          state.consecutiveFailures = Math.max(1, state.consecutiveFailures);
        }
        if (outcome?.ran === true) {
          state.consecutiveEmptyCycles = 0;
        } else {
          state.consecutiveEmptyCycles += 1;
        }
      } catch (err) {
        state.consecutiveFailures += 1;
        state.consecutiveEmptyCycles = 0;
        const message = `Internalization consumer cycle failed: ${err instanceof Error ? err.message : String(err)}`;
        logger.error(`[PD:AutoConsumer] ${message}`);
        SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_CYCLE_FAILED', message);
      }
      const durationMs = Math.max(0, Date.now() - startedAtMs);
      state.lastCycleDurationMs = durationMs;
      const signals = buildSignals(outcomeHolder.current, durationMs);
      const decision = nextConsumerDelay(signals);
      // Structured, greppable evidence for "why is the next cycle in N ms".
      SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_SCHEDULE', JSON.stringify({
        state: decision.state,
        delayMs: decision.delayMs,
        reason: decision.reason,
        cycleDurationMs: durationMs,
        readyQueueDepth: signals.readyQueueDepth,
        retryQueueDepth: signals.retryQueueDepth,
        oldestReadyAgeMs: signals.oldestReadyAgeMs,
        consecutiveEmptyCycles: signals.consecutiveEmptyCycles,
        consecutiveFailures: signals.consecutiveFailures,
        providerLimited: signals.providerLimited,
        recovered: signals.recoveredLastCycle,
        ...(outcomeHolder.current?.taskId !== undefined ? { taskId: outcomeHolder.current.taskId } : {}),
        ...(outcomeHolder.current?.taskKind !== undefined ? { taskKind: outcomeHolder.current.taskKind } : {}),
        ...(outcomeHolder.current?.errorCategory !== undefined ? { errorCategory: outcomeHolder.current.errorCategory } : {}),
      }));
      scheduleNext(decision);
    }

    const initialDecision = nextConsumerDelay({
      readyQueueDepth: 0,
      retryQueueDepth: 0,
      oldestReadyAgeMs: null,
      lastCycleWorked: false,
      lastCycleDurationMs: null,
      consecutiveEmptyCycles: 0,
      consecutiveFailures: 0,
      providerLimited: false,
      recoveredLastCycle: 0,
    });
    state.lastDecision = initialDecision;

    state.timeoutId = setTimeout(() => {
      void runCycle().catch((err: unknown) => {
        logger.error(`[PD:AutoConsumer] Startup cycle failed: ${String(err)}`);
        if (state.stopped) return;
        state.timeoutId = setTimeout(runCycle, initialDecision.delayMs);
        state.timeoutId?.unref();
      });
    }, INTERNALIZATION_AUTO_CONSUMER_INITIAL_DELAY_MS);
    state.timeoutId?.unref();

    SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_STARTED', JSON.stringify({
      schedule: 'adaptive',
      idleDelayMs: initialDecision.delayMs,
      initialDelayMs: INTERNALIZATION_AUTO_CONSUMER_INITIAL_DELAY_MS,
    }));
    logger.info(
      `[PD:AutoConsumer] Started for workspace: ${workspaceDir} (adaptive schedule, idle delay: ${initialDecision.delayMs}ms, initial delay: ${INTERNALIZATION_AUTO_CONSUMER_INITIAL_DELAY_MS}ms)`,
    );
  },

  stop(ctx: OpenClawPluginServiceContext): void {
    const workspaceDir = ctx?.workspaceDir;
    if (workspaceDir) {
      const state = workspaceStates.get(workspaceDir);
      if (state) {
        state.stopped = true;
        if (state.timeoutId) clearTimeout(state.timeoutId);
        state.timeoutId = null;
      }
      workspaceStates.delete(workspaceDir);
    } else {
      for (const [, state] of workspaceStates) {
        state.stopped = true;
        if (state.timeoutId) clearTimeout(state.timeoutId);
        state.timeoutId = null;
      }
      workspaceStates.clear();
    }
  },
};
