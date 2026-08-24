/**
 * Governance Experience Snapshot collector — PRI-585 (SPEC v1.5.1).
 *
 * Batch source reader for the read-only governance experience layer:
 *   Batch Source Reader (4 queries + 1 ledger read + 1 config read, once)
 *     → group facts in memory per principle (GovernanceProjectionCollector.buildFacts)
 *     → deriveOwnerGovernanceView() per principle (existing projection, zero duplication)
 *     → deriveGovernanceExperienceSnapshot() aggregate (principles-core pure function)
 *
 * Forbidden by SPEC and absent here: `for (principle) { collect() }` — the four
 * table reads happen exactly once per snapshot regardless of principle count.
 * The snapshot explains; it never authorizes (ERR-102).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  deriveGovernanceExperienceSnapshot,
  deriveOwnerGovernanceView,
} from '@principles/core/runtime-v2';
import type {
  DataQualityIssue,
  GovernanceExperienceInputs,
  GovernanceExperienceSnapshot,
  GovernanceFacts,
  OwnerConfigSnapshot,
  SourceAvailabilityInput,
  SourceRef,
  UnlinkedRecordGroup,
} from '@principles/core/runtime-v2';
import {
  GovernanceProjectionCollector,
  type GovernanceProjectionTables,
  type ValidTaskRow,
} from './GovernanceProjectionCollector.js';
import { loadPdConfig } from '../config/pd-config-store.js';

const EMPTY_TABLES: GovernanceProjectionTables = { artifactRows: [], taskRows: [], approvalRows: [], activationRows: [] };
const UNLINKED_SAMPLE_LIMIT = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readOwnString(record: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Stable, path-safe workspace hash for snapshotId (SPEC §13): never exposes the
 * raw path and is never persisted. Windows normalization: backslashes become
 * forward slashes and the drive letter is case-folded, so `D:\a\b`, `d:/a/b/`
 * and `D:/a/b` hash identically. POSIX path case is intentionally preserved.
 */
export function hashWorkspacePath(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir).replace(/\\/g, '/').replace(/\/+$/, '');
  const normalized = resolved.replace(/([A-Za-z]):/, (match, _drive: string) => match.toUpperCase());
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export interface GovernanceExperienceCollectOptions {
  ownerConfig: OwnerConfigSnapshot;
  /** ISO-8601 UTC timestamp; defaults to now. Injected by tests for determinism. */
  asOf?: string;
  /** Test seam for the query-budget contract; production always reads via GovernanceProjectionCollector.readTables. */
  tableReader?: (workspaceDir: string) => GovernanceProjectionTables;
}

interface LedgerScan {
  available: boolean;
  reasonCode?: string;
  /** All principle ids present in the ledger tree (valid or not). */
  presentPrincipleIds: Set<string>;
  facts: Map<string, GovernanceFacts['principle']>;
  issuesByPrinciple: Map<string, DataQualityIssue[]>;
  invalidPrincipleRefs: SourceRef[];
}

export class GovernanceExperienceCollector {
  constructor(private readonly workspaceDir: string) {}

  collectSnapshot(options: GovernanceExperienceCollectOptions): GovernanceExperienceSnapshot {
    return deriveGovernanceExperienceSnapshot(this.buildInputs(options));
  }

  buildInputs(options: GovernanceExperienceCollectOptions): GovernanceExperienceInputs {
    const asOf = options.asOf ?? new Date().toISOString();
    const sourceAvailability: SourceAvailabilityInput[] = [];
    const dataQualityInputs: UnlinkedRecordGroup[] = [];

    // ── Principle ledger: read once, validate every entry ────────────────────
    const ledger = this.scanLedger();
    sourceAvailability.push({
      sourceId: 'principle_ledger',
      available: ledger.available,
      ...(ledger.reasonCode !== undefined ? { reasonCode: ledger.reasonCode } : {}),
    });
    if (ledger.invalidPrincipleRefs.length > 0) {
      dataQualityInputs.push({
        source: 'principle',
        reasonCode: 'principle_ledger_entry_invalid',
        count: ledger.invalidPrincipleRefs.length,
        sampleRefs: ledger.invalidPrincipleRefs.slice(0, UNLINKED_SAMPLE_LIMIT),
      });
    }

    // ── state.db: existence check + one batched table read ───────────────────
    const dbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    let tables: GovernanceProjectionTables = EMPTY_TABLES;
    let stateDbAvailable = true;
    let stateDbReasonCode: string | undefined;
    if (!fs.existsSync(dbPath)) {
      stateDbAvailable = false;
      stateDbReasonCode = 'state_db_missing';
    } else {
      try {
        tables = (options.tableReader ?? GovernanceProjectionCollector.readTables)(this.workspaceDir);
      } catch {
        stateDbAvailable = false;
        stateDbReasonCode = 'state_db_read_failed';
        tables = EMPTY_TABLES;
      }
    }
    sourceAvailability.push({
      sourceId: 'state_db',
      available: stateDbAvailable,
      ...(stateDbReasonCode !== undefined ? { reasonCode: stateDbReasonCode } : {}),
    });

    // ── Views: reuse the existing projection per principle, in memory ────────
    const views: GovernanceExperienceInputs['governanceViews'] = [];
    const claimedTaskIds = new Set<string>();
    const principleIds = [...ledger.facts.keys()].sort();
    for (const principleId of principleIds) {
      const principle = ledger.facts.get(principleId);
      if (principle === undefined) continue;
      const issues: DataQualityIssue[] = [...(ledger.issuesByPrinciple.get(principleId) ?? [])];
      try {
        // state.db unavailable mirrors collect()'s degraded facts shape exactly
        const facts = stateDbAvailable
          ? GovernanceProjectionCollector.buildFacts({ principleId, asOf, principle, tables, collectionIssues: issues })
          : GovernanceProjectionCollector.factsForUnavailableSource({ principleId, asOf, principle, collectionIssues: issues });
        for (const task of facts.tasks) {
          if (task.taskId !== undefined) claimedTaskIds.add(task.taskId);
        }
        views.push({ view: deriveOwnerGovernanceView(facts), lineageConfidence: facts.lineage.confidence });
      } catch {
        // A principle whose facts/view fail validation never blocks the snapshot;
        // it surfaces as a bounded data-quality group (fail loud, keep going).
        dataQualityInputs.push({
          source: 'principle',
          reasonCode: 'projection_derivation_failed',
          count: 1,
          sampleRefs: [{ type: 'principle', id: principleId }],
        });
      }
    }

    // ── Frontier evidence + unlinked records (from the same batched rows) ────
    const parsedTasks: ValidTaskRow[] = [];
    const parseIssues: DataQualityIssue[] = []; // malformed rows are attributed per-principle by buildFacts; not double-counted here
    if (stateDbAvailable) {
      for (const row of tables.taskRows) {
        const parsed = GovernanceProjectionCollector.parseTaskRow(row, parseIssues);
        if (parsed !== null) parsedTasks.push(parsed);
      }
    }
    const activeTasks = stateDbAvailable ? parsedTasks.filter(task => task.status !== 'succeeded') : [];
    // RuleCode owner decisions awaiting action: non-deactivated shadow
    // activations, counted from the same batched rows (SPEC §8.3 source).
    const rulecodePendingRefs: SourceRef[] = [];
    let rulecodePendingCount = 0;
    if (stateDbAvailable) {
      for (const row of tables.activationRows) {
        if (!isRecord(row)) continue;
        const action = readOwnString(row, 'action');
        const deactivatedAt = readOwnString(row, 'deactivated_at');
        if (action !== 'code_tool_hook_shadow_activate' || deactivatedAt !== undefined) continue;
        rulecodePendingCount += 1;
        const activationId = readOwnString(row, 'activation_id');
        if (activationId !== undefined && rulecodePendingRefs.length < UNLINKED_SAMPLE_LIMIT) {
          rulecodePendingRefs.push({ type: 'activation', id: activationId });
        }
      }
    }
    const artifactIds = new Set<string>();
    if (stateDbAvailable) {
      for (const row of tables.artifactRows) {
        if (!isRecord(row)) continue;
        const artifactId = readOwnString(row, 'artifact_id');
        if (artifactId !== undefined) artifactIds.add(artifactId);
      }
    }
    if (stateDbAvailable) {
      const unlinkedApprovalRefs: SourceRef[] = [];
      let unlinkedApprovalCount = 0;
      for (const row of tables.approvalRows) {
        if (!isRecord(row)) continue;
        const artifactId = readOwnString(row, 'artifact_id');
        const approvalId = readOwnString(row, 'approval_id');
        if (artifactId !== undefined && !artifactIds.has(artifactId)) {
          unlinkedApprovalCount += 1;
          if (approvalId !== undefined && unlinkedApprovalRefs.length < UNLINKED_SAMPLE_LIMIT) {
            unlinkedApprovalRefs.push({ type: 'approval', id: approvalId });
          }
        }
      }
      if (unlinkedApprovalCount > 0) {
        dataQualityInputs.push({ source: 'approval', reasonCode: 'unlinked_record', count: unlinkedApprovalCount, sampleRefs: unlinkedApprovalRefs });
      }

      if (ledger.available) {
        const unlinkedArtifactRefs: SourceRef[] = [];
        let unlinkedArtifactCount = 0;
        for (const row of tables.artifactRows) {
          if (!isRecord(row)) continue;
          const sourcePrincipleId = readOwnString(row, 'source_principle_id');
          const artifactId = readOwnString(row, 'artifact_id');
          if (sourcePrincipleId !== undefined && !ledger.presentPrincipleIds.has(sourcePrincipleId)) {
            unlinkedArtifactCount += 1;
            if (artifactId !== undefined && unlinkedArtifactRefs.length < UNLINKED_SAMPLE_LIMIT) {
              unlinkedArtifactRefs.push({ type: 'artifact', id: artifactId });
            }
          }
        }
        if (unlinkedArtifactCount > 0) {
          dataQualityInputs.push({ source: 'artifact', reasonCode: 'unlinked_record', count: unlinkedArtifactCount, sampleRefs: unlinkedArtifactRefs });
        }
      }

      const unlinkedTaskRefs: SourceRef[] = [];
      let unlinkedTaskCount = 0;
      for (const task of parsedTasks) {
        if (claimedTaskIds.has(task.taskId)) continue;
        unlinkedTaskCount += 1;
        if (unlinkedTaskRefs.length < UNLINKED_SAMPLE_LIMIT) unlinkedTaskRefs.push({ type: 'task', id: task.taskId });
      }
      if (unlinkedTaskCount > 0) {
        dataQualityInputs.push({ source: 'task', reasonCode: 'unlinked_record', count: unlinkedTaskCount, sampleRefs: unlinkedTaskRefs });
      }
    }

    // ── Workspace config environment (PRI-587) via the unified validator ─────
    const configResult = loadPdConfig(this.workspaceDir);
    const environment = configResult.ok ? configResult.effective.config.workspace?.environment : undefined;
    const environmentContext = configResult.ok
      ? environment !== undefined
        ? { environment, source: 'workspace_config' as const }
        : { environment: 'unknown' as const, source: 'missing' as const }
      : { environment: 'unknown' as const, source: 'missing' as const, configIssue: 'config_invalid' };

    return {
      schemaVersion: '1',
      asOf,
      workspaceHash: hashWorkspacePath(this.workspaceDir),
      governanceViews: views,
      ownerConfigSnapshot: options.ownerConfig,
      environmentContext,
      sourceAvailability,
      dataQualityInputs,
      ...(stateDbAvailable
        ? {
            frontierEvidence: { sourceId: 'state_db' as const, activeTaskCount: activeTasks.length, sampleRefs: activeTasks.slice(0, UNLINKED_SAMPLE_LIMIT).map(task => ({ type: 'task' as const, id: task.taskId })) },
            rulecodeDecisionEvidence: { pendingCount: rulecodePendingCount, sampleRefs: rulecodePendingRefs },
          }
        : {}),
    };
  }

  /**
   * Reads the principle ledger once and validates every entry. A readable file
   * with a malformed tree counts as an unavailable ledger source (no views can
   * be built); individual invalid entries degrade to data-quality groups.
   */
  private scanLedger(): LedgerScan {
    const scan: LedgerScan = {
      available: true,
      presentPrincipleIds: new Set(),
      facts: new Map(),
      issuesByPrinciple: new Map(),
      invalidPrincipleRefs: [],
    };
    let parsed: unknown;
    try {
      parsed = GovernanceProjectionCollector.parsePrincipleLedgerFile(this.workspaceDir);
    } catch {
      scan.available = false;
      scan.reasonCode = 'ledger_unreadable';
      return scan;
    }
    if (!isRecord(parsed)) {
      scan.available = false;
      scan.reasonCode = 'ledger_tree_malformed';
      return scan;
    }
    const tree = Object.hasOwn(parsed, '_tree') ? parsed._tree : parsed.tree;
    if (!isRecord(tree) || !isRecord(tree.principles)) {
      scan.available = false;
      scan.reasonCode = 'ledger_tree_malformed';
      return scan;
    }
    for (const principleId of Object.keys(tree.principles).sort()) {
      scan.presentPrincipleIds.add(principleId);
      const issues: DataQualityIssue[] = [];
      try {
        const fact = GovernanceProjectionCollector.principleFactFromLedger(parsed, principleId, issues);
        scan.facts.set(principleId, fact);
        scan.issuesByPrinciple.set(principleId, issues);
      } catch {
        scan.invalidPrincipleRefs.push({ type: 'principle', id: principleId });
      }
    }
    return scan;
  }
}
