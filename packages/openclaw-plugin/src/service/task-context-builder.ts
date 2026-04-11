/**
 * TaskContextBuilder — Context extraction for evolution cycle execution
 *
 * Extracts all context building logic from evolution-worker.ts into a dedicated
 * class with validated entry points and fail-visible event emission.
 *
 * Design decisions:
 * - D-01: Class instantiated with workspaceDir
 * - D-02: Permissive validation (CONTRACT-03) — required fields only, returns error result
 * - D-03: FB-04 and FB-05 are FAIL-VISIBLE — emit recordSkip() events, pipeline continues
 */

import type { PluginLogger } from '../utils/plugin-logger.js';
import type { WorkspaceContext } from '../core/workspace-context.js';
import { checkWorkspaceIdle, checkCooldown } from './nocturnal-runtime.js';
import type { IdleCheckResult } from './nocturnal-runtime.js';
import type { CooldownCheckResult } from './nocturnal-runtime.js';
import { PainFlagDetector } from './pain-flag-detector.js';
import type { RecentPainContext } from './evolution-queue-store.js';
import type { EvolutionQueueItem } from './evolution-queue-store.js';
import type { NocturnalSessionSnapshot, NocturnalPainEvent } from '../core/nocturnal-trajectory-extractor.js';
import { listSessions } from '../core/session-tracker.js';
import type { SessionState } from '../core/session-tracker.js';
import type { EventLog } from '../core/event-log.js';

// ── Result Types ───────────────────────────────────────────────────────────────

export interface CycleContextResult {
  idle: IdleCheckResult;
  cooldown: CooldownCheckResult;
  recentPain: RecentPainContext;
  activeSessions: SessionState[];
  errors: string[];
}

// ── TaskContextBuilder ────────────────────────────────────────────────────────

export class TaskContextBuilder {
  constructor(private readonly workspaceDir: string) {}

  /**
   * Build cycle context for a single runCycle execution.
   *
   * Permissive validation (CONTRACT-03): wctx must be a non-null object.
   * Returns error result on validation failure — never throws.
   *
   * FB-04 (checkWorkspaceIdle error): FAIL-VISIBLE — emits recordSkip(), returns default idle.
   * FB-05 (checkCooldown error): FAIL-VISIBLE — emits recordSkip(), returns default cooldown.
   */
  async buildCycleContext(
    wctx: WorkspaceContext,
    _logger?: PluginLogger,
    eventLog?: EventLog,
  ): Promise<CycleContextResult> {
    const errors: string[] = [];

    // CONTRACT-03: Permissive validation at boundary entry
    if (!wctx || typeof wctx !== 'object') {
      errors.push('Invalid workspace context');
      return {
        idle: {
          isIdle: false,
          mostRecentActivityAt: 0,
          idleForMs: 0,
          userActiveSessions: 0,
          abandonedSessionIds: [],
          trajectoryGuardrailConfirmsIdle: false,
          reason: 'invalid_wctx',
        },
        cooldown: {
          globalCooldownActive: false,
          globalCooldownUntil: null,
          globalCooldownRemainingMs: 0,
          principleCooldownActive: false,
          principleCooldownUntil: null,
          principleCooldownRemainingMs: 0,
          quotaExhausted: false,
          runsRemaining: 0,
        },
        recentPain: { mostRecent: null, recentPainCount: 0, recentMaxPainScore: 0 },
        activeSessions: [],
        errors,
      };
    }

    // FB-04: checkWorkspaceIdle failure — FAIL-VISIBLE (CONTRACT-05)
    // Emit skip event so diagnostics can observe this degradation; pipeline continues
    let idle: IdleCheckResult;
    try {
      idle = checkWorkspaceIdle(wctx.workspaceDir, {});
    } catch (err) {
      errors.push(`checkWorkspaceIdle failed: ${String(err)}`);
      idle = {
        isIdle: false,
        mostRecentActivityAt: 0,
        idleForMs: 0,
        userActiveSessions: 0,
        abandonedSessionIds: [],
        trajectoryGuardrailConfirmsIdle: false,
        reason: 'checkWorkspaceIdle_error',
      };
      if (eventLog) {
        eventLog.recordSkip(undefined, {
          reason: 'checkWorkspaceIdle_error',
          fallback: 'default_idle_assumption',
          context: { error: String(err) },
        });
      }
    }

    // FB-05: checkCooldown failure — FAIL-VISIBLE (CONTRACT-05)
    // Emit skip event so diagnostics can observe this degradation; pipeline continues
    let cooldown: CooldownCheckResult;
    try {
      cooldown = checkCooldown(wctx.stateDir);
    } catch (err) {
      errors.push(`checkCooldown failed: ${String(err)}`);
      cooldown = {
        globalCooldownActive: false,
        globalCooldownUntil: null,
        globalCooldownRemainingMs: 0,
        principleCooldownActive: false,
        principleCooldownUntil: null,
        principleCooldownRemainingMs: 0,
        quotaExhausted: false,
        runsRemaining: 0,
      };
      if (eventLog) {
        eventLog.recordSkip(undefined, {
          reason: 'checkCooldown_error',
          fallback: 'no_cooldown_assumption',
          context: { error: String(err) },
        });
      }
    }

    // extractRecentPainContext — wrapped in try/catch
    let recentPain: RecentPainContext;
    try {
      recentPain = new PainFlagDetector(this.workspaceDir).extractRecentPainContext();
    } catch (err) {
      errors.push(`extractRecentPainContext failed: ${String(err)}`);
      recentPain = { mostRecent: null, recentPainCount: 0, recentMaxPainScore: 0 };
    }

    // active sessions — filter system and abandoned sessions
    let activeSessions: SessionState[] = [];
    try {
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      activeSessions = listSessions(wctx.workspaceDir).filter((s) => {
        if (s.sessionId.startsWith('system:')) return false;
        if (s.lastActivityAt < twoHoursAgo) return false;
        return true;
      });
    } catch (err) {
      errors.push(`listSessions failed: ${String(err)}`);
    }

    return { idle, cooldown, recentPain, activeSessions, errors };
  }

  /**
   * Build a fallback NocturnalSessionSnapshot from a sleep_reflection task's
   * recentPainContext, used when the primary trajectory database is unavailable.
   *
   * Returns null if the task has no recentPainContext.
   */
  buildFallbackSnapshot(sleepTask: EvolutionQueueItem): NocturnalSessionSnapshot | null {
    const painContext = sleepTask.recentPainContext;
    if (!painContext) {
      return null;
    }

    const fallbackPainEvents: NocturnalPainEvent[] = painContext.mostRecent
      ? [
          {
            source: painContext.mostRecent.source,
            score: painContext.mostRecent.score,
            severity: null,
            reason: painContext.mostRecent.reason,
            createdAt: painContext.mostRecent.timestamp,
          },
        ]
      : [];

    return {
      sessionId: painContext.mostRecent?.sessionId || sleepTask.id,
      startedAt: sleepTask.timestamp,
      updatedAt: sleepTask.timestamp,
      assistantTurns: [],
      userTurns: [],
      toolCalls: [],
      painEvents: fallbackPainEvents,
      gateBlocks: [],
      stats: {
        totalAssistantTurns: null,
        totalToolCalls: null,
        failureCount: null,
        totalPainEvents: painContext.recentPainCount,
        totalGateBlocks: null,
      },
      _dataSource: 'pain_context_fallback',
    };
  }
}
