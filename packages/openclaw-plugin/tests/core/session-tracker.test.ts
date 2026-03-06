import { describe, it, expect, beforeEach } from 'vitest';
import { trackToolRead, trackLlmOutput, getSession, clearSession } from '../../src/core/session-tracker';

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
        trackLlmOutput(sessionId, { input: 4500, output: 20 });
        // 3rd turn
        trackLlmOutput(sessionId, { input: 4800, output: 15 });

        let state = getSession(sessionId);
        expect(state?.stuckLoops).toBe(0); // Needs > 3 turns total

        // 4th turn (should trigger loop detection)
        trackLlmOutput(sessionId, { input: 5000, output: 10 });
        state = getSession(sessionId);
        expect(state?.stuckLoops).toBe(1);

        // 5th turn (continues loop)
        trackLlmOutput(sessionId, { input: 5200, output: 5 });
        state = getSession(sessionId);
        expect(state?.stuckLoops).toBe(2);

        // 6th turn (breaks out, high output)
        trackLlmOutput(sessionId, { input: 5200, output: 300 });
        state = getSession(sessionId);
        expect(state?.stuckLoops).toBe(1); // decrements
    });
});
