import type { PluginHookSubagentEndedEvent, PluginHookSubagentContext, PluginLogger, OpenClawPluginApi } from '../openclaw-sdk.js';
import { buildPainFlag, writePainFlag } from '../core/pain.js';
import { WorkspaceContext } from '../core/workspace-context.js';
// No longer needed — diagnostician runs via HEARTBEAT, not subagent
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

type HookLogger = Pick<PluginLogger, 'info' | 'warn' | 'error'>;

// Cleanup expired retry entries periodically

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


function extractAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
    // sessionKey format: "agent:{agentId}:{type}:{uuid}" or "agent:{agentId}:{uuid}"
    if (!sessionKey) return undefined;
    const match = sessionKey.match(/^agent:([^:]+):/);
    return match ? match[1] : undefined;
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

        writePainFlag(workspaceDir, buildPainFlag({
            source: 'subagent_error',
            score: String(score),
            reason,
            is_risky: true,
            session_id: ctx.sessionId || '',
            agent_id: ctx.agentId || extractAgentIdFromSessionKey(targetSessionKey) || '',
        }));

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

    // ── End of subagent_ended handling ──
    // Note: Diagnostician runs via HEARTBEAT (main session LLM), not as a subagent.
    // Principle creation happens in evolution-worker.ts marker detection path.
}
