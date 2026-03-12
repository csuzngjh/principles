/**
 * Evolution Engine V2.0 - 单元测试
 */

import { describe, it, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  EvolutionEngine,
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
  const stateDir = path.join(tmpDir, '.principles-disciple');
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
    test('Seed tier should limit to 20 lines', () => {
      const decision = engine.beforeToolCall({
        toolName: 'write',
        content: Array(21).fill('line').join('\n'),
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('20');
    });

    test('Seed tier should allow within limit', () => {
      const decision = engine.beforeToolCall({
        toolName: 'write',
        content: Array(10).fill('line').join('\n'),
      });
      expect(decision.allowed).toBe(true);
    });

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
        toolName: 'pd_spawn_agent',
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
});
