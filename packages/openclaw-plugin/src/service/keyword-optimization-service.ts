/**
 * Keyword Optimization Service
 *
 * Applies LLM optimization results (ADD/UPDATE/REMOVE mutations) to the
 * correction keyword store. Invoked by the correction observer service
 * when optimization results are available.
 */

import { CorrectionCueLearner } from '../core/correction-cue-learner.js';
import { SystemLogger } from '../core/system-logger.js';
import type { CorrectionObserverOutputV1 as CorrectionObserverResult } from '@principles/core/runtime-v2';
import type { PluginLogger } from '../openclaw-sdk.js';
import { TrajectoryRegistry } from '../core/trajectory.js';

/**
 * `updates` is keyed BY term, so a key that is blank or is one of the action
 * words means the model put the action in the key slot (observed in
 * production: REMOVE term="add"). Such an entry carries no term and must never
 * reach the store — rc-1/rc-2: untrusted output is not executed as written.
 */
const RESERVED_UPDATE_KEYS = new Set(['add', 'update', 'remove']);

/**
 * Applies CorrectionObserverResult mutations to the keyword store.
 * - ADD: calls learner.add() with new keyword (evicts a learned term at cap)
 * - UPDATE: updates weight on an existing keyword
 * - REMOVE: removes keyword from store; Owner-authored seed terms are protected
 *
 * Every key is resolved with the store's own identity rule (trim + lowercase),
 * and a key that does not resolve is an observable skip, not a thrown error:
 * the model paraphrases terms constantly, and the old per-op exceptions turned
 * that into ~47 WARN lines a day that hid real failures.
 */
export class KeywordOptimizationService {
  private readonly stateDir: string;
  private readonly workspaceDir: string;
  private readonly logger: PluginLogger;

  constructor(stateDir: string, workspaceDir: string, logger: PluginLogger) {
    this.stateDir = stateDir;
    this.workspaceDir = workspaceDir;
    this.logger = logger;
  }

  applyResult(result: CorrectionObserverResult): void {
    const learner = CorrectionCueLearner.get(this.stateDir);

    const updates = result.updates ?? {};
    if (result.updated && Object.keys(updates).length > 0) {
      for (const [rawKey, update] of Object.entries(updates)) {
        const term = rawKey.trim().toLowerCase();
        if (term === '' || RESERVED_UPDATE_KEYS.has(term)) {
          this.skip(rawKey, update.action, `"${rawKey}" is not a term (blank or action word)`);
          continue;
        }

        const existing = learner.find(term);
        if (update.action !== 'add' && !existing) {
          this.skip(rawKey, update.action, 'not in store');
          continue;
        }
        if (update.action === 'remove' && existing !== undefined && existing.source !== 'llm') {
          this.skip(rawKey, update.action, `${existing.source} term is Owner-authored, not machine-removable`);
          continue;
        }

        try {
          switch (update.action) {
            case 'add': {
              if (existing) {
                this.audit('ADD_SKIPPED', `"${term}" already exists as "${existing.term}"`);
                break;
              }
              if (term.includes(',')) {
                this.skip(rawKey, 'add', 'joined cue of several terms, not one learnable term');
                break;
              }
              const weight = update.weight !== undefined
                ? Math.max(0.1, Math.min(0.9, update.weight))
                : 0.5;
              const evicted = learner.add({ term, weight, source: 'llm' });
              this.audit(
                'ADD',
                evicted
                  ? `term="${term}" weight=${weight} evicted="${evicted}" (store at cap)`
                  : `term="${term}" weight=${weight}`,
              );
              break;
            }
            case 'update': {
              if (update.weight === undefined) break;
              learner.updateWeight(term, update.weight);
              this.audit('UPDATE', `term="${term}" weight=${update.weight}`);
              break;
            }
            case 'remove': {
              learner.remove(term);
              this.audit('REMOVE', `term="${term}"`);
              break;
            }
          }
        } catch (opErr) {
          // Log and skip individual operation failures — don't fail the whole batch
          this.logger?.warn?.(`[KeywordOptimizationService] ${update.action.toUpperCase()} failed for term="${term}": ${String(opErr)}`);
        }
      }
    } else {
      this.logger?.info?.('[KeywordOptimizationService] No store mutations to apply');
    }

    // H-1: Record confirmed false positives — terms where correctionDetected fired
    // but trajectory analysis shows user wasn't actually expressing frustration.
    // PRI-812: recorded INDEPENDENTLY of `updated`/`updates` — the observer
    // contract allows an FP-only verdict (updated=false, fpTerms=[...]), and
    // that verdict is the counter-evidence the earned-high demotion loop
    // consumes (high → FP=1 → precisionFor → ambiguous). Gating it behind
    // store mutations silently discarded the only demotion signal.
    if (result.fpAnalysisStatus === 'completed' && result.fpTerms && result.fpTerms.length > 0) {
      // Normalize: trim, lowercase, dedupe, sanity cap
      const MAX_FP_TERMS = 20;
      const normalizedFpTerms = [...new Set(
        result.fpTerms
          .map((t: string) => t.trim().toLowerCase())
          .filter((t: string) => t.length > 0)
      )].slice(0, MAX_FP_TERMS);

      for (const term of normalizedFpTerms) {
        try {
          if (learner.recordFalsePositive(term)) {
            this.audit('FP_RECORDED', `term="${term}" (weight x0.8)`);
          } else {
            this.skip(term, 'fp', 'not in store');
          }
        } catch (fpErr) {
          this.logger?.warn?.(`[KeywordOptimizationService] recordFalsePositive failed for term="${term}": ${String(fpErr)}`);
        }
      }
    }
  }

  /** One Owner-visible line per store mutation: plugin log + SYSTEM log. */
  private audit(action: string, detail: string): void {
    this.logger?.info?.(`[KeywordOptimizationService] ${action} ${detail}`);
    SystemLogger.log(this.workspaceDir, 'KEYWORD_LEARNING', `${action} ${detail}`);
  }

  /**
   * A verdict the store cannot act on. Reported, not thrown: the model
   * paraphrases term keys constantly, and each refusal still needs a reason
   * (rc-9 — degradation must be observable).
   */
  private skip(term: string, action: string, reason: string): void {
    this.logger?.warn?.(`[KeywordOptimizationService] ${action.toUpperCase()} skipped for term="${term}": ${reason}`);
  }

  /**
   * Builds trajectory history for payload:
   * - Calls TrajectoryDatabase.listUserTurnsForSession() for recent sessions
   * - Filters to turns where correctionDetected=true
   * - Returns last 50 correction events
   */
  async buildTrajectoryHistory(sessionIds: string[]): Promise<TrajectoryHistoryEntry[]> {
    const history: TrajectoryHistoryEntry[] = [];
    const db = TrajectoryRegistry.get(this.workspaceDir);

    for (const sessionId of sessionIds.slice(0, 10)) { // Last 10 sessions
      try {
        const turns = db.listUserTurnsForSession(sessionId);
        for (const turn of turns) {
          if (turn.correctionDetected) {
            const cue = (turn.correctionCue ?? '').trim();
            // A cue persisted as "llm:<reason>" is Stage2 verdict prose, not a
            // keyword. Passing it through as `term` is what taught the
            // optimizer to store whole sentences as terms (52 of the 58
            // detected turns in the live workspace) — an empty term says
            // honestly "this correction had no keyword match", which
            // buildPrompt renders.
            const proseOnly = cue.startsWith('llm:');
            // Stage1 joins every matched term with ", ", so one cue can name
            // several terms. Emit one event per term: the observer judges and
            // proposes per term, and a joined string handed to it as a single
            // "term" is exactly the composite that would come back as an ADD
            // candidate that can never match again.
            const terms = proseOnly ? [''] : (cue.split(',').map((t) => t.trim()).filter((t) => t !== ''));
            for (const term of terms.length > 0 ? terms : ['']) {
              history.push({
                sessionId,
                timestamp: turn.createdAt ?? new Date().toISOString(),
                term,
                // PRI-823: carry the bounded raw excerpt (≤200 chars, persisted
                // per user_turn) so the observer can judge each hit event on its
                // own message text instead of guessing from the term alone. Same
                // data category recentMessages already delivers — no new storage
                // or privacy surface. buildPrompt still caps rendering at 80
                // chars/entry.
                userMessage: turn.rawExcerpt ?? '',
              });
              if (history.length >= 50) break; // Cap at 50 events
            }
          }
          if (history.length >= 50) break;
        }
      } catch (dbErr) {
        // Skip individual session DB errors — try remaining sessions
        this.logger?.warn?.(`[KeywordOptimizationService] Failed to read trajectory for session ${sessionId}: ${String(dbErr)}`);
      }
      if (history.length >= 50) break;
    }

    return history;
  }

  // ── Singleton factory ───────────────────────────────────────────────────

  private static _instances = new Map<string, KeywordOptimizationService>();

  static get(stateDir: string, workspaceDir: string, logger: PluginLogger): KeywordOptimizationService {
    const key = `${stateDir}::${workspaceDir}`;
    if (!KeywordOptimizationService._instances.has(key)) {
      KeywordOptimizationService._instances.set(key, new KeywordOptimizationService(stateDir, workspaceDir, logger));
    }
    return KeywordOptimizationService._instances.get(key)!;
  }

  static reset(): void {
    KeywordOptimizationService._instances.clear();
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
export type { CorrectionObserverPayload } from '@principles/core/runtime-v2';
