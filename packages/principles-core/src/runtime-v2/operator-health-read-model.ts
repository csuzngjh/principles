/**
 * OperatorHealthReadModel — composite read-only health snapshot for Runtime V2.
 *
 * Aggregates chain reliability, candidate/ledger consistency, and pruning
 * lifecycle signals into a single operator-facing snapshot.
 *
 * PRI-28: Operator health snapshot.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PainChainReadModel } from './pain-chain-read-model.js';
import type { PainChainTrace } from './pain-chain-read-model.js';
import { PruningReadModel } from './pruning-read-model.js';
import { auditCandidateLedgerConsistency } from './candidate-audit.js';
import type { CandidateAuditResult } from './candidate-audit.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type OverallHealthStatus = 'healthy' | 'degraded' | 'error';

export interface OperatorHealthSnapshot {
  generatedAt: string;
  workspace: string;
  painChain: {
    lastSuccessfulChain: PainChainTrace | null;
    failureCategory: string | null;
  };
  candidateLedger: {
    auditStatus: CandidateAuditResult['status'];
    orphanCandidateCount: number;
    missingLedgerCount: number;
  };
  pruning: {
    watchCount: number;
    reviewCount: number;
    orphanDerivedCandidateCount: number;
  };
  overallStatus: OverallHealthStatus;
  recommendedActions: string[];
}

export interface OperatorHealthReadModelOptions {
  workspaceDir: string;
  painChainReadModel?: PainChainReadModel;
  pruningReadModel?: PruningReadModel;
}

// ── Read model ───────────────────────────────────────────────────────────────

export class OperatorHealthReadModel {
  private readonly workspaceDir: string;
  private readonly injectedPainChainReadModel: PainChainReadModel | undefined;
  private readonly injectedPruningReadModel: PruningReadModel | undefined;
  private ownedPainChainReadModel: PainChainReadModel | null = null;

  constructor(opts: OperatorHealthReadModelOptions) {
    this.workspaceDir = opts.workspaceDir;
    this.injectedPainChainReadModel = opts.painChainReadModel;
    this.injectedPruningReadModel = opts.pruningReadModel;
  }

  async getSnapshot(): Promise<OperatorHealthSnapshot> {
    const generatedAt = new Date().toISOString();
    const recommendedActions: string[] = [];
    const pdDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    const dbExists = fs.existsSync(pdDbPath);

    // ── Candidate/ledger audit ────────────────────────────────────────────
    const audit: CandidateAuditResult = await auditCandidateLedgerConsistency(this.workspaceDir);

    // ── Pain chain ────────────────────────────────────────────────────────
    let lastSuccessfulChain: PainChainTrace | null = null;
    let failureCategory: string | null = null;

    const painChainReadModel = this.injectedPainChainReadModel
      ?? new PainChainReadModel({ workspaceDir: this.workspaceDir });

    if (!this.injectedPainChainReadModel) {
      this.ownedPainChainReadModel = painChainReadModel;
    }

    try {
      const chain = await painChainReadModel.getLastSuccessfulChain();
      lastSuccessfulChain = chain ?? null;
      failureCategory = chain?.failureCategory ?? null;
    } catch {
      // Graceful — chain section stays null
    }

    // ── Pruning ───────────────────────────────────────────────────────────
    let watchCount = 0;
    let reviewCount = 0;
    let orphanDerivedCandidateCount = 0;

    const pruningReadModel = this.injectedPruningReadModel
      ?? new PruningReadModel({ workspaceDir: this.workspaceDir });

    try {
      const summary = pruningReadModel.getHealthSummary();
      ({ watchCount, reviewCount, orphanDerivedCandidateCount } = summary);
    } catch {
      // Graceful — pruning section stays zeroed
    }

    // ── Compute overallStatus ─────────────────────────────────────────────
    let overallStatus: OverallHealthStatus = 'healthy';

    if (!dbExists || audit.status === 'error') {
      overallStatus = 'error';
    } else if (
      audit.status === 'degraded'
      || watchCount > 0
      || reviewCount > 0
      || lastSuccessfulChain === null
    ) {
      overallStatus = 'degraded';
    }

    // ── Build recommendedActions ──────────────────────────────────────────
    if (!dbExists) {
      recommendedActions.push('Initialize workspace with `pd pain record`.');
    }

    if (audit.status === 'degraded') {
      recommendedActions.push('Run `pd candidate audit --workspace <path> --json` for details.');
    }

    if (watchCount > 0 || reviewCount > 0) {
      recommendedActions.push('Run `pd runtime pruning report --workspace <path> --json` for lifecycle signals.');
    }

    if (lastSuccessfulChain === null && dbExists) {
      recommendedActions.push('Run `pd runtime uat --workspace <path> --count 3` to establish baseline.');
    }

    return {
      generatedAt,
      workspace: this.workspaceDir,
      painChain: { lastSuccessfulChain, failureCategory },
      candidateLedger: {
        auditStatus: audit.status,
        orphanCandidateCount: audit.orphanCandidateCount,
        missingLedgerCount: audit.missingLedgerCount,
      },
      pruning: { watchCount, reviewCount, orphanDerivedCandidateCount },
      overallStatus,
      recommendedActions,
    };
  }

  async close(): Promise<void> {
    if (this.ownedPainChainReadModel) {
      await this.ownedPainChainReadModel.close();
      this.ownedPainChainReadModel = null;
    }
  }
}
