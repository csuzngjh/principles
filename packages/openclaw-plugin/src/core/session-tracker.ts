 
import * as path from 'path';
import * as fs from 'fs';
import { atomicWriteFileSync } from '../utils/io.js';
import type { PainConfig } from './config.js';
import { SystemLogger } from './system-logger.js';
import { TWO_HOURS_MS } from '../config/defaults/runtime.js';
import {
  applyFriction as coreApplyFriction,
  applyDecay as coreApplyDecay,
  applyRelief as coreApplyRelief,
  classifyGfiStage,
  DEFAULT_GFI_POLICY,
} from '@principles/core/runtime-v2';
import type { GfiState, GfiEvent, GfiSource } from '@principles/core/runtime-v2';

export interface TokenUsage {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
}

// ── GFI Core Kernel Adapter ──────────────────────────────────────────────────

/** Convert SessionState GFI fields to GfiState for core kernel */
function toGfiState(state: SessionState): GfiState {
  return {
    currentGfi: state.currentGfi ?? 0,
    gfiBySource: (state.gfiBySource ?? {}) as Partial<Record<GfiSource, number>>,
    lastErrorHash: state.lastErrorHash === '' ? undefined : state.lastErrorHash,
    lastErrorSource: state.lastErrorSource || undefined,
    consecutiveErrors: state.consecutiveErrors ?? 0,
    lastGfiDecayAt: state.lastGfiDecayAt,
    dailyGfiPeak: state.dailyGfiPeak,
  };
}

/** Apply GfiState result back onto SessionState */
function applyGfiResult(state: SessionState, result: GfiState): void {
  state.currentGfi = result.currentGfi;
  state.gfiBySource = { ...result.gfiBySource } as Record<string, number>;
  state.lastErrorHash = result.lastErrorHash ?? '';
  state.lastErrorSource = result.lastErrorSource ?? '';
  state.consecutiveErrors = result.consecutiveErrors;
  state.lastGfiDecayAt = result.lastGfiDecayAt;
  state.dailyGfiPeak = result.dailyGfiPeak ?? state.dailyGfiPeak;
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
        const twoHoursAgo = now - TWO_HOURS_MS;
        
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
        atomicWriteFileSync(sessionPath, JSON.stringify(state, null, 2));
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
    timer.unref(); // Don't keep process alive for persistence
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
 * Delegates to core GFI kernel for scoring.
 */
export function trackFriction(
    sessionId: string,
    deltaF: number,
    hash: string,
    workspaceDir?: string,
    options?: { source?: string }
): SessionState {
    const state = getOrCreateSession(sessionId, workspaceDir);

    const source: GfiSource = (options?.source as GfiSource) ?? 'unknown';
    const event: GfiEvent = {
        source,
        baseScore: deltaF,
        hash: hash || undefined,
    };

    const coreState = toGfiState(state);
    const nextCore = coreApplyFriction(coreState, event, DEFAULT_GFI_POLICY);

    // Preserve composite source key for unattributed sources
    if (!options?.source && hash) {
        const val = nextCore.gfiBySource['unknown'];
        if (val !== undefined) {
            const s = nextCore.gfiBySource as Record<string, number>;
            delete s['unknown'];
            const key = `unattributed:${hash}`;
            s[key] = (s[key] ?? 0) + val;
        }
    }

    applyGfiResult(state, nextCore);

    touchActivity(state, 'control');

    // Update daily stats
    state.dailyToolFailures++;
    state.dailyGfiPeak = Math.max(state.dailyGfiPeak, state.currentGfi);

    // Schedule persistence
    state.lastGfiDecayAt = Date.now();
    schedulePersistence(state);

    return state;
}

/**
 * Resets the friction index upon successful action.
 * Delegates to core GFI kernel for relief computation.
 */
export function resetFriction(
    sessionId: string,
    workspaceDir?: string,
    options?: { source?: string; amount?: number }
): SessionState {
    const state = getOrCreateSession(sessionId, workspaceDir);

    if (options?.source) {
        const coreState = toGfiState(state);
        const nextCore = coreApplyRelief(coreState, { source: options.source, amount: options.amount ?? 0 }, Date.now(), DEFAULT_GFI_POLICY);
        applyGfiResult(state, nextCore);

        if (state.currentGfi > 0) {
            SystemLogger.log(
                state.workspaceDir,
                'GFI_SLICE_RESET',
                `Friction slice reset for ${options.source}: remaining GFI=${state.currentGfi.toFixed(1)}`
            );
        }
        touchActivity(state, 'control');
        schedulePersistence(state);
        return state;
    }

    // Full reset via core kernel
    const previousGfi = state.currentGfi;
    const coreState = toGfiState(state);
    const nextCore = coreApplyRelief(coreState, { source: 'all', amount: 100 }, Date.now(), DEFAULT_GFI_POLICY);
    applyGfiResult(state, nextCore);

    if (previousGfi > 0) {
        SystemLogger.log(state.workspaceDir, 'GFI_RESET', `Friction reset to 0 (Was: ${previousGfi.toFixed(1)}). Action successful.`);
    }
    touchActivity(state, 'control');

    schedulePersistence(state);
    return state;
}

// Thinking checkpoint retirement (2026-08-19, Wave 4): recordThinkingCheckpoint /
// hasRecentThinking / SessionState.lastThinkingTimestamp were removed. The only
// consumer (RuleHostInput.session.recentThinking and rule-real-diagnosis-first
// v1's regex-proxy fallback) was migrated to RuleContextV2 history evidence.
// Old persisted session JSON files may still carry a lastThinkingTimestamp
// field; the loader tolerates extra fields, so no destructive migration.

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
 * Apply time-based decay to GFI using stage-aware linear decay.
 * Delegates to core GFI kernel.
 *
 * @param sessionId - The session to decay
 * @param elapsedMinutes - Minutes since last decay
 * @returns Updated session state, or undefined if session not found or GFI is 0
 */
export function decayGfi(sessionId: string, elapsedMinutes: number): SessionState | undefined {
    const state = sessions.get(sessionId);
    if (!state || state.currentGfi <= 0 || elapsedMinutes <= 0) return undefined;

    const coreState = toGfiState(state);
    const stage = classifyGfiStage(state.currentGfi, DEFAULT_GFI_POLICY);
    const nextCore = coreApplyDecay(coreState, elapsedMinutes, DEFAULT_GFI_POLICY, stage, Date.now());
    const previousGfi = state.currentGfi;
    applyGfiResult(state, nextCore);

    // Log if significant decay
    const decayedAmount = previousGfi - state.currentGfi;
    if (decayedAmount >= 1) {
      SystemLogger.log(
        state.workspaceDir,
        'GFI_DECAY',
        `GFI decayed by ${decayedAmount.toFixed(1)} (${elapsedMinutes}min). ${previousGfi.toFixed(1)} → ${state.currentGfi.toFixed(1)}`
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
