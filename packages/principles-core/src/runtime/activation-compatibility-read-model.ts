/**
 * Activation compatibility read model (2026-08-19).
 *
 * Read-only model that loads ACTIVE code_tool_hook RuleCode from a
 * workspace's .pd/state.db (activations ⋈ pi_artifacts) and runs the legacy
 * RuleHost contract scanner over each implementation. Consumers:
 *
 *   - `pd runtime compatibility-scan` (pd-cli) — the installer's upgrade
 *     preflight invokes this through the NEW pd-cli before replacing the
 *     current installation;
 *   - pd-console update routes — in-process preflight before applying an
 *     update that would swap the runtime executing these rules.
 *
 * IO discipline: strictly read-only. `bootstrapIfMissing: false` guarantees a
 * fresh workspace with no state.db is reported as "nothing to scan" instead
 * of creating a database. Rows are validated from `unknown` (rc-1/rc-2).
 */
import * as fs from 'fs';
import * as path from 'path';
import { SqliteConnection } from './store/sqlite-connection.js';
import {
  scanLegacyRuleContractDependencies,
  type LegacyRuleContractFinding,
  type LegacyRuleContractRuleSource,
} from './internalization/legacy-rule-contract-scanner.js';

/** Why an ACTIVE activation row could not be scanned (incremental counter, 2B-a). */
export type ActivationCompatibilitySkipReason =
  | 'row_not_record'
  | 'missing_artifact_id'
  | 'missing_content_json'
  | 'invalid_content_json'
  | 'content_not_object'
  | 'missing_implementation_code';

/** One aggregated skip reason. `count` is always > 0. */
export interface ActivationCompatibilitySkipped {
  reason: ActivationCompatibilitySkipReason;
  count: number;
  /** Up to 5 attributable activation ids; empty when the row had no readable id. */
  sampleActivationIds: string[];
}

export interface ActivationCompatibilityScanResult {
  ok: boolean;
  workspaceDir: string;
  /** 'clean' = no retired-contract dependencies; 'legacy_dependency' = findings present. */
  status: 'clean' | 'legacy_dependency' | 'no_state_db' | 'scan_failed';
  findings: LegacyRuleContractFinding[];
  scannedActivations: number;
  /**
   * ACTIVE rows that were NOT scanned, aggregated by reason. Empty = every
   * row was scanned. This is additive observability only: `status` and `ok`
   * keep their pre-2B-a meaning, so a skipped row never turns `clean` into a
   * failure on its own.
   */
  skipped: ActivationCompatibilitySkipped[];
  reason?: string;
  nextAction?: string;
}

const SKIP_SAMPLE_LIMIT = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export class ActivationCompatibilityReadModel {
  private readonly workspaceDir: string;

  constructor(options: { workspaceDir: string }) {
    this.workspaceDir = path.resolve(options.workspaceDir);
  }

  /**
   * Scan active code_tool_hook rules for retired-contract dependencies.
   * Never mutates the workspace; a missing state.db is a clean pass (fresh
   * install — nothing persisted to be incompatible with).
   */
  scan(): ActivationCompatibilityScanResult {
    const stateDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    if (!fs.existsSync(stateDbPath)) {
      return {
        ok: true,
        workspaceDir: this.workspaceDir,
        status: 'no_state_db',
        findings: [],
        scannedActivations: 0,
        skipped: [],
        reason: 'state.db not found — workspace has no persisted activations to scan',
        nextAction: 'Nothing to do; fresh workspaces have no legacy rule contracts.',
      };
    }

    const skipTotals = new Map<ActivationCompatibilitySkipReason, { count: number; sampleActivationIds: string[] }>();
    const recordSkip = (reason: ActivationCompatibilitySkipReason, row?: Record<string, unknown>): void => {
      const entry = skipTotals.get(reason) ?? { count: 0, sampleActivationIds: [] };
      entry.count += 1;
      const activationId = row === undefined ? undefined : readStringField(row, 'activation_id');
      if (activationId !== undefined && entry.sampleActivationIds.length < SKIP_SAMPLE_LIMIT) {
        entry.sampleActivationIds.push(activationId);
      }
      skipTotals.set(reason, entry);
    };
    const skipped = (): ActivationCompatibilitySkipped[] =>
      [...skipTotals.entries()].map(([reason, entry]) => ({ reason, count: entry.count, sampleActivationIds: entry.sampleActivationIds }));

    let conn: SqliteConnection | null = null;
    try {
      conn = new SqliteConnection({
        workspaceDir: this.workspaceDir,
        readonly: true,
        bootstrapIfMissing: false,
      });
      const db = conn.getDb();
      const rows: unknown = db.prepare(`
        SELECT a.activation_id, a.artifact_id, a.action,
               p.content_json, p.source_rule_id, p.source_principle_id
        FROM activations a
        JOIN pi_artifacts p ON a.artifact_id = p.artifact_id
        WHERE a.channel = 'code_tool_hook' AND a.deactivated_at IS NULL
        ORDER BY a.activated_at ASC
      `).all();

      const sources: LegacyRuleContractRuleSource[] = [];
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (!isRecord(row)) {
            recordSkip('row_not_record');
            continue;
          }
          const artifactId = readStringField(row, 'artifact_id');
          if (!artifactId) {
            recordSkip('missing_artifact_id', row);
            continue;
          }
          const contentJson = readStringField(row, 'content_json');
          if (!contentJson) {
            recordSkip('missing_content_json', row);
            continue;
          }
          let content: unknown;
          try {
            content = JSON.parse(contentJson);
          } catch {
            recordSkip('invalid_content_json', row);
            continue;
          }
          if (!isRecord(content)) {
            recordSkip('content_not_object', row);
            continue;
          }
          const {implementationCode} = content;
          if (typeof implementationCode !== 'string' || implementationCode.length === 0) {
            recordSkip('missing_implementation_code', row);
            continue;
          }
          sources.push({
            activationId: readStringField(row, 'activation_id'),
            artifactId,
            ruleId: readStringField(row, 'source_rule_id') ?? (isRecord(content) && typeof content.ruleId === 'string' ? content.ruleId : undefined),
            principleId: readStringField(row, 'source_principle_id'),
            implementationCode,
          });
        }
      }

      const findings = scanLegacyRuleContractDependencies(sources);
      return {
        ok: findings.length === 0,
        workspaceDir: this.workspaceDir,
        status: findings.length === 0 ? 'clean' : 'legacy_dependency',
        findings,
        scannedActivations: sources.length,
        skipped: skipped(),
        ...(findings.length > 0
          ? {
              reason: 'legacy_rule_contract_dependency',
              nextAction: 'Migrate or deactivate the listed rules before upgrading. The current installation is untouched.',
            }
          : {}),
      };
    } catch (err) {
      // rc-9: structured failure, never a silent pass on an unreadable DB —
      // callers treat ok=false as "refuse to proceed".
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        workspaceDir: this.workspaceDir,
        status: 'scan_failed',
        findings: [],
        scannedActivations: 0,
        skipped: skipped(),
        reason: `state.db scan failed: ${message}`,
        nextAction: 'Resolve the workspace database access issue, then retry the compatibility scan.',
      };
    } finally {
      conn?.close();
    }
  }
}
