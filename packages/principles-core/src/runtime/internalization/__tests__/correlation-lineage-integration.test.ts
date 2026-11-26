/**
 * PRI-1293 Phase 3 — 十二项强制血缘测试的集成半区 (TECH §3.6.3)。
 *
 * 与 correlation-lineage.test.ts (单元半区) 的分工: 本文件经 REAL
 * RuntimeStateManager + REAL orchestrator 生产路径验证血缘门禁的副作用契约:
 *   - commitNextTaskProposal: 拒绝 = lineage_refused 结构化 decision +
 *     零 createTask 零写入; 通过 = 后继 metadata 写入验证/恢复的 id;
 *   - reopenTaskForRevision (Owner revise_once / rollout / repair-complete
 *     reopen 的共同核心): 篡改链拒绝且原始 metadata 逐字节不变; 历史链
 *     reopen 安全补入已验证 id;
 *   - DiagnosticianStageKind 分支不受门禁影响;
 *   - repair 完成后 REOPEN_SOURCE_EVALUATOR 继承同一 correlationId。
 * Evaluator Repair Seeder (host-runtime / pd-cli) 的生产路径集成见
 * host-runtime tests (evaluator-repair-lineage.test.ts)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { InternalizationOrchestrator } from '../internalization-orchestrator.js';
import { reopenTaskForRevision } from '../revision-reopen.js';
import { hydratePITaskRecord, createPITaskDiagnosticJson, PI_METADATA_KEY } from '../pitask-metadata.js';
import { isDiagnosticianStageKind } from '../peer-runner-contracts.js';

const CAND_A = 'cand-aaaa';
const CAND_B = 'cand-bbbb';

let workspaceDir: string;
let stateManager: RuntimeStateManager;
let orchestrator: InternalizationOrchestrator;

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-lineage-'));
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  orchestrator = new InternalizationOrchestrator(
    { stateManager }, { owner: 'lineage-itest', runtimeKind: 'test-double', dryRun: true },
  );
});

afterEach(async () => {
  await stateManager.close();
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
});

/** 空值收窄: 缺行即失败测试, 不静默通过 (也避免 no-non-null-assertion)。 */
function need<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${label} to exist`);
  return value;
}

// eslint-disable-next-line @typescript-eslint/max-params -- 夹具四参形态与全文件调用点一致
async function mkTask(
  taskId: string,
  taskKind: string,
  status: 'pending' | 'succeeded' | 'needs_human_review' | 'retry_wait',
  meta: { parentTaskId?: string; correlationId?: string; topCandidateId?: string; dependencyTaskIds?: string[]; runnerDecision?: string },
): Promise<string> {
  await stateManager.createTask({
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
      },
      ...(meta.topCandidateId !== undefined ? { candidateId: meta.topCandidateId } : {}),
    }),
  });
  return taskId;
}

/** 历史链标准夹具: dreamer(仅 seed candidateId) → philosopher → scribe, 全程无 id。 */
async function seedLegacyChain(options?: { topCandidateId?: string }): Promise<{ dreamer: string; philosopher: string; scribe: string }> {
  const dreamer = await mkTask('dreamer-legacy-prompt', 'dreamer', 'succeeded', { topCandidateId: options?.topCandidateId ?? CAND_A });
  const philosopher = await mkTask(`philosopher-legacy-${Math.random().toString(36).slice(2, 8)}-prompt`, 'philosopher', 'succeeded', { parentTaskId: dreamer });
  const scribe = await mkTask(`scribe-legacy-${Math.random().toString(36).slice(2, 8)}-prompt`, 'scribe', 'succeeded', { parentTaskId: philosopher });
  return { dreamer, philosopher, scribe };
}

async function successorIds(): Promise<string[]> {
  const tasks = await stateManager.listTasks();
  return tasks.map((t) => t.taskId);
}

describe('§3.6.3 (1)(3) — 正常推进与历史恢复 (commit ADVANCE 路径)', () => {
  it('test 1: dreamer→philosopher 正常推进 — 后继创建并携带验证的 correlationId + parentTaskId', async () => {
    await mkTask('dreamer-t1-prompt', 'dreamer', 'succeeded', { correlationId: CAND_A, topCandidateId: CAND_A });
    const result = await orchestrator.commitNextTaskProposal('dreamer-t1-prompt');
    expect(result.decision).toBe('successor_created');
    if (result.decision !== 'successor_created') return;
    const successor = await stateManager.getTask(result.successorTaskId);
    expect(successor?.taskKind).toBe('philosopher');
    const pi = hydratePITaskRecord(need(successor, 'successor task'));
    expect(pi?.correlationId).toBe(CAND_A);
    expect(pi?.parentTaskId).toBe('dreamer-t1-prompt');
  });

  it('test 3: 历史多跳无 id 链恢复 — successor metadata 写入根侧恢复的 id, taskId 派生不漂移 (D2)', async () => {
    const { scribe } = await seedLegacyChain({ topCandidateId: CAND_A });
    const result = await orchestrator.commitNextTaskProposal(scribe);
    expect(result.decision).toBe('successor_created');
    if (result.decision !== 'successor_created') return;
    // D2: 历史链无 correlationId → 后继 taskId 派生保持原样 (stripTrailingChannel),
    // 恢复的 id 只写 metadata — 在途链的确定性去重不被破坏。
    expect(result.successorTaskId.startsWith('artificer-scribe-legacy')).toBe(true);
    expect(result.successorTaskId).not.toContain(CAND_A);
    const pi = hydratePITaskRecord(need(await stateManager.getTask(result.successorTaskId), 'successor'));
    expect(pi?.correlationId).toBe(CAND_A);
  });

  it('test 1b: recovery 重放幂等 — 同链二次 commit → successor_exists, 不重复创建', async () => {
    const { scribe } = await seedLegacyChain();
    const first = await orchestrator.commitNextTaskProposal(scribe);
    expect(first.decision).toBe('successor_created');
    const second = await orchestrator.commitNextTaskProposal(scribe);
    expect(second.decision).toBe('successor_exists');
    expect((await successorIds()).filter((id) => id.startsWith('artificer-')).length).toBe(1);
  });
});

describe('§3.6.3 (2)(4)(8)(10)(11)(12) — commit 拒绝路径 (零后继零写入)', () => {
  it('test 2: 父子 correlationId 冲突 → lineage_refused + 零创建', async () => {
    const dreamer = await mkTask('dreamer-conflict-prompt', 'dreamer', 'succeeded', { correlationId: CAND_A, topCandidateId: CAND_A });
    const philosopher = await mkTask('philosopher-conflict-prompt', 'philosopher', 'succeeded', { parentTaskId: dreamer, correlationId: CAND_B });
    const before = await successorIds();
    const result = await orchestrator.commitNextTaskProposal(philosopher);
    expect(result).toEqual({
      decision: 'lineage_refused',
      sourceTaskId: philosopher,
      reason: 'conflicting_parent_correlation_id',
      detail: expect.stringContaining(CAND_A),
    });
    expect(await successorIds()).toEqual(before);
  });

  it('test 4: 不可恢复孤儿 (scribe 单节点无链无 id) → lineage_refused + 零创建', async () => {
    // 用 scribe (非决策型 → ADVANCE 路径) 而非 evaluator: evaluator 缺
    // runnerDecision 时先走 blocked_missing_verdict (P0-3 门先于血缘门)。
    await mkTask('scribe-orphan-prompt', 'scribe', 'succeeded', {});
    const before = await successorIds();
    const result = await orchestrator.commitNextTaskProposal('scribe-orphan-prompt');
    expect(result.decision).toBe('lineage_refused');
    if (result.decision === 'lineage_refused') {
      expect(result.reason).toBe('missing_correlation_id_lineage');
      expect(result.detail).toContain('unrecoverable_chain_root_not_dreamer');
    }
    expect(await successorIds()).toEqual(before);
  });

  it('test 8: 有 id 但父任务不存在 → dangling_parent_reference 拒绝 + 零创建', async () => {
    await mkTask('scribe-dangling-prompt', 'scribe', 'succeeded', { parentTaskId: 'parent-vanished', correlationId: CAND_A });
    const result = await orchestrator.commitNextTaskProposal('scribe-dangling-prompt');
    expect(result.decision).toBe('lineage_refused');
    if (result.decision === 'lineage_refused') expect(result.reason).toBe('dangling_parent_reference');
    expect((await successorIds()).filter((id) => id.startsWith('artificer-')).length).toBe(0);
  });

  it('test 9: 根双源冲突 (taskId 解析 A、seed 解析 B) → conflicting_root_identity_sources', async () => {
    await mkTask('dreamer-11111111-1111-4111-8111-111111111111-prompt', 'dreamer', 'succeeded', { topCandidateId: CAND_B });
    const philosopher = await mkTask('philosopher-rootconflict-prompt', 'philosopher', 'succeeded', { parentTaskId: 'dreamer-11111111-1111-4111-8111-111111111111-prompt' });
    const result = await orchestrator.commitNextTaskProposal(philosopher);
    expect(result.decision).toBe('lineage_refused');
    if (result.decision === 'lineage_refused') expect(result.reason).toBe('conflicting_root_identity_sources');
  });

  it('test 10: 父链自环 → parent_chain_cycle_or_depth_exceeded 拒绝', async () => {
    const a = await mkTask('cycle-a-t', 'philosopher', 'succeeded', { parentTaskId: 'cycle-b-t', correlationId: CAND_A });
    await mkTask('cycle-b-t', 'scribe', 'succeeded', { parentTaskId: 'cycle-a-t', correlationId: CAND_A });
    const result = await orchestrator.commitNextTaskProposal(a);
    expect(result.decision).toBe('lineage_refused');
    if (result.decision === 'lineage_refused') expect(result.reason).toBe('parent_chain_cycle_or_depth_exceeded');
  });

  it('test 11: 深度上限语义 — 9→10 边创建放行, 10→11 创建前结构化拒绝, 11 边源读取侧拒绝', async () => {
    // 链: dreamer(深度0) → p1..p9 (p9 深度9) → leaf (深度10)。
    await mkTask('dreamer-depth-prompt', 'dreamer', 'succeeded', { correlationId: CAND_A, topCandidateId: CAND_A });
    for (let i = 1; i <= 9; i++) {
      await mkTask(`depth-p${i}`, 'philosopher', 'succeeded', { parentTaskId: i === 1 ? 'dreamer-depth-prompt' : `depth-p${i - 1}`, correlationId: CAND_A });
    }

    // (a) 深度 9 的源创建深度 10 的后继 — 放行 (评审: 9→10 应通过)。
    const nineEdge = await orchestrator.commitNextTaskProposal('depth-p9');
    expect(nineEdge.decision, JSON.stringify(nineEdge)).toBe('successor_created');

    // (b) 深度 10 的源创建后继会变成第 11 条边 — 必须在持久化前结构化
    // 拒绝, 零 createTask (评审: 修复前此处断言 successor_created, 恰好
    // 制造"已创建但永远无法推进"的任务)。
    const leafAtCap = await mkTask('depth-leaf-ok', 'scribe', 'succeeded', { parentTaskId: 'depth-p9', correlationId: CAND_A });
    const taskCountBefore = (await successorIds()).length;
    const atCap = await orchestrator.commitNextTaskProposal(leafAtCap);
    expect(atCap.decision, JSON.stringify(atCap)).toBe('lineage_refused');
    if (atCap.decision === 'lineage_refused') {
      expect(atCap.reason).toBe('parent_chain_cycle_or_depth_exceeded');
      expect(atCap.detail).toContain('successor_would_exceed_depth_limit:11_edges_max_10');
    }
    expect((await successorIds()).length).toBe(taskCountBefore);
    // 深度 10 的源自身保持可读 (读取侧不拒绝) — 拒绝只发生在后继创建。
    const { resolveAuthoritativeCorrelationId, correlationLineageGetTask } = await import('../correlation-lineage.js');
    const rawLeaf = await stateManager.getTask(leafAtCap);
    if (!rawLeaf) throw new Error('depth-capped leaf missing');
    const readable = await resolveAuthoritativeCorrelationId(rawLeaf, correlationLineageGetTask(stateManager));
    expect(readable.ok).toBe(true);

    // (c) 11 条边的源: resolver 读取侧即拒绝 (行为保持)。
    await mkTask('depth-p10', 'philosopher', 'succeeded', { parentTaskId: 'depth-p9', correlationId: CAND_A });
    const leafDeep = await mkTask('depth-leaf-deep', 'scribe', 'succeeded', { parentTaskId: 'depth-p10', correlationId: CAND_A });
    const deep = await orchestrator.commitNextTaskProposal(leafDeep);
    expect(deep.decision).toBe('lineage_refused');
    if (deep.decision === 'lineage_refused') {
      expect(deep.reason).toBe('parent_chain_cycle_or_depth_exceeded');
      expect(deep.detail).toContain('depth_limit_exceeded:10_edges');
    }
  });

  it('test 12: 根全盲 (taskId/seed/自身 id 全缺) 仅后代声明 → 拒绝 + 零创建', async () => {
    await mkTask('dreamer-blind-prompt', 'dreamer', 'succeeded', {});
    const philosopher = await mkTask('philosopher-blind-claim', 'philosopher', 'succeeded', { parentTaskId: 'dreamer-blind-prompt', correlationId: CAND_A });
    const result = await orchestrator.commitNextTaskProposal(philosopher);
    expect(result.decision).toBe('lineage_refused');
    if (result.decision === 'lineage_refused') {
      expect(result.reason).toBe('missing_correlation_id_lineage');
      expect(result.detail).toContain('root_corroboration_failed');
    }
    expect((await successorIds()).filter((id) => id.startsWith('scribe-')).length).toBe(0);
  });
});

describe('§3.6.3 (5) — DiagnosticianStageKind 作用域隔离', () => {
  it('诊断链分支不受血缘门禁影响: diag 任务经 commit 真实创建 diag 后继', async () => {
    expect(isDiagnosticianStageKind('diag_rootcause')).toBe(true);
    // CodeRabbit review: proposeNextTask 不经过血缘门禁, 即使门禁错误地把
    // 诊断任务一并拒绝该路径仍会通过 — 必须走 commitNextTaskProposal 生产
    // 路径并断言后继真实落库。诊断子任务没有 correlationId/可校验父链,
    // 若被误纳入门禁, commit 将拒绝而非创建。
    await mkTask('diag_rootcause-1', 'diag_rootcause', 'succeeded', {});
    const result = await orchestrator.commitNextTaskProposal('diag_rootcause-1');
    expect(result.decision, JSON.stringify(result)).toBe('successor_created');
    if (result.decision !== 'successor_created') return;
    const successor = await stateManager.getTask(result.successorTaskId);
    expect(successor?.taskKind).toBe('diag_distiller');
    const pi = hydratePITaskRecord(successor!);
    expect(pi?.parentTaskId).toBe('diag_rootcause-1');
    expect(pi?.correlationId).toBeUndefined();
    expect(pi?.dependencyTaskIds).toContain('diag_rootcause-1');
  });
});

describe('§3.6.3 (7) — reopenTaskForRevision 血缘保持 / 篡改拒绝 (Owner revise_once 共同核心)', () => {
  it('合法链 reopen: ok, correlationId 保持, revisionCount+1, 单次原子写', async () => {
    const { scribe } = await seedLegacyChain({ topCandidateId: CAND_A });
    // 历史链 scribe 无 id — reopen 会在同一次原子写中补入恢复值 (§5.3.7)。
    const before = await stateManager.getTask(scribe);
    const result = await reopenTaskForRevision(stateManager, scribe, {
      revisionCauseId: 'owner-res-t7',
      revisionFeedback: 'owner instruction',
      reason: 'owner_revise_once',
    });
    expect(result.ok).toBe(true);
    const after = await stateManager.getTask(scribe);
    expect(after?.status).toBe('pending');
    const pi = hydratePITaskRecord(need(after, 'reopened task'));
    expect(pi?.correlationId).toBe(CAND_A); // 补入已验证 id
    expect(pi?.revisionCount).toBe(1);
    expect(pi?.revisionCauseId).toBe('owner-res-t7');
    expect(pi?.runnerDecision).toBeUndefined();
    expect(before?.attemptCount).toBe(1);
    expect(after?.attemptCount).toBe(0); // attemptCount 重置语义保持
  });

  it('同 causeId 重放 → idempotent no-op (先于血缘门禁短路)', async () => {
    const { scribe } = await seedLegacyChain();
    const first = await reopenTaskForRevision(stateManager, scribe, { revisionCauseId: 'owner-res-replay', reason: 'owner_revise_once' });
    expect(first.ok).toBe(true);
    const afterFirst = hydratePITaskRecord(need(await stateManager.getTask(scribe), 'scribe after first reopen'));
    const revisionCountAfterFirst = afterFirst?.revisionCount;
    const replay = await reopenTaskForRevision(stateManager, scribe, { revisionCauseId: 'owner-res-replay', reason: 'owner_revise_once' });
    expect(replay).toEqual({ ok: true, reason: 'idempotent_replay_same_revision' });
    const afterReplay = hydratePITaskRecord(need(await stateManager.getTask(scribe), 'scribe after replay'));
    expect(afterReplay?.revisionCount).toBe(revisionCountAfterFirst);
  });

  it('篡改链 reopen 拒绝: 原始 diagnosticJson 逐字节不变、状态不变 (零写入)', async () => {
    const dreamer = await mkTask('dreamer-tamper-prompt', 'dreamer', 'succeeded', { correlationId: CAND_A, topCandidateId: CAND_A });
    const scribe = await mkTask('scribe-tamper', 'scribe', 'needs_human_review', { parentTaskId: dreamer, correlationId: CAND_B });
    const beforeJson = (await stateManager.getTask(scribe))?.diagnosticJson;
    const result = await reopenTaskForRevision(stateManager, scribe, {
      revisionCauseId: 'owner-res-tamper',
      reason: 'owner_revise_once',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'lineage_refused:conflicting_parent_correlation_id',
      detail: `chain_values:[${CAND_B},${CAND_A}]`,
    });
    const after = await stateManager.getTask(scribe);
    expect(after?.diagnosticJson).toBe(beforeJson);
    expect(after?.status).toBe('needs_human_review');
  });

  it('dangling 父引用的 NHR 任务 reopen 拒绝且零写入', async () => {
    const scribe = await mkTask('scribe-nhr-dangling', 'scribe', 'needs_human_review', { parentTaskId: 'gone-parent', correlationId: CAND_A });
    const beforeJson = (await stateManager.getTask(scribe))?.diagnosticJson;
    const result = await reopenTaskForRevision(stateManager, scribe, { revisionCauseId: 'owner-res-dangling' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('lineage_refused:dangling_parent_reference');
    expect((await stateManager.getTask(scribe))?.diagnosticJson).toBe(beforeJson);
  });
});

describe('§3.6.3 (6) — repair → 来源 evaluator reopen 继承同一 correlationId', () => {
  it('repair 完成触发 REOPEN_SOURCE_EVALUATOR: evaluator 保留原 id (mergePITaskMetadata 不丢字段)', async () => {
    // 链: dreamer(A) → scribe(A) → artificer-original(A) → evaluator(A)
    // evaluator needs_revision 产出 repair artificer (parent=evaluator),
    // repairPayload.sourceEvaluatorTaskId 指回 evaluator。
    const dreamer = await mkTask('dreamer-repair-prompt', 'dreamer', 'succeeded', { correlationId: CAND_A, topCandidateId: CAND_A });
    const scribe = await mkTask('scribe-repair', 'scribe', 'succeeded', { parentTaskId: dreamer, correlationId: CAND_A });
    await mkTask('artificer-repair-1', 'artificer', 'succeeded', {
      parentTaskId: scribe,
      correlationId: CAND_A,
      runnerDecision: 'approved',
    });
    // 手工补 repairPayload (含 sourceEvaluatorTaskId + iteration)。
    const artificerRaw = await stateManager.getTask('artificer-repair-1');
    const artificerPi = hydratePITaskRecord(need(artificerRaw, 'repair artificer task'));
    await stateManager.updateTask('artificer-repair-1', {
      diagnosticJson: createPITaskDiagnosticJson({
        ...need(artificerPi, 'repair artificer metadata'),
        repairPayload: {
          requiredChanges: ['fix x'],
          concerns: [],
          previousScore: 0.5,
          repairIteration: 1,
          sourceArtificerArtifactId: 'pi-art-a',
          sourceEvaluatorTaskId: 'evaluator-repair-src',
          sourceEvaluatorRunId: 'run-1',
        },
      }),
    });
    // CodeRabbit review fix: evaluator 初始必须依赖**原** artificer — 修复前
    // 夹具直接把 repair artificer 写成依赖, 即使 reopen 不换依赖最终断言也
    // 照样通过 (vacuous)。生产方向: evaluator 的 parent/dep 是产出被评工件
    // 的原 artificer; repair artificer 的 parent 才是 evaluator。
    const originalArtificer = await mkTask('artificer-original', 'artificer', 'succeeded', {
      parentTaskId: scribe,
      correlationId: CAND_A,
      runnerDecision: 'approved',
    });
    const evaluator = await mkTask('evaluator-repair-src', 'evaluator', 'succeeded', {
      parentTaskId: originalArtificer,
      correlationId: CAND_A,
      runnerDecision: 'needs_revision',
      dependencyTaskIds: [originalArtificer],
    });
    // repair artificer 的父链按生产方向指向来源 evaluator。
    const repairRaw = await stateManager.getTask('artificer-repair-1');
    const repairPi = hydratePITaskRecord(need(repairRaw, 'repair artificer'));
    await stateManager.updateTask('artificer-repair-1', {
      diagnosticJson: createPITaskDiagnosticJson({
        ...need(repairPi, 'repair artificer metadata'),
        parentTaskId: evaluator,
      }),
    });

    const result = await orchestrator.commitNextTaskProposal('artificer-repair-1');
    expect(result.decision).toBe('revision_reopened');
    if (result.decision !== 'revision_reopened') return;
    expect(result.reopenedTaskId).toBe(evaluator);
    const reopened = hydratePITaskRecord(need(await stateManager.getTask(evaluator), 'reopened evaluator'));
    // 继承语义: evaluator 的 correlationId 经 reopen 原样保留。
    expect(reopened?.correlationId).toBe(CAND_A);
    expect(reopened?.status).toBe('pending');
    // 依赖替换的真实证明: 原 artificer 依赖被换出, repair artificer 换入
    // (PRI-668 / P0-D 语义保持) — 两个方向都必须断言。
    expect(reopened?.dependencyTaskIds).toContain('artificer-repair-1');
    expect(reopened?.dependencyTaskIds).not.toContain('artificer-original');
  });
});

describe('PRI-1293 review fix — 修订重开复用历史终态后继, 不派生重复后继 (finding 2)', () => {
  it('历史链 artificer 修订波: 级联按 (parent,kind,channel) 扫描命中原终态 evaluator 并重开它, 重放零新增任务', async () => {
    // 场景出自复核例: 历史代码规则链全程无 correlationId, 后继 id 由
    // stripTrailingChannel 派生 (evaluator-artificer-legacy-prompt)。
    const dreamer = await mkTask('dreamer-legacy-prompt', 'dreamer', 'succeeded', { topCandidateId: CAND_A });
    const philosopher = await mkTask('philosopher-legacy-prompt', 'philosopher', 'succeeded', { parentTaskId: dreamer });
    const scribe = await mkTask('scribe-legacy-prompt', 'scribe', 'succeeded', { parentTaskId: philosopher });
    const artificer = await mkTask('artificer-legacy-prompt', 'artificer', 'succeeded', { parentTaskId: scribe });
    const evaluator = await mkTask('evaluator-artificer-legacy-prompt', 'evaluator', 'succeeded', {
      parentTaskId: artificer,
      dependencyTaskIds: [artificer],
      runnerDecision: 'approved',
    });
    const taskCountBefore = (await successorIds()).length;

    // 1) Owner 修订 artificer — reopen 补入恢复的 correlationId (cand-aaaa),
    //    revisionCount=1。此后派生根从 artificer-legacy 漂移到 cand-aaaa,
    //    直查 evaluator-cand-aaaa-prompt 必未命中 — 修复前在此制造重复后继。
    const reopenedSource = await reopenTaskForRevision(stateManager, artificer, {
      revisionCauseId: 'owner-revise-art',
      reason: 'owner_revise_once',
    });
    expect(reopenedSource.ok).toBe(true);
    const sourcePi = hydratePITaskRecord(need(await stateManager.getTask(artificer), 'reopened artificer'));
    expect(sourcePi?.correlationId).toBe(CAND_A);
    expect(sourcePi?.revisionCount).toBe(1);

    // 2) 模拟 artificer 重跑完成 (修订波上游重新 succeeded)。
    await stateManager.updateTask(artificer, { status: 'succeeded', attemptCount: 1 });

    // 3) commit: 级联必须复用原 evaluator (真实 id), 而不是创建
    //    evaluator-cand-aaaa-prompt。
    const first = await orchestrator.commitNextTaskProposal(artificer);
    expect(first.decision, JSON.stringify(first)).toBe('successor_reopened');
    if (first.decision !== 'successor_reopened') return;
    expect(first.reopenedTaskId).toBe(evaluator);
    // 原 evaluator 回到 pending 等待重跑; 没有任何新任务被创建。
    const reopenedEvaluator = hydratePITaskRecord(need(await stateManager.getTask(evaluator), 'cascade-reopened evaluator'));
    expect(reopenedEvaluator?.status).toBe('pending');
    expect(reopenedEvaluator?.revisionCauseId).toBe(`cascade-${artificer}-rc1-${evaluator}`);
    expect((await successorIds()).length).toBe(taskCountBefore);
    expect((await successorIds()).some((id) => id.includes(CAND_A))).toBe(false);

    // 4) 重放 commit: evaluator 已在途 (pending) → successor_exists, 仍零新增。
    const replay = await orchestrator.commitNextTaskProposal(artificer);
    expect(replay.decision).toBe('successor_exists');
    if (replay.decision === 'successor_exists') {
      expect(replay.successorTaskId).toBe(evaluator);
    }
    expect((await successorIds()).length).toBe(taskCountBefore);
  });
});

describe('PRI-1293 review fix — 级联重开拒绝透出真实血缘原因 (finding 4 后半)', () => {
  it('终态后继自身链冲突时, 级联拒绝映射为 lineage_refused 而非 successor_exists', async () => {
    // 源链一致 (cand-aaaa), 但终态 evaluator 自带冲突标识 cand-bbbb:
    // reopen 校验其链时 claimed = {cand-bbbb, cand-aaaa} → 拒绝。
    const dreamer = await mkTask('dreamer-cascade-prompt', 'dreamer', 'succeeded', { correlationId: CAND_A, topCandidateId: CAND_A });
    const artificer = await mkTask('artificer-cascade', 'artificer', 'succeeded', {
      parentTaskId: dreamer,
      correlationId: CAND_A,
    });
    await mkTask('evaluator-cascade-conflict', 'evaluator', 'succeeded', {
      parentTaskId: artificer,
      correlationId: CAND_B,
      dependencyTaskIds: [artificer],
    });
    // 源已经历修订 (revisionCount=1) — 直接 reopen + 重新完成构造。
    const reopenedSource = await reopenTaskForRevision(stateManager, artificer, {
      revisionCauseId: 'owner-revise-cascade',
      reason: 'owner_revise_once',
    });
    expect(reopenedSource.ok).toBe(true);
    await stateManager.updateTask(artificer, { status: 'succeeded', attemptCount: 1 });

    const result = await orchestrator.commitNextTaskProposal(artificer);
    expect(result.decision, JSON.stringify(result)).toBe('lineage_refused');
    if (result.decision !== 'lineage_refused') return;
    expect(result.reason).toBe('conflicting_parent_correlation_id');
    expect(result.detail ?? '').toContain('cascade_reopen_refused:evaluator-cascade-conflict');
    // 拒绝不折叠、不创建任何任务。
    expect((await successorIds()).some((id) => id.startsWith('evaluator-cand'))).toBe(false);
  });
});

describe('PRI-1293 review fix — revision reopen CAS 并发安全 (finding: lease clobbering)', () => {
  it('血缘异步读取期间任务被并发 lease → CAS 拒绝,  reopen 零写入, 任务保持 leased 原状', async () => {
    // 真实竞态形态: 目标处于 pending (revision-refresh 路径), 血缘多跳
    // 读取期间另一 consumer 取得 lease。修复前无条件 updateTask 会把
    // status 覆盖回 pending、attemptCount 清零, lease 字段悬空。
    const dreamer = await mkTask('dreamer-cas-prompt', 'dreamer', 'succeeded', { correlationId: CAND_A, topCandidateId: CAND_A });
    const philosopher = await mkTask('philosopher-cas', 'philosopher', 'succeeded', { parentTaskId: dreamer, correlationId: CAND_A });
    const scribe = await mkTask('scribe-cas', 'scribe', 'pending', { parentTaskId: philosopher, correlationId: CAND_A });
    const beforeJson = (await stateManager.getTask(scribe))?.diagnosticJson;

    // 在血缘链读取 philosopher 一跳时注入并发 lease — 这正是 reopen
    // 校验窗口内的真实交错 ( leased 先于写入落地 )。
    const originalGetTask = stateManager.getTask.bind(stateManager);
    let leaseInjected = false;
    stateManager.getTask = async (id: string) => {
      if (!leaseInjected && id === philosopher) {
        leaseInjected = true;
        await stateManager.acquireLease({ taskId: scribe, owner: 'rival-consumer', runtimeKind: 'test-double' });
      }
      return originalGetTask(id);
    };
    let result;
    try {
      result = await reopenTaskForRevision(stateManager, scribe, {
        revisionCauseId: 'owner-cas-race',
        reason: 'owner_revise_once',
      });
    } finally {
      stateManager.getTask = originalGetTask;
    }

    expect(leaseInjected).toBe(true);
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(result.reason).toBe('concurrent_modification');
    // 零写入: 任务仍是 rival 的 leased 状态, metadata 逐字节不变,
    // revisionCount/revisionCauseId 均未落地。
    const after = need(await stateManager.getTask(scribe), 'scribe after cas conflict');
    expect(after.status).toBe('leased');
    expect(after.leaseOwner).toBe('rival-consumer');
    expect(after.diagnosticJson).toBe(beforeJson);
    const afterPi = hydratePITaskRecord(after);
    expect(afterPi?.revisionCauseId).toBeUndefined();
    expect(afterPi?.revisionCount ?? 0).toBe(0);
  });

  it('无并发干扰时 CAS 路径 reopen 照常成功 (回归保护)', async () => {
    const { scribe } = await seedLegacyChain({ topCandidateId: CAND_A });
    const result = await reopenTaskForRevision(stateManager, scribe, {
      revisionCauseId: 'owner-cas-normal',
      reason: 'owner_revise_once',
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const after = hydratePITaskRecord(need(await stateManager.getTask(scribe), 'reopened scribe'));
    expect(after?.status).toBe('pending');
    expect(after?.revisionCount).toBe(1);
    expect(after?.correlationId).toBe(CAND_A);
  });
});
