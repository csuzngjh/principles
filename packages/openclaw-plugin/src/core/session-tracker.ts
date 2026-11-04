 
import * as path from 'path';
import * as fs from 'fs';
import { atomicWriteFileSync } from '../utils/io.js';
import { SystemLogger } from './system-logger.js';
import { TWO_HOURS_MS } from '../config/defaults/runtime.js';
import type { PainConfig } from './config.js';

export interface TokenUsage {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
}

// GFI kernel adapter removed with GFI-COMPLETE-REMOVAL-001 (2026-11-04).

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
    

    // PRI-534: per-session receipt summary surfaced by /pd-context status.
    injectedPrincipleIds?: string[];
    // PRI-899: activation id per entry of injectedPrincipleIds (same index).
    // Index-aligned with the array above, exactly like the presence-receipt
    // pairing at prompt build (alignActivationIds / recordInjectionPresence).
    injectedActivationIds?: string[];
    receiptAutoCorrects?: number;
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
            injectedPrincipleIds: [],
            receiptAutoCorrects: 0,
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
 * Mark control activity (manual/rollback actions and successful tool outcomes)
 * so the control plane can observe freshness without a friction score.
 */
export function trackSessionControlActivity(sessionId: string, workspaceDir?: string): SessionState {
    const state = getOrCreateSession(sessionId, workspaceDir);
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


/**
 * PRI-534: record the principle ids injected into this session's prompt context.
 * PRI-755 (review fix): call this on EVERY prompt build with the CURRENT set —
 * including an empty one. An empty array is a known-empty round and overwrites
 * a stale non-empty set from an earlier turn; the self-report capture validates
 * against this set, so keeping a stale set would re-admit markers for
 * principles no longer injected.
 */
export function setInjectedPrincipleIds(
    sessionId: string | undefined,
    ids: readonly string[],
    workspaceDir?: string,
    /**
     * PRI-899: the activation id paired with each entry of `ids` (same index,
     * the array the presence-receipt writer already consumed). Optional and
     * append-only so every existing caller keeps working unchanged — a caller
     * that omits it stores an empty pairing rather than a stale one.
     */
    activationIds?: readonly string[],
): void {
    if (!sessionId) return;
    const state = getOrCreateSession(sessionId, workspaceDir);
    state.injectedPrincipleIds = [...ids];
    state.injectedActivationIds = activationIds ? [...activationIds] : [];
    touchActivity(state, 'control');
    schedulePersistence(state);
}

/** PRI-534: count one applied live auto-correction in this session. */
export function trackReceiptAutoCorrect(sessionId: string | undefined, workspaceDir?: string): void {
    if (!sessionId) return;
    const state = getOrCreateSession(sessionId, workspaceDir);
    state.receiptAutoCorrects = (state.receiptAutoCorrects ?? 0) + 1;
    touchActivity(state, 'control');
    schedulePersistence(state);
}

/**
 * PRI-755: read-only view of the principle ids injected into this session's
 * prompt context. Tri-state: an array (possibly empty) means the injection set
 * is KNOWN; undefined means UNKNOWN (session never built a prompt in this
 * process, tracker restarted, or session expired). Receipt capture may only
 * treat verified membership as evidence — unknown must not imply empty.
 */
export function getInjectedPrincipleIds(sessionId: string): readonly string[] | undefined {
    const state = getSession(sessionId);
    return state?.injectedPrincipleIds ? [...state.injectedPrincipleIds] : undefined;
}

/**
 * PRI-899: the activation id paired with each entry of the injected set, in
 * the SAME index order. Tri-state, mirroring getInjectedPrincipleIds:
 *   - undefined → the injection set is UNKNOWN for this session;
 *   - []        → the set is known but carries no activation pairing (legacy
 *                 caller, or the injection carried no activation id);
 *   - [a, b]    → index-aligned with getInjectedPrincipleIds(sessionId).
 * A consumer must never treat "no pairing" as "some other activation".
 */
export function getInjectedActivationIds(sessionId: string): readonly string[] | undefined {
    const state = getSession(sessionId);
    return state?.injectedActivationIds ? [...state.injectedActivationIds] : undefined;
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
            // PRI-899: the two paired arrays are cloned TOGETHER or not at all.
            // Pairing is by index, so handing out a live alias of one while
            // cloning the other lets a caller reorder the principle ids and
            // silently point every activation at the wrong principle.
            injectedPrincipleIds: state.injectedPrincipleIds ? [...state.injectedPrincipleIds] : undefined,
            injectedActivationIds: state.injectedActivationIds ? [...state.injectedActivationIds] : undefined,
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
