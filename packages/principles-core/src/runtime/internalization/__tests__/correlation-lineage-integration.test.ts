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

  it('test 11: 10 条父链边通过 (后继创建), 11 条边拒绝 (lineage_refused)', async () => {
    // 10 条边: dreamer + p1..p9 + leaf (11 节点, 10 边) → 通过。
    await mkTask('dreamer-depth-prompt', 'dreamer', 'succeeded', { correlationId: CAND_A, topCandidateId: CAND_A });
    for (let i = 1; i <= 9; i++) {
      await mkTask(`depth-p${i}`, 'philosopher', 'succeeded', { parentTaskId: i === 1 ? 'dreamer-depth-prompt' : `depth-p${i - 1}`, correlationId: CAND_A });
    }
    const leafOk = await mkTask('depth-leaf-ok', 'scribe', 'succeeded', { parentTaskId: 'depth-p9', correlationId: CAND_A });
    const ok = await orchestrator.commitNextTaskProposal(leafOk);
    expect(ok.decision).toBe('successor_created');

    // 11 条边: 在同一链上再挂一层 → 拒绝。
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
  it('诊断链分支不受血缘门禁影响: diag 任务 proposeNextTask 照常产出 diag 后继 proposal', async () => {
    expect(isDiagnosticianStageKind('diag_rootcause')).toBe(true);
    // 诊断子任务没有 correlationId / 可校验父链 — 若被误纳入门禁, proposal 将
    // 无法生成。这是 §4.2 作用域隔离的正向证明。
    await mkTask('diag_rootcause-1', 'diag_rootcause', 'succeeded', {});
    const proposal = await orchestrator.proposeNextTask('diag_rootcause-1');
    expect(proposal?.decision).toBe('proposal_created');
    if (proposal?.decision === 'proposal_created') {
      expect(proposal.proposal.taskKind).toBe('diag_distiller');
      expect(proposal.proposal.correlationId).toBeUndefined();
      expect(proposal.proposal.parentTaskId).toBe('diag_rootcause-1');
    }
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
    expect(result).toEqual({ ok: false, reason: 'lineage_refused:conflicting_parent_correlation_id' });
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
    // 链: dreamer(A) → scribe(A) → artificer(A, repairPayload) — repairPayload
    // 的 sourceEvaluatorTaskId 指向 evaluator(A)。
    const dreamer = await mkTask('dreamer-repair-prompt', 'dreamer', 'succeeded', { correlationId: CAND_A, topCandidateId: CAND_A });
    const scribe = await mkTask('scribe-repair', 'scribe', 'succeeded', { parentTaskId: dreamer, correlationId: CAND_A });
    const artificer = await mkTask('artificer-repair-1', 'artificer', 'succeeded', {
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
    const evaluator = await mkTask('evaluator-repair-src', 'evaluator', 'succeeded', {
      parentTaskId: 'artificer-repair-1',
      correlationId: CAND_A,
      runnerDecision: 'needs_revision',
      dependencyTaskIds: [artificer],
    });

    const result = await orchestrator.commitNextTaskProposal('artificer-repair-1');
    expect(result.decision).toBe('revision_reopened');
    if (result.decision !== 'revision_reopened') return;
    expect(result.reopenedTaskId).toBe(evaluator);
    const reopened = hydratePITaskRecord(need(await stateManager.getTask(evaluator), 'reopened evaluator'));
    // 继承语义: evaluator 的 correlationId 经 reopen 原样保留。
    expect(reopened?.correlationId).toBe(CAND_A);
    expect(reopened?.status).toBe('pending');
    // 依赖换到 repair artificer (PRI-668 / P0-D 语义保持)。
    expect(reopened?.dependencyTaskIds).toContain('artificer-repair-1');
  });
});
