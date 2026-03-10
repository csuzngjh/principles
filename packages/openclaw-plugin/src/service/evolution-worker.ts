import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { OpenClawPluginServiceContext, OpenClawPluginApi } from '../openclaw-sdk.js';
import { DictionaryService } from '../core/dictionary-service.js';
import { ConfigService } from '../core/config-service.js';
import { DetectionService } from '../core/detection-service.js';
import { ensureStateTemplates } from '../core/init.js';
import { extractCommonSubstring } from '../utils/nlp.js';
import { SystemLogger } from '../core/system-logger.js';
import { EventLogService } from '../core/event-log.js';
import { initPersistence, flushAllSessions } from '../core/session-tracker.js';

let intervalId: NodeJS.Timeout | null = null;

interface EvolutionQueueItem {
    id: string;
    source: string;
    score: number;
    reason: string;
    timestamp: string;
    trigger_text_preview?: string;
    status: 'pending' | 'in_progress' | 'completed';
}

function checkPainFlag(workspaceDir: string, logger: any) {
    const painFlagPath = path.join(workspaceDir, 'docs', '.pain_flag');
    if (!fs.existsSync(painFlagPath)) return;

    try {
        const rawPain = fs.readFileSync(painFlagPath, 'utf8');
        const lines = rawPain.split('\n');
        let score = 0;
        let source = 'unknown';
        let reason = '';
        let isQueued = false;
        let preview = '';

        for (const line of lines) {
            if (line.startsWith('score:')) score = parseInt(line.split(':', 2)[1].trim(), 10) || 0;
            if (line.startsWith('source:')) source = line.split(':', 2)[1].trim();
            if (line.startsWith('reason:')) reason = line.slice('reason:'.length).trim();
            if (line.startsWith('trigger_text_preview:')) preview = line.slice('trigger_text_preview:'.length).trim();
            if (line.startsWith('status: queued')) isQueued = true;
        }

        if (isQueued || score < 30) return;

        logger.info(`[PD:EvolutionWorker] Detected pain flag (score: ${score}, source: ${source}). Enqueueing evolution task.`);

        const queuePath = path.join(workspaceDir, 'docs', 'evolution_queue.json');
        let queue: EvolutionQueueItem[] = [];
        if (fs.existsSync(queuePath)) {
            try {
                queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
            } catch (e) { }
        }

        const newTask: EvolutionQueueItem = {
            id: `evt-${Date.now()}`,
            source,
            score,
            reason,
            timestamp: new Date().toISOString(),
            trigger_text_preview: preview,
            status: 'pending'
        };

        queue.push(newTask);
        const dir = path.dirname(queuePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
        fs.appendFileSync(painFlagPath, '\nstatus: queued\n', 'utf8');

        logger.info(`[PD:EvolutionWorker] Task ${newTask.id} successfully enqueued to ${queuePath}.`);
    } catch (err) {
        logger.warn(`[PD:EvolutionWorker] Error processing pain flag: ${String(err)}`);
    }
}

function processEvolutionQueue(workspaceDir: string, stateDir: string, logger: any, eventLog: any) {
    const queuePath = path.join(workspaceDir, 'docs', 'evolution_queue.json');
    if (!fs.existsSync(queuePath)) return;

    try {
        const queue: EvolutionQueueItem[] = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
        const pendingTasks = queue.filter(t => t.status === 'pending');

        if (pendingTasks.length > 0) {
            const directivePath = path.join(stateDir, 'evolution_directive.json');
            const highestScoreTask = pendingTasks.sort((a, b) => b.score - a.score)[0];

            const directive = {
                active: true,
                task: `Diagnose systemic pain [ID: ${highestScoreTask.id}]. Source: ${highestScoreTask.source}. Reason: ${highestScoreTask.reason}. ` +
                    (highestScoreTask.trigger_text_preview ? `Trigger Text: "${highestScoreTask.trigger_text_preview}"` : ''),
                enqueuedAt: highestScoreTask.timestamp,
            };

            if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
            fs.writeFileSync(directivePath, JSON.stringify(directive, null, 2), 'utf8');

            // CRITICAL: Mark as in_progress to prevent infinite loop
            highestScoreTask.status = 'in_progress';
            fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');

            logger.info(`[PD:EvolutionWorker] Evolution directive generated in ${directivePath}. Model will pick this up for next task.`);

            // Record evolution task event
            eventLog.recordEvolutionTask({
                taskId: highestScoreTask.id,
                taskType: highestScoreTask.source,
                reason: highestScoreTask.reason,
            });
        }
    } catch (err) { }
}

async function processDetectionQueue(stateDir: string, api: any, eventLog: any) {
    const funnel = DetectionService.get(stateDir);
    const queue = funnel.flushQueue();
    if (queue.length === 0) return;

    const logger = api.logger;
    logger.info(`[PD:EvolutionWorker] Processing ${queue.length} items in semantic detection queue...`);

    const searchTool = api.runtime?.tools?.createMemorySearchTool?.({
        config: api.config,
    });

    if (!searchTool) {
        logger.warn('[PD:EvolutionWorker] memory_search tool not available. Semantic detection skipped.');
        return;
    }

    for (const text of queue) {
        try {
            const config = ConfigService.get(stateDir);
            const minScore = config.get('thresholds.semantic_min_score') || 0.7;

            const result = await searchTool.execute('internal-l3-check', {
                query: text,
                minScore,
                maxResults: 3
            });

            const results = (result as any)?.results || [];
            if (results.length > 0) {
                const bestMatch = results[0];
                logger.info(`[PD:EvolutionWorker] Semantic hit! Score: ${bestMatch.score}. Text: "${text.substring(0, 50)}..."`);

                funnel.updateCache(text, {
                    detected: true,
                    severity: config.get('scores.default_confusion') || 35
                });

                recordCandidate(stateDir, text, bestMatch);
            } else {
                funnel.updateCache(text, { detected: false });
            }
        } catch (err) {
            logger.warn(`[PD:EvolutionWorker] Error in semantic search for text: ${String(err)}`);
        }
    }
}

function recordCandidate(stateDir: string, text: string, match: any) {
    const candidatePath = path.join(stateDir, 'pain_candidates.json');
    let data: any = { candidates: {} };
    if (fs.existsSync(candidatePath)) {
        try {
            data = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
        } catch (e) { }
    }

    const fingerprint = createHash('sha256').update(text.trim()).digest('hex').substring(0, 12);

    if (!data.candidates[fingerprint]) {
        data.candidates[fingerprint] = {
            samples: [],
            count: 0,
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            avgSimilarity: 0,
            status: 'pending'
        };
    }

    const cand = data.candidates[fingerprint];
    if (!cand.samples.includes(text) && cand.samples.length < 5) {
        cand.samples.push(text);
    }
    cand.count++;
    cand.lastSeen = new Date().toISOString();
    cand.avgSimilarity = (cand.avgSimilarity * (cand.count - 1) + match.score) / cand.count;

    fs.writeFileSync(candidatePath, JSON.stringify(data, null, 2), 'utf8');
}

function processPromotion(stateDir: string, logger: any, eventLog: any) {
    const candidatePath = path.join(stateDir, 'pain_candidates.json');
    if (!fs.existsSync(candidatePath)) return;

    try {
        const config = ConfigService.get(stateDir);
        const dictionary = DictionaryService.get(stateDir);
        const data = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
        const countThreshold = config.get('thresholds.promotion_count_threshold') || 3;
        const simThreshold = config.get('thresholds.promotion_similarity_threshold') || 0.8;

        let promotedCount = 0;

        for (const [fingerprint, cand] of Object.entries(data.candidates) as any) {
            if (cand.status === 'pending' && cand.count >= countThreshold && cand.avgSimilarity >= simThreshold) {
                // Perform N-gram extraction
                const commonPhrases = extractCommonSubstring(cand.samples);

                if (commonPhrases.length > 0) {
                    const phrase = commonPhrases[0];
                    const ruleId = `P_PROMOTED_${fingerprint.toUpperCase()}`;

                    logger.info(`[PD:EvolutionWorker] Promoting candidate ${fingerprint} to formal rule: ${ruleId} (Phrase: "${phrase}")`);
                    SystemLogger.log(stateDir.replace(/\/memory\/\.state$/, ''), 'RULE_PROMOTED', `Candidate ${fingerprint} promoted to formal rule ${ruleId} based on ${cand.count} hits.`);

                    dictionary.addRule(ruleId, {
                        type: 'exact_match',
                        phrases: [phrase],
                        severity: config.get('scores.default_confusion') || 35,
                        status: 'active'
                    });

                    cand.status = 'promoted';
                    cand.promotedTo = ruleId;
                    promotedCount++;

                    // Record rule promotion event
                    eventLog.recordRulePromotion({
                        ruleId,
                        phrase,
                        count: cand.count,
                        avgSimilarity: cand.avgSimilarity,
                        fingerprint,
                    });
                }
            }
        }

        if (promotedCount > 0) {
            fs.writeFileSync(candidatePath, JSON.stringify(data, null, 2), 'utf8');
            dictionary.flush();
        }
    } catch (err) {
        logger.warn(`[PD:EvolutionWorker] Error during rule promotion: ${String(err)}`);
    }
}

export interface ExtendedEvolutionWorkerService {
    id: string;
    api?: OpenClawPluginApi;
    start: (ctx: OpenClawPluginServiceContext) => void;
    stop: (ctx: OpenClawPluginServiceContext) => void;
}

export const EvolutionWorkerService: ExtendedEvolutionWorkerService = {
    id: 'principles-evolution-worker',

    start(ctx: OpenClawPluginServiceContext): void {
        const { workspaceDir, logger } = ctx;
        const api = this.api;

        // Use workspace-specific state directory, not global ~/.openclaw/
        // This ensures Service and Hooks use the same stateDir
        const stateDir = workspaceDir
            ? path.join(workspaceDir, 'memory', '.state')
            : ctx.stateDir;

        logger.info(`[PD:EvolutionWorker] Starting with workspaceDir=${workspaceDir}, stateDir=${stateDir}`);

        // Initialize persistence and event logging
        initPersistence(stateDir);
        const eventLog = EventLogService.get(stateDir, {
            info: (msg) => logger.info(msg),
            warn: (msg) => logger.warn(msg),
            error: (msg) => logger.error(msg),
            debug: (msg) => logger.debug?.(msg)
        });

        const config = ConfigService.get(stateDir);
        const language = config.get('language') || 'en';

        ensureStateTemplates({ logger }, stateDir, language);
        const dictionary = DictionaryService.get(stateDir);

        const pollInterval = config.get('intervals.worker_poll_ms') || (15 * 60 * 1000);
        const initialDelay = config.get('intervals.initial_delay_ms') || 5000;

        intervalId = setInterval(() => {
            if (workspaceDir) {
                checkPainFlag(workspaceDir, logger);
                processEvolutionQueue(workspaceDir, stateDir, logger, eventLog);
            }
            if (api) {
                processDetectionQueue(stateDir, api, eventLog).catch(err => {
                    logger.error(`[PD:EvolutionWorker] Error in detection queue: ${String(err)}`);
                });
            }
            processPromotion(stateDir, logger, eventLog);
            dictionary.flush();

            // Periodically flush event log
            eventLog.flush();
            flushAllSessions();
        }, pollInterval);

        setTimeout(() => {
            if (workspaceDir) {
                checkPainFlag(workspaceDir, logger);
                processEvolutionQueue(workspaceDir, stateDir, logger, eventLog);
            }
            if (api) {
                processDetectionQueue(stateDir, api, eventLog).catch(() => { });
            }
            processPromotion(stateDir, logger, eventLog);
        }, initialDelay);
    },

    stop(ctx: OpenClawPluginServiceContext): void {
        ctx.logger.info(`[PD:EvolutionWorker] Stopping background service...`);
        if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
        }

        if (ctx.stateDir) {
            DictionaryService.get(ctx.stateDir).flush();

            // Flush event log and sessions
            EventLogService.get(ctx.stateDir).flush();
            flushAllSessions();
        }
    }
};
