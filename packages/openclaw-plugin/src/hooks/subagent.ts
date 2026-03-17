import { PluginHookSubagentEndedEvent, PluginHookAgentContext } from '../openclaw-sdk.js';
import { writePainFlag } from '../core/pain.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import * as fs from 'fs';
import * as path from 'path';

export async function handleSubagentEnded(
    event: PluginHookSubagentEndedEvent,
    ctx: PluginHookAgentContext
): Promise<void> {
    const { outcome, targetSessionKey } = event;
    const workspaceDir = ctx.workspaceDir;

    if (!workspaceDir) return;

    const wctx = WorkspaceContext.fromHookContext(ctx);
    const config = wctx.config;

    // 1. Autonomous Pain Capture: If subagent failed, record pain
    if (outcome === 'error' || outcome === 'timeout') {
        const scoreSettings = config.get('scores');
        const score = outcome === 'error' ? scoreSettings.subagent_error_penalty : scoreSettings.subagent_timeout_penalty;
        
        writePainFlag(workspaceDir, {
            source: `subagent_${outcome}`,
            score: String(score),
            time: new Date().toISOString(),
            reason: `Subagent session ${targetSessionKey} ended with outcome: ${outcome}`,
            is_risky: 'true'
        });
    }

    // 2. Loop Closure: Clean up evolution queue if any subagent finished successfully
    if (outcome === 'ok' || outcome === 'deleted') {
        // ── Trust Engine: Record success using V2 API ──
        wctx.trust.recordSuccess('subagent_success', {
            sessionId: ctx.sessionId,
            api: (ctx as any).api
        }, true);

        const queuePath = wctx.resolve('EVOLUTION_QUEUE');
        if (fs.existsSync(queuePath)) {
            try {
                const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
                let changed = false;
                
                // Find in_progress tasks
                const inProgressTasks = queue.filter((t: any) => t.status === 'in_progress');
                if (inProgressTasks.length > 0) {
                    const resolveTaskTime = (task: any): number => {
                        const raw = task?.enqueued_at || task?.timestamp;
                        const ts = new Date(raw).getTime();
                        return Number.isFinite(ts) ? ts : Number.MAX_SAFE_INTEGER;
                    };

                    // Sort by enqueue timestamp (fallback to legacy timestamp) to find the oldest task
                    const oldestTask = inProgressTasks.sort((a: any, b: any) => 
                        resolveTaskTime(a) - resolveTaskTime(b)
                    )[0];

                    // Mark as completed
                    const taskIndex = queue.findIndex((t: any) => t.id === oldestTask.id);
                    if (taskIndex !== -1) {
                        queue[taskIndex].status = 'completed';
                        queue[taskIndex].completed_at = new Date().toISOString();
                        changed = true;

                        // Clean up the .pain_flag if it was queued, to reset the environment
                        const painFlagPath = wctx.resolve('PAIN_FLAG');
                        if (fs.existsSync(painFlagPath)) {
                            try {
                                const painData = fs.readFileSync(painFlagPath, 'utf8');
                                if (painData.includes('status: queued')) {
                                    fs.unlinkSync(painFlagPath);
                                }
                            } catch (e) {
                                console.error(`[PD:Subagent] Failed to cleanup pain flag: ${String(e)}`);
                            }
                        }
                    }
                }
                
                if (changed) {
                    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
                }
            } catch (e) {
                console.error(`[PD:Subagent] Failed to update evolution queue: ${String(e)}`);
            }
        }
    }
}
