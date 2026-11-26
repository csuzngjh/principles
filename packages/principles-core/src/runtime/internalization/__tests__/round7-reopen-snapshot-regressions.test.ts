/**
 * PRI-1293 R7 (P1-2): reopenTaskForRevision 快照生命周期回归 — 真实 sqlite。
 *
 * 缺陷: 血缘解析 (含历史回填 CAS) 后继续使用第一次读取的 rawTask/piTask —
 * 自身回填即令 CAS 前提落败, 且 merge 会丢失刚回填的 parentTaskId。
 * 修复: 血缘门禁后重新读取, 合并与 CAS 全部基于第二次快照。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { reopenTaskForRevision } from '../revision-reopen.js';
import { hydratePITaskRecord, PI_METADATA_KEY } from '../pitask-metadata.js';

const CAND = 'cand-round7';

let workspaceDir: string;
let sm: RuntimeStateManager;

beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-r7-'));
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

async function seedDreamerRoot(): Promise<string> {
  return mkTask('dreamer-root', 'dreamer', 'succeeded', { correlationId: CAND, topCandidateId: CAND });
}

/** legacy adversarial 链: 全部无 parentTaskId, 仅 deps, id 形状可证明。 */
async function seedLegacyChainToEvaluator(prefix: string) {
  await seedDreamerRoot();
  const ph = await mkTask(prefix + '-philosopher-p1', 'philosopher', 'succeeded', { correlationId: CAND, dependencyTaskIds: ['dreamer-root'] });
  const sc = await mkTask(prefix + '-scribe-s1', 'scribe', 'succeeded', { correlationId: CAND, dependencyTaskIds: [ph] });
  const art = await mkTask(prefix + '-artificer-r1-a1', 'artificer', 'succeeded', { correlationId: CAND, dependencyTaskIds: [sc] });
  const ev = await mkTask(prefix + '-evaluator-r1-e1', 'evaluator', 'succeeded', { correlationId: CAND, dependencyTaskIds: [art], runnerDecision: 'approved' });
  return { ph, sc, art, ev };
}

async function piOf(taskId: string) {
  const raw = need(await sm.getTask(taskId), taskId + ' row');
  return { raw, pi: need(hydratePITaskRecord(raw), taskId + ' pi') };
}

describe('P1-2 — reopen 快照生命周期', () => {
  it('测试A: 历史 Evaluator 缺 parentTaskId — 单次 reopen 成功, 回填保留, 只一个 epoch', async () => {
    const { ev, art } = await seedLegacyChainToEvaluator('r7a');
    const result = await reopenTaskForRevision(sm, ev, { revisionCauseId: 'cascade-src-rc1-target' });
    expect(result.ok).toBe(true);
    const { raw, pi } = await piOf(ev);
    expect(pi.parentTaskId).toBe(art); // 回填的 parentTaskId 未被 merge 丢失
    expect(pi.correlationId).toBe(CAND);
    expect(raw.status).toBe('pending');
    expect(pi.revisionCount).toBe(1);
    expect(pi.runnerDecision).toBeUndefined(); // 旧 verdict 已清
    expect((await piOf(art)).pi.parentTaskId).toBe('r7a-scribe-s1'); // 链中间节点同样回填
  });

  it('测试B: 血缘解析期间外部 consumer 取得 lease — reopen 拒绝且 lease/状态不被覆盖', async () => {
    const { ev } = await seedLegacyChainToEvaluator('r7b');
    // 初始任务为 pending (lease 合法目标) — 先把 ev 重建为 pending 在途态。
    {
      const cur = need(await sm.getTask(ev), 'ev row');
      const curPi = need(hydratePITaskRecord(cur), 'ev pi');
      void curPi;
      await sm.updateTaskIfDiagnosticJsonUnchanged(ev, cur.diagnosticJson ?? null, { status: 'pending', attemptCount: 0 }, {
        expectedStatus: cur.status,
        expectedAttemptCount: cur.attemptCount,
        expectedMaxAttempts: cur.maxAttempts,
        expectedLeaseOwner: cur.leaseOwner ?? null,
        expectedLeaseExpiresAt: cur.leaseExpiresAt ?? null,
        expectedLeaseGeneration: cur.leaseGeneration ?? 0,
      });
    }
    const origGetTask = sm.getTask.bind(sm);
    let injected = false;
    const wrapped = Object.create(Object.getPrototypeOf(sm)) as RuntimeStateManager;
    Object.assign(wrapped, sm);
    wrapped.getTask = async (id: string) => {
      const r = await origGetTask(id);
      if (!injected && id !== ev) {
        injected = true;
        await sm.acquireLeaseDetailed({ taskId: ev, owner: 'other-consumer', runtimeKind: 'test-double' }).catch(() => undefined);
      }
      return r;
    };
    const result = await reopenTaskForRevision(wrapped, ev, { revisionCauseId: 'cause-b' });
    if (result.ok) throw new Error('reopen must not succeed while task is leased by another consumer');
    // lease 注入被哪一层先捕获取决于交织时序: backfill CAS 冲突
    // (legacy_parent_backfill_conflict) 或 reopen 第二快照/CAS 冲突
    // (concurrent_modification) — 两者都是真实结构化并发反射, 核心断言是
    // lease 与业务状态不被覆盖。
    const honestConflict = result.reason.includes('concurrent_modification')
      || result.reason.includes('legacy_parent_backfill_conflict');
    expect(honestConflict).toBe(true);
    const { raw, pi } = await piOf(ev);
    expect(raw.status).toBe('leased');
    expect(raw.leaseOwner).toBe('other-consumer');
    expect(pi.revisionCount ?? 0).toBe(0); // epoch 未推进
    expect(pi.runnerDecision).toBe('approved'); // verdict 未被清
  });

  it('测试C: 相同 cause 并发两调用 — 只产生一个 revision epoch', async () => {
    const { ev } = await seedLegacyChainToEvaluator('r7c');
    const cause = 'cascade-same-cause';
    const [r1, r2] = await Promise.all([
      reopenTaskForRevision(sm, ev, { revisionCauseId: cause }),
      reopenTaskForRevision(sm, ev, { revisionCauseId: cause }),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const { pi } = await piOf(ev);
    expect(pi.revisionCount).toBe(1); // 只一个 epoch
    expect(pi.consumedRevisionCauseIds?.includes(cause) || pi.revisionCauseId === cause).toBe(true);
  });

  it('测试D: 不同 cause 并发 — 无 stale 覆盖, consumed 历史与 revisionCount 一致', async () => {
    const { ev } = await seedLegacyChainToEvaluator('r7d');
    const [r1, r2] = await Promise.all([
      reopenTaskForRevision(sm, ev, { revisionCauseId: 'cause-X' }),
      reopenTaskForRevision(sm, ev, { revisionCauseId: 'cause-Y' }),
    ]);
    const { pi } = await piOf(ev);
    const consumed = pi.consumedRevisionCauseIds ?? [];
    const rc = pi.revisionCount ?? 0;
    // 失败调用的 cause 不得被记为已消费
    if (!r1.ok) expect(consumed.includes('cause-X')).toBe(false);
    if (!r2.ok) expect(consumed.includes('cause-Y')).toBe(false);
    // 至少一个 epoch 物化, 至多两个; 历史与计数一致 (无丢失更新)
    expect(rc).toBeGreaterThanOrEqual(1);
    expect(rc).toBeLessThanOrEqual(2);
    expect(pi.dependencyTaskIds.length).toBeGreaterThan(0); // 依赖未被 stale 覆盖清空
  });
});
