import { PluginHookLlmOutputEvent } from '../openclaw-sdk.js';
import * as path from 'path';
import { PainConfig } from './config.js';

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
    
    // GFI - Track A: Empirical Friction
    currentGfi: number;
    lastErrorHash: string;
    consecutiveErrors: number;
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
            currentGfi: 0,
            lastErrorHash: '',
            consecutiveErrors: 0,
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

export function trackLlmOutput(sessionId: string, usage: TokenUsage | undefined, config?: PainConfig): SessionState {
    const state = getOrCreateSession(sessionId);
    state.llmTurns += 1;
    state.lastActivityAt = Date.now();

    if (usage) {
        state.totalInputTokens += usage.input || 0;
        state.totalOutputTokens += usage.output || 0;
        state.cacheHits += usage.cacheRead || 0;

        // Use thresholds from config or defaults
        const minTurns = 3;
        const outputThreshold = 50;
        const inputThreshold = config ? config.get('thresholds.cognitive_paralysis_input') : 4000;

        // Very rough heuristic for empty/paralysis loops: high input context, tiny output, multiple turns
        if (state.llmTurns > minTurns) {
            const isTinyOutput = (usage.output || 0) < outputThreshold;
            const isLargeInput = (usage.input || 0) > inputThreshold;
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

/**
 * Tracks physical friction based on tool execution failures.
 */
export function trackFriction(sessionId: string, deltaF: number, hash: string): SessionState {
    const state = getOrCreateSession(sessionId);
    
    if (hash && hash === state.lastErrorHash) {
        state.consecutiveErrors++;
    } else {
        state.lastErrorHash = hash;
        state.consecutiveErrors = 1;
    }

    // GFI formula with multiplier: GFI = GFI + (Delta_F * 1.5^(n-1))
    const multiplier = Math.pow(1.5, state.consecutiveErrors - 1);
    state.currentGfi = (state.currentGfi || 0) + (deltaF * multiplier);
    state.lastActivityAt = Date.now();
    return state;
}

/**
 * Resets the friction index upon successful action.
 */
export function resetFriction(sessionId: string): SessionState {
    const state = getOrCreateSession(sessionId);
    state.currentGfi = 0;
    state.consecutiveErrors = 0;
    state.lastErrorHash = '';
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
