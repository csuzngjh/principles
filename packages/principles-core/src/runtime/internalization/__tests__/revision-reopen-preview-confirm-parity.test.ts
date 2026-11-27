/**
 * PRI-1299 P2 — revision transition preview/confirm parity (真实 sqlite)。
 *
 * 评审缺陷: repair reopen 的只读预览把**初始 leased** 的来源 evaluator 分类为
 * concurrent_modification, 而 confirm (reopenTaskForRevision 第一快照门) 对同一
 * 静态快照分类为 task_in_flight_leased / revision_reopen_failed。
 * concurrent_modification 是竞争结果分类 — 只属于 confirm 的血缘校验期间状态
 * 漂移 / CAS 并发落败; 单次快照的只读预览不存在竞争窗口, 永远不得产出它。
 *
 * 修复: planRevisionReopenInitialState (revision-reopen.ts) 是初始状态判定的
 * 唯一纯权威, preview 与 confirm 共享。本文件在**同一数据库快照**上比较两侧:
 *   - 业务 decision / 拒绝类别 / 写权限必须一致 (不要求对象形状逐字相同);
 *   - 预览永远零写入;
 *   - concurrent_modification 仅在漂移/竞速注入时出现, 且不覆盖并发写。
 *
 * 覆盖矩阵 (评审要求): missing task / invalid metadata / same-cause consumed /
 * pending / retry_wait / succeeded / needs_human_review / leased / failed /
 * 其他非可 reopen 状态 — 纯规划器全量矩阵 + sqlite 集成关键路径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { InternalizationOrchestrator } from '../internalization-orchestrator.js';
import {
  reopenTaskForRevision,
  planRevisionReopenInitialState,
  buildRepairRevisionCauseId,
} from '../revision-reopen.js';
import { hydratePITaskRecord, artificerRepairTaskId, PI_METADATA_KEY } from '../pitask-metadata.js';
import type { TaskRecord } from '../../task-status.js';

const CAND = 'cand-parity';

let workspaceDir: string;
let sm: RuntimeStateManager;

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-parity-'));
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

interface SeedMeta {
  parentTaskId?: string;
  correlationId?: string;
  topCandidateId?: string;
  dependencyTaskIds?: string[];
  runnerDecision?: string;
  repairPayload?: {
    requiredChanges: string[]; concerns: string[]; previousScore: number;
    repairIteration: number; sourceArtificerArtifactId: string; sourceEvaluatorTaskId: string;
  };
  revisionCount?: number;
  revisionCauseId?: string;
  consumedRevisionCauseIds?: string[];
  humanReviewContext?: Record<string, unknown>;
  sourceCorrectionCauseId?: string;
  sourceCorrectionReceipt?: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/max-params -- 夹具四参形态与同目录集成测试惯例一致
async function mkTask(
  taskId: string,
  taskKind: string,
  status: 'pending' | 'leased' | 'succeeded' | 'needs_human_review' | 'retry_wait' | 'failed',
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
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        runnerDecision: meta.runnerDecision,
        ...(meta.parentTaskId !== undefined ? { parentTaskId: meta.parentTaskId } : {}),
        ...(meta.correlationId !== undefined ? { correlationId: meta.correlationId } : {}),
        ...(meta.repairPayload !== undefined ? { repairPayload: meta.repairPayload } : {}),
        ...(meta.revisionCount !== undefined ? { revisionCount: meta.revisionCount } : {}),
        ...(meta.revisionCauseId !== undefined ? { revisionCauseId: meta.revisionCauseId } : {}),
        ...(meta.consumedRevisionCauseIds !== undefined ? { consumedRevisionCauseIds: meta.consumedRevisionCauseIds } : {}),
        ...(meta.humanReviewContext !== undefined ? { humanReviewContext: meta.humanReviewContext } : {}),
        ...(meta.sourceCorrectionCauseId !== undefined ? { sourceCorrectionCauseId: meta.sourceCorrectionCauseId } : {}),
        ...(meta.sourceCorrectionReceipt !== undefined ? { sourceCorrectionReceipt: meta.sourceCorrectionReceipt } : {}),
      },
      ...(meta.topCandidateId !== undefined ? { candidateId: meta.topCandidateId } : {}),
    }),
  });
  return taskId;
}

/** 现代链: dreamer→philosopher→scribe→artificer→evaluator (parentTaskId 全程, 无需回填)。dreamer id per-prefix — 单测试多链不撞 UNIQUE。 */
async function seedModernChainToEvaluator(prefix: string, evMeta?: Partial<SeedMeta> & { status?: 'pending' | 'leased' | 'succeeded' | 'needs_human_review' | 'retry_wait' | 'failed' }) {
  await mkTask(prefix + '-dreamer', 'dreamer', 'succeeded', { correlationId: CAND, topCandidateId: CAND });
  const ph = await mkTask(prefix + '-philosopher', 'philosopher', 'succeeded', { parentTaskId: prefix + '-dreamer', correlationId: CAND });
  const sc = await mkTask(prefix + '-scribe', 'scribe', 'succeeded', { parentTaskId: ph, correlationId: CAND });
  const art = await mkTask(prefix + '-artificer', 'artificer', 'succeeded', { parentTaskId: sc, correlationId: CAND, dependencyTaskIds: [sc] });
  const { status: evStatus, ...restMeta } = evMeta ?? {};
  const ev = await mkTask(prefix + '-evaluator', 'evaluator', evStatus ?? 'succeeded', {
    parentTaskId: art, correlationId: CAND, dependencyTaskIds: [art], runnerDecision: 'needs_revision',
    ...restMeta,
  });
  return { ph, sc, art, ev };
}

async function seedRepairTask(ev: string, iteration: number): Promise<string> {
  const taskId = artificerRepairTaskId(ev, iteration);
  await mkTask(taskId, 'artificer', 'succeeded', {
    parentTaskId: ev,
    correlationId: CAND,
    repairPayload: {
      requiredChanges: ['x'], concerns: [], previousScore: 0.3,
      repairIteration: iteration, sourceArtificerArtifactId: 'art-1', sourceEvaluatorTaskId: ev,
    },
  });
  return taskId;
}

function orchestrator(stateManager?: RuntimeStateManager): InternalizationOrchestrator {
  return new InternalizationOrchestrator(
    { stateManager: stateManager ?? sm },
    { owner: 'parity-test', runtimeKind: 'test-double', dryRun: true },
  );
}

async function piOf(taskId: string) {
  const raw = need(await sm.getTask(taskId), taskId + ' row');
  return { raw, pi: need(hydratePITaskRecord(raw), taskId + ' pi') };
}

/** 全关键行的字节级快照 — 预览零写入断言输入。 */
async function snapshotRows(taskIds: readonly string[]): Promise<Map<string, string>> {
  const snap = new Map<string, string>();
  for (const id of taskIds) {
    const row = need(await sm.getTask(id), id + ' row');
    snap.set(id, JSON.stringify(row));
  }
  return snap;
}

async function expectRowsUnchanged(snap: Map<string, string>): Promise<void> {
  for (const [id, before] of snap) {
    const after = need(await sm.getTask(id), id + ' row after');
    expect(JSON.stringify(after), `row ${id} must be byte-identical after read-only preview`).toBe(before);
  }
}

// ── 纯规划器: 初始状态全矩阵 (missing/invalid/consumed/全状态) ──────────────

describe('planRevisionReopenInitialState — 初始状态判定全矩阵 (纯函数)', () => {
  function syntheticRaw(status: string, meta?: { revisionCauseId?: string; consumedRevisionCauseIds?: readonly string[]; invalidMetadata?: boolean }): TaskRecord {
    return {
      taskId: 'syn-ev',
      taskKind: 'evaluator',
      status: status as TaskRecord['status'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      attemptCount: 1,
      maxAttempts: 3,
      diagnosticJson: meta?.invalidMetadata === true
        ? '{not-json'
        : JSON.stringify({
          [PI_METADATA_KEY]: {
            dependencyTaskIds: [],
            channel: 'prompt',
            timeoutMs: 300_000,
            inputArtifactRefs: [],
            outputArtifactRefs: [],
            ...(meta?.revisionCauseId !== undefined ? { revisionCauseId: meta.revisionCauseId } : {}),
            ...(meta?.consumedRevisionCauseIds !== undefined ? { consumedRevisionCauseIds: [...meta.consumedRevisionCauseIds] } : {}),
          },
        }),
    };
  }

  it('missing task → task_not_found', () => {
    expect(planRevisionReopenInitialState(null, 'cause-x').plan).toBe('task_not_found');
  });

  it('invalid metadata → invalid_task_metadata', () => {
    expect(planRevisionReopenInitialState(syntheticRaw('succeeded', { invalidMetadata: true }), 'cause-x').plan).toBe('invalid_task_metadata');
  });

  it('same revisionCauseId consumed (当前槽) → idempotent replay, 任意状态', () => {
    const plan = planRevisionReopenInitialState(syntheticRaw('leased', { revisionCauseId: 'cause-x' }), 'cause-x');
    expect(plan.plan).toBe('idempotent_replay_same_revision');
  });

  it('same revisionCauseId consumed (历史折入) → idempotent replay', () => {
    const plan = planRevisionReopenInitialState(
      syntheticRaw('succeeded', { revisionCauseId: 'cause-other', consumedRevisionCauseIds: ['cause-x'] }),
      'cause-x',
    );
    expect(plan.plan).toBe('idempotent_replay_same_revision');
  });

  it('pending / retry_wait / succeeded / needs_human_review → proceed', () => {
    for (const status of ['pending', 'retry_wait', 'succeeded', 'needs_human_review']) {
      const plan = planRevisionReopenInitialState(syntheticRaw(status), 'cause-x');
      expect(plan.plan, `${status} must proceed`).toBe('proceed');
    }
  });

  it('leased → refused_in_flight task_in_flight_leased (绝非 concurrent 分类)', () => {
    const plan = planRevisionReopenInitialState(syntheticRaw('leased'), 'cause-x');
    expect(plan.plan).toBe('refused_in_flight');
    if (plan.plan === 'refused_in_flight') expect(plan.reason).toBe('task_in_flight_leased');
  });

  it('failed → refused_in_flight task_in_flight_failed', () => {
    const plan = planRevisionReopenInitialState(syntheticRaw('failed'), 'cause-x');
    expect(plan.plan).toBe('refused_in_flight');
    if (plan.plan === 'refused_in_flight') expect(plan.reason).toBe('task_in_flight_failed');
  });

  it('其他非可 reopen 状态 (非 canonical 自由串) → refused_in_flight task_in_flight_<status>', () => {
    const plan = planRevisionReopenInitialState(syntheticRaw('cancelled'), 'cause-x');
    expect(plan.plan).toBe('refused_in_flight');
    if (plan.plan === 'refused_in_flight') expect(plan.reason).toBe('task_in_flight_cancelled');
  });

  it('无 revisionCauseId → consumed 判定不触发 (退化兼容路径)', () => {
    const plan = planRevisionReopenInitialState(syntheticRaw('succeeded', { revisionCauseId: 'cause-x' }));
    expect(plan.plan).toBe('proceed');
  });
});

// ── Repair reopen: 同一快照 preview vs confirm ─────────────────────────────

describe('Repair reopen — 同一数据库快照 preview/confirm 业务分类一致', () => {
  it('初始 leased: 两侧同为 revision_reopen_failed/task_in_flight_leased — 绝非 concurrent_modification', async () => {
    const { ev } = await seedModernChainToEvaluator('il', { status: 'pending' });
    const rep = await seedRepairTask(ev, 1);
    // 初始 leased: 另一 consumer 正在执行 — 经真实 lease 获取路径落库
    // (fencing trigger 要求代际递增, 手工 patch  lease 字段不是生产形态)。
    const lease = await sm.acquireLeaseDetailed({ taskId: ev, owner: 'other-consumer', runtimeKind: 'test-double' });
    expect(lease.task.status).toBe('leased');
    const before = await snapshotRows([ev, rep]);

    const preview = await orchestrator().previewNextTaskTransitionGate(rep);
    expect(preview).not.toBeNull();
    expect(preview?.decision).toBe('revision_reopen_failed');
    expect(preview?.decision).not.toBe('concurrent_modification');
    if (preview?.decision === 'revision_reopen_failed') {
      expect(preview.reason).toBe('task_in_flight_leased');
    }
    // 预览零写入 — 行字节级不变。
    await expectRowsUnchanged(before);

    const confirm = await orchestrator().commitNextTaskProposal(rep);
    expect(confirm.decision).toBe('revision_reopen_failed');
    expect(confirm.decision).not.toBe('concurrent_modification');
    if (confirm.decision === 'revision_reopen_failed') {
      expect(confirm.reason).toBe('task_in_flight_leased');
    }

    // 业务类别一致 + 拒绝写权限一致: confirm 同样零写入 — lease/状态/verdict 原样。
    await expectRowsUnchanged(before);
    const { raw, pi } = await piOf(ev);
    expect(raw.status).toBe('leased');
    expect(raw.leaseOwner).toBe('other-consumer');
    expect(pi.revisionCount ?? 0).toBe(0);
    expect(pi.runnerDecision).toBe('needs_revision');

    // confirm 核心 (reopenTaskForRevision) 同一分类 — 业务拒绝而非并发反射。
    const direct = await reopenTaskForRevision(sm, ev, { revisionCauseId: 'cause-direct' });
    expect(direct.ok).toBe(false);
    expect(direct.reason).toBe('task_in_flight_leased');
  });

  it('初始 failed: 两侧同为 revision_reopen_failed/task_in_flight_failed', async () => {
    const { ev } = await seedModernChainToEvaluator('if-failed', { status: 'failed' });
    const rep = await seedRepairTask(ev, 1);
    const preview = await orchestrator().previewNextTaskTransitionGate(rep);
    expect(preview?.decision).toBe('revision_reopen_failed');
    if (preview?.decision === 'revision_reopen_failed') {
      expect(preview.reason).toBe('task_in_flight_failed');
    }
    const confirm = await orchestrator().commitNextTaskProposal(rep);
    expect(confirm.decision).toBe('revision_reopen_failed');
    if (confirm.decision === 'revision_reopen_failed') {
      expect(confirm.reason).toBe('task_in_flight_failed');
    }
  });

  it('可 reopen 状态矩阵 (pending/retry_wait/succeeded/needs_human_review): 两侧同为 revision_reopened', async () => {
    for (const status of ['pending', 'retry_wait', 'succeeded', 'needs_human_review'] as const) {
      const { ev } = await seedModernChainToEvaluator('pm-' + status, { status });
      const rep = await seedRepairTask(ev, 1);
      const before = await snapshotRows([ev, rep]);
      const preview = await orchestrator().previewNextTaskTransitionGate(rep);
      expect(preview?.decision, `preview ${status}`).toBe('revision_reopened');
      await expectRowsUnchanged(before); // 预览零写入
      const confirm = await orchestrator().commitNextTaskProposal(rep);
      expect(confirm.decision, `confirm ${status}`).toBe('revision_reopened');
      if (confirm.decision === 'revision_reopened') {
        expect(confirm.reopenedTaskId).toBe(ev);
      }
      // confirm 是唯一写侧: reopen 已物化 — pending + epoch 推进 + cause 消费。
      const { raw, pi } = await piOf(ev);
      expect(raw.status).toBe('pending');
      expect(pi.revisionCount).toBe(1);
    }
  });

  it('血缘校验期间变为 leased: confirm 分类 concurrent_modification (漂移), 并发 lease 不被覆盖', async () => {
    const { ev } = await seedModernChainToEvaluator('dr', { status: 'pending' });
    const rep = await seedRepairTask(ev, 1);

    // 漂移前静态快照: 预览诚实报告将 reopen (世界未变时的计划)。
    const previewBefore = await orchestrator().previewNextTaskTransitionGate(rep);
    expect(previewBefore?.decision).toBe('revision_reopened');
    expect(previewBefore?.decision).not.toBe('concurrent_modification');

    // 注入: 血缘链遍历读取非目标行时, 另一 consumer 取得 lease —
    // 第二快照看到 leased = 校验期间漂移 (round7 测试B 交织形态)。
    const origGetTask = sm.getTask.bind(sm);
    let injected = false;
    const wrapped = Object.create(Object.getPrototypeOf(sm)) as RuntimeStateManager;
    Object.assign(wrapped, sm);
    wrapped.getTask = async (id: string) => {
      const r = await origGetTask(id);
      if (!injected && id !== ev) {
        injected = true;
        // 真实 lease 获取路径 (fencing 代际) — 模拟另一 consumer 在血缘
        // 校验窗口内竞得执行权。
        await sm.acquireLeaseDetailed({ taskId: ev, owner: 'racing-consumer', runtimeKind: 'test-double' });
      }
      return r;
    };
    const drifted = await reopenTaskForRevision(wrapped, ev, { revisionCauseId: 'cause-drift' });
    expect(injected).toBe(true);
    expect(drifted.ok).toBe(false);
    expect(drifted.reason).toBe('concurrent_modification');
    expect(drifted.detail ?? '').toContain('task_leased_during_lineage_validation');
    // 并发 lease 与业务状态不被覆盖 — epoch 未推进, verdict 未清。
    const { raw, pi } = await piOf(ev);
    expect(raw.status).toBe('leased');
    expect(raw.leaseOwner).toBe('racing-consumer');
    expect(pi.revisionCount ?? 0).toBe(0);
    expect(pi.runnerDecision).toBe('needs_revision');

    // 漂移后静态快照: 预览与静态 confirm 重新一致 — leased 是业务拒绝,
    // concurrent_modification 只属于漂移窗口本身。
    const previewAfter = await orchestrator().previewNextTaskTransitionGate(rep);
    expect(previewAfter?.decision).toBe('revision_reopen_failed');
    expect(previewAfter?.decision).not.toBe('concurrent_modification');
    if (previewAfter?.decision === 'revision_reopen_failed') {
      expect(previewAfter.reason).toBe('task_in_flight_leased');
    }
    const confirmAfter = await orchestrator().commitNextTaskProposal(rep);
    expect(confirmAfter.decision).toBe('revision_reopen_failed');
    if (confirmAfter.decision === 'revision_reopen_failed') {
      expect(confirmAfter.reason).toBe('task_in_flight_leased');
    }
  });

  it('CAS 并发落败: confirm 分类 concurrent_modification (竞速), reopen 不写, 并发写保留', async () => {
    const { ev } = await seedModernChainToEvaluator('cas', { status: 'succeeded' });
    const rep = await seedRepairTask(ev, 1);
    const attemptBefore = (await piOf(ev)).raw.attemptCount;

    // 同一快照: 预览计划 reopen (零写入)。
    const before = await snapshotRows([ev, rep]);
    const preview = await orchestrator().previewNextTaskTransitionGate(rep);
    expect(preview?.decision).toBe('revision_reopened');
    await expectRowsUnchanged(before);

    // 注入: 目标行 CAS 尝试瞬间先执行一次无关并发写 — 前提必然落败。
    // 现代链无血缘回填边, 该 ev 的首次 CAS 即 reopen 写。
    const origCas = sm.updateTaskIfDiagnosticJsonUnchanged.bind(sm);
    let injected = false;
    const wrapped = Object.create(Object.getPrototypeOf(sm)) as RuntimeStateManager;
    Object.assign(wrapped, sm);
    wrapped.updateTaskIfDiagnosticJsonUnchanged = async (
      ...args: Parameters<RuntimeStateManager['updateTaskIfDiagnosticJsonUnchanged']>
    ) => {
      const [taskId] = args;
      if (taskId === ev && !injected) {
        injected = true;
        await sm.updateTask(ev, { attemptCount: attemptBefore + 1 }); // 并发无关写
      }
      return origCas(...args);
    };
    const confirm = await orchestrator(wrapped).commitNextTaskProposal(rep);
    expect(injected).toBe(true);
    expect(confirm.decision).toBe('concurrent_modification');
    // 竞速分类 pin: detail 必须指向 CAS 前提落败, 而非漂移/初始 leased 措辞 —
    // 三类 concurrent 反射在 confirm 内部仍可区分, 不混同。
    if (confirm.decision === 'concurrent_modification') {
      expect(confirm.detail).toContain('cas_precondition_failed');
    }

    // reopen 未写: 并发写 (attemptCount+1) 原样保留, 状态/epoch/verdict/cause 未动。
    const { raw, pi } = await piOf(ev);
    expect(raw.status).toBe('succeeded');
    expect(raw.attemptCount).toBe(attemptBefore + 1);
    expect(pi.revisionCount ?? 0).toBe(0);
    expect(pi.runnerDecision).toBe('needs_revision');
    expect(pi.revisionCauseId ?? '').not.toBe(buildRepairRevisionCauseId((await piOf(rep)).pi));
  });

  it('来源 evaluator 缺失: 两侧同为 lineage_refused (身份验证 fail-closed 先于 reopen 规划)', async () => {
    const { ev } = await seedModernChainToEvaluator('mt', { status: 'succeeded' });
    const rep = await seedRepairTask(ev, 1);
    // 删除来源 evaluator — repair payload 指向不存在的行。
    // (sqlite 无外键, 直接 DELETE 模拟历史腐蚀/手工清理后的快照。)
    // 注意分层: verifyRepairTaskIdentity 在两侧都先于 reopen 初始状态规划 —
    // 来源缺失在身份门禁即 fail-closed (lineage_refused), 静态快照下永远到不了
    // 规划器的 task_not_found 分支 (该分支为竞速窗口防御 — 验证后消失的并发
    // 删除)。两侧同一门禁同一分类 = parity。
    sm.connection.getDb().prepare('DELETE FROM tasks WHERE task_id = ?').run(ev);
    const before = await snapshotRows([rep]);
    const preview = await orchestrator().previewNextTaskTransitionGate(rep);
    expect(preview?.decision).toBe('lineage_refused');
    if (preview?.decision === 'lineage_refused') {
      expect(preview.reason).toBe('repair_source_evaluator_missing');
    }
    await expectRowsUnchanged(before);
    const confirm = await orchestrator().commitNextTaskProposal(rep);
    expect(confirm.decision).toBe('lineage_refused');
    if (confirm.decision === 'lineage_refused') {
      expect(confirm.reason).toBe('repair_source_evaluator_missing');
    }
    await expectRowsUnchanged(before); // confirm 同样零写入 — 身份拒绝先于任何 mutation
  });

  it('来源 evaluator metadata 损坏 (合法 JSON 非法 PI metadata): 两侧同为 lineage_refused/repair_source_unreadable_metadata', async () => {
    const { ev } = await seedModernChainToEvaluator('im', { status: 'succeeded' });
    const rep = await seedRepairTask(ev, 1);
    // sqlite 层 json_valid 约束不允许写入语法损坏的 JSON — 生产中的"invalid
    // metadata"真实形态是合法 JSON 但 PI metadata 结构/语义不可解析。
    // 分层同上: 身份验证 hydrate 失败即 fail-closed, 两侧同一分类。
    await sm.updateTask(ev, { diagnosticJson: JSON.stringify({ [PI_METADATA_KEY]: { dependencyTaskIds: 'not-an-array' } }) });
    const preview = await orchestrator().previewNextTaskTransitionGate(rep);
    const confirm = await orchestrator().commitNextTaskProposal(rep);
    expect(preview?.decision).toBe(confirm.decision);
    expect(preview?.decision).toBe('lineage_refused');
    if (preview?.decision === 'lineage_refused' && confirm.decision === 'lineage_refused') {
      expect(preview.reason).toBe('repair_source_unreadable_metadata');
      expect(confirm.reason).toBe('repair_source_unreadable_metadata');
    }
  });

  it('same-cause replay: 两侧同为 revision_reopen_noop, confirm 零写入', async () => {
    // 先物化一次 reopen — 随后同一 repair 完成 transition 的重放必须幂等。
    const { ev } = await seedModernChainToEvaluator('sc', { status: 'succeeded' });
    const rep = await seedRepairTask(ev, 1);
    const causeId = buildRepairRevisionCauseId((await piOf(rep)).pi);
    // 直接种入已消费形态 (等价于一次已完成 reopen 的残留): revisionCauseId 单槽。
    const cur = await piOf(ev);
    const mergedMeta = JSON.parse(cur.raw.diagnosticJson ?? '{}') as Record<string, unknown>;
    (mergedMeta[PI_METADATA_KEY] as Record<string, unknown>).revisionCauseId = causeId;
    (mergedMeta[PI_METADATA_KEY] as Record<string, unknown>).revisionCount = 1;
    await sm.updateTask(ev, { diagnosticJson: JSON.stringify(mergedMeta) });
    const before = await snapshotRows([ev, rep]);

    const preview = await orchestrator().previewNextTaskTransitionGate(rep);
    expect(preview?.decision).toBe('revision_reopen_noop');
    if (preview?.decision === 'revision_reopen_noop') {
      expect(preview.reason).toBe('revision_cause_already_materialized');
    }
    await expectRowsUnchanged(before);

    const confirm = await orchestrator().commitNextTaskProposal(rep);
    expect(confirm.decision).toBe('revision_reopen_noop');
    if (confirm.decision === 'revision_reopen_noop') {
      expect(confirm.reason).toBe('revision_cause_already_materialized');
    }
    // 幂等重放: confirm 同样零写入 — epoch 不二次推进。
    await expectRowsUnchanged(before);
    expect((await piOf(ev)).pi.revisionCount).toBe(1);
  });

  it('different-cause new revision: 两侧同为 revision_reopened, confirm 推进新 epoch 并保留消费历史', async () => {
    const { ev } = await seedModernChainToEvaluator('dc', {
      status: 'succeeded',
      revisionCount: 1,
      revisionCauseId: 'owner-revise-once-cause',
      consumedRevisionCauseIds: ['owner-revise-once-cause'],
    });
    const rep = await seedRepairTask(ev, 1);
    const before = await snapshotRows([ev, rep]);

    const preview = await orchestrator().previewNextTaskTransitionGate(rep);
    expect(preview?.decision).toBe('revision_reopened');
    await expectRowsUnchanged(before); // 预览零写入

    const confirm = await orchestrator().commitNextTaskProposal(rep);
    expect(confirm.decision).toBe('revision_reopened');
    // confirm 写侧语义: 新 epoch = 旧 1 + 1, 历史 cause 折入保留, 依赖换到 repair。
    const { raw, pi } = await piOf(ev);
    expect(raw.status).toBe('pending');
    expect(pi.revisionCount).toBe(2);
    const repairCause = buildRepairRevisionCauseId((await piOf(rep)).pi);
    expect(
      pi.revisionCauseId === repairCause || (pi.consumedRevisionCauseIds ?? []).includes(repairCause),
    ).toBe(true);
    expect(pi.consumedRevisionCauseIds ?? []).toContain('owner-revise-once-cause');
    expect(pi.dependencyTaskIds).toEqual([rep]);
  });
});

// ── Source Correction: 同一快照 preview vs confirm ─────────────────────────

const SC_BINDREV = 1;
const SC_DIGEST = 'sha256:' + 'a'.repeat(64);

interface ScChain {
  scribe: string;
  artificer: string;
  causeId: string;
}

/** source-correction 续接夹具: scribe 新 epoch 已成功, receipt 未处理; artificer 停点 NHR。 */
async function seedSourceCorrectionChain(prefix: string, opts?: {
  artificerStatus?: 'needs_human_review' | 'succeeded' | 'failed' | 'pending' | 'leased';
  artificerConsumedCause?: boolean;
  artificerStopReasonCode?: string;
  receiptOutcomeRecorded?: boolean;
}): Promise<ScChain> {
  await mkTask('dreamer-root', 'dreamer', 'succeeded', { correlationId: CAND, topCandidateId: CAND });
  const ph = await mkTask(prefix + '-philosopher', 'philosopher', 'succeeded', { parentTaskId: 'dreamer-root', correlationId: CAND });
  const scribe = prefix + '-scribe';
  const artificer = prefix + '-artificer';
  const causeId = `rule-source-correction:${CAND}:${SC_BINDREV}`;
  await mkTask(scribe, 'scribe', 'succeeded', {
    parentTaskId: ph,
    correlationId: CAND,
    dependencyTaskIds: [ph],
    revisionCount: 4,
    revisionCauseId: causeId,
    sourceCorrectionCauseId: causeId,
    sourceCorrectionReceipt: {
      version: 1,
      candidateId: CAND,
      scribeTaskId: scribe,
      artificerTaskId: artificer,
      sourceArtifactId: 'pi-art-scribe-run-4',
      sourceArtifactDigest: SC_DIGEST,
      bindingRevision: SC_BINDREV,
      decisionId: 'decision-1',
      expectedStopReasonCode: 'textual_basis_unanchored',
      reason: 'Owner authorized one source-correction.',
      actor: 'owner-console:pd',
      requestId: 'req-parity-1',
      consumedAt: '2026-01-01T00:00:00.000Z',
      status: 'consumed',
      ...(opts?.receiptOutcomeRecorded === true
        ? { reopenOutcome: { kind: 'reopened', recordedAt: '2026-01-01T01:00:00.000Z' } }
        : {}),
    },
  });
  const artMeta: SeedMeta = {
    parentTaskId: scribe,
    correlationId: CAND,
    dependencyTaskIds: [scribe],
    revisionCount: 2,
    humanReviewContext: {
      reasonCode: opts?.artificerStopReasonCode ?? 'textual_basis_unanchored',
      sourceRunId: 'intent-preflight',
      revisionEpoch: 2,
      detail: 'required fact textualBasis cannot be anchored',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    ...(opts?.artificerConsumedCause === true ? { revisionCauseId: causeId } : {}),
  };
  await mkTask(artificer, 'artificer', opts?.artificerStatus ?? 'needs_human_review', artMeta);
  return { scribe, artificer, causeId };
}

describe('Source Correction — 同一数据库快照 preview/confirm 业务分类一致', () => {
  it('正常续接: 两侧同为 source_correction_reopened; confirm CAS 重开原 artificer 并回填 outcome, 预览零写入', async () => {
    const { scribe, artificer, causeId } = await seedSourceCorrectionChain('scn');
    const before = await snapshotRows([scribe, artificer]);

    const preview = await orchestrator().previewNextTaskTransitionGate(scribe);
    expect(preview?.decision).toBe('source_correction_reopened');
    if (preview?.decision === 'source_correction_reopened') {
      expect(preview.reopenedTaskId).toBe(artificer);
    }
    await expectRowsUnchanged(before); // 预览零写入 — receipt outcome 也不回填

    const confirm = await orchestrator().commitNextTaskProposal(scribe);
    expect(confirm.decision).toBe('source_correction_reopened');
    if (confirm.decision === 'source_correction_reopened') {
      expect(confirm.reopenedTaskId).toBe(artificer);
    }
    // confirm 写侧语义: 原 artificer pending + epoch 推进 + cause 消费 + outcome reopened。
    const { raw, pi } = await piOf(artificer);
    expect(raw.status).toBe('pending');
    expect(pi.revisionCount).toBe(3);
    expect(pi.revisionCauseId).toBe(causeId);
    expect(pi.dependencyTaskIds).toEqual([scribe]);
    const scribePi = (await piOf(scribe)).pi;
    expect(scribePi.sourceCorrectionReceipt?.reopenOutcome?.kind).toBe('reopened');
  });

  it('cause 已消费 (崩溃重放): 两侧同为 source_correction_reopen_noop 同一 reason', async () => {
    const { scribe, artificer } = await seedSourceCorrectionChain('scc', { artificerConsumedCause: true });
    const before = await snapshotRows([scribe, artificer]);

    const preview = await orchestrator().previewNextTaskTransitionGate(scribe);
    expect(preview?.decision).toBe('source_correction_reopen_noop');
    if (preview?.decision === 'source_correction_reopen_noop') {
      expect(preview.reason).toBe('source_correction_cause_already_materialized');
    }
    await expectRowsUnchanged(before);

    const confirm = await orchestrator().commitNextTaskProposal(scribe);
    expect(confirm.decision).toBe('source_correction_reopen_noop');
    if (confirm.decision === 'source_correction_reopen_noop') {
      expect(confirm.reason).toBe('source_correction_cause_already_materialized');
    }
    // artificer 行零写入 — epoch 不二次推进 (confirm 唯一写是 scribe receipt
    // outcome 回填 reopened_earlier, 幂等观测记录而非 reopen 写)。
    const artAfter = await piOf(artificer);
    expect(artAfter.raw.status).toBe('needs_human_review');
    expect(artAfter.pi.revisionCount).toBe(2);
  });

  it('outcome 已回填: 两侧同为 source_correction_outcome_recorded 幂等 noop', async () => {
    const { scribe } = await seedSourceCorrectionChain('scr', { receiptOutcomeRecorded: true });
    const preview = await orchestrator().previewNextTaskTransitionGate(scribe);
    expect(preview?.decision).toBe('source_correction_reopen_noop');
    if (preview?.decision === 'source_correction_reopen_noop') {
      expect(preview.reason).toBe('source_correction_outcome_recorded:reopened');
    }
    const confirm = await orchestrator().commitNextTaskProposal(scribe);
    expect(confirm.decision).toBe('source_correction_reopen_noop');
    if (confirm.decision === 'source_correction_reopen_noop') {
      expect(confirm.reason).toBe('source_correction_outcome_recorded:reopened');
    }
  });

  it('冲突 (artificer 非停点状态): 两侧同为 source_correction_reopen_conflict 同一 reason', async () => {
    const { scribe, artificer } = await seedSourceCorrectionChain('scf', { artificerStatus: 'succeeded' });
    const before = await snapshotRows([scribe, artificer]);

    const preview = await orchestrator().previewNextTaskTransitionGate(scribe);
    expect(preview?.decision).toBe('source_correction_reopen_conflict');
    if (preview?.decision === 'source_correction_reopen_conflict') {
      expect(preview.reason).toBe('artificer_status_succeeded');
    }
    await expectRowsUnchanged(before);

    const confirm = await orchestrator().commitNextTaskProposal(scribe);
    expect(confirm.decision).toBe('source_correction_reopen_conflict');
    if (confirm.decision === 'source_correction_reopen_conflict') {
      expect(confirm.reason).toBe('artificer_status_succeeded');
    }
    // 冲突 = 零 reopen 写: artificer 状态/epoch 原样。
    const artAfter = await piOf(artificer);
    expect(artAfter.raw.status).toBe('succeeded');
    expect(artAfter.pi.revisionCount).toBe(2);
  });

  it('冲突 (停点 reasonCode 漂移): 两侧同为 source_correction_reopen_conflict/stop_reason_drifted', async () => {
    const { scribe } = await seedSourceCorrectionChain('scd', { artificerStopReasonCode: 'some_other_stop' });
    const preview = await orchestrator().previewNextTaskTransitionGate(scribe);
    expect(preview?.decision).toBe('source_correction_reopen_conflict');
    if (preview?.decision === 'source_correction_reopen_conflict') {
      expect(preview.reason).toContain('stop_reason_drifted');
    }
    const confirm = await orchestrator().commitNextTaskProposal(scribe);
    expect(confirm.decision).toBe('source_correction_reopen_conflict');
    if (confirm.decision === 'source_correction_reopen_conflict') {
      expect(confirm.reason).toContain('stop_reason_drifted');
    }
  });

  it('artificer leased: 两侧同为 conflict artificer_status_leased — source-correction 无 concurrent_modification 静态分类', async () => {
    const { scribe, artificer } = await seedSourceCorrectionChain('scl', { artificerStatus: 'leased' });
    const before = await snapshotRows([scribe, artificer]);
    const preview = await orchestrator().previewNextTaskTransitionGate(scribe);
    expect(preview?.decision).toBe('source_correction_reopen_conflict');
    expect(preview?.decision).not.toBe('concurrent_modification');
    if (preview?.decision === 'source_correction_reopen_conflict') {
      expect(preview.reason).toBe('artificer_status_leased');
    }
    await expectRowsUnchanged(before);
    const confirm = await orchestrator().commitNextTaskProposal(scribe);
    expect(confirm.decision).toBe('source_correction_reopen_conflict');
    expect(confirm.decision).not.toBe('concurrent_modification');
    if (confirm.decision === 'source_correction_reopen_conflict') {
      expect(confirm.reason).toBe('artificer_status_leased');
    }
  });
});
