/**
 * SessionTracker — Session lifecycle wrapper for evolution-worker
 *
 * Thin wrapper around the existing session-tracker.ts module-level functions.
 * Encapsulates lifecycle (initPersistence/flushAllSessions) into a class
 * with constructor/init/flush methods, enabling proper lifecycle management
 * and testability consistent with Phase 24/25/26 extraction patterns.
 *
 * CONTRACT-03: Permissive validation at entry points.
 * - Constructor: workspaceDir must be a non-empty string
 * - init(): stateDir must be a non-empty string
 * - Tracking methods delegate to module functions (which handle their own validation)
 */

import type { SessionState, TokenUsage } from '../core/session-tracker.js';
import {
    initPersistence,
    flushAllSessions,
    trackToolRead as moduleTrackToolRead,
    trackLlmOutput as moduleTrackLlmOutput,
    trackFriction as moduleTrackFriction,
    resetFriction as moduleResetFriction,
    getSession as moduleGetSession,
    listSessions as moduleListSessions,
    clearSession as moduleClearSession,
} from '../core/session-tracker.js';

export type { SessionState, TokenUsage };

export class SessionTracker {
    private readonly workspaceDir: string;

    /**
     * @param workspaceDir - Must be a non-empty string (CONTRACT-03 permissive validation)
     * @throws Error if workspaceDir is not a non-empty string
     */
    constructor(workspaceDir: string) {
        if (!workspaceDir || typeof workspaceDir !== 'string' || workspaceDir.trim().length === 0) {
            throw new Error('SessionTracker: workspaceDir must be a non-empty string');
        }
        this.workspaceDir = workspaceDir;
    }

    /**
     * Initialize session persistence. Call once at worker start.
     * @param stateDir - Must be a non-empty string (CONTRACT-03 permissive validation)
     * @throws Error if stateDir is not a non-empty string
     */
    init(stateDir: string): void {
        if (!stateDir || typeof stateDir !== 'string' || stateDir.trim().length === 0) {
            throw new Error('SessionTracker.init: stateDir must be a non-empty string');
        }
        initPersistence(stateDir);
    }

    /**
     * Flush all sessions to disk. Call at end of each runCycle and at worker stop.
     */
    flush(): void {
        flushAllSessions();
    }

    trackToolRead(sessionId: string, filePath: string, workspaceDir?: string): SessionState {
        return moduleTrackToolRead(sessionId, filePath, workspaceDir ?? this.workspaceDir);
    }

    trackLlmOutput(
        sessionId: string,
        usage: TokenUsage | undefined,
        workspaceDir?: string,
        sessionKey?: string,
        trigger?: string
    ): SessionState {
        return moduleTrackLlmOutput(sessionId, usage, undefined, workspaceDir ?? this.workspaceDir, sessionKey, trigger);
    }

    trackFriction(sessionId: string, deltaF: number, hash: string, workspaceDir?: string, options?: { source?: string }): SessionState {
        return moduleTrackFriction(sessionId, deltaF, hash, workspaceDir ?? this.workspaceDir, options);
    }

    resetFriction(sessionId: string, workspaceDir?: string, options?: { source?: string; amount?: number }): SessionState {
        return moduleResetFriction(sessionId, workspaceDir ?? this.workspaceDir, options);
    }

    getSession(sessionId: string): SessionState | undefined {
        return moduleGetSession(sessionId);
    }

    listSessions(workspaceDir?: string): SessionState[] {
        return moduleListSessions(workspaceDir ?? this.workspaceDir);
    }

    clearSession(sessionId: string): void {
        moduleClearSession(sessionId);
    }
}
