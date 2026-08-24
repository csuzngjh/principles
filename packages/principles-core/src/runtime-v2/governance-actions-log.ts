/**
 * governance-actions-log.ts — append-only JSONL audit log for Owner-triggered
 * rulecode lifecycle actions (PRI-566).
 *
 * Problem it closes (8-21 incident): a live, owner-promoted RuleCode was
 * deactivated with zero audit trace in events_*.jsonl or anywhere else. The
 * deactivation surfaced only three days later via manual SQLite backup diff.
 *
 * Storage: <workspace>/.state/governance_actions.jsonl
 * Each line is one complete JSON record (mirrors recovery-actions-log.ts —
 * the established append-only audit pattern; no new DB tables).
 *
 * Scope:
 * - 'promote'    — Owner Live Decision committing a shadow activation to
 *                  live enforcement (CLI `pd activation promote --confirm`,
 *                  Console promoteRuleCode)
 * - 'deactivate' — reversible deactivation of an activation
 *                  (CLI `pd activation deactivate`, Console disable)
 *
 * Non-goals:
 * - Global emergency pause is NOT recorded here: it already persists a full
 *   decision row into the `activation_decisions` table (operator, reasonCode,
 *   note) inside SqliteActivationSafetyStore.
 * - No reads are performed on governed state; this module only records that a
 *   governance mutation happened (the mutation itself stays in its store).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export type GovernanceActionKind = 'promote' | 'deactivate';

/** Where the mutation was initiated from. New entrypoints MUST extend this. */
export type GovernanceOperator = 'cli' | 'console';

export interface GovernanceActionRecord {
  /** Random id for this audit line */
  actionId: string;
  action: GovernanceActionKind;
  activationId: string;
  operator: GovernanceOperator;
  /** Activation channel when known (prompt / code_tool_hook); null otherwise */
  channel: string | null;
  /** Optional owner-supplied reason (bounded free text) */
  reason: string | null;
  createdAt: string;
}

export interface AppendGovernanceActionInput {
  action: GovernanceActionKind;
  activationId: string;
  operator: GovernanceOperator;
  channel?: string | null;
  reason?: string | null;
}

// ─── Validation ─────────────────────────────────────────────────────────────

const VALID_ACTIONS = new Set<string>(['promote', 'deactivate']);
const VALID_OPERATORS = new Set<string>(['cli', 'console']);

function validateAction(action: string): asserts action is GovernanceActionKind {
  if (!VALID_ACTIONS.has(action)) {
    throw new Error(`Invalid governance action: '${action}'. Must be one of: promote, deactivate`);
  }
}

function validateOperator(operator: string): asserts operator is GovernanceOperator {
  if (!VALID_OPERATORS.has(operator)) {
    throw new Error(`Invalid governance operator: '${operator}'. Must be one of: cli, console`);
  }
}

/** Bounded reason text (append log lines stay readable; rc-8 bounded serialization). */
const MAX_REASON_LENGTH = 2000;

function normalizeReason(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string' || reason.length === 0) return null;
  return reason.length > MAX_REASON_LENGTH ? reason.slice(0, MAX_REASON_LENGTH) : reason;
}

// ─── Core Functions ─────────────────────────────────────────────────────────

function getLogPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.state', 'governance_actions.jsonl');
}

function ensureStateDir(workspaceDir: string): void {
  const stateDir = path.join(workspaceDir, '.state');
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
}

/**
 * Append a governance action record to the audit log.
 *
 * Best-effort by design: an audit-write failure must not roll back an already
 * committed governance mutation, but it is never silent — the error propagates
 * to the caller, which must surface it as a structured warning (rc-9).
 *
 * Callers MUST invoke this only after the underlying store mutation has
 * succeeded, so the log records facts, not intentions.
 */
export function appendGovernanceAction(
  workspaceDir: string,
  input: AppendGovernanceActionInput,
): GovernanceActionRecord {
  validateAction(input.action);
  validateOperator(input.operator);

  if (typeof input.activationId !== 'string' || input.activationId.length === 0) {
    throw new Error('Governance audit requires a non-empty activationId');
  }

  ensureStateDir(workspaceDir);

  const record: GovernanceActionRecord = {
    actionId: crypto.randomUUID(),
    action: input.action,
    activationId: input.activationId,
    operator: input.operator,
    channel: typeof input.channel === 'string' && input.channel.length > 0 ? input.channel : null,
    reason: normalizeReason(input.reason ?? null),
    createdAt: new Date().toISOString(),
  };

  const logPath = getLogPath(workspaceDir);
  fs.appendFileSync(logPath, JSON.stringify(record) + '\n', 'utf-8');

  return record;
}

function isGovernanceActionRecord(value: unknown): value is GovernanceActionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    Object.hasOwn(rec, 'actionId') && typeof rec.actionId === 'string' &&
    Object.hasOwn(rec, 'action') && typeof rec.action === 'string' && VALID_ACTIONS.has(rec.action) &&
    Object.hasOwn(rec, 'activationId') && typeof rec.activationId === 'string' &&
    Object.hasOwn(rec, 'operator') && typeof rec.operator === 'string' && VALID_OPERATORS.has(rec.operator) &&
    Object.hasOwn(rec, 'channel') && (rec.channel === null || typeof rec.channel === 'string') &&
    Object.hasOwn(rec, 'reason') && (rec.reason === null || typeof rec.reason === 'string') &&
    Object.hasOwn(rec, 'createdAt') && typeof rec.createdAt === 'string'
  );
}

/**
 * List governance action records from the audit log.
 *
 * @param workspaceDir - The workspace root directory
 * @param filter - Optional filter by activationId and/or action
 * @returns Array of records, oldest first
 */
export function listGovernanceActions(
  workspaceDir: string,
  filter?: { activationId?: string; action?: GovernanceActionKind },
): GovernanceActionRecord[] {
  const logPath = getLogPath(workspaceDir);

  if (!fs.existsSync(logPath)) {
    return [];
  }

  const content = fs.readFileSync(logPath, 'utf-8');
  const lines = content.split('\n');
  const records: GovernanceActionRecord[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      // rc-1/rc-2: log lines are untrusted persisted data — full shape-check
      // via a type guard, never an `as` cast (rc-5: Object.hasOwn, not `in`).
      if (isGovernanceActionRecord(parsed)) {
        if (filter?.activationId && parsed.activationId !== filter.activationId) {
          continue;
        }
        if (filter?.action && parsed.action !== filter.action) {
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
