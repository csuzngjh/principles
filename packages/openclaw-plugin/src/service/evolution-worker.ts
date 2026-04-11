/* global NodeJS */
import * as fs from 'fs';
import * as path from 'path';
import type { OpenClawPluginServiceContext, OpenClawPluginApi, PluginLogger } from '../openclaw-sdk.js';
import { DictionaryService } from '../core/dictionary-service.js';
import { DetectionService } from '../core/detection-service.js';
import { ensureStateTemplates } from '../core/init.js';
import { SystemLogger } from '../core/system-logger.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import type { EventLog } from '../core/event-log.js';
import { TaskContextBuilder } from './task-context-builder.js';
import { SessionTracker } from './session-tracker.js';
import type { PluginLogger as TaskCtxLogger } from '../utils/plugin-logger.js';
import type { TaskKind, TaskPriority } from '../core/trajectory-types.js';
export type { TaskKind, TaskPriority } from '../core/trajectory-types.js';
import { PainFlagDetector } from './pain-flag-detector.js';
import { EvolutionQueueStore } from './evolution-queue-store.js';
import type { EvolutionQueueItem, QueueStatus, TaskResolution, RecentPainContext, QueueLoadResult } from './evolution-queue-store.js';
import { EvolutionTaskDispatcher } from './evolution-task-dispatcher.js';
import { WorkflowOrchestrator } from './workflow-orchestrator.js';

// Re-export types for backward compatibility
export type { EvolutionQueueItem, QueueStatus, TaskResolution, RecentPainContext } from './evolution-queue-store.js';
export { EvolutionQueueStore } from './evolution-queue-store.js';
export { PainFlagDetector } from './pain-flag-detector.js';
export { EvolutionTaskDispatcher } from './evolution-task-dispatcher.js';
export type { DispatchResult } from './evolution-task-dispatcher.js';
export { WorkflowOrchestrator } from './workflow-orchestrator.js';
export type { WatchdogResult, SweepResult } from './workflow-orchestrator.js';
export { TaskContextBuilder } from './task-context-builder.js';
export type { CycleContextResult } from './task-context-builder.js';
export { SessionTracker } from './session-tracker.js';

/**
 * Process evolution queue — thin wrapper for backward compatibility.
 * Delegates to EvolutionTaskDispatcher.dispatchQueue().
 */
async function processEvolutionQueue(wctx: WorkspaceContext, logger: PluginLogger, eventLog: EventLog, api?: OpenClawPluginApi): Promise<import('./evolution-task-dispatcher.js').DispatchResult> {
    return await new EvolutionTaskDispatcher(wctx.workspaceDir).dispatchQueue(wctx, logger, eventLog, api);
}

let timeoutId: NodeJS.Timeout | null = null;

// Backward-compatible wrappers for test imports
export function createEvolutionTaskId(source: string, score: number, preview: string, reason: string, now: number): string {
  return EvolutionQueueStore.createTaskId(source, score, preview, reason, now);
}

export function extractEvolutionTaskId(task: string): string | null {
  return EvolutionQueueStore.extractTaskId(task);
}

export function hasRecentDuplicateTask(queue: EvolutionQueueItem[], source: string, preview: string, now: number, reason?: string): boolean {
  const store = new EvolutionQueueStore('');
  return store.hasRecentDuplicate(queue, source, preview, now, reason);
}

export function hasEquivalentPromotedRule(dictionary: { getAllRules(): Record<string, { type: string; phrases?: string[]; pattern?: string; status: string; }> }, phrase: string): boolean {
  const store = new EvolutionQueueStore('');
  return store.hasEquivalentPromotedRule(dictionary, phrase);
}

export function purgeStaleFailedTasks(queue: EvolutionQueueItem[], logger: PluginLogger): { purged: number; remaining: number; byReason: Record<string, number> } {
  const store = new EvolutionQueueStore('');
  return store.purge(queue, logger);
}










// Detection queue processing removed (D-05): processDetectionQueue deleted
// Pain candidate tracking removed (D-05, D-06): trackPainCandidate and processPromotion deleted
// Evolution queue is now the single active pain→principle path

 
export async function registerEvolutionTaskSession(
    workspaceResolve: (key: string) => string,
    taskId: string,
    sessionKey: string,
    logger?: { warn?: (message: string) => void; info?: (message: string) => void }
): Promise<boolean> {
    try {
        const queuePath = workspaceResolve('EVOLUTION_QUEUE');
        // Derive workspaceDir: queuePath = $workspaceDir/.state/evolution_queue.json
        // path.dirname(queuePath) = $workspaceDir/.state
        // path.dirname(path.dirname(queuePath)) = $workspaceDir
        const workspaceDir = path.dirname(path.dirname(queuePath));
        // Pass queuePathOverride so the store reads/writes the actual path from workspaceResolve
        const store = new EvolutionQueueStore(workspaceDir, queuePath);
        return await store.registerSession(taskId, sessionKey, logger);
    } catch (e) {
        logger?.warn?.(`[PD:EvolutionWorker] registerEvolutionTaskSession error: ${String(e)}`);
        return false;
    }
}

/**
 * Evolution Worker - Background service for pain processing and evolution task management.
 *
 * IMPORTANT: evolution_directive.json is a COMPATIBILITY-ONLY DISPLAY ARTIFACT.
 * This service does NOT read or use directive for Phase 3 eligibility or any decisions.
 * Queue (EVOLUTION_QUEUE) is the only authoritative execution truth source.
 *
 * Directive exists solely for UI/backwards compatibility display purposes.
 * Production evidence shows directive stopped updating on 2026-03-22 and is stale.
 */

 
export interface ExtendedEvolutionWorkerService {
    id: string;
    api: OpenClawPluginApi | null;
    start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
    stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
}
 

interface WorkerStatusReport {
    timestamp: string;
    cycle_start_ms: number;
    duration_ms: number;
    pain_flag: { exists: boolean; score: number | null; source: string | null; enqueued: boolean; skipped_reason: string | null };
    queue: { total: number; pending: number; in_progress: number; completed_this_cycle: number; failed_this_cycle: number };
    errors: string[];
}

function writeWorkerStatus(stateDir: string, report: WorkerStatusReport): void {
    try {
        const statusPath = path.join(stateDir, 'worker-status.json');
        fs.writeFileSync(statusPath, JSON.stringify(report, null, 2), 'utf8');
    } catch {
        // Non-critical: worker-status.json is for monitoring, failure is acceptable
    }
}

 
export const EvolutionWorkerService: ExtendedEvolutionWorkerService = {
    id: 'principles-evolution-worker',
    api: null,

    start(ctx: OpenClawPluginServiceContext): void {
        const logger = ctx?.logger || console;
        const {api} = this;
        const workspaceDir = ctx?.workspaceDir;

        if (!workspaceDir) {
            if (logger) logger.warn('[PD:EvolutionWorker] workspaceDir not found in service config. Evolution cycle disabled.');
            return;
        }

        const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });
        if (logger) logger.info(`[PD:EvolutionWorker] Starting with workspaceDir=${wctx.workspaceDir}, stateDir=${wctx.stateDir}`);

        // Session lifecycle management (DECOMP-05, DECOMP-06)
        const sessionTracker = new SessionTracker(wctx.workspaceDir);
        sessionTracker.init(wctx.stateDir);

        const {eventLog} = wctx;

        // TaskContextBuilder for per-cycle context extraction (DECOMP-05)
        const taskContextBuilder = new TaskContextBuilder(wctx.workspaceDir);

        // Store on `this` so stop() can access sessionTracker
        (this as typeof EvolutionWorkerService & { _sessionTracker?: SessionTracker })._sessionTracker = sessionTracker;
        (this as typeof EvolutionWorkerService & { _taskContextBuilder?: TaskContextBuilder })._taskContextBuilder = taskContextBuilder;

        const {config} = wctx;
        const language = config.get('language') || 'en';
        ensureStateTemplates({ logger }, wctx.stateDir, language);

        const initialDelay = 5000;
        const interval = config.get('intervals.worker_poll_ms') || (15 * 60 * 1000);

        async function runCycle(): Promise<void> {
            const cycleStart = Date.now();

            // ──── DEBUG: Verify subagent availability in heartbeat context ────
            const hbSubagent = api?.runtime?.subagent;
            logger?.info?.(`[PD:DEBUG:SubagentCheck:Heartbeat] api_exists=${!!api}, subagent_exists=${!!hbSubagent}, subagent.run_exists=${!!hbSubagent?.run}`);
            if (hbSubagent?.run) {
                logger?.info?.('[PD:DEBUG:SubagentCheck:Heartbeat] run entrypoint is callable');
            }
            const cycleResult: {
                timestamp: string;
                cycle_start_ms: number;
                duration_ms: number;
                pain_flag: { exists: boolean; score: number | null; source: string | null; enqueued: boolean; skipped_reason: string | null };
                queue: { total: number; pending: number; in_progress: number; completed_this_cycle: number; failed_this_cycle: number };
                errors: string[];
            } = {
                timestamp: new Date().toISOString(),
                cycle_start_ms: cycleStart,
                duration_ms: 0,
                pain_flag: { exists: false, score: null, source: null, enqueued: false, skipped_reason: null },
                queue: { total: 0, pending: 0, in_progress: 0, completed_this_cycle: 0, failed_this_cycle: 0 },
                errors: [],
            };

            try {
                // Use TaskContextBuilder for per-cycle context (DECOMP-05, FB-04/FB-05 fail-visible)
                // Pass eventLog so recordSkip() fires for idle/cooldown errors
                const cycleCtx = await taskContextBuilder.buildCycleContext(wctx, logger as TaskCtxLogger, eventLog);
                const { idle: idleResult, cooldown } = cycleCtx;
                if (cycleCtx.errors.length > 0) {
                    cycleCtx.errors.forEach(e => logger?.warn?.(`[PD:EvolutionWorker] Context build warning: ${e}`));
                }
                logger?.info?.(`[PD:EvolutionWorker] HEARTBEAT cycle=${new Date().toISOString()} idle=${idleResult.isIdle} idleForMs=${idleResult.idleForMs} userActiveSessions=${idleResult.userActiveSessions} abandonedSessions=${idleResult.abandonedSessionIds.length} lastActivityEpoch=${idleResult.mostRecentActivityAt}`);
                if (idleResult.isIdle) {
                    logger?.debug?.(`[PD:EvolutionWorker] Workspace idle (${idleResult.idleForMs}ms since last activity)`);
                    if (!cooldown.globalCooldownActive && !cooldown.quotaExhausted) {
                        new EvolutionTaskDispatcher(wctx.workspaceDir).enqueueSleepReflection(wctx, logger).catch((err) => {
                            logger?.error?.(`[PD:EvolutionWorker] Failed to enqueue sleep_reflection task: ${String(err)}`);
                        });
                    }
                } else {
                    logger?.debug?.(`[PD:EvolutionWorker] Workspace active (last activity ${idleResult.idleForMs}ms ago)`);
                }

                // Pain detection — fail-visible error handling
                let painCheckResult;
                try {
                    painCheckResult = await new PainFlagDetector(wctx.workspaceDir).detect(logger);
                } catch (painErr) {
                    logger?.warn?.(`[PD:EvolutionWorker] PainFlagDetector error: ${String(painErr)}`);
                    painCheckResult = { exists: false, score: null, source: null, enqueued: false, skipped_reason: `error: ${String(painErr)}` };
                    // fail-visible: emit skip event (CONTRACT-05)
                    eventLog.recordSkip(undefined, {
                        reason: 'pain_detector_error',
                        fallback: 'none',
                        context: { error: String(painErr) },
                    });
                }
                cycleResult.pain_flag = painCheckResult;

                // Purge stale failed tasks before dispatch (keeps queue lean)
                const store = new EvolutionQueueStore(wctx.workspaceDir);
                const loadResult = await store.load();
                if (loadResult.queue.length > 0) {
                    store.purge(loadResult.queue, logger);
                    await store.save(loadResult.queue);
                }

                const dispatchResult = await processEvolutionQueue(wctx, logger, eventLog, api ?? undefined);
                cycleResult.queue = {
                    total: loadResult.queue.length,
                    pending: dispatchResult.painStats.pending + dispatchResult.sleepStats.pending,
                    in_progress: dispatchResult.painStats.inProgress + dispatchResult.sleepStats.inProgress,
                    completed_this_cycle: dispatchResult.painStats.completed + dispatchResult.sleepStats.completed,
                    failed_this_cycle: 0,
                };
                if (dispatchResult.errors.length > 0) cycleResult.errors.push(...dispatchResult.errors);

                // If pain flag was enqueued AND processEvolutionQueue wrote HEARTBEAT.md
                // with a diagnostician task, immediately trigger a heartbeat to start
                // the diagnostician without waiting for the next 15-minute interval.
                // Must run AFTER processEvolutionQueue — HEARTBEAT.md must be written first.
                if (painCheckResult.enqueued) {
                    const canTrigger = !!api?.runtime?.system?.runHeartbeatOnce;
                    logger.info(`[PD:EvolutionWorker] Pain flag enqueued — runHeartbeatOnce available: ${canTrigger} (api=${!!api}, runtime=${!!api?.runtime}, system=${!!api?.runtime?.system})`);
                    if (canTrigger) {
                        try {
                            const hbResult = await api.runtime.system.runHeartbeatOnce({
                                reason: `pd-pain-diagnosis: pain flag detected, starting diagnostician`,
                            });
                            logger.info(`[PD:EvolutionWorker] Immediate heartbeat result: status=${hbResult.status}${hbResult.status === 'ran' ? ` duration=${hbResult.durationMs}ms` : ''}${hbResult.status === 'skipped' || hbResult.status === 'failed' ? ` reason=${hbResult.reason}` : ''}`);
                            if (hbResult.status === 'skipped' || hbResult.status === 'failed') {
                                logger.warn(`[PD:EvolutionWorker] Immediate heartbeat was ${hbResult.status} (${hbResult.reason}). Diagnostician will start on next regular heartbeat cycle.`);
                            }
                        } catch (hbErr) {
                            logger.warn(`[PD:EvolutionWorker] Failed to trigger immediate heartbeat: ${String(hbErr)}. Diagnostician will start on next regular heartbeat cycle.`);
                        }
                    } else {
                        // fail-visible: emit skip event (CONTRACT-05)
                        eventLog.recordSkip(undefined, {
                            reason: 'heartbeat_trigger_unavailable',
                            fallback: 'diagnostician_on_next_cycle',
                            context: { apiExists: !!api, runtimeExists: !!api?.runtime, systemExists: !!api?.runtime?.system },
                        });
                        logger?.warn?.(`[PD:EvolutionWorker] runHeartbeatOnce not available. Diagnostician will start on next regular heartbeat cycle.`);
                    }
                }

                // Detection queue processing removed (D-05)
                // processPromotion removed (D-06) — promotion via PAIN_CANDIDATES no longer needed

                // ── Workflow Orchestrator: sweep expired + watchdog ──
                const orchestrator = new WorkflowOrchestrator(wctx.workspaceDir);
                try {
                    const sweepResult = await orchestrator.sweepExpired(wctx, api ?? null, logger);
                    if (sweepResult.swept > 0) {
                        logger?.info?.(`[PD:EvolutionWorker] Swept ${sweepResult.swept} expired workflows`);
                    }
                    if (sweepResult.errors.length > 0) {
                        sweepResult.errors.forEach(e => logger?.warn?.(`[PD:EvolutionWorker] Sweep error: ${e}`));
                        cycleResult.errors.push(...sweepResult.errors);
                    }

                    const watchdogResult = await orchestrator.runWatchdog(wctx, api ?? null, logger);
                    if (watchdogResult.anomalies > 0) {
                        logger?.warn?.(`[PD:Watchdog] ${watchdogResult.anomalies} anomalies: ${watchdogResult.details.join('; ')}`);
                        cycleResult.errors.push(...watchdogResult.details);
                    }
                    if (watchdogResult.errors.length > 0) {
                        watchdogResult.errors.forEach(e => logger?.warn?.(`[PD:Watchdog] Error: ${e}`));
                        cycleResult.errors.push(...watchdogResult.errors);
                    }
                } finally {
                    // No dispose needed — WorkflowOrchestrator uses short-lived managers internally
                }

                // Dictionary flush (non-critical — fail-visible on failure)
                try {
                    wctx.dictionary.flush();
                } catch (flushErr) {
                    logger?.warn?.(`[PD:EvolutionWorker] Dictionary flush failed: ${String(flushErr)}`);
                    eventLog.recordSkip(undefined, {
                        reason: 'dictionary_flush_failed',
                        fallback: 'none',
                        context: { error: String(flushErr) },
                    });
                }

                // Session persistence flush — fail-visible on failure (CONTRACT-05)
                try {
                    sessionTracker.flush();
                } catch (flushErr) {
                    logger?.warn?.(`[PD:EvolutionWorker] Session flush failed: ${String(flushErr)}`);
                    eventLog.recordSkip(undefined, {
                        reason: 'session_flush_failed',
                        fallback: 'none',
                        context: { error: String(flushErr) },
                    });
                }

                cycleResult.duration_ms = Date.now() - cycleStart;
                writeWorkerStatus(wctx.stateDir, cycleResult);
            } catch (err) {
                const errMsg = `Error in worker interval: ${String(err)}`;
                if (logger) logger.error(`[PD:EvolutionWorker] ${errMsg}`);
                writeWorkerStatus(wctx.stateDir, {
                    timestamp: new Date().toISOString(),
                    cycle_start_ms: cycleStart,
                    duration_ms: Date.now() - cycleStart,
                    pain_flag: { exists: false, score: null, source: null, enqueued: false, skipped_reason: null },
                    queue: { total: 0, pending: 0, in_progress: 0, completed_this_cycle: 0, failed_this_cycle: 0 },
                    errors: [errMsg],
                });
            }

            timeoutId = setTimeout(runCycle, interval);
        }

        timeoutId = setTimeout(() => {
            void (async () => {
                await new PainFlagDetector(wctx.workspaceDir).detect(logger);
                // Use the same pipeline as regular cycles (includes purge + observability)
                const store = new EvolutionQueueStore(wctx.workspaceDir);
                const loadResult = await store.load();
                if (loadResult.queue.length > 0) {
                    store.purge(loadResult.queue, logger);
                    await store.save(loadResult.queue);
                }
                const dispatchResult = await processEvolutionQueue(wctx, logger, eventLog, api ?? undefined);
                if (dispatchResult.errors.length > 0) {
                    dispatchResult.errors.forEach((e) => logger?.error?.(`[PD:EvolutionWorker] Startup cycle error: ${e}`));
                }
                // Detection queue processing removed (D-05)
                timeoutId = setTimeout(runCycle, interval);
            })().catch((err) => {
                if (logger) logger.error(`[PD:EvolutionWorker] Startup worker cycle failed: ${String(err)}`);
                timeoutId = setTimeout(runCycle, interval);
            });
        }, initialDelay);
    },

    stop(ctx: OpenClawPluginServiceContext): void {
        if (ctx?.logger) ctx.logger.info('[PD:EvolutionWorker] Stopping background service...');
        if (timeoutId) clearTimeout(timeoutId);
        const tracker = (this as typeof EvolutionWorkerService & { _sessionTracker?: SessionTracker })._sessionTracker;
        if (tracker) {
            try {
                tracker.flush();
            } catch (flushErr) {
                ctx?.logger?.warn?.(`[PD:EvolutionWorker] Session flush failed on stop: ${String(flushErr)}`);
            }
        }
    }
};
