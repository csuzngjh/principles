import { PluginHookLlmOutputEvent } from '../openclaw-sdk.js';
import * as path from 'path';
import * as fs from 'fs';
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
    
    // Daily statistics (persisted)
    dailyToolCalls: number;
    dailyToolFailures: number;
    dailyPainSignals: number;
    dailyGfiPeak: number;
}

const sessions = new Map<string, SessionState>();

/** Directory for persisting session state */
let persistDir: string | null = null;

/** Debounce timer for persistence */
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Initialize persistence for session state.
 * Call this once during plugin startup.
 */
export function initPersistence(stateDir: string): void {
    persistDir = path.join(stateDir, 'sessions');
    if (!fs.existsSync(persistDir)) {
        fs.mkdirSync(persistDir, { recursive: true });
    }
    
    // Load all existing sessions
    loadAllSessions();
}

/**
 * Get the file path for a session's persisted state.
 */
function getSessionPath(sessionId: string): string {
    if (!persistDir) return '';
    // Sanitize sessionId for filesystem
    const safeId = sessionId.replace(/[/\\:]/g, '_');
    return path.join(persistDir, `${safeId}.json`);
}

/**
 * Load all persisted sessions from disk.
 */
function loadAllSessions(): void {
    if (!persistDir || !fs.existsSync(persistDir)) return;
    
    try {
        const files = fs.readdirSync(persistDir).filter(f => f.endsWith('.json'));
        const now = Date.now();
        const twoHoursAgo = now - 2 * 60 * 60 * 1000;
        
        for (const file of files) {
            try {
                const content = fs.readFileSync(path.join(persistDir, file), 'utf-8');
                const state = JSON.parse(content) as SessionState;
                
                // Skip abandoned sessions
                if (state.lastActivityAt < twoHoursAgo) {
                    continue;
                }
                
                sessions.set(state.sessionId, state);
            } catch {
                // Ignore corrupted files
            }
        }
    } catch (err) {
        // Ignore errors during load
    }
}

/**
 * Persist a single session to disk.
 */
function persistSession(state: SessionState): void {
    if (!persistDir) return;
    
    const sessionPath = getSessionPath(state.sessionId);
    if (!sessionPath) return;
    
    try {
        fs.writeFileSync(sessionPath, JSON.stringify(state, null, 2), 'utf-8');
    } catch {
        // Ignore persistence errors
    }
}

/**
 * Schedule persistence with debounce.
 */
function schedulePersistence(state: SessionState): void {
    if (persistTimer) {
        clearTimeout(persistTimer);
    }
    persistTimer = setTimeout(() => {
        persistSession(state);
        persistTimer = null;
    }, 1000);  // 1 second debounce
}

/**
 * Force persist all sessions immediately.
 */
export function flushAllSessions(): void {
    for (const state of sessions.values()) {
        persistSession(state);
    }
}

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
            dailyToolCalls: 0,
            dailyToolFailures: 0,
            dailyPainSignals: 0,
            dailyGfiPeak: 0,
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
    
    // Update daily stats
    state.dailyToolFailures++;
    state.dailyGfiPeak = Math.max(state.dailyGfiPeak, state.currentGfi);
    
    // Schedule persistence
    schedulePersistence(state);
    
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
    
    // Schedule persistence
    schedulePersistence(state);
    
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
            
            // Also delete persisted file
            if (persistDir) {
                const sessionPath = getSessionPath(id);
                if (sessionPath && fs.existsSync(sessionPath)) {
                    try {
                        fs.unlinkSync(sessionPath);
                    } catch {
                        // Ignore deletion errors
                    }
                }
            }
        }
    }
}

/**
 * Get daily statistics summary for a session.
 */
export function getDailySummary(sessionId: string): {
    toolCalls: number;
    toolFailures: number;
    painSignals: number;
    gfiPeak: number;
} | null {
    const state = sessions.get(sessionId);
    if (!state) return null;
    
    return {
        toolCalls: state.dailyToolCalls,
        toolFailures: state.dailyToolFailures,
        painSignals: state.dailyPainSignals,
        gfiPeak: state.dailyGfiPeak,
    };
}

/**
 * Reset daily statistics (call at midnight or on new day).
 */
export function resetDailyStats(sessionId: string): void {
    const state = sessions.get(sessionId);
    if (state) {
        state.dailyToolCalls = 0;
        state.dailyToolFailures = 0;
        state.dailyPainSignals = 0;
        state.dailyGfiPeak = 0;
        schedulePersistence(state);
    }
}
