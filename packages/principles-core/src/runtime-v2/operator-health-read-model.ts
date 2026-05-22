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
import { buildGfiWorkspaceSnapshot, classifyGfiWorkspaceHealth } from './gfi/gfi-read-model.js';
import type { GfiWorkspaceSnapshot } from './gfi/gfi-read-model.js';
import type { GfiSource } from './gfi/gfi-types.js';

// ── Thresholds ────────────────────────────────────────────────────────────────

const ORPHAN_DERIVED_CANDIDATE_COUNT_THRESHOLD = 10;

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
  gfi: GfiWorkspaceSnapshot;
  overallStatus: OverallHealthStatus;
  recommendedActions: string[];
  /** Total number of tasks in the workspace DB. Used to distinguish cold-start (0 tasks) from real degradation (tasks exist but no successful chain). */
  totalTaskCount: number;
}

export interface OperatorHealthReadModelOptions {
  workspaceDir: string;
  painChainReadModel?: PainChainReadModel;
  pruningReadModel?: PruningReadModel;
}

// ── Read model ───────────────────────────────────────────────────────────────

interface PersistedSession {
  sessionId: string;
  currentGfi: number;
  gfiBySource?: Partial<Record<GfiSource, number>>;
  lastErrorSource?: string;
  consecutiveErrors: number;
  lastGfiDecayAt?: number;
  dailyGfiPeak?: number;
  lastActivityAt: number;
}

function readPersistedSessions(workspaceDir: string): PersistedSession[] {
  const sessionDir = path.join(workspaceDir, '.state', 'sessions');

  if (!fs.existsSync(sessionDir)) {
    return [];
  }

  const sessions: PersistedSession[] = [];

  for (const file of fs.readdirSync(sessionDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(sessionDir, file), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.sessionId) {
        sessions.push({
          sessionId: parsed.sessionId ?? file.replace('.json', ''),
          currentGfi: parsed.currentGfi ?? 0,
          gfiBySource: parsed.gfiBySource,
          lastErrorSource: parsed.lastErrorSource,
          consecutiveErrors: parsed.consecutiveErrors ?? 0,
          lastGfiDecayAt: parsed.lastGfiDecayAt,
          dailyGfiPeak: parsed.dailyGfiPeak,
          lastActivityAt: parsed.lastActivityAt ?? parsed.lastControlActivityAt ?? 0,
        });
      }
    } catch {
      // skip malformed session files
    }
  }

  return sessions;
}

export class OperatorHealthReadModel {
  private readonly workspaceDir: string;
  private readonly injectedPainChainReadModel: PainChainReadModel | undefined;
  private readonly injectedPruningReadModel: PruningReadModel | undefined;
  private ownedPainChainReadModel: PainChainReadModel | null = null;
  private ownedPruningReadModel: PruningReadModel | null = null;

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

    // ── Pain chain read model (also used for task-count) ───────────────────
    const painChainReadModel = this.injectedPainChainReadModel
      ?? new PainChainReadModel({ workspaceDir: this.workspaceDir });

    if (!this.injectedPainChainReadModel) {
      this.ownedPainChainReadModel = painChainReadModel;
    }

    // ── Task count (for cold-start vs. real-degradation discrimination) ───
    let totalTaskCount = 0;
    try {
      totalTaskCount = await painChainReadModel.getTotalTaskCount();
    } catch {
      // graceful — task count stays 0
    }

    // ── Pain chain ────────────────────────────────────────────────────────
    let lastSuccessfulChain: PainChainTrace | null = null;
    let failureCategory: string | null = null;

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

    if (!this.injectedPruningReadModel) {
      this.ownedPruningReadModel = pruningReadModel;
    }

    try {
      const summary = pruningReadModel.getHealthSummary();
      ({ watchCount, reviewCount, orphanDerivedCandidateCount } = summary);
    } catch {
      // Graceful — pruning section stays zeroed
    }

    // ── GFI ───────────────────────────────────────────────────────────────
    const gfi: GfiWorkspaceSnapshot = (() => {
      try {
        const sessions = readPersistedSessions(this.workspaceDir);
        return buildGfiWorkspaceSnapshot({ sessions, nowMs: Date.now() });
      } catch {
        return {
          active: null,
          staleSessionCount: 0,
          staleGfiRange: null,
          totalSessionCount: 0,
          activeSessionCount: 0,
          generatedAt: new Date().toISOString(),
        };
      }
    })();

    // ── Compute overallStatus ─────────────────────────────────────────────
    const gfiHealth = classifyGfiWorkspaceHealth(gfi);
    let overallStatus: OverallHealthStatus = 'healthy';

    if (!dbExists || audit.status === 'error') {
      overallStatus = 'error';
    } else if (
      audit.status === 'degraded'
      || watchCount > 0
      || reviewCount > 0
      || orphanDerivedCandidateCount > ORPHAN_DERIVED_CANDIDATE_COUNT_THRESHOLD
      || gfiHealth.status === 'degraded'
      || (lastSuccessfulChain === null && totalTaskCount > 0)
    ) {
      overallStatus = 'degraded';
    }

    // ── Build recommendedActions ──────────────────────────────────────────
    if (!dbExists) {
      recommendedActions.push('Initialize workspace with `pd pain record`.');
    }

    if (audit.status === 'error' && dbExists) {
      recommendedActions.push('Candidate audit failed — check DB integrity with `pd candidate audit --workspace <path>`.');
    }

    if (audit.status === 'degraded') {
      recommendedActions.push('Run `pd candidate audit --workspace <path> --json` for details.');
    }

    if (watchCount > 0 || reviewCount > 0) {
      recommendedActions.push('Run `pd runtime pruning report --workspace <path> --json` for lifecycle signals.');
    }

    if (orphanDerivedCandidateCount > ORPHAN_DERIVED_CANDIDATE_COUNT_THRESHOLD) {
      recommendedActions.push(`High orphan-derived-candidate count (${orphanDerivedCandidateCount}) — run pruning to clean up.`);
    }

    if (gfiHealth.status === 'degraded') {
      recommendedActions.push(`GFI degraded: ${gfiHealth.reason} — run cleanup or investigate session lifecycle.`);
    }

    if (lastSuccessfulChain === null && dbExists && totalTaskCount > 0) {
      recommendedActions.push('Run `pd runtime uat --workspace <path> --count 3` to establish baseline.');
    }

    if (totalTaskCount === 0 && dbExists) {
      recommendedActions.push('Runtime V2 pipeline has never been exercised. Run `pd pain record --reason "test" --workspace <path>` to trigger the pain-to-principle chain.');
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
      gfi,
      overallStatus,
      recommendedActions,
      totalTaskCount,
    };
  }

  async close(): Promise<void> {
    if (this.ownedPainChainReadModel) {
      await this.ownedPainChainReadModel.close();
      this.ownedPainChainReadModel = null;
    }
    if (this.ownedPruningReadModel) {
      this.ownedPruningReadModel = null;
    }
  }
}
