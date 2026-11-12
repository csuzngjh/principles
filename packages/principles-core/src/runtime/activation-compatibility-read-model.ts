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
import { resolveStateDbPath } from './store/storage-paths.js';
import {
  scanLegacyRuleContractDependencies,
  type LegacyRuleContractFinding,
  type LegacyRuleContractRuleSource,
} from './internalization/legacy-rule-contract-scanner.js';

/** Why an ACTIVE activation row could not be scanned (incremental counter, 2B-a). */
type ActivationCompatibilitySkipReason =
  | 'row_not_record'
  | 'missing_artifact_id'
  | 'missing_content_json'
  | 'invalid_content_json'
  | 'content_not_object'
  | 'missing_implementation_code';

/** One aggregated skip reason. `count` is always > 0. */
interface ActivationCompatibilitySkipped {
  reason: ActivationCompatibilitySkipReason;
  count: number;
  /** Up to 5 attributable activation ids; empty when the row had no readable id. */
  sampleActivationIds: string[];
}

export interface ActivationCompatibilityScanResult {
  /**
   * "The scan itself did not crash." `ok` is deliberately NOT a
   * severity/blocking signal: an `incomplete` scan (some rows unreadable) is
   * still a completed scan, and consumers decide how loudly to surface it.
   */
  ok: boolean;
  workspaceDir: string;
  /**
   * 'clean'              = findings empty AND skipped empty (every active row
   *                        was scanned and none has a retired dependency);
   * 'incomplete'         = findings empty AND skipped non-empty (nothing was
   *                        found, but at least one active row could not be
   *                        read — NOT equivalent to clean);
   * 'legacy_dependency'  = findings present (dominates `incomplete`: findings
   *                        are never merged into `incomplete`);
   * 'no_state_db'        = fresh workspace, nothing persisted to scan;
   * 'scan_failed'        = the scan threw.
   */
  status: 'clean' | 'incomplete' | 'legacy_dependency' | 'no_state_db' | 'scan_failed';
  findings: LegacyRuleContractFinding[];
  scannedActivations: number;
  /**
   * ACTIVE rows that were NOT scanned, aggregated by reason. Empty = every
   * row was scanned. Non-empty forces `status` to at least `incomplete`:
   * silently reporting `clean` while whole rows were unreadable was the 5B
   * defect this field's consumers relied on not happening.
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
    const stateDbPath = resolveStateDbPath(this.workspaceDir);
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
      const skippedEntries = skipped();
      // findings > skipped > clean: a real finding is the strongest signal, and
      // `incomplete` is never merged into it (the status stays one value while
      // both arrays remain available to the caller).
      const status: ActivationCompatibilityScanResult['status'] =
        findings.length > 0 ? 'legacy_dependency' : skippedEntries.length > 0 ? 'incomplete' : 'clean';
      return {
        // `ok` = the scan ran to completion; it is not a severity signal, so
        // neither skipped rows nor the status above may flip it.
        ok: findings.length === 0,
        workspaceDir: this.workspaceDir,
        status,
        findings,
        scannedActivations: sources.length,
        skipped: skippedEntries,
        ...(findings.length > 0
          ? {
              reason: 'legacy_rule_contract_dependency',
              nextAction: 'Migrate or deactivate the listed rules before upgrading. The current installation is untouched.',
            }
          : skippedEntries.length > 0
            ? {
                reason: 'unscannable_active_rows',
                nextAction:
                  'Some ACTIVE rules could not be read, so their compatibility is unverified. Run `pd runtime compatibility-scan` for the per-reason counts and activation ids, then repair or re-activate those rules.',
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
