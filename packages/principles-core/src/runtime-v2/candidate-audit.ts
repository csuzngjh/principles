/**
 * Candidate/ledger consistency audit — extracted from CLI for core reuse.
 *
 * Checks that every consumed candidate in state.db has a corresponding
 * ledger resolution in principle_training_state.json.
 *
 * Reuse-aware judgment (PRI-917 / R7): a consumed principle-kind candidate is
 * "resolved" when it EITHER created a ledger principle (`derivedFromPainIds`,
 * which stores candidate ids despite its legacy pain-oriented name) OR was
 * resolved into an existing principle by a reuse decision (`reuseEvidence[]`;
 * zero ledger growth by design). Candidates whose `recommendation_kind` never
 * targets the Principle Ledger (rule / prompt / implementation / defer, and
 * unknown kinds refused fail-closed by the intake boundary) never produce
 * `derivedFromPainIds` — they are counted, not flagged. Only a consumed,
 * principle-kind candidate with NO resolution anywhere is true drift.
 *
 * PRI-28: Extracted so OperatorHealthReadModel can reuse without CLI side effects.
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { loadLedger } from '../principle-tree-ledger.js';
import { isPrincipleLedgerEligibleKind } from './store/candidate/recommendation-kind-resolver.js';

export interface CandidateAuditResult {
  status: 'ok' | 'degraded' | 'error';
  consumedCount: number;
  orphanCandidateCount: number;
  missingLedgerCount: number;
  /**
   * Consumed candidates resolved into an EXISTING principle via
   * `reuseEvidence` (not missing — by-design zero ledger growth).
   */
  reusedResolvedCount?: number;
  /**
   * Consumed candidates whose `recommendation_kind` never targets the
   * Principle Ledger (not missing — by-design no ledger entry).
   */
  nonLedgerKindCount?: number;
  /** The true-missing candidate ids (principle-kind, consumed, no resolution). */
  missingLedgerEntryIds?: string[];
}

function errorResult(): CandidateAuditResult {
  return {
    status: 'error',
    consumedCount: 0,
    orphanCandidateCount: 0,
    missingLedgerCount: 0,
    reusedResolvedCount: 0,
    nonLedgerKindCount: 0,
    missingLedgerEntryIds: [],
  };
}

export async function auditCandidateLedgerConsistency(workspaceDir: string): Promise<CandidateAuditResult> {
  const pdDbPath = path.join(workspaceDir, '.pd', 'state.db');
  const stateDir = path.join(workspaceDir, '.state');

  if (!fs.existsSync(pdDbPath)) {
    return errorResult();
  }

  try {
    const db = new Database(pdDbPath, { readonly: true });
    try {
      const consumedRows = db.prepare(
        "SELECT candidate_id, recommendation_kind FROM principle_candidates WHERE status = 'consumed'",
      ).all() as { candidate_id: string; recommendation_kind: string | null }[];

      const ledger = loadLedger(stateDir);
      const ledgerPrinciples = Object.values(ledger.tree.principles);

      // Both ledger expressions of a resolved candidate. The ledger file is
      // only shape-validated at its write boundaries, so values read here are
      // guarded before use (rc-1/rc-4).
      const derivedCandidateIds = new Set<string>();
      const reuseResolvedCandidateIds = new Set<string>();
      for (const p of ledgerPrinciples) {
        const principle = p as {
          derivedFromPainIds?: unknown;
          reuseEvidence?: unknown;
        };
        if (Array.isArray(principle.derivedFromPainIds)) {
          for (const cid of principle.derivedFromPainIds) {
            if (typeof cid === 'string' && cid !== '') derivedCandidateIds.add(cid);
          }
        }
        if (Array.isArray(principle.reuseEvidence)) {
          for (const ev of principle.reuseEvidence) {
            const candidateId = (ev as { candidateId?: unknown } | null)?.candidateId;
            if (typeof candidateId === 'string' && candidateId !== '') {
              reuseResolvedCandidateIds.add(candidateId);
            }
          }
        }
      }

      const missingLedgerEntryIds: string[] = [];
      let reusedResolvedCount = 0;
      let nonLedgerKindCount = 0;
      for (const row of consumedRows) {
        if (derivedCandidateIds.has(row.candidate_id)) continue;
        if (reuseResolvedCandidateIds.has(row.candidate_id)) {
          reusedResolvedCount++;
          continue;
        }
        if (!isPrincipleLedgerEligibleKind(row.recommendation_kind)) {
          nonLedgerKindCount++;
          continue;
        }
        missingLedgerEntryIds.push(row.candidate_id);
      }
      const missingCount = missingLedgerEntryIds.length;

      return {
        status: missingCount === 0 ? 'ok' : 'degraded',
        consumedCount: consumedRows.length,
        orphanCandidateCount: missingCount,
        missingLedgerCount: missingCount,
        reusedResolvedCount,
        nonLedgerKindCount,
        missingLedgerEntryIds,
      };
    } finally {
      db.close();
    }
  } catch {
    return errorResult();
  }
}
