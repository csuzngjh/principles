/**
 * Internalization State Machine Guards — Unit Tests (PRI-62)
 *
 * TDD: Tests written first to define the expected behavior of guard functions
 * and state-machine decision logic for the Internalization Engine.
 */
import { describe, it, expect } from 'vitest';
import type { TaskRecord } from '../task-status.js';
import type { PITaskRecord, LineageRef } from '../internalization/peer-runner-contracts.js';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// ── Test helpers ───────────────────────────────────────────────────────────────

function makePITask(overrides: Partial<PITaskRecord> = {}): PITaskRecord {
  const {
    taskId = 'test-task',
    taskKind = 'dreamer',
    status = 'pending',
    createdAt = new Date().toISOString(),
    updatedAt = new Date().toISOString(),
    attemptCount = 0,
    maxAttempts = 3,
    dependencyTaskIds = [],
    channel = 'prompt',
    timeoutMs = 60000,
    inputArtifactRefs = [],
    outputArtifactRefs = [],
  } = overrides;
  return {
    taskId,
    taskKind,
    status,
    createdAt,
    updatedAt,
    attemptCount,
    maxAttempts,
    dependencyTaskIds,
    channel,
    timeoutMs,
    inputArtifactRefs,
    outputArtifactRefs,
  } as PITaskRecord;
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const {
    taskId = 'dep-task',
    status = 'succeeded',
    createdAt = new Date().toISOString(),
    updatedAt = new Date().toISOString(),
    attemptCount = 0,
    maxAttempts = 3,
  } = overrides;
  return {
    taskId,
    status,
    createdAt,
    updatedAt,
    attemptCount,
    maxAttempts,
  } as TaskRecord;
}

// ── Architecture Guard Helpers ────────────────────────────────────────────────

function moduleHasNoInfraImports(modulePath: string): Promise<boolean> {
  const src = readFileSync(resolve(__dirname, '..', modulePath), 'utf-8');
  return Promise.resolve(
    !src.includes('node:fs') &&
    !src.includes('node:path') &&
    !src.includes('openclaw-plugin') &&
    !src.includes('node:cron')
  );
}

// ── canAcquireLease ───────────────────────────────────────────────────────────

describe('canAcquireLease', () => {
  it('pending task can be leased', async () => {
    const { canAcquireLease } = await import('../internalization/internalization-task-guards.js');
    expect(canAcquireLease(makePITask({ status: 'pending' }))).toBe(true);
  });

  it('retry_wait task can be leased (recovery allowed)', async () => {
    const { canAcquireLease } = await import('../internalization/internalization-task-guards.js');
    expect(canAcquireLease(makePITask({ status: 'retry_wait' }))).toBe(true);
  });

  it('leased task cannot be leased again', async () => {
    const { canAcquireLease } = await import('../internalization/internalization-task-guards.js');
    expect(canAcquireLease(makePITask({ status: 'leased' }))).toBe(false);
  });

  it('succeeded task cannot be leased (terminal)', async () => {
    const { canAcquireLease } = await import('../internalization/internalization-task-guards.js');
    expect(canAcquireLease(makePITask({ status: 'succeeded' }))).toBe(false);
  });

  it('failed task cannot be leased (terminal)', async () => {
    const { canAcquireLease } = await import('../internalization/internalization-task-guards.js');
    expect(canAcquireLease(makePITask({ status: 'failed' }))).toBe(false);
  });
});

// ── areDependenciesMet ────────────────────────────────────────────────────────

describe('areDependenciesMet', () => {
  it('empty dependencyTaskIds returns true', async () => {
    const { areDependenciesMet } = await import('../internalization/internalization-task-guards.js');
    expect(areDependenciesMet(makePITask({ dependencyTaskIds: [] }), [])).toBe(true);
  });

  it('all dependencies succeeded returns true', async () => {
    const { areDependenciesMet } = await import('../internalization/internalization-task-guards.js');
    const deps = [
      makeTask({ taskId: 'dep-1', status: 'succeeded' }),
      makeTask({ taskId: 'dep-2', status: 'succeeded' }),
    ];
    expect(areDependenciesMet(makePITask({ dependencyTaskIds: ['dep-1', 'dep-2'] }), deps)).toBe(true);
  });

  it('dependency still pending returns false', async () => {
    const { areDependenciesMet } = await import('../internalization/internalization-task-guards.js');
    const deps = [
      makeTask({ taskId: 'dep-1', status: 'succeeded' }),
      makeTask({ taskId: 'dep-2', status: 'pending' }),
    ];
    expect(areDependenciesMet(makePITask({ dependencyTaskIds: ['dep-1', 'dep-2'] }), deps)).toBe(false);
  });

  it('dependency failed returns false (fail closed)', async () => {
    const { areDependenciesMet } = await import('../internalization/internalization-task-guards.js');
    const deps = [
      makeTask({ taskId: 'dep-1', status: 'succeeded' }),
      makeTask({ taskId: 'dep-2', status: 'failed' }),
    ];
    expect(areDependenciesMet(makePITask({ dependencyTaskIds: ['dep-1', 'dep-2'] }), deps)).toBe(false);
  });

  it('dependency not found returns false (fail closed)', async () => {
    const { areDependenciesMet } = await import('../internalization/internalization-task-guards.js');
    const deps = [makeTask({ taskId: 'dep-1', status: 'succeeded' })];
    // dep-2 does not exist in deps array
    expect(areDependenciesMet(makePITask({ dependencyTaskIds: ['dep-1', 'dep-2'] }), deps)).toBe(false);
  });
});

// ── canTransitionTo ──────────────────────────────────────────────────────────

describe('canTransitionTo', () => {
  it('pending → leased is valid', async () => {
    const { canTransitionTo } = await import('../internalization/internalization-task-guards.js');
    expect(canTransitionTo('pending', 'leased')).toBe(true);
  });

  it('leased → succeeded is valid', async () => {
    const { canTransitionTo } = await import('../internalization/internalization-task-guards.js');
    expect(canTransitionTo('leased', 'succeeded')).toBe(true);
  });

  it('leased → retry_wait is valid', async () => {
    const { canTransitionTo } = await import('../internalization/internalization-task-guards.js');
    expect(canTransitionTo('leased', 'retry_wait')).toBe(true);
  });

  it('leased → failed is valid', async () => {
    const { canTransitionTo } = await import('../internalization/internalization-task-guards.js');
    expect(canTransitionTo('leased', 'failed')).toBe(true);
  });

  it('retry_wait → pending is valid (recovery sweep reset)', async () => {
    const { canTransitionTo } = await import('../internalization/internalization-task-guards.js');
    expect(canTransitionTo('retry_wait', 'pending')).toBe(true);
  });

  it('succeeded → any state is invalid (terminal)', async () => {
    const { canTransitionTo } = await import('../internalization/internalization-task-guards.js');
    expect(canTransitionTo('succeeded', 'pending')).toBe(false);
    expect(canTransitionTo('succeeded', 'leased')).toBe(false);
    expect(canTransitionTo('succeeded', 'retry_wait')).toBe(false);
    expect(canTransitionTo('succeeded', 'failed')).toBe(false);
  });

  it('failed → any state is invalid (terminal)', async () => {
    const { canTransitionTo } = await import('../internalization/internalization-task-guards.js');
    expect(canTransitionTo('failed', 'pending')).toBe(false);
    expect(canTransitionTo('failed', 'leased')).toBe(false);
    expect(canTransitionTo('failed', 'retry_wait')).toBe(false);
    expect(canTransitionTo('failed', 'succeeded')).toBe(false);
  });

  it('pending → succeeded is invalid (must lease first)', async () => {
    const { canTransitionTo } = await import('../internalization/internalization-task-guards.js');
    expect(canTransitionTo('pending', 'succeeded')).toBe(false);
  });

  it('pending → retry_wait is invalid', async () => {
    const { canTransitionTo } = await import('../internalization/internalization-task-guards.js');
    expect(canTransitionTo('pending', 'retry_wait')).toBe(false);
  });
});

// ── validateInternalizationTaskReady ──────────────────────────────────────────

describe('validateInternalizationTaskReady', () => {
  it('no deps + pending → proceed', async () => {
    const { validateInternalizationTaskReady } = await import('../internalization/internalization-state-machine.js');
    const task = makePITask({ status: 'pending', dependencyTaskIds: [] });
    const result = validateInternalizationTaskReady(task, []);
    expect(result.decision).toBe('proceed');
    expect(result.ready).toBe(true);
    expect(result.blockedBy).toHaveLength(0);
  });

  it('all deps succeeded → proceed', async () => {
    const { validateInternalizationTaskReady } = await import('../internalization/internalization-state-machine.js');
    const task = makePITask({ status: 'pending', dependencyTaskIds: ['dep-1'] });
    const deps = [makeTask({ taskId: 'dep-1', status: 'succeeded' })];
    const result = validateInternalizationTaskReady(task, deps);
    expect(result.decision).toBe('proceed');
    expect(result.ready).toBe(true);
  });

  it('dep pending → blocked', async () => {
    const { validateInternalizationTaskReady } = await import('../internalization/internalization-state-machine.js');
    const task = makePITask({ status: 'pending', dependencyTaskIds: ['dep-1'] });
    const deps = [makeTask({ taskId: 'dep-1', status: 'pending' })];
    const result = validateInternalizationTaskReady(task, deps);
    expect(result.decision).toBe('blocked');
    expect(result.ready).toBe(false);
    expect(result.blockedBy).toContain('dep-1');
  });

  it('dep failed → dependency_failed (NOT auto-fail)', async () => {
    const { validateInternalizationTaskReady } = await import('../internalization/internalization-state-machine.js');
    const task = makePITask({ status: 'pending', dependencyTaskIds: ['dep-1'] });
    const deps = [makeTask({ taskId: 'dep-1', status: 'failed' })];
    const result = validateInternalizationTaskReady(task, deps);
    expect(result.decision).toBe('dependency_failed');
    expect(result.ready).toBe(false);
    expect(result.failedDependencies).toContain('dep-1');
  });

  it('task already leased → blocked', async () => {
    const { validateInternalizationTaskReady } = await import('../internalization/internalization-state-machine.js');
    const task = makePITask({ status: 'leased', dependencyTaskIds: [] });
    const result = validateInternalizationTaskReady(task, []);
    expect(result.decision).toBe('blocked');
    expect(result.ready).toBe(false);
  });
});

// ── validateTaskTransition ───────────────────────────────────────────────────

describe('validateTaskTransition', () => {
  it('valid transition returns valid=true', async () => {
    const { validateTaskTransition } = await import('../internalization/internalization-state-machine.js');
    const task = makePITask({ status: 'pending' });
    const result = validateTaskTransition(task, 'leased');
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('terminal state transition returns valid=false with reason', async () => {
    const { validateTaskTransition } = await import('../internalization/internalization-state-machine.js');
    const task = makePITask({ status: 'succeeded' });
    const result = validateTaskTransition(task, 'failed');
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('illegal pending → succeeded returns invalid', async () => {
    const { validateTaskTransition } = await import('../internalization/internalization-state-machine.js');
    const task = makePITask({ status: 'pending' });
    const result = validateTaskTransition(task, 'succeeded');
    expect(result.valid).toBe(false);
  });
});

// ── decideArtifactRejectionFeedback ───────────────────────────────────────────

describe('decideArtifactRejectionFeedback', () => {
  it('rejected artifact does NOT set task to failed', async () => {
    const { decideArtifactRejectionFeedback } = await import('../internalization/internalization-state-machine.js');
    const artifact = {
      artifactId: 'art-1',
      artifactKind: 'principle' as const,
      sourceTaskId: 'scribe-task',
      lineageRefs: [] as LineageRef[],
      validationStatus: 'rejected' as const,
    };
    const task = makePITask({ taskKind: 'scribe', status: 'succeeded' });
    const result = decideArtifactRejectionFeedback(artifact, task);
    // Key assertion: decision is about corrective task, not task failure
    expect(result.action).not.toBe('task_failed');
  });

  it('scribe artifact rejected → create corrective scribe task', async () => {
    const { decideArtifactRejectionFeedback } = await import('../internalization/internalization-state-machine.js');
    const artifact = {
      artifactId: 'art-1',
      artifactKind: 'rule' as const,
      sourceTaskId: 'scribe-task',
      lineageRefs: [] as LineageRef[],
      validationStatus: 'rejected' as const,
    };
    const task = makePITask({ taskKind: 'scribe', status: 'succeeded' });
    const result = decideArtifactRejectionFeedback(artifact, task);
    expect(result.action).toBe('create_corrective_task');
    expect(result.correctiveTaskKind).toBe('scribe');
  });

  it('artificer artifact rejected → create corrective artificer task', async () => {
    const { decideArtifactRejectionFeedback } = await import('../internalization/internalization-state-machine.js');
    const artifact = {
      artifactId: 'art-1',
      artifactKind: 'patch' as const,
      sourceTaskId: 'artificer-task',
      lineageRefs: [] as LineageRef[],
      validationStatus: 'rejected' as const,
    };
    const task = makePITask({ taskKind: 'artificer', status: 'succeeded' });
    const result = decideArtifactRejectionFeedback(artifact, task);
    expect(result.action).toBe('create_corrective_task');
    expect(result.correctiveTaskKind).toBe('artificer');
  });

  it('other runner artifact rejected → escalate', async () => {
    const { decideArtifactRejectionFeedback } = await import('../internalization/internalization-state-machine.js');
    const artifact = {
      artifactId: 'art-1',
      artifactKind: 'principle' as const,
      sourceTaskId: 'dreamer-task',
      lineageRefs: [] as LineageRef[],
      validationStatus: 'rejected' as const,
    };
    const task = makePITask({ taskKind: 'dreamer', status: 'succeeded' });
    const result = decideArtifactRejectionFeedback(artifact, task);
    expect(result.action).toBe('escalate');
  });
});

// ── createNextTaskProposal ────────────────────────────────────────────────────

describe('createNextTaskProposal', () => {
  it('dreamer succeeded → propose philosopher', async () => {
    const { createNextTaskProposal } = await import('../internalization/internalization-state-machine.js');
    const task = makePITask({
      taskId: 'dreamer-1',
      taskKind: 'dreamer',
      status: 'succeeded',
      outputArtifactRefs: [{ artifactType: 'principle', ref: 'art-1' }],
    });
    const result = createNextTaskProposal(task, []);
    expect(result).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const r = result!;
    expect(r.taskKind).toBe('philosopher');
    expect(r.parentTaskId).toBe('dreamer-1');
    expect(r.dependencyTaskIds).toContain('dreamer-1');
  });

  it('philosopher succeeded → propose scribe', async () => {
    const { createNextTaskProposal } = await import('../internalization/internalization-state-machine.js');
    const task = makePITask({
      taskId: 'phil-1',
      taskKind: 'philosopher',
      status: 'succeeded',
      outputArtifactRefs: [{ artifactType: 'rule', ref: 'art-2' }],
    });
    const result = createNextTaskProposal(task, []);
    expect(result).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result!.taskKind).toBe('scribe');
  });

  it('evaluator succeeded → propose rollout_reviewer', async () => {
    const { createNextTaskProposal } = await import('../internalization/internalization-state-machine.js');
    const task = makePITask({
      taskId: 'eval-1',
      taskKind: 'evaluator',
      status: 'succeeded',
      outputArtifactRefs: [],
    });
    const result = createNextTaskProposal(task, []);
    expect(result).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result!.taskKind).toBe('rollout_reviewer');
  });

  it('rollout_reviewer succeeded → trainer (can reach trainer via model_training channel)', async () => {
    const { createNextTaskProposal } = await import('../internalization/internalization-state-machine.js');
    const task = makePITask({
      taskId: 'rr-1',
      taskKind: 'rollout_reviewer',
      status: 'succeeded',
      outputArtifactRefs: [],
    });
    const result = createNextTaskProposal(task, []);
    // rollout_reviewer has no direct ALLOWED_EDGES successors, but getAllowedSuccessors
    // appends trainer as a reachable alternative (any runner can reach trainer
    // via model_training channel)
    expect(result).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(result!.taskKind).toBe('trainer');
  });

  it('dreamer succeeded → philosopher (first in ALLOWED_EDGES, channel passed through)', async () => {
    const { createNextTaskProposal } = await import('../internalization/internalization-state-machine.js');
    const task = makePITask({
      taskId: 'dreamer-1',
      taskKind: 'dreamer',
      status: 'succeeded',
      channel: 'model_training',
      outputArtifactRefs: [{ artifactType: 'training_data', ref: 'td-1' }],
    });
    const result = createNextTaskProposal(task, []);
    expect(result).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const r = result!;
    // getAllowedSuccessors returns ['philosopher', 'trainer'] for dreamer;
    // first element is philosopher (direct ALLOWED_EDGES successor)
    expect(r.taskKind).toBe('philosopher');
    expect(r.channel).toBe('model_training');
  });
});

// ── validateInternalizationGraph ──────────────────────────────────────────────

describe('validateInternalizationGraph', () => {
  it('valid linear chain → valid', async () => {
    const { validateInternalizationGraph } = await import('../internalization/internalization-state-machine.js');
    const tasks = [
      makePITask({ taskId: 't1', taskKind: 'dreamer', dependencyTaskIds: [] }),
      makePITask({ taskId: 't2', taskKind: 'philosopher', dependencyTaskIds: ['t1'] }),
      makePITask({ taskId: 't3', taskKind: 'scribe', dependencyTaskIds: ['t2'] }),
    ];
    const result = validateInternalizationGraph(tasks);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('graph with cycle → invalid + cycle error', async () => {
    const { validateInternalizationGraph } = await import('../internalization/internalization-state-machine.js');
    // t1 → t2 → t3 → t1 (cycle)
    const tasks = [
      makePITask({ taskId: 't1', taskKind: 'dreamer', dependencyTaskIds: ['t3'] }),
      makePITask({ taskId: 't2', taskKind: 'philosopher', dependencyTaskIds: ['t1'] }),
      makePITask({ taskId: 't3', taskKind: 'scribe', dependencyTaskIds: ['t2'] }),
    ];
    const result = validateInternalizationGraph(tasks);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.type === 'cycle')).toBe(true);
  });

  it('graph with disallowed edge → invalid + disallowed_edge error', async () => {
    const { validateInternalizationGraph } = await import('../internalization/internalization-state-machine.js');
    // scribe → dreamer is NOT a valid edge (must go through pipeline)
    const tasks = [
      makePITask({ taskId: 't1', taskKind: 'scribe', dependencyTaskIds: [] }),
      makePITask({ taskId: 't2', taskKind: 'dreamer', dependencyTaskIds: ['t1'] }),
    ];
    const result = validateInternalizationGraph(tasks);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.type === 'disallowed_edge')).toBe(true);
  });

  it('empty graph → valid', async () => {
    const { validateInternalizationGraph } = await import('../internalization/internalization-state-machine.js');
    const result = validateInternalizationGraph([]);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── isResultRefImmutable / canUpdateLastError ────────────────────────────────

describe('isResultRefImmutable', () => {
  it('succeeded task has immutable resultRef', async () => {
    const { isResultRefImmutable } = await import('../internalization/internalization-task-guards.js');
    expect(isResultRefImmutable(makePITask({ status: 'succeeded' }))).toBe(true);
  });

  it('pending task resultRef is not yet set', async () => {
    const { isResultRefImmutable } = await import('../internalization/internalization-task-guards.js');
    // Immutable check is only meaningful after succeeded; pending can still be set
    expect(isResultRefImmutable(makePITask({ status: 'pending' }))).toBe(false);
  });
});

describe('canUpdateLastError', () => {
  it('retry_wait task can update lastError', async () => {
    const { canUpdateLastError } = await import('../internalization/internalization-task-guards.js');
    expect(canUpdateLastError(makePITask({ status: 'retry_wait' }))).toBe(true);
  });

  it('failed task can update lastError', async () => {
    const { canUpdateLastError } = await import('../internalization/internalization-task-guards.js');
    expect(canUpdateLastError(makePITask({ status: 'failed' }))).toBe(true);
  });

  it('pending task cannot update lastError', async () => {
    const { canUpdateLastError } = await import('../internalization/internalization-task-guards.js');
    expect(canUpdateLastError(makePITask({ status: 'pending' }))).toBe(false);
  });

  it('succeeded task cannot update lastError', async () => {
    const { canUpdateLastError } = await import('../internalization/internalization-task-guards.js');
    expect(canUpdateLastError(makePITask({ status: 'succeeded' }))).toBe(false);
  });
});

// ── isArtifactRejected ───────────────────────────────────────────────────────

describe('isArtifactRejected', () => {
  it('rejected artifact returns true', async () => {
    const { isArtifactRejected } = await import('../internalization/internalization-task-guards.js');
    const artifact = {
      artifactId: 'art-1',
      artifactKind: 'principle' as const,
      sourceTaskId: 'task-1',
      lineageRefs: [] as LineageRef[],
      validationStatus: 'rejected' as const,
    };
    expect(isArtifactRejected(artifact)).toBe(true);
  });

  it('validated artifact returns false', async () => {
    const { isArtifactRejected } = await import('../internalization/internalization-task-guards.js');
    const artifact = {
      artifactId: 'art-1',
      artifactKind: 'principle' as const,
      sourceTaskId: 'task-1',
      lineageRefs: [] as LineageRef[],
      validationStatus: 'validated' as const,
    };
    expect(isArtifactRejected(artifact)).toBe(false);
  });

  it('pending artifact returns false', async () => {
    const { isArtifactRejected } = await import('../internalization/internalization-task-guards.js');
    const artifact = {
      artifactId: 'art-1',
      artifactKind: 'principle' as const,
      sourceTaskId: 'task-1',
      lineageRefs: [] as LineageRef[],
      validationStatus: 'pending' as const,
    };
    expect(isArtifactRejected(artifact)).toBe(false);
  });
});

// ── Architecture Guards ───────────────────────────────────────────────────────

describe('Architecture Guards: no infrastructure imports', () => {
  it('internalization-task-guards.ts has zero infra imports', async () => {
    expect(await moduleHasNoInfraImports('internalization/internalization-task-guards.ts')).toBe(true);
  });

  it('internalization-state-machine.ts has zero infra imports', async () => {
    expect(await moduleHasNoInfraImports('internalization/internalization-state-machine.ts')).toBe(true);
  });

  it('state machine guard does not call PDRuntimeAdapter', async () => {
    const src = readFileSync(resolve(__dirname, '..', 'internalization/internalization-state-machine.ts'), 'utf-8');
    // PDRuntimeAdapter is only mentioned in a comment — no actual runtime call
    expect(src).not.toMatch(/\bPDRuntimeAdapter\s*\(/);
  });

  it('guard functions return proposals, not direct createTask calls', async () => {
    const src = readFileSync(resolve(__dirname, '..', 'internalization/internalization-state-machine.ts'), 'utf-8');
    // Pure return values — no store mutation functions called
    expect(src).not.toMatch(/\bcreateTask\s*\(/);
    expect(src).not.toMatch(/\bmarkTask\S+\s*\(/);
  });
});
