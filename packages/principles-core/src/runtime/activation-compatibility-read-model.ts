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

export interface ActivationCompatibilityScanResult {
  ok: boolean;
  workspaceDir: string;
  /** 'clean' = no retired-contract dependencies; 'legacy_dependency' = findings present. */
  status: 'clean' | 'legacy_dependency' | 'no_state_db' | 'scan_failed';
  findings: LegacyRuleContractFinding[];
  scannedActivations: number;
  reason?: string;
  nextAction?: string;
}

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
        reason: 'state.db not found — workspace has no persisted activations to scan',
        nextAction: 'Nothing to do; fresh workspaces have no legacy rule contracts.',
      };
    }

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
          if (!isRecord(row)) continue;
          const artifactId = readStringField(row, 'artifact_id');
          const contentJson = readStringField(row, 'content_json');
          if (!artifactId || !contentJson) continue;
          let content: unknown;
          try {
            content = JSON.parse(contentJson);
          } catch {
            continue;
          }
          if (!isRecord(content)) continue;
          const {implementationCode} = content;
          if (typeof implementationCode !== 'string' || implementationCode.length === 0) continue;
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
        reason: `state.db scan failed: ${message}`,
        nextAction: 'Resolve the workspace database access issue, then retry the compatibility scan.',
      };
    } finally {
      conn?.close();
    }
  }
}
