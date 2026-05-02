/**
 * PruningReadModel — non-destructive read model for principle lifecycle signals.
 *
 * PRI-15: Dynamic pruning metrics and read model.
 *
 * This model reads from the ledger and candidates table to produce
 * actionable signals for principle health, without writing anything.
 * All rules are deterministic and based on available metadata only.
 *
 * Non-goals:
 * - No automatic pruning or demotion
 * - No ledger writes
 * - No state changes
 * - No background workers
 */
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { loadLedger } from '../principle-tree-ledger.js';

// ── Types ───────────────────────────────────────────────────────────────────────

export type PrincipleStatus = 'candidate' | 'active' | 'archived' | 'deprecated' | 'probation';
export type PruningRiskLevel = 'none' | 'watch' | 'review';

export interface PrinciplePruningSignal {
  principleId: string;
  status: PrincipleStatus;
  createdAt: string;
  updatedAt: string;
  derivedCandidateIds: string[];
  derivedPainCount: number;
  candidateCount: number;
  recentCandidateCount: number;
  ageDays: number;
  staleDays: number | null;   // null = unknown (no createdAt)
  riskLevel: PruningRiskLevel;
  reasons: string[];
}

export interface PruningHealthSummary {
  totalPrinciples: number;
  byStatus: Record<string, number>;
  watchCount: number;
  reviewCount: number;
  orphanDerivedCandidateCount: number;
  averageAgeDays: number;
  generatedAt: string;
}

export interface PruningReadModelOptions {
  workspaceDir: string;
  /** Override days threshold for 'watch' risk level (default: 30) */
  watchThresholdDays?: number;
  /** Override days threshold for 'review' risk level (default: 90) */
  reviewThresholdDays?: number;
  /** Override minimum candidate count for 'review' (default: 0) */
  reviewMinCandidateCount?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysBetween(dateA: string | number, dateB: Date | number): number {
  const a = typeof dateA === 'string' ? new Date(dateA).getTime() : dateA;
  const b = typeof dateB === 'number' ? dateB : dateB.getTime();
  if (isNaN(a)) return 0;
  return Math.max(0, Math.round((b - a) / (1000 * 60 * 60 * 24)));
}

function computeRiskLevel(
  ageDays: number,
  derivedPainCount: number,
  opts: { watchThresholdDays: number; reviewThresholdDays: number; reviewMinCandidateCount: number },
): PruningRiskLevel {
  if (ageDays >= opts.reviewThresholdDays && derivedPainCount === 0) {
    return 'review';
  }
  if (ageDays >= opts.watchThresholdDays && derivedPainCount === 0) {
    return 'watch';
  }
  return 'none';
}

function buildReasons(
  ageDays: number,
  derivedPainCount: number,
  params: {
    candidateCount: number;
    recentCandCount: number;
    orphanCandCount: number;
    status: PrincipleStatus;
    watchThresholdDays: number;
    reviewThresholdDays: number;
  },
): string[] {
  const reasons: string[] = [];
  const { candidateCount, recentCandCount, orphanCandCount, status } = params;
  const opts = { watchThresholdDays: params.watchThresholdDays, reviewThresholdDays: params.reviewThresholdDays };

  if (ageDays >= opts.reviewThresholdDays && derivedPainCount === 0) {
    reasons.push(`review: principle older than ${opts.reviewThresholdDays} days with no derived pain signals [source: createdAt + derivedFromPainIds]`);
  } else if (ageDays >= opts.watchThresholdDays && derivedPainCount === 0) {
    reasons.push(`watch: principle older than ${opts.watchThresholdDays} days with no recent derived pain signals [source: createdAt + derivedFromPainIds]`);
  }

  if (status === 'probation') {
    reasons.push('status: principle is in probation status [source: ledger.status]');
  }

  if (orphanCandCount > 0) {
    reasons.push(`orphan: ${orphanCandCount} derived candidate(s) not found in candidates table [source: derivedFromPainIds + state.db]`);
  }

  if (derivedPainCount > 0 && candidateCount === 0) {
    reasons.push('gap: derived pain signals exist but no candidates in ledger [source: derivedFromPainIds + ledger entry count]');
  }

  if (recentCandCount > 0 && derivedPainCount === 0) {
    reasons.push('stale: recent candidates exist but none derived from pain signals [source: candidates.createdAt]');
  }

  if (status === 'deprecated' || status === 'archived') {
    reasons.push(`status: principle is ${status} [source: ledger.status]`);
  }

  return reasons;
}

// ── Main Class ────────────────────────────────────────────────────────────────

export class PruningReadModel {
  private readonly workspaceDir: string;
  private readonly watchThresholdDays: number;
  private readonly reviewThresholdDays: number;
  private readonly reviewMinCandidateCount: number;

  constructor(opts: PruningReadModelOptions) {
    this.workspaceDir = opts.workspaceDir;
    this.watchThresholdDays = opts.watchThresholdDays ?? 30;
    this.reviewThresholdDays = opts.reviewThresholdDays ?? 90;
    this.reviewMinCandidateCount = opts.reviewMinCandidateCount ?? 0;
  }

  /**
   * Build per-principle signals for the current workspace ledger.
   *
   * Reads:
   *   - .state/principle_training_state.json (ledger)
   *   - .pd/state.db principle_candidates (candidate table)
   *
   * Returns one signal per ledger principle entry.
   */
  async getPrincipleSignals(): Promise<PrinciplePruningSignal[]> {
    const now = new Date();
    const stateDir = path.join(this.workspaceDir, '.state');
    const ledger = loadLedger(stateDir);
    const principleEntries = Object.values(ledger.tree.principles);

    if (principleEntries.length === 0) {
      return [];
    }

    // Build candidate_id → createdAt map from SQLite (only 'consumed' candidates matter)
    const candidateCreatedAtMap = new Map<string, string>();
    const pdDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    try {
      if (fs.existsSync(pdDbPath)) {
        const db = new Database(pdDbPath, { readonly: true });
        try {
          const rows = db.prepare(
            "SELECT candidate_id, created_at FROM principle_candidates WHERE status = 'consumed'"
          ).all() as { candidate_id: string; created_at: string }[];
          for (const r of rows) {
            candidateCreatedAtMap.set(r.candidate_id, r.created_at);
          }
        } finally {
          db.close();
        }
      }
    } catch {
      // Graceful degradation — candidate map stays empty
    }

    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const recentCutoff = new Date(now.getTime() - thirtyDaysMs).toISOString();

    // Build set of all candidate IDs referenced in ledger
    const ledgerCandidateIds = new Set<string>();
    for (const p of principleEntries) {
      for (const cid of p.derivedFromPainIds ?? []) {
        ledgerCandidateIds.add(cid);
      }
    }

    // 90-day threshold for recent candidates
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    void ninetyDaysMs; // reserved for future 90-day filtering

    return principleEntries.map((p) => {
      const derivedPainCount = p.derivedFromPainIds?.length ?? 0;
      const candidateCount = derivedPainCount; // Each derivedFromPainIds entry corresponds to one candidate intake

      // Recent = candidate created within 30 days
      let recentCandidateCount = 0;
      for (const cid of p.derivedFromPainIds ?? []) {
        const cAt = candidateCreatedAtMap.get(cid);
        if (cAt && cAt >= recentCutoff) recentCandidateCount++;
      }

      // Orphan = derived candidate ID not in candidates table
      let orphanDerivedCandidateCount = 0;
      for (const cid of p.derivedFromPainIds ?? []) {
        if (!candidateCreatedAtMap.has(cid)) {
          // derived candidate ID not found in consumed candidates table
          orphanDerivedCandidateCount++;
        }
      }

      const ageDays = daysBetween(p.createdAt, now);
      const staleDays = derivedPainCount > 0 && candidateCount === 0 ? ageDays : null;

      const riskLevel = computeRiskLevel(ageDays, derivedPainCount, {
        watchThresholdDays: this.watchThresholdDays,
        reviewThresholdDays: this.reviewThresholdDays,
        reviewMinCandidateCount: this.reviewMinCandidateCount,
      });

      const reasons = buildReasons(
        ageDays,
        derivedPainCount,
        {
          candidateCount,
          recentCandCount: recentCandidateCount,
          orphanCandCount: orphanDerivedCandidateCount,
          status: p.status as PrincipleStatus,
          watchThresholdDays: this.watchThresholdDays,
          reviewThresholdDays: this.reviewThresholdDays,
        },
      );

      return {
        principleId: p.id,
        status: p.status as PrincipleStatus,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt ?? p.createdAt,
        derivedCandidateIds: [...(p.derivedFromPainIds ?? [])],
        derivedPainCount,
        candidateCount,
        recentCandidateCount,
        ageDays,
        staleDays,
        riskLevel,
        reasons,
      };
    });
  }

  /**
   * Build aggregate pruning health summary.
   */
  async getHealthSummary(): Promise<PruningHealthSummary> {
    const now = new Date();
    const signals = await this.getPrincipleSignals();
    const stateDir = path.join(this.workspaceDir, '.state');
    const ledger = loadLedger(stateDir);
    const principleEntries = Object.values(ledger.tree.principles);

    const byStatus: Record<string, number> = {};
    let totalAgeDays = 0;

    for (const p of principleEntries) {
      const entry = p;
      const status = entry.status || 'unknown';
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      totalAgeDays += daysBetween(entry.createdAt, now);
    }

    // Count orphan derived candidates
    const allDerivedCandIds = new Set<string>();
    for (const p of principleEntries) {
      const entry = p;
      for (const cid of entry.derivedFromPainIds ?? []) {
        allDerivedCandIds.add(cid);
      }
    }

    const pdDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    let orphanDerivedCandidateCount = 0;
    try {
      if (fs.existsSync(pdDbPath)) {
        const db = new Database(pdDbPath, { readonly: true });
        try {
          const rows = db.prepare(
            "SELECT candidate_id FROM principle_candidates WHERE status = 'consumed'"
          ).all() as { candidate_id: string }[];
          const dbCandIds = new Set(rows.map((r) => r.candidate_id));
          for (const cid of allDerivedCandIds) {
            if (!dbCandIds.has(cid)) orphanDerivedCandidateCount++;
          }
        } finally {
          db.close();
        }
      }
    } catch {
      orphanDerivedCandidateCount = 0;
    }

    return {
      totalPrinciples: principleEntries.length,
      byStatus,
      watchCount: signals.filter((s) => s.riskLevel === 'watch').length,
      reviewCount: signals.filter((s) => s.riskLevel === 'review').length,
      orphanDerivedCandidateCount,
      averageAgeDays: principleEntries.length > 0
        ? Math.round(totalAgeDays / principleEntries.length)
        : 0,
      generatedAt: now.toISOString(),
    };
  }
}
