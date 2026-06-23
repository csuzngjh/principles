/**
 * pd health command implementation — Runtime V2 edition.
 *
 * Usage: pd health [--workspace <path>] [--json]
 *
 * Reads workspace/.pd/state.db and workspace/.state/principle_training_state.json
 * to provide Runtime V2 health diagnostics.
 * Uses read models from @principles/core/runtime-v2 (no direct ledger access).
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { PruningReadModel, PainChainReadModel, auditCandidateLedgerConsistency } from '@principles/core/runtime-v2';
import type { PainChainTrace } from '@principles/core/runtime-v2';
import { getLedgerFilePathPublic } from '@principles/core/principle-tree-ledger';

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

function painChainTraceToLastSuccessfulChain(trace: PainChainTrace): LastSuccessfulChain {
  const totalMs = (trace.latencyMs.painToTask ?? 0)
    + (trace.latencyMs.taskToRun ?? 0)
    + (trace.latencyMs.runToArtifact ?? 0);

  return {
    painId: trace.painId,
    taskId: trace.taskId,
    runId: trace.runId ?? '',
    artifactId: trace.artifactId ?? '',
    candidateIds: trace.candidateIds,
    ledgerEntryIds: trace.ledgerEntryIds,
    latencyMs: { totalMs: totalMs > 0 ? totalMs : undefined },
    failureCategory: trace.failureCategory,
    checkedAt: trace.checkedAt,
  };
}

export async function handleHealth(opts: HealthOptions = {}): Promise<void> {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  const generatedAt = new Date().toISOString();
  const pdDbPath = path.join(workspaceDir, '.pd', 'state.db');
  const ledgerStateDir = path.join(workspaceDir, '.state');
  const ledgerPath = getLedgerFilePathPublic(ledgerStateDir);

  const pruningModel = new PruningReadModel({ workspaceDir });
  const healthSummary = pruningModel.getHealthSummary();
  const ledgerByStatus = healthSummary.byStatus;

  const { missingLedgerCount } = await auditCandidateLedgerConsistency(workspaceDir);

  let candidatesTotal = 0, candidatesConsumed = 0, candidatesPending = 0;
  let tasksTotal = 0;
  const tasksByStatus: Record<string, number> = {};
  let pdDbExists = false;
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
        totalPrinciples: healthSummary.totalPrinciples,
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

      const painChainModel = new PainChainReadModel({ workspaceDir });
      try {
        const chain = await painChainModel.getLastSuccessfulChain();
        if (chain) {
          lastSuccessfulChain = painChainTraceToLastSuccessfulChain(chain);
        }
      } catch {
        partialHealth = true;
      } finally {
        await painChainModel.close();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: could not read full state.db metrics — partial health data: ${msg}`);
      partialHealth = true;
    } finally {
      db.close();
    }
  }

  writeHealth();
}
