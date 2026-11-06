/**
 * PRI-1114 — read-only behavior evidence linkage.
 *
 * Design: docs/specs/PD-AA-PRI-1114-BEHAVIOR-EVIDENCE-LINK-DESIGN-v0.2.md
 *
 * This module answers a deliberately narrow question: which recorded actions,
 * corrections and task outcomes belong to the same *run* as a recorded
 * principle intervention. It never claims a request-level link, never claims
 * the intervention was delivered before an action, and never upgrades a
 * model-completion record into task success.
 *
 * No writes, no model calls, no migrations. Every read is bounded.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import {
  openTrajectoryDbReadonly,
} from '@principles/core/trajectory-store';
import {
  ADAPTIVE_JOURNAL_CANDIDATE_DIRS,
  ADAPTIVE_JOURNAL_MAX_DATE_FILES_PER_DIR,
  ADAPTIVE_JOURNAL_MAX_FILE_BYTES,
  ADAPTIVE_JOURNAL_MAX_INVOCATIONS,
  ADAPTIVE_JOURNAL_MAX_TERMINAL_VARIANTS,
  reconcileAdaptiveJournal,
  type AdaptiveJournalConfigIdentity,
  type AdaptiveJournalError,
  type AdaptiveJournalInvocation,
  type AdaptiveJournalReport,
} from './adaptive-journal-reconciliation.js';

export const ADAPTIVE_BEHAVIOR_LINKAGE_SCHEMA_VERSION = 'pd-aa-behavior-linkage/v1' as const;

export const BEHAVIOR_LINKAGE_MAX_EVENT_LOG_LINES = 20_000;
export const BEHAVIOR_LINKAGE_MAX_TOOL_CALLS = 5_000;
export const BEHAVIOR_LINKAGE_MAX_TRAJECTORY_ROWS = 5_000;
export const BEHAVIOR_LINKAGE_MAX_ACTIONS_PER_INVOCATION = 200;
export const BEHAVIOR_LINKAGE_MAX_CORRECTIONS_PER_INVOCATION = 50;
export const BEHAVIOR_LINKAGE_MAX_OUTCOMES_PER_INVOCATION = 20;
export const BEHAVIOR_LINKAGE_MAX_WEAK_CANDIDATES_PER_INVOCATION = 20;
export const BEHAVIOR_LINKAGE_MAX_SESSION_QUERIES = 100;
export const BEHAVIOR_LINKAGE_ROWS_PER_SESSION = 200;

const DAY_MS = 86_400_000;

export interface LinkAdaptiveBehaviorEvidenceLimits {
  maxDateFilesPerDir?: number;
  maxFileBytes?: number;
  maxInvocations?: number;
  maxTerminalVariantsPerInvocation?: number;
  maxEventLogLines?: number;
  maxToolCalls?: number;
  maxTrajectoryRows?: number;
  maxActionsPerInvocation?: number;
  maxCorrectionsPerInvocation?: number;
  maxOutcomesPerInvocation?: number;
  maxWeakCandidatesPerInvocation?: number;
  maxSessionQueries?: number;
}

export interface LinkAdaptiveBehaviorEvidenceInput {
  workspaceDir: string;
  since?: string;
  until?: string;
  host?: string;
  now?: Date;
  limits?: LinkAdaptiveBehaviorEvidenceLimits;
}

export type BehaviorAssociation = 'strong_run' | 'weak' | 'ambiguous' | 'unknown' | 'conflict';

export type BehaviorAssociationReason =
  | 'run_identity_proven'
  | 'run_identity_missing'
  | 'workspace_identity_unknown'
  | 'journal_range_incomplete'
  | 'run_has_multiple_invocations'
  | 'duplicate_records'
  | 'target_identity_unproven'
  | 'terminal_conflicted'
  | 'config_changed'
  | 'open_not_visible_in_range'
  | 'terminal_not_visible_in_range'
  | 'action_before_open';

export type BehaviorUnknownReason =
  | 'delivery_time_unavailable'
  | 'task_success_not_observable'
  | 'model_completion_only'
  | 'artifact_effect_not_observable'
  | 'principle_ids_not_comparable'
  | 'journal_range_incomplete'
  | 'run_has_multiple_invocations'
  | 'duplicate_records'
  | 'terminal_not_visible_in_range'
  | 'open_not_visible_in_range'
  | 'config_changed'
  | 'trajectory_db_unavailable'
  | 'trajectory_schema_incomplete'
  | 'trajectory_query_failed'
  | 'event_log_unavailable'
  | 'event_log_parse_limit_reached'
  | 'event_log_files_omitted'
  | 'event_log_parse_errors'
  | 'event_log_read_error'
  | 'action_limit_reached'
  | 'correction_limit_reached'
  | 'outcome_limit_reached'
  | 'weak_candidate_limit_reached'
  | 'trajectory_row_limit_reached'
  | 'session_query_limit_reached'
  | 'session_rows_truncated';

export interface BehaviorLinkageActionFact {
  source: 'event_log.tool_call';
  toolName: string;
  toolCallIdRef: string | null;
  outcome: 'success' | 'failure' | 'unknown';
  exitCode: number | null;
  errorType: string | null;
  errorPresent: boolean;
  ts: string;
  /** Owner correction 2: no delivery timestamp exists, so ordering is always unknown. */
  ordering: 'unknown';
  relativeToRecordedOpen: 'before_open' | 'after_open' | 'no_open_timestamp';
  strength: 'run_strong' | 'run_ambiguous';
  verified: boolean;
  logRef: string;
}

export interface BehaviorLinkageCorrectionFact {
  source: 'trajectory.user_turns';
  userTurnId: number;
  turnIndex: number;
  referencedAssistantTurnId: number | null;
  referencedRunId: string | null;
  createdAt: string;
  ordering: 'unknown';
  strength: 'run_strong' | 'run_ambiguous' | 'weak';
  verified: boolean;
}

export interface BehaviorLinkageOutcomeFact {
  source: 'trajectory.task_outcomes';
  outcomeId: number;
  /** Raw recorded token; `completed` is a model-output record, never task success. */
  recordedOutcome: string | null;
  modelCompletionRecorded: boolean;
  semantics: 'model_completion_only';
  taskSuccess: 'unknown';
  principleBinding: 'session_level_unknown' | 'absent';
  principleIdCount: number;
  createdAt: string;
  strength: 'run_strong' | 'run_ambiguous';
  verified: boolean;
}

export interface BehaviorLinkageArtifacts {
  declaredTargetCount: number;
  declaredByToolNames: string[];
  confirmedCount: 0;
  confirmation: 'unknown';
}

export interface BehaviorLinkageWeakCandidate {
  source: 'trajectory.tool_calls';
  rowId: number;
  toolName: string;
  outcome: string | null;
  createdAt: string;
  reason: 'session_tool_time_only';
  verified: false;
}

export interface BehaviorLinkageInvocation {
  intervention: {
    hookInvocationId: string;
    runId: string | null;
    sessionId: string | null;
    host: string;
    workspaceVerified: boolean;
    artifactId: string | null;
    activationId: string | null;
    targetBodySha256: string | null;
    configIdentity: AdaptiveJournalConfigIdentity | null;
    terminal: {
      receiptState: 'open' | 'closed' | 'reconciled' | null;
      variants: number;
      classification: string;
    };
    openTs: string | null;
    terminalTs: string | null;
  };
  association: BehaviorAssociation;
  associationReasons: BehaviorAssociationReason[];
  /**
   * Explicit four-layer claim boundary. Only `runAssociation` is ever derived
   * from recorded facts; request-level attribution, principle adherence and
   * causal improvement are not observable with the current evidence.
   */
  evidenceLayers: {
    runAssociation: BehaviorAssociation;
    requestAssociation: 'unknown';
    principleAdherence: 'unknown';
    behaviorImprovement: 'unknown';
  };
  facts: {
    actions: BehaviorLinkageActionFact[];
    corrections: BehaviorLinkageCorrectionFact[];
    outcomes: BehaviorLinkageOutcomeFact[];
    artifacts: BehaviorLinkageArtifacts;
  };
  weakCandidates: BehaviorLinkageWeakCandidate[];
  unknowns: { fact: string; reasonCode: BehaviorUnknownReason }[];
  conflicts: {
    kind: 'journal' | 'config_identity';
    reasonCodes: string[];
    duplicateCount?: number;
  }[];
}

export interface BehaviorLinkageReport {
  schemaVersion: typeof ADAPTIVE_BEHAVIOR_LINKAGE_SCHEMA_VERSION;
  generatedAt: string;
  readOnly: true;
  request: {
    workspaceDir: string;
    host: string;
    window: AdaptiveJournalReport['request']['window'];
  };
  coverage: {
    complete: boolean;
    window: AdaptiveJournalReport['request']['window'];
    journal: {
      status: AdaptiveJournalReport['coverage']['status'];
      complete: boolean;
      filesRead: number;
      filesSkipped: number;
      limitCode: AdaptiveJournalReport['coverage']['limitCode'];
      truncatedFiles: number;
      errors: number;
      malformedLines: number;
      invalidRecords: number;
    };
    eventLog: {
      dirsFound: number;
      filesRead: number;
      linesRead: number;
      toolCalls: number;
      truncated: boolean;
      omittedFiles: number;
      parseErrors: number;
      errors: number;
      unattributedToolCalls: number;
    };
    trajectory: {
      status: 'read' | 'unavailable';
      rowsRead: number;
      truncated: boolean;
      reasons: string[];
    };
    incompleteReasons: BehaviorUnknownReason[];
  };
  totals: {
    invocations: number;
    byAssociation: Record<BehaviorAssociation, number>;
    actions: number;
    corrections: number;
    outcomes: number;
    weakCandidates: number;
  };
  invocations: BehaviorLinkageInvocation[];
  nextAction: string[];
}

export interface BehaviorLinkageError {
  code:
    | AdaptiveJournalError['code']
    | 'invalid_limit'
    | 'workspace_unavailable';
  message: string;
  nextAction: string;
}

export type BehaviorLinkageResult =
  | { ok: true; report: BehaviorLinkageReport }
  | {
      ok: false;
      schemaVersion: typeof ADAPTIVE_BEHAVIOR_LINKAGE_SCHEMA_VERSION;
      generatedAt: string;
      readOnly: true;
      error: BehaviorLinkageError;
    };

interface ResolvedLinkLimits {
  maxDateFilesPerDir: number;
  maxFileBytes: number;
  maxInvocations: number;
  maxTerminalVariantsPerInvocation: number;
  maxEventLogLines: number;
  maxToolCalls: number;
  maxTrajectoryRows: number;
  maxActionsPerInvocation: number;
  maxCorrectionsPerInvocation: number;
  maxOutcomesPerInvocation: number;
  maxWeakCandidatesPerInvocation: number;
  maxSessionQueries: number;
}

interface ToolCallRow {
  ts: string;
  tsMs: number;
  sessionId: string | null;
  runId: string | null;
  toolName: string;
  toolCallIdRef: string | null;
  outcome: 'success' | 'failure' | 'unknown';
  exitCode: number | null;
  errorType: string | null;
  errorPresent: boolean;
  declaresFilePath: boolean;
  logRef: string;
}

interface SessionTrajectoryRows {
  corrections: Record<string, unknown>[];
  outcomes: Record<string, unknown>[];
  weakToolCalls: Record<string, unknown>[];
  correctionsTruncated: boolean;
  outcomesTruncated: boolean;
  weakTruncated: boolean;
  queryFailed: boolean;
}

interface TrajectoryReadResult {
  status: 'read' | 'unavailable';
  rowsRead: number;
  truncated: boolean;
  reasons: string[];
  sessions: Map<string, SessionTrajectoryRows>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positiveInt(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

function resolveLimits(input: LinkAdaptiveBehaviorEvidenceLimits | undefined): ResolvedLinkLimits | null {
  const raw = input ?? {};
  const values: ResolvedLinkLimits = {
    maxDateFilesPerDir: positiveInt(raw.maxDateFilesPerDir, ADAPTIVE_JOURNAL_MAX_DATE_FILES_PER_DIR) ?? -1,
    maxFileBytes: positiveInt(raw.maxFileBytes, ADAPTIVE_JOURNAL_MAX_FILE_BYTES) ?? -1,
    maxInvocations: positiveInt(raw.maxInvocations, ADAPTIVE_JOURNAL_MAX_INVOCATIONS) ?? -1,
    maxTerminalVariantsPerInvocation:
      positiveInt(raw.maxTerminalVariantsPerInvocation, ADAPTIVE_JOURNAL_MAX_TERMINAL_VARIANTS) ?? -1,
    maxEventLogLines: positiveInt(raw.maxEventLogLines, BEHAVIOR_LINKAGE_MAX_EVENT_LOG_LINES) ?? -1,
    maxToolCalls: positiveInt(raw.maxToolCalls, BEHAVIOR_LINKAGE_MAX_TOOL_CALLS) ?? -1,
    maxTrajectoryRows: positiveInt(raw.maxTrajectoryRows, BEHAVIOR_LINKAGE_MAX_TRAJECTORY_ROWS) ?? -1,
    maxActionsPerInvocation:
      positiveInt(raw.maxActionsPerInvocation, BEHAVIOR_LINKAGE_MAX_ACTIONS_PER_INVOCATION) ?? -1,
    maxCorrectionsPerInvocation:
      positiveInt(raw.maxCorrectionsPerInvocation, BEHAVIOR_LINKAGE_MAX_CORRECTIONS_PER_INVOCATION) ?? -1,
    maxOutcomesPerInvocation:
      positiveInt(raw.maxOutcomesPerInvocation, BEHAVIOR_LINKAGE_MAX_OUTCOMES_PER_INVOCATION) ?? -1,
    maxWeakCandidatesPerInvocation:
      positiveInt(raw.maxWeakCandidatesPerInvocation, BEHAVIOR_LINKAGE_MAX_WEAK_CANDIDATES_PER_INVOCATION) ?? -1,
    maxSessionQueries: positiveInt(raw.maxSessionQueries, BEHAVIOR_LINKAGE_MAX_SESSION_QUERIES) ?? -1,
  };
  return Object.values(values).some((value) => value < 0) ? null : values;
}

function utcDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function windowDateKeys(startIso: string, endIso: string): string[] {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const firstDayMs = Date.UTC(
    new Date(startMs).getUTCFullYear(),
    new Date(startMs).getUTCMonth(),
    new Date(startMs).getUTCDate(),
  );
  const dates: string[] = [];
  for (let cursor = firstDayMs; cursor <= endMs; cursor += DAY_MS) {
    dates.push(utcDateKey(cursor));
  }
  // EventLog names files by flush time, so a record created just before
  // midnight can live in the next UTC day's file. Envelope ts still filters.
  dates.push(utcDateKey(firstDayMs + dates.length * DAY_MS));
  return dates;
}

function normalizePathForComparison(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function realpathOrNull(value: string): string | null {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = normalizePathForComparison(root);
  const normalizedCandidate = normalizePathForComparison(candidate);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

interface EventLogFile {
  absolutePath: string;
  dateKey: string;
  logDir: string;
  dirPriority: number;
}

interface EventLogCoverage {
  dirsFound: number;
  filesRead: number;
  linesRead: number;
  toolCalls: number;
  truncated: boolean;
  omittedFiles: number;
  parseErrors: number;
  errors: number;
  unattributedToolCalls: number;
}

function selectEventLogFiles(input: {
  workspaceDir: string;
  dates: string[];
  maxDateFilesPerDir: number;
  coverage: EventLogCoverage;
}): EventLogFile[] {
  const { workspaceDir, dates, maxDateFilesPerDir, coverage } = input;
  const dateSet = new Set(dates);
  const selected: EventLogFile[] = [];
  const canonicalWorkspace = realpathOrNull(workspaceDir);
  if (canonicalWorkspace === null) return selected;

  ADAPTIVE_JOURNAL_CANDIDATE_DIRS.forEach((logDir, dirPriority) => {
    const absoluteDir = path.resolve(workspaceDir, logDir);
    const canonicalDir = realpathOrNull(absoluteDir);
    if (canonicalDir === null) return;
    if (!isInside(canonicalWorkspace, canonicalDir)) {
      coverage.errors += 1;
      return;
    }
    coverage.dirsFound += 1;
    let names: string[];
    try {
      names = fs.readdirSync(canonicalDir);
    } catch {
      coverage.errors += 1;
      return;
    }
    const dateFiles = names
      .map((name) => {
        const match = /^events_(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
        return match?.[1] ? { name, dateKey: match[1] } : null;
      })
      .filter((entry): entry is { name: string; dateKey: string } => entry !== null && dateSet.has(entry.dateKey))
      .sort((left, right) => right.dateKey.localeCompare(left.dateKey));
    const omitted = Math.max(0, dateFiles.length - maxDateFilesPerDir);
    if (omitted > 0) {
      coverage.omittedFiles += omitted;
      // A whole date file was not read: this is bounded coverage, never "absent".
      coverage.truncated = true;
    }
    for (const entry of dateFiles.slice(0, maxDateFilesPerDir)) {
      selected.push({
        absolutePath: path.join(canonicalDir, entry.name),
        dateKey: entry.dateKey,
        logDir,
        dirPriority,
      });
    }
  });

  return selected.sort((left, right) => {
    const byDate = right.dateKey.localeCompare(left.dateKey);
    return byDate !== 0 ? byDate : left.dirPriority - right.dirPriority;
  });
}

interface BoundedLines {
  lines: { text: string; ordinal: number }[];
  bytesRead: number;
  truncated: boolean;
}

function readTailLines(absolutePath: string, maxBytes: number): BoundedLines {
  const fd = fs.openSync(absolutePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    if (length === 0) return { lines: [], bytesRead: 0, truncated: false };
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    const rawLines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const lines = rawLines.map((line, index) => ({
      text: line,
      ordinal: start > 0 ? -1 : index + 1,
    }));
    return { lines, bytesRead: length, truncated: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

function hashRef(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function readToolCallRows(input: {
  workspaceDir: string;
  window: { start: string; end: string };
  limits: ResolvedLinkLimits;
  coverage: EventLogCoverage;
}): ToolCallRow[] {
  const { workspaceDir, window, limits, coverage } = input;
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  const files = selectEventLogFiles({
    workspaceDir,
    dates: windowDateKeys(window.start, window.end),
    maxDateFilesPerDir: limits.maxDateFilesPerDir,
    coverage,
  });
  const rows: ToolCallRow[] = [];
  let lineBudget = limits.maxEventLogLines;
  let stopped = false;

  for (const file of files) {
    if (stopped) break;
    let bounded: BoundedLines;
    try {
      bounded = readTailLines(file.absolutePath, limits.maxFileBytes);
      coverage.filesRead += 1;
    } catch {
      coverage.errors += 1;
      continue;
    }
    if (bounded.truncated) coverage.truncated = true;
    for (const line of bounded.lines) {
      if (lineBudget <= 0) {
        coverage.truncated = true;
        stopped = true;
        break;
      }
      lineBudget -= 1;
      coverage.linesRead += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.text);
      } catch {
        coverage.parseErrors += 1;
        continue;
      }
      if (!isRecord(parsed) || parsed.type !== 'tool_call') continue;
      const ts = optionalString(parsed.ts);
      if (ts === null) continue;
      const tsMs = Date.parse(ts);
      if (!Number.isFinite(tsMs) || tsMs < startMs || tsMs > endMs) continue;
      if (rows.length >= limits.maxToolCalls) {
        coverage.truncated = true;
        stopped = true;
        break;
      }
      const data = isRecord(parsed.data) ? parsed.data : {};
      const sessionId = optionalString(parsed.sessionId) ?? optionalString(data.sessionId);
      const runId = optionalString(data.runId);
      const toolName = optionalString(data.toolName) ?? 'unknown';
      const outcome: 'success' | 'failure' | 'unknown' = parsed.category === 'success' || parsed.category === 'failure'
        ? parsed.category
        : (optionalString(data.error) !== null || (optionalNumber(data.exitCode) ?? 0) !== 0 ? 'failure' : 'unknown');
      const toolCallId = optionalString(data.toolCallId);
      const ordinal = line.ordinal >= 0 ? `${line.ordinal}` : `tail:${rows.length + 1}`;
      rows.push({
        ts,
        tsMs,
        sessionId,
        runId,
        toolName,
        toolCallIdRef: toolCallId === null ? null : hashRef(toolCallId),
        outcome,
        exitCode: optionalNumber(data.exitCode),
        errorType: optionalString(data.errorType),
        errorPresent: optionalString(data.error) !== null,
        declaresFilePath: optionalString(data.filePath) !== null,
        logRef: `${path.basename(file.absolutePath)}:${ordinal}`,
      });
    }
  }
  coverage.toolCalls = rows.length;
  coverage.unattributedToolCalls = rows.filter(
    (row) => row.sessionId === null || row.runId === null,
  ).length;
  return rows;
}

class SqlRowBudget {
  remaining: number;

  constructor(max: number) {
    this.remaining = max;
  }
}

interface BoundedRows {
  rows: Record<string, unknown>[];
  truncated: boolean;
}

function isRecordRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecordRows(value: unknown[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const row of value) {
    if (!isRecordRow(row)) throw new Error('trajectory_row_malformed');
    rows.push(row);
  }
  return rows;
}

function boundedQuery(input: {
  db: Database.Database;
  sql: string;
  params: unknown[];
  budget: SqlRowBudget;
  requested: number;
}): BoundedRows {
  const { db, sql, params, budget, requested } = input;
  if (budget.remaining <= 0) return { rows: [], truncated: true };
  const limit = Math.min(requested, budget.remaining);
  const rows = requireRecordRows(db.prepare(sql).all(...params, limit + 1));
  const kept = rows.slice(0, limit);
  budget.remaining = Math.max(0, budget.remaining - kept.length);
  return { rows: kept, truncated: rows.length > limit };
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  const columns = new Set<string>();
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    for (const row of rows) {
      if (isRecordRow(row) && typeof row.name === 'string') columns.add(row.name);
    }
  } catch {
    return new Set();
  }
  return columns;
}

function hasRequiredSchema(db: Database.Database): boolean {
  const required: Record<string, string[]> = {
    assistant_turns: ['id', 'session_id', 'run_id', 'created_at'],
    user_turns: ['id', 'session_id', 'turn_index', 'correction_detected', 'references_assistant_turn_id', 'created_at'],
    tool_calls: ['id', 'session_id', 'tool_name', 'outcome', 'created_at'],
    task_outcomes: ['id', 'session_id', 'task_id', 'outcome', 'principle_ids_json', 'created_at'],
  };
  for (const [table, columns] of Object.entries(required)) {
    const actual = tableColumns(db, table);
    if (actual.size === 0) return false;
    for (const column of columns) {
      if (!actual.has(column)) return false;
    }
  }
  return true;
}

function readTrajectory(input: {
  workspaceDir: string;
  invocations: AdaptiveJournalInvocation[];
  window: { start: string; end: string };
  limits: ResolvedLinkLimits;
}): TrajectoryReadResult {
  const { workspaceDir, invocations, window, limits } = input;
  const sessions = new Map<string, SessionTrajectoryRows>();
  const distinctSessions = [...new Set(
    invocations.flatMap((invocation) => (invocation.identity.sessionId === null ? [] : [invocation.identity.sessionId])),
  )].sort();
  const result: TrajectoryReadResult = {
    status: 'unavailable',
    rowsRead: 0,
    truncated: false,
    reasons: [],
    sessions,
  };

  let db: Database.Database;
  try {
    db = openTrajectoryDbReadonly(workspaceDir);
  } catch {
    result.reasons.push('trajectory_db_unavailable');
    return result;
  }

  try {
    try {
      db.pragma('query_only = ON');
    } catch {
      result.reasons.push('query_only_unavailable');
    }
    if (!hasRequiredSchema(db)) {
      result.reasons.push('trajectory_schema_incomplete');
      return result;
    }
    result.status = 'read';
    const budget = new SqlRowBudget(limits.maxTrajectoryRows);
    const sessionsToQuery = distinctSessions.slice(0, limits.maxSessionQueries);
    if (sessionsToQuery.length < distinctSessions.length) {
      result.truncated = true;
      result.reasons.push('session_query_limit_reached');
    }

    for (const sessionId of sessionsToQuery) {
      const row: SessionTrajectoryRows = {
        corrections: [],
        outcomes: [],
        weakToolCalls: [],
        correctionsTruncated: false,
        outcomesTruncated: false,
        weakTruncated: false,
        queryFailed: false,
      };
      try {
        const corrections = boundedQuery({
          db,
          sql: `SELECT u.id AS user_turn_id, u.turn_index, u.correction_detected,
                  u.references_assistant_turn_id, u.created_at, a.run_id AS referenced_run_id
             FROM user_turns u
             LEFT JOIN assistant_turns a ON a.id = u.references_assistant_turn_id
            WHERE u.session_id = ? AND u.correction_detected = 1
              AND u.created_at >= ? AND u.created_at <= ?
            ORDER BY u.created_at ASC, u.id ASC
            LIMIT ?`,
          params: [sessionId, window.start, window.end],
          budget,
          requested: BEHAVIOR_LINKAGE_ROWS_PER_SESSION,
        });
        row.corrections = corrections.rows;
        row.correctionsTruncated = corrections.truncated;

        const outcomes = boundedQuery({
          db,
          sql: `SELECT id, task_id, outcome, principle_ids_json, created_at
             FROM task_outcomes
            WHERE session_id = ? AND created_at >= ? AND created_at <= ?
            ORDER BY created_at ASC, id ASC
            LIMIT ?`,
          params: [sessionId, window.start, window.end],
          budget,
          requested: BEHAVIOR_LINKAGE_ROWS_PER_SESSION,
        });
        row.outcomes = outcomes.rows;
        row.outcomesTruncated = outcomes.truncated;

        const weakToolCalls = boundedQuery({
          db,
          sql: `SELECT id, tool_name, outcome, created_at
             FROM tool_calls
            WHERE session_id = ? AND created_at >= ? AND created_at <= ?
            ORDER BY created_at ASC, id ASC
            LIMIT ?`,
          params: [sessionId, window.start, window.end],
          budget,
          requested: BEHAVIOR_LINKAGE_ROWS_PER_SESSION,
        });
        row.weakToolCalls = weakToolCalls.rows;
        row.weakTruncated = weakToolCalls.truncated;
        // A truncated per-session read means rows may exist past the cap; the
        // targeted run's row can be among them, so the whole read is incomplete.
        if (corrections.truncated || outcomes.truncated || weakToolCalls.truncated) {
          result.truncated = true;
          if (!result.reasons.includes('session_rows_truncated')) {
            result.reasons.push('session_rows_truncated');
          }
        }
      } catch {
        row.queryFailed = true;
        result.truncated = true;
        result.reasons.push('trajectory_query_failed');
      }
      sessions.set(sessionId, row);
    }
    result.rowsRead = limits.maxTrajectoryRows - budget.remaining;
    if (budget.remaining <= 0) {
      result.truncated = true;
      result.reasons.push('trajectory_row_limit_reached');
    }
  } finally {
    db.close();
  }
  return result;
}

function configChanged(invocation: AdaptiveJournalInvocation): boolean {
  const open = invocation.open?.configIdentity ?? null;
  const terminal = invocation.terminal?.configIdentity ?? null;
  if (open === null || terminal === null) return false;
  return open.effectiveHookSetFingerprint !== terminal.effectiveHookSetFingerprint
    || open.hostVersion !== terminal.hostVersion
    || open.pluginVersion !== terminal.pluginVersion;
}

function journalRangeComplete(report: AdaptiveJournalReport): boolean {
  return report.coverage.status === 'complete'
    && (report.truncation?.omitted ?? 0) === 0
    && !report.outputTruncated
    // Design §4.2: dropped parse/envelope/identity failures make uniqueness unproven.
    && (report.totals.malformedJsonLines ?? 0) === 0
    && (report.totals.invalidEnvelopeRecords ?? 0) === 0
    && (report.totals.invalidRecords ?? 0) === 0;
}

function classifyAssociation(
  invocation: AdaptiveJournalInvocation,
  sameRunCount: number,
  rangeComplete: boolean,
): { association: BehaviorAssociation; reasons: BehaviorAssociationReason[] } {
  const reasons: BehaviorAssociationReason[] = [];
  if (invocation.classification === 'conflicted') {
    reasons.push('terminal_conflicted');
    return { association: 'conflict', reasons };
  }

  const identityValid = invocation.identity.runId !== null
    && invocation.identity.sessionId !== null
    && invocation.identity.workspaceVerified;

  if (invocation.open === null) {
    reasons.push('open_not_visible_in_range');
    return { association: identityValid ? 'weak' : 'unknown', reasons };
  }
  if (invocation.terminal === null) {
    reasons.push('terminal_not_visible_in_range');
    return { association: identityValid ? 'weak' : 'unknown', reasons };
  }
  if (!rangeComplete) {
    reasons.push('journal_range_incomplete');
    return { association: 'unknown', reasons };
  }
  if (!identityValid) {
    reasons.push(invocation.identity.runId === null ? 'run_identity_missing' : 'workspace_identity_unknown');
    return { association: 'unknown', reasons };
  }
  if (invocation.duplicates.open > 0 || invocation.duplicates.terminal > 0) {
    reasons.push('duplicate_records');
    return { association: 'unknown', reasons };
  }
  if (invocation.targetConsistent !== true) {
    reasons.push('target_identity_unproven');
    return { association: 'unknown', reasons };
  }
  if (configChanged(invocation)) {
    reasons.push('config_changed');
    return { association: 'unknown', reasons };
  }
  if (sameRunCount > 1) {
    reasons.push('run_has_multiple_invocations');
    return { association: 'ambiguous', reasons };
  }
  reasons.push('run_identity_proven');
  return { association: 'strong_run', reasons };
}

function parsePrincipleIds(value: unknown): string[] | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const ids: string[] = [];
    for (const entry of parsed) {
      // rc-4/rc-9: a partially invalid array is incomparable, not "absent".
      if (typeof entry !== 'string' || entry.length === 0) return null;
      ids.push(entry);
    }
    return ids;
  } catch {
    return null;
  }
}

function stringField(row: Record<string, unknown>, key: string): string | null {
  return optionalString(row[key]);
}

function numericField(row: Record<string, unknown>, key: string): number | null {
  return optionalNumber(row[key]);
}

function buildInvocation(input: {
  invocation: AdaptiveJournalInvocation;
  sameRunCount: number;
  rangeComplete: boolean;
  actionsByRun: Map<string, ToolCallRow[]>;
  trajectory: TrajectoryReadResult;
  limits: ResolvedLinkLimits;
}): BehaviorLinkageInvocation {
  const { invocation, sameRunCount, rangeComplete, actionsByRun, trajectory, limits } = input;
  const { association, reasons } = classifyAssociation(invocation, sameRunCount, rangeComplete);
  const openTs = invocation.open?.ts ?? null;
  const openMs = openTs === null ? null : Date.parse(openTs);
  const { runId, sessionId } = invocation.identity;
  const key = runId === null || sessionId === null ? null : `${sessionId}\u0000${runId}`;
  const runActions = key === null ? [] : (actionsByRun.get(key) ?? []);

  const actions: BehaviorLinkageActionFact[] = [];
  let actionsTruncated = false;
  for (const row of runActions) {
    if (actions.length >= limits.maxActionsPerInvocation) {
      actionsTruncated = true;
      break;
    }
    const relative: BehaviorLinkageActionFact['relativeToRecordedOpen'] = openMs === null
      ? 'no_open_timestamp'
      : row.tsMs < openMs ? 'before_open' : 'after_open';
    actions.push({
      source: 'event_log.tool_call',
      toolName: row.toolName,
      toolCallIdRef: row.toolCallIdRef,
      outcome: row.outcome,
      exitCode: row.exitCode,
      errorType: row.errorType,
      errorPresent: row.errorPresent,
      ts: row.ts,
      ordering: 'unknown',
      relativeToRecordedOpen: relative,
      strength: association === 'strong_run' ? 'run_strong' : 'run_ambiguous',
      verified: association === 'strong_run',
      logRef: row.logRef,
    });
  }
  if (actions.some((action) => action.relativeToRecordedOpen === 'before_open')) {
    reasons.push('action_before_open');
  }
  actions.sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));

  const actionsByTool = new Set<string>();
  let declaredTargetCount = 0;
  for (const row of runActions) {
    if (!row.declaresFilePath) continue;
    declaredTargetCount += 1;
    actionsByTool.add(row.toolName);
  }

  const sessionRows = sessionId === null ? null : (trajectory.sessions.get(sessionId) ?? null);
  const corrections: BehaviorLinkageCorrectionFact[] = [];
  let correctionsTruncated = false;
  for (const row of sessionRows?.corrections ?? []) {
    const userId = numericField(row, 'user_turn_id');
    const referencedAssistantTurnId = numericField(row, 'references_assistant_turn_id');
    const referencedRunId = stringField(row, 'referenced_run_id');
    const runBound = runId !== null && referencedRunId === runId;
    if (!runBound && referencedAssistantTurnId !== null && referencedRunId !== null) continue;
    if (corrections.length >= limits.maxCorrectionsPerInvocation) {
      correctionsTruncated = true;
      break;
    }
    corrections.push({
      source: 'trajectory.user_turns',
      userTurnId: userId ?? -1,
      turnIndex: numericField(row, 'turn_index') ?? -1,
      referencedAssistantTurnId,
      referencedRunId,
      createdAt: stringField(row, 'created_at') ?? '',
      ordering: 'unknown',
      strength: runBound ? (association === 'strong_run' ? 'run_strong' : 'run_ambiguous') : 'weak',
      verified: runBound && association === 'strong_run',
    });
  }

  const outcomes: BehaviorLinkageOutcomeFact[] = [];
  let outcomesTruncated = false;
  for (const row of sessionRows?.outcomes ?? []) {
    if (runId === null || stringField(row, 'task_id') !== runId) continue;
    if (outcomes.length >= limits.maxOutcomesPerInvocation) {
      outcomesTruncated = true;
      break;
    }
    const recordedOutcome = stringField(row, 'outcome');
    const principleIds = parsePrincipleIds(row.principle_ids_json);
    outcomes.push({
      source: 'trajectory.task_outcomes',
      outcomeId: numericField(row, 'id') ?? -1,
      recordedOutcome,
      modelCompletionRecorded: recordedOutcome === 'completed',
      semantics: 'model_completion_only',
      taskSuccess: 'unknown',
      principleBinding: principleIds !== null && principleIds.length === 0 ? 'absent' : 'session_level_unknown',
      principleIdCount: principleIds?.length ?? 0,
      createdAt: stringField(row, 'created_at') ?? '',
      strength: association === 'strong_run' ? 'run_strong' : 'run_ambiguous',
      verified: association === 'strong_run',
    });
  }

  const weakCandidates: BehaviorLinkageWeakCandidate[] = [];
  let weakTruncated = false;
  if (sessionRows !== null) {
    for (const row of sessionRows.weakToolCalls) {
      if (weakCandidates.length >= limits.maxWeakCandidatesPerInvocation) {
        weakTruncated = true;
        break;
      }
      weakCandidates.push({
        source: 'trajectory.tool_calls',
        rowId: numericField(row, 'id') ?? -1,
        toolName: stringField(row, 'tool_name') ?? 'unknown',
        outcome: stringField(row, 'outcome'),
        createdAt: stringField(row, 'created_at') ?? '',
        reason: 'session_tool_time_only',
        verified: false,
      });
    }
  }

  const unknowns: BehaviorLinkageInvocation['unknowns'] = [];
  const addUnknown = (fact: string, reasonCode: BehaviorUnknownReason): void => {
    unknowns.push({ fact, reasonCode });
  };
  for (const reason of reasons) {
    if (reason === 'journal_range_incomplete') addUnknown('run_uniqueness', 'journal_range_incomplete');
    if (reason === 'run_has_multiple_invocations') addUnknown('run_uniqueness', 'run_has_multiple_invocations');
    if (reason === 'duplicate_records') addUnknown('terminal_identity', 'duplicate_records');
    if (reason === 'config_changed') addUnknown('config_identity', 'config_changed');
    if (reason === 'terminal_not_visible_in_range') addUnknown('terminal', 'terminal_not_visible_in_range');
    if (reason === 'open_not_visible_in_range') addUnknown('open', 'open_not_visible_in_range');
  }
  if (actions.length > 0) addUnknown('ordering', 'delivery_time_unavailable');
  if (actionsTruncated) addUnknown('actions', 'action_limit_reached');
  if (correctionsTruncated) addUnknown('corrections', 'correction_limit_reached');
  if (outcomesTruncated) addUnknown('outcomes', 'outcome_limit_reached');
  if (weakTruncated) addUnknown('weak_candidates', 'weak_candidate_limit_reached');
  // Session-level truncation is not the per-opportunity cap: filtering by run
  // can hide the missing rows, so it must degrade coverage on its own.
  if (sessionRows?.correctionsTruncated) addUnknown('corrections', 'session_rows_truncated');
  if (sessionRows?.outcomesTruncated) addUnknown('outcomes', 'session_rows_truncated');
  if (sessionRows?.weakTruncated) addUnknown('weak_candidates', 'session_rows_truncated');
  if (sessionRows?.queryFailed) addUnknown('trajectory', 'trajectory_row_limit_reached');
  if (trajectory.status === 'unavailable') {
    addUnknown('trajectory', trajectory.reasons.includes('trajectory_schema_incomplete')
      ? 'trajectory_schema_incomplete'
      : 'trajectory_db_unavailable');
  } else if (trajectory.truncated) {
    for (const reason of trajectory.reasons) {
      if (reason === 'session_query_limit_reached') addUnknown('trajectory', 'session_query_limit_reached');
      if (reason === 'session_rows_truncated') addUnknown('trajectory', 'session_rows_truncated');
      if (reason === 'trajectory_row_limit_reached') addUnknown('trajectory', 'trajectory_row_limit_reached');
    }
  }
  if (outcomes.length > 0) {
    addUnknown('task_result', 'model_completion_only');
    addUnknown('task_result', 'task_success_not_observable');
    addUnknown('principle_binding', 'principle_ids_not_comparable');
  }
  if (declaredTargetCount > 0) addUnknown('artifact', 'artifact_effect_not_observable');

  const conflicts: BehaviorLinkageInvocation['conflicts'] = [];
  if (invocation.classification === 'conflicted') {
    conflicts.push({
      kind: 'journal',
      reasonCodes: invocation.reasonCodes.filter((code) => code !== 'output_truncated').sort(),
      duplicateCount: invocation.duplicates.open + invocation.duplicates.terminal,
    });
  }
  if (reasons.includes('config_changed')) {
    conflicts.push({
      kind: 'config_identity',
      reasonCodes: ['effectiveHookSetFingerprint_mismatch'],
    });
  }

  return {
    intervention: {
      hookInvocationId: invocation.invocationId,
      runId,
      sessionId,
      host: invocation.identity.host,
      workspaceVerified: invocation.identity.workspaceVerified,
      artifactId: invocation.terminal?.artifactId ?? invocation.open?.artifactId ?? null,
      activationId: invocation.terminal?.activationId ?? invocation.open?.activationId ?? null,
      targetBodySha256: invocation.terminal?.targetBodySha256 ?? null,
      configIdentity: invocation.terminal?.configIdentity ?? invocation.open?.configIdentity ?? null,
      terminal: {
        receiptState: invocation.terminal?.receiptState ?? null,
        variants: invocation.terminalVariants.length,
        classification: invocation.classification,
      },
      openTs,
      terminalTs: invocation.terminal?.ts ?? null,
    },
    association,
    associationReasons: reasons,
    evidenceLayers: {
      runAssociation: association,
      requestAssociation: 'unknown',
      principleAdherence: 'unknown',
      behaviorImprovement: 'unknown',
    },
    facts: {
      actions,
      corrections,
      outcomes,
      artifacts: {
        declaredTargetCount,
        declaredByToolNames: [...actionsByTool].sort(),
        confirmedCount: 0,
        confirmation: 'unknown',
      },
    },
    weakCandidates,
    unknowns,
    conflicts,
  };
}

export function linkAdaptiveBehaviorEvidence(input: LinkAdaptiveBehaviorEvidenceInput): BehaviorLinkageResult {
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const limits = resolveLimits(input.limits);
  if (limits === null) {
    return {
      ok: false,
      schemaVersion: ADAPTIVE_BEHAVIOR_LINKAGE_SCHEMA_VERSION,
      generatedAt,
      readOnly: true,
      error: {
        code: 'invalid_limit',
        message: 'One or more read limits is not a positive integer.',
        nextAction: '给出大于 0 的整数上限，或省略该上限使用默认值。',
      },
    };
  }
  if (!fs.existsSync(input.workspaceDir)) {
    return {
      ok: false,
      schemaVersion: ADAPTIVE_BEHAVIOR_LINKAGE_SCHEMA_VERSION,
      generatedAt,
      readOnly: true,
      error: {
        code: 'workspace_unavailable',
        message: `Workspace does not exist: ${input.workspaceDir}`,
        nextAction: '使用 -w/--workspace 指向一个存在的 PD 工作区。',
      },
    };
  }

  const journal = reconcileAdaptiveJournal({
    workspaceDir: input.workspaceDir,
    since: input.since,
    until: input.until,
    host: input.host,
    now,
    limits: {
      maxDateFilesPerDir: limits.maxDateFilesPerDir,
      maxFileBytes: limits.maxFileBytes,
      maxInvocations: limits.maxInvocations,
      maxTerminalVariantsPerInvocation: limits.maxTerminalVariantsPerInvocation,
    },
  });
  if (!journal.ok) {
    return {
      ok: false,
      schemaVersion: ADAPTIVE_BEHAVIOR_LINKAGE_SCHEMA_VERSION,
      generatedAt,
      readOnly: true,
      error: journal.error,
    };
  }
  const { report } = journal;
  const { window } = report.request;
  const rangeComplete = journalRangeComplete(report);

  const eventLog: EventLogCoverage = {
    dirsFound: 0,
    filesRead: 0,
    linesRead: 0,
    toolCalls: 0,
    truncated: false,
    omittedFiles: 0,
    parseErrors: 0,
    errors: 0,
    unattributedToolCalls: 0,
  };
  const toolCalls = readToolCallRows({
    workspaceDir: input.workspaceDir,
    window,
    limits,
    coverage: eventLog,
  });

  const actionsByRun = new Map<string, ToolCallRow[]>();
  for (const row of toolCalls) {
    if (row.runId === null || row.sessionId === null) continue;
    const key = `${row.sessionId}\u0000${row.runId}`;
    const bucket = actionsByRun.get(key);
    if (bucket === undefined) actionsByRun.set(key, [row]);
    else bucket.push(row);
  }

  const trajectory = readTrajectory({
    workspaceDir: input.workspaceDir,
    invocations: report.invocations,
    window,
    limits,
  });

  const runCounts = new Map<string, number>();
  for (const invocation of report.invocations) {
    const { runId, sessionId } = invocation.identity;
    if (runId === null || sessionId === null) continue;
    const key = `${sessionId}\u0000${runId}`;
    runCounts.set(key, (runCounts.get(key) ?? 0) + 1);
  }

  const invocations = report.invocations.map((invocation) => {
    const { runId, sessionId } = invocation.identity;
    const key = runId === null || sessionId === null ? null : `${sessionId}\u0000${runId}`;
    const sameRunCount = key === null ? 0 : (runCounts.get(key) ?? 0);
    return buildInvocation({
      invocation,
      sameRunCount,
      rangeComplete,
      actionsByRun,
      trajectory,
      limits,
    });
  });

  const incompleteReasons: BehaviorUnknownReason[] = [];
  if (!rangeComplete) incompleteReasons.push('journal_range_incomplete');
  if (eventLog.dirsFound === 0) incompleteReasons.push('event_log_unavailable');
  if (eventLog.omittedFiles > 0) incompleteReasons.push('event_log_files_omitted');
  else if (eventLog.truncated) incompleteReasons.push('event_log_parse_limit_reached');
  if (eventLog.parseErrors > 0) incompleteReasons.push('event_log_parse_errors');
  if (eventLog.errors > 0) incompleteReasons.push('event_log_read_error');
  if (trajectory.status === 'unavailable') {
    incompleteReasons.push(trajectory.reasons.includes('trajectory_schema_incomplete')
      ? 'trajectory_schema_incomplete'
      : 'trajectory_db_unavailable');
  } else {
    if (trajectory.reasons.includes('trajectory_row_limit_reached')) incompleteReasons.push('trajectory_row_limit_reached');
    if (trajectory.reasons.includes('session_query_limit_reached')) incompleteReasons.push('session_query_limit_reached');
    if (trajectory.reasons.includes('session_rows_truncated')) incompleteReasons.push('session_rows_truncated');
    if (trajectory.reasons.includes('trajectory_query_failed')) incompleteReasons.push('trajectory_query_failed');
  }
  // Per-opportunity caps are budgets too: a lower-bound list must not read as complete.
  const perInvocationCaps: BehaviorUnknownReason[] = [
    'action_limit_reached',
    'correction_limit_reached',
    'outcome_limit_reached',
    'weak_candidate_limit_reached',
    'session_rows_truncated',
  ];
  for (const code of perInvocationCaps) {
    if (invocations.some((item) => item.unknowns.some((entry) => entry.reasonCode === code))) {
      incompleteReasons.push(code);
    }
  }

  const byAssociation: Record<BehaviorAssociation, number> = {
    strong_run: 0,
    weak: 0,
    ambiguous: 0,
    unknown: 0,
    conflict: 0,
  };
  for (const invocation of invocations) byAssociation[invocation.association] += 1;

  const nextAction: string[] = [];
  if (incompleteReasons.includes('journal_range_incomplete')) nextAction.push('缩小 --since 窗口或提高 --max-date-files 后重试；日志中被丢弃的解析/身份失败不会被当作“不存在”。');
  if (incompleteReasons.includes('event_log_unavailable')) nextAction.push('未找到 EventLog 目录：本次没有可关联的工具事件，不代表没有发生行动。');
  if (incompleteReasons.includes('event_log_files_omitted')) nextAction.push('提高 --max-date-files，或缩小 --since 窗口以读取全部工具事件文件。');
  if (incompleteReasons.includes('event_log_parse_limit_reached')) nextAction.push('提高 --max-event-lines，或缩小时间窗口以读取完整的工具事件。');
  if (incompleteReasons.includes('event_log_parse_errors')) nextAction.push('部分 EventLog 行无法解析；这些行未被当作“没有行动”。');
  if (incompleteReasons.includes('event_log_read_error')) nextAction.push('部分日志目录/文件不可读；检查权限与符号链接后重试。');
  if (incompleteReasons.includes('trajectory_db_unavailable')) nextAction.push('轨迹库尚不存在；先让插件写入轨迹，或仅使用运行级关联。');
  if (incompleteReasons.includes('trajectory_schema_incomplete')) nextAction.push('轨迹库缺少本读取器所需列；本命令不迁移，请先修复写侧 schema。');
  if (incompleteReasons.includes('trajectory_query_failed')) nextAction.push('轨迹查询失败；修复数据库可读性后重试。');
  if (incompleteReasons.includes('action_limit_reached')) nextAction.push('提高 --max-actions 以读取该机会的全部行动。');
  if (incompleteReasons.includes('correction_limit_reached')) nextAction.push('提高 --max-corrections 以读取该机会的全部纠正记录。');
  if (incompleteReasons.includes('outcome_limit_reached')) nextAction.push('提高 --max-outcomes 以读取该机会的全部任务结果。');
  if (incompleteReasons.includes('weak_candidate_limit_reached')) nextAction.push('提高 --max-weak-candidates 以读取全部弱候选。');
  if (incompleteReasons.includes('trajectory_row_limit_reached') || incompleteReasons.includes('session_query_limit_reached')) {
    nextAction.push('提高 --max-trajectory-rows/--max-session-queries，或缩小时间窗口。');
  }
  if (incompleteReasons.includes('session_rows_truncated')) {
    nextAction.push(`该会话的分类查询已达到固定的单会话 ${BEHAVIOR_LINKAGE_ROWS_PER_SESSION} 行上限；请缩小 --since/--until 时间窗口后重试（--max-trajectory-rows 不控制该上限）。空结果不代表“不存在”。`);
  }
  if (eventLog.unattributedToolCalls > 0) nextAction.push('部分工具事件缺少 run/session 身份，已排除在关联之外；不要把它们当作未发生。');
  if (invocations.some((item) => item.association === 'ambiguous')) nextAction.push('同一 run 存在多个干预机会；按 hookInvocationId 单独复核。');
  if (nextAction.length === 0) nextAction.push('无需操作。');

  const reportOut: BehaviorLinkageReport = {
    schemaVersion: ADAPTIVE_BEHAVIOR_LINKAGE_SCHEMA_VERSION,
    generatedAt,
    readOnly: true,
    request: {
      workspaceDir: input.workspaceDir,
      host: report.request.host,
      window,
    },
    coverage: {
      complete: incompleteReasons.length === 0,
      window,
      journal: {
        status: report.coverage.status,
        complete: rangeComplete,
        filesRead: report.coverage.filesRead,
        filesSkipped: report.coverage.filesSkipped,
        limitCode: report.coverage.limitCode,
        truncatedFiles: report.coverage.truncatedFiles.length,
        errors: report.coverage.errors.length,
        malformedLines: report.totals.malformedJsonLines ?? 0,
        invalidRecords: report.totals.invalidRecords ?? 0,
      },
      eventLog: {
        dirsFound: eventLog.dirsFound,
        filesRead: eventLog.filesRead,
        linesRead: eventLog.linesRead,
        toolCalls: eventLog.toolCalls,
        truncated: eventLog.truncated,
        omittedFiles: eventLog.omittedFiles,
        parseErrors: eventLog.parseErrors,
        errors: eventLog.errors,
        unattributedToolCalls: eventLog.unattributedToolCalls,
      },
      trajectory: {
        status: trajectory.status,
        rowsRead: trajectory.rowsRead,
        truncated: trajectory.truncated,
        reasons: [...new Set(trajectory.reasons)].sort(),
      },
      incompleteReasons,
    },
    totals: {
      invocations: invocations.length,
      byAssociation,
      actions: invocations.reduce((sum, item) => sum + item.facts.actions.length, 0),
      corrections: invocations.reduce((sum, item) => sum + item.facts.corrections.length, 0),
      outcomes: invocations.reduce((sum, item) => sum + item.facts.outcomes.length, 0),
      weakCandidates: invocations.reduce((sum, item) => sum + item.weakCandidates.length, 0),
    },
    invocations,
    nextAction,
  };

  return { ok: true, report: reportOut };
}
