import type { PluginHookSubagentEndedEvent, PluginHookSubagentContext } from '../openclaw-sdk.js';
import { writePainFlag } from '../core/pain.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { empathyObserverManager, type EmpathyObserverApi } from '../service/empathy-observer-manager.js';
import * as fs from 'fs';
import * as path from 'path';



function emitSubagentPainEvent(
    wctx: WorkspaceContext,
    payload: {
        source: string;
        reason: string;
        score: number;
        sessionId?: string;
    }
): void {
    try {
        wctx.evolutionReducer.emitSync({
            ts: new Date().toISOString(),
            type: 'pain_detected',
            data: {
                painId: `pain_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
                painType: 'subagent_error',
                source: payload.source,
                reason: payload.reason,
                score: payload.score,
                sessionId: payload.sessionId,
            },
        });
    } catch (e) {
        console.warn(`[PD:Subagent] failed to emit evolution event: ${String(e)}`);
    }
}

type SubagentEndedHookContext = PluginHookSubagentContext & {
    api?: EmpathyObserverApi;
    workspaceDir?: string;
    sessionId?: string;
};

export async function handleSubagentEnded(
    event: PluginHookSubagentEndedEvent,
    ctx: SubagentEndedHookContext
): Promise<void> {
    const { outcome, targetSessionKey } = event;
    const workspaceDir = ctx.workspaceDir;

    if (!workspaceDir) return;

    const wctx = WorkspaceContext.fromHookContext(ctx);
    // Empathy observer subagent session is handled by sidecar manager
    if (targetSessionKey?.startsWith('empathy_obs:')) {
        await empathyObserverManager.reap(ctx.api, targetSessionKey, workspaceDir);
        return;
    }

    const config = wctx.config;

    // 1. Autonomous Pain Capture: If subagent failed, record pain
    if (outcome === 'error' || outcome === 'timeout') {
        const scoreSettings = config.get('scores');
        const score = outcome === 'error' ? scoreSettings.subagent_error_penalty : scoreSettings.subagent_timeout_penalty;
        const reason = `Subagent session ${targetSessionKey} ended with outcome: ${outcome}`;

        writePainFlag(workspaceDir, {
            source: `subagent_${outcome}`,
            score: String(score),
            time: new Date().toISOString(),
            reason,
            is_risky: 'true'
        });

        emitSubagentPainEvent(wctx, {
            source: `subagent_${outcome}`,
            reason,
            score,
            sessionId: ctx.sessionId,
        });
    }

    // 2. Loop Closure: Clean up evolution queue if any subagent finished successfully
    if (outcome === 'ok' || outcome === 'deleted') {
        // ── Trust Engine: Record success using V2 API ──
        wctx.trust.recordSuccess('subagent_success', {
            sessionId: ctx.sessionId,
            api: ctx.api
        }, true);

        const queuePath = wctx.resolve('EVOLUTION_QUEUE');
        if (fs.existsSync(queuePath)) {
            try {
                const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
                let changed = false;

                const resolveTaskTime = (task: any): number => {
                    const raw = task?.enqueued_at || task?.timestamp;
                    const ts = new Date(raw).getTime();
                    return Number.isFinite(ts) ? ts : Number.MAX_SAFE_INTEGER;
                };

                // Resolve the queue entry by its position, not by id. Historical pain
                // records may legitimately share the same id in legacy data.
                let oldestTaskIndex = -1;
                let oldestTaskTime = Number.MAX_SAFE_INTEGER;
                queue.forEach((task: any, index: number) => {
                    if (task?.status !== 'in_progress') return;
                    const taskTime = resolveTaskTime(task);
                    if (taskTime < oldestTaskTime) {
                        oldestTaskTime = taskTime;
                        oldestTaskIndex = index;
                    }
                });

                if (oldestTaskIndex !== -1) {
                    queue[oldestTaskIndex].status = 'completed';
                    queue[oldestTaskIndex].completed_at = new Date().toISOString();
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
                
                if (changed) {
                    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
                }
            } catch (e) {
                console.error(`[PD:Subagent] Failed to update evolution queue: ${String(e)}`);
            }
        }
    }
}
