/**
 * Internalization State Machine (PRI-62)
 *
 * Pure decision functions for the Internalization Engine state machine.
 * These functions return structured proposals — they do NOT mutate store state,
 * do NOT call PDRuntimeAdapter, and do NOT execute createTask.
 *
 * Orchestrator (future PRI-62 scope) is responsible for consuming these
 * decisions and invoking RuntimeStateManager to apply transitions.
 *
 * Key design:
 *   - Guard functions (task-guards.ts) validate individual conditions
 *   - State machine functions compose guards into actionable decisions
 *   - All functions are pure: same inputs → same outputs, no side effects
 *
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 */

import type { PDTaskStatus, TaskRecord } from '../task-status.js';
import type {
  PITaskRecord,
  PeerRunnerKind,
  RunnerKind,
  InternalizationChannel,
  PIArtifact,
  ArtifactRef,
} from './peer-runner-contracts.js';
import { isPeerRunnerKind, isDiagnosticianStageKind } from './peer-runner-contracts.js';
import { getAllowedSuccessors, isAcyclic, validateEdge, validateDiagEdge } from './internalization-job-graph.js';

import {
  canAcquireLease,
  canTransitionTo,
  canRetryNow,
  isUnresolvable,
} from './internalization-task-guards.js';

// ── Dependency Gate Types ─────────────────────────────────────────────────────

/**
 * Decision when evaluating if a task is ready to execute.
 *
 *   proceed:            All conditions met — task can be leased and executed
 *   blocked:            Dependencies not yet satisfied — wait for them
 *   dependency_failed:   At least one dependency has failed — escalate policy needed
 */
export type DependencyGateDecision = 'proceed' | 'blocked' | 'dependency_failed' | 'retry_wait_pending';

export interface DependencyGateResult {
  decision: DependencyGateDecision;
  /** Whether the task is ready to execute (same as decision === 'proceed') */
  ready: boolean;
  /** Task IDs that are blocking execution (status != succeeded) */
  blockedBy: string[];
  /** Task IDs that have failed — for escalation policy decision */
  failedDependencies: string[];
  /** For retry_wait_pending: ISO timestamp when the task can be retried */
  retryAfter?: string;
}

// ── Transition Validation Types ───────────────────────────────────────────────

export interface TransitionValidation {
  valid: boolean;
  /** Human-readable reason if invalid */
  reason?: string;
}

// ── Rejection Feedback Types ─────────────────────────────────────────────────

/**
 * Action to take when an artifact has been rejected.
 *
 *   create_corrective_task: Re-run the same or corrective runner kind
 *   escalate:               Human review needed
 */
export type RejectionFeedbackAction = 'create_corrective_task' | 'escalate';

/**
 * Discriminated union for artifact rejection feedback.
 *
 * create_corrective_task: correctiveTaskKind is required
 * escalate: correctiveTaskKind is absent
 */
export type RejectionFeedbackResult =
  | {
      action: 'create_corrective_task';
      correctiveTaskKind: PeerRunnerKind;
      rejectedArtifactId: string;
      sourceTaskId: string;
      sourceTaskKind: PeerRunnerKind;
      rejectionReason?: string;
    }
  | {
      action: 'escalate';
      rejectedArtifactId: string;
      sourceTaskId: string;
      sourceTaskKind: PeerRunnerKind;
      rejectionReason?: string;
    };

// ── Next Task Proposal Types ─────────────────────────────────────────────────

export interface NextTaskProposal {
  taskKind: RunnerKind;
  parentTaskId: string;
  dependencyTaskIds: string[];
  inputArtifactRefs: ArtifactRef[];
  channel: InternalizationChannel;
  correlationId?: string;
}

// ── Graph Validation Types ───────────────────────────────────────────────────

export type GraphErrorType = 'cycle' | 'disallowed_edge' | 'missing_dependency';

export interface GraphValidationError {
  type: GraphErrorType;
  message: string;
  taskId?: string;
  fromKind?: string;
  toKind?: string;
}

export interface GraphValidationResult {
  valid: boolean;
  errors: GraphValidationError[];
}

// ── Core Decision Functions ──────────────────────────────────────────────────

/**
 * Validates whether a task is ready to be leased and executed.
 *
 * Combines:
 *   1. canAcquireLease — task status must be pending or retry_wait
 *   2. areDependenciesMet — all dependencyTaskIds must be succeeded
 *
 * Note: dependency failure (dependency_failed) does NOT automatically fail
 * the dependent task. The escalation policy (PRI-62 follow-up) decides
 * how to handle dependency failures.
 */
export function validateInternalizationTaskReady(
  task: PITaskRecord,
  dependencies: readonly TaskRecord[],
  nowMs?: number,
): DependencyGateResult {
  const blockedBy: string[] = [];
  const failedDependencies: string[] = [];

  // Check if task status allows leasing
  if (!canAcquireLease(task)) {
    // Task is already leased, succeeded, or failed — blocked
    return {
      decision: 'blocked',
      ready: false,
      blockedBy: [],
      failedDependencies: [],
    };
  }

  // Check if retry_wait backoff period has expired
  if (!canRetryNow(task, nowMs)) {
    return {
      decision: 'retry_wait_pending',
      ready: false,
      blockedBy: [],
      failedDependencies: [],
      retryAfter: task.leaseExpiresAt,
    };
  }

  // Collect dependency statuses
  const depMap = new Map(dependencies.map(d => [d.taskId, d]));

  for (const depId of task.dependencyTaskIds) {
    const dep = depMap.get(depId);
    if (!dep) {
      // Dependency not found — fail closed
      blockedBy.push(depId);
    } else if (dep.status === 'succeeded') {
      // OK
    } else if (dep.status === 'failed') {
      failedDependencies.push(depId);
    } else {
      blockedBy.push(depId);
    }
  }

  // Determine decision
  if (failedDependencies.length > 0) {
    return {
      decision: 'dependency_failed',
      ready: false,
      blockedBy,
      failedDependencies,
    };
  }

  if (blockedBy.length > 0) {
    return {
      decision: 'blocked',
      ready: false,
      blockedBy,
      failedDependencies: [],
    };
  }

  return {
    decision: 'proceed',
    ready: true,
    blockedBy: [],
    failedDependencies: [],
  };
}

/**
 * Validates whether a task status transition is permitted.
 *
 * Uses canTransitionTo internally and adds human-readable reasons
 * for invalid transitions.
 */
export function validateTaskTransition(
  task: PITaskRecord,
  newStatus: PDTaskStatus,
): TransitionValidation {
  if (canTransitionTo(task.status, newStatus)) {
    return { valid: true };
  }

  const reason = ((): string => {
    if (task.status === 'succeeded' || task.status === 'failed') {
      return `Terminal state: ${task.status} cannot transition to ${newStatus}`;
    }
    if (newStatus === 'succeeded' && task.status !== 'leased') {
      return `Cannot transition directly to succeeded: task must be leased first (currently ${task.status})`;
    }
    if (task.status === 'pending' && newStatus !== 'leased') {
      return `Pending task can only transition to leased (not ${newStatus})`;
    }
    return `Invalid transition from ${task.status} to ${newStatus}`;
  })();

  return { valid: false, reason };
}

/**
 * Decides what action to take when an artifact has been rejected.
 *
 * Per ADR-0003 Section 3.7 rejection feedback loop:
 *   - Artifact rejected ≠ task failed (they are separate concerns)
 *   - Rejected artifacts can generate corrective task proposals
 *   - Scribe/Artificer rejections → corrective task (re-run)
 *   - Other runners → escalate for human review
 *
 * This function returns a proposal; the Orchestrator decides whether
 * to act on it.
 */
export function decideArtifactRejectionFeedback(
  artifact: PIArtifact,
  task: PITaskRecord,
): RejectionFeedbackResult {
  // Only peer runner tasks have artifact rejection feedback.
  // Diagnostician stage tasks should not reach this path — if they do,
  // escalate with an explicit reason rather than fabricating a PeerRunnerKind.
  if (!isPeerRunnerKind(task.taskKind)) {
    return {
      action: 'escalate',
      rejectedArtifactId: artifact.artifactId,
      sourceTaskId: artifact.sourceTaskId,
      sourceTaskKind: 'dreamer', // sentinel — diagnostician tasks must not reach here; caller must guard
      rejectionReason: `unexpected_diagnostician_taskKind:${task.taskKind}`,
    };
  }

  const base = {
    rejectedArtifactId: artifact.artifactId,
    sourceTaskId: artifact.sourceTaskId,
    sourceTaskKind: task.taskKind,
  };

  if (isUnresolvable(task)) {
    return {
      ...base,
      action: 'escalate',
      rejectionReason: 'unresolvable_threshold_exceeded',
    };
  }

  if (task.taskKind === 'scribe') {
    return {
      ...base,
      action: 'create_corrective_task',
      correctiveTaskKind: 'scribe',
    };
  }

  if (task.taskKind === 'artificer') {
    return {
      ...base,
      action: 'create_corrective_task',
      correctiveTaskKind: 'artificer',
    };
  }

  return {
    ...base,
    action: 'escalate',
  };
}

/**
 * Proposes the next task in the pipeline after a task succeeds.
 *
 * Uses the job graph (getAllowedSuccessors) to determine valid next steps:
 *   - dreamer → philosopher
 *   - philosopher → scribe
 *   - scribe → artificer
 *   - artificer → evaluator
 *   - evaluator → rollout_reviewer
 *
 * rollout_reviewer is the v1 terminal peer runner; the trainer/model_training
 * surface was removed in PRI-449 (MVP-Gone).
 *
 * Requires currentTask.status === 'succeeded' — non-terminal tasks
 * must not generate successor proposals (prevents pipeline乱序).
 *
 * Filters successors by channel constraint: a runner kind transition
 * is only valid when validateEdge(fromKind, toKind, channel) is true.
 *
 * Returns null if the task is not succeeded or no channel-valid
 * successors exist.
 */
export function createNextTaskProposal(
  currentTask: PITaskRecord,
  _artifacts: PIArtifact[],
  channel?: InternalizationChannel,
): NextTaskProposal | null {
  if (currentTask.status !== 'succeeded') {
    return null;
  }

  if (isUnresolvable(currentTask)) {
    return null;
  }

  // Diagnostician chain tasks are handled by the orchestrator via getDiagSuccessors,
  // not by this function which uses the peer runner job graph.
  if (!isPeerRunnerKind(currentTask.taskKind)) {
    return null;
  }

  // After the guard, currentTask.taskKind is narrowed to PeerRunnerKind
  const { taskKind } = currentTask;
  const effectiveChannel = channel ?? currentTask.channel;
  const successors = getAllowedSuccessors(taskKind);

  // Filter to only channel-valid successors (M1: gate by job graph + channel policy)
  const validSuccessors = successors.filter(s =>
    validateEdge(taskKind, s, effectiveChannel),
  );

  if (validSuccessors.length === 0) {
    return null;
  }

  // V1: take the first valid successor (linear chain)
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const nextKind = validSuccessors[0]!;

  return {
    taskKind: nextKind,
    parentTaskId: currentTask.taskId,
    dependencyTaskIds: [currentTask.taskId],
    // Defensive copy: prevent caller from mutating source task outputArtifactRefs (M2)
    inputArtifactRefs: [...currentTask.outputArtifactRefs],
    channel: effectiveChannel,
    correlationId: currentTask.correlationId,
  };
}

/**
 * Validates an entire task graph for structural correctness.
 *
 * Checks:
 *   1. No cycles — uses isAcyclic() on extracted edges
 *   2. All edges are in ALLOWED_EDGES (via validateEdge)
 *   3. All dependencyTaskIds reference existing tasks (fail closed)
 *
 * Note: this does NOT check dependency status (use validateInternalizationTaskReady
 * for that) — only structural validity.
 */
export function validateInternalizationGraph(tasks: PITaskRecord[]): GraphValidationResult {
  const errors: GraphValidationError[] = [];
  const taskMap = new Map(tasks.map(t => [t.taskId, t]));

  // Build dependency edges for cycle detection
  const edgesForCycle: (readonly [string, string])[] = [];
  for (const task of tasks) {
    for (const depId of task.dependencyTaskIds) {
      const dep = taskMap.get(depId);
      if (dep) {
        edgesForCycle.push([depId, task.taskId]);
      }
    }
  }

  // Check 1: cycles (using isAcyclic on dependency edges)
  if (!isAcyclic(edgesForCycle)) {
    errors.push({
      type: 'cycle',
      message: 'Task graph contains a cycle — dependencies cannot be satisfied',
    });
  }

  // Check 2: disallowed edges (using validateEdge on runner kind transitions)
  for (const task of tasks) {
    for (const depId of task.dependencyTaskIds) {
      const dep = taskMap.get(depId);
      if (!dep) {
        errors.push({
          type: 'missing_dependency',
          message: `Task ${task.taskId} depends on ${depId} which does not exist in the graph`,
          taskId: task.taskId,
        });
        continue;
      }

      // Use the current task's channel for edge validation
      // Peer runner edges use validateEdge; diagnostician edges use validateDiagEdge
      let edgeValid: boolean;
      if (isDiagnosticianStageKind(dep.taskKind) && isDiagnosticianStageKind(task.taskKind)) {
        edgeValid = validateDiagEdge(dep.taskKind, task.taskKind);
      } else if (isPeerRunnerKind(dep.taskKind) && isPeerRunnerKind(task.taskKind)) {
        edgeValid = validateEdge(dep.taskKind, task.taskKind, task.channel);
      } else {
        // Cross-pipeline edge — not allowed
        edgeValid = false;
      }
      if (!edgeValid) {
        errors.push({
          type: 'disallowed_edge',
          message: `Disallowed edge: ${dep.taskKind} → ${task.taskKind}`,
          taskId: task.taskId,
          fromKind: dep.taskKind,
          toKind: task.taskKind,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
