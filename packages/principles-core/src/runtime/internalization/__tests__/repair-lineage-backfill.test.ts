/**
 * PRI-1300 回归 — validateAndBackfillRepairLineage (真实 sqlite):
 *   repair 血缘校验 + 六项快照前提 CAS 回填的唯一写侧实现。
 *
 * 覆盖矩阵 (工单验收):
 *   - 来源 evaluator 缺失 / 非 evaluator / 权威血缘不可证明 → 结构化拒绝, 零写入;
 *   - repair metadata 不可 hydrate → repair_identity_unreadable_metadata
 *     (verify 词汇透传; 'invalid_task_metadata' 是防御性分支 — hydrate 为纯
 *     函数, 验证通过后正常不可达);
 *   - parent 冲突 / correlation 冲突 → 拒绝且原值不被覆盖;
 *   - CAS 失败 → concurrent_modification, 无部分写入;
 *   - 合法完整任务 → backfilled=false 且零写入;
 *   - 合法缺字段任务 → backfilled=true, merge 保持其余字段;
 *   - 回填使用六项快照前提 (diagnosticJson + status/attemptCount/maxAttempts/
 *     leaseOwner/leaseExpiresAt/leaseGeneration) — 参数捕获 + 行为双证明;
 *   - 窄接口契约: 全部用例经仅含 getTask/listTasks/
 *     updateTaskIfDiagnosticJsonUnchanged 三方法的结构对象驱动 — 实现若
 *     退回 fat RuntimeStateManager 的其它方法即红。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import type { TaskRecord } from '../../task-status.js';
import {
  validateAndBackfillRepairLineage,
  type RepairLineageBackfillStore,
  type ValidateAndBackfillRepairLineageParams,
} from '../repair-lineage-backfill.js';
import { artificerRepairTaskId, PI_METADATA_KEY, hydratePITaskRecord } from '../pitask-metadata.js';

const CAND = 'cand-p1300';

let workspaceDir: string;
let sm: RuntimeStateManager;

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-p1300-'));
  sm = new RuntimeStateManager({ workspaceDir });
  await sm.initialize();
});

afterEach(async () => {
  await sm.close();
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
});

function need<T>(v: T | null | undefined, label: string): T {
  if (v === null || v === undefined) throw new Error(`expected ${label}`);
  return v;
}

/**
 * 窄接口契约证明: 测试只经三方法结构对象驱动实现 — 不传入 RuntimeStateManager
 * 本体。若实现暗中依赖窄接口以外的方法, 类型层与运行时双重变红。
 */
function narrowStore(): RepairLineageBackfillStore {
  return {
    getTask: (taskId: string) => sm.getTask(taskId),
    listTasks: (filter?: Parameters<RuntimeStateManager['listTasks']>[0]) => sm.listTasks(filter),
    // eslint-disable-next-line @typescript-eslint/max-params -- CAS 签名与生产 store 同形 (第 4 参为前提集而非写载荷), 透传折入会失真。
    updateTaskIfDiagnosticJsonUnchanged: (taskId, expectedDiagnosticJson, patch, options) =>
      sm.updateTaskIfDiagnosticJsonUnchanged(taskId, expectedDiagnosticJson, patch, options),
  };
}

function repairPayloadOf(ev: string, iteration: number) {
  return {
    requiredChanges: ['x'], concerns: [], previousScore: 0.3,
    repairIteration: iteration, sourceArtificerArtifactId: 'art-1', sourceEvaluatorTaskId: ev,
  };
}

interface SeedMeta {
  parentTaskId?: string;
  correlationId?: string;
  topCandidateId?: string;
  dependencyTaskIds?: string[];
  runnerDecision?: string;
  repairPayload?: ReturnType<typeof repairPayloadOf>;
  channel?: string;
}

// eslint-disable-next-line @typescript-eslint/max-params -- 夹具四参形态与同目录 round7 集成测试惯例一致
async function mkTask(
  taskId: string,
  taskKind: string,
  status: 'pending' | 'succeeded' | 'needs_human_review' | 'retry_wait' | 'failed',
  meta: SeedMeta,
): Promise<string> {
  await sm.createTask({
    taskId,
    taskKind,
    status,
    attemptCount: status === 'succeeded' ? 1 : 0,
    maxAttempts: 3,
    diagnosticJson: JSON.stringify({
      [PI_METADATA_KEY]: {
        dependencyTaskIds: meta.dependencyTaskIds ?? [],
        channel: meta.channel ?? 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        runnerDecision: meta.runnerDecision,
        ...(meta.parentTaskId !== undefined ? { parentTaskId: meta.parentTaskId } : {}),
        ...(meta.correlationId !== undefined ? { correlationId: meta.correlationId } : {}),
        ...(meta.repairPayload !== undefined ? { repairPayload: meta.repairPayload } : {}),
      },
      ...(meta.topCandidateId !== undefined ? { candidateId: meta.topCandidateId } : {}),
    }),
  });
  return taskId;
}

/** 现代链: dreamer→philosopher→scribe→artificer→evaluator (parentTaskId 全程)。 */
async function seedModernChainToEvaluator(prefix: string) {
  await mkTask('dreamer-root', 'dreamer', 'succeeded', { correlationId: CAND, topCandidateId: CAND });
  const ph = await mkTask(prefix + '-philosopher', 'philosopher', 'succeeded', { parentTaskId: 'dreamer-root', correlationId: CAND });
  const sc = await mkTask(prefix + '-scribe', 'scribe', 'succeeded', { parentTaskId: ph, correlationId: CAND });
  const art = await mkTask(prefix + '-artificer', 'artificer', 'succeeded', { parentTaskId: sc, correlationId: CAND, dependencyTaskIds: [sc] });
  const ev = await mkTask(prefix + '-evaluator', 'evaluator', 'succeeded', { parentTaskId: art, correlationId: CAND, dependencyTaskIds: [art], runnerDecision: 'needs_revision' });
  return { ph, sc, art, ev };
}

async function seedRepairTask(ev: string, iteration: number, opts?: {
  omitLineage?: boolean; parentOverride?: string; correlationOverride?: string;
  omitPayload?: boolean; lease?: boolean; extraDiagnosticFields?: Record<string, unknown>;
}): Promise<string> {
  const taskId = artificerRepairTaskId(ev, iteration);
  const meta: SeedMeta = {
    ...(opts?.omitPayload === true ? {} : { repairPayload: repairPayloadOf(ev, iteration) }),
  };
  if (opts?.omitLineage !== true) {
    meta.parentTaskId = opts?.parentOverride ?? ev;
    meta.correlationId = opts?.correlationOverride ?? CAND;
  }
  await sm.createTask({
    taskId,
    taskKind: 'artificer',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    ...(opts?.lease === true
      ? { leaseOwner: 'worker-1', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), leaseGeneration: 2 }
      : {}),
    diagnosticJson: JSON.stringify({
      [PI_METADATA_KEY]: {
        dependencyTaskIds: ['scribe-x'],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        ...(meta.parentTaskId !== undefined ? { parentTaskId: meta.parentTaskId } : {}),
        ...(meta.correlationId !== undefined ? { correlationId: meta.correlationId } : {}),
        ...(meta.repairPayload !== undefined ? { repairPayload: meta.repairPayload } : {}),
      },
      ...(opts?.extraDiagnosticFields ?? {}),
    }),
  });
  return taskId;
}

// eslint-disable-next-line @typescript-eslint/max-params -- existingOverride 是并发用例的陈旧快照注入点, 折入参数对象会让三参主路径背负可选噪声
async function runBackfill(repairTaskId: string, ev: string, iteration: number, existingOverride?: TaskRecord) {
  const existing = existingOverride ?? need(await sm.getTask(repairTaskId), repairTaskId + ' row');
  const params: ValidateAndBackfillRepairLineageParams = {
    repairTaskId,
    existing,
    sourceEvaluatorTaskId: ev,
    repairIteration: iteration,
  };
  return validateAndBackfillRepairLineage(params, narrowStore());
}

describe('validateAndBackfillRepairLineage — 合法路径', () => {
  it('血缘完整的合法任务 → ok + backfilled=false + 零写入 (diagnosticJson 逐字节不变)', async () => {
    const { ev } = await seedModernChainToEvaluator('full');
    const rep = await seedRepairTask(ev, 1);
    const before = need(await sm.getTask(rep), 'rep').diagnosticJson;
    const r = await runBackfill(rep, ev, 1);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.backfilled).toBe(false);
      expect(r.authoritativeCorrelationId).toBe(CAND);
    }
    expect(need(await sm.getTask(rep), 'rep after').diagnosticJson).toBe(before);
  });

  it('缺 parent/correlation 的合法历史任务 → ok + backfilled=true, merge 保持其余字段', async () => {
    const { ev } = await seedModernChainToEvaluator('bk');
    const rep = await seedRepairTask(ev, 1, { omitLineage: true });
    const r = await runBackfill(rep, ev, 1);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.backfilled).toBe(true);
      expect(r.authoritativeCorrelationId).toBe(CAND);
    }
    const after = hydratePITaskRecord(need(await sm.getTask(rep), 'rep after'));
    expect(after?.parentTaskId).toBe(ev);
    expect(after?.correlationId).toBe(CAND);
    // merge 而非重建 — payload / dependency / 状态全部保持。
    expect(after?.repairPayload?.sourceEvaluatorTaskId).toBe(ev);
    expect(after?.dependencyTaskIds).toContain('scribe-x');
    expect(after?.channel).toBe('prompt');
    expect(need(await sm.getTask(rep), 'rep after row').status).toBe('pending');
  });

  it('CAS 回填只替换 pi_metadata 信封 → diagnosticJson 根上的 Runner 诊断证据不丢失', async () => {
    const { ev } = await seedModernChainToEvaluator('siblings');
    const rep = await seedRepairTask(ev, 1, {
      omitLineage: true,
      extraDiagnosticFields: {
        lastValidatorErrors: ['validator evidence'],
        output_failure_details: { kind: 'validator_failed' },
        validator_error_history: [{ round: 1, message: 'keep-me' }],
      },
    });
    const r = await runBackfill(rep, ev, 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.backfilled).toBe(true);
    const raw = need(await sm.getTask(rep), 'rep after').diagnosticJson;
    const parsed: unknown = JSON.parse(raw ?? '{}');
    const root = parsed as Record<string, unknown>;
    expect(root.lastValidatorErrors).toEqual(['validator evidence']);
    expect(root.output_failure_details).toEqual({ kind: 'validator_failed' });
    expect(root.validator_error_history).toEqual([{ round: 1, message: 'keep-me' }]);
    const pi = hydratePITaskRecord(need(await sm.getTask(rep), 'rep after hydrate'));
    expect(pi?.parentTaskId).toBe(ev);
    expect(pi?.correlationId).toBe(CAND);
  });

  it('仅缺 correlation (parent 已在且一致) → 仍 backfilled=true 且 parent 不被改写', async () => {
    const { ev } = await seedModernChainToEvaluator('pc-only');
    const taskId = artificerRepairTaskId(ev, 1);
    await sm.createTask({
      taskId,
      taskKind: 'artificer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        [PI_METADATA_KEY]: {
          dependencyTaskIds: ['scribe-x'],
          channel: 'prompt',
          timeoutMs: 300_000,
          inputArtifactRefs: [],
          outputArtifactRefs: [],
          parentTaskId: ev,
          repairPayload: repairPayloadOf(ev, 1),
        },
      }),
    });
    const r = await runBackfill(taskId, ev, 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.backfilled).toBe(true);
    const after = hydratePITaskRecord(need(await sm.getTask(taskId), 'after'));
    expect(after?.parentTaskId).toBe(ev);
    expect(after?.correlationId).toBe(CAND);
  });
});

describe('validateAndBackfillRepairLineage — 拒绝矩阵 (零写入)', () => {
  it('repairTaskId 与 existing.taskId 不一致 → repair_task_id_mismatch, fail fast 零写入', async () => {
    const { ev } = await seedModernChainToEvaluator('idmm');
    const rep = await seedRepairTask(ev, 1, { omitLineage: true });
    const existing = need(await sm.getTask(rep), 'rep');
    const before = existing.diagnosticJson;
    const r = await validateAndBackfillRepairLineage(
      { repairTaskId: rep + '-wrong-target', existing, sourceEvaluatorTaskId: ev, repairIteration: 1 },
      narrowStore(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('repair_task_id_mismatch');
      expect(r.detail).toContain('wrong-target');
    }
    expect(need(await sm.getTask(rep), 'rep after').diagnosticJson).toBe(before);
  });

  it('来源 evaluator 缺失 → repair_source_evaluator_missing, 零写入', async () => {
    // payload 与确定性 taskId 互证一致, 但 payload 指向的来源从未存在。
    const ghost = 'evaluator-never-existed';
    const rep = await seedRepairTask(ghost, 1);
    const before = need(await sm.getTask(rep), 'rep').diagnosticJson;
    const r = await runBackfill(rep, ghost, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('repair_source_evaluator_missing');
    expect(need(await sm.getTask(rep), 'rep after').diagnosticJson).toBe(before);
  });

  it('来源不是 evaluator → repair_source_not_evaluator', async () => {
    const { art } = await seedModernChainToEvaluator('ne');
    const rep = await seedRepairTask(art, 1);
    const r = await runBackfill(rep, art, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('repair_source_not_evaluator');
  });

  it('权威血缘不可证明 (孤儿 evaluator) → repair_source_lineage_unprovable, 零写入', async () => {
    await mkTask('evaluator-orphan-p1300', 'evaluator', 'succeeded', { runnerDecision: 'needs_revision' });
    const rep = await seedRepairTask('evaluator-orphan-p1300', 1, { omitLineage: true });
    const before = need(await sm.getTask(rep), 'rep').diagnosticJson;
    const r = await runBackfill(rep, 'evaluator-orphan-p1300', 1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('repair_source_lineage_unprovable');
      expect(r.detail).toContain('evaluator-orphan-p1300');
    }
    // 零写入 — 缺字段不被补齐。
    expect(need(await sm.getTask(rep), 'rep after').diagnosticJson).toBe(before);
  });

  it('repair metadata 不可 hydrate → repair_identity_unreadable_metadata (verify 词汇)', async () => {
    const { ev } = await seedModernChainToEvaluator('uh');
    const rep = artificerRepairTaskId(ev, 1);
    await sm.createTask({
      taskId: rep,
      taskKind: 'artificer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      // store 写入侧拒绝 malformed JSON — 合法 JSON 但缺 pi_metadata 同样
      // 使 hydratePITaskRecord 返回 null (parsePITaskMetadata 找不到元数据信封)。
      diagnosticJson: '{"no_pi_metadata_envelope":true}',
    });
    const r = await runBackfill(rep, ev, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('repair_identity_unreadable_metadata');
  });

  it('repairPayload 缺失 → repair_payload_missing (fail-closed, 不得猜测来源)', async () => {
    const { ev } = await seedModernChainToEvaluator('np');
    const rep = await seedRepairTask(ev, 1, { omitPayload: true });
    const r = await runBackfill(rep, ev, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('repair_payload_missing');
  });

  it('parentTaskId 与 payload 来源冲突 → repair_parent_conflicts_payload_source, 原值不覆盖', async () => {
    const { ev } = await seedModernChainToEvaluator('cf');
    const rep = await seedRepairTask(ev, 1, { parentOverride: 'someone-else' });
    const r = await runBackfill(rep, ev, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('repair_parent_conflicts_payload_source');
    const after = hydratePITaskRecord(need(await sm.getTask(rep), 'after'));
    expect(after?.parentTaskId).toBe('someone-else');
  });

  it('correlationId 与权威来源冲突 → repair_correlation_conflicts_authoritative, 原值不覆盖', async () => {
    const { ev } = await seedModernChainToEvaluator('cc');
    const rep = await seedRepairTask(ev, 1, { correlationOverride: 'cand-foreign' });
    const r = await runBackfill(rep, ev, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('repair_correlation_conflicts_authoritative');
    const after = hydratePITaskRecord(need(await sm.getTask(rep), 'after'));
    expect(after?.correlationId).toBe('cand-foreign');
  });
});

describe('validateAndBackfillRepairLineage — CAS 六项快照前提', () => {
  it('参数证明: 回填调用携带 diagnosticJson + 五项行级前提, 全部取自读取快照', async () => {
    const { ev } = await seedModernChainToEvaluator('cap');
    const rep = await seedRepairTask(ev, 1, { omitLineage: true, lease: true });
    const existing = need(await sm.getTask(rep), 'rep');
    expect(existing.leaseOwner).toBe('worker-1');
    expect(existing.leaseGeneration).toBe(2);

    type CapturedCasCall = {
      taskId: string;
      expectedDiagnosticJson: string | null;
      options?: Record<string, unknown>;
    };
    let captured: CapturedCasCall | null = null;
    const capturingStore: RepairLineageBackfillStore = {
      getTask: (taskId: string) => sm.getTask(taskId),
      listTasks: (filter?: Parameters<RuntimeStateManager['listTasks']>[0]) => sm.listTasks(filter),
      // eslint-disable-next-line @typescript-eslint/max-params -- CAS 签名与生产 store 同形 (第 4 参为前提集而非写载荷), 参数捕获必须逐形透传
      updateTaskIfDiagnosticJsonUnchanged: async (taskId, expectedDiagnosticJson, patch, options) => {
        captured = { taskId, expectedDiagnosticJson, options: options as Record<string, unknown> };
        return sm.updateTaskIfDiagnosticJsonUnchanged(taskId, expectedDiagnosticJson, patch, options);
      },
    };
    const r = await validateAndBackfillRepairLineage(
      { repairTaskId: rep, existing, sourceEvaluatorTaskId: ev, repairIteration: 1 },
      capturingStore,
    );
    expect(r.ok).toBe(true);
    const got = need<CapturedCasCall>(captured, 'captured CAS call');
    expect(got.taskId).toBe(rep);
    // diagnosticJson 逐字节前提。
    expect(got.expectedDiagnosticJson).toBe(existing.diagnosticJson ?? null);
    // 五项行级快照前提 — 六项全部齐备, 缺任一此测试即红。
    expect(got.options?.expectedStatus).toBe(existing.status);
    expect(got.options?.expectedAttemptCount).toBe(existing.attemptCount);
    expect(got.options?.expectedMaxAttempts).toBe(existing.maxAttempts);
    expect(got.options?.expectedLeaseOwner).toBe('worker-1');
    expect(got.options?.expectedLeaseExpiresAt).toBe(existing.leaseExpiresAt ?? null);
    expect(got.options?.expectedLeaseGeneration).toBe(2);
  });

  it('行为证明: 快照后并发触碰 (status 翻转) → concurrent_modification, 无部分写入', async () => {
    const { ev } = await seedModernChainToEvaluator('race');
    const rep = await seedRepairTask(ev, 1, { omitLineage: true });
    const stale = need(await sm.getTask(rep), 'stale snapshot');
    // 并发写入者在你读完快照后翻转状态 (不碰 diagnosticJson — 证明行级前提
    // 独立生效, 不是只有 diagnosticJson 在守门)。
    await sm.updateTask(rep, { status: 'retry_wait' });
    const jsonBeforeCas = need(await sm.getTask(rep), 'before cas').diagnosticJson;
    const r = await runBackfill(rep, ev, 1, stale);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('concurrent_modification');
    // 无部分写入: diagnosticJson 逐字节保持并发写入后的值 (parent/correlation 未补);
    // 并发写入者的 status 翻转不被回滚。
    const after = need(await sm.getTask(rep), 'after');
    expect(after.diagnosticJson).toBe(jsonBeforeCas);
    expect(hydratePITaskRecord(after)?.parentTaskId).toBeUndefined();
    expect(hydratePITaskRecord(after)?.correlationId).toBeUndefined();
    expect(after.status).toBe('retry_wait');
  });

  it('行为证明: 快照后被并发 lease (generation 轮换) → concurrent_modification, 无部分写入', async () => {
    const { ev } = await seedModernChainToEvaluator('gen');
    const rep = await seedRepairTask(ev, 1, { omitLineage: true });
    const stale = need(await sm.getTask(rep), 'stale snapshot');
    expect(stale.leaseOwner ?? null).toBeNull();
    // 并发执行器经真实通道 acquireLease — owner/expires/generation 全部离开
    // 快照 (generation 0→1)。diagnosticJson 不动: 证明行级 lease 前提独立守门。
    await sm.acquireLease({ taskId: rep, owner: 'worker-concurrent', runtimeKind: 'test-double', durationMs: 60_000 });
    const leased = need(await sm.getTask(rep), 'leased');
    expect(leased.leaseOwner).toBe('worker-concurrent');
    const jsonBeforeCas = leased.diagnosticJson;
    const r = await runBackfill(rep, ev, 1, stale);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('concurrent_modification');
    // 无部分写入: 并发 lease 不被回滚, 亲缘字段未补。
    const after = need(await sm.getTask(rep), 'after');
    expect(after.diagnosticJson).toBe(jsonBeforeCas);
    expect(after.leaseOwner).toBe('worker-concurrent');
    expect(hydratePITaskRecord(after)?.parentTaskId).toBeUndefined();
    expect(hydratePITaskRecord(after)?.correlationId).toBeUndefined();
  });
});
