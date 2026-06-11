/**
 * Internalization Dumb Trigger Adapter (PRI-63)
 *
 * Thin adapter that wakes periodically to probe SQLite for ready
 * internalization tasks. Plugin layer only — does NOT execute LLM calls,
 * does NOT directly chain PeerRunners, does NOT modify task status.
 *
 * Core decision functions (validateInternalizationTaskReady) determine
 * if a task is ready to be processed. This adapter is only responsible
 * for waking and logging — actual dispatch is handled by future
 * Orchestrator PRI.
 *
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 * @see packages/principles-core/src/runtime-v2/internalization/internalization-state-machine.ts (PRI-62)
 */

import type { TaskRecord } from '@principles/core/runtime-v2';

import {
  validateInternalizationTaskReady,
  isRunnerKind,
  hydratePITaskRecord,
  type PITaskRecord,
  type RunnerKind,
} from '@principles/core/runtime-v2';

// ── Structured log event types ───────────────────────────────────────────────

type TriggerWakeEvent = {
  event: 'INTERNALIZATION_TRIGGER_WAKE';
  workspaceDir: string;
  taskId: string;
  taskKind: RunnerKind;
  correlationId?: string;
  gateDecision: 'proceed';
  timestamp: string;
};

type TriggerNoopEvent = {
  event: 'INTERNALIZATION_TRIGGER_NOOP';
  workspaceDir: string;
  timestamp: string;
};

type TriggerBlockedEvent = {
  event: 'INTERNALIZATION_TRIGGER_BLOCKED';
  workspaceDir: string;
  taskId: string;
  taskKind: string;
  gateDecision: 'blocked' | 'dependency_failed' | 'retry_wait_pending';
  blockedBy?: string[];
  failedDependencies?: string[];
  retryAfter?: string;
  timestamp: string;
};

type TriggerFailedEvent = {
  event: 'INTERNALIZATION_TRIGGER_FAILED';
  workspaceDir: string;
  failureCategory: 'invalid_context' | 'provider_error' | 'unexpected_error';
  error?: string;
  timestamp: string;
};

type LogEvent = TriggerWakeEvent | TriggerNoopEvent | TriggerFailedEvent | TriggerBlockedEvent;

// ── Logger interface ─────────────────────────────────────────────────────────

export interface TriggerLogger {
  debug?(msg: string, meta?: Record<string, unknown>): void;
  info?(msg: string, meta?: Record<string, unknown>): void;
  warn?(msg: string, meta?: Record<string, unknown>): void;
  error?(msg: string, meta?: Record<string, unknown>): void;
}

// ── Task provider interface (dependency injection for testability) ───────────

export interface InternalizationTaskProvider {
  listTasks(filter?: { status?: string; taskKind?: string }): Promise<TaskRecord[]>;
  getTask(taskId: string): Promise<TaskRecord | null>;
}

// ── Wake context ──────────────────────────────────────────────────────────────

export interface TriggerContext {
  workspaceDir: string;
  stateDir: string;
}

// ── Adapter interface ─────────────────────────────────────────────────────────

export interface InternalizationTriggerAdapter {
  wake(ctx: TriggerContext): Promise<void>;
  start(ctx: TriggerContext, intervalMs?: number): () => void;
  stop(): void;
}

// ── Internal state ─────────────────────────────────────────────────────────────

interface AdapterState {
  intervalId: ReturnType<typeof setInterval> | null;
}

// ── Log helper ────────────────────────────────────────────────────────────────

function emitLog(
  logger: TriggerLogger | undefined,
  event: LogEvent,
): void {
  const { event: eventType, ...meta } = event;

  switch (eventType) {
    case 'INTERNALIZATION_TRIGGER_WAKE':
      logger?.info?.('[PD:InternalizationTrigger] INTERNALIZATION_TRIGGER_WAKE', meta);
      break;
    case 'INTERNALIZATION_TRIGGER_NOOP':
      logger?.debug?.('[PD:InternalizationTrigger] INTERNALIZATION_TRIGGER_NOOP', meta);
      break;
    case 'INTERNALIZATION_TRIGGER_BLOCKED':
      logger?.debug?.('[PD:InternalizationTrigger] INTERNALIZATION_TRIGGER_BLOCKED', meta);
      break;
    case 'INTERNALIZATION_TRIGGER_FAILED':
      logger?.error?.('[PD:InternalizationTrigger] INTERNALIZATION_TRIGGER_FAILED', meta);
      break;
  }
}

// ── Core adapter factory ───────────────────────────────────────────────────────

/**
 * Creates a dumb trigger adapter that probes for ready internalization tasks.
 *
 * Design constraints (enforced by architecture regression guards):
 * - PLUGIN_NO_INLINE_EXECUTION: wake() is read-only, does not await long tasks
 * - PEER_NO_DIRECT_CHAINING: adapter does not call Dreamer/Philosopher/Scribe
 * - TASK_MODEL_REUSE: reuses PITaskRecord / TaskRecord, no second task model
 *
 * @param provider - Task data access abstraction (SqliteTaskStore in production)
 * @param logger - Optional structured logger
 */
export function createInternalizationTrigger(
  provider: InternalizationTaskProvider,
  logger?: TriggerLogger,
): InternalizationTriggerAdapter {
  const state: AdapterState = {
    intervalId: null,
  };

  // ── wake: single trigger cycle ─────────────────────────────────────────────

  async function wake(ctx: TriggerContext): Promise<void> {
    // Fail closed: missing workspaceDir or stateDir
    if (!ctx.workspaceDir || !ctx.stateDir) {
      emitLog(logger, {
        event: 'INTERNALIZATION_TRIGGER_FAILED',
        workspaceDir: ctx.workspaceDir ?? '(missing)',
        failureCategory: 'invalid_context',
        error: 'workspaceDir or stateDir is missing',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      // Query pending and retry_wait tasks (non-terminal states that can be leased)
      const pendingTasks = await provider.listTasks({ status: 'pending' });
      const retryWaitTasks = await provider.listTasks({ status: 'retry_wait' });

      // Filter to only PeerRunner tasks, then hydrate PI metadata from diagnosticJson.
      // Tasks without valid PI metadata in diagnosticJson return null and are filtered out.
      const pendingPITasks = pendingTasks
        .filter(t => isRunnerKind(t.taskKind))
        .map(t => hydratePITaskRecord(t))
        .filter((t): t is PITaskRecord => t !== null);

      const retryWaitPITasks = retryWaitTasks
        .filter(t => isRunnerKind(t.taskKind))
        .map(t => hydratePITaskRecord(t))
        .filter((t): t is PITaskRecord => t !== null);

      const candidateTasks = [...pendingPITasks, ...retryWaitPITasks];

      // No candidates → NOOP
      if (candidateTasks.length === 0) {
        emitLog(logger, {
          event: 'INTERNALIZATION_TRIGGER_NOOP',
          workspaceDir: ctx.workspaceDir,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Evaluate each candidate
      let hasReadyTask = false;

      for (const task of candidateTasks) {
        // Fetch dependency tasks for gate validation
        const dependencies: TaskRecord[] = [];
        if (task.dependencyTaskIds && task.dependencyTaskIds.length > 0) {
          for (const depId of task.dependencyTaskIds) {
            const dep = await provider.getTask(depId);
            if (dep) dependencies.push(dep);
            // Fail closed: if dep not found, dependencies array is incomplete
            // validateInternalizationTaskReady will return 'blocked'
          }
        }

        const gateResult = validateInternalizationTaskReady(task, dependencies);

        if (gateResult.decision === 'proceed') {
          // Task is ready — log WAKE event (read-only, no mutation)
          emitLog(logger, {
            event: 'INTERNALIZATION_TRIGGER_WAKE',
            workspaceDir: ctx.workspaceDir,
            taskId: task.taskId,
            taskKind: task.taskKind,
            correlationId: task.correlationId,
            gateDecision: gateResult.decision,
            timestamp: new Date().toISOString(),
          });
          hasReadyTask = true;
        } else {
          // blocked, dependency_failed, or retry_wait_pending — debug visibility for operators
          emitLog(logger, {
            event: 'INTERNALIZATION_TRIGGER_BLOCKED',
            workspaceDir: ctx.workspaceDir,
            taskId: task.taskId,
            taskKind: task.taskKind,
            gateDecision: gateResult.decision,
            blockedBy: gateResult.decision === 'blocked' ? gateResult.blockedBy : undefined,
            failedDependencies: gateResult.decision === 'dependency_failed' ? gateResult.failedDependencies : undefined,
            retryAfter: gateResult.decision === 'retry_wait_pending' ? gateResult.retryAfter : undefined,
            timestamp: new Date().toISOString(),
          });
        }
      }

      // All candidates were blocked
      if (!hasReadyTask) {
        emitLog(logger, {
          event: 'INTERNALIZATION_TRIGGER_NOOP',
          workspaceDir: ctx.workspaceDir,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      emitLog(logger, {
        event: 'INTERNALIZATION_TRIGGER_FAILED',
        workspaceDir: ctx.workspaceDir,
        failureCategory: 'provider_error',
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ── start: begin periodic wake cycles ─────────────────────────────────────

  function start(ctx: TriggerContext, intervalMs = 5 * 60 * 1000): () => void {
    // Prevent re-entrancy: if already running, warn and return existing stop
    if (state.intervalId !== null) {
      logger?.warn?.('[PD:InternalizationTrigger] start() called while already running — returning existing stop', {
        workspaceDir: ctx.workspaceDir,
        stateDir: ctx.stateDir,
      });
      return stop;
    }

    // Immediate first wake
    wake(ctx).catch(err => {
      logger?.error?.('[PD:InternalizationTrigger] start() initial wake failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Schedule periodic wake
    state.intervalId = setInterval(() => {
      wake(ctx).catch(err => {
        logger?.error?.('[PD:InternalizationTrigger] periodic wake failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, intervalMs);

    return stop;
  }

  // ── stop: halt periodic wake ──────────────────────────────────────────────

  function stop(): void {
    if (state.intervalId !== null) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }
  }

  return { wake, start, stop };
}

// ── Re-export types for consumers ────────────────────────────────────────────

export type { PITaskRecord, RunnerKind } from '@principles/core/runtime-v2';