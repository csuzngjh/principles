import type { PluginHookSubagentEndedEvent, PluginHookSubagentContext, PluginLogger } from '../openclaw-sdk.js';
import * as fs from 'fs';
import { writePainFlag } from '../core/pain.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { empathyObserverManager, type EmpathyObserverApi } from '../service/empathy-observer-manager.js';
import { acquireQueueLock } from '../service/evolution-worker.js';
import { isSubagentRuntimeAvailable } from '../utils/subagent-probe.js';

const COMPLETION_RETRY_DELAY_MS = 250;
const COMPLETION_MAX_RETRIES = 3;
const COMPLETION_RETRY_TTL_MS = 60 * 60 * 1000; // 1 hour TTL for retry entries
const TASK_OUTCOME_RETRY_DELAY_MS = 250;
const TASK_OUTCOME_MAX_RETRIES = 3;
const DIAGNOSTICIAN_SESSION_PREFIX = 'agent:diagnostician:';
const completionRetryCounts = new Map<string, { count: number; expires: number }>();
type HookLogger = Pick<PluginLogger, 'info' | 'warn' | 'error'>;

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
        agentId?: string;
    },
    logger: HookLogger
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
                agentId: payload.agentId,
            },
        });
    } catch (e) {
        logger.warn(`[PD:Subagent] failed to emit evolution event: ${String(e)}`);
    }
}

function isDiagnosticianSession(targetSessionKey: string | undefined): boolean {
    return typeof targetSessionKey === 'string' && targetSessionKey.startsWith(DIAGNOSTICIAN_SESSION_PREFIX);
}

function extractAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
    // sessionKey format: "agent:{agentId}:{type}:{uuid}" or "agent:{agentId}:{uuid}"
    if (!sessionKey) return undefined;
    const match = sessionKey.match(/^agent:([^:]+):/);
    return match ? match[1] : undefined;
}

function cleanupPainFlagForTask(wctx: WorkspaceContext, completedTaskId: string, queue: any[], logger: HookLogger): void {
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
        logger.error(`[PD:Subagent] Failed to cleanup pain flag: ${String(e)}`);
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
    logger: HookLogger,
): void {
    if (attempt > TASK_OUTCOME_MAX_RETRIES) {
        logger.error(`[PD:Subagent] Failed to persist task outcome after ${TASK_OUTCOME_MAX_RETRIES} retries: ${payload.taskId}`);
        return;
    }

    setTimeout(() => {
        try {
            wctx.trajectory?.recordTaskOutcome?.(payload);
        } catch (error) {
            logger.warn(`[PD:Subagent] Retrying task outcome persistence for ${payload.taskId}: ${String(error)}`);
            scheduleTaskOutcomeRetry(wctx, payload, attempt + 1, logger);
        }
    }, TASK_OUTCOME_RETRY_DELAY_MS);
}

type SubagentEndedHookContext = PluginHookSubagentContext & {
    api?: EmpathyObserverApi;
    workspaceDir?: string;
    sessionId?: string;
    agentId?: string;
};

export async function handleSubagentEnded(
    event: PluginHookSubagentEndedEvent,
    ctx: SubagentEndedHookContext
): Promise<void> {
    const { outcome, targetSessionKey } = event;
    const workspaceDir = ctx.workspaceDir;

    if (!workspaceDir) return;

    const wctx = WorkspaceContext.fromHookContext(ctx);
    const logger: HookLogger = ctx.api?.logger ?? console;
    if (targetSessionKey?.startsWith('empathy_obs:')) {
        await empathyObserverManager.reap(ctx.api, targetSessionKey, workspaceDir);
        return;
    }

    const config = wctx.config;

    // ── Outcome-based Trust Score and Pain Signal handling ──
    // OpenClaw v2026.3.23 fixes: timeout may be false positive (fast-finishing workers)
    // Only penalize actual errors, not timeout/killed/reset
    
    if (outcome === 'error') {
        // Only actual errors trigger penalty
        const scoreSettings = config.get('scores');
        const score = scoreSettings.subagent_error_penalty;
        const reason = `Subagent session ${targetSessionKey} ended with error`;

        writePainFlag(workspaceDir, {
            source: `subagent_error`,
            score: String(score),
            time: new Date().toISOString(),
            reason,
            is_risky: 'true',
            session_id: ctx.sessionId || '',
            agent_id: ctx.agentId || extractAgentIdFromSessionKey(targetSessionKey) || '',
        });

        emitSubagentPainEvent(wctx, {
            source: `subagent_error`,
            reason,
            score,
            sessionId: ctx.sessionId,
            agentId: ctx.agentId || extractAgentIdFromSessionKey(targetSessionKey),
        }, logger);
    }

    if (outcome === 'timeout') {
        // OpenClaw v2026.3.23 fix: timeout may be false positive
        // Fast-finishing workers are no longer incorrectly reported as timed out
        // Do not penalize - the task may have actually succeeded
        logger.warn(`[PD:Subagent] Session ${targetSessionKey} timed out - not penalizing (OpenClaw fix applied)`);
    }

    if (outcome === 'killed' || outcome === 'reset') {
        // User-initiated termination or system reset - not an agent failure
        logger.info(`[PD:Subagent] Session ${targetSessionKey} ended with ${outcome} - no penalty (user/system action)`);
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
        releaseLock = await acquireQueueLock(queuePath, logger);
        const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
        let completedTaskId: string | null = null;

        // Improved matching logic: support both direct session key match and HEARTBEAT placeholder match
        // This fixes task_outcomes being empty for HEARTBEAT-triggered diagnostician runs
        const matchedTask = queue.find((task: any) => {
            if (task?.status !== 'in_progress') return false;
            
            const taskSessionKey = task?.assigned_session_key;
            
            // 1. Exact match: direct session key assignment
            if (typeof taskSessionKey === 'string' && taskSessionKey === targetSessionKey) {
                return true;
            }
            
            // 2. HEARTBEAT placeholder match: for diagnostician sessions
            // Tasks started via HEARTBEAT have placeholder like "heartbeat:diagnostician:{taskId}"
            if (isDiagnosticianSession(targetSessionKey)) {
                // Match tasks with HEARTBEAT placeholder
                if (typeof taskSessionKey === 'string' && taskSessionKey.startsWith('heartbeat:diagnostician')) {
                    return true;
                }
                // Backward compatibility: match tasks with no assigned_session_key (legacy behavior)
                // Only match tasks started within 2 hours to avoid stale task matching
                if (taskSessionKey === undefined || taskSessionKey === null) {
                    const taskStartedAt = task?.started_at ? new Date(task.started_at).getTime() : 0;
                    const taskAge = taskStartedAt > 0 ? Date.now() - taskStartedAt : Infinity;
                    const LEGACY_FALLBACK_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
                    if (taskAge < LEGACY_FALLBACK_MAX_AGE_MS) {
                        return true;
                    }
                }
            }
            
            return false;
        });

        if (matchedTask) {
            // Enhanced observability: log match type for debugging
            const matchType = matchedTask.assigned_session_key === targetSessionKey 
                ? 'exact' 
                : matchedTask.assigned_session_key?.startsWith('heartbeat:diagnostician')
                    ? 'heartbeat_placeholder'
                    : 'legacy_fallback';
            logger.info(`[PD:Subagent] Matched session ${targetSessionKey} to task ${matchedTask.id} (match_type: ${matchType})`);
            
            matchedTask.status = 'completed';
            matchedTask.completed_at = new Date().toISOString();
            delete matchedTask.assigned_session_key;
            completedTaskId = matchedTask.id;
        } else {
            logger.warn(`[PD:Subagent] No in-progress evolution task matched subagent session ${targetSessionKey}`);
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
            cleanupPainFlagForTask(wctx, completedTaskId, queue, logger);
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
                logger.warn(`[PD:Subagent] Failed to persist task outcome for ${taskOutcomePayload.taskId}: ${String(error)}`);
                scheduleTaskOutcomeRetry(wctx, taskOutcomePayload, 1, logger);
            }
        }

        // Read diagnostician output and create principle with generalized pattern
        if (completedTaskId && isSubagentRuntimeAvailable(ctx.api?.runtime?.subagent)) {
            try {
                const messages = await ctx.api?.runtime?.subagent?.getSessionMessages?.({
                    sessionKey: targetSessionKey,
                    limit: 50
                });

                const assistantText = extractAssistantText(messages);
                const report = parseDiagnosticianReport(assistantText);

                if (report?.principle) {
                    const principleId = wctx.evolutionReducer.createPrincipleFromDiagnosis({
                        painId: matchedTask?.id || completedTaskId,
                        painType: 'tool_failure',  // Default, could be extracted from task
                        triggerPattern: report.principle.trigger_pattern,
                        action: report.principle.action,
                        source: matchedTask?.source || 'diagnostician'
                    });

                    if (principleId) {
                        logger.warn(`[PD:Subagent] Created principle ${principleId} from diagnostician analysis for task ${completedTaskId}`);
                    }
                }
            } catch (e) {
                logger.warn(`[PD:Subagent] Failed to read diagnostician output: ${String(e)}`);
            }
        }
    } catch (e) {
        logger.error(`[PD:Subagent] Failed to update evolution queue: ${String(e)}`);
        scheduleCompletionRetry(event, ctx, attempt);
    } finally {
        releaseLock?.();
    }
}

/**
 * Extract text content from assistant messages
 */
function extractAssistantText(messages: unknown): string {
    if (!messages || !Array.isArray(messages)) return '';

    const texts: string[] = [];
    for (const msg of messages) {
        if (msg?.role !== 'assistant') continue;
        const content = msg?.content;
        if (Array.isArray(content)) {
            for (const block of content) {
                if (block?.type === 'text' && typeof block.text === 'string') {
                    texts.push(block.text);
                }
            }
        } else if (typeof content === 'string') {
            texts.push(content);
        }
    }
    return texts.join('\n');
}

/**
 * Parse diagnostician JSON report from text
 */
function parseDiagnosticianReport(text: string): { principle?: { trigger_pattern: string; action: string } } | null {
    // Try to find JSON in markdown code block
    const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[1]);
            // Support both direct principle and nested phases.principle_extraction structure
            if (parsed?.principle) {
                return { principle: parsed.principle };
            }
            if (parsed?.phases?.principle_extraction?.principle) {
                return { principle: parsed.phases.principle_extraction.principle };
            }
        } catch {
            // Fall through to return null
        }
    }

    // Try to find raw JSON object
    const objectMatch = text.match(/\{[\s\S]*"principle"[\s\S]*\}/);
    if (objectMatch) {
        try {
            const parsed = JSON.parse(objectMatch[0]);
            if (parsed?.principle) {
                return { principle: parsed.principle };
            }
            if (parsed?.phases?.principle_extraction?.principle) {
                return { principle: parsed.phases.principle_extraction.principle };
            }
        } catch {
            // Fall through to return null
        }
    }

    return null;
}
