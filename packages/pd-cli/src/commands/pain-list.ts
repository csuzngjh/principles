/**
 * pd pain list command — PRI-640 (Governance Signal Host Attribution v0.1)
 *
 * Read-only: lists canonical pain_events rows from trajectory.db with their
 * host attribution. `--host` filters by openclaw / codex / unknown.
 * PRI-743: the result (human and --json) also carries `byHost`, the
 * full-table host distribution independent of --host/--limit.
 *
 * Usage:
 *   pd pain list [--workspace <path>] [--limit N] [--host openclaw|codex|unknown] [--json]
 *
 * Host semantics (SPEC §6/§12): host_kind is observability metadata only.
 * NULL (legacy / manual / unprovable) is reported as `unknown` — never guessed.
 * On a pre-PRI-640 database without the host_kind column every row reports
 * `unknown` and a `host_kind_column_missing` warning is emitted (rc-9).
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

export type PainListHostFilter = 'openclaw' | 'codex' | 'unknown';

export interface PainListOptions {
  workspace?: string;
  limit?: number;
  host?: string;
  json?: boolean;
}

export interface PainListEntry {
  /** Canonical pain identity; `row:<id>` when the legacy row has none. */
  painId: string;
  source: string;
  /** 'openclaw' | 'codex' | 'unknown' — unknown covers NULL/unprovable. */
  host: PainListHostFilter | 'unknown';
  score: number;
  severity: string | null;
  createdAt: string;
  runtimeTaskId: string | null;
}

export interface PainListResult {
  count: number;
  pains: PainListEntry[];
  workspace: string;
  hostFilter: PainListHostFilter | null;
  /**
   * PRI-743: full-table host distribution (independent of --limit and --host
   * filtering) so operator tooling can group by host without an external
   * script. `null` only on a pre-PRI-640 database without the host_kind
   * column — the distribution is unprovable there, never guessed (rc-3/rc-9;
   * see the accompanying host_kind_column_missing warning).
   */
  byHost: { openclaw: number; codex: number; unknown: number } | null;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownField(row: unknown, key: string): unknown {
  return isRecord(row) && Object.hasOwn(row, key) ? row[key] : undefined;
}

/** Runtime Contract #1/#4: validate each DB row; skip malformed rows loudly. */
function toPainEntry(row: unknown): PainListEntry | null {
  const id = ownField(row, 'id');
  const source = ownField(row, 'source');
  const score = ownField(row, 'score');
  const createdAt = ownField(row, 'created_at');
  if (typeof id !== 'number' || typeof source !== 'string' || typeof score !== 'number' || typeof createdAt !== 'string') {
    return null;
  }
  const canonicalPainId = ownField(row, 'canonical_pain_id');
  const hostKind = ownField(row, 'host_kind');
  const severity = ownField(row, 'severity');
  const runtimeTaskId = ownField(row, 'runtime_task_id');
  const host: PainListEntry['host'] =
    hostKind === 'openclaw' || hostKind === 'codex' ? hostKind : 'unknown';
  return {
    painId: typeof canonicalPainId === 'string' && canonicalPainId.length > 0 ? canonicalPainId : `row:${id}`,
    source,
    host,
    score,
    severity: typeof severity === 'string' ? severity : null,
    createdAt,
    runtimeTaskId: typeof runtimeTaskId === 'string' && runtimeTaskId.length > 0 ? runtimeTaskId : null,
  };
}

export async function listPains(dbPath: string, options: { limit?: number; host?: PainListHostFilter } = {}): Promise<PainListResult> {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath, { readonly: true });
  try {
    const warnings: string[] = [];
    const columns: unknown[] = db.prepare('PRAGMA table_info(pain_events)').all();
    const hasHostKindColumn = columns.some((row) => ownField(row, 'name') === 'host_kind');
    if (!hasHostKindColumn) {
      warnings.push('host_kind_column_missing');
    }

    // PRI-743: full-table distribution, deliberately NOT narrowed by the
    // --host filter or --limit below — the operator question this answers is
    // "how do pains split across hosts in this workspace", which a filtered
    // count cannot answer. Non-openclaw/codex values (incl. NULL) count as
    // unknown, mirroring toPainEntry's read-side normalization.
    const byHost: PainListResult['byHost'] = hasHostKindColumn
      ? { openclaw: 0, codex: 0, unknown: 0 }
      : null;
    if (byHost) {
      const distRows: unknown[] = db
        .prepare("SELECT COALESCE(host_kind, 'unknown') AS host_bucket, COUNT(*) AS n FROM pain_events GROUP BY host_kind")
        .all();
      for (const row of distRows) {
        const bucket = ownField(row, 'host_bucket');
        const n = ownField(row, 'n');
        if ((bucket === 'openclaw' || bucket === 'codex' || bucket === 'unknown') && typeof n === 'number') {
          byHost[bucket] += n;
        }
      }
    }

    const params: (string | number)[] = [];
    let query = 'SELECT id, source, score, severity, created_at, canonical_pain_id, runtime_task_id';
    query += hasHostKindColumn ? ', host_kind' : ", NULL AS host_kind";
    query += ' FROM pain_events WHERE 1=1';
    if (options.host === 'unknown') {
      query += hasHostKindColumn ? ' AND host_kind IS NULL' : '';
    } else if (options.host === 'openclaw' || options.host === 'codex') {
      if (!hasHostKindColumn) {
        return { count: 0, pains: [], workspace: path.dirname(path.dirname(dbPath)), hostFilter: options.host, byHost, warnings };
      }
      query += ' AND host_kind = ?';
      params.push(options.host);
    }
    query += ' ORDER BY created_at DESC, id DESC';
    const limit = options.limit ?? 20;
    query += ' LIMIT ?';
    params.push(limit);

    const rawRows: unknown[] = db.prepare(query).all(...params);
    const skipped = rawRows.length - rawRows.map(toPainEntry).filter((entry) => entry !== null).length;
    if (skipped > 0) {
      warnings.push(`malformed_rows_skipped:${skipped}`);
    }
    const pains = rawRows
      .map(toPainEntry)
      .filter((entry): entry is PainListEntry => entry !== null);
    return {
      count: pains.length,
      pains,
      workspace: path.dirname(path.dirname(dbPath)),
      hostFilter: options.host ?? null,
      byHost,
      warnings,
    };
  } finally {
    db.close();
  }
}

function printHuman(result: PainListResult): void {
  const filterNote = result.hostFilter ? ` (host: ${result.hostFilter})` : '';
  console.log(`Pain events — ${result.count} shown${filterNote}`);
  if (result.byHost) {
    const { openclaw, codex, unknown } = result.byHost;
    console.log(`By host: openclaw=${openclaw} codex=${codex} unknown=${unknown}`);
  }
  console.log('─'.repeat(96));
  for (const pain of result.pains) {
    const painId = pain.painId.length > 40 ? `${pain.painId.slice(0, 37)}...` : pain.painId;
    console.log(`  ${pain.createdAt}  host=${pain.host.padEnd(8)} score=${String(pain.score).padEnd(3)} ${pain.severity ?? '-'.padEnd(6)} ${pain.source}`);
    console.log(`    id: ${painId}${pain.runtimeTaskId ? ` | task: ${pain.runtimeTaskId}` : ''}`);
  }
  console.log('─'.repeat(96));
  for (const warning of result.warnings) {
    console.error(`WARN: ${warning}`);
  }
  if (result.warnings.includes('host_kind_column_missing')) {
    console.error('Next: run `pd runtime init --workspace <dir>` (or restart the OpenClaw plugin) to migrate this workspace schema.');
  }
}

export async function handlePainList(opts: PainListOptions): Promise<void> {
  const { workspace, limit: rawLimit, host: rawHost, json } = opts;

  if (rawHost !== undefined && rawHost !== 'openclaw' && rawHost !== 'codex' && rawHost !== 'unknown') {
    const message = `invalid host filter: expected openclaw | codex | unknown, got ${rawHost}`;
    if (json) {
      console.log(JSON.stringify({ status: 'failed', reason: 'invalid_host_filter', message, nextAction: 'Pass --host openclaw, --host codex, or --host unknown.' }));
    } else {
      console.error('Error: ' + message);
      console.error('Next: Pass --host openclaw, --host codex, or --host unknown.');
    }
    process.exit(1);
    return; // guard: test stubs of process.exit continue execution (cli-2-exit-stops)
  }
  const hostFilter: PainListHostFilter | undefined = rawHost;

  let effectiveLimit = 20;
  if (rawLimit !== undefined) {
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 10000) {
      const message = `invalid limit: limit must be an integer between 1 and 10000, got ${rawLimit}`;
      if (json) {
        console.log(JSON.stringify({ status: 'failed', reason: 'invalid_limit', message, nextAction: 'Pass --limit with a valid integer (1-10000).' }));
      } else {
        console.error('Error: ' + message);
        console.error('Next: Pass --limit with a valid integer (1-10000).');
      }
      process.exit(1);
      return; // guard: test stubs of process.exit continue execution (cli-2-exit-stops)
    }
    effectiveLimit = rawLimit;
  }

  const workspaceDir = resolveWorkspaceDir(workspace);
  const dbPath = path.join(workspaceDir, '.state', 'trajectory.db');
  if (!fs.existsSync(dbPath)) {
    const message = `trajectory database not found at ${dbPath}`;
    if (json) {
      console.log(JSON.stringify({ status: 'failed', reason: 'trajectory_db_not_found', message, nextAction: 'Initialize the PD workspace first (pd runtime init), or pass --workspace pointing at an initialized workspace.' }));
    } else {
      console.error('Error: ' + message);
      console.error('Next: Initialize the PD workspace first (pd runtime init), or pass --workspace pointing at an initialized workspace.');
    }
    process.exit(1);
    return; // guard: test stubs of process.exit continue execution (cli-2-exit-stops)
  }

  const result = await listPains(dbPath, { limit: effectiveLimit, ...(hostFilter ? { host: hostFilter } : {}) });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printHuman(result);
}
