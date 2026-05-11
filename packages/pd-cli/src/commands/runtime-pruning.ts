/**
 * pd runtime pruning report command — non-destructive pruning metrics.
 *
 * Usage: pd runtime pruning report [--workspace <path>] [--json]
 *
 * Delegates to PruningReadModel (core).
 */

import * as path from 'path';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { PruningReadModel, appendPruningReview, listPruningReviews, buildMaskedPrincipleSet, loadLedger, saveLedger } from '@principles/core/runtime-v2';
import type { PruningReviewDecision, OrphanDerivedCandidate, OrphanDetectionResult } from '@principles/core/runtime-v2';
import { createRemediationResult, remediationAction } from './remediation-output.js';
import type { RemediationResult } from './remediation-output.js';

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
  decision: PruningReviewDecision;
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
    return; // satisfies TypeScript control flow (process.exit is [noreturn] in tests)
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

// ── Pruning rollback ──────────────────────────────────────────────────────────

export interface PruningRollbackOptions {
  principleId: string;
  note?: string;
  reviewer?: string;
  workspace?: string;
  json?: boolean;
}

export function handlePruningRollback(opts: PruningRollbackOptions): void {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  const reviews = listPruningReviews(workspaceDir, { principleId: opts.principleId });
  if (reviews.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ error: `No reviews found for principle: '${opts.principleId}'` }));
    } else {
      console.error(`Error: No reviews found for principle: '${opts.principleId}'`);
    }
    process.exit(1);
    return;
  }

  const maskedIds = buildMaskedPrincipleSet(reviews);
  if (!maskedIds.has(opts.principleId)) {
    if (opts.json) {
      console.log(JSON.stringify({ error: `Principle '${opts.principleId}' is not currently masked (latest decision is not archive-candidate)` }));
    } else {
      console.error(`Error: Principle '${opts.principleId}' is not currently masked (latest decision is not archive-candidate)`);
    }
    process.exit(1);
    return;
  }

  const model = new PruningReadModel({ workspaceDir });
  const signals = model.getPrincipleSignals();
  const signal = signals.find((s) => s.principleId === opts.principleId) ?? undefined;

  const record = appendPruningReview(workspaceDir, {
    principleId: opts.principleId,
    decision: 'keep',
    note: opts.note ?? 'Rollback: restore principle injection',
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
  console.log('Principle has been restored to injection.');
}

// ── Pruning orphans ───────────────────────────────────────────────────────────

export interface PruningOrphansOptions {
  workspace?: string;
  dryRun?: boolean;
  confirm?: boolean;
  json?: boolean;
}

function orphanActions(orphans: OrphanDerivedCandidate[]) {
  return orphans.map((orphan) => remediationAction({
    action: 'remove_orphan_reference',
    targetId: orphan.candidateId,
    previousState: orphan.status ?? 'unknown',
    nextState: 'removed_from_ledger_reference',
    reason: `${orphan.reason} (principle: ${orphan.principleId})`,
  }));
}

export function handlePruningOrphans(opts: PruningOrphansOptions): void {
  if (opts.dryRun && opts.confirm) {
    console.error('Error: --dry-run and --confirm are mutually exclusive');
    process.exit(1);
  }

  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : resolveWorkspaceDir();

  const model = new PruningReadModel({ workspaceDir });
  const detection: OrphanDetectionResult = model.getOrphanDerivedCandidates();
  const orphans = detection.candidates;
  const isDryRun = !opts.confirm;

  if (isDryRun) {
    const result: RemediationResult = createRemediationResult({
      mode: 'dry_run',
      repairedCount: 0,
      skippedCount: 0,
      actions: orphanActions(orphans),
      warnings: detection.dbReadable ? [] : ['state.db is unreadable; --confirm will be refused until DB access is restored.'],
      safeToConfirm: detection.dbReadable && orphans.length > 0,
      includeLegacyDryRun: true,
    });

    if (opts.json) {
      console.log(JSON.stringify({
        ...result,
        orphanDerivedCandidateCount: orphans.length,
        candidates: orphans,
        dbReadable: detection.dbReadable,
      }, null, 2));
      return;
    }

    console.log(`orphanDerivedCandidateCount: ${orphans.length}`);
    console.log(`dryRun: true`);
    console.log(`dbReadable: ${detection.dbReadable}`);
    console.log('');
    if (!detection.dbReadable) {
      console.log('⚠️  state.db is unreadable — orphan list may include valid candidates.');
      console.log('   --confirm will be refused until the DB is accessible.');
      console.log('');
    }
    if (orphans.length === 0) {
      console.log('No orphan derived candidates found.');
    } else {
      console.log('── Orphan derived candidates ──');
      for (const o of orphans) {
        console.log(`  [${o.status ?? 'unknown'}] ${o.candidateId} → principle: ${o.principleId}`);
        console.log(`    ↳ ${o.reason}`);
      }
      console.log('');
      console.log('NOTE: This is a dry-run. No data was modified. Use --confirm to remove orphan references.');
    }
    return;
  }

  if (!detection.dbReadable) {
    const result: RemediationResult = createRemediationResult({
      mode: 'confirm',
      status: 'refused',
      safeToConfirm: false,
      repairedCount: 0,
      skippedCount: orphans.length,
      actions: orphanActions(orphans),
      warnings: ['state.db is unreadable; refusing orphan cleanup because candidates cannot be verified.'],
      includeLegacyDryRun: true,
    });

    if (opts.json) {
      console.log(JSON.stringify({
        ...result,
        orphanDerivedCandidateCount: orphans.length,
        candidates: orphans,
        dbReadable: false,
      }, null, 2));
    } else {
      console.error('❌ REFUSED: state.db is unreadable — cannot safely confirm orphan cleanup.');
      console.error('   All derivedFromPainIds would appear as orphans when the DB is inaccessible.');
      console.error('   Fix the DB access issue and re-run.');
    }
    process.exit(1);
    return;
  }

  const orphanIdsByPrinciple = new Map<string, Set<string>>();
  for (const o of orphans) {
    if (!orphanIdsByPrinciple.has(o.principleId)) {
      orphanIdsByPrinciple.set(o.principleId, new Set());
    }
    orphanIdsByPrinciple.get(o.principleId)?.add(o.candidateId);
  }

  const stateDir = path.join(workspaceDir, '.state');
  const ledger = loadLedger(stateDir);
  const removedFromPrinciples: { principleId: string; removedIds: string[] }[] = [];

  // Deep clone ledger to avoid mutating the loaded object (immutability requirement)
  const nextLedger = JSON.parse(JSON.stringify(ledger)) as typeof ledger;

  for (const [principleId, orphanIds] of orphanIdsByPrinciple) {
    const entry = nextLedger.tree.principles[principleId];
    if (!entry) continue;

    const originalIds = entry.derivedFromPainIds ?? [];
    const orphanIdSet = orphanIds;
    const filteredIds = originalIds.filter((id: string) => !orphanIdSet.has(id));

    if (filteredIds.length !== originalIds.length) {
      entry.derivedFromPainIds = filteredIds;
      removedFromPrinciples.push({
        principleId,
        removedIds: originalIds.filter((id: string) => orphanIdSet.has(id)),
      });
    }
  }

  if (removedFromPrinciples.length > 0) {
    try {
      saveLedger(stateDir, nextLedger);
    } catch (err) {
      console.error(`❌ Failed to save ledger: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
      return;
    }
  }

  const removedCount = removedFromPrinciples.reduce((sum, item) => sum + item.removedIds.length, 0);
  const result: RemediationResult = createRemediationResult({
    mode: 'confirm',
    repairedCount: removedCount,
    skippedCount: Math.max(0, orphans.length - removedCount),
    actions: orphanActions(orphans),
    warnings: [],
    includeLegacyDryRun: true,
  });

  if (opts.json) {
    console.log(JSON.stringify({
      ...result,
      orphanDerivedCandidateCount: orphans.length,
      candidates: orphans,
      dbReadable: true,
      removedFromPrinciples,
    }, null, 2));
    return;
  }

  console.log(`orphanDerivedCandidateCount: ${orphans.length}`);
  console.log(`dryRun: false`);
  console.log('');
  for (const r of removedFromPrinciples) {
    console.log(`principle: ${r.principleId}`);
    console.log(`  removed: ${r.removedIds.join(', ')}`);
  }
  console.log('');
  console.log(`${removedFromPrinciples.length} principles updated. ${orphans.length} orphan references removed.`);
}
