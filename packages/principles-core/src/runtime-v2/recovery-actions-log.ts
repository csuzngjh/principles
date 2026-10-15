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
 * - Does not provide UI writers (recovery writes come from the Console route;
 *   PRI-983 evidence actions attach_evidence/resume_evidence are written by
 *   the core owner-evidence-recovery service that the CLI entry drives)
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

// ── Owner evidence actions (PRI-983, SPEC-PD-IAER-001 FR-03/FR-06) ────────────
//
// The same append-only audit channel (one file, one Owner-governance action
// history) records the two B1 evidence operations:
//   - `attach_evidence`: an authorized Owner wrote an evidence selection into
//     pi_metadata (the task STAYS needs_human_review — attach never unblocks);
//   - `resume_evidence`: the authorized, digest-verified authority reset that
//     returned the task to pending. `previousAttemptCount` is recorded BEFORE
//     the reset — ownerRetryNeedsHumanReviewTask zeroes the attempt budget,
//     and FR-06 requires that reset to be explicit + audited, never silent.
//
// Deliberately NOT `ownerResolutions` metadata: that log is the verdict-decision
// authority with decision-specific validation (reviewKey uniqueness,
// RUNNER_DECISIONS vocabulary); evidence attachment carries neither.

export type OwnerEvidenceActionKind = 'attach_evidence' | 'resume_evidence';

export interface OwnerEvidenceActionRecord {
  actionId: string;
  taskId: string;
  action: OwnerEvidenceActionKind;
  /** Canonical pain id the attached selection references. */
  painId: string;
  /** Attach revision of the selection (1 = first attach). */
  revision: number;
  /** `sha256:<hex>` digest of the assembled pack this action is anchored to. */
  contentDigest: string;
  /** Only on resume: the attempt budget BEFORE the explicit authority reset. */
  previousAttemptCount?: number;
  /** Operator label (--decidedBy); null when not supplied. */
  operator: string | null;
  createdAt: string;
}

export interface AppendOwnerEvidenceActionInput {
  taskId: string;
  action: OwnerEvidenceActionKind;
  painId: string;
  revision: number;
  contentDigest: string;
  previousAttemptCount?: number;
  operator?: string | null;
}

const OWNER_EVIDENCE_ACTION_KINDS: ReadonlySet<string> = new Set(['attach_evidence', 'resume_evidence']);

/**
 * Append an Owner evidence action to the same audit log. Same best-effort
 * contract as appendRecoveryAction: errors propagate to the caller (rc-9,
 * never silent) but the state mutation they audit has already been committed.
 */
export function appendOwnerEvidenceAction(
  workspaceDir: string,
  input: AppendOwnerEvidenceActionInput,
): OwnerEvidenceActionRecord {
  if (!OWNER_EVIDENCE_ACTION_KINDS.has(input.action)) {
    throw new Error(`Invalid owner evidence action: '${input.action}'. Must be one of: attach_evidence, resume_evidence`);
  }
  if (typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new Error(`Invalid owner evidence revision: '${input.revision}'. Must be a positive integer`);
  }

  ensureStateDir(workspaceDir);

  const record: OwnerEvidenceActionRecord = {
    actionId: crypto.randomUUID(),
    taskId: input.taskId,
    action: input.action,
    painId: input.painId,
    revision: input.revision,
    contentDigest: input.contentDigest,
    ...(input.previousAttemptCount !== undefined ? { previousAttemptCount: input.previousAttemptCount } : {}),
    operator: input.operator ?? null,
    createdAt: new Date().toISOString(),
  };

  fs.appendFileSync(getLogPath(workspaceDir), JSON.stringify(record) + '\n', 'utf-8');
  return record;
}

function isOwnerEvidenceActionRecord(value: unknown): value is OwnerEvidenceActionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    Object.hasOwn(rec, 'actionId') && typeof rec.actionId === 'string' &&
    Object.hasOwn(rec, 'taskId') && typeof rec.taskId === 'string' &&
    Object.hasOwn(rec, 'action') && typeof rec.action === 'string' &&
    OWNER_EVIDENCE_ACTION_KINDS.has(rec.action) &&
    Object.hasOwn(rec, 'painId') && typeof rec.painId === 'string' &&
    Object.hasOwn(rec, 'revision') && typeof rec.revision === 'number' &&
    Object.hasOwn(rec, 'contentDigest') && typeof rec.contentDigest === 'string' &&
    (!Object.hasOwn(rec, 'previousAttemptCount') || (typeof rec.previousAttemptCount === 'number' && Number.isSafeInteger(rec.previousAttemptCount))) &&
    Object.hasOwn(rec, 'operator') && (rec.operator === null || typeof rec.operator === 'string') &&
    Object.hasOwn(rec, 'createdAt') && typeof rec.createdAt === 'string'
  );
}

/**
 * List Owner evidence action records from the audit log (oldest first).
 * `recover`-kind lines and corrupt lines are skipped — each record family
 * reads only its own shape.
 */
export function listOwnerEvidenceActions(
  workspaceDir: string,
  filter?: { taskId?: string },
): OwnerEvidenceActionRecord[] {
  const logPath = getLogPath(workspaceDir);

  if (!fs.existsSync(logPath)) {
    return [];
  }

  const content = fs.readFileSync(logPath, 'utf-8');
  const records: OwnerEvidenceActionRecord[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isOwnerEvidenceActionRecord(parsed)) {
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
