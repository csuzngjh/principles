/**
 * Candidate/ledger consistency audit — extracted from CLI for core reuse.
 *
 * Checks that every consumed candidate in state.db has a corresponding
 * ledger entry in principle_training_state.json.
 *
 * PRI-28: Extracted so OperatorHealthReadModel can reuse without CLI side effects.
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { loadLedger } from '../principle-tree-ledger.js';

export interface CandidateAuditResult {
  status: 'ok' | 'degraded' | 'error';
  consumedCount: number;
  orphanCandidateCount: number;
  missingLedgerCount: number;
}

export async function auditCandidateLedgerConsistency(workspaceDir: string): Promise<CandidateAuditResult> {
  const pdDbPath = path.join(workspaceDir, '.pd', 'state.db');
  const stateDir = path.join(workspaceDir, '.state');

  if (!fs.existsSync(pdDbPath)) {
    return { status: 'error', consumedCount: 0, orphanCandidateCount: 0, missingLedgerCount: 0 };
  }

  try {
    const db = new Database(pdDbPath, { readonly: true, immutable: true } as Database.Options);
    try {
      const consumedRows = db.prepare(
        "SELECT candidate_id FROM principle_candidates WHERE status = 'consumed'",
      ).all() as { candidate_id: string }[];

      const consumedIds = consumedRows.map(r => r.candidate_id);

      const ledger = loadLedger(stateDir);
      const ledgerPrinciples = Object.values(ledger.tree.principles);

      let missingCount = 0;
      for (const candidateId of consumedIds) {
        const found = ledgerPrinciples.some(p =>
          p.derivedFromPainIds?.includes(candidateId),
        );
        if (!found) missingCount++;
      }

      return {
        status: missingCount === 0 ? 'ok' : 'degraded',
        consumedCount: consumedIds.length,
        orphanCandidateCount: missingCount,
        missingLedgerCount: missingCount,
      };
    } finally {
      db.close();
    }
  } catch {
    return { status: 'error', consumedCount: 0, orphanCandidateCount: 0, missingLedgerCount: 0 };
  }
}
