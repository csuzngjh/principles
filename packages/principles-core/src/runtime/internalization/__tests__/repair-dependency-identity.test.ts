import { describe, expect, it } from 'vitest';
import { planStaleRepairTransitionFromDependencyScan, resolveEvaluatorArtificerDependencyIdentity, scanEvaluatorArtificerDependencyIdentity } from '../repair-task-identity.js';
import { artificerRepairTaskId, createPITaskDiagnosticJson, type PITaskMetadata, type RepairPayload } from '../pitask-metadata.js';
import type { TaskRecord } from '../../task-status.js';

const ROOT = 'dreamer-repair-identity-root';
const CORRELATION = '11111111-1111-4111-8111-111111111111';
const EVALUATOR = 'evaluator-repair-identity';

function task(input: { taskId: string; taskKind: string; meta: Partial<PITaskMetadata>; extraDiagnostic?: Record<string, unknown> }): TaskRecord {
  const { taskId, taskKind, meta, extraDiagnostic = {} } = input;
  return {
    taskId, taskKind, status: 'succeeded', attemptCount: 1, maxAttempts: 3,
    createdAt: '2026-11-27T00:00:00.000Z', updatedAt: '2026-11-27T00:00:00.000Z',
    diagnosticJson: taskKind === 'dreamer'
      ? JSON.stringify({ pi_metadata: { dependencyTaskIds: [], channel: 'prompt', timeoutMs: 1, inputArtifactRefs: [], outputArtifactRefs: [], correlationId: CORRELATION }, candidateId: CORRELATION, ...extraDiagnostic })
      : createPITaskDiagnosticJson({
          dependencyTaskIds: [], channel: 'prompt', timeoutMs: 1, inputArtifactRefs: [], outputArtifactRefs: [], ...meta,
        }),
  };
}

function payload(iteration: 1 | 2, source = EVALUATOR): RepairPayload {
  return { requiredChanges: ['fix'], concerns: [], previousScore: 0.5, repairIteration: iteration, sourceArtificerArtifactId: 'pi-art-src', sourceEvaluatorTaskId: source };
}

function evaluator(dependencyTaskIds: string[], channel: 'prompt' | 'code_tool_hook' = 'prompt'): TaskRecord {
  return task({ taskId: EVALUATOR, taskKind: 'evaluator', meta: { dependencyTaskIds, parentTaskId: ROOT, channel } });
}

function repair(iteration: 1 | 2, options: { source?: string; taskId?: string; role?: string; channel?: 'prompt' | 'code_tool_hook'; diagnosticJson?: string } = {}): TaskRecord {
  if (options.diagnosticJson !== undefined) {
    return { ...task({ taskId: options.taskId ?? artificerRepairTaskId(options.source ?? EVALUATOR, iteration), taskKind: 'artificer', meta: {} }), diagnosticJson: options.diagnosticJson };
  }
  return task({ taskId: options.taskId ?? artificerRepairTaskId(options.source ?? EVALUATOR, iteration), taskKind: 'artificer', meta: {
    dependencyTaskIds: [], parentTaskId: options.source ?? EVALUATOR, channel: options.channel ?? 'prompt', correlationId: CORRELATION,
    ...(options.role === undefined ? {} : { repairTaskRole: options.role }), repairPayload: payload(iteration, options.source),
  } });
}

function store(tasks: TaskRecord[], throwOn = new Set<string>()) {
  return {
    getTask: async (id: string) => {
      if (throwOn.has(id)) throw new Error(`read failed:${id}`);
      return tasks.find((candidate) => candidate.taskId === id) ?? null;
    },
    listTasks: async () => [...tasks],
  };
}
const root = () => task({ taskId: ROOT, taskKind: 'dreamer', meta: {} });

async function resolve(tasks: TaskRecord[], evalTask = evaluator(tasks.filter((t) => t.taskKind === 'artificer').map((t) => t.taskId))) {
  return resolveEvaluatorArtificerDependencyIdentity({ evaluatorTask: evalTask, store: store([root(), evalTask, ...tasks]) });
}

describe('PRI-1299 repair dependency identity shared resolver', () => {
  it.each([1, 2] as const)('accepts a valid R%i repair dependency', async (iteration) => {
    const row = repair(iteration, { role: 'repair_artificer' });
    const result = await resolve([row]);
    expect(result).toMatchObject({ kind: 'repair', payload: { repairIteration: iteration }, legacyRepair: false });
  });

  it('accepts payload-valid legacy repair without durable role as backfillable legacy', async () => {
    const result = await resolve([repair(1)]);
    expect(result).toMatchObject({ kind: 'repair', legacyRepair: true });
  });

  it('rejects a foreign-source repair even when attached as a dependency', async () => {
    const row = repair(1, { source: 'evaluator-other', role: 'repair_artificer' });
    const result = await resolve([row]);
    expect(result).toMatchObject({ kind: 'invalid', reason: 'repair_payload_source_mismatch' });
  });

  it('rejects deterministic task id / payload mismatch', async () => {
    const row = repair(1, { taskId: 'artificer-repair-forged-r1', role: 'repair_artificer' });
    const result = await resolve([row]);
    expect(result).toMatchObject({ kind: 'invalid', reason: 'repair_task_id_payload_mismatch' });
  });

  it('rejects iteration mismatch because payload and deterministic id do not mutually prove identity', async () => {
    const row = repair(2, { taskId: artificerRepairTaskId(EVALUATOR, 1), role: 'repair_artificer' });
    const result = await resolve([row]);
    expect(result).toMatchObject({ kind: 'invalid', reason: 'repair_task_id_payload_mismatch' });
  });

  it('rejects channel mismatch', async () => {
    const row = repair(1, { role: 'repair_artificer', channel: 'code_tool_hook' });
    const result = await resolve([row]);
    expect(result).toMatchObject({ kind: 'invalid', reason: 'repair_channel_mismatch' });
  });

  it('rejects malformed metadata fail-closed', async () => {
    const row = repair(1, { diagnosticJson: '{bad-json' });
    const result = await resolve([row]);
    expect(result).toMatchObject({ kind: 'invalid', reason: 'evaluator_artificer_dependency_metadata_malformed' });
  });

  it('rejects role-only metadata fail-closed', async () => {
    const row = repair(1, { role: 'repair_artificer' });
    const parsed = JSON.parse(row.diagnosticJson ?? '{}') as { pi_metadata: Record<string, unknown> };
    delete parsed.pi_metadata.repairPayload;
    row.diagnosticJson = JSON.stringify(parsed);
    const result = await resolve([row]);
    expect(result).toMatchObject({ kind: 'invalid', reason: 'repair_role_payload_missing' });
  });

  it('does not reinterpret a reserved deterministic repair id with missing payload as ordinary input', async () => {
    const row = repair(1, { role: 'repair_artificer' });
    const parsed = JSON.parse(row.diagnosticJson ?? '{}') as { pi_metadata: Record<string, unknown> };
    delete parsed.pi_metadata.repairPayload;
    delete parsed.pi_metadata.repairTaskRole;
    row.diagnosticJson = JSON.stringify(parsed);
    const result = await resolve([row]);
    expect(result).toMatchObject({ kind: 'invalid', reason: 'repair_payload_missing' });
  });

  it('rejects multiple artificer candidates instead of choosing the first', async () => {
    const ordinary = task({ taskId: 'artificer-ordinary', taskKind: 'artificer', meta: { dependencyTaskIds: [], parentTaskId: EVALUATOR } });
    const row = repair(1, { role: 'repair_artificer' });
    const result = await resolve([ordinary, row]);
    expect(result).toMatchObject({ kind: 'invalid', reason: 'evaluator_ambiguous_artificer_dependencies' });
  });

  it('fails closed when the store cannot read a dependency', async () => {
    const row = repair(1, { role: 'repair_artificer' });
    const evalTask = evaluator([row.taskId]);
    const result = await resolveEvaluatorArtificerDependencyIdentity({ evaluatorTask: evalTask, store: store([root(), evalTask], new Set([row.taskId])) });
    expect(result).toMatchObject({ kind: 'invalid', reason: 'evaluator_artificer_dependency_read_failed' });
  });
});

describe('PRI-1299 repair dependency complete scan and stale-round adjudication', () => {
  async function scanFor(tasks: TaskRecord[], dependencyIds: string[]) {
    const evalTask = evaluator(dependencyIds);
    return scanEvaluatorArtificerDependencyIdentity({
      evaluatorTask: evalTask,
      store: store([root(), evalTask, ...tasks]),
    });
  }

  it('scans ordinary rows without hiding a later valid newer repair', async () => {
    const ordinary = task({ taskId: 'artificer-ordinary-scan', taskKind: 'artificer', meta: { dependencyTaskIds: [], parentTaskId: EVALUATOR } });
    const newer = repair(2, { role: 'repair_artificer' });
    const scan = await scanFor([ordinary, newer], [ordinary.taskId, newer.taskId]);

    expect(scan.candidates.map((candidate) => candidate.class)).toEqual(['ordinary', 'legal_repair']);
    const plan = planStaleRepairTransitionFromDependencyScan({
      scan,
      completingRepairTaskId: artificerRepairTaskId(EVALUATOR, 1),
      completingRepairIteration: 1,
    });
    expect(plan).toEqual({ kind: 'superseded' });
  });

  it('scan order does not change ordinary/newer-repair stale adjudication', async () => {
    const ordinary = task({ taskId: 'artificer-ordinary-scan', taskKind: 'artificer', meta: { dependencyTaskIds: [], parentTaskId: EVALUATOR } });
    const newer = repair(2, { role: 'repair_artificer' });
    const scan = await scanFor([ordinary, newer], [newer.taskId, ordinary.taskId]);

    expect(scan.candidates.map((candidate) => candidate.class)).toEqual(['legal_repair', 'ordinary']);
    expect(planStaleRepairTransitionFromDependencyScan({
      scan,
      completingRepairTaskId: artificerRepairTaskId(EVALUATOR, 1),
      completingRepairIteration: 1,
    })).toEqual({ kind: 'superseded' });
  });

  it('a proven legacy newer repair also supersedes without any write-side backfill', async () => {
    const newer = repair(2);
    const scan = await scanFor([newer], [newer.taskId]);
    expect(scan.candidates[0]?.class).toBe('legacy_repair');
    expect(planStaleRepairTransitionFromDependencyScan({
      scan,
      completingRepairTaskId: artificerRepairTaskId(EVALUATOR, 1),
      completingRepairIteration: 1,
    })).toEqual({ kind: 'superseded' });
  });

  it('ordinary rows alone do not supersede a completing repair', async () => {
    const ordinary = task({ taskId: 'artificer-ordinary-scan', taskKind: 'artificer', meta: { dependencyTaskIds: [], parentTaskId: EVALUATOR } });
    const scan = await scanFor([ordinary], [ordinary.taskId]);
    expect(planStaleRepairTransitionFromDependencyScan({
      scan,
      completingRepairTaskId: artificerRepairTaskId(EVALUATOR, 1),
      completingRepairIteration: 1,
    })).toEqual({ kind: 'clear' });
  });

  it('role-only evidence vetoes reopen even when a newer valid repair is also present', async () => {
    const roleOnly = repair(1, { role: 'repair_artificer', taskId: 'artificer-role-only' });
    const parsed = JSON.parse(roleOnly.diagnosticJson ?? '{}') as { pi_metadata: Record<string, unknown> };
    delete parsed.pi_metadata.repairPayload;
    roleOnly.diagnosticJson = JSON.stringify(parsed);
    const newer = repair(2, { role: 'repair_artificer' });
    const scan = await scanFor([roleOnly, newer], [roleOnly.taskId, newer.taskId]);

    expect(scan.candidates.map((candidate) => candidate.class)).toEqual(['role_only', 'legal_repair']);
    expect(planStaleRepairTransitionFromDependencyScan({
      scan,
      completingRepairTaskId: artificerRepairTaskId(EVALUATOR, 1),
      completingRepairIteration: 1,
    })).toMatchObject({ kind: 'invalid', reason: 'repair_role_payload_missing' });
  });

  it('unprovable evidence vetoes reopen even when a newer valid repair is also present', async () => {
    const foreign = repair(1, { source: 'evaluator-foreign', role: 'repair_artificer' });
    const newer = repair(2, { role: 'repair_artificer' });
    const scan = await scanFor([foreign, newer], [foreign.taskId, newer.taskId]);

    expect(scan.candidates.map((candidate) => candidate.class)).toEqual(['unprovable', 'legal_repair']);
    expect(planStaleRepairTransitionFromDependencyScan({
      scan,
      completingRepairTaskId: artificerRepairTaskId(EVALUATOR, 1),
      completingRepairIteration: 1,
    })).toMatchObject({ kind: 'invalid', reason: 'repair_payload_source_mismatch' });
  });

  it('multiple proven repair dependencies are ambiguous rather than silently ordered', async () => {
    const r1 = repair(1, { role: 'repair_artificer' });
    const r2 = repair(2, { role: 'repair_artificer' });
    const scan = await scanFor([r1, r2], [r1.taskId, r2.taskId]);

    expect(scan.candidates.map((candidate) => candidate.class)).toEqual(['legal_repair', 'legal_repair']);
    expect(planStaleRepairTransitionFromDependencyScan({
      scan,
      completingRepairTaskId: r1.taskId,
      completingRepairIteration: 1,
    })).toMatchObject({ kind: 'invalid', reason: 'evaluator_ambiguous_repair_dependencies' });
  });

  it('equal iteration never counts as a newer round', async () => {
    const current = repair(1, { role: 'repair_artificer' });
    const scan = await scanFor([current], [current.taskId]);
    expect(planStaleRepairTransitionFromDependencyScan({
      scan,
      completingRepairTaskId: 'artificer-repair-different-row-r1',
      completingRepairIteration: 1,
    })).toEqual({ kind: 'clear' });
  });
});
