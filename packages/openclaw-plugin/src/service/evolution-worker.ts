 
 
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
import { addDiagnosticianTask, completeDiagnosticianTask } from '../core/diagnostician-task-store.js';
import { getEvolutionLogger } from '../core/evolution-logger.js';
import type { TaskKind, TaskPriority } from '../core/trajectory-types.js';
export type { TaskKind, TaskPriority } from '../core/trajectory-types.js';
import { atomicWriteFileSync } from '../utils/io.js';

// Re-export queue I/O (extracted to queue-io.ts)
export { loadEvolutionQueue, saveEvolutionQueue, withQueueLock, acquireQueueLock, requireQueueLock } from './queue-io.js';
export { enqueueSleepReflectionTask, enqueueKeywordOptimizationTask } from './queue-io.js';
export { EVOLUTION_QUEUE_LOCK_SUFFIX, LOCK_MAX_RETRIES, LOCK_RETRY_DELAY_MS, LOCK_STALE_MS } from './queue-io.js';
import { saveEvolutionQueue, requireQueueLock, hasPendingTask, enqueueSleepReflectionTask, enqueueKeywordOptimizationTask, createEvolutionTaskId } from './queue-io.js';
import type { RecentPainContext } from './queue-io.js';
export type { RecentPainContext } from './queue-io.js';
import { checkWorkspaceIdle, checkCooldown, recordCooldown } from './nocturnal-runtime.js';
import { loadCooldownEscalationConfig, loadNocturnalConfigMerged } from './nocturnal-config.js';
import { WorkflowStore } from './subagent-workflow/workflow-store.js';
import { EmpathyObserverWorkflowManager } from './subagent-workflow/empathy-observer-workflow-manager.js';
import { DeepReflectWorkflowManager } from './subagent-workflow/deep-reflect-workflow-manager.js';
import { NocturnalWorkflowManager, nocturnalWorkflowSpec } from './subagent-workflow/nocturnal-workflow-manager.js';
import {
    createNocturnalTrajectoryExtractor,
    type NocturnalPainEvent,
    type NocturnalSessionSnapshot,
} from '../core/nocturnal-trajectory-extractor.js';
import { validateNocturnalSnapshotIngress } from '../core/nocturnal-snapshot-contract.js';
import { isExpectedSubagentError } from './subagent-workflow/subagent-error-utils.js';
import { readPainFlagContract } from '../core/pain.js';
import { CorrectionObserverWorkflowManager, correctionObserverWorkflowSpec } from './subagent-workflow/correction-observer-workflow-manager.js';
import { findRecentDuplicateTask } from './evolution-dedup.js';
import type { CorrectionObserverPayload } from './subagent-workflow/correction-observer-types.js';
import { KeywordOptimizationService } from './keyword-optimization-service.js';
import { TrajectoryRegistry } from '../core/trajectory.js';
import { CorrectionCueLearner } from '../core/correction-cue-learner.js';
import { classifyFailure, type ClassifiableTaskKind } from './failure-classifier.js';
import { recordPersistentFailure, resetFailureState, isTaskKindInCooldown } from './cooldown-strategy.js';
import { reconcileStartup } from './startup-reconciler.js';
import { WORKFLOW_TTL_MS } from '../config/defaults/runtime.js';
import { OpenClawTrinityRuntimeAdapter } from '../core/nocturnal-trinity.js';

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
 * Queue V2 Schema - Supports multiple task kinds while preserving pain_diagnosis semantics.
 *
 * taskKind semantics:
 * - pain_diagnosis: User-adjacent, triggers HEARTBEAT, injects into user prompts
 * - sleep_reflection: Background-only, never injects into user prompts, no HEARTBEAT
 *
 * Old queue items (without taskKind) are migrated to pain_diagnosis for compatibility.
 */
export type QueueStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled';
export type TaskResolution = 'marker_detected' | 'auto_completed_timeout' | 'failed_max_retries' | 'runtime_unavailable' | 'canceled' | 'late_marker_principle_created' | 'late_marker_no_principle' | 'stub_fallback' | 'skipped_thin_violation';

export interface EvolutionQueueItem {
    // Core identity
    id: string;
    taskKind: TaskKind;          // V2: distinguishes task types
    priority: TaskPriority;      // V2: scheduling priority
    source: string;
    traceId?: string;           // Trace ID for linking events across the evolution lifecycle
    
    // Legacy fields (still used for pain_diagnosis)
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

    // V2: Recent pain context for sleep_reflection tasks
    // Attaches explicit recent pain signal without merging task kinds.
    // Used by target selector for ranking bias and context enrichment.
    recentPainContext?: RecentPainContext;

    /** Trajectory pain_events row ID — set when pain flag includes pain_event_id */
    painEventId?: number;
}

// ── Queue Migration (extracted to queue-migration.ts) ────────────────────────
import { migrateToV2, isLegacyQueueItem, migrateQueueToV2, LegacyEvolutionQueueItem, DEFAULT_TASK_KIND, DEFAULT_PRIORITY, DEFAULT_MAX_RETRIES, type RawQueueItem } from './queue-migration.js';
export { migrateToV2, isLegacyQueueItem, migrateQueueToV2, LegacyEvolutionQueueItem, DEFAULT_TASK_KIND, DEFAULT_PRIORITY, DEFAULT_MAX_RETRIES };
export type { RawQueueItem };

function isSessionAtOrBeforeTriggerTime(
    session: { startedAt: string; updatedAt: string },
    triggerTimeMs: number,
): boolean {
    const startedAtMs = new Date(session.startedAt).getTime();
    const updatedAtMs = new Date(session.updatedAt).getTime();
    if (!Number.isFinite(triggerTimeMs)) {
        return true;
    }
    if (Number.isFinite(startedAtMs) && startedAtMs > triggerTimeMs) {
        return false;
    }
    if (Number.isFinite(updatedAtMs) && updatedAtMs > triggerTimeMs) {
        return false;
    }
    return true;
}

 
function buildFallbackNocturnalSnapshot(
    sleepTask: EvolutionQueueItem,
    extractor?: ReturnType<typeof createNocturnalTrajectoryExtractor> | null,
    logger?: { warn?: (message: string) => void }
): NocturnalSessionSnapshot | null {
    const painContext = sleepTask.recentPainContext;
    if (!painContext) {
        return null;
    }

    const fallbackPainEvents: NocturnalPainEvent[] = painContext.mostRecent ? [{
        source: painContext.mostRecent.source,
        score: painContext.mostRecent.score,
        severity: null,
        reason: painContext.mostRecent.reason,
        createdAt: painContext.mostRecent.timestamp,
    }] : [];

    // #246: Try to extract real session stats from trajectory DB for the pain session.
    // The main path tries getNocturnalSessionSnapshot which returns null when no session
    // exists. Here we attempt a lighter query via listRecentNocturnalCandidateSessions
    // to at least get summary counts for the pain-triggering session.
    let realStats: { totalAssistantTurns: number; totalToolCalls: number; failureCount: number; totalGateBlocks: number } | null = null;
    if (extractor && painContext.mostRecent?.sessionId) {
        try {
            // #246-fix: Use minToolCalls=0 to avoid filtering out sessions with 0 tool calls.
            // The pain-triggering session may have no tool calls but still be worth tracking.
            const summaries = extractor.listRecentNocturnalCandidateSessions({ limit: 300, minToolCalls: 0 });
            const match = summaries.find(s => s.sessionId === painContext.mostRecent?.sessionId);
            if (match) {
                realStats = {
                    totalAssistantTurns: match.assistantTurnCount,
                    totalToolCalls: match.toolCallCount,
                    failureCount: match.failureCount,
                    totalGateBlocks: match.gateBlockCount,
                };
            }
        } catch (err) {
            // #260: Log extraction failures — silent swallowing makes debugging impossible
            // and can mask systemic trajectory DB issues.
            logger?.warn?.(`[PD:EvolutionWorker] Failed to extract real stats for session ${painContext.mostRecent?.sessionId} (falling back to zeros): ${String(err)}`);
        }
    }

    return {
        sessionId: painContext.mostRecent?.sessionId || sleepTask.id,
        startedAt: sleepTask.timestamp,
        updatedAt: sleepTask.timestamp,
        assistantTurns: [],
        userTurns: [],
        toolCalls: [],
        painEvents: fallbackPainEvents,
        gateBlocks: [],
        // #268: Empty corrections in fallback path (no trajectory data available)
        userCorrections: [],
        stats: {
            totalAssistantTurns: realStats?.totalAssistantTurns ?? 0,
            totalToolCalls: realStats?.totalToolCalls ?? 0,
            failureCount: realStats?.failureCount ?? 0,
            totalPainEvents: painContext.recentPainCount,
            totalGateBlocks: realStats?.totalGateBlocks ?? 0,
        },
        _dataSource: 'pain_context_fallback',
    };
}

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

interface ParsedPainValues {
    score: number; source: string; reason: string; preview: string;
    traceId: string; sessionId: string; agentId: string;
    painEventId?: number;
}

 
 
async function doEnqueuePainTask(
    wctx: WorkspaceContext, logger: PluginLogger, painFlagPath: string,
    result: WorkerStatusReport['pain_flag'], v: ParsedPainValues,
): Promise<WorkerStatusReport['pain_flag']> {
    result.exists = true;
    result.score = v.score;
    result.source = v.source;

    if (v.score < 30) {
        result.skipped_reason = `score_too_low (${v.score} < 30)`;
        if (logger) logger.info(`[PD:EvolutionWorker] Pain flag score too low: ${v.score} (source=${v.source})`);
        return result;
    }

    const queuePath = wctx.resolve('EVOLUTION_QUEUE');
    const releaseLock = await requireQueueLock(queuePath, logger, 'checkPainFlag');
    try {
        let queue: EvolutionQueueItem[] = [];
        if (fs.existsSync(queuePath)) {
            try { queue = JSON.parse(fs.readFileSync(queuePath, 'utf8')); } catch { /* corrupted queue, treat as empty — safe fallback */ }
        }
        const now = Date.now();
        const dup = findRecentDuplicateTask(queue, v.source, v.preview, now, v.reason);
        if (dup) {
            fs.appendFileSync(painFlagPath, `\nstatus: queued\ntask_id: ${dup.id}\n`, 'utf8');
            result.enqueued = true;
            result.skipped_reason = 'duplicate';
            if (logger) logger.info(`[PD:EvolutionWorker] Duplicate pain task skipped for source=${v.source} preview=${v.preview || 'N/A'}`);
            return result;
        }

        const taskId = createEvolutionTaskId(v.source, v.score, v.preview, v.reason, now);
        const nowIso = new Date(now).toISOString();
        const effectiveTraceId = v.traceId || taskId;

        queue.push({
            id: taskId, taskKind: 'pain_diagnosis',
            priority: v.score >= 70 ? 'high' : v.score >= 40 ? 'medium' : 'low',
            score: v.score, source: v.source, reason: v.reason,
            trigger_text_preview: v.preview, timestamp: nowIso, enqueued_at: nowIso,
            status: 'pending', session_id: v.sessionId || undefined,
            agent_id: v.agentId || undefined, traceId: effectiveTraceId,
            retryCount: 0, maxRetries: 3,
            painEventId: v.painEventId,
        });

        saveEvolutionQueue(queuePath, queue);
        fs.appendFileSync(painFlagPath, `\nstatus: queued\ntask_id: ${taskId}\n`, 'utf8');
        result.enqueued = true;

        if (logger) logger.info(`[PD:EvolutionWorker] Enqueued pain task ${taskId} (score=${v.score})`);

        const evoLogger = getEvolutionLogger(wctx.workspaceDir, wctx.trajectory);
        evoLogger.logQueued({
            traceId: effectiveTraceId,
            taskId,
            score: v.score,
            source: v.source,
            reason: v.reason,
        });

        wctx.trajectory?.recordEvolutionTask?.({
            taskId,
            traceId: effectiveTraceId,
            source: v.source,
            reason: v.reason,
            score: v.score,
            status: 'pending',
            enqueuedAt: nowIso,
        });
    } finally { releaseLock(); }
    return result;
}

async function checkPainFlag(wctx: WorkspaceContext, logger: PluginLogger): Promise<WorkerStatusReport['pain_flag']> {
    const result: WorkerStatusReport['pain_flag'] = { exists: false, score: null, source: null, enqueued: false, skipped_reason: null };
    try {
        const painFlagPath = wctx.resolve('PAIN_FLAG');
        if (!fs.existsSync(painFlagPath)) return result;

        const rawPain = fs.readFileSync(painFlagPath, 'utf8');
        const contract = readPainFlagContract(wctx.workspaceDir);

        if (contract.status === 'valid') {
            const score = parseInt(contract.data.score ?? '0', 10) || 0;
            const source = contract.data.source ?? 'unknown';
            const reason = contract.data.reason ?? 'Systemic pain detected';
            const preview = contract.data.trigger_text_preview ?? '';
            const isQueued = contract.data.status === 'queued';
            const traceId = contract.data.trace_id ?? '';
            const sessionId = contract.data.session_id ?? '';
            const agentId = contract.data.agent_id ?? '';
            const painEventIdRaw = contract.data.pain_event_id;
            const painEventId = painEventIdRaw ? parseInt(painEventIdRaw, 10) : undefined;

            result.exists = true;
            result.score = score;
            result.source = source;
            result.enqueued = isQueued;

            if (isQueued) {
                result.skipped_reason = 'already_queued';
                if (logger) logger.info(`[PD:EvolutionWorker] Pain flag already queued (score=${score}, source=${source})`);
                return result;
            }

            if (logger) logger.info(`[PD:EvolutionWorker] Detected pain flag (score: ${score}, source: ${source}). Enqueueing evolution task.`);
            return doEnqueuePainTask(wctx, logger, painFlagPath, result, {
                score, source, reason, preview, traceId, sessionId, agentId, painEventId,
            });
        }

        if (contract.status === 'invalid' && (contract.format === 'kv' || contract.format === 'json' || contract.format === 'invalid_json')) {
            result.exists = true;
            result.skipped_reason = `invalid_pain_flag (${contract.missingFields.join(', ') || contract.format})`;
            if (logger) logger.warn(`[PD:EvolutionWorker] Invalid pain flag skipped: ${result.skipped_reason}`);
            return result;
        }

        // Try JSON format first (pain skill structured output)
        // The file may have 'status: queued' and 'task_id: xxx' appended after the JSON object.
        // Extract just the JSON portion by finding the last '}' and parsing up to that point.
        let parsedAsJson = false;
        try {
            const jsonEndIdx = rawPain.lastIndexOf('}');
            const jsonPortion = jsonEndIdx >= 0 ? rawPain.slice(0, jsonEndIdx + 1) : rawPain;
            const jsonPain = JSON.parse(jsonPortion);

            // Detect if this is a pain flag JSON object: has any of the known pain flag fields
            const isPainJson = typeof jsonPain === 'object' && jsonPain !== null && (
                jsonPain.pain_score !== undefined ||
                jsonPain.score !== undefined ||
                jsonPain.source !== undefined ||
                jsonPain.reason !== undefined ||
                jsonPain.session_id !== undefined ||
                jsonPain.agent_id !== undefined
            );

            if (isPainJson) {
                parsedAsJson = true;
                // Score resolution: pain_score > score > default 50
                const jsonScore = typeof jsonPain.pain_score === 'number' ? jsonPain.pain_score :
                                  typeof jsonPain.score === 'number' ? jsonPain.score : 50;
                const jsonSource = jsonPain.source || 'human';
                const jsonReason = jsonPain.reason || jsonPain.requested_action || 'Systemic pain detected';
                const jsonPreview = (jsonPain.symptoms || []).slice(0, 2).join('; ');

                // Check if already queued by looking for 'status: queued' in the full file
                const alreadyQueued = rawPain.includes('status: queued');
                if (alreadyQueued) {
                    result.exists = true;
                    result.score = jsonScore;
                    result.source = jsonSource;
                    result.enqueued = true;
                    result.skipped_reason = 'already_queued';
                    if (logger) logger.info(`[PD:EvolutionWorker] Pain flag already queued (score=${jsonScore}, source=${jsonSource})`);
                    return result;
                }

                return doEnqueuePainTask(wctx, logger, painFlagPath, result, {
                    score: jsonScore, source: jsonSource, reason: jsonReason,
                    preview: jsonPreview, traceId: '',
                    sessionId: jsonPain.session_id || '',
                    agentId: jsonPain.agent_id || '',
                    painEventId: jsonPain.pain_event_id ? parseInt(jsonPain.pain_event_id, 10) : undefined,
                });
            }
        } catch { /* Not JSON — fall through to KV/Markdown parsing */ }

        // If we successfully parsed JSON but it didn't match pain flag fields,
        // don't fall through to KV parsing — it's not a valid pain flag
        if (parsedAsJson) {
            if (logger) logger.warn('[PD:EvolutionWorker] Pain flag parsed as JSON but missing all expected fields — ignoring');
            result.skipped_reason = 'invalid_json_format';
            return result;
        }

        const lines = rawPain.split('\n');

        let score = 0;
        let source = 'unknown';
        let reason = 'Systemic pain detected';
        let preview = '';
        let isQueued = false;
        let traceId = '';
        let sessionId = '';
        let agentId = '';
        let painEventId: number | undefined;

        for (const line of lines) {
            // KV format: "key: value"
            if (line.startsWith('score:')) score = parseInt(line.split(':', 2)[1].trim(), 10) || 0;
            if (line.startsWith('source:')) source = line.split(':', 2)[1].trim();
            if (line.startsWith('reason:')) reason = line.slice('reason:'.length).trim();
            if (line.startsWith('trigger_text_preview:')) preview = line.slice('trigger_text_preview:'.length).trim();
            if (line.startsWith('status: queued')) isQueued = true;
            if (line.startsWith('trace_id:')) traceId = line.split(':', 2)[1].trim();
            if (line.startsWith('session_id:')) sessionId = line.slice('session_id:'.length).trim();
            if (line.startsWith('agent_id:')) agentId = line.slice('agent_id:'.length).trim();
            if (line.startsWith('pain_event_id:')) {
                const raw = line.slice('pain_event_id:'.length).trim();
                painEventId = parseInt(raw, 10) || undefined;
            }

            // Key=Value fallback format: "key=value" (pain skill manual output)
            // Handles both uppercase (Source=X) and lowercase (source=x) variants
            if (line.startsWith('Source=') || line.startsWith('source=')) source = line.includes('Source=') ? line.slice('Source='.length).trim() : line.slice('source='.length).trim();
            if (line.startsWith('Reason=') || line.startsWith('reason=')) reason = line.includes('Reason=') ? line.slice('Reason='.length).trim() : line.slice('reason='.length).trim();
            if (line.startsWith('Score=') || line.startsWith('score=')) {
                const scoreStr = line.includes('Score=') ? line.slice('Score='.length).trim() : line.slice('score='.length).trim();
                score = parseInt(scoreStr, 10) || 0;
            }
            if (line.startsWith('Time=') || line.startsWith('time=')) {
                const timeStr = line.includes('Time=') ? line.slice('Time='.length).trim() : line.slice('time='.length).trim();
                preview = `Human intervention at ${timeStr}`;
            }

            // Markdown format support (pain skill writes **Source**: xxx format)
            const mdSource = /\*\*Source\*\*:\s*(.+)/.exec(line);
            if (mdSource) source = mdSource[1].trim();
            const mdReason = /\*\*Reason\*\*:\s*(.+)/.exec(line);
            if (mdReason) reason = mdReason[1].trim();
            const mdTime = /\*\*Time\*\*:\s*(.+)/.exec(line);
            if (mdTime) preview = `Human intervention at ${mdTime[1].trim()}`;
        }

        // Markdown format has no score — default to 50 for human intervention
        if (score === 0 && source !== 'unknown') score = 50;

        result.exists = true;
        result.score = score;
        result.source = source;
        result.enqueued = isQueued;

        if (isQueued) {
            result.skipped_reason = 'already_queued';
            if (logger) logger.info(`[PD:EvolutionWorker] Pain flag already queued (score=${score}, source=${source})`);
            return result;
        }

        if (logger) logger.info(`[PD:EvolutionWorker] Detected pain flag (score: ${score}, source: ${source}). Enqueueing evolution task.`);

        return doEnqueuePainTask(wctx, logger, painFlagPath, result, {
            score, source, reason, preview,
            traceId, sessionId, agentId, painEventId,
        });

    } catch (err) {
        if (logger) logger.warn(`[PD:EvolutionWorker] Error processing pain flag: ${String(err)}`);
        result.skipped_reason = `error: ${String(err)}`;
    }
    return result;
}

 
 
async function processEvolutionQueue(wctx: WorkspaceContext, logger: PluginLogger, eventLog: EventLog, api?: OpenClawPluginApi) {
    const queuePath = wctx.resolve('EVOLUTION_QUEUE');
    if (!fs.existsSync(queuePath)) {
        logger?.debug?.('[PD:EvolutionWorker] No evolution queue file — nothing to process');
        return;
    }

    const releaseLock = await requireQueueLock(queuePath, logger, 'processEvolutionQueue');
    const evoLogger = getEvolutionLogger(wctx.workspaceDir, wctx.trajectory);
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
        const queue: EvolutionQueueItem[] = migrateQueueToV2(rawQueue) as unknown as EvolutionQueueItem[];

        let queueChanged = rawQueue.some(isLegacyQueueItem);

        // Guard: Skip keyword_optimization if one is already pending/in-progress (CORR-08)
        if (hasPendingTask(queue, 'keyword_optimization')) {
            logger?.debug?.('[PD:EvolutionWorker] keyword_optimization task already pending/in-progress, skipping enqueue');
        }

        const {config} = wctx;
        const timeout = config.get('intervals.task_timeout_ms') || (60 * 60 * 1000); // Default 1 hour

        // V2: Recover stuck in_progress sleep_reflection tasks.
        // If the worker crashes or the result write-back fails after Phase 1 claimed
        // the task, it stays in_progress indefinitely. Detect via timeout and mark
        // as failed so a fresh task can be enqueued on the next idle cycle.
        // #214: Also expire the underlying nocturnal workflow to prevent resource leaks.
        for (const task of queue.filter(t => t.status === 'in_progress' && t.taskKind === 'sleep_reflection')) {
            const startedAt = new Date(task.started_at || task.timestamp);
            const age = Date.now() - startedAt.getTime();
            if (age > timeout) {
                task.status = 'failed';
                task.completed_at = new Date().toISOString();
                task.resolution = 'failed_max_retries';
                task.retryCount = (task.retryCount ?? 0) + 1;
                queueChanged = true;

                // #219: Fetch real failure reason from workflow events for better diagnostics
                let detailedError = `sleep_reflection timed out after ${Math.round(timeout / 60000)} minutes`;
                if (task.resultRef && !task.resultRef.startsWith('trinity-draft')) {
                    try {
                        const wfStore = new WorkflowStore({ workspaceDir: wctx.workspaceDir });
                        const events = wfStore.getEvents(task.resultRef);
                        // Find the most recent failure event
                        const failureEvent = events.filter(e => 
                            e.event_type.includes('failed') || e.event_type.includes('error')
                        ).pop();
                        if (failureEvent) {
                            const payload = validateQueueEventPayload(failureEvent.payload_json);
                            detailedError = `sleep_reflection failed: ${failureEvent.reason}`;
                            if (payload.skipReason) {
                                detailedError += ` (skipReason: ${payload.skipReason})`;
                            }
                            if (payload.failures && Array.isArray(payload.failures) && payload.failures.length > 0) {
                                detailedError += ` | failures: ${(payload.failures as string[]).slice(0, 3).join(', ')}`;
                            }
                        }
                    } catch (fetchErr) {
                        logger?.debug?.(`[PD:EvolutionWorker] Could not fetch workflow events for ${task.resultRef}: ${String(fetchErr)}`);
                    }
                }
                task.lastError = detailedError;
                
                logger?.warn?.(`[PD:EvolutionWorker] sleep_reflection task ${task.id} timed out after ${Math.round(age / 60000)} minutes, marking as failed. Reason: ${detailedError}`);
                evoLogger.logCompleted({
                    traceId: task.traceId || task.id,
                    taskId: task.id,
                    resolution: 'manual',
                    durationMs: age,
                });

                // #214: Expire the underlying nocturnal workflow to prevent resource leak.
                // The task's resultRef holds the workflowId if one was started.
                if (task.resultRef && !task.resultRef.startsWith('trinity-draft')) {
                    try {
                        const nocturnalMgr = new NocturnalWorkflowManager({
                            workspaceDir: wctx.workspaceDir,
                            stateDir: wctx.stateDir,
                            logger: api?.logger || logger,
                             
                            runtimeAdapter: new OpenClawTrinityRuntimeAdapter(api!),
                            subagent: api?.runtime?.subagent,
                        });
                        try {
                            // Force-expire this specific workflow regardless of TTL
                            nocturnalMgr.expireWorkflow(
                                task.resultRef,
                                `Sleep reflection task ${task.id} timed out after ${Math.round(age / 60000)} min`,
                            );
                            logger?.info?.(`[PD:EvolutionWorker] Expired nocturnal workflow ${task.resultRef} for timed-out sleep task ${task.id}`);
                        } finally {
                            nocturnalMgr.dispose();
                        }
                    } catch (expireErr) {
                        logger?.warn?.(`[PD:EvolutionWorker] Could not expire nocturnal workflow ${task.resultRef}: ${String(expireErr)}`);
                    }
                }
            }
        }

        // Check in_progress tasks for completion (only pain_diagnosis gets HEARTBEAT treatment)
        // Diagnostician runs via HEARTBEAT (main session LLM), not as a subagent.
        // Marker file detection is the ONLY completion path for HEARTBEAT diagnostics.
        for (const task of queue.filter(t => t.status === 'in_progress' && t.taskKind === 'pain_diagnosis')) {
            const startedAt = new Date(task.started_at || task.timestamp);

            // Condition 1: Check for marker file (created by diagnostician on completion)
            const completeMarker = path.join(wctx.stateDir, `.evolution_complete_${task.id}`);
            if (fs.existsSync(completeMarker)) {
                if (logger) logger.info(`[PD:EvolutionWorker] Task ${task.id} completed - marker file detected`);

                // Create principle from the diagnostician's JSON report.
                const reportPath = path.join(wctx.stateDir, `.diagnostician_report_${task.id}.json`);
                if (fs.existsSync(reportPath)) {
                    try {
                        const reportData = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
                        // Check ALL known nesting paths — matches subagent.ts parseDiagnosticianReport
                        const principle = reportData?.principle
                            || reportData?.phases?.principle_extraction?.principle
                            || reportData?.diagnosis_report?.principle
                            || reportData?.diagnosis_report?.phases?.principle_extraction?.principle;
                        if (principle?.trigger_pattern && principle?.action) {
                            // Check for duplicate principle (diagnostician may output existing principle)
                            if (principle.duplicate === true) {
                                logger.info(`[PD:EvolutionWorker] Diagnostician marked principle as duplicate: ${principle.duplicate_of || 'unknown'} — skipping creation for task ${task.id}`);
                                task.status = 'completed';
                                task.completed_at = new Date().toISOString();
                                task.resolution = 'marker_detected';
                            } else {
                                // ── Server-side dedup guard (defense against LLM ignoring duplicate check) ──
                                const existingPrinciples = wctx.evolutionReducer.getActivePrinciples();
                                let serverDuplicate: string | null = null;
                                if (existingPrinciples.length > 0) {
                                    const newTrigger = (principle.trigger_pattern || '').toLowerCase();
                                    const newAbstracted = (principle.abstracted_principle || '').toLowerCase();
                                    for (const ep of existingPrinciples) {
                                        const epTrigger = (ep.trigger || '').toLowerCase();
                                        const epAbstracted = (ep.abstractedPrinciple || '').toLowerCase();
                                        const epText = (ep.text || '').toLowerCase();

                                        // Check 1: abstracted principle overlap (>70% keyword match)
                                        const newKeywords = newAbstracted.split(/\s+/).filter((w: string) => w.length > 3);
                                        const epKeywords = epAbstracted.split(/\s+/).filter((w: string) => w.length > 3);
                                        if (newKeywords.length > 0 && epKeywords.length > 0) {
                                            const overlap = newKeywords.filter((k: string) => epKeywords.includes(k)).length;
                                            const overlapRatio = overlap / Math.max(newKeywords.length, epKeywords.length);
                                            if (overlapRatio > 0.7) {
                                                serverDuplicate = ep.id;
                                                break;
                                            }
                                        }

                                        // Check 2: trigger pattern contains same key terms
                                        if (newTrigger.length > 10 && epTrigger.length > 10) {
                                            const sharedTerms = newTrigger.split(/[\s|\\.+*?()[\]{}^$-]+/).filter((t: string) => t.length > 3);
                                            if (sharedTerms.length > 0 && sharedTerms.every((t: string) => epTrigger.includes(t))) {
                                                serverDuplicate = ep.id;
                                                break;
                                            }
                                        }

                                        // Check 3: text overlap (LLM often reuses text from existing principle)
                                        if (epText.length > 20 && newTrigger.length > 20) {
                                            const sharedPhrases = epText.split(/\s+/).filter(w => w.length > 5);
                                            const matchCount = sharedPhrases.filter(w => newTrigger.includes(w)).length;
                                            if (matchCount >= 3) {
                                                serverDuplicate = ep.id;
                                                break;
                                            }
                                        }
                                    }
                                }

                                if (serverDuplicate) {
                                    logger.info(`[PD:EvolutionWorker] Server-side dedup: new principle overlaps with existing ${serverDuplicate} — skipping creation for task ${task.id}`);
                                    task.status = 'completed';
                                    task.completed_at = new Date().toISOString();
                                    task.resolution = 'marker_detected';
                                } else {
                                    logger.info(`[PD:EvolutionWorker] Creating principle from report for task ${task.id}`);
                                    const principleId = wctx.evolutionReducer.createPrincipleFromDiagnosis({
                                        painId: task.id,
                                        painType: task.source === 'Human Intervention' ? 'user_frustration' : 'tool_failure',
                                        triggerPattern: principle.trigger_pattern,
                                        action: principle.action,
                                        source: task.source || 'heartbeat_diagnostician',
                                        // #212: Default to weak_heuristic so principles are auto-evaluable
                                        // without requiring full detectorMetadata from the diagnostician.
                                        evaluability: principle.evaluability || 'weak_heuristic',
                                        // Review fix: Accept both snake_case and camelCase from LLM output
                                        detectorMetadata: principle.detector_metadata || principle.detectorMetadata,
                                        abstractedPrinciple: principle.abstracted_principle,
                                        coreAxiomId: principle.core_axiom_id || principle.coreAxiomId,
                                    });
                                    if (principleId) {
                                        logger.info(`[PD:EvolutionWorker] Created principle ${principleId} from marker fallback for task ${task.id}`);
                                    } else {
                                        logger.warn(`[PD:EvolutionWorker] createPrincipleFromDiagnosis returned null for task ${task.id} (may be duplicate or blacklisted)`);
                                    }
                                    task.status = 'completed';
                                    task.completed_at = new Date().toISOString();
                                    task.resolution = 'marker_detected';
                                }
                            }
                        } else {
                            logger.warn(`[PD:EvolutionWorker] Diagnostician report for task ${task.id} missing principle fields — diagnostician did not produce a principle`);
                        }
                    } catch (err) {
                        logger.warn(`[PD:EvolutionWorker] Failed to parse diagnostician report for task ${task.id}: ${String(err)}`);
                    }
                } else {
                    logger.warn(`[PD:EvolutionWorker] No diagnostician report found for completed task ${task.id} (expected: .diagnostician_report_${task.id}.json)`);
                }

                task.status = 'completed';
                task.completed_at = new Date().toISOString();
                task.resolution = 'marker_detected';
                try {
                    fs.unlinkSync(completeMarker);
                } catch { /* marker may have been deleted already, not critical */ }

                // #190: Clean up diagnostician report file after processing
                try {
                    const cleanupReportPath = path.join(wctx.stateDir, `.diagnostician_report_${task.id}.json`);
                    if (fs.existsSync(cleanupReportPath)) fs.unlinkSync(cleanupReportPath);
                } catch { /* report may not exist, not critical */ }

                // FIX (#187): Remove the task from the diagnostician task store
                await completeDiagnosticianTask(wctx.stateDir, task.id);

                // Log to EvolutionLogger
                const durationMs = task.started_at
                    ? Date.now() - new Date(task.started_at).getTime()
                    : undefined;
                evoLogger.logCompleted({
                    traceId: task.traceId || task.id,
                    taskId: task.id,
                    resolution: 'marker_detected',
                    durationMs,
                });

                // Update evolution_tasks table
                wctx.trajectory?.updateEvolutionTask?.(task.id, {
                    status: 'completed',
                    completedAt: task.completed_at,
                    resolution: 'marker_detected',
                });

                wctx.trajectory?.recordTaskOutcome({
                    sessionId: task.assigned_session_key || 'heartbeat:diagnostician',
                    taskId: task.id,
                    outcome: 'ok',
                    summary: `Task ${task.id} completed - marker file detected.`
                });
                queueChanged = true;
                continue;
            }

            const age = Date.now() - startedAt.getTime();
            if (age > timeout) {
                const timeoutMinutes = Math.round(timeout / 60000);

                const timeoutCompleteMarker = path.join(wctx.stateDir, `.evolution_complete_${task.id}`);
                const timeoutReportPath = path.join(wctx.stateDir, `.diagnostician_report_${task.id}.json`);

                if (fs.existsSync(timeoutCompleteMarker) && fs.existsSync(timeoutReportPath)) {
                    if (logger) logger.info(`[PD:EvolutionWorker] Task ${task.id} timed out but marker found — creating principle anyway`);
                    let principleCreated = false;
                    try {
                        const reportData = JSON.parse(fs.readFileSync(timeoutReportPath, 'utf8'));
                        const principle = reportData?.principle
                            || reportData?.phases?.principle_extraction?.principle
                            || reportData?.diagnosis_report?.principle
                            || reportData?.diagnosis_report?.phases?.principle_extraction?.principle;
                        if (principle?.trigger_pattern && principle?.action) {
                            if (principle.duplicate === true) {
                                logger.info(`[PD:EvolutionWorker] Diagnostician marked principle as duplicate: ${principle.duplicate_of || 'unknown'} — skipping for task ${task.id}`);
                            } else {
                                const principleId = wctx.evolutionReducer.createPrincipleFromDiagnosis({
                                    painId: task.id,
                                    painType: task.source === 'Human Intervention' ? 'user_frustration' : 'tool_failure',
                                    triggerPattern: principle.trigger_pattern,
                                    action: principle.action,
                                    source: task.source || 'heartbeat_diagnostician',
                                    // #212: Default to weak_heuristic so principles are auto-evaluable.
                                    evaluability: principle.evaluability || 'weak_heuristic',
                                    // Review fix: Accept both snake_case and camelCase from LLM output
                                    detectorMetadata: principle.detector_metadata || principle.detectorMetadata,
                                    abstractedPrinciple: principle.abstracted_principle,
                                        coreAxiomId: principle.core_axiom_id || principle.coreAxiomId,
                                    });
                                if (principleId) {
                                    logger.info(`[PD:EvolutionWorker] Created principle ${principleId} from late marker for task ${task.id}`);
                                    principleCreated = true;
                                }
                            }
                        }
                    } catch (err) {
                        logger.warn(`[PD:EvolutionWorker] Failed to parse late diagnostician report for task ${task.id}: ${String(err)}`);
                    }
                    try { fs.unlinkSync(completeMarker); } catch { /* marker may not exist, not critical */ }
                    // #190: Clean up diagnostician report file
                    try {
                        const lateReportPath = path.join(wctx.stateDir, `.diagnostician_report_${task.id}.json`);
                        if (fs.existsSync(lateReportPath)) fs.unlinkSync(lateReportPath);
                    } catch { /* report may not exist, not critical */ }
                    task.resolution = principleCreated ? 'late_marker_principle_created' : 'late_marker_no_principle';
                } else {
                    if (logger) logger.info(`[PD:EvolutionWorker] Task ${task.id} auto-completed after ${timeoutMinutes} minute timeout`);
                    // #190: Clean up diagnostician report file even on timeout (may have been written late)
                    try {
                        const autoTimeoutReportPath = path.join(wctx.stateDir, `.diagnostician_report_${task.id}.json`);
                        if (fs.existsSync(autoTimeoutReportPath)) fs.unlinkSync(autoTimeoutReportPath);
                    } catch { /* report may not exist, not critical */ }
                    task.resolution = 'auto_completed_timeout';
                }

                // Critical: mark task as completed so it doesn't get re-processed
                task.status = 'completed';
                task.completed_at = new Date().toISOString();

                // Log to EvolutionLogger - use task.resolution, not hardcoded value
                evoLogger.logCompleted({
                    traceId: task.traceId || task.id,
                    taskId: task.id,
                    resolution: task.resolution,
                    durationMs: age,
                });

                // Update evolution_tasks table - use task.resolution, not hardcoded value
                wctx.trajectory?.updateEvolutionTask?.(task.id, {
                    status: 'completed',
                    completedAt: task.completed_at,
                    resolution: task.resolution,
                });

                wctx.trajectory?.recordTaskOutcome({
                    sessionId: task.assigned_session_key || 'heartbeat:diagnostician',
                    taskId: task.id,
                    outcome: 'timeout',
                    summary: `Task ${task.id} auto-completed after ${timeoutMinutes} minute timeout.`
                });
                queueChanged = true;
            }
        }

        // V2: Process pain_diagnosis tasks FIRST (quick, inside lock),
        // then sleep_reflection tasks (slow, lock released during execution).
        // This order ensures pain tasks are never starved by long-running
        // nocturnal reflection — sleep_reflection can safely return early
        // because pain_diagnosis has already been handled.
        const pendingTasks = queue.filter(t => t.status === 'pending' && t.taskKind === 'pain_diagnosis');

        if (pendingTasks.length > 0) {
            // V2: Also sort by priority within same score
            const priorityWeight = { high: 3, medium: 2, low: 1 };
            const [highestScoreTask] = pendingTasks.sort((a, b) => {
                const scoreDiff = b.score - a.score;
                if (scoreDiff !== 0) return scoreDiff;
                return (priorityWeight[b.priority] || 2) - (priorityWeight[a.priority] || 2);
            });
            const nowIso = new Date().toISOString();

            const taskDescription = `Diagnose systemic pain [ID: ${highestScoreTask.id}]. Source: ${highestScoreTask.source}. Reason: ${highestScoreTask.reason}. ` +
                  `Trigger text: "${highestScoreTask.trigger_text_preview || 'N/A'}"`;

            // Prepare diagnostician task content
            // FIX (#187): Write diagnostician tasks to .state/diagnostician_tasks.json
            // instead of HEARTBEAT.md. HEARTBEAT.md is a shared file that gets overwritten
            // by the main session heartbeat, causing a race condition where the diagnostician
            // task prompt is lost. The task store is in .state/ which is not modified by
            // the main session.
            const markerFilePath = path.join(wctx.stateDir, `.evolution_complete_${highestScoreTask.id}`);
            const reportFilePath = path.join(wctx.stateDir, `.diagnostician_report_${highestScoreTask.id}.json`);

            let existingPrinciplesRef = '';
            try {
                const activePrinciples = wctx.evolutionReducer.getActivePrinciples();
                if (activePrinciples.length > 0) {
                    // Include all principles up to 20 — enough for duplicate detection
                    // without overwhelming the context window
                    const maxPrinciples = 20;
                    const included = activePrinciples.length > maxPrinciples
                        ? activePrinciples.slice(-maxPrinciples)
                        : activePrinciples;
                    const lines = included.map((p) => {
                        let line = `### ${p.id}: ${p.text}`;
                        if (p.priority && p.priority !== 'P1') line += ` [${p.priority}]`;
                        if (p.scope === 'domain' && p.domain) line += ` (domain: ${p.domain})`;
                        return line;
                    });
                    existingPrinciplesRef = `\n**Existing Principles for Duplicate Detection** (showing ${included.length}/${activePrinciples.length}):\n${lines.join('\n')}`;

                    // Also inject suggested rules from existing principles (if any)
                    const rulesByPrinciple = included.filter((p) => p.suggestedRules?.length);
                    if (rulesByPrinciple.length > 0) {
                        const ruleLines = rulesByPrinciple.flatMap((p) =>
                            (p.suggestedRules ?? []).map((r) => `- [${p.id}] **${r.name}**: ${r.action} (type: ${r.type}, enforce: ${r.enforcement})`),
                        );
                        existingPrinciplesRef += `\n\n**Suggested Rules from Existing Principles**:\n${ruleLines.join('\n')}`;
                    }
                }
            } catch (err) {
                // #184: Log warning instead of silently swallowing — diagnostician needs
                // existing principles context for duplicate detection.
                logger?.warn?.(`[PD:EvolutionWorker] Failed to load active principles for duplicate detection: ${String(err)}`);
            }

            // ── Context Enrichment (CTX-01): Dual-path strategy ──
            // P1: OpenClaw built-in tools (sessions_history) - safe, visibility-limited
            // P2: JSONL direct read - fallback when tools fail or session not visible
            // The diagnostician skill implements both paths (Phase 0 protocol).
            //
            // Here we pre-extract JSONL context as backup and inject tool instructions.

            let contextSection = '';
            if (highestScoreTask.session_id && highestScoreTask.agent_id) {
                try {
                    const { extractRecentConversation, extractFailedToolContext } = await import('../core/pain-context-extractor.js');
                    const conversation = await extractRecentConversation(highestScoreTask.session_id, highestScoreTask.agent_id, 5);
                    
                    if (conversation) {
                        contextSection = `\n## Recent Conversation Context (pre-extracted JSONL fallback)\n\n${conversation}\n`;
                        
                        // Also try to extract failed tool context if this is a tool failure
                        if (highestScoreTask.source === 'tool_failure') {
                            const toolMatch = /Tool ([\w-]+) failed/.exec(highestScoreTask.reason);
                            const fileMatch = /on (.+?)(?=\s*Error:|$)/i.exec(highestScoreTask.reason);
                            if (toolMatch) {
                                const toolContext = await extractFailedToolContext(
                                    highestScoreTask.session_id,
                                    highestScoreTask.agent_id,
                                    toolMatch[1],
                                    fileMatch?.[1]?.trim(),
                                );
                                if (toolContext) {
                                    contextSection += `\n## Failed Tool Call Context\n\n${toolContext}\n`;
                                }
                            }
                        }
                    }
                    if (logger) {
                        const turns = contextSection ? contextSection.split('\n').filter(l => l.startsWith('[User]') || l.startsWith('[Assistant]')).length : 0;
                        logger?.debug?.(`[PD:EvolutionWorker] Pre-extracted ${turns} conversation turns for task ${highestScoreTask.id}`);
                    }
                } catch (e) {
                    if (logger) logger.warn(`[PD:EvolutionWorker] Failed to extract conversation context for task ${highestScoreTask.id}: ${String(e)}. Diagnostician will use P1 tools or fallback.`);
                }
            }

            const heartbeatContent = [
                `## Evolution Task [ID: ${highestScoreTask.id}]`,
                ``,
                `**Pain Score**: ${highestScoreTask.score}`,
                `**Source**: ${highestScoreTask.source}`,
                `**Reason**: ${highestScoreTask.reason}`,
                `**Trigger**: "${highestScoreTask.trigger_text_preview || 'N/A'}"`,
                `**Queued At**: ${highestScoreTask.enqueued_at || nowIso}`,
                `**Session ID**: ${highestScoreTask.session_id || 'N/A'}`,
                `**Agent ID**: ${highestScoreTask.agent_id || 'main'}`,
                ``,
                `## Available Tools for Context Search (P1 - Preferred)`,
                ``,
                `1. **sessions_history** — Get full message history (requires sessionKey)`,
                `2. **sessions_list** — List sessions (searches metadata only, NOT message content)`,
                `3. **read_file / search_file_content** — Search codebase`,
                ``,
                `**P1 SOP**: sessions_history(sessionKey="agent:${highestScoreTask.agent_id || 'main'}:run:${highestScoreTask.session_id || 'N/A'}", limit=30)`,
                highestScoreTask.session_id === 'N/A' || !highestScoreTask.session_id ? `\n\n**⚠️ IMPORTANT**: session_id is N/A — P1 sessions_history tool CANNOT be used. You MUST rely on P2 pre-extracted context below, the pain reason, and your own reasoning. Do NOT hallucinate session details.` : '',
                ``,
                `## Pre-extracted Context (P2 - JSONL Fallback)`,
                `If OpenClaw tools cannot access the session (visibility limits),`,
                `use this pre-extracted context below:`,
                contextSection || `*(No JSONL context available — use P1 tools first)*`,
                ``,
                `---`,
                ``,
                `## Diagnostician Protocol`,
                ``,
                `You MUST use the **pd-diagnostician** skill for this task.`,
                `Read the full skill definition and follow the protocol EXACTLY as specified: Phase 0 (context extraction, optional) → Phase 1 (Evidence) → Phase 2 (Causal Chain) → Phase 3 (Classification) → Phase 4 (Principle Extraction).`,
                `The skill defines the complete output contract — your JSON report MUST match the format specified in the skill.`,
                ``,
                `---`,
                ``,
                `After completing the analysis:`,
                `1. Write your JSON diagnosis report to: ${reportFilePath}`,
                `   The JSON structure MUST match the output format defined in the pd-diagnostician skill.`,
                `2. Mark the task complete by creating a marker file: ${markerFilePath}`,
                `   The marker file should contain: "diagnostic_completed: <timestamp>\\noutcome: <summary>"`,
                `3. After writing both files, reply with "DIAGNOSTICIAN_DONE: ${highestScoreTask.id}"`,
                existingPrinciplesRef,
            ].join('\n');

            // FIX (#187): Write to diagnostician_tasks.json instead of HEARTBEAT.md
            // HEARTBEAT.md is a shared file that gets overwritten by the main session
            // heartbeat, causing a race condition. The task store is in .state/ and is
            // not modified by the main session.
            try {
                await addDiagnosticianTask(wctx.stateDir, highestScoreTask.id, heartbeatContent);
                if (logger) logger.info(`[PD:EvolutionWorker] Wrote diagnostician task to diagnostician_tasks.json for task ${highestScoreTask.id}`);

                // Task store write succeeded, now mark task as in_progress
                highestScoreTask.task = taskDescription;
                highestScoreTask.status = 'in_progress';
                highestScoreTask.started_at = nowIso;
                delete highestScoreTask.completed_at;
                // Use placeholder so marker path can correlate task (no subagent spawned for HEARTBEAT)
                // This fixes task_outcomes being empty for HEARTBEAT-triggered diagnostician runs
                highestScoreTask.assigned_session_key = `heartbeat:diagnostician:${highestScoreTask.id}`;
                queueChanged = true;

                // Log to EvolutionLogger
                evoLogger.logStarted({
                    traceId: highestScoreTask.traceId || highestScoreTask.id,
                    taskId: highestScoreTask.id,
                });

                // Update evolution_tasks table
                wctx.trajectory?.updateEvolutionTask?.(highestScoreTask.id, {
                    status: 'in_progress',
                    startedAt: nowIso,
                });

                if (eventLog) {
                    eventLog.recordEvolutionTask({
                        taskId: highestScoreTask.id,
                        taskType: highestScoreTask.source,
                        reason: highestScoreTask.reason
                    });
                }
            } catch (heartbeatErr) {
                // Diagnostician task store write failed - keep task as pending for next cycle retry
                if (logger) logger.error(`[PD:EvolutionWorker] Failed to write diagnostician task for task ${highestScoreTask.id}: ${String(heartbeatErr)}. Task will remain pending for next cycle.`);
                SystemLogger.log(wctx.workspaceDir, 'DIAGNOSTICIAN_TASK_WRITE_FAILED', `Task ${highestScoreTask.id} diagnostician task write failed: ${String(heartbeatErr)}`);
            }
        }

        // Phase 2.4: Process sleep_reflection tasks AFTER pain_diagnosis.
        // Claim tasks inside the lock, execute reflection outside the lock,
        // then re-acquire the lock to write results. This prevents the long-running
        // nocturnal reflection from blocking all other queue consumers.
        // Safe to return early here because pain_diagnosis was already handled above.

        // FIX: Also poll in_progress tasks that were started in a previous cycle.
        // Previously only 'pending' tasks were filtered, so an in_progress task from
        // a previous heartbeat cycle would never be re-polled until the 1-hour
        // stuck task recovery kicked in.
        const pendingSleepTasks = queue.filter(t => t.status === 'pending' && t.taskKind === 'sleep_reflection');
        const pollingSleepTasks = queue.filter(t =>
            t.status === 'in_progress' && t.taskKind === 'sleep_reflection' && t.resultRef && !t.resultRef.startsWith('trinity-draft')
        );
        let sleepReflectionTasks = [...pendingSleepTasks, ...pollingSleepTasks];
        // Phase 40: Check if sleep_reflection is in cooldown due to persistent failures
        const sleepCooldown = isTaskKindInCooldown(wctx.stateDir, 'sleep_reflection');
        if (sleepCooldown.inCooldown) {
            logger?.info?.(`[PD:EvolutionWorker] sleep_reflection in cooldown (remaining ${Math.round(sleepCooldown.remainingMs / 60000)}min), skipping task processing`);
            sleepReflectionTasks = [];
        }
        if (sleepReflectionTasks.length > 0) {
            // --- Phase 1: Claim only pending tasks (inside lock) ---
            // in_progress tasks from previous cycles are already claimed, don't re-claim them
            for (const sleepTask of pendingSleepTasks) {
                sleepTask.status = 'in_progress';
                sleepTask.started_at = new Date().toISOString();
            }
            queueChanged = queueChanged || pendingSleepTasks.length > 0;

            // Write claimed state (includes any pain changes from above) and release lock
            if (queueChanged) {
                saveEvolutionQueue(queuePath, queue);
            }
            releaseLock();
            // Phase 40: Track outcomes for failure classification after queue write
            const sleepOutcomes: Array<{ taskKind: ClassifiableTaskKind; succeeded: boolean }> = [];
            for (const sleepTask of sleepReflectionTasks) {
                try {
                    // FIX: For in_progress tasks from a previous cycle, just poll the workflow.
                    // Don't start a new workflow — that was already done when the task was first claimed.
                    const isPollingTask = !!sleepTask.resultRef && !sleepTask.resultRef.startsWith('trinity-draft');

                    if (isPollingTask) {
                        logger?.debug?.(`[PD:EvolutionWorker] Polling existing sleep_reflection task ${sleepTask.id} (workflowId: ${sleepTask.resultRef})`);
                    } else {
                        logger?.info?.(`[PD:EvolutionWorker] Processing sleep_reflection task ${sleepTask.id}`);
                    }

                     
                    let workflowId: string | undefined;
                     
                     
                    let nocturnalManager: NocturnalWorkflowManager;
                     
                     
                    let snapshotData: NocturnalSessionSnapshot | undefined;

                    if (isPollingTask) {
                         
                        workflowId = sleepTask.resultRef!;
                    } else {
                        // Phase 1: Build trajectory snapshot for Nocturnal pipeline
                        // Priority: Pain signal sessionId → Task ID → Recent session with violations
                        let extractor: ReturnType<typeof createNocturnalTrajectoryExtractor> | null = null;
                        try {
                            extractor = createNocturnalTrajectoryExtractor(wctx.workspaceDir);

                            // 1. Try exact session ID from pain signal (most accurate)
                            const painSessionId = sleepTask.recentPainContext?.mostRecent?.sessionId;
                            let fullSnapshot = painSessionId ? extractor.getNocturnalSessionSnapshot(painSessionId) : undefined;
                            if (fullSnapshot) {
                                logger?.info?.(`[PD:EvolutionWorker] Task ${sleepTask.id} using exact session from pain signal: ${painSessionId}`);
                            }

                            // 2. Try task ID (legacy compatibility, rarely matches)
                            if (!fullSnapshot) {
                                fullSnapshot = extractor.getNocturnalSessionSnapshot(sleepTask.id);
                            }

                            // 3. If no match, find most recent session WITH violation signals
                            if (!fullSnapshot) {
                                const taskTimeMs = new Date(sleepTask.enqueued_at || sleepTask.timestamp).getTime();
                                const recentSessions = extractor.listRecentNocturnalCandidateSessions({
                                    limit: 20,
                                    minToolCalls: 1,
                                    dateTo: sleepTask.enqueued_at || sleepTask.timestamp,
                                }).filter((session) => isSessionAtOrBeforeTriggerTime(session, taskTimeMs));
                                // Filter to sessions with actual violations (pain, failures, or gate blocks)
                                const sessionsWithViolations = recentSessions.filter(
                                    s => s.failureCount > 0 || s.painEventCount > 0 || s.gateBlockCount > 0
                                );
                                if (sessionsWithViolations.length > 0) {
                                     
                                    const targetSession = sessionsWithViolations[0];
                                    logger?.info?.(`[PD:EvolutionWorker] Task ${sleepTask.id} using session with violations: ${targetSession.sessionId} (failed=${targetSession.failureCount}, pain=${targetSession.painEventCount}, gates=${targetSession.gateBlockCount})`);
                                    fullSnapshot = extractor.getNocturnalSessionSnapshot(targetSession.sessionId);
                                } else if (recentSessions.length > 0) {
                                    // No sessions with violations, use most recent as last resort
                                     
                                    const latestSession = recentSessions[0];
                                    logger?.warn?.(`[PD:EvolutionWorker] Task ${sleepTask.id} no sessions with violations found, using most recent: ${latestSession.sessionId} (failed=${latestSession.failureCount}, pain=${latestSession.painEventCount}, gates=${latestSession.gateBlockCount})`);
                                    fullSnapshot = extractor.getNocturnalSessionSnapshot(latestSession.sessionId);
                                } else {
                                    logger?.warn?.(`[PD:EvolutionWorker] Task ${sleepTask.id} no sessions with tool calls in trajectory DB`);
                                }
                            }

                            if (fullSnapshot) {
                                snapshotData = fullSnapshot;
                            }
                        } catch (snapErr) {
                            logger?.warn?.(`[PD:EvolutionWorker] Failed to build trajectory snapshot for ${sleepTask.id}: ${String(snapErr)}`);
                        }

                        // Phase 2: If no trajectory data, try pain-context fallback
                        if (!snapshotData && sleepTask.recentPainContext) {
                            logger?.warn?.(`[PD:EvolutionWorker] Using pain-context fallback for ${sleepTask.id}: trajectory snapshot unavailable, will try session summary from extractor`);
                            snapshotData = buildFallbackNocturnalSnapshot(sleepTask, extractor, logger) ?? undefined;
                        }

                        const snapshotValidation = validateNocturnalSnapshotIngress(snapshotData);
                        if (snapshotValidation.status !== 'valid') {
                            sleepTask.status = 'failed';
                            sleepTask.completed_at = new Date().toISOString();
                            sleepTask.resolution = 'failed_max_retries';
                            sleepOutcomes.push({ taskKind: 'sleep_reflection', succeeded: false });
                            sleepTask.lastError = `sleep_reflection failed: invalid_snapshot_ingress (${snapshotValidation.reasons.join('; ') || 'missing snapshot'})`;
                            sleepTask.retryCount = (sleepTask.retryCount ?? 0) + 1;
                            logger?.warn?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} rejected: ${sleepTask.lastError}`);
                            continue;
                        }

                        snapshotData = snapshotValidation.snapshot;
                    }

                    if (!api) {
                        sleepTask.status = 'failed';
                        sleepTask.completed_at = new Date().toISOString();
                        sleepTask.resolution = 'failed_max_retries';
                        sleepTask.lastError = 'No API available to create NocturnalWorkflowManager';
                        sleepTask.retryCount = (sleepTask.retryCount ?? 0) + 1;
                        sleepOutcomes.push({ taskKind: 'sleep_reflection', succeeded: false });
                        logger?.warn?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} skipped: no API`);
                        continue;
                    }

                    nocturnalManager = new NocturnalWorkflowManager({
                        workspaceDir: wctx.workspaceDir,
                        stateDir: wctx.stateDir,
                        logger: api.logger,
                        runtimeAdapter: new OpenClawTrinityRuntimeAdapter(api),
                        subagent: api.runtime.subagent,
                    });

                    if (!isPollingTask) {
                        const workflowHandle = await nocturnalManager.startWorkflow(nocturnalWorkflowSpec, {
                            parentSessionId: `sleep_reflection:${sleepTask.id}`,
                            workspaceDir: wctx.workspaceDir,
                            taskInput: {},
                            metadata: {
                                snapshot: snapshotData,
                                taskId: sleepTask.id,
                                painContext: sleepTask.recentPainContext,
                                triggerSource: sleepTask.source,
                                // #297: Configure which preflight gates to skip.
                                // sleep_reflection uses periodic trigger which bypasses idle by design.
                                skipPreflightGates: ['idle'],
                            },
                        });
                        sleepTask.resultRef = workflowHandle.workflowId;
                         
                        workflowId = workflowHandle.workflowId;
                    }

                    if (!workflowId) {
                        sleepTask.status = 'failed';
                        sleepTask.completed_at = new Date().toISOString();
                        sleepTask.resolution = 'failed_max_retries';
                        sleepTask.lastError = 'sleep_reflection failed: missing_workflow_id';
                        sleepTask.retryCount = (sleepTask.retryCount ?? 0) + 1;
                        sleepOutcomes.push({ taskKind: 'sleep_reflection', succeeded: false });
                        logger?.warn?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} missing workflow id after startup`);
                        continue;
                    }

                    // Workflow is running asynchronously. Check if it completed in this cycle
                    // by polling getWorkflowDebugSummary.
                    const summary = await nocturnalManager.getWorkflowDebugSummary(workflowId);
                    if (summary) {
                        if (summary.state === 'completed') {
                            sleepTask.status = 'completed';
                            sleepTask.completed_at = new Date().toISOString();
                            sleepTask.resolution = 'marker_detected';
                            sleepTask.resultRef = summary.metadata?.nocturnalResult ? 'trinity-draft' : workflowId;
                            sleepOutcomes.push({ taskKind: 'sleep_reflection', succeeded: true });
                            logger?.info?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} workflow completed`);
                        } else if (summary.state === 'terminal_error') {
                            // #208/#209: Classify terminal_error reason before hardcoding to failed.
                            // The async executeNocturnalReflectionAsync catches subagent errors and
                            // records them as terminal_error. Without this check, expected errors
                            // (daemon mode, process isolation) would always become failed_max_retries.
                            const lastEvent = summary.recentEvents[summary.recentEvents.length - 1];
                            const errorReason = lastEvent?.reason ?? 'unknown';
                            // #219: Include payload details for better diagnostics
                            let detailedError = `Workflow terminal_error: ${errorReason}`;
                             
                            let payload: unknown = {};
                             
                            try {
                                payload = lastEvent?.payload ?? {};
                                 
                                if ((payload as any).skipReason) {
                                     
                                    detailedError += ` (skipReason: ${(payload as any).skipReason})`;
                                 
                                }
                                 
                                if ((payload as any).failures && Array.isArray((payload as any).failures) && (payload as any).failures.length > 0) {
                                     
                                    detailedError += ` | failures: ${((payload as any).failures as string[]).slice(0, 3).join(', ')}`;
                                }
                            } catch { /* ignore parse errors */ }
                            sleepTask.lastError = detailedError;
                            sleepTask.retryCount = (sleepTask.retryCount ?? 0) + 1;

                            if (isExpectedSubagentError(errorReason)) {
                                // #237: Expected unavailability → stub fallback, not hard failure
                                sleepTask.status = 'completed';

                                sleepTask.completed_at = new Date().toISOString();
                                sleepTask.resolution = 'stub_fallback';
                                sleepOutcomes.push({ taskKind: 'sleep_reflection', succeeded: true });

                                logger?.warn?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} background runtime unavailable, using stub fallback: ${errorReason}`);
                             
                            } else if ((payload as any).skipReason === 'no_violating_sessions') {
                                // #244: No meaningful violations found (thin filter) → skip without failure
                                sleepTask.status = 'completed';
                                sleepTask.completed_at = new Date().toISOString();
                                sleepTask.resolution = 'skipped_thin_violation';
                                sleepOutcomes.push({ taskKind: 'sleep_reflection', succeeded: true });
                                logger?.info?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} completed: no sessions with meaningful violations found`);
                            } else {
                                sleepTask.status = 'failed';
                                sleepTask.completed_at = new Date().toISOString();
                                sleepTask.resolution = 'failed_max_retries';
                                sleepOutcomes.push({ taskKind: 'sleep_reflection', succeeded: false });
                                logger?.warn?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} workflow failed: ${sleepTask.lastError}`);
                            }
                        } else {
                            // Workflow still active, keep task in_progress for next cycle
                            logger?.info?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} workflow ${summary.state}, will poll again next cycle`);
                        }
                    }
                } catch (taskErr) {
                    // #202: Handle expected subagent unavailability (e.g., process isolation in daemon mode)
                    // When subagent is unavailable due to gateway running in separate process,
                    // use stub fallback instead of failing the task.
                    sleepTask.completed_at = new Date().toISOString();
                    sleepTask.lastError = String(taskErr);
                    sleepTask.retryCount = (sleepTask.retryCount ?? 0) + 1;

                    if (isExpectedSubagentError(taskErr)) {
                        // #237: Expected unavailability → stub fallback, not hard failure
                        sleepTask.status = 'completed';
                        sleepTask.completed_at = new Date().toISOString();
                        sleepTask.resolution = 'stub_fallback';
                        sleepOutcomes.push({ taskKind: 'sleep_reflection', succeeded: true });
                        logger?.warn?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} background runtime unavailable, using stub fallback: ${String(taskErr)}`);
                    } else {
                        sleepTask.status = 'failed';
                        sleepTask.completed_at = new Date().toISOString();
                        sleepTask.resolution = 'failed_max_retries';
                        sleepOutcomes.push({ taskKind: 'sleep_reflection', succeeded: false });
                        logger?.error?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} threw: ${taskErr}`);
                    }
                }
            }

            // --- Phase 3: Write results back (re-acquire lock) ---
            try {
                const resultLock = await requireQueueLock(queuePath, logger, 'sleepReflectionResult');
                try {
                    // Re-read queue to merge with any changes made while lock was released
                    let freshQueue: (RawQueueItem | EvolutionQueueItem)[] = [];
                    try {
                        freshQueue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
                    } catch { /* empty queue if corrupted */ }

                    // Merge: update tasks by ID
                    for (const sleepTask of sleepReflectionTasks) {
                        const idx = freshQueue.findIndex((t) => (t as { id?: string }).id === sleepTask.id);
                        if (idx >= 0) {
                            freshQueue[idx] = sleepTask;
                        }
                    }
                    atomicWriteFileSync(queuePath, JSON.stringify(freshQueue, null, 2));

                    // Log completions to EvolutionLogger
                    for (const sleepTask of sleepReflectionTasks) {
                        if (sleepTask.status === 'completed' || sleepTask.status === 'failed') {
                            evoLogger.logCompleted({
                                traceId: sleepTask.traceId || sleepTask.id,
                                taskId: sleepTask.id,
                                resolution: sleepTask.status === 'completed'
                                    ? (sleepTask.resolution === 'marker_detected' ? 'marker_detected' : 'manual')
                                    : 'manual',
                                durationMs: sleepTask.started_at
                                    ? Date.now() - new Date(sleepTask.started_at).getTime()
                                    : undefined,
                            });
                        }
                    }
                } finally {
                    resultLock();
                }
            } catch (resultLockErr) {
                // If we can't re-acquire lock, results are in memory but not persisted.
                // Tasks will appear stuck as in_progress and will be retried on next cycle.
                logger?.warn?.(`[PD:EvolutionWorker] Failed to write sleep_reflection results back: ${String(resultLockErr)}`);
            }

            // Phase 40: Process failure classification — evaluate once per taskKind,
            // not per-outcome, to prevent tier escalation from firing N times for N failures.
            try {
                const hadAnySuccess = sleepOutcomes.some(o => o.succeeded);
                const hadAnyFailure = sleepOutcomes.some(o => !o.succeeded);
                if (hadAnySuccess) {
                    await resetFailureState(wctx.stateDir, 'sleep_reflection');
                }
                if (hadAnyFailure) {
                    const config = loadCooldownEscalationConfig(wctx.stateDir);
                    const result = classifyFailure(queue, 'sleep_reflection', config.consecutive_threshold);
                    if (result.classification === 'persistent') {
                        await recordPersistentFailure(wctx.stateDir, 'sleep_reflection', config, result.consecutiveFailures);
                        logger?.warn?.(`[PD:EvolutionWorker] sleep_reflection persistent failure (${result.consecutiveFailures} consecutive), escalating cooldown`);
                    }
                }
            } catch { /* classification errors are non-blocking */ }

            // Safe to return — pain_diagnosis was already processed above.
            // keyword_optimization tasks are deferred to the next heartbeat cycle.
            // Running both in the same cycle causes stale queue overwrite and
            // double lock release (lock was released at line ~1703).
            lockReleased = true;
            return;
        }

        // ── keyword_optimization task processing ──────────────────────────────
        // Process keyword_optimization tasks independently of sleep_reflection.
        // Uses CorrectionObserverWorkflowManager to dispatch LLM subagent and
        // KeywordOptimizationService to apply mutations to keyword store (CORR-09).
        const pendingKeywordOptTasks = queue.filter(t => t.status === 'pending' && t.taskKind === 'keyword_optimization');
        const inProgressKeywordOptTasks = queue.filter(t =>
            t.status === 'in_progress' &&
            t.taskKind === 'keyword_optimization' &&
            t.resultRef &&
            !t.resultRef.startsWith('trinity-draft')
        );
        const keywordOptTasks = [...pendingKeywordOptTasks, ...inProgressKeywordOptTasks];
        // Phase 40: Check if keyword_optimization is in cooldown due to persistent failures
        const kwOptCooldown = isTaskKindInCooldown(wctx.stateDir, 'keyword_optimization');
        if (kwOptCooldown.inCooldown) {
            logger?.info?.(`[PD:EvolutionWorker] keyword_optimization in cooldown (remaining ${Math.round(kwOptCooldown.remainingMs / 60000)}min), skipping task processing`);
            if (keywordOptTasks.length > 0) {
                // Skip all keyword_optimization tasks this cycle; release lock and return
                if (queueChanged) {
                    saveEvolutionQueue(queuePath, queue);
                }
                releaseLock();
                lockReleased = true;
                return;
            }
        }
        if (keywordOptTasks.length > 0) {
            // Claim pending tasks inside lock
            for (const koTask of pendingKeywordOptTasks) {
                koTask.status = 'in_progress';
                koTask.started_at = new Date().toISOString();
            }
            queueChanged = queueChanged || pendingKeywordOptTasks.length > 0;

            // Release lock during LLM dispatch (long-running)
            saveEvolutionQueue(queuePath, queue);
            releaseLock();
            lockReleased = true;

            // Phase 40: Track outcomes for failure classification after queue write
            const kwOptOutcomes: Array<{ taskKind: ClassifiableTaskKind; succeeded: boolean }> = [];
            for (const koTask of keywordOptTasks) {
                const isPolling = !!koTask.resultRef && !koTask.resultRef.startsWith('trinity-draft');

                if (isPolling) {
                    logger?.debug?.(`[PD:EvolutionWorker] Polling existing keyword_optimization task ${koTask.id}`);
                } else {
                    logger?.info?.(`[PD:EvolutionWorker] Processing keyword_optimization task ${koTask.id}`);
                }

                try {
                    // Build trajectoryHistory via KeywordOptimizationService
                    const koService = KeywordOptimizationService.get(wctx.stateDir, wctx.workspaceDir, logger);
                    const db = TrajectoryRegistry.get(wctx.workspaceDir);
                    const recentSessionIds = db.listRecentSessions({ limit: 10 }).map(s => s.sessionId);
                    const trajectoryHistory = await koService.buildTrajectoryHistory(recentSessionIds);

                    // Build full payload (CORR-09, D-40-07, D-40-08)
                    const learner = CorrectionCueLearner.get(wctx.stateDir);
                    const store = learner.getStore();
                    const payload: CorrectionObserverPayload = {
                        workspaceDir: wctx.workspaceDir,
                        parentSessionId: `keyword_optimization:${koTask.id}`,
                        keywordStoreSummary: {
                            totalKeywords: store.keywords.length,
                            terms: store.keywords.map(k => ({
                                term: k.term,
                                weight: k.weight,
                                hitCount: k.hitCount ?? 0,
                                truePositiveCount: k.truePositiveCount ?? 0,
                                falsePositiveCount: k.falsePositiveCount ?? 0,
                            })),
                        },
                        recentMessages: [],
                        trajectoryHistory,
                    };

                    // Dispatch LLM subagent via CorrectionObserverWorkflowManager
                    const manager = new CorrectionObserverWorkflowManager({
                        workspaceDir: wctx.workspaceDir,
                        logger,
                        subagent: api?.runtime?.subagent!,  
                        agentSession: api?.runtime?.agent?.session,
                    });

                    let workflowId: string | undefined;
                    if (!isPolling) {
                        const handle = await manager.startWorkflow(correctionObserverWorkflowSpec, {
                            parentSessionId: `keyword_optimization:${koTask.id}`,
                            workspaceDir: wctx.workspaceDir,
                            taskInput: payload,
                        });
                        workflowId = handle.workflowId;
                        koTask.resultRef = workflowId;
                    } else {
                        workflowId = koTask.resultRef!;  
                    }

                    // Poll workflow state
                    const summary = await manager.getWorkflowDebugSummary(workflowId);
                    if (summary) {
                        if (summary.state === 'completed') {
                            // Get parsed LLM result and apply mutations to keyword store (CORR-09)
                            const parsedResult = await manager.getWorkflowResult(workflowId);

                            if (parsedResult?.updated) {
                                koService.applyResult(parsedResult);
                                learner.recordOptimizationPerformed();
                                logger?.info?.(`[PD:EvolutionWorker] keyword_optimization applied mutations: ${parsedResult.summary}`);
                            } else {
                                logger?.info?.(`[PD:EvolutionWorker] keyword_optimization completed with no updates`);
                            }

                            koTask.status = 'completed';
                            koTask.completed_at = new Date().toISOString();
                            koTask.resolution = 'marker_detected';
                            kwOptOutcomes.push({ taskKind: 'keyword_optimization', succeeded: true });
                            // CORR-08: Record throttle quota (max 4/day)
                            recordCooldown(wctx.stateDir).catch(err =>
                                logger?.warn?.(`[PD:EvolutionWorker] recordCooldown failed (non-blocking): ${String(err)}`)
                            );
                            logger?.info?.(`[PD:EvolutionWorker] keyword_optimization task ${koTask.id} workflow completed`);
                        } else if (summary.state === 'terminal_error') {
                            koTask.status = 'failed';
                            koTask.completed_at = new Date().toISOString();
                            koTask.resolution = 'failed_max_retries';
                            kwOptOutcomes.push({ taskKind: 'keyword_optimization', succeeded: false });
                            koTask.retryCount = (koTask.retryCount ?? 0) + 1;
                            const lastEvent = summary.recentEvents[summary.recentEvents.length - 1];
                            koTask.lastError = `keyword_optimization failed: ${lastEvent?.reason ?? 'unknown'}`;
                            logger?.warn?.(`[PD:EvolutionWorker] keyword_optimization task ${koTask.id} workflow terminal_error: ${koTask.lastError}`);
                        } else {
                            logger?.info?.(`[PD:EvolutionWorker] keyword_optimization task ${koTask.id} workflow ${summary.state}, will poll again next cycle`);
                        }
                    }
                } catch (koErr) {
                    koTask.status = 'failed';
                    koTask.completed_at = new Date().toISOString();
                    koTask.resolution = 'failed_max_retries';
                    kwOptOutcomes.push({ taskKind: 'keyword_optimization', succeeded: false });
                    koTask.lastError = String(koErr);
                    koTask.retryCount = (koTask.retryCount ?? 0) + 1;
                    logger?.error?.(`[PD:EvolutionWorker] keyword_optimization task ${koTask.id} threw: ${koErr}`);
                }
            }

            // Re-acquire lock to write results
            const koResultLock = await requireQueueLock(queuePath, logger, 'keywordOptResult');
            try {
                let freshQueue: (RawQueueItem | EvolutionQueueItem)[] = [];
                try {
                    freshQueue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
                } catch (readErr) {
                    // Queue file corrupted — log warning but preserve in-memory task state
                    logger?.warn?.(`[PD:EvolutionWorker] Queue file corrupted (${String(readErr)}), preserving in-memory state`);
                    freshQueue = [];
                }

                // Append or replace keyword_optimization tasks
                for (const koTask of keywordOptTasks) {
                    const idx = freshQueue.findIndex((t) => (t as { id?: string }).id === koTask.id);
                    if (idx >= 0) {
                        freshQueue[idx] = koTask;
                    } else {
                        freshQueue.push(koTask);
                    }
                }
                atomicWriteFileSync(queuePath, JSON.stringify(freshQueue, null, 2));
            } catch (koResultErr) {
                logger?.warn?.(`[PD:EvolutionWorker] Failed to write keyword_optimization results: ${String(koResultErr)}`);
            } finally {
                koResultLock();
            }

            // Phase 40: Process failure classification — evaluate once per taskKind
            try {
                const hadAnySuccess = kwOptOutcomes.some(o => o.succeeded);
                const hadAnyFailure = kwOptOutcomes.some(o => !o.succeeded);
                if (hadAnySuccess) {
                    await resetFailureState(wctx.stateDir, 'keyword_optimization');
                }
                if (hadAnyFailure) {
                    const config = loadCooldownEscalationConfig(wctx.stateDir);
                    const freshQueue = JSON.parse(fs.readFileSync(queuePath, 'utf8')) as EvolutionQueueItem[];
                    const result = classifyFailure(freshQueue, 'keyword_optimization', config.consecutive_threshold);
                    if (result.classification === 'persistent') {
                        await recordPersistentFailure(wctx.stateDir, 'keyword_optimization', config, result.consecutiveFailures);
                        logger?.warn?.(`[PD:EvolutionWorker] keyword_optimization persistent failure (${result.consecutiveFailures} consecutive), escalating cooldown`);
                    }
                }
            } catch { /* classification errors are non-blocking */ }

            return;
        }

        if (queueChanged) {
            saveEvolutionQueue(queuePath, queue);
        }

        // Pipeline observability: log stage-level summary at end of cycle
        const pendingPain = queue.filter((t) => t.status === 'pending' && t.taskKind === 'pain_diagnosis').length;
        const inProgressPain = queue.filter((t) => t.status === 'in_progress' && t.taskKind === 'pain_diagnosis').length;
        if (inProgressPain > 0) {
            const stuck = queue
                .filter((t) => t.status === 'in_progress' && t.taskKind === 'pain_diagnosis')
                .map((t) => `${t.id} (since ${t.started_at || 'unknown'})`);
            logger?.info?.(`[PD:EvolutionWorker] Pipeline: ${inProgressPain} pain_diagnosis task(s) in_progress — awaiting agent response: ${stuck.join(', ')}`);
        }
        if (pendingPain > 0) {
            logger?.info?.(`[PD:EvolutionWorker] Pipeline: ${pendingPain} pain_diagnosis task(s) pending — HEARTBEAT.md will trigger next cycle`);
        }
        const painCompleted = queue.filter((t) => t.status === 'completed' && t.taskKind === 'pain_diagnosis').length;
        logger?.info?.(`[PD:EvolutionWorker] Pipeline summary: pain_completed=${painCompleted} pain_pending=${pendingPain} pain_in_progress=${inProgressPain}`);
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
                if (kwOptConfig.enabled && heartbeatCounter > 0 && heartbeatCounter % kwOptConfig.period_heartbeats === 0) {
                    logger?.info?.(`[PD:EvolutionWorker] keyword_optimization trigger at heartbeat ${heartbeatCounter} (trigger_mode=${sleepConfig.trigger_mode})`);
                    enqueueKeywordOptimizationTask(wctx, logger).catch((err) => {
                        logger?.error?.(`[PD:EvolutionWorker] Failed to enqueue keyword_optimization task: ${String(err)}`);
                    });
                }

                // Path 2: Periodic trigger for sleep_reflection (fires regardless of idle state)
                if (sleepConfig.trigger_mode === 'periodic') {
                    if (heartbeatCounter >= sleepConfig.period_heartbeats) {
                        logger?.info?.(`[PD:EvolutionWorker] Periodic trigger: heartbeatCounter=${heartbeatCounter} >= period_heartbeats=${sleepConfig.period_heartbeats}`);
                        shouldTrySleepReflection = true;
                        heartbeatCounter = 0; // Reset counter
                    } else {
                        logger?.info?.(`[PD:EvolutionWorker] Periodic: ${heartbeatCounter}/${sleepConfig.period_heartbeats} heartbeats — waiting`);
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

                const painCheckResult = await checkPainFlag(wctx, logger);
                cycleResult.pain_flag = painCheckResult;

                const queueResult = await processEvolutionQueueWithResult(wctx, logger, eventLog, api ?? undefined);
                cycleResult.queue = queueResult.queue;
                if (queueResult.errors) cycleResult.errors.push(...queueResult.errors);

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
                                subagent: api.runtime.subagent,
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
            timeoutId.unref();
        }

        timeoutId = setTimeout(() => {
            void (async () => {
                // Phase 41: Startup reconciliation — validate state, clear stale cooldowns, clean orphans
                try {
                    const reconResult = await reconcileStartup(wctx.stateDir);
                    if (reconResult.cooldownsCleared > 0 || reconResult.orphansRemoved.length > 0 || reconResult.stateReset) {
                        logger?.info?.(`[PD:EvolutionWorker] Startup reconciliation: ${reconResult.cooldownsCleared} stale cooldowns cleared, ${reconResult.orphansRemoved.length} orphan files removed, stateReset=${reconResult.stateReset}`);
                    } else {
                        logger?.debug?.('[PD:EvolutionWorker] Startup reconciliation: clean state, no action needed');
                    }
                } catch (reconErr) {
                    logger?.warn?.(`[PD:EvolutionWorker] Startup reconciliation failed (non-blocking): ${String(reconErr)}`);
                }

                await checkPainFlag(wctx, logger);
                // Use the same pipeline as regular cycles (includes purge + observability)
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
