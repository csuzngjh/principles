/**
 * recovery-actions-log.ts — append-only JSONL audit log for Owner-triggered
 * governance recovery actions (Governance Recovery Actions v1, SPEC §10).
 *
 * Storage: <workspace>/.state/recovery_actions.jsonl
 * Each line is one complete JSON record (mirrors pruning-review-log.ts — the
 * established append-only audit pattern; no new DB tables, SPEC §10 "优先复用
 * 现有 persistence").
 *
 * Non-goals:
 * - Does not modify state.db (the recovery itself is done by
 *   RecoverySweepService / owner-retry; this log only records the action)
 * - Does not provide CLI writers (CLI recovery paths keep their existing
 *   runs/telemetry coverage; only Console-originated actions are recorded)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export type RecoveryActionKind = 'recover';

export type RecoveryActionResult =
  /** failed → pending via RecoverySweepService.recoverFailedTask */
  | 'recovered'
  /** needs_human_review → pending via owner authority reset */
  | 'requeued';

export interface RecoveryActionRecord {
  /** Random id for this audit line */
  actionId: string;
  taskId: string;
  action: RecoveryActionKind;
  /** Status before the recovery mutation (e.g. 'failed', 'needs_human_review') */
  previousStatus: string;
  /** Who triggered the action (e.g. 'console'); null when unknown */
  operator: string | null;
  /** Optional owner-supplied reason (bounded free text) */
  reason: string | null;
  /**
   * True when the recovery bypassed an exhausted attempt budget
   * (recoverFailedTask force path). Absent on records written before this
   * field existed and on non-forced recoveries.
   */
  forceApplied?: boolean;
  createdAt: string;
  result: RecoveryActionResult;
}

export interface AppendRecoveryActionInput {
  taskId: string;
  previousStatus: string;
  result: RecoveryActionResult;
  operator?: string;
  reason?: string | null;
  forceApplied?: boolean;
}

// ── Validation ─────────────────────────────────────────────────────────────────

const VALID_RESULTS = new Set<string>(['recovered', 'requeued']);

function validateResult(result: string): asserts result is RecoveryActionResult {
  if (!VALID_RESULTS.has(result)) {
    throw new Error(`Invalid recovery result: '${result}'. Must be one of: recovered, requeued`);
  }
}

/** Bounded reason text (append log lines stay readable; rc-8 bounded serialization). */
const MAX_REASON_LENGTH = 2000;

function normalizeReason(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string' || reason.length === 0) return null;
  return reason.length > MAX_REASON_LENGTH ? reason.slice(0, MAX_REASON_LENGTH) : reason;
}

// ── Core Functions ─────────────────────────────────────────────────────────────

function getLogPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.state', 'recovery_actions.jsonl');
}

function ensureStateDir(workspaceDir: string): void {
  const stateDir = path.join(workspaceDir, '.state');
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
}

/**
 * Append a recovery action record to the audit log.
 *
 * Best-effort by design: an audit-write failure must not turn an already
 * committed task recovery into a reported failure, but it is never silent —
 * the error propagates to the caller, which logs it (rc-9).
 */
export function appendRecoveryAction(
  workspaceDir: string,
  input: AppendRecoveryActionInput,
): RecoveryActionRecord {
  validateResult(input.result);

  ensureStateDir(workspaceDir);

  const record: RecoveryActionRecord = {
    actionId: crypto.randomUUID(),
    taskId: input.taskId,
    action: 'recover',
    previousStatus: input.previousStatus,
    operator: input.operator ?? null,
    reason: normalizeReason(input.reason ?? null),
    // Omitted (not false) so records of ordinary recoveries stay identical to
    // the pre-force field set — old readers and line diffs don't see noise.
    ...(input.forceApplied === true ? { forceApplied: true as const } : {}),
    createdAt: new Date().toISOString(),
    result: input.result,
  };

  const logPath = getLogPath(workspaceDir);
  fs.appendFileSync(logPath, JSON.stringify(record) + '\n', 'utf-8');

  return record;
}

function isRecoveryActionRecord(value: unknown): value is RecoveryActionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    Object.hasOwn(rec, 'actionId') && typeof rec.actionId === 'string' &&
    Object.hasOwn(rec, 'taskId') && typeof rec.taskId === 'string' &&
    Object.hasOwn(rec, 'action') && rec.action === 'recover' &&
    Object.hasOwn(rec, 'previousStatus') && typeof rec.previousStatus === 'string' &&
    Object.hasOwn(rec, 'operator') && (rec.operator === null || typeof rec.operator === 'string') &&
    Object.hasOwn(rec, 'reason') && (rec.reason === null || typeof rec.reason === 'string') &&
    // forceApplied is optional (legacy records predate it): absent is fine,
    // present-but-non-boolean means the line is malformed (rc-3).
    (!Object.hasOwn(rec, 'forceApplied') || typeof rec.forceApplied === 'boolean') &&
    Object.hasOwn(rec, 'createdAt') && typeof rec.createdAt === 'string' &&
    Object.hasOwn(rec, 'result') && typeof rec.result === 'string' && VALID_RESULTS.has(rec.result)
  );
}

/**
 * List recovery action records from the audit log.
 *
 * @param workspaceDir - The workspace root directory
 * @param filter - Optional filter by taskId
 * @returns Array of recovery action records (oldest first)
 */
export function listRecoveryActions(
  workspaceDir: string,
  filter?: { taskId?: string },
): RecoveryActionRecord[] {
  const logPath = getLogPath(workspaceDir);

  if (!fs.existsSync(logPath)) {
    return [];
  }

  const content = fs.readFileSync(logPath, 'utf-8');
  const lines = content.split('\n');
  const records: RecoveryActionRecord[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      // rc-1/rc-2: log lines are untrusted persisted data — full shape-check
      // via a type guard, never an `as` cast (rc-5: Object.hasOwn, not `in`).
      if (isRecoveryActionRecord(parsed)) {
        if (filter?.taskId && parsed.taskId !== filter.taskId) {
          continue;
        }
        records.push(parsed);
      }
    } catch {
      // Skip corrupt lines — continue processing
    }
  }

  return records;
}
