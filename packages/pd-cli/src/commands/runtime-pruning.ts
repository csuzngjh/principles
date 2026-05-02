/**
 * pd runtime pruning report command — non-destructive pruning metrics.
 *
 * Usage: pd runtime pruning report [--workspace <path>] [--json]
 *
 * Delegates to PruningReadModel (core).
 */

import * as path from 'path';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { PruningReadModel } from '@principles/core/runtime-v2';

interface PruningReportOptions {
  workspace?: string;
  json?: boolean;
}

function outputText(
  summary: ReturnType<PruningReadModel['getHealthSummary']>,
  signals: ReturnType<PruningReadModel['getPrincipleSignals']>,
  workspaceDir: string,
): void {
  console.log(`generatedAt: ${summary.generatedAt}`);
  console.log(`workspace: ${workspaceDir}`);
  console.log(`totalPrinciples: ${summary.totalPrinciples}`);
  console.log(`byStatus: ${JSON.stringify(summary.byStatus)}`);
  console.log(`orphanDerivedCandidateCount: ${summary.orphanDerivedCandidateCount}`);
  console.log(`averageAgeDays: ${summary.averageAgeDays}`);
  console.log('');
  console.log(`watchCount: ${summary.watchCount}`);
  console.log(`reviewCount: ${summary.reviewCount}`);

  if (summary.watchCount > 0) {
    console.log('');
    console.log('── Principles flagged WATCH ──');
    for (const s of signals) {
      if (s.riskLevel === 'watch') {
        console.log(`  [${s.status}] ${s.principleId} (age: ${s.ageDays}d, derivedPainCount: ${s.derivedPainCount})`);
        for (const r of s.reasons) {
          console.log(`    ↳ ${r}`);
        }
      }
    }
  }

  if (summary.reviewCount > 0) {
    console.log('');
    console.log('── Principles flagged REVIEW ──');
    for (const s of signals) {
      if (s.riskLevel === 'review') {
        console.log(`  [${s.status}] ${s.principleId} (age: ${s.ageDays}d, derivedPainCount: ${s.derivedPainCount})`);
        for (const r of s.reasons) {
          console.log(`    ↳ ${r}`);
        }
      }
    }
  }

  if (summary.watchCount === 0 && summary.reviewCount === 0) {
    console.log('');
    console.log('No watch or review signals. System is healthy.');
  }

  console.log('');
  console.log('NOTE: This report is read-only. No principles are modified or deleted.');
}

export function handlePruningReport(opts: PruningReportOptions): void {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  const model = new PruningReadModel({ workspaceDir });
  const signals = model.getPrincipleSignals();
  const summary = model.getHealthSummary();

  if (opts.json) {
    console.log(JSON.stringify({ generatedAt: summary.generatedAt, workspace: workspaceDir, summary, signals }, null, 2));
    return;
  }

  outputText(summary, signals, workspaceDir);
}
