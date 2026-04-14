/**
 * Keyword Optimization Service
 *
 * Applies LLM optimization results (ADD/UPDATE/REMOVE mutations) to the
 * correction keyword store. Called by evolution-worker.ts after the
 * keyword_optimization workflow completes.
 */

import { CorrectionCueLearner } from '../core/correction-cue-learner.js';
import type { CorrectionObserverResult } from './subagent-workflow/correction-observer-types.js';
import type { PluginLogger } from '../openclaw-sdk.js';
import { TrajectoryRegistry } from '../core/trajectory.js';

/**
 * Applies CorrectionObserverResult mutations to the keyword store.
 * - ADD: calls learner.add() with new keyword
 * - UPDATE: updates weight on existing keyword
 * - REMOVE: removes keyword from store
 */
export class KeywordOptimizationService {
  private stateDir: string;
  private logger: PluginLogger;

  constructor(stateDir: string, logger: PluginLogger) {
    this.stateDir = stateDir;
    this.logger = logger;
  }

  applyResult(result: CorrectionObserverResult): void {
    const learner = CorrectionCueLearner.get(this.stateDir);

    if (!result.updated || !result.updates) {
      this.logger?.info?.('[KeywordOptimizationService] No updates to apply');
      return;
    }

    for (const [term, update] of Object.entries(result.updates)) {
      switch (update.action) {
        case 'add': {
          const weight = update.weight ?? 0.5;
          learner.add({ term, weight, source: 'llm_optimization' });
          this.logger?.info?.(`[KeywordOptimizationService] ADD term="${term}" weight=${weight}`);
          break;
        }
        case 'update': {
          if (update.weight !== undefined) {
            learner.updateWeight(term, update.weight);
            this.logger?.info?.(`[KeywordOptimizationService] UPDATE term="${term}" weight=${update.weight}`);
          }
          break;
        }
        case 'remove': {
          learner.remove(term);
          this.logger?.info?.(`[KeywordOptimizationService] REMOVE term="${term}"`);
          break;
        }
      }
    }
  }

  /**
   * Builds trajectory history for payload:
   * - Calls TrajectoryDatabase.listUserTurnsForSession() for recent sessions
   * - Filters to turns where correctionDetected=true
   * - Returns last 50 correction events
   */
  async buildTrajectoryHistory(sessionIds: string[]): Promise<TrajectoryHistoryEntry[]> {
    const history: CorrectionObserverPayload['trajectoryHistory'] = [];
    const db = TrajectoryRegistry.get(this.stateDir);

    for (const sessionId of sessionIds.slice(0, 10)) { // Last 10 sessions
      const turns = db.listUserTurnsForSession(sessionId);
      for (const turn of turns) {
        if (turn.correctionDetected) {
          history.push({
            sessionId,
            timestamp: turn.createdAt,
            term: turn.correctionCue ?? 'unknown',
            userMessage: turn.correctionCue ?? '',
          });
        }
        if (history.length >= 50) break; // Cap at 50 events
      }
      if (history.length >= 50) break;
    }

    return history;
  }

  // ── Singleton factory ───────────────────────────────────────────────────

  private static _instance: KeywordOptimizationService | null = null;
  private static _lastStateDir: string | null = null;

  static get(stateDir: string, logger: PluginLogger): KeywordOptimizationService {
    if (!_instance || _lastStateDir !== stateDir) {
      _instance = new KeywordOptimizationService(stateDir, logger);
      _lastStateDir = stateDir;
    }
    return _instance;
  }

  static reset(): void {
    _instance = null;
    _lastStateDir = null;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────

/**
 * Internal type mirroring the trajectoryHistory field in CorrectionObserverPayload.
 * Exported here so buildTrajectoryHistory can reference it without a circular import.
 */
export type TrajectoryHistoryEntry = {
  sessionId: string;
  timestamp: string;
  term: string;
  userMessage: string;
};

/** Re-export CorrectionObserverPayload for convenience */
export type { CorrectionObserverPayload } from './subagent-workflow/correction-observer-types.js';
