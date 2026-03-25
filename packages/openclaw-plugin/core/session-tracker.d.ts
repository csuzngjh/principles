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
    workspaceDir?: string;
    toolReadsByFile: Record<string, number>;
    llmTurns: number;
    blockedAttempts: number;
    lastActivityAt: number;
    lastControlActivityAt: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    cacheHits: number;
    stuckLoops: number;
    currentGfi: number;
    gfiBySource?: Record<string, number>;
    lastErrorSource?: string;
    lastErrorHash: string;
    consecutiveErrors: number;
    dailyToolCalls: number;
    dailyToolFailures: number;
    dailyPainSignals: number;
    dailyGfiPeak: number;
    lastThinkingTimestamp: number;
    injectedProbationIds?: string[];
}
/**
 * Initialize persistence for session state.
 * Call this once during plugin startup.
 */
export declare function initPersistence(stateDir: string): void;
/**
 * Force persist all sessions immediately.
 */
export declare function flushAllSessions(): void;
export declare function trackToolRead(sessionId: string, filePath: string, workspaceDir?: string): SessionState;
export declare function trackLlmOutput(sessionId: string, usage: TokenUsage | undefined, config?: PainConfig, workspaceDir?: string): SessionState;
/**
 * Tracks physical friction based on tool execution failures.
 */
export declare function trackFriction(sessionId: string, deltaF: number, hash: string, workspaceDir?: string, options?: {
    source?: string;
}): SessionState;
/**
 * Resets the friction index upon successful action.
 */
export declare function resetFriction(sessionId: string, workspaceDir?: string, options?: {
    source?: string;
    amount?: number;
}): SessionState;
/**
 * Records that deep thinking (Thinking OS) was performed in this session.
 * Used by the Thinking OS checkpoint to allow high-risk operations.
 */
export declare function recordThinkingCheckpoint(sessionId: string, workspaceDir?: string): SessionState;
/**
 * Checks if deep thinking was performed recently (within the given window).
 * @param sessionId - The session to check
 * @param windowMs - How recent the thinking must be (default: 5 minutes)
 * @returns true if thinking was recorded within the window
 */
export declare function hasRecentThinking(sessionId: string, windowMs?: number): boolean;
export declare function trackBlock(sessionId: string): SessionState;
export declare function setInjectedProbationIds(sessionId: string, ids: string[], workspaceDir?: string): SessionState;
export declare function getInjectedProbationIds(sessionId: string, workspaceDir?: string): string[];
export declare function clearInjectedProbationIds(sessionId: string, workspaceDir?: string): SessionState;
export declare function getSession(sessionId: string): SessionState | undefined;
export declare function listSessions(workspaceDir?: string): SessionState[];
export declare function clearSession(sessionId: string): void;
export declare function garbageCollectSessions(): void;
/**
 * Get daily statistics summary for a session.
 */
export declare function getDailySummary(sessionId: string): {
    toolCalls: number;
    toolFailures: number;
    painSignals: number;
    gfiPeak: number;
} | null;
/**
 * Reset daily statistics (call at midnight or on new day).
 */
export declare function resetDailyStats(sessionId: string): void;
