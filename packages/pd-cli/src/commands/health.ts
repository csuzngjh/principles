/**
 * pd health command implementation — Runtime V2 edition.
 *
 * Usage: pd health [--workspace <path>] [--json]
 *
 * Reads workspace/.pd/state.db and workspace/.state/principle_training_state.json
 * to provide Runtime V2 health diagnostics.
 * Does NOT depend on openclaw-plugin source paths.
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface WorkspaceHealth {
  generatedAt: string;
  workspace: string;
  pdStateDb: { path: string; exists: boolean };
  ledger: { path: string; exists: boolean; totalPrinciples: number; byStatus: Record<string, number> };
  candidates: { total: number; consumed: number; pending: number };
  tasks: { total: number; byStatus: Record<string, number> };
  candidateLedgerConsistency: { status: 'ok' | 'degraded'; missing: number };
}

function loadLedger(ledgerPath: string): { principles: Record<string, unknown> } {
  if (!fs.existsSync(ledgerPath)) return { principles: {} };
  try {
    const content = fs.readFileSync(ledgerPath, 'utf8').trim();
    if (!content) return { principles: {} };
    const parsed = JSON.parse(content);
    return { principles: parsed._tree?.principles || {} };
  } catch {
    return { principles: {} };
  }
}

export async function handleHealth(): Promise<void> {
  const workspaceDir = (() => {
    try {
      return resolveWorkspaceDir();
    } catch {
      console.error('Error: No workspace directory configured. Set --workspace <path>, PD_WORKSPACE_DIR, or run from initialized workspace.');
      process.exit(1);
      return ''; // unreachable
    }
  })();

  const generatedAt = new Date().toISOString();
  const pdDbPath = path.join(workspaceDir, '.pd', 'state.db');
  const ledgerPath = path.join(workspaceDir, '.state', 'principle_training_state.json');

  // Load ledger
  const { principles: ledgerPrinciples } = loadLedger(ledgerPath);
  const principleEntries = Object.values(ledgerPrinciples);

  // Count by status in ledger
  const ledgerByStatus: Record<string, number> = {};
  for (const p of principleEntries) {
    const status = (p as { status?: string }).status || 'unknown';
    ledgerByStatus[status] = (ledgerByStatus[status] || 0) + 1;
  }

  // Load PD state.db metrics (SQLite)
  let candidatesTotal = 0, candidatesConsumed = 0, candidatesPending = 0;
  let tasksTotal = 0;
  const tasksByStatus: Record<string, number> = {};
  let pdDbExists = false;

  if (fs.existsSync(pdDbPath)) {
    pdDbExists = true;
    try {
      const db = Database(pdDbPath, { readonly: true });

      const cRow = db.prepare('SELECT COUNT(*) as total, status FROM principle_candidates GROUP BY status').all() as { total: number; status: string }[];
      for (const r of cRow) {
        candidatesTotal += r.total;
        if (r.status === 'consumed') candidatesConsumed = r.total;
        if (r.status === 'pending') candidatesPending = r.total;
      }

      const tRows = db.prepare('SELECT COUNT(*) as total, status FROM tasks GROUP BY status').all() as { total: number; status: string }[];
      for (const r of tRows) {
        tasksTotal += r.total;
        tasksByStatus[r.status] = r.total;
      }

      db.close();
    } catch {
      // DB accessible but query failed — continue with partial data
    }
  }

  // Check candidate/ledger consistency
  let missingLedgerCount = 0;
  if (pdDbExists) {
    try {
      const db = Database(pdDbPath, { readonly: true });
      const consumedRows = db.prepare("SELECT candidate_id FROM principle_candidates WHERE status = 'consumed'").all() as { candidate_id: string }[];
      for (const r of consumedRows) {
        const sourceRef = `candidate://${r.candidate_id}`;
        const found = principleEntries.some((p: unknown) => {
          const principle = p as { sourceRef?: string; derivedFromPainIds?: string[] };
          return principle.sourceRef === sourceRef ||
            (principle.derivedFromPainIds && principle.derivedFromPainIds.includes(r.candidate_id));
        });
        if (!found) missingLedgerCount++;
      }
      db.close();
    } catch {
      // ignore
    }
  }

  const health: WorkspaceHealth = {
    generatedAt,
    workspace: workspaceDir,
    pdStateDb: { path: pdDbPath, exists: pdDbExists },
    ledger: {
      path: ledgerPath,
      exists: fs.existsSync(ledgerPath),
      totalPrinciples: principleEntries.length,
      byStatus: ledgerByStatus,
    },
    candidates: {
      total: candidatesTotal,
      consumed: candidatesConsumed,
      pending: candidatesPending,
    },
    tasks: { total: tasksTotal, byStatus: tasksByStatus },
    candidateLedgerConsistency: {
      status: missingLedgerCount === 0 ? 'ok' : 'degraded',
      missing: missingLedgerCount,
    },
  };

  console.log(`generatedAt: ${health.generatedAt}`);
  console.log(`workspace: ${health.workspace}`);
  console.log(`pdStateDb.exists: ${health.pdStateDb.exists}`);
  console.log(`pdStateDb.path: ${health.pdStateDb.path}`);
  console.log(`ledger.exists: ${health.ledger.exists}`);
  console.log(`ledger.path: ${health.ledger.path}`);
  console.log(`ledger.totalPrinciples: ${health.ledger.totalPrinciples}`);
  console.log(`ledger.byStatus: ${JSON.stringify(health.ledger.byStatus)}`);
  console.log(`candidates.total: ${health.candidates.total}`);
  console.log(`candidates.consumed: ${health.candidates.consumed}`);
  console.log(`candidates.pending: ${health.candidates.pending}`);
  console.log(`tasks.total: ${health.tasks.total}`);
  console.log(`tasks.byStatus: ${JSON.stringify(health.tasks.byStatus)}`);
  console.log(`candidateLedgerConsistency.status: ${health.candidateLedgerConsistency.status}`);
  console.log(`candidateLedgerConsistency.missing: ${health.candidateLedgerConsistency.missing}`);
  console.log('');

  if (health.candidateLedgerConsistency.status === 'degraded') {
    console.warn('⚠️  Candidate/ledger consistency is DEGRADED. Run: pd candidate audit --workspace "' + workspaceDir + '" --json');
    console.warn('   To repair missing entries: pd candidate repair --candidate-id <id> --workspace "' + workspaceDir + '" --json');
  }
}
