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
 *
 * PRI-1282 (Phase 4) — §8.4 ownership gate: the install manifest's
 * `backgroundExecutions` record is the ONLY consumption authority for this
 * service. The marker is read (a) before the service arms a workspace's
 * timer chain, and (b) before EVERY tick; any state other than
 * `legacy_owned` — including an UNREADABLE manifest — fails closed: no new
 * consumption cycle starts. When a blocking state is observed the workspace
 * quiesces: in-flight cycles are awaited (bounded), a persisted
 * `pd.gateway-quiesce.v1` acknowledgment is written (the auditable "the old
 * consumer stopped" evidence the handover command waits for), and the timer
 * slot degrades into a slow ownership watch that re-arms normal consumption
 * only when the marker returns to `legacy_owned` (rollback) — one timer
 * chain per workspace at all times, never a second resident loop.
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
import { readOpenClawWorkspaceOwnership } from '../openclaw-worker.js';
import { writeGatewayQuiesceAck, type GatewayQuiesceAck } from './gateway-quiesce-ack.js';
import {
  gatewayConsumerLeaseToken,
  gatewayConsumerInstanceId,
  readGatewayConsumerLease,
  writeGatewayConsumerLease,
  clearGatewayConsumerLease,
  foreignConsumerLeaseStatus,
} from './gateway-consumer-lease.js';

/**
 * PRI-1282 P1-3 + r4: identity of ONE consumer INSTANCE — minted fresh on
 * every start(), not per process. The lease
 * (<workspace>/.pd/gateway-consumer-lease.json) is the workspace-scoped
 * liveness record that makes "a foreign Gateway consumer is alive"
 * decidable across a Gateway restart: PID liveness alone cannot distinguish
 * two lifecycles of the same process, so process liveness and instance
 * identity are judged separately and a new instance never clears or claims
 * the old instance's lease. Anything unverifiable fails closed.
 */
interface ConsumerIdentity {
  readonly token: string;
  readonly instanceId: string;
}

function freshConsumerIdentity(): ConsumerIdentity {
  return { token: gatewayConsumerLeaseToken(), instanceId: gatewayConsumerInstanceId() };
}

let consumerIdentity = freshConsumerIdentity();

// SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §4: the interval is no longer
// a fixed constant. The FIRST cycle keeps its original delay; every later delay
// is decided by the pure `nextConsumerDelay` policy from the facts the previous
// cycle observed (empty queue → the baseline 120s sleep, backlog → shorter).
const INTERNALIZATION_AUTO_CONSUMER_INITIAL_DELAY_MS = 30_000;

/**
 * PRI-1282: bounded wait for an in-flight cycle to end before the quiesce
 * acknowledgment is written. Covers the longest expected cycle (diagnostician
 * execution) with margin; exceeding it is recorded honestly as
 * `in_flight_timeout` — the handover then fails closed instead of assuming
 * cancellation. The eventual natural completion still lands (cycles are
 * bounded by design) and the ownership watch keeps the chain parked.
 */
const GATEWAY_QUIESCE_WAIT_MS = 10 * 60_000;
/**
 * While a workspace is blocked, its ONE timer slot ticks this slowly,
 * re-reading the marker: rollback (legacy_owned) re-arms consumption; a new
 * operation identity gets a fresh ack. Not a second loop — the consumer
 * chain itself is parked.
 */
const OWNERSHIP_WATCH_INTERVAL_MS = 30_000;

/**
 * PRI-1282 r4 §3.1: stop() drains the in-flight cycle before releasing the
 * lease. The wait is bounded; on timeout the PROTECTIVE lease stays (the
 * observable INTERNALIZATION_CONSUMER_STOP_DRAIN_TIMEOUT event records why)
 * and the workspace's next consumer keeps being gated by it — stop()
 * returning is never, by itself, proof the old consumer exited.
 */
const STOP_DRAIN_WAIT_MS = 30_000;
/** Effective drain bound — the test seam may shorten it; production never does. */
let stopDrainWaitMs = STOP_DRAIN_WAIT_MS;

/** Whether the on-disk lease is ours or provably dead (safe to overwrite). */
function leaseOursOrDead(workspaceDir: string): boolean {
  const lease = readGatewayConsumerLease(workspaceDir);
  if (lease === null) return false; // unreadable/malformed → unverifiable → not safe
  if (lease.token === consumerIdentity.token || lease.instanceId === consumerIdentity.instanceId) return true;
  return foreignConsumerLeaseStatus(workspaceDir, {
    selfToken: consumerIdentity.token,
    selfInstanceId: consumerIdentity.instanceId,
  }) === 'none';
}

export interface InternalizationAutoConsumerServiceShape {
  id: string;
  start: (ctx: OpenClawPluginServiceContext) => void;
  stop?: (ctx: OpenClawPluginServiceContext) => void;
}

interface WorkspaceConsumerState {
  stopped: boolean;
  quiescing: boolean;
  timeoutId: ReturnType<typeof setTimeout> | null;
  /** The in-flight runCycle promise — quiesce waits for this (bounded). */
  inFlight: Promise<void> | null;
  /** Identity of the operation last acked (avoids duplicate acks while watching). */
  ackedOperation: { state: string; operationId: string | null; generation: number } | null;
  /** Adaptive-scheduler inputs, owned by this workspace's timer chain only. */
  consecutiveEmptyCycles: number;
  consecutiveFailures: number;
  lastCycleDurationMs: number | null;
  lastDecision: AdaptiveConsumerScheduleDecision | null;
}

const workspaceStates = new Map<string, WorkspaceConsumerState>();

/**
 * Deterministic test seams (PRI-1282 r4 §3.4): let lifecycle tests inject an
 * in-flight cycle, shorten the drain bound, and read the live identity
 * without monkey-patching node modules. Production never touches them.
 */
export const __autoConsumerTestSeams = {
  workspaceStates,
  identity: (): ConsumerIdentity => consumerIdentity,
  getWorkspaceState,
  injectInFlight(workspaceDir: string, inFlight: Promise<void> | null): void {
    getWorkspaceState(workspaceDir).inFlight = inFlight;
  },
  setStopDrainWaitMs(ms: number): void {
    stopDrainWaitMs = ms;
  },
};

function getWorkspaceState(workspaceDir: string): WorkspaceConsumerState {
  let state = workspaceStates.get(workspaceDir);
  if (!state) {
    state = {
      stopped: false,
      quiescing: false,
      timeoutId: null,
      inFlight: null,
      ackedOperation: null,
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

/** Marker states that forbid new consumption cycles (§8.4). */
type BlockingOwnership =
  | { blocked: true; state: 'handover_preparing' | 'service_host_owned' | 'rollback_pending'; operationId: string | null; generation: number }
  | { blocked: true; state: 'manifest_unreadable'; operationId: null; generation: -1 };

function evaluateOwnershipForConsumption(workspaceDir: string): BlockingOwnership | { blocked: false } {
  const ownership = readOpenClawWorkspaceOwnership(workspaceDir);
  if (ownership.status === 'legacy_owned') return { blocked: false };
  if (ownership.status === 'manifest_unreadable') {
    return { blocked: true, state: 'manifest_unreadable', operationId: null, generation: -1 };
  }
  return { blocked: true, state: ownership.status, operationId: ownership.record.operationId, generation: ownership.generation };
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
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

    // ── PRI-1282 §8.4 marker gate (service-start read point). ──
    const startOwnership = evaluateOwnershipForConsumption(workspaceDir);
    if (startOwnership.blocked) {
      state.stopped = false;
      state.quiescing = true;
      logOwnershipBlocked(workspaceDir, startOwnership, logger, 'service_start');
      // A fresh Gateway process that refuses to consume is itself quiesce
      // evidence for the in-flight operation (no cycles can exist from THIS
      // process; the ack still binds operationId + generation).
      void quiesceAndWatch(workspaceDir, state, startOwnership, logger, 'service_start');
      return;
    }

    // Claim the workspace consumer lease — the liveness record that lets a
    // blocked sibling process and the resume path arbitrate "is a foreign
    // consumer alive" by PID AND instance identity (PRI-1282 P1-3 + r4).
    //
    // A live foreign instance's lease must not be overwritten: refuse to
    // consume and park on the ownership watch instead (an old instance may
    // still have in-flight work). A lease that cannot be written means the
    // liveness record cannot be published — never degrade into unprotected
    // consumption (fail-closed).
    consumerIdentity = freshConsumerIdentity(); // every start() mints a NEW instanceId
    const foreignAtStart = foreignConsumerLeaseStatus(workspaceDir, {
      selfToken: consumerIdentity.token,
      selfInstanceId: consumerIdentity.instanceId,
    });
    if (foreignAtStart !== 'none') {
      state.stopped = false;
      state.quiescing = true;
      SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_START_REFUSED', JSON.stringify({
        reason: `foreign_consumer_lease_${foreignAtStart}`,
        nextAction: 'An older consumer instance may still have in-flight work; this instance stays parked on the ownership watch until the foreign lease is provably dead.',
      }));
      logger.warn(`[PD:AutoConsumer] Start refused for ${workspaceDir}: foreign consumer lease status=${foreignAtStart} (fail-closed against double consumption).`);
      armOwnershipWatch(workspaceDir, state, logger);
      return;
    }
    const leaseWrite = writeGatewayConsumerLease({
      workspaceDir,
      token: consumerIdentity.token,
      instanceId: consumerIdentity.instanceId,
      state: 'consuming',
    });
    if (!leaseWrite.ok) {
      state.stopped = false;
      state.quiescing = true;
      SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_START_REFUSED', JSON.stringify({
        reason: 'consumer_lease_write_failed',
        detail: leaseWrite.reason,
        nextAction: 'Fix the workspace .pd directory writability; consumption is refused until the lease can be published (fail-closed).',
      }));
      logger.error(`[PD:AutoConsumer] Consumer lease write failed for ${workspaceDir}: ${leaseWrite.reason}; refusing to consume unprotected.`);
      armOwnershipWatch(workspaceDir, state, logger);
      return;
    }

    state.stopped = false;
    state.quiescing = false;
    state.consecutiveEmptyCycles = 0;
    state.consecutiveFailures = 0;
    state.lastCycleDurationMs = null;

    function scheduleNext(decision: AdaptiveConsumerScheduleDecision): void {
      if (state.stopped || state.quiescing) return;
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
      if (state.stopped || state.quiescing) return;
      // ── PRI-1282 §8.4 marker gate (per-tick read point). ──
      const tickOwnership = evaluateOwnershipForConsumption(workspaceDir);
      if (tickOwnership.blocked) {
        state.quiescing = true;
        logOwnershipBlocked(workspaceDir, tickOwnership, logger, 'timer_tick');
        void quiesceAndWatch(workspaceDir, state, tickOwnership, logger, 'timer_tick');
        return;
      }
      // Renew the consumer lease at each cycle start so a blocked sibling
      // observes OUR live identity for the whole consuming window. Renewal
      // only overwrites our own (or a provably dead) lease — never a live
      // foreign instance's record — and a failed write parks the chain
      // rather than degrading into unprotected consumption.
      if (!leaseOursOrDead(workspaceDir)) {
        state.quiescing = true;
        SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_LEASE_LOST', JSON.stringify({
          reason: 'foreign_or_unverifiable_lease',
          nextAction: 'Another consumer instance holds the lease; this chain parks on the ownership watch.',
        }));
        logger.warn(`[PD:AutoConsumer] Consumer lease for ${workspaceDir} is foreign or unverifiable; parking this chain (fail-closed).`);
        armOwnershipWatch(workspaceDir, state, logger);
        return;
      }
      const renew = writeGatewayConsumerLease({
        workspaceDir,
        token: consumerIdentity.token,
        instanceId: consumerIdentity.instanceId,
        state: 'consuming',
      });
      if (!renew.ok) {
        state.quiescing = true;
        SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_LEASE_LOST', JSON.stringify({
          reason: 'consumer_lease_write_failed',
          detail: renew.reason,
          nextAction: 'Lease publish failed; consumption parks on the ownership watch (fail-closed).',
        }));
        logger.error(`[PD:AutoConsumer] Consumer lease renew failed for ${workspaceDir}: ${renew.reason}; parking this chain.`);
        armOwnershipWatch(workspaceDir, state, logger);
        return;
      }
      const startedAtMs = Date.now();
      const outcomeHolder: { current: InternalizationConsumerCycleOutcome | undefined } = { current: undefined };
      const cycle: Promise<void> = (async () => {
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
        // ── PRI-1282 §8.4 post-cycle ownership gate: a handover may have
        // opened WHILE this cycle ran. The chain reschedules only here, so
        // without this check the flip would stay unobserved until the next
        // tick; with it, the just-finished cycle parks the chain (and acks)
        // immediately. The detached quiesce resolves after this closure
        // returns and the tracked in-flight promise clears. ──
        const postCycle = evaluateOwnershipForConsumption(workspaceDir);
        if (postCycle.blocked) {
          state.quiescing = true;
          logOwnershipBlocked(workspaceDir, postCycle, logger, 'timer_tick');
          void quiesceAndWatch(workspaceDir, state, postCycle, logger, 'timer_tick');
          return;
        }
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
      })();
      state.inFlight = cycle;
      try {
        await cycle;
      } finally {
        // Only clear when THIS cycle is still the tracked one — a late
        // orphaned cycle (stop() deleted the state) must not clobber it.
        if (state.inFlight === cycle) state.inFlight = null;
      }
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
    const drainWorkspace = (dir: string, state: WorkspaceConsumerState): void => {
      // §3.1 order: (1) forbid new cycles, (2) clear the next timer, (3)
      // keep our lease while (4) in-flight cycles settle, (5) only then
      // release OUR lease — token + instanceId gated. On the bounded wait
      // timing out the protective lease STAYS: stop() returning is not
      // proof the consumer exited (observable timeout event); the lease is
      // released the moment the cycle's tracked promise actually settles.
      state.stopped = true;
      if (state.timeoutId) clearTimeout(state.timeoutId);
      state.timeoutId = null;
      const release = (): void => {
        clearGatewayConsumerLease(dir, consumerIdentity.token, consumerIdentity.instanceId);
      };
      const tracked = state.inFlight;
      if (tracked === null) {
        release();
        workspaceStates.delete(dir);
        return;
      }
      workspaceStates.delete(dir); // the retired entry must not be re-armed
      let completed = false;
      tracked.then(() => { completed = true; }).catch(() => { completed = true; });
      void Promise.race([tracked.catch(() => undefined), delayMs(stopDrainWaitMs)]).then(() => {
        if (completed) {
          release();
        } else {
          SystemLogger.log(dir, 'INTERNALIZATION_CONSUMER_STOP_DRAIN_TIMEOUT', JSON.stringify({
            reason: 'in_flight_cycle_still_running',
            waitMs: stopDrainWaitMs,
            nextAction: 'The protective lease is retained; it is released when the in-flight cycle actually settles.',
          }));
          void tracked.then(() => release()).catch(() => release());
        }
      });
    };
    if (workspaceDir) {
      const state = workspaceStates.get(workspaceDir);
      if (state) {
        drainWorkspace(workspaceDir, state);
      } else {
        clearGatewayConsumerLease(workspaceDir, consumerIdentity.token, consumerIdentity.instanceId);
      }
    } else {
      for (const [dir, state] of [...workspaceStates.entries()]) drainWorkspace(dir, state);
      workspaceStates.clear();
    }
  },
};

function logOwnershipBlocked(
  workspaceDir: string,
  ownership: BlockingOwnership,
  logger: PluginLogger,
  observedVia: 'service_start' | 'timer_tick',
): void {
  const payload = JSON.stringify({
    reason: ownership.state === 'manifest_unreadable'
      ? 'background_executions_manifest_unreadable'
      : `background_execution_state_${ownership.state}`,
    observedVia,
    ...(ownership.operationId !== null ? { operationId: ownership.operationId } : {}),
    ...(ownership.generation >= 0 ? { generation: ownership.generation } : {}),
    nextAction: ownership.state === 'manifest_unreadable'
      ? 'Restore ~/.pd/install.json; consumption stays refused until the ownership record is readable (fail-closed).'
      : 'This workspace is being handed over to (or rolled back by) the PD Service Host; the Gateway will resume automatically when the marker returns to legacy_owned.',
  });
  SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_OWNERSHIP_BLOCKED', payload);
  logger.warn(`[PD:AutoConsumer] Consumption blocked for workspace ${workspaceDir}: ${payload}`);
}

/**
 * Quiesce protocol (§8.4 handover evidence): park the workspace's ONE timer
 * slot, await the in-flight cycle (bounded), persist the
 * `pd.gateway-quiesce.v1` acknowledgment, then degrade the slot into the
 * ownership watch. Runs detached (`void`) — callers are timer callbacks.
 */
async function quiesceAndWatch(
  workspaceDir: string,
  state: WorkspaceConsumerState,
  ownership: BlockingOwnership,
  logger: PluginLogger,
  startedVia: 'service_start' | 'timer_tick',
): Promise<void> {
  let outcome: GatewayQuiesceAck['outcome'] = 'quiesced';
  let inFlightCycles = 0;
  if (state.inFlight !== null) {
    const tracked = state.inFlight;
    let completed = false;
    tracked.then(() => { completed = true; }).catch(() => { completed = true; });
    await Promise.race([tracked.catch(() => undefined), delayMs(GATEWAY_QUIESCE_WAIT_MS)]);
    if (!completed) {
      outcome = 'in_flight_timeout';
      inFlightCycles = 1;
      logger.warn(`[PD:AutoConsumer] Quiesce wait exceeded ${GATEWAY_QUIESCE_WAIT_MS}ms for ${workspaceDir}; recording in_flight_timeout — the handover must fail closed.`);
    }
  }
  if (ownership.state !== 'manifest_unreadable') {
    // PRI-1282 P1-3: 'quiesced' means "the workspace's consumer stopped" —
    // this process's empty in-flight only proves THIS process stopped. A
    // live foreign consumer lease (a sibling Gateway still holding the
    // workspace) makes that claim dishonest: do not ack; keep watching and
    // let the real holder's ack (or the handover's timeout) arbitrate.
    // Anything unverifiable fails closed the same way.
    const foreign = foreignConsumerLeaseStatus(workspaceDir, {
      selfToken: consumerIdentity.token,
      selfInstanceId: consumerIdentity.instanceId,
    });
    const mayClaimQuiesced = outcome !== 'quiesced' || foreign === 'none';
    if (outcome === 'quiesced' && foreign !== 'none') {
      logger.warn(`[PD:AutoConsumer] Foreign consumer lease status=${foreign} for ${workspaceDir}; refusing to ack 'quiesced' — only the lease holder may claim the workspace quiesced.`);
    }
    // §3.3: before 'quiesced' may be claimed, OUR lease lifecycle must have
    // ended correctly — the lease transitions to 'quiesced' first, and if
    // that write fails we cannot prove lifecycle completion → no ack.
    if (mayClaimQuiesced && outcome === 'quiesced') {
      const leaseEnd = writeGatewayConsumerLease({
        workspaceDir,
        token: consumerIdentity.token,
        instanceId: consumerIdentity.instanceId,
        state: 'quiesced',
      });
      if (!leaseEnd.ok) {
        logger.error(`[PD:AutoConsumer] Cannot transition consumer lease to 'quiesced' for ${workspaceDir}: ${leaseEnd.reason}; refusing to ack 'quiesced' (lease lifecycle unproven).`);
        armOwnershipWatch(workspaceDir, state, logger);
        return;
      }
    }
    if (mayClaimQuiesced) {
      const written = writeGatewayQuiesceAck({
        workspaceDir,
        state: ownership.state,
        operationId: ownership.operationId,
        generation: ownership.generation,
        inFlightCycles,
        outcome,
        startedVia,
      });
      // PRI-1282 P2-2: only suppress re-acks when the write actually landed;
      // a failed write must be retried on the next watch tick.
      if (written.ok) {
        state.ackedOperation = { state: ownership.state, operationId: ownership.operationId, generation: ownership.generation };
      } else {
        logger.error(`[PD:AutoConsumer] Quiesce ACK write failed for ${workspaceDir}: ${written.reason}; the handover will fail closed on timeout.`);
      }
    }
  }
  armOwnershipWatch(workspaceDir, state, logger);
}

function armOwnershipWatch(workspaceDir: string, state: WorkspaceConsumerState, logger: PluginLogger): void {
  if (state.stopped) return;
  state.timeoutId = setTimeout(() => {
    void watchOwnership(workspaceDir, state, logger).catch((err: unknown) => {
      logger.error(`[PD:AutoConsumer] Ownership watch failed: ${String(err)}`);
      armOwnershipWatch(workspaceDir, state, logger);
    });
  }, OWNERSHIP_WATCH_INTERVAL_MS);
  state.timeoutId?.unref();
}

/**
 * The parked slot's slow tick: re-read the marker. `legacy_owned` re-arms
 * normal consumption (rollback completed — §8.4 step 8 without a Gateway
 * restart); a NEW operation identity gets a fresh ack; anything else
 * (including unreadable) keeps watching — never consuming.
 */
async function watchOwnership(workspaceDir: string, state: WorkspaceConsumerState, logger: PluginLogger): Promise<void> {
  if (state.stopped) return;
  const ownership = evaluateOwnershipForConsumption(workspaceDir);
  if (!ownership.blocked) {
    // PRI-1282 P1-3: before resuming, arbitrate against a foreign live
    // consumer lease — a sibling Gateway instance must not double-resume.
    const foreign = foreignConsumerLeaseStatus(workspaceDir, {
      selfToken: consumerIdentity.token,
      selfInstanceId: consumerIdentity.instanceId,
    });
    if (foreign !== 'none') {
      logger.warn(`[PD:AutoConsumer] Ownership returned to legacy_owned but foreign consumer lease status=${foreign} for ${workspaceDir}; staying parked (fail-closed against double consumption).`);
      armOwnershipWatch(workspaceDir, state, logger);
      return;
    }
    state.quiescing = false;
    state.ackedOperation = null;
    SystemLogger.log(workspaceDir, 'INTERNALIZATION_CONSUMER_RESUMED', JSON.stringify({
      reason: 'background_execution_state_legacy_owned',
    }));
    logger.info(`[PD:AutoConsumer] Resuming consumption for workspace: ${workspaceDir} (ownership returned to legacy_owned).`);
    // Clear the fired watch handle and drop the parked state FIRST — the
    // service's own idempotency check ("Already started") keys on a live
    // timeoutId, so re-entering start() without this would silently no-op.
    if (state.timeoutId) clearTimeout(state.timeoutId);
    state.timeoutId = null;
    state.stopped = true; // retire the parked entry; start() builds a fresh one
    workspaceStates.delete(workspaceDir);
    // Restart the normal chain through the service's public entry so the
    // adaptive counters and the initial-delay semantics reset cleanly.
    InternalizationAutoConsumerService.start({
      config: undefined,
      workspaceDir,
      stateDir: path.join(workspaceDir, '.state'),
      logger,
    } as OpenClawPluginServiceContext);
    return;
  }
  if (ownership.state !== 'manifest_unreadable') {
    const changed = state.ackedOperation === null
      || state.ackedOperation.state !== ownership.state
      || state.ackedOperation.operationId !== ownership.operationId
      || state.ackedOperation.generation !== ownership.generation;
    if (changed) {
      // Same foreign-lease honesty gate as quiesceAndWatch (PRI-1282 P1-3).
      const foreign = foreignConsumerLeaseStatus(workspaceDir, {
        selfToken: consumerIdentity.token,
        selfInstanceId: consumerIdentity.instanceId,
      });
      if (foreign === 'none') {
        const written = writeGatewayQuiesceAck({
          workspaceDir,
          state: ownership.state,
          operationId: ownership.operationId,
          generation: ownership.generation,
          inFlightCycles: state.inFlight !== null ? 1 : 0,
          outcome: 'quiesced',
          startedVia: 'timer_tick',
        });
        if (written.ok) {
          state.ackedOperation = { state: ownership.state, operationId: ownership.operationId, generation: ownership.generation };
        }
      }
    }
  }
  armOwnershipWatch(workspaceDir, state, logger);
}
