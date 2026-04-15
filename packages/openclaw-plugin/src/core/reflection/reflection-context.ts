/**
 * ReflectionContextCollector — Unified Pipeline Input
 * ====================================================
 *
 * PURPOSE: Collect all grounding context for a principle into a single
 * ReflectionContext object. This is the input to the nocturnal reflection
 * pipeline: principle + painEvents + sessionSnapshot + lineage.
 *
 * DESIGN DECISIONS:
 * - If a principle has no derivedFromPainIds, collect() returns null
 *   (nothing to ground code on).
 * - painId -> sessionId resolution is a known gap. For now, we attempt
 *   best-effort lookup but return what we have with sessionSnapshot = null
 *   if we can't resolve.
 *
 * REUSES:
 * - principle-tree-ledger: loadLedger() for principle lookup
 * - nocturnal-trajectory-extractor: for session snapshots
 * - trajectory: TrajectoryDatabase for pain event queries
 */

import { loadLedger, type LedgerPrinciple } from '../principle-tree-ledger.js';
import {
  NocturnalTrajectoryExtractor,
  type NocturnalPainEvent,
  type NocturnalSessionSnapshot,
} from '../nocturnal-trajectory-extractor.js';
import type { TrajectoryDatabase } from '../trajectory.js';
import type { Principle } from '../../types/principle-tree-schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Unified reflection context for the nocturnal pipeline.
 */
export interface ReflectionContext {
  /** The principle being reflected upon */
  principle: Principle;
  /** Pain events associated with this principle (via derivedFromPainIds) */
  painEvents: NocturnalPainEvent[];
  /** Session snapshot if resolvable, null otherwise */
  sessionSnapshot: NocturnalSessionSnapshot | null;
  /** Lineage metadata connecting principle to source pain signals */
  lineage: {
    sourcePainIds: string[];
    sessionId: string | null;
  };
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

/**
 * Collects ReflectionContext for principles by joining ledger data with
 * trajectory data.
 */
export class ReflectionContextCollector {
  private readonly stateDir: string;
  private readonly trajectory: TrajectoryDatabase;

  constructor(stateDir: string, trajectory: TrajectoryDatabase) {
    this.stateDir = stateDir;
    this.trajectory = trajectory;
  }

  /**
   * Collect full reflection context for a single principle.
   *
   * Returns null if:
   * - The principle is not found in the ledger
   * - The principle has no derivedFromPainIds (nothing to ground on)
   */
  collect(principleId: string): ReflectionContext | null {
    const ledger = loadLedger(this.stateDir);
    const principle = ledger.tree.principles[principleId];

    if (!principle) {
      return null;
    }

    if (!principle.derivedFromPainIds || principle.derivedFromPainIds.length === 0) {
      return null;
    }

    return this.buildContext(principle);
  }

  /**
   * Collect reflection contexts for multiple principles, optionally filtered.
   *
   * Skips principles without derivedFromPainIds.
   */
  collectBatch(filter?: { status?: string }): ReflectionContext[] {
    const ledger = loadLedger(this.stateDir);
    const principles = Object.values(ledger.tree.principles);

    const results: ReflectionContext[] = [];

    for (const principle of principles) {
      // Apply status filter if provided
      if (filter?.status && principle.status !== filter.status) {
        continue;
      }

      // Skip principles without pain grounding
      if (!principle.derivedFromPainIds || principle.derivedFromPainIds.length === 0) {
        continue;
      }

      const ctx = this.buildContext(principle);
      if (ctx) {
        results.push(ctx);
      }
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Build a ReflectionContext from a principle.
   *
   * Attempts to resolve painIds to sessions via best-effort lookup.
   * Since painId -> sessionId mapping is a known gap, we may return
   * empty painEvents and null sessionSnapshot.
   */
  private buildContext(principle: LedgerPrinciple): ReflectionContext {
    const sourcePainIds = principle.derivedFromPainIds;

    // Best-effort: try to find a session containing pain events related to this principle.
    // The pain_events table uses auto-increment IDs, not the string painIds stored in
    // derivedFromPainIds. This is the known gap — for now we attempt session resolution
    // but gracefully handle the case where we can't match.
    const { painEvents, sessionId } = this.resolvePainEvents(sourcePainIds);

    // If we found a session, get the snapshot
    let sessionSnapshot: NocturnalSessionSnapshot | null = null;
    if (sessionId) {
      const extractor = new NocturnalTrajectoryExtractor(this.trajectory);
      sessionSnapshot = extractor.getNocturnalSessionSnapshot(sessionId);
    }

    return {
      principle,
      painEvents,
      sessionSnapshot,
      lineage: {
        sourcePainIds,
        sessionId,
      },
    };
  }

  /**
   * Attempt to resolve painIds to actual pain events and a session.
   *
   * Two-phase strategy:
   * 1. Exact ID match: sourcePainIds are stringified pain_events row IDs.
   *    If any match String(pe.id) exactly, use those and stop.
   * 2. Heuristic fallback: substring match on reason/origin fields.
   *    Only used when no exact matches are found.
   */
  private resolvePainEvents(sourcePainIds: string[]): {
    painEvents: NocturnalPainEvent[];
    sessionId: string | null;
  } {
    const sessions = this.trajectory.listRecentSessions({ limit: 100 });
    const sourcePainIdSet = new Set(sourcePainIds);

    const exactMatches: NocturnalPainEvent[] = [];
    const heuristicMatches: NocturnalPainEvent[] = [];
    let exactSessionId: string | null = null;
    let heuristicSessionId: string | null = null;

    for (const session of sessions) {
      const sessionPainEvents = this.trajectory.listPainEventsForSession(session.sessionId);

      for (const pe of sessionPainEvents) {
        // Phase 1: exact ID match
        if (sourcePainIdSet.has(String(pe.id))) {
          exactMatches.push({
            source: pe.source,
            score: pe.score,
            severity: pe.severity,
            reason: pe.reason,
            createdAt: pe.createdAt,
          });
          if (!exactSessionId) {
            exactSessionId = session.sessionId;
          }
          continue;
        }

        // Phase 2: heuristic substring match on reason/origin only
        const peText = [pe.reason, pe.origin].filter(Boolean);
        const isMatch = sourcePainIds.some((painId) =>
          peText.some((field) => field?.includes(painId)),
        );

        if (isMatch) {
          heuristicMatches.push({
            source: pe.source,
            score: pe.score,
            severity: pe.severity,
            reason: pe.reason,
            createdAt: pe.createdAt,
          });
          if (!heuristicSessionId) {
            heuristicSessionId = session.sessionId;
          }
        }
      }
    }

    // Prefer exact matches over heuristic matches
    if (exactMatches.length > 0) {
      return { painEvents: exactMatches, sessionId: exactSessionId };
    }

    return { painEvents: heuristicMatches, sessionId: heuristicSessionId };
  }
}
