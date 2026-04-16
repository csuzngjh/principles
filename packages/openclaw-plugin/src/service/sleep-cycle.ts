/**
 * Sleep Cycle Orchestrator — extracted from evolution-worker.ts
 *
 * Responsibilities:
 * - Idle workspace detection via nocturnal-runtime.js
 * - Cooldown enforcement via nocturnal-runtime.js
 * - Sleep reflection task enqueue orchestration (fire-and-forget)
 * - Keyword optimization task enqueue orchestration (fire-and-forget)
 * - Cycle heartbeat tracking and periodic trigger reset
 *
 * Does NOT include (remain in evolution-worker.ts facade):
 * - checkPainFlag, processEvolutionQueueWithResult, processDetectionQueue
 * - Workflow managers (EmpathyObserver, DeepReflect, Nocturnal)
 * - Workflow watchdog (runWorkflowWatchdog)
 * - Pain-flag-triggered immediate heartbeat
 *
 * Dependencies: nocturnal-runtime.js, nocturnal-config.js, queue-io.js
 * Zero imports from evolution-worker.ts.
 */

import type { WorkspaceContext } from '../core/workspace-context.js';
import type { OpenClawPluginApi, PluginLogger } from '../openclaw-sdk.js';
import type { EventLog } from '../core/event-log.js';
import { checkWorkspaceIdle, checkCooldown } from './nocturnal-runtime.js';
import { loadNocturnalConfigMerged } from './nocturnal-config.js';
import { enqueueSleepReflectionTask, enqueueKeywordOptimizationTask } from './queue-io.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkerStatusReport {
    timestamp: string;
    cycle_start_ms: number;
    duration_ms: number;
    pain_flag: { exists: boolean; score: number | null; source: string | null; enqueued: boolean; skipped_reason: string | null };
    queue: { total: number; pending: number; in_progress: number; completed_this_cycle: number; failed_this_cycle: number };
    errors: string[];
}

export interface CycleOptions {
    wctx: WorkspaceContext;
    logger: PluginLogger | undefined;
    eventLog: EventLog;
    api: OpenClawPluginApi | undefined;
    /** Mutable ref to the heartbeat counter — incremented by runCycle on each call */
    heartbeatCounterRef: { value: number };
}

// ---------------------------------------------------------------------------
// Cycle Orchestrator
// ---------------------------------------------------------------------------

/**
 * Execute one sleep-cycle heartbeat.
 *
 * Orchestrates:
 * 1. Load merged nocturnal config
 * 2. Check workspace idle state
 * 3. Enqueue keyword_optimization task (independent periodic trigger)
 * 4. Enqueue sleep_reflection task (idle-based OR periodic trigger + cooldown gate)
 * 5. Cycle result reporting
 *
 * Does NOT directly call checkPainFlag, processEvolutionQueueWithResult, or
 * processDetectionQueue — those remain in the evolution-worker.ts facade.
 *
 * @param options.wctx       — workspace context
 * @param options.logger     — plugin logger
 * @param options.eventLog   — event log
 * @param options.api        — OpenClaw plugin API (optional)
 * @param options.heartbeatCounterRef — mutable counter, incremented by runCycle
 */
export async function runCycle(options: CycleOptions): Promise<WorkerStatusReport> {
    const { wctx, logger, api: _api, heartbeatCounterRef } = options;
    const cycleStart = Date.now();
    heartbeatCounterRef.value++;

    // ──── DEBUG: Verify subagent availability in heartbeat context ────
    const hbSubagent = _api?.runtime?.subagent;
    logger?.info?.(`[PD:DEBUG:SubagentCheck:Heartbeat] api_exists=${!!_api}, subagent_exists=${!!hbSubagent}, subagent.run_exists=${!!hbSubagent?.run}, heartbeatCounter=${heartbeatCounterRef.value}`);
    if (hbSubagent?.run) {
        logger?.info?.('[PD:DEBUG:SubagentCheck:Heartbeat] run entrypoint is callable');
    }

    const cycleResult: WorkerStatusReport = {
        timestamp: new Date().toISOString(),
        cycle_start_ms: cycleStart,
        duration_ms: 0,
        pain_flag: { exists: false, score: null, source: null, enqueued: false, skipped_reason: null },
        queue: { total: 0, pending: 0, in_progress: 0, completed_this_cycle: 0, failed_this_cycle: 0 },
        errors: [],
    };

    try {
        // Load config on each cycle (supports runtime updates) — single file read
        const mergedConfig = loadNocturnalConfigMerged(wctx.stateDir);
        const { sleepReflection: sleepConfig, keywordOptimization: kwOptConfig } = mergedConfig;

        const idleResult = checkWorkspaceIdle(wctx.workspaceDir, {});
        logger?.info?.(`[PD:EvolutionWorker] HEARTBEAT cycle=${new Date().toISOString()} idle=${idleResult.isIdle} idleForMs=${idleResult.idleForMs} userActiveSessions=${idleResult.userActiveSessions} abandonedSessions=${idleResult.abandonedSessionIds.length} lastActivityEpoch=${idleResult.mostRecentActivityAt} triggerMode=${sleepConfig.trigger_mode}`);

        let shouldTrySleepReflection = false;

        // Path 1: Idle-based trigger (default mode)
        if (idleResult.isIdle && sleepConfig.trigger_mode === 'idle') {
            logger?.info?.(`[PD:EvolutionWorker] Workspace idle (${idleResult.idleForMs}ms since last activity)`);
            shouldTrySleepReflection = true;
        }

        // keyword_optimization: Independent periodic trigger (CORR-07).
        // Fires every kwOptConfig.period_heartbeats regardless of trigger_mode.
        // Has its own dedicated config (default 24 heartbeats = 6 hours).
        if (kwOptConfig.enabled && heartbeatCounterRef.value > 0 && heartbeatCounterRef.value % kwOptConfig.period_heartbeats === 0) {
            logger?.info?.(`[PD:EvolutionWorker] keyword_optimization trigger at heartbeat ${heartbeatCounterRef.value} (trigger_mode=${sleepConfig.trigger_mode})`);
            enqueueKeywordOptimizationTask(wctx, logger).catch((err) => {
                logger?.error?.(`[PD:EvolutionWorker] Failed to enqueue keyword_optimization task: ${String(err)}`);
            });
        }

        // Path 2: Periodic trigger for sleep_reflection (fires regardless of idle state)
        if (sleepConfig.trigger_mode === 'periodic') {
            if (heartbeatCounterRef.value >= sleepConfig.period_heartbeats) {
                logger?.info?.(`[PD:EvolutionWorker] Periodic trigger: heartbeatCounter=${heartbeatCounterRef.value} >= period_heartbeats=${sleepConfig.period_heartbeats}`);
                shouldTrySleepReflection = true;
                heartbeatCounterRef.value = 0; // Reset counter
            } else {
                logger?.info?.(`[PD:EvolutionWorker] Periodic: ${heartbeatCounterRef.value}/${sleepConfig.period_heartbeats} heartbeats — waiting`);
            }
        }

        if (shouldTrySleepReflection) {
            const cooldown = checkCooldown(wctx.stateDir, undefined, {
                globalCooldownMs: sleepConfig.cooldown_ms,
                maxRunsPerWindow: sleepConfig.max_runs_per_day,
                quotaWindowMs: 24 * 60 * 60 * 1000,
            });
            logger?.info?.(`[PD:EvolutionWorker] Cooldown check: globalCooldownActive=${cooldown.globalCooldownActive} quotaExhausted=${cooldown.quotaExhausted} runsRemaining=${cooldown.runsRemaining}`);
            if (!cooldown.globalCooldownActive && !cooldown.quotaExhausted) {
                logger?.info?.('[PD:EvolutionWorker] Attempting to enqueue sleep_reflection task...');
                enqueueSleepReflectionTask(wctx, logger).catch((err) => {
                    logger?.error?.(`[PD:EvolutionWorker] Failed to enqueue sleep_reflection task: ${String(err)}`);
                });
            } else {
                logger?.info?.(`[PD:EvolutionWorker] Skipping sleep_reflection: globalCooldown=${cooldown.globalCooldownActive} quotaExhausted=${cooldown.quotaExhausted}`);
            }
        }

        cycleResult.duration_ms = Date.now() - cycleStart;
    } catch (err) {
        const errMsg = `Error in runCycle: ${String(err)}`;
        if (logger) logger.error(`[PD:EvolutionWorker] ${errMsg}`);
        cycleResult.errors.push(errMsg);
        cycleResult.duration_ms = Date.now() - cycleStart;
    }

    return cycleResult;
}
