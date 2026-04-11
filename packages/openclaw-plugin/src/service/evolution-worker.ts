/* global NodeJS */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { OpenClawPluginServiceContext, OpenClawPluginApi, PluginLogger } from '../openclaw-sdk.js';
import { DictionaryService } from '../core/dictionary-service.js';
import { DetectionService } from '../core/detection-service.js';
import { ensureStateTemplates } from '../core/init.js';
import { SystemLogger } from '../core/system-logger.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import type { EventLog } from '../core/event-log.js';
import { initPersistence, flushAllSessions } from '../core/session-tracker.js';
import { acquireLockAsync, releaseLock as releaseImportedLock, type LockContext } from '../utils/file-lock.js';
import { addDiagnosticianTask, completeDiagnosticianTask } from '../core/diagnostician-task-store.js';
import { getEvolutionLogger } from '../core/evolution-logger.js';
import type { TaskKind, TaskPriority } from '../core/trajectory-types.js';
export type { TaskKind, TaskPriority } from '../core/trajectory-types.js';
import { LockUnavailableError } from '../config/index.js';
import { checkWorkspaceIdle, checkCooldown } from './nocturnal-runtime.js';
import { WorkflowStore } from './subagent-workflow/workflow-store.js';
import type { WorkflowRow } from './subagent-workflow/types.js';
import { EmpathyObserverWorkflowManager } from './subagent-workflow/empathy-observer-workflow-manager.js';
import { DeepReflectWorkflowManager } from './subagent-workflow/deep-reflect-workflow-manager.js';
import { NocturnalWorkflowManager, nocturnalWorkflowSpec } from './subagent-workflow/nocturnal-workflow-manager.js';
import {
    createNocturnalTrajectoryExtractor,
    type NocturnalPainEvent,
    type NocturnalSessionSnapshot,
} from '../core/nocturnal-trajectory-extractor.js';
import { validateNocturnalSnapshotIngress } from '../core/nocturnal-snapshot-contract.js';
import { isExpectedSubagentError } from './subagent-workflow/subagent-error-utils.js';
import { readPainFlagContract } from '../core/pain.js';

const WORKFLOW_TTL_MS = 5 * 60 * 1000; // 5 minutes default TTL for helper workflows
import { OpenClawTrinityRuntimeAdapter } from '../core/nocturnal-trinity.js';

// ── Workflow Watchdog ────────────────────────────────────────────────────────
// Detects stale/orphaned workflows, invalid results, and cleanup failures.
// Runs every heartbeat cycle, catching bugs like:
//   #185 — orphaned active workflows
//   #181 — structurally invalid results (all zeros)
//   #180/#183 — expired workflows not swept
//   #182 — unhandled rejections leaving workflows in limbo

interface WatchdogResult {
  anomalies: number;
  details: string[];
}

async function runWorkflowWatchdog(
  wctx: WorkspaceContext,
  api: OpenClawPluginApi | null,
  logger?: PluginLogger,
): Promise<WatchdogResult> {
  const details: string[] = [];
  const now = Date.now();
  const subagentRuntime = api?.runtime?.subagent;
  const agentSession = api?.runtime?.agent?.session;

  try {
    const store = new WorkflowStore({ workspaceDir: wctx.workspaceDir });
    try {
      const allWorkflows: WorkflowRow[] = store.listWorkflows();

      // Check 1: Stale active workflows (active > 2x TTL)
      const staleThreshold = WORKFLOW_TTL_MS * 2;
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
        // Check if the metadata snapshot has all zeros (invalid data)
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
    logger?.warn?.(`[PD:Watchdog] Failed to scan workflows: ${String(err)}`);
  }

  return { anomalies: details.length, details };
}

let timeoutId: NodeJS.Timeout | null = null;

/**
 * Queue V2 Schema - Supports multiple task kinds while preserving pain_diagnosis semantics.
 *
 * taskKind semantics:
 * - pain_diagnosis: User-adjacent, triggers HEARTBEAT, injects into user prompts
 * - sleep_reflection: Background-only, never injects into user prompts, no HEARTBEAT
 *
 * Old queue items (without taskKind) are migrated to pain_diagnosis for compatibility.
 */
export type QueueStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled';
export type TaskResolution = 'marker_detected' | 'auto_completed_timeout' | 'failed_max_retries' | 'runtime_unavailable' | 'canceled' | 'late_marker_principle_created' | 'late_marker_no_principle' | 'stub_fallback';

/**
 * Recent pain context attached to sleep_reflection tasks.
 * Carries explicit recent pain signal metadata without being a separate task kind.
 * Used by NocturnalTargetSelector for ranking bias and context enrichment.
 */
export interface RecentPainContext {
  /** Most recent unresolved pain event */
  mostRecent: {
    score: number;
    source: string;
    reason: string;
    timestamp: string;
    /** Session ID where the pain occurred */
    sessionId: string;
  } | null;
  /** Count of pain events in the recent window (for signal strength) */
  recentPainCount: number;
  /** Highest pain score in the recent window */
  recentMaxPainScore: number;
}

export interface EvolutionQueueItem {
    // Core identity
    id: string;
    taskKind: TaskKind;          // V2: distinguishes task types
    priority: TaskPriority;      // V2: scheduling priority
    source: string;
    traceId?: string;           // Trace ID for linking events across the evolution lifecycle
    
    // Legacy fields (still used for pain_diagnosis)
    task?: string;
    score: number;
    reason: string;
    timestamp: string;
    enqueued_at?: string;
    started_at?: string;
    completed_at?: string;
    assigned_session_key?: string;
    trigger_text_preview?: string;
    status: QueueStatus;        // V2: includes 'failed' and 'canceled'
    resolution?: TaskResolution;
    session_id?: string;
    agent_id?: string;
    
    // V2 retry support
    retryCount: number;         // V2: number of retry attempts
    maxRetries: number;         // V2: maximum retry attempts allowed
    lastError?: string;         // V2: last error message if failed
    
    // V2 result reference
    resultRef?: string;         // V2: reference to result artifact

    // V2: Recent pain context for sleep_reflection tasks
    // Attaches explicit recent pain signal without merging task kinds.
    // Used by target selector for ranking bias and context enrichment.
    recentPainContext?: RecentPainContext;
}

/**
 * Legacy queue item shape (pre-V2) for migration compatibility.
 * These items lack taskKind, priority, retryCount, maxRetries, lastError fields.
 */
interface LegacyEvolutionQueueItem {
    id: string;
    task?: string;
    score: number;
    source: string;
    reason: string;
    timestamp: string;
    enqueued_at?: string;
    started_at?: string;
    completed_at?: string;
    assigned_session_key?: string;
    trigger_text_preview?: string;
    status?: string;
    resolution?: string;
    session_id?: string;
    agent_id?: string;
    traceId?: string;
    taskKind?: string;
    priority?: string;
    retryCount?: number;
    maxRetries?: number;
    lastError?: string;
    resultRef?: string;
}

/**
 * Default values for new V2 fields when migrating legacy items.
 */
const DEFAULT_TASK_KIND: TaskKind = 'pain_diagnosis';
const DEFAULT_PRIORITY: TaskPriority = 'medium';
const DEFAULT_MAX_RETRIES = 3;

/**
 * Migrate a legacy queue item to V2 schema.
 * Old items without taskKind are assumed to be pain_diagnosis for backward compatibility.
 */
function migrateToV2(item: LegacyEvolutionQueueItem): EvolutionQueueItem {
    return {
        id: item.id,
        taskKind: (item.taskKind as TaskKind) || DEFAULT_TASK_KIND,
        priority: (item.priority as TaskPriority) || DEFAULT_PRIORITY,
        source: item.source,
        traceId: item.traceId,
        task: item.task,
        score: item.score,
        reason: item.reason,
        timestamp: item.timestamp,
        enqueued_at: item.enqueued_at,
        started_at: item.started_at,
        completed_at: item.completed_at,
        assigned_session_key: item.assigned_session_key,
        trigger_text_preview: item.trigger_text_preview,
        status: (item.status as QueueStatus) || 'pending',
        resolution: item.resolution as TaskResolution | undefined,
        session_id: item.session_id,
        agent_id: item.agent_id,
        retryCount: item.retryCount || 0,
        maxRetries: item.maxRetries || DEFAULT_MAX_RETRIES,
        lastError: item.lastError,
        resultRef: item.resultRef,
    };
}

type RawQueueItem = Record<string, unknown>;

/**
 * Check if an item is a legacy (pre-V2) queue item.
 */
function isLegacyQueueItem(item: RawQueueItem): boolean {
    return item && typeof item === 'object' && !('taskKind' in item);
}

/**
 * Migrate entire queue to V2 schema if needed.
 * Returns a new array with all items migrated to V2 format.
 */
function migrateQueueToV2(queue: RawQueueItem[]): EvolutionQueueItem[] {
    return queue.map(item => isLegacyQueueItem(item) ? migrateToV2(item as unknown as LegacyEvolutionQueueItem) : item as unknown as EvolutionQueueItem);
}

function isSessionAtOrBeforeTriggerTime(
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

function buildFallbackNocturnalSnapshot(sleepTask: EvolutionQueueItem): NocturnalSessionSnapshot | null {
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

const PAIN_QUEUE_DEDUP_WINDOW_MS = 30 * 60 * 1000;

// P0 fix: File lock constants and helper for queue operations (prevents TOCTOU race)
export const EVOLUTION_QUEUE_LOCK_SUFFIX = '.lock';
export const LOCK_MAX_RETRIES = 50;
export const LOCK_RETRY_DELAY_MS = 50;
export const LOCK_STALE_MS = 30_000;

/* eslint-disable @typescript-eslint/max-params -- Reason: Function requires all parameters for unique task ID generation */
export function createEvolutionTaskId(
    source: string,
    score: number,
    preview: string,
    reason: string,
    now: number
): string {
    // Keep ids short for prompt injection, but include enough entropy to avoid
    // collisions between different pain events that share the same source/score/preview.
    return createHash('md5')
        .update(`${source}:${score}:${preview}:${reason}:${now}`)
        .digest('hex')
        .substring(0, 8);
}

/* eslint-disable no-unused-vars -- Reason: type-level function parameter names in logger union type are documentation */
export async function acquireQueueLock(resourcePath: string, logger: PluginLogger | { warn?: (message: string) => void; info?: (message: string) => void } | undefined, lockSuffix: string = EVOLUTION_QUEUE_LOCK_SUFFIX): Promise<() => void> {
    try {
        const ctx: LockContext = await acquireLockAsync(resourcePath, {
            lockSuffix,
            maxRetries: LOCK_MAX_RETRIES,
            baseRetryDelayMs: LOCK_RETRY_DELAY_MS,
            lockStaleMs: LOCK_STALE_MS,
        });
        return () => releaseImportedLock(ctx);
    } catch (error: unknown) {
        const warn = logger?.warn;
        warn?.(`[PD:EvolutionWorker] Failed to acquire lock for ${resourcePath}: ${String(error)}`);
        throw error;
    }
}

/* eslint-disable no-unused-vars, @typescript-eslint/max-params -- Reason: type-level function parameter names in logger union type are documentation */
async function requireQueueLock(resourcePath: string, logger: PluginLogger | { warn?: (message: string) => void; info?: (message: string) => void } | undefined, scope: string, lockSuffix: string = EVOLUTION_QUEUE_LOCK_SUFFIX): Promise<() => void> {
    try {
        return await acquireQueueLock(resourcePath, logger, lockSuffix);
    } catch (err) {
        throw new LockUnavailableError(resourcePath, scope, { cause: err });
    }
}

export function extractEvolutionTaskId(task: string): string | null {
    if (!task) return null;
    const match = /\[ID:\s*([A-Za-z0-9_-]+)\]/.exec(task);
    return match?.[1] || null;
}

/* eslint-disable @typescript-eslint/max-params -- Reason: Function requires all parameters for duplicate detection */
function findRecentDuplicateTask(
    queue: EvolutionQueueItem[],
    source: string,
    preview: string,
    now: number,
    reason?: string
): EvolutionQueueItem | undefined {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- Reason: function is defined later in file but used in helper for consistency
    const key = normalizePainDedupKey(source, preview, reason);
    return queue.find((task) => {
        if (task.status === 'completed') return false;
        const taskTime = new Date(task.enqueued_at || task.timestamp).getTime();
        if (!Number.isFinite(taskTime) || (now - taskTime) > PAIN_QUEUE_DEDUP_WINDOW_MS) return false;
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- Reason: function is defined later in file but used in helper for consistency
        return normalizePainDedupKey(task.source, task.trigger_text_preview || '', task.reason) === key;
    });
}

/**
 * Purge stale failed tasks from the queue.
 * Failed tasks older than the threshold are noise — they won't auto-recover
 * and they bloat the queue, slowing every cycle.
 *
 * Called at the start of each cycle to keep the queue lean.
 */
const STALE_FAILED_TASK_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export function purgeStaleFailedTasks(
    queue: EvolutionQueueItem[],
    logger: PluginLogger,
): { purged: number; remaining: number; byReason: Record<string, number> } {
    const cutoff = Date.now() - STALE_FAILED_TASK_MAX_AGE_MS;
    const byReason: Record<string, number> = {};

    const purged = queue.filter((t) => {
        if (t.status !== 'failed') return false;
        const taskTime = new Date(t.timestamp || t.enqueued_at || 0).getTime();
        if (!Number.isFinite(taskTime) || taskTime > cutoff) return false;
        const reason = t.lastError || t.resolution || 'unknown';
        byReason[reason] = (byReason[reason] || 0) + 1;
        return true;
    });

    if (purged.length === 0) return { purged: 0, remaining: queue.length, byReason };

    // Remove purged items from the queue (mutates in place)
    const purgedIds = new Set(purged.map((t) => t.id));
    for (let i = queue.length - 1; i >= 0; i--) {
        if (purgedIds.has(queue[i].id)) queue.splice(i, 1);
    }

    const summary = Object.entries(byReason)
        .map(([r, c]) => `${c}x ${r}`)
        .join('; ');
    logger?.info?.(`[PD:EvolutionWorker] Purged ${purged.length} stale failed tasks (>24h): ${summary}`);

    return { purged: purged.length, remaining: queue.length, byReason };
}

function normalizePainDedupKey(source: string, preview: string, reason?: string): string {
    // Include reason in dedup key to match createEvolutionTaskId() behavior
    // Different reasons for the same source/preview should create different tasks
    const normalizedReason = (reason || '').trim().toLowerCase();
    return `${source.trim().toLowerCase()}::${preview.trim().toLowerCase()}::${normalizedReason}`;
}

/* eslint-disable @typescript-eslint/max-params -- Reason: Function requires all parameters for duplicate detection */
export function hasRecentDuplicateTask(queue: EvolutionQueueItem[], source: string, preview: string, now: number, reason?: string): boolean {
    return !!findRecentDuplicateTask(queue, source, preview, now, reason);
}

export function hasEquivalentPromotedRule(dictionary: { getAllRules(): Record<string, { type: string; phrases?: string[]; pattern?: string; status: string; }> }, phrase: string): boolean {
    const normalizedPhrase = phrase.trim().toLowerCase();
    return Object.values(dictionary.getAllRules()).some((rule) => {
        if (rule.status !== 'active') return false;
        if (rule.type === 'exact_match' && Array.isArray(rule.phrases)) {
            return rule.phrases.some((candidate) => candidate.trim().toLowerCase() === normalizedPhrase);
        }
        if (rule.type === 'regex' && typeof rule.pattern === 'string') {
            return rule.pattern.trim().toLowerCase() === normalizedPhrase;
        }
        return false;
    });
}

/**
 * Read recent pain context from PAIN_FLAG file.
 * Extracts session_id to link to trajectory DB.
 * Returns structured pain metadata for attaching to sleep_reflection tasks.
 * Returns null if no pain flag exists.
 */
export function readRecentPainContext(wctx: WorkspaceContext): RecentPainContext {
    const contract = readPainFlagContract(wctx.workspaceDir);
    if (contract.status !== 'valid') {
        return { mostRecent: null, recentPainCount: 0, recentMaxPainScore: 0 };
    }

    try {
        const score = parseInt(contract.data.score ?? '0', 10) || 0;
        const source = contract.data.source ?? '';
        const reason = contract.data.reason ?? '';
        const timestamp = contract.data.time ?? '';
        const sessionId = contract.data.session_id ?? '';

        if (score > 0) {
            return {
                mostRecent: { score, source, reason, timestamp, sessionId },
                recentPainCount: 1,
                recentMaxPainScore: score,
            };
        }
    } catch {
        // Best effort — non-fatal
    }

    return { mostRecent: null, recentPainCount: 0, recentMaxPainScore: 0 };
}

/**
 * Enqueue a sleep_reflection task if one is not already pending.
 * Phase 2.4: Called when workspace is idle to trigger nocturnal reflection.
 */
async function enqueueSleepReflectionTask(
    wctx: WorkspaceContext,
    logger: PluginLogger
): Promise<void> {
    const queuePath = wctx.resolve('EVOLUTION_QUEUE');
    const releaseLock = await requireQueueLock(queuePath, logger, 'enqueueSleepReflection', EVOLUTION_QUEUE_LOCK_SUFFIX);

    try {
        let rawQueue: RawQueueItem[] = [];
        try {
            rawQueue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
        } catch {
            // Queue doesn't exist yet - create empty array
            rawQueue = [];
        }

        const queue: EvolutionQueueItem[] = migrateQueueToV2(rawQueue);

        // Check if a sleep_reflection task is already pending
        const hasPendingSleepReflection = queue.some(
            t => t.taskKind === 'sleep_reflection' && (t.status === 'pending' || t.status === 'in_progress')
        );
        if (hasPendingSleepReflection) {
            logger?.debug?.('[PD:EvolutionWorker] sleep_reflection task already pending/in-progress, skipping');
            return;
        }

        const now = Date.now();
        const taskId = createEvolutionTaskId('nocturnal', 50, 'idle workspace', 'Sleep-mode reflection', now);
        const nowIso = new Date(now).toISOString();

        // Attach recent pain context if available
        const recentPainContext = readRecentPainContext(wctx);

        queue.push({
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
            maxRetries: 1, // sleep_reflection doesn't retry
            recentPainContext,
        });

        fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
        logger?.info?.(`[PD:EvolutionWorker] Enqueued sleep_reflection task ${taskId}`);
    } finally {
        releaseLock();
    }
}

interface ParsedPainValues {
    score: number; source: string; reason: string; preview: string;
    traceId: string; sessionId: string; agentId: string;
}

/* eslint-disable @typescript-eslint/max-params -- Reason: Function requires all parameters for task enqueue */
async function doEnqueuePainTask(
    wctx: WorkspaceContext, logger: PluginLogger, painFlagPath: string,
    result: WorkerStatusReport['pain_flag'], v: ParsedPainValues,
): Promise<WorkerStatusReport['pain_flag']> {
    result.exists = true;
    result.score = v.score;
    result.source = v.source;

    if (v.score < 30) {
        result.skipped_reason = `score_too_low (${v.score} < 30)`;
        if (logger) logger.info(`[PD:EvolutionWorker] Pain flag score too low: ${v.score} (source=${v.source})`);
        return result;
    }

    const queuePath = wctx.resolve('EVOLUTION_QUEUE');
    const releaseLock = await requireQueueLock(queuePath, logger, 'checkPainFlag');
    try {
        let queue: EvolutionQueueItem[] = [];
        if (fs.existsSync(queuePath)) {
            try { queue = JSON.parse(fs.readFileSync(queuePath, 'utf8')); } catch { /* corrupted queue, treat as empty — safe fallback */ }
        }
        const now = Date.now();
        const dup = findRecentDuplicateTask(queue, v.source, v.preview, now, v.reason);
        if (dup) {
            fs.appendFileSync(painFlagPath, `\nstatus: queued\ntask_id: ${dup.id}\n`, 'utf8');
            result.enqueued = true;
            result.skipped_reason = 'duplicate';
            if (logger) logger.info(`[PD:EvolutionWorker] Duplicate pain task skipped for source=${v.source} preview=${v.preview || 'N/A'}`);
            return result;
        }

        const taskId = createEvolutionTaskId(v.source, v.score, v.preview, v.reason, now);
        const nowIso = new Date(now).toISOString();
        const effectiveTraceId = v.traceId || taskId;

        queue.push({
            id: taskId, taskKind: 'pain_diagnosis',
            priority: v.score >= 70 ? 'high' : v.score >= 40 ? 'medium' : 'low',
            score: v.score, source: v.source, reason: v.reason,
            trigger_text_preview: v.preview, timestamp: nowIso, enqueued_at: nowIso,
            status: 'pending', session_id: v.sessionId || undefined,
            agent_id: v.agentId || undefined, traceId: effectiveTraceId,
            retryCount: 0, maxRetries: 3,
        });

        fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
        fs.appendFileSync(painFlagPath, `\nstatus: queued\ntask_id: ${taskId}\n`, 'utf8');
        result.enqueued = true;

        if (logger) logger.info(`[PD:EvolutionWorker] Enqueued pain task ${taskId} (score=${v.score})`);

        const evoLogger = getEvolutionLogger(wctx.workspaceDir, wctx.trajectory);
        evoLogger.logQueued({
            traceId: effectiveTraceId,
            taskId,
            score: v.score,
            source: v.source,
            reason: v.reason,
        });

        wctx.trajectory?.recordEvolutionTask?.({
            taskId,
            traceId: effectiveTraceId,
            source: v.source,
            reason: v.reason,
            score: v.score,
            status: 'pending',
            enqueuedAt: nowIso,
        });
    } finally { releaseLock(); }
    return result;
}

async function checkPainFlag(wctx: WorkspaceContext, logger: PluginLogger): Promise<WorkerStatusReport['pain_flag']> {
    const result: WorkerStatusReport['pain_flag'] = { exists: false, score: null, source: null, enqueued: false, skipped_reason: null };
    try {
        const painFlagPath = wctx.resolve('PAIN_FLAG');
        if (!fs.existsSync(painFlagPath)) return result;

        const rawPain = fs.readFileSync(painFlagPath, 'utf8');
        const contract = readPainFlagContract(wctx.workspaceDir);

        if (contract.status === 'valid') {
            const score = parseInt(contract.data.score ?? '0', 10) || 0;
            const source = contract.data.source ?? 'unknown';
            const reason = contract.data.reason ?? 'Systemic pain detected';
            const preview = contract.data.trigger_text_preview ?? '';
            const isQueued = contract.data.status === 'queued';
            const traceId = contract.data.trace_id ?? '';
            const sessionId = contract.data.session_id ?? '';
            const agentId = contract.data.agent_id ?? '';

            result.exists = true;
            result.score = score;
            result.source = source;
            result.enqueued = isQueued;

            if (isQueued) {
                result.skipped_reason = 'already_queued';
                if (logger) logger.info(`[PD:EvolutionWorker] Pain flag already queued (score=${score}, source=${source})`);
                return result;
            }

            if (logger) logger.info(`[PD:EvolutionWorker] Detected pain flag (score: ${score}, source: ${source}). Enqueueing evolution task.`);
            return doEnqueuePainTask(wctx, logger, painFlagPath, result, {
                score, source, reason, preview, traceId, sessionId, agentId,
            });
        }

        if (contract.status === 'invalid' && (contract.format === 'kv' || contract.format === 'json' || contract.format === 'invalid_json')) {
            result.exists = true;
            result.skipped_reason = `invalid_pain_flag (${contract.missingFields.join(', ') || contract.format})`;
            if (logger) logger.warn(`[PD:EvolutionWorker] Invalid pain flag skipped: ${result.skipped_reason}`);
            return result;
        }

        // Try JSON format first (pain skill structured output)
        // The file may have 'status: queued' and 'task_id: xxx' appended after the JSON object.
        // Extract just the JSON portion by finding the last '}' and parsing up to that point.
        let parsedAsJson = false;
        try {
            const jsonEndIdx = rawPain.lastIndexOf('}');
            const jsonPortion = jsonEndIdx >= 0 ? rawPain.slice(0, jsonEndIdx + 1) : rawPain;
            const jsonPain = JSON.parse(jsonPortion);

            // Detect if this is a pain flag JSON object: has any of the known pain flag fields
            const isPainJson = typeof jsonPain === 'object' && jsonPain !== null && (
                jsonPain.pain_score !== undefined ||
                jsonPain.score !== undefined ||
                jsonPain.source !== undefined ||
                jsonPain.reason !== undefined ||
                jsonPain.session_id !== undefined ||
                jsonPain.agent_id !== undefined
            );

            if (isPainJson) {
                parsedAsJson = true;
                // Score resolution: pain_score > score > default 50
                const jsonScore = typeof jsonPain.pain_score === 'number' ? jsonPain.pain_score :
                                  typeof jsonPain.score === 'number' ? jsonPain.score : 50;
                const jsonSource = jsonPain.source || 'human';
                const jsonReason = jsonPain.reason || jsonPain.requested_action || 'Systemic pain detected';
                const jsonPreview = (jsonPain.symptoms || []).slice(0, 2).join('; ');

                // Check if already queued by looking for 'status: queued' in the full file
                const alreadyQueued = rawPain.includes('status: queued');
                if (alreadyQueued) {
                    result.exists = true;
                    result.score = jsonScore;
                    result.source = jsonSource;
                    result.enqueued = true;
                    result.skipped_reason = 'already_queued';
                    if (logger) logger.info(`[PD:EvolutionWorker] Pain flag already queued (score=${jsonScore}, source=${jsonSource})`);
                    return result;
                }

                return doEnqueuePainTask(wctx, logger, painFlagPath, result, {
                    score: jsonScore, source: jsonSource, reason: jsonReason,
                    preview: jsonPreview, traceId: '',
                    sessionId: jsonPain.session_id || '',
                    agentId: jsonPain.agent_id || '',
                });
            }
        } catch { /* Not JSON — fall through to KV/Markdown parsing */ }

        // If we successfully parsed JSON but it didn't match pain flag fields,
        // don't fall through to KV parsing — it's not a valid pain flag
        if (parsedAsJson) {
            if (logger) logger.warn('[PD:EvolutionWorker] Pain flag parsed as JSON but missing all expected fields — ignoring');
            result.skipped_reason = 'invalid_json_format';
            return result;
        }

        const lines = rawPain.split('\n');

        let score = 0;
        let source = 'unknown';
        let reason = 'Systemic pain detected';
        let preview = '';
        let isQueued = false;
        let traceId = '';
        let sessionId = '';
        let agentId = '';

        for (const line of lines) {
            // KV format: "key: value"
            if (line.startsWith('score:')) score = parseInt(line.split(':', 2)[1].trim(), 10) || 0;
            if (line.startsWith('source:')) source = line.split(':', 2)[1].trim();
            if (line.startsWith('reason:')) reason = line.slice('reason:'.length).trim();
            if (line.startsWith('trigger_text_preview:')) preview = line.slice('trigger_text_preview:'.length).trim();
            if (line.startsWith('status: queued')) isQueued = true;
            if (line.startsWith('trace_id:')) traceId = line.split(':', 2)[1].trim();
            if (line.startsWith('session_id:')) sessionId = line.slice('session_id:'.length).trim();
            if (line.startsWith('agent_id:')) agentId = line.slice('agent_id:'.length).trim();

            // Key=Value fallback format: "key=value" (pain skill manual output)
            // Handles both uppercase (Source=X) and lowercase (source=x) variants
            if (line.startsWith('Source=') || line.startsWith('source=')) source = line.includes('Source=') ? line.slice('Source='.length).trim() : line.slice('source='.length).trim();
            if (line.startsWith('Reason=') || line.startsWith('reason=')) reason = line.includes('Reason=') ? line.slice('Reason='.length).trim() : line.slice('reason='.length).trim();
            if (line.startsWith('Score=') || line.startsWith('score=')) {
                const scoreStr = line.includes('Score=') ? line.slice('Score='.length).trim() : line.slice('score='.length).trim();
                score = parseInt(scoreStr, 10) || 0;
            }
            if (line.startsWith('Time=') || line.startsWith('time=')) {
                const timeStr = line.includes('Time=') ? line.slice('Time='.length).trim() : line.slice('time='.length).trim();
                preview = `Human intervention at ${timeStr}`;
            }

            // Markdown format support (pain skill writes **Source**: xxx format)
            const mdSource = /\*\*Source\*\*:\s*(.+)/.exec(line);
            if (mdSource) source = mdSource[1].trim();
            const mdReason = /\*\*Reason\*\*:\s*(.+)/.exec(line);
            if (mdReason) reason = mdReason[1].trim();
            const mdTime = /\*\*Time\*\*:\s*(.+)/.exec(line);
            if (mdTime) preview = `Human intervention at ${mdTime[1].trim()}`;
        }

        // Markdown format has no score — default to 50 for human intervention
        if (score === 0 && source !== 'unknown') score = 50;

        result.exists = true;
        result.score = score;
        result.source = source;
        result.enqueued = isQueued;

        if (isQueued) {
            result.skipped_reason = 'already_queued';
            if (logger) logger.info(`[PD:EvolutionWorker] Pain flag already queued (score=${score}, source=${source})`);
            return result;
        }

        if (logger) logger.info(`[PD:EvolutionWorker] Detected pain flag (score: ${score}, source: ${source}). Enqueueing evolution task.`);

        return doEnqueuePainTask(wctx, logger, painFlagPath, result, {
            score, source, reason, preview,
            traceId, sessionId, agentId,
        });

    } catch (err) {
        if (logger) logger.warn(`[PD:EvolutionWorker] Error processing pain flag: ${String(err)}`);
        result.skipped_reason = `error: ${String(err)}`;
    }
    return result;
}

/* eslint-disable @typescript-eslint/max-params -- Reason: Function requires all parameters for queue processing */
async function processEvolutionQueue(wctx: WorkspaceContext, logger: PluginLogger, eventLog: EventLog, api?: OpenClawPluginApi) {
    const queuePath = wctx.resolve('EVOLUTION_QUEUE');
    if (!fs.existsSync(queuePath)) {
        logger?.debug?.('[PD:EvolutionWorker] No evolution queue file — nothing to process');
        return;
    }

    const releaseLock = await requireQueueLock(queuePath, logger, 'processEvolutionQueue');
    const evoLogger = getEvolutionLogger(wctx.workspaceDir, wctx.trajectory);
    let lockReleased = false;

    try {
        let rawQueue: RawQueueItem[] = [];
        try {
            rawQueue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
        } catch (e) {
            // Backup corrupted file instead of silently discarding
            const backupPath = `${queuePath}.corrupted.${Date.now()}`;
            try {
                fs.renameSync(queuePath, backupPath);
                if (logger) {
                    logger.error(`[PD:EvolutionWorker] Evolution queue corrupted and backed up to ${backupPath}. All pending tasks have been preserved in the backup file. Parse error: ${String(e)}`);
                }
                SystemLogger.log(wctx.workspaceDir, 'QUEUE_CORRUPTED', `Queue file backed up to ${backupPath}. Error: ${String(e)}`);
            } catch (backupErr) {
                if (logger) {
                    logger.error(`[PD:EvolutionWorker] Failed to backup corrupted queue: ${String(backupErr)}`);
                }
            }
            return;
        }

        // V2: Migrate queue to current schema if needed
        const queue: EvolutionQueueItem[] = migrateQueueToV2(rawQueue);

        let queueChanged = rawQueue.some(isLegacyQueueItem);

        const {config} = wctx;
        const timeout = config.get('intervals.task_timeout_ms') || (60 * 60 * 1000); // Default 1 hour

        // V2: Recover stuck in_progress sleep_reflection tasks.
        // If the worker crashes or the result write-back fails after Phase 1 claimed
        // the task, it stays in_progress indefinitely. Detect via timeout and mark
        // as failed so a fresh task can be enqueued on the next idle cycle.
        // #214: Also expire the underlying nocturnal workflow to prevent resource leaks.
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
                        const failureEvent = events.filter(e => 
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
                evoLogger.logCompleted({
                    traceId: task.traceId || task.id,
                    taskId: task.id,
                    resolution: 'manual',
                    durationMs: age,
                });

                // #214: Expire the underlying nocturnal workflow to prevent resource leak.
                // The task's resultRef holds the workflowId if one was started.
                if (task.resultRef && !task.resultRef.startsWith('trinity-draft')) {
                    try {
                        const nocturnalMgr = new NocturnalWorkflowManager({
                            workspaceDir: wctx.workspaceDir,
                            stateDir: wctx.stateDir,
                            logger: api?.logger || logger,
                            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- Reason: api is guaranteed non-null in this recovery path where runtimeAdapter is required
                            runtimeAdapter: new OpenClawTrinityRuntimeAdapter(api!),
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

        // Check in_progress tasks for completion (only pain_diagnosis gets HEARTBEAT treatment)
        // Diagnostician runs via HEARTBEAT (main session LLM), not as a subagent.
        // Marker file detection is the ONLY completion path for HEARTBEAT diagnostics.
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
                                        // without requiring full detectorMetadata from the diagnostician.
                                        evaluability: principle.evaluability || 'weak_heuristic',
                                        // Review fix: Accept both snake_case and camelCase from LLM output
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

                // Log to EvolutionLogger
                const durationMs = task.started_at
                    ? Date.now() - new Date(task.started_at).getTime()
                    : undefined;
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
                                    // #212: Default to weak_heuristic so principles are auto-evaluable.
                                    evaluability: principle.evaluability || 'weak_heuristic',
                                    // Review fix: Accept both snake_case and camelCase from LLM output
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

                // Log to EvolutionLogger - use task.resolution, not hardcoded value
                evoLogger.logCompleted({
                    traceId: task.traceId || task.id,
                    taskId: task.id,
                    resolution: task.resolution,
                    durationMs: age,
                });

                // Update evolution_tasks table - use task.resolution, not hardcoded value
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

        // V2: Process pain_diagnosis tasks FIRST (quick, inside lock),
        // then sleep_reflection tasks (slow, lock released during execution).
        // This order ensures pain tasks are never starved by long-running
        // nocturnal reflection — sleep_reflection can safely return early
        // because pain_diagnosis has already been handled.
        const pendingTasks = queue.filter(t => t.status === 'pending' && t.taskKind === 'pain_diagnosis');

        if (pendingTasks.length > 0) {
            // V2: Also sort by priority within same score
            const priorityWeight = { high: 3, medium: 2, low: 1 };
            const [highestScoreTask] = pendingTasks.sort((a, b) => {
                const scoreDiff = b.score - a.score;
                if (scoreDiff !== 0) return scoreDiff;
                return (priorityWeight[b.priority] || 2) - (priorityWeight[a.priority] || 2);
            });
            const nowIso = new Date().toISOString();

            const taskDescription = `Diagnose systemic pain [ID: ${highestScoreTask.id}]. Source: ${highestScoreTask.source}. Reason: ${highestScoreTask.reason}. ` +
                  `Trigger text: "${highestScoreTask.trigger_text_preview || 'N/A'}"`;

            // Prepare diagnostician task content
            // FIX (#187): Write diagnostician tasks to .state/diagnostician_tasks.json
            // instead of HEARTBEAT.md. HEARTBEAT.md is a shared file that gets overwritten
            // by the main session heartbeat, causing a race condition where the diagnostician
            // task prompt is lost. The task store is in .state/ which is not modified by
            // the main session.
            const markerFilePath = path.join(wctx.stateDir, `.evolution_complete_${highestScoreTask.id}`);
            const reportFilePath = path.join(wctx.stateDir, `.diagnostician_report_${highestScoreTask.id}.json`);

            let existingPrinciplesRef = '';
            try {
                const activePrinciples = wctx.evolutionReducer.getActivePrinciples();
                if (activePrinciples.length > 0) {
                    // Include all principles up to 20 — enough for duplicate detection
                    // without overwhelming the context window
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

                    // Also inject suggested rules from existing principles (if any)
                    const rulesByPrinciple = included.filter((p) => p.suggestedRules?.length);
                    if (rulesByPrinciple.length > 0) {
                        const ruleLines = rulesByPrinciple.flatMap((p) =>
                            (p.suggestedRules ?? []).map((r) => `- [${p.id}] **${r.name}**: ${r.action} (type: ${r.type}, enforce: ${r.enforcement})`),
                        );
                        existingPrinciplesRef += `\n\n**Suggested Rules from Existing Principles**:\n${ruleLines.join('\n')}`;
                    }
                }
            } catch (err) {
                // #184: Log warning instead of silently swallowing — diagnostician needs
                // existing principles context for duplicate detection.
                logger?.warn?.(`[PD:EvolutionWorker] Failed to load active principles for duplicate detection: ${String(err)}`);
            }

            // ── Context Enrichment (CTX-01): Dual-path strategy ──
            // P1: OpenClaw built-in tools (sessions_history) - safe, visibility-limited
            // P2: JSONL direct read - fallback when tools fail or session not visible
            // The diagnostician skill implements both paths (Phase 0 protocol).
            //
            // Here we pre-extract JSONL context as backup and inject tool instructions.

            let contextSection = '';
            if (highestScoreTask.session_id && highestScoreTask.agent_id) {
                try {
                    const { extractRecentConversation, extractFailedToolContext } = await import('../core/pain-context-extractor.js');
                    const conversation = await extractRecentConversation(highestScoreTask.session_id, highestScoreTask.agent_id, 5);
                    
                    if (conversation) {
                        contextSection = `\n## Recent Conversation Context (pre-extracted JSONL fallback)\n\n${conversation}\n`;
                        
                        // Also try to extract failed tool context if this is a tool failure
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
                `   The marker file should contain: "diagnostic_completed: <timestamp>\\noutcome: <summary>"`,
                `3. After writing both files, reply with "DIAGNOSTICIAN_DONE: ${highestScoreTask.id}"`,
                existingPrinciplesRef,
            ].join('\n');

            // FIX (#187): Write to diagnostician_tasks.json instead of HEARTBEAT.md
            // HEARTBEAT.md is a shared file that gets overwritten by the main session
            // heartbeat, causing a race condition. The task store is in .state/ and is
            // not modified by the main session.
            try {
                await addDiagnosticianTask(wctx.stateDir, highestScoreTask.id, heartbeatContent);
                if (logger) logger.info(`[PD:EvolutionWorker] Wrote diagnostician task to diagnostician_tasks.json for task ${highestScoreTask.id}`);

                // Task store write succeeded, now mark task as in_progress
                highestScoreTask.task = taskDescription;
                highestScoreTask.status = 'in_progress';
                highestScoreTask.started_at = nowIso;
                delete highestScoreTask.completed_at;
                // Use placeholder so marker path can correlate task (no subagent spawned for HEARTBEAT)
                // This fixes task_outcomes being empty for HEARTBEAT-triggered diagnostician runs
                highestScoreTask.assigned_session_key = `heartbeat:diagnostician:${highestScoreTask.id}`;
                queueChanged = true;

                // Log to EvolutionLogger
                evoLogger.logStarted({
                    traceId: highestScoreTask.traceId || highestScoreTask.id,
                    taskId: highestScoreTask.id,
                });

                // Update evolution_tasks table
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
                // Diagnostician task store write failed - keep task as pending for next cycle retry
                if (logger) logger.error(`[PD:EvolutionWorker] Failed to write diagnostician task for task ${highestScoreTask.id}: ${String(heartbeatErr)}. Task will remain pending for next cycle.`);
                SystemLogger.log(wctx.workspaceDir, 'DIAGNOSTICIAN_TASK_WRITE_FAILED', `Task ${highestScoreTask.id} diagnostician task write failed: ${String(heartbeatErr)}`);
            }
        }

        // Phase 2.4: Process sleep_reflection tasks AFTER pain_diagnosis.
        // Claim tasks inside the lock, execute reflection outside the lock,
        // then re-acquire the lock to write results. This prevents the long-running
        // nocturnal reflection from blocking all other queue consumers.
        // Safe to return early here because pain_diagnosis was already handled above.

        // FIX: Also poll in_progress tasks that were started in a previous cycle.
        // Previously only 'pending' tasks were filtered, so an in_progress task from
        // a previous heartbeat cycle would never be re-polled until the 1-hour
        // stuck task recovery kicked in.
        const pendingSleepTasks = queue.filter(t => t.status === 'pending' && t.taskKind === 'sleep_reflection');
        const pollingSleepTasks = queue.filter(t =>
            t.status === 'in_progress' && t.taskKind === 'sleep_reflection' && t.resultRef && !t.resultRef.startsWith('trinity-draft')
        );
        const sleepReflectionTasks = [...pendingSleepTasks, ...pollingSleepTasks];
        if (sleepReflectionTasks.length > 0) {
            // --- Phase 1: Claim only pending tasks (inside lock) ---
            // in_progress tasks from previous cycles are already claimed, don't re-claim them
            for (const sleepTask of pendingSleepTasks) {
                sleepTask.status = 'in_progress';
                sleepTask.started_at = new Date().toISOString();
            }
            queueChanged = queueChanged || pendingSleepTasks.length > 0;

            // Write claimed state (includes any pain changes from above) and release lock
            if (queueChanged) {
                fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
            }
            releaseLock();
            for (const sleepTask of sleepReflectionTasks) {
                try {
                    // FIX: For in_progress tasks from a previous cycle, just poll the workflow.
                    // Don't start a new workflow — that was already done when the task was first claimed.
                    const isPollingTask = !!sleepTask.resultRef && !sleepTask.resultRef.startsWith('trinity-draft');

                    if (isPollingTask) {
                        logger?.debug?.(`[PD:EvolutionWorker] Polling existing sleep_reflection task ${sleepTask.id} (workflowId: ${sleepTask.resultRef})`);
                    } else {
                        logger?.info?.(`[PD:EvolutionWorker] Processing sleep_reflection task ${sleepTask.id}`);
                    }

                    let workflowId: string | undefined;
                    // eslint-disable-next-line @typescript-eslint/init-declarations -- assigned when runtime API is available
                    let nocturnalManager: NocturnalWorkflowManager;
                    // eslint-disable-next-line @typescript-eslint/init-declarations -- assigned only for newly started workflows
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
                                }).filter((session) => isSessionAtOrBeforeTriggerTime(session, taskTimeMs));
                                // Filter to sessions with actual violations (pain, failures, or gate blocks)
                                const sessionsWithViolations = recentSessions.filter(
                                    s => s.failureCount > 0 || s.painEventCount > 0 || s.gateBlockCount > 0
                                );
                                if (sessionsWithViolations.length > 0) {
                                    const targetSession = sessionsWithViolations[0];
                                    logger?.info?.(`[PD:EvolutionWorker] Task ${sleepTask.id} using session with violations: ${targetSession.sessionId} (failed=${targetSession.failureCount}, pain=${targetSession.painEventCount}, gates=${targetSession.gateBlockCount})`);
                                    fullSnapshot = extractor.getNocturnalSessionSnapshot(targetSession.sessionId);
                                } else if (recentSessions.length > 0) {
                                    // No sessions with violations, use most recent as last resort
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
                            snapshotData = buildFallbackNocturnalSnapshot(sleepTask) ?? undefined;
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
                    // by polling getWorkflowDebugSummary.
                    const summary = await nocturnalManager.getWorkflowDebugSummary(workflowId);
                    if (summary) {
                        if (summary.state === 'completed') {
                            sleepTask.status = 'completed';
                            sleepTask.completed_at = new Date().toISOString();
                            sleepTask.resolution = 'marker_detected';
                            sleepTask.resultRef = summary.metadata?.nocturnalResult ? 'trinity-draft' : workflowId;
                            logger?.info?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} workflow completed`);
                        } else if (summary.state === 'terminal_error') {
                            // #208/#209: Classify terminal_error reason before hardcoding to failed.
                            // The async executeNocturnalReflectionAsync catches subagent errors and
                            // records them as terminal_error. Without this check, expected errors
                            // (daemon mode, process isolation) would always become failed_max_retries.
                            const lastEvent = summary.recentEvents[summary.recentEvents.length - 1];
                            const errorReason = lastEvent?.reason ?? 'unknown';
                            // #219: Include payload details for better diagnostics
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
                                sleepTask.status = 'failed';
                                sleepTask.completed_at = new Date().toISOString();
                                sleepTask.resolution = 'runtime_unavailable';
                                logger?.warn?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} background runtime unavailable: ${errorReason}`);
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
                } catch (taskErr) {
                    // #202: Handle expected subagent unavailability (e.g., process isolation in daemon mode)
                    // When subagent is unavailable due to gateway running in separate process,
                    // use stub fallback instead of failing the task.
                    sleepTask.lastError = String(taskErr);
                    sleepTask.retryCount = (sleepTask.retryCount ?? 0) + 1;
                    if (isExpectedSubagentError(taskErr)) {
                        sleepTask.status = 'failed';
                        sleepTask.completed_at = new Date().toISOString();
                        sleepTask.resolution = 'runtime_unavailable';
                        logger?.warn?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} background runtime unavailable: ${String(taskErr)}`);
                    } else {
                        sleepTask.status = 'failed';
                        sleepTask.completed_at = new Date().toISOString();
                        sleepTask.resolution = 'failed_max_retries';
                        logger?.error?.(`[PD:EvolutionWorker] sleep_reflection task ${sleepTask.id} threw: ${taskErr}`);
                    }
                }
            }

            // --- Phase 3: Write results back (re-acquire lock) ---
            try {
                const resultLock = await requireQueueLock(queuePath, logger, 'sleepReflectionResult');
                try {
                    // Re-read queue to merge with any changes made while lock was released
                    let freshQueue: (RawQueueItem | EvolutionQueueItem)[] = [];
                    try {
                        freshQueue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
                    } catch { /* empty queue if corrupted */ }

                    // Merge: update tasks by ID
                    for (const sleepTask of sleepReflectionTasks) {
                        const idx = freshQueue.findIndex((t) => (t as { id?: string }).id === sleepTask.id);
                        if (idx >= 0) {
                            freshQueue[idx] = sleepTask;
                        }
                    }
                    fs.writeFileSync(queuePath, JSON.stringify(freshQueue, null, 2), 'utf8');

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
                } finally {
                    resultLock();
                }
            } catch (resultLockErr) {
                // If we can't re-acquire lock, results are in memory but not persisted.
                // Tasks will appear stuck as in_progress and will be retried on next cycle.
                logger?.warn?.(`[PD:EvolutionWorker] Failed to write sleep_reflection results back: ${String(resultLockErr)}`);
            }

            // Safe to return — pain_diagnosis was already processed above.
            lockReleased = true;
            return;
        }

        if (queueChanged) {
            fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
        }

        // Pipeline observability: log stage-level summary at end of cycle
        const pendingPain = queue.filter((t) => t.status === 'pending' && t.taskKind === 'pain_diagnosis').length;
        const inProgressPain = queue.filter((t) => t.status === 'in_progress' && t.taskKind === 'pain_diagnosis').length;
        if (inProgressPain > 0) {
            const stuck = queue
                .filter((t) => t.status === 'in_progress' && t.taskKind === 'pain_diagnosis')
                .map((t) => `${t.id} (since ${t.started_at || 'unknown'})`);
            logger?.info?.(`[PD:EvolutionWorker] Pipeline: ${inProgressPain} pain_diagnosis task(s) in_progress — awaiting agent response: ${stuck.join(', ')}`);
        }
        if (pendingPain > 0) {
            logger?.info?.(`[PD:EvolutionWorker] Pipeline: ${pendingPain} pain_diagnosis task(s) pending — HEARTBEAT.md will trigger next cycle`);
        }
        const painCompleted = queue.filter((t) => t.status === 'completed' && t.taskKind === 'pain_diagnosis').length;
        logger?.info?.(`[PD:EvolutionWorker] Pipeline summary: pain_completed=${painCompleted} pain_pending=${pendingPain} pain_in_progress=${inProgressPain}`);
    } catch (err) {
        if (logger) logger.warn(`[PD:EvolutionWorker] Error processing evolution queue: ${String(err)}`);
    } finally {
        if (!lockReleased) {
            releaseLock();
        }
    }
}

async function processDetectionQueue(wctx: WorkspaceContext, api: OpenClawPluginApi, eventLog: EventLog) {
    const {logger} = api;
    try {
        const funnel = DetectionService.get(wctx.stateDir);
        const queue = funnel.flushQueue();
        if (queue.length === 0) return;

        if (logger) logger.info(`[PD:EvolutionWorker] Processing ${queue.length} items from detection funnel.`);

        const dictionary = DictionaryService.get(wctx.stateDir);

        for (const text of queue) {
            const match = dictionary.match(text);
            if (match) {
                if (eventLog) {
                    eventLog.recordRuleMatch(undefined, {
                        ruleId: match.ruleId,
                        layer: 'L2',
                        severity: match.severity,
                        textPreview: text.substring(0, 100)
                    });
                }
            } else {
                // L3 semantic search via trajectory database FTS5 (MEM-04)
                if (wctx.trajectory) {
                    const searchResults = wctx.trajectory.searchPainEvents(text, 5);
                    if (searchResults.length > 0) {
                        // Found similar pain events - record as L3 semantic hit
                        if (eventLog) {
                            eventLog.recordRuleMatch(undefined, {
                                ruleId: 'l3_semantic',
                                layer: 'L3',
                                severity: searchResults[0].score,
                                textPreview: text.substring(0, 100)
                            });
                        }
                        // Update detection funnel cache with L3 hit result
                        funnel.updateCache(text, { detected: true, severity: searchResults[0].score });
                        // Don't track as candidate - this is a confirmed L3 hit
                        if (logger) logger.info(`[PD:EvolutionWorker] L3 semantic hit: found ${searchResults.length} similar pain events for "${text.substring(0, 50)}..."`);
                        continue;
                    }
                }
                // No L3 hit — pain candidate tracking removed (D-05)
            }
        }
    } catch (err) {
        if (logger) logger.warn(`[PD:EvolutionWorker] Detection queue failed: ${String(err)}`);
    }
}

// PAIN_CANDIDATES system removed (D-05, D-06): trackPainCandidate and processPromotion deleted
// Evolution queue is now the single active pain→principle path

/* eslint-disable no-unused-vars, @typescript-eslint/max-params -- Reason: type-level function parameter names in logger union type and unused workspaceResolve key are documentation/signature */
export async function registerEvolutionTaskSession(
    workspaceResolve: (key: string) => string,
    taskId: string,
    sessionKey: string,
    logger?: { warn?: (message: string) => void; info?: (message: string) => void }
): Promise<boolean> {
    const queuePath = workspaceResolve('EVOLUTION_QUEUE');
    if (!fs.existsSync(queuePath)) return false;

    const releaseLock = await requireQueueLock(queuePath, logger, 'registerEvolutionTaskSession');

    try {
        // eslint-disable-next-line @typescript-eslint/init-declarations -- assigned in try, catch has early return
        let rawQueue: RawQueueItem[];
        try {
            rawQueue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
        } catch (parseErr) {
            logger?.warn?.(`[PD:EvolutionWorker] Failed to parse EVOLUTION_QUEUE for session registration: ${queuePath} - ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
            return false;
        }
        
        // V2: Migrate queue to current schema
        const queue: EvolutionQueueItem[] = migrateQueueToV2(rawQueue);
        
        const task = queue.find((item) => item.id === taskId && item.status === 'in_progress');
        if (!task) {
            logger?.warn?.(`[PD:EvolutionWorker] Could not find in-progress evolution task ${taskId} for session assignment`);
            return false;
        }

        task.assigned_session_key = sessionKey;
        if (!task.started_at) {
            task.started_at = new Date().toISOString();
        }
        fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
        return true;
    } finally {
        releaseLock();
    }
}

/**
 * Evolution Worker - Background service for pain processing and evolution task management.
 *
 * IMPORTANT: evolution_directive.json is a COMPATIBILITY-ONLY DISPLAY ARTIFACT.
 * This service does NOT read or use directive for Phase 3 eligibility or any decisions.
 * Queue (EVOLUTION_QUEUE) is the only authoritative execution truth source.
 *
 * Directive exists solely for UI/backwards compatibility display purposes.
 * Production evidence shows directive stopped updating on 2026-03-22 and is stale.
 */

/* eslint-disable no-unused-vars -- Reason: interface method parameters are type signatures */
export interface ExtendedEvolutionWorkerService {
    id: string;
    api: OpenClawPluginApi | null;
    start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
    stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
}
/* eslint-enable no-unused-vars */

interface WorkerStatusReport {
    timestamp: string;
    cycle_start_ms: number;
    duration_ms: number;
    pain_flag: { exists: boolean; score: number | null; source: string | null; enqueued: boolean; skipped_reason: string | null };
    queue: { total: number; pending: number; in_progress: number; completed_this_cycle: number; failed_this_cycle: number };
    errors: string[];
}

function writeWorkerStatus(stateDir: string, report: WorkerStatusReport): void {
    try {
        const statusPath = path.join(stateDir, 'worker-status.json');
        fs.writeFileSync(statusPath, JSON.stringify(report, null, 2), 'utf8');
    } catch (err) {
        // Non-critical: worker-status.json is for monitoring, not core logic
        console.warn(`[PD:EvolutionWorker] Failed to write worker-status.json: ${String(err)}`);
    }
}

/* eslint-disable @typescript-eslint/max-params -- Reason: Function requires all parameters for queue processing */
async function processEvolutionQueueWithResult(
    wctx: WorkspaceContext,
    logger: PluginLogger,
    eventLog: EventLog,
    api?: OpenClawPluginApi | undefined
): Promise<{ queue: WorkerStatusReport['queue']; errors: string[] }> {
    const queueResult: WorkerStatusReport['queue'] = { total: 0, pending: 0, in_progress: 0, completed_this_cycle: 0, failed_this_cycle: 0 };
    const errors: string[] = [];

    try {
        const queuePath = wctx.resolve('EVOLUTION_QUEUE');
        if (!fs.existsSync(queuePath)) {
            return { queue: queueResult, errors };
        }

        const queue: EvolutionQueueItem[] = JSON.parse(fs.readFileSync(queuePath, 'utf8')) as EvolutionQueueItem[];

        // Purge stale failed tasks before processing (keeps queue lean)
        const purgeResult = purgeStaleFailedTasks(queue, logger);
        if (purgeResult.purged > 0) {
            // Write back the cleaned queue
            fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
        }

        queueResult.total = queue.length;
        queueResult.pending = queue.filter((t) => t.status === 'pending').length;
        queueResult.in_progress = queue.filter((t) => t.status === 'in_progress').length;
        queueResult.failed_this_cycle = queue.filter((t) => t.status === 'failed').length;
        queueResult.completed_this_cycle = queue.filter((t) => t.status === 'completed').length;

        // Log queue health snapshot every cycle
        logger.info(`[PD:EvolutionWorker] Queue snapshot: total=${queueResult.total} pending=${queueResult.pending} in_progress=${queueResult.in_progress} completed=${queueResult.completed_this_cycle} failed=${queueResult.failed_this_cycle} purged=${purgeResult.purged}`);

        await processEvolutionQueue(wctx, logger, eventLog, api);
    } catch (err) {
        const errMsg = `processEvolutionQueue failed: ${String(err)}`;
        errors.push(errMsg);
        logger.error(`[PD:EvolutionWorker] ${errMsg}`);
    }

    return { queue: queueResult, errors };
}

export const EvolutionWorkerService: ExtendedEvolutionWorkerService = {
    id: 'principles-evolution-worker',
    api: null,

    start(ctx: OpenClawPluginServiceContext): void {
        const logger = ctx?.logger || console;
        const {api} = this;
        const workspaceDir = ctx?.workspaceDir;

        if (!workspaceDir) {
            if (logger) logger.warn('[PD:EvolutionWorker] workspaceDir not found in service config. Evolution cycle disabled.');
            return;
        }

        const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });
        if (logger) logger.info(`[PD:EvolutionWorker] Starting with workspaceDir=${wctx.workspaceDir}, stateDir=${wctx.stateDir}`);

        initPersistence(wctx.stateDir);
        const {eventLog} = wctx;

        const {config} = wctx;
        const language = config.get('language') || 'en';
        ensureStateTemplates({ logger }, wctx.stateDir, language);

        const initialDelay = 5000;
        const interval = config.get('intervals.worker_poll_ms') || (15 * 60 * 1000);

        async function runCycle(): Promise<void> {
            const cycleStart = Date.now();

            // ──── DEBUG: Verify subagent availability in heartbeat context ────
            const hbSubagent = api?.runtime?.subagent;
            logger?.info?.(`[PD:DEBUG:SubagentCheck:Heartbeat] api_exists=${!!api}, subagent_exists=${!!hbSubagent}, subagent.run_exists=${!!hbSubagent?.run}`);
            if (hbSubagent?.run) {
                logger?.info?.('[PD:DEBUG:SubagentCheck:Heartbeat] run entrypoint is callable');
            }
            const cycleResult: {
                timestamp: string;
                cycle_start_ms: number;
                duration_ms: number;
                pain_flag: { exists: boolean; score: number | null; source: string | null; enqueued: boolean; skipped_reason: string | null };
                queue: { total: number; pending: number; in_progress: number; completed_this_cycle: number; failed_this_cycle: number };
                errors: string[];
            } = {
                timestamp: new Date().toISOString(),
                cycle_start_ms: cycleStart,
                duration_ms: 0,
                pain_flag: { exists: false, score: null, source: null, enqueued: false, skipped_reason: null },
                queue: { total: 0, pending: 0, in_progress: 0, completed_this_cycle: 0, failed_this_cycle: 0 },
                errors: [],
            };

            try {
                const idleResult = checkWorkspaceIdle(wctx.workspaceDir, {});
                logger?.info?.(`[PD:EvolutionWorker] HEARTBEAT cycle=${new Date().toISOString()} idle=${idleResult.isIdle} idleForMs=${idleResult.idleForMs} userActiveSessions=${idleResult.userActiveSessions} abandonedSessions=${idleResult.abandonedSessionIds.length} lastActivityEpoch=${idleResult.mostRecentActivityAt}`);
                if (idleResult.isIdle) {
                    logger?.debug?.(`[PD:EvolutionWorker] Workspace idle (${idleResult.idleForMs}ms since last activity)`);
                    const cooldown = checkCooldown(wctx.stateDir);
                    if (!cooldown.globalCooldownActive && !cooldown.quotaExhausted) {
                        enqueueSleepReflectionTask(wctx, logger).catch((err) => {
                            logger?.error?.(`[PD:EvolutionWorker] Failed to enqueue sleep_reflection task: ${String(err)}`);
                        });
                    }
                } else {
                    logger?.debug?.(`[PD:EvolutionWorker] Workspace active (last activity ${idleResult.idleForMs}ms ago)`);
                }

                const painCheckResult = await checkPainFlag(wctx, logger);
                cycleResult.pain_flag = painCheckResult;

                const queueResult = await processEvolutionQueueWithResult(wctx, logger, eventLog, api ?? undefined);
                cycleResult.queue = queueResult.queue;
                if (queueResult.errors) cycleResult.errors.push(...queueResult.errors);

                // If pain flag was enqueued AND processEvolutionQueue wrote HEARTBEAT.md
                // with a diagnostician task, immediately trigger a heartbeat to start
                // the diagnostician without waiting for the next 15-minute interval.
                // Must run AFTER processEvolutionQueue — HEARTBEAT.md must be written first.
                if (painCheckResult.enqueued) {
                    const canTrigger = !!api?.runtime?.system?.runHeartbeatOnce;
                    logger.info(`[PD:EvolutionWorker] Pain flag enqueued — runHeartbeatOnce available: ${canTrigger} (api=${!!api}, runtime=${!!api?.runtime}, system=${!!api?.runtime?.system})`);
                    if (canTrigger) {
                        try {
                            const hbResult = await api.runtime.system.runHeartbeatOnce({
                                reason: `pd-pain-diagnosis: pain flag detected, starting diagnostician`,
                            });
                            logger.info(`[PD:EvolutionWorker] Immediate heartbeat result: status=${hbResult.status}${hbResult.status === 'ran' ? ` duration=${hbResult.durationMs}ms` : ''}${hbResult.status === 'skipped' || hbResult.status === 'failed' ? ` reason=${hbResult.reason}` : ''}`);
                            if (hbResult.status === 'skipped' || hbResult.status === 'failed') {
                                logger.warn(`[PD:EvolutionWorker] Immediate heartbeat was ${hbResult.status} (${hbResult.reason}). Diagnostician will start on next regular heartbeat cycle.`);
                            }
                        } catch (hbErr) {
                            logger.warn(`[PD:EvolutionWorker] Failed to trigger immediate heartbeat: ${String(hbErr)}. Diagnostician will start on next regular heartbeat cycle.`);
                        }
                    } else {
                        logger.warn(`[PD:EvolutionWorker] runHeartbeatOnce not available. Diagnostician will start on next regular heartbeat cycle.`);
                    }
                }

                if (api) {
                    await processDetectionQueue(wctx, api, eventLog);
                }
                // processPromotion removed (D-06) — promotion via PAIN_CANDIDATES no longer needed

                try {
                    // Delegate to workflow managers' sweepExpiredWorkflows so that
                    // session/transcript cleanup runs via driver.deleteSession().
                    const subagentRuntime = api?.runtime?.subagent;
                    const agentSession = api?.runtime?.agent?.session;
                    if (subagentRuntime) {
                        const empathyMgr = new EmpathyObserverWorkflowManager({
                            workspaceDir: wctx.workspaceDir,
                            logger: api.logger,
                            subagent: subagentRuntime,
                            agentSession,
                        });
                        let swept = 0;
                        try {
                            swept += await empathyMgr.sweepExpiredWorkflows(WORKFLOW_TTL_MS);
                        } finally {
                            empathyMgr.dispose();
                        }

                        const deepReflectMgr = new DeepReflectWorkflowManager({
                            workspaceDir: wctx.workspaceDir,
                            logger: api.logger,
                            subagent: subagentRuntime,
                            agentSession,
                        });
                        try {
                            swept += await deepReflectMgr.sweepExpiredWorkflows(WORKFLOW_TTL_MS);
                        } finally {
                            deepReflectMgr.dispose();
                        }

                        // #183 + #188: Sweep Nocturnal workflows too (with gateway-safe fallback)
                        try {
                            const nocturnalMgr = new NocturnalWorkflowManager({
                                workspaceDir: wctx.workspaceDir,
                                stateDir: wctx.stateDir,
                                logger: api.logger,
                                runtimeAdapter: new OpenClawTrinityRuntimeAdapter(api),
                            });
                            swept += await nocturnalMgr.sweepExpiredWorkflows(WORKFLOW_TTL_MS, subagentRuntime, agentSession);
                            nocturnalMgr.dispose();
                        } catch (noctSweepErr) {
                            logger?.warn?.(`[PD:EvolutionWorker] Nocturnal sweep failed: ${String(noctSweepErr)}`);
                        }

                        if (swept > 0) {
                            logger?.info?.(`[PD:EvolutionWorker] Swept ${swept} expired workflows (with session cleanup)`);
                        }
                    } else {
                        // Fallback: if subagent runtime unavailable, mark as expired
                        // but log that session cleanup was skipped.
                        const workflowStore = new WorkflowStore({ workspaceDir: wctx.workspaceDir });
                        const expiredWorkflows = workflowStore.getExpiredWorkflows(WORKFLOW_TTL_MS);
                        for (const wf of expiredWorkflows) {
                            workflowStore.updateWorkflowState(wf.workflow_id, 'expired');
                            workflowStore.updateCleanupState(wf.workflow_id, 'failed');
                            workflowStore.recordEvent(wf.workflow_id, 'swept', wf.state, 'expired', 'TTL expired (no runtime for session cleanup)', {});
                            logger?.warn?.(`[PD:EvolutionWorker] Marked workflow ${wf.workflow_id} as expired but could not cleanup session (subagent runtime unavailable)`);
                        }
                        workflowStore.dispose();
                    }
                } catch (sweepErr) {
                    const errMsg = `Failed to sweep expired workflows: ${String(sweepErr)}`;
                    cycleResult.errors.push(errMsg);
                    logger?.warn?.(`[PD:EvolutionWorker] ${errMsg}`);
                }

                // ── Workflow Watchdog: detect stale active workflows ──
                // This catches bugs like #185 (orphaned active), #181 (empty results),
                // #180/#183 (expired without cleanup), #182 (unhandled rejection).
                try {
                    const watchdogResult = await runWorkflowWatchdog(wctx, api, logger);
                    if (watchdogResult.anomalies > 0) {
                        logger?.warn?.(`[PD:Watchdog] ${watchdogResult.anomalies} anomalies: ${watchdogResult.details.join('; ')}`);
                        cycleResult.errors.push(...watchdogResult.details);
                    }
                } catch (watchdogErr) {
                    logger?.warn?.(`[PD:Watchdog] Watchdog failed: ${String(watchdogErr)}`);
                }

                wctx.dictionary.flush();
                flushAllSessions();

                cycleResult.duration_ms = Date.now() - cycleStart;
                writeWorkerStatus(wctx.stateDir, cycleResult);
            } catch (err) {
                const errMsg = `Error in worker interval: ${String(err)}`;
                if (logger) logger.error(`[PD:EvolutionWorker] ${errMsg}`);
                writeWorkerStatus(wctx.stateDir, {
                    timestamp: new Date().toISOString(),
                    cycle_start_ms: cycleStart,
                    duration_ms: Date.now() - cycleStart,
                    pain_flag: { exists: false, score: null, source: null, enqueued: false, skipped_reason: null },
                    queue: { total: 0, pending: 0, in_progress: 0, completed_this_cycle: 0, failed_this_cycle: 0 },
                    errors: [errMsg],
                });
            }

            timeoutId = setTimeout(runCycle, interval);
        }

        timeoutId = setTimeout(() => {
            void (async () => {
                await checkPainFlag(wctx, logger);
                // Use the same pipeline as regular cycles (includes purge + observability)
                const queueResult = await processEvolutionQueueWithResult(wctx, logger, eventLog, api ?? undefined);
                if (queueResult.errors.length > 0) {
                    queueResult.errors.forEach((e) => logger?.error?.(`[PD:EvolutionWorker] Startup cycle error: ${e}`));
                }
                if (api) {
                    await processDetectionQueue(wctx, api, eventLog);
                }
                // processPromotion removed (D-06)
                timeoutId = setTimeout(runCycle, interval);
            })().catch((err) => {
                if (logger) logger.error(`[PD:EvolutionWorker] Startup worker cycle failed: ${String(err)}`);
                timeoutId = setTimeout(runCycle, interval);
            });
        }, initialDelay);
    },

    stop(ctx: OpenClawPluginServiceContext): void {
        if (ctx?.logger) ctx.logger.info('[PD:EvolutionWorker] Stopping background service...');
        if (timeoutId) clearTimeout(timeoutId);
        flushAllSessions();
    }
};
