/**
 * Nocturnal Runtime Service — Idle Detection Source of Truth
 * ===========================================================
 *
 * This module is the authoritative source for workspace idle state used by the
 * nocturnal reflection pipeline. It must NOT use `.last_active.json` as the primary
 * source of truth.
 *
 * SOURCE OF TRUTH HIERARCHY (ordered by priority):
 *  1. SessionState.lastActivityAt  — via listSessions(workspaceDir)
 *  2. trajectory timestamps        — secondary guardrail only, NOT primary
 *  3. nocturnal-runtime.json       — cooldown/quota bookkeeping (ephemeral state)
 *
 * DESIGN CONSTRAINTS:
 * - No `.last_active.json` as primary idle source
 * - trajectory timestamps are a guardrail, not the primary source
 * - cooldown/quota state is persisted in nocturnal-runtime.json
 * - abandoned sessions (>2h inactive) must not block nocturnal flow
 */

import * as fs from 'fs';
import * as path from 'path';
import { listSessions } from '../core/session-tracker.js';
import { withLockAsync } from '../utils/file-lock.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** File name for nocturnal runtime bookkeeping */
export const NOCTURNAL_RUNTIME_FILE = 'nocturnal-runtime.json';

/** Default idle threshold: workspace is considered idle if no activity for this duration (ms) */
export const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/** Default cooldown between nocturnal runs (ms) */
export const DEFAULT_GLOBAL_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/** Default per-principle cooldown (ms) */
export const DEFAULT_PRINCIPLE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Default maximum nocturnal runs per quota window */
export const DEFAULT_MAX_RUNS_PER_WINDOW = 3;

/** Default quota window size (ms) */
export const DEFAULT_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Abandoned session threshold: sessions inactive for longer than this are ignored (ms) */
export const DEFAULT_ABANDONED_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Persisted state for nocturnal runtime bookkeeping.
 * Stored in {stateDir}/nocturnal-runtime.json
 */
export interface NocturnalRuntimeState {
    /** Last time a nocturnal run was started (ISO string) */
    lastRunAt?: string;

    /** Last time a nocturnal run completed successfully */
    lastSuccessfulRunAt?: string;

    /** Cooldown end time for global cooldown (ISO string) */
    globalCooldownUntil?: string;

    /**
     * Per-principle cooldown map.
     * Key: principleId, Value: ISO string of cooldown end time
     */
    principleCooldowns: Record<string, string>;

    /**
     * Sliding window of recent run timestamps.
     * Used for quota enforcement.
     */
    recentRunTimestamps: string[];

    /** Metadata about last run (for debugging) */
    lastRunMeta?: {
        targetPrincipleId?: string;
        sampleCount?: number;
        status: 'success' | 'failed' | 'skipped';
        reason?: string;
    };
}

/** Result of an idle check */
export interface IdleCheckResult {
    /** Whether the workspace is currently idle */
    isIdle: boolean;
    /** Most recent activity timestamp across all sessions (epoch ms) */
    mostRecentActivityAt: number;
    /** How long since the last activity (ms) */
    idleForMs: number;
    /** Number of active (non-abandoned) sessions found */
    activeSessionCount: number;
    /** List of abandoned session IDs (inactive > abandoned threshold) */
    abandonedSessionIds: string[];
    /** Whether trajectory guardrail also confirms idle */
    trajectoryGuardrailConfirmsIdle: boolean;
    /** Reason for the idle determination */
    reason: string;
}

/** Result of a cooldown check */
export interface CooldownCheckResult {
    /** Whether the global cooldown is currently active */
    globalCooldownActive: boolean;
    /** When the global cooldown ends (ISO string), null if not in cooldown */
    globalCooldownUntil: string | null;
    /** Remaining ms until global cooldown expires */
    globalCooldownRemainingMs: number;
    /** Whether the principle-specific cooldown is active */
    principleCooldownActive: boolean;
    /** When the principle cooldown ends (ISO string), null if not in cooldown */
    principleCooldownUntil: string | null;
    /** Remaining ms until principle cooldown expires */
    principleCooldownRemainingMs: number;
    /** Whether the quota has been exhausted */
    quotaExhausted: boolean;
    /** Number of runs remaining in current window */
    runsRemaining: number;
}

// ---------------------------------------------------------------------------
// Default State
// ---------------------------------------------------------------------------

function createDefaultState(): NocturnalRuntimeState {
    return {
        principleCooldowns: {},
        recentRunTimestamps: [],
    };
}

// ---------------------------------------------------------------------------
// File Operations (with locking)
// ---------------------------------------------------------------------------

async function readState(stateDir: string): Promise<NocturnalRuntimeState> {
    const filePath = path.join(stateDir, NOCTURNAL_RUNTIME_FILE);
    if (!fs.existsSync(filePath)) {
        return createDefaultState();
    }
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as NocturnalRuntimeState;
        // Ensure required fields exist (migration-safe)
        return {
            principleCooldowns: parsed.principleCooldowns ?? {},
            recentRunTimestamps: parsed.recentRunTimestamps ?? [],
            lastRunAt: parsed.lastRunAt,
            lastSuccessfulRunAt: parsed.lastSuccessfulRunAt,
            globalCooldownUntil: parsed.globalCooldownUntil,
            lastRunMeta: parsed.lastRunMeta,
        };
    } catch {
        // Corrupted file — start fresh
        return createDefaultState();
    }
}

function readStateSync(stateDir: string): NocturnalRuntimeState {
    const filePath = path.join(stateDir, NOCTURNAL_RUNTIME_FILE);
    if (!fs.existsSync(filePath)) {
        return createDefaultState();
    }
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as NocturnalRuntimeState;
        return {
            principleCooldowns: parsed.principleCooldowns ?? {},
            recentRunTimestamps: parsed.recentRunTimestamps ?? [],
            lastRunAt: parsed.lastRunAt,
            lastSuccessfulRunAt: parsed.lastSuccessfulRunAt,
            globalCooldownUntil: parsed.globalCooldownUntil,
            lastRunMeta: parsed.lastRunMeta,
        };
    } catch (err) {
        console.warn(`[nocturnal-runtime] State file corrupted, resetting: ${err instanceof Error ? err.message : String(err)}`);
        return createDefaultState();
    }
}

async function writeState(stateDir: string, state: NocturnalRuntimeState): Promise<void> {
    const filePath = path.join(stateDir, NOCTURNAL_RUNTIME_FILE);
    const stateDirPath = path.dirname(filePath);
    if (!fs.existsSync(stateDirPath)) {
        fs.mkdirSync(stateDirPath, { recursive: true });
    }
    await withLockAsync(filePath, async () => {
        fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
    });
}

// ---------------------------------------------------------------------------
// Idle Detection
// ---------------------------------------------------------------------------

/**
 * Check if the workspace is currently idle based on session activity.
 *
 * IDLE DETERMINATION LOGIC:
 * - Collect all sessions for the workspace via listSessions()
 * - Filter out abandoned sessions (inactive > abandonedThresholdMs)
 * - Workspace is idle if: no active sessions OR all active sessions have lastActivityAt older than idleThresholdMs
 * - Abandoned sessions do NOT contribute to idle determination
 *
 * @param workspaceDir - Workspace directory to check
 * @param options.idleThresholdMs - Consider idle if no activity for this duration (default: 30 min)
 * @param options.abandonedThresholdMs - Consider session abandoned if inactive for this duration (default: 2 hr)
 * @param trajectoryLastActivityAt - Optional trajectory timestamp as secondary guardrail
 * @returns IdleCheckResult with full diagnostic information
 */
export function checkWorkspaceIdle(
    workspaceDir: string,
    options: {
        idleThresholdMs?: number;
        abandonedThresholdMs?: number;
    } = {},
    trajectoryLastActivityAt?: number
): IdleCheckResult {
    const {
        idleThresholdMs = DEFAULT_IDLE_THRESHOLD_MS,
        abandonedThresholdMs = DEFAULT_ABANDONED_THRESHOLD_MS,
    } = options;

    const now = Date.now();
    const sessions = listSessions(workspaceDir);

    // Separate active vs abandoned sessions
    const abandonedSessions: string[] = [];
    let mostRecentActivityAt = 0;
    let activeSessionCount = 0;

    for (const session of sessions) {
        const inactiveFor = now - session.lastActivityAt;
        if (inactiveFor > abandonedThresholdMs) {
            abandonedSessions.push(session.sessionId);
        } else {
            activeSessionCount++;
            if (session.lastActivityAt > mostRecentActivityAt) {
                mostRecentActivityAt = session.lastActivityAt;
            }
        }
    }

    const idleForMs = mostRecentActivityAt > 0 ? now - mostRecentActivityAt : now;
    const isIdle = mostRecentActivityAt === 0 || idleForMs > idleThresholdMs;

    // Trajectory guardrail: only used as a secondary check
    // If trajectory says there's recent activity but session state says idle,
    // that's a discrepancy we should note but still trust session state as primary
    let trajectoryGuardrailConfirmsIdle = true;
    if (trajectoryLastActivityAt !== undefined) {
        const trajectoryIdleFor = now - trajectoryLastActivityAt;
        // Guardrail confirms if trajectory also shows idle or near-idle (>80% of threshold)
        trajectoryGuardrailConfirmsIdle = trajectoryIdleFor > idleThresholdMs * 0.8;
    }

    let reason: string;
    if (mostRecentActivityAt === 0) {
        reason = 'No active sessions found — workspace is idle';
    } else if (isIdle) {
        reason = `Most recent activity ${idleForMs}ms ago (>${idleThresholdMs}ms threshold)`;
    } else {
        reason = `Recent activity ${idleForMs}ms ago (<${idleThresholdMs}ms threshold)`;
    }

    if (abandonedSessions.length > 0) {
        reason += `; ${abandonedSessions.length} abandoned session(s) ignored`;
    }

    return {
        isIdle,
        mostRecentActivityAt,
        idleForMs,
        activeSessionCount,
        abandonedSessionIds: abandonedSessions,
        trajectoryGuardrailConfirmsIdle,
        reason,
    };
}

// ---------------------------------------------------------------------------
// Cooldown Management
// ---------------------------------------------------------------------------

/**
 * Check if the workspace is currently in a cooldown period.
 *
 * @param stateDir - State directory
 * @param principleId - Optional principle ID to check per-principle cooldown
 * @param options - Cooldown configuration options
 * @returns CooldownCheckResult
 */
export function checkCooldown(
    stateDir: string,
    principleId?: string,
    options: {
        globalCooldownMs?: number;
        principleCooldownMs?: number;
        maxRunsPerWindow?: number;
        quotaWindowMs?: number;
    } = {}
): CooldownCheckResult {
    const {
        globalCooldownMs = DEFAULT_GLOBAL_COOLDOWN_MS,
        principleCooldownMs = DEFAULT_PRINCIPLE_COOLDOWN_MS,
        maxRunsPerWindow = DEFAULT_MAX_RUNS_PER_WINDOW,
        quotaWindowMs = DEFAULT_QUOTA_WINDOW_MS,
    } = options;

    const now = Date.now();
    const state = readStateSync(stateDir);

    // Global cooldown check
    let globalCooldownActive = false;
    let globalCooldownRemainingMs = 0;
    let globalCooldownUntil: string | null = null;

    if (state.globalCooldownUntil) {
        const cooldownEnd = new Date(state.globalCooldownUntil).getTime();
        if (cooldownEnd > now) {
            globalCooldownActive = true;
            globalCooldownRemainingMs = cooldownEnd - now;
            globalCooldownUntil = state.globalCooldownUntil;
        }
    }

    // Principle-specific cooldown check
    let principleCooldownActive = false;
    let principleCooldownRemainingMs = 0;
    let principleCooldownUntil: string | null = null;

    if (principleId && state.principleCooldowns[principleId]) {
        const cooldownEnd = new Date(state.principleCooldowns[principleId]).getTime();
        if (cooldownEnd > now) {
            principleCooldownActive = true;
            principleCooldownRemainingMs = cooldownEnd - now;
            principleCooldownUntil = state.principleCooldowns[principleId];
        }
    }

    // Quota check: count runs in sliding window
    const windowStart = now - quotaWindowMs;
    const recentRuns = state.recentRunTimestamps
        .map(ts => new Date(ts).getTime())
        .filter(ts => ts > windowStart);

    const quotaExhausted = recentRuns.length >= maxRunsPerWindow;
    const runsRemaining = Math.max(0, maxRunsPerWindow - recentRuns.length);

    return {
        globalCooldownActive,
        globalCooldownUntil,
        globalCooldownRemainingMs,
        principleCooldownActive,
        principleCooldownUntil,
        principleCooldownRemainingMs,
        quotaExhausted,
        runsRemaining,
    };
}

/**
 * Record that a nocturnal run has started.
 * Updates global cooldown and quota tracking.
 *
 * @param stateDir - State directory
 * @param principleId - Target principle ID for this run
 */
export async function recordRunStart(
    stateDir: string,
    principleId: string
): Promise<void> {
    const state = await readState(stateDir);
    const now = new Date().toISOString();

    state.lastRunAt = now;
    state.lastRunMeta = {
        targetPrincipleId: principleId,
        status: 'skipped', // Will be updated on completion
    };

    // Set global cooldown
    const cooldownUntil = new Date(Date.now() + DEFAULT_GLOBAL_COOLDOWN_MS).toISOString();
    state.globalCooldownUntil = cooldownUntil;

    // Add to recent runs for quota tracking
    state.recentRunTimestamps.push(now);

    // Prune old timestamps outside the quota window
    const windowStart = Date.now() - DEFAULT_QUOTA_WINDOW_MS;
    state.recentRunTimestamps = state.recentRunTimestamps
        .map(ts => new Date(ts).getTime())
        .filter(ts => ts > windowStart)
        .map(ts => new Date(ts).toISOString());

    await writeState(stateDir, state);
}

/**
 * Record the outcome of a nocturnal run.
 *
 * @param stateDir - State directory
 * @param outcome - 'success', 'failed', or 'skipped'
 * @param details - Optional details about the run
 */
export async function recordRunEnd(
    stateDir: string,
    outcome: 'success' | 'failed' | 'skipped',
    details?: {
        sampleCount?: number;
        reason?: string;
    }
): Promise<void> {
    const state = await readState(stateDir);
    const now = new Date().toISOString();

    if (outcome === 'success') {
        state.lastSuccessfulRunAt = now;

        // Also set per-principle cooldown if we know which principle was targeted
        if (state.lastRunMeta?.targetPrincipleId) {
            const pid = state.lastRunMeta.targetPrincipleId;
            state.principleCooldowns[pid] = new Date(
                Date.now() + DEFAULT_PRINCIPLE_COOLDOWN_MS
            ).toISOString();
        }
    }

    // Update run metadata
    state.lastRunMeta = {
        ...state.lastRunMeta,
        status: outcome,
        sampleCount: details?.sampleCount ?? state.lastRunMeta?.sampleCount,
        reason: details?.reason ?? state.lastRunMeta?.reason,
    };

    // Note: global cooldown remains active (set at run start) - we don't clear it on failure
    // This prevents rapid retry loops

    await writeState(stateDir, state);
}

/**
 * Clear all cooldowns (for testing or admin reset).
 *
 * @param stateDir - State directory
 */
export async function clearAllCooldowns(stateDir: string): Promise<void> {
    const state = await readState(stateDir);
    state.globalCooldownUntil = undefined;
    state.principleCooldowns = {};
    state.recentRunTimestamps = [];
    state.lastRunMeta = undefined;
    await writeState(stateDir, state);
}

/**
 * Get the current runtime state (for debugging/inspection).
 *
 * @param stateDir - State directory
 * @returns The current NocturnalRuntimeState
 */
export async function getRuntimeState(stateDir: string): Promise<NocturnalRuntimeState> {
    return readState(stateDir);
}

// ---------------------------------------------------------------------------
// Convenience: Full Pre-Flight Check
// ---------------------------------------------------------------------------

export interface PreflightCheckResult {
    canRun: boolean;
    idle: IdleCheckResult;
    cooldown: CooldownCheckResult;
    /**
     * Human-readable reasons why run is blocked (if canRun is false)
     */
    blockers: string[];
}

/**
 * Combined pre-flight check for whether a nocturnal run should proceed.
 * Integrates idle + cooldown + quota checks.
 *
 * @param workspaceDir - Workspace directory
 * @param stateDir - State directory
 * @param principleId - Target principle ID
 * @param trajectoryLastActivityAt - Optional trajectory timestamp as secondary guardrail
 * @param idleCheckOverride - Optional override for idle check result (for testing)
 */
export function checkPreflight(
    workspaceDir: string,
    stateDir: string,
    principleId?: string,
    trajectoryLastActivityAt?: number,
    idleCheckOverride?: IdleCheckResult
): PreflightCheckResult {
    const idle = idleCheckOverride ?? checkWorkspaceIdle(workspaceDir, {}, trajectoryLastActivityAt);
    const cooldown = checkCooldown(stateDir, principleId);

    const blockers: string[] = [];

    if (!idle.isIdle) {
        blockers.push(`Workspace not idle (active for ${idle.idleForMs}ms, threshold=${DEFAULT_IDLE_THRESHOLD_MS}ms)`);
    }

    if (cooldown.globalCooldownActive) {
        blockers.push(`Global cooldown active until ${cooldown.globalCooldownUntil}`);
    }

    if (cooldown.principleCooldownActive) {
        blockers.push(`Principle cooldown active until ${cooldown.principleCooldownUntil}`);
    }

    if (cooldown.quotaExhausted) {
        blockers.push(`Quota exhausted (${DEFAULT_MAX_RUNS_PER_WINDOW} runs per ${DEFAULT_QUOTA_WINDOW_MS / 3600000}h window)`);
    }

    if (idle.abandonedSessionIds.length > 0 && idle.activeSessionCount === 0) {
        // Only block if ALL sessions are abandoned (meaning workspace truly has no activity)
        // If some sessions are active, we trust the session-based idle check
    }

    return {
        canRun: blockers.length === 0,
        idle,
        cooldown,
        blockers,
    };
}
