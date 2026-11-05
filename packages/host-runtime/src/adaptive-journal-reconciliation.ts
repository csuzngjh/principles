import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  INTERVENTION_SHORT_SOURCE_RETENTION_DAYS,
  canonicalStringify,
  validateAdaptiveDeliveryRecord,
} from '@principles/core/runtime-v2';

/**
 * PRI-1109 — conservative, read-only reconciliation of adaptive-delivery journal
 * records (approved design: docs/specs/PD-AA-PRI-1109-JOURNAL-RECONCILE-DESIGN-v0.2.md).
 *
 * Semantic red lines enforced here:
 * - closed/reconciled is a recorded phase, never success;
 * - payload=confirmed and submission are only transcribed as recorded evidence
 *   declarations (never re-verified by this reader);
 * - an absent terminal, absent start, or absent log is "not visible in the
 *   scanned range", never a claim about what happened outside it;
 * - non-adaptive events are irrelevant, not invalid;
 * - every truncation / coverage limit is explicit, never silent.
 */

export const ADAPTIVE_JOURNAL_SCHEMA_VERSION = 'pd-aa-journal-reconciliation/v1' as const;
export const ADAPTIVE_JOURNAL_CANDIDATE_DIRS = ['.pd/logs', '.state/logs'] as const;
export const ADAPTIVE_JOURNAL_MAX_DATE_FILES_PER_DIR = 9;
export const ADAPTIVE_JOURNAL_MAX_FILE_BYTES = 4 * 1024 * 1024;
/**
 * Character budget for the full-content duplicate identity comparison. A record
 * comes from a file capped at ADAPTIVE_JOURNAL_MAX_FILE_BYTES, so on the default
 * read path its canonical form fits this budget. A caller that raises
 * maxFileBytes far enough can exceed it: such records are then treated as
 * DISTINCT (never as exact duplicates) and the limitation is reported via
 * coverage.identityComparisonLimited.
 */
const IDENTITY_COMPARISON_MAX_CHARS = ADAPTIVE_JOURNAL_MAX_FILE_BYTES;
export const ADAPTIVE_JOURNAL_MAX_INVOCATIONS = 1000;
export const ADAPTIVE_JOURNAL_MAX_TERMINAL_VARIANTS = 5;
export const ADAPTIVE_JOURNAL_SUPPORTED_HOST = 'openclaw';

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_FILE_PATTERN = /^events_(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MAX_REJECTED_SAMPLES = 3;

export type JournalClassification =
  | 'paired_open_and_terminal'
  | 'open_only'
  | 'terminal_only'
  | 'conflicted'
  | 'invalid';

/** Closed reason-code set from design §6. */
export type JournalReasonCode =
  | 'terminal_not_visible_in_range'
  | 'window_end_explicit_not_now'
  | 'start_not_visible_in_range'
  | 'exact_duplicate_record'
  | 'multiple_starts_conflict'
  | 'conflicting_terminal_states'
  | 'target_identity_mismatch'
  | 'malformed_json'
  | 'non_adaptive_event'
  | 'invalid_envelope'
  | 'missing_hook_invocation_id'
  | 'invalid_four_dimension_state'
  | 'session_identity_mismatch'
  | 'workspace_identity_unknown'
  | 'foreign_workspace'
  | 'host_identity_unknown'
  | 'record_before_coverage_start'
  | 'output_truncated'
  | 'terminal_variants_truncated';

export type JournalSessionIdSource = 'envelope' | 'data' | 'both' | 'none';
export type JournalCoverageStatus = 'complete' | 'partial' | 'unavailable';
export type JournalCountBasis = 'exact' | 'lower_bound' | null;

export interface AdaptiveJournalRequestWindow {
  start: string;
  end: string;
  inclusiveBounds: '[start,end]';
  endIsNow: boolean;
  requestedStart: string;
  clampedByRetention: boolean;
  retentionDays: number;
}

export interface AdaptiveJournalRequest {
  workspaceDir: string;
  host: string;
  window: AdaptiveJournalRequestWindow;
  logDirs: string[];
  pairingKey: string[];
}

export interface AdaptiveJournalCoverageError {
  logDir: string;
  file: string | null;
  code: 'read_failed' | 'stat_failed' | 'outside_workspace';
  message: string;
}

export interface AdaptiveJournalCoverage {
  status: JournalCoverageStatus;
  sourceDirsFound: number;
  filesRead: number;
  filesSkipped: number;
  bytesRead: number;
  dateFilesIntersecting: number;
  limitCode: 'coverage_file_limit_reached' | null;
  filesOmitted: string[];
  truncatedFiles: string[];
  errors: AdaptiveJournalCoverageError[];
  /**
   * True when at least one record's canonical full content exceeded the identity
   * comparison budget. Those records were conservatively treated as distinct:
   * exact duplication was never asserted for them.
   */
  identityComparisonLimited: boolean;
}

export interface AdaptiveJournalTotals {
  linesRead: number | null;
  adaptiveRecords: number | null;
  nonAdaptiveLines: number | null;
  malformedJsonLines: number | null;
  invalidEnvelopeRecords: number | null;
  invalidRecords: number | null;
  duplicatesExact: number | null;
  uniqueInvocations: number | null;
  rejectedRecords: number | null;
  countsAreLowerBounds: boolean;
}

export interface AdaptiveJournalRecordProjection {
  ts: string;
  receiptState: 'open' | 'closed' | 'reconciled';
  execution: string;
  payload: string;
  selection: string;
  submission: string;
  selectionPending: boolean | null;
  reason: string | null;
  artifactId: string | null;
  activationId: string | null;
  requestId: string | null;
  evidenceReferencePresent: boolean;
  /** Transcribed as recorded; never re-verified by this reader. */
  evidenceIndependentlyVerifiedAsRecorded: boolean | null;
  /** Transcribed as recorded; never re-verified by this reader. */
  hostKillConfirmedAsRecorded: boolean | null;
}

export interface AdaptiveJournalInvocationIdentity {
  host: string;
  workspaceDir: string | null;
  workspaceVerified: boolean;
  sessionId: string | null;
  sessionIdSource: JournalSessionIdSource;
  runId: string | null;
}

export interface AdaptiveJournalInvocation {
  invocationId: string;
  identity: AdaptiveJournalInvocationIdentity;
  targetConsistent: boolean | null;
  classification: JournalClassification;
  reasonCodes: JournalReasonCode[];
  open: AdaptiveJournalRecordProjection | null;
  terminal: AdaptiveJournalRecordProjection | null;
  terminalVariants: AdaptiveJournalRecordProjection[];
  terminalVariantsOmitted: number;
  duplicates: { open: number; terminal: number };
  window: { openInWindow: boolean; terminalInWindow: boolean; terminalSearchComplete: boolean };
  unknowns: string[];
}

export interface AdaptiveJournalRejectedGroup {
  reasonCode: JournalReasonCode;
  count: number;
  samples: { logDir: string; file: string; line: number; hookInvocationId: string | null }[];
}

export interface AdaptiveJournalAnswer {
  count: number | null;
  countBasis: JournalCountBasis;
  invocationIds: string[];
  reasonCodes?: string[];
}

export interface AdaptiveJournalTruncation {
  reason: 'output_truncated';
  limit: number;
  included: number;
  omitted: number;
  omittedByClassification: Record<JournalClassification, number>;
  variantLimitPerInvocation: number;
  terminalVariantsOmitted: number;
  coverageLimitCode: 'coverage_file_limit_reached' | null;
  suggestions: string[];
}

export interface AdaptiveJournalReport {
  schemaVersion: typeof ADAPTIVE_JOURNAL_SCHEMA_VERSION;
  generatedAt: string;
  readOnly: true;
  request: AdaptiveJournalRequest;
  coverage: AdaptiveJournalCoverage;
  totals: AdaptiveJournalTotals;
  invocations: AdaptiveJournalInvocation[];
  rejected: AdaptiveJournalRejectedGroup[];
  outputTruncated: boolean;
  truncation: AdaptiveJournalTruncation | null;
  answers: {
    q1_open_and_terminal: AdaptiveJournalAnswer;
    q2_open_without_visible_terminal: AdaptiveJournalAnswer;
    q3_missing_start_or_identity_or_invalid: AdaptiveJournalAnswer;
    q4_duplicate_or_conflicted: AdaptiveJournalAnswer;
    q5: { confirmedFacts: string[]; unknowns: string[]; notes: string[] };
  };
  nextAction: string[];
}

export interface AdaptiveJournalError {
  code:
    | 'invalid_since'
    | 'invalid_until'
    | 'until_after_now'
    | 'since_after_until'
    | 'invalid_limit'
    | 'unsupported_host';
  message: string;
  nextAction: string;
}

export interface ReconcileAdaptiveJournalInput {
  workspaceDir: string;
  since?: string;
  until?: string;
  host?: string;
  limits?: {
    maxDateFilesPerDir?: number;
    maxFileBytes?: number;
    maxInvocations?: number;
    maxTerminalVariantsPerInvocation?: number;
  };
  now?: Date;
}

export type ReconcileAdaptiveJournalResult =
  | { ok: true; report: AdaptiveJournalReport }
  | {
      ok: false;
      schemaVersion: typeof ADAPTIVE_JOURNAL_SCHEMA_VERSION;
      generatedAt: string;
      readOnly: true;
      error: AdaptiveJournalError;
    };

interface ResolvedLimits {
  maxDateFilesPerDir: number;
  maxFileBytes: number;
  maxInvocations: number;
  maxTerminalVariantsPerInvocation: number;
}

interface ResolvedWindow {
  window: AdaptiveJournalRequestWindow;
  startMs: number;
  endMs: number;
  dates: string[];
}

interface SelectedFile {
  absolutePath: string;
  dateKey: string;
  dirPriority: number;
  logDir: string;
}

interface BoundedReadResult {
  lines: string[];
  bytesRead: number;
  truncated: boolean;
}

interface ParsedJournalRecord {
  /** Normalized full record data; null when the comparison budget was exceeded. */
  identityKey: string | null;
  ts: string;
  tsMs: number;
  state: 'open' | 'closed' | 'reconciled';
  data: Record<string, unknown>;
  projection: AdaptiveJournalRecordProjection;
  fromTruncatedFile: boolean;
}

interface JournalGroup {
  hookInvocationId: string;
  workspaceKey: string;
  workspaceDir: string | null;
  sessionId: string | null;
  sessionIdSource: JournalSessionIdSource;
  runId: string | null;
  invalidReason: JournalReasonCode | null;
  fromTruncatedFile: boolean;
  records: ParsedJournalRecord[];
}

interface GroupSeed {
  hookInvocationId: string;
  workspaceKey: string;
  workspaceDir: string | null;
  sessionId: string | null;
  sessionIdSource: JournalSessionIdSource;
  runId: string | null;
  invalidReason: JournalReasonCode | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function parseIso(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function utcDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function normalizeComparablePath(value: string): string {
  const resolved = path.resolve(value);
  return path.sep === '\\' ? resolved.toLowerCase() : resolved;
}

function normalizeWorkspace(value: string): string {
  let resolved = normalizeComparablePath(value);
  if (resolved.endsWith(path.sep)) resolved = resolved.slice(0, -path.sep.length);
  return resolved;
}

function isInside(parent: string, child: string): boolean {
  const parentComparable = normalizeComparablePath(parent);
  const childComparable = normalizeComparablePath(child);
  return childComparable === parentComparable || childComparable.startsWith(`${parentComparable}${path.sep}`);
}

function nodeErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object' || !Object.hasOwn(error, 'code')) return null;
  const value = Reflect.get(error, 'code');
  return typeof value === 'string' ? value : null;
}

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function emptyCoverage(): AdaptiveJournalCoverage {
  return {
    status: 'complete',
    sourceDirsFound: 0,
    filesRead: 0,
    filesSkipped: 0,
    bytesRead: 0,
    dateFilesIntersecting: 0,
    limitCode: null,
    filesOmitted: [],
    truncatedFiles: [],
    errors: [],
    identityComparisonLimited: false,
  };
}

function emptyTotals(): AdaptiveJournalTotals {
  return {
    linesRead: 0,
    adaptiveRecords: 0,
    nonAdaptiveLines: 0,
    malformedJsonLines: 0,
    invalidEnvelopeRecords: 0,
    invalidRecords: 0,
    duplicatesExact: 0,
    uniqueInvocations: 0,
    rejectedRecords: 0,
    countsAreLowerBounds: false,
  };
}

function unavailableTotals(): AdaptiveJournalTotals {
  return {
    linesRead: null,
    adaptiveRecords: null,
    nonAdaptiveLines: null,
    malformedJsonLines: null,
    invalidEnvelopeRecords: null,
    invalidRecords: null,
    duplicatesExact: null,
    uniqueInvocations: null,
    rejectedRecords: null,
    countsAreLowerBounds: false,
  };
}

function unavailableAnswer(reasonCodes?: string[]): AdaptiveJournalAnswer {
  const answer: AdaptiveJournalAnswer = { count: null, countBasis: null, invocationIds: [] };
  if (reasonCodes !== undefined) answer.reasonCodes = reasonCodes;
  return answer;
}

function validateLimits(
  input: ReconcileAdaptiveJournalInput,
  defaults: ResolvedLimits,
): { ok: true; limits: ResolvedLimits } | { ok: false; error: AdaptiveJournalError } {
  const resolved: ResolvedLimits = { ...defaults };
  const provided = input.limits ?? {};
  const keys: (keyof ResolvedLimits)[] = [
    'maxDateFilesPerDir',
    'maxFileBytes',
    'maxInvocations',
    'maxTerminalVariantsPerInvocation',
  ];
  for (const key of keys) {
    const value = provided[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value <= 0) {
      return {
        ok: false,
        error: {
          code: 'invalid_limit',
          message: `limit ${key} must be a positive integer`,
          nextAction: `为 ${key} 传入正整数（默认 ${defaults[key]}）。`,
        },
      };
    }
    resolved[key] = value;
  }
  return { ok: true, limits: resolved };
}

function resolveWindow(
  input: ReconcileAdaptiveJournalInput,
  now: Date,
): { ok: true; resolved: ResolvedWindow } | { ok: false; error: AdaptiveJournalError } {
  const nowMs = now.getTime();
  let endMs = nowMs;
  let endIsNow = true;
  if (input.until !== undefined) {
    const parsed = parseIso(input.until);
    if (parsed === null) {
      return {
        ok: false,
        error: {
          code: 'invalid_until',
          message: `--until is not a valid ISO timestamp: ${input.until}`,
          nextAction: '使用 ISO 时间（例如 2026-11-05T10:00:00Z）。',
        },
      };
    }
    if (parsed > nowMs) {
      return {
        ok: false,
        error: {
          code: 'until_after_now',
          message: `--until (${input.until}) is after now (${now.toISOString()})`,
          nextAction: '把 --until 调整到当前时间或更早。',
        },
      };
    }
    endMs = parsed;
    endIsNow = false;
  }

  const defaultSinceMs = endMs - INTERVENTION_SHORT_SOURCE_RETENTION_DAYS * DAY_MS;
  const requestedStart = input.since ?? new Date(defaultSinceMs).toISOString();
  const parsedSince = parseIso(requestedStart);
  if (parsedSince === null) {
    return {
      ok: false,
      error: {
        code: 'invalid_since',
        message: `--since is not a valid ISO timestamp: ${requestedStart}`,
        nextAction: '使用 ISO 时间（例如 2026-10-29T10:00:00Z）。',
      },
    };
  }
  if (parsedSince > endMs) {
    return {
      ok: false,
      error: {
        code: 'since_after_until',
        message: `--since (${requestedStart}) is after --until (${new Date(endMs).toISOString()})`,
        nextAction: '保证 --since 早于或等于 --until。',
      },
    };
  }

  const retentionBoundaryMs = nowMs - INTERVENTION_SHORT_SOURCE_RETENTION_DAYS * DAY_MS;
  const clampedByRetention = parsedSince < retentionBoundaryMs;
  const startMs = clampedByRetention ? retentionBoundaryMs : parsedSince;

  const dates: string[] = [];
  const firstDayMs = Date.UTC(
    new Date(startMs).getUTCFullYear(),
    new Date(startMs).getUTCMonth(),
    new Date(startMs).getUTCDate(),
  );
  for (let cursor = firstDayMs; cursor <= endMs; cursor += DAY_MS) {
    dates.push(utcDateKey(cursor));
  }
  // EventLog flushes the in-memory buffer into a file named by the flush time,
  // while each record's ts/date is fixed at creation. A record created just
  // before midnight can therefore be appended to the next UTC day's file, so
  // the day after the window end is a candidate even though its own date does
  // not intersect the window. Envelope ts still decides inclusion later.
  dates.push(utcDateKey(firstDayMs + dates.length * DAY_MS));

  return {
    ok: true,
    resolved: {
      window: {
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        inclusiveBounds: '[start,end]',
        endIsNow,
        requestedStart,
        clampedByRetention,
        retentionDays: INTERVENTION_SHORT_SOURCE_RETENTION_DAYS,
      },
      startMs,
      endMs,
      dates,
    },
  };
}

function selectDateFiles(options: {
  workspaceDir: string;
  dates: string[];
  maxDateFilesPerDir: number;
  coverage: AdaptiveJournalCoverage;
}): SelectedFile[] {
  const { workspaceDir, dates, maxDateFilesPerDir, coverage } = options;
  const dateSet = new Set(dates);
  const selected: SelectedFile[] = [];
  const canonicalWorkspace = realpathOrNull(workspaceDir);

  ADAPTIVE_JOURNAL_CANDIDATE_DIRS.forEach((logDir, dirPriority) => {
    const absoluteDir = path.join(workspaceDir, logDir);
    let entries: string[];
    try {
      entries = fs.readdirSync(absoluteDir);
    } catch (error) {
      const errnoCode = nodeErrorCode(error);
      if (errnoCode === 'ENOENT' || errnoCode === 'ENOTDIR') return;
      coverage.errors.push({
        logDir,
        file: null,
        code: 'read_failed',
        message: `log directory is not readable${errnoCode === null ? '' : ` (${errnoCode})`}`,
      });
      return;
    }
    coverage.sourceDirsFound += 1;

    if (canonicalWorkspace === null) {
      coverage.errors.push({
        logDir,
        file: null,
        code: 'stat_failed',
        message: 'workspace directory is not readable, cannot verify log containment',
      });
      return;
    }
    const canonicalDir = realpathOrNull(absoluteDir);
    if (canonicalDir === null) {
      coverage.errors.push({ logDir, file: null, code: 'stat_failed', message: 'log directory is not readable' });
      return;
    }
    if (!isInside(canonicalWorkspace, canonicalDir)) {
      coverage.errors.push({
        logDir,
        file: null,
        code: 'outside_workspace',
        message: 'log directory resolves outside the workspace; not read',
      });
      return;
    }

    const matched: SelectedFile[] = [];
    for (const entry of entries) {
      const match = DATE_FILE_PATTERN.exec(entry);
      if (match === null) continue;
      const [, dateKey] = match;
      if (dateKey === undefined || !dateSet.has(dateKey)) continue;
      matched.push({ absolutePath: path.join(absoluteDir, entry), dateKey, dirPriority, logDir });
    }
    matched.sort((left, right) => left.dateKey.localeCompare(right.dateKey));
    coverage.dateFilesIntersecting += matched.length;

    if (matched.length > maxDateFilesPerDir) {
      const keep = matched.slice(matched.length - maxDateFilesPerDir);
      const omit = matched.slice(0, matched.length - maxDateFilesPerDir);
      coverage.limitCode = 'coverage_file_limit_reached';
      coverage.filesOmitted.push(...omit.map((file) => file.absolutePath));
      selected.push(...keep);
      return;
    }
    selected.push(...matched);
  });

  selected.sort((left, right) => {
    if (left.dateKey === right.dateKey) return left.dirPriority - right.dirPriority;
    return left.dateKey.localeCompare(right.dateKey);
  });
  return selected;
}

function readBoundedLines(filePath: string, maxBytes: number): BoundedReadResult {
  const handle = fs.openSync(filePath, 'r');
  try {
    const stats = fs.fstatSync(handle);
    if (!stats.isFile()) throw new Error('not a regular file');
    const { size } = stats;
    const truncated = size > maxBytes;
    const bytesToRead = truncated ? maxBytes : size;
    const buffer = Buffer.allocUnsafe(bytesToRead);
    if (bytesToRead > 0) {
      fs.readSync(handle, buffer, 0, bytesToRead, truncated ? size - bytesToRead : 0);
    }
    let text = buffer.toString('utf8');
    if (truncated) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }
    const lines = text
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    return { lines, bytesRead: bytesToRead, truncated };
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Full canonical serialization of journal record data for duplicate identity.
 * Never truncated: journal data comes from `JSON.parse`, so only JSON values
 * occur, and object keys are sorted exactly like canonicalStringify while array
 * order is preserved.
 */
function canonicalJournalDataInner(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJournalDataInner).join(',')}]`;
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const parts: string[] = [];
    for (const key of keys) {
      const entry = source[key];
      if (entry === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJournalDataInner(entry)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return 'null';
}

/**
 * Returns the full canonical text, or null when it exceeds
 * IDENTITY_COMPARISON_MAX_CHARS — the caller must then treat the record as
 * DISTINCT and report the limitation instead of asserting equality.
 */
function canonicalJournalData(value: unknown): string | null {
  const text = canonicalJournalDataInner(value);
  return text.length > IDENTITY_COMPARISON_MAX_CHARS ? null : text;
}

function identityKey(record: ParsedJournalRecord): string | null {
  // Exact duplication is decided on the whole normalized record data, not on
  // the display projection: two terminals that differ only in evidence reference
  // or target digest are different observations and must stay conflicted.
  const canonical = canonicalStringify(record.data);
  // canonicalStringify documents its output as a marked PREFIX once the data
  // exceeds its own limit, so truncated text can never certify equality. Fall
  // back to the full local canonicalization and report a conservative distinct.
  if (!canonical.truncated) return canonical.text;
  return canonicalJournalData(record.data);
}

function countDistinctIdentities(records: ParsedJournalRecord[]): number {
  const keys = new Set<string>();
  let limited = 0;
  for (const record of records) {
    if (record.identityKey === null) limited += 1;
    else keys.add(record.identityKey);
  }
  // Budget-limited records can never be proven equal to anything.
  return keys.size + limited;
}

function buildProjection(data: Record<string, unknown>, fallbackTs: string): AdaptiveJournalRecordProjection {
  const receiptState = data.receiptState === 'closed' || data.receiptState === 'reconciled' ? data.receiptState : 'open';
  const evidence = isRecord(data.evidence) ? data.evidence : null;
  return {
    ts: fallbackTs,
    receiptState,
    execution: String(data.execution ?? 'unknown'),
    payload: String(data.payload ?? 'unknown'),
    selection: String(data.selection ?? 'unavailable'),
    submission: String(data.submission ?? 'unknown'),
    selectionPending: optionalBoolean(data.selectionPending),
    reason: optionalString(data.reason),
    artifactId: optionalString(data.artifactId) ?? optionalString(data.principleArtifactId),
    activationId: optionalString(data.activationId) ?? optionalString(data.activationRunId),
    requestId: optionalString(data.requestId),
    evidenceReferencePresent: evidence !== null && optionalString(evidence.reference) !== null,
    evidenceIndependentlyVerifiedAsRecorded: evidence === null ? null : optionalBoolean(evidence.independentlyVerified),
    hostKillConfirmedAsRecorded: evidence === null ? null : optionalBoolean(evidence.hostKillConfirmed),
  };
}

function sortedByTs<T extends { tsMs: number }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.tsMs - right.tsMs);
}

function compareTargets(
  opens: ParsedJournalRecord[],
  terminals: ParsedJournalRecord[],
): { consistent: boolean | null; mismatched: boolean } {
  let compared = false;
  let mismatched = false;
  for (const open of opens) {
    for (const terminal of terminals) {
      for (const field of ['artifactId', 'activationId'] as const) {
        const left = open.projection[field];
        const right = terminal.projection[field];
        if (left !== null && right !== null) {
          compared = true;
          if (left !== right) mismatched = true;
        }
      }
    }
  }
  if (mismatched) return { consistent: false, mismatched: true };
  return { consistent: compared ? true : null, mismatched: false };
}

interface ClassificationOutput {
  invocation: AdaptiveJournalInvocation;
  duplicateOpen: number;
  duplicateTerminal: number;
}

function classifyGroup(options: {
  group: JournalGroup;
  window: AdaptiveJournalRequestWindow;
  coverageStatus: JournalCoverageStatus;
  maxTerminalVariants: number;
}): ClassificationOutput {
  const { group, window, coverageStatus, maxTerminalVariants } = options;
  const deduped: ParsedJournalRecord[] = [];
  const seen = new Set<string>();
  let duplicateOpen = 0;
  let duplicateTerminal = 0;
  for (const record of group.records) {
    if (record.identityKey !== null && seen.has(record.identityKey)) {
      if (record.state === 'open') duplicateOpen += 1;
      else duplicateTerminal += 1;
      continue;
    }
    if (record.identityKey !== null) seen.add(record.identityKey);
    deduped.push(record);
  }

  const opens = sortedByTs(deduped.filter((record) => record.state === 'open'));
  const terminals = sortedByTs(deduped.filter((record) => record.state !== 'open'));

  const reasonCodes: JournalReasonCode[] = [];
  const unknowns: string[] = [];
  let classification: JournalClassification = 'paired_open_and_terminal';
  let targetConsistent: boolean | null = null;

  if (group.fromTruncatedFile) {
    reasonCodes.push('record_before_coverage_start');
    unknowns.push('该调用至少一条记录来自被截断的文件尾部，更早的记录可能不可见');
  }
  if (group.workspaceDir === null) {
    reasonCodes.push('workspace_identity_unknown');
    unknowns.push('工作区身份缺失，未与已验证工作区的记录合并');
  }
  if (group.sessionId === null) {
    unknowns.push('session 身份缺失，调用归属未确认');
  }
  if (duplicateOpen + duplicateTerminal > 0) {
    reasonCodes.push('exact_duplicate_record');
  }

  if (group.invalidReason !== null) {
    classification = 'invalid';
    reasonCodes.push(group.invalidReason);
    unknowns.push('存在无法归属或未通过校验的记录，该调用不能作为配对证据');
  } else if (opens.length === 0 && terminals.length > 0) {
    if (countDistinctIdentities(terminals) > 1) {
      classification = 'conflicted';
      reasonCodes.push('conflicting_terminal_states');
    } else {
      classification = 'terminal_only';
    }
    reasonCodes.push('start_not_visible_in_range');
    unknowns.push('开始记录在当前范围内不可见');
  } else if (opens.length > 0 && terminals.length === 0) {
    if (countDistinctIdentities(opens) > 1) {
      classification = 'conflicted';
      reasonCodes.push('multiple_starts_conflict');
    } else {
      classification = 'open_only';
    }
    reasonCodes.push('terminal_not_visible_in_range');
    if (!window.endIsNow) reasonCodes.push('window_end_explicit_not_now');
    unknowns.push('终态记录在当前范围内不可见');
    if (!window.endIsNow) unknowns.push('窗口终点由 --until 显式指定，并非 now；终态是否在窗口之后仍未知');
  } else if (opens.length === 0 && terminals.length === 0) {
    classification = 'invalid';
    unknowns.push('该调用没有任何可归属的记录');
  } else {
    if (countDistinctIdentities(opens) > 1) {
      classification = 'conflicted';
      reasonCodes.push('multiple_starts_conflict');
    }
    if (countDistinctIdentities(terminals) > 1) {
      classification = 'conflicted';
      reasonCodes.push('conflicting_terminal_states');
    }
    const comparison = compareTargets(opens, terminals);
    targetConsistent = comparison.consistent;
    if (comparison.mismatched) {
      classification = 'conflicted';
      reasonCodes.push('target_identity_mismatch');
      unknowns.push('目标一致性校验失败：同一 hookInvocationId 的 artifactId/activationId 不一致');
    } else if (comparison.consistent === null) {
      unknowns.push('目标身份不可比对（artifactId/activationId 缺失）');
    }
  }

  let terminalVariantsOmitted = 0;
  let terminalVariants: AdaptiveJournalRecordProjection[] = [];
  if (terminals.length > 1) {
    let extraTerminalVariants = terminals.slice(1);
    const allowedExtras = Math.max(0, maxTerminalVariants - 1);
    if (extraTerminalVariants.length > allowedExtras) {
      terminalVariantsOmitted = extraTerminalVariants.length - allowedExtras;
      extraTerminalVariants = extraTerminalVariants.slice(0, allowedExtras);
      reasonCodes.push('terminal_variants_truncated');
      reasonCodes.push('output_truncated');
      unknowns.push(`终态变体超过每调用上限，已省略 ${terminalVariantsOmitted} 个；冲突结论仍保留`);
    }
    terminalVariants = extraTerminalVariants.map((record) => record.projection);
  }

  const firstRecordMs = deduped.reduce(
    (min, record) => (record.tsMs < min ? record.tsMs : min),
    deduped[0]?.tsMs ?? 0,
  );
  const lastRecordMs = deduped.reduce(
    (max, record) => (record.tsMs > max ? record.tsMs : max),
    deduped[0]?.tsMs ?? 0,
  );

  const invocation: AdaptiveJournalInvocation = {
    invocationId: group.hookInvocationId,
    identity: {
      host: ADAPTIVE_JOURNAL_SUPPORTED_HOST,
      workspaceDir: group.workspaceDir,
      workspaceVerified: group.workspaceDir !== null,
      sessionId: group.sessionId,
      sessionIdSource: group.sessionIdSource,
      runId: group.runId,
    },
    targetConsistent,
    classification,
    reasonCodes,
    open: opens[0]?.projection ?? null,
    terminal: terminals[0]?.projection ?? null,
    terminalVariants,
    terminalVariantsOmitted,
    duplicates: { open: duplicateOpen, terminal: duplicateTerminal },
    window: {
      openInWindow: opens.length > 0,
      terminalInWindow: terminals.length > 0,
      terminalSearchComplete: coverageStatus === 'complete' && !group.fromTruncatedFile,
    },
    unknowns,
  };

  if (deduped.length === 0) {
    invocation.unknowns.push('该调用只有无效记录，无法投影 open/terminal');
  } else if (firstRecordMs === 0 || lastRecordMs === 0) {
    invocation.unknowns.push('记录时间不可比较');
  }

  return { invocation, duplicateOpen, duplicateTerminal };
}

const CLASSIFICATION_ORDER: Record<JournalClassification, number> = {
  conflicted: 0,
  invalid: 1,
  terminal_only: 2,
  open_only: 3,
  paired_open_and_terminal: 4,
};

function emptyOmittedByClassification(): Record<JournalClassification, number> {
  return {
    paired_open_and_terminal: 0,
    open_only: 0,
    terminal_only: 0,
    conflicted: 0,
    invalid: 0,
  };
}

export function reconcileAdaptiveJournal(input: ReconcileAdaptiveJournalInput): ReconcileAdaptiveJournalResult {
  const now = input.now instanceof Date ? input.now : new Date();
  const generatedAt = new Date().toISOString();
  const host = input.host ?? ADAPTIVE_JOURNAL_SUPPORTED_HOST;

  const fail = (error: AdaptiveJournalError): ReconcileAdaptiveJournalResult => ({
    ok: false,
    schemaVersion: ADAPTIVE_JOURNAL_SCHEMA_VERSION,
    generatedAt,
    readOnly: true,
    error,
  });

  if (host !== ADAPTIVE_JOURNAL_SUPPORTED_HOST) {
    return fail({
      code: 'unsupported_host',
      message: `host "${host}" is not supported by this read-only reconciler`,
      nextAction: `本轮只支持 --host ${ADAPTIVE_JOURNAL_SUPPORTED_HOST}；其它宿主需单独设计。`,
    });
  }

  const limitsResult = validateLimits(input, {
    maxDateFilesPerDir: ADAPTIVE_JOURNAL_MAX_DATE_FILES_PER_DIR,
    maxFileBytes: ADAPTIVE_JOURNAL_MAX_FILE_BYTES,
    maxInvocations: ADAPTIVE_JOURNAL_MAX_INVOCATIONS,
    maxTerminalVariantsPerInvocation: ADAPTIVE_JOURNAL_MAX_TERMINAL_VARIANTS,
  });
  if (!limitsResult.ok) return fail(limitsResult.error);

  const windowResult = resolveWindow(input, now);
  if (!windowResult.ok) return fail(windowResult.error);

  const workspaceDir = path.resolve(input.workspaceDir);
  const workspaceKey = normalizeWorkspace(workspaceDir);
  const coverage = emptyCoverage();
  const files = selectDateFiles({
    workspaceDir,
    dates: windowResult.resolved.dates,
    maxDateFilesPerDir: limitsResult.limits.maxDateFilesPerDir,
    coverage,
  });

  const request: AdaptiveJournalRequest = {
    workspaceDir,
    host: ADAPTIVE_JOURNAL_SUPPORTED_HOST,
    window: windowResult.resolved.window,
    logDirs: [...ADAPTIVE_JOURNAL_CANDIDATE_DIRS],
    pairingKey: ['host', 'workspaceDir', 'sessionId', 'hookInvocationId'],
  };

  if (coverage.sourceDirsFound === 0) {
    coverage.status = 'unavailable';
    return {
      ok: true,
      report: {
        schemaVersion: ADAPTIVE_JOURNAL_SCHEMA_VERSION,
        generatedAt,
        readOnly: true,
        request,
        coverage,
        totals: unavailableTotals(),
        invocations: [],
        rejected: [],
        outputTruncated: false,
        truncation: null,
        answers: {
          q1_open_and_terminal: unavailableAnswer(),
          q2_open_without_visible_terminal: unavailableAnswer(['terminal_not_visible_in_range']),
          q3_missing_start_or_identity_or_invalid: unavailableAnswer([
            'invalid_envelope',
            'missing_hook_invocation_id',
            'invalid_four_dimension_state',
            'start_not_visible_in_range',
            'workspace_identity_unknown',
          ]),
          q4_duplicate_or_conflicted: unavailableAnswer([
            'exact_duplicate_record',
            'multiple_starts_conflict',
            'conflicting_terminal_states',
            'target_identity_mismatch',
          ]),
          q5: {
            confirmedFacts: [],
            unknowns: ['无可读日志目录 = 未知，不等于零调用。'],
            notes: ['只读视图：未修改任何日志。'],
          },
        },
        nextAction: [
          '未找到 .pd/logs 或 .state/logs：确认工作区路径，或先让宿主产生事件日志。',
        ],
      },
    };
  }

  const totals = emptyTotals();
  const rejected = new Map<JournalReasonCode, { count: number; samples: { logDir: string; file: string; line: number; hookInvocationId: string | null }[] }>();
  const reject = (reasonCode: JournalReasonCode, sample: { logDir: string; file: string; line: number; hookInvocationId: string | null }): void => {
    const entry = rejected.get(reasonCode) ?? { count: 0, samples: [] };
    entry.count += 1;
    if (entry.samples.length < MAX_REJECTED_SAMPLES) entry.samples.push(sample);
    rejected.set(reasonCode, entry);
    totals.rejectedRecords = (totals.rejectedRecords ?? 0) + 1;
  };

  const groups = new Map<string, JournalGroup>();
  const seenRawLines = new Set<string>();
  let duplicatesExact = 0;

  const getGroup = (seed: GroupSeed): JournalGroup => {
    const {
      hookInvocationId,
      workspaceKey: recordWorkspaceKey,
      workspaceDir: recordWorkspaceDir,
      sessionId,
      sessionIdSource,
      runId,
      invalidReason,
    } = seed;
    const key = [
      ADAPTIVE_JOURNAL_SUPPORTED_HOST,
      recordWorkspaceKey,
      sessionId ?? '__unknown_session__',
      hookInvocationId,
    ].join('|');
    const existing = groups.get(key);
    if (existing !== undefined) {
      if (invalidReason !== null) existing.invalidReason = invalidReason;
      return existing;
    }
    const created: JournalGroup = {
      hookInvocationId,
      workspaceKey: recordWorkspaceKey,
      workspaceDir: recordWorkspaceDir,
      sessionId,
      sessionIdSource,
      runId,
      invalidReason,
      fromTruncatedFile: false,
      records: [],
    };
    groups.set(key, created);
    return created;
  };

  for (const file of files) {
    let read: BoundedReadResult;
    try {
      read = readBoundedLines(file.absolutePath, limitsResult.limits.maxFileBytes);
    } catch (error) {
      coverage.filesSkipped += 1;
      coverage.errors.push({
        logDir: file.logDir,
        file: path.basename(file.absolutePath),
        code: 'read_failed',
        message: error instanceof Error ? error.message : 'unknown read failure',
      });
      continue;
    }
    coverage.filesRead += 1;
    coverage.bytesRead += read.bytesRead;
    if (read.truncated) coverage.truncatedFiles.push(file.absolutePath);
    totals.linesRead = (totals.linesRead ?? 0) + read.lines.length;

    for (let index = 0; index < read.lines.length; index += 1) {
      const line = read.lines[index];
      if (line === undefined) continue;
      if (seenRawLines.has(line)) {
        duplicatesExact += 1;
        continue;
      }
      seenRawLines.add(line);
      const lineOrdinal = index + 1;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        totals.malformedJsonLines = (totals.malformedJsonLines ?? 0) + 1;
        continue;
      }
      if (!isRecord(parsed)) {
        totals.invalidEnvelopeRecords = (totals.invalidEnvelopeRecords ?? 0) + 1;
        reject('invalid_envelope', { logDir: file.logDir, file: path.basename(file.absolutePath), line: lineOrdinal, hookInvocationId: null });
        continue;
      }
      if (parsed.type !== 'adaptive_delivery') {
        totals.nonAdaptiveLines = (totals.nonAdaptiveLines ?? 0) + 1;
        continue;
      }

      totals.adaptiveRecords = (totals.adaptiveRecords ?? 0) + 1;
      const ts = optionalString(parsed.ts);
      const tsMs = ts === null ? null : parseIso(ts);
      const data = isRecord(parsed.data) ? parsed.data : null;
      if (ts === null || tsMs === null || data === null) {
        totals.invalidEnvelopeRecords = (totals.invalidEnvelopeRecords ?? 0) + 1;
        reject('invalid_envelope', { logDir: file.logDir, file: path.basename(file.absolutePath), line: lineOrdinal, hookInvocationId: null });
        continue;
      }
      if (tsMs < windowResult.resolved.startMs || tsMs > windowResult.resolved.endMs) continue;

      const recordHost = optionalString(data.host);
      if (recordHost !== ADAPTIVE_JOURNAL_SUPPORTED_HOST) {
        reject('host_identity_unknown', { logDir: file.logDir, file: path.basename(file.absolutePath), line: lineOrdinal, hookInvocationId: optionalString(data.hookInvocationId) });
        continue;
      }

      const recordedWorkspace = optionalString(data.workspaceDir);
      if (recordedWorkspace !== null && normalizeWorkspace(recordedWorkspace) !== workspaceKey) {
        reject('foreign_workspace', { logDir: file.logDir, file: path.basename(file.absolutePath), line: lineOrdinal, hookInvocationId: optionalString(data.hookInvocationId) });
        continue;
      }
      const recordWorkspaceDir = recordedWorkspace === null ? null : workspaceDir;
      const recordWorkspaceKey = recordedWorkspace === null ? '__unknown_workspace__' : workspaceKey;

      const envelopeSession = optionalString(parsed.sessionId);
      const dataSession = optionalString(data.sessionId);
      let sessionId: string | null = envelopeSession ?? dataSession;
      let sessionIdSource: JournalSessionIdSource = 'none';
      if (envelopeSession !== null && dataSession !== null) sessionIdSource = 'both';
      else if (envelopeSession !== null) sessionIdSource = 'envelope';
      else if (dataSession !== null) sessionIdSource = 'data';
      let invalidReason: JournalReasonCode | null = null;
      if (envelopeSession !== null && dataSession !== null && envelopeSession !== dataSession) {
        sessionId = envelopeSession;
        invalidReason = 'session_identity_mismatch';
      }

      const hookInvocationId = optionalString(data.hookInvocationId);
      if (hookInvocationId === null) {
        totals.invalidRecords = (totals.invalidRecords ?? 0) + 1;
        reject('missing_hook_invocation_id', { logDir: file.logDir, file: path.basename(file.absolutePath), line: lineOrdinal, hookInvocationId: null });
        continue;
      }

      const validation = validateAdaptiveDeliveryRecord(data);
      const runId = optionalString(data.runId);
      if (!validation.ok) {
        totals.invalidRecords = (totals.invalidRecords ?? 0) + 1;
        getGroup({
          hookInvocationId,
          workspaceKey: recordWorkspaceKey,
          workspaceDir: recordWorkspaceDir,
          sessionId,
          sessionIdSource,
          runId,
          invalidReason: 'invalid_four_dimension_state',
        });
        continue;
      }

      const projection = buildProjection(data, ts);
      const record: ParsedJournalRecord = {
        identityKey: '',
        ts,
        tsMs,
        state: projection.receiptState,
        data,
        projection,
        fromTruncatedFile: read.truncated,
      };
      record.identityKey = identityKey(record);
      if (record.identityKey === null) coverage.identityComparisonLimited = true;

      const group = getGroup({
        hookInvocationId,
        workspaceKey: recordWorkspaceKey,
        workspaceDir: recordWorkspaceDir,
        sessionId,
        sessionIdSource,
        runId,
        invalidReason,
      });
      group.records.push(record);
      if (read.truncated) group.fromTruncatedFile = true;
      if (projection.receiptState !== 'open') group.runId = group.runId ?? runId;
    }
  }

  coverage.status = coverage.limitCode !== null || coverage.errors.length > 0 || coverage.truncatedFiles.length > 0
    ? 'partial'
    : 'complete';

  const invocations: AdaptiveJournalInvocation[] = [];
  for (const group of groups.values()) {
    invocations.push(classifyGroup({
      group,
      window: windowResult.resolved.window,
      coverageStatus: coverage.status,
      maxTerminalVariants: limitsResult.limits.maxTerminalVariantsPerInvocation,
    }).invocation);
  }
  invocations.sort((left, right) => {
    const byClass = CLASSIFICATION_ORDER[left.classification] - CLASSIFICATION_ORDER[right.classification];
    if (byClass !== 0) return byClass;
    const leftStart = left.open?.ts ?? left.terminal?.ts ?? '';
    const rightStart = right.open?.ts ?? right.terminal?.ts ?? '';
    return leftStart.localeCompare(rightStart);
  });
  totals.duplicatesExact = duplicatesExact + invocations.reduce((sum, item) => sum + item.duplicates.open + item.duplicates.terminal, 0);

  const outputLimit = limitsResult.limits.maxInvocations;
  const omittedByClassification = emptyOmittedByClassification();
  let kept = invocations;
  let truncatedInvocations = 0;
  if (invocations.length > outputLimit) {
    const omitted = invocations.slice(outputLimit);
    for (const invocation of omitted) omittedByClassification[invocation.classification] += 1;
    kept = invocations.slice(0, outputLimit);
    truncatedInvocations = omitted.length;
  }
  const terminalVariantsOmitted = invocations.reduce((sum, item) => sum + item.terminalVariantsOmitted, 0);
  const variantsTruncated = terminalVariantsOmitted > 0;
  const outputTruncated = truncatedInvocations > 0 || variantsTruncated;
  const countsAreLowerBounds = truncatedInvocations > 0
    || variantsTruncated
    || coverage.limitCode !== null
    || coverage.truncatedFiles.length > 0
    || coverage.errors.length > 0;

  totals.uniqueInvocations = invocations.length;
  totals.countsAreLowerBounds = countsAreLowerBounds;
  const countBasis: JournalCountBasis = coverage.status === 'complete' && !countsAreLowerBounds ? 'exact' : 'lower_bound';

  const q1Items = kept.filter((item) => item.classification === 'paired_open_and_terminal');
  const q2Items = kept.filter((item) => item.classification === 'open_only');
  const q3Invocations = kept.filter((item) =>
    item.classification === 'terminal_only'
    || item.classification === 'invalid'
    || item.reasonCodes.includes('workspace_identity_unknown'));
  const q4Items = kept.filter((item) =>
    item.classification === 'conflicted'
    || item.duplicates.open > 0
    || item.duplicates.terminal > 0);

  const rejectedCount = totals.rejectedRecords ?? 0;
  const q3ReasonCodes = new Set<string>(q3Invocations.flatMap((item) => item.reasonCodes));
  for (const reasonCode of rejected.keys()) q3ReasonCodes.add(reasonCode);
  const q4ReasonCodes = new Set<string>(q4Items.flatMap((item) => item.reasonCodes));

  const nextAction: string[] = [];
  const suggestions: string[] = [];
  if (truncatedInvocations > 0) {
    suggestions.push('缩小窗口：--since/--until');
    suggestions.push('按 host 或 session 分片');
    nextAction.push(`输出截断：${truncatedInvocations} 个调用未输出；缩小窗口或按 host/session 分片后重试。`);
  }
  if (terminalVariantsOmitted > 0) {
    suggestions.push('提高每调用终态变体上限后重试');
    nextAction.push(`终态变体截断：${terminalVariantsOmitted} 个终态未输出；冲突结论仍保留，必要时提高上限。`);
  }
  if (coverage.limitCode !== null) {
    suggestions.push('缩小窗口或提高日期文件上限后重试');
    nextAction.push(`覆盖不完整：${coverage.filesOmitted.length} 个相交日期文件未读取（coverage_file_limit_reached）。`);
  }
  if (coverage.errors.length > 0) {
    nextAction.push('覆盖不完整：存在无法读取或越界的日志；检查文件权限与工作区路径。');
  }
  if (coverage.truncatedFiles.length > 0) {
    suggestions.push('缩小窗口后重试（单文件超过 4 MiB 只读取了尾部）');
    nextAction.push(`覆盖不完整：${coverage.truncatedFiles.length} 个文件只读取了尾部，统计为下界。`);
  }
  if (coverage.identityComparisonLimited) {
    suggestions.push('缩小单条记录内容或降低 maxFileBytes 后重试');
    nextAction.push('重复判定受限：部分记录的规范化内容超出比较预算，已保守地按不同记录处理，不能据此确认完全重复。');
  }

  const confirmedFacts: string[] = [];
  if (coverage.filesRead === 0) {
    confirmedFacts.push('窗口内没有读到任何日志文件。');
  } else {
    confirmedFacts.push(`读取 ${coverage.filesRead} 个日期文件，共扫描 ${totals.linesRead ?? 0} 行；识别 ${totals.adaptiveRecords ?? 0} 条 adaptive_delivery 记录。`);
  }
  confirmedFacts.push(`配对 ${q1Items.length} 个调用；配对成立不等于执行成功（closed/reconciled 只是记录声明的阶段）。`);
  if ((totals.duplicatesExact ?? 0) > 0) confirmedFacts.push(`去重 ${totals.duplicatesExact} 条完全重复记录（保留首条）。`);
  if (q4Items.length > 0) confirmedFacts.push(`发现 ${q4Items.length} 个冲突或重复相关的调用。`);

  const unknowns: string[] = [
    '无日志 = 未知，不等于零调用。',
    '未找到终态只表示当前范围内不可见，不表示终态发生在窗口之后。',
  ];
  if (!windowResult.resolved.window.endIsNow) {
    unknowns.push('窗口终点由 --until 显式指定，并非 now；窗口外的记录不参与本报告。');
  }
  if (coverage.limitCode !== null) unknowns.push('日期文件读取达到上限，部分相交日期文件未纳入。');
  if (coverage.truncatedFiles.length > 0) unknowns.push('存在被截断的文件，更早的记录可能不可见。');
  if (coverage.errors.length > 0) unknowns.push('存在无法读取或越界的日志目录，覆盖不完整。');
  if (coverage.identityComparisonLimited) unknowns.push('存在超出比较预算的记录：完全相同性未被证明，已保守地按不同记录处理。');
  if (q2Items.length > 0) unknowns.push(`${q2Items.length} 个调用在当前范围内未找到终态。`);
  unknowns.push('本工具不重新认证记录中的独立验证标志，只按记录原样转录。');

  const notes: string[] = [
    '只读视图：未修改任何日志；只读取两个候选目录中与窗口相交的日期文件。',
    `生效窗口：${windowResult.resolved.window.start} ~ ${windowResult.resolved.window.end}（窗口终点${windowResult.resolved.window.endIsNow ? '为 now' : '由 --until 指定'}）。`,
  ];
  if (windowResult.resolved.window.clampedByRetention) notes.push('请求的 --since 早于日志保留边界，已截断到保留边界。');
  if (outputTruncated) notes.push('输出被截断，结论仅为已输出子集；计数为下界。');
  if (coverage.status === 'partial') notes.push('覆盖不完整：结论与计数仅为当前读取范围的下界。');
  if (coverage.identityComparisonLimited) notes.push('重复判定受限：部分记录规范化内容超出比较预算，完全相同性未被证明，已保守地按不同记录处理（coverage.identityComparisonLimited=true）。');

  const report: AdaptiveJournalReport = {
    schemaVersion: ADAPTIVE_JOURNAL_SCHEMA_VERSION,
    generatedAt,
    readOnly: true,
    request,
    coverage,
    totals,
    invocations: kept,
    rejected: [...rejected.entries()]
      .map(([reasonCode, entry]) => ({ reasonCode, count: entry.count, samples: entry.samples }))
      .sort((left, right) => right.count - left.count || left.reasonCode.localeCompare(right.reasonCode)),
    outputTruncated,
    truncation: outputTruncated
      ? {
          reason: 'output_truncated',
          limit: outputLimit,
          included: kept.length,
          omitted: truncatedInvocations,
          omittedByClassification,
          variantLimitPerInvocation: limitsResult.limits.maxTerminalVariantsPerInvocation,
          terminalVariantsOmitted,
          coverageLimitCode: coverage.limitCode,
          suggestions,
        }
      : null,
    answers: {
      q1_open_and_terminal: {
        count: q1Items.length,
        countBasis,
        invocationIds: q1Items.map((item) => item.invocationId),
      },
      q2_open_without_visible_terminal: {
        count: q2Items.length,
        countBasis,
        invocationIds: q2Items.map((item) => item.invocationId),
        reasonCodes: [...new Set(q2Items.flatMap((item) => item.reasonCodes))].sort(),
      },
      q3_missing_start_or_identity_or_invalid: {
        count: q3Invocations.length + rejectedCount,
        countBasis,
        invocationIds: q3Invocations.map((item) => item.invocationId),
        reasonCodes: [...q3ReasonCodes].sort(),
      },
      q4_duplicate_or_conflicted: {
        count: q4Items.length + (totals.duplicatesExact ?? 0),
        countBasis,
        invocationIds: q4Items.map((item) => item.invocationId),
        reasonCodes: [...q4ReasonCodes].sort(),
      },
      q5: { confirmedFacts, unknowns, notes },
    },
    nextAction,
  };

  return { ok: true, report };
}
