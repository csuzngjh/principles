/**
 * PRI-1293 Phase 3 — resolveAuthoritativeCorrelationId 单元测试。
 *
 * 覆盖 TECH §3.6.2 的判别联合语义与指令 §4 的算法约束:
 *   - 仅沿 parentTaskId 上溯; dependencyTaskIds 绝不参与遍历;
 *   - 10 条边通过 / 11 条边拒绝; visited 环检测; 悬空父引用 fail-closed;
 *   - 链内 trim 后一致性冲突 → conflicting_parent_correlation_id;
 *   - 根 dreamer 双源身份交叉表 (A/A、A/B、A/null、null/B、null/null);
 *   - 根侧佐证 (v0.5): 孤立后代声明不采信 (根全盲拒绝);
 *   - 非 dreamer 根: 无佐证来源, 一律拒绝;
 *   - InternalizationOrchestrator 静态包装与自由函数同判。
 */
import { describe, it, expect } from 'vitest';
import { resolveAuthoritativeCorrelationId, CORRELATION_LINEAGE_MAX_PARENT_EDGES } from '../correlation-lineage.js';
import { InternalizationOrchestrator } from '../internalization-orchestrator.js';
import { createPITaskDiagnosticJson, PI_METADATA_KEY } from '../pitask-metadata.js';
import type { TaskRecord } from '../../task-status.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

/** 与 intake bridge buildDreamerTaskSeed 相同的 diagnosticJson 形状。 */
function seedJson(options: {
  parentTaskId?: string;
  correlationId?: string;
  topCandidateId?: string;
  taskKind?: string;
}): string {
  return JSON.stringify({
    [PI_METADATA_KEY]: {
      dependencyTaskIds: [],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
      ...(options.parentTaskId !== undefined ? { parentTaskId: options.parentTaskId } : {}),
      ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
    },
    ...(options.topCandidateId !== undefined ? { candidateId: options.topCandidateId } : {}),
    ...(options.taskKind !== undefined ? { taskKind: options.taskKind } : {}),
  });
}

function mkTask(
  taskId: string,
  taskKind: string,
  options: { parentTaskId?: string; correlationId?: string; topCandidateId?: string } = {},
): TaskRecord {
  return {
    taskId,
    taskKind,
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    diagnosticJson: seedJson({
      parentTaskId: options.parentTaskId,
      correlationId: options.correlationId,
      topCandidateId: options.topCandidateId,
    }),
    createdAt: '2026-11-25T00:00:00.000Z',
    updatedAt: '2026-11-25T00:00:00.000Z',
  };
}

/** 空值收窄: 缺值即失败测试, 不静默通过 (也避免 no-non-null-assertion)。 */
function need<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${label} to exist`);
  return value;
}

/** 内存任务表 + getTask 闭包 (模拟 RuntimeStateManager.getTask 的查找语义)。 */
function makeStore(tasks: TaskRecord[]): (taskId: string) => Promise<TaskRecord | null> {
  const byId = new Map(tasks.map((task) => [task.taskId, task] as const));
  return async (taskId: string) => byId.get(taskId) ?? null;
}

describe('resolveAuthoritativeCorrelationId — 正常链与历史恢复', () => {
  it('新链: dreamer(双源 A + 自身 correlationId=A) → philosopher → scribe 全程一致 → 通过', async () => {
    const dreamer = mkTask(`dreamer-${UUID_A}-prompt`, 'dreamer', { correlationId: UUID_A, topCandidateId: UUID_A });
    const philosopher = mkTask(`philosopher-${UUID_A}-prompt`, 'philosopher', { parentTaskId: dreamer.taskId, correlationId: UUID_A });
    const scribe = mkTask(`scribe-${UUID_A}-prompt`, 'scribe', { parentTaskId: philosopher.taskId, correlationId: UUID_A });
    const result = await resolveAuthoritativeCorrelationId(scribe, makeStore([dreamer, philosopher, scribe]));
    expect(result).toEqual({ ok: true, correlationId: UUID_A, recoveredFromLegacyRoot: false });
  });

  it('历史恢复: 全链无 id、根 dreamer 仅 taskId 双源可解析 (A/null) → 恢复 A, recoveredFromLegacyRoot=true', async () => {
    const dreamer = mkTask(`dreamer-${UUID_A}-prompt`, 'dreamer');
    const philosopher = mkTask(`philosopher-${UUID_A}-prompt`, 'philosopher', { parentTaskId: dreamer.taskId });
    const scribe = mkTask(`scribe-${UUID_A}-prompt`, 'scribe', { parentTaskId: philosopher.taskId });
    const result = await resolveAuthoritativeCorrelationId(scribe, makeStore([dreamer, philosopher, scribe]));
    expect(result).toEqual({ ok: true, correlationId: UUID_A, recoveredFromLegacyRoot: true });
  });

  it('历史恢复: 根 taskId 非 UUID 格式、seed 顶层 candidateId 存在 (null/B) → 恢复 B', async () => {
    const dreamer = mkTask('dreamer-legacy-format-prompt', 'dreamer', { topCandidateId: UUID_B });
    const scribe = mkTask(`scribe-${UUID_B}-prompt`, 'scribe', { parentTaskId: dreamer.taskId });
    const result = await resolveAuthoritativeCorrelationId(scribe, makeStore([dreamer, scribe]));
    expect(result).toEqual({ ok: true, correlationId: UUID_B, recoveredFromLegacyRoot: true });
  });

  it('历史恢复: 根双源 A/A 相等 → 恢复 A (双源一致的确定性)', async () => {
    const dreamer = mkTask(`dreamer-${UUID_A}-prompt`, 'dreamer', { topCandidateId: UUID_A });
    const philosopher = mkTask(`philosopher-x`, 'philosopher', { parentTaskId: dreamer.taskId });
    const result = await resolveAuthoritativeCorrelationId(philosopher, makeStore([dreamer, philosopher]));
    expect(result).toEqual({ ok: true, correlationId: UUID_A, recoveredFromLegacyRoot: true });
  });

  it('不使用 dependencyTaskIds 代替 parentTaskId: 仅靠依赖相连的链视为孤立单节点 → 非 dreamer 叶子拒绝', async () => {
    const dreamer = mkTask(`dreamer-${UUID_A}-prompt`, 'dreamer', { correlationId: UUID_A, topCandidateId: UUID_A });
    const scribe = mkTask(`scribe-${UUID_A}-prompt`, 'scribe'); // 无 parentTaskId
    const result = await resolveAuthoritativeCorrelationId(scribe, makeStore([dreamer, scribe]));
    expect(result).toEqual({
      ok: false,
      reason: 'missing_correlation_id_lineage',
      detail: expect.stringContaining('root_not_dreamer:scribe'),
    });
  });

  it('trim 等价: 链上 id 带首尾空白仍按 trim 后一致判定', async () => {
    const dreamer = mkTask(`dreamer-${UUID_A}-prompt`, 'dreamer', { correlationId: `  ${UUID_A}  `, topCandidateId: UUID_A });
    const philosopher = mkTask('philosopher-trim', 'philosopher', { parentTaskId: dreamer.taskId, correlationId: UUID_A });
    const result = await resolveAuthoritativeCorrelationId(philosopher, makeStore([dreamer, philosopher]));
    expect(result.ok).toBe(true);
  });
});

describe('resolveAuthoritativeCorrelationId — 拒绝路径 (fail-closed)', () => {
  it('父子冲突: 叶子 C 与中间节点 D 不同 → conflicting_parent_correlation_id', async () => {
    const dreamer = mkTask(`dreamer-${UUID_A}-prompt`, 'dreamer', { correlationId: UUID_A, topCandidateId: UUID_A });
    const philosopher = mkTask('philosopher-conflict', 'philosopher', { parentTaskId: dreamer.taskId, correlationId: UUID_B });
    const scribe = mkTask('scribe-conflict', 'scribe', { parentTaskId: philosopher.taskId, correlationId: UUID_B });
    const result = await resolveAuthoritativeCorrelationId(scribe, makeStore([dreamer, philosopher, scribe]));
    expect(result).toEqual({
      ok: false,
      reason: 'conflicting_parent_correlation_id',
      detail: expect.stringContaining(UUID_A),
    });
    if (!result.ok) expect(result.detail).toContain(UUID_B);
  });

  it('根双源冲突 (A≠B) → conflicting_root_identity_sources — 即使后代声明与其中一方一致', async () => {
    const dreamer = mkTask(`dreamer-${UUID_A}-prompt`, 'dreamer', { topCandidateId: UUID_B });
    const scribe = mkTask('scribe-ab', 'scribe', { parentTaskId: dreamer.taskId, correlationId: UUID_A });
    const result = await resolveAuthoritativeCorrelationId(scribe, makeStore([dreamer, scribe]));
    expect(result).toEqual({
      ok: false,
      reason: 'conflicting_root_identity_sources',
      detail: expect.stringContaining(UUID_B),
    });
  });

  it('悬空父引用: 有 id 但父任务不存在 → dangling_parent_reference (即使叶子自带 id)', async () => {
    const scribe = mkTask('scribe-dangling', 'scribe', { parentTaskId: 'task-gone', correlationId: UUID_A });
    const result = await resolveAuthoritativeCorrelationId(scribe, makeStore([scribe]));
    expect(result).toEqual({ ok: false, reason: 'dangling_parent_reference', detail: 'parent_not_found:task-gone' });
  });

  it('父任务存在但元数据不可读 → dangling_parent_reference (parent_metadata_invalid)', async () => {
    const brokenParent: TaskRecord = {
      taskId: 'parent-broken',
      taskKind: 'philosopher',
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 3,
      diagnosticJson: 'not-json-at-all',
      createdAt: '2026-11-25T00:00:00.000Z',
      updatedAt: '2026-11-25T00:00:00.000Z',
    };
    const scribe = mkTask('scribe-under-broken', 'scribe', { parentTaskId: 'parent-broken', correlationId: UUID_A });
    const result = await resolveAuthoritativeCorrelationId(scribe, makeStore([brokenParent, scribe]));
    expect(result).toEqual({
      ok: false,
      reason: 'dangling_parent_reference',
      detail: 'parent_metadata_invalid:parent-broken',
    });
  });

  it('父链自环: A 的父是 B、B 的父是 A → parent_chain_cycle_or_depth_exceeded', async () => {
    const a = mkTask('cycle-a', 'philosopher', { parentTaskId: 'cycle-b', correlationId: UUID_A });
    const b = mkTask('cycle-b', 'scribe', { parentTaskId: 'cycle-a', correlationId: UUID_A });
    const result = await resolveAuthoritativeCorrelationId(a, makeStore([a, b]));
    expect(result).toEqual({
      ok: false,
      reason: 'parent_chain_cycle_or_depth_exceeded',
      detail: expect.stringContaining('cycle_at:'),
    });
  });

  it('自指环: 叶子的父是自己 → 拒绝', async () => {
    const a = mkTask('self-parent', 'scribe', { parentTaskId: 'self-parent', correlationId: UUID_A });
    const result = await resolveAuthoritativeCorrelationId(a, makeStore([a]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('parent_chain_cycle_or_depth_exceeded');
  });

  it('深度边界: 恰好 10 条父链边 (11 节点) 通过; 11 条边 (12 节点) 拒绝', async () => {
    // 恰好 10 条边: scribe ← p1 ← … ← p9 ← dreamer (10 父边, 11 节点)。
    const chainOk: TaskRecord[] = [
      mkTask(`dreamer-${UUID_A}-prompt`, 'dreamer', { correlationId: UUID_A, topCandidateId: UUID_A }),
    ];
    for (let i = 1; i <= 9; i++) {
      chainOk.push(mkTask(`p${i}`, 'philosopher', { parentTaskId: i === 1 ? need(chainOk[0], 'chain head').taskId : `p${i - 1}`, correlationId: UUID_A }));
    }
    const leafOk = mkTask('leaf-ok', 'scribe', { parentTaskId: 'p9', correlationId: UUID_A });
    chainOk.push(leafOk);
    const ok = await resolveAuthoritativeCorrelationId(leafOk, makeStore(chainOk));
    expect(ok).toEqual({ ok: true, correlationId: UUID_A, recoveredFromLegacyRoot: false });
    expect(CORRELATION_LINEAGE_MAX_PARENT_EDGES).toBe(10);

    // 11 条边: 再加一层 → 拒绝。
    const chainTooDeep = chainOk.slice(0, 10); // dreamer + p1..p9
    const p10 = mkTask('p10', 'philosopher', { parentTaskId: 'p9', correlationId: UUID_A });
    const leafDeep = mkTask('leaf-deep', 'scribe', { parentTaskId: 'p10', correlationId: UUID_A });
    chainTooDeep.push(p10, leafDeep);
    const deep = await resolveAuthoritativeCorrelationId(leafDeep, makeStore(chainTooDeep));
    expect(deep).toEqual({
      ok: false,
      reason: 'parent_chain_cycle_or_depth_exceeded',
      detail: expect.stringContaining('depth_limit_exceeded:10_edges'),
    });
  });

  it('根非 dreamer 且带 id 的单节点链 → 拒绝 (无根侧佐证来源)', async () => {
    const repairTask = mkTask('artificer-repair-legacy', 'artificer', { correlationId: UUID_A });
    const result = await resolveAuthoritativeCorrelationId(repairTask, makeStore([repairTask]));
    expect(result).toEqual({
      ok: false,
      reason: 'missing_correlation_id_lineage',
      detail: expect.stringContaining('root_not_dreamer:artificer'),
    });
  });

  it('根非 dreamer 且无 id 的不可恢复孤儿 → 拒绝 (unrecoverable)', async () => {
    const orphan = mkTask('orphan-evaluator', 'evaluator');
    const result = await resolveAuthoritativeCorrelationId(orphan, makeStore([orphan]));
    expect(result).toEqual({
      ok: false,
      reason: 'missing_correlation_id_lineage',
      detail: expect.stringContaining('unrecoverable_chain_root_not_dreamer'),
    });
  });

  it('根锚点核对: 根 taskId/seed 双源均为 A, 链上 (含根自身) 全写 B → conflicting_parent_correlation_id (SPEC §3.6.2)', async () => {
    // 根自身 correlationId 是链上声明的一部分, 不得充当独立于 rootSeedId 的
    // 佐证 — 否则根双源事实 (A) 会被链上自证 (B) 循环推翻。
    const dreamer = mkTask(`dreamer-${UUID_A}-prompt`, 'dreamer', { correlationId: UUID_B, topCandidateId: UUID_A });
    const philosopher = mkTask('philosopher-anchor-b', 'philosopher', { parentTaskId: dreamer.taskId, correlationId: UUID_B });
    const result = await resolveAuthoritativeCorrelationId(philosopher, makeStore([dreamer, philosopher]));
    expect(result).toEqual({
      ok: false,
      reason: 'conflicting_parent_correlation_id',
      detail: expect.stringContaining(UUID_A),
    });
    if (!result.ok) expect(result.detail).toContain(UUID_B);
  });

  it('根锚点核对: 根双源为 A、根自身不携带 id、仅后代写 B → 同样 conflicting_parent_correlation_id', async () => {
    const dreamer = mkTask(`dreamer-${UUID_A}-prompt`, 'dreamer', { topCandidateId: UUID_A });
    const scribe = mkTask('scribe-anchor-b', 'scribe', { parentTaskId: dreamer.taskId, correlationId: UUID_B });
    const result = await resolveAuthoritativeCorrelationId(scribe, makeStore([dreamer, scribe]));
    expect(result).toEqual({
      ok: false,
      reason: 'conflicting_parent_correlation_id',
      detail: expect.stringContaining(UUID_B),
    });
  });

  it('根锚点核对不误伤: 根双源为 A 且链上全写 A → 通过', async () => {
    const dreamer = mkTask(`dreamer-${UUID_A}-prompt`, 'dreamer', { correlationId: UUID_A, topCandidateId: UUID_A });
    const scribe = mkTask('scribe-anchor-a', 'scribe', { parentTaskId: dreamer.taskId, correlationId: UUID_A });
    const result = await resolveAuthoritativeCorrelationId(scribe, makeStore([dreamer, scribe]));
    expect(result).toEqual({ ok: true, correlationId: UUID_A, recoveredFromLegacyRoot: false });
  });

  it('根全盲 (A=null, B=null, 根自身无 id) 而仅后代声明 correlationId → 拒绝 (test 12)', async () => {
    const dreamer = mkTask('dreamer-blind-prompt', 'dreamer'); // 非 UUID taskId, 无 seed candidateId, 无自身 id
    const philosopher = mkTask('philosopher-claim', 'philosopher', { parentTaskId: dreamer.taskId, correlationId: UUID_C });
    const result = await resolveAuthoritativeCorrelationId(philosopher, makeStore([dreamer, philosopher]));
    expect(result).toEqual({
      ok: false,
      reason: 'missing_correlation_id_lineage',
      detail: expect.stringContaining('root_corroboration_failed'),
    });
  });

  it('根全盲但根自身携带同一 correlationId → 佐证成立通过 (§4.5 第三来源)', async () => {
    const dreamer = mkTask('dreamer-blind-own-id-prompt', 'dreamer', { correlationId: UUID_C });
    const philosopher = mkTask('philosopher-of-blind', 'philosopher', { parentTaskId: dreamer.taskId, correlationId: UUID_C });
    const result = await resolveAuthoritativeCorrelationId(philosopher, makeStore([dreamer, philosopher]));
    expect(result).toEqual({ ok: true, correlationId: UUID_C, recoveredFromLegacyRoot: false });
  });

  it('根双缺失且全链无 id (null/null) → 不可恢复拒绝', async () => {
    const dreamer = mkTask('dreamer-fully-blind-prompt', 'dreamer');
    const scribe = mkTask('scribe-of-blind', 'scribe', { parentTaskId: dreamer.taskId });
    const result = await resolveAuthoritativeCorrelationId(scribe, makeStore([dreamer, scribe]));
    expect(result).toEqual({
      ok: false,
      reason: 'missing_correlation_id_lineage',
      detail: expect.stringContaining('root_identity_sources_all_missing'),
    });
  });

  it('叶子元数据不可解析 → missing_correlation_id_lineage (invalid_leaf_task_metadata)', async () => {
    const brokenLeaf: TaskRecord = {
      taskId: 'leaf-broken',
      taskKind: 'scribe',
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 3,
      diagnosticJson: '{{{',
      createdAt: '',
      updatedAt: '',
    };
    const result = await resolveAuthoritativeCorrelationId(brokenLeaf, async () => null);
    expect(result).toEqual({
      ok: false,
      reason: 'missing_correlation_id_lineage',
      detail: 'invalid_leaf_task_metadata',
    });
  });
});

describe('resolveAuthoritativeCorrelationId — 根双源身份交叉表 (指令 §7 第 9 项)', () => {
  const cases: readonly { name: string; taskId: string; topCandidateId?: string; expectReason?: string; expectId?: string }[] = [
    { name: 'A/A → 通过', taskId: `dreamer-${UUID_A}-prompt`, topCandidateId: UUID_A, expectId: UUID_A },
    { name: 'A/B → conflicting_root_identity_sources', taskId: `dreamer-${UUID_A}-prompt`, topCandidateId: UUID_B, expectReason: 'conflicting_root_identity_sources' },
    { name: 'A/null → 采纳 A', taskId: `dreamer-${UUID_A}-prompt`, expectId: UUID_A },
    { name: 'null/B → 采纳 B', taskId: 'dreamer-non-uuid-prompt', topCandidateId: UUID_B, expectId: UUID_B },
    { name: 'null/null → 不可恢复', taskId: 'dreamer-non-uuid-prompt', expectReason: 'missing_correlation_id_lineage' },
  ];
  for (const c of cases) {
    it(`恢复模式: ${c.name}`, async () => {
      const dreamer = mkTask(c.taskId, 'dreamer', { topCandidateId: c.topCandidateId });
      const scribe = mkTask('scribe-probe', 'scribe', { parentTaskId: dreamer.taskId });
      const result = await resolveAuthoritativeCorrelationId(scribe, makeStore([dreamer, scribe]));
      if (c.expectReason !== undefined) {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe(c.expectReason);
      } else {
        expect(result).toEqual({ ok: true, correlationId: c.expectId, recoveredFromLegacyRoot: true });
      }
    });
  }
});

describe('静态包装与自由函数同判', () => {
  it('InternalizationOrchestrator.resolveAuthoritativeCorrelationId 与核心实现返回一致', async () => {
    const dreamer = mkTask(`dreamer-${UUID_A}-prompt`, 'dreamer', { correlationId: UUID_A, topCandidateId: UUID_A });
    const scribe = mkTask('scribe-static', 'scribe', { parentTaskId: dreamer.taskId, correlationId: UUID_A });
    const getTask = makeStore([dreamer, scribe]);
    const viaStatic = await InternalizationOrchestrator.resolveAuthoritativeCorrelationId(scribe, getTask);
    const viaFree = await resolveAuthoritativeCorrelationId(scribe, getTask);
    expect(viaStatic).toEqual(viaFree);
    expect(viaStatic).toEqual({ ok: true, correlationId: UUID_A, recoveredFromLegacyRoot: false });
  });

  it('静态包装同样传播拒绝 (dangling)', async () => {
    const scribe = mkTask('scribe-static-dangling', 'scribe', { parentTaskId: 'nope', correlationId: UUID_A });
    const viaStatic = await InternalizationOrchestrator.resolveAuthoritativeCorrelationId(scribe, async () => null);
    expect(viaStatic.ok).toBe(false);
  });
});

// createPITaskDiagnosticJson 仍被引用于 seedJson 的字段形状注释上 — 保持
// 与生产序列化契约的对齐断言: 本文件的 seedJson 必须能被 hydrate 还原。
import { hydratePITaskRecord } from '../pitask-metadata.js';
describe('测试夹具自身契约', () => {
  it('seedJson 经 hydratePITaskRecord 还原出 parentTaskId/correlationId', () => {
    const record = mkTask('fixture-check', 'scribe', { parentTaskId: 'p', correlationId: UUID_A, topCandidateId: UUID_A });
    const pi = hydratePITaskRecord(record);
    expect(pi?.parentTaskId).toBe('p');
    expect(pi?.correlationId).toBe(UUID_A);
    expect(createPITaskDiagnosticJson.length).toBeGreaterThan(0);
  });
});
