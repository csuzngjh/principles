import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    TrustEngine,
    getAgentScorecard,
    recordSuccess,
    recordFailure,
    getTrustStats,
    getTrustStatus
} from '../../src/core/trust-engine.js';

vi.mock('fs');
vi.mock('../../src/core/config-service.js', () => ({
    ConfigService: {
        get: vi.fn().mockReturnValue({
            get: vi.fn((key) => {
                if (key === 'trust') return {
                    stages: { stage_1_observer: 30, stage_2_editor: 60, stage_3_developer: 80 },
                    cold_start: { initial_trust: 59, grace_failures: 3, cold_start_period_ms: 86400000 },
                    penalties: { tool_failure_base: -8, risky_failure_base: -15, gate_bypass_attempt: -5, failure_streak_multiplier: -3, max_penalty: -25 },
                    rewards: { success_base: 1, subagent_success: 3, streak_bonus_threshold: 5, streak_bonus: 5, recovery_boost: 3, max_reward: 10 },
                    limits: { stage_2_max_lines: 10, stage_3_max_lines: 100 }
                };
                return undefined;
            })
        })
    }
}));

describe('Trust Engine - Unified Adaptive System', () => {
    const workspaceDir = '/mock/workspace';

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(fs.existsSync).mockReturnValue(false);
        vi.mocked(fs.readFileSync).mockReturnValue('{}');
    });

    describe('Initialization', () => {
        it('should initialize new agent with higher trust score (59)', () => {
            vi.mocked(fs.existsSync).mockReturnValue(false);

            const engine = new TrustEngine(workspaceDir);
            const scorecard = engine.getScorecard();

            expect(scorecard.trust_score).toBe(59);
            expect(scorecard.grace_failures_remaining).toBe(3);
            expect(scorecard.first_activity_at).toBeDefined();
        });

        it('should progress to Stage 2 by default', () => {
            const engine = new TrustEngine(workspaceDir);
            expect(engine.getStage()).toBe(2);
        });
    });

    describe('Cold Start & Grace Failures', () => {
        it('should grant grace failures with no penalty', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
                trust_score: 59,
                grace_failures_remaining: 3,
                history: [],
                cold_start_end: new Date(Date.now() + 86400000).toISOString()
            }));

            const engine = new TrustEngine(workspaceDir);
            engine.recordFailure('tool', {});
            
            expect(engine.getScore()).toBe(59); // No change
            expect(engine.getScorecard().grace_failures_remaining).toBe(2);
        });

        it('should penalize after grace is exhausted', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
                trust_score: 59,
                grace_failures_remaining: 0,
                history: [],
                cold_start_end: new Date(Date.now() + 86400000).toISOString()
            }));

            const engine = new TrustEngine(workspaceDir);
            engine.recordFailure('tool', {});
            
            expect(engine.getScore()).toBeLessThan(59);
        });
    });

    describe('Adaptive Rewards', () => {
        it('should give streak bonus for consistent success', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
                trust_score: 50,
                success_streak: 4, // Next one hits threshold 5
                history: [],
                first_activity_at: new Date(Date.now() - 48 * 3600000).toISOString()
            }));

            const engine = new TrustEngine(workspaceDir);
            engine.recordSuccess('Good work');
            
            // Base 1 + Streak 5 = +6
            expect(engine.getScore()).toBe(56);
        });

        it('should give recovery boost when trust is very low', () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
                trust_score: 20, // Stage 1
                history: [],
                first_activity_at: new Date(Date.now() - 48 * 3600000).toISOString()
            }));

            const engine = new TrustEngine(workspaceDir);
            engine.recordSuccess('Recovery');
            
            // Base 1 + Recovery 3 = +4
            expect(engine.getScore()).toBe(24);
        });
    });

    describe('Legacy Compatibility', () => {
        it('getAgentScorecard should return valid scorecard', () => {
            const scorecard = getAgentScorecard(workspaceDir);
            expect(scorecard.trust_score).toBe(59);
        });

        it('getTrustStats should return correct summary', () => {
            const scorecard = {
                trust_score: 85,
                success_streak: 10,
                failure_streak: 0,
                history: Array(10).fill({ type: 'success' }),
                last_updated: new Date().toISOString()
            };
            const stats = getTrustStats(scorecard as any);
            expect(stats.stage).toBe(4);
            expect(stats.successRate).toBe(100);
        });
    });
});
