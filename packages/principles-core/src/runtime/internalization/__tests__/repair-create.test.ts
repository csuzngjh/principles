/**
 * PRI-1299 Phase 1 回归 — createRepairTask (真实 sqlite):
 *   host-runtime / pd-cli 共用的唯一 Repair Creation Authority。
 *
 * 覆盖: R1/R2 identity、同请求复用、跨连接并发、payload/channel fail-closed、
 * malformed payload、terminal repair、legacy 血缘/角色 CAS 回填、pipelineMode、
 * UNIQUE race re-arbitration、重启持久化与失败零写入。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import type { TaskRecord } from '../../task-status.js';
import { createRepairTask, repairSeedErrorMessage } from '../repair-create.js';
import { artificerRepairTaskId, hydratePITaskRecord, PI_METADATA_KEY, type RepairPayload } from '../pitask-metadata.js';
import type { InternalizationChannel, PipelineTopologyMode } from '../peer-runner-contracts.js';

const CAND = 'cand-p1299-phase1';

let workspaceDir: string;
let sm: RuntimeStateManager;

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-p1299-repair-create-'));
  sm = new RuntimeStateManager({ workspaceDir });
  await sm.initialize();
});

afterEach(async () => {
  await sm.close();
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
});

function need<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${label}`);
  return value;
}

async function mkPiTask(
  taskId: string,
  taskKind: string,
  meta: {
    status?: TaskRecord['status'];
    channel?: InternalizationChannel;
    parentTaskId?: string;
    correlationId?: string;
    candidateId?: string;
    repairPayload?: RepairPayload;
    repairTaskRole?: 'repair_artificer';
  },
): Promise<TaskRecord> {
  return sm.createTask({
    taskId,
    taskKind,
    status: meta.status ?? 'pending',
    attemptCount: meta.status === 'succeeded' ? 1 : 0,
    maxAttempts: 3,
    diagnosticJson: JSON.stringify({
      [PI_METADATA_KEY]: {
        dependencyTaskIds: meta.parentTaskId !== undefined ? [meta.parentTaskId] : [],
        channel: meta.channel ?? 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        ...(meta.parentTaskId !== undefined ? { parentTaskId: meta.parentTaskId } : {}),
        ...(meta.correlationId !== undefined ? { correlationId: meta.correlationId } : {}),
        ...(meta.repairPayload !== undefined ? { repairPayload: meta.repairPayload } : {}),
        ...(meta.repairTaskRole !== undefined ? { repairTaskRole: meta.repairTaskRole } : {}),
      },
      ...(meta.candidateId !== undefined ? { candidateId: meta.candidateId } : {}),
    }),
  });
}

async function seedSourceEvaluator(prefix: string, channel: InternalizationChannel = 'prompt'): Promise<string> {
  await mkPiTask(`${prefix}-dreamer`, 'dreamer', {
    status: 'succeeded', channel, correlationId: CAND, candidateId: CAND,
  });
  await mkPiTask(`${prefix}-evaluator`, 'evaluator', {
    status: 'succeeded', channel, parentTaskId: `${prefix}-dreamer`, correlationId: CAND,
  });
  return `${prefix}-evaluator`;
}

function repairPayload(sourceEvaluatorTaskId: string, repairIteration: number, overrides: Partial<RepairPayload> = {}): RepairPayload {
  return {
    requiredChanges: ['fix matcher'],
    concerns: ['code gap'],
    previousScore: 0.4,
    repairIteration,
    sourceArtificerArtifactId: 'pi-art-source-artificer',
    sourceEvaluatorTaskId,
    ...overrides,
  };
}

function request(sourceEvaluatorTaskId: string, repairIteration = 1, overrides: {
  repairPayload?: Partial<RepairPayload>;
  inheritedChannel?: InternalizationChannel;
  inheritedPipelineMode?: PipelineTopologyMode;
} = {}) {
  return {
    repairPayload: repairPayload(sourceEvaluatorTaskId, repairIteration, overrides.repairPayload),
    inheritedDependencyTaskIds: [`${sourceEvaluatorTaskId}-scribe`],
    inheritedChannel: overrides.inheritedChannel ?? ('prompt' as const),
    inheritedPipelineMode: overrides.inheritedPipelineMode,
    inheritedTimeoutMs: 300_000,
    inheritedInputArtifactRefs: [],
  };
}

async function seedManualRepair(
  sourceEvaluatorTaskId: string,
  repairIteration: number,
  opts: {
    status?: TaskRecord['status'];
    channel?: InternalizationChannel;
    omitLineage?: boolean;
    omitRole?: boolean;
    omitPayload?: boolean;
    payload?: RepairPayload;
  } = {},
): Promise<TaskRecord> {
  const payload = opts.payload ?? repairPayload(sourceEvaluatorTaskId, repairIteration);
  return mkPiTask(artificerRepairTaskId(sourceEvaluatorTaskId, repairIteration), 'artificer', {
    status: opts.status ?? 'pending',
    channel: opts.channel ?? 'prompt',
    ...(opts.omitLineage === true
      ? {}
      : { parentTaskId: sourceEvaluatorTaskId, correlationId: CAND }),
    ...(opts.omitPayload === true ? {} : { repairPayload: payload }),
    ...(opts.omitRole === true ? {} : { repairTaskRole: 'repair_artificer' as const }),
  });
}

async function repairRows(sourceEvaluatorTaskId: string): Promise<TaskRecord[]> {
  const tasks = await sm.listTasks({ taskKind: 'artificer' });
  return tasks.filter((task) => task.taskId.startsWith(`artificer-repair-${sourceEvaluatorTaskId}-`));
}

describe('createRepairTask — RepairSuccessorIdentity', () => {
  it('creates R1 once with authoritative lineage, pipelineMode and explicit repair role', async () => {
    const source = await seedSourceEvaluator('r1');
    const result = await createRepairTask(sm, request(source, 1, { inheritedPipelineMode: 'standard' }));

    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') return;
    expect(result.task.taskId).toBe(artificerRepairTaskId(source, 1));
    const pi = hydratePITaskRecord(result.task);
    expect(pi).toMatchObject({
      taskKind: 'artificer',
      status: 'pending',
      parentTaskId: source,
      correlationId: CAND,
      channel: 'prompt',
      pipelineMode: 'standard',
      repairTaskRole: 'repair_artificer',
    });
    expect(pi?.repairPayload).toEqual(request(source, 1).repairPayload);
  });

  it('R1 and R2 have distinct identities and legally coexist', async () => {
    const source = await seedSourceEvaluator('r12');
    const r1 = await createRepairTask(sm, request(source, 1));
    expect(r1.outcome).toBe('created');
    if (r1.outcome !== 'created') return;
    await sm.updateTask(r1.task.taskId, { status: 'succeeded' });
    const r2 = await createRepairTask(sm, request(source, 2));

    expect(r2.outcome).toBe('created');
    const rows = await repairRows(source);
    expect(rows.map((task) => task.taskId).sort()).toEqual([
      artificerRepairTaskId(source, 1),
      artificerRepairTaskId(source, 2),
    ].sort());
    const r2Pi = hydratePITaskRecord(need(rows.find((task) => task.taskId.endsWith('-r2')), 'r2'));
    expect(r2Pi?.repairPayload?.repairIteration).toBe(2);
    expect(r2Pi?.repairTaskRole).toBe('repair_artificer');
  });

  it('replaying the same repair request adopts the in-flight row without creating a second task', async () => {
    const source = await seedSourceEvaluator('dup');
    const first = await createRepairTask(sm, request(source, 1));
    const second = await createRepairTask(sm, request(source, 1));

    expect(first.outcome).toBe('created');
    expect(second).toMatchObject({ outcome: 'adopted_existing', backfilled: false });
    expect(await repairRows(source)).toHaveLength(1);
  });

  it('two SQLite connections racing the same repair identity produce exactly one row', async () => {
    const source = await seedSourceEvaluator('race');
    const second = new RuntimeStateManager({ workspaceDir });
    await second.initialize();
    try {
      const [a, b] = await Promise.all([
        createRepairTask(sm, request(source, 1)),
        createRepairTask(second, request(source, 1)),
      ]);
      expect([a.outcome, b.outcome].sort()).toEqual(['adopted_existing', 'created']);
      expect(await repairRows(source)).toHaveLength(1);
      expect(await second.listTasks({ taskKind: 'artificer' })).toHaveLength(1);
    } finally {
      await second.close();
    }
  });

  it('UNIQUE-conflict re-arbitration adopts the winner instead of surfacing a generic seed failure', async () => {
    const source = await seedSourceEvaluator('unique-race');
    const repairTaskId = artificerRepairTaskId(source, 1);
    const originalCreateTask = sm.createTask.bind(sm);
    let injected = false;
    sm.createTask = async (record) => {
      if (!injected && record.taskId === repairTaskId) {
        injected = true;
        await originalCreateTask(record);
        throw new Error('UNIQUE constraint failed: tasks.task_id');
      }
      return originalCreateTask(record);
    };
    try {
      const result = await createRepairTask(sm, request(source, 1));
      expect(result).toMatchObject({ outcome: 'adopted_existing', backfilled: false });
      expect(await repairRows(source)).toHaveLength(1);
    } finally {
      sm.createTask = originalCreateTask;
    }
  });
});

describe('createRepairTask — fail-closed adjudication', () => {
  it('same deterministic id with different repair payload is a conflict and creates nothing', async () => {
    const source = await seedSourceEvaluator('payload-conflict');
    await createRepairTask(sm, request(source, 1));
    const before = await sm.listTasks({});

    const result = await createRepairTask(sm, request(source, 1, {
      repairPayload: { requiredChanges: ['different fix'] },
    }));

    expect(result).toMatchObject({ outcome: 'conflict', reason: 'repair_payload_mismatch' });
    expect(await sm.listTasks({})).toEqual(before);
  });

  it('channel mismatch fails closed and never creates a second-channel repair row', async () => {
    const source = await seedSourceEvaluator('channel-conflict');
    await seedManualRepair(source, 1, { channel: 'skill' });
    const before = await sm.listTasks({});

    const result = await createRepairTask(sm, request(source, 1));

    expect(result).toMatchObject({ outcome: 'fail_closed', reason: 'repair_channel_mismatch' });
    expect(await sm.listTasks({})).toEqual(before);
  });

  it('request channel must match an existing repair identity before adoption', async () => {
    const source = await seedSourceEvaluator('request-channel');
    const existing = await seedManualRepair(source, 1, { omitRole: true });
    const before = need(await sm.getTask(existing.taskId), 'existing before').diagnosticJson;

    const result = await createRepairTask(sm, request(source, 1, { inheritedChannel: 'skill' }));

    expect(result).toMatchObject({ outcome: 'fail_closed', reason: 'repair_channel_mismatch' });
    expect(need(await sm.getTask(existing.taskId), 'existing after').diagnosticJson).toBe(before);
  });

  it('request channel must equal the source evaluator channel before any insert', async () => {
    const source = await seedSourceEvaluator('source-channel');
    const result = await createRepairTask(sm, request(source, 1, { inheritedChannel: 'skill' }));

    expect(result).toMatchObject({ outcome: 'fail_closed', reason: 'repair_channel_mismatch' });
    expect(await repairRows(source)).toHaveLength(0);
  });

  it('malformed repair payload is refused before lineage proof or insert', async () => {
    const source = await seedSourceEvaluator('malformed');
    const malformed = {
      ...request(source, 1),
      repairPayload: { ...repairPayload(source, 1), requiredChanges: [] },
    };
    const result = await createRepairTask(sm, malformed);
    expect(result).toMatchObject({ outcome: 'fail_closed', reason: 'malformed_repair_payload' });
    expect(await repairRows(source)).toHaveLength(0);
  });

  it('explicit repair role without payload is rejected as malformed repair identity', async () => {
    const source = await seedSourceEvaluator('role-only');
    await seedManualRepair(source, 1, { omitPayload: true });
    const before = need(await sm.getTask(artificerRepairTaskId(source, 1)), 'role-only repair');

    const result = await createRepairTask(sm, request(source, 1));

    expect(result).toMatchObject({ outcome: 'fail_closed', reason: 'repair_payload_missing' });
    expect(need(await sm.getTask(before.taskId), 'role-only after')).toEqual(before);
  });

  it.each(['succeeded', 'failed', 'needs_human_review'] as const)('terminal %s repair is classified, not reused as new work', async (status) => {
    const source = await seedSourceEvaluator(`terminal-${status}`);
    await seedManualRepair(source, 1, { status });
    const before = need(await sm.getTask(artificerRepairTaskId(source, 1)), 'terminal repair');

    const result = await createRepairTask(sm, request(source, 1));

    expect(result).toMatchObject({ outcome: 'conflict', reason: 'terminal_repair_task' });
    expect(need(await sm.getTask(before.taskId), 'terminal after')).toEqual(before);
  });

  it('missing source evaluator lineage fails closed with zero repair rows', async () => {
    const result = await createRepairTask(sm, request('missing-source-evaluator', 1));
    expect(result).toMatchObject({ outcome: 'fail_closed', reason: 'repair_source_evaluator_missing' });
    expect(await sm.listTasks({ taskKind: 'artificer' })).toHaveLength(0);
  });

  it('a non-unique create failure rolls back the write transaction and a retry can create cleanly', async () => {
    const source = await seedSourceEvaluator('create-failure');
    const repairTaskId = artificerRepairTaskId(source, 1);
    const originalCreateTask = sm.createTask.bind(sm);
    let failOnce = true;
    sm.createTask = async (record) => {
      if (failOnce && record.taskId === repairTaskId) {
        failOnce = false;
        throw new Error('simulated process crash before repair insert');
      }
      return originalCreateTask(record);
    };
    try {
      await expect(createRepairTask(sm, request(source, 1))).rejects.toThrow('simulated process crash');
      expect(await repairRows(source)).toHaveLength(0);
      const retry = await createRepairTask(sm, request(source, 1));
      expect(retry.outcome).toBe('created');
      expect(await repairRows(source)).toHaveLength(1);
    } finally {
      sm.createTask = originalCreateTask;
    }
  });
});

describe('createRepairTask — legacy repair rows and persistence', () => {
  it('legacy deterministic repair with provable lineage is adopted after parent/correlation/role CAS backfill', async () => {
    const source = await seedSourceEvaluator('legacy-backfill');
    const legacy = await seedManualRepair(source, 1, { omitLineage: true, omitRole: true });

    const result = await createRepairTask(sm, request(source, 1));

    expect(result).toMatchObject({ outcome: 'adopted_existing', backfilled: true });
    const pi = hydratePITaskRecord(need(await sm.getTask(legacy.taskId), 'legacy after'));
    expect(pi).toMatchObject({
      parentTaskId: source,
      correlationId: CAND,
      repairTaskRole: 'repair_artificer',
    });
    expect(pi?.repairPayload?.sourceEvaluatorTaskId).toBe(source);
  });

  it('legacy deterministic repair with unprovable source lineage is refused and left untouched', async () => {
    await mkPiTask('orphan-source-evaluator', 'evaluator', { status: 'succeeded' });
    const payload = repairPayload('orphan-source-evaluator', 1);
    const legacy = await seedManualRepair('orphan-source-evaluator', 1, {
      omitLineage: true,
      omitRole: true,
      payload,
    });
    const before = need(await sm.getTask(legacy.taskId), 'legacy before');

    const result = await createRepairTask(sm, {
      repairPayload: payload,
      inheritedDependencyTaskIds: [],
      inheritedChannel: 'prompt',
      inheritedTimeoutMs: 300_000,
      inheritedInputArtifactRefs: [],
    });

    expect(result).toMatchObject({ outcome: 'fail_closed', reason: 'repair_source_lineage_unprovable' });
    expect(await sm.getTask(legacy.taskId)).toEqual(before);
  });

  it('repair identity, lineage and explicit role survive a SQLite connection restart', async () => {
    const source = await seedSourceEvaluator('restart');
    const created = await createRepairTask(sm, request(source, 1));
    expect(created.outcome).toBe('created');

    const reopened = new RuntimeStateManager({ workspaceDir });
    await reopened.initialize();
    try {
      const task = need(await reopened.getTask(artificerRepairTaskId(source, 1)), 'reopened repair');
      const pi = hydratePITaskRecord(task);
      expect(pi).toMatchObject({
        taskId: artificerRepairTaskId(source, 1),
        parentTaskId: source,
        correlationId: CAND,
        repairTaskRole: 'repair_artificer',
      });
      expect(pi?.repairPayload?.repairIteration).toBe(1);
    } finally {
      await reopened.close();
    }
  });
});

describe('repairSeedErrorMessage — host/pd-cli backward-compatible error mapping parity', () => {
  const failure = (reason: string, detail: string, taskId = 'artificer-repair-evaluator-x-r1') => ({
    outcome: 'fail_closed' as const,
    reason,
    detail,
    task: { taskId } as TaskRecord,
  });

  it('maps the seven review-required outcome classes to stable legacy error text', () => {
    expect(repairSeedErrorMessage(failure('repair_source_evaluator_missing', 'source evaluator task evaluator-x not found')))
      .toBe('evaluator_repair_seed_lineage_refused: source evaluator task evaluator-x not found');
    expect(repairSeedErrorMessage(failure('missing_correlation_id_lineage', 'unrecoverable_chain_root_not_dreamer:evaluator:evaluator-x')))
      .toBe('evaluator_repair_seed_lineage_refused:missing_correlation_id_lineage:unrecoverable_chain_root_not_dreamer:evaluator:evaluator-x');
    expect(repairSeedErrorMessage({ outcome: 'conflict', reason: 'concurrent_modification', detail: 'changed', task: { taskId: 'artificer-repair-evaluator-x-r1' } as TaskRecord }))
      .toBe('evaluator_repair_seed_concurrent_modification: repair task artificer-repair-evaluator-x-r1 changed during lineage backfill — seed NOT applied, safe to retry');
    expect(repairSeedErrorMessage({ outcome: 'conflict', reason: 'terminal_repair_task', detail: 'repair task artificer-repair-evaluator-x-r1 already reached terminal status succeeded; refusing to reuse it as new corrective work (PRI-718 revise-ne-resume)', task: { taskId: 'artificer-repair-evaluator-x-r1' } as TaskRecord }))
      .toBe('repair task artificer-repair-evaluator-x-r1 already reached terminal status succeeded; refusing to reuse it as new corrective work (PRI-718 revise-ne-resume)');
    expect(repairSeedErrorMessage(failure('malformed_repair_payload', 'repairPayload failed structural validation')))
      .toBe('evaluator_repair_seed_lineage_refused:malformed_repair_payload:repairPayload failed structural validation');
    expect(repairSeedErrorMessage(failure('repair_correlation_conflicts_authoritative', 'task=artificer-repair-evaluator-x-r1;correlationId=cand-foreign;authoritative=cand-a')))
      .toBe('evaluator_repair_seed_lineage_refused:repair_correlation_conflicts_authoritative:task=artificer-repair-evaluator-x-r1;correlationId=cand-foreign;authoritative=cand-a');
    expect(repairSeedErrorMessage(failure('unique_violation_without_verified_repair', 'task=artificer-repair-evaluator-x-r1;insert collided but no repair row is visible')))
      .toBe('evaluator_repair_seed_lineage_refused:unique_violation_without_verified_repair:task=artificer-repair-evaluator-x-r1;insert collided but no repair row is visible');
  });

  it('preserves the legacy structured reason shape for adoption/reuse failures', () => {
    expect(repairSeedErrorMessage({
      ...failure('repair_source_evaluator_missing', 'source=evaluator-x'),
      failureStage: 'adoption' as const,
    })).toBe('evaluator_repair_seed_lineage_refused:repair_source_evaluator_missing:source=evaluator-x');
    expect(repairSeedErrorMessage({
      ...failure('repair_source_lineage_unprovable', 'source=evaluator-x;missing_correlation_id_lineage:root_not_dreamer'),
      failureStage: 'adoption' as const,
    })).toBe('evaluator_repair_seed_lineage_refused:repair_source_lineage_unprovable:source=evaluator-x;missing_correlation_id_lineage:root_not_dreamer');
  });
});
