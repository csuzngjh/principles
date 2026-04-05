import type { PluginHookSubagentEndedEvent, PluginHookSubagentContext, PluginLogger, OpenClawPluginApi } from '../openclaw-sdk.js';
import * as fs from 'fs';
import { writePainFlag } from '../core/pain.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { acquireQueueLock, type EvolutionQueueItem } from '../service/evolution-worker.js';
import { recordEvolutionSuccess } from '../core/evolution-engine.js';
import { WorkflowStore } from '../service/subagent-workflow/workflow-store.js';
import { EmpathyObserverWorkflowManager } from '../service/subagent-workflow/empathy-observer-workflow-manager.js';
import { DeepReflectWorkflowManager } from '../service/subagent-workflow/deep-reflect-workflow-manager.js';
import type { WorkflowManager } from '../service/subagent-workflow/types.js';

/**
 * Factory to create the appropriate WorkflowManager by workflow_type string.
 * Used by the subagent_ended hook to dispatch lifecycle recovery to the right manager.
 */
function createWorkflowManagerForType(
    workflowType: string,
    workspaceDir: string,
    logger: HookLogger,
    subagent: NonNullable<OpenClawPluginApi['runtime']>['subagent'],
): WorkflowManager | null {
    const loggerAdapter: PluginLogger = {
        info: (m: string) => logger.info(String(m)),
        warn: (m: string) => logger.warn(String(m)),
        error: (m: string) => logger.error(String(m)),
        debug: () => {},
    } as unknown as PluginLogger;

    switch (workflowType) {
        case 'empathy-observer':
            return new EmpathyObserverWorkflowManager({
                workspaceDir,
                logger: loggerAdapter,
                subagent,
            });
        case 'deep-reflect':
            return new DeepReflectWorkflowManager({
                workspaceDir,
                logger: loggerAdapter,
                subagent,
            });
        default:
            return null;
    }
}

const HELPER_WORKFLOW_SESSION_PREFIX = 'agent:main:subagent:workflow-';

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
    const entries = Array.from(completionRetryCounts.entries());
    for (const [key, value] of entries) {
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

function cleanupPainFlagForTask(wctx: WorkspaceContext, completedTaskId: string, queue: EvolutionQueueItem[], logger: HookLogger): void {
    const painFlagPath = wctx.resolve('PAIN_FLAG');

    try {
        const painData = fs.readFileSync(painFlagPath, 'utf8');
        const taskIdMatch = painData.match(/^task_id:\s*(.+)$/m);
        const painTaskId = taskIdMatch?.[1]?.trim();
        const hasQueuedStatus = painData.includes('status: queued');
        const hasRemainingActiveTasks = queue.some((task) => task?.status === 'pending' || task?.status === 'in_progress');

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
    } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // File doesn't exist, nothing to clean up
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
        } catch (error: unknown) {
            logger.warn(`[PD:Subagent] Retrying task outcome persistence for ${payload.taskId}: ${String(error)}`);
            scheduleTaskOutcomeRetry(wctx, payload, attempt + 1, logger);
        }
    }, TASK_OUTCOME_RETRY_DELAY_MS);
}

type SubagentEndedHookContext = PluginHookSubagentContext & {
    api?: OpenClawPluginApi;
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
    // ── Helper Workflow Lifecycle Notification ──
    // When a helper workflow's subagent ends, notify the workflow manager
    // so that it can trigger fallback recovery (notifyWaitResult → finalizeOnce)
    if (targetSessionKey?.startsWith(HELPER_WORKFLOW_SESSION_PREFIX)) {
        try {
            const store = new WorkflowStore({ workspaceDir });
            const workflow = store.getWorkflowByChildSession(targetSessionKey);
            if (workflow && workflow.state !== 'completed' && workflow.state !== 'terminal_error' && workflow.state !== 'expired') {
                logger.info(`[PD:Subagent] Helper workflow lifecycle event: workflowId=${workflow.workflow_id}, workflowType=${workflow.workflow_type}, outcome=${outcome}`);

                const mappedOutcome = outcome === 'deleted' ? 'deleted' :
                                      outcome === 'killed' ? 'killed' :
                                      outcome === 'reset' ? 'reset' :
                                      outcome === 'error' ? 'error' :
                                      outcome === 'timeout' ? 'timeout' : 'ok';

                // Call notifyLifecycleEvent on the appropriate manager so it
                // triggers notifyWaitResult → finalizeOnce / terminal transition.
                const subagentRuntime = ctx.api?.runtime?.subagent;
                if (subagentRuntime) {
                    const mgr = createWorkflowManagerForType(workflow.workflow_type, workspaceDir, logger, subagentRuntime);
                    if (mgr) {
                        await mgr.notifyLifecycleEvent(workflow.workflow_id, 'subagent_ended', { outcome: mappedOutcome });
                        mgr.dispose();
                    } else {
                        logger.warn(`[PD:Subagent] Unknown workflow type ${workflow.workflow_type} — falling back to store-only event`);
                        store.recordEvent(workflow.workflow_id, 'subagent_ended', workflow.state, workflow.state, `subagent ended with outcome: ${outcome}`, { outcome: mappedOutcome });
                    }
                } else {
                    logger.warn(`[PD:Subagent] Subagent runtime not available — cannot notify manager, falling back to store event`);
                    store.recordEvent(workflow.workflow_id, 'subagent_ended', workflow.state, workflow.state, `subagent ended with outcome: ${outcome}`, { outcome: mappedOutcome });
                }
                store.dispose();
                return;
            }
            store.dispose();
        } catch (e) {
            logger.warn(`[PD:Subagent] Failed to notify helper workflow lifecycle: ${String(e)}`);
        }
    }

    const config = wctx.config;

    // ── Outcome-based EP and Pain Signal handling ──
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
        recordEvolutionSuccess(workspaceDir, 'subagent', {
            sessionId: ctx.sessionId,
            reason: 'subagent_success',
        });
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
            // V2: Skip non-pain_diagnosis tasks - they don't use HEARTBEAT completion flow
            // pain_diagnosis: routed through subagent completion matcher (this block)
            // sleep_reflection: handled by nocturnal service (separate flow, no HEARTBEAT)
            // model_eval: handled separately (no HEARTBEAT completion)
            if (task?.taskKind !== 'pain_diagnosis' && task?.taskKind !== undefined) return false;
            
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
                // Only match tasks started within 30 minutes to avoid stale task matching
                if (taskSessionKey === undefined || taskSessionKey === null) {
                    const taskStartedAt = task?.started_at ? new Date(task.started_at).getTime() : 0;
                    const taskAge = taskStartedAt > 0 ? Date.now() - taskStartedAt : Infinity;
                    const LEGACY_FALLBACK_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
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
            } catch (error: unknown) {
                logger.warn(`[PD:Subagent] Failed to persist task outcome for ${taskOutcomePayload.taskId}: ${String(error)}`);
                scheduleTaskOutcomeRetry(wctx, taskOutcomePayload, 1, logger);
            }
        }

        // Read diagnostician output and create principle with generalized pattern
        if (completedTaskId && ctx.api?.runtime?.subagent) {
            try {
                const messages = await ctx.api?.runtime?.subagent?.getSessionMessages?.({
                    sessionKey: targetSessionKey,
                    limit: 50
                });

                const assistantText = extractAssistantText(messages);
                logger.info(`[PD:Subagent] Diagnostician output for task ${completedTaskId}: ${assistantText.length} chars`);

                const report = parseDiagnosticianReport(assistantText);

                if (report?.principle) {
                    logger.info(`[PD:Subagent] Parsed principle from diagnostician for task ${completedTaskId}: trigger="${report.principle.trigger_pattern.slice(0, 60)}..."`);

                    // Principles default to 'manual_only' evaluability unless detector metadata
                    // is explicitly provided. Only deterministic / weak_heuristic evaluability
                    // can enter automatic nocturnal targeting.
                    const evaluability = report.principle.evaluability;

                    // Only pass detector metadata if ALL required fields are present and valid.
                    // Incomplete metadata → 'manual_only' — the principle stays prompt-only.
                    // Defense in depth: also validate in reducer, but subagent should not pass
                    // malformed data in the first place.
                    const rawMeta = report.principle.detector_metadata;
                    // Require confidence (valid enum) + ALL THREE signal arrays non-empty.
                    // toolSequenceHints is optional (may be empty or absent).
                    const VALID_CONFIDENCE = ['high', 'medium', 'low'] as const;
                    const hasValidConfidence =
                        typeof rawMeta?.confidence === 'string' &&
                        (VALID_CONFIDENCE as readonly string[]).includes(rawMeta.confidence);
                    const signalArrays = [
                        rawMeta?.applicabilityTags,
                        rawMeta?.positiveSignals,
                        rawMeta?.negativeSignals,
                    ];
                    const allSignalsNonEmpty = signalArrays.every(
                        (arr) => Array.isArray(arr) && arr.length > 0 && arr.every((s) => typeof s === 'string' && s.length > 0)
                    );
                    const hasCompleteMetadata = hasValidConfidence && allSignalsNonEmpty;
                    const detectorMetadata: import('../core/evolution-types.js').PrincipleDetectorSpec | undefined =
                        hasCompleteMetadata && rawMeta.confidence
                            ? {
                                  applicabilityTags: rawMeta.applicabilityTags ?? [],
                                  positiveSignals: rawMeta.positiveSignals ?? [],
                                  negativeSignals: rawMeta.negativeSignals ?? [],
                                  toolSequenceHints: rawMeta.toolSequenceHints ?? [],
                                  confidence: rawMeta.confidence as 'high' | 'medium' | 'low',
                              }
                            : undefined;

                    const principleId = wctx.evolutionReducer.createPrincipleFromDiagnosis({
                        painId: matchedTask?.id || completedTaskId,
                        painType: 'tool_failure',  // Default, could be extracted from task
                        triggerPattern: report.principle.trigger_pattern,
                        action: report.principle.action,
                        source: matchedTask?.source || 'diagnostician',
                        evaluability,
                        detectorMetadata,
                        abstractedPrinciple: report.principle.abstracted_principle,
                    });

                    if (principleId) {
                        logger.info(`[PD:Subagent] Created principle ${principleId} from diagnostician analysis for task ${completedTaskId}`);
                    } else {
                        logger.warn(`[PD:Subagent] createPrincipleFromDiagnosis returned null for task ${completedTaskId} (possibly blacklisted or duplicate)`);
                    }
                } else {
                    logger.warn(`[PD:Subagent] Diagnostician output for task ${completedTaskId} did not contain parseable principle JSON. Output length: ${assistantText.length} chars. First 200 chars: ${assistantText.slice(0, 200)}`);

                    // Fallback: try to extract principle from raw text even without JSON
                    const extractedPrinciple = extractPrincipleFromRawText(assistantText, matchedTask);
                    if (extractedPrinciple) {
                        logger.info(`[PD:Subagent] Fallback: extracted principle from raw text for task ${completedTaskId}`);
                        const principleId = wctx.evolutionReducer.createPrincipleFromDiagnosis({
                            painId: matchedTask?.id || completedTaskId,
                            painType: 'tool_failure',
                            triggerPattern: extractedPrinciple.triggerPattern,
                            action: extractedPrinciple.action,
                            source: matchedTask?.source || 'diagnostician',
                            evaluability: 'manual_only',
                        });
                        if (principleId) {
                            logger.info(`[PD:Subagent] Created principle ${principleId} via fallback extraction for task ${completedTaskId}`);
                        }
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
function parseDiagnosticianReport(
    text: string
): {
    principle?: {
        trigger_pattern: string;
        action: string;
        abstracted_principle?: string;
        evaluability?: 'deterministic' | 'weak_heuristic' | 'manual_only';
        detector_metadata?: {
            applicabilityTags?: string[];
            positiveSignals?: string[];
            negativeSignals?: string[];
            toolSequenceHints?: string[][];
            confidence?: 'high' | 'medium' | 'low';
        };
    };
} | null {
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

function extractPrincipleFromRawText(
    text: string,
    matchedTask?: any
): { triggerPattern: string; action: string } | null {
    const patterns = [
        /(?:When|如果|当)\s*(.+?)\s*(?:时|的时候|，|,)\s*(?:应该|必须|要|then|should|must)\s*(.+)/i,
        /(?:trigger_pattern|触发条件)[:：]\s*(.+?)[\n,](?:action|行动|操作)[:：]\s*(.+)/i,
        /(?:principle|原则)[:：]\s*(.+)/i,
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            if (match.length >= 3) {
                return {
                    triggerPattern: match[1].trim().slice(0, 200),
                    action: match[2].trim().slice(0, 500),
                };
            } else if (match.length === 2) {
                return {
                    triggerPattern: matchedTask?.reason || 'detected issue',
                    action: match[1].trim().slice(0, 500),
                };
            }
        }
    }

    const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 50);
    if (paragraphs.length > 0) {
        return {
            triggerPattern: matchedTask?.reason || 'detected issue',
            action: paragraphs[0].trim().slice(0, 500),
        };
    }

    return null;
}
