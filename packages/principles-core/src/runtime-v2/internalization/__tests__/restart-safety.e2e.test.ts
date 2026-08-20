/**
 * Journey 11 — Restart Safety (Worker 隔离 E2E)。
 *
 * 此前 PARTIAL 的原因: 只做了幂等设计级验证。本测试把 J5/J8 场景拆到
 * 多个独立 Worker——每个 Worker 拥有独立模块图/事件循环/DB 连接,退出后
 * 内存状态全部消失;下一 stage 新 Worker 从 SQLite 重读,等价于 OpenClaw
 * 在 REVISING / 修订推进 / WAITING_FOR_DISPATCH 各阶段重启。
 *
 * 断言 (INV-08): 状态不丢、不重复创建任务、不重复 approval、不重复
 * activation、不重复 promotion。
 */
import { describe, it, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(here, 'restart-safety-worker.mjs');

interface StageSummary {
  stage: string;
  tasks: Record<string, string>;
  approvals: number;
  activations: Array<{ activation_id: string; action: string }>;
  commit?: string;
  runStatus?: string;
  reconcile?: { scanned: number; recovered: number; alreadyMaterialized: number; blocked: number };
}

/** stage 白名单: 只接受枚举值(注入防御) */
const ALLOWED_STAGES = new Set(['seed', 'repair-complete', 'evaluator-approved', 'rollout-approve', 'eval-approved-nocommit', 'rollout-succeed', 'reconcile']);

function runStage(workspaceDir: string, stage: string): Promise<StageSummary> {
  if (!ALLOWED_STAGES.has(stage)) {
    return Promise.reject(new Error(`unknown stage: ${stage}`));
  }
  if (!fs.existsSync(workspaceDir)) {
    return Promise.reject(new Error(`workspace dir does not exist: ${workspaceDir}`));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SCRIPT, { workerData: { workspaceDir, stage } });
    worker.on('message', (m: StageSummary) => { void worker.terminate(); resolve(m); });
    worker.on('error', (e) => reject(e));
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`worker stage ${stage} exited with ${code}`));
    });
  });
}

describe('Journey 11 — Restart Safety (独立 Worker 逐阶段推进)', () => {
  it('每阶段重启后: 状态保留、零重复任务/approval/activation', { timeout: 180_000 }, async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-restart-'));
    try {
      // ── Worker 1: seed (evaluator needs_revision + repair seeded) ──
      const s1 = await runStage(workspaceDir, 'seed');
      expect(s1.tasks['evaluator-j11-prompt']).toBe('succeeded');
      expect(s1.tasks['artificer-repair-j11-1']).toBe('pending');
      expect(s1.approvals).toBe(0);
      expect(s1.activations.length).toBe(0);

      // ── Worker 2 (重启后): repair 完成 → commit → evaluator reopen ──
      const s2 = await runStage(workspaceDir, 'repair-complete');
      expect(s2.commit).toBe('revision_reopened');
      expect(s2.tasks['evaluator-j11-prompt']).toBe('pending'); // reopen 存活
      expect(s2.tasks['scribe-j11-prompt']).toBe('succeeded');  // 前置不丢
      expect(s2.approvals).toBe(0);
      expect(s2.activations.length).toBe(0);

      // 幂等重放 (INV-8): 同 stage 再跑(consumer 重复周期)→ 不产生 rollout
      const s2b = await runStage(workspaceDir, 'repair-complete');
      expect(s2b.tasks['evaluator-j11-prompt']).toBe('pending');
      expect(Object.keys(s2b.tasks).filter((id) => id.includes('rollout'))).toEqual([]);

      // ── Worker 3 (重启后): evaluator 修订 approved → seed rollout ──
      const s3 = await runStage(workspaceDir, 'evaluator-approved');
      expect(s3.commit).toBe('successor_created');
      expect(s3.tasks['rollout_reviewer-j11-prompt']).toBe('pending');

      // 幂等重放: → successor_exists, rollout 任务数恒为 1
      const s3b = await runStage(workspaceDir, 'evaluator-approved');
      expect(s3b.commit).toBe('successor_exists');
      const rolloutCount = Object.keys(s3b.tasks).filter((id) => id.startsWith('rollout_reviewer-')).length;
      expect(rolloutCount).toBe(1);

      // ── Worker 4 (重启后): rollout approve_rollout → 自动 dispatch ──
      const s4 = await runStage(workspaceDir, 'rollout-approve');
      expect(s4.runStatus).toBe('succeeded');
      expect(s4.activations.length).toBe(1);
      expect(s4.activations[0]?.action).toBe('prompt_activate');
      expect(s4.approvals).toBe(0); // 低风险自动路径零审批打扰

      // 幂等重放 dispatch: rollout 已 succeeded(lease 拒绝)→ activation 不重复
      const s4b = await runStage(workspaceDir, 'rollout-approve');
      expect(s4b.activations.length).toBe(1);
    } finally {
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
    }
  });

  it('A: crash-after-succeeded → 新 consumer 周期自动恢复 successor,恰好一次,重放无重复', { timeout: 180_000 }, async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-restart-a-'));
    try {
      // 进程 1: 常规链至 evaluator needs_revision + repair seeded
      const s1 = await runStage(workspaceDir, 'seed');
      expect(s1.tasks['evaluator-j11-prompt']).toBe('succeeded');
      // 进程 2: repair 完成 + commit (evaluator reopen) — 常规路径
      const s2 = await runStage(workspaceDir, 'repair-complete');
      expect(s2.commit).toBe('revision_reopened');
      // 进程 3: evaluator 修订轮 approved 已持久化, 但 commit 前 crash
      const s3 = await runStage(workspaceDir, 'eval-approved-nocommit');
      expect(s3.tasks['evaluator-j11-prompt']).toBe('succeeded');
      // crash 后果: rollout successor 缺失 (没有任何任务创建它)
      expect(Object.keys(s3.tasks).filter((id) => id.includes('rollout'))).toEqual([]);

      // 进程 4 (重启后的 auto-consumer): 只跑 reconciliation
      const s4 = await runStage(workspaceDir, 'reconcile');
      console.log('A-DEBUG s4:', JSON.stringify(s4.reconcile));
      expect(s4.reconcile?.recovered).toBe(1);
      expect(s4.tasks['rollout_reviewer-j11-prompt']).toBe('pending'); // 自动恢复

      // 重放无重复: 再跑两次 reconciliation — successor_exists,无新增任务/重复出边
      const s5 = await runStage(workspaceDir, 'reconcile');
      const s6 = await runStage(workspaceDir, 'reconcile');
      expect(s5.reconcile?.recovered).toBe(0);
      expect(s6.reconcile?.recovered).toBe(0);
      const rollouts = Object.keys(s6.tasks).filter((id) => id.startsWith('rollout_reviewer-'));
      expect(rollouts.length).toBe(1);
      expect(s6.tasks['rollout_reviewer-j11-prompt']).toBe('pending');
    } finally {
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
    }
  });

  it('B: 同一 upstream revision wave 连续 reconcile 3 次 — successor revisionCount 只 +1', { timeout: 180_000 }, async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-restart-b-'));
    try {
      // 建立 cascade 前置: evaluator 修订轮 approved + 正常 commit (rollout 创建)
      await runStage(workspaceDir, 'seed');
      await runStage(workspaceDir, 'repair-complete');  // evaluator reopen rc=1
      await runStage(workspaceDir, 'evaluator-approved'); // commit → rollout created
      await runStage(workspaceDir, 'rollout-succeed');    // 下游 succeeded (cascade 可触发)
      // 第二次 revision wave: evaluator 再次 approved 后 crash (无 commit)
      await runStage(workspaceDir, 'eval-approved-nocommit');
      // 第一次 reconcile: cascade reopen rollout rc 0→1
      const r1 = await runStage(workspaceDir, 'reconcile');
      expect(r1.reconcile?.recovered).toBeGreaterThanOrEqual(1);

      // 用独立连接读取 successor 的 revisionCount (worker 摘要不含元数据)
      const { SqliteConnection } = await import('@principles/core/runtime-v2');
      const readRevisionCount = (): number => {
        const conn = new SqliteConnection(workspaceDir);
        try {
          const row = conn.getDb().prepare(
            "SELECT diagnostic_json FROM tasks WHERE task_id = 'rollout_reviewer-j11-prompt'",
          ).get() as { diagnostic_json?: string } | undefined;
          if (!row?.diagnostic_json) return -1;
          const parsed = JSON.parse(row.diagnostic_json) as { pi_metadata?: { revisionCount?: number } };
          return parsed.pi_metadata?.revisionCount ?? 0;
        } finally {
          try { conn.close(); } catch { /* best-effort */ }
        }
      };
      const rc1 = readRevisionCount();

      // 连续两次 reconciliation 重放 — 因果幂等: revisionCount 不变
      await runStage(workspaceDir, 'reconcile');
      await runStage(workspaceDir, 'reconcile');
      expect(readRevisionCount()).toBe(rc1);
      expect(rc1).toBe(1); // 整个 wave 只发生过一次 reopen
    } finally {
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
    }
  });
});
