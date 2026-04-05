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
import { DIAGNOSTICIAN_PROTOCOL_SUMMARY } from '../constants/diagnostician.js';
import { LockUnavailableError } from '../config/index.js';
import { checkWorkspaceIdle, checkCooldown } from './nocturnal-runtime.js';
import { WorkflowStore } from './subagent-workflow/workflow-store.js';

const WORKFLOW_TTL_MS = 5 * 60 * 1000; // 5 minutes default TTL for helper workflows
import { executeNocturnalReflectionAsync } from './nocturnal-service.js';
import { OpenClawTrinityRuntimeAdapter } from '../core/nocturnal-trinity.js';

let intervalId: NodeJS.Timeout | null = null;
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
export type TaskResolution = 'marker_detected' | 'auto_completed_timeout' | 'failed_max_retries' | 'canceled';

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

async function checkPainFlag(wctx: WorkspaceContext, logger: PluginLogger): Promise<WorkerStatusReport['pain_flag']> {
    const result: WorkerStatusReport['pain_flag'] = { exists: false, score: null, source: null, enqueued: false, skipped_reason: null };
    try {
        const painFlagPath = wctx.resolve('PAIN_FLAG');
        if (!fs.existsSync(painFlagPath)) return result;

        const rawPain = fs.readFileSync(painFlagPath, 'utf8');
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
        if (score < 30) {
            result.skipped_reason = `score_too_low (${score} < 30)`;
            if (logger) logger.info(`[PD:EvolutionWorker] Pain flag score too low: ${score} (source=${source})`);
            return result;
        }

        if (logger) logger.info(`[PD:EvolutionWorker] Detected pain flag (score: ${score}, source: ${source}). Enqueueing evolution task.`);

        const queuePath = wctx.resolve('EVOLUTION_QUEUE');
        const releaseLock = await requireQueueLock(queuePath, logger, 'checkPainFlag');

        try {
            let queue: EvolutionQueueItem[] = [];
            if (fs.existsSync(queuePath)) {
                try {
                    queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
                } catch (e) {
                    if (logger) logger.error(`[PD:EvolutionWorker] Failed to parse evolution queue: ${String(e)}`);
                }
            }

            const now = Date.now();
            const duplicateTask = findRecentDuplicateTask(queue, source, preview, now, reason);
            if (duplicateTask) {
                logger?.info?.(`[PD:EvolutionWorker] Duplicate pain task skipped for source=${source} preview=${preview || 'N/A'}`);
                fs.appendFileSync(
                    painFlagPath,
                    `\nstatus: queued\ntask_id: ${duplicateTask.id}\n`,
                    'utf8'
                );
                result.enqueued = true;
                result.skipped_reason = 'duplicate';
                return result;
            }

            const taskId = createEvolutionTaskId(source, score, preview, reason, now);
            const nowIso = new Date(now).toISOString();
            const effectiveTraceId = traceId || taskId;

            queue.push({
                id: taskId,
                taskKind: 'pain_diagnosis',
                priority: score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low',
                score,
                source,
                reason,
                trigger_text_preview: preview,
                timestamp: nowIso,
                enqueued_at: nowIso,
                status: 'pending',
                session_id: sessionId || undefined,
                agent_id: agentId || undefined,
                traceId: effectiveTraceId,
                retryCount: 0,
                maxRetries: 3,
            });

            fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
            fs.appendFileSync(painFlagPath, `\nstatus: queued\ntask_id: ${taskId}\n`, 'utf8');

            const evoLogger = getEvolutionLogger(wctx.workspaceDir, wctx.trajectory);
            evoLogger.logQueued({
                traceId: traceId || taskId,
                taskId,
                score,
                source,
                reason,
            });

            wctx.trajectory?.recordEvolutionTask?.({
                taskId,
                traceId: traceId || taskId,
                source,
                reason,
                score,
                status: 'pending',
                enqueuedAt: nowIso,
            });

            result.enqueued = true;

        } finally {
            releaseLock();
        }

    } catch (err) {
        if (logger) logger.warn(`[PD:EvolutionWorker] Error processing pain flag: ${String(err)}`);
        result.skipped_reason = `error: ${String(err)}`;
    }
    return result;
}

async function processEvolutionQueue(wctx: WorkspaceContext, logger: PluginLogger, eventLog: EventLog, api?: OpenClawPluginApi) {
    const queuePath = wctx.resolve('EVOLUTION_QUEUE');
    if (!fs.existsSync(queuePath)) return;

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
        for (const task of queue.filter(t => t.status === 'in_progress' && t.taskKind === 'pain_diagnosis')) {
            const startedAt = new Date(task.started_at || task.timestamp);

            // Condition 1: Check for marker file (created by diagnostician on completion)
            const completeMarker = path.join(wctx.stateDir, `.evolution_complete_${task.id}`);
            if (fs.existsSync(completeMarker)) {
                if (logger) logger.info(`[PD:EvolutionWorker] Task ${task.id} completed - marker file detected`);

                const reportPath = path.join(wctx.stateDir, `.diagnostician_report_${task.id}.json`);
                if (fs.existsSync(reportPath)) {
                    try {
                        const reportData = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
                        const principle = reportData?.diagnosis_report?.principle || reportData?.principle;
                        if (principle?.trigger_pattern && principle?.action) {
                            const principleId = wctx.evolutionReducer.createPrincipleFromDiagnosis({
                                painId: task.id,
                                painType: task.source === 'Human Intervention' ? 'user_frustration' : 'tool_failure',
                                triggerPattern: principle.trigger_pattern,
                                action: principle.action,
                                source: task.source || 'heartbeat_diagnostician',
                                evaluability: principle.evaluability || 'manual_only',
                            });
                            if (principleId) {
                                logger.info(`[PD:EvolutionWorker] Created principle ${principleId} from heartbeat diagnostician report for task ${task.id}`);
                            } else {
                                logger.warn(`[PD:EvolutionWorker] createPrincipleFromDiagnosis returned null for task ${task.id}`);
                            }
                        } else {
                            logger.warn(`[PD:EvolutionWorker] Diagnostician report for task ${task.id} missing principle fields`);
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

            // Condition 2: Timeout auto-complete
            const age = Date.now() - startedAt.getTime();
            if (age > timeout) {
                const timeoutMinutes = Math.round(timeout / 60000);
                if (logger) logger.info(`[PD:EvolutionWorker] Task ${task.id} auto-completed after ${timeoutMinutes} minute timeout`);
                task.status = 'completed';
                task.completed_at = new Date().toISOString();
                task.resolution = 'auto_completed_timeout';

                // Log to EvolutionLogger
                evoLogger.logCompleted({
                    traceId: task.traceId || task.id,
                    taskId: task.id,
                    resolution: 'auto_completed_timeout',
                    durationMs: age,
                });

                // Update evolution_tasks table
                wctx.trajectory?.updateEvolutionTask?.(task.id, {
                    status: 'completed',
                    completedAt: task.completed_at,
                    resolution: 'auto_completed_timeout',
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
                `---`,
                ``,
                DIAGNOSTICIAN_PROTOCOL_SUMMARY,
                ``,
                `---`,
                ``,
                `After completing the analysis:`,
                `1. Write your JSON diagnosis report to: ${reportFilePath}`,
                `   The JSON must include a "principle" field with "trigger_pattern" and "action".`,
                `2. Write the resulting principle(s) to PRINCIPLES.md`,
                `3. Mark the task complete by creating a marker file: ${markerFilePath}`,
                `   The marker file should contain: "diagnostic_completed: <timestamp>\\noutcome: <summary>"`,
                `4. Replace this HEARTBEAT.md content with "HEARTBEAT_OK"`,
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
                // Use placeholder instead of deleting - allows subagent_ended hook to match
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

                    // Build runtime adapter for real Trinity execution if api is available
                    const runtimeAdapter = api ? new OpenClawTrinityRuntimeAdapter(api) : undefined;

                    // Call the nocturnal reflection service
                    const result = await executeNocturnalReflectionAsync(wctx.workspaceDir, wctx.stateDir, {
                        runtimeAdapter,
                    });

                    if (result.success && result.artifact) {
                        sleepTask.status = 'completed';
                        sleepTask.completed_at = new Date().toISOString();
                        sleepTask.resolution = 'marker_detected';
                        sleepTask.resultRef = result.diagnostics.persistedPath;
                        logger?.info?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} completed successfully`);
                    } else {
                        // Record failure with skip reason
                        const skipReason = result.skipReason || (result.noTargetSelected ? 'no_target' : 'validation_failed');
                        sleepTask.status = 'failed';
                        sleepTask.completed_at = new Date().toISOString();
                        sleepTask.resolution = 'failed_max_retries';
                        sleepTask.lastError = `Nocturnal reflection failed: ${result.validationFailures.join('; ') || skipReason}`;
                        sleepTask.retryCount = (sleepTask.retryCount ?? 0) + 1;
                        logger?.warn?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} failed: ${sleepTask.lastError}`);
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
                // L3 semantic search via createMemorySearchTool is not available in the OpenClaw SDK.
                // Fall through to L2 rule-based detection only.
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
        queueResult.total = queue.length;
        queueResult.pending = queue.filter((t: any) => t.status === 'pending').length;
        queueResult.in_progress = queue.filter((t: any) => t.status === 'in_progress').length;

        for (const task of queue) {
            if (task?.taskKind !== 'sleep_reflection') continue;
            if (task?.status === 'completed') queueResult.completed_this_cycle++;
            if (task?.status === 'failed') queueResult.failed_this_cycle++;
        }

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

        intervalId = setInterval(() => {
            void (async () => {
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

                // V2: Nocturnal idle check — logs workspace idle state on each cycle.
                // This makes nocturnal-runtime a visible part of the worker lifecycle.
                // Phase 2.4: Enqueue sleep_reflection when workspace is idle and not in cooldown.
                const idleResult = checkWorkspaceIdle(wctx.workspaceDir, {});
                logger?.info?.(`[PD:EvolutionWorker] HEARTBEAT cycle=${new Date().toISOString()} idle=${idleResult.isIdle} idleForMs=${idleResult.idleForMs} userActiveSessions=${idleResult.userActiveSessions} abandonedSessions=${idleResult.abandonedSessionIds.length} lastActivityEpoch=${idleResult.mostRecentActivityAt}`);
                if (idleResult.isIdle) {
                    logger?.debug?.(`[PD:EvolutionWorker] Workspace idle (${idleResult.idleForMs}ms since last activity)`);
                    // Phase 2.4: Enqueue sleep_reflection task if not in global cooldown
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

                if (api) {
                    await processDetectionQueue(wctx, api, eventLog);
                }
                await processPromotion(wctx, logger, eventLog);

                // PR2.1 Task 2: Sweep expired helper workflows
                // Uses WorkflowStore directly to update state; session cleanup is handled
                // separately by the workflow manager when it has access to subagent runtime.
                try {
                    const workflowStore = new WorkflowStore({ workspaceDir: wctx.workspaceDir });
                    const expiredWorkflows = workflowStore.getExpiredWorkflows(WORKFLOW_TTL_MS);
                    for (const wf of expiredWorkflows) {
                        workflowStore.updateWorkflowState(wf.workflow_id, 'expired');
                        workflowStore.recordEvent(wf.workflow_id, 'swept', wf.state, 'expired', 'TTL expired by worker', {});
                        logger?.debug?.(`[PD:EvolutionWorker] Swept expired workflow: ${wf.workflow_id}`);
                    }
                    workflowStore.dispose();
                } catch (sweepErr) {
                    const errMsg = `Failed to sweep expired workflows: ${String(sweepErr)}`;
                    cycleResult.errors.push(errMsg);
                    logger?.warn?.(`[PD:EvolutionWorker] ${errMsg}`);
                }

                wctx.dictionary.flush();
                flushAllSessions();

                cycleResult.duration_ms = Date.now() - cycleStart;
                writeWorkerStatus(wctx.stateDir, cycleResult);
            })().catch((err) => {
                const errMsg = `Error in worker interval: ${String(err)}`;
                if (logger) logger.error(`[PD:EvolutionWorker] ${errMsg}`);
                writeWorkerStatus(wctx.stateDir, {
                    timestamp: new Date().toISOString(),
                    cycle_start_ms: Date.now(),
                    duration_ms: 0,
                    pain_flag: { exists: false, score: null, source: null, enqueued: false, skipped_reason: null },
                    queue: { total: 0, pending: 0, in_progress: 0, completed_this_cycle: 0, failed_this_cycle: 0 },
                    errors: [errMsg],
                });
            });
        }, interval);

        timeoutId = setTimeout(() => {
            void (async () => {
                await checkPainFlag(wctx, logger);
                await processEvolutionQueue(wctx, logger, eventLog, api ?? undefined);
                if (api) {
                    await processDetectionQueue(wctx, api, eventLog);
                }
                await processPromotion(wctx, logger, eventLog);
            })().catch((err) => {
                if (logger) logger.error(`[PD:EvolutionWorker] Startup worker cycle failed: ${String(err)}`);
            });
        }, initialDelay);
    },

    stop(ctx: OpenClawPluginServiceContext): void {
        if (ctx?.logger) ctx.logger.info('[PD:EvolutionWorker] Stopping background service...');
        if (intervalId) clearInterval(intervalId);
        if (timeoutId) clearTimeout(timeoutId);
        flushAllSessions();
    }
};
