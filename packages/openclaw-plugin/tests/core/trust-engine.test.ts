import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TrustEngine,
  getAgentScorecard,
  getTrustStats,
} from '../../src/core/trust-engine.js';

vi.mock('../../src/core/trajectory.js', () => ({
  TrajectoryRegistry: {
    get: vi.fn().mockReturnValue({
      recordTrustChange: vi.fn(),
    }),
    use: vi.fn(),
    dispose: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock('../../src/core/config-service.js', () => ({
  ConfigService: {
    get: vi.fn().mockReturnValue({
      get: vi.fn((key: string) => {
        if (key === 'trust') {
          return {
            stages: { stage_1_observer: 30, stage_2_editor: 60, stage_3_developer: 80 },
            cold_start: { initial_trust: 59, grace_failures: 3, cold_start_period_ms: 86400000 },
            penalties: {
              tool_failure_base: -8,
              risky_failure_base: -15,
              gate_bypass_attempt: -5,
              failure_streak_multiplier: -3,
              max_penalty: -25,
            },
            rewards: {
              success_base: 1,
              subagent_success: 3,
              tool_success_reward: 0.2,
              streak_bonus_threshold: 5,
              streak_bonus: 5,
              recovery_boost: 3,
              max_reward: 10,
            },
            limits: { stage_2_max_lines: 10, stage_3_max_lines: 100 },
          };
        }
        return undefined;
      }),
    }),
  },
}));

const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trust-engine-'));
  tempDirs.push(dir);
  return dir;
}

function writeScorecard(workspaceDir: string, payload: Record<string, unknown>): void {
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'AGENT_SCORECARD.json'),
    JSON.stringify(payload, null, 2),
    'utf8'
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Trust Engine - Phase 1 legacy freeze', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks new scorecards as legacy frozen', () => {
    const workspaceDir = makeWorkspace();

    const scorecard = new TrustEngine(workspaceDir).getScorecard();

    expect(scorecard.trust_score).toBe(59);
    expect(scorecard.frozen).toBe(true);
    expect(scorecard.reward_policy).toBe('frozen_all_positive');
  });

  it('freezes tool_success so repeated atomic successes do not raise trust', () => {
    const workspaceDir = makeWorkspace();
    writeScorecard(workspaceDir, {
      trust_score: 30,
      success_streak: 4,
      failure_streak: 2,
      exploratory_failure_streak: 1,
      history: [],
      first_activity_at: new Date(Date.now() - 48 * 3600000).toISOString(),
      last_updated: '2026-03-20T10:00:00Z',
    });

    const engine = new TrustEngine(workspaceDir);
    for (let i = 0; i < 10; i++) {
      engine.recordSuccess('tool_success', { toolName: 'write' });
    }

    const scorecard = engine.getScorecard();
    expect(scorecard.trust_score).toBe(30);
    expect(scorecard.success_streak).toBe(0);
    expect(scorecard.failure_streak).toBe(0);
    expect(scorecard.history).toHaveLength(0);
  });

  it('freezes subagent_success so delegated success does not raise trust', () => {
    const workspaceDir = makeWorkspace();
    writeScorecard(workspaceDir, {
      trust_score: 59,
      success_streak: 9,
      failure_streak: 1,
      exploratory_failure_streak: 0,
      history: [],
      first_activity_at: new Date(Date.now() - 48 * 3600000).toISOString(),
      last_updated: '2026-03-20T10:00:00Z',
    });

    const engine = new TrustEngine(workspaceDir);
    engine.recordSuccess('subagent_success', { toolName: 'sessions_spawn' }, true);

    const scorecard = engine.getScorecard();
    expect(scorecard.trust_score).toBe(59);
    expect(scorecard.success_streak).toBe(0);
    expect(scorecard.history).toHaveLength(0);
  });

  it('keeps the trust floor when failures continue from the minimum stage boundary', () => {
    const workspaceDir = makeWorkspace();
    writeScorecard(workspaceDir, {
      trust_score: 30,
      success_streak: 0,
      failure_streak: 4,
      exploratory_failure_streak: 0,
      grace_failures_remaining: 0,
      cold_start_end: new Date(Date.now() - 1000).toISOString(),
      history: [],
      last_updated: '2026-03-20T10:00:00Z',
    });

    const engine = new TrustEngine(workspaceDir);
    engine.recordFailure('tool', { toolName: 'write' });

    const scorecard = engine.getScorecard();
    expect(scorecard.trust_score).toBe(30);
    expect(scorecard.failure_streak).toBe(5);
    expect(scorecard.history.at(-1)?.type).toBe('failure');
  });

  it('loads legacy freeze metadata through compatibility helpers', () => {
    const workspaceDir = makeWorkspace();

    const scorecard = getAgentScorecard(workspaceDir);
    const stats = getTrustStats({
      ...scorecard,
      trust_score: 85,
      success_streak: 10,
      failure_streak: 0,
      history: Array(10).fill({ type: 'success' }),
    });

    expect(scorecard.frozen).toBe(true);
    expect(scorecard.reward_policy).toBe('frozen_all_positive');
    expect(stats.stage).toBe(4);
    expect(stats.successRate).toBe(100);
  });
});
