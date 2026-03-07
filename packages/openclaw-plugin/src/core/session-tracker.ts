import { PluginHookLlmOutputEvent } from '../openclaw-sdk.js';
import * as path from 'path';

export interface TokenUsage {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
}

export interface SessionState {
    sessionId: string;
    toolReadsByFile: Record<string, number>;
    llmTurns: number;
    blockedAttempts: number;
    lastActivityAt: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    cacheHits: number;
    // Track consecutive loops of similar lengths/ratios (paralysis)
    stuckLoops: number;
}

const sessions = new Map<string, SessionState>();

function getOrCreateSession(sessionId: string): SessionState {
    let state = sessions.get(sessionId);
    if (!state) {
        state = {
            sessionId,
            toolReadsByFile: {},
            llmTurns: 0,
            blockedAttempts: 0,
            lastActivityAt: Date.now(),
            totalInputTokens: 0,
            totalOutputTokens: 0,
            cacheHits: 0,
            stuckLoops: 0,
        };
        sessions.set(sessionId, state);
    }
    return state;
}

export function trackToolRead(sessionId: string, filePath: string): SessionState {
    const state = getOrCreateSession(sessionId);
    const normalizedPath = path.posix.normalize(filePath.replace(/\\/g, '/'));
    state.toolReadsByFile[normalizedPath] = (state.toolReadsByFile[normalizedPath] || 0) + 1;
    state.lastActivityAt = Date.now();
    return state;
}

export function trackLlmOutput(sessionId: string, usage: TokenUsage | undefined): SessionState {
    const state = getOrCreateSession(sessionId);
    state.llmTurns += 1;
    state.lastActivityAt = Date.now();

    if (usage) {
        state.totalInputTokens += usage.input || 0;
        state.totalOutputTokens += usage.output || 0;
        state.cacheHits += usage.cacheRead || 0;

        // Very rough heuristic for empty/paralysis loops: high input context, tiny output, multiple turns
        if (state.llmTurns > 3) {
            const isTinyOutput = (usage.output || 0) < 50;
            const isLargeInput = (usage.input || 0) > 4000;
            if (isTinyOutput && isLargeInput) {
                state.stuckLoops += 1;
            } else {
                // Reset if we broke out of the tiny output loop
                state.stuckLoops = Math.max(0, state.stuckLoops - 1);
            }
        }
    }

    return state;
}

export function trackBlock(sessionId: string): SessionState {
    const state = getOrCreateSession(sessionId);
    state.blockedAttempts += 1;
    state.lastActivityAt = Date.now();
    return state;
}

export function getSession(sessionId: string): SessionState | undefined {
    return sessions.get(sessionId);
}

export function clearSession(sessionId: string): void {
    sessions.delete(sessionId);
}

// Memory cleanup for abandoned sessions (older than 2 hours)
export function garbageCollectSessions(): void {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, state] of sessions.entries()) {
        if (state.lastActivityAt < twoHoursAgo) {
            sessions.delete(id);
        }
    }
}
