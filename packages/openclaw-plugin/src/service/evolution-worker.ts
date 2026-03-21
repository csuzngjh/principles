import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { OpenClawPluginServiceContext, OpenClawPluginApi } from '../openclaw-sdk.js';
import { DictionaryService } from '../core/dictionary-service.js';
import { DetectionService } from '../core/detection-service.js';
import { ensureStateTemplates } from '../core/init.js';
import { extractCommonSubstring } from '../utils/nlp.js';
import { SystemLogger } from '../core/system-logger.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { initPersistence, flushAllSessions } from '../core/session-tracker.js';
import { acquireLockAsync, releaseLock, type LockContext } from '../utils/file-lock.js';

let intervalId: NodeJS.Timeout | null = null;

export interface EvolutionQueueItem {
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
    status: 'pending' | 'in_progress' | 'completed';
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

export async function acquireQueueLock(resourcePath: string, logger: any, lockSuffix: string = EVOLUTION_QUEUE_LOCK_SUFFIX): Promise<() => void> {
    try {
        const ctx: LockContext = await acquireLockAsync(resourcePath, {
            lockSuffix,
            maxRetries: LOCK_MAX_RETRIES,
            baseRetryDelayMs: LOCK_RETRY_DELAY_MS,
            lockStaleMs: LOCK_STALE_MS,
        });
        return () => releaseLock(ctx);
    } catch (error) {
        logger?.warn?.(`[PD:EvolutionWorker] Failed to acquire lock for ${resourcePath}: ${String(error)}`);
        throw error;
    }
}

async function requireQueueLock(resourcePath: string, logger: any, scope: string, lockSuffix: string = EVOLUTION_QUEUE_LOCK_SUFFIX): Promise<() => void> {
    try {
        return await acquireQueueLock(resourcePath, logger, lockSuffix);
    } catch {
        throw new Error(`[PD:EvolutionWorker] ${scope}: queue lock unavailable for ${resourcePath}`);
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

async function checkPainFlag(wctx: WorkspaceContext, logger: any) {
    try {
        const painFlagPath = wctx.resolve('PAIN_FLAG');
        if (!fs.existsSync(painFlagPath)) return;

        const rawPain = fs.readFileSync(painFlagPath, 'utf8');
        const lines = rawPain.split('\n');
        
        let score = 0;
        let source = 'unknown';
        let reason = 'Systemic pain detected';
        let preview = '';
        let isQueued = false;

        for (const line of lines) {
            if (line.startsWith('score:')) score = parseInt(line.split(':', 2)[1].trim(), 10) || 0;
            if (line.startsWith('source:')) source = line.split(':', 2)[1].trim();
            if (line.startsWith('reason:')) reason = line.slice('reason:'.length).trim();
            if (line.startsWith('trigger_text_preview:')) preview = line.slice('trigger_text_preview:'.length).trim();
            if (line.startsWith('status: queued')) isQueued = true;
        }

        if (isQueued || score < 30) return;

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
                return;
            }

            const taskId = createEvolutionTaskId(source, score, preview, reason, now);
            queue.push({
                id: taskId,
                score,
                source,
                reason,
                trigger_text_preview: preview,
                timestamp: new Date(now).toISOString(),
                enqueued_at: new Date(now).toISOString(),
                status: 'pending'
            });

            fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
            fs.appendFileSync(painFlagPath, `\nstatus: queued\ntask_id: ${taskId}\n`, 'utf8');
        } finally {
            releaseLock();
        }

    } catch (err) {
        if (logger) logger.warn(`[PD:EvolutionWorker] Error processing pain flag: ${String(err)}`);
    }
}

async function processEvolutionQueue(wctx: WorkspaceContext, logger: any, eventLog: any) {
    const queuePath = wctx.resolve('EVOLUTION_QUEUE');
    if (!fs.existsSync(queuePath)) return;
    const directivePath = wctx.resolve('EVOLUTION_DIRECTIVE');

    const releaseLock = await requireQueueLock(queuePath, logger, 'processEvolutionQueue');

    try {
        let queue: EvolutionQueueItem[] = [];
        try {
            queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
        } catch (e) {
            if (logger) logger.error(`[PD:EvolutionWorker] Failed to parse evolution queue: ${String(e)}`);
            return;
        }

        let queueChanged = false;

        const config = wctx.config;
        const timeout = config.get('intervals.task_timeout_ms') || (30 * 60 * 1000);

        for (const task of queue) {
            if (task.status === 'in_progress' && task.timestamp) {
                const startedAt = task.started_at || task.timestamp;
                const age = Date.now() - new Date(startedAt).getTime();
                if (age > timeout) {
                    if (logger) logger.info(`[PD:EvolutionWorker] Resetting timed-out task: ${task.id}`);
                    task.status = 'pending';
                    delete task.started_at;
                    delete task.assigned_session_key;
                    queueChanged = true;
                }
            }
        }

        const pendingTasks = queue.filter(t => t.status === 'pending');

        if (pendingTasks.length > 0) {
            const highestScoreTask = pendingTasks.sort((a, b) => b.score - a.score)[0];
            const nowIso = new Date().toISOString();

            const taskDescription = `Diagnose systemic pain [ID: ${highestScoreTask.id}]. Source: ${highestScoreTask.source}. Reason: ${highestScoreTask.reason}. ` +
                  `Trigger text: "${highestScoreTask.trigger_text_preview || 'N/A'}"`;
            highestScoreTask.task = taskDescription;
            highestScoreTask.status = 'in_progress';
            highestScoreTask.started_at = nowIso;
            delete highestScoreTask.completed_at;
            delete highestScoreTask.assigned_session_key;
            queueChanged = true;

            if (eventLog) {
                eventLog.recordEvolutionTask({
                    taskId: highestScoreTask.id,
                    taskType: highestScoreTask.source,
                    reason: highestScoreTask.reason
                });
            }

            fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
            queueChanged = false;

            const directive = {
                active: true,
                taskId: highestScoreTask.id,
                task: taskDescription,
                timestamp: nowIso
            };

            fs.writeFileSync(directivePath, JSON.stringify(directive, null, 2), 'utf8');
        } else {
            const hasInProgressTask = queue.some((task) => task.status === 'in_progress');
            if (!hasInProgressTask && fs.existsSync(directivePath)) {
                const clearedAt = new Date().toISOString();
                fs.writeFileSync(
                    directivePath,
                    JSON.stringify({
                        active: false,
                        task: null,
                        taskId: null,
                        timestamp: clearedAt,
                        clearedAt,
                    }, null, 2),
                    'utf8'
                );
            }
        }

        if (queueChanged) {
            fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
        }
    } catch (err) {
        if (logger) logger.warn(`[PD:EvolutionWorker] Error processing evolution queue: ${String(err)}`);
    } finally {
        releaseLock();
    }
}

async function processDetectionQueue(wctx: WorkspaceContext, api: OpenClawPluginApi, eventLog: any) {
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
                try {
                    const searchTool = api.runtime.tools?.createMemorySearchTool?.({ config: api.config });
                    if (searchTool) {
                        const searchResult = await searchTool.execute('pre-emptive-pain-check', {
                            query: text,
                            limit: 1,
                            threshold: 0.85
                        });

                        if (searchResult && searchResult.results?.length > 0) {
                            const hit = searchResult.results[0];
                            if (logger) logger.info?.(`[PD:EvolutionWorker] L3 Semantic Hit: ${hit.id} (Score: ${hit.score})`);
                            
                            funnel.updateCache(text, { detected: true, severity: 40 });
                            if (eventLog) {
                                eventLog.recordRuleMatch(undefined, {
                                    ruleId: 'SEMANTIC_HIT',
                                    layer: 'L3',
                                    severity: 40,
                                    textPreview: text.substring(0, 100)
                                });
                            }
                        }
                    }
                } catch (e) {
                    if (logger) logger.debug?.(`[PD:EvolutionWorker] L3 Semantic search failed: ${String(e)}`);
                }
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
        let data = { candidates: {} as any };
        if (fs.existsSync(candidatePath)) {
            try {
                data = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
            } catch (e) {
                // Keep going with empty data if parse fails, but log it
                console.error(`[PD:EvolutionWorker] Failed to parse pain candidates: ${String(e)}`);
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

export async function processPromotion(wctx: WorkspaceContext, logger: any, eventLog: any) {
    const candidatePath = wctx.resolve('PAIN_CANDIDATES');
    if (!fs.existsSync(candidatePath)) return;

    const releaseLock = await requireQueueLock(candidatePath, logger, 'processPromotion', PAIN_CANDIDATES_LOCK_SUFFIX);

    try {
        const config = wctx.config;
        const dictionary = wctx.dictionary;
        const data = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
        const countThreshold = config.get('thresholds.promotion_count_threshold') || 3;

        let promotedCount = 0;
        let changed = false;

        for (const [fingerprint, cand] of Object.entries(data.candidates) as any) {
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

                    if (hasEquivalentPromotedRule(dictionary as any, phrase)) {
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
        const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8')) as EvolutionQueueItem[];
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

export interface ExtendedEvolutionWorkerService {
    id: string;
    api: OpenClawPluginApi | null;
    start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
    stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
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
                await checkPainFlag(wctx, logger);
                await processEvolutionQueue(wctx, logger, eventLog);
                if (api) {
                    await processDetectionQueue(wctx, api, eventLog);
                }
                await processPromotion(wctx, logger, eventLog);
                wctx.dictionary.flush();
                flushAllSessions();
            })().catch((err) => {
                if (logger) logger.error(`[PD:EvolutionWorker] Error in worker interval: ${String(err)}`);
            });
        }, interval);

        setTimeout(() => {
            void (async () => {
                await checkPainFlag(wctx, logger);
                await processEvolutionQueue(wctx, logger, eventLog);
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
        flushAllSessions();
    }
};
