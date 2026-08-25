/**
 * Receipts Console Model — PRI-533 (SPEC §5.4), coverage disclosure PRI-590..594.
 *
 * Read-side model for the principle receipt ledger (principle_applications,
 * written by the plugin when principle_receipt_ledger is enabled). Serves:
 * - per-principle receipt history (effect/presence counts + bounded timeline)
 * - per-principle counts for the activations page columns
 *
 * Every response carries `coverage` (ReceiptEvidenceCoverage) describing what
 * the numbers mean: source readability, data trustworthiness, observed range
 * and retention policy. Coverage is derived from the same read — no extra
 * fact source, no behavior change to the legacy status/reason/nextAction
 * contract.
 *
 * Degradation rules (rc-9): state.db missing, table missing (pre-PRI-531
 * workspace), or the ledger flag disabled → status degraded with reason +
 * nextAction. Never throws to the route.
 *
 * rc-1: SQL rows are typed unknown and narrowed with typeof per column.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SqliteConnection, RECEIPT_RETENTION_POLICY_DAYS } from '@principles/core/runtime-v2';
import type { ReceiptEvidenceCoverage, ReceiptValidationStatus } from '@principles/core/runtime-v2';
import { computeFlagsFromLoadResult, loadPdConfig } from '../config/pd-config-store.js';

export interface ReceiptEvent {
  kind: 'rule_blocked' | 'auto_correct_applied' | 'self_reported' | 'prompt_injected';
  level: 'effect' | 'presence';
  sessionId: string | null;
  toolName: string | null;
  filePath: string | null;
  digest: string | null;
  createdAt: string;
}

export interface PrincipleReceipts {
  status: 'ok' | 'degraded';
  reason?: string;
  nextAction?: string;
  principleId: string;
  effectCount: number;
  presenceCount: number;
  lastEffectAt: string | null;
  events: ReceiptEvent[];
  coverage: ReceiptEvidenceCoverage;
}

export interface ReceiptCountEntry {
  principleId: string;
  effectCount: number;
  presenceCount: number;
  lastEffectAt: string | null;
}

export interface ReceiptCounts {
  status: 'ok' | 'degraded';
  reason?: string;
  nextAction?: string;
  counts: ReceiptCountEntry[];
  coverage: ReceiptEvidenceCoverage;
}

const KINDS: ReadonlySet<string> = new Set(['rule_blocked', 'auto_correct_applied', 'self_reported', 'prompt_injected']);
const LEVELS: ReadonlySet<string> = new Set(['effect', 'presence']);
const TIMELINE_LIMIT = 50;

interface RawRow {
  principle_id?: unknown;
  kind?: unknown;
  level?: unknown;
  session_id?: unknown;
  tool_name?: unknown;
  file_path?: unknown;
  digest?: unknown;
  created_at?: unknown;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toEvent(row: RawRow): ReceiptEvent | null {
  if (typeof row.kind !== 'string' || !KINDS.has(row.kind)) return null;
  if (typeof row.level !== 'string' || !LEVELS.has(row.level)) return null;
  if (typeof row.created_at !== 'string') return null;
  return {
    kind: row.kind as ReceiptEvent['kind'],
    level: row.level as ReceiptEvent['level'],
    sessionId: asNullableString(row.session_id),
    toolName: asNullableString(row.tool_name),
    filePath: asNullableString(row.file_path),
    digest: asNullableString(row.digest),
    createdAt: row.created_at,
  };
}

function isMissingTableError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('no such table');
}

/**
 * Coverage for a source that was not read. validationStatus stays 'valid' —
 * no data assessment was performed (the unreadable state itself is carried
 * by sourceStatus + reasonCode). See receipt-coverage.ts contract docs.
 */
function unreadCoverage(
  sourceStatus: 'disabled' | 'unavailable',
  reasonCode: string,
  nextActionCode: string,
): ReceiptEvidenceCoverage {
  return {
    sourceStatus,
    validationStatus: 'valid',
    observedFrom: null,
    asOf: new Date().toISOString(),
    retentionPolicyDays: RECEIPT_RETENTION_POLICY_DAYS,
    reasonCode,
    nextActionCode,
  };
}

interface ValidationOutcome {
  validationStatus: ReceiptValidationStatus;
  reasonCode?: string;
  nextActionCode?: string;
}

function readCoverage(validation: ValidationOutcome, observedFrom: string | null): ReceiptEvidenceCoverage {
  return {
    sourceStatus: 'available',
    validationStatus: validation.validationStatus,
    observedFrom,
    asOf: new Date().toISOString(),
    retentionPolicyDays: RECEIPT_RETENTION_POLICY_DAYS,
    ...(validation.reasonCode === undefined ? {} : { reasonCode: validation.reasonCode }),
    ...(validation.nextActionCode === undefined ? {} : { nextActionCode: validation.nextActionCode }),
  };
}

function resolveValidation(
  malformedReasonCode: string | undefined,
  partialReasonCode: string | undefined,
): ValidationOutcome {
  if (malformedReasonCode !== undefined) {
    // Counts are untrustworthy — owner must not read them as facts.
    return { validationStatus: 'malformed', reasonCode: malformedReasonCode, nextActionCode: 'inspect_state_db' };
  }
  if (partialReasonCode !== undefined) {
    return { validationStatus: 'partial', reasonCode: partialReasonCode, nextActionCode: 'inspect_state_db' };
  }
  return { validationStatus: 'valid' };
}

export class ReceiptsConsoleModel {
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async getPrincipleReceipts(principleId: string): Promise<PrincipleReceipts> {
    const guard = this.precheck();
    if (guard) {
      return {
        ...guard,
        principleId,
        effectCount: 0,
        presenceCount: 0,
        lastEffectAt: null,
        events: [],
      };
    }
    const conn = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true, bootstrapIfMissing: false });
    try {
      const rows = conn.getDb().prepare(
        'SELECT kind, level, session_id, tool_name, file_path, digest, created_at FROM principle_applications WHERE principle_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      ).all(principleId, TIMELINE_LIMIT) as unknown;
      const events: ReceiptEvent[] = [];
      let droppedRows = 0;
      for (const row of Array.isArray(rows) ? rows : []) {
        const event = toEvent(row as RawRow);
        if (event) events.push(event);
        else droppedRows++;
      }
      const counts = conn.getDb().prepare(
        'SELECT level, COUNT(*) AS n, MAX(created_at) AS last_at, MIN(created_at) AS first_at FROM principle_applications WHERE principle_id = ? GROUP BY level',
      ).all(principleId) as unknown;
      let effectCount = 0;
      let presenceCount = 0;
      let lastEffectAt: string | null = null;
      let observedFrom: string | null = null;
      let levelAnomaly = false;
      for (const row of Array.isArray(counts) ? counts : []) {
        const rec = row as { level?: unknown; n?: unknown; last_at?: unknown; first_at?: unknown };
        // ISO8601-UTC lexicographic comparison: safe only while created_at stays
        // zero-padded UTC from toISOString() — pin this precondition here.
        const firstAt = asNullableString(rec.first_at);
        if (firstAt !== null && (observedFrom === null || firstAt < observedFrom)) observedFrom = firstAt;
        if (rec.level === 'effect') {
          effectCount = typeof rec.n === 'number' ? rec.n : 0;
          lastEffectAt = asNullableString(rec.last_at);
        } else if (rec.level === 'presence') {
          presenceCount = typeof rec.n === 'number' ? rec.n : 0;
        } else {
          // Rows exist outside the effect/presence level space (schema drift /
          // tampering) — the two counts above silently miss them, so the
          // aggregate is untrustworthy.
          levelAnomaly = true;
        }
      }
      // COUNT(*) in a GROUP BY output is always a number — no unreadable-counts
      // branch exists on this endpoint (ERR-099: no unreachable conditionals).
      const malformedReasonCode = levelAnomaly ? 'ledger_level_invalid' : undefined;
      const partialReasonCode = droppedRows > 0 ? 'receipt_rows_dropped' : undefined;
      const validation = resolveValidation(malformedReasonCode, partialReasonCode);
      return {
        status: 'ok',
        principleId,
        effectCount,
        presenceCount,
        lastEffectAt,
        events,
        coverage: readCoverage(validation, observedFrom),
      };
    } catch (err) {
      if (isMissingTableError(err)) {
        return {
          status: 'degraded',
          reason: 'principle_applications table not found — ledger not initialized on this workspace',
          nextAction: 'Update the plugin to a version including PRI-531 and enable principle_receipt_ledger',
          principleId,
          effectCount: 0,
          presenceCount: 0,
          lastEffectAt: null,
          events: [],
          coverage: unreadCoverage('unavailable', 'ledger_table_missing', 'update_plugin'),
        };
      }
      throw err;
    } finally {
      conn.close();
    }
  }

  async getReceiptCounts(): Promise<ReceiptCounts> {
    const guard = this.precheck();
    if (guard) {
      return {
        status: guard.status,
        reason: guard.reason,
        nextAction: guard.nextAction,
        counts: [],
        coverage: guard.coverage,
      };
    }
    const conn = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true, bootstrapIfMissing: false });
    try {
      const rows = conn.getDb().prepare(
        `SELECT principle_id,
                SUM(CASE WHEN level = 'effect' THEN 1 ELSE 0 END) AS effect_count,
                SUM(CASE WHEN level = 'presence' THEN 1 ELSE 0 END) AS presence_count,
                MAX(CASE WHEN level = 'effect' THEN created_at END) AS last_effect_at,
                COUNT(*) AS total_count,
                SUM(CASE WHEN kind NOT IN ('rule_blocked','auto_correct_applied','self_reported','prompt_injected') THEN 1 ELSE 0 END) AS invalid_kind_count
          FROM principle_applications GROUP BY principle_id`,
      // invalid_kind_count mirrors the timeline's KINDS set (toEvent): rows with
      // an unknown kind are dropped from the detail timeline (partial) — the
      // counts endpoint must reach the SAME verdict for the same table.
      ).all() as unknown;
      // Global observed range (the retention sweep is table-wide, not per principle).
      const firstAtRow = conn.getDb().prepare(
        'SELECT MIN(created_at) AS first_at FROM principle_applications',
      ).get();
      const observedFrom = asNullableString((firstAtRow as { first_at?: unknown } | undefined)?.first_at);
      const counts: ReceiptCountEntry[] = [];
      let skippedRows = 0;
      let levelAnomaly = false;
      let kindAnomaly = false;
      for (const row of Array.isArray(rows) ? rows : []) {
        const rec = row as Record<string, unknown>;
        const principleId = asNullableString(rec.principle_id);
        if (!principleId) {
          skippedRows++;
          continue;
        }
        // SUM(CASE ... ELSE 0 END) / COUNT(*) in GROUP BY output are always
        // numbers — no unreadable-counts branch exists on this endpoint
        // (ERR-099: no unreachable conditionals).
        const effectCount = typeof rec.effect_count === 'number' ? rec.effect_count : 0;
        const presenceCount = typeof rec.presence_count === 'number' ? rec.presence_count : 0;
        if (typeof rec.total_count === 'number' && rec.total_count > effectCount + presenceCount) {
          // Rows outside the effect/presence level space inflate the row total
          // without landing in either count — the aggregate is untrustworthy.
          levelAnomaly = true;
        }
        if (typeof rec.invalid_kind_count === 'number' && rec.invalid_kind_count > 0) {
          // Unknown-kind rows are still counted (valid level) but the detail
          // timeline drops them — align the partial verdict across endpoints.
          kindAnomaly = true;
        }
        counts.push({
          principleId,
          effectCount,
          presenceCount,
          lastEffectAt: asNullableString(rec.last_effect_at),
        });
      }
      const malformedReasonCode = levelAnomaly ? 'ledger_level_invalid' : undefined;
      const partialReasonCode = skippedRows > 0 || kindAnomaly ? 'receipt_rows_dropped' : undefined;
      const validation = resolveValidation(malformedReasonCode, partialReasonCode);
      return {
        status: 'ok',
        counts,
        coverage: readCoverage(validation, observedFrom),
      };
    } catch (err) {
      if (isMissingTableError(err)) {
        return {
          status: 'degraded',
          reason: 'principle_applications table not found — ledger not initialized on this workspace',
          nextAction: 'Update the plugin to a version including PRI-531 and enable principle_receipt_ledger',
          counts: [],
          coverage: unreadCoverage('unavailable', 'ledger_table_missing', 'update_plugin'),
        };
      }
      throw err;
    } finally {
      conn.close();
    }
  }

  /**
   * Shared preconditions: state.db exists + ledger flag enabled. Returns a
   * degraded partial response when a precondition fails (rc-9), else null.
   * Unavailable outranks disabled (mirrors the legacy precheck order, so
   * observable behavior is unchanged).
   */
  private precheck(): { status: 'degraded'; reason: string; nextAction: string; coverage: ReceiptEvidenceCoverage } | null {
    const stateDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    if (!fs.existsSync(stateDbPath)) {
      return {
        status: 'degraded',
        reason: 'state.db not found — workspace may not be initialized',
        nextAction: 'Run pd runtime diagnostics to check workspace state',
        coverage: unreadCoverage('unavailable', 'state_db_missing', 'run_runtime_diagnostics'),
      };
    }
    const flags = computeFlagsFromLoadResult(loadPdConfig(this.workspaceDir));
    if (flags.flags.principle_receipt_ledger?.enabled !== true) {
      return {
        status: 'degraded',
        reason: 'principle_receipt_ledger flag is disabled — no receipt history is being recorded',
        nextAction: 'Enable the flag in .pd/config.yaml: features.principle_receipt_ledger.enabled = true',
        coverage: unreadCoverage('disabled', 'ledger_flag_disabled', 'enable_ledger_flag'),
      };
    }
    return null;
  }
}
