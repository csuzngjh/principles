import * as path from 'path';
import * as fs from 'fs';
import { SystemLogger } from './system-logger.js';
const sessions = new Map();
/** Directory for persisting session state */
let persistDir = null;
/** Debounce timers for persistence, one per session */
const persistTimers = new Map();
function logSessionTrackerWarning(message, error) {
    const detail = error instanceof Error ? error.message : error ? String(error) : '';
    const suffix = detail ? `: ${detail}` : '';
    console.warn(`[PD:SessionTracker] ${message}${suffix}`);
}
function touchActivity(state, kind = 'general') {
    const now = Date.now();
    state.lastActivityAt = now;
    if (kind === 'control') {
        state.lastControlActivityAt = now;
    }
}
/**
 * Initialize persistence for session state.
 * Call this once during plugin startup.
 */
export function initPersistence(stateDir) {
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
function getSessionPath(sessionId) {
    if (!persistDir)
        return '';
    // Sanitize sessionId for filesystem
    const safeId = sessionId.replace(/[/\\:]/g, '_');
    return path.join(persistDir, `${safeId}.json`);
}
/**
 * Load all persisted sessions from disk.
 */
function loadAllSessions() {
    if (!persistDir || !fs.existsSync(persistDir))
        return;
    try {
        const files = fs.readdirSync(persistDir).filter(f => f.endsWith('.json'));
        const now = Date.now();
        const twoHoursAgo = now - 2 * 60 * 60 * 1000;
        for (const file of files) {
            try {
                const content = fs.readFileSync(path.join(persistDir, file), 'utf-8');
                const state = JSON.parse(content);
                // Skip abandoned sessions
                if (state.lastActivityAt < twoHoursAgo) {
                    continue;
                }
                sessions.set(state.sessionId, state);
            }
            catch (error) {
                logSessionTrackerWarning(`Failed to load session snapshot ${file}`, error);
            }
        }
    }
    catch (err) {
        logSessionTrackerWarning('Failed to load persisted sessions', err);
    }
}
/**
 * Persist a single session to disk.
 */
function persistSession(state) {
    if (!persistDir)
        return;
    const sessionPath = getSessionPath(state.sessionId);
    if (!sessionPath)
        return;
    try {
        fs.writeFileSync(sessionPath, JSON.stringify(state, null, 2), 'utf-8');
    }
    catch (error) {
        logSessionTrackerWarning(`Failed to persist session ${state.sessionId}`, error);
    }
}
/**
 * Schedule persistence with debounce.
 */
function schedulePersistence(state) {
    const existing = persistTimers.get(state.sessionId);
    if (existing) {
        clearTimeout(existing);
    }
    const timer = setTimeout(() => {
        persistSession(state);
        persistTimers.delete(state.sessionId);
    }, 1000); // 1 second debounce
    persistTimers.set(state.sessionId, timer);
}
/**
 * Force persist all sessions immediately.
 */
export function flushAllSessions() {
    for (const timer of persistTimers.values()) {
        clearTimeout(timer);
    }
    persistTimers.clear();
    for (const state of sessions.values()) {
        persistSession(state);
    }
}
function getOrCreateSession(sessionId, workspaceDir) {
    let state = sessions.get(sessionId);
    if (!state) {
        state = {
            sessionId,
            workspaceDir,
            toolReadsByFile: {},
            llmTurns: 0,
            blockedAttempts: 0,
            lastActivityAt: Date.now(),
            lastControlActivityAt: Date.now(),
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
function ensureGfiLedger(state) {
    if (!state.gfiBySource || typeof state.gfiBySource !== 'object') {
        state.gfiBySource = {};
    }
    return state.gfiBySource;
}
export function trackToolRead(sessionId, filePath, workspaceDir) {
    const state = getOrCreateSession(sessionId, workspaceDir);
    const normalizedPath = path.posix.normalize(filePath.replace(/\\/g, '/'));
    state.toolReadsByFile[normalizedPath] = (state.toolReadsByFile[normalizedPath] || 0) + 1;
    touchActivity(state);
    return state;
}
export function trackLlmOutput(sessionId, usage, config, workspaceDir) {
    const state = getOrCreateSession(sessionId, workspaceDir);
    state.llmTurns += 1;
    touchActivity(state);
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
            }
            else {
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
export function trackFriction(sessionId, deltaF, hash, workspaceDir, options) {
    const state = getOrCreateSession(sessionId, workspaceDir);
    const ledger = ensureGfiLedger(state);
    if (hash && hash === state.lastErrorHash) {
        state.consecutiveErrors++;
    }
    else {
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
    touchActivity(state, 'control');
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
export function resetFriction(sessionId, workspaceDir, options) {
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
            SystemLogger.log(state.workspaceDir, 'GFI_SLICE_RESET', `Friction slice reset for ${sourceKey}: -${amountToRemove.toFixed(1)}. Total GFI: ${state.currentGfi.toFixed(1)}`);
            if (state.lastErrorSource === sourceKey) {
                state.consecutiveErrors = 0;
                state.lastErrorHash = '';
                state.lastErrorSource = '';
            }
        }
        touchActivity(state, 'control');
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
    touchActivity(state, 'control');
    // Schedule persistence
    schedulePersistence(state);
    return state;
}
/**
 * Records that deep thinking (Thinking OS) was performed in this session.
 * Used by the Thinking OS checkpoint to allow high-risk operations.
 */
export function recordThinkingCheckpoint(sessionId, workspaceDir) {
    const state = getOrCreateSession(sessionId, workspaceDir);
    state.lastThinkingTimestamp = Date.now();
    touchActivity(state, 'control');
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
export function hasRecentThinking(sessionId, windowMs = 5 * 60 * 1000) {
    const state = sessions.get(sessionId);
    if (!state || !state.lastThinkingTimestamp)
        return false;
    return (Date.now() - state.lastThinkingTimestamp) < windowMs;
}
export function trackBlock(sessionId) {
    const state = getOrCreateSession(sessionId);
    state.blockedAttempts += 1;
    touchActivity(state, 'control');
    schedulePersistence(state);
    return state;
}
export function setInjectedProbationIds(sessionId, ids, workspaceDir) {
    const state = getOrCreateSession(sessionId, workspaceDir);
    state.injectedProbationIds = [...ids];
    touchActivity(state, 'control');
    schedulePersistence(state);
    return state;
}
export function getInjectedProbationIds(sessionId, workspaceDir) {
    const state = getOrCreateSession(sessionId, workspaceDir);
    return [...(state.injectedProbationIds || [])];
}
export function clearInjectedProbationIds(sessionId, workspaceDir) {
    return setInjectedProbationIds(sessionId, [], workspaceDir);
}
export function getSession(sessionId) {
    return sessions.get(sessionId);
}
export function listSessions(workspaceDir) {
    return [...sessions.values()]
        .filter((state) => !workspaceDir || !state.workspaceDir || state.workspaceDir === workspaceDir)
        .map((state) => ({
        ...state,
        toolReadsByFile: { ...state.toolReadsByFile },
        gfiBySource: state.gfiBySource ? { ...state.gfiBySource } : undefined,
        injectedProbationIds: state.injectedProbationIds ? [...state.injectedProbationIds] : undefined,
    }));
}
export function clearSession(sessionId) {
    const timer = persistTimers.get(sessionId);
    if (timer) {
        clearTimeout(timer);
        persistTimers.delete(sessionId);
    }
    sessions.delete(sessionId);
}
// Memory cleanup for abandoned sessions (older than 2 hours)
export function garbageCollectSessions() {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, state] of sessions.entries()) {
        if (state.lastActivityAt < twoHoursAgo) {
            const timer = persistTimers.get(id);
            if (timer) {
                clearTimeout(timer);
                persistTimers.delete(id);
            }
            sessions.delete(id);
            // Also delete persisted file
            if (persistDir) {
                const sessionPath = getSessionPath(id);
                if (sessionPath && fs.existsSync(sessionPath)) {
                    try {
                        fs.unlinkSync(sessionPath);
                    }
                    catch (error) {
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
export function getDailySummary(sessionId) {
    const state = sessions.get(sessionId);
    if (!state)
        return null;
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
export function resetDailyStats(sessionId) {
    const state = sessions.get(sessionId);
    if (state) {
        state.dailyToolCalls = 0;
        state.dailyToolFailures = 0;
        state.dailyPainSignals = 0;
        state.dailyGfiPeak = 0;
        schedulePersistence(state);
    }
}
