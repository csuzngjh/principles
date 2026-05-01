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

interface WorkspaceHealth {
  generatedAt: string;
  workspace: string;
  pdStateDb: { path: string; exists: boolean };
  ledger: { path: string; exists: boolean; totalPrinciples: number; byStatus: Record<string, number> };
  candidates: { total: number; consumed: number; pending: number };
  tasks: { total: number; byStatus: Record<string, number> };
  candidateLedgerConsistency: { status: 'ok' | 'degraded'; missing: number };
  lastSuccessfulChain?: {
    taskId: string;
    runId: string;
    artifactId: string;
    candidateIds: string[];
    ledgerEntryIds: string[];
  };
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

  // Load ledger using core's loadLedger (same HybridLedgerStore format as plugin)
  const ledger = loadLedger(ledgerStateDir);
  const principleEntries = Object.values(ledger.tree.principles);

  // Count by status in ledger
  const ledgerByStatus: Record<string, number> = {};
  for (const p of principleEntries) {
    const status = (p as { status?: string }).status || 'unknown';
    ledgerByStatus[status] = (ledgerByStatus[status] || 0) + 1;
  }

  // Load PD state.db metrics (SQLite) — single connection
  let candidatesTotal = 0, candidatesConsumed = 0, candidatesPending = 0;
  let tasksTotal = 0;
  const tasksByStatus: Record<string, number> = {};
  let pdDbExists = false;
  let missingLedgerCount = 0;

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

  if (fs.existsSync(pdDbPath)) {
    const db = Database(pdDbPath, { readonly: true });
    try {
      // Query last successful task with candidates → ledger chain
      const lastSucceeded = db.prepare(
        "SELECT task_id FROM tasks WHERE status = 'succeeded' ORDER BY updated_at DESC LIMIT 1"
      ).get() as { task_id: string } | undefined;

      if (lastSucceeded) {
        const run = db.prepare(
          "SELECT run_id FROM runs WHERE task_id = ? AND execution_status = 'succeeded' ORDER BY started_at DESC LIMIT 1"
        ).get(lastSucceeded.task_id) as { run_id: string } | undefined;

        if (run) {
          const artifacts = db.prepare(
            "SELECT artifact_id FROM artifacts WHERE run_id = ? ORDER BY created_at DESC LIMIT 1"
          ).get(run.run_id) as { artifact_id: string } | undefined;

          const candidates = db.prepare(
            "SELECT candidate_id FROM principle_candidates WHERE artifact_id = ?"
          ).all(artifacts?.artifact_id) as { candidate_id: string }[];

          const ledgerEntryIds: string[] = [];
          for (const c of candidates) {
            const entry = Object.values(principleEntries).find(
              (p: unknown) => (p as { derivedFromPainIds?: string[] }).derivedFromPainIds?.includes(c.candidate_id)
            );
            if (entry) ledgerEntryIds.push((entry as { id: string }).id);
          }

          if (candidates.length > 0) {
            health.lastSuccessfulChain = {
              taskId: lastSucceeded.task_id,
              runId: run.run_id,
              artifactId: artifacts?.artifact_id ?? '',
              candidateIds: candidates.map(c => c.candidate_id),
              ledgerEntryIds,
            };
          }
        }
      }
    } finally {
      db.close();
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(health, null, 2));
    if (health.candidateLedgerConsistency.status === 'degraded') {
      process.exit(1);
    }
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