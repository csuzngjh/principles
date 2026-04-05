/**
 * NocturnalWorkflowManager — WorkflowManager interface for Nocturnal Reflection
 * =============================================================================
 *
 * PURPOSE: Wraps OpenClawTrinityRuntimeAdapter in the WorkflowManager interface.
 * Single-reflector path only (useTrinity=false). Trinity multi-stage chain comes
 * in Phase 7.
 *
 * DESIGN:
 * - NocturnalWorkflowManager calls executeNocturnalReflectionAsync synchronously
 *   within startWorkflow. There is no wait polling path.
 * - All 5 nocturnal event types are recorded: nocturnal_started, nocturnal_completed,
 *   nocturnal_failed, nocturnal_fallback, nocturnal_expired.
 * - sweepExpiredWorkflows marks expired workflows and cleans partial artifact files.
 * - notifyWaitResult and notifyLifecycleEvent are no-ops per D-10.
 *
 * PHASE: Phase 6 — Foundation and Single-Reflector Mode
 */

import type { PluginLogger } from '../../openclaw-sdk.js';
import type {
    WorkflowManager,
    WorkflowHandle,
    SubagentWorkflowSpec,
    WorkflowMetadata,
    WorkflowDebugSummary,
    WorkflowResultContext,
    WorkflowPersistContext,
} from './types.js';
import { WorkflowStore } from './workflow-store.js';
import { NocturnalPathResolver } from '../../core/nocturnal-paths.js';
import {
    executeNocturnalReflectionAsync,
    type NocturnalRunResult,
} from '../nocturnal-service.js';
import type { TrinityRuntimeAdapter, TrinityConfig } from '../../core/nocturnal-trinity.js';
import * as fs from 'fs';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// NocturnalResult Type Alias
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nocturnal workflow result type (mirrors NocturnalRunResult per D-02).
 * This is the result type returned by executeNocturnalReflectionAsync.
 */
export type NocturnalResult = NocturnalRunResult;

// ─────────────────────────────────────────────────────────────────────────────
// NocturnalWorkflowOptions
// ─────────────────────────────────────────────────────────────────────────────

export interface NocturnalWorkflowOptions {
    /** Workspace directory for artifact storage */
    workspaceDir: string;
    /** State directory for nocturnal runtime bookkeeping */
    stateDir: string;
    /** Plugin logger */
    logger: PluginLogger;
    /** Trinity runtime adapter for subagent execution */
    runtimeAdapter: TrinityRuntimeAdapter;
}

// ─────────────────────────────────────────────────────────────────────────────
// NocturnalWorkflowSpec
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nocturnal workflow specification.
 * Drives NocturnalWorkflowManager for the nocturnal reflection workflow.
 *
 * Per D-07, D-08, D-09, D-03, D-04:
 * - workflowType: 'nocturnal'
 * - transport: 'runtime_direct'
 * - shouldDeleteSessionAfterFinalize: false (no external session to delete)
 * - timeoutMs: 15 minutes (900000ms)
 * - ttlMs: 30 minutes (1800000ms)
 */
export const nocturnalWorkflowSpec: SubagentWorkflowSpec<NocturnalResult> = {
    workflowType: 'nocturnal',
    transport: 'runtime_direct',
    timeoutMs: 15 * 60 * 1000,        // D-03: 15 minutes
    ttlMs: 30 * 60 * 1000,            // D-04: 30 minutes
    shouldDeleteSessionAfterFinalize: false,  // D-09: no external session to delete

    buildPrompt(_taskInput: unknown, _metadata: WorkflowMetadata): string {
        // NocturnalWorkflowManager does not use prompt injection.
        // Execution is driven by executeNocturnalReflectionAsync.
        return '';
    },

    async parseResult(ctx: WorkflowResultContext): Promise<NocturnalResult | null> {
        // NocturnalWorkflowManager handles execution directly in startWorkflow.
        // This is not called via the standard subagent message path.
        return (ctx.metadata['nocturnalResult'] as NocturnalResult) ?? null;
    },

    async persistResult(_ctx: WorkflowPersistContext<NocturnalResult>): Promise<void> {
        // Artifact persistence is handled in startWorkflow after
        // executeNocturnalReflectionAsync returns. The artifact is already
        // persisted by the service; nothing more needed here.
    },

    shouldFinalizeOnWaitStatus(status: 'ok' | 'error' | 'timeout'): boolean {
        return status === 'ok';
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// NocturnalWorkflowManager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * NocturnalWorkflowManager — implements WorkflowManager for nocturnal reflection.
 *
 * Single-reflector path (useTrinity=false) only in Phase 6.
 * Trinity multi-stage chain (Dreamer→Philosopher→Scribe) comes in Phase 7.
 *
 * Key behaviors:
 * - startWorkflow calls executeNocturnalReflectionAsync with useTrinity=false
 * - Records all 5 nocturnal event types to WorkflowStore
 * - notifyWaitResult and notifyLifecycleEvent are no-ops
 * - sweepExpiredWorkflows marks expired workflows and cleans partial artifacts
 */
export class NocturnalWorkflowManager implements WorkflowManager {
    private readonly workspaceDir: string;
    private readonly stateDir: string;
    private readonly logger: PluginLogger;
    private readonly runtimeAdapter: TrinityRuntimeAdapter;
    private readonly store: WorkflowStore;

    /** Tracks completion timestamps for idempotency */
    private completedWorkflows = new Map<string, number>();
    /** Maps workflowId → spec (needed for finalizeOnce) */
    private workflowSpecs = new Map<string, SubagentWorkflowSpec<unknown>>();
    /** Maps workflowId → result (needed for finalizeOnce) */
    private executionResults = new Map<string, NocturnalResult>();

    constructor(opts: NocturnalWorkflowOptions) {
        this.workspaceDir = opts.workspaceDir;
        this.stateDir = opts.stateDir;
        this.logger = opts.logger;
        this.runtimeAdapter = opts.runtimeAdapter;
        this.store = new WorkflowStore({ workspaceDir: opts.workspaceDir });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // WorkflowManager Interface: startWorkflow (NOC-01, NOC-02, NOC-03)
    // ─────────────────────────────────────────────────────────────────────────

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
        const now = Date.now();

        const metadata: WorkflowMetadata = {
            parentSessionId: options.parentSessionId,
            workspaceDir: options.workspaceDir,
            taskInput: options.taskInput,
            startedAt: now,
            workflowType: spec.workflowType,
            ...options.metadata,
        };

        this.logger.info(`[PD:NocturnalWorkflow] Starting workflow: workflowId=${workflowId}, type=${spec.workflowType}`);

        // Record nocturnal_started event (NOC-03)
        this.store.createWorkflow({
            workflow_id: workflowId,
            workflow_type: spec.workflowType,
            transport: spec.transport,
            parent_session_id: options.parentSessionId,
            child_session_key: `nocturnal:internal:${workflowId}`,  // D-10: placeholder since adapter manages sessions internally
            run_id: null,
            state: 'active',
            created_at: now,
            updated_at: now,
            metadata_json: JSON.stringify(metadata),
        });
        this.store.recordEvent(workflowId, 'nocturnal_started', null, 'active', 'TrinityRuntimeAdapter invoked', { workflowType: 'nocturnal' });

        // Execute single-reflector path (NOC-02): useTrinity=false
        const trinityConfig: Partial<TrinityConfig> = {
            useTrinity: false,  // D-10: single-reflector only in Phase 6
            maxCandidates: 3,
            useStubs: false,
            runtimeAdapter: this.runtimeAdapter,
        };

        const result = await executeNocturnalReflectionAsync(
            this.workspaceDir,
            this.stateDir,
            { trinityConfig, runtimeAdapter: this.runtimeAdapter }
        );

        // Store execution result and spec for finalizeOnce
        this.executionResults.set(workflowId, result);
        this.workflowSpecs.set(workflowId, spec as SubagentWorkflowSpec<unknown>);

        const previousState = 'active';

        if (result.success && result.artifact) {
            // Record nocturnal_completed event (NOC-03, D-05)
            this.store.updateWorkflowState(workflowId, 'completed');
            this.store.recordEvent(workflowId, 'nocturnal_completed', previousState, 'completed', 'artifact persisted', {
                persistedPath: result.diagnostics.persistedPath,
            });
            this.markCompleted(workflowId);
        } else if (result.noTargetSelected || result.skipReason) {
            // Record nocturnal_fallback event (NOC-03, D-05)
            this.store.updateWorkflowState(workflowId, 'completed');
            this.store.recordEvent(workflowId, 'nocturnal_fallback', previousState, 'completed', `skip: ${result.skipReason ?? 'no target'}`, {
                skipReason: result.skipReason,
                noTargetSelected: result.noTargetSelected,
            });
            this.markCompleted(workflowId);
        } else {
            // Record nocturnal_failed event (NOC-03, D-05)
            this.store.updateWorkflowState(workflowId, 'terminal_error');
            this.store.recordEvent(workflowId, 'nocturnal_failed', previousState, 'terminal_error', 'validation failed', {
                validationFailures: result.validationFailures,
                success: result.success,
            });
            this.markCompleted(workflowId);
        }

        return {
            workflowId,
            childSessionKey: `nocturnal:internal:${workflowId}`,
            runId: undefined,
            state: 'completed',
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // WorkflowManager Interface: notifyWaitResult (NOC-01, D-10: no-op)
    // ─────────────────────────────────────────────────────────────────────────

    async notifyWaitResult(
        _workflowId: string,
        _status: 'ok' | 'error' | 'timeout',
        _error?: string
    ): Promise<void> {
        // D-10: No-op. NocturnalWorkflowManager calls executeNocturnalReflectionAsync
        // synchronously in startWorkflow. There is no wait polling path.
        // The execution completes within startWorkflow; no separate wait phase exists.
    }

    // ─────────────────────────────────────────────────────────────────────────
    // WorkflowManager Interface: notifyLifecycleEvent (NOC-01, D-10: no-op)
    // ─────────────────────────────────────────────────────────────────────────

    async notifyLifecycleEvent(
        _workflowId: string,
        _event: 'subagent_spawned' | 'subagent_ended',
        _data?: Record<string, unknown>
    ): Promise<void> {
        // D-10: No-op. NocturnalWorkflowManager does not use the wait-on-run pattern.
        // TrinityRuntimeAdapter manages its own internal subagent lifecycle.
        // No external subagent_spawned/subagent_ended events need to be tracked.
    }

    // ─────────────────────────────────────────────────────────────────────────
    // WorkflowManager Interface: finalizeOnce (NOC-01)
    // ─────────────────────────────────────────────────────────────────────────

    async finalizeOnce(workflowId: string): Promise<void> {
        const workflow = this.store.getWorkflow(workflowId);
        if (!workflow) {
            this.logger.warn(`[PD:NocturnalWorkflow] finalizeOnce: workflow not found: ${workflowId}`);
            return;
        }

        if (this.isCompleted(workflowId)) {
            this.logger.info(`[PD:NocturnalWorkflow] finalizeOnce: already completed: ${workflowId}`);
            return;
        }

        // NocturnalWorkflowManager completes execution synchronously in startWorkflow.
        // If we reach here, the workflow was already marked as completed/failed.
        // Nothing more to do - result already persisted by executeNocturnalReflectionAsync.
        this.logger.info(`[PD:NocturnalWorkflow] finalizeOnce: workflow already in terminal state: ${workflowId}, state=${workflow.state}`);
        this.markCompleted(workflowId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // WorkflowManager Interface: sweepExpiredWorkflows (NOC-05)
    // ─────────────────────────────────────────────────────────────────────────

    async sweepExpiredWorkflows(maxAgeMs = 30 * 60 * 1000): Promise<number> {
        const expired = this.store.getExpiredWorkflows(maxAgeMs);

        this.logger.info(`[PD:NocturnalWorkflow] sweepExpiredWorkflows: found ${expired.length} expired`);

        for (const workflow of expired) {
            try {
                this.logger.info(`[PD:NocturnalWorkflow] Sweeping expired workflow: ${workflow.workflow_id}`);

                // D-06: Mark as expired in WorkflowStore
                this.store.updateWorkflowState(workflow.workflow_id, 'expired');
                this.store.recordEvent(workflow.workflow_id, 'nocturnal_expired', workflow.state, 'expired', 'TTL expired', { workflowId: workflow.workflow_id });

                // D-06: Clean partial artifact files by workflowId prefix
                const samplesDir = NocturnalPathResolver.resolveNocturnalDir(this.workspaceDir, 'SAMPLES');
                if (fs.existsSync(samplesDir)) {
                    const files = fs.readdirSync(samplesDir).filter(f => f.includes(workflow.workflow_id));
                    for (const file of files) {
                        const filePath = path.join(samplesDir, file);
                        try {
                            fs.unlinkSync(filePath);
                            this.logger.info(`[PD:NocturnalWorkflow] Removed partial artifact: ${filePath}`);
                        } catch (unlinkErr) {
                            this.logger.warn(`[PD:NocturnalWorkflow] Failed to remove partial artifact ${filePath}: ${String(unlinkErr)}`);
                        }
                    }
                }

            } catch (error) {
                this.logger.error(`[PD:NocturnalWorkflow] Sweep failed for ${workflow.workflow_id}: ${String(error)}`);
            }
        }

        // Clean up memory Maps to prevent leaks
        const cutoff = Date.now() - 60_000; // 1 minute dedup window
        for (const [id, timestamp] of this.completedWorkflows) {
            if (timestamp < cutoff) {
                this.completedWorkflows.delete(id);
            }
        }

        return expired.length;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // WorkflowManager Interface: getWorkflowDebugSummary (NOC-01)
    // ─────────────────────────────────────────────────────────────────────────

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

    // ─────────────────────────────────────────────────────────────────────────
    // WorkflowManager Interface: dispose (NOC-01)
    // ─────────────────────────────────────────────────────────────────────────

    dispose(): void {
        this.store.dispose();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helper Methods
    // ─────────────────────────────────────────────────────────────────────────

    private generateWorkflowId(): string {
        return `wf_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
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
        this.executionResults.delete(workflowId);
    }
}
