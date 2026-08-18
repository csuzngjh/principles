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
}

/** stage 白名单: 只接受枚举值(注入防御) */
const ALLOWED_STAGES = new Set(['seed', 'repair-complete', 'evaluator-approved', 'rollout-approve']);

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
});
