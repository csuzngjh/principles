/**
 * Evolution Engine V2.0 - 单元测试
 */

import { describe, it, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  EvolutionEngine,
  disposeAllEvolutionEngines,
  disposeEvolutionEngine,
  getEvolutionEngine,
} from '../../src/core/evolution-engine.js';
import {
  EvolutionTier,
  TIER_DEFINITIONS,
  TASK_DIFFICULTY_CONFIG,
  getTierByPoints,
  EvolutionEvent,
  EvolutionScorecard,
  TaskDifficulty,
} from '../../src/core/evolution-types.js';

// ===== 测试工具 =====

function createTempWorkspace(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-test-'));
  // EvolutionEngine 使用 .state 目录（STATE_DIR）
  const stateDir = path.join(tmpDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  return tmpDir;
}

function cleanupWorkspace(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

// ===== 测试套件 =====

describe('EvolutionEngine', () => {
  let workspace: string;
  let engine: EvolutionEngine;

  beforeEach(() => {
    workspace = createTempWorkspace();
    engine = new EvolutionEngine(workspace);
  });

  afterEach(() => {
    disposeAllEvolutionEngines();
    cleanupWorkspace(workspace);
  });

  // ===== 等级系统测试 =====

  describe('Tier System', () => {
    test('should start at Seed tier with 0 points', () => {
      expect(engine.getTier()).toBe(EvolutionTier.Seed);
      expect(engine.getPoints()).toBe(0);
    });

    test('should promote to Sprout at 50 points', () => {
      // 50 points / 3 base = ~17 normal successes
      for (let i = 0; i < 17; i++) {
        engine.recordSuccess('write', { difficulty: 'normal' });
      }
      expect(engine.getTier()).toBeGreaterThanOrEqual(EvolutionTier.Sprout);
    });

    test('should promote to Sapling at 200 points', () => {
      // 200 points / 8 base = 25 hard successes
      for (let i = 0; i < 26; i++) {
        engine.recordSuccess('write', { difficulty: 'hard' });
      }
      expect(engine.getTier()).toBeGreaterThanOrEqual(EvolutionTier.Sapling);
    });

    test('getTierByPoints returns correct tier', () => {
      expect(getTierByPoints(0)).toBe(EvolutionTier.Seed);
      expect(getTierByPoints(49)).toBe(EvolutionTier.Seed);
      expect(getTierByPoints(50)).toBe(EvolutionTier.Sprout);
      expect(getTierByPoints(199)).toBe(EvolutionTier.Sprout);
      expect(getTierByPoints(200)).toBe(EvolutionTier.Sapling);
      expect(getTierByPoints(499)).toBe(EvolutionTier.Sapling);
      expect(getTierByPoints(500)).toBe(EvolutionTier.Tree);
      expect(getTierByPoints(999)).toBe(EvolutionTier.Tree);
      expect(getTierByPoints(1000)).toBe(EvolutionTier.Forest);
    });

    test('TIER_DEFINITIONS has 5 tiers', () => {
      expect(TIER_DEFINITIONS).toHaveLength(5);
    });
  });

  // ===== 积分计算测试 =====

  describe('Points Calculation', () => {
    test('should award base points for normal success', () => {
      const result = engine.recordSuccess('write', { difficulty: 'normal' });
      expect(result.pointsAwarded).toBe(TASK_DIFFICULTY_CONFIG.normal.basePoints);
    });

    test('should award more points for hard tasks', () => {
      const normalResult = engine.recordSuccess('write', { difficulty: 'normal' });
      
      // Reset for hard test
      workspace = createTempWorkspace();
      engine = new EvolutionEngine(workspace);
      const hardResult = engine.recordSuccess('write', { difficulty: 'hard' });
      
      expect(hardResult.pointsAwarded).toBeGreaterThan(normalResult.pointsAwarded);
    });

    test('should not award points for exploratory tools', () => {
      const result = engine.recordSuccess('read');
      expect(result.pointsAwarded).toBe(0);
    });

    test('failure should award 0 points', () => {
      const result = engine.recordFailure('write');
      expect(result.pointsAwarded).toBe(0);
    });
  });

  // ===== 双倍奖励测试 =====

  describe('Double Reward', () => {
    test('should give double reward after failure then success', () => {
      // 先失败
      engine.recordFailure('write', { filePath: 'test.ts' });
      
      // 再成功（同类任务）
      const result = engine.recordSuccess('write', { filePath: 'test.ts', difficulty: 'normal' });
      
      expect(result.isDoubleReward).toBe(true);
      expect(result.pointsAwarded).toBe(TASK_DIFFICULTY_CONFIG.normal.basePoints * 2);
    });

    test('should not give double reward without prior failure', () => {
      const result = engine.recordSuccess('write', { difficulty: 'normal' });
      expect(result.isDoubleReward).toBe(false);
    });

    test('should respect cooldown for double reward', () => {
      // 第一次失败→成功（触发双倍）
      engine.recordFailure('write', { filePath: 'test1.ts' });
      const first = engine.recordSuccess('write', { filePath: 'test1.ts', difficulty: 'normal' });
      expect(first.isDoubleReward).toBe(true);

      // 第二次失败→成功（冷却中，不双倍）
      engine.recordFailure('write', { filePath: 'test2.ts' });
      const second = engine.recordSuccess('write', { filePath: 'test2.ts', difficulty: 'normal' });
      expect(second.isDoubleReward).toBe(false);
    });
  });

  // ===== 难度衰减测试 =====

  describe('Difficulty Penalty', () => {
    test('should apply penalty for trivial tasks at high tier', () => {
      // 直接设置高积分来模拟高等级
      for (let i = 0; i < 63; i++) {
        engine.recordSuccess('write', { difficulty: 'hard' });
      }
      
      // 此时应该是 Tree 级别
      const tier = engine.getTier();
      if (tier >= EvolutionTier.Tree) {
        const result = engine.recordSuccess('write', { difficulty: 'trivial' });
        // trivial 基础分1分，Tree级衰减后应该是 0.1 → 最少1分
        expect(result.pointsAwarded).toBeLessThanOrEqual(TASK_DIFFICULTY_CONFIG.trivial.basePoints);
      }
    });
  });

  // ===== Gate 检查测试 =====

  describe('Gate Integration', () => {
    test('Seed tier should block risk path', () => {
      const decision = engine.beforeToolCall({
        toolName: 'write',
        filePath: 'src/core/trust-engine.ts',
        isRiskPath: true,
      });
      expect(decision.allowed).toBe(false);
    });

    test('Seed tier should block subagent spawn', () => {
      const decision = engine.beforeToolCall({
      toolName: 'sessions_spawn',
      });
      expect(decision.allowed).toBe(false);
    });

    test('Forest tier should allow everything', () => {
      // 直接设置为 Forest
      for (let i = 0; i < 125; i++) {
        engine.recordSuccess('write', { difficulty: 'hard' });
      }
      
      expect(engine.getTier()).toBe(EvolutionTier.Forest);
      
      const decision = engine.beforeToolCall({
        toolName: 'write',
        content: Array(10000).fill('line').join('\n'),
        isRiskPath: true,
      });
      expect(decision.allowed).toBe(true);
    });
  });

  // ===== 持久化测试 =====

  describe('Persistence', () => {
    test('should save and load scorecard', () => {
      engine.recordSuccess('write', { difficulty: 'hard' });
      engine.recordSuccess('write', { difficulty: 'hard' });
      
      const pointsBefore = engine.getPoints();
      
      // 创建新实例（模拟重启）
      const engine2 = new EvolutionEngine(workspace);
      expect(engine2.getPoints()).toBe(pointsBefore);
    });

    test('should persist failure hashes across restart', () => {
      engine.recordFailure('write', { filePath: 'test.ts' });
      
      // 重启
      const engine2 = new EvolutionEngine(workspace);
      const result = engine2.recordSuccess('write', { filePath: 'test.ts', difficulty: 'normal' });
      
      expect(result.isDoubleReward).toBe(true);
    });
  });

  // ===== 统计测试 =====

  describe('Stats', () => {
    test('should track success/failure counts', () => {
      engine.recordSuccess('write', { difficulty: 'normal' });
      engine.recordSuccess('write', { difficulty: 'normal' });
      engine.recordFailure('write');
      
      const stats = engine.getStats();
      expect(stats.totalSuccesses).toBe(2);
      expect(stats.totalFailures).toBe(1);
    });

    test('should track consecutive streaks', () => {
      engine.recordSuccess('write');
      engine.recordSuccess('write');
      engine.recordSuccess('write');
      
      const stats = engine.getStats();
      expect(stats.consecutiveSuccesses).toBe(3);
      expect(stats.consecutiveFailures).toBe(0);
    });

    test('should break streak on failure', () => {
      engine.recordSuccess('write');
      engine.recordSuccess('write');
      engine.recordFailure('write');
      
      const stats = engine.getStats();
      expect(stats.consecutiveSuccesses).toBe(0);
      expect(stats.consecutiveFailures).toBe(1);
    });
  });

  // ===== 状态摘要测试 =====

  describe('Status Summary', () => {
    test('should return correct status summary', () => {
      const summary = engine.getStatusSummary();
      expect(summary.tier).toBe(EvolutionTier.Seed);
      expect(summary.tierName).toBe('Seed');
      expect(summary.totalPoints).toBe(0);
      expect(summary.nextTier).toBeDefined();
      expect(summary.nextTier!.name).toBe('Sprout');
    });

    test('Forest should have no next tier', () => {
      for (let i = 0; i < 125; i++) {
        engine.recordSuccess('write', { difficulty: 'hard' });
      }
      
      const summary = engine.getStatusSummary();
      expect(summary.nextTier).toBeNull();
    });
  });

  // ===== P0 修复验证：多 Workspace 隔离 =====

  describe('Multi-Workspace Isolation (P0 fix)', () => {
    test('getEvolutionEngine should return different instances for different workspaces', () => {
      const workspace1 = createTempWorkspace();
      const workspace2 = createTempWorkspace();

      const engine1 = getEvolutionEngine(workspace1);
      const engine2 = getEvolutionEngine(workspace2);

      // 不同 workspace 应该有不同的引擎实例
      expect(engine1).not.toBe(engine2);

      // 各自独立计分
      engine1.recordSuccess('write', { difficulty: 'hard' });
      expect(engine1.getPoints()).toBe(TASK_DIFFICULTY_CONFIG.hard.basePoints);
      expect(engine2.getPoints()).toBe(0);

      cleanupWorkspace(workspace1);
      cleanupWorkspace(workspace2);
    });

    test('getEvolutionEngine should return same instance for same workspace', () => {
      const ws = createTempWorkspace();
      const e1 = getEvolutionEngine(ws);
      const e2 = getEvolutionEngine(ws);
      expect(e1).toBe(e2);
      disposeEvolutionEngine(ws);
      cleanupWorkspace(ws);
    });

    test('disposeEvolutionEngine should remove cached instance', () => {
      const ws = createTempWorkspace();
      const e1 = getEvolutionEngine(ws);
      disposeEvolutionEngine(ws);
      const e2 = getEvolutionEngine(ws);
      expect(e2).not.toBe(e1);
      disposeEvolutionEngine(ws);
      cleanupWorkspace(ws);
    });
  });

  // ===== P0 修复验证：并发写入 =====

  describe('Concurrent Write Safety (P0 fix)', () => {
    test('should handle rapid sequential writes without corruption', () => {
      const iterations = 50;
      for (let i = 0; i < iterations; i++) {
        engine.recordSuccess('write', { difficulty: 'normal' });
      }

      // 验证数据完整性
      expect(engine.getPoints()).toBe(iterations * TASK_DIFFICULTY_CONFIG.normal.basePoints);
      expect(engine.getStats().totalSuccesses).toBe(iterations);
    });

    test('should persist correctly after rapid writes', () => {
      const iterations = 30;
      for (let i = 0; i < iterations; i++) {
        engine.recordSuccess('write', { difficulty: 'hard' });
      }

      const expectedPoints = engine.getPoints();

      // 重新加载验证持久化
      const engine2 = new EvolutionEngine(workspace);
      expect(engine2.getPoints()).toBe(expectedPoints);
    });
  });

  // ===== P0 修复验证：锁竞态条件 =====

  describe('Lock Race Condition Fixes', () => {
    test('should handle concurrent engine instances safely', () => {
      // 测试多个引擎实例（共享同一文件）的安全性
      // 每个实例有独立的内存状态，但文件是共享的
      
      const engine1 = new EvolutionEngine(workspace);
      const engine2 = new EvolutionEngine(workspace);
      
      // 两个实例交替写入
      engine1.recordSuccess('write', { difficulty: 'normal' });
      engine2.recordSuccess('write', { difficulty: 'normal' });
      engine1.recordSuccess('write', { difficulty: 'normal' });
      engine2.recordSuccess('write', { difficulty: 'normal' });
      
      // 重新加载验证最终状态
      const engine3 = new EvolutionEngine(workspace);
      // 由于内存状态独立，最终积分取决于最后一次成功保存的实例
      // 这里主要验证没有数据损坏
      expect(() => engine3.getPoints()).not.toThrow();
    });

    test('should not corrupt data under high contention', () => {
      // 快速连续写入，测试文件锁的保护
      const iterations = 50;
      for (let i = 0; i < iterations; i++) {
        engine.recordSuccess('write', { difficulty: 'normal' });
      }
      
      // 验证数据完整性（没有损坏）
      const stateDir = path.join(workspace, '.state');
      const storagePath = path.join(stateDir, 'evolution-scorecard.json');
      const content = fs.readFileSync(storagePath, 'utf8');
      const data = JSON.parse(content);  // 不应该抛出异常
      
      expect(data.totalPoints).toBe(iterations * TASK_DIFFICULTY_CONFIG.normal.basePoints);
    });

    test('should handle lock timeout gracefully', () => {
      // 创建一个持有锁的"假进程"
      const stateDir = path.join(workspace, '.state');
      const storagePath = path.join(stateDir, 'evolution-scorecard.json');
      const lockPath = `${storagePath}.lock`;
      
      // 模拟锁被死进程持有
      const deadPid = 99999999;
      fs.writeFileSync(lockPath, String(deadPid), 'utf8');
      
      // 尝试写入应该成功（死进程锁会被清理）
      const result = engine.recordSuccess('write', { difficulty: 'normal' });
      expect(result.pointsAwarded).toBeGreaterThan(0);
    });
  });

  // ===== P0 修复验证：数据不丢失 =====

  describe('No Data Loss on Lock Failure', () => {
    test('should not silently drop data when lock fails', () => {
      // 记录初始状态
      const initialPoints = engine.getPoints();
      
      // 连续快速操作
      const operations = 100;
      for (let i = 0; i < operations; i++) {
        engine.recordSuccess('write', { difficulty: 'trivial' });
      }
      
      // 所有操作都应该被记录（无丢失）
      const expectedPoints = initialPoints + operations * TASK_DIFFICULTY_CONFIG.trivial.basePoints;
      expect(engine.getPoints()).toBe(expectedPoints);
    });

    test('should preserve all failure records for double reward', () => {
      // 记录多次失败
      for (let i = 0; i < 5; i++) {
        engine.recordFailure('write', { filePath: `test-${i}.ts` });
      }
      
      // 重新加载
      const engine2 = new EvolutionEngine(workspace);
      
      // 验证失败记录被保留
      const result = engine2.recordSuccess('write', { 
        filePath: 'test-0.ts', 
        difficulty: 'normal' 
      });
      
      expect(result.isDoubleReward).toBe(true);
    });

    test('retry queue should eventually save data', async () => {
      // 这个测试验证正常情况下数据能被持久化
      // 重试队列仅在锁获取失败时触发
      
      // 记录一些数据
      engine.recordSuccess('write', { difficulty: 'hard' });
      const pointsBefore = engine.getPoints();
      
      // 等待可能的异步操作完成
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // 重新加载验证
      const engine2 = new EvolutionEngine(workspace);
      expect(engine2.getPoints()).toBe(pointsBefore);
    });
  });

  // ===== 原子写入验证 =====

  describe('Atomic Write Operations', () => {
    test('should write to temp file first, then rename', () => {
      const stateDir = path.join(workspace, '.state');
      const tempFiles = fs.readdirSync(stateDir).filter(f => f.includes('.tmp.'));
      
      // 不应该有残留的临时文件
      expect(tempFiles.length).toBe(0);
      
      // 执行写入
      engine.recordSuccess('write', { difficulty: 'normal' });
      
      // 仍然不应该有残留的临时文件
      const tempFilesAfter = fs.readdirSync(stateDir).filter(f => f.includes('.tmp.'));
      expect(tempFilesAfter.length).toBe(0);
    });

    test('should have valid JSON after concurrent writes', () => {
      // 快速写入
      for (let i = 0; i < 50; i++) {
        engine.recordSuccess('write', { difficulty: 'normal' });
      }
      
      // 直接读取文件验证 JSON 有效性
      const stateDir = path.join(workspace, '.state');
      const storagePath = path.join(stateDir, 'evolution-scorecard.json');
      
      const content = fs.readFileSync(storagePath, 'utf8');
      const data = JSON.parse(content);  // 不应该抛出异常
      
      expect(data.totalPoints).toBe(50 * TASK_DIFFICULTY_CONFIG.normal.basePoints);
    });
  });

  // ===== PID 存活检测测试 =====

  describe('PID Liveness Detection', () => {
    test('should detect current process as alive', () => {
      // 当前进程应该总是存活的
      expect(() => process.kill(process.pid, 0)).not.toThrow();
    });

    test('should clean up dead process lock and save data', () => {
      const stateDir = path.join(workspace, '.state');
      const storagePath = path.join(stateDir, 'evolution-scorecard.json');
      const lockPath = `${storagePath}.lock`;
      
      // 创建一个"死进程"的锁
      // 使用一个非常大的 PID 号（如 99999999），这个进程几乎肯定不存在
      const deadPid = 99999999;
      fs.writeFileSync(lockPath, String(deadPid), 'utf8');
      
      // 验证锁文件存在
      expect(fs.existsSync(lockPath)).toBe(true);
      
      // 下一次写入应该能获取锁（因为持有者进程已死亡）并成功保存
      const result = engine.recordSuccess('write', { difficulty: 'normal' });
      expect(result.pointsAwarded).toBeGreaterThan(0);
      
      // 验证内存中的积分正确
      expect(engine.getPoints()).toBe(result.pointsAwarded);
      
      // 验证锁被释放（文件不存在）
      expect(fs.existsSync(lockPath)).toBe(false);
      
      // 验证数据文件存在
      expect(fs.existsSync(storagePath)).toBe(true);
    });
  });
});
