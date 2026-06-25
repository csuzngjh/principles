import { loadLedger, type LedgerPrinciple } from '../principle-tree-ledger.js';
import type { TrajectoryDatabase } from '../trajectory.js';

export interface ReflectionContext {
  principle: LedgerPrinciple;
  painEvents: Array<{ source: string; score: number; severity: string | null; reason: string | null; createdAt: string }>;
  sessionSnapshot: {
    toolCalls: Array<{
      toolName: string;
      outcome: string;
      filePath: string | null;
      errorType: string | null;
    }>;
  } | null;
}

export class ReflectionContextCollector {
  private readonly stateDir: string;
  private readonly trajectory: TrajectoryDatabase;

  constructor(stateDir: string, trajectory: TrajectoryDatabase) {
    this.stateDir = stateDir;
    this.trajectory = trajectory;
  }

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

  collectBatch(filter?: { status?: string }): ReflectionContext[] {
    const ledger = loadLedger(this.stateDir);
    const principles = Object.values(ledger.tree.principles);

    const results: ReflectionContext[] = [];

    for (const principle of principles) {
      if (filter?.status && principle.status !== filter.status) {
        continue;
      }

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

  private buildContext(principle: LedgerPrinciple): ReflectionContext {
    const sourcePainIds = principle.derivedFromPainIds;
    const { painEvents } = this.resolvePainEvents(sourcePainIds);

    return {
      principle,
      painEvents,
      sessionSnapshot: null,
    };
  }

  private resolvePainEvents(sourcePainIds: string[]): {
    painEvents: Array<{ source: string; score: number; severity: string | null; reason: string | null; createdAt: string }>;
    sessionId: string | null;
  } {
    const sessions = this.trajectory.listRecentSessions({ limit: 100 });
    const sourcePainIdSet = new Set(sourcePainIds);

    const exactMatches: Array<{ source: string; score: number; severity: string | null; reason: string | null; createdAt: string }> = [];
    const heuristicMatches: Array<{ source: string; score: number; severity: string | null; reason: string | null; createdAt: string }> = [];
    let exactSessionId: string | null = null;
    let heuristicSessionId: string | null = null;

    for (const session of sessions) {
      const sessionPainEvents = this.trajectory.listPainEventsForSession(session.sessionId);

      for (const pe of sessionPainEvents) {
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

    if (exactMatches.length > 0) {
      return { painEvents: exactMatches, sessionId: exactSessionId };
    }

    return { painEvents: heuristicMatches, sessionId: heuristicSessionId };
  }
}
