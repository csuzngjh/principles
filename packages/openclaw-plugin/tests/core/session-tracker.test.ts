import { describe, it, expect, beforeEach } from 'vitest';
import { trackToolRead, trackLlmOutput, getSession, clearSession, trackFriction, resetFriction } from '../../src/core/session-tracker.js';

describe('Session Tracker', () => {
    const sessionId = 'test-session-1';

    beforeEach(() => {
        clearSession(sessionId);
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
            tool_failure_hash: 30,
            user_empathy: 20,
        });

        resetFriction(sessionId, undefined, { source: 'user_empathy', amount: 20 });

        state = getSession(sessionId);
        expect(state?.currentGfi).toBe(30);
        expect(state?.gfiBySource).toEqual({
            tool_failure_hash: 30,
        });
        expect(state?.consecutiveErrors).toBe(0);
        expect(state?.lastErrorHash).toBe('');
        expect(state?.lastErrorSource).toBe('');
    });
});
