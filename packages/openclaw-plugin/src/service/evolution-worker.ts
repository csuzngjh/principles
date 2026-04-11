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
import { initPersistence, flushAllSessions } from '../core/session-tracker.js';
import type { TaskKind, TaskPriority } from '../core/trajectory-types.js';
export type { TaskKind, TaskPriority } from '../core/trajectory-types.js';
import { checkWorkspaceIdle, checkCooldown } from './nocturnal-runtime.js';
import { WorkflowStore } from './subagent-workflow/workflow-store.js';
import type { WorkflowRow } from './subagent-workflow/types.js';
import { EmpathyObserverWorkflowManager } from './subagent-workflow/empathy-observer-workflow-manager.js';
import { DeepReflectWorkflowManager } from './subagent-workflow/deep-reflect-workflow-manager.js';
import { NocturnalWorkflowManager } from './subagent-workflow/nocturnal-workflow-manager.js';
import { OpenClawTrinityRuntimeAdapter } from '../core/nocturnal-trinity.js';
import { PainFlagDetector } from './pain-flag-detector.js';
import { EvolutionQueueStore } from './evolution-queue-store.js';
import type { EvolutionQueueItem, QueueStatus, TaskResolution, RecentPainContext, QueueLoadResult } from './evolution-queue-store.js';
import { EvolutionTaskDispatcher } from './evolution-task-dispatcher.js';

// Re-export types for backward compatibility
export type { EvolutionQueueItem, QueueStatus, TaskResolution, RecentPainContext } from './evolution-queue-store.js';
export { EvolutionQueueStore } from './evolution-queue-store.js';
export { PainFlagDetector } from './pain-flag-detector.js';
export { EvolutionTaskDispatcher } from './evolution-task-dispatcher.js';
export type { DispatchResult } from './evolution-task-dispatcher.js';

const WORKFLOW_TTL_MS = 5 * 60 * 1000; // 5 minutes default TTL for helper workflows

// ── Workflow Watchdog ────────────────────────────────────────────────────────
// Detects stale/orphaned workflows, invalid results, and cleanup failures.
// Runs every heartbeat cycle, catching bugs like:
//   #185 — orphaned active workflows
//   #181 — structurally invalid results (all zeros)
//   #180/#183 — expired workflows not swept
//   #182 — unhandled rejections leaving workflows in limbo

interface WatchdogResult {
  anomalies: number;
  details: string[];
}

async function runWorkflowWatchdog(
  wctx: WorkspaceContext,
  api: OpenClawPluginApi | null,
  logger?: PluginLogger,
): Promise<WatchdogResult> {
  const details: string[] = [];
  const now = Date.now();
  const subagentRuntime = api?.runtime?.subagent;
  const agentSession = api?.runtime?.agent?.session;

  try {
    const store = new WorkflowStore({ workspaceDir: wctx.workspaceDir });
    try {
      const allWorkflows: WorkflowRow[] = store.listWorkflows();

      // Check 1: Stale active workflows (active > 2x TTL)
      const staleThreshold = WORKFLOW_TTL_MS * 2;
      const staleActive = allWorkflows.filter(
        (wf: WorkflowRow) => wf.state === 'active' && (now - wf.created_at) > staleThreshold,
      );
      if (staleActive.length > 0) {
        for (const wf of staleActive) {
          const ageMin = Math.round((now - wf.created_at) / 60000);
          details.push(`stale_active: ${wf.workflow_id} (${wf.workflow_type}, ${ageMin}min old)`);
          store.updateWorkflowState(wf.workflow_id, 'terminal_error');
          store.recordEvent(wf.workflow_id, 'watchdog_timeout', 'active', 'terminal_error', `Stale active > ${staleThreshold / 60000}s`, { ageMs: now - wf.created_at });

          // Cleanup session if possible (#188: gateway-safe fallback)
          if (wf.child_session_key) {
            try {
              if (subagentRuntime) {
                await subagentRuntime.deleteSession({ sessionKey: wf.child_session_key, deleteTranscript: true });
                logger?.info?.(`[PD:Watchdog] Cleaned up stale session: ${wf.child_session_key}`);
              } else if (agentSession) {
                const storePath = agentSession.resolveStorePath();
                const sessionStore = agentSession.loadSessionStore(storePath, { skipCache: true });
                const normalizedKey = wf.child_session_key.toLowerCase();
                if (sessionStore[normalizedKey]) {
                  delete sessionStore[normalizedKey];
                  await agentSession.saveSessionStore(storePath, sessionStore);
                  logger?.info?.(`[PD:Watchdog] Cleaned up stale session via agentSession fallback: ${wf.child_session_key}`);
                }
              }
            } catch (cleanupErr) {
              const errMsg = String(cleanupErr);
              if (errMsg.includes('gateway request') && agentSession) {
                const storePath = agentSession.resolveStorePath();
                const sessionStore = agentSession.loadSessionStore(storePath, { skipCache: true });
                const normalizedKey = wf.child_session_key.toLowerCase();
                if (sessionStore[normalizedKey]) {
                  delete sessionStore[normalizedKey];
                  await agentSession.saveSessionStore(storePath, sessionStore);
                  logger?.info?.(`[PD:Watchdog] Cleaned up stale session via agentSession fallback after gateway error: ${wf.child_session_key}`);
                }
              } else {
                logger?.warn?.(`[PD:Watchdog] Failed to cleanup session ${wf.child_session_key}: ${errMsg}`);
              }
            }
          }
        }
      }

      // Check 2: Workflows in terminal_error/expired without cleanup
      const unclearedTerminal = allWorkflows.filter(
        (wf: WorkflowRow) => (wf.state === 'terminal_error' || wf.state === 'expired') && wf.cleanup_state === 'pending',
      );
      if (unclearedTerminal.length > 0) {
        details.push(`uncleared_terminal: ${unclearedTerminal.length} workflows (will be swept next cycle)`);
      }

      // Check 3: Nocturnal workflow result validation (#181 pattern)
      const nocturnalCompleted = allWorkflows.filter(
        (wf: WorkflowRow) => wf.workflow_type === 'nocturnal' && wf.state === 'completed',
      );
      for (const wf of nocturnalCompleted) {
        // Check if the metadata snapshot has all zeros (invalid data)
        try {
          const meta = JSON.parse(wf.metadata_json) as Record<string, unknown>;
          const snapshot = meta.snapshot as Record<string, unknown> | undefined;
          if (snapshot) {
            // #219: Check for fallback data source (partial stats from pain context)
            const dataSource = snapshot._dataSource as string | undefined;
            if (dataSource === 'pain_context_fallback') {
              details.push(`fallback_snapshot: nocturnal workflow ${wf.workflow_id} uses pain-context fallback (stats may be incomplete)`);
            }
            const stats = snapshot.stats as Record<string, number | null> | undefined;
            if (stats && stats.totalAssistantTurns === null && stats.totalToolCalls === null && stats.totalPainEvents === 0 && stats.totalGateBlocks === null) {
              details.push(`fallback_snapshot_stats: nocturnal workflow ${wf.workflow_id} has null stats (data unavailable)`);
            }
          }
        } catch { /* ignore malformed metadata */ }
      }

      // Summary
      const stateCounts: Record<string, number> = {};
      for (const wf of allWorkflows) {
        stateCounts[wf.state] = (stateCounts[wf.state] || 0) + 1;
      }
      const stateSummary = Object.entries(stateCounts).map(([s, c]) => `${s}=${c}`).join(', ');
      if (details.length === 0) {
        logger?.debug?.(`[PD:Watchdog] OK — ${allWorkflows.length} workflows (${stateSummary})`);
      } else {
        logger?.info?.(`[PD:Watchdog] ${details.length} anomalies — ${allWorkflows.length} workflows (${stateSummary})`);
      }
    } finally {
      store.dispose();
    }
  } catch (err) {
    logger?.warn?.(`[PD:Watchdog] Failed to scan workflows: ${String(err)}`);
  }

  return { anomalies: details.length, details };
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







/**





async function processDetectionQueue(wctx: WorkspaceContext, api: OpenClawPluginApi, eventLog: EventLog) {
    const {logger} = api;
    try {
        const funnel = DetectionService.get(wctx.stateDir);
        const queue = funnel.flushQueue();
        if (queue.length === 0) return;

        if (logger) logger.info(`[PD:EvolutionWorker] Processing ${queue.length} items from detection funnel.`);

        const dictionary = DictionaryService.get(wctx.stateDir);

        for (const text of queue) {
            const match = dictionary.match(text);
            if (match) {
                if (eventLog) {
                    eventLog.recordRuleMatch(undefined, {
                        ruleId: match.ruleId,
                        layer: 'L2',
                        severity: match.severity,
                        textPreview: text.substring(0, 100)
                    });
                }
            } else {
                // L3 semantic search via trajectory database FTS5 (MEM-04)
                if (wctx.trajectory) {
                    const searchResults = wctx.trajectory.searchPainEvents(text, 5);
                    if (searchResults.length > 0) {
                        // Found similar pain events - record as L3 semantic hit
                        if (eventLog) {
                            eventLog.recordRuleMatch(undefined, {
                                ruleId: 'l3_semantic',
                                layer: 'L3',
                                severity: searchResults[0].score,
                                textPreview: text.substring(0, 100)
                            });
                        }
                        // Update detection funnel cache with L3 hit result
                        funnel.updateCache(text, { detected: true, severity: searchResults[0].score });
                        // Don't track as candidate - this is a confirmed L3 hit
                        if (logger) logger.info(`[PD:EvolutionWorker] L3 semantic hit: found ${searchResults.length} similar pain events for "${text.substring(0, 50)}..."`);
                        continue;
                    }
                }
                // No L3 hit — pain candidate tracking removed (D-05)
            }
        }
    } catch (err) {
        if (logger) logger.warn(`[PD:EvolutionWorker] Detection queue failed: ${String(err)}`);
    }
}

// PAIN_CANDIDATES system removed (D-05, D-06): trackPainCandidate and processPromotion deleted
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

        initPersistence(wctx.stateDir);
        const {eventLog} = wctx;

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
                const idleResult = checkWorkspaceIdle(wctx.workspaceDir, {});
                logger?.info?.(`[PD:EvolutionWorker] HEARTBEAT cycle=${new Date().toISOString()} idle=${idleResult.isIdle} idleForMs=${idleResult.idleForMs} userActiveSessions=${idleResult.userActiveSessions} abandonedSessions=${idleResult.abandonedSessionIds.length} lastActivityEpoch=${idleResult.mostRecentActivityAt}`);
                if (idleResult.isIdle) {
                    logger?.debug?.(`[PD:EvolutionWorker] Workspace idle (${idleResult.idleForMs}ms since last activity)`);
                    const cooldown = checkCooldown(wctx.stateDir);
                    if (!cooldown.globalCooldownActive && !cooldown.quotaExhausted) {
                        new EvolutionTaskDispatcher(wctx.workspaceDir).enqueueSleepReflection(wctx, logger).catch((err) => {
                            logger?.error?.(`[PD:EvolutionWorker] Failed to enqueue sleep_reflection task: ${String(err)}`);
                        });
                    }
                } else {
                    logger?.debug?.(`[PD:EvolutionWorker] Workspace active (last activity ${idleResult.idleForMs}ms ago)`);
                }

                const painCheckResult = await new PainFlagDetector(wctx.workspaceDir).detect(logger);
                cycleResult.pain_flag = painCheckResult;

                // Purge stale failed tasks before dispatch (keeps queue lean)
                const store = new EvolutionQueueStore(wctx.workspaceDir);
                const loadResult = await store.load();
                if (loadResult.queue.length > 0) {
                    store.purge(loadResult.queue, logger);
                    await store.save(loadResult.queue);
                }

                const dispatchResult = await new EvolutionTaskDispatcher(wctx.workspaceDir).dispatchQueue(wctx, logger, eventLog, api ?? undefined);
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
                        logger.warn(`[PD:EvolutionWorker] runHeartbeatOnce not available. Diagnostician will start on next regular heartbeat cycle.`);
                    }
                }

                if (api) {
                    await processDetectionQueue(wctx, api, eventLog);
                }
                // processPromotion removed (D-06) — promotion via PAIN_CANDIDATES no longer needed

                try {
                    // Delegate to workflow managers' sweepExpiredWorkflows so that
                    // session/transcript cleanup runs via driver.deleteSession().
                    const subagentRuntime = api?.runtime?.subagent;
                    const agentSession = api?.runtime?.agent?.session;
                    if (subagentRuntime) {
                        const empathyMgr = new EmpathyObserverWorkflowManager({
                            workspaceDir: wctx.workspaceDir,
                            logger: api.logger,
                            subagent: subagentRuntime,
                            agentSession,
                        });
                        let swept = 0;
                        try {
                            swept += await empathyMgr.sweepExpiredWorkflows(WORKFLOW_TTL_MS);
                        } finally {
                            empathyMgr.dispose();
                        }

                        const deepReflectMgr = new DeepReflectWorkflowManager({
                            workspaceDir: wctx.workspaceDir,
                            logger: api.logger,
                            subagent: subagentRuntime,
                            agentSession,
                        });
                        try {
                            swept += await deepReflectMgr.sweepExpiredWorkflows(WORKFLOW_TTL_MS);
                        } finally {
                            deepReflectMgr.dispose();
                        }

                        // #183 + #188: Sweep Nocturnal workflows too (with gateway-safe fallback)
                        try {
                            const nocturnalMgr = new NocturnalWorkflowManager({
                                workspaceDir: wctx.workspaceDir,
                                stateDir: wctx.stateDir,
                                logger: api.logger,
                                runtimeAdapter: new OpenClawTrinityRuntimeAdapter(api),
                            });
                            swept += await nocturnalMgr.sweepExpiredWorkflows(WORKFLOW_TTL_MS, subagentRuntime, agentSession);
                            nocturnalMgr.dispose();
                        } catch (noctSweepErr) {
                            logger?.warn?.(`[PD:EvolutionWorker] Nocturnal sweep failed: ${String(noctSweepErr)}`);
                        }

                        if (swept > 0) {
                            logger?.info?.(`[PD:EvolutionWorker] Swept ${swept} expired workflows (with session cleanup)`);
                        }
                    } else {
                        // Fallback: if subagent runtime unavailable, mark as expired
                        // but log that session cleanup was skipped.
                        const workflowStore = new WorkflowStore({ workspaceDir: wctx.workspaceDir });
                        const expiredWorkflows = workflowStore.getExpiredWorkflows(WORKFLOW_TTL_MS);
                        for (const wf of expiredWorkflows) {
                            workflowStore.updateWorkflowState(wf.workflow_id, 'expired');
                            workflowStore.updateCleanupState(wf.workflow_id, 'failed');
                            workflowStore.recordEvent(wf.workflow_id, 'swept', wf.state, 'expired', 'TTL expired (no runtime for session cleanup)', {});
                            logger?.warn?.(`[PD:EvolutionWorker] Marked workflow ${wf.workflow_id} as expired but could not cleanup session (subagent runtime unavailable)`);
                        }
                        workflowStore.dispose();
                    }
                } catch (sweepErr) {
                    const errMsg = `Failed to sweep expired workflows: ${String(sweepErr)}`;
                    cycleResult.errors.push(errMsg);
                    logger?.warn?.(`[PD:EvolutionWorker] ${errMsg}`);
                }

                // ── Workflow Watchdog: detect stale active workflows ──
                // This catches bugs like #185 (orphaned active), #181 (empty results),
                // #180/#183 (expired without cleanup), #182 (unhandled rejection).
                try {
                    const watchdogResult = await runWorkflowWatchdog(wctx, api, logger);
                    if (watchdogResult.anomalies > 0) {
                        logger?.warn?.(`[PD:Watchdog] ${watchdogResult.anomalies} anomalies: ${watchdogResult.details.join('; ')}`);
                        cycleResult.errors.push(...watchdogResult.details);
                    }
                } catch (watchdogErr) {
                    logger?.warn?.(`[PD:Watchdog] Watchdog failed: ${String(watchdogErr)}`);
                }

                wctx.dictionary.flush();
                flushAllSessions();

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
                const dispatchResult = await new EvolutionTaskDispatcher(wctx.workspaceDir).dispatchQueue(wctx, logger, eventLog, api ?? undefined);
                if (dispatchResult.errors.length > 0) {
                    dispatchResult.errors.forEach((e) => logger?.error?.(`[PD:EvolutionWorker] Startup cycle error: ${e}`));
                }
                if (api) {
                    await processDetectionQueue(wctx, api, eventLog);
                }
                // processPromotion removed (D-06)
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
        flushAllSessions();
    }
};
