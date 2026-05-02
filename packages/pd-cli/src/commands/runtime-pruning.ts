/**
 * pd runtime pruning report command — non-destructive pruning metrics.
 *
 * Usage: pd runtime pruning report [--workspace <path>] [--json]
 *
 * Delegates to PruningReadModel (core).
 */

import * as path from 'path';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { PruningReadModel, appendPruningReview } from '@principles/core/runtime-v2';

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

// ── Pruning explain ────────────────────────────────────────────────────────────

export interface PruningExplainOptions {
  principleId: string;
  workspace?: string;
  json?: boolean;
}

export interface PruningReviewOptions {
  principleId: string;
  decision: string;
  note?: string;
  reviewer?: string;
  workspace?: string;
  json?: boolean;
}

export function handlePruningReview(opts: PruningReviewOptions): void {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  const model = new PruningReadModel({ workspaceDir });
  const signals = model.getPrincipleSignals();

  const signal = signals.find((s) => s.principleId === opts.principleId);

  if (!signal) {
    if (opts.json) {
      console.log(JSON.stringify({ error: `Principle not found: '${opts.principleId}'` }));
    } else {
      console.error(`Error: Principle not found: '${opts.principleId}'`);
    }
    process.exit(1);
    return;
  }

  if (opts.decision !== 'keep' && opts.decision !== 'defer' && opts.decision !== 'archive-candidate') {
    if (opts.json) {
      console.log(JSON.stringify({ error: `Invalid decision: '${opts.decision}'. Must be one of: keep, defer, archive-candidate` }));
    } else {
      console.error(`Error: Invalid decision: '${opts.decision}'. Must be one of: keep, defer, archive-candidate`);
    }
    process.exit(1);
    return;
  }

  if (opts.decision === 'archive-candidate' && !opts.note) {
    if (opts.json) {
      console.log(JSON.stringify({ error: 'archive-candidate decision requires --note' }));
    } else {
      console.error('Error: archive-candidate decision requires --note');
    }
    process.exit(1);
    return;
  }

  const record = appendPruningReview(workspaceDir, {
    principleId: signal.principleId,
    decision: opts.decision,
    note: opts.note ?? '',
    reviewer: opts.reviewer,
    signalSnapshot: signal,
  });

  if (opts.json) {
    console.log(JSON.stringify({
      reviewId: record.reviewId,
      principleId: record.principleId,
      decision: record.decision,
      reviewer: record.reviewer,
      reviewedAt: record.reviewedAt,
    }));
    return;
  }

  console.log(`reviewId: ${record.reviewId}`);
  console.log(`principleId: ${record.principleId}`);
  console.log(`decision: ${record.decision}`);
  console.log(`reviewer: ${record.reviewer}`);
  console.log(`reviewedAt: ${record.reviewedAt}`);
  console.log('');
  console.log('NOTE: This audit record does not modify the principle.');
}

export function handlePruningExplain(opts: PruningExplainOptions): void {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  const model = new PruningReadModel({ workspaceDir });
  const signals = model.getPrincipleSignals();
  const now = new Date().toISOString();

  const signal = signals.find((s) => s.principleId === opts.principleId);

  if (!signal) {
    if (opts.json) {
      console.log(JSON.stringify({ error: `Principle not found: '${opts.principleId}'`, workspace: workspaceDir, generatedAt: now }, null, 2));
    } else {
      console.error(`Error: Principle not found: '${opts.principleId}'`);
    }
    process.exit(1);
    return; // unreachable but satisfies TypeScript
  }

  if (opts.json) {
    console.log(JSON.stringify({ workspace: workspaceDir, principleId: signal.principleId, signal, generatedAt: now }, null, 2));
    return;
  }

  console.log(`principleId: ${signal.principleId}`);
  console.log(`status: ${signal.status}`);
  console.log(`riskLevel: ${signal.riskLevel}`);
  console.log(`ageDays: ${signal.ageDays}`);
  console.log(`derivedPainCount: ${signal.derivedPainCount}`);
  console.log(`matchedCandidateCount: ${signal.matchedCandidateCount}`);
  console.log(`orphanCandidateCount: ${signal.orphanCandidateCount}`);
  console.log(`reasons:`);
  for (const r of signal.reasons) {
    console.log(`  ${r}`);
  }
  console.log('');
  console.log('NOTE: This report is read-only. No principles are modified or deleted.');
}
