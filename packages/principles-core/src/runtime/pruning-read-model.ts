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
import { loadLedger, saveLedger } from '../principle-tree-ledger.js';
import { DEFAULT_L1_HARD_CAP, validateL1CapConfig } from './l1-hard-cap.js';

// ── Types ───────────────────────────────────────────────────────────────────────

import type { PrincipleStatus } from './types/principle-enums.js';

export type { PrincipleStatus };
export type PruningRiskLevel = 'none' | 'watch' | 'review';

export interface PrinciplePruningSignal {
  principleId: string;
  status: PrincipleStatus;
  createdAt: string;
  updatedAt: string;
  derivedCandidateIds: string[];
  derivedPainCount: number;
  matchedCandidateCount: number;
  recentCandidateCount: number;
  orphanCandidateCount: number;
  ageDays: number;
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
  activeL1Count: number;
  l1Cap: number;
  generatedAt: string;
}

export interface OrphanDerivedCandidate {
  candidateId: string;
  principleId: string;
  reason: string;
  sourceRef?: string;
  status?: string;
}

export interface OrphanDetectionResult {
  candidates: OrphanDerivedCandidate[];
  dbReadable: boolean;
}

export interface PruningReadModelOptions {
  workspaceDir: string;
  /** Override days threshold for 'watch' risk level (default: 30) */
  watchThresholdDays?: number;
  /** Override days threshold for 'review' risk level (default: 90) */
  reviewThresholdDays?: number;
  /** Override L1 hard cap for health summary (default: 12) */
  l1Cap?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysBetween(dateA: string | number, dateB: Date | number): number {
  const a = typeof dateA === 'string' ? new Date(dateA).getTime() : dateA;
  const b = typeof dateB === 'number' ? dateB : dateB.getTime();
  if (isNaN(a)) return 9999;
  return Math.max(0, Math.round((b - a) / (1000 * 60 * 60 * 24)));
}

function computeRiskLevel(
  ageDays: number,
  derivedPainCount: number,
  opts: { watchThresholdDays: number; reviewThresholdDays: number },
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
    matchedCandidateCount: number;
    recentCandCount: number;
    orphanCandCount: number;
    status: PrincipleStatus;
    watchThresholdDays: number;
    reviewThresholdDays: number;
  },
): string[] {
  const reasons: string[] = [];
  const { matchedCandidateCount, recentCandCount, orphanCandCount, status } = params;
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

  if (derivedPainCount > 0 && matchedCandidateCount === 0) {
    reasons.push('gap: derived pain signals exist but no matched candidates in DB [source: derivedFromPainIds + state.db]');
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
  private readonly l1Cap: number;

  constructor(opts: PruningReadModelOptions) {
    this.workspaceDir = opts.workspaceDir;
    this.watchThresholdDays = opts.watchThresholdDays ?? 30;
    this.reviewThresholdDays = opts.reviewThresholdDays ?? 90;
    this.l1Cap = opts.l1Cap ?? DEFAULT_L1_HARD_CAP;
    validateL1CapConfig({ hardCap: this.l1Cap });
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
  getPrincipleSignals(): PrinciplePruningSignal[] {
    const now = new Date();
    const stateDir = path.join(this.workspaceDir, '.state');
    const ledger = loadLedger(stateDir);
    const principleEntries = Object.values(ledger.tree.principles);

    if (principleEntries.length === 0) {
      return [];
    }

    const candidateCreatedAtMap = new Map<string, string>();
    const allCandidateIdSet = new Set<string>();
    const pdDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    try {
      if (fs.existsSync(pdDbPath)) {
        const db = new Database(pdDbPath, { readonly: true });
        try {
          const allRows = db.prepare(
            'SELECT candidate_id, status, created_at FROM principle_candidates'
          ).all() as { candidate_id: string; status: string; created_at: string }[];
          for (const r of allRows) {
            allCandidateIdSet.add(r.candidate_id);
            if (r.status === 'consumed') {
              candidateCreatedAtMap.set(r.candidate_id, r.created_at);
            }
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

    return principleEntries.map((p) => {
      const derivedPainCount = p.derivedFromPainIds?.length ?? 0;

      let matchedCandidateCount = 0;
      let recentCandidateCount = 0;
      let orphanCandidateCount = 0;
      for (const cid of p.derivedFromPainIds ?? []) {
        if (allCandidateIdSet.has(cid)) {
          matchedCandidateCount++;
          const cAt = candidateCreatedAtMap.get(cid);
          if (cAt && cAt >= recentCutoff) recentCandidateCount++;
        } else {
          orphanCandidateCount++;
        }
      }

      const ageDays = daysBetween(p.createdAt, now);

      const riskLevel = computeRiskLevel(ageDays, derivedPainCount, {
        watchThresholdDays: this.watchThresholdDays,
        reviewThresholdDays: this.reviewThresholdDays,
      });

      const reasons = buildReasons(
        ageDays,
        derivedPainCount,
        {
          matchedCandidateCount,
          recentCandCount: recentCandidateCount,
          orphanCandCount: orphanCandidateCount,
          status: p.status,
          watchThresholdDays: this.watchThresholdDays,
          reviewThresholdDays: this.reviewThresholdDays,
        },
      );

      return {
        principleId: p.id,
        status: p.status,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt ?? p.createdAt,
        derivedCandidateIds: [...(p.derivedFromPainIds ?? [])],
        derivedPainCount,
        matchedCandidateCount,
        recentCandidateCount,
        orphanCandidateCount,
        ageDays,
        riskLevel,
        reasons,
      };
    });
  }

  /**
   * Build aggregate pruning health summary.
   * Reuses getPrincipleSignals() to avoid duplicate DB queries.
   */
  getHealthSummary(): PruningHealthSummary {
    const now = new Date();
    const signals = this.getPrincipleSignals();

    const byStatus: Record<string, number> = {};
    let totalAgeDays = 0;
    let orphanDerivedCandidateCount = 0;

    for (const s of signals) {
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
      totalAgeDays += s.ageDays;
      orphanDerivedCandidateCount += s.orphanCandidateCount;
    }

    return {
      totalPrinciples: signals.length,
      byStatus,
      watchCount: signals.filter((s) => s.riskLevel === 'watch').length,
      reviewCount: signals.filter((s) => s.riskLevel === 'review').length,
      orphanDerivedCandidateCount,
      averageAgeDays: signals.length > 0
        ? Math.round(totalAgeDays / signals.length)
        : 0,
      activeL1Count: byStatus.active ?? 0,
      l1Cap: this.l1Cap,
      generatedAt: now.toISOString(),
    };
  }

  getOrphanDerivedCandidates(): OrphanDetectionResult {
    const stateDir = path.join(this.workspaceDir, '.state');
    const ledger = loadLedger(stateDir);
    const principleEntries = Object.values(ledger.tree.principles);

    if (principleEntries.length === 0) {
      return { candidates: [], dbReadable: true };
    }

    const allCandidateIds = new Set<string>();
    let dbReadable = true;
    const pdDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    try {
      if (fs.existsSync(pdDbPath)) {
        const db = new Database(pdDbPath, { readonly: true });
        try {
          const rows = db.prepare(
            'SELECT candidate_id FROM principle_candidates'
          ).all() as { candidate_id: string }[];
          for (const r of rows) {
            allCandidateIds.add(r.candidate_id);
          }
        } finally {
          db.close();
        }
      } else {
        dbReadable = false;
      }
    } catch {
      dbReadable = false;
    }

    const orphans: OrphanDerivedCandidate[] = [];

    for (const p of principleEntries) {
      for (const cid of p.derivedFromPainIds ?? []) {
        if (!allCandidateIds.has(cid)) {
          orphans.push({
            candidateId: cid,
            principleId: p.id,
            reason: dbReadable
              ? 'candidate not found in state.db'
              : 'candidate not verifiable: state.db unreadable',
            sourceRef: 'derivedFromPainIds',
            status: p.status,
          });
        }
      }
    }

    return { candidates: orphans, dbReadable };
  }
}

export interface RemovedOrphanReference {
  principleId: string;
  removedIds: string[];
}

export function removeOrphanReferencesFromLedger(
  stateDir: string,
  orphanIdsByPrinciple: Map<string, Set<string>>,
): RemovedOrphanReference[] {
  const ledger = loadLedger(stateDir);
  const nextLedger = JSON.parse(JSON.stringify(ledger)) as typeof ledger;
  const removedFromPrinciples: RemovedOrphanReference[] = [];

  for (const [principleId, orphanIds] of orphanIdsByPrinciple) {
    const entry = nextLedger.tree.principles[principleId];
    if (!entry) continue;

    const originalIds = entry.derivedFromPainIds ?? [];
    const filteredIds = originalIds.filter((id: string) => !orphanIds.has(id));

    if (filteredIds.length !== originalIds.length) {
      entry.derivedFromPainIds = filteredIds;
      removedFromPrinciples.push({
        principleId,
        removedIds: originalIds.filter((id: string) => orphanIds.has(id)),
      });
    }
  }

  if (removedFromPrinciples.length > 0) {
    saveLedger(stateDir, nextLedger);
  }

  return removedFromPrinciples;
}
