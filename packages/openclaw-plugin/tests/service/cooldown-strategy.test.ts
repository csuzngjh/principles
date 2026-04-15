import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { recordPersistentFailure, resetFailureState, isTaskKindInCooldown } from '../../src/service/cooldown-strategy.js';
import { readState } from '../../src/service/nocturnal-runtime.js';

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cooldown-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('cooldown-strategy', () => {
    describe('recordPersistentFailure', () => {
        it('sets Tier 1 (30min) on first call', async () => {
            await recordPersistentFailure(tmpDir, 'sleep_reflection');
            const state = await readState(tmpDir);

            expect(state.taskFailureState).toBeDefined();
            expect(state.taskFailureState!['sleep_reflection'].consecutiveFailures).toBe(1);
            expect(state.taskFailureState!['sleep_reflection'].escalationTier).toBe(1);

            const cooldownUntil = new Date(state.taskFailureState!['sleep_reflection'].cooldownUntil!).getTime();
            const expectedEnd = Date.now() + 30 * 60 * 1000;
            expect(Math.abs(cooldownUntil - expectedEnd)).toBeLessThan(5000);
        });

        it('sets Tier 2 (4h) on second call', async () => {
            await recordPersistentFailure(tmpDir, 'sleep_reflection');
            await recordPersistentFailure(tmpDir, 'sleep_reflection');
            const state = await readState(tmpDir);

            expect(state.taskFailureState!['sleep_reflection'].consecutiveFailures).toBe(2);
            expect(state.taskFailureState!['sleep_reflection'].escalationTier).toBe(2);

            const cooldownUntil = new Date(state.taskFailureState!['sleep_reflection'].cooldownUntil!).getTime();
            const expectedEnd = Date.now() + 4 * 60 * 60 * 1000;
            expect(Math.abs(cooldownUntil - expectedEnd)).toBeLessThan(5000);
        });

        it('caps at Tier 3 (24h) on fourth+ call', async () => {
            for (let i = 0; i < 4; i++) {
                await recordPersistentFailure(tmpDir, 'sleep_reflection');
            }
            const state = await readState(tmpDir);

            expect(state.taskFailureState!['sleep_reflection'].consecutiveFailures).toBe(4);
            expect(state.taskFailureState!['sleep_reflection'].escalationTier).toBe(3);

            const cooldownUntil = new Date(state.taskFailureState!['sleep_reflection'].cooldownUntil!).getTime();
            const expectedEnd = Date.now() + 24 * 60 * 60 * 1000;
            expect(Math.abs(cooldownUntil - expectedEnd)).toBeLessThan(5000);
        });

        it('independent state per task kind', async () => {
            await recordPersistentFailure(tmpDir, 'sleep_reflection');
            await recordPersistentFailure(tmpDir, 'keyword_optimization');
            const state = await readState(tmpDir);

            expect(state.taskFailureState!['sleep_reflection'].escalationTier).toBe(1);
            expect(state.taskFailureState!['keyword_optimization'].escalationTier).toBe(1);
            expect(state.taskFailureState!['sleep_reflection'].cooldownUntil).not.toBe(
                state.taskFailureState!['keyword_optimization'].cooldownUntil,
            );
        });
    });

    describe('resetFailureState', () => {
        it('clears failures after escalation', async () => {
            await recordPersistentFailure(tmpDir, 'sleep_reflection');
            await resetFailureState(tmpDir, 'sleep_reflection');
            const state = await readState(tmpDir);

            expect(state.taskFailureState!['sleep_reflection'].consecutiveFailures).toBe(0);
            expect(state.taskFailureState!['sleep_reflection'].escalationTier).toBe(0);
            expect(state.taskFailureState!['sleep_reflection'].cooldownUntil).toBeUndefined();
        });

        it('is idempotent with no prior state', async () => {
            await expect(resetFailureState(tmpDir, 'sleep_reflection')).resolves.not.toThrow();
        });
    });

    describe('isTaskKindInCooldown', () => {
        it('returns inCooldown=true after recordPersistentFailure', async () => {
            await recordPersistentFailure(tmpDir, 'sleep_reflection');
            const result = isTaskKindInCooldown(tmpDir, 'sleep_reflection');

            expect(result.inCooldown).toBe(true);
            expect(result.remainingMs).toBeGreaterThan(0);
            expect(result.cooldownUntil).not.toBeNull();
        });

        it('returns inCooldown=false when cooldownUntil is in the past', async () => {
            // Manually set expired cooldown
            const state = await readState(tmpDir);
            state.taskFailureState = {
                sleep_reflection: {
                    consecutiveFailures: 1,
                    escalationTier: 1,
                    cooldownUntil: new Date(Date.now() - 60000).toISOString(),
                },
            };
            const { writeState } = await import('../../src/service/nocturnal-runtime.js');
            await writeState(tmpDir, state);

            const result = isTaskKindInCooldown(tmpDir, 'sleep_reflection');
            expect(result.inCooldown).toBe(false);
            expect(result.remainingMs).toBe(0);
        });

        it('returns inCooldown=false when no state exists', () => {
            const result = isTaskKindInCooldown(tmpDir, 'sleep_reflection');
            expect(result.inCooldown).toBe(false);
            expect(result.remainingMs).toBe(0);
        });

        it('returns inCooldown=false for untracked task kind', async () => {
            await recordPersistentFailure(tmpDir, 'sleep_reflection');
            const result = isTaskKindInCooldown(tmpDir, 'keyword_optimization');

            expect(result.inCooldown).toBe(false);
            expect(result.remainingMs).toBe(0);
        });
    });

    describe('state persistence', () => {
        it('state survives to disk after recordPersistentFailure', async () => {
            await recordPersistentFailure(tmpDir, 'sleep_reflection');

            // Read directly from file to verify persistence
            const filePath = path.join(tmpDir, 'nocturnal-runtime.json');
            expect(fs.existsSync(filePath)).toBe(true);
            const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(raw.taskFailureState).toBeDefined();
            expect(raw.taskFailureState.sleep_reflection).toBeDefined();
            expect(raw.taskFailureState.sleep_reflection.consecutiveFailures).toBe(1);
        });
    });

    describe('custom config', () => {
        it('uses custom tier durations', async () => {
            const customConfig = {
                tier1_ms: 1000,
                tier2_ms: 5000,
                tier3_ms: 10000,
                consecutive_threshold: 3,
            };
            await recordPersistentFailure(tmpDir, 'sleep_reflection', customConfig);
            const state = await readState(tmpDir);

            const cooldownUntil = new Date(state.taskFailureState!['sleep_reflection'].cooldownUntil!).getTime();
            const expectedEnd = Date.now() + 1000;
            expect(Math.abs(cooldownUntil - expectedEnd)).toBeLessThan(1000);
        });
    });
});
