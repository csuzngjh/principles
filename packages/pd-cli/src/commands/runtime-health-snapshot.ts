/**
 * pd runtime health snapshot command — Operator health snapshot for Runtime V2.
 *
 * Usage:
 *   pd runtime health snapshot --workspace <path> --json
 *
 * Aggregates chain reliability, candidate/ledger consistency, and pruning
 * lifecycle signals into a single operator-facing read-only snapshot.
 *
 * PRI-28: Operator health snapshot.
 */
import * as path from 'path';
import { OperatorHealthReadModel } from '@principles/core/runtime-v2';
import type { OperatorHealthSnapshot } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface HealthSnapshotOptions {
  workspace?: string;
  json?: boolean;
}

function formatTextOutput(snapshot: OperatorHealthSnapshot): string {
  const lines: string[] = [];
  const statusIcon = snapshot.overallStatus === 'healthy' ? '✓' : '✗';

  lines.push(`Operator Health Snapshot`);
  lines.push(`generatedAt: ${snapshot.generatedAt}`);
  lines.push(`workspace:   ${snapshot.workspace}`);
  lines.push('');
  lines.push(`OVERALL: ${statusIcon} ${snapshot.overallStatus.toUpperCase()}`);
  lines.push('');

  // Pain chain
  lines.push('painChain:');
  if (snapshot.painChain.lastSuccessfulChain) {
    const c = snapshot.painChain.lastSuccessfulChain;
    lines.push(`  lastChain: ${c.painId} → ${c.taskId} → ${c.runId ?? '-'} → ${c.artifactId ?? '-'}`);
    lines.push(`  candidates: ${c.candidateIds.length}, ledgerEntries: ${c.ledgerEntryIds.length}`);
  } else {
    lines.push('  lastChain: (none)');
  }
  lines.push('');

  // Candidate/ledger
  lines.push('candidateLedger:');
  lines.push(`  status: ${snapshot.candidateLedger.auditStatus}`);
  if (snapshot.candidateLedger.missingLedgerCount > 0) {
    lines.push(`  missingLedger: ${snapshot.candidateLedger.missingLedgerCount}`);
  }
  lines.push('');

  // Pruning
  lines.push('pruning:');
  lines.push(`  watchCount: ${snapshot.pruning.watchCount}, reviewCount: ${snapshot.pruning.reviewCount}`);
  if (snapshot.pruning.orphanDerivedCandidateCount > 0) {
    lines.push(`  orphanDerivedCandidates: ${snapshot.pruning.orphanDerivedCandidateCount}`);
  }
  lines.push('');

  // GFI
  if (snapshot.gfi.active) {
    const g = snapshot.gfi.active;
    lines.push(`gfi: stage=${g.stage} currentGfi=${g.currentGfi} dominantSource=${g.dominantSource ?? '-'} sessions=${snapshot.gfi.activeSessionCount}active/${snapshot.gfi.staleSessionCount}stale`);
  } else {
    lines.push('gfi: (no active sessions)');
  }
  lines.push('');

  // Actions
  if (snapshot.recommendedActions.length === 0) {
    lines.push('No actions recommended.');
  } else {
    lines.push('Recommended actions:');
    for (const action of snapshot.recommendedActions) {
      lines.push(`  [!] ${action}`);
    }
  }

  return lines.join('\n');
}

export async function handleRuntimeHealthSnapshot(opts: HealthSnapshotOptions): Promise<void> {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  const model = new OperatorHealthReadModel({ workspaceDir });

  try {
    const snapshot = await model.getSnapshot();

    if (opts.json) {
      console.log(JSON.stringify(snapshot, null, 2));
    } else {
      console.log(formatTextOutput(snapshot));
    }

    if (snapshot.overallStatus !== 'healthy') {
      if (!opts.json) {
        console.error('');
        console.error(`FAIL: overallStatus=${snapshot.overallStatus}`);
      }
      process.exitCode = 1;
    }
  } finally {
    await model.close();
  }
}
