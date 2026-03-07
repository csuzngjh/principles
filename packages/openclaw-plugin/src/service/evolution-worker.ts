import * as fs from 'fs';
import * as path from 'path';
import type { OpenClawPluginServiceContext } from '../openclaw-sdk.js';

let intervalId: NodeJS.Timeout | null = null;

// A simple structure to hold our queue
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

        // If it's already queued or score is too low, do nothing
        if (isQueued || score < 30) return;

        logger.info(`[PD:EvolutionWorker] Detected pain flag (score: ${score}, source: ${source}). Enqueueing evolution task.`);

        const queuePath = path.join(workspaceDir, 'docs', 'evolution_queue.json');
        let queue: EvolutionQueueItem[] = [];
        if (fs.existsSync(queuePath)) {
            try {
                queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
            } catch (e) {
                // start fresh if corrupted
            }
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

        // Ensure dir exists
        const dir = path.dirname(queuePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');

        // Mark pain flag as queued so we don't pick it up again
        fs.appendFileSync(painFlagPath, '\nstatus: queued\n', 'utf8');

    } catch (err) {
        logger.warn(`[PD:EvolutionWorker] Error processing pain flag: ${err instanceof Error ? err.message : String(err)}`);
    }
}

function processEvolutionQueue(workspaceDir: string, stateDir: string, logger: any) {
    const queuePath = path.join(workspaceDir, 'docs', 'evolution_queue.json');
    if (!fs.existsSync(queuePath)) return;

    try {
        const queue: EvolutionQueueItem[] = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
        const pendingTasks = queue.filter(t => t.status === 'pending');

        if (pendingTasks.length > 0) {
            // Write a directive file to the stateDir that the before_prompt_build hook will pick up
            const directivePath = path.join(stateDir, 'evolution_directive.json');

            const highestScoreTask = pendingTasks.sort((a, b) => b.score - a.score)[0];

            const directive = {
                active: true,
                task: `Diagnose systemic pain [ID: ${highestScoreTask.id}]. Source: ${highestScoreTask.source}. Reason: ${highestScoreTask.reason}. ` +
                    (highestScoreTask.trigger_text_preview ? `Trigger Text: "${highestScoreTask.trigger_text_preview}"` : ''),
                enqueuedAt: highestScoreTask.timestamp,
            };

            // Ensure stateDir exists
            if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
            fs.writeFileSync(directivePath, JSON.stringify(directive, null, 2), 'utf8');

            // We don't mark it in_progress here; the user prompt hook will do that when it injects it
        }
    } catch (err) {
        // Non-critical
    }
}

export const EvolutionWorkerService = {
    id: 'principles-evolution-worker',

    start(ctx: OpenClawPluginServiceContext): void {
        ctx.logger.info(`[PD:EvolutionWorker] Starting background autonomous evolution service...`);

        // Then poll every 15 minutes
        intervalId = setInterval(() => {
            if (!ctx.workspaceDir) return;
            checkPainFlag(ctx.workspaceDir, ctx.logger);
            processEvolutionQueue(ctx.workspaceDir, ctx.stateDir, ctx.logger);
        }, 15 * 60 * 1000);

        // Do a gentle initial check after 5 seconds
        setTimeout(() => {
            if (ctx.workspaceDir) {
                checkPainFlag(ctx.workspaceDir, ctx.logger);
                processEvolutionQueue(ctx.workspaceDir, ctx.stateDir, ctx.logger);
            }
        }, 5000);
    },

    stop(ctx: OpenClawPluginServiceContext): void {
        ctx.logger.info(`[PD:EvolutionWorker] Stopping background service...`);
        if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
        }
    }
};
