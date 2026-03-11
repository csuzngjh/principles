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

let intervalId: NodeJS.Timeout | null = null;

export interface EvolutionQueueItem {
    id: string;
    score: number;
    source: string;
    reason: string;
    timestamp: string;
    trigger_text_preview?: string;
    status: 'pending' | 'in_progress' | 'completed';
}

function checkPainFlag(wctx: WorkspaceContext, logger: any) {
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
        let queue: EvolutionQueueItem[] = [];
        if (fs.existsSync(queuePath)) {
            try {
                queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
            } catch (e) { }
        }

        const taskId = createHash('md5').update(`${source}:${score}:${new Date().toISOString()}`).digest('hex').substring(0, 8);
        queue.push({
            id: taskId,
            score,
            source,
            reason,
            trigger_text_preview: preview,
            timestamp: new Date().toISOString(),
            status: 'pending'
        });

        fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
        fs.appendFileSync(painFlagPath, '\nstatus: queued\n', 'utf8');

    } catch (err) {
        if (logger) logger.warn(`[PD:EvolutionWorker] Error processing pain flag: ${String(err)}`);
    }
}

function processEvolutionQueue(wctx: WorkspaceContext, logger: any, eventLog: any) {
    try {
        const queuePath = wctx.resolve('EVOLUTION_QUEUE');
        if (!fs.existsSync(queuePath)) return;

        const queue: EvolutionQueueItem[] = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
        let queueChanged = false;

        const config = wctx.config;
        const timeout = config.get('intervals.task_timeout_ms') || (30 * 60 * 1000);

        for (const task of queue) {
            if (task.status === 'in_progress' && task.timestamp) {
                const age = Date.now() - new Date(task.timestamp).getTime();
                if (age > timeout) {
                    if (logger) logger.info(`[PD:EvolutionWorker] Resetting timed-out task: ${task.id}`);
                    task.status = 'pending';
                    queueChanged = true;
                }
            }
        }

        const pendingTasks = queue.filter(t => t.status === 'pending');

        if (pendingTasks.length > 0) {
            const directivePath = wctx.resolve('EVOLUTION_DIRECTIVE');
            const highestScoreTask = pendingTasks.sort((a, b) => b.score - a.score)[0];

            const directive = {
                active: true,
                task: `Diagnose systemic pain [ID: ${highestScoreTask.id}]. Source: ${highestScoreTask.source}. Reason: ${highestScoreTask.reason}. ` +
                      `Trigger text: "${highestScoreTask.trigger_text_preview || 'N/A'}"`,
                timestamp: new Date().toISOString()
            };

            fs.writeFileSync(directivePath, JSON.stringify(directive, null, 2), 'utf8');
            highestScoreTask.status = 'in_progress';
            queueChanged = true;
            
            if (eventLog) {
                eventLog.recordEvolutionTask({
                    taskId: highestScoreTask.id,
                    taskType: highestScoreTask.source,
                    reason: highestScoreTask.reason
                });
            }
        }

        if (queueChanged) {
            fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
        }
    } catch (err) {
        if (logger) logger.warn(`[PD:EvolutionWorker] Error processing evolution queue: ${String(err)}`);
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
                trackPainCandidate(text, wctx);
            }
        }
    } catch (err) {
        if (logger) logger.warn(`[PD:EvolutionWorker] Detection queue failed: ${String(err)}`);
    }
}

function trackPainCandidate(text: string, wctx: WorkspaceContext) {
    const candidatePath = wctx.resolve('PAIN_CANDIDATES');
    let data = { candidates: {} as any };
    if (fs.existsSync(candidatePath)) {
        try { data = JSON.parse(fs.readFileSync(candidatePath, 'utf8')); } catch (e) { }
    }

    const fingerprint = createHash('md5').update(text.substring(0, 50)).digest('hex').substring(0, 8);
    if (!data.candidates[fingerprint]) {
        data.candidates[fingerprint] = { count: 0, firstSeen: new Date().toISOString(), samples: [] };
    }

    const cand = data.candidates[fingerprint];
    cand.count++;
    if (cand.samples.length < 5) cand.samples.push(text.substring(0, 200));
    
    fs.writeFileSync(candidatePath, JSON.stringify(data, null, 2), 'utf8');
}

function processPromotion(wctx: WorkspaceContext, logger: any, eventLog: any) {
    const candidatePath = wctx.resolve('PAIN_CANDIDATES');
    if (!fs.existsSync(candidatePath)) return;

    try {
        const config = wctx.config;
        const dictionary = wctx.dictionary;
        const data = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
        const countThreshold = config.get('thresholds.promotion_count_threshold') || 3;

        let promotedCount = 0;

        for (const [fingerprint, cand] of Object.entries(data.candidates) as any) {
            if (cand.status === 'pending' && cand.count >= countThreshold) {
                const commonPhrases = extractCommonSubstring(cand.samples);

                if (commonPhrases.length > 0) {
                    const phrase = commonPhrases[0];
                    const ruleId = `P_PROMOTED_${fingerprint.toUpperCase()}`;

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
                }
            }
        }

        if (promotedCount > 0) {
            fs.writeFileSync(candidatePath, JSON.stringify(data, null, 2), 'utf8');
        }
    } catch (err) {
        if (logger) logger.warn(`[PD:EvolutionWorker] Error during rule promotion: ${String(err)}`);
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
            checkPainFlag(wctx, logger);
            processEvolutionQueue(wctx, logger, eventLog);
            if (api) {
                processDetectionQueue(wctx, api, eventLog).catch(err => {
                    if (logger) logger.error(`[PD:EvolutionWorker] Error in detection queue: ${String(err)}`);
                });
            }
            processPromotion(wctx, logger, eventLog);
            wctx.dictionary.flush();
            flushAllSessions();
        }, interval);

        setTimeout(() => {
            checkPainFlag(wctx, logger);
            processEvolutionQueue(wctx, logger, eventLog);
            if (api) {
                processDetectionQueue(wctx, api, eventLog).catch(() => { });
            }
            processPromotion(wctx, logger, eventLog);
        }, initialDelay);
    },

    stop(ctx: OpenClawPluginServiceContext): void {
        if (ctx?.logger) ctx.logger.info('[PD:EvolutionWorker] Stopping background service...');
        if (intervalId) clearInterval(intervalId);
        flushAllSessions();
    }
};
