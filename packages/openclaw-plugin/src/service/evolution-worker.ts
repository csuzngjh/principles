 
 
/* global NodeJS */
 
import * as fs from 'fs';
import * as path from 'path';
import type { OpenClawPluginServiceContext, OpenClawPluginApi, PluginLogger } from '../openclaw-sdk.js';
import { DictionaryService } from '../core/dictionary-service.js';
import { DetectionService } from '../core/detection-service.js';
import { ensureStateTemplates, ensureCorePrinciples } from '../core/init.js';
import { SystemLogger } from '../core/system-logger.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import type { EventLog } from '../core/event-log.js';
import { initPersistence, flushAllSessions } from '../core/session-tracker.js';
import type { TaskKind, TaskPriority } from '../core/trajectory-types.js';
import type { PrincipleEvaluability } from '../types/principle-tree-schema.js';
export type { TaskKind, TaskPriority } from '../core/trajectory-types.js';
import { atomicWriteFileSync } from '../utils/io.js';

// Re-export queue I/O (extracted to queue-io.ts)
export { loadEvolutionQueue, saveEvolutionQueue, withQueueLock, acquireQueueLock, requireQueueLock } from './queue-io.js';
export { EVOLUTION_QUEUE_LOCK_SUFFIX, LOCK_MAX_RETRIES, LOCK_RETRY_DELAY_MS, LOCK_STALE_MS } from './queue-io.js';
import { saveEvolutionQueue, requireQueueLock } from './queue-io.js';
import { WorkflowStore } from './subagent-workflow/workflow-store.js';
import {
    WorkflowFunnelLoader,
    PiAiRuntimeAdapter,
    CorrectionObserver,
    AgentScheduler,
} from '@principles/core/runtime-v2';
import { KeywordOptimizationService } from './keyword-optimization-service.js';
import { CorrectionCueLearner } from '../core/correction-cue-learner.js';

import { PrincipleCompiler } from '../core/principle-compiler/index.js';
import { loadLedger, updatePrinciple } from '../core/principle-tree-ledger.js';
import { findRecentDuplicateTask } from './evolution-dedup.js';
import { TrajectoryRegistry } from '../core/trajectory.js';
import { WORKFLOW_TTL_MS } from '../config/defaults/runtime.js';

// ── Queue Event Payload Validation ─────────────────────────────────────────

/**
 * Validates a queue event payload string before JSON.parse.
 * Checks:
 *   1. typeof payload === 'string'
 *   2. Parsed object has required fields: 'type' and 'workspaceId'
 * Returns the parsed object only if validation passes.
 * Returns empty object {} if payload is falsy.
 * Throws Error if payload is a non-empty string that fails validation.
 */
function validateQueueEventPayload(payload: string | null | undefined): Record<string, unknown> {
    if (!payload) return {};
    if (typeof payload !== 'string') {
        throw new Error(`Queue event payload must be a string, got: ${typeof payload}`);
    }
    try {
        const parsed = JSON.parse(payload);
        if (typeof parsed !== 'object' || parsed === null) {
            throw new Error('Queue event payload must be a JSON object');
        }
        if (!('type' in parsed) || !('workspaceId' in parsed)) {
            throw new Error('Queue event payload missing required fields: type, workspaceId');
        }
        return parsed;
    } catch (err) {
        if (err instanceof SyntaxError) {
            throw new Error(`Invalid JSON in queue event payload: ${err.message}`);
        }
        throw err;
    }
}

/* istanbul ignore next — test export for validateQueueEventPayload */
export { validateQueueEventPayload };

// Re-export workflow watchdog (extracted to workflow-watchdog.ts)
import { runWorkflowWatchdog, type WatchdogResult } from './workflow-watchdog.js';
export { runWorkflowWatchdog };
export type { WatchdogResult };

let timeoutId: NodeJS.Timeout | null = null;

/**
 * Queue V2 Schema - Supports background evolution task kinds.
 *
 * Pain diagnosis is Runtime v2 only: after_tool_call / pd pain record ->
 * PainSignalBridge -> DiagnosticianRunner. EvolutionWorker does not read
 * .pain_flag or process pain_diagnosis queue items.
 */
/** @deprecated Use PDTaskStatus from '@principles/core/runtime-v2'. M2 migration will replace this. */
export type QueueStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled';
export type TaskResolution = 'marker_detected' | 'auto_completed_timeout' | 'failed_max_retries' | 'runtime_unavailable' | 'canceled' | 'late_marker_principle_created' | 'late_marker_no_principle' | 'stub_fallback' | 'skipped_thin_violation' | 'noise_classified' | 'retired';

export interface EvolutionQueueItem {
    // Core identity
    id: string;
    taskKind: TaskKind;          // V2: distinguishes task types
    priority: TaskPriority;      // V2: scheduling priority
    source: string;
    traceId?: string;           // Trace ID for linking events across the evolution lifecycle
    
    // Legacy fields kept for existing queue records and background task metadata.
    task?: string;
    score: number;
    reason: string;
    timestamp: string;
    enqueued_at?: string;
    started_at?: string;
    completed_at?: string;
    assigned_session_key?: string;
    trigger_text_preview?: string;
    status: QueueStatus;        // V2: includes 'failed' and 'canceled'
    resolution?: TaskResolution;
    session_id?: string;
    agent_id?: string;
    
    // V2 retry support
    retryCount: number;         // V2: number of retry attempts
    maxRetries: number;         // V2: maximum retry attempts allowed
    lastError?: string;         // V2: last error message if failed
    
    // V2 result reference
    resultRef?: string;         // V2: reference to result artifact

    painEventId?: number;
}

// ── Queue Migration (extracted to queue-migration.ts) ────────────────────────
import { migrateToV2, isLegacyQueueItem, migrateQueueToV2, LegacyEvolutionQueueItem, DEFAULT_TASK_KIND, DEFAULT_PRIORITY, DEFAULT_MAX_RETRIES, type RawQueueItem } from './queue-migration.js';
export { migrateToV2, isLegacyQueueItem, migrateQueueToV2, LegacyEvolutionQueueItem, DEFAULT_TASK_KIND, DEFAULT_PRIORITY, DEFAULT_MAX_RETRIES };
export type { RawQueueItem };



// Queue lock constants and requireQueueLock are imported from queue-io.ts

export function extractEvolutionTaskId(task: string): string | null {
    if (!task) return null;
    const match = /\[ID:\s*([A-Za-z0-9_-]+)\]/.exec(task);
    return match?.[1] || null;
}

/**
 * Purge stale failed tasks from the queue.
 * Failed tasks older than the threshold are noise — they won't auto-recover
 * and they bloat the queue, slowing every cycle.
 *
 * Called at the start of each cycle to keep the queue lean.
 */
const STALE_FAILED_TASK_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export function purgeStaleFailedTasks(
    queue: EvolutionQueueItem[],
    logger: PluginLogger,
): { purged: number; remaining: number; byReason: Record<string, number> } {
    const cutoff = Date.now() - STALE_FAILED_TASK_MAX_AGE_MS;
    const byReason: Record<string, number> = {};

    const purged = queue.filter((t) => {
        if (t.status !== 'failed') return false;
        const taskTime = new Date(t.timestamp || t.enqueued_at || 0).getTime();
        if (!Number.isFinite(taskTime) || taskTime > cutoff) return false;
        const reason = t.lastError || t.resolution || 'unknown';
        byReason[reason] = (byReason[reason] || 0) + 1;
        return true;
    });

    if (purged.length === 0) return { purged: 0, remaining: queue.length, byReason };

    // Remove purged items from the queue (mutates in place)
    const purgedIds = new Set(purged.map((t) => t.id));
    for (let i = queue.length - 1; i >= 0; i--) {
        if (purgedIds.has(queue[i].id)) queue.splice(i, 1);
    }

    const summary = Object.entries(byReason)
        .map(([r, c]) => `${c}x ${r}`)
        .join('; ');
    logger?.info?.(`[PD:EvolutionWorker] Purged ${purged.length} stale failed tasks (>24h): ${summary}`);

    return { purged: purged.length, remaining: queue.length, byReason };
}

 
 
export function hasRecentDuplicateTask(queue: EvolutionQueueItem[], source: string, preview: string, now: number, reason?: string): boolean {
    return !!findRecentDuplicateTask(queue, source, preview, now, reason);
}

export function hasEquivalentPromotedRule(dictionary: { getAllRules(): Record<string, { type: string; phrases?: string[]; pattern?: string; status: string; }> }, phrase: string): boolean {
    const normalizedPhrase = phrase.trim().toLowerCase();
    return Object.values(dictionary.getAllRules()).some((rule) => {
        if (rule.status !== 'active') return false;
        if (rule.type === 'exact_match' && Array.isArray(rule.phrases)) {
            return rule.phrases.some((candidate) => candidate.trim().toLowerCase() === normalizedPhrase);
        }
        if (rule.type === 'regex' && typeof rule.pattern === 'string') {
            return rule.pattern.trim().toLowerCase() === normalizedPhrase;
        }
        return false;
    });
}

/**
 * Process compilation backfill and retry loop.
 * Phase 1 — Backfill: on first call, scan for old principles (compilationRetryCount === undefined)
 *            with evaluability !== 'manual_only' and no active implementation, queue them (set to 0).
 * Phase 2 — Retry: compile all principles with compilationRetryCount >= 0.
 * After 5 consecutive failures, downgrades to manual_only and logs COMPILE_EXHAUSTED.
 */
export async function processCompilationBackfill(
    wctx: WorkspaceContext,
    logger: PluginLogger,
): Promise<void> {
    if (!wctx.stateDir) return;

    let ledger: ReturnType<typeof loadLedger>;
    try {
        ledger = loadLedger(wctx.stateDir);
    } catch (err) {
        logger?.warn?.(`[PD:EvolutionWorker] CompilationBackfill: failed to load ledger: ${String(err)}`);
        return;
    }

    // ── Phase 1: Backfill old principles (runs once per process) ─────────────────
    const backfillMarkerPath = path.join(wctx.stateDir, 'COMPILATION_BACKFILL_DONE');
    const hasBackfillRun = fs.existsSync(backfillMarkerPath);
    if (!hasBackfillRun) {
        let backfillQueued = 0;
        for (const [principleId, principle] of Object.entries(ledger.tree.principles)) {
            if (principle.compilationRetryCount !== undefined) continue; // already processed
            if (principle.evaluability === 'manual_only') continue;
            // Check if already has active implementation
            const hasActiveImpl = Object.values(ledger.tree.implementations).some(
                (impl) => impl.lifecycleState === 'active' && (
                    ledger.tree.rules[impl.ruleId]?.principleId === principleId
                )
            );
            if (hasActiveImpl) {
                // Already compiled — mark as done
                try {
                    updatePrinciple(wctx.stateDir, principleId, { compilationRetryCount: undefined });
                } catch (err) {
                    SystemLogger.log(wctx.workspaceDir, 'BACKFILL_UPDATE_FAILED',
                        `Failed to mark principle ${principleId} as done: ${String(err)}`);
                    continue;
                }
            } else {
                // Needs compilation — queue it
                try {
                    updatePrinciple(wctx.stateDir, principleId, { compilationRetryCount: 0 });
                    backfillQueued++;
                } catch (err) {
                    SystemLogger.log(wctx.workspaceDir, 'BACKFILL_UPDATE_FAILED',
                        `Failed to queue principle ${principleId}: ${String(err)}`);
                    continue;
                }
            }
        }
        if (backfillQueued > 0) {
            SystemLogger.log(wctx.workspaceDir, 'COMPILE_BACKFILL_QUEUED',
                `Queued ${backfillQueued} old principles for compilation`);
        }
        // Write marker so we don't backfill again in this process
        try {
            atomicWriteFileSync(backfillMarkerPath, new Date().toISOString());
        } catch (err) {
            SystemLogger.log(wctx.workspaceDir, 'BACKFILL_MARKER_WRITE_FAILED',
                `Failed to write backfill marker: ${String(err)}`);
        }
    }

    // ── Phase 2: Retry pending compilations ───────────────────────────────────
    const trajectory = TrajectoryRegistry.get(wctx.workspaceDir);
    const compiler = new PrincipleCompiler(wctx.stateDir, trajectory);

    // Re-load ledger after potential backfill updates
    ledger = loadLedger(wctx.stateDir);

    for (const [principleId, principle] of Object.entries(ledger.tree.principles)) {
        const count = principle.compilationRetryCount;

        // Skip: not in retry queue (undefined = done/succeeded)
        if (count === undefined) continue;

        // Skip: already exhausted (count >= 5 means 5 attempts already made)
        if (count >= 5) continue;

        // Error-isolate each principle so one failure doesn't stop all other retries
        try {
            const result = compiler.compileOne(principleId);
            if (result.success) {
                tryUpdateRetryCount(wctx.stateDir, wctx.workspaceDir, principleId, undefined);
                SystemLogger.log(wctx.workspaceDir, 'COMPILE_SUCCESS',
                    `Principle ${principleId} compiled successfully (attempt ${count + 1})`);
            } else {
                const nextCount = count + 1;
                if (nextCount >= 5) {
                    // Exhausted: single write to set manual_only (no intermediate count write)
                    tryUpdatePrinciple(wctx.stateDir, wctx.workspaceDir, principleId, {
                        evaluability: 'manual_only',
                        compilationRetryCount: undefined,
                    });
                    SystemLogger.log(wctx.workspaceDir, 'COMPILE_EXHAUSTED',
                        `Principle ${principleId} compilation exhausted after 5 attempts: ${result.reason ?? 'unknown'}`);
                } else {
                    tryUpdateRetryCount(wctx.stateDir, wctx.workspaceDir, principleId, nextCount);
                    SystemLogger.log(wctx.workspaceDir, 'COMPILE_FAILED',
                        `Principle ${principleId} compile failed: ${result.reason ?? 'unknown'} (attempt ${nextCount}/5)`);
                }
            }
        } catch (compileErr) {
            const nextCount = count + 1;
            if (nextCount >= 5) {
                // Exhausted: single write to set manual_only (no intermediate count write)
                tryUpdatePrinciple(wctx.stateDir, wctx.workspaceDir, principleId, {
                    evaluability: 'manual_only',
                    compilationRetryCount: undefined,
                });
                SystemLogger.log(wctx.workspaceDir, 'COMPILE_EXHAUSTED',
                    `Principle ${principleId} compilation exhausted after 5 attempts: threw ${String(compileErr)}`);
            } else {
                tryUpdateRetryCount(wctx.stateDir, wctx.workspaceDir, principleId, nextCount);
                SystemLogger.log(wctx.workspaceDir, 'COMPILE_FAILED',
                    `Principle ${principleId} compile threw: ${String(compileErr)} (attempt ${nextCount}/5)`);
            }
        }
    }
}

/**
 * Wrapper for updateRetryCount — logs but does not propagate errors.
 * Errors are silently swallowed: if update fails, the principle stays in its
 * current retry state and will be picked up again on the next heartbeat.
 */
function tryUpdateRetryCount(stateDir: string, workspaceDir: string, principleId: string, count: number | undefined): void {
    try {
        updatePrinciple(stateDir, principleId, { compilationRetryCount: count });
    } catch (err) {
        SystemLogger.log(workspaceDir, 'RETRY_COUNT_UPDATE_FAILED',
            `Failed to update retry count for ${principleId}: ${String(err)}`);
    }
}

/**
 * Wrapper for updatePrinciple with multiple fields — logs but does not propagate errors.
 * Errors are silently swallowed: if update fails, the principle stays in its
 * current state and will be picked up again on the next heartbeat.
 */
function tryUpdatePrinciple(
    stateDir: string,
    workspaceDir: string,
    principleId: string,
    updates: { evaluability?: PrincipleEvaluability; compilationRetryCount?: number },
): void {
    try {
        updatePrinciple(stateDir, principleId, updates);
    } catch (err) {
        SystemLogger.log(workspaceDir, 'RETRY_PRINCIPLE_UPDATE_FAILED',
            `Failed to update principle ${principleId}: ${String(err)}`);
    }
}

async function processEvolutionQueue(wctx: WorkspaceContext, logger: PluginLogger, _eventLog?: EventLog, _api?: OpenClawPluginApi) {
    const queuePath = wctx.resolve('EVOLUTION_QUEUE');
    if (!fs.existsSync(queuePath)) {
        logger?.debug?.('[PD:EvolutionWorker] No evolution queue file — nothing to process');
        return;
    }

    const releaseLock = await requireQueueLock(queuePath, logger, 'processEvolutionQueue');
    let lockReleased = false;

    try {
        let rawQueue: RawQueueItem[] = [];
        try {
            rawQueue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
        } catch (e) {
            // Backup corrupted file instead of silently discarding
            const backupPath = `${queuePath}.corrupted.${Date.now()}`;
            try {
                fs.renameSync(queuePath, backupPath);
                if (logger) {
                    logger.error(`[PD:EvolutionWorker] Evolution queue corrupted and backed up to ${backupPath}. All pending tasks have been preserved in the backup file. Parse error: ${String(e)}`);
                }
                SystemLogger.log(wctx.workspaceDir, 'QUEUE_CORRUPTED', `Queue file backed up to ${backupPath}. Error: ${String(e)}`);
            } catch (backupErr) {
                if (logger) {
                    logger.error(`[PD:EvolutionWorker] Failed to backup corrupted queue: ${String(backupErr)}`);
                }
            }
            return;
        }

        // V2: Migrate queue to current schema if needed
        let queue: EvolutionQueueItem[] = migrateQueueToV2(rawQueue) as unknown as EvolutionQueueItem[];

        // Runtime v2 owns pain diagnosis. Drop legacy pain_diagnosis queue items so
        // EvolutionWorker cannot revive the old .pain_flag -> prompt path.
        const beforeLegacyPainDrop = queue.length;
        queue = queue.filter((item) => item.taskKind !== 'pain_diagnosis');
        if (queue.length < beforeLegacyPainDrop) {
            logger?.info?.(`[PD:EvolutionWorker] Dropped ${beforeLegacyPainDrop - queue.length} legacy pain_diagnosis queue item(s); use PainSignalBridge/pd pain record`);
        }

        // Validate queue items — filter out malformed entries before processing.
        // Malformed items are logged + skipped; they never crash the evolution cycle.
        const beforeValidation = queue.length;
        queue = queue.filter((item) => {
            const errors: string[] = [];
            if (!item.id || typeof item.id !== 'string') errors.push('missing/invalid id');
            if (!item.source || typeof item.source !== 'string') errors.push('missing/invalid source');
            if (typeof item.score !== 'number') errors.push('missing/invalid score');
            if (!item.status || typeof item.status !== 'string') errors.push('missing/invalid status');
            if (!item.taskKind || typeof item.taskKind !== 'string') errors.push('missing/invalid taskKind');
            else {
                const validTaskKinds = ['model_eval'];
                if (!validTaskKinds.includes(item.taskKind)) {
                    errors.push(`invalid taskKind value '${item.taskKind}' (expected one of: ${validTaskKinds.join(', ')})`);
                }
            }
            if (typeof item.retryCount !== 'number') errors.push('missing/invalid retryCount');
            if (typeof item.maxRetries !== 'number') errors.push('missing/invalid maxRetries');
            if (errors.length > 0) {
                logger?.warn?.(`[PD:EvolutionWorker] Skipping malformed queue item: ${errors.join(', ')} | ${JSON.stringify(item).slice(0, 200)}`);
                SystemLogger.log(wctx.workspaceDir, 'QUEUE_ITEM_MALFORMED', `Skipped: ${errors.join(', ')} | id=${item.id || 'N/A'}`);
                return false;
            }
            return true;
        });
        if (queue.length < beforeValidation) {
            logger?.info?.(`[PD:EvolutionWorker] Filtered ${beforeValidation - queue.length} malformed queue item(s)`);
        }

        let queueChanged = rawQueue.some(isLegacyQueueItem) || queue.length < beforeLegacyPainDrop || queue.length < beforeValidation;

        if (queueChanged) {
            saveEvolutionQueue(queuePath, queue);
        }

    } catch (err) {
        if (logger) logger.warn(`[PD:EvolutionWorker] Error processing evolution queue: ${String(err)}`);
    } finally {
        if (!lockReleased) {
            releaseLock();
        }
    }
}

     
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
    const queuePath = workspaceResolve('EVOLUTION_QUEUE');
    if (!fs.existsSync(queuePath)) return false;

    const releaseLock = await requireQueueLock(queuePath, logger, 'registerEvolutionTaskSession');

    try {
         
         
        let rawQueue: RawQueueItem[];
        try {
            rawQueue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
        } catch (parseErr) {
            logger?.warn?.(`[PD:EvolutionWorker] Failed to parse EVOLUTION_QUEUE for session registration: ${queuePath} - ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
            return false;
        }
        
        // V2: Migrate queue to current schema
        const queue: EvolutionQueueItem[] = migrateQueueToV2(rawQueue) as unknown as EvolutionQueueItem[];

        const task = queue.find((item) => item.id === taskId && item.status === 'in_progress');
        if (!task) {
            logger?.warn?.(`[PD:EvolutionWorker] Could not find in-progress evolution task ${taskId} for session assignment`);
            return false;
        }

        task.assigned_session_key = sessionKey;
        if (!task.started_at) {
            task.started_at = new Date().toISOString();
        }
        saveEvolutionQueue(queuePath, queue);
        return true;
    } finally {
        releaseLock();
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
    _startedWorkspaces: Set<string>;
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
        atomicWriteFileSync(statusPath, JSON.stringify(report, null, 2));
    } catch (statusErr) {
        // Non-critical: worker-status.json is for monitoring, failure is acceptable
        // (no logger available in this standalone helper)
        void statusErr;
    }
}

 
 
async function processEvolutionQueueWithResult(
    wctx: WorkspaceContext,
    logger: PluginLogger,
    eventLog: EventLog,
    api?: OpenClawPluginApi | undefined
): Promise<{ queue: WorkerStatusReport['queue']; errors: string[] }> {
    const queueResult: WorkerStatusReport['queue'] = { total: 0, pending: 0, in_progress: 0, completed_this_cycle: 0, failed_this_cycle: 0 };
    const errors: string[] = [];

    try {
        const queuePath = wctx.resolve('EVOLUTION_QUEUE');
        if (!fs.existsSync(queuePath)) {
            return { queue: queueResult, errors };
        }

        const queue: EvolutionQueueItem[] = JSON.parse(fs.readFileSync(queuePath, 'utf8')) as EvolutionQueueItem[];

        // Purge stale failed tasks before processing (keeps queue lean)
        const purgeResult = purgeStaleFailedTasks(queue, logger);
        if (purgeResult.purged > 0) {
            // Write back the cleaned queue
            saveEvolutionQueue(queuePath, queue);
        }

        queueResult.total = queue.length;
        queueResult.pending = queue.filter((t) => t.status === 'pending').length;
        queueResult.in_progress = queue.filter((t) => t.status === 'in_progress').length;
        queueResult.failed_this_cycle = queue.filter((t) => t.status === 'failed').length;
        queueResult.completed_this_cycle = queue.filter((t) => t.status === 'completed').length;

        // Log queue health snapshot every cycle
        logger.info(`[PD:EvolutionWorker] Queue snapshot: total=${queueResult.total} pending=${queueResult.pending} in_progress=${queueResult.in_progress} completed=${queueResult.completed_this_cycle} failed=${queueResult.failed_this_cycle} purged=${purgeResult.purged}`);

        await processEvolutionQueue(wctx, logger, eventLog, api);
    } catch (err) {
        const errMsg = `processEvolutionQueue failed: ${String(err)}`;
        errors.push(errMsg);
        logger.error(`[PD:EvolutionWorker] ${errMsg}`);
    }

    return { queue: queueResult, errors };
}

function resolveCorrectionObserver(wctx: WorkspaceContext, logger?: Pick<PluginLogger, 'info' | 'warn' | 'error' | 'debug'>): CorrectionObserver | null {
  try {
    const loader = new WorkflowFunnelLoader(wctx.stateDir);
    const funnel = loader.getFunnel('pd-correction-observer');
    const policy = funnel?.policy;
    if (!policy || policy.runtimeKind !== 'pi-ai') {
      logger?.debug?.('[PD:Correction] workflows.yaml pd-correction-observer policy not found. Falling back to environment variables.');
      const provider = process.env.PD_CORRECTION_PROVIDER || 'anthropic';
      const model = process.env.PD_CORRECTION_MODEL || 'anthropic/claude-3-5-sonnet';
      const apiKeyEnv = process.env.PD_CORRECTION_API_KEY_ENV || 'ANTHROPIC_API_KEY';
      const baseUrl = process.env.PD_CORRECTION_BASE_URL;

      if (!process.env[apiKeyEnv]) {
        logger?.debug?.(`[PD:Correction] Correction observer API key env ${apiKeyEnv} is not set. Periodic optimization disabled.`);
        return null;
      }

      const adapter = new PiAiRuntimeAdapter({
        provider,
        model,
        apiKeyEnv,
        baseUrl,
        workspace: wctx.workspaceDir,
      });
      return new CorrectionObserver({ runtimeAdapter: adapter });
    }

    const adapter = new PiAiRuntimeAdapter({
      provider: String(policy.provider),
      model: String(policy.model),
      apiKeyEnv: String(policy.apiKeyEnv),
      maxRetries: policy.maxRetries,
      timeoutMs: policy.timeoutMs ?? 30_000,
      baseUrl: policy.baseUrl,
      workspace: wctx.workspaceDir,
    });
    return new CorrectionObserver({ runtimeAdapter: adapter }, { timeoutMs: policy.timeoutMs });
  } catch (err) {
    logger?.warn?.(`[PD:Correction] Failed to resolve CorrectionObserver: ${String(err)}`);
    return null;
  }
}

export const EvolutionWorkerService: ExtendedEvolutionWorkerService = {
    id: 'principles-evolution-worker',
    api: null,
    _startedWorkspaces: new Set<string>(),

    start(ctx: OpenClawPluginServiceContext): void {
        const workspaceDir = ctx?.workspaceDir;
        const logger = ctx?.logger || console;
        const {api} = this;

        if (!workspaceDir) {
            if (logger) logger.warn('[PD:EvolutionWorker] workspaceDir not found in service config. Evolution cycle disabled.');
            return;
        }

        // Guard: prevent duplicate starts for the SAME workspace
        const started = EvolutionWorkerService._startedWorkspaces;
        if (started.has(workspaceDir)) {
            ctx?.logger?.info?.(`[PD:EvolutionWorker] Already started for ${workspaceDir}, skipping`);
            return;
        }

        started.add(workspaceDir);

        const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });
        if (logger) logger.info(`[PD:EvolutionWorker] Starting with workspaceDir=${wctx.workspaceDir}, stateDir=${wctx.stateDir}`);

        initPersistence(wctx.stateDir);
        const {eventLog} = wctx;

        const {config} = wctx;
        const language = config.get('language') || 'en';
        ensureStateTemplates({ logger }, wctx.stateDir, language);
        ensureCorePrinciples(wctx.stateDir, logger);

        const initialDelay = 5000;
        const interval = config.get('intervals.worker_poll_ms') || (15 * 60 * 1000);

        // Periodic trigger tracking
        let heartbeatCounter = 0;

        async function runCycle(): Promise<void> {
            const cycleStart = Date.now();
            heartbeatCounter++;

            // ──── DEBUG: Verify subagent availability in heartbeat context ────
            const hbSubagent = api?.runtime?.subagent;
            logger?.info?.(`[PD:DEBUG:SubagentCheck:Heartbeat] api_exists=${!!api}, subagent_exists=${!!hbSubagent}, subagent.run_exists=${!!hbSubagent?.run}, heartbeatCounter=${heartbeatCounter}`);
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
                // Compilation backfill: runs on every heartbeat to retry failed compilations.
                // Fire-and-forget — errors are logged within the function.
                processCompilationBackfill(wctx, logger).catch((err) => {
                    logger?.error?.(`[PD:EvolutionWorker] CompilationBackfill threw: ${String(err)}`);
                });

                logger?.info?.(`[PD:EvolutionWorker] HEARTBEAT cycle=${new Date().toISOString()}`);

                const queueResult = await processEvolutionQueueWithResult(wctx, logger, eventLog, api ?? undefined);
                cycleResult.queue = queueResult.queue;
                if (queueResult.errors) cycleResult.errors.push(...queueResult.errors);

                if (api) {
                    await processDetectionQueue(wctx, api, eventLog);
                }
                // processPromotion removed (D-06) — promotion via PAIN_CANDIDATES no longer needed

                // ── Correction Observer: periodic keyword optimization (D-40-08 / H-1) ──
                try {
                    const observer = resolveCorrectionObserver(wctx, logger);
                    if (observer) {
                        logger?.info?.('[PD:EvolutionWorker] Correction Observer resolved. Initiating periodic optimization...');
                        const db = TrajectoryRegistry.get(wctx.workspaceDir);
                        const recentSessions = db.listRecentSessions({ limit: 20 });
                        const recentSessionIds = recentSessions.map(s => s.sessionId);

                        if (recentSessionIds.length > 0) {
                            const recentMessages: string[] = [];
                            for (const sId of recentSessionIds.slice(0, 5)) {
                                try {
                                    const turns = db.listUserTurnsForSession(sId);
                                    for (const t of turns) {
                                        if (t.rawExcerpt) {
                                            recentMessages.push(t.rawExcerpt);
                                        }
                                    }
                                } catch (turnErr) {
                                    logger?.warn?.(`[PD:EvolutionWorker] Failed to load user turns for session ${sId}: ${String(turnErr)}`);
                                }
                            }

                            const learner = CorrectionCueLearner.get(wctx.stateDir);
                            const keywords = learner.getStore().keywords;
                            const keywordStoreSummary = {
                                totalKeywords: keywords.length,
                                terms: keywords.map(k => ({
                                    term: k.term,
                                    weight: k.weight,
                                    hitCount: k.hitCount ?? 0,
                                    truePositiveCount: k.truePositiveCount ?? 0,
                                    falsePositiveCount: k.falsePositiveCount ?? 0,
                                })),
                            };

                            const optimizationService = KeywordOptimizationService.get(wctx.stateDir, wctx.workspaceDir, logger);
                            const trajectoryHistory = await optimizationService.buildTrajectoryHistory(recentSessionIds);

                            const payload = {
                                parentSessionId: 'evolution-worker',
                                workspaceDir: wctx.workspaceDir,
                                keywordStoreSummary,
                                recentMessages,
                                trajectoryHistory,
                            };

                            const scheduler = new AgentScheduler();
                            scheduler.register({
                                agentId: 'correction-observer',
                                mode: 'realtime',
                                runner: observer,
                            });

                            logger?.info?.(`[PD:EvolutionWorker] Dispatching correction-observer with ${trajectoryHistory.length} trajectory events, ${recentMessages.length} recent messages.`);
                            const result = await scheduler.dispatch('correction-observer', payload);
                            logger?.info?.(`[PD:EvolutionWorker] Correction-observer completed: updated=${result.updated}, summary="${result.summary}"`);
                            
                            if (result.updated) {
                                optimizationService.applyResult(result);
                            }
                        } else {
                            logger?.info?.('[PD:EvolutionWorker] No recent sessions found. Skipping correction optimization.');
                        }
                    }
                } catch (corrErr) {
                    const corrErrMsg = `Correction observer execution failed: ${String(corrErr)}`;
                    cycleResult.errors.push(corrErrMsg);
                    logger?.warn?.(`[PD:EvolutionWorker] ${corrErrMsg}`);
                }

                try {
                    const subagentRuntime = api?.runtime?.subagent;
                    const workflowStore = new WorkflowStore({ workspaceDir: wctx.workspaceDir });
                    try {
                        const expiredWorkflows = workflowStore.getExpiredWorkflows(WORKFLOW_TTL_MS);
                        for (const wf of expiredWorkflows) {
                            // Attempt session cleanup when runtime is available
                            if (subagentRuntime && wf.child_session_key) {
                                try {
                                    await subagentRuntime.deleteSession({ sessionKey: wf.child_session_key, deleteTranscript: true });
                                    workflowStore.updateCleanupState(wf.workflow_id, 'completed');
                                    logger?.info?.(`[PD:EvolutionWorker] Cleaned up session ${wf.child_session_key} for expired workflow ${wf.workflow_id}`);
                                } catch (cleanupErr) {
                                    const errMsg = `Session cleanup failed for workflow ${wf.workflow_id} (child_session=${wf.child_session_key}): ${String(cleanupErr)}`;
                                    workflowStore.updateCleanupState(wf.workflow_id, 'failed');
                                    cycleResult.errors.push(errMsg);
                                    logger?.warn?.(`[PD:EvolutionWorker] ${errMsg}`);
                                }
                            } else if (wf.child_session_key) {
                                // Runtime unavailable but session exists — structured failure, not silent
                                const errMsg = `Session cleanup unavailable for workflow ${wf.workflow_id} (child_session=${wf.child_session_key}): subagentRuntime not in gateway context`;
                                workflowStore.updateCleanupState(wf.workflow_id, 'failed');
                                cycleResult.errors.push(errMsg);
                                logger?.warn?.(`[PD:EvolutionWorker] ${errMsg}`);
                            }
                            workflowStore.updateWorkflowState(wf.workflow_id, 'expired');
                            workflowStore.recordEvent(wf.workflow_id, 'swept', wf.state, 'expired', 'TTL expired', {});
                            logger?.warn?.(`[PD:EvolutionWorker] Marked workflow ${wf.workflow_id} as expired`);
                        }
                    } finally {
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
            timeoutId.unref();
        }

        timeoutId = setTimeout(() => {
            void (async () => {
                const queueResult = await processEvolutionQueueWithResult(wctx, logger, eventLog, api ?? undefined);
                if (queueResult.errors.length > 0) {
                    queueResult.errors.forEach((e) => logger?.error?.(`[PD:EvolutionWorker] Startup cycle error: ${e}`));
                }
                if (api) {
                    await processDetectionQueue(wctx, api, eventLog);
                }
                // processPromotion removed (D-06)
                timeoutId = setTimeout(runCycle, interval);
                timeoutId.unref();
            })().catch((err) => {
                if (logger) logger.error(`[PD:EvolutionWorker] Startup worker cycle failed: ${String(err)}`);
                timeoutId = setTimeout(runCycle, interval);
                timeoutId.unref();
            });
        }, initialDelay);
        timeoutId.unref();
    },

    stop(ctx: OpenClawPluginServiceContext): void {
        if (ctx?.logger) ctx.logger.info('[PD:EvolutionWorker] Stopping background service...');
        if (timeoutId) clearTimeout(timeoutId);
        flushAllSessions();
    }
};
