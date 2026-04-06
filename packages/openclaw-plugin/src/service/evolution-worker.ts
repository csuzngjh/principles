import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { OpenClawPluginServiceContext, OpenClawPluginApi, PluginLogger } from '../openclaw-sdk.js';
import { DictionaryService } from '../core/dictionary-service.js';
import { DetectionService } from '../core/detection-service.js';
import { ensureStateTemplates } from '../core/init.js';
import { extractCommonSubstring } from '../utils/nlp.js';
import { SystemLogger } from '../core/system-logger.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { EventLog } from '../core/event-log.js';
import { initPersistence, flushAllSessions } from '../core/session-tracker.js';
import { acquireLockAsync, releaseLock, type LockContext } from '../utils/file-lock.js';
import { getEvolutionLogger, type EvolutionStage } from '../core/evolution-logger.js';
import type { TaskKind, TaskPriority } from '../core/trajectory-types.js';
export type { TaskKind, TaskPriority } from '../core/trajectory-types.js';
import { LockUnavailableError } from '../config/index.js';
import { checkWorkspaceIdle, checkCooldown } from './nocturnal-runtime.js';
import { WorkflowStore } from './subagent-workflow/workflow-store.js';
import { EmpathyObserverWorkflowManager } from './subagent-workflow/empathy-observer-workflow-manager.js';
import { DeepReflectWorkflowManager } from './subagent-workflow/deep-reflect-workflow-manager.js';
import { NocturnalWorkflowManager, nocturnalWorkflowSpec } from './subagent-workflow/nocturnal-workflow-manager.js';

const WORKFLOW_TTL_MS = 5 * 60 * 1000; // 5 minutes default TTL for helper workflows
import { OpenClawTrinityRuntimeAdapter } from '../core/nocturnal-trinity.js';

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
export type TaskResolution = 'marker_detected' | 'auto_completed_timeout' | 'failed_max_retries' | 'canceled' | 'late_marker_principle_created' | 'late_marker_no_principle';

/**
 * Recent pain context attached to sleep_reflection tasks.
 * Carries explicit recent pain signal metadata without being a separate task kind.
 * Used by NocturnalTargetSelector for ranking bias and context enrichment.
 */
export interface RecentPainContext {
  /** Most recent unresolved pain event */
  mostRecent: {
    score: number;
    source: string;
    reason: string;
    timestamp: string;
  } | null;
  /** Count of pain events in the recent window (for signal strength) */
  recentPainCount: number;
  /** Highest pain score in the recent window */
  recentMaxPainScore: number;
}

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
}

/**
 * Legacy queue item shape (pre-V2) for migration compatibility.
 * These items lack taskKind, priority, retryCount, maxRetries, lastError fields.
 */
interface LegacyEvolutionQueueItem {
    id: string;
    task?: string;
    score: number;
    source: string;
    reason: string;
    timestamp: string;
    enqueued_at?: string;
    started_at?: string;
    completed_at?: string;
    assigned_session_key?: string;
    trigger_text_preview?: string;
    status?: string;
    resolution?: string;
    session_id?: string;
    agent_id?: string;
    traceId?: string;
    taskKind?: string;
    priority?: string;
    retryCount?: number;
    maxRetries?: number;
    lastError?: string;
    resultRef?: string;
}

interface PainCandidateEntry {
    count: number;
    status: string;
    firstSeen: string;
    lastSeen: string;
    samples: string[];
}

/**
 * Default values for new V2 fields when migrating legacy items.
 */
const DEFAULT_TASK_KIND: TaskKind = 'pain_diagnosis';
const DEFAULT_PRIORITY: TaskPriority = 'medium';
const DEFAULT_MAX_RETRIES = 3;

/**
 * Migrate a legacy queue item to V2 schema.
 * Old items without taskKind are assumed to be pain_diagnosis for backward compatibility.
 */
function migrateToV2(item: LegacyEvolutionQueueItem): EvolutionQueueItem {
    return {
        id: item.id,
        taskKind: (item.taskKind as TaskKind) || DEFAULT_TASK_KIND,
        priority: (item.priority as TaskPriority) || DEFAULT_PRIORITY,
        source: item.source,
        traceId: item.traceId,
        task: item.task,
        score: item.score,
        reason: item.reason,
        timestamp: item.timestamp,
        enqueued_at: item.enqueued_at,
        started_at: item.started_at,
        completed_at: item.completed_at,
        assigned_session_key: item.assigned_session_key,
        trigger_text_preview: item.trigger_text_preview,
        status: (item.status as QueueStatus) || 'pending',
        resolution: item.resolution as TaskResolution | undefined,
        session_id: item.session_id,
        agent_id: item.agent_id,
        retryCount: item.retryCount || 0,
        maxRetries: item.maxRetries || DEFAULT_MAX_RETRIES,
        lastError: item.lastError,
        resultRef: item.resultRef,
    };
}

type RawQueueItem = Record<string, unknown>;

/**
 * Check if an item is a legacy (pre-V2) queue item.
 */
function isLegacyQueueItem(item: RawQueueItem): boolean {
    return item && typeof item === 'object' && !('taskKind' in item);
}

/**
 * Migrate entire queue to V2 schema if needed.
 * Returns a new array with all items migrated to V2 format.
 */
function migrateQueueToV2(queue: RawQueueItem[]): EvolutionQueueItem[] {
    return queue.map(item => isLegacyQueueItem(item) ? migrateToV2(item as unknown as LegacyEvolutionQueueItem) : item as unknown as EvolutionQueueItem);
}

const PAIN_QUEUE_DEDUP_WINDOW_MS = 30 * 60 * 1000;

// P0 fix: File lock constants and helper for queue operations (prevents TOCTOU race)
export const EVOLUTION_QUEUE_LOCK_SUFFIX = '.lock';
export const PAIN_CANDIDATES_LOCK_SUFFIX = '.candidates.lock';
export const LOCK_MAX_RETRIES = 50;
export const LOCK_RETRY_DELAY_MS = 50;
export const LOCK_STALE_MS = 30_000;
const PAIN_CANDIDATE_MAX_SAMPLES = 5;
const PAIN_CANDIDATE_SAMPLE_LEN = 1000;
const PAIN_CANDIDATE_FINGERPRINT_HEAD_LEN = 160;
const PAIN_CANDIDATE_FINGERPRINT_TAIL_LEN = 80;

export function createEvolutionTaskId(
    source: string,
    score: number,
    preview: string,
    reason: string,
    now: number
): string {
    // Keep ids short for prompt injection, but include enough entropy to avoid
    // collisions between different pain events that share the same source/score/preview.
    return createHash('md5')
        .update(`${source}:${score}:${preview}:${reason}:${now}`)
        .digest('hex')
        .substring(0, 8);
}

function normalizePainCandidateText(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

export function shouldTrackPainCandidate(text: string): boolean {
    const normalized = normalizePainCandidateText(text);
    if (!normalized) return false;
    if (normalized === 'NO_REPLY') return false;

    // Skip empathy observer payloads: they are classifier telemetry, not user/system pain patterns.
    if (
        normalized.startsWith('{')
        && normalized.endsWith('}')
        && normalized.includes('"damageDetected"')
        && normalized.includes('"severity"')
        && normalized.includes('"confidence"')
    ) {
        return false;
    }

    return true;
}

export function createPainCandidateFingerprint(text: string): string {
    const normalized = normalizePainCandidateText(text);
    const head = normalized.substring(0, PAIN_CANDIDATE_FINGERPRINT_HEAD_LEN);
    const tail = normalized.slice(-PAIN_CANDIDATE_FINGERPRINT_TAIL_LEN);

    return createHash('md5')
        .update(`${normalized.length}:${head}:${tail}`)
        .digest('hex')
        .substring(0, 8);
}

export function summarizePainCandidateSample(text: string): string {
    return normalizePainCandidateText(text).substring(0, PAIN_CANDIDATE_SAMPLE_LEN);
}

function isPendingPainCandidate(status: string | undefined): boolean {
    return status === undefined || status === 'pending';
}

export async function acquireQueueLock(resourcePath: string, logger: PluginLogger | { warn?: (message: string) => void; info?: (message: string) => void } | undefined, lockSuffix: string = EVOLUTION_QUEUE_LOCK_SUFFIX): Promise<() => void> {
    try {
        const ctx: LockContext = await acquireLockAsync(resourcePath, {
            lockSuffix,
            maxRetries: LOCK_MAX_RETRIES,
            baseRetryDelayMs: LOCK_RETRY_DELAY_MS,
            lockStaleMs: LOCK_STALE_MS,
        });
        return () => releaseLock(ctx);
    } catch (error: unknown) {
        const warn = logger?.warn;
        warn?.(`[PD:EvolutionWorker] Failed to acquire lock for ${resourcePath}: ${String(error)}`);
        throw error;
    }
}

async function requireQueueLock(resourcePath: string, logger: PluginLogger | { warn?: (message: string) => void; info?: (message: string) => void } | undefined, scope: string, lockSuffix: string = EVOLUTION_QUEUE_LOCK_SUFFIX): Promise<() => void> {
    try {
        return await acquireQueueLock(resourcePath, logger, lockSuffix);
    } catch (err) {
        throw new LockUnavailableError(resourcePath, scope, { cause: err });
    }
}

export function extractEvolutionTaskId(task: string): string | null {
    if (!task) return null;
    const match = task.match(/\[ID:\s*([A-Za-z0-9_-]+)\]/);
    return match?.[1] || null;
}

function findRecentDuplicateTask(
    queue: EvolutionQueueItem[],
    source: string,
    preview: string,
    now: number,
    reason?: string
): EvolutionQueueItem | undefined {
    const key = normalizePainDedupKey(source, preview, reason);
    return queue.find((task) => {
        if (task.status === 'completed') return false;
        const taskTime = new Date(task.enqueued_at || task.timestamp).getTime();
        if (!Number.isFinite(taskTime) || (now - taskTime) > PAIN_QUEUE_DEDUP_WINDOW_MS) return false;
        return normalizePainDedupKey(task.source, task.trigger_text_preview || '', task.reason) === key;
    });
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
    const beforeCount = queue.length;
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

function normalizePainDedupKey(source: string, preview: string, reason?: string): string {
    // Include reason in dedup key to match createEvolutionTaskId() behavior
    // Different reasons for the same source/preview should create different tasks
    const normalizedReason = (reason || '').trim().toLowerCase();
    return `${source.trim().toLowerCase()}::${preview.trim().toLowerCase()}::${normalizedReason}`;
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
 * Read recent pain context from PAIN_FLAG file.
 * Returns structured pain metadata for attaching to sleep_reflection tasks.
 * Returns null if no pain flag exists.
 */
function readRecentPainContext(wctx: WorkspaceContext): RecentPainContext {
    const painFlagPath = wctx.resolve('PAIN_FLAG');
    if (!fs.existsSync(painFlagPath)) {
        return { mostRecent: null, recentPainCount: 0, recentMaxPainScore: 0 };
    }

    try {
        const rawPain = fs.readFileSync(painFlagPath, 'utf8');
        const lines = rawPain.split('\n');

        let score = 0;
        let source = '';
        let reason = '';
        let timestamp = '';

        for (const line of lines) {
            if (line.startsWith('score:')) score = parseInt(line.split(':', 2)[1].trim(), 10) || 0;
            if (line.startsWith('source:')) source = line.split(':', 2)[1].trim();
            if (line.startsWith('reason:')) reason = line.slice('reason:'.length).trim();
            if (line.startsWith('timestamp:')) timestamp = line.slice('timestamp:'.length).trim();
        }

        if (score > 0) {
            return {
                mostRecent: { score, source, reason, timestamp },
                recentPainCount: 1,
                recentMaxPainScore: score,
            };
        }
    } catch {
        // Best effort — non-fatal
    }

    return { mostRecent: null, recentPainCount: 0, recentMaxPainScore: 0 };
}

/**
 * Enqueue a sleep_reflection task if one is not already pending.
 * Phase 2.4: Called when workspace is idle to trigger nocturnal reflection.
 */
async function enqueueSleepReflectionTask(
    wctx: WorkspaceContext,
    logger: PluginLogger
): Promise<void> {
    const queuePath = wctx.resolve('EVOLUTION_QUEUE');
    const releaseLock = await requireQueueLock(queuePath, logger, 'enqueueSleepReflection', EVOLUTION_QUEUE_LOCK_SUFFIX);

    try {
        let rawQueue: RawQueueItem[] = [];
        try {
            rawQueue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
        } catch {
            // Queue doesn't exist yet - create empty array
            rawQueue = [];
        }

        const queue: EvolutionQueueItem[] = migrateQueueToV2(rawQueue);

        // Check if a sleep_reflection task is already pending
        const hasPendingSleepReflection = queue.some(
            t => t.taskKind === 'sleep_reflection' && (t.status === 'pending' || t.status === 'in_progress')
        );
        if (hasPendingSleepReflection) {
            logger?.debug?.('[PD:EvolutionWorker] sleep_reflection task already pending/in-progress, skipping');
            return;
        }

        const now = Date.now();
        const taskId = createEvolutionTaskId('nocturnal', 50, 'idle workspace', 'Sleep-mode reflection', now);
        const nowIso = new Date(now).toISOString();

        // Attach recent pain context if available
        const recentPainContext = readRecentPainContext(wctx);

        queue.push({
            id: taskId,
            taskKind: 'sleep_reflection',
            priority: 'medium',
            score: 50,
            source: 'nocturnal',
            reason: 'Sleep-mode reflection triggered by idle workspace',
            trigger_text_preview: 'Idle workspace detected',
            timestamp: nowIso,
            enqueued_at: nowIso,
            status: 'pending',
            traceId: taskId,
            retryCount: 0,
            maxRetries: 1, // sleep_reflection doesn't retry
            recentPainContext,
        });

        fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
        logger?.info?.(`[PD:EvolutionWorker] Enqueued sleep_reflection task ${taskId}`);
    } finally {
        releaseLock();
    }
}

interface ParsedPainValues {
    score: number; source: string; reason: string; preview: string;
    traceId: string; sessionId: string; agentId: string;
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
            try { queue = JSON.parse(fs.readFileSync(queuePath, 'utf8')); } catch {}
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
        });

        fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
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

        // Try JSON format first (pain skill structured output)
        // The file may have 'status: queued' and 'task_id: xxx' appended after the JSON object.
        // Extract just the JSON portion by finding the last '}' and parsing up to that point.
        try {
            const jsonEndIdx = rawPain.lastIndexOf('}');
            const jsonPortion = jsonEndIdx >= 0 ? rawPain.slice(0, jsonEndIdx + 1) : rawPain;
            const jsonPain = JSON.parse(jsonPortion);
            if (typeof jsonPain === 'object' && jsonPain !== null && jsonPain.pain_score !== undefined) {
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
                    preview: jsonPreview, traceId: '', sessionId: '', agentId: '',
                });
            }
        } catch { /* Not JSON — fall through to KV/Markdown parsing */ }

        const lines = rawPain.split('\n');

        let score = 0;
        let source = 'unknown';
        let reason = 'Systemic pain detected';
        let preview = '';
        let isQueued = false;
        let traceId = '';
        let sessionId = '';
        let agentId = '';

        for (const line of lines) {
            if (line.startsWith('score:')) score = parseInt(line.split(':', 2)[1].trim(), 10) || 0;
            if (line.startsWith('source:')) source = line.split(':', 2)[1].trim();
            if (line.startsWith('reason:')) reason = line.slice('reason:'.length).trim();
            if (line.startsWith('trigger_text_preview:')) preview = line.slice('trigger_text_preview:'.length).trim();
            if (line.startsWith('status: queued')) isQueued = true;
            if (line.startsWith('trace_id:')) traceId = line.split(':', 2)[1].trim();
            if (line.startsWith('session_id:')) sessionId = line.slice('session_id:'.length).trim();
            if (line.startsWith('agent_id:')) agentId = line.slice('agent_id:'.length).trim();

            // Markdown format support (pain skill writes **Source**: xxx format)
            const mdSource = line.match(/\*\*Source\*\*:\s*(.+)/);
            if (mdSource) source = mdSource[1].trim();
            const mdReason = line.match(/\*\*Reason\*\*:\s*(.+)/);
            if (mdReason) reason = mdReason[1].trim();
            const mdTime = line.match(/\*\*Time\*\*:\s*(.+)/);
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
            traceId, sessionId, agentId,
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
        const queue: EvolutionQueueItem[] = migrateQueueToV2(rawQueue);

        let queueChanged = rawQueue.some(isLegacyQueueItem);

        const config = wctx.config;
        const timeout = config.get('intervals.task_timeout_ms') || (60 * 60 * 1000); // Default 1 hour

        // V2: Recover stuck in_progress sleep_reflection tasks.
        // If the worker crashes or the result write-back fails after Phase 1 claimed
        // the task, it stays in_progress indefinitely. Detect via timeout and mark
        // as failed so a fresh task can be enqueued on the next idle cycle.
        for (const task of queue.filter(t => t.status === 'in_progress' && t.taskKind === 'sleep_reflection')) {
            const startedAt = new Date(task.started_at || task.timestamp);
            const age = Date.now() - startedAt.getTime();
            if (age > timeout) {
                task.status = 'failed';
                task.completed_at = new Date().toISOString();
                task.resolution = 'failed_max_retries';
                task.lastError = `sleep_reflection timed out after ${Math.round(timeout / 60000)} minutes`;
                task.retryCount = (task.retryCount ?? 0) + 1;
                queueChanged = true;
                logger?.warn?.(`[PD:EvolutionWorker] sleep_reflection task ${task.id} timed out after ${Math.round(age / 60000)} minutes, marking as failed`);
                evoLogger.logCompleted({
                    traceId: task.traceId || task.id,
                    taskId: task.id,
                    resolution: 'manual',
                    durationMs: age,
                });
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
                                logger.info(`[PD:EvolutionWorker] Creating principle from report for task ${task.id}`);
                                const principleId = wctx.evolutionReducer.createPrincipleFromDiagnosis({
                                    painId: task.id,
                                    painType: task.source === 'Human Intervention' ? 'user_frustration' : 'tool_failure',
                                    triggerPattern: principle.trigger_pattern,
                                    action: principle.action,
                                    source: task.source || 'heartbeat_diagnostician',
                                    evaluability: principle.evaluability || 'manual_only',
                                    abstractedPrinciple: principle.abstracted_principle,
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
                } catch {}

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

                const completeMarker = path.join(wctx.stateDir, `.evolution_complete_${task.id}`);
                const reportPath = path.join(wctx.stateDir, `.diagnostician_report_${task.id}.json`);

                if (fs.existsSync(completeMarker) && fs.existsSync(reportPath)) {
                    if (logger) logger.info(`[PD:EvolutionWorker] Task ${task.id} timed out but marker found — creating principle anyway`);
                    let principleCreated = false;
                    try {
                        const reportData = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
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
                                    evaluability: principle.evaluability || 'manual_only',
                                    abstractedPrinciple: principle.abstracted_principle,
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
                    try { fs.unlinkSync(completeMarker); } catch {}
                    task.resolution = principleCreated ? 'late_marker_principle_created' : 'late_marker_no_principle';
                } else {
                    if (logger) logger.info(`[PD:EvolutionWorker] Task ${task.id} auto-completed after ${timeoutMinutes} minute timeout`);
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
            const highestScoreTask = pendingTasks.sort((a, b) => {
                const scoreDiff = b.score - a.score;
                if (scoreDiff !== 0) return scoreDiff;
                return (priorityWeight[b.priority] || 2) - (priorityWeight[a.priority] || 2);
            })[0];
            const nowIso = new Date().toISOString();

            const taskDescription = `Diagnose systemic pain [ID: ${highestScoreTask.id}]. Source: ${highestScoreTask.source}. Reason: ${highestScoreTask.reason}. ` +
                  `Trigger text: "${highestScoreTask.trigger_text_preview || 'N/A'}"`;

            // Prepare HEARTBEAT content first
            // Use shared diagnostician protocol (consistent with pd-diagnostician skill)
            const heartbeatPath = wctx.resolve('HEARTBEAT');
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
            } catch {}

            // ── Context Enrichment (CTX-01): Pre-extract conversation context ──
            // Extract recent conversation from JSONL so diagnostician has full context
            // instead of just the 100-char trigger_text_preview.
            let contextSection = '';
            if (highestScoreTask.session_id && highestScoreTask.agent_id) {
                try {
                    const { extractRecentConversation, extractFailedToolContext } = await import('../core/pain-context-extractor.js');
                    const conversation = await extractRecentConversation(highestScoreTask.session_id, highestScoreTask.agent_id, 5);
                    
                    if (conversation) {
                        contextSection = `\n## Recent Conversation Context (pre-extracted)\n\n${conversation}\n`;
                        
                        // Also try to extract failed tool context if this is a tool failure
                        if (highestScoreTask.source === 'tool_failure') {
                            // Extract tool name from reason (e.g., "Tool write failed on src/foo.ts")
                            const toolMatch = highestScoreTask.reason?.match(/Tool ([\w-]+) failed/);
                            const fileMatch = highestScoreTask.reason?.match(/on (.+?)(?=\s*Error:|$)/i);
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
                } catch (e) {
                    logger?.debug?.(`[PD:EvolutionWorker] Failed to extract conversation context: ${String(e)}`);
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
                ...(contextSection ? [contextSection] : ['']),
                `---`,
                ``,
                `## Diagnostician Protocol`,
                ``,
                `You MUST use the **pd-diagnostician** skill for this task.`,
                `Read the full skill definition and follow the 4-phase protocol (Evidence → Causal Chain → Classification → Principle Extraction) EXACTLY as specified.`,
                `The skill defines the complete output contract — your JSON report MUST match the format specified in the skill.`,
                ``,
                `---`,
                ``,
                `After completing the analysis:`,
                `1. Write your JSON diagnosis report to: ${reportFilePath}`,
                `   The JSON structure MUST match the output format defined in the pd-diagnostician skill.`,
                `2. Mark the task complete by creating a marker file: ${markerFilePath}`,
                `   The marker file should contain: "diagnostic_completed: <timestamp>\\noutcome: <summary>"`,
                `3. Replace this HEARTBEAT.md content with "HEARTBEAT_OK"`,
                existingPrinciplesRef,
            ].join('\n');

            // Try to write HEARTBEAT.md FIRST
            // Only mark task as in_progress after successful write to avoid stuck tasks
            try {
                fs.writeFileSync(heartbeatPath, heartbeatContent, 'utf8');
                if (logger) logger.info(`[PD:EvolutionWorker] Wrote diagnostician task to HEARTBEAT.md for task ${highestScoreTask.id}`);

                // HEARTBEAT write succeeded, now mark task as in_progress
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
                // HEARTBEAT write failed - keep task as pending for next cycle retry
                if (logger) logger.error(`[PD:EvolutionWorker] Failed to write HEARTBEAT.md for task ${highestScoreTask.id}: ${String(heartbeatErr)}. Task will remain pending for next cycle.`);
                SystemLogger.log(wctx.workspaceDir, 'HEARTBEAT_WRITE_FAILED', `Task ${highestScoreTask.id} HEARTBEAT write failed: ${String(heartbeatErr)}`);
            }
        }

        // Phase 2.4: Process sleep_reflection tasks AFTER pain_diagnosis.
        // Claim tasks inside the lock, execute reflection outside the lock,
        // then re-acquire the lock to write results. This prevents the long-running
        // nocturnal reflection from blocking all other queue consumers.
        // Safe to return early here because pain_diagnosis was already handled above.
        const sleepReflectionTasks = queue.filter(t => t.status === 'pending' && t.taskKind === 'sleep_reflection');
        if (sleepReflectionTasks.length > 0) {
            // --- Phase 1: Claim tasks (inside lock) ---
            for (const sleepTask of sleepReflectionTasks) {
                sleepTask.status = 'in_progress';
                sleepTask.started_at = new Date().toISOString();
            }
            queueChanged = true;

            // Write claimed state (includes any pain changes from above) and release lock
            if (queueChanged) {
                fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
            }
            releaseLock();
            for (const sleepTask of sleepReflectionTasks) {
                try {
                    logger?.info?.(`[PD:EvolutionWorker] Processing sleep_reflection task ${sleepTask.id}`);

                    // NOC-14: Use NocturnalWorkflowManager for sleep_reflection tasks
                    // Lazy-create manager (needs runtimeAdapter from api)
                    let nocturnalManager: NocturnalWorkflowManager | undefined;
                    if (api) {
                        nocturnalManager = new NocturnalWorkflowManager({
                            workspaceDir: wctx.workspaceDir,
                            stateDir: wctx.stateDir,
                            logger: api.logger,
                            runtimeAdapter: new OpenClawTrinityRuntimeAdapter(api),
                        });
                    } else {
                        // Cannot create manager without api (runtimeAdapter required)
                        sleepTask.status = 'failed';
                        sleepTask.completed_at = new Date().toISOString();
                        sleepTask.resolution = 'failed_max_retries';
                        sleepTask.lastError = 'No API available to create NocturnalWorkflowManager';
                        sleepTask.retryCount = (sleepTask.retryCount ?? 0) + 1;
                        logger?.warn?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} skipped: no API`);
                        continue;
                    }

                    // Start workflow via NocturnalWorkflowManager instead of direct executeNocturnalReflectionAsync
                    // Pass taskId in metadata for correlation
                    const workflowHandle = await nocturnalManager.startWorkflow(nocturnalWorkflowSpec, {
                        parentSessionId: `sleep_reflection:${sleepTask.id}`,
                        workspaceDir: wctx.workspaceDir,
                        taskInput: {},
                        metadata: {
                            snapshot: sleepTask.recentPainContext ? {
                                sessionId: sleepTask.id,
                                sessionStart: sleepTask.timestamp,
                                stats: { totalAssistantTurns: 0, totalToolCalls: 0, failureCount: 0, totalPainEvents: sleepTask.recentPainContext.recentPainCount, totalGateBlocks: 0 },
                                recentPain: sleepTask.recentPainContext.mostRecent ? [sleepTask.recentPainContext.mostRecent] : [],
                            } : undefined,
                            principleId: 'default',
                            taskId: sleepTask.id,  // NOC-14: correlation ID for evolution worker
                        },
                    });

                    // Store workflowId on task for polling on subsequent cycles
                    sleepTask.resultRef = workflowHandle.workflowId;

                    // Workflow is running asynchronously. Check if it completed in this cycle
                    // by polling getWorkflowDebugSummary.
                    const summary = await nocturnalManager.getWorkflowDebugSummary(workflowHandle.workflowId);
                    if (summary) {
                        if (summary.state === 'completed') {
                            sleepTask.status = 'completed';
                            sleepTask.completed_at = new Date().toISOString();
                            sleepTask.resolution = 'marker_detected';
                            sleepTask.resultRef = summary.metadata?.nocturnalResult ? 'trinity-draft' : workflowHandle.workflowId;
                            logger?.info?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} workflow completed`);
                        } else if (summary.state === 'terminal_error') {
                            sleepTask.status = 'failed';
                            sleepTask.completed_at = new Date().toISOString();
                            sleepTask.resolution = 'failed_max_retries';
                            const lastEvent = summary.recentEvents[summary.recentEvents.length - 1];
                            sleepTask.lastError = `Workflow terminal_error: ${lastEvent?.reason ?? 'unknown'}`;
                            sleepTask.retryCount = (sleepTask.retryCount ?? 0) + 1;
                            logger?.warn?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} workflow failed: ${sleepTask.lastError}`);
                        } else {
                            // Workflow still active, keep task in_progress for next cycle
                            logger?.info?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} workflow ${summary.state}, will poll again next cycle`);
                        }
                    }
                } catch (taskErr) {
                    sleepTask.status = 'failed';
                    sleepTask.completed_at = new Date().toISOString();
                    sleepTask.resolution = 'failed_max_retries';
                    sleepTask.lastError = String(taskErr);
                    sleepTask.retryCount = (sleepTask.retryCount ?? 0) + 1;
                    logger?.error?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} threw: ${taskErr}`);
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
                    fs.writeFileSync(queuePath, JSON.stringify(freshQueue, null, 2), 'utf8');

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

            // Safe to return — pain_diagnosis was already processed above.
            lockReleased = true;
            return;
        }

        if (queueChanged) {
            fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
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
    const logger = api.logger;
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
                // No L3 hit - fall through to track as pain candidate
                await trackPainCandidate(text, wctx);
            }
        }
    } catch (err) {
        if (logger) logger.warn(`[PD:EvolutionWorker] Detection queue failed: ${String(err)}`);
    }
}

export async function trackPainCandidate(text: string, wctx: WorkspaceContext) {
    if (!shouldTrackPainCandidate(text)) return;

    const candidatePath = wctx.resolve('PAIN_CANDIDATES');
    const releaseLock = await requireQueueLock(candidatePath, console, 'trackPainCandidate', PAIN_CANDIDATES_LOCK_SUFFIX);

    try {
        let data: { candidates: Record<string, PainCandidateEntry> } = { candidates: {} };
        if (fs.existsSync(candidatePath)) {
            try {
                data = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
            } catch (e) {
                // Keep going with empty data if parse fails, but log it
                // eslint-disable-next-line no-console
                console.warn(`[PD:EvolutionWorker] Failed to parse pain candidates: ${String(e)}`);
            }
        }

        const fingerprint = createPainCandidateFingerprint(text);
        const now = new Date().toISOString();
        if (!data.candidates[fingerprint]) {
            data.candidates[fingerprint] = { count: 0, status: 'pending', firstSeen: now, lastSeen: now, samples: [] };
        }

        const cand = data.candidates[fingerprint];
        cand.status = cand.status || 'pending';
        cand.count++;
        cand.lastSeen = now;

        const sample = summarizePainCandidateSample(text);
        if (cand.samples.length < PAIN_CANDIDATE_MAX_SAMPLES && !cand.samples.includes(sample)) {
            cand.samples.push(sample);
        }
        
        fs.writeFileSync(candidatePath, JSON.stringify(data, null, 2), 'utf8');
    } finally {
        releaseLock();
    }
}

export async function processPromotion(wctx: WorkspaceContext, logger: PluginLogger, eventLog: EventLog) {
    const candidatePath = wctx.resolve('PAIN_CANDIDATES');
    if (!fs.existsSync(candidatePath)) return;

    const releaseLock = await requireQueueLock(candidatePath, logger, 'processPromotion', PAIN_CANDIDATES_LOCK_SUFFIX);

    try {
        const config = wctx.config;
        const dictionary = wctx.dictionary;
        const data: { candidates: Record<string, PainCandidateEntry> } = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
        const countThreshold = config.get('thresholds.promotion_count_threshold') || 3;

        let promotedCount = 0;
        let changed = false;

        for (const [fingerprint, cand] of Object.entries(data.candidates)) {
            if (isPendingPainCandidate(cand.status) && cand.count >= countThreshold) {
                // Normalize undefined status to 'pending'
                if (cand.status !== 'pending') {
                    cand.status = 'pending';
                    changed = true;
                }
                const commonPhrases = extractCommonSubstring(cand.samples);

                if (commonPhrases.length > 0) {
                    const phrase = commonPhrases[0];
                    const ruleId = `P_PROMOTED_${fingerprint.toUpperCase()}`;

                    if (hasEquivalentPromotedRule(dictionary, phrase)) {
                        cand.status = 'duplicate';
                        changed = true;
                        logger?.info?.(`[PD:EvolutionWorker] Skipping duplicate promoted rule for candidate ${fingerprint}: ${phrase}`);
                        continue;
                    }

                    if (logger) logger.info(`[PD:EvolutionWorker] Promoting candidate ${fingerprint} to formal rule: ${ruleId}`);
                    SystemLogger.log(wctx.workspaceDir, 'RULE_PROMOTED', `Candidate ${fingerprint} promoted to rule ${ruleId}`);

                    dictionary.addRule(ruleId, {
                        type: 'exact_match',
                        phrases: [phrase],
                        severity: config.get('scores.default_confusion') || 35,
                        status: 'active'
                    });

                    cand.status = 'promoted';
                    promotedCount++;
                    changed = true;
                }
            }
        }

        if (changed) {
            fs.writeFileSync(candidatePath, JSON.stringify(data, null, 2), 'utf8');
        }
    } catch (err) {
        if (logger) logger.warn(`[PD:EvolutionWorker] Error during rule promotion: ${String(err)}`);
    } finally {
        releaseLock();
    }
}

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
        const queue: EvolutionQueueItem[] = migrateQueueToV2(rawQueue);
        
        const task = queue.find((item) => item.id === taskId && item.status === 'in_progress');
        if (!task) {
            logger?.warn?.(`[PD:EvolutionWorker] Could not find in-progress evolution task ${taskId} for session assignment`);
            return false;
        }

        task.assigned_session_key = sessionKey;
        if (!task.started_at) {
            task.started_at = new Date().toISOString();
        }
        fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
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
    } catch {}
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

        const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));

        // Purge stale failed tasks before processing (keeps queue lean)
        const purgeResult = purgeStaleFailedTasks(queue, logger);
        if (purgeResult.purged > 0) {
            // Write back the cleaned queue
            fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
        }

        queueResult.total = queue.length;
        queueResult.pending = queue.filter((t: any) => t.status === 'pending').length;
        queueResult.in_progress = queue.filter((t: any) => t.status === 'in_progress').length;
        queueResult.failed_this_cycle = queue.filter((t: any) => t.status === 'failed').length;
        queueResult.completed_this_cycle = queue.filter((t: any) => t.status === 'completed').length;

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

    start(ctx: OpenClawPluginServiceContext): void {
        const logger = ctx?.logger || console;
        const api = this.api;
        const workspaceDir = ctx?.workspaceDir;

        if (!workspaceDir) {
            if (logger) logger.warn('[PD:EvolutionWorker] workspaceDir not found in service config. Evolution cycle disabled.');
            return;
        }

        const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });
        if (logger) logger.info(`[PD:EvolutionWorker] Starting with workspaceDir=${wctx.workspaceDir}, stateDir=${wctx.stateDir}`);

        initPersistence(wctx.stateDir);
        const eventLog = wctx.eventLog;

        const config = wctx.config;
        const language = config.get('language') || 'en';
        ensureStateTemplates({ logger }, wctx.stateDir, language);

        const initialDelay = 5000;
        const interval = config.get('intervals.worker_poll_ms') || (15 * 60 * 1000);

        async function runCycle(): Promise<void> {
            const cycleStart = Date.now();
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
                        enqueueSleepReflectionTask(wctx, logger).catch((err) => {
                            logger?.error?.(`[PD:EvolutionWorker] Failed to enqueue sleep_reflection task: ${String(err)}`);
                        });
                    }
                } else {
                    logger?.debug?.(`[PD:EvolutionWorker] Workspace active (last activity ${idleResult.idleForMs}ms ago)`);
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
                await processPromotion(wctx, logger, eventLog);

                try {
                    // Delegate to workflow managers' sweepExpiredWorkflows so that
                    // session/transcript cleanup runs via driver.deleteSession().
                    const subagentRuntime = api?.runtime?.subagent;
                    if (subagentRuntime) {
                        const empathyMgr = new EmpathyObserverWorkflowManager({
                            workspaceDir: wctx.workspaceDir,
                            logger: api.logger,
                            subagent: subagentRuntime,
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
                        });
                        try {
                            swept += await deepReflectMgr.sweepExpiredWorkflows(WORKFLOW_TTL_MS);
                        } finally {
                            deepReflectMgr.dispose();
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
                await checkPainFlag(wctx, logger);
                // Use the same pipeline as regular cycles (includes purge + observability)
                const queueResult = await processEvolutionQueueWithResult(wctx, logger, eventLog, api ?? undefined);
                if (queueResult.errors.length > 0) {
                    queueResult.errors.forEach((e) => logger?.error?.(`[PD:EvolutionWorker] Startup cycle error: ${e}`));
                }
                if (api) {
                    await processDetectionQueue(wctx, api, eventLog);
                }
                await processPromotion(wctx, logger, eventLog);
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
