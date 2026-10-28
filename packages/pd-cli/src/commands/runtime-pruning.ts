/**
 * pd runtime pruning report command — non-destructive pruning metrics.
 *
 * Usage: pd runtime pruning report [--workspace <path>] [--json]
 *
 * Delegates to PruningReadModel (core).
 */

import * as path from 'path';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { PruningReadModel, removeOrphanReferencesFromLedger } from '@principles/core/runtime-v2';
import type { OrphanDerivedCandidate, OrphanDetectionResult } from '@principles/core/runtime-v2';
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
  const removedFromPrinciples = (() => {
    try {
      return removeOrphanReferencesFromLedger(stateDir, orphanIdsByPrinciple);
    } catch (err) {
      console.error(`❌ Failed to save ledger: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
      return [] as { principleId: string; removedIds: string[] }[];
    }
  })();

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
