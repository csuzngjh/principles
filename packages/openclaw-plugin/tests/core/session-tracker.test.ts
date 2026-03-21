import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    trackToolRead,
    trackLlmOutput,
    getSession,
    clearSession,
    trackFriction,
    resetFriction,
    initPersistence,
    trackBlock,
    recordThinkingCheckpoint,
} from '../../src/core/session-tracker.js';

describe('Session Tracker', () => {
    const sessionId = 'test-session-1';
    let tempDir: string | null = null;

    beforeEach(() => {
        clearSession(sessionId);
    });

    afterEach(() => {
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
            tempDir = null;
        }
        vi.useRealTimers();
        clearSession('session-a');
        clearSession('session-b');
    });

    it('should track tool reads per file', () => {
        trackToolRead(sessionId, 'src/main.ts');
        trackToolRead(sessionId, 'src/main.ts');
        trackToolRead(sessionId, 'docs/README.md');

        const state = getSession(sessionId);
        expect(state).toBeDefined();
        expect(state?.toolReadsByFile['src/main.ts']).toBe(2);
        expect(state?.toolReadsByFile['docs/README.md']).toBe(1);
    });

    it('should detect stuck loops (paralysis) on high input / tiny output', () => {
        // 1st turn
        trackLlmOutput(sessionId, { input: 100, output: 500 });
        // 2nd turn
        trackLlmOutput(sessionId, { input: 8500, output: 20 });
        // 3rd turn
        trackLlmOutput(sessionId, { input: 8800, output: 15 });
        // 4th turn
        trackLlmOutput(sessionId, { input: 9000, output: 10 });
        // 5th turn
        trackLlmOutput(sessionId, { input: 9100, output: 8 });

        let state = getSession(sessionId);
        expect(state?.stuckLoops).toBe(0); // Needs > 5 turns total

        // 6th turn (should trigger loop detection)
        trackLlmOutput(sessionId, { input: 9200, output: 10 });
        state = getSession(sessionId);
        expect(state?.stuckLoops).toBe(1);

        // 7th turn (continues loop)
        trackLlmOutput(sessionId, { input: 9300, output: 5 });
        state = getSession(sessionId);
        expect(state?.stuckLoops).toBe(2);

        // 8th turn (breaks out, high output)
        trackLlmOutput(sessionId, { input: 9400, output: 300 });
        state = getSession(sessionId);
        expect(state?.stuckLoops).toBe(1); // decrements
    });

    it('should accumulate friction and reset on success', () => {
        const errorHash = 'abc-123';
        
        // 1st error
        trackFriction(sessionId, 30, errorHash);
        let state = getSession(sessionId);
        expect(state?.currentGfi).toBe(30);
        expect(state?.consecutiveErrors).toBe(1);

        // 2nd identical error (multiplier 1.5^1 = 1.5)
        trackFriction(sessionId, 30, errorHash);
        state = getSession(sessionId);
        expect(state?.currentGfi).toBe(30 + (30 * 1.5)); // 75
        expect(state?.consecutiveErrors).toBe(2);

        // 3rd identical error (multiplier 1.5^2 = 2.25)
        trackFriction(sessionId, 30, errorHash);
        state = getSession(sessionId);
        expect(state?.currentGfi).toBe(75 + (30 * 2.25)); // 75 + 67.5 = 142.5
        expect(state?.consecutiveErrors).toBe(3);

        // Success should reset GFI
        resetFriction(sessionId);
        state = getSession(sessionId);
        expect(state?.currentGfi).toBe(0);
        expect(state?.consecutiveErrors).toBe(0);
        expect(state?.gfiBySource).toEqual({});
    });

    it('should reset multiplier on different error hash', () => {
        trackFriction(sessionId, 30, 'hash-1');
        trackFriction(sessionId, 30, 'hash-2');
        
        let state = getSession(sessionId);
        expect(state?.currentGfi).toBe(60); // 30 + 30
        expect(state?.consecutiveErrors).toBe(1); // reset to 1 for new hash
    });

    it('should rollback only the empathy source slice instead of wiping total gfi', () => {
        trackFriction(sessionId, 30, 'tool_failure_hash');
        trackFriction(sessionId, 20, 'user_empathy_moderate', undefined, { source: 'user_empathy' });

        let state = getSession(sessionId);
        expect(state?.currentGfi).toBe(50);
        expect(state?.gfiBySource).toEqual({
            'unattributed:tool_failure_hash': 30,
            user_empathy: 20,
        });

        resetFriction(sessionId, undefined, { source: 'user_empathy', amount: 20 });

        state = getSession(sessionId);
        expect(state?.currentGfi).toBe(30);
        expect(state?.gfiBySource).toEqual({
            'unattributed:tool_failure_hash': 30,
        });
        expect(state?.consecutiveErrors).toBe(0);
        expect(state?.lastErrorHash).toBe('');
        expect(state?.lastErrorSource).toBe('');
    });

    it('should clamp slice rollback amount and preserve other source ledger entries', () => {
        trackFriction(sessionId, 10, 'tool_failure_hash');
        trackFriction(sessionId, 15, 'user_empathy_mild', undefined, { source: 'user_empathy' });
        trackFriction(sessionId, 5, 'system_empathy_warn', undefined, { source: 'system_infer' });

        resetFriction(sessionId, undefined, { source: 'user_empathy', amount: 999 });

        const state = getSession(sessionId);
        expect(state?.currentGfi).toBe(15);
        expect(state?.gfiBySource).toEqual({
            'unattributed:tool_failure_hash': 10,
            system_infer: 5,
        });
    });

    it('should ignore slice rollback for a source that does not exist', () => {
        trackFriction(sessionId, 12, 'tool_failure_hash');

        resetFriction(sessionId, undefined, { source: 'user_empathy', amount: 7 });

        const state = getSession(sessionId);
        expect(state?.currentGfi).toBe(12);
        expect(state?.gfiBySource).toEqual({
            'unattributed:tool_failure_hash': 12,
        });
        expect(state?.consecutiveErrors).toBe(1);
        expect(state?.lastErrorHash).toBe('tool_failure_hash');
    });

    it('should persist multiple sessions independently instead of overwriting the previous debounce timer', () => {
        vi.useFakeTimers();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-session-persist-'));
        initPersistence(tempDir);

        trackFriction('session-a', 10, 'hash-a', tempDir);
        trackFriction('session-b', 15, 'hash-b', tempDir);

        vi.advanceTimersByTime(1000);

        expect(fs.existsSync(path.join(tempDir, 'sessions', 'session-a.json'))).toBe(true);
        expect(fs.existsSync(path.join(tempDir, 'sessions', 'session-b.json'))).toBe(true);
    });

    it('should refresh control activity timestamps for block and thinking updates', () => {
        trackBlock(sessionId);
        let state = getSession(sessionId);
        const blockTs = state?.lastControlActivityAt ?? 0;
        expect(blockTs).toBeGreaterThan(0);

        recordThinkingCheckpoint(sessionId);
        state = getSession(sessionId);
        expect((state?.lastControlActivityAt ?? 0) >= blockTs).toBe(true);
    });
});
