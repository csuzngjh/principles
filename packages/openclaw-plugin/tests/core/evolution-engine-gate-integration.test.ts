/**
 * Evolution Engine Gate Integration Tests
 * 
 * 集成测试：验证 Gate 系统在实际场景下的表现
 */

import { describe, it, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  EvolutionEngine,
  getEvolutionEngine,
} from '../../src/core/evolution-engine.js';
import {
  EvolutionTier,
  TIER_DEFINITIONS,
  TASK_DIFFICULTY_CONFIG,
  getTierByPoints,
  ToolCallContext,
} from '../../src/core/evolution-types.js';

// ===== 测试工具 =====

function createTempWorkspace(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-gate-test-'));
  const stateDir = path.join(tmpDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  return tmpDir;
}

function cleanupWorkspace(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

// ===== 集成测试套件 =====

describe('Gate Integration - Tier Progression Flow', () => {
  let workspace: string;
  let engine: EvolutionEngine;

  beforeEach(() => {
    workspace = createTempWorkspace();
    engine = new EvolutionEngine(workspace);
  });

  afterEach(() => {
    cleanupWorkspace(workspace);
  });

  test('Seed tier: maxFilesPerTask = 3', () => {
    const tierDef = engine.getTierDefinition();
    expect(tierDef.permissions.maxFilesPerTask).toBe(3);
    expect(tierDef.permissions.allowRiskPath).toBe(false);
    expect(tierDef.permissions.allowSubagentSpawn).toBe(true); // Now allowed at Seed tier
  });

  test('Seed → Sprout: points increase', () => {
    // 50 points = Sprout
    for (let i = 0; i < 17; i++) {
      engine.recordSuccess('write', { difficulty: 'normal' });
    }
    
    const tier = engine.getTier();
    expect(tier).toBeGreaterThanOrEqual(EvolutionTier.Sprout);
  });

  test('Seed → Sapling: risk path unlocks', () => {
    // 200 points = Sapling
    for (let i = 0; i < 26; i++) {
      engine.recordSuccess('write', { difficulty: 'hard' });
    }
    
    const tier = engine.getTier();
    expect(tier).toBeGreaterThanOrEqual(EvolutionTier.Sapling);
    
    const tierDef = engine.getTierDefinition();
    expect(tierDef.permissions.allowRiskPath).toBe(true); // Risk path unlocks at Sapling
    expect(tierDef.permissions.allowSubagentSpawn).toBe(true);
  });

  test('Full progression: Seed → Sprout → Sapling → Tree → Forest', () => {
    // Seed (0) → Sprout (50)
    for (let i = 0; i < 17; i++) engine.recordSuccess('write', { difficulty: 'normal' });
    expect(engine.getTier()).toBeGreaterThanOrEqual(EvolutionTier.Sprout);
    
    // Sprout (50) → Sapling (200)
    for (let i = 0; i < 20; i++) engine.recordSuccess('write', { difficulty: 'hard' });
    expect(engine.getTier()).toBeGreaterThanOrEqual(EvolutionTier.Sapling);
    
    // Sapling (200) → Tree (500)
    for (let i = 0; i < 38; i++) engine.recordSuccess('write', { difficulty: 'hard' });
    expect(engine.getTier()).toBeGreaterThanOrEqual(EvolutionTier.Tree);
    
    // Tree (500) → Forest (1000)
    for (let i = 0; i < 63; i++) engine.recordSuccess('write', { difficulty: 'hard' });
    expect(engine.getTier()).toBe(EvolutionTier.Forest);
    
    // Forest: risk path and subagent allowed
    const tierDef = engine.getTierDefinition();
    const perms = tierDef.permissions;
    expect(perms.allowRiskPath).toBe(true);
    expect(perms.allowSubagentSpawn).toBe(true);
  });
});

describe('Gate Integration - Blocking Recovery', () => {
  let workspace: string;
  let engine: EvolutionEngine;

  beforeEach(() => {
    workspace = createTempWorkspace();
    engine = new EvolutionEngine(workspace);
  });

  afterEach(() => {
    cleanupWorkspace(workspace);
  });

  test('blocked operation: agent can continue with allowed operations', () => {
    // Seed tier: risk path is blocked
    const blocked = engine.beforeToolCall({
      toolName: 'write',
      isRiskPath: true,
      lineCount: 10,
    });
    expect(blocked.allowed).toBe(false);
    
    // Non-risk path operations are allowed
    const allowed = engine.beforeToolCall({
      toolName: 'write',
      content: Array(100).fill('line').join('\n'),
    });
    expect(allowed.allowed).toBe(true);
  });

  test('after promotion: previously blocked operations now allowed', () => {
    // Initially Seed: risk path blocked
    const blocked = engine.beforeToolCall({
      toolName: 'write',
      isRiskPath: true,
      lineCount: 10,
    });
    expect(blocked.allowed).toBe(false);
    
    // Earn points and promote to Sprout
    for (let i = 0; i < 17; i++) {
      engine.recordSuccess('write', { difficulty: 'normal' });
    }
    
    // Now Sprout: risk path still blocked until Sapling
    const stillBlocked = engine.beforeToolCall({
      toolName: 'write',
      isRiskPath: true,
      lineCount: 10,
    });
    expect(stillBlocked.allowed).toBe(false);
  });

  test('risk path access unlocks after promotion to Sapling', () => {
    // Seed: risk path blocked
    const blocked = engine.beforeToolCall({
        toolName: 'write',
        isRiskPath: true,
        lineCount: 10,
    });
    expect(blocked.allowed).toBe(false);
    
    // Promote to Sapling (where risk path unlocks)
    for (let i = 0; i < 26; i++) {
      engine.recordSuccess('write', { difficulty: 'hard' });
    }
    
    const allowed = engine.beforeToolCall({
        toolName: 'write',
        isRiskPath: true,
        lineCount: 10,
    });
    expect(allowed.allowed).toBe(true);
  });
});

describe('Gate Integration - Multi-tool Consistency', () => {
  let workspace: string;
  let engine: EvolutionEngine;

  beforeEach(() => {
    workspace = createTempWorkspace();
    engine = new EvolutionEngine(workspace);
  });

  afterEach(() => {
    cleanupWorkspace(workspace);
  });

  test('write tool respects line limit', () => {
    // Exactly at limit (150) - should allow
    const exact = engine.beforeToolCall({
      toolName: 'write',
      content: Array(150).fill('line').join('\n'),
    });
    expect(exact.allowed).toBe(true);
    
    // 1 over limit (151) - should block
    const over = engine.beforeToolCall({
      toolName: 'write',
      content: Array(151).fill('line').join('\n'),
    });
    expect(over.allowed).toBe(false);
  });

  test('edit tool respects line limit', () => {
    const allowed = engine.beforeToolCall({
      toolName: 'edit',
      content: Array(100).fill('line').join('\n'),
    });
    expect(allowed.allowed).toBe(true);
    
    const blocked = engine.beforeToolCall({
      toolName: 'edit',
      content: Array(200).fill('line').join('\n'),
    });
    expect(blocked.allowed).toBe(false);
  });

  test('high-risk tools blocked at Seed tier for risk paths', () => {
    // run_shell_command and delete_file are high-risk, blocked for risk paths
    const highRiskTools = ['run_shell_command', 'delete_file'];
    
    for (const tool of highRiskTools) {
      const result = engine.beforeToolCall({ toolName: tool, isRiskPath: true });
      expect(result.allowed).toBe(false);
    }
    
    // sessions_spawn is now allowed at Seed tier
    const spawnResult = engine.beforeToolCall({ toolName: 'sessions_spawn' });
    expect(spawnResult.allowed).toBe(true);
  });

  test('read tool always allowed (no content restriction)', () => {
    const result = engine.beforeToolCall({
      toolName: 'read',
      content: Array(1000).fill('line').join('\n'),
    });
    expect(result.allowed).toBe(true);
  });
});

describe('Gate Integration - Edge Cases', () => {
  let workspace: string;
  let engine: EvolutionEngine;

  beforeEach(() => {
    workspace = createTempWorkspace();
    engine = new EvolutionEngine(workspace);
  });

  afterEach(() => {
    cleanupWorkspace(workspace);
  });

  test('empty content allowed', () => {
    const result = engine.beforeToolCall({
      toolName: 'write',
      content: '',
    });
    expect(result.allowed).toBe(true);
  });

  test('single long line not counted as multiple lines', () => {
    // One very long line (not multiple lines)
    const result = engine.beforeToolCall({
      toolName: 'write',
      content: 'a'.repeat(10000), // 10000 chars, 1 line
    });
    expect(result.allowed).toBe(true);
  });

  test('lineCount option works the same as content', () => {
    const viaContent = engine.beforeToolCall({
      toolName: 'write',
      content: Array(21).fill('line').join('\n'),
    });
    
    const viaLineCount = engine.beforeToolCall({
      toolName: 'write',
      lineCount: 21,
    });
    
    expect(viaContent.allowed).toBe(viaLineCount.allowed);
  });

  test('risk path detection at Seed tier', () => {
    // Without isRiskPath flag
    const normalWrite = engine.beforeToolCall({
      toolName: 'write',
      filePath: 'src/core/trust-engine.ts',
    });
    expect(normalWrite.allowed).toBe(true);
    
    // With isRiskPath flag
    const riskWrite = engine.beforeToolCall({
      toolName: 'write',
      filePath: 'src/core/trust-engine.ts',
      isRiskPath: true,
    });
    expect(riskWrite.allowed).toBe(false);
  });

  test('tool name case sensitivity', () => {
    // Exact match required
    const lowercase = engine.beforeToolCall({ toolName: 'write' });
    expect(lowercase.allowed).toBe(true);
    
    const uppercase = engine.beforeToolCall({ toolName: 'WRITE' });
    // Not in HIGH_RISK_TOOLS set, so it's not blocked
    expect(uppercase.allowed).toBe(true);
  });

  test('no content, no line count - allowed', () => {
    const result = engine.beforeToolCall({
      toolName: 'write',
    });
    expect(result.allowed).toBe(true);
  });
});

describe('Gate Integration - Persistence', () => {
  let workspace: string;
  let engine: EvolutionEngine;

  beforeEach(() => {
    workspace = createTempWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(workspace);
  });

  test('gate permissions restored after restart', () => {
    // Initial engine: Seed tier
    engine = new EvolutionEngine(workspace);
    expect(engine.getTier()).toBe(EvolutionTier.Seed);
    
    // Risk path should be blocked at Seed
    let blocked = engine.beforeToolCall({ toolName: 'write', isRiskPath: true, lineCount: 10 });
    expect(blocked.allowed).toBe(false);
    
    // Earn points
    for (let i = 0; i < 26; i++) {
      engine.recordSuccess('write', { difficulty: 'hard' });
    }
    
    // Now Sapling - risk path allowed
    expect(engine.getTier()).toBeGreaterThanOrEqual(EvolutionTier.Sapling);
    let allowed = engine.beforeToolCall({ toolName: 'write', isRiskPath: true, lineCount: 10 });
    expect(allowed.allowed).toBe(true);
    
    // Restart engine (simulating process restart)
    engine = new EvolutionEngine(workspace);
    
    // Should still be Sapling with same permissions
    expect(engine.getTier()).toBeGreaterThanOrEqual(EvolutionTier.Sapling);
    allowed = engine.beforeToolCall({ toolName: 'write', isRiskPath: true, lineCount: 10 });
    expect(allowed.allowed).toBe(true);
  });

  test('points persisted correctly after restart', () => {
    engine = new EvolutionEngine(workspace);
    
    // Record some successes
    engine.recordSuccess('write', { difficulty: 'hard' });
    engine.recordSuccess('write', { difficulty: 'hard' });
    const pointsBefore = engine.getPoints();
    
    // Restart
    engine = new EvolutionEngine(workspace);
    const pointsAfter = engine.getPoints();
    
    expect(pointsAfter).toBe(pointsBefore);
    expect(pointsAfter).toBe(TASK_DIFFICULTY_CONFIG.hard.basePoints * 2);
  });

  test('double reward persisted correctly', () => {
    engine = new EvolutionEngine(workspace);
    
    // Failure then success = double reward
    engine.recordFailure('write', { filePath: 'test.ts' });
    const result = engine.recordSuccess('write', { filePath: 'test.ts', difficulty: 'normal' });
    expect(result.isDoubleReward).toBe(true);
    
    // Restart and verify double reward no longer applies (1hr cooldown)
    engine = new EvolutionEngine(workspace);
    const result2 = engine.recordSuccess('write', { filePath: 'test.ts', difficulty: 'normal' });
    expect(result2.isDoubleReward).toBe(false);
  });

  test('stats persisted correctly', () => {
    engine = new EvolutionEngine(workspace);
    
    engine.recordSuccess('write', { difficulty: 'normal' });
    engine.recordSuccess('write', { difficulty: 'normal' });
    engine.recordFailure('write');
    
    const statsBefore = engine.getStats();
    
    // Restart
    engine = new EvolutionEngine(workspace);
    const statsAfter = engine.getStats();
    
    expect(statsAfter.totalSuccesses).toBe(statsBefore.totalSuccesses);
    expect(statsAfter.totalFailures).toBe(statsBefore.totalFailures);
    expect(statsAfter.consecutiveSuccesses).toBe(0); // Reset on restart
  });
});

describe('Gate Integration - Real World Scenarios', () => {
  let workspace: string;
  let engine: EvolutionEngine;

  beforeEach(() => {
    workspace = createTempWorkspace();
    engine = new EvolutionEngine(workspace);
  });

  afterEach(() => {
    cleanupWorkspace(workspace);
  });

  test('agent starts small, grows capability', () => {
    // New agent at Seed
    expect(engine.getTier()).toBe(EvolutionTier.Seed);
    
    // Attempt 200-line write - blocked (Seed limit is 150)
    let decision = engine.beforeToolCall({
      toolName: 'write',
      content: Array(200).fill('line').join('\n'),
    });
    expect(decision.allowed).toBe(false);
    
    // Subagent spawn is now allowed at Seed
    decision = engine.beforeToolCall({
      toolName: 'sessions_spawn',
    });
    expect(decision.allowed).toBe(true);
    
    // Risk path is blocked at Seed
    decision = engine.beforeToolCall({
      toolName: 'write',
      isRiskPath: true,
      lineCount: 10,
    });
    expect(decision.allowed).toBe(false);
    
    // Work hard, grow to Forest
    for (let i = 0; i < 125; i++) {
      engine.recordSuccess('write', { difficulty: 'hard' });
    }
    
    // Now Forest - can do anything
    decision = engine.beforeToolCall({
      toolName: 'write',
      content: Array(1000).fill('line').join('\n'),
    });
    expect(decision.allowed).toBe(true);
    
    decision = engine.beforeToolCall({
      toolName: 'sessions_spawn',
    });
    expect(decision.allowed).toBe(true);
    
    decision = engine.beforeToolCall({
      toolName: 'write',
      filePath: 'src/core/trust-engine.ts',
      isRiskPath: true,
    });
    expect(decision.allowed).toBe(true);
  });

  test('agent recovers from failure without losing progress', () => {
    // Record some successes
    for (let i = 0; i < 10; i++) {
      engine.recordSuccess('write', { difficulty: 'normal' });
    }
    const pointsBeforeFailure = engine.getPoints();
    
    // Record failures
    engine.recordFailure('write', { filePath: 'test.ts' });
    engine.recordFailure('write', { filePath: 'test2.ts' });
    
    // Points should not decrease
    expect(engine.getPoints()).toBe(pointsBeforeFailure);
    
    // Recover with double reward
    const result = engine.recordSuccess('write', { filePath: 'test.ts', difficulty: 'normal' });
    expect(result.isDoubleReward).toBe(true);
    expect(engine.getPoints()).toBeGreaterThan(pointsBeforeFailure);
  });

  test('status summary reflects gate permissions', () => {
    const summary = engine.getStatusSummary();
    
    expect(summary.tier).toBe(EvolutionTier.Seed);
    expect(summary.permissions.allowRiskPath).toBe(false);
    expect(summary.permissions.allowSubagentSpawn).toBe(true); // Allowed at Seed tier
    
    // Earn promotion to Sapling (risk path unlocks)
    for (let i = 0; i < 26; i++) {
      engine.recordSuccess('write', { difficulty: 'hard' });
    }
    
    const summaryAfter = engine.getStatusSummary();
    expect(summaryAfter.permissions.allowRiskPath).toBe(true);
  });

  test('different workspaces have independent gate state', () => {
    const engine1 = new EvolutionEngine(workspace);
    const workspace2 = createTempWorkspace();
    const engine2 = new EvolutionEngine(workspace2);
    
    // Engine 1 promotes to Sapling
    for (let i = 0; i < 26; i++) {
      engine1.recordSuccess('write', { difficulty: 'hard' });
    }
    
    // Engine 1 has risk path permission (Sapling tier)
    let decision1 = engine1.beforeToolCall({ toolName: 'write', isRiskPath: true, lineCount: 10 });
    expect(decision1.allowed).toBe(true);
    
    // Engine 2 is still Seed - risk path blocked
    let decision2 = engine2.beforeToolCall({ toolName: 'write', isRiskPath: true, lineCount: 10 });
    expect(decision2.allowed).toBe(false);
    
    cleanupWorkspace(workspace2);
  });
});
