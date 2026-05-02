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
import { loadLedger, getLedgerFilePathPublic } from '@principles/core/runtime-v2';

interface LastSuccessfulChain {
  painId?: string;
  taskId: string;
  runId: string;
  artifactId: string;
  candidateIds: string[];
  ledgerEntryIds: string[];
  latencyMs?: { totalMs?: number };
  failureCategory: string | null;
  checkedAt: string;
}

interface WorkspaceHealth {
  generatedAt: string;
  workspace: string;
  partialHealth?: boolean;
  pdStateDb: { path: string; exists: boolean };
  ledger: { path: string; exists: boolean; totalPrinciples: number; byStatus: Record<string, number> };
  candidates: { total: number; consumed: number; pending: number };
  tasks: { total: number; byStatus: Record<string, number> };
  candidateLedgerConsistency: { status: 'ok' | 'degraded'; missing: number };
  lastSuccessfulChain?: LastSuccessfulChain;
}

interface HealthOptions {
  workspace?: string;
  json?: boolean;
}

export async function handleHealth(opts: HealthOptions = {}): Promise<void> {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  const generatedAt = new Date().toISOString();
  const pdDbPath = path.join(workspaceDir, '.pd', 'state.db');
  const ledgerStateDir = path.join(workspaceDir, '.state');
  const ledgerPath = getLedgerFilePathPublic(ledgerStateDir);

  // Load ledger
  const ledger = loadLedger(ledgerStateDir);
  const principleEntries = Object.values(ledger.tree.principles);

  // Count by status in ledger
  const ledgerByStatus: Record<string, number> = {};
  for (const p of principleEntries) {
    const status = (p as { status?: string }).status || 'unknown';
    ledgerByStatus[status] = (ledgerByStatus[status] || 0) + 1;
  }

  // Build candidateId → ledgerEntryId reverse map once
  const candidateToLedgerEntry = new Map<string, string>();
  for (const entry of principleEntries) {
    const e = entry as { id: string; derivedFromPainIds?: string[] };
    for (const cid of e.derivedFromPainIds ?? []) {
      candidateToLedgerEntry.set(cid, e.id);
    }
  }

  // Load PD state.db metrics
  let candidatesTotal = 0, candidatesConsumed = 0, candidatesPending = 0;
  let tasksTotal = 0;
  const tasksByStatus: Record<string, number> = {};
  let pdDbExists = false;
  let missingLedgerCount = 0;
  let lastSuccessfulChain: LastSuccessfulChain | undefined = undefined;
  let partialHealth = false;

  function buildHealth(): WorkspaceHealth {
    return {
      generatedAt,
      workspace: workspaceDir,
      partialHealth,
      pdStateDb: { path: pdDbPath, exists: pdDbExists },
      ledger: {
        path: ledgerPath,
        exists: fs.existsSync(ledgerPath),
        totalPrinciples: principleEntries.length,
        byStatus: ledgerByStatus,
      },
      candidates: { total: candidatesTotal, consumed: candidatesConsumed, pending: candidatesPending },
      tasks: { total: tasksTotal, byStatus: tasksByStatus },
      candidateLedgerConsistency: {
        status: missingLedgerCount === 0 ? 'ok' : 'degraded',
        missing: missingLedgerCount,
      },
      lastSuccessfulChain,
    };
  }

  function writeHealth(): void {
    const health = buildHealth();

    if (opts.json) {
      console.log(JSON.stringify(health, null, 2));
      if (health.candidateLedgerConsistency.status === 'degraded') process.exit(1);
      return;
    }

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
    if (health.lastSuccessfulChain) {
      console.log('lastSuccessfulChain:');
      console.log(`  taskId:       ${health.lastSuccessfulChain.taskId}`);
      console.log(`  runId:        ${health.lastSuccessfulChain.runId}`);
      console.log(`  artifactId:   ${health.lastSuccessfulChain.artifactId}`);
      console.log(`  candidateIds: ${health.lastSuccessfulChain.candidateIds.join(', ')}`);
      console.log(`  ledgerEntries: ${health.lastSuccessfulChain.ledgerEntryIds.join(', ')}`);
    }
    console.log('');

    if (health.candidateLedgerConsistency.status === 'degraded') {
      console.warn('⚠️  Candidate/ledger consistency is DEGRADED. Run: pd candidate audit --workspace "' + workspaceDir + '" --json');
      console.warn('   To repair missing entries: pd candidate repair --candidate-id <id> --workspace "' + workspaceDir + '" --json');
      process.exit(1);
    }
  }

  if (fs.existsSync(pdDbPath)) {
    pdDbExists = true;
    const db = Database(pdDbPath, { readonly: true });
    try {
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

      // Candidate/ledger consistency check
      const consumedRows = db.prepare("SELECT candidate_id FROM principle_candidates WHERE status = 'consumed'").all() as { candidate_id: string }[];
      for (const r of consumedRows) {
        if (!candidateToLedgerEntry.has(r.candidate_id)) missingLedgerCount++;
      }

      // Last successful chain query — graceful degradation if schema incomplete
      const lastSucceeded = db.prepare(
        "SELECT task_id, input_ref, created_at FROM tasks WHERE status = 'succeeded' ORDER BY updated_at DESC LIMIT 1"
      ).get() as { task_id: string; input_ref: string | null; created_at: string } | undefined;
      if (!lastSucceeded) { db.close(); writeHealth(); return; }

      const run = db.prepare(
        "SELECT run_id FROM runs WHERE task_id = ? AND execution_status = 'succeeded' ORDER BY started_at DESC LIMIT 1"
      ).get(lastSucceeded.task_id) as { run_id: string } | undefined;
      if (!run) { db.close(); writeHealth(); return; }

      const artifacts = db.prepare(
        "SELECT artifact_id, created_at FROM artifacts WHERE run_id = ? ORDER BY created_at DESC LIMIT 1"
      ).get(run.run_id) as { artifact_id: string; created_at: string } | undefined;
      if (!artifacts) { db.close(); writeHealth(); return; }

      const candidates = db.prepare(
        "SELECT candidate_id FROM principle_candidates WHERE artifact_id = ?"
      ).all(artifacts.artifact_id) as { candidate_id: string }[];
      if (candidates.length === 0) { db.close(); writeHealth(); return; }

      const ledgerEntryIds: string[] = [];
      for (const c of candidates) {
        const entryId = candidateToLedgerEntry.get(c.candidate_id);
        if (entryId) ledgerEntryIds.push(entryId);
      }

      lastSuccessfulChain = {
        painId: lastSucceeded.input_ref ?? undefined,
        taskId: lastSucceeded.task_id,
        runId: run.run_id,
        artifactId: artifacts.artifact_id,
        candidateIds: candidates.map(c => c.candidate_id),
        ledgerEntryIds,
        latencyMs: {
          totalMs: lastSucceeded.created_at
            ? Math.max(0, new Date(artifacts.created_at).getTime() - new Date(lastSucceeded.created_at).getTime())
            : undefined,
        },
        failureCategory: null,
        checkedAt: generatedAt,
      };
    } catch (err) {
      // Schema mismatch or transient SQLite error — emit partial health report
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: could not read full state.db metrics — partial health data: ${msg}`);
      partialHealth = true;
    } finally {
      db.close();
    }
  }

  writeHealth();
}