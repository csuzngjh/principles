/**
 * Evolution Task Dispatcher — Task dispatch and execution for pain_diagnosis and sleep_reflection
 *
 * Extracts all dispatch/execution logic from evolution-worker.ts into a dedicated class,
 * following the Phase 24/25 pattern (class-based, validated entry points, permissive
 * validation, structured result types).
 *
 * Design decisions:
 * - D-01: Class instantiated with workspaceDir, follows PainFlagDetector pattern
 * - D-02: Permissive validation (required fields only, ignore unknowns)
 * - D-03: All public methods return structured results; internal errors caught and returned in result.errors
 * - D-04: Queue modifications happen via store.update() which handles locking internally
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PluginLogger, OpenClawPluginApi } from '../openclaw-sdk.js';
import type { WorkspaceContext } from '../core/workspace-context.js';
import type { EventLog } from '../core/event-log.js';
import { SystemLogger } from '../core/system-logger.js';
import { addDiagnosticianTask, completeDiagnosticianTask } from '../core/diagnostician-task-store.js';
import { getEvolutionLogger } from '../core/evolution-logger.js';
import { EvolutionQueueStore } from './evolution-queue-store.js';
import type { RecentPainContext } from './evolution-queue-store.js';
import { PainFlagDetector } from './pain-flag-detector.js';
import { NocturnalWorkflowManager, nocturnalWorkflowSpec } from './subagent-workflow/nocturnal-workflow-manager.js';
import { OpenClawTrinityRuntimeAdapter } from '../core/nocturnal-trinity.js';
import { validateNocturnalSnapshotIngress } from '../core/nocturnal-snapshot-contract.js';
import {
    createNocturnalTrajectoryExtractor,
    type NocturnalPainEvent,
    type NocturnalSessionSnapshot,
} from '../core/nocturnal-trajectory-extractor.js';
import type { WorkflowEventRow } from './subagent-workflow/types.js';
import { isExpectedSubagentError } from './subagent-workflow/subagent-error-utils.js';
import type { EvolutionQueueItem } from './evolution-queue-store.js';

// Re-export RecentPainContext for backward compatibility
export type { RecentPainContext } from './evolution-queue-store.js';

// ── Dispatch Result Types ─────────────────────────────────────────────────────

export interface DispatchResult {
    /** Whether the queue was modified during this dispatch cycle */
    queueChanged: boolean;
    /** Whether any pain_diagnosis tasks were processed */
    processedPain: boolean;
    /** Whether any sleep_reflection tasks were processed */
    processedSleep: boolean;
    /** Any errors encountered during dispatch */
    errors: string[];
    painStats: { completed: number; pending: number; inProgress: number };
    sleepStats: { completed: number; pending: number; inProgress: number };
}

// ── EvolutionTaskDispatcher ───────────────────────────────────────────────────

export class EvolutionTaskDispatcher {
    private readonly workspaceDir: string;

    constructor(workspaceDir: string) {
        if (!workspaceDir || typeof workspaceDir !== 'string') {
            // D-02: Permissive — accept empty/invalid workspaceDir, let operations fail later
            this.workspaceDir = '';
        } else {
            this.workspaceDir = workspaceDir;
        }
    }

    /**
     * Enqueue a sleep_reflection task if one is not already pending.
     * Called when workspace is idle to trigger nocturnal reflection.
     *
     * Extracts: enqueueSleepReflectionTask (evolution-worker.ts L256-299)
     */
    async enqueueSleepReflection(wctx: WorkspaceContext, logger: PluginLogger): Promise<void> {
        const store = new EvolutionQueueStore(wctx.workspaceDir);
        const now = Date.now();
        const taskId = EvolutionQueueStore.createTaskId('nocturnal', 50, 'idle workspace', 'Sleep-mode reflection', now);
        const nowIso = new Date(now).toISOString();

        // Attach recent pain context if available
        const recentPainContext = this._extractRecentPainContext(wctx);

        const taskItem: EvolutionQueueItem = {
            id: taskId,
            taskKind: 'sleep_reflection',
            priority: 'medium',
            score: 50,
            source: 'nocturnal',
            reason: 'Sleep-mode reflection triggered by idle workspace',
            trigger_text_preview: 'Idle workspace detected',
            timestamp: nowIso,
            enqueued_at: nowIso,
            status: 'pending',
            traceId: taskId,
            retryCount: 0,
            maxRetries: 1,
            recentPainContext,
        };

        let didEnqueue = false;
        await store.update((queue) => {
            const hasPendingSleepReflection = queue.some(
                (t) => t.taskKind === 'sleep_reflection' && (t.status === 'pending' || t.status === 'in_progress'),
            );
            if (hasPendingSleepReflection) {
                return queue;
            }

            queue.push(taskItem);
            didEnqueue = true;
            return queue;
        });

        if (!didEnqueue) {
            logger?.debug?.('[PD:EvolutionWorker] sleep_reflection task already pending/in-progress, skipping');
            return;
        }

        logger?.info?.(`[PD:EvolutionWorker] Enqueued sleep_reflection task ${taskId}`);
    }

    /**
     * Main entry point — orchestrates all task dispatch and execution.
     *
     * Handles:
     * - _recoverStuckSleepReflection: marks timed-out in_progress sleep_reflection as failed
     * - _checkInProgressPainDiagnosis: checks in_progress pain_diagnosis for completion markers
     * - _dispatchPendingPainDiagnosis: claims and dispatches highest-priority pending pain_diagnosis
     * - _dispatchSleepReflection: claims, executes, polls, writes back sleep_reflection task
     *
     * Extracts: processEvolutionQueue (evolution-worker.ts L309-1139)
     */
    async dispatchQueue(
        wctx: WorkspaceContext,
        logger: PluginLogger,
        eventLog: EventLog,
        api?: OpenClawPluginApi,
    ): Promise<DispatchResult> {
        const result: DispatchResult = {
            queueChanged: false,
            processedPain: false,
            processedSleep: false,
            errors: [],
            painStats: { completed: 0, pending: 0, inProgress: 0 },
            sleepStats: { completed: 0, pending: 0, inProgress: 0 },
        };

        const store = new EvolutionQueueStore(wctx.workspaceDir);
        const evoLogger = getEvolutionLogger(wctx.workspaceDir, wctx.trajectory);

        // Phase 1: Atomic load via store
        const loadResult = await store.load();
        const queue: EvolutionQueueItem[] = loadResult.queue;

        if (loadResult.status === 'corrupted' && loadResult.backupPath) {
            logger?.error?.(`[PD:EvolutionWorker] Evolution queue corrupted and backed up to ${loadResult.backupPath}. Reasons: ${loadResult.reasons.join('; ')}`);
            SystemLogger.log(wctx.workspaceDir, 'QUEUE_CORRUPTED', `Queue file backed up. Reasons: ${loadResult.reasons.join('; ')}`);
        }

        if (queue.length === 0) {
            logger?.debug?.('[PD:EvolutionWorker] Empty queue — nothing to process');
            return result;
        }

        try {
            const { config } = wctx;
            const timeout = config.get('intervals.task_timeout_ms') || (60 * 60 * 1000); // Default 1 hour

            // V2: Recover stuck in_progress sleep_reflection tasks
            const stuckRecoveryChanged = this._recoverStuckSleepReflection(queue, wctx, logger, api, timeout);
            result.queueChanged = result.queueChanged || stuckRecoveryChanged;
            if (stuckRecoveryChanged) {
                await store.save(queue);
            }

            // V2: Process pain_diagnosis tasks FIRST (quick, inside lock),
            // then sleep_reflection tasks (slow, lock released during execution).
            const painChanged = await this._checkInProgressPainDiagnosis(queue, wctx, logger, eventLog, timeout);
            result.queueChanged = result.queueChanged || painChanged;
            if (painChanged) result.processedPain = true;

            const dispatchChanged = await this._dispatchPendingPainDiagnosis(queue, wctx, logger, eventLog);
            result.queueChanged = result.queueChanged || dispatchChanged;
            if (dispatchChanged) result.processedPain = true;

            if (painChanged || dispatchChanged) {
                await store.save(queue);
            }

            // Phase 2.4: Process sleep_reflection tasks AFTER pain_diagnosis
            const sleepChanged = await this._dispatchSleepReflection(queue, wctx, logger, eventLog, api, timeout, evoLogger);
            result.queueChanged = result.queueChanged || sleepChanged;
            if (sleepChanged) result.processedSleep = true;

            // Pipeline observability: log stage-level summary at end of cycle
            result.painStats.pending = queue.filter((t) => t.status === 'pending' && t.taskKind === 'pain_diagnosis').length;
            result.painStats.inProgress = queue.filter((t) => t.status === 'in_progress' && t.taskKind === 'pain_diagnosis').length;
            result.sleepStats.pending = queue.filter((t) => t.status === 'pending' && t.taskKind === 'sleep_reflection').length;
            result.sleepStats.inProgress = queue.filter((t) => t.status === 'in_progress' && t.taskKind === 'sleep_reflection').length;

            if (result.painStats.inProgress > 0) {
                const stuck = queue
                    .filter((t) => t.status === 'in_progress' && t.taskKind === 'pain_diagnosis')
                    .map((t) => `${t.id} (since ${t.started_at || 'unknown'})`);
                logger?.info?.(`[PD:EvolutionWorker] Pipeline: ${result.painStats.inProgress} pain_diagnosis task(s) in_progress — awaiting agent response: ${stuck.join(', ')}`);
            }
            if (result.painStats.pending > 0) {
                logger?.info?.(`[PD:EvolutionWorker] Pipeline: ${result.painStats.pending} pain_diagnosis task(s) pending — HEARTBEAT.md will trigger next cycle`);
            }
            const painCompleted = queue.filter((t) => t.status === 'completed' && t.taskKind === 'pain_diagnosis').length;
            result.painStats.completed = painCompleted;
            logger?.info?.(`[PD:EvolutionWorker] Pipeline summary: pain_completed=${painCompleted} pain_pending=${result.painStats.pending} pain_in_progress=${result.painStats.inProgress}`);
        } catch (err) {
            const errMsg = `Error processing evolution queue: ${String(err)}`;
            result.errors.push(errMsg);
            if (logger) logger.warn(`[PD:EvolutionWorker] ${errMsg}`);
        }

        return result;
    }

    // ── Private Dispatch Methods ──────────────────────────────────────────────

    /**
     * Recover stuck in_progress sleep_reflection tasks.
     * If the worker crashes or the result write-back fails after claiming the task,
     * it stays in_progress indefinitely. Detect via timeout and mark as failed
     * so a fresh task can be enqueued on the next idle cycle.
     * #214: Also expire the underlying nocturnal workflow to prevent resource leaks.
     *
     * Extracts: evolution-worker.ts L333-408
     */
    private _recoverStuckSleepReflection(
        queue: EvolutionQueueItem[],
        wctx: WorkspaceContext,
        logger: PluginLogger,
        api: OpenClawPluginApi | undefined,
        timeout: number,
    ): boolean {
        let queueChanged = false;
        const { WorkflowStore } = require('./subagent-workflow/workflow-store.js');

        for (const task of queue.filter(t => t.status === 'in_progress' && t.taskKind === 'sleep_reflection')) {
            const startedAt = new Date(task.started_at || task.timestamp);
            const age = Date.now() - startedAt.getTime();
            if (age > timeout) {
                task.status = 'failed';
                task.completed_at = new Date().toISOString();
                task.resolution = 'failed_max_retries';
                task.retryCount = (task.retryCount ?? 0) + 1;
                queueChanged = true;

                // #219: Fetch real failure reason from workflow events for better diagnostics
                let detailedError = `sleep_reflection timed out after ${Math.round(timeout / 60000)} minutes`;
                if (task.resultRef && !task.resultRef.startsWith('trinity-draft')) {
                    try {
                        const wfStore = new WorkflowStore({ workspaceDir: wctx.workspaceDir });
                        const events = wfStore.getEvents(task.resultRef);
                        // Find the most recent failure event
                        const failureEvent = events.filter((e: WorkflowEventRow) =>
                            e.event_type.includes('failed') || e.event_type.includes('error')
                        ).pop();
                        if (failureEvent) {
                            const payload = failureEvent.payload_json ? JSON.parse(failureEvent.payload_json) : {};
                            detailedError = `sleep_reflection failed: ${failureEvent.reason}`;
                            if (payload.skipReason) {
                                detailedError += ` (skipReason: ${payload.skipReason})`;
                            }
                            if (payload.failures && payload.failures.length > 0) {
                                detailedError += ` | failures: ${payload.failures.slice(0, 3).join(', ')}`;
                            }
                        }
                    } catch (fetchErr) {
                        logger?.debug?.(`[PD:EvolutionWorker] Could not fetch workflow events for ${task.resultRef}: ${String(fetchErr)}`);
                    }
                }
                task.lastError = detailedError;

                logger?.warn?.(`[PD:EvolutionWorker] sleep_reflection task ${task.id} timed out after ${Math.round(age / 60000)} minutes, marking as failed. Reason: ${detailedError}`);

                // #214: Expire the underlying nocturnal workflow to prevent resource leak.
                if (task.resultRef && !task.resultRef.startsWith('trinity-draft')) {
                    try {
                        if (!api) {
                            logger?.warn?.(`[PD:EvolutionWorker] Cannot expire nocturnal workflow ${task.resultRef}: runtime_unavailable (plugin API missing)`);
                            continue;
                        }
                        const nocturnalMgr = new NocturnalWorkflowManager({
                            workspaceDir: wctx.workspaceDir,
                            stateDir: wctx.stateDir,
                            logger: api?.logger || logger,
                            runtimeAdapter: new OpenClawTrinityRuntimeAdapter(api),
                        });
                        try {
                            // Force-expire this specific workflow regardless of TTL
                            nocturnalMgr.expireWorkflow(
                                task.resultRef,
                                `Sleep reflection task ${task.id} timed out after ${Math.round(age / 60000)} min`,
                            );
                            logger?.info?.(`[PD:EvolutionWorker] Expired nocturnal workflow ${task.resultRef} for timed-out sleep task ${task.id}`);
                        } finally {
                            nocturnalMgr.dispose();
                        }
                    } catch (expireErr) {
                        logger?.warn?.(`[PD:EvolutionWorker] Could not expire nocturnal workflow ${task.resultRef}: ${String(expireErr)}`);
                    }
                }
            }
        }
        return queueChanged;
    }

    /**
     * Check in_progress pain_diagnosis tasks for completion markers.
     * Diagnostician runs via HEARTBEAT (main session LLM), not as a subagent.
     * Marker file detection is the ONLY completion path for HEARTBEAT diagnostics.
     *
     * Extracts: evolution-worker.ts L410-654
     */
    private async _checkInProgressPainDiagnosis(
        queue: EvolutionQueueItem[],
        wctx: WorkspaceContext,
        logger: PluginLogger,
        eventLog: EventLog,
        timeout: number,
    ): Promise<boolean> {
        let queueChanged = false;

        for (const task of queue.filter(t => t.status === 'in_progress' && t.taskKind === 'pain_diagnosis')) {
            const startedAt = new Date(task.started_at || task.timestamp);

            // Condition 1: Check for marker file (created by diagnostician on completion)
            const completeMarker = path.join(wctx.stateDir, `.evolution_complete_${task.id}`);
            if (fs.existsSync(completeMarker)) {
                if (logger) logger.info(`[PD:EvolutionWorker] Task ${task.id} completed - marker file detected`);

                // Create principle from the diagnostician's JSON report.
                const reportPath = path.join(wctx.stateDir, `.diagnostician_report_${task.id}.json`);
                if (fs.existsSync(reportPath)) {
                    try {
                        const reportData = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
                        // Check ALL known nesting paths — matches subagent.ts parseDiagnosticianReport
                        const principle = reportData?.principle
                            || reportData?.phases?.principle_extraction?.principle
                            || reportData?.diagnosis_report?.principle
                            || reportData?.diagnosis_report?.phases?.principle_extraction?.principle;
                        if (principle?.trigger_pattern && principle?.action) {
                            // Check for duplicate principle (diagnostician may output existing principle)
                            if (principle.duplicate === true) {
                                logger.info(`[PD:EvolutionWorker] Diagnostician marked principle as duplicate: ${principle.duplicate_of || 'unknown'} — skipping creation for task ${task.id}`);
                                task.status = 'completed';
                                task.completed_at = new Date().toISOString();
                                task.resolution = 'marker_detected';
                            } else {
                                // ── Server-side dedup guard (defense against LLM ignoring duplicate check) ──
                                const existingPrinciples = wctx.evolutionReducer.getActivePrinciples();
                                let serverDuplicate: string | null = null;
                                if (existingPrinciples.length > 0) {
                                    const newTrigger = (principle.trigger_pattern || '').toLowerCase();
                                    const newAbstracted = (principle.abstracted_principle || '').toLowerCase();
                                    for (const ep of existingPrinciples) {
                                        const epTrigger = (ep.trigger || '').toLowerCase();
                                        const epAbstracted = (ep.abstractedPrinciple || '').toLowerCase();
                                        const epText = (ep.text || '').toLowerCase();

                                        // Check 1: abstracted principle overlap (>70% keyword match)
                                        const newKeywords = newAbstracted.split(/\s+/).filter((w: string) => w.length > 3);
                                        const epKeywords = epAbstracted.split(/\s+/).filter((w: string) => w.length > 3);
                                        if (newKeywords.length > 0 && epKeywords.length > 0) {
                                            const overlap = newKeywords.filter((k: string) => epKeywords.includes(k)).length;
                                            const overlapRatio = overlap / Math.max(newKeywords.length, epKeywords.length);
                                            if (overlapRatio > 0.7) {
                                                serverDuplicate = ep.id;
                                                break;
                                            }
                                        }

                                        // Check 2: trigger pattern contains same key terms
                                        if (newTrigger.length > 10 && epTrigger.length > 10) {
                                            const sharedTerms = newTrigger.split(/[\s|\\.+*?()[\]{}^$-]+/).filter((t: string) => t.length > 3);
                                            if (sharedTerms.length > 0 && sharedTerms.every((t: string) => epTrigger.includes(t))) {
                                                serverDuplicate = ep.id;
                                                break;
                                            }
                                        }

                                        // Check 3: text overlap (LLM often reuses text from existing principle)
                                        if (epText.length > 20 && newTrigger.length > 20) {
                                            const sharedPhrases = epText.split(/\s+/).filter(w => w.length > 5);
                                            const matchCount = sharedPhrases.filter(w => newTrigger.includes(w)).length;
                                            if (matchCount >= 3) {
                                                serverDuplicate = ep.id;
                                                break;
                                            }
                                        }
                                    }
                                }

                                if (serverDuplicate) {
                                    logger.info(`[PD:EvolutionWorker] Server-side dedup: new principle overlaps with existing ${serverDuplicate} — skipping creation for task ${task.id}`);
                                    task.status = 'completed';
                                    task.completed_at = new Date().toISOString();
                                    task.resolution = 'marker_detected';
                                } else {
                                    logger.info(`[PD:EvolutionWorker] Creating principle from report for task ${task.id}`);
                                    const principleId = wctx.evolutionReducer.createPrincipleFromDiagnosis({
                                        painId: task.id,
                                        painType: task.source === 'Human Intervention' ? 'user_frustration' : 'tool_failure',
                                        triggerPattern: principle.trigger_pattern,
                                        action: principle.action,
                                        source: task.source || 'heartbeat_diagnostician',
                                        // #212: Default to weak_heuristic so principles are auto-evaluable
                                        evaluability: principle.evaluability || 'weak_heuristic',
                                        detectorMetadata: principle.detector_metadata || principle.detectorMetadata,
                                        abstractedPrinciple: principle.abstracted_principle,
                                        coreAxiomId: principle.core_axiom_id || principle.coreAxiomId,
                                    });
                                    if (principleId) {
                                        logger.info(`[PD:EvolutionWorker] Created principle ${principleId} from marker fallback for task ${task.id}`);
                                    } else {
                                        logger.warn(`[PD:EvolutionWorker] createPrincipleFromDiagnosis returned null for task ${task.id} (may be duplicate or blacklisted)`);
                                    }
                                    task.status = 'completed';
                                    task.completed_at = new Date().toISOString();
                                    task.resolution = 'marker_detected';
                                }
                            }
                        } else {
                            logger.warn(`[PD:EvolutionWorker] Diagnostician report for task ${task.id} missing principle fields — diagnostician did not produce a principle`);
                        }
                    } catch (err) {
                        logger.warn(`[PD:EvolutionWorker] Failed to parse diagnostician report for task ${task.id}: ${String(err)}`);
                    }
                } else {
                    logger.warn(`[PD:EvolutionWorker] No diagnostician report found for completed task ${task.id} (expected: .diagnostician_report_${task.id}.json)`);
                }

                task.status = 'completed';
                task.completed_at = new Date().toISOString();
                task.resolution = 'marker_detected';
                try {
                    fs.unlinkSync(completeMarker);
                } catch { /* marker may have been deleted already, not critical */ }

                // #190: Clean up diagnostician report file after processing
                try {
                    const cleanupReportPath = path.join(wctx.stateDir, `.diagnostician_report_${task.id}.json`);
                    if (fs.existsSync(cleanupReportPath)) fs.unlinkSync(cleanupReportPath);
                } catch { /* report may not exist, not critical */ }

                // FIX (#187): Remove the task from the diagnostician task store
                await completeDiagnosticianTask(wctx.stateDir, task.id);

                const durationMs = task.started_at
                    ? Date.now() - new Date(task.started_at).getTime()
                    : undefined;
                const evoLogger = getEvolutionLogger(wctx.workspaceDir, wctx.trajectory);
                evoLogger.logCompleted({
                    traceId: task.traceId || task.id,
                    taskId: task.id,
                    resolution: 'marker_detected',
                    durationMs,
                });

                // Update evolution_tasks table
                wctx.trajectory?.updateEvolutionTask?.(task.id, {
                    status: 'completed',
                    completedAt: task.completed_at,
                    resolution: 'marker_detected',
                });

                wctx.trajectory?.recordTaskOutcome({
                    sessionId: task.assigned_session_key || 'heartbeat:diagnostician',
                    taskId: task.id,
                    outcome: 'ok',
                    summary: `Task ${task.id} completed - marker file detected.`
                });
                queueChanged = true;
                continue;
            }

            const age = Date.now() - startedAt.getTime();
            if (age > timeout) {
                const timeoutMinutes = Math.round(timeout / 60000);

                const timeoutCompleteMarker = path.join(wctx.stateDir, `.evolution_complete_${task.id}`);
                const timeoutReportPath = path.join(wctx.stateDir, `.diagnostician_report_${task.id}.json`);

                if (fs.existsSync(timeoutCompleteMarker) && fs.existsSync(timeoutReportPath)) {
                    if (logger) logger.info(`[PD:EvolutionWorker] Task ${task.id} timed out but marker found — creating principle anyway`);
                    let principleCreated = false;
                    try {
                        const reportData = JSON.parse(fs.readFileSync(timeoutReportPath, 'utf8'));
                        const principle = reportData?.principle
                            || reportData?.phases?.principle_extraction?.principle
                            || reportData?.diagnosis_report?.principle
                            || reportData?.diagnosis_report?.phases?.principle_extraction?.principle;
                        if (principle?.trigger_pattern && principle?.action) {
                            if (principle.duplicate === true) {
                                logger.info(`[PD:EvolutionWorker] Diagnostician marked principle as duplicate: ${principle.duplicate_of || 'unknown'} — skipping for task ${task.id}`);
                            } else {
                                const principleId = wctx.evolutionReducer.createPrincipleFromDiagnosis({
                                    painId: task.id,
                                    painType: task.source === 'Human Intervention' ? 'user_frustration' : 'tool_failure',
                                    triggerPattern: principle.trigger_pattern,
                                    action: principle.action,
                                    source: task.source || 'heartbeat_diagnostician',
                                    evaluability: principle.evaluability || 'weak_heuristic',
                                    detectorMetadata: principle.detector_metadata || principle.detectorMetadata,
                                    abstractedPrinciple: principle.abstracted_principle,
                                    coreAxiomId: principle.core_axiom_id || principle.coreAxiomId,
                                });
                                if (principleId) {
                                    logger.info(`[PD:EvolutionWorker] Created principle ${principleId} from late marker for task ${task.id}`);
                                    principleCreated = true;
                                }
                            }
                        }
                    } catch (err) {
                        logger.warn(`[PD:EvolutionWorker] Failed to parse late diagnostician report for task ${task.id}: ${String(err)}`);
                    }
                    try { fs.unlinkSync(completeMarker); } catch { /* marker may not exist, not critical */ }
                    // #190: Clean up diagnostician report file
                    try {
                        const lateReportPath = path.join(wctx.stateDir, `.diagnostician_report_${task.id}.json`);
                        if (fs.existsSync(lateReportPath)) fs.unlinkSync(lateReportPath);
                    } catch { /* report may not exist, not critical */ }
                    task.resolution = principleCreated ? 'late_marker_principle_created' : 'late_marker_no_principle';
                } else {
                    if (logger) logger.info(`[PD:EvolutionWorker] Task ${task.id} auto-completed after ${timeoutMinutes} minute timeout`);
                    // #190: Clean up diagnostician report file even on timeout (may have been written late)
                    try {
                        const autoTimeoutReportPath = path.join(wctx.stateDir, `.diagnostician_report_${task.id}.json`);
                        if (fs.existsSync(autoTimeoutReportPath)) fs.unlinkSync(autoTimeoutReportPath);
                    } catch { /* report may not exist, not critical */ }
                    task.resolution = 'auto_completed_timeout';
                }

                // Critical: mark task as completed so it doesn't get re-processed
                task.status = 'completed';
                task.completed_at = new Date().toISOString();

                const evoLogger = getEvolutionLogger(wctx.workspaceDir, wctx.trajectory);
                evoLogger.logCompleted({
                    traceId: task.traceId || task.id,
                    taskId: task.id,
                    resolution: task.resolution,
                    durationMs: age,
                });

                // Update evolution_tasks table
                wctx.trajectory?.updateEvolutionTask?.(task.id, {
                    status: 'completed',
                    completedAt: task.completed_at,
                    resolution: task.resolution,
                });

                wctx.trajectory?.recordTaskOutcome({
                    sessionId: task.assigned_session_key || 'heartbeat:diagnostician',
                    taskId: task.id,
                    outcome: 'timeout',
                    summary: `Task ${task.id} auto-completed after ${timeoutMinutes} minute timeout.`
                });
                queueChanged = true;
            }
        }
        return queueChanged;
    }

    /**
     * Dispatch highest-priority pending pain_diagnosis task.
     * Writes diagnostician task to .state/diagnostician_tasks.json and marks task in_progress.
     *
     * Extracts: evolution-worker.ts L661-846
     */
    private async _dispatchPendingPainDiagnosis(
        queue: EvolutionQueueItem[],
        wctx: WorkspaceContext,
        logger: PluginLogger,
        eventLog: EventLog,
    ): Promise<boolean> {
        let queueChanged = false;
        const evoLogger = getEvolutionLogger(wctx.workspaceDir, wctx.trajectory);

        const pendingTasks = queue.filter(t => t.status === 'pending' && t.taskKind === 'pain_diagnosis');

        if (pendingTasks.length > 0) {
            // V2: Also sort by priority within same score
            const priorityWeight: Record<string, number> = { high: 3, medium: 2, low: 1 };
            const [highestScoreTask] = pendingTasks.sort((a, b) => {
                const scoreDiff = b.score - a.score;
                if (scoreDiff !== 0) return scoreDiff;
                return (priorityWeight[b.priority] || 2) - (priorityWeight[a.priority] || 2);
            });
            const nowIso = new Date().toISOString();

            const taskDescription = `Diagnose systemic pain [ID: ${highestScoreTask.id}]. Source: ${highestScoreTask.source}. Reason: ${highestScoreTask.reason}. ` +
                  `Trigger text: "${highestScoreTask.trigger_text_preview || 'N/A'}"`;

            const markerFilePath = path.join(wctx.stateDir, `.evolution_complete_${highestScoreTask.id}`);
            const reportFilePath = path.join(wctx.stateDir, `.diagnostician_report_${highestScoreTask.id}.json`);

            let existingPrinciplesRef = '';
            try {
                const activePrinciples = wctx.evolutionReducer.getActivePrinciples();
                if (activePrinciples.length > 0) {
                    const maxPrinciples = 20;
                    const included = activePrinciples.length > maxPrinciples
                        ? activePrinciples.slice(-maxPrinciples)
                        : activePrinciples;
                    const lines = included.map((p) => {
                        let line = `### ${p.id}: ${p.text}`;
                        if (p.priority && p.priority !== 'P1') line += ` [${p.priority}]`;
                        if (p.scope === 'domain' && p.domain) line += ` (domain: ${p.domain})`;
                        return line;
                    });
                    existingPrinciplesRef = `\n**Existing Principles for Duplicate Detection** (showing ${included.length}/${activePrinciples.length}):\n${lines.join('\n')}`;

                    const rulesByPrinciple = included.filter((p) => p.suggestedRules?.length);
                    if (rulesByPrinciple.length > 0) {
                        const ruleLines = rulesByPrinciple.flatMap((p) =>
                            (p.suggestedRules ?? []).map((r) => `- [${p.id}] **${r.name}**: ${r.action} (type: ${r.type}, enforce: ${r.enforcement})`),
                        );
                        existingPrinciplesRef += `\n\n**Suggested Rules from Existing Principles**:\n${ruleLines.join('\n')}`;
                    }
                }
            } catch (err) {
                logger?.warn?.(`[PD:EvolutionWorker] Failed to load active principles for duplicate detection: ${String(err)}`);
            }

            // ── Context Enrichment: Dual-path strategy ──
            let contextSection = '';
            if (highestScoreTask.session_id && highestScoreTask.agent_id) {
                try {
                    const { extractRecentConversation, extractFailedToolContext } = await import('../core/pain-context-extractor.js');
                    const conversation = await extractRecentConversation(highestScoreTask.session_id, highestScoreTask.agent_id, 5);

                    if (conversation) {
                        contextSection = `\n## Recent Conversation Context (pre-extracted JSONL fallback)\n\n${conversation}\n`;

                        if (highestScoreTask.source === 'tool_failure') {
                            const toolMatch = /Tool ([\w-]+) failed/.exec(highestScoreTask.reason);
                            const fileMatch = /on (.+?)(?=\s*Error:|$)/i.exec(highestScoreTask.reason);
                            if (toolMatch) {
                                const toolContext = await extractFailedToolContext(
                                    highestScoreTask.session_id,
                                    highestScoreTask.agent_id,
                                    toolMatch[1],
                                    fileMatch?.[1]?.trim(),
                                );
                                if (toolContext) {
                                    contextSection += `\n## Failed Tool Call Context\n\n${toolContext}\n`;
                                }
                            }
                        }
                    }
                    if (logger) {
                        const turns = contextSection ? contextSection.split('\n').filter(l => l.startsWith('[User]') || l.startsWith('[Assistant]')).length : 0;
                        logger?.debug?.(`[PD:EvolutionWorker] Pre-extracted ${turns} conversation turns for task ${highestScoreTask.id}`);
                    }
                } catch (e) {
                    if (logger) logger.warn(`[PD:EvolutionWorker] Failed to extract conversation context for task ${highestScoreTask.id}: ${String(e)}. Diagnostician will use P1 tools or fallback.`);
                }
            }

            const heartbeatContent = [
                `## Evolution Task [ID: ${highestScoreTask.id}]`,
                ``,
                `**Pain Score**: ${highestScoreTask.score}`,
                `**Source**: ${highestScoreTask.source}`,
                `**Reason**: ${highestScoreTask.reason}`,
                `**Trigger**: "${highestScoreTask.trigger_text_preview || 'N/A'}"`,
                `**Queued At**: ${highestScoreTask.enqueued_at || nowIso}`,
                `**Session ID**: ${highestScoreTask.session_id || 'N/A'}`,
                `**Agent ID**: ${highestScoreTask.agent_id || 'main'}`,
                ``,
                `## Available Tools for Context Search (P1 - Preferred)`,
                ``,
                `1. **sessions_history** — Get full message history (requires sessionKey)`,
                `2. **sessions_list** — List sessions (searches metadata only, NOT message content)`,
                `3. **read_file / search_file_content** — Search codebase`,
                ``,
                `**P1 SOP**: sessions_history(sessionKey="agent:${highestScoreTask.agent_id || 'main'}:run:${highestScoreTask.session_id || 'N/A'}", limit=30)`,
                highestScoreTask.session_id === 'N/A' || !highestScoreTask.session_id ? `\n\n**⚠️ IMPORTANT**: session_id is N/A — P1 sessions_history tool CANNOT be used. You MUST rely on P2 pre-extracted context below, the pain reason, and your own reasoning. Do NOT hallucinate session details.` : '',
                ``,
                `## Pre-extracted Context (P2 - JSONL Fallback)`,
                `If OpenClaw tools cannot access the session (visibility limits),`,
                `use this pre-extracted context below:`,
                contextSection || `*(No JSONL context available — use P1 tools first)*`,
                ``,
                `---`,
                ``,
                `## Diagnostician Protocol`,
                ``,
                `You MUST use the **pd-diagnostician** skill for this task.`,
                `Read the full skill definition and follow the protocol EXACTLY as specified: Phase 0 (context extraction, optional) → Phase 1 (Evidence) → Phase 2 (Causal Chain) → Phase 3 (Classification) → Phase 4 (Principle Extraction).`,
                `The skill defines the complete output contract — your JSON report MUST match the format specified in the skill.`,
                ``,
                `---`,
                ``,
                `After completing the analysis:`,
                `1. Write your JSON diagnosis report to: ${reportFilePath}`,
                `   The JSON structure MUST match the output format defined in the pd-diagnostician skill.`,
                `2. Mark the task complete by creating a marker file: ${markerFilePath}`,
                `   The marker file should contain: "diagnostic_completed: <timestamp>\noutcome: <summary>"`,
                `3. After writing both files, reply with "DIAGNOSTICIAN_DONE: ${highestScoreTask.id}"`,
                existingPrinciplesRef,
            ].join('\n');

            try {
                await addDiagnosticianTask(wctx.stateDir, highestScoreTask.id, heartbeatContent);
                if (logger) logger.info(`[PD:EvolutionWorker] Wrote diagnostician task to diagnostician_tasks.json for task ${highestScoreTask.id}`);

                highestScoreTask.task = taskDescription;
                highestScoreTask.status = 'in_progress';
                highestScoreTask.started_at = nowIso;
                delete highestScoreTask.completed_at;
                highestScoreTask.assigned_session_key = `heartbeat:diagnostician:${highestScoreTask.id}`;
                queueChanged = true;

                evoLogger.logStarted({
                    traceId: highestScoreTask.traceId || highestScoreTask.id,
                    taskId: highestScoreTask.id,
                });

                wctx.trajectory?.updateEvolutionTask?.(highestScoreTask.id, {
                    status: 'in_progress',
                    startedAt: nowIso,
                });

                if (eventLog) {
                    eventLog.recordEvolutionTask({
                        taskId: highestScoreTask.id,
                        taskType: highestScoreTask.source,
                        reason: highestScoreTask.reason
                    });
                }
            } catch (heartbeatErr) {
                if (logger) logger.error(`[PD:EvolutionWorker] Failed to write diagnostician task for task ${highestScoreTask.id}: ${String(heartbeatErr)}. Task will remain pending for next cycle.`);
                SystemLogger.log(wctx.workspaceDir, 'DIAGNOSTICIAN_TASK_WRITE_FAILED', `Task ${highestScoreTask.id} diagnostician task write failed: ${String(heartbeatErr)}`);
            }
        }

        return queueChanged;
    }

    /**
     * Dispatch sleep_reflection tasks.
     * Claims tasks inside the lock, executes reflection outside the lock,
     * then re-acquires the lock to write results.
     *
     * Extracts: evolution-worker.ts L848-1114
     */
    private async _dispatchSleepReflection(
        queue: EvolutionQueueItem[],
        wctx: WorkspaceContext,
        logger: PluginLogger,
        eventLog: EventLog,
        api: OpenClawPluginApi | undefined,
        timeout: number,
        evoLogger: ReturnType<typeof getEvolutionLogger>,
    ): Promise<boolean> {
        const pendingSleepTasks = queue.filter(t => t.status === 'pending' && t.taskKind === 'sleep_reflection');
        const pollingSleepTasks = queue.filter(t =>
            t.status === 'in_progress' && t.taskKind === 'sleep_reflection' && t.resultRef && !t.resultRef.startsWith('trinity-draft')
        );
        const sleepReflectionTasks = [...pendingSleepTasks, ...pollingSleepTasks];
        if (sleepReflectionTasks.length === 0) {
            return false;
        }

        let queueChanged = false;
        const store = new EvolutionQueueStore(wctx.workspaceDir);

        // --- Phase 1: Claim only pending tasks (inside lock) ---
        for (const sleepTask of pendingSleepTasks) {
            sleepTask.status = 'in_progress';
            sleepTask.started_at = new Date().toISOString();
        }
        queueChanged = queueChanged || pendingSleepTasks.length > 0;

        if (pendingSleepTasks.length > 0) {
            const claimedTasks = new Map(pendingSleepTasks.map((task) => [task.id, task]));
            await store.update((freshQueue) =>
                freshQueue.map((task) => claimedTasks.get(task.id) ?? task),
            );
        }

        for (const sleepTask of sleepReflectionTasks) {
            try {
                const isPollingTask = !!sleepTask.resultRef && !sleepTask.resultRef.startsWith('trinity-draft');

                if (isPollingTask) {
                    logger?.debug?.(`[PD:EvolutionWorker] Polling existing sleep_reflection task ${sleepTask.id} (workflowId: ${sleepTask.resultRef})`);
                } else {
                    logger?.info?.(`[PD:EvolutionWorker] Processing sleep_reflection task ${sleepTask.id}`);
                }

                let workflowId: string | undefined;
                let nocturnalManager: NocturnalWorkflowManager;
                let snapshotData: NocturnalSessionSnapshot | undefined;

                if (isPollingTask) {
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- Reason: polling path requires existing resultRef
                    workflowId = sleepTask.resultRef!;
                } else {
                    // Phase 1: Build trajectory snapshot for Nocturnal pipeline
                    // Priority: Pain signal sessionId → Task ID → Recent session with violations
                    try {
                        const extractor = createNocturnalTrajectoryExtractor(wctx.workspaceDir);

                        // 1. Try exact session ID from pain signal (most accurate)
                        const painSessionId = sleepTask.recentPainContext?.mostRecent?.sessionId;
                        let fullSnapshot = painSessionId ? extractor.getNocturnalSessionSnapshot(painSessionId) : undefined;
                        if (fullSnapshot) {
                            logger?.info?.(`[PD:EvolutionWorker] Task ${sleepTask.id} using exact session from pain signal: ${painSessionId}`);
                        }

                        // 2. Try task ID (legacy compatibility, rarely matches)
                        if (!fullSnapshot) {
                            fullSnapshot = extractor.getNocturnalSessionSnapshot(sleepTask.id);
                        }

                        // 3. If no match, find most recent session WITH violation signals
                        if (!fullSnapshot) {
                            const taskTimeMs = new Date(sleepTask.enqueued_at || sleepTask.timestamp).getTime();
                            const recentSessions = extractor.listRecentNocturnalCandidateSessions({
                                limit: 20,
                                minToolCalls: 1,
                                dateTo: sleepTask.enqueued_at || sleepTask.timestamp,
                            }).filter((session) => this._isSessionAtOrBeforeTriggerTime(session, taskTimeMs));
                            // Filter to sessions with actual violations (pain, failures, or gate blocks)
                            const sessionsWithViolations = recentSessions.filter(
                                s => s.failureCount > 0 || s.painEventCount > 0 || s.gateBlockCount > 0
                            );
                            if (sessionsWithViolations.length > 0) {
                                const targetSession = sessionsWithViolations[0];
                                logger?.info?.(`[PD:EvolutionWorker] Task ${sleepTask.id} using session with violations: ${targetSession.sessionId} (failed=${targetSession.failureCount}, pain=${targetSession.painEventCount}, gates=${targetSession.gateBlockCount})`);
                                fullSnapshot = extractor.getNocturnalSessionSnapshot(targetSession.sessionId);
                            } else if (recentSessions.length > 0) {
                                const latestSession = recentSessions[0];
                                logger?.warn?.(`[PD:EvolutionWorker] Task ${sleepTask.id} no sessions with violations found, using most recent: ${latestSession.sessionId} (failed=${latestSession.failureCount}, pain=${latestSession.painEventCount}, gates=${latestSession.gateBlockCount})`);
                                fullSnapshot = extractor.getNocturnalSessionSnapshot(latestSession.sessionId);
                            } else {
                                logger?.warn?.(`[PD:EvolutionWorker] Task ${sleepTask.id} no sessions with tool calls in trajectory DB`);
                            }
                        }

                        if (fullSnapshot) {
                            snapshotData = fullSnapshot;
                        }
                    } catch (snapErr) {
                        logger?.warn?.(`[PD:EvolutionWorker] Failed to build trajectory snapshot for ${sleepTask.id}: ${String(snapErr)}`);
                    }

                    // Phase 2: If no trajectory data, try pain-context fallback
                    if (!snapshotData && sleepTask.recentPainContext) {
                        logger?.warn?.(`[PD:EvolutionWorker] Using pain-context fallback for ${sleepTask.id}: trajectory stats unavailable (stats will be null)`);
                        snapshotData = this._buildFallbackNocturnalSnapshot(sleepTask) ?? undefined;
                    }

                    const snapshotValidation = validateNocturnalSnapshotIngress(snapshotData);
                    if (snapshotValidation.status !== 'valid') {
                        sleepTask.status = 'failed';
                        sleepTask.completed_at = new Date().toISOString();
                        sleepTask.resolution = 'failed_max_retries';
                        sleepTask.lastError = `sleep_reflection failed: invalid_snapshot_ingress (${snapshotValidation.reasons.join('; ') || 'missing snapshot'})`;
                        sleepTask.retryCount = (sleepTask.retryCount ?? 0) + 1;
                        logger?.warn?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} rejected: ${sleepTask.lastError}`);
                        continue;
                    }

                    snapshotData = snapshotValidation.snapshot;
                }

                if (!api) {
                    sleepTask.status = 'failed';
                    sleepTask.completed_at = new Date().toISOString();
                    sleepTask.resolution = 'failed_max_retries';
                    sleepTask.lastError = 'No API available to create NocturnalWorkflowManager';
                    sleepTask.retryCount = (sleepTask.retryCount ?? 0) + 1;
                    logger?.warn?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} skipped: no API`);
                    continue;
                }

                nocturnalManager = new NocturnalWorkflowManager({
                    workspaceDir: wctx.workspaceDir,
                    stateDir: wctx.stateDir,
                    logger: api.logger,
                    runtimeAdapter: new OpenClawTrinityRuntimeAdapter(api),
                });

                if (!isPollingTask) {
                    const workflowHandle = await nocturnalManager.startWorkflow(nocturnalWorkflowSpec, {
                        parentSessionId: `sleep_reflection:${sleepTask.id}`,
                        workspaceDir: wctx.workspaceDir,
                        taskInput: {},
                        metadata: {
                            snapshot: snapshotData,
                            taskId: sleepTask.id,
                            painContext: sleepTask.recentPainContext,
                        },
                    });
                    sleepTask.resultRef = workflowHandle.workflowId;
                    workflowId = workflowHandle.workflowId;
                }

                if (!workflowId) {
                    sleepTask.status = 'failed';
                    sleepTask.completed_at = new Date().toISOString();
                    sleepTask.resolution = 'failed_max_retries';
                    sleepTask.lastError = 'sleep_reflection failed: missing_workflow_id';
                    sleepTask.retryCount = (sleepTask.retryCount ?? 0) + 1;
                    logger?.warn?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} missing workflow id after startup`);
                    continue;
                }

                // Workflow is running asynchronously. Check if it completed in this cycle
                const summary = await nocturnalManager.getWorkflowDebugSummary(workflowId);
                if (summary) {
                    if (summary.state === 'completed') {
                        sleepTask.status = 'completed';
                        sleepTask.completed_at = new Date().toISOString();
                        sleepTask.resolution = 'marker_detected';
                        sleepTask.resultRef = summary.metadata?.nocturnalResult ? 'trinity-draft' : workflowId;
                        logger?.info?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} workflow completed`);
                    } else if (summary.state === 'terminal_error') {
                        const lastEvent = summary.recentEvents[summary.recentEvents.length - 1];
                        const errorReason = lastEvent?.reason ?? 'unknown';
                        let detailedError = `Workflow terminal_error: ${errorReason}`;
                        try {
                            const payload = lastEvent?.payload ?? {};
                            if (payload.skipReason) {
                                detailedError += ` (skipReason: ${payload.skipReason})`;
                            }
                            if (payload.failures && Array.isArray(payload.failures) && payload.failures.length > 0) {
                                detailedError += ` | failures: ${(payload.failures as string[]).slice(0, 3).join(', ')}`;
                            }
                        } catch { /* ignore parse errors */ }
                        sleepTask.lastError = detailedError;
                        sleepTask.retryCount = (sleepTask.retryCount ?? 0) + 1;

                        if (isExpectedSubagentError(errorReason)) {
                            sleepTask.status = 'completed';
                            sleepTask.completed_at = new Date().toISOString();
                            sleepTask.resolution = 'stub_fallback';
                            logger?.warn?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} background runtime unavailable, using stub fallback: ${errorReason}`);
                        } else {
                            sleepTask.status = 'failed';
                            sleepTask.completed_at = new Date().toISOString();
                            sleepTask.resolution = 'failed_max_retries';
                            logger?.warn?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} workflow failed: ${sleepTask.lastError}`);
                        }
                    } else {
                        // Workflow still active, keep task in_progress for next cycle
                        logger?.info?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} workflow ${summary.state}, will poll again next cycle`);
                    }
                }
                queueChanged = true;
            } catch (taskErr) {
                sleepTask.completed_at = new Date().toISOString();
                sleepTask.lastError = String(taskErr);
                sleepTask.retryCount = (sleepTask.retryCount ?? 0) + 1;

                if (isExpectedSubagentError(taskErr)) {
                    sleepTask.status = 'completed';
                    sleepTask.completed_at = new Date().toISOString();
                    sleepTask.resolution = 'stub_fallback';
                    logger?.warn?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} background runtime unavailable, using stub fallback: ${String(taskErr)}`);
                } else {
                    sleepTask.status = 'failed';
                    sleepTask.completed_at = new Date().toISOString();
                    sleepTask.resolution = 'failed_max_retries';
                    logger?.error?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} threw: ${taskErr}`);
                }
                queueChanged = true;
            }
        }

        // --- Phase 3: Write results back via store ---
        try {
            await store.update((freshQueue) => {
                for (const sleepTask of sleepReflectionTasks) {
                    const idx = freshQueue.findIndex(t => t.id === sleepTask.id);
                    if (idx >= 0) {
                        freshQueue[idx] = sleepTask;
                    }
                }
                return freshQueue;
            });

            // Log completions to EvolutionLogger
            for (const sleepTask of sleepReflectionTasks) {
                if (sleepTask.status === 'completed' || sleepTask.status === 'failed') {
                    evoLogger.logCompleted({
                        traceId: sleepTask.traceId || sleepTask.id,
                        taskId: sleepTask.id,
                        resolution: sleepTask.status === 'completed'
                            ? (sleepTask.resolution === 'marker_detected' ? 'marker_detected' : 'manual')
                            : 'manual',
                        durationMs: sleepTask.started_at
                            ? Date.now() - new Date(sleepTask.started_at).getTime()
                            : undefined,
                    });
                }
            }
        } catch (resultLockErr) {
            logger?.warn?.(`[PD:EvolutionWorker] Failed to write sleep_reflection results back: ${String(resultLockErr)}`);
        }

        return queueChanged;
    }

    // ── Helper Methods ────────────────────────────────────────────────────────

    /**
     * Check if a session was at or before the trigger time.
     *
     * Extracts: isSessionAtOrBeforeTriggerTime (evolution-worker.ts L194-210)
     */
    private _isSessionAtOrBeforeTriggerTime(
        session: { startedAt: string; updatedAt: string },
        triggerTimeMs: number,
    ): boolean {
        const startedAtMs = new Date(session.startedAt).getTime();
        const updatedAtMs = new Date(session.updatedAt).getTime();
        if (!Number.isFinite(triggerTimeMs)) {
            return true;
        }
        if (Number.isFinite(startedAtMs) && startedAtMs > triggerTimeMs) {
            return false;
        }
        if (Number.isFinite(updatedAtMs) && updatedAtMs > triggerTimeMs) {
            return false;
        }
        return true;
    }

    /**
     * Build a fallback nocturnal snapshot from pain context when trajectory is unavailable.
     *
     * Extracts: buildFallbackNocturnalSnapshot (evolution-worker.ts L212-244)
     */
    private _buildFallbackNocturnalSnapshot(sleepTask: EvolutionQueueItem): NocturnalSessionSnapshot | null {
        const painContext = sleepTask.recentPainContext;
        if (!painContext) {
            return null;
        }

        const fallbackPainEvents: NocturnalPainEvent[] = painContext.mostRecent ? [{
            source: painContext.mostRecent.source,
            score: painContext.mostRecent.score,
            severity: null,
            reason: painContext.mostRecent.reason,
            createdAt: painContext.mostRecent.timestamp,
        }] : [];

        return {
            sessionId: painContext.mostRecent?.sessionId || sleepTask.id,
            startedAt: sleepTask.timestamp,
            updatedAt: sleepTask.timestamp,
            assistantTurns: [],
            userTurns: [],
            toolCalls: [],
            painEvents: fallbackPainEvents,
            gateBlocks: [],
            stats: {
                totalAssistantTurns: null,
                totalToolCalls: null,
                failureCount: null,
                totalPainEvents: painContext.recentPainCount,
                totalGateBlocks: null,
            },
            _dataSource: 'pain_context_fallback',
        };
    }

    /**
     * Extract recent pain context from PAIN_FLAG file.
     * Delegates to PainFlagDetector.extractRecentPainContext().
     */
    private _extractRecentPainContext(wctx: WorkspaceContext): RecentPainContext {
        const detector = new PainFlagDetector(wctx.workspaceDir);
        return detector.extractRecentPainContext();
    }
}
