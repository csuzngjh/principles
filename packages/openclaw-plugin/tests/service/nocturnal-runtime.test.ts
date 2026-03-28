import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    checkWorkspaceIdle,
    checkCooldown,
    checkPreflight,
    recordRunStart,
    recordRunEnd,
    clearAllCooldowns,
    getRuntimeState,
    DEFAULT_IDLE_THRESHOLD_MS,
    DEFAULT_GLOBAL_COOLDOWN_MS,
    DEFAULT_PRINCIPLE_COOLDOWN_MS,
    DEFAULT_ABANDONED_THRESHOLD_MS,
    NOCTURNAL_RUNTIME_FILE,
} from '../../src/service/nocturnal-runtime.js';
import { initPersistence, trackToolRead, clearSession, listSessions } from '../../src/core/session-tracker.js';
import { safeRmDir } from '../test-utils.js';

describe('NocturnalRuntime', () => {
    let tempDir: string;
    let workspaceDir: string;

    beforeEach(() => {
        vi.useFakeTimers();
        // Use a fixed "now" for deterministic testing
        vi.setSystemTime(new Date('2026-03-27T12:00:00.000Z'));

        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-nocturnal-ws-'));
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-nocturnal-'));

        // Initialize session tracker persistence for the temp workspace
        initPersistence(tempDir);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
        safeRmDir(workspaceDir);
        safeRmDir(tempDir);
        clearSession('session-active');
        clearSession('session-stale');
        clearSession('session-abandoned');
        clearSession('session-ancient');
    });

    // -------------------------------------------------------------------------
    // Idle Detection Tests
    // -------------------------------------------------------------------------

    describe('checkWorkspaceIdle', () => {
        it('should return isIdle=true when no sessions exist', () => {
            const result = checkWorkspaceIdle(workspaceDir);
            expect(result.isIdle).toBe(true);
            expect(result.activeSessionCount).toBe(0);
            expect(result.abandonedSessionIds).toEqual([]);
            expect(result.reason).toContain('No active sessions');
        });

        it('should return isIdle=false when a session is recent (within threshold)', () => {
            // Create an active session with recent activity
            trackToolRead('session-active', 'src/main.ts', workspaceDir);

            const result = checkWorkspaceIdle(workspaceDir, { idleThresholdMs: 30 * 60 * 1000 });
            expect(result.isIdle).toBe(false);
            expect(result.activeSessionCount).toBe(1);
            expect(result.abandonedSessionIds).toEqual([]);
        });

        it('should return isIdle=true when session is older than idle threshold', () => {
            // Create a stale session (activity 45 min ago)
            vi.setSystemTime(new Date('2026-03-27T11:15:00.000Z')); // 45 min before "now"
            trackToolRead('session-stale', 'src/main.ts', workspaceDir);
            vi.setSystemTime(new Date('2026-03-27T12:00:00.000Z')); // reset to "now"

            const result = checkWorkspaceIdle(workspaceDir, { idleThresholdMs: 30 * 60 * 1000 });
            expect(result.isIdle).toBe(true);
            expect(result.idleForMs).toBeGreaterThan(30 * 60 * 1000);
        });

        it('should treat abandoned sessions as not contributing to idle check', () => {
            // Session active 3 hours ago — should be treated as abandoned
            vi.setSystemTime(new Date('2026-03-27T09:00:00.000Z')); // 3 hours before "now"
            trackToolRead('session-abandoned', 'src/main.ts', workspaceDir);
            vi.setSystemTime(new Date('2026-03-27T12:00:00.000Z')); // reset to "now"

            const result = checkWorkspaceIdle(workspaceDir, {
                idleThresholdMs: 30 * 60 * 1000,
                abandonedThresholdMs: 2 * 60 * 60 * 1000,
            });

            expect(result.isIdle).toBe(true); // No active sessions, so idle
            expect(result.abandonedSessionIds).toContain('session-abandoned');
            expect(result.activeSessionCount).toBe(0);
            expect(result.reason).toContain('abandoned session(s) ignored');
        });

        it('should ignore ancient sessions but still detect recent activity from other sessions', () => {
            // Ancient session (4 hours ago — abandoned)
            vi.setSystemTime(new Date('2026-03-27T08:00:00.000Z'));
            trackToolRead('session-ancient', 'src/main.ts', workspaceDir);
            vi.setSystemTime(new Date('2026-03-27T12:00:00.000Z'));

            // Recent session (5 minutes ago — still active)
            vi.setSystemTime(new Date('2026-03-27T11:55:00.000Z'));
            trackToolRead('session-active', 'src/main.ts', workspaceDir);
            vi.setSystemTime(new Date('2026-03-27T12:00:00.000Z'));

            const result = checkWorkspaceIdle(workspaceDir, {
                idleThresholdMs: 30 * 60 * 1000,
                abandonedThresholdMs: 2 * 60 * 60 * 1000,
            });

            expect(result.isIdle).toBe(false); // Recent activity 5 min ago
            expect(result.abandonedSessionIds).toContain('session-ancient');
            expect(result.activeSessionCount).toBe(1);
        });

        it('should use trajectory timestamp as secondary guardrail', () => {
            // No sessions, trajectory shows recent activity
            const trajectoryRecent = Date.now() - 5 * 60 * 1000; // 5 min ago

            const result = checkWorkspaceIdle(workspaceDir, {}, trajectoryRecent);
            expect(result.isIdle).toBe(true); // Still idle (no sessions is primary)
            expect(result.trajectoryGuardrailConfirmsIdle).toBe(false); // But trajectory disagrees
        });

        it('should confirm idle when both session state and trajectory agree', () => {
            // No sessions, trajectory also shows idle (>80% of threshold)
            const trajectoryOld = Date.now() - 40 * 60 * 1000; // 40 min ago (>24 min = 80% of 30min)

            const result = checkWorkspaceIdle(workspaceDir, {}, trajectoryOld);
            expect(result.isIdle).toBe(true);
            expect(result.trajectoryGuardrailConfirmsIdle).toBe(true);
        });

        it('should report idleForMs correctly', () => {
            // Session active 15 min ago
            vi.setSystemTime(new Date('2026-03-27T11:45:00.000Z'));
            trackToolRead('session-active', 'src/main.ts', workspaceDir);
            vi.setSystemTime(new Date('2026-03-27T12:00:00.000Z'));

            const result = checkWorkspaceIdle(workspaceDir, { idleThresholdMs: 30 * 60 * 1000 });
            expect(result.idleForMs).toBe(15 * 60 * 1000);
            expect(result.isIdle).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // Cooldown Management Tests
    // -------------------------------------------------------------------------

    describe('checkCooldown', () => {
        it('should return no active cooldowns when state is empty', () => {
            const result = checkCooldown(tempDir);
            expect(result.globalCooldownActive).toBe(false);
            expect(result.principleCooldownActive).toBe(false);
            expect(result.quotaExhausted).toBe(false);
            expect(result.runsRemaining).toBe(3); // DEFAULT_MAX_RUNS_PER_WINDOW
        });

        it('should detect active global cooldown', async () => {
            await recordRunStart(tempDir, 'T-01');

            const result = checkCooldown(tempDir);
            expect(result.globalCooldownActive).toBe(true);
            expect(result.globalCooldownRemainingMs).toBe(DEFAULT_GLOBAL_COOLDOWN_MS);
            expect(result.globalCooldownUntil).toBeTruthy();
        });

        it('should detect expired global cooldown', async () => {
            await recordRunStart(tempDir, 'T-01');

            // Advance time past the global cooldown
            vi.advanceTimersByTime(DEFAULT_GLOBAL_COOLDOWN_MS + 1000);

            const result = checkCooldown(tempDir);
            expect(result.globalCooldownActive).toBe(false);
            expect(result.globalCooldownRemainingMs).toBe(0);
        });

        it('should detect principle-specific cooldown after successful run', async () => {
            await recordRunStart(tempDir, 'T-01');
            await recordRunEnd(tempDir, 'success', { sampleCount: 5 });

            const result = checkCooldown(tempDir, 'T-01');
            expect(result.principleCooldownActive).toBe(true);
            expect(result.principleCooldownRemainingMs).toBe(DEFAULT_PRINCIPLE_COOLDOWN_MS);
        });

        it('should not trigger principle cooldown on failed run', async () => {
            await recordRunStart(tempDir, 'T-01');
            await recordRunEnd(tempDir, 'failed', { reason: 'No violating sessions' });

            // Global cooldown still active, but no principle cooldown
            const result = checkCooldown(tempDir, 'T-01');
            expect(result.globalCooldownActive).toBe(true);
            expect(result.principleCooldownActive).toBe(false);
        });

        it('should not trigger principle cooldown on skipped run', async () => {
            await recordRunStart(tempDir, 'T-01');
            await recordRunEnd(tempDir, 'skipped', { reason: 'Idle check failed' });

            const result = checkCooldown(tempDir, 'T-01');
            expect(result.principleCooldownActive).toBe(false);
        });

        it('should enforce quota limit', async () => {
            // Run max number of times
            for (let i = 0; i < 3; i++) {
                await recordRunStart(tempDir, 'T-01');
                await recordRunEnd(tempDir, 'success', { sampleCount: 1 });
                // Advance past global cooldown for each run
                vi.advanceTimersByTime(DEFAULT_GLOBAL_COOLDOWN_MS + 1000);
            }

            const result = checkCooldown(tempDir);
            expect(result.quotaExhausted).toBe(true);
            expect(result.runsRemaining).toBe(0);
        });

        it('should reset quota after window expires', async () => {
            // Run max times
            for (let i = 0; i < 3; i++) {
                await recordRunStart(tempDir, 'T-01');
                await recordRunEnd(tempDir, 'success', { sampleCount: 1 });
                vi.advanceTimersByTime(DEFAULT_GLOBAL_COOLDOWN_MS + 1000);
            }

            // Advance past the quota window
            vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1000);

            const result = checkCooldown(tempDir);
            expect(result.quotaExhausted).toBe(false);
            expect(result.runsRemaining).toBe(3);
        });

        it('should only cooldown specific principles, not others', async () => {
            await recordRunStart(tempDir, 'T-01');
            await recordRunEnd(tempDir, 'success');

            const resultT01 = checkCooldown(tempDir, 'T-01');
            const resultT02 = checkCooldown(tempDir, 'T-02');

            expect(resultT01.principleCooldownActive).toBe(true);
            expect(resultT02.principleCooldownActive).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // Run Recording Tests
    // -------------------------------------------------------------------------

    describe('recordRunStart / recordRunEnd', () => {
        it('should record run start timestamp', async () => {
            await recordRunStart(tempDir, 'T-01');
            const state = await getRuntimeState(tempDir);

            expect(state.lastRunAt).toBeTruthy();
            expect(state.lastRunMeta?.targetPrincipleId).toBe('T-01');
            expect(state.lastRunMeta?.status).toBe('skipped');
            expect(state.globalCooldownUntil).toBeTruthy();
        });

        it('should record successful run with sample count', async () => {
            await recordRunStart(tempDir, 'T-01');
            await recordRunEnd(tempDir, 'success', { sampleCount: 7 });

            const state = await getRuntimeState(tempDir);
            expect(state.lastSuccessfulRunAt).toBeTruthy();
            expect(state.lastRunMeta?.status).toBe('success');
            expect(state.lastRunMeta?.sampleCount).toBe(7);
            expect(state.principleCooldowns['T-01']).toBeTruthy();
        });

        it('should preserve failed run reason without setting successful timestamp', async () => {
            await recordRunStart(tempDir, 'T-02');
            await recordRunEnd(tempDir, 'failed', { reason: 'No violating sessions found' });

            const state = await getRuntimeState(tempDir);
            expect(state.lastSuccessfulRunAt).toBeUndefined();
            expect(state.lastRunMeta?.status).toBe('failed');
            expect(state.lastRunMeta?.reason).toBe('No violating sessions found');
            expect(state.principleCooldowns['T-02']).toBeUndefined(); // No principle cooldown on failure
        });

        it('should add timestamp to recentRunTimestamps for quota tracking', async () => {
            await recordRunStart(tempDir, 'T-01');
            const state = await getRuntimeState(tempDir);

            expect(state.recentRunTimestamps.length).toBe(1);
        });
    });

    // -------------------------------------------------------------------------
    // clearAllCooldowns Tests
    // -------------------------------------------------------------------------

    describe('clearAllCooldowns', () => {
        it('should clear all cooldown state', async () => {
            await recordRunStart(tempDir, 'T-01');
            await recordRunEnd(tempDir, 'success');

            await clearAllCooldowns(tempDir);

            const state = await getRuntimeState(tempDir);
            expect(state.globalCooldownUntil).toBeUndefined();
            expect(state.principleCooldowns).toEqual({});
            expect(state.recentRunTimestamps).toEqual([]);
            expect(state.lastRunMeta).toBeUndefined();
        });
    });

    // -------------------------------------------------------------------------
    // Preflight Check Tests
    // -------------------------------------------------------------------------

    describe('checkPreflight', () => {
        it('should return canRun=true when workspace is idle and no cooldowns', () => {
            // No sessions = idle
            const result = checkPreflight(workspaceDir, tempDir, 'T-01');
            expect(result.canRun).toBe(true);
            expect(result.blockers).toEqual([]);
        });

        it('should block when workspace is not idle', () => {
            // Create recent session
            trackToolRead('session-active', 'src/main.ts', workspaceDir);

            const result = checkPreflight(workspaceDir, tempDir, 'T-01');
            expect(result.canRun).toBe(false);
            expect(result.blockers.some(b => b.includes('not idle'))).toBe(true);
        });

        it('should block when global cooldown is active', async () => {
            await recordRunStart(tempDir, 'T-01');

            const result = checkPreflight(workspaceDir, tempDir, 'T-01');
            expect(result.canRun).toBe(false);
            expect(result.blockers.some(b => b.includes('Global cooldown'))).toBe(true);
        });

        it('should block when quota is exhausted', async () => {
            // Exhaust quota
            for (let i = 0; i < 3; i++) {
                await recordRunStart(tempDir, 'T-01');
                await recordRunEnd(tempDir, 'success', { sampleCount: 1 });
                vi.advanceTimersByTime(DEFAULT_GLOBAL_COOLDOWN_MS + 1000);
            }

            const result = checkPreflight(workspaceDir, tempDir, 'T-01');
            expect(result.canRun).toBe(false);
            expect(result.blockers.some(b => b.includes('Quota exhausted'))).toBe(true);
        });

        it('should report all blockers when multiple conditions block', async () => {
            // Create recent session AND set global cooldown
            trackToolRead('session-active', 'src/main.ts', workspaceDir);
            await recordRunStart(tempDir, 'T-01');

            const result = checkPreflight(workspaceDir, tempDir, 'T-01');
            expect(result.canRun).toBe(false);
            expect(result.blockers.length).toBeGreaterThanOrEqual(2);
        });

        it('should include idle info in preflight result', () => {
            const result = checkPreflight(workspaceDir, tempDir, 'T-01');
            expect(result.idle).toBeDefined();
            expect(result.idle.isIdle).toBe(true); // No sessions
        });

        it('should include cooldown info in preflight result', () => {
            const result = checkPreflight(workspaceDir, tempDir, 'T-01');
            expect(result.cooldown).toBeDefined();
            expect(result.cooldown.globalCooldownActive).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // Abandoned Session Tests (dedicated)
// -------------------------------------------------------------------------

    describe('abandoned sessions', () => {
        it('should not block nocturnal flow when all sessions are abandoned but workspace otherwise empty', () => {
            // Create only abandoned sessions (no recent activity)
            vi.setSystemTime(new Date('2026-03-27T09:00:00.000Z')); // 3 hours ago
            trackToolRead('session-abandoned', 'src/main.ts', workspaceDir);
            vi.setSystemTime(new Date('2026-03-27T12:00:00.000Z'));

            const result = checkWorkspaceIdle(workspaceDir, {
                idleThresholdMs: 30 * 60 * 1000,
                abandonedThresholdMs: 2 * 60 * 60 * 1000,
            });

            // Workspace should be considered idle (all sessions abandoned = effectively no sessions)
            expect(result.isIdle).toBe(true);
            expect(result.activeSessionCount).toBe(0);
        });

        it('should not incorrectly block when there are abandoned AND active sessions', () => {
            // Abandoned session (3 hours ago)
            vi.setSystemTime(new Date('2026-03-27T09:00:00.000Z'));
            trackToolRead('session-abandoned', 'src/main.ts', workspaceDir);

            // Recent session (5 min ago)
            vi.setSystemTime(new Date('2026-03-27T11:55:00.000Z'));
            trackToolRead('session-active', 'src/main.ts', workspaceDir);
            vi.setSystemTime(new Date('2026-03-27T12:00:00.000Z'));

            const idleResult = checkWorkspaceIdle(workspaceDir, {
                idleThresholdMs: 30 * 60 * 1000,
                abandonedThresholdMs: 2 * 60 * 60 * 1000,
            });

            // Should NOT be idle because there's a recent active session
            expect(idleResult.isIdle).toBe(false);
            expect(idleResult.activeSessionCount).toBe(1);
            expect(idleResult.abandonedSessionIds).toContain('session-abandoned');
        });

        it('should persist abandoned sessions do not create cooldown state', async () => {
            // Create abandoned session
            vi.setSystemTime(new Date('2026-03-27T09:00:00.000Z'));
            trackToolRead('session-abandoned', 'src/main.ts', workspaceDir);
            vi.setSystemTime(new Date('2026-03-27T12:00:00.000Z'));

            // Workspace is idle, preflight should pass
            const result = checkPreflight(workspaceDir, tempDir, 'T-01');
            expect(result.canRun).toBe(true);
        });
    });

    // -------------------------------------------------------------------------
    // File Persistence Tests
    // -------------------------------------------------------------------------

    describe('file persistence', () => {
        it('should create nocturnal-runtime.json on first write', async () => {
            const filePath = path.join(tempDir, NOCTURNAL_RUNTIME_FILE);
            expect(fs.existsSync(filePath)).toBe(false);

            await recordRunStart(tempDir, 'T-01');
            expect(fs.existsSync(filePath)).toBe(true);
        });

        it('should survive corrupted JSON (start fresh)', async () => {
            const filePath = path.join(tempDir, NOCTURNAL_RUNTIME_FILE);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, '{ corrupted json }', 'utf-8');

            const state = await getRuntimeState(tempDir);
            // Should return default state, not throw
            expect(state.principleCooldowns).toEqual({});
            expect(state.recentRunTimestamps).toEqual([]);
        });

        it('should read persisted cooldown on restart', async () => {
            await recordRunStart(tempDir, 'T-01');
            await recordRunEnd(tempDir, 'success');

            // Simulate restart by re-reading
            const state = await getRuntimeState(tempDir);
            expect(state.lastSuccessfulRunAt).toBeTruthy();
            expect(state.principleCooldowns['T-01']).toBeTruthy();
        });
    });
});
