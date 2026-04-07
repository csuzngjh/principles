import type { PluginLogger } from '../../openclaw-sdk.js';
import type {
    WorkflowManager,
    WorkflowHandle,
    SubagentWorkflowSpec,
    WorkflowMetadata,
    WorkflowDebugSummary,
    EmpathyObserverPayload,
    EmpathyResult,
    WorkflowResultContext,
    WorkflowPersistContext,
} from './types.js';
import { RuntimeDirectDriver, type RunParams } from './runtime-direct-driver.js';
import { WorkflowStore } from './workflow-store.js';
import { isSubagentRuntimeAvailable } from '../../utils/subagent-probe.js';
import { WorkspaceContext } from '../../core/workspace-context.js';
import { trackFriction } from '../../core/session-tracker.js';
import { computeDynamicTimeout, computeRetrySchedule, MAX_TIMEOUT_RETRIES } from './dynamic-timeout.js';

const WORKFLOW_SESSION_PREFIX = 'agent:main:subagent:workflow-';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface EmpathyObserverWorkflowOptions {
    workspaceDir: string;
    logger: PluginLogger;
    subagent: RuntimeDirectDriver['subagent'];
}

export class EmpathyObserverWorkflowManager implements WorkflowManager {
    private readonly store: WorkflowStore;
    private readonly driver: RuntimeDirectDriver;
    private readonly logger: PluginLogger;
    private readonly workspaceDir: string;
    
    private activeWorkflows = new Map<string, NodeJS.Timeout>();
    private completedWorkflows = new Map<string, number>();
    private workflowSpecs = new Map<string, SubagentWorkflowSpec<unknown>>();
    
    constructor(opts: EmpathyObserverWorkflowOptions) {
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
        
        this.logger.info(`[PD:EmpathyObserverWorkflow] Starting workflow: workflowId=${workflowId}, type=${spec.workflowType}`);
        
        // Surface degrade: skip boot sessions (they run outside gateway request context)
        if (options.parentSessionId.startsWith('boot-')) {
            this.logger.info(`[PD:EmpathyObserverWorkflow] Skipping workflow: boot session (gateway request context unavailable)`);
            throw new Error(`EmpathyObserverWorkflowManager: cannot start workflow for boot session`);
        }
        
        // Surface degrade: check subagent runtime availability before calling run()
        if (!isSubagentRuntimeAvailable(this.driver.getSubagent())) {
            this.logger.info(`[PD:EmpathyObserverWorkflow] Skipping workflow: subagent runtime unavailable`);
            throw new Error(`EmpathyObserverWorkflowManager: subagent runtime unavailable`);
        }
        
        if (spec.transport !== 'runtime_direct') {
            throw new Error(`EmpathyObserverWorkflowManager only supports runtime_direct transport`);
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
    
    static buildEmpathyPrompt(userMessage: string): string {
        return [
            'You are an empathy observer.',
            'Analyze ONLY the user message and return strict JSON (no markdown):',
            '{"damageDetected": boolean, "severity": "mild|moderate|severe", "confidence": number, "reason": string}',
            `User message: ${JSON.stringify(userMessage.trim())}`,
        ].join('\n');
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
        const baseTimeout = computeDynamicTimeout(this.store, spec?.workflowType ?? 'empathy-observer', staticTimeout);
        const schedule = computeRetrySchedule(baseTimeout, MAX_TIMEOUT_RETRIES);
        const timeoutMs = schedule[Math.min(attempt, schedule.length - 1)];
        const historyCount = this.store.getCompletionDurations(spec?.workflowType ?? 'empathy-observer', 50).length;

        this.logger.info(`[PD:EmpathyObserverWorkflow] Wait attempt ${attempt + 1}/${schedule.length}: timeout=${timeoutMs}ms (base=${baseTimeout}ms, static=${staticTimeout}ms, samples=${historyCount}) for ${workflowId}`);

        const timeout = setTimeout(async () => {
            try {
                const result = await this.driver.wait({ runId, timeoutMs });
                if (result.status === 'timeout' && attempt < MAX_TIMEOUT_RETRIES) {
                    this.logger.info(`[PD:EmpathyObserverWorkflow] Timeout on attempt ${attempt + 1}, retrying for ${workflowId}`);
                    this.store.recordEvent(workflowId, 'wait_timeout_retry', 'active', 'active', `timeout on attempt ${attempt + 1}, scheduling retry ${attempt + 2}`, { attempt });
                    // Clean up current timeout handle before scheduling next
                    this.activeWorkflows.delete(workflowId);
                    this.scheduleWaitPollWithRetry(workflowId, runId, attempt + 1);
                    return;
                }
                // Log retry success if we got here after a timeout
                if (result.status === 'ok' && attempt > 0) {
                    this.logger.info(`[PD:EmpathyObserverWorkflow] Retry succeeded on attempt ${attempt + 1} after timeout for ${workflowId}`);
                }
                await this.notifyWaitResult(workflowId, result.status, result.error);
            } catch (error) {
                const errMsg = String(error);
                // Don't retry on database errors — the connection was closed
                // (typically by lifecycle notification dispose). The subagent
                // may have completed successfully.
                if (errMsg.includes('not open') || errMsg.includes('database')) {
                    this.logger.warn(`[PD:EmpathyObserverWorkflow] Database error during wait poll for ${workflowId}: ${errMsg} — not retrying`);
                    return;
                }
                this.logger.error(`[PD:EmpathyObserverWorkflow] Wait poll failed: ${errMsg}`);
                if (attempt < MAX_TIMEOUT_RETRIES) {
                    this.logger.info(`[PD:EmpathyObserverWorkflow] Error on attempt ${attempt + 1}, retrying for ${workflowId}`);
                    this.activeWorkflows.delete(workflowId);
                    this.scheduleWaitPollWithRetry(workflowId, runId, attempt + 1);
                    return;
                }
                await this.notifyWaitResult(workflowId, 'error', errMsg);
            }
        }, 100);

        this.activeWorkflows.set(workflowId, timeout);
    }
    
    async notifyWaitResult(
        workflowId: string,
        status: 'ok' | 'error' | 'timeout',
        error?: string
    ): Promise<void> {
        let workflow;
        try {
            workflow = this.store.getWorkflow(workflowId);
        } catch (dbError) {
            // Database connection closed (e.g., by lifecycle notification dispose).
            // If subagent succeeded, this is a known race condition — the workflow
            // will be handled by the original manager's finalizeOnce path.
            if (status === 'ok') {
                this.logger.info(`[PD:EmpathyObserverWorkflow] notifyWaitResult: database unavailable for ${workflowId}, status=ok — skipping (original manager will finalize)`);
                return;
            }
            this.logger.warn(`[PD:EmpathyObserverWorkflow] notifyWaitResult: database unavailable for ${workflowId}, status=${status}`);
            return;
        }
        if (!workflow) {
            this.logger.warn(`[PD:EmpathyObserverWorkflow] notifyWaitResult: workflow not found: ${workflowId}`);
            return;
        }

        if (workflow.state === 'completed' || workflow.state === 'terminal_error' || workflow.state === 'expired') {
            this.logger.info(`[PD:EmpathyObserverWorkflow] notifyWaitResult: ignoring terminal workflow: ${workflowId}, state=${workflow.state}`);
            return;
        }
        
        this.logger.info(`[PD:EmpathyObserverWorkflow] notifyWaitResult: workflowId=${workflowId}, status=${status}`);

        const previousState = workflow.state;
        this.store.updateWorkflowState(workflowId, 'wait_result');
        this.store.recordEvent(workflowId, 'wait_result', previousState, 'wait_result', `wait completed: ${status}`, { error });

        const spec = this.workflowSpecs.get(workflowId);
        if (!spec) {
            // Spec not registered — this happens when notifyWaitResult is called from
            // a lifecycle event notification (subagent.ts) rather than the primary
            // scheduleWaitPollWithRetry path. The original manager instance will handle
            // finalization via its wait poll. Just record the event and return.
            this.logger.info(`[PD:EmpathyObserverWorkflow] notifyWaitResult: spec not registered for ${workflowId} — skipping finalization (primary path will handle)`);
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
        this.logger.info(`[PD:EmpathyObserverWorkflow] notifyLifecycleEvent: workflowId=${workflowId}, event=${event}`);
        
        if (event === 'subagent_ended' && data?.outcome) {
            await this.notifyWaitResult(workflowId, data.outcome === 'ok' ? 'ok' : data.outcome === 'error' ? 'error' : 'timeout', data.error);
        }
    }
    
    async finalizeOnce(workflowId: string): Promise<void> {
        const workflow = this.store.getWorkflow(workflowId);
        if (!workflow) {
            this.logger.warn(`[PD:EmpathyObserverWorkflow] finalizeOnce: workflow not found: ${workflowId}`);
            return;
        }

        const spec = this.workflowSpecs.get(workflowId);
        if (!spec) {
            throw new Error(`Workflow spec not registered for ${workflowId}`);
        }
        
        if (this.isCompleted(workflowId)) {
            this.logger.info(`[PD:EmpathyObserverWorkflow] finalizeOnce: already completed: ${workflowId}`);
            return;
        }
        
        this.logger.info(`[PD:EmpathyObserverWorkflow] Finalizing workflow: ${workflowId}`);
        
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
                    this.logger.error(`[PD:EmpathyObserverWorkflow] cleanup failed after persistence: ${String(cleanupError)}`);
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
            this.logger.info(`[PD:EmpathyObserverWorkflow] Duration recorded: workflowId=${workflowId}, durationMs=${durationMs}ms (${(durationMs / 1000).toFixed(1)}s), type=${spec.workflowType}`);

            this.store.updateWorkflowState(workflowId, 'completed');
            this.store.recordEvent(workflowId, 'finalized', 'finalizing', 'completed', 'success', { durationMs });
            this.markCompleted(workflowId);

        } catch (error) {
            this.logger.error(`[PD:EmpathyObserverWorkflow] finalizeOnce failed: ${String(error)}`);
            this.store.updateWorkflowState(workflowId, 'terminal_error');
            this.store.recordEvent(workflowId, 'finalize_error', 'finalizing', 'terminal_error', String(error), {});
            throw error;
        }
    }
    
    async sweepExpiredWorkflows(maxAgeMs = DEFAULT_TTL_MS): Promise<number> {
        const expired = this.store.getExpiredWorkflows(maxAgeMs);

        this.logger.info(`[PD:EmpathyObserverWorkflow] sweepExpiredWorkflows: found ${expired.length} expired`);

        for (const workflow of expired) {
            try {
                this.logger.info(`[PD:EmpathyObserverWorkflow] Sweeping expired workflow: ${workflow.workflow_id}`);

                await this.driver.cleanup({ sessionKey: workflow.child_session_key });
                this.store.updateCleanupState(workflow.workflow_id, 'completed');
                this.store.updateWorkflowState(workflow.workflow_id, 'expired');
                this.store.recordEvent(workflow.workflow_id, 'swept', workflow.state, 'expired', 'TTL expired', {});

            } catch (error) {
                this.logger.error(`[PD:EmpathyObserverWorkflow] Sweep cleanup failed for ${workflow.workflow_id}: ${String(error)}`);
                this.store.updateCleanupState(workflow.workflow_id, 'failed');
            }
        }

        // Clean up memory Maps to prevent leaks
        const cutoff = Date.now() - 60_000; // 1 minute dedup window
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
        return `wf_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    }
    
    private buildChildSessionKey(parentSessionId: string): string {
        const safeParentSessionId = parentSessionId
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .substring(0, 64);
        const timestamp = Date.now();
        return `${WORKFLOW_SESSION_PREFIX}${safeParentSessionId}-${timestamp}`;
    }
    
    private extractAssistantText(messages: unknown[], assistantTexts?: string[]): string {
        if (assistantTexts && assistantTexts.length > 0) {
            return assistantTexts[assistantTexts.length - 1] || '';
        }
        
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i] as { role?: string; content?: unknown };
            if (msg?.role !== 'assistant') continue;
            if (typeof msg.content === 'string') return msg.content;
            if (Array.isArray(msg.content)) {
                const txt = msg.content
                    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
                    .map((part: any) => part.text)
                    .join('\n');
                if (txt) return txt;
            }
        }
        
        return '';
    }
    
    parseEmpathyPayload(rawText: string): EmpathyObserverPayload | null {
        if (!rawText?.trim()) return null;
        
        try {
            return JSON.parse(rawText.trim()) as EmpathyObserverPayload;
        } catch {
            const match = rawText.match(/\{[\s\S]*\}/);
            if (!match) {
                this.logger.warn('[PD:EmpathyObserverWorkflow] Observer payload is not valid JSON');
                return null;
            }
            try {
                return JSON.parse(match[0]) as EmpathyObserverPayload;
            } catch {
                this.logger.warn('[PD:EmpathyObserverWorkflow] Failed to parse observer JSON payload');
                return null;
            }
        }
    }
    
    private isCompleted(workflowId: string): boolean {
        const timestamp = this.completedWorkflows.get(workflowId);
        if (!timestamp) return false;
        if (Date.now() - timestamp > 5 * 60 * 1000) {
            this.completedWorkflows.delete(workflowId);
            return false;
        }
        return true;
    }
    
    private markCompleted(workflowId: string): void {
        this.completedWorkflows.set(workflowId, Date.now());
        this.workflowSpecs.delete(workflowId);
        
        const timeout = this.activeWorkflows.get(workflowId);
        if (timeout) {
            clearTimeout(timeout);
            this.activeWorkflows.delete(workflowId);
        }
    }
    
    dispose(): void {
        for (const timeout of this.activeWorkflows.values()) {
            clearTimeout(timeout);
        }
        this.activeWorkflows.clear();
        this.store.dispose();
    }
}

export function createEmpathyObserverWorkflowManager(
    opts: EmpathyObserverWorkflowOptions
): EmpathyObserverWorkflowManager {
    return new EmpathyObserverWorkflowManager(opts);
}

/**
 * Extract raw assistant text from messages or assistantTexts array.
 */
function extractAssistantTextForSpec(messages: unknown[], assistantTexts?: string[]): string {
    if (assistantTexts && assistantTexts.length > 0) {
        return assistantTexts[assistantTexts.length - 1] || '';
    }
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i] as { role?: string; content?: unknown };
        if (msg?.role !== 'assistant') continue;
        if (typeof msg.content === 'string') return msg.content;
        if (Array.isArray(msg.content)) {
            const txt = msg.content
                .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
                .map((part: any) => part.text)
                .join('\n');
            if (txt) return txt;
        }
    }
    return '';
}

/**
 * Parse empathy observer JSON payload from raw text.
 */
function parseEmpathyPayloadForSpec(rawText: string): EmpathyObserverPayload | null {
    if (!rawText?.trim()) return null;
    try {
        return JSON.parse(rawText.trim()) as EmpathyObserverPayload;
    } catch {
        const match = rawText.match(/\{[\s\S]*\}/);
        if (!match) return null;
        try {
            return JSON.parse(match[0]) as EmpathyObserverPayload;
        } catch {
            return null;
        }
    }
}

/**
 * Normalize severity to valid enum.
 */
function normalizeSeverityForSpec(severity: string | undefined): 'mild' | 'moderate' | 'severe' {
    if (severity === 'severe') return 'severe';
    if (severity === 'moderate') return 'moderate';
    return 'mild';
}

/**
 * Normalize confidence to [0, 1] range.
 */
function normalizeConfidenceForSpec(value: number | undefined): number {
    if (!Number.isFinite(value)) return 1;
    return Math.max(0, Math.min(1, Number(value)));
}

/**
 * Calculate pain score from severity using config.
 */
function scoreFromSeverityForSpec(severity: string | undefined, wctx: WorkspaceContext): number {
    if (severity === 'severe') return Number(wctx.config.get('empathy_engine.penalties.severe') ?? 40);
    if (severity === 'moderate') return Number(wctx.config.get('empathy_engine.penalties.moderate') ?? 25);
    return Number(wctx.config.get('empathy_engine.penalties.mild') ?? 10);
}

/**
 * EmpathyObserver workflow specification.
 * This spec drives EmpathyObserverWorkflowManager for the empathy observer workflow.
 */
export const empathyObserverWorkflowSpec: SubagentWorkflowSpec<EmpathyResult> = {
    workflowType: 'empathy-observer',
    transport: 'runtime_direct',
    timeoutMs: 30_000,
    ttlMs: 300_000,
    shouldDeleteSessionAfterFinalize: true,

    buildPrompt(taskInput: unknown, _metadata: WorkflowMetadata): string {
        const userMessage = String(taskInput).trim();
        return [
            'You are an empathy observer.',
            'Analyze ONLY the user message and return strict JSON (no markdown):',
            '{"damageDetected": boolean, "severity": "mild|moderate|severe", "confidence": number, "reason": string}',
            `User message: ${JSON.stringify(userMessage)}`,
        ].join('\n');
    },

    async parseResult(ctx: WorkflowResultContext): Promise<EmpathyResult | null> {
        const rawText = extractAssistantTextForSpec(ctx.messages, ctx.assistantTexts);
        const payload = parseEmpathyPayloadForSpec(rawText);
        if (!payload) return null;

        return {
            damageDetected: payload.damageDetected ?? false,
            severity: normalizeSeverityForSpec(payload.severity),
            confidence: normalizeConfidenceForSpec(payload.confidence),
            reason: payload.reason ?? '',
            painScore: 0,
        };
    },

    async persistResult(ctx: WorkflowPersistContext<EmpathyResult>): Promise<void> {
        const { result, metadata, workspaceDir } = ctx;
        if (!result.damageDetected) return;

        const wctx = WorkspaceContext.fromHookContext({ workspaceDir });
        const painScore = scoreFromSeverityForSpec(result.severity, wctx);

        trackFriction(
            metadata.parentSessionId,
            painScore,
            `observer_empathy_${result.severity}`,
            workspaceDir,
            { source: 'user_empathy' }
        );

        const eventId = `emp_obs_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        wctx.eventLog.recordPainSignal(metadata.parentSessionId, {
            score: painScore,
            source: 'user_empathy',
            reason: result.reason || 'Empathy observer detected likely user frustration.',
            isRisky: false,
            origin: 'system_infer',
            severity: result.severity,
            confidence: result.confidence,
            detection_mode: 'structured',
            deduped: false,
            trigger_text_excerpt: String(metadata.taskInput ?? '').substring(0, 120),
            raw_score: painScore,
            calibrated_score: painScore,
            eventId,
        });

        try {
            wctx.trajectory?.recordPainEvent?.({
                sessionId: metadata.parentSessionId,
                source: 'user_empathy',
                score: painScore,
                reason: result.reason || 'Empathy observer detected likely user frustration.',
                severity: result.severity,
                origin: 'system_infer',
                confidence: result.confidence,
                // Use runtime check instead of type assertion
                text: typeof metadata.taskInput === 'string' ? metadata.taskInput : undefined,
            });
        } catch (error) {
            console.warn(`[PD:EmpathyObserverWorkflow] Failed to persist trajectory: ${String(error)}`);
        }
    },

    shouldFinalizeOnWaitStatus(status: 'ok' | 'error' | 'timeout'): boolean {
        return status === 'ok';
    },
};
