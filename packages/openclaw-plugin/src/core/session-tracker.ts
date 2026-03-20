import { PluginHookLlmOutputEvent } from '../openclaw-sdk.js';
import * as path from 'path';
import * as fs from 'fs';
import { PainConfig } from './config.js';
import { SystemLogger } from './system-logger.js';
import { EventLogService } from './event-log.js';

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
    totalInputTokens: number;
    totalOutputTokens: number;
    cacheHits: number;
    // Track consecutive loops of similar lengths/ratios (paralysis)
    stuckLoops: number;
    
    // GFI - Track A: Empirical Friction
    currentGfi: number;
    gfiBySource?: Record<string, number>;
    lastErrorSource?: string;
    lastErrorHash: string;
    consecutiveErrors: number;
    
    // Daily statistics (persisted)
    dailyToolCalls: number;
    dailyToolFailures: number;
    dailyPainSignals: number;
    dailyGfiPeak: number;
    
    // Thinking OS checkpoint - tracks last deep thinking timestamp
    lastThinkingTimestamp: number;

    // Evolution loop feedback attribution
    injectedProbationIds?: string[];
}


const sessions = new Map<string, SessionState>();

/** Directory for persisting session state */
let persistDir: string | null = null;

/** Debounce timer for persistence */
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function logSessionTrackerWarning(message: string, error?: unknown): void {
    const detail = error instanceof Error ? error.message : error ? String(error) : '';
    const suffix = detail ? `: ${detail}` : '';
    console.warn(`[PD:SessionTracker] ${message}${suffix}`);
}

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
            } catch (error) {
                logSessionTrackerWarning(`Failed to load session snapshot ${file}`, error);
            }
        }
    } catch (err) {
        logSessionTrackerWarning('Failed to load persisted sessions', err);
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
    } catch (error) {
        logSessionTrackerWarning(`Failed to persist session ${state.sessionId}`, error);
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

function getOrCreateSession(sessionId: string, workspaceDir?: string): SessionState {
    let state = sessions.get(sessionId);
    if (!state) {
        state = {
            sessionId,
            workspaceDir,
            toolReadsByFile: {},
            llmTurns: 0,
            blockedAttempts: 0,
            lastActivityAt: Date.now(),
            totalInputTokens: 0,
            totalOutputTokens: 0,
            cacheHits: 0,
            stuckLoops: 0,
            currentGfi: 0,
            gfiBySource: {},
            lastErrorSource: '',
            lastErrorHash: '',
            consecutiveErrors: 0,
            dailyToolCalls: 0,
            dailyToolFailures: 0,
            dailyPainSignals: 0,
            dailyGfiPeak: 0,
            lastThinkingTimestamp: 0,
            injectedProbationIds: [],
        };
        sessions.set(sessionId, state);
    }
    
    if (workspaceDir && !state.workspaceDir) {
        state.workspaceDir = workspaceDir;
    }
    return state;
}

function ensureGfiLedger(state: SessionState): Record<string, number> {
    if (!state.gfiBySource || typeof state.gfiBySource !== 'object') {
        state.gfiBySource = {};
    }
    return state.gfiBySource;
}

export function trackToolRead(sessionId: string, filePath: string, workspaceDir?: string): SessionState {
    const state = getOrCreateSession(sessionId, workspaceDir);
    const normalizedPath = path.posix.normalize(filePath.replace(/\\/g, '/'));
    state.toolReadsByFile[normalizedPath] = (state.toolReadsByFile[normalizedPath] || 0) + 1;
    state.lastActivityAt = Date.now();
    return state;
}

export function trackLlmOutput(sessionId: string, usage: TokenUsage | undefined, config?: PainConfig, workspaceDir?: string): SessionState {
    const state = getOrCreateSession(sessionId, workspaceDir);
    state.llmTurns += 1;
    state.lastActivityAt = Date.now();

    if (usage) {
        state.totalInputTokens += usage.input || 0;
        state.totalOutputTokens += usage.output || 0;
        state.cacheHits += usage.cacheRead || 0;

        // Use thresholds from config or defaults
        const minTurns = 5; // Increased from 3 to 5 to prevent false positives on short tasks
        const outputThreshold = 30; // Decreased from 50. Only penalize truly stunted outputs.
        const inputThreshold = config ? config.get('thresholds.cognitive_paralysis_input') : 8000; // Increased base to 8k

        // Very rough heuristic for empty/paralysis loops: high input context, tiny output, multiple turns
        if (state.llmTurns > minTurns) {
            const isTinyOutput = (usage.output || 0) < outputThreshold;
            const isLargeInput = (usage.input || 0) > inputThreshold;
            if (isTinyOutput && isLargeInput) {
                state.stuckLoops += 1;
                SystemLogger.log(state.workspaceDir, 'EFFICIENCY_ALARM', `Stuck loop detected (Turn ${state.llmTurns}). Input: ${usage.input}, Output: ${usage.output}. Consecutive: ${state.stuckLoops}`);
            } else {
                // Reset if we broke out of the tiny output loop
                if (state.stuckLoops > 0) {
                    SystemLogger.log(state.workspaceDir, 'EFFICIENCY_OK', `Broke out of stuck loop after ${state.stuckLoops} turns.`);
                }
                state.stuckLoops = Math.max(0, state.stuckLoops - 1);
            }
        }
    }

    return state;
}

/**
 * Tracks physical friction based on tool execution failures.
 */
export function trackFriction(
    sessionId: string,
    deltaF: number,
    hash: string,
    workspaceDir?: string,
    options?: { source?: string }
): SessionState {
    const state = getOrCreateSession(sessionId, workspaceDir);
    const ledger = ensureGfiLedger(state);
    
    if (hash && hash === state.lastErrorHash) {
        state.consecutiveErrors++;
    } else {
        state.lastErrorSource = options?.source || (hash ? `unattributed:${hash}` : 'unattributed:unknown');
        state.lastErrorHash = hash;
        state.consecutiveErrors = 1;
    }

    // GFI formula with multiplier: GFI = GFI + (Delta_F * 1.5^(n-1))
    const multiplier = Math.pow(1.5, state.consecutiveErrors - 1);
    const addedFriction = deltaF * multiplier;
    state.currentGfi = (state.currentGfi || 0) + addedFriction;
    const sourceKey = options?.source || (hash ? `unattributed:${hash}` : 'unattributed:unknown');
    ledger[sourceKey] = (ledger[sourceKey] || 0) + addedFriction;
    state.lastActivityAt = Date.now();
    
    SystemLogger.log(state.workspaceDir, 'GFI_INC', `Friction added: +${addedFriction.toFixed(1)} (Base: ${deltaF}, Mult: ${multiplier.toFixed(2)}). Total GFI: ${state.currentGfi.toFixed(1)}`);
    
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
export function resetFriction(
    sessionId: string,
    workspaceDir?: string,
    options?: { source?: string; amount?: number }
): SessionState {
    const state = getOrCreateSession(sessionId, workspaceDir);
    const ledger = ensureGfiLedger(state);

    if (options?.source) {
        const sourceKey = options.source;
        const currentSource = ledger[sourceKey] || 0;
        const requestedAmount = Number.isFinite(options.amount) ? Number(options.amount) : currentSource;
        const amountToRemove = Math.max(0, Math.min(currentSource, requestedAmount));

        if (amountToRemove > 0) {
            ledger[sourceKey] = Math.max(0, currentSource - amountToRemove);
            if (ledger[sourceKey] === 0) {
                delete ledger[sourceKey];
            }
            state.currentGfi = Math.max(0, (state.currentGfi || 0) - amountToRemove);
            SystemLogger.log(
                state.workspaceDir,
                'GFI_SLICE_RESET',
                `Friction slice reset for ${sourceKey}: -${amountToRemove.toFixed(1)}. Total GFI: ${state.currentGfi.toFixed(1)}`
            );

            if (state.lastErrorSource === sourceKey) {
                state.consecutiveErrors = 0;
                state.lastErrorHash = '';
                state.lastErrorSource = '';
            }
        }
        schedulePersistence(state);
        return state;
    }

    if (state.currentGfi > 0) {
        SystemLogger.log(state.workspaceDir, 'GFI_RESET', `Friction reset to 0 (Was: ${state.currentGfi.toFixed(1)}). Action successful.`);
    }
    state.currentGfi = 0;
    state.gfiBySource = {};
    state.lastErrorSource = '';
    state.consecutiveErrors = 0;
    state.lastErrorHash = '';
    
    // Schedule persistence
    schedulePersistence(state);
    
    return state;
}

/**
 * Records that deep thinking (Thinking OS) was performed in this session.
 * Used by the Thinking OS checkpoint to allow high-risk operations.
 */
export function recordThinkingCheckpoint(sessionId: string, workspaceDir?: string): SessionState {
    const state = getOrCreateSession(sessionId, workspaceDir);
    state.lastThinkingTimestamp = Date.now();
    SystemLogger.log(state.workspaceDir, 'THINKING_CHECKPOINT', `Deep thinking recorded at ${new Date(state.lastThinkingTimestamp).toISOString()}`);
    schedulePersistence(state);
    return state;
}

/**
 * Checks if deep thinking was performed recently (within the given window).
 * @param sessionId - The session to check
 * @param windowMs - How recent the thinking must be (default: 5 minutes)
 * @returns true if thinking was recorded within the window
 */
export function hasRecentThinking(sessionId: string, windowMs: number = 5 * 60 * 1000): boolean {
    const state = sessions.get(sessionId);
    if (!state || !state.lastThinkingTimestamp) return false;
    return (Date.now() - state.lastThinkingTimestamp) < windowMs;
}

export function trackBlock(sessionId: string): SessionState {
    const state = getOrCreateSession(sessionId);
    state.blockedAttempts += 1;
    state.lastActivityAt = Date.now();
    return state;
}


export function setInjectedProbationIds(sessionId: string, ids: string[], workspaceDir?: string): SessionState {
    const state = getOrCreateSession(sessionId, workspaceDir);
    state.injectedProbationIds = [...ids];
    state.lastActivityAt = Date.now();
    schedulePersistence(state);
    return state;
}

export function getInjectedProbationIds(sessionId: string, workspaceDir?: string): string[] {
    const state = getOrCreateSession(sessionId, workspaceDir);
    return [...(state.injectedProbationIds || [])];
}

export function clearInjectedProbationIds(sessionId: string, workspaceDir?: string): SessionState {
    return setInjectedProbationIds(sessionId, [], workspaceDir);
}

export function getSession(sessionId: string): SessionState | undefined {
    return sessions.get(sessionId);
}

export function listSessions(workspaceDir?: string): SessionState[] {
    return [...sessions.values()]
        .filter((state) => !workspaceDir || !state.workspaceDir || state.workspaceDir === workspaceDir)
        .map((state) => ({
            ...state,
            toolReadsByFile: { ...state.toolReadsByFile },
            gfiBySource: state.gfiBySource ? { ...state.gfiBySource } : undefined,
            injectedProbationIds: state.injectedProbationIds ? [...state.injectedProbationIds] : undefined,
        }));
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
                    } catch (error) {
                        logSessionTrackerWarning(`Failed to delete session snapshot for ${id}`, error);
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
