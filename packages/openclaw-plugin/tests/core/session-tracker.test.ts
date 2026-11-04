import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// 31a60e1e5 retired the friction state (trackFriction / resetFriction /
// currentGfi / gfiBySource / per-source slice rollback) — SPEC §3.2. The
// session tracker now only tracks reads, LLM turns, blocks and injected ids.
import {
    trackToolRead,
    trackLlmOutput,
    getSession,
    clearSession,
    initPersistence,
    trackBlock,
    setInjectedPrincipleIds,
    getInjectedPrincipleIds,
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

    it('should persist multiple sessions independently instead of overwriting the previous debounce timer', () => {
        vi.useFakeTimers();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-session-persist-'));
        initPersistence(tempDir);

        // (c) 类：per-session debounce 不被覆盖这一不变量仍然有效，驱动点从
        // 已删除的 trackFriction 迁到仍在生产的 trackBlock
        // (src/core/session-tracker.ts:272-277，内部调用 schedulePersistence)。
        trackBlock('session-a');
        trackBlock('session-b');

        vi.advanceTimersByTime(1000);

        expect(fs.existsSync(path.join(tempDir, 'sessions', 'session-a.json'))).toBe(true);
        expect(fs.existsSync(path.join(tempDir, 'sessions', 'session-b.json'))).toBe(true);
    });

    it('should refresh control activity timestamps for block updates', () => {
        trackBlock(sessionId);
        const state = getSession(sessionId);
        const blockTs = state?.lastControlActivityAt ?? 0;
        expect(blockTs).toBeGreaterThan(0);
    });

    // Thinking checkpoint retirement (2026-08-19, Wave 4): the
    // recordThinkingCheckpoint/hasRecentThinking tests were removed together
    // with the API — the retired recentThinking rule input had no remaining
    // consumer after rule-real-diagnosis-first v2 migration.

    it('getInjectedPrincipleIds returns the tracked set and undefined for unknown sessions (PRI-755)', () => {
        // Unknown session: read-only getter must not create state and must not
        // imply an empty set — undefined means "cannot prove membership".
        expect(getSession('sess-pri755')).toBeUndefined();
        expect(getInjectedPrincipleIds('sess-pri755')).toBeUndefined();

        setInjectedPrincipleIds('sess-pri755', ['T-01', 'T-02']);
        const ids = getInjectedPrincipleIds('sess-pri755');
        expect(ids).toEqual(['T-01', 'T-02']);

        // Returned array is a copy — mutating it must not corrupt tracker state.
        (ids as string[]).push('T-99');
        expect(getInjectedPrincipleIds('sess-pri755')).toEqual(['T-01', 'T-02']);
    });

    it('setInjectedPrincipleIds records an empty set as known-empty, clearing stale rounds (PRI-755 review fix)', () => {
        setInjectedPrincipleIds('sess-pri755', ['T-01']);
        expect(getInjectedPrincipleIds('sess-pri755')).toEqual(['T-01']);

        // An empty round (no Runtime V2 injection this turn) must OVERWRITE the
        // stale set — a marker for T-01 after this point is unverifiable.
        setInjectedPrincipleIds('sess-pri755', []);
        expect(getInjectedPrincipleIds('sess-pri755')).toEqual([]);
    });
});
