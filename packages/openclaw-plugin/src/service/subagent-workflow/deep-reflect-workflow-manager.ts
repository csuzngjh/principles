import type { PluginLogger } from '../../openclaw-sdk.js';
import type {
    WorkflowManager,
    WorkflowHandle,
    SubagentWorkflowSpec,
    WorkflowMetadata,
    WorkflowDebugSummary,
    DeepReflectResult,
    WorkflowResultContext,
    WorkflowPersistContext,
} from './types.js';

// Re-export DeepReflectResult so index.ts can re-export it
export type { DeepReflectResult } from './types.js';
import { RuntimeDirectDriver, type RunParams } from './runtime-direct-driver.js';
import { WorkflowStore } from './workflow-store.js';
import { isSubagentRuntimeAvailable } from '../../utils/subagent-probe.js';
import { buildCritiquePromptV2 } from '../../tools/critique-prompt.js';
import { computeDynamicTimeout, computeRetrySchedule, MAX_TIMEOUT_RETRIES } from './dynamic-timeout.js';

const WORKFLOW_SESSION_PREFIX = 'agent:main:subagent:workflow-';

const DEFAULT_TIMEOUT_MS = 60_000; // Deep-reflect needs more time than empathy
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface DeepReflectWorkflowOptions {
    workspaceDir: string;
    logger: PluginLogger;
    subagent: RuntimeDirectDriver['subagent'];
}

export class DeepReflectWorkflowManager implements WorkflowManager {
    private readonly store: WorkflowStore;
    private readonly driver: RuntimeDirectDriver;
    private readonly logger: PluginLogger;
    private readonly workspaceDir: string;

    private activeWorkflows = new Map<string, NodeJS.Timeout>();
    private completedWorkflows = new Map<string, number>();
    private workflowSpecs = new Map<string, SubagentWorkflowSpec<unknown>>();

    constructor(opts: DeepReflectWorkflowOptions) {
        this.workspaceDir = opts.workspaceDir;
        this.logger = opts.logger;
        this.store = new WorkflowStore({ workspaceDir: opts.workspaceDir });
        this.driver = new RuntimeDirectDriver({ subagent: opts.subagent, logger: opts.logger });
    }

    async startWorkflow<TResult>(
        spec: SubagentWorkflowSpec<TResult>,
        options: {
            parentSessionId: string;
            workspaceDir?: string;
            taskInput: unknown;
            metadata?: Record<string, unknown>;
        }
    ): Promise<WorkflowHandle> {
        const workflowId = this.generateWorkflowId();
        const childSessionKey = this.buildChildSessionKey(options.parentSessionId);
        const now = Date.now();

        const metadata: WorkflowMetadata = {
            parentSessionId: options.parentSessionId,
            workspaceDir: options.workspaceDir,
            taskInput: options.taskInput,
            startedAt: now,
            workflowType: spec.workflowType,
            ...options.metadata,
        };

        this.logger.info(`[PD:DeepReflectWorkflow] Starting workflow: workflowId=${workflowId}, type=${spec.workflowType}`);

        // Surface degrade: skip boot sessions
        if (options.parentSessionId.startsWith('boot-')) {
            this.logger.info(`[PD:DeepReflectWorkflow] Skipping workflow: boot session`);
            throw new Error(`DeepReflectWorkflowManager: cannot start workflow for boot session`);
        }

        // Surface degrade: check subagent runtime availability
        if (!isSubagentRuntimeAvailable(this.driver.getSubagent())) {
            this.logger.info(`[PD:DeepReflectWorkflow] Skipping workflow: subagent runtime unavailable`);
            throw new Error(`DeepReflectWorkflowManager: subagent runtime unavailable`);
        }

        if (spec.transport !== 'runtime_direct') {
            throw new Error(`DeepReflectWorkflowManager only supports runtime_direct transport`);
        }

        const runParams = this.buildRunParams(spec, options, childSessionKey);
        const runResult = await this.driver.run(runParams);

        this.store.createWorkflow({
            workflow_id: workflowId,
            workflow_type: spec.workflowType,
            transport: spec.transport,
            parent_session_id: options.parentSessionId,
            child_session_key: childSessionKey,
            run_id: runResult.runId,
            state: 'active',
            created_at: now,
            updated_at: now,
            duration_ms: null,
            metadata_json: JSON.stringify(metadata),
        });
        this.store.recordEvent(workflowId, 'spawned', null, 'active', 'subagent spawned', { runId: runResult.runId });
        this.workflowSpecs.set(workflowId, spec as SubagentWorkflowSpec<unknown>);

        this.scheduleWaitPollWithRetry(workflowId, runResult.runId);

        return {
            workflowId,
            childSessionKey,
            runId: runResult.runId,
            state: 'active',
        };
    }

    private buildRunParams<TResult>(
        spec: SubagentWorkflowSpec<TResult>,
        options: {
            parentSessionId: string;
            workspaceDir?: string;
            taskInput: unknown;
            metadata?: Record<string, unknown>;
        },
        childSessionKey: string
    ): RunParams {
        const message = spec.buildPrompt(options.taskInput, {
            parentSessionId: options.parentSessionId,
            workspaceDir: options.workspaceDir,
            taskInput: options.taskInput,
            startedAt: Date.now(),
            workflowType: spec.workflowType,
            ...(options.metadata ?? {}),
        });

        return {
            sessionKey: childSessionKey,
            message,
            lane: 'subagent',
            deliver: false,
            idempotencyKey: options.parentSessionId
                ? `${options.parentSessionId}:${Date.now()}`
                : `pd:${childSessionKey}:${Date.now()}`,
            expectsCompletionMessage: true,
        };
    }

    /**
     * Schedule wait polling with dynamic timeout and automatic retry.
     *
     * Learns from historical completion times for this workflow type.
     * On timeout, retries with exponential backoff (1x → 2x → 4x base timeout).
     */
    private scheduleWaitPollWithRetry(
        workflowId: string,
        runId: string,
        attempt: number = 0,
    ): void {
        const spec = this.workflowSpecs.get(workflowId);
        const staticTimeout = spec?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

        // Compute dynamic timeout from historical data
        const baseTimeout = computeDynamicTimeout(this.store, spec?.workflowType ?? 'deep-reflect', staticTimeout);
        const schedule = computeRetrySchedule(baseTimeout, MAX_TIMEOUT_RETRIES);
        const timeoutMs = schedule[Math.min(attempt, schedule.length - 1)];

        this.logger.info(`[PD:DeepReflectWorkflow] Wait attempt ${attempt + 1}/${schedule.length}: timeout=${timeoutMs}ms (base=${baseTimeout}ms) for ${workflowId}`);

        const timeout = setTimeout(async () => {
            try {
                const result = await this.driver.wait({ runId, timeoutMs });
                if (result.status === 'timeout' && attempt < MAX_TIMEOUT_RETRIES) {
                    this.logger.info(`[PD:DeepReflectWorkflow] Timeout on attempt ${attempt + 1}, retrying for ${workflowId}`);
                    this.store.recordEvent(workflowId, 'wait_timeout_retry', 'active', 'active', `timeout on attempt ${attempt + 1}, scheduling retry ${attempt + 2}`, { attempt });
                    this.activeWorkflows.delete(workflowId);
                    this.scheduleWaitPollWithRetry(workflowId, runId, attempt + 1);
                    return;
                }
                await this.notifyWaitResult(workflowId, result.status, result.error);
            } catch (error) {
                this.logger.error(`[PD:DeepReflectWorkflow] Wait poll failed: ${String(error)}`);
                if (attempt < MAX_TIMEOUT_RETRIES) {
                    this.logger.info(`[PD:DeepReflectWorkflow] Error on attempt ${attempt + 1}, retrying for ${workflowId}`);
                    this.activeWorkflows.delete(workflowId);
                    this.scheduleWaitPollWithRetry(workflowId, runId, attempt + 1);
                    return;
                }
                await this.notifyWaitResult(workflowId, 'error', String(error));
            }
        }, 100);

        this.activeWorkflows.set(workflowId, timeout);
    }

    async notifyWaitResult(
        workflowId: string,
        status: 'ok' | 'error' | 'timeout',
        error?: string
    ): Promise<void> {
        const workflow = this.store.getWorkflow(workflowId);
        if (!workflow) {
            this.logger.warn(`[PD:DeepReflectWorkflow] notifyWaitResult: workflow not found: ${workflowId}`);
            return;
        }

        if (workflow.state === 'completed' || workflow.state === 'terminal_error' || workflow.state === 'expired') {
            this.logger.info(`[PD:DeepReflectWorkflow] notifyWaitResult: ignoring terminal workflow: ${workflowId}, state=${workflow.state}`);
            return;
        }

        this.logger.info(`[PD:DeepReflectWorkflow] notifyWaitResult: workflowId=${workflowId}, status=${status}`);

        const previousState = workflow.state;
        this.store.updateWorkflowState(workflowId, 'wait_result');
        this.store.recordEvent(workflowId, 'wait_result', previousState, 'wait_result', `wait completed: ${status}`, { error });

        const spec = this.workflowSpecs.get(workflowId);
        if (!spec) {
            // Spec not registered — lifecycle event notification path (subagent.ts).
            // Original manager's wait poll will handle finalization.
            this.logger.info(`[PD:DeepReflectWorkflow] notifyWaitResult: spec not registered for ${workflowId} — skipping finalization (primary path will handle)`);
            return;
        }

        const shouldFinalize = spec.shouldFinalizeOnWaitStatus(status);

        if (shouldFinalize) {
            await this.finalizeOnce(workflowId);
        } else {
            this.store.updateWorkflowState(workflowId, 'terminal_error');
            this.store.recordEvent(workflowId, 'finalize_skipped', 'wait_result', 'terminal_error', `wait status: ${status}`, { error });
        }
    }

    async notifyLifecycleEvent(
        workflowId: string,
        event: 'subagent_spawned' | 'subagent_ended',
        data?: { outcome?: 'ok' | 'error' | 'timeout' | 'killed' | 'reset' | 'deleted'; error?: string }
    ): Promise<void> {
        this.logger.info(`[PD:DeepReflectWorkflow] notifyLifecycleEvent: workflowId=${workflowId}, event=${event}`);

        if (event === 'subagent_ended' && data?.outcome) {
            await this.notifyWaitResult(workflowId, data.outcome === 'ok' ? 'ok' : data.outcome === 'error' ? 'error' : 'timeout', data.error);
        }
    }

    async finalizeOnce(workflowId: string): Promise<void> {
        const workflow = this.store.getWorkflow(workflowId);
        if (!workflow) {
            this.logger.warn(`[PD:DeepReflectWorkflow] finalizeOnce: workflow not found: ${workflowId}`);
            return;
        }

        const spec = this.workflowSpecs.get(workflowId);
        if (!spec) {
            throw new Error(`Workflow spec not registered for ${workflowId}`);
        }

        if (this.isCompleted(workflowId)) {
            this.logger.info(`[PD:DeepReflectWorkflow] finalizeOnce: already completed: ${workflowId}`);
            return;
        }

        this.logger.info(`[PD:DeepReflectWorkflow] Finalizing workflow: ${workflowId}`);

        this.store.updateWorkflowState(workflowId, 'finalizing');

        try {
            const result = await this.driver.getResult({ sessionKey: workflow.child_session_key, limit: 20 });

            const metadata = JSON.parse(workflow.metadata_json) as WorkflowMetadata;
            const parsed = await spec.parseResult({
                messages: result.messages,
                assistantTexts: result.assistantTexts,
                metadata,
                waitStatus: 'ok',
            });

            if (!parsed) {
                this.store.updateWorkflowState(workflowId, 'terminal_error');
                this.store.recordEvent(workflowId, 'parse_failed', 'finalizing', 'terminal_error', 'spec.parseResult returned null', {});
                return;
            }

            await spec.persistResult({
                result: parsed,
                metadata,
                workspaceDir: this.workspaceDir,
            });
            this.store.recordEvent(workflowId, 'persisted', 'finalizing', 'finalizing', 'result persisted', {});

            if (spec.shouldDeleteSessionAfterFinalize && workflow.run_id) {
                try {
                    await this.driver.cleanup({ sessionKey: workflow.child_session_key });
                    this.store.updateCleanupState(workflowId, 'completed');
                } catch (cleanupError) {
                    this.logger.error(`[PD:DeepReflectWorkflow] cleanup failed after persistence: ${String(cleanupError)}`);
                    this.store.updateCleanupState(workflowId, 'failed');
                    this.store.updateWorkflowState(workflowId, 'cleanup_pending');
                    this.store.recordEvent(workflowId, 'cleanup_failed', 'finalizing', 'cleanup_pending', String(cleanupError), {});
                    this.markCompleted(workflowId);
                    return;
                }
            }

            // Record actual completion duration for adaptive timeout learning
            const durationMs = Date.now() - workflow.created_at;
            this.store.recordDuration(workflowId, durationMs);

            this.store.updateWorkflowState(workflowId, 'completed');
            this.store.recordEvent(workflowId, 'finalized', 'finalizing', 'completed', 'success', { durationMs });
            this.markCompleted(workflowId);

        } catch (error) {
            this.logger.error(`[PD:DeepReflectWorkflow] finalizeOnce failed: ${String(error)}`);
            this.store.updateWorkflowState(workflowId, 'terminal_error');
            this.store.recordEvent(workflowId, 'finalize_error', 'finalizing', 'terminal_error', String(error), {});
            throw error;
        }
    }

    async sweepExpiredWorkflows(maxAgeMs = DEFAULT_TTL_MS): Promise<number> {
        const expired = this.store.getExpiredWorkflows(maxAgeMs);

        this.logger.info(`[PD:DeepReflectWorkflow] sweepExpiredWorkflows: found ${expired.length} expired`);

        for (const workflow of expired) {
            try {
                this.logger.info(`[PD:DeepReflectWorkflow] Sweeping expired workflow: ${workflow.workflow_id}`);

                await this.driver.cleanup({ sessionKey: workflow.child_session_key });
                this.store.updateCleanupState(workflow.workflow_id, 'completed');
                this.store.updateWorkflowState(workflow.workflow_id, 'expired');
                this.store.recordEvent(workflow.workflow_id, 'swept', workflow.state, 'expired', 'TTL expired', {});

            } catch (error) {
                this.logger.error(`[PD:DeepReflectWorkflow] Sweep cleanup failed for ${workflow.workflow_id}: ${String(error)}`);
                this.store.updateCleanupState(workflow.workflow_id, 'failed');
            }
        }

        // Clean up memory Maps to prevent leaks
        const cutoff = Date.now() - 60_000;
        for (const [id, timestamp] of this.completedWorkflows) {
            if (timestamp < cutoff) {
                this.completedWorkflows.delete(id);
            }
        }
        for (const [id, timeout] of this.activeWorkflows) {
            const wf = this.store.getWorkflow(id);
            if (!wf || wf.state === 'expired' || wf.state === 'completed' || wf.state === 'terminal_error') {
                clearTimeout(timeout);
                this.activeWorkflows.delete(id);
            }
        }

        return expired.length;
    }

    async getWorkflowDebugSummary(workflowId: string, eventLimit = 10): Promise<WorkflowDebugSummary | null> {
        const workflow = this.store.getWorkflow(workflowId);
        if (!workflow) return null;

        const metadata = JSON.parse(workflow.metadata_json) as WorkflowMetadata;
        const recentEvents = this.store
            .getEvents(workflowId)
            .slice(-eventLimit)
            .map((event) => ({
                eventType: event.event_type,
                fromState: event.from_state,
                toState: event.to_state,
                reason: event.reason,
                createdAt: event.created_at,
                payload: JSON.parse(event.payload_json || '{}') as Record<string, unknown>,
            }));

        return {
            workflowId: workflow.workflow_id,
            workflowType: workflow.workflow_type,
            transport: workflow.transport,
            parentSessionId: workflow.parent_session_id,
            childSessionKey: workflow.child_session_key,
            runId: workflow.run_id,
            state: workflow.state,
            cleanupState: workflow.cleanup_state,
            lastObservedAt: workflow.last_observed_at ?? null,
            metadata,
            recentEvents,
        };
    }

    private generateWorkflowId(): string {
        return `wf_dr_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    }

    private buildChildSessionKey(parentSessionId: string): string {
        const safeParentSessionId = parentSessionId
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .substring(0, 64);
        const timestamp = Date.now();
        return `${WORKFLOW_SESSION_PREFIX}${safeParentSessionId}-${timestamp}`;
    }

    private isCompleted(workflowId: string): boolean {
        const timestamp = this.completedWorkflows.get(workflowId);
        if (!timestamp) return false;
        return Date.now() - timestamp < 60_000; // 1 minute dedup window
    }

    private markCompleted(workflowId: string): void {
        const timeout = this.activeWorkflows.get(workflowId);
        if (timeout) {
            clearTimeout(timeout);
            this.activeWorkflows.delete(workflowId);
        }
        this.completedWorkflows.set(workflowId, Date.now());
    }

    dispose(): void {
        for (const [workflowId, timeout] of this.activeWorkflows) {
            clearTimeout(timeout);
            this.logger.info(`[PD:DeepReflectWorkflow] Disposed active workflow: ${workflowId}`);
        }
        this.activeWorkflows.clear();
        this.completedWorkflows.clear();
        this.workflowSpecs.clear();
        this.store.dispose();
    }
}

// ─── Workflow Spec ───────────────────────────────────────────────

export interface DeepReflectTaskInput {
    context: string;
    depth: number;
    model_id?: string;
}

export interface DeepReflectBuildPromptContext {
    parentSessionId: string;
    workspaceDir?: string;
    taskInput: unknown;
    startedAt: number;
    workflowType: string;
}

export const deepReflectWorkflowSpec: SubagentWorkflowSpec<DeepReflectResult> = {
    workflowType: 'deep-reflect',
    transport: 'runtime_direct',
    timeoutMs: 60_000,
    ttlMs: 10 * 60 * 1000,
    shouldDeleteSessionAfterFinalize: true,

    buildPrompt(taskInput: unknown, ctx: DeepReflectBuildPromptContext): string {
        const input = taskInput as DeepReflectTaskInput;
        // Use the existing critique prompt builder
        return buildCritiquePromptV2({
            context: input.context,
            depth: input.depth,
            model_id: input.model_id,
            api: undefined, // Not available in workflow context
            workspaceDir: ctx.workspaceDir,
        });
    },

    shouldFinalizeOnWaitStatus(status: 'ok' | 'error' | 'timeout'): boolean {
        return status === 'ok';
    },

    async parseResult(ctx: WorkflowResultContext): Promise<DeepReflectResult | null> {
        const { assistantTexts, messages } = ctx;

        let insights = '';
        if (assistantTexts && assistantTexts.length > 0) {
            insights = assistantTexts[assistantTexts.length - 1] || '';
        } else if (messages && messages.length > 0) {
            const lastMessage = messages[messages.length - 1] as { role?: string; content?: unknown };
            if (typeof lastMessage?.content === 'string') {
                insights = lastMessage.content;
            } else if (Array.isArray(lastMessage?.content)) {
                insights = (lastMessage.content as Array<{ type?: string; text?: string }>)
                    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
                    .map((c) => c.text!)
                    .join('\n');
            }
        }

        if (!insights?.trim()) {
            return null;
        }

        const taskInput = ctx.metadata.taskInput as DeepReflectTaskInput | undefined;

        return {
            insights,
            context: taskInput?.context ?? '',
            depth: taskInput?.depth ?? 2,
            modelId: taskInput?.model_id ?? 'auto-select',
            passed: !insights.includes('REFLECTION_FAIL'),
        };
    },

    async persistResult(ctx: WorkflowPersistContext<DeepReflectResult>): Promise<void> {
        const { result, metadata, workspaceDir } = ctx;

        if (!result || !result.insights) return;

        try {
            const fs = await import('fs');
            const pathMod = await import('path');
            const { resolvePdPath } = await import('../../core/paths.js');

            const reflectionLogPath = resolvePdPath(workspaceDir, 'REFLECTION_LOG');
            const memoryDir = pathMod.default.dirname(reflectionLogPath);
            if (!fs.default.existsSync(memoryDir)) {
                fs.default.mkdirSync(memoryDir, { recursive: true });
            }

            const timestamp = new Date().toISOString();
            const taskInput = metadata.taskInput as DeepReflectTaskInput | undefined;
            const entry = `
---
## Reflection at ${timestamp}
**Model**: ${result.modelId || 'auto-select'}
**Depth**: ${result.depth || 2}

### Context
${(taskInput?.context ?? '').substring(0, 500)}${(taskInput?.context ?? '').length > 500 ? '...' : ''}

### Insights
${result.insights}

`;

            const header = `# Reflection Log\n\n> Auto-generated by Deep Reflection Tool\n> Retention: 30 days\n`;

            let existingContent = '';
            if (fs.default.existsSync(reflectionLogPath)) {
                existingContent = fs.default.readFileSync(reflectionLogPath, 'utf8');
            }

            const newContent = header + entry + existingContent.replace(header, '');

            const tempPath = `${reflectionLogPath}.tmp`;
            fs.default.writeFileSync(tempPath, newContent, 'utf8');
            fs.default.renameSync(tempPath, reflectionLogPath);
        } catch (err) {
            // Let the error propagate to finalizeOnce for proper event logging
            throw new Error(`DeepReflectWorkflow persistResult failed: ${String(err)}`);
        }
    },
};
