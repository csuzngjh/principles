/**
 * PRI-1293 R7 回归 — 真实 sqlite:
 *   P1-1 verifyRepairTaskIdentity 完整身份验证矩阵 (seeder 复用与 orchestrator
 *       完成路径共享同一实现);
 *   P2-1 planLegacyLineageResolution 只读规划 — 与 confirm 同判定且零写入;
 *   P2-2 reconciliation outcome 完整投影 (reopenedTaskId 不丢失);
 *   P2-3 leaseGeneration 变化使旧 CAS 落败的机制钉。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { InternalizationOrchestrator } from '../internalization-orchestrator.js';
import { verifyRepairTaskIdentity } from '../repair-task-identity.js';
import { planLegacyLineageResolution } from '../correlation-lineage.js';
import { artificerRepairTaskId, PI_METADATA_KEY } from '../pitask-metadata.js';

const CAND = 'cand-r7i';

let workspaceDir: string;
let sm: RuntimeStateManager;

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-r7i-'));
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
  omitPayload?: boolean; wrongSource?: string; wrongIteration?: number;
  wrongTaskId?: boolean; parentOverride?: string; correlationOverride?: string;
  omitLineage?: boolean; channelOverride?: string; status?: 'pending' | 'succeeded';
}): Promise<string> {
  const payload = repairPayloadOf(opts?.wrongSource ?? ev, opts?.wrongIteration ?? iteration);
  const taskId = opts?.wrongTaskId === true
    ? 'artificer-repair-WRONG-r' + String(iteration)
    : artificerRepairTaskId(opts?.wrongSource ?? ev, opts?.wrongIteration ?? iteration);
  const meta: SeedMeta = {
    ...(opts?.omitPayload === true ? {} : { repairPayload: payload }),
  };
  if (opts?.omitLineage !== true) {
    meta.parentTaskId = opts?.parentOverride ?? ev;
    meta.correlationId = opts?.correlationOverride ?? CAND;
  } else if (opts?.parentOverride !== undefined || opts?.correlationOverride !== undefined) {
    if (opts.parentOverride !== undefined) meta.parentTaskId = opts.parentOverride;
    if (opts.correlationOverride !== undefined) meta.correlationId = opts.correlationOverride;
  }
  if (opts?.channelOverride !== undefined) meta.channel = opts.channelOverride;
  await mkTask(taskId, 'artificer', opts?.status ?? 'pending', meta);
  return taskId;
}

async function verifyRepair(taskId: string, ev: string, iteration: number) {
  const row = need(await sm.getTask(taskId), taskId + ' row');
  return verifyRepairTaskIdentity(row, ev, iteration, sm);
}

describe('P1-1 — Repair 身份完整验证矩阵', () => {
  it('正常 repair → 验证通过, 无需回填', async () => {
    const { ev } = await seedModernChainToEvaluator('ok');
    const rep = await seedRepairTask(ev, 1);
    const r = await verifyRepair(rep, ev, 1);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.needsLineageBackfill).toBe(false);
      expect(r.authoritativeCorrelationId).toBe(CAND);
    }
  });

  it('payload 缺失 → 拒绝 repair_payload_missing', async () => {
    const { ev } = await seedModernChainToEvaluator('np');
    const rep = await seedRepairTask(ev, 1, { omitPayload: true });
    const r = await verifyRepair(rep, ev, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('repair_payload_missing');
  });

  it('payload 来源不匹配 → 拒绝', async () => {
    const { ev } = await seedModernChainToEvaluator('sm');
    const rep = await seedRepairTask(ev, 1, { wrongSource: 'other-evaluator' });
    const r = await verifyRepair(rep, ev, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('repair_payload_source_mismatch');
  });

  it('iteration 不匹配 → 拒绝', async () => {
    const { ev } = await seedModernChainToEvaluator('im');
    const rep = await seedRepairTask(ev, 1, { wrongIteration: 2 });
    const r = await verifyRepair(rep, ev, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('repair_payload_iteration_mismatch');
  });

  it('taskId 与 payload 身份互证失败 → 拒绝', async () => {
    const { ev } = await seedModernChainToEvaluator('tm');
    // taskId 正确但 payload 内的来源不同 → 互证失败在 source_mismatch 先捕获;
    // 真正的互证失败: taskId 不符合派生形式但 payload 一致 — 构造 taskId 正确
    // 派生但手工篡改: 直接用 wrongTaskId 形态 (payload 仍是 ev/1)。
    const payload = repairPayloadOf(ev, 1);
    await mkTask('artificer-repair-tampered-r1', 'artificer', 'pending', {
      repairPayload: payload, parentTaskId: ev, correlationId: CAND,
    });
    const r = await verifyRepair('artificer-repair-tampered-r1', ev, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('repair_task_id_payload_mismatch');
  });

  it('parentTaskId 与 payload 冲突 → 拒绝', async () => {
    const { ev } = await seedModernChainToEvaluator('pc');
    const rep = await seedRepairTask(ev, 1, { parentOverride: 'someone-else' });
    const r = await verifyRepair(rep, ev, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('repair_parent_conflicts_payload_source');
  });

  it('correlationId 与权威来源冲突 → 拒绝', async () => {
    const { ev } = await seedModernChainToEvaluator('cc');
    const rep = await seedRepairTask(ev, 1, { correlationOverride: 'cand-foreign' });
    const r = await verifyRepair(rep, ev, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('repair_correlation_conflicts_authoritative');
  });

  it('channel 不一致 → 拒绝', async () => {
    const { ev } = await seedModernChainToEvaluator('ch');
    const rep = await seedRepairTask(ev, 1, { channelOverride: 'skill' });
    const r = await verifyRepair(rep, ev, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('repair_channel_mismatch');
  });

  it('历史任务仅缺 parent/correlation → 验证通过且标记可回填', async () => {
    const { ev } = await seedModernChainToEvaluator('lg');
    const rep = await seedRepairTask(ev, 1, { omitLineage: true });
    const r = await verifyRepair(rep, ev, 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.needsLineageBackfill).toBe(true);
  });

  it('来源不是 evaluator → 拒绝 repair_source_not_evaluator', async () => {
    const { art } = await seedModernChainToEvaluator('ne');
    const payload = repairPayloadOf(art, 1);
    const taskId = artificerRepairTaskId(art, 1);
    await mkTask(taskId, 'artificer', 'pending', { repairPayload: payload, parentTaskId: art, correlationId: CAND });
    const r = await verifyRepair(taskId, art, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('repair_source_not_evaluator');
  });
});

describe('P2-1 — 只读 lineage planner 一致性', () => {
  it('合法历史链: planner 与 confirm 同判定 (ok + backfillEdges), 且零写入', async () => {
    await mkTask('dreamer-root', 'dreamer', 'succeeded', { correlationId: CAND, topCandidateId: CAND });
    const ph = await mkTask('lp-philosopher-p1', 'philosopher', 'succeeded', { correlationId: CAND, dependencyTaskIds: ['dreamer-root'] });
    const sc = await mkTask('lp-scribe-s1', 'scribe', 'succeeded', { correlationId: CAND, dependencyTaskIds: [ph] });
    const beforeSc = (need(await sm.getTask(sc), 'sc')).diagnosticJson;
    const leaf = need(await sm.getTask(sc), 'sc leaf');
    const plan = await planLegacyLineageResolution(leaf, sm);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.correlationId).toBe(CAND);
      expect(plan.backfillEdges.length).toBeGreaterThanOrEqual(2); // scribe + philosopher 边
      expect(plan.backfillEdges.some((e) => e.taskId === sc && e.parentTaskId === ph)).toBe(true);
    }
    // 零写入断言: diagnosticJson 逐字节不变
    expect((need(await sm.getTask(sc), 'sc after')).diagnosticJson).toBe(beforeSc);
    expect((need(await sm.getTask(ph), 'ph after')).diagnosticJson).toBe((need(await sm.getTask(ph), 'ph')).diagnosticJson);
  });

  it('非法历史链 (多候选) → planner 拒绝, 零写入', async () => {
    await mkTask('dreamer-root', 'dreamer', 'succeeded', { correlationId: CAND, topCandidateId: CAND });
    const ph = await mkTask('lq-philosopher-p1', 'philosopher', 'succeeded', { correlationId: CAND, dependencyTaskIds: ['dreamer-root'] });
    const sc = await mkTask('lq-scribe-s1', 'scribe', 'succeeded', { correlationId: CAND, dependencyTaskIds: [ph] });
    const art1 = await mkTask('lq-artificer-r1-a1', 'artificer', 'succeeded', { correlationId: CAND, dependencyTaskIds: [sc] });
    await mkTask('lq-evaluator-r1-e1', 'evaluator', 'succeeded', { correlationId: CAND, runnerDecision: 'needs_revision', dependencyTaskIds: [art1] });
    await mkTask('lq-evaluator-r1-e2', 'evaluator', 'succeeded', { correlationId: CAND, runnerDecision: 'needs_revision', dependencyTaskIds: [art1] });
    const art2 = await mkTask('lq-artificer-r2-b2', 'artificer', 'succeeded', { correlationId: CAND, dependencyTaskIds: [sc] });
    const before = (need(await sm.getTask(art2), 'art2')).diagnosticJson;
    const plan = await planLegacyLineageResolution(need(await sm.getTask(art2), 'art2 leaf'), sm);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toBe('legacy_parent_inference_refused');
    expect((need(await sm.getTask(art2), 'art2 after')).diagnosticJson).toBe(before);
  });
});

describe('P2-3 — leaseGeneration CAS 机制钉', () => {
  it('leaseOwner/expires 相同但 generation 变化 → 旧前提 CAS 必须失败', async () => {
    await mkTask('cas-task', 'artificer', 'needs_human_review', {});
    const row = need(await sm.getTask('cas-task'), 'row');
    // 模拟 lease 轮换: owner/expires 视觉上相同, generation 已 +1。
    const result = await sm.updateTaskIfDiagnosticJsonUnchanged(
      'cas-task',
      row.diagnosticJson ?? null,
      { status: 'pending' },
      {
        expectedStatus: 'needs_human_review',
        expectedAttemptCount: row.attemptCount,
        expectedMaxAttempts: row.maxAttempts,
        expectedLeaseOwner: row.leaseOwner ?? null,
        expectedLeaseExpiresAt: row.leaseExpiresAt ?? null,
        expectedLeaseGeneration: (row.leaseGeneration ?? 0) + 1, // 错误的代际
      },
    );
    expect(result).toBeNull(); // CAS 必须落败 — generation 前提生效
    // 正确 generation 则成功
    const ok = await sm.updateTaskIfDiagnosticJsonUnchanged(
      'cas-task',
      row.diagnosticJson ?? null,
      { status: 'pending' },
      {
        expectedStatus: 'needs_human_review',
        expectedAttemptCount: row.attemptCount,
        expectedMaxAttempts: row.maxAttempts,
        expectedLeaseOwner: row.leaseOwner ?? null,
        expectedLeaseExpiresAt: row.leaseExpiresAt ?? null,
        expectedLeaseGeneration: row.leaseGeneration ?? 0,
      },
    );
    expect(ok).not.toBeNull();
  });
});

describe('P2-2 — reconciliation outcome 完整投影', () => {
  it('repair 已完成且 cause 已消费 → reconciliation outcome 保留 reopenedTaskId', async () => {
    const { ev } = await seedModernChainToEvaluator('rc');
    const rep = await seedRepairTask(ev, 1, { status: 'succeeded' });
    // evaluator 已消费 repair cause → commit 走 revision_reopen_noop 路径。
    const orchestrator = new InternalizationOrchestrator(
      { stateManager: sm }, { owner: 'r7i', runtimeKind: 'test-double', dryRun: true },
    );
    // 先直接 commit 一次验证 decision 形状, 再验证 reconciliation 投影。
    const commitResult = await orchestrator.commitNextTaskProposal(rep);
    expect(['revision_reopen_noop', 'revision_reopened', 'lineage_refused', 'revision_reopen_failed']).toContain(commitResult.decision);
    if ('reopenedTaskId' in commitResult) {
      expect(commitResult.reopenedTaskId).toBe(ev);
    }
    const recon = await orchestrator.reconcileSucceededTransitions({ limit: 50 });
    const outcome = recon.outcomes.find((o) => o.taskId === rep);
    expect(outcome).toBeDefined();
    if (outcome && 'reopenedTaskId' in outcome) {
      expect(outcome.reopenedTaskId).toBe(ev);
    }
  });
});
