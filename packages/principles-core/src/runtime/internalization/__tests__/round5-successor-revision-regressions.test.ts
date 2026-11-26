/**
 * PRI-1293 Round-5 评审回归 — 真实 RuntimeStateManager (sqlite) + 真实 orchestrator。
 *
 * 三个已核实生产缺陷的回归钉:
 *   F1 跨链派生 id 碰撞: RuleHost 时间戳链与队列链共享候选身份时, 直查命中
 *      异链 evaluator 会被级联重开 (错链) — 修复后父子扫描为唯一权威, 异链
 *      occupant 不命中, 创建收敛到父派生 fallback id;
 *   F2 revisionCauseId 单槽覆盖: 级联传播后修复重开覆写单槽, 上游重扫的旧
 *      级联 dedup 失效 → 重复传播回滚修复成果 — 修复后消费历史成员判定
 *      (mergePITaskMetadata 写不变量折入) 使重扫幂等;
 *   F3 planner 共享判定: exists_plain / cascade_reopen / already_materialized
 *      三态与 commit 消费同一纯函数。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { InternalizationOrchestrator } from '../internalization-orchestrator.js';
import { reopenTaskForRevision, planExistingSuccessorTransition, buildCascadeRevisionCauseId } from '../revision-reopen.js';
import { hydratePITaskRecord, createPITaskDiagnosticJson, mergePITaskMetadata, hasConsumedRevisionCause, PI_METADATA_KEY, type RunnerDecision } from '../pitask-metadata.js';

const CAND_X = 'cand-xxxx';

let workspaceDir: string;
let stateManager: RuntimeStateManager;
let orchestrator: InternalizationOrchestrator;

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-r5-'));
  stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  orchestrator = new InternalizationOrchestrator(
    { stateManager }, { owner: 'r5-itest', runtimeKind: 'test-double', dryRun: true },
  );
});

afterEach(async () => {
  await stateManager.close();
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
});

function need<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${label} to exist`);
  return value;
}

interface SeedMeta {
  parentTaskId?: string;
  correlationId?: string;
  topCandidateId?: string;
  dependencyTaskIds?: string[];
  runnerDecision?: string;
  revisionCount?: number;
  pipelineMode?: string;
}

// eslint-disable-next-line @typescript-eslint/max-params -- 夹具四参形态与 lineage 集成测试文件惯例一致
async function mkTask(
  taskId: string,
  taskKind: string,
  status: 'pending' | 'succeeded' | 'needs_human_review' | 'retry_wait' | 'failed',
  meta: SeedMeta,
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
        ...(meta.pipelineMode !== undefined ? { pipelineMode: meta.pipelineMode } : {}),
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        runnerDecision: meta.runnerDecision,
        ...(meta.revisionCount !== undefined ? { revisionCount: meta.revisionCount } : {}),
        ...(meta.parentTaskId !== undefined ? { parentTaskId: meta.parentTaskId } : {}),
        ...(meta.correlationId !== undefined ? { correlationId: meta.correlationId } : {}),
      },
      ...(meta.topCandidateId !== undefined ? { candidateId: meta.topCandidateId } : {}),
    }),
  });
  return taskId;
}

/** 真实租约闭环重完成: pending/retry_wait → leased → succeeded (fence+runId 真实路径)。 */
async function recomplete(taskId: string): Promise<void> {
  const acquired = await stateManager.acquireLeaseDetailed({ taskId, owner: 'r5', runtimeKind: 'test-double' });
  await stateManager.markTaskSucceeded(
    taskId,
    undefined,
    { taskId, owner: 'r5', leaseGeneration: acquired.leaseGeneration },
    acquired.runId,
  );
}

async function writeVerdict(taskId: string, runnerDecision: RunnerDecision): Promise<void> {
  const raw = need(await stateManager.getTask(taskId), `${taskId} row`);
  const pi = need(hydratePITaskRecord(raw), `${taskId} pi`);
  await stateManager.updateTaskDiagnosticJson(taskId, createPITaskDiagnosticJson(mergePITaskMetadata(pi, { runnerDecision })));
}

/**
 * 全链夹具: dreamer → philosopher → scribe → artificer (均 succeeded, correlationId
 * 全程一致, full_chain 模式使 artificer→evaluator 提案合法)。chainPrefix 区分
 * 队列链 (确定性 id) 与 RuleHost 链 (时间戳形态 id)。
 */
async function seedFullChain(chainPrefix: string, ids: { timestamped: boolean }): Promise<{ dreamer: string; philosopher: string; scribe: string; artificer: string }> {
  const suffix = ids.timestamped ? `-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` : '';
  const dreamer = await mkTask(`${chainPrefix}-dreamer${suffix}`, 'dreamer', 'succeeded', { correlationId: CAND_X, topCandidateId: CAND_X, pipelineMode: 'full_chain' });
  const philosopher = await mkTask(`${chainPrefix}-philosopher${suffix}`, 'philosopher', 'succeeded', { parentTaskId: dreamer, correlationId: CAND_X, pipelineMode: 'full_chain' });
  const scribe = await mkTask(`${chainPrefix}-scribe${suffix}`, 'scribe', 'succeeded', { parentTaskId: philosopher, correlationId: CAND_X, pipelineMode: 'full_chain' });
  const artificer = await mkTask(`${chainPrefix}-artificer${suffix}`, 'artificer', 'succeeded', { parentTaskId: scribe, correlationId: CAND_X, pipelineMode: 'full_chain', dependencyTaskIds: [scribe] });
  return { dreamer, philosopher, scribe, artificer };
}

describe('F1 — 跨链派生 id 碰撞: 级联不再错链, 创建收敛父派生 fallback id', () => {
  it('RuleHost 链修订完成后, 队列链同派生 id 的 evaluator 不被误认/重开, fallback id 创建', async () => {
    // 队列链: artificer + 已存在的终态 evaluator, 占住确定性派生 id。
    const queue = await seedFullChain('queue', { timestamped: false });
    const queueEvaluatorId = `evaluator-${CAND_X}-prompt`;
    await mkTask(queueEvaluatorId, 'evaluator', 'succeeded', {
      parentTaskId: queue.artificer,
      correlationId: CAND_X,
      pipelineMode: 'full_chain',
      dependencyTaskIds: [queue.artificer],
      runnerDecision: 'approved',
    });

    // RuleHost 链: 时间戳形态 id, 同一候选身份 (correlationId 回填语义)。
    // artificer 经历过 revision (rc=1) 且刚重完成 — commit 触发下游级联判定。
    const rulehost = await seedFullChain('rulehost', { timestamped: true });

    // 直接 seed rc=1 的 artificer 状态太繁琐 — 走真实 reopen+重完成闭环。
    const reopenedArtificer = await reopenTaskForRevision(stateManager, rulehost.artificer, {
      revisionCauseId: 'rollout-rh-r1',
      revisionFeedback: 'revise',
      reason: 'owner_revise_once',
    });
    expect(reopenedArtificer.ok).toBe(true);
    await recomplete(rulehost.artificer);

    const queueEvalBefore = need(hydratePITaskRecord(need(await stateManager.getTask(queueEvaluatorId), 'queue evaluator')), 'queue evaluator pi');
    const result = await orchestrator.commitNextTaskProposal(rulehost.artificer);

    // 核心断言 1: 队列链 evaluator 绝未被级联触碰 (pre-fix: 被错链 reopen,
    // verdict 清空, revisionCount+1)。
    const queueEvalAfter = need(hydratePITaskRecord(need(await stateManager.getTask(queueEvaluatorId), 'queue evaluator after')), 'queue evaluator pi after');
    expect(queueEvalAfter.status).toBe('succeeded');
    expect(queueEvalAfter.revisionCount ?? 0).toBe(queueEvalBefore.revisionCount ?? 0);
    expect(queueEvalAfter.runnerDecision).toBe('approved');

    // 核心断言 2: commit 不报告 successor_exists (异链 occupant 不是本父子后继)
    // — RuleHost 链的真实后继被创建, id 为父派生 fallback (主派生 id 被异链占用)。
    expect(result.decision).toBe('successor_created');
    if (result.decision !== 'successor_created') return;
    expect(result.successorTaskId).toBe(`evaluator-${CAND_X}-prompt-p-${rulehost.artificer}`);
    const created = need(hydratePITaskRecord(need(await stateManager.getTask(result.successorTaskId), 'created successor')), 'created pi');
    expect(created.parentTaskId).toBe(rulehost.artificer);
    expect(created.taskKind).toBe('evaluator');

    // 核心断言 3: 幂等重放 — 再次 commit 经扫描命中刚创建的后继 (fallback id
    // 不影响父子身份), 不重复创建。
    const replay = await orchestrator.commitNextTaskProposal(rulehost.artificer);
    expect(replay.decision).toBe('successor_exists');
    if (replay.decision === 'successor_exists') {
      expect(replay.successorTaskId).toBe(result.successorTaskId);
    }
  });
});

describe('F2 — 级联+修复交错: 消费历史使旧级联重扫幂等, 修复成果不回滚', () => {
  it('级联传播→修复重开覆写单槽→上游重扫不再重复 reopen, verdict/依赖/revisionCount 不变', async () => {
    const chain = await seedFullChain('q2', { timestamped: false });
    const evaluatorId = `evaluator-${CAND_X}-prompt`;
    await mkTask(evaluatorId, 'evaluator', 'succeeded', {
      parentTaskId: chain.artificer,
      correlationId: CAND_X,
      pipelineMode: 'full_chain',
      dependencyTaskIds: [chain.artificer],
      runnerDecision: 'approved',
    });

    // ── 第 1 幕: artificer 修订重开后重完成, commit 级联传播到 evaluator ──
    const r1 = await reopenTaskForRevision(stateManager, chain.artificer, {
      revisionCauseId: 'rollout-rh-r1',
      revisionFeedback: 'revise once',
      reason: 'owner_revise_once',
    });
    expect(r1.ok).toBe(true);
    await recomplete(chain.artificer);

    const cascadeResult = await orchestrator.commitNextTaskProposal(chain.artificer);
    expect(cascadeResult.decision).toBe('successor_reopened');
    const cascadeCauseId = buildCascadeRevisionCauseId(chain.artificer, 1, evaluatorId);

    const afterCascade = need(hydratePITaskRecord(need(await stateManager.getTask(evaluatorId), 'evaluator post-cascade')), 'pi post-cascade');
    expect(afterCascade.status).toBe('pending');
    expect(afterCascade.revisionCount).toBe(1);
    expect(afterCascade.revisionCauseId).toBe(cascadeCauseId);
    // 写不变量: 消费历史已含本 cascade cause。
    expect(hasConsumedRevisionCause(afterCascade, cascadeCauseId)).toBe(true);

    // evaluator 重跑完成 (级联修订轮 verdict)。
    await recomplete(evaluatorId);
    await writeVerdict(evaluatorId, 'approved');

    // ── 第 2 幕: 修复完成路径以 repair cause 重开 evaluator (覆写单槽) ──
    const repairCause = 'repair-repairtask-1';
    const r2 = await reopenTaskForRevision(stateManager, evaluatorId, {
      revisionCauseId: repairCause,
      revisionFeedback: 'repair round',
      reason: 'artificer_repair_complete',
    });
    expect(r2.ok).toBe(true);
    const afterRepair = need(hydratePITaskRecord(need(await stateManager.getTask(evaluatorId), 'evaluator post-repair')), 'pi post-repair');
    // 单槽被覆写为 repair cause — 但级联 cause 必须仍受消费历史保护。
    expect(afterRepair.revisionCauseId).toBe(repairCause);
    expect(hasConsumedRevisionCause(afterRepair, cascadeCauseId)).toBe(true);
    expect(hasConsumedRevisionCause(afterRepair, repairCause)).toBe(true);

    // evaluator 修复轮重跑完成 — 修复成果 (新 verdict)。
    await recomplete(evaluatorId);
    await writeVerdict(evaluatorId, 'approved');
    const preRescan = need(hydratePITaskRecord(need(await stateManager.getTask(evaluatorId), 'evaluator pre-rescan')), 'pi pre-rescan');

    // ── 第 3 幕: reconciliation 重扫已 succeeded 的上游 artificer ──
    // pre-fix: 单槽=repair cause ≠ cascade cause → dedup 失效 → evaluator 被
    //   再次 reopen, 修复轮 verdict 销毁, revisionCount 继续膨胀。
    // post-fix: 成员判定命中消费历史 → revision_reopen_noop, 一切不变。
    const rescan = await orchestrator.commitNextTaskProposal(chain.artificer);
    expect(rescan.decision).toBe('revision_reopen_noop');

    const afterRescan = need(hydratePITaskRecord(need(await stateManager.getTask(evaluatorId), 'evaluator after rescan')), 'pi after rescan');
    expect(afterRescan.status).toBe('succeeded');
    expect(afterRescan.runnerDecision).toBe('approved');
    expect(afterRescan.revisionCount).toBe(preRescan.revisionCount);
    expect(afterRescan.dependencyTaskIds).toEqual(preRescan.dependencyTaskIds);

    // 同 epoch 的 repair cause 重放同样幂等 (保护未弱化)。
    const repairReplay = await reopenTaskForRevision(stateManager, evaluatorId, {
      revisionCauseId: repairCause,
      reason: 'artificer_repair_complete',
    });
    expect(repairReplay.ok).toBe(true);
    expect(repairReplay.reason).toBe('idempotent_replay_same_revision');
  });

  it('mergePITaskMetadata 写不变量: 覆写 revisionCauseId 槽自动折入旧值与新值', async () => {
    const chain = await seedFullChain('q3', { timestamped: false });
    const artificerRow = need(await stateManager.getTask(chain.artificer), 'artificer');
    const pi = need(hydratePITaskRecord(artificerRow), 'artificer pi');

    const first = mergePITaskMetadata(pi, { revisionCauseId: 'cascade-a-rc1-x' });
    expect(first.consumedRevisionCauseIds).toEqual(['cascade-a-rc1-x']);

    // 模拟"已携带第一 cause"的二次覆写: 旧槽值+新值都必须在历史中。
    const second = mergePITaskMetadata(
      { ...pi, revisionCauseId: 'cascade-a-rc1-x', consumedRevisionCauseIds: first.consumedRevisionCauseIds },
      { revisionCauseId: 'repair-b' },
    );
    expect(second.revisionCauseId).toBe('repair-b');
    expect(second.consumedRevisionCauseIds).toEqual(['cascade-a-rc1-x', 'repair-b']);

    // 不触碰 revisionCauseId 的写 (如 verdict 记录) 不得改写历史。
    const verdictWrite = mergePITaskMetadata(
      { ...pi, revisionCauseId: 'cascade-a-rc1-x', consumedRevisionCauseIds: ['cascade-a-rc1-x'] },
      { runnerDecision: 'approved' },
    );
    expect(verdictWrite.consumedRevisionCauseIds).toEqual(['cascade-a-rc1-x']);
  });
});


describe('PRI-1299 creation-id conflict regressions', () => {
  it('foreign occupants of both derived and fallback ids produce successor_id_conflict, never successor_exists or a third row', async () => {
    const chain = await seedFullChain('foreign-occupants', { timestamped: false });
    const primaryId = 'evaluator-' + CAND_X + '-prompt';
    const fallbackId = primaryId + '-p-' + chain.artificer;
    await mkTask(primaryId, 'evaluator', 'pending', {
      parentTaskId: 'foreign-parent-a',
      correlationId: 'foreign-corr',
      dependencyTaskIds: ['foreign-parent-a'],
    });
    await mkTask(fallbackId, 'evaluator', 'pending', {
      parentTaskId: 'foreign-parent-b',
      correlationId: 'foreign-corr',
      dependencyTaskIds: ['foreign-parent-b'],
    });
    const beforeCount = (await stateManager.listTasks({})).length;

    const result = await orchestrator.commitNextTaskProposal(chain.artificer);

    expect(result.decision).toBe('successor_id_conflict');
    if (result.decision === 'successor_id_conflict') {
      expect(result.reason).toBe('derived_and_fallback_ids_occupied_by_foreign_chain');
    }
    expect((await stateManager.listTasks({})).length).toBe(beforeCount);
  });

  it('two concurrent creators both scan first, then converge through UNIQUE rescan to exactly one logical successor', async () => {
    const chain = await seedFullChain('concurrent-create', { timestamped: false });
    const beforeCount = (await stateManager.listTasks({})).length;
    const originalListTasks = stateManager.listTasks.bind(stateManager);
    let releaseBarrier: () => void = () => undefined;
    const bothScanned = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    let exactScanCount = 0;
    stateManager.listTasks = async (filter?: Parameters<RuntimeStateManager['listTasks']>[0]) => {
      const isTargetExactScan = filter?.piParentTaskId === chain.artificer
        && filter.taskKind === 'evaluator'
        && filter.piChannel === 'prompt';
      if (isTargetExactScan) {
        exactScanCount++;
        if (exactScanCount === 1) await bothScanned;
        if (exactScanCount === 2) releaseBarrier();
      }
      return originalListTasks(filter);
    };
    const secondOrchestrator = new InternalizationOrchestrator(
      { stateManager }, { owner: 'r5-itest-second', runtimeKind: 'test-double', dryRun: true },
    );
    let first: Awaited<ReturnType<InternalizationOrchestrator['commitNextTaskProposal']>>;
    let second: Awaited<ReturnType<InternalizationOrchestrator['commitNextTaskProposal']>>;
    try {
      [first, second] = await Promise.all([
        orchestrator.commitNextTaskProposal(chain.artificer),
        secondOrchestrator.commitNextTaskProposal(chain.artificer),
      ]);
    } finally {
      stateManager.listTasks = originalListTasks;
    }

    const decisions = [first.decision, second.decision].sort();
    expect(decisions).toEqual(['successor_created', 'successor_exists']);
    const created = first.decision === 'successor_created' ? first : second;
    const exists = first.decision === 'successor_exists' ? first : second;
    if (created.decision === 'successor_created' && exists.decision === 'successor_exists') {
      expect(exists.successorTaskId).toBe(created.successorTaskId);
    }
    const logicalSuccessors = await stateManager.listTasks({
      taskKind: 'evaluator',
      piParentTaskId: chain.artificer,
      piChannel: 'prompt',
    });
    expect(logicalSuccessors.map((task) => task.taskId)).toHaveLength(1);
    expect((await stateManager.listTasks({})).length).toBe(beforeCount + 1);
    // Two initial scans are forced empty by the barrier. Because both creators
    // then race the same deterministic insert, the UNIQUE loser must perform a
    // third exact scan and observe the winner. Accepting merely >=2 would not
    // prove that post-conflict rescan happened at all.
    expect(exactScanCount).toBe(3);
  });

  it('unparseable occupant of the derived id remains successor_id_conflict and blocks fallback duplication', async () => {
    const chain = await seedFullChain('malformed-occupant', { timestamped: false });
    const primaryId = 'evaluator-' + CAND_X + '-prompt';
    const fallbackId = primaryId + '-p-' + chain.artificer;
    await stateManager.createTask({
      taskId: primaryId,
      taskKind: 'evaluator',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: JSON.stringify({ pi_metadata: { channel: 42, dependencyTaskIds: [] } }),
    });
    const beforeCount = (await stateManager.listTasks({})).length;

    const result = await orchestrator.commitNextTaskProposal(chain.artificer);

    expect(result.decision).toBe('successor_id_conflict');
    if (result.decision === 'successor_id_conflict') {
      expect(result.reason).toBe('occupant_metadata_unparseable');
    }
    expect((await stateManager.listTasks({})).length).toBe(beforeCount);
    expect(await stateManager.getTask(fallbackId)).toBeNull();
  });
});

describe('F3 — 共享级联 planner 三态判定', () => {
  it('exists_plain: rc=0 或非终态后继', () => {
    expect(planExistingSuccessorTransition({
      sourceTaskId: 'src', sourceRevisionCount: 0,
      successorTaskId: 'succ', successorStatus: 'succeeded',
    }).plan).toBe('exists_plain');
    expect(planExistingSuccessorTransition({
      sourceTaskId: 'src', sourceRevisionCount: 2,
      successorTaskId: 'succ', successorStatus: 'pending',
    }).plan).toBe('exists_plain');
  });

  it('cascade_reopen: 终态 + rc>0 + cause 未消费', () => {
    const plan = planExistingSuccessorTransition({
      sourceTaskId: 'src', sourceRevisionCount: 1,
      successorTaskId: 'succ', successorStatus: 'succeeded',
      successorRevisionCauseId: 'repair-unrelated',
    });
    expect(plan.plan).toBe('cascade_reopen');
    if (plan.plan === 'cascade_reopen') {
      expect(plan.cascadeCauseId).toBe('cascade-src-rc1-succ');
    }
  });

  it('cascade_already_materialized: cause 在单槽或在消费历史中', () => {
    const inSlot = planExistingSuccessorTransition({
      sourceTaskId: 'src', sourceRevisionCount: 1,
      successorTaskId: 'succ', successorStatus: 'needs_human_review',
      successorRevisionCauseId: 'cascade-src-rc1-succ',
    });
    expect(inSlot.plan).toBe('cascade_already_materialized');
    // 单槽被覆写但历史仍在 — F2 的核心场景。
    const inHistory = planExistingSuccessorTransition({
      sourceTaskId: 'src', sourceRevisionCount: 1,
      successorTaskId: 'succ', successorStatus: 'succeeded',
      successorRevisionCauseId: 'repair-x',
      successorConsumedRevisionCauseIds: ['cascade-src-rc1-succ', 'repair-x'],
    });
    expect(inHistory.plan).toBe('cascade_already_materialized');
  });
});
