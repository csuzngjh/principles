/**
 * WorkflowManagerBase - Shared base class for polling-based workflow managers
 *
 * Extracts common lifecycle, state transitions, and store operations from
 * EmpathyObserverWorkflowManager and DeepReflectWorkflowManager.
 *
 * Both managers implement the same polling-based workflow lifecycle:
 *   startWorkflow → driver.run() → store.createWorkflow → scheduleWaitPollWithRetry
 *   → driver.wait() → finalizeOnce → driver.cleanup()
 *
 * The base class handles all shared workflow management.
 * Subclasses provide only:
 *   - Their specific constants (WORKFLOW_SESSION_PREFIX, DEFAULT_TIMEOUT_MS, DEFAULT_TTL_MS)
 *   - Surface-degrade checks (boot session skip, subagent availability)
 *   - The createWorkflowRecord hook for type-specific metadata
 *
 * @module subagent-workflow/workflow-manager-base
 */
/* global NodeJS */
import type { PluginLogger } from '../../openclaw-sdk.js';
import type {
    WorkflowManager,
    WorkflowHandle,
    SubagentWorkflowSpec,
    WorkflowMetadata,
    WorkflowDebugSummary,
} from './types.js';
import { RuntimeDirectDriver, type RunParams } from './runtime-direct-driver.js';
import { WorkflowStore } from './workflow-store.js';
import { isSubagentRuntimeAvailable } from '../../utils/subagent-probe.js';
import { computeDynamicTimeout, computeRetrySchedule, MAX_TIMEOUT_RETRIES } from './dynamic-timeout.js';

// ── Constructor Options ────────────────────────────────────────────────────────

export interface WorkflowManagerBaseOptions {
    workspaceDir: string;
    logger: PluginLogger;
    subagent: RuntimeDirectDriver['subagent'];
    /** Pass api.runtime.agent.session to enable heartbeat-safe cleanup (#188) */
    agentSession?: RuntimeDirectDriver['agentSession'];
    /** Workflow type identifier for logging and dynamic timeout lookups (e.g. 'empathy-observer') */
    workflowType: string;
    /** Session key prefix (e.g. 'agent:main:subagent:workflow-') */
    sessionPrefix: string;
    /** Default polling timeout in milliseconds */
    defaultTimeoutMs: number;
    /** Default TTL for orphan cleanup in milliseconds */
    defaultTtlMs: number;
}

// ── Base Class ─────────────────────────────────────────────────────────────────

export abstract class WorkflowManagerBase implements WorkflowManager {
    // Protected: accessible to subclasses
    protected readonly store: WorkflowStore;
    protected readonly driver: RuntimeDirectDriver;
    protected readonly logger: PluginLogger;
    protected readonly workspaceDir: string;
    protected readonly workflowType: string;

    // Protected: shared state
    protected activeWorkflows = new Map<string, NodeJS.Timeout>();
    protected completedWorkflows = new Map<string, number>();
    protected workflowSpecs = new Map<string, SubagentWorkflowSpec<unknown>>();

    // Private: subclass-specific constants used by base class methods
    private readonly sessionPrefix: string;
    private readonly defaultTimeoutMs: number;
    private readonly defaultTtlMs: number;

    constructor(opts: WorkflowManagerBaseOptions) {
        this.workspaceDir = opts.workspaceDir;
        this.logger = opts.logger;
        this.store = new WorkflowStore({ workspaceDir: opts.workspaceDir });
        this.driver = new RuntimeDirectDriver({
            subagent: opts.subagent,
            logger: opts.logger,
            agentSession: opts.agentSession,
        });
        this.workflowType = opts.workflowType;
        this.sessionPrefix = opts.sessionPrefix;
        this.defaultTimeoutMs = opts.defaultTimeoutMs;
        this.defaultTtlMs = opts.defaultTtlMs;
    }

    // ── startWorkflow ─────────────────────────────────────────────────────────

    /**
     * Start a new workflow.
     *
     * Common flow:
     *   1. Validate surface checks (boot session, subagent availability)
     *   2. Generate workflowId + childSessionKey
     *   3. Build metadata (subclass provides via createWorkflowMetadata hook)
     *   4. Call driver.run()
     *   5. Create workflow record via createWorkflowRecord hook
     *   6. Register spec
     *   7. Schedule wait polling
     *
     * Subclasses override surfaceCheck or startWorkflow to add type-specific
     * surface-degrade checks before calling super.startWorkflow().
     */
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

        // Surface degrade: skip boot sessions
        if (options.parentSessionId.startsWith('boot-')) {
            this.logger.info(`[PD:${this.workflowType}] Skipping workflow: boot session`);
            throw new Error(`${this.constructor.name}: cannot start workflow for boot session`);
        }

        // Surface degrade: check subagent runtime availability
        if (!isSubagentRuntimeAvailable(this.driver.getSubagent())) {
            this.logger.info(`[PD:${this.workflowType}] Skipping workflow: subagent runtime unavailable`);
            throw new Error(`${this.constructor.name}: subagent runtime unavailable`);
        }

        if (spec.transport !== 'runtime_direct') {
            throw new Error(`${this.constructor.name} only supports runtime_direct transport`);
        }

        const runParams = this.buildRunParams(spec, options, childSessionKey);
        const runResult = await this.driver.run(runParams);

        const metadata = this.createWorkflowMetadata(spec, options, now);

        await this.createWorkflowRecord(workflowId, childSessionKey, spec, options, now, metadata, runResult.runId);

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

    // ── Protected Hooks (subclasses override) ─────────────────────────────────

    /**
     * Create workflow metadata for store.createWorkflow().
     * Subclasses override to add type-specific fields.
     */
    /* eslint-disable @typescript-eslint/class-methods-use-this -- Reason: Subclass hook that returns value via spec, not class state */
    protected createWorkflowMetadata<TResult>(
        spec: SubagentWorkflowSpec<TResult>,
        options: {
            parentSessionId: string;
            workspaceDir?: string;
            taskInput: unknown;
            metadata?: Record<string, unknown>;
        },
        now: number
    ): WorkflowMetadata {
        return {
            parentSessionId: options.parentSessionId,
            workspaceDir: options.workspaceDir,
            taskInput: options.taskInput,
            startedAt: now,
            workflowType: spec.workflowType,
            ...options.metadata,
        };
    }

    /**
     * Create a workflow record in the store.
     * Called after driver.run() succeeds.
     * Subclasses override to call store.createWorkflow() with type-specific metadata.
     */
    /* eslint-disable @typescript-eslint/max-params -- Reason: Interface hook requires all params from caller context */
    protected async createWorkflowRecord<TResult>(
        workflowId: string,
        childSessionKey: string,
        spec: SubagentWorkflowSpec<TResult>,
        options: {
            parentSessionId: string;
            workspaceDir?: string;
            taskInput: unknown;
            metadata?: Record<string, unknown>;
        },
        now: number,
        metadata: WorkflowMetadata,
        runId: string
    ): Promise<void> {
        this.store.createWorkflow({
            workflow_id: workflowId,
            workflow_type: spec.workflowType,
            transport: spec.transport,
            parent_session_id: options.parentSessionId,
            child_session_key: childSessionKey,
            run_id: runId,
            state: 'active',
            created_at: now,
            updated_at: now,
            duration_ms: null,
            metadata_json: JSON.stringify(metadata),
        });
    }

    // ── Protected Helpers ────────────────────────────────────────────────────

    /* eslint-disable @typescript-eslint/class-methods-use-this -- Reason: Helper method that delegates to spec.buildPrompt and driver.run */
    protected buildRunParams<TResult>(
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
    protected scheduleWaitPollWithRetry(
        workflowId: string,
        runId: string,
        attempt = 0,
    ): void {
        const spec = this.workflowSpecs.get(workflowId);
        const staticTimeout = spec?.timeoutMs ?? this.defaultTimeoutMs;

        // Compute dynamic timeout from historical data using this.workflowType
        const baseTimeout = computeDynamicTimeout(this.store, this.workflowType, staticTimeout);
        const schedule = computeRetrySchedule(baseTimeout, MAX_TIMEOUT_RETRIES);
        const timeoutMs = schedule[Math.min(attempt, schedule.length - 1)];
        const historyCount = this.store.getCompletionDurations(this.workflowType, 50).length;

        this.logger.info(`[PD:${this.workflowType}] Wait attempt ${attempt + 1}/${schedule.length}: timeout=${timeoutMs}ms (base=${baseTimeout}ms, static=${staticTimeout}ms, samples=${historyCount}) for ${workflowId}`);

        const timeout = setTimeout(async () => {
            try {
                const result = await this.driver.wait({ runId, timeoutMs });
                if (result.status === 'timeout' && attempt < MAX_TIMEOUT_RETRIES) {
                    this.logger.info(`[PD:${this.workflowType}] Timeout on attempt ${attempt + 1}, retrying for ${workflowId}`);
                    this.store.recordEvent(workflowId, 'wait_timeout_retry', 'active', 'active', `timeout on attempt ${attempt + 1}, scheduling retry ${attempt + 2}`, { attempt });
                    this.activeWorkflows.delete(workflowId);
                    this.scheduleWaitPollWithRetry(workflowId, runId, attempt + 1);
                    return;
                }
                if (result.status === 'ok' && attempt > 0) {
                    this.logger.info(`[PD:${this.workflowType}] Retry succeeded on attempt ${attempt + 1} after timeout for ${workflowId}`);
                }
                await this.notifyWaitResult(workflowId, result.status, result.error);
            } catch (error) {
                const errMsg = String(error);
                // Don't retry on database errors — the connection was closed
                // (typically by lifecycle notification dispose). The subagent
                // may have completed successfully.
                if (errMsg.includes('not open') || errMsg.includes('database')) {
                    this.logger.warn(`[PD:${this.workflowType}] Database error during wait poll for ${workflowId}: ${errMsg} — not retrying`);
                    return;
                }
                this.logger.error(`[PD:${this.workflowType}] Wait poll failed: ${errMsg}`);
                if (attempt < MAX_TIMEOUT_RETRIES) {
                    this.logger.info(`[PD:${this.workflowType}] Error on attempt ${attempt + 1}, retrying for ${workflowId}`);
                    this.activeWorkflows.delete(workflowId);
                    this.scheduleWaitPollWithRetry(workflowId, runId, attempt + 1);
                    return;
                }
                await this.notifyWaitResult(workflowId, 'error', errMsg);
            }
        }, 100);

        this.activeWorkflows.set(workflowId, timeout);
    }

    // ── WorkflowManager Interface ─────────────────────────────────────────────

    async notifyWaitResult(
        workflowId: string,
        status: 'ok' | 'error' | 'timeout',
        error?: string
    ): Promise<void> {
        // eslint-disable-next-line @typescript-eslint/init-declarations -- assigned in try, catch has early returns
        let workflow;
        try {
            workflow = this.store.getWorkflow(workflowId);
        /* eslint-disable @typescript-eslint/no-unused-vars, no-unused-vars -- Reason: Error is handled via early returns based on status, not error value */
        } catch (_dbError) {
            // Database connection closed (e.g., by lifecycle notification dispose).
            // If subagent succeeded, this is a known race condition — the workflow
            // will be handled by the original manager's finalizeOnce path.
            if (status === 'ok') {
                this.logger.info(`[PD:${this.workflowType}] notifyWaitResult: database unavailable for ${workflowId}, status=ok — skipping (original manager will finalize)`);
                return;
            }
            this.logger.warn(`[PD:${this.workflowType}] notifyWaitResult: database unavailable for ${workflowId}, status=${status}`);
            return;
        }
        if (!workflow) {
            this.logger.warn(`[PD:${this.workflowType}] notifyWaitResult: workflow not found: ${workflowId}`);
            return;
        }

        if (workflow.state === 'completed' || workflow.state === 'terminal_error' || workflow.state === 'expired') {
            this.logger.info(`[PD:${this.workflowType}] notifyWaitResult: ignoring terminal workflow: ${workflowId}, state=${workflow.state}`);
            return;
        }

        this.logger.info(`[PD:${this.workflowType}] notifyWaitResult: workflowId=${workflowId}, status=${status}`);

        const previousState = workflow.state;
        this.store.updateWorkflowState(workflowId, 'wait_result');
        this.store.recordEvent(workflowId, 'wait_result', previousState, 'wait_result', `wait completed: ${status}`, { error });

        const spec = this.workflowSpecs.get(workflowId);
        if (!spec) {
            // Spec not registered — lifecycle event notification path (subagent.ts).
            // Original manager's wait poll will handle finalization.
            this.logger.info(`[PD:${this.workflowType}] notifyWaitResult: spec not registered for ${workflowId} — skipping finalization (primary path will handle)`);
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
        this.logger.info(`[PD:${this.workflowType}] notifyLifecycleEvent: workflowId=${workflowId}, event=${event}`);

        if (event === 'subagent_ended' && data?.outcome) {
            await this.notifyWaitResult(workflowId, data.outcome === 'ok' ? 'ok' : data.outcome === 'error' ? 'error' : 'timeout', data.error);
        }
    }

    async finalizeOnce(workflowId: string): Promise<void> {
        const workflow = this.store.getWorkflow(workflowId);
        if (!workflow) {
            this.logger.warn(`[PD:${this.workflowType}] finalizeOnce: workflow not found: ${workflowId}`);
            return;
        }

        const spec = this.workflowSpecs.get(workflowId);
        if (!spec) {
            throw new Error(`Workflow spec not registered for ${workflowId}`);
        }

        if (this.isCompleted(workflowId)) {
            this.logger.info(`[PD:${this.workflowType}] finalizeOnce: already completed: ${workflowId}`);
            return;
        }

        this.logger.info(`[PD:${this.workflowType}] Finalizing workflow: ${workflowId}`);

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
                    this.logger.error(`[PD:${this.workflowType}] cleanup failed after persistence: ${String(cleanupError)}`);
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
            this.logger.info(`[PD:${this.workflowType}] Duration recorded: workflowId=${workflowId}, durationMs=${durationMs}ms (${(durationMs / 1000).toFixed(1)}s), type=${spec.workflowType}`);

            this.store.updateWorkflowState(workflowId, 'completed');
            this.store.recordEvent(workflowId, 'finalized', 'finalizing', 'completed', 'success', { durationMs });
            this.markCompleted(workflowId);

        } catch (error) {
            this.logger.error(`[PD:${this.workflowType}] finalizeOnce failed: ${String(error)}`);
            this.store.updateWorkflowState(workflowId, 'terminal_error');
            this.store.recordEvent(workflowId, 'finalize_error', 'finalizing', 'terminal_error', String(error), {});
            throw error;
        }
    }

    async sweepExpiredWorkflows(maxAgeMs?: number): Promise<number> {
        const ttl = maxAgeMs ?? this.defaultTtlMs;
        const expired = this.store.getExpiredWorkflows(ttl);

        this.logger.info(`[PD:${this.workflowType}] sweepExpiredWorkflows: found ${expired.length} expired`);

        for (const workflow of expired) {
            try {
                this.logger.info(`[PD:${this.workflowType}] Sweeping expired workflow: ${workflow.workflow_id}`);

                await this.driver.cleanup({ sessionKey: workflow.child_session_key });
                this.store.updateCleanupState(workflow.workflow_id, 'completed');
                this.store.updateWorkflowState(workflow.workflow_id, 'expired');
                this.store.recordEvent(workflow.workflow_id, 'swept', workflow.state, 'expired', 'TTL expired', {});

            } catch (error) {
                this.logger.error(`[PD:${this.workflowType}] Sweep cleanup failed for ${workflow.workflow_id}: ${String(error)}`);
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

    // ── Private Helpers ───────────────────────────────────────────────────────

    protected generateWorkflowId(): string {
        // Subclasses override the prefix part via wf_ prefix pattern
        return `wf_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    }

    protected buildChildSessionKey(parentSessionId: string): string {
        const safeParentSessionId = parentSessionId
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .substring(0, 64);
        const timestamp = Date.now();
        return `${this.sessionPrefix}${safeParentSessionId}-${timestamp}`;
    }

    protected isCompleted(workflowId: string): boolean {
        const timestamp = this.completedWorkflows.get(workflowId);
        if (!timestamp) return false;
        return Date.now() - timestamp < 60_000; // 1 minute dedup window
    }

    /**
     * Get the current state of a workflow by ID.
     * Returns null if the workflow doesn't exist.
     */
    getWorkflowState(workflowId: string): string | null {
        const workflow = this.store.getWorkflow(workflowId);
        return workflow?.state ?? null;
    }

    protected markCompleted(workflowId: string): void {
        const timeout = this.activeWorkflows.get(workflowId);
        if (timeout) {
            clearTimeout(timeout);
            this.activeWorkflows.delete(workflowId);
        }
        this.completedWorkflows.set(workflowId, Date.now());
        this.workflowSpecs.delete(workflowId);
    }

    dispose(): void {
        for (const [workflowId, timeout] of this.activeWorkflows) {
            clearTimeout(timeout);
            this.logger.info(`[PD:${this.workflowType}] Disposed active workflow: ${workflowId}`);
        }
        this.activeWorkflows.clear();
        this.completedWorkflows.clear();
        this.workflowSpecs.clear();
        this.store.dispose();
    }
}
