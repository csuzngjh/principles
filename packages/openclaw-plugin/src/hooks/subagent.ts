import type { PluginHookSubagentEndedEvent, PluginHookSubagentContext } from '../openclaw-sdk.js';
import * as fs from 'fs';
import { writePainFlag } from '../core/pain.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { empathyObserverManager, type EmpathyObserverApi } from '../service/empathy-observer-manager.js';
import { acquireQueueLock } from '../service/evolution-worker.js';

const COMPLETION_RETRY_DELAY_MS = 250;
const COMPLETION_MAX_RETRIES = 3;
const COMPLETION_RETRY_TTL_MS = 60 * 60 * 1000; // 1 hour TTL for retry entries
const TASK_OUTCOME_RETRY_DELAY_MS = 250;
const TASK_OUTCOME_MAX_RETRIES = 3;
const DIAGNOSTICIAN_SESSION_PREFIX = 'agent:diagnostician:';
const completionRetryCounts = new Map<string, { count: number; expires: number }>();

// Cleanup expired retry entries periodically
function cleanupExpiredRetryEntries(): void {
    const now = Date.now();
    for (const [key, value] of completionRetryCounts.entries()) {
        if (now > value.expires) {
            completionRetryCounts.delete(key);
        }
    }
}

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

function isDiagnosticianSession(targetSessionKey: string | undefined): boolean {
    return typeof targetSessionKey === 'string' && targetSessionKey.startsWith(DIAGNOSTICIAN_SESSION_PREFIX);
}

function cleanupPainFlagForTask(wctx: WorkspaceContext, completedTaskId: string, queue: any[]): void {
    const painFlagPath = wctx.resolve('PAIN_FLAG');

    try {
        const painData = fs.readFileSync(painFlagPath, 'utf8');
        const taskIdMatch = painData.match(/^task_id:\s*(.+)$/m);
        const painTaskId = taskIdMatch?.[1]?.trim();
        const hasQueuedStatus = painData.includes('status: queued');
        const hasRemainingActiveTasks = queue.some((task: any) => task?.status === 'pending' || task?.status === 'in_progress');

        if (!hasQueuedStatus) return;

        if (painTaskId) {
            if (painTaskId === completedTaskId) {
                fs.unlinkSync(painFlagPath);
            }
            return;
        }

        // Legacy fallback: only clear an untagged queued pain flag when there are
        // no active queue entries left. This avoids unrelated diagnostician runs
        // from deleting a queued flag that belongs to another task.
        if (!hasRemainingActiveTasks) {
            fs.unlinkSync(painFlagPath);
        }
    } catch (e: any) {
        if (e.code === 'ENOENT') return; // File doesn't exist, nothing to clean up
        console.error(`[PD:Subagent] Failed to cleanup pain flag: ${String(e)}`);
    }
}

function getCompletionRetryKey(workspaceDir: string, targetSessionKey: string): string {
    return `${workspaceDir}::${targetSessionKey}`;
}

function scheduleCompletionRetry(
    event: PluginHookSubagentEndedEvent,
    ctx: SubagentEndedHookContext,
    attempt: number,
): void {
    const workspaceDir = ctx.workspaceDir;
    const targetSessionKey = event.targetSessionKey;
    if (!workspaceDir || !targetSessionKey || attempt >= COMPLETION_MAX_RETRIES) {
        return;
    }

    cleanupExpiredRetryEntries();
    const retryKey = getCompletionRetryKey(workspaceDir, targetSessionKey);
    completionRetryCounts.set(retryKey, {
        count: attempt + 1,
        expires: Date.now() + COMPLETION_RETRY_TTL_MS
    });
    setTimeout(() => {
        void handleSubagentEnded(event, ctx).finally(() => {
            const entry = completionRetryCounts.get(retryKey);
            if (!entry || entry.count <= attempt + 1) {
                completionRetryCounts.delete(retryKey);
            }
        });
    }, COMPLETION_RETRY_DELAY_MS);
}

function scheduleTaskOutcomeRetry(
    wctx: WorkspaceContext,
    payload: {
        sessionId: string;
        taskId: string;
        outcome: string;
        summary: string;
    },
    attempt: number,
): void {
    if (attempt >= TASK_OUTCOME_MAX_RETRIES) {
        console.error(`[PD:Subagent] Failed to persist task outcome after ${TASK_OUTCOME_MAX_RETRIES} attempts: ${payload.taskId}`);
        return;
    }

    setTimeout(() => {
        try {
            wctx.trajectory?.recordTaskOutcome?.(payload);
        } catch (error) {
            console.warn(`[PD:Subagent] Retrying task outcome persistence for ${payload.taskId}: ${String(error)}`);
            scheduleTaskOutcomeRetry(wctx, payload, attempt + 1);
        }
    }, TASK_OUTCOME_RETRY_DELAY_MS);
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
    if (targetSessionKey?.startsWith('empathy_obs:')) {
        await empathyObserverManager.reap(ctx.api, targetSessionKey, workspaceDir);
        return;
    }

    const config = wctx.config;

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

    if (outcome === 'ok' || outcome === 'deleted') {
        wctx.trust.recordSuccess('subagent_success', {
            sessionId: ctx.sessionId,
            api: ctx.api
        }, true);
    }

    if ((outcome !== 'ok' && outcome !== 'deleted') || !isDiagnosticianSession(targetSessionKey)) {
        return;
    }

    const queuePath = wctx.resolve('EVOLUTION_QUEUE');
    if (!fs.existsSync(queuePath)) return;

    const retryKey = getCompletionRetryKey(workspaceDir, targetSessionKey);
    const retryEntry = completionRetryCounts.get(retryKey);
    const attempt = retryEntry?.count || 0;
    let releaseLock: (() => void) | null = null;

    try {
        releaseLock = await acquireQueueLock(queuePath, console);
        const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
        let completedTaskId: string | null = null;

        const matchedTask = queue.find((task: any) =>
            task?.status === 'in_progress'
            && typeof task?.assigned_session_key === 'string'
            && task.assigned_session_key === targetSessionKey
        );

        if (matchedTask) {
            matchedTask.status = 'completed';
            matchedTask.completed_at = new Date().toISOString();
            delete matchedTask.assigned_session_key;
            completedTaskId = matchedTask.id;
        } else {
            console.warn(`[PD:Subagent] No in-progress evolution task matched subagent session ${targetSessionKey}`);
        }

        let taskOutcomePayload:
            | {
                sessionId: string;
                taskId: string;
                outcome: string;
                summary: string;
            }
            | null = null;

        if (completedTaskId) {
            fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
            cleanupPainFlagForTask(wctx, completedTaskId, queue);
            taskOutcomePayload = {
                sessionId: targetSessionKey,
                taskId: completedTaskId,
                outcome,
                summary: `Diagnostician session ${targetSessionKey} completed evolution task ${completedTaskId}.`,
            };
        }

        if (taskOutcomePayload) {
            try {
                wctx.trajectory?.recordTaskOutcome?.(taskOutcomePayload);
            } catch (error) {
                console.warn(`[PD:Subagent] Failed to persist task outcome for ${taskOutcomePayload.taskId}: ${String(error)}`);
                scheduleTaskOutcomeRetry(wctx, taskOutcomePayload, 1);
            }
        }
    } catch (e) {
        console.error(`[PD:Subagent] Failed to update evolution queue: ${String(e)}`);
        scheduleCompletionRetry(event, ctx, attempt);
    } finally {
        releaseLock?.();
    }
}
