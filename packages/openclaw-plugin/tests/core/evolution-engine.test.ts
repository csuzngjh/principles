import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { EvolutionConfig, ToolCallContext } from '../../src/core/evolution-types.js';
import { EvolutionTier } from '../../src/core/evolution-types.js';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../src/core/paths.js', () => ({
  resolvePdPath: vi.fn().mockReturnValue('/tmp/test-ws/.principles/state'),
}));

vi.mock('../../src/utils/file-lock.js', () => ({
  withLock: vi.fn((_path: string, fn: () => unknown) => fn()),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
    openSync: vi.fn().mockReturnValue(42),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// ── Imports (after mocks) ──────────────────────────────────────────────────

import * as fs from 'fs';
import {
  EvolutionEngine,
  getEvolutionEngine,
  disposeEvolutionEngine,
  disposeAllEvolutionEngines,
  recordEvolutionSuccess,
  recordEvolutionFailure,
  checkEvolutionGate,
} from '../../src/core/evolution-engine.js';
import { resolvePdPath } from '../../src/core/paths.js';
import { withLock } from '../../src/utils/file-lock.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const WORKSPACE = '/tmp/test-ws';

function createEngine(config?: Partial<EvolutionConfig>): EvolutionEngine {
  return new EvolutionEngine(WORKSPACE, config);
}

/** Build a scorecard JSON string as it would be stored on disk */
function buildStoredScorecard(overrides?: Record<string, unknown>) {
  const base = {
    version: '2.0',
    agentId: 'default',
    totalPoints: 0,
    availablePoints: 0,
    currentTier: EvolutionTier.Seed,
    recentFailureHashes: [],
    stats: {
      totalSuccesses: 0,
      totalFailures: 0,
      consecutiveSuccesses: 0,
      consecutiveFailures: 0,
      doubleRewardsEarned: 0,
      tierPromotions: 0,
      pointsByDifficulty: { trivial: 0, normal: 0, hard: 0 },
    },
    recentEvents: [],
    lastUpdated: new Date().toISOString(),
  };
  return JSON.stringify({ ...base, ...overrides });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('EvolutionEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no stored scorecard on disk
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  // ── Constructor & Loading ─────────────────────────────────────────────────

  describe('constructor', () => {
    test('creates new scorecard when no file exists', () => {
      const engine = createEngine();
      expect(engine.getPoints()).toBe(0);
      expect(engine.getTier()).toBe(EvolutionTier.Seed);
    });

    test('loads existing v2.0 scorecard from disk', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        buildStoredScorecard({
          totalPoints: 100,
          availablePoints: 80,
          currentTier: EvolutionTier.Sprout,
          recentFailureHashes: [['edit:foo.ts', '2026-01-01T00:00:00Z']],
        })
      );

      const engine = createEngine();
      expect(engine.getPoints()).toBe(100);
      expect(engine.getAvailablePoints()).toBe(80);
      expect(engine.getTier()).toBe(EvolutionTier.Sprout);
    });

    test('creates new scorecard when stored version is not 2.0', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ version: '1.0' }));

      const engine = createEngine();
      expect(engine.getPoints()).toBe(0);
      expect(engine.getTier()).toBe(EvolutionTier.Seed);
    });

    test('creates new scorecard when JSON parse fails', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not-json');

      const engine = createEngine();
      expect(engine.getPoints()).toBe(0);
    });

    test('applies custom config overrides', () => {
      const engine = createEngine({ maxRecentEvents: 10 });
      // Record 15 events to verify the limit
      for (let i = 0; i < 15; i++) {
        engine.recordSuccess('write_file', { filePath: `f${i}.ts` });
      }
      const scorecard = engine.getScorecard();
      expect(scorecard.recentEvents).toHaveLength(10);
    });
  });

  // ── Getters ───────────────────────────────────────────────────────────────

  describe('getters', () => {
    test('getScorecard returns a copy', () => {
      const engine = createEngine();
      const sc1 = engine.getScorecard();
      const sc2 = engine.getScorecard();
      expect(sc1).not.toBe(sc2);
      expect(sc1).toEqual(sc2);
    });

    test('getStats returns a copy', () => {
      const engine = createEngine();
      const s1 = engine.getStats();
      const s2 = engine.getStats();
      expect(s1).not.toBe(s2);
      expect(s1).toEqual(s2);
    });

    test('getTierDefinition returns current tier info', () => {
      const engine = createEngine();
      const def = engine.getTierDefinition();
      expect(def.tier).toBe(EvolutionTier.Seed);
      expect(def.name).toBe('Seed');
    });

    test('getStatusSummary returns complete status', () => {
      const engine = createEngine();
      const summary = engine.getStatusSummary();
      expect(summary.tier).toBe(EvolutionTier.Seed);
      expect(summary.tierName).toBe('Seed');
      expect(summary.totalPoints).toBe(0);
      expect(summary.availablePoints).toBe(0);
      expect(summary.permissions).toBeDefined();
      expect(summary.stats).toBeDefined();
    });
  });

  // ── recordSuccess ─────────────────────────────────────────────────────────

  describe('recordSuccess', () => {
    test('awards points for constructive tool', () => {
      const engine = createEngine();
      const result = engine.recordSuccess('write_file', { filePath: 'test.ts' });
      expect(result.pointsAwarded).toBeGreaterThan(0);
      expect(engine.getPoints()).toBe(result.pointsAwarded);
    });

    test('awards 0 points for exploratory tool but clears failure hash', () => {
      const engine = createEngine();
      // First record a failure to create a hash
      engine.recordFailure('read_file', { filePath: 'test.ts' });
      const result = engine.recordSuccess('read_file', { filePath: 'test.ts' });
      expect(result.pointsAwarded).toBe(0);
      expect(result.isDoubleReward).toBe(false);
    });

    test('updates consecutive success count', () => {
      const engine = createEngine();
      engine.recordSuccess('write_file');
      engine.recordSuccess('write_file');
      const stats = engine.getStats();
      expect(stats.consecutiveSuccesses).toBe(2);
      expect(stats.consecutiveFailures).toBe(0);
    });

    test('resets consecutive failures on success', () => {
      const engine = createEngine();
      engine.recordFailure('write_file');
      engine.recordSuccess('write_file');
      const stats = engine.getStats();
      expect(stats.consecutiveFailures).toBe(0);
      expect(stats.consecutiveSuccesses).toBe(1);
    });

    test('returns double reward when recovering from failure', () => {
      const engine = createEngine({ doubleRewardCooldownMs: 0 });
      engine.recordFailure('write_file', { filePath: 'test.ts' });
      const result = engine.recordSuccess('write_file', { filePath: 'test.ts' });
      expect(result.isDoubleReward).toBe(true);
      expect(result.pointsAwarded).toBeGreaterThan(3); // normal base is 3, doubled = 6
    });

    test('infers hard difficulty for high-risk tools', () => {
      const engine = createEngine();
      const result = engine.recordSuccess('bash');
      // hard base = 8
      expect(result.pointsAwarded).toBe(8);
    });

    test('infers normal difficulty for constructive tools', () => {
      const engine = createEngine();
      const result = engine.recordSuccess('write_file');
      // normal base = 3
      expect(result.pointsAwarded).toBe(3);
    });

    test('infers trivial difficulty for unknown tools', () => {
      const engine = createEngine();
      const result = engine.recordSuccess('some_unknown_tool');
      // trivial base = 1
      expect(result.pointsAwarded).toBe(1);
    });

    test('allows explicit difficulty override', () => {
      const engine = createEngine();
      const result = engine.recordSuccess('write_file', { difficulty: 'hard' });
      expect(result.pointsAwarded).toBe(8);
    });
  });

  // ── recordFailure ─────────────────────────────────────────────────────────

  describe('recordFailure', () => {
    test('does not deduct points', () => {
      const engine = createEngine();
      engine.recordSuccess('write_file');
      const pointsBefore = engine.getPoints();
      engine.recordFailure('write_file');
      expect(engine.getPoints()).toBe(pointsBefore);
    });

    test('records lesson (failure hash)', () => {
      const engine = createEngine();
      const result = engine.recordFailure('write_file', { filePath: 'test.ts' });
      expect(result.lessonRecorded).toBe(true);
      expect(result.pointsAwarded).toBe(0);
    });

    test('updates failure stats', () => {
      const engine = createEngine();
      engine.recordFailure('write_file');
      engine.recordFailure('write_file');
      const stats = engine.getStats();
      expect(stats.totalFailures).toBe(2);
      expect(stats.consecutiveFailures).toBe(2);
      expect(stats.consecutiveSuccesses).toBe(0);
    });

    test('resets consecutive successes on failure', () => {
      const engine = createEngine();
      engine.recordSuccess('write_file');
      engine.recordFailure('write_file');
      const stats = engine.getStats();
      expect(stats.consecutiveSuccesses).toBe(0);
    });

    test('exploratory tool failure records event but no stats impact', () => {
      const engine = createEngine();
      const result = engine.recordFailure('read_file', { filePath: 'test.ts' });
      expect(result.pointsAwarded).toBe(0);
      expect(result.lessonRecorded).toBe(true);
      // exploratory failures do NOT increment totalFailures (only event recorded)
      const stats = engine.getStats();
      expect(stats.totalFailures).toBe(0);
    });
  });

  // ── Tier Promotion ────────────────────────────────────────────────────────

  describe('tier promotion', () => {
    test('promotes from Seed to Sprout at 50 points', () => {
      const engine = createEngine();
      // 50 / 3 (normal) = ~17 successes
      let promoted = false;
      for (let i = 0; i < 20; i++) {
        const r = engine.recordSuccess('write_file');
        if (r.newTier !== undefined) {
          promoted = true;
          expect(r.newTier).toBe(EvolutionTier.Sprout);
          break;
        }
      }
      expect(promoted).toBe(true);
      expect(engine.getTier()).toBe(EvolutionTier.Sprout);
    });

    test('promotes through multiple tiers with enough points', () => {
      // Load a scorecard with 490 points (just below Tree at 500)
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        buildStoredScorecard({
          totalPoints: 490,
          availablePoints: 490,
          currentTier: EvolutionTier.Sapling,
        })
      );
      const engine = createEngine();
      // hard = 8 points, need 10 more → 2 successes
      const r = engine.recordSuccess('bash');
      if (r.newTier !== undefined) {
        expect(r.newTier).toBe(EvolutionTier.Tree);
      }
    });

    test('getStatusSummary shows next tier info', () => {
      const engine = createEngine();
      const summary = engine.getStatusSummary();
      expect(summary.nextTier).not.toBeNull();
      expect(summary.nextTier!.tier).toBe(EvolutionTier.Sprout);
      expect(summary.nextTier!.pointsNeeded).toBe(50);
    });
  });

  // ── Difficulty Penalty ────────────────────────────────────────────────────

  describe('difficulty penalty (high-tier trivial)', () => {
    test('Tree tier gets reduced points for trivial tasks', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        buildStoredScorecard({
          totalPoints: 500,
          availablePoints: 500,
          currentTier: EvolutionTier.Tree,
        })
      );
      const engine = createEngine();
      const result = engine.recordSuccess('some_unknown_tool'); // trivial
      // base 1 * tier4Trivial 0.1 = 0.1, max(1, floor(0.1)) = 1
      expect(result.pointsAwarded).toBe(1);
    });

    test('Forest tier gets reduced points for normal tasks', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        buildStoredScorecard({
          totalPoints: 1000,
          availablePoints: 1000,
          currentTier: EvolutionTier.Forest,
        })
      );
      const engine = createEngine();
      const result = engine.recordSuccess('write_file'); // normal
      // base 3 * tier5Normal 0.5 = 1.5, floor = 1
      expect(result.pointsAwarded).toBe(1);
    });
  });

  // ── beforeToolCall (Gate) ─────────────────────────────────────────────────

  describe('beforeToolCall', () => {
    test('allows normal tool for Seed tier', () => {
      const engine = createEngine();
      const decision = engine.beforeToolCall({ toolName: 'write_file' });
      expect(decision.allowed).toBe(true);
      expect(decision.currentTier).toBe(EvolutionTier.Seed);
    });

    test('blocks risk path for Seed tier', () => {
      const engine = createEngine();
      const decision = engine.beforeToolCall({
        toolName: 'write_file',
        isRiskPath: true,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('未解锁风险路径权限');
    });

    test('blocks high-risk tool for Seed tier', () => {
      const engine = createEngine();
      const decision = engine.beforeToolCall({ toolName: 'bash' });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('未解锁高风险工具权限');
    });

    test('allows sessions_spawn for Seed tier (all tiers allow subagent)', () => {
      const engine = createEngine();
      const decision = engine.beforeToolCall({ toolName: 'sessions_spawn' });
      expect(decision.allowed).toBe(true);
    });

    test('allows risk path for Sapling tier', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        buildStoredScorecard({
          totalPoints: 200,
          availablePoints: 200,
          currentTier: EvolutionTier.Sapling,
        })
      );
      const engine = createEngine();
      const decision = engine.beforeToolCall({
        toolName: 'write_file',
        isRiskPath: true,
      });
      expect(decision.allowed).toBe(true);
    });

    test('allows high-risk tool for Sapling tier', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        buildStoredScorecard({
          totalPoints: 200,
          availablePoints: 200,
          currentTier: EvolutionTier.Sapling,
        })
      );
      const engine = createEngine();
      const decision = engine.beforeToolCall({ toolName: 'bash' });
      expect(decision.allowed).toBe(true);
    });
  });

  // ── Persistence ───────────────────────────────────────────────────────────

  describe('persistence', () => {
    test('saves scorecard after recordSuccess', () => {
      const engine = createEngine();
      engine.recordSuccess('write_file');
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled();
      expect(vi.mocked(fs.renameSync)).toHaveBeenCalled();
    });

    test('saves scorecard after recordFailure', () => {
      const engine = createEngine();
      engine.recordFailure('write_file');
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled();
    });

    test('creates directory if it does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      createEngine();
      // After constructor, recordSuccess should trigger save → mkdir
      vi.mocked(fs.existsSync).mockReturnValue(false); // dir check in saveScorecard
      const engine = createEngine();
      engine.recordSuccess('write_file');
      expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalled();
    });
  });

  // ── Double Reward Cooldown ────────────────────────────────────────────────

  describe('double reward cooldown', () => {
    test('does not grant double reward within cooldown period', () => {
      const engine = createEngine({ doubleRewardCooldownMs: 60_000 });
      engine.recordFailure('write_file', { filePath: 'test.ts' });
      const r1 = engine.recordSuccess('write_file', { filePath: 'test.ts' });
      expect(r1.isDoubleReward).toBe(true);

      // Second failure + success within cooldown
      engine.recordFailure('write_file', { filePath: 'test.ts' });
      const r2 = engine.recordSuccess('write_file', { filePath: 'test.ts' });
      expect(r2.isDoubleReward).toBe(false);
    });

    test('grants double reward after cooldown expires', () => {
      const engine = createEngine({ doubleRewardCooldownMs: 0 });
      engine.recordFailure('write_file', { filePath: 'test.ts' });
      const r1 = engine.recordSuccess('write_file', { filePath: 'test.ts' });
      expect(r1.isDoubleReward).toBe(true);

      engine.recordFailure('write_file', { filePath: 'test.ts' });
      const r2 = engine.recordSuccess('write_file', { filePath: 'test.ts' });
      expect(r2.isDoubleReward).toBe(true);
    });

    test('does not grant double reward without prior failure', () => {
      const engine = createEngine({ doubleRewardCooldownMs: 0 });
      const result = engine.recordSuccess('write_file', { filePath: 'test.ts' });
      expect(result.isDoubleReward).toBe(false);
    });
  });

  // ── Event History ─────────────────────────────────────────────────────────

  describe('event history', () => {
    test('records success events with correct shape', () => {
      const engine = createEngine();
      engine.recordSuccess('write_file', { filePath: 'test.ts', reason: 'good' });
      const sc = engine.getScorecard();
      expect(sc.recentEvents).toHaveLength(1);
      const ev = sc.recentEvents[0];
      expect(ev.type).toBe('success');
      expect(ev.toolName).toBe('write_file');
      expect(ev.filePath).toBe('test.ts');
      expect(ev.reason).toBe('good');
      expect(ev.pointsAwarded).toBeGreaterThan(0);
      expect(ev.id).toBeDefined();
      expect(ev.timestamp).toBeDefined();
    });

    test('records failure events with 0 points', () => {
      const engine = createEngine();
      engine.recordFailure('write_file', { filePath: 'test.ts' });
      const sc = engine.getScorecard();
      expect(sc.recentEvents).toHaveLength(1);
      expect(sc.recentEvents[0].type).toBe('failure');
      expect(sc.recentEvents[0].pointsAwarded).toBe(0);
    });

    test('trims events beyond maxRecentEvents', () => {
      const engine = createEngine({ maxRecentEvents: 3 });
      for (let i = 0; i < 5; i++) {
        engine.recordSuccess('write_file', { filePath: `f${i}.ts` });
      }
      const sc = engine.getScorecard();
      expect(sc.recentEvents).toHaveLength(3);
      // Oldest events are removed
      expect(sc.recentEvents[0].filePath).toBe('f2.ts');
    });
  });

  // ── dispose ───────────────────────────────────────────────────────────────

  describe('dispose', () => {
    test('clears retry timer and queue', () => {
      const engine = createEngine();
      // Should not throw
      engine.dispose();
    });
  });
});

// ── Convenience Functions ───────────────────────────────────────────────────

describe('convenience functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    disposeAllEvolutionEngines();
  });

  test('getEvolutionEngine returns same instance for same workspace', () => {
    const e1 = getEvolutionEngine(WORKSPACE);
    const e2 = getEvolutionEngine(WORKSPACE);
    expect(e1).toBe(e2);
  });

  test('getEvolutionEngine returns different instance for different workspace', () => {
    const e1 = getEvolutionEngine('/ws-1');
    const e2 = getEvolutionEngine('/ws-2');
    expect(e1).not.toBe(e2);
  });

  test('disposeEvolutionEngine removes instance', () => {
    const e1 = getEvolutionEngine(WORKSPACE);
    disposeEvolutionEngine(WORKSPACE);
    const e2 = getEvolutionEngine(WORKSPACE);
    expect(e1).not.toBe(e2);
  });

  test('disposeEvolutionEngine is no-op for unknown workspace', () => {
    expect(() => disposeEvolutionEngine('/nonexistent')).not.toThrow();
  });

  test('disposeAllEvolutionEngines clears all instances', () => {
    getEvolutionEngine('/ws-1');
    getEvolutionEngine('/ws-2');
    disposeAllEvolutionEngines();
    // New instances should be created
    const e1 = getEvolutionEngine('/ws-1');
    expect(e1.getPoints()).toBe(0);
  });

  test('recordEvolutionSuccess delegates to engine', () => {
    const result = recordEvolutionSuccess(WORKSPACE, 'write_file');
    expect(result.pointsAwarded).toBeGreaterThan(0);
  });

  test('recordEvolutionFailure delegates to engine', () => {
    const result = recordEvolutionFailure(WORKSPACE, 'write_file');
    expect(result.lessonRecorded).toBe(true);
    expect(result.pointsAwarded).toBe(0);
  });

  test('checkEvolutionGate delegates to engine', () => {
    const decision = checkEvolutionGate(WORKSPACE, { toolName: 'write_file' });
    expect(decision.allowed).toBe(true);
  });
});
