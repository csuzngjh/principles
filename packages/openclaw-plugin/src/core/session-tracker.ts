import * as path from 'path';
import * as fs from 'fs';
import type { PainConfig } from './config.js';
import { SystemLogger } from './system-logger.js';

export interface TokenUsage {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
}

export interface SessionState {
    sessionId: string;
    sessionKey?: string;   // Structured session key from OpenClaw (e.g., agent:main:cron:job-1:run:xxx)
    trigger?: string;      // Trigger source: "user" | "cron" | "heartbeat" | "memory" | "subagent"
    workspaceDir?: string;
    toolReadsByFile: Record<string, number>;
    llmTurns: number;
    blockedAttempts: number;
    lastActivityAt: number;
    lastControlActivityAt: number;
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
    lastGfiDecayAt?: number;  // Timestamp of last GFI decay (for time-based decay)
    
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

/** Debounce timers for persistence, one per session */
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

function logSessionTrackerWarning(message: string, error?: unknown): void {
    const detail = error instanceof Error ? error.message : error ? String(error) : '';
    const suffix = detail ? `: ${detail}` : '';
     
    console.warn(`[PD:SessionTracker] ${message}${suffix}`);
}

function touchActivity(state: SessionState, kind: 'general' | 'control' = 'general'): void {
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
        // Log successful persistence with GFI snapshot for debugging
        if (state.currentGfi > 0) {
            SystemLogger.log(
                state.workspaceDir,
                'GFI_PERSIST',
                `Session ${state.sessionId.slice(0, 8)} persisted: GFI=${state.currentGfi.toFixed(1)}, sources=${JSON.stringify(state.gfiBySource)}`
            );
        }
    } catch (error) {
        logSessionTrackerWarning(`Failed to persist session ${state.sessionId}`, error);
    }
}

/**
 * Schedule persistence with debounce.
 */
function schedulePersistence(state: SessionState): void {
    const existing = persistTimers.get(state.sessionId);
    if (existing) {
        clearTimeout(existing);
    }
    const timer = setTimeout(() => {
        persistSession(state);
        persistTimers.delete(state.sessionId);
    }, 1000);  // 1 second debounce
    persistTimers.set(state.sessionId, timer);
}

/**
 * Force persist all sessions immediately.
 */
export function flushAllSessions(): void {
    for (const timer of persistTimers.values()) {
        clearTimeout(timer);
    }
    persistTimers.clear();
    for (const state of sessions.values()) {
        persistSession(state);
    }
}

 
function getOrCreateSession(sessionId: string, workspaceDir?: string, sessionKey?: string, trigger?: string): SessionState {
    let state = sessions.get(sessionId);
    if (!state) {
        state = {
            sessionId,
            sessionKey,
            trigger,
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
            lastGfiDecayAt: Date.now(),
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
    // Update sessionKey and trigger if provided (they may be more recent)
    if (sessionKey && !state.sessionKey) {
        state.sessionKey = sessionKey;
    }
    if (trigger && !state.trigger) {
        state.trigger = trigger;
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
    touchActivity(state);
    return state;
}

 
export function trackLlmOutput(sessionId: string, usage: TokenUsage | undefined, config?: PainConfig, workspaceDir?: string, sessionKey?: string, trigger?: string): SessionState {
    const state = getOrCreateSession(sessionId, workspaceDir, sessionKey, trigger);
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
export function recordThinkingCheckpoint(sessionId: string, workspaceDir?: string): SessionState {
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
export function hasRecentThinking(sessionId: string, windowMs: number = 5 * 60 * 1000): boolean {
    const state = sessions.get(sessionId);
    if (!state || !state.lastThinkingTimestamp) return false;
    return (Date.now() - state.lastThinkingTimestamp) < windowMs;
}

export function trackBlock(sessionId: string): SessionState {
    const state = getOrCreateSession(sessionId);
    state.blockedAttempts += 1;
    touchActivity(state, 'control');
    schedulePersistence(state);
    return state;
}


export function setInjectedProbationIds(sessionId: string, ids: string[], workspaceDir?: string): SessionState {
    const state = getOrCreateSession(sessionId, workspaceDir);
    state.injectedProbationIds = [...ids];
    touchActivity(state, 'control');
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
    const timer = persistTimers.get(sessionId);
    if (timer) {
        clearTimeout(timer);
        persistTimers.delete(sessionId);
    }
    sessions.delete(sessionId);
}

/**
 * Seed a session directly into SessionTracker.sessions for testing.
 * This bypasses the normal tool-call flow to set up test data for
 * checkWorkspaceIdle without requiring full integration test setup.
 *
 * @param sessionId - Session ID
 * @param workspaceDir - Workspace directory (optional, for filtering)
 * @param lastActivityAt - Unix timestamp in ms (default: now)
 */
export function seedSessionForTest(sessionId: string, workspaceDir?: string, lastActivityAt?: number): void {
    const state = getOrCreateSession(sessionId, workspaceDir);
    state.lastActivityAt = lastActivityAt ?? Date.now();
    state.lastControlActivityAt = state.lastActivityAt;
}

// Memory cleanup for abandoned sessions (older than 2 hours)
export function garbageCollectSessions(): void {
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

/**
 * Apply time-based decay to GFI using segmented exponential decay.
 * 
 * Decay rates:
 * - GFI >= 70 (severe): 3%/min - fast recovery to avoid prolonged blocking
 * - GFI 40-70 (moderate): 2%/min - medium decay
 * - GFI < 40 (mild): 1%/min - slow decay to retain as warning
 * 
 * Formula: GFI_new = GFI * (1 - λ)^elapsedMinutes
 * 
 * @param sessionId - The session to decay
 * @param elapsedMinutes - Minutes since last decay
 * @returns Updated session state, or undefined if session not found or GFI is 0
 */
export function decayGfi(sessionId: string, elapsedMinutes: number): SessionState | undefined {
    const state = sessions.get(sessionId);
    if (!state || state.currentGfi <= 0 || elapsedMinutes <= 0) return undefined;
    
    // Determine decay rate based on current GFI level (segmented)
    let decayRate: number;
    if (state.currentGfi >= 70) {
      decayRate = 0.03;  // 3%/min for severe friction
    } else if (state.currentGfi >= 40) {
      decayRate = 0.02;  // 2%/min for moderate friction
    } else {
      decayRate = 0.01;  // 1%/min for mild friction
    }
    
    // Exponential decay: GFI_new = GFI * (1-λ)^Δt
    const decayFactor = Math.pow(1 - decayRate, elapsedMinutes);
    const previousGfi = state.currentGfi;
    state.currentGfi = Math.max(0, state.currentGfi * decayFactor);
    
    // Apply same decay factor to all sources
    const ledger = ensureGfiLedger(state);
    for (const source of Object.keys(ledger)) {
      ledger[source] = Math.max(0, ledger[source] * decayFactor);
      // Remove sources that have decayed below 0.1
      if (ledger[source] < 0.1) {
        delete ledger[source];
      }
    }
    
    // Round to 1 decimal place
    state.currentGfi = Math.round(state.currentGfi * 10) / 10;
    
    // Update last decay timestamp
    state.lastGfiDecayAt = Date.now();
    
    // Log if significant decay
    const decayedAmount = previousGfi - state.currentGfi;
    if (decayedAmount >= 1) {
      SystemLogger.log(
        state.workspaceDir,
        'GFI_DECAY',
        `GFI decayed by ${decayedAmount.toFixed(1)} (${elapsedMinutes}min at ${decayRate*100}%/min). ${previousGfi.toFixed(1)} → ${state.currentGfi.toFixed(1)}`
      );
    }
    
    schedulePersistence(state);
    return state;
}

/**
 * Check if GFI decay should be applied and return elapsed minutes since last decay.
 * @param sessionId - The session to check
 * @returns Elapsed minutes since last decay, or 0 if no decay needed
 */
export function getGfiDecayElapsed(sessionId: string): number {
  const state = sessions.get(sessionId);
  if (!state || state.currentGfi <= 0) return 0;
  
  const now = Date.now();
  const lastDecay = state.lastGfiDecayAt || state.lastControlActivityAt || state.lastActivityAt || now;
  const elapsedMs = now - lastDecay;
  
  // Return elapsed minutes (floor to whole minutes)
  return Math.floor(elapsedMs / 60000);
}
