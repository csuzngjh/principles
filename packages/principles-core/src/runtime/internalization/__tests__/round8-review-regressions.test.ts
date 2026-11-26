/**
 * PRI-1293 R8 评审回归 — 真实 sqlite:
 *   #1 Owner 裁决在 reopen 两次读取间提交 → 结构化拒绝且裁决/状态原样保留;
 *   #2 跨运行对抗轮次: 异链 Evaluator 不得被写成父节点 (同 Scribe 核对);
 *   #3 未回填历史后继纳入查重 — 不重复创建;
 *   #5 血缘校验失败零写入 (plan-then-write): 下层推断成功上层失败, 字节不变。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { InternalizationOrchestrator } from '../internalization-orchestrator.js';
import { reopenTaskForRevision } from '../revision-reopen.js';
import { resolveAuthoritativeCorrelationIdWithLegacyBackfill } from '../correlation-lineage.js';
import { PI_METADATA_KEY } from '../pitask-metadata.js';

let workspaceDir: string;
let sm: RuntimeStateManager;

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-r8-'));
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

// eslint-disable-next-line @typescript-eslint/max-params -- 夹具四参形态与同目录集成测试惯例一致。
async function mkTask(
  taskId: string,
  taskKind: string,
  status: 'pending' | 'succeeded' | 'needs_human_review',
  meta: Record<string, unknown>,
): Promise<string> {
  await sm.createTask({
    taskId, taskKind, status,
    attemptCount: status === 'succeeded' ? 1 : 0, maxAttempts: 3,
    diagnosticJson: JSON.stringify({
      [PI_METADATA_KEY]: {
        dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000,
        inputArtifactRefs: [], outputArtifactRefs: [], ...meta,
      },
      ...(meta.topCandidateId !== undefined ? { candidateId: meta.topCandidateId } : {}),
    }),
  });
  return taskId;
}

describe('#1 — Owner 裁决在 reopen 读取窗口提交 → 拒绝且保留', () => {
  it('血缘验证期间 owner 写入 verdict+pending → concurrent_modification, 裁决不丢', async () => {
    await mkTask('dreamer-r1', 'dreamer', 'succeeded', { correlationId: 'r1c', topCandidateId: 'r1c' });
    await mkTask('ev-r1', 'evaluator', 'succeeded', {
      parentTaskId: 'dreamer-r1', correlationId: 'r1c', dependencyTaskIds: [],
    });
    // 拦截第二读: 在血缘解析后、权威快照读取前模拟 Owner 裁决写入
    // (runnerDecision + status 保持 succeeded 但 metadata 变化)。
    const originalGetTask = sm.getTask.bind(sm);
    let reads = 0;
    sm.getTask = async (id: string) => {
      const row = await originalGetTask(id);
      if (id === 'ev-r1') {
        reads += 1;
        if (reads === 1) {
          // 第一读放行后注入 Owner 裁决写 (runnerDecision + revisionCount 不动,
          // 但 completionIntent 出现 — 绑定当前轮次)。
          const cur = need(await originalGetTask('ev-r1'), 'ev');
          const parsed = JSON.parse(cur.diagnosticJson ?? '{}') as Record<string, unknown>;
          const piMeta = (parsed[PI_METADATA_KEY] ?? {}) as Record<string, unknown>;
          piMeta.runnerDecision = 'approved';
          parsed[PI_METADATA_KEY] = piMeta;
          await sm.updateTask('ev-r1', { diagnosticJson: JSON.stringify(parsed) });
        }
      }
      return row;
    };
    try {
      const result = await reopenTaskForRevision(sm, 'ev-r1', { revisionCauseId: 'c-r1' });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('concurrent_modification');
    } finally {
      sm.getTask = originalGetTask;
    }
    // Owner 裁决原样保留 — reopen 未写、未递增轮次。
    const after = need(await sm.getTask('ev-r1'), 'ev after');
    const parsed = JSON.parse(after.diagnosticJson ?? '{}') as Record<string, unknown>;
    expect((parsed[PI_METADATA_KEY] as Record<string, unknown>).runnerDecision).toBe('approved');
    expect((parsed[PI_METADATA_KEY] as Record<string, unknown>).revisionCount ?? 0).toBe(0);
  });
});

describe('#5 — 血缘校验失败零写入 (plan-then-write)', () => {
  it('下层 scribe 可推断但上层 phil 不可证明 → 拒绝且 scribe 字节不变', async () => {
    // 链: scribe(缺 parent, 输入 phil) → phil(缺 parent, 但无 dreamer 输入可证明)
    await mkTask('phil-x1', 'philosopher', 'succeeded', { correlationId: 'x1c' });
    const scJson = JSON.stringify({
      [PI_METADATA_KEY]: {
        dependencyTaskIds: ['phil-x1'], channel: 'prompt', timeoutMs: 300_000,
        inputArtifactRefs: [], outputArtifactRefs: [], correlationId: 'x1c',
      },
    });
    await sm.createTask({
      taskId: 'corr-x1-scribe-a1', taskKind: 'scribe', status: 'succeeded',
      attemptCount: 1, maxAttempts: 3, diagnosticJson: scJson,
    });
    const leaf = need(await sm.getTask('corr-x1-scribe-a1'), 'scribe');
    const result = await resolveAuthoritativeCorrelationIdWithLegacyBackfill(leaf, sm);
    expect(result.ok).toBe(false);
    // 零写入: scribe diagnosticJson 逐字节不变 (旧实现会先写 scribe→phil 边)。
    const after = need(await sm.getTask('corr-x1-scribe-a1'), 'scribe after');
    expect(after.diagnosticJson).toBe(scJson);
  });
});

describe('#2 — 跨运行对抗轮次不得错接父链', () => {
  it('异链 evaluator 不算候选 → 多运行下只有同 Scribe 链被证明', async () => {
    // 运行 A: scribeA → artA-r1 → evalA-r1(needs_revision)
    // 运行 B: scribeB → artB-r1 → evalB-r1(needs_revision) → artB-r2(待恢复)
    // 两次运行同 correlation 前缀 (同痛点重跑)。
    await mkTask('corrX-scribe-aa', 'scribe', 'succeeded', { correlationId: 'corrX' });
    await mkTask('corrX-scribe-bb', 'scribe', 'succeeded', { correlationId: 'corrX' });
    await mkTask('corrX-artificer-r1-aa', 'artificer', 'succeeded', {
      correlationId: 'corrX', dependencyTaskIds: ['corrX-scribe-aa'],
    });
    await mkTask('corrX-artificer-r1-bb', 'artificer', 'succeeded', {
      correlationId: 'corrX', dependencyTaskIds: ['corrX-scribe-bb'],
    });
    await mkTask('corrX-evaluator-r1-aa', 'evaluator', 'succeeded', {
      correlationId: 'corrX', dependencyTaskIds: ['corrX-artificer-r1-aa'], runnerDecision: 'needs_revision',
    });
    await mkTask('corrX-evaluator-r1-bb', 'evaluator', 'succeeded', {
      correlationId: 'corrX', dependencyTaskIds: ['corrX-artificer-r1-bb'], runnerDecision: 'needs_revision',
    });
    // B 的 r2 artificer 缺 parent — 输入是 scribeB。
    await mkTask('corrX-artificer-r2-bb', 'artificer', 'succeeded', {
      correlationId: 'corrX', dependencyTaskIds: ['corrX-scribe-bb'],
    });
    const leaf = need(await sm.getTask('corrX-artificer-r2-bb'), 'artB-r2');
    const result = await resolveAuthoritativeCorrelationIdWithLegacyBackfill(leaf, sm);
    // 两个 r1 evaluator 都 needs_revision — 但只有 bb 链共享 scribeB。
    // aa 被正确排除后剩下唯一候选 bb → 可证明而非虚假多候选拒绝;
    // 然而链上层 (scribeB 无父) 不可证 → 最终仍拒绝, 但拒绝原因必须是
    // 上层血缘而非"previous_round_evaluator_not_unique"(异链干扰已排除)。
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail ?? '').not.toContain('previous_round_evaluator_not_unique');
    }
    // 关键: artB-r2 不得被写上 evalA (异链) 父节点 — 字节级验证。
    const after = need(await sm.getTask('corrX-artificer-r2-bb'), 'artB-r2 after');
    expect(after.diagnosticJson ?? '').not.toContain('corrX-evaluator-r1-aa');
  });
});

describe('#3 — 未回填历史后继纳入查重', () => {
  it('历史 scribe 缺 parent 但可证明 → commit philosopher 不重复创建', async () => {
    // 现代 dreamer + 历史 philosopher (已回填/直接有 parent) + 历史 scribe 缺 parent。
    await mkTask('dreamer-r3', 'dreamer', 'succeeded', { correlationId: 'r3c', topCandidateId: 'r3c' });
    await mkTask('r3c-philosopher-p1', 'philosopher', 'succeeded', {
      parentTaskId: 'dreamer-r3', correlationId: 'r3c',
    });
    // 历史 scribe: 唯一输入 philosopher, 缺 parentTaskId — RuleHost 形状。
    await mkTask('r3c-scribe-s1', 'scribe', 'succeeded', {
      correlationId: 'r3c', dependencyTaskIds: ['r3c-philosopher-p1'],
    });
    const orchestrator = new InternalizationOrchestrator(
      { stateManager: sm }, { owner: 'r8', runtimeKind: 'test-double', dryRun: true },
    );
    const result = await orchestrator.commitNextTaskProposal('r3c-philosopher-p1');
    // 不得创建新 scribe — 历史 scribe 被识别为既有后继。
    expect(['successor_exists', 'successor_reopened', 'lineage_refused', 'successor_integrity_conflict']).toContain(result.decision);
    const scribes = (await sm.listTasks({})).filter((t) => t.taskKind === 'scribe');
    expect(scribes).toHaveLength(1);
  });
});


describe('PRI-1299 review — backfill races and conflict zero-write ordering', () => {
  it('双连接竞态: 第一次 exact read 后真实回填父边, 第二次 read 重判 exact 并复用历史后继', async () => {
    await mkTask('dreamer-race', 'dreamer', 'succeeded', { correlationId: 'racer', topCandidateId: 'racer', pipelineMode: 'full_chain' });
    await mkTask('racer-philosopher-p1', 'philosopher', 'succeeded', {
      parentTaskId: 'dreamer-race', correlationId: 'racer', pipelineMode: 'full_chain',
    });
    await mkTask('racer-scribe-s1', 'scribe', 'succeeded', {
      correlationId: 'racer', dependencyTaskIds: ['racer-philosopher-p1'], pipelineMode: 'full_chain',
    });
    const beforeCount = (await sm.listTasks({})).length;
    const secondConnection = new RuntimeStateManager({ workspaceDir });
    await secondConnection.initialize();
    const originalListTasks = sm.listTasks.bind(sm);
    let targetExactReads = 0;
    sm.listTasks = async (filter?: Parameters<RuntimeStateManager['listTasks']>[0]) => {
      const isTargetExactScan = filter?.piParentTaskId === 'racer-philosopher-p1'
        && filter.taskKind === 'scribe'
        && filter.piChannel === 'prompt';
      const rows = await originalListTasks(filter);
      if (isTargetExactScan) {
        targetExactReads += 1;
        if (targetExactReads === 1) {
          const leaf = need(await secondConnection.getTask('racer-scribe-s1'), 'legacy scribe on second connection');
          const backfill = await resolveAuthoritativeCorrelationIdWithLegacyBackfill(leaf, secondConnection);
          expect(backfill.ok).toBe(true);
        }
      }
      return rows;
    };
    try {
      const orchestrator = new InternalizationOrchestrator(
        { stateManager: sm }, { owner: 'r8-race', runtimeKind: 'test-double', dryRun: true },
      );
      const result = await orchestrator.commitNextTaskProposal('racer-philosopher-p1');
      expect(result.decision).toBe('successor_exists');
      if (result.decision === 'successor_exists') {
        expect(result.successorTaskId).toBe('racer-scribe-s1');
      }
    } finally {
      sm.listTasks = originalListTasks;
      await secondConnection.close();
    }
    expect(targetExactReads).toBeGreaterThanOrEqual(1);
    const scribes = (await sm.listTasks({})).filter((t) => t.taskKind === 'scribe');
    expect(scribes.map((t) => t.taskId)).toEqual(['racer-scribe-s1']);
    expect((await sm.listTasks({})).length).toBe(beforeCount);
  });

  it('来源链需要回填但后继已冲突 → 冲突先于回填写入, 源任务字节与行数不变', async () => {
    await mkTask('c8-dreamer', 'dreamer', 'succeeded', { correlationId: 'c8', topCandidateId: 'c8', pipelineMode: 'full_chain' });
    await mkTask('c8-philosopher-p1', 'philosopher', 'succeeded', {
      correlationId: 'c8', dependencyTaskIds: ['c8-dreamer'], pipelineMode: 'full_chain',
    });
    await mkTask('c8-scribe-exact-a', 'scribe', 'succeeded', {
      parentTaskId: 'c8-philosopher-p1', correlationId: 'c8', pipelineMode: 'full_chain',
    });
    await mkTask('c8-scribe-exact-b', 'scribe', 'pending', {
      parentTaskId: 'c8-philosopher-p1', correlationId: 'c8', pipelineMode: 'full_chain',
    });
    const beforeSource = need(await sm.getTask('c8-philosopher-p1'), 'source before').diagnosticJson;
    const beforeCount = (await sm.listTasks({})).length;
    const orchestrator = new InternalizationOrchestrator(
      { stateManager: sm }, { owner: 'r8-conflict', runtimeKind: 'test-double', dryRun: true },
    );

    const result = await orchestrator.commitNextTaskProposal('c8-philosopher-p1');

    expect(result.decision).toBe('successor_integrity_conflict');
    if (result.decision === 'successor_integrity_conflict') {
      expect(result.conflictingSuccessorTaskIds).toEqual(['c8-scribe-exact-a', 'c8-scribe-exact-b']);
    }
    const afterSource = need(await sm.getTask('c8-philosopher-p1'), 'source after').diagnosticJson;
    expect(afterSource).toBe(beforeSource);
    expect((await sm.listTasks({})).length).toBe(beforeCount);
  });
});
