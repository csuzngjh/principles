/**
 * Workflow Orchestrator — Dedicated workflow watchdog and expiry cleanup module
 *
 * Extracts all workflow watchdog and sweep/expire logic from evolution-worker.ts into
 * a dedicated class, following the Phase 24/25/26 pattern.
 *
 * Design decisions:
 * - Class instantiated with workspaceDir
 * - Permissive validation at entry points (wctx must be non-null object, api may be null)
 * - Errors returned in result.errors, not thrown
 * - Short-lived manager instances with dispose() for resource cleanup
 */

import type { OpenClawPluginApi, PluginLogger } from '../openclaw-sdk.js';
import type { EventLog } from '../core/event-log.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { WorkflowStore } from './subagent-workflow/workflow-store.js';
import type { WorkflowRow } from './subagent-workflow/types.js';
import { EmpathyObserverWorkflowManager } from './subagent-workflow/empathy-observer-workflow-manager.js';
import { DeepReflectWorkflowManager } from './subagent-workflow/deep-reflect-workflow-manager.js';
import { NocturnalWorkflowManager } from './subagent-workflow/nocturnal-workflow-manager.js';
import { OpenClawTrinityRuntimeAdapter } from '../core/nocturnal-trinity.js';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Result of workflow watchdog scan.
 */
export interface WatchdogResult {
    anomalies: number;
    details: string[];
    errors: string[];
}

/**
 * Result of workflow sweep/expire.
 */
export interface SweepResult {
    swept: number;
    errors: string[];
}

// ── WorkflowOrchestrator ─────────────────────────────────────────────────────

export class WorkflowOrchestrator {
    private readonly workspaceDir: string;
    private readonly WORKFLOW_TTL_MS = 5 * 60 * 1000; // 5 minutes default TTL

    constructor(workspaceDir: string) {
        this.workspaceDir = workspaceDir;
    }

    /**
     * Run workflow watchdog — detects stale/orphaned workflows, invalid results,
     * and cleanup failures.
     *
     * Checks:
     * 1. Stale active workflows (active > 2x TTL) → mark terminal_error, cleanup sessions
     * 2. Uncleared terminal/expired workflows (cleanup_state=pending)
     * 3. Nocturnal workflow result snapshot validation (fallback data, null stats)
     */
    async runWatchdog(
        wctx: WorkspaceContext,
        api: OpenClawPluginApi | null,
        logger?: PluginLogger,
    ): Promise<WatchdogResult> {
        const details: string[] = [];
        const errors: string[] = [];
        const now = Date.now();
        const subagentRuntime = api?.runtime?.subagent;
        const agentSession = api?.runtime?.agent?.session;

        // Permissive validation: wctx must be non-null object
        if (!wctx || typeof wctx !== 'object') {
            errors.push('Invalid workspace context: must be a non-null object');
            return { anomalies: 0, details: [], errors };
        }

        try {
            const store = new WorkflowStore({ workspaceDir: this.workspaceDir });
            try {
                const allWorkflows: WorkflowRow[] = store.listWorkflows();

                // Check 1: Stale active workflows (active > 2x TTL)
                const staleThreshold = this.WORKFLOW_TTL_MS * 2;
                const staleActive = allWorkflows.filter(
                    (wf: WorkflowRow) => wf.state === 'active' && (now - wf.created_at) > staleThreshold,
                );
                if (staleActive.length > 0) {
                    for (const wf of staleActive) {
                        const ageMin = Math.round((now - wf.created_at) / 60000);
                        details.push(`stale_active: ${wf.workflow_id} (${wf.workflow_type}, ${ageMin}min old)`);
                        store.updateWorkflowState(wf.workflow_id, 'terminal_error');
                        store.recordEvent(wf.workflow_id, 'watchdog_timeout', 'active', 'terminal_error', `Stale active > ${staleThreshold / 60000}s`, { ageMs: now - wf.created_at });

                        // Cleanup session if possible (#188: gateway-safe fallback)
                        if (wf.child_session_key) {
                            try {
                                if (subagentRuntime) {
                                    await subagentRuntime.deleteSession({ sessionKey: wf.child_session_key, deleteTranscript: true });
                                    logger?.info?.(`[PD:Watchdog] Cleaned up stale session: ${wf.child_session_key}`);
                                } else if (agentSession) {
                                    const storePath = agentSession.resolveStorePath();
                                    const sessionStore = agentSession.loadSessionStore(storePath, { skipCache: true });
                                    const normalizedKey = wf.child_session_key.toLowerCase();
                                    if (sessionStore[normalizedKey]) {
                                        delete sessionStore[normalizedKey];
                                        await agentSession.saveSessionStore(storePath, sessionStore);
                                        logger?.info?.(`[PD:Watchdog] Cleaned up stale session via agentSession fallback: ${wf.child_session_key}`);
                                    }
                                }
                            } catch (cleanupErr) {
                                const errMsg = String(cleanupErr);
                                if (errMsg.includes('gateway request') && agentSession) {
                                    const storePath = agentSession.resolveStorePath();
                                    const sessionStore = agentSession.loadSessionStore(storePath, { skipCache: true });
                                    const normalizedKey = wf.child_session_key.toLowerCase();
                                    if (sessionStore[normalizedKey]) {
                                        delete sessionStore[normalizedKey];
                                        await agentSession.saveSessionStore(storePath, sessionStore);
                                        logger?.info?.(`[PD:Watchdog] Cleaned up stale session via agentSession fallback after gateway error: ${wf.child_session_key}`);
                                    }
                                } else {
                                    logger?.warn?.(`[PD:Watchdog] Failed to cleanup session ${wf.child_session_key}: ${errMsg}`);
                                }
                            }
                        }
                    }
                }

                // Check 2: Workflows in terminal_error/expired without cleanup
                const unclearedTerminal = allWorkflows.filter(
                    (wf: WorkflowRow) => (wf.state === 'terminal_error' || wf.state === 'expired') && wf.cleanup_state === 'pending',
                );
                if (unclearedTerminal.length > 0) {
                    details.push(`uncleared_terminal: ${unclearedTerminal.length} workflows (will be swept next cycle)`);
                }

                // Check 3: Nocturnal workflow result validation (#181 pattern)
                const nocturnalCompleted = allWorkflows.filter(
                    (wf: WorkflowRow) => wf.workflow_type === 'nocturnal' && wf.state === 'completed',
                );
                for (const wf of nocturnalCompleted) {
                    try {
                        const meta = JSON.parse(wf.metadata_json) as Record<string, unknown>;
                        const snapshot = meta.snapshot as Record<string, unknown> | undefined;
                        if (snapshot) {
                            // #219: Check for fallback data source (partial stats from pain context)
                            const dataSource = snapshot._dataSource as string | undefined;
                            if (dataSource === 'pain_context_fallback') {
                                details.push(`fallback_snapshot: nocturnal workflow ${wf.workflow_id} uses pain-context fallback (stats may be incomplete)`);
                            }
                            const stats = snapshot.stats as Record<string, number | null> | undefined;
                            if (stats && stats.totalAssistantTurns === null && stats.totalToolCalls === null && stats.totalPainEvents === 0 && stats.totalGateBlocks === null) {
                                details.push(`fallback_snapshot_stats: nocturnal workflow ${wf.workflow_id} has null stats (data unavailable)`);
                            }
                        }
                    } catch { /* ignore malformed metadata */ }
                }

                // Summary
                const stateCounts: Record<string, number> = {};
                for (const wf of allWorkflows) {
                    stateCounts[wf.state] = (stateCounts[wf.state] || 0) + 1;
                }
                const stateSummary = Object.entries(stateCounts).map(([s, c]) => `${s}=${c}`).join(', ');
                if (details.length === 0) {
                    logger?.debug?.(`[PD:Watchdog] OK — ${allWorkflows.length} workflows (${stateSummary})`);
                } else {
                    logger?.info?.(`[PD:Watchdog] ${details.length} anomalies — ${allWorkflows.length} workflows (${stateSummary})`);
                }
            } finally {
                store.dispose();
            }
        } catch (err) {
            const errMsg = `Failed to scan workflows: ${String(err)}`;
            errors.push(errMsg);
            logger?.warn?.(`[PD:Watchdog] ${errMsg}`);
        }

        return { anomalies: details.length, details, errors };
    }

    /**
     * Sweep expired workflows — calls each manager's sweepExpiredWorkflows,
     * with fallback using WorkflowStore directly if subagentRuntime unavailable.
     */
    async sweepExpired(
        wctx: WorkspaceContext,
        api: OpenClawPluginApi | null,
        logger?: PluginLogger,
    ): Promise<SweepResult> {
        const errors: string[] = [];
        let swept = 0;

        // Permissive validation: wctx must be non-null object
        if (!wctx || typeof wctx !== 'object') {
            errors.push('Invalid workspace context: must be a non-null object');
            return { swept: 0, errors };
        }

        try {
            const subagentRuntime = api?.runtime?.subagent;
            const agentSession = api?.runtime?.agent?.session;

            if (subagentRuntime) {
                // EmpathyObserverWorkflowManager
                const empathyMgr = new EmpathyObserverWorkflowManager({
                    workspaceDir: this.workspaceDir,
                    logger: api?.logger,
                    subagent: subagentRuntime,
                    agentSession,
                });
                try {
                    swept += await empathyMgr.sweepExpiredWorkflows(this.WORKFLOW_TTL_MS);
                } finally {
                    empathyMgr.dispose();
                }

                // DeepReflectWorkflowManager
                const deepReflectMgr = new DeepReflectWorkflowManager({
                    workspaceDir: this.workspaceDir,
                    logger: api?.logger,
                    subagent: subagentRuntime,
                    agentSession,
                });
                try {
                    swept += await deepReflectMgr.sweepExpiredWorkflows(this.WORKFLOW_TTL_MS);
                } finally {
                    deepReflectMgr.dispose();
                }

                // NocturnalWorkflowManager
                try {
                    const nocturnalMgr = new NocturnalWorkflowManager({
                        workspaceDir: this.workspaceDir,
                        stateDir: wctx.stateDir,
                        logger: api?.logger,
                        runtimeAdapter: new OpenClawTrinityRuntimeAdapter(api!),
                    });
                    try {
                        swept += await nocturnalMgr.sweepExpiredWorkflows(this.WORKFLOW_TTL_MS, subagentRuntime, agentSession);
                    } finally {
                        nocturnalMgr.dispose();
                    }
                } catch (noctSweepErr) {
                    const errMsg = `Nocturnal sweep failed: ${String(noctSweepErr)}`;
                    errors.push(errMsg);
                    logger?.warn?.(`[PD:EvolutionWorker] ${errMsg}`);
                }
            } else {
                // Fallback: if subagent runtime unavailable, mark as expired
                // but log that session cleanup was skipped.
                const workflowStore = new WorkflowStore({ workspaceDir: this.workspaceDir });
                try {
                    const expiredWorkflows = workflowStore.getExpiredWorkflows(this.WORKFLOW_TTL_MS);
                    for (const wf of expiredWorkflows) {
                        workflowStore.updateWorkflowState(wf.workflow_id, 'expired');
                        workflowStore.updateCleanupState(wf.workflow_id, 'failed');
                        workflowStore.recordEvent(wf.workflow_id, 'swept', wf.state, 'expired', 'TTL expired (no runtime for session cleanup)', {});
                        logger?.warn?.(`[PD:EvolutionWorker] Marked workflow ${wf.workflow_id} as expired but could not cleanup session (subagent runtime unavailable)`);
                        swept++;
                    }
                    wctx.eventLog.recordSkip(undefined, {
                        reason: 'subagent_runtime_unavailable_sweep',
                        fallback: 'workflows_marked_expired_via_workflowstore',
                        context: { workflowCount: swept },
                    });
                } finally {
                    workflowStore.dispose();
                }
            }
        } catch (sweepErr) {
            const errMsg = `Failed to sweep expired workflows: ${String(sweepErr)}`;
            errors.push(errMsg);
            logger?.warn?.(`[PD:EvolutionWorker] ${errMsg}`);
        }

        return { swept, errors };
    }
}
