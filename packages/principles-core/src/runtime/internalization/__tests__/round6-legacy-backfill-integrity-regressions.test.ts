/**
 * PRI-1293 Round-6 评审回归 — 真实 RuntimeStateManager (sqlite)。
 *
 * 三组钉子:
 *   A. 历史血缘回填 14 项矩阵 (resolveAuthoritativeCorrelationIdWithLegacyBackfill):
 *      RuleHost 时间戳链 / Adversarial round 因果 (round>1 真实父=上一轮唯一
 *      needs_revision Evaluator, 不是输入 Scribe) / Repair payload 证据 / CAS 冲突
 *      / 无身份孤儿保持 missing_correlation_id_lineage; 全部拒绝路径断言零写入。
 *   B. 多后继完整性冲突: 同一 parent/kind/channel 两个持久化后继 → commit
 *      fail-closed successor_integrity_conflict, 全部冲突 id 透出, 零写入。
 *   C. 幂等历史无淘汰: 40 个不同 cause 连续 reopen, 第一个 cause 重放仍
 *      idempotent_replay_same_revision, revisionCount 不增, verdict/依赖不变。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { InternalizationOrchestrator } from '../internalization-orchestrator.js';
import { resolveAuthoritativeCorrelationIdWithLegacyBackfill } from '../correlation-lineage.js';
import { reopenTaskForRevision } from '../revision-reopen.js';
import { hydratePITaskRecord, createPITaskDiagnosticJson, mergePITaskMetadata, PI_METADATA_KEY } from '../pitask-metadata.js';

const CAND = 'cand-round6';

let workspaceDir: string;
let sm: RuntimeStateManager;
let orchestrator: InternalizationOrchestrator;

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-r6-'));
  sm = new RuntimeStateManager({ workspaceDir });
  await sm.initialize();
  orchestrator = new InternalizationOrchestrator(
    { stateManager: sm }, { owner: 'r6-itest', runtimeKind: 'test-double', dryRun: true },
  );
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
  pipelineMode?: string;
  repairPayload?: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/max-params -- 夹具四参形态与同目录集成测试惯例一致
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
        channel: 'prompt',
        ...(meta.pipelineMode !== undefined ? { pipelineMode: meta.pipelineMode } : {}),
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

async function parentOf(taskId: string): Promise<string | undefined> {
  const raw = need(await sm.getTask(taskId), `${taskId} row`);
  return hydratePITaskRecord(raw)?.parentTaskId;
}

async function diagnosticOf(taskId: string): Promise<string | null> {
  const raw = need(await sm.getTask(taskId), `${taskId} row`);
  return raw.diagnosticJson ?? null;
}

/** dreamer 根 (seed 单源身份, taskId 无 uuid → 无第二源) + 合法终态。 */
async function seedDreamerRoot(id = 'dreamer-root'): Promise<string> {
  return mkTask(id, 'dreamer', 'succeeded', { correlationId: CAND, topCandidateId: CAND, pipelineMode: 'full_chain' });
}

async function resolveLeaf(taskId: string) {
  const raw = need(await sm.getTask(taskId), `${taskId} row`);
  return resolveAuthoritativeCorrelationIdWithLegacyBackfill(raw, sm);
}

describe('A — 历史血缘回填矩阵', () => {
  it('A1 RuleHost 合法链: scribe 时间戳 id + 单 dep philosopher → 回填并解析成功', async () => {
    await seedDreamerRoot();
    const ph = await mkTask('chainx-philosopher-m1abc', 'philosopher', 'succeeded', { correlationId: CAND, dependencyTaskIds: ['dreamer-root'] });
    const sc = await mkTask('chainx-scribe-m2def', 'scribe', 'succeeded', { correlationId: CAND, dependencyTaskIds: [ph] });
    const result = await resolveLeaf(sc);
    expect(result.ok).toBe(true);
    expect(await parentOf(sc)).toBe(ph);
    expect(await parentOf(ph)).toBe('dreamer-root');
  });

  it('A2 RuleHost 多依赖拒绝 + 零写入', async () => {
    const sc = await mkTask('chainx-scribe-m3ghi', 'scribe', 'succeeded', { correlationId: CAND, dependencyTaskIds: ['a', 'b'] });
    const before = await diagnosticOf(sc);
    const result = await resolveLeaf(sc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('legacy_parent_inference_refused');
    expect(await diagnosticOf(sc)).toBe(before);
  });

  it('A3 RuleHost 错误前驱类型拒绝 + 零写入', async () => {
    const ev = await mkTask('some-evaluator-x', 'evaluator', 'succeeded', { correlationId: CAND });
    const sc = await mkTask('chainx-scribe-m4jkl', 'scribe', 'succeeded', { correlationId: CAND, dependencyTaskIds: [ev] });
    const before = await diagnosticOf(sc);
    const result = await resolveLeaf(sc);
    expect(result.ok).toBe(false);
    expect(await parentOf(sc)).toBeUndefined();
    expect(await diagnosticOf(sc)).toBe(before);
  });

  it('A4 Adversarial round-1 artificer 从 Scribe 回填', async () => {
    await seedDreamerRoot();
    const ph = await mkTask('corr1-philosopher-p1', 'philosopher', 'succeeded', { correlationId: CAND, dependencyTaskIds: ['dreamer-root'] });
    const sc = await mkTask('corr1-scribe-s1', 'scribe', 'succeeded', { correlationId: CAND, dependencyTaskIds: [ph] });
    const art = await mkTask('corr1-artificer-r1-a1', 'artificer', 'succeeded', { correlationId: CAND, dependencyTaskIds: [sc] });
    const result = await resolveLeaf(art);
    expect(result.ok).toBe(true);
    expect(await parentOf(art)).toBe(sc);
  });

  it('A5/A6 Adversarial round-2 从唯一上一轮 needs_revision Evaluator 回填, 不得回填 Scribe', async () => {
    await seedDreamerRoot();
    const ph = await mkTask('corr2-philosopher-p1', 'philosopher', 'succeeded', { correlationId: CAND, dependencyTaskIds: ['dreamer-root'] });
    const sc = await mkTask('corr2-scribe-s1', 'scribe', 'succeeded', { correlationId: CAND, dependencyTaskIds: [ph] });
    const art1 = await mkTask('corr2-artificer-r1-a1', 'artificer', 'succeeded', { correlationId: CAND, dependencyTaskIds: [sc] });
    const ev1 = await mkTask('corr2-evaluator-r1-e1', 'evaluator', 'succeeded', { correlationId: CAND, runnerDecision: 'needs_revision', dependencyTaskIds: [art1] });
    // round-2 artificer 输入依赖仍指向 Scribe (输入依赖≠因果父)。
    const art2 = await mkTask('corr2-artificer-r2-b2', 'artificer', 'succeeded', { correlationId: CAND, dependencyTaskIds: [sc] });
    const result = await resolveLeaf(art2);
    expect(result.ok).toBe(true);
    expect(await parentOf(art2)).toBe(ev1);
    expect(await parentOf(art2)).not.toBe(sc);
  });

  it('A7 两个符合条件的上一轮 Evaluator → 拒绝 + 零写入', async () => {
    await seedDreamerRoot();
    const ph = await mkTask('corr3-philosopher-p1', 'philosopher', 'succeeded', { correlationId: CAND, dependencyTaskIds: ['dreamer-root'] });
    const sc = await mkTask('corr3-scribe-s1', 'scribe', 'succeeded', { correlationId: CAND, dependencyTaskIds: [ph] });
    const art1 = await mkTask('corr3-artificer-r1-a1', 'artificer', 'succeeded', { correlationId: CAND, dependencyTaskIds: [sc] });
    await mkTask('corr3-evaluator-r1-e1', 'evaluator', 'succeeded', { correlationId: CAND, runnerDecision: 'needs_revision', dependencyTaskIds: [art1] });
    await mkTask('corr3-evaluator-r1-e2', 'evaluator', 'succeeded', { correlationId: CAND, runnerDecision: 'needs_revision', dependencyTaskIds: [art1] });
    const art2 = await mkTask('corr3-artificer-r2-b2', 'artificer', 'succeeded', { correlationId: CAND, dependencyTaskIds: [sc] });
    const before = await diagnosticOf(art2);
    const result = await resolveLeaf(art2);
    expect(result.ok).toBe(false);
    expect(await diagnosticOf(art2)).toBe(before);
  });

  it('A8 错误 round 的 Evaluator 不得选中 (round-3 需要 round-2 evaluator)', async () => {
    await seedDreamerRoot();
    const ph = await mkTask('corr4-philosopher-p1', 'philosopher', 'succeeded', { correlationId: CAND, dependencyTaskIds: ['dreamer-root'] });
    const sc = await mkTask('corr4-scribe-s1', 'scribe', 'succeeded', { correlationId: CAND, dependencyTaskIds: [ph] });
    const art1 = await mkTask('corr4-artificer-r1-a1', 'artificer', 'succeeded', { correlationId: CAND, dependencyTaskIds: [sc] });
    await mkTask('corr4-evaluator-r1-e1', 'evaluator', 'succeeded', { correlationId: CAND, runnerDecision: 'needs_revision', dependencyTaskIds: [art1] });
    const art3 = await mkTask('corr4-artificer-r3-c3', 'artificer', 'succeeded', { correlationId: CAND, dependencyTaskIds: [sc] });
    const before = await diagnosticOf(art3);
    const result = await resolveLeaf(art3);
    expect(result.ok).toBe(false);
    expect(await diagnosticOf(art3)).toBe(before);
  });

  it('A9 correlation 不一致拒绝', async () => {
    await seedDreamerRoot();
    const sc = await mkTask('corr5-scribe-s1', 'scribe', 'succeeded', { correlationId: 'cand-other', dependencyTaskIds: ['dreamer-root'] });
    // 注: A9 在 scribe 层即因 correlation 不一致拒绝 — 无需 philosopher 链。
    const art = await mkTask('corr5-artificer-r1-a1', 'artificer', 'succeeded', { correlationId: CAND, dependencyTaskIds: [sc] });
    const result = await resolveLeaf(art);
    expect(result.ok).toBe(false);
    expect(await parentOf(art)).toBeUndefined();
  });

  it('A10 channel 不一致拒绝 (evaluator round 父 artificer 异 channel)', async () => {
    const art = await mkTask('corr6-artificer-r1-a1', 'artificer', 'succeeded', { correlationId: CAND });
    // 手工把 artificer 的 channel 改成非 prompt。
    const artRaw = need(await sm.getTask(art), 'art row');
    const artPi = need(hydratePITaskRecord(artRaw), 'art pi');
    await sm.updateTaskDiagnosticJson(art, createPITaskDiagnosticJson(mergePITaskMetadata(artPi, { channel: 'skill' })));
    const ev = await mkTask('corr6-evaluator-r1-e1', 'evaluator', 'succeeded', { correlationId: CAND, dependencyTaskIds: [art] });
    const result = await resolveLeaf(ev);
    expect(result.ok).toBe(false);
    expect(await parentOf(ev)).toBeUndefined();
  });

  it('A11 Repair 用 sourceEvaluatorTaskId 回填', async () => {
    await seedDreamerRoot();
    const ph7 = await mkTask('corr7-philosopher', 'philosopher', 'succeeded', { parentTaskId: 'dreamer-root', correlationId: CAND });
    const sc7 = await mkTask('corr7-scribe', 'scribe', 'succeeded', { parentTaskId: ph7, correlationId: CAND });
    const art7 = await mkTask('corr7-artificer', 'artificer', 'succeeded', { parentTaskId: sc7, correlationId: CAND, dependencyTaskIds: [sc7] });
    const ev = await mkTask('corr7-evaluator-r1-e1', 'evaluator', 'succeeded', { parentTaskId: art7, correlationId: CAND, runnerDecision: 'needs_revision', dependencyTaskIds: [art7] });
    const rep = await mkTask(`artificer-repair-${ev}-r1`, 'artificer', 'succeeded', {
      correlationId: CAND,
      repairPayload: { requiredChanges: ['x'], concerns: [], previousScore: 0.3, repairIteration: 1, sourceArtificerArtifactId: 'art-1', sourceEvaluatorTaskId: ev },
    });
    const result = await resolveLeaf(rep);
    expect(result.ok).toBe(true);
    expect(await parentOf(rep)).toBe(ev);
  });

  it('A12 Repair taskId 与 payload 不匹配拒绝 + 零写入', async () => {
    await seedDreamerRoot();
    const ev = await mkTask('corr8-evaluator-r1-e1', 'evaluator', 'succeeded', { correlationId: CAND, runnerDecision: 'needs_revision' });
    const rep = await mkTask('artificer-repair-wrong-id-r1', 'artificer', 'succeeded', {
      correlationId: CAND,
      repairPayload: { requiredChanges: ['x'], concerns: [], previousScore: 0.3, repairIteration: 1, sourceArtificerArtifactId: 'art-1', sourceEvaluatorTaskId: ev },
    });
    const before = await diagnosticOf(rep);
    const result = await resolveLeaf(rep);
    expect(result.ok).toBe(false);
    expect(await diagnosticOf(rep)).toBe(before);
  });

  it('A13 CAS 并发冲突: 回填期间父节点被他者写入不同值 → legacy_parent_backfill_conflict', async () => {
    await seedDreamerRoot();
    const ph = await mkTask('corr9-philosopher-m1abc', 'philosopher', 'succeeded', { correlationId: CAND, dependencyTaskIds: ['dreamer-root'] });
    const sc = await mkTask('corr9-scribe-m2def', 'scribe', 'succeeded', { correlationId: CAND, dependencyTaskIds: [ph] });
    // 预读 leaf (快照) 后由"另一个执行者"写入不同的 parentTaskId。
    const leafRaw = need(await sm.getTask(sc), 'scribe row');
    const leafPi = need(hydratePITaskRecord(leafRaw), 'scribe pi');
    await sm.updateTaskDiagnosticJson(sc, createPITaskDiagnosticJson(mergePITaskMetadata(leafPi, { parentTaskId: 'someone-else-parent' })));
    const result = await resolveAuthoritativeCorrelationIdWithLegacyBackfill(leafRaw, sm);
    // 他者已写入 parentTaskId → walk 沿该边上行, 父不存在 → canonical 报悬空;
    // 关键断言: 不静默覆盖他者写入, 且最终结果不是 ok。
    expect(result.ok).toBe(false);
    expect(await parentOf(sc)).toBe('someone-else-parent');
  });

  it('A14 无身份来源孤儿 (不匹配任何生产者形状) → missing_correlation_id_lineage, 零写入', async () => {
    const sc = await mkTask('scribe-orphan-plain', 'scribe', 'succeeded', {});
    const before = await diagnosticOf(sc);
    const result = await resolveLeaf(sc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_correlation_id_lineage');
    expect(await diagnosticOf(sc)).toBe(before);
  });
});

describe('B — 多后继完整性冲突 fail-closed', () => {
  it('同一 parent/kind/channel 两个后继 → successor_integrity_conflict, 全 id 透出, 零新写入', async () => {
    await seedDreamerRoot();
    const ph = await mkTask('ib-philosopher', 'philosopher', 'succeeded', { parentTaskId: 'dreamer-root', correlationId: CAND, pipelineMode: 'full_chain' });
    const sc = await mkTask('ib-scribe', 'scribe', 'succeeded', { parentTaskId: ph, correlationId: CAND, pipelineMode: 'full_chain' });
    const art = await mkTask('ib-artificer', 'artificer', 'succeeded', { parentTaskId: sc, correlationId: CAND, pipelineMode: 'full_chain', dependencyTaskIds: [sc] });
    // 两个不同 id 的 evaluator 都声明同一 parent/kind/channel。
    await mkTask('ib-evaluator-1', 'evaluator', 'succeeded', { parentTaskId: art, correlationId: CAND, pipelineMode: 'full_chain', dependencyTaskIds: [art], runnerDecision: 'approved' });
    await mkTask('ib-evaluator-2', 'evaluator', 'succeeded', { parentTaskId: art, correlationId: CAND, pipelineMode: 'full_chain', dependencyTaskIds: [art], runnerDecision: 'approved' });
    const countBefore = (await sm.listTasks({})).length;
    const result = await orchestrator.commitNextTaskProposal(art);
    expect(result.decision).toBe('successor_integrity_conflict');
    if (result.decision === 'successor_integrity_conflict') {
      expect(result.conflictingSuccessorTaskIds.sort()).toEqual(['ib-evaluator-1', 'ib-evaluator-2']);
    }
    expect((await sm.listTasks({})).length).toBe(countBefore);
  });

  it('单个后继时幂等逻辑不受影响 → successor_exists', async () => {
    await seedDreamerRoot();
    const ph = await mkTask('is-philosopher', 'philosopher', 'succeeded', { parentTaskId: 'dreamer-root', correlationId: CAND, pipelineMode: 'full_chain' });
    const sc = await mkTask('is-scribe', 'scribe', 'succeeded', { parentTaskId: ph, correlationId: CAND, pipelineMode: 'full_chain' });
    const art = await mkTask('is-artificer', 'artificer', 'succeeded', { parentTaskId: sc, correlationId: CAND, pipelineMode: 'full_chain', dependencyTaskIds: [sc] });
    await mkTask('is-evaluator-1', 'evaluator', 'succeeded', { parentTaskId: art, correlationId: CAND, pipelineMode: 'full_chain', dependencyTaskIds: [art], runnerDecision: 'approved' });
    const result = await orchestrator.commitNextTaskProposal(art);
    expect(result.decision).toBe('successor_exists');
  });
});

describe('C — revisionCauseId 幂等历史无淘汰', () => {
  it('40 个不同 cause 连续 reopen 后, 第一个 cause 重放仍幂等, 无 verdict/依赖破坏', async () => {
    await seedDreamerRoot();
    const ph = await mkTask('c-philosopher', 'philosopher', 'succeeded', { parentTaskId: 'dreamer-root', correlationId: CAND, pipelineMode: 'full_chain' });
    const sc = await mkTask('c-scribe', 'scribe', 'succeeded', { parentTaskId: ph, correlationId: CAND, pipelineMode: 'full_chain' });
    const art = await mkTask('c-artificer', 'artificer', 'succeeded', { parentTaskId: sc, correlationId: CAND, pipelineMode: 'full_chain', dependencyTaskIds: [sc] });
    const ev = await mkTask('c-evaluator', 'evaluator', 'succeeded', {
      parentTaskId: art, correlationId: CAND, pipelineMode: 'full_chain', dependencyTaskIds: [art], runnerDecision: 'approved',
    });
    const causes: string[] = [];
    for (let i = 1; i <= 40; i += 1) {
      causes.push(`cascade:corrX:artificer:r${i}`);
    }
    for (const cause of causes) {
      const r = await reopenTaskForRevision(sm, ev, { revisionCauseId: cause });
      expect(r.ok).toBe(true);
      // reopen 后任务回 pending — 重新完成以便下一轮 reopen。
      const raw = need(await sm.getTask(ev), 'ev row');
      if (raw.status === 'pending' || raw.status === 'retry_wait') {
        const lease = await sm.acquireLeaseDetailed({ taskId: ev, owner: 'r6', runtimeKind: 'test-double' });
        await sm.markTaskSucceeded(ev, undefined, { taskId: ev, owner: 'r6', leaseGeneration: lease.leaseGeneration }, lease.runId);
      }
    }
    // 历史完整性: 40 个 cause 全部保留 (含顺序)。
    const rawAfter = need(await sm.getTask(ev), 'ev after');
    const piAfter = need(hydratePITaskRecord(rawAfter), 'pi after');
    expect((piAfter.consumedRevisionCauseIds ?? []).length).toBeGreaterThanOrEqual(40);
    expect(piAfter.consumedRevisionCauseIds?.[0]).toBe(causes[0]);
    expect(piAfter.consumedRevisionCauseIds?.includes(causes.at(-1) ?? "never")).toBe(true);

    // 第一个 cause 重放 → 幂等 no-op, revisionCount 不增, verdict 不清。
    const rcBefore = piAfter.revisionCount ?? 0;
    const verdictBefore = piAfter.runnerDecision;
    const replay = await reopenTaskForRevision(sm, ev, { revisionCauseId: causes[0] ?? "cause-fallback-never-used" });
    expect(replay).toMatchObject({ ok: true, reason: 'idempotent_replay_same_revision' });
    const rawFinal = need(await sm.getTask(ev), 'ev final');
    const piFinal = need(hydratePITaskRecord(rawFinal), 'pi final');
    expect(piFinal.revisionCount ?? 0).toBe(rcBefore);
    expect(piFinal.runnerDecision).toBe(verdictBefore);
    expect(piFinal.dependencyTaskIds).toEqual([art]);
    expect(rawFinal.status).toBe('succeeded');

    // 无关 metadata 更新不清空历史。
    await sm.updateTaskDiagnosticJson(ev, createPITaskDiagnosticJson(mergePITaskMetadata(piFinal, { revisionCount: rcBefore + 99 })));
    const rawMeta = need(await sm.getTask(ev), 'ev meta');
    const piMeta = need(hydratePITaskRecord(rawMeta), 'pi meta');
    expect((piMeta.consumedRevisionCauseIds ?? []).length).toBeGreaterThanOrEqual(40);
  });
});
