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
    WorkflowEventRow,
} from './types.js';
import { WorkflowStore } from './workflow-store.js';
import { resolveNocturnalDir } from '../../core/nocturnal-paths.js';
import {
    executeNocturnalReflectionAsync,
    type NocturnalRunResult,
} from '../nocturnal-service.js';
import { type TrinityStageFailure, type TrinityResult } from '../../core/nocturnal-trinity.js';
import type { TrinityRuntimeAdapter, TrinityConfig, DreamerOutput, PhilosopherOutput, TrinityTelemetry } from '../../core/nocturnal-trinity.js';
import type { NocturnalSessionSnapshot } from '../../core/nocturnal-trajectory-extractor.js';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isSubagentRuntimeAvailable } from '../../utils/subagent-probe.js';

// ─────────────────────────────────────────────────────────────────────────────
// NocturnalResult Type Alias
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nocturnal workflow result type (mirrors NocturnalRunResult per D-02).
 * This is the result type returned by executeNocturnalReflectionAsync.
 */
export type NocturnalResult = NocturnalRunResult;

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency Key Computation (D-18)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute idempotency key for the Dreamer stage (D-18).
 * Key = SHA-256(workflowId + stage + inputDigest)
 * inputDigest = SHA-256(snapshot.sessionId + principleId + maxCandidates)
 * Uses simple concatenation (no delimiters) per D-18 spec.
 */
function computeDreamerIdempotencyKey(
  workflowId: string,
  snapshot: import('../../core/nocturnal-trajectory-extractor.js').NocturnalSessionSnapshot,
  principleId: string,
  maxCandidates: number
): string {
  // Use delimiters to prevent collision (e.g., "sess10"+"2"+"3" vs "sess1"+"02"+"3")
  const inputDigest = createHash('sha256')
    .update(`${snapshot.sessionId}::${principleId}::${maxCandidates}`)
    .digest('hex');
  return createHash('sha256')
    .update(`${workflowId}::dreamer::${inputDigest}`)
    .digest('hex');
}

/**
 * Compute idempotency key for the Philosopher stage (D-18).
 * Key = SHA-256(workflowId + stage + inputDigest)
 * inputDigest = SHA-256(workflowId + dreamerOutputJson)
 * Uses simple concatenation (no delimiters) per D-18 spec.
 */
function computePhilosopherIdempotencyKey(
  workflowId: string,
  dreamerOutput: import('../../core/nocturnal-trinity.js').DreamerOutput
): string {
  const dreamerOutputJson = JSON.stringify(dreamerOutput);
  const inputDigest = createHash('sha256')
    .update(workflowId + dreamerOutputJson)
    .digest('hex');
  return createHash('sha256')
    .update(workflowId + 'philosopher' + inputDigest)
    .digest('hex');
}

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
// Stub Fallback Runtime Adapter (NOC-15)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stub fallback runtime adapter for Trinity.
 * Wraps a real adapter and provides stub implementations for fallback when stages fail.
 * Per NOC-15: Fallback degrades to stub, NOT to EmpathyObserver/DeepReflect.
 */
class StubFallbackRuntimeAdapter implements TrinityRuntimeAdapter {
    constructor(
        private snapshot: NocturnalSessionSnapshot,
        private principleId: string,
        private maxCandidates: number
    ) {}

    async invokeDreamer(
        snapshot: NocturnalSessionSnapshot,
        principleId: string,
        maxCandidates: number
    ): Promise<DreamerOutput> {
        const { invokeStubDreamer } = await import('../../core/nocturnal-trinity.js');
        return invokeStubDreamer(snapshot, principleId, maxCandidates);
    }

    async invokePhilosopher(
        dreamerOutput: DreamerOutput,
        principleId: string
    ): Promise<PhilosopherOutput> {
        const { invokeStubPhilosopher } = await import('../../core/nocturnal-trinity.js');
        return invokeStubPhilosopher(dreamerOutput, principleId);
    }

    async invokeScribe(
        dreamerOutput: DreamerOutput,
        philosopherOutput: PhilosopherOutput,
        snapshot: NocturnalSessionSnapshot,
        principleId: string,
        telemetry: TrinityTelemetry,
        config: TrinityConfig
    ): Promise<import('../../core/nocturnal-trinity.js').TrinityDraftArtifact | null> {
        // Use stub Scribe
        const { invokeStubScribe } = await import('../../core/nocturnal-trinity.js');
        return invokeStubScribe(dreamerOutput, philosopherOutput, snapshot, principleId, telemetry, config);
    }

    async close(): Promise<void> {
        // No-op for stubs
    }
}

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
    /** Maps workflowId → TrinityStageFailure[] (stored before async launch, used in notifyWaitResult) */
    private pendingTrinityFailures = new Map<string, TrinityStageFailure[]>();
    /** Maps workflowId → TrinityResult (needed by notifyWaitResult for artifact persistence) */
    private pendingTrinityResults = new Map<string, TrinityResult>();

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
        // #179: Check subagent runtime availability before starting
        // Other workflow managers (empathy, deep-reflect) have this check
        const subagent = (this.runtimeAdapter as any).api?.runtime?.subagent;
        if (!isSubagentRuntimeAvailable(subagent)) {
            this.logger.warn(`[PD:NocturnalWorkflow] Subagent runtime unavailable, skipping workflow`);
            throw new Error(`NocturnalWorkflowManager: subagent runtime unavailable`);
        }

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
            duration_ms: null,
            metadata_json: JSON.stringify(metadata),
        });
        this.store.recordEvent(workflowId, 'nocturnal_started', null, 'active', 'TrinityRuntimeAdapter invoked', { workflowType: 'nocturnal' });

        // Extract snapshot and principleId from taskInput.metadata (NOC-07: Trinity async path)
        const snapshot = options.metadata?.snapshot as import('../../core/nocturnal-trajectory-extractor.js').NocturnalSessionSnapshot | undefined;
        const principleId = options.metadata?.principleId as string | undefined;
        // Extract painContext for Selector ranking bias
        const painContext = options.metadata?.painContext as import('../evolution-worker.js').RecentPainContext | undefined;

        // Validate required metadata (prevent runtime crashes from undefined snapshot)
        if (!snapshot?.sessionId) {
            this.logger.warn(`[PD:NocturnalWorkflow] Missing snapshot.sessionId in metadata for workflow=${workflowId}, terminating`);
            this.store.recordEvent(workflowId, 'nocturnal_failed', null, 'terminal_error', 'Missing required metadata: snapshot.sessionId', { workflowId });
            return {
                workflowId,
                childSessionKey: `nocturnal:internal:${workflowId}`,
                state: 'terminal_error' as const,
            };
        }
        // #205: Always use executeNocturnalReflectionAsync for unified pipeline
        // This ensures the full post-processing flow is always executed:
        // Selector → Trinity → Arbiter → Executability → Persist → Register
        //
        // When principleId is provided, we pass it as principleIdOverride to skip Selector.
        // When principleId is missing, Selector will choose a principle from training store.
        this.logger.info(`[PD:NocturnalWorkflow] Calling executeNocturnalReflectionAsync for full pipeline (principleId=${principleId ?? 'auto-select'})`);

        // #213: Wrap fire-and-forget Promise with .catch() to prevent
        // unhandled promise rejections if anything throws outside the try-catch
        // (e.g., during parameter construction or environment errors).
        Promise.resolve().then(async () => {
            try {
                const result = await executeNocturnalReflectionAsync(
                    this.workspaceDir,
                    this.stateDir,
                    {
                        runtimeAdapter: this.runtimeAdapter,
                        trinityConfig: {
                            useTrinity: true,
                            maxCandidates: 3,
                            useStubs: false,
                            runtimeAdapter: this.runtimeAdapter,
                            stateDir: this.stateDir,
                        },
                        // Pass painContext for Selector ranking bias
                        painContext,
                        // Skip Selector if principleId and snapshot are provided
                        ...(principleId && snapshot ? {
                            principleIdOverride: principleId,
                            snapshotOverride: snapshot,
                        } : {}),
                    }
                );

                if (result.success) {
                    this.store.recordEvent(workflowId, 'nocturnal_completed', null, 'completed', 'Full pipeline completed via executeNocturnalReflectionAsync', {
                        artifactId: result.diagnostics?.persistedPath,
                    });
                    this.completedWorkflows.set(workflowId, Date.now());
                } else {
                    const reason = result.noTargetSelected ? 'no_target_selected' : 'validation_failed';
                    this.store.recordEvent(workflowId, 'nocturnal_failed', null, 'terminal_error', reason, {
                        failures: result.validationFailures,
                        skipReason: result.skipReason,
                    });
                }
            } catch (err) {
                this.logger.error(`[PD:NocturnalWorkflow] executeNocturnalReflectionAsync threw: ${String(err)}`);
                this.store.recordEvent(workflowId, 'nocturnal_failed', null, 'terminal_error', String(err), { workflowId });
            }
        }).catch((err) => {
            // #213: Outer catch — catches errors from the fire-and-forget promise
            // itself (e.g., if the async callback throws before entering try).
            this.logger.error(`[PD:NocturnalWorkflow] Unhandled error in async pipeline for ${workflowId}: ${String(err)}`);
            this.store.recordEvent(workflowId, 'nocturnal_failed', null, 'terminal_error', String(err), { workflowId });
        });

        return {
            workflowId,
            childSessionKey: `nocturnal:internal:${workflowId}`,
            state: 'active' as const,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // WorkflowManager Interface: notifyWaitResult (NOC-01, D-10: no-op)
    // ─────────────────────────────────────────────────────────────────────────

    async notifyWaitResult(
        workflowId: string,
        status: 'ok' | 'error' | 'timeout',
        error?: string
    ): Promise<void> {
        const workflow = this.store.getWorkflow(workflowId);
        if (!workflow) {
            this.logger.warn(`[PD:NocturnalWorkflow] notifyWaitResult: workflow not found: ${workflowId}`);
            return;
        }

        // Only handle workflows in 'active' state (Trinity async path)
        if (workflow.state !== 'active') {
            this.logger.info(`[PD:NocturnalWorkflow] notifyWaitResult: workflow ${workflowId} not in active state: ${workflow.state}`);
            return;
        }

        const trinityFailures = this.pendingTrinityFailures.get(workflowId) ?? [];
        const trinityResult = this.pendingTrinityResults.get(workflowId);

        if (status === 'ok') {
            // Trinity succeeded: active -> finalizing -> completed (NOC-10)
            this.store.updateWorkflowState(workflowId, 'finalizing');
            this.store.recordEvent(workflowId, 'trinity_completed', 'active', 'finalizing', 'Trinity chain completed successfully', {
                trinityTelemetry: trinityResult?.telemetry,
            });

            this.store.updateWorkflowState(workflowId, 'completed');
            this.store.recordEvent(workflowId, 'nocturnal_completed', 'finalizing', 'completed', 'artifact persisted', {
                persistedPath: trinityResult?.artifact ? 'trinity-draft' : undefined,
            });
        } else {
            // Any stage failure: -> terminal_error immediately (NOC-09, NOC-10)
            this.store.updateWorkflowState(workflowId, 'terminal_error');
            this.store.recordEvent(workflowId, 'nocturnal_failed', 'active', 'terminal_error', error ?? 'Trinity stage failed', {
                failures: trinityFailures,  // NOC-09: TrinityStageFailure[] in payload
                trinityTelemetry: trinityResult?.telemetry,
            });
        }

        // Clean up pending state (idempotent - also cleaned in markCompleted)
        this.pendingTrinityFailures.delete(workflowId);
        this.pendingTrinityResults.delete(workflowId);
        this.markCompleted(workflowId);
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

    async sweepExpiredWorkflows(
        maxAgeMs = 30 * 60 * 1000,
        subagentRuntime?: any,
        agentSession?: {
            resolveStorePath: () => string;
            loadSessionStore: (storePath: string, opts?: { skipCache?: boolean }) => Record<string, unknown>;
            saveSessionStore: (storePath: string, store: Record<string, unknown>) => Promise<void>;
        },
    ): Promise<number> {
        const expired = this.store.getExpiredWorkflows(maxAgeMs);

        this.logger.info(`[PD:NocturnalWorkflow] sweepExpiredWorkflows: found ${expired.length} expired`);

        for (const workflow of expired) {
            try {
                this.logger.info(`[PD:NocturnalWorkflow] Sweeping expired workflow: ${workflow.workflow_id}`);

                // D-06: Mark as expired in WorkflowStore
                this.store.updateWorkflowState(workflow.workflow_id, 'expired');
                this.store.recordEvent(workflow.workflow_id, 'nocturnal_expired', workflow.state, 'expired', 'TTL expired', { workflowId: workflow.workflow_id });

                // #180 + #188: Cleanup subagent session with gateway-safe fallback
                if (workflow.child_session_key) {
                    try {
                        if (subagentRuntime) {
                            await subagentRuntime.deleteSession({
                                sessionKey: workflow.child_session_key,
                                deleteTranscript: true,
                            });
                            this.logger.info(`[PD:NocturnalWorkflow] Cleaned up subagent session: ${workflow.child_session_key}`);
                        } else if (agentSession) {
                            // Heartbeat-safe fallback: directly manipulate session store
                            const storePath = agentSession.resolveStorePath();
                            const store = agentSession.loadSessionStore(storePath, { skipCache: true });
                            const normalizedKey = workflow.child_session_key.toLowerCase();
                            if (store[normalizedKey]) {
                                delete store[normalizedKey];
                                await agentSession.saveSessionStore(storePath, store);
                                this.logger.info(`[PD:NocturnalWorkflow] Cleaned up subagent session via agentSession fallback: ${workflow.child_session_key}`);
                            }
                        }
                    } catch (sessionErr) {
                        const errMsg = String(sessionErr);
                        // #188: If gateway-scoped method fails, try agentSession fallback
                        if (errMsg.includes('gateway request') && agentSession) {
                            const storePath = agentSession.resolveStorePath();
                            const store = agentSession.loadSessionStore(storePath, { skipCache: true });
                            const normalizedKey = workflow.child_session_key.toLowerCase();
                            if (store[normalizedKey]) {
                                delete store[normalizedKey];
                                await agentSession.saveSessionStore(storePath, store);
                                this.logger.info(`[PD:NocturnalWorkflow] Cleaned up subagent session via agentSession fallback after gateway error: ${workflow.child_session_key}`);
                            }
                        } else {
                            this.logger.warn(`[PD:NocturnalWorkflow] Failed to cleanup session ${workflow.child_session_key}: ${errMsg}`);
                        }
                    }
                }

                // D-06: Clean partial artifact files by workflowId prefix
                const samplesDir = resolveNocturnalDir(this.workspaceDir, 'SAMPLES');
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
        const allEvents = this.store.getEvents(workflowId);
        const recentEvents = allEvents
            .slice(-eventLimit)
            .map((event) => ({
                eventType: event.event_type,
                fromState: event.from_state,
                toState: event.to_state,
                reason: event.reason,
                createdAt: event.created_at,
                payload: JSON.parse(event.payload_json || '{}') as Record<string, unknown>,
            }));

        // NOC-16: Compute Trinity stage states from events
        const trinityStageStates = this.computeTrinityStageStates(allEvents);

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
            trinityStageStates,  // NOC-16
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
        this.pendingTrinityFailures.delete(workflowId);
        this.pendingTrinityResults.delete(workflowId);
    }

    /**
     * Compute Trinity stage states from workflow events (NOC-16).
     * Derives current/completed/failed state for each Trinity stage.
     */
    private computeTrinityStageStates(events: WorkflowEventRow[]): Array<{
        stage: 'dreamer' | 'philosopher' | 'scribe';
        status: 'pending' | 'running' | 'completed' | 'failed';
        reason?: string;
        completedAt?: number;
    }> {
        const stages: Array<'dreamer' | 'philosopher' | 'scribe'> = ['dreamer', 'philosopher', 'scribe'];
        const result: Array<{
            stage: 'dreamer' | 'philosopher' | 'scribe';
            status: 'pending' | 'running' | 'completed' | 'failed';
            reason?: string;
            completedAt?: number;
        }> = [];

        for (const stage of stages) {
            const startEvent = events.find(e => e.event_type === `trinity_${stage}_start`);
            const completeEvent = events.find(e => e.event_type === `trinity_${stage}_complete`);
            const failedEvent = events.find(e => e.event_type === `trinity_${stage}_failed`);

            if (!startEvent) {
                // Stage never ran
                result.push({ stage, status: 'pending' });
            } else if (failedEvent) {
                // Stage ran and failed
                const payload = JSON.parse(failedEvent.payload_json || '{}') as Record<string, unknown>;
                const failures = payload.failures as Array<{ reason?: string }> | undefined;
                result.push({
                    stage,
                    status: 'failed',
                    reason: failures?.[0]?.reason ?? failedEvent.reason,
                    completedAt: failedEvent.created_at,
                });
            } else if (completeEvent) {
                // Stage ran and completed
                result.push({
                    stage,
                    status: 'completed',
                    completedAt: completeEvent.created_at,
                });
            } else {
                // Stage started but not completed or failed — currently running
                result.push({ stage, status: 'running' });
            }
        }

        return result;
    }

    /**
     * Record Trinity stage events in batch after the chain completes (per NOC-08).
     * Derives stage events from TrinityResult.telemetry and TrinityResult.failures.
     * Always records _start event for each stage that ran, plus _complete or _failed based on outcome.
     */
    private recordStageEvents(workflowId: string, result: TrinityResult): void {
        const { telemetry, failures } = result;

        // Dreamer events (always runs if we reach here)
        this.store.recordEvent(
            workflowId,
            'trinity_dreamer_start',
            null,  // fromState: null for first event
            'active',
            'Trinity Dreamer stage began',
            {}
        );

        if (telemetry.dreamerPassed) {
            this.store.recordEvent(
                workflowId,
                'trinity_dreamer_complete',
                'active',
                'active',
                'Dreamer completed successfully',
                { candidateCount: telemetry.candidateCount }
            );
        } else {
            const dreamerFailure = failures.find(f => f.stage === 'dreamer');
            this.store.recordEvent(
                workflowId,
                'trinity_dreamer_failed',
                'active',
                'active',
                dreamerFailure?.reason ?? 'Dreamer stage failed',
                { failures: failures.filter(f => f.stage === 'dreamer') }
            );
        }

        // Philosopher events (only if Dreamer passed)
        if (telemetry.dreamerPassed) {
            this.store.recordEvent(
                workflowId,
                'trinity_philosopher_start',
                'active',
                'active',
                'Trinity Philosopher stage began',
                {}
            );

            if (telemetry.philosopherPassed) {
                this.store.recordEvent(
                    workflowId,
                    'trinity_philosopher_complete',
                    'active',
                    'active',
                    'Philosopher completed successfully',
                    {}
                );
            } else {
                const philosopherFailure = failures.find(f => f.stage === 'philosopher');
                this.store.recordEvent(
                    workflowId,
                    'trinity_philosopher_failed',
                    'active',
                    'active',
                    philosopherFailure?.reason ?? 'Philosopher stage failed',
                    { failures: failures.filter(f => f.stage === 'philosopher') }
                );
            }
        }

        // Scribe events (only if Philosopher passed)
        if (telemetry.philosopherPassed) {
            this.store.recordEvent(
                workflowId,
                'trinity_scribe_start',
                'active',
                'active',
                'Trinity Scribe stage began',
                {}
            );

            if (telemetry.scribePassed) {
                this.store.recordEvent(
                    workflowId,
                    'trinity_scribe_complete',
                    'active',
                    'finalizing',  // NOC-10: scribe complete -> finalizing state
                    'Scribe completed successfully',
                    { selectedCandidateIndex: telemetry.selectedCandidateIndex }
                );
            } else {
                const scribeFailure = failures.find(f => f.stage === 'scribe');
                this.store.recordEvent(
                    workflowId,
                    'trinity_scribe_failed',
                    'active',
                    'terminal_error',  // NOC-10: scribe failure -> terminal_error immediately
                    scribeFailure?.reason ?? 'Scribe stage failed',
                    { failures: failures.filter(f => f.stage === 'scribe') }
                );
            }
        }
    }
}
