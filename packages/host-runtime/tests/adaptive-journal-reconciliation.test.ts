import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADAPTIVE_JOURNAL_SCHEMA_VERSION,
  type AdaptiveJournalReport,
  reconcileAdaptiveJournal,
} from '../src/adaptive-journal-reconciliation.js';

const NOW = new Date('2026-11-05T10:00:00.000Z');
const TS = '2026-11-05T09:00:00.000Z';

const tempDirs: string[] = [];

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-journal-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeEvents(workspaceDir: string, dateKey: string, lines: string[], logDir = '.pd/logs'): string {
  const dir = path.join(workspaceDir, logDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `events_${dateKey}.jsonl`);
  fs.appendFileSync(file, lines.map((line) => `${line}\n`).join(''), 'utf8');
  return file;
}

interface RecordSpec {
  ts?: string;
  hookInvocationId?: string | null;
  sessionId?: string | null;
  envelopeSessionId?: string | null;
  dataSessionId?: string | null;
  workspaceDir?: string | null;
  host?: string | null;
  state?: 'open' | 'closed' | 'reconciled';
  artifactId?: string | null;
  activationId?: string | null;
  runId?: string | null;
  execution?: string;
  payload?: string;
  selection?: string;
  submission?: string;
  selectionPending?: boolean;
  evidence?: Record<string, unknown> | null;
  reason?: string | null;
  forceInvalidOpen?: boolean;
}

function adaptiveLine(spec: RecordSpec, workspaceDir: string): string {
  const ts = spec.ts ?? TS;
  const state = spec.state ?? 'closed';
  const envelopeSessionId = spec.envelopeSessionId === undefined ? (spec.sessionId ?? 'sess-1') : spec.envelopeSessionId;
  const dataSessionId = spec.dataSessionId === undefined ? (spec.sessionId ?? 'sess-1') : spec.dataSessionId;
  const data: Record<string, unknown> = {
    host: spec.host === undefined ? 'openclaw' : spec.host,
    runtimeMode: 'shadow',
    workspaceDir: spec.workspaceDir === undefined ? workspaceDir : spec.workspaceDir,
    sessionId: dataSessionId,
    runId: spec.runId === undefined ? 'run-1' : spec.runId,
    artifactId: spec.artifactId === undefined ? 'art-1' : spec.artifactId,
    activationId: spec.activationId === undefined ? 'act-1' : spec.activationId,
    hostVersion: 'unknown',
    pluginVersion: 'unknown',
    effectiveHookSetFingerprint: 'unknown',
    evidenceCoverage: 'partial',
    hookInvocationId: spec.hookInvocationId === undefined ? 'inv-1' : spec.hookInvocationId,
    receiptState: state,
    execution: spec.execution ?? (state === 'open' ? (spec.forceInvalidOpen ? 'completed' : 'unknown') : 'completed'),
    payload: spec.payload ?? (state === 'open' ? 'unknown' : 'prepared'),
    selection: spec.selection ?? (state === 'open' ? 'unavailable' : 'selected'),
    submission: spec.submission ?? 'unknown',
  };
  if (state === 'open') {
    data.selectionPending = spec.selectionPending === undefined ? true : spec.selectionPending;
  } else if (spec.reason !== undefined) {
    data.reason = spec.reason;
    data.addedTarget = false;
  }
  if (spec.evidence !== undefined && spec.evidence !== null) data.evidence = spec.evidence;

  const envelope: Record<string, unknown> = {
    ts,
    date: ts.slice(0, 10),
    type: 'adaptive_delivery',
    category: 'written',
    data,
  };
  if (envelopeSessionId !== null) envelope.sessionId = envelopeSessionId;
  return JSON.stringify(envelope);
}

function run(
  workspaceDir: string,
  overrides: Partial<Parameters<typeof reconcileAdaptiveJournal>[0]> = {},
): AdaptiveJournalReport {
  const result = reconcileAdaptiveJournal({ workspaceDir, now: NOW, ...overrides });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected a report');
  expect(result.report.schemaVersion).toBe(ADAPTIVE_JOURNAL_SCHEMA_VERSION);
  return result.report;
}

function findInvocation(report: AdaptiveJournalReport, id: string) {
  const invocation = report.invocations.find((item) => item.invocationId === id);
  expect(invocation).toBeDefined();
  return invocation!;
}

function hashTree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string): void => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        result[`dir:${path.relative(root, absolute)}`] = 'dir';
        walk(absolute);
      } else {
        result[`file:${path.relative(root, absolute)}`] = crypto
          .createHash('sha256')
          .update(fs.readFileSync(absolute))
          .digest('hex');
      }
    }
  };
  walk(root);
  return result;
}

describe('reconcileAdaptiveJournal — pairing and classification', () => {
  it('pairs a normal open→closed invocation without claiming success', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      adaptiveLine({ state: 'open', hookInvocationId: 'inv-1' }, dir),
      adaptiveLine({ state: 'closed', hookInvocationId: 'inv-1', reason: 'native_entry_preserved' }, dir),
    ]);
    const report = run(dir);
    const invocation = findInvocation(report, 'inv-1');
    expect(invocation.classification).toBe('paired_open_and_terminal');
    expect(invocation.targetConsistent).toBe(true);
    expect(invocation.open?.receiptState).toBe('open');
    expect(invocation.terminal?.receiptState).toBe('closed');
    expect(invocation.terminal?.payload).toBe('prepared');
    expect(invocation.terminal?.submission).toBe('unknown');
    expect(report.answers.q1_open_and_terminal.count).toBe(1);
    expect(report.answers.q1_open_and_terminal.countBasis).toBe('exact');
    expect(report.totals.countsAreLowerBounds).toBe(false);
  });

  it('reports open-only as "not visible in range" and never asserts interruption', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [adaptiveLine({ state: 'open', hookInvocationId: 'inv-open' }, dir)]);
    const report = run(dir);
    const invocation = findInvocation(report, 'inv-open');
    expect(invocation.classification).toBe('open_only');
    expect(invocation.reasonCodes).toContain('terminal_not_visible_in_range');
    expect(invocation.reasonCodes).not.toContain('window_end_explicit_not_now');
    expect(report.answers.q2_open_without_visible_terminal.count).toBe(1);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('终态发生在窗口后');
    expect(serialized).not.toContain('中断');
  });

  it('adds window_end_explicit_not_now when the window end is explicit', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      adaptiveLine({ state: 'open', hookInvocationId: 'inv-open', ts: '2026-11-05T08:00:00.000Z' }, dir),
      adaptiveLine({ state: 'closed', hookInvocationId: 'inv-open', ts: '2026-11-05T11:00:00.000Z' }, dir),
    ]);
    const report = run(dir, { until: '2026-11-05T09:00:00.000Z' });
    const invocation = findInvocation(report, 'inv-open');
    expect(invocation.classification).toBe('open_only');
    expect(invocation.reasonCodes).toEqual(
      expect.arrayContaining(['terminal_not_visible_in_range', 'window_end_explicit_not_now']),
    );
    expect(report.request.window.endIsNow).toBe(false);
    expect(JSON.stringify(report)).not.toContain('终态发生在窗口后');
  });

  it('reports terminal-only as start not visible in range', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [adaptiveLine({ state: 'closed', hookInvocationId: 'inv-terminal' }, dir)]);
    const report = run(dir);
    const invocation = findInvocation(report, 'inv-terminal');
    expect(invocation.classification).toBe('terminal_only');
    expect(invocation.reasonCodes).toContain('start_not_visible_in_range');
    expect(report.answers.q3_missing_start_or_identity_or_invalid.invocationIds).toContain('inv-terminal');
  });

  it('keeps all distinct terminal variants and marks the invocation conflicted', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      adaptiveLine({ state: 'open', hookInvocationId: 'inv-1', ts: '2026-11-05T08:00:00.000Z' }, dir),
      adaptiveLine({ state: 'closed', hookInvocationId: 'inv-1', ts: '2026-11-05T08:30:00.000Z', reason: 'native_entry_preserved' }, dir),
      adaptiveLine({ state: 'closed', hookInvocationId: 'inv-1', ts: '2026-11-05T09:00:00.000Z', execution: 'degraded', payload: 'none', selection: 'skipped', reason: 'deadline' }, dir),
    ]);
    const report = run(dir);
    const invocation = findInvocation(report, 'inv-1');
    expect(invocation.classification).toBe('conflicted');
    expect(invocation.reasonCodes).toContain('conflicting_terminal_states');
    expect(invocation.terminal?.reason).toBe('native_entry_preserved');
    expect(invocation.terminalVariants).toHaveLength(1);
    expect(invocation.terminalVariants[0].reason).toBe('deadline');
    expect(report.answers.q4_duplicate_or_conflicted.invocationIds).toContain('inv-1');
  });

  it('marks multiple distinct starts as conflicted', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      adaptiveLine({ state: 'open', hookInvocationId: 'inv-1', ts: '2026-11-05T08:00:00.000Z', artifactId: 'art-a' }, dir),
      adaptiveLine({ state: 'open', hookInvocationId: 'inv-1', ts: '2026-11-05T08:10:00.000Z', artifactId: 'art-b' }, dir),
      adaptiveLine({ state: 'closed', hookInvocationId: 'inv-1', ts: '2026-11-05T09:00:00.000Z', artifactId: 'art-a' }, dir),
    ]);
    const report = run(dir);
    const invocation = findInvocation(report, 'inv-1');
    expect(invocation.classification).toBe('conflicted');
    expect(invocation.reasonCodes).toContain('multiple_starts_conflict');
  });

  it('flags target identity mismatch instead of pairing (acceptance 16)', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      adaptiveLine({ state: 'open', hookInvocationId: 'inv-1', ts: '2026-11-05T08:00:00.000Z', artifactId: 'art-a', activationId: 'act-a' }, dir),
      adaptiveLine({ state: 'closed', hookInvocationId: 'inv-1', ts: '2026-11-05T09:00:00.000Z', artifactId: 'art-b', activationId: 'act-b' }, dir),
    ]);
    const report = run(dir);
    const invocation = findInvocation(report, 'inv-1');
    expect(invocation.classification).toBe('conflicted');
    expect(invocation.reasonCodes).toContain('target_identity_mismatch');
    expect(invocation.targetConsistent).toBe(false);
    expect(report.answers.q1_open_and_terminal.count).toBe(0);
    expect(report.answers.q4_duplicate_or_conflicted.invocationIds).toContain('inv-1');
  });

  it('records target identity as unknown when it cannot be compared', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      adaptiveLine({ state: 'open', hookInvocationId: 'inv-1', artifactId: null, activationId: null }, dir),
      adaptiveLine({ state: 'closed', hookInvocationId: 'inv-1', artifactId: 'art-b', activationId: 'act-b' }, dir),
    ]);
    const report = run(dir);
    const invocation = findInvocation(report, 'inv-1');
    expect(invocation.classification).toBe('paired_open_and_terminal');
    expect(invocation.targetConsistent).toBeNull();
    expect(invocation.unknowns.join('|')).toContain('目标身份不可比对');
  });
});

describe('reconcileAdaptiveJournal — duplicates and invalid records', () => {
  it('deduplicates exact duplicate lines globally and identical projections per invocation', () => {
    const dir = workspace();
    const openLine = adaptiveLine({ state: 'open', hookInvocationId: 'inv-1', ts: '2026-11-05T08:00:00.000Z' }, dir);
    const openAgainDifferentTs = adaptiveLine({ state: 'open', hookInvocationId: 'inv-1', ts: '2026-11-05T08:05:00.000Z' }, dir);
    const closedLine = adaptiveLine({ state: 'closed', hookInvocationId: 'inv-1', ts: '2026-11-05T09:00:00.000Z' }, dir);
    writeEvents(dir, '2026-11-05', [openLine, openLine, openAgainDifferentTs, closedLine]);
    const report = run(dir);
    const invocation = findInvocation(report, 'inv-1');
    expect(report.totals.duplicatesExact).toBeGreaterThanOrEqual(1);
    expect(invocation.duplicates.open).toBe(1);
    expect(invocation.reasonCodes).toContain('exact_duplicate_record');
    expect(invocation.classification).toBe('paired_open_and_terminal');
  });

  it('ignores malformed JSON lines without inflating invalid statistics', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      '{"ts":"2026-11-05T08:00:00.000Z", broken',
      adaptiveLine({ state: 'open', hookInvocationId: 'inv-1' }, dir),
      adaptiveLine({ state: 'closed', hookInvocationId: 'inv-1' }, dir),
    ]);
    const report = run(dir);
    expect(report.totals.malformedJsonLines).toBe(1);
    expect(report.totals.invalidEnvelopeRecords).toBe(0);
    expect(report.totals.invalidRecords).toBe(0);
    expect(report.rejected).toEqual([]);
    expect(report.answers.q3_missing_start_or_identity_or_invalid.count).toBe(0);
    expect(report.answers.q1_open_and_terminal.count).toBe(1);
  });

  it('classifies a record failing four-dimension validation as invalid', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      adaptiveLine({ state: 'open', hookInvocationId: 'inv-invalid', forceInvalidOpen: true }, dir),
    ]);
    const report = run(dir);
    const invocation = findInvocation(report, 'inv-invalid');
    expect(invocation.classification).toBe('invalid');
    expect(invocation.reasonCodes).toContain('invalid_four_dimension_state');
    expect(report.totals.invalidRecords).toBe(1);
    expect(report.answers.q3_missing_start_or_identity_or_invalid.count).toBe(1);
  });

  it('separates records with missing identity instead of merging them', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      // missing hookInvocationId → rejected, cannot be attributed
      adaptiveLine({ state: 'closed', hookInvocationId: null }, dir),
      // missing host → rejected as unknown host
      adaptiveLine({ state: 'closed', hookInvocationId: 'inv-no-host', host: null }, dir),
      // missing workspace → own group, identity unknown
      adaptiveLine({ state: 'closed', hookInvocationId: 'inv-no-workspace', workspaceDir: null }, dir),
      // envelope/data session disagreement → invalid invocation
      adaptiveLine({ state: 'closed', hookInvocationId: 'inv-session-mismatch', envelopeSessionId: 'sess-a', dataSessionId: 'sess-b' }, dir),
      // no session at all on either side → still attributable, but session identity unknown
      adaptiveLine({ state: 'open', hookInvocationId: 'inv-no-session', envelopeSessionId: null, dataSessionId: null }, dir),
      adaptiveLine({ state: 'closed', hookInvocationId: 'inv-no-session', envelopeSessionId: null, dataSessionId: null }, dir),
    ]);
    const report = run(dir);
    const rejectedReasons = report.rejected.map((entry) => entry.reasonCode);
    expect(rejectedReasons).toContain('missing_hook_invocation_id');
    expect(rejectedReasons).toContain('host_identity_unknown');
    expect(findInvocation(report, 'inv-no-workspace').reasonCodes).toContain('workspace_identity_unknown');
    expect(findInvocation(report, 'inv-session-mismatch').classification).toBe('invalid');
    expect(findInvocation(report, 'inv-session-mismatch').reasonCodes).toContain('session_identity_mismatch');
    const noSession = findInvocation(report, 'inv-no-session');
    expect(noSession.identity.sessionId).toBeNull();
    expect(noSession.identity.sessionIdSource).toBe('none');
    expect(noSession.unknowns.join('|')).toContain('session 身份缺失');
    expect(noSession.classification).toBe('paired_open_and_terminal');
  });
});

describe('reconcileAdaptiveJournal — workspace, host and non-adaptive isolation', () => {
  it('does not pair across different workspaces that share a hookInvocationId', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      adaptiveLine({ state: 'open', hookInvocationId: 'inv-1' }, dir),
      adaptiveLine({ state: 'closed', hookInvocationId: 'inv-1' }, dir),
      adaptiveLine({ state: 'closed', hookInvocationId: 'inv-1', workspaceDir: 'D:\\other-workspace' }, dir),
      adaptiveLine({ state: 'closed', hookInvocationId: 'inv-1', workspaceDir: null }, dir),
    ]);
    const report = run(dir);
    const paired = report.invocations.find(
      (item) => item.invocationId === 'inv-1' && item.classification === 'paired_open_and_terminal',
    );
    expect(paired).toBeDefined();
    expect(report.rejected.some((entry) => entry.reasonCode === 'foreign_workspace')).toBe(true);
    // The workspace-less record forms its own group, never merged with the verified one.
    expect(report.invocations.filter((item) => item.invocationId === 'inv-1')).toHaveLength(2);
    const unknownWorkspace = report.invocations.find((item) => item.identity.workspaceDir === null);
    expect(unknownWorkspace?.reasonCodes).toContain('workspace_identity_unknown');
    expect(unknownWorkspace?.identity.workspaceVerified).toBe(false);
  });

  it('ignores non-adaptive events in the same file (acceptance 14)', () => {
    const dir = workspace();
    const nonAdaptive = [
      JSON.stringify({ ts: TS, date: '2026-11-05', type: 'hook_execution', category: 'success', data: { hook: 'prompt' } }),
      JSON.stringify({ ts: TS, date: '2026-11-05', type: 'tool_call', category: 'success', data: { tool: 'read' } }),
      JSON.stringify({ ts: TS, date: '2026-11-05', category: 'success', data: { note: 'no type' } }),
    ];
    writeEvents(dir, '2026-11-05', [
      ...nonAdaptive,
      adaptiveLine({ state: 'open', hookInvocationId: 'inv-1' }, dir),
      adaptiveLine({ state: 'closed', hookInvocationId: 'inv-1' }, dir),
    ]);
    const report = run(dir);
    expect(report.totals.nonAdaptiveLines).toBe(3);
    expect(report.totals.invalidEnvelopeRecords).toBe(0);
    expect(report.totals.invalidRecords).toBe(0);
    expect(report.rejected).toEqual([]);
    expect(report.answers.q3_missing_start_or_identity_or_invalid.count).toBe(0);
    expect(report.answers.q1_open_and_terminal.count).toBe(1);
  });

  it('does not merge cross-host records', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      adaptiveLine({ state: 'open', hookInvocationId: 'inv-1' }, dir),
      adaptiveLine({ state: 'closed', hookInvocationId: 'inv-1', host: 'codex' }, dir),
      adaptiveLine({ state: 'closed', hookInvocationId: 'inv-1', host: null }, dir),
    ]);
    const report = run(dir);
    const invocation = findInvocation(report, 'inv-1');
    expect(invocation.classification).toBe('open_only');
    expect(report.rejected.filter((entry) => entry.reasonCode === 'host_identity_unknown')).toHaveLength(1);
    const allRejected = report.rejected.reduce((sum, entry) => sum + entry.count, 0);
    expect(allRejected).toBe(2);
  });
});

describe('reconcileAdaptiveJournal — window, coverage and truncation', () => {
  it('reads all 8 intersecting date files by default and reports an explicit coverage limit', () => {
    const dir = workspace();
    const dates = ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'];
    dates.forEach((dateKey, index) => {
      writeEvents(dir, dateKey, [adaptiveLine({ state: 'open', hookInvocationId: `inv-${index}` }, dir)]);
    });
    const complete = run(dir);
    expect(complete.coverage.dateFilesIntersecting).toBe(8);
    expect(complete.coverage.filesRead).toBe(8);
    expect(complete.coverage.status).toBe('complete');
    expect(complete.coverage.limitCode).toBeNull();

    const limited = run(dir, { limits: { maxDateFilesPerDir: 7 } });
    expect(limited.coverage.filesRead).toBe(7);
    expect(limited.coverage.status).toBe('partial');
    expect(limited.coverage.limitCode).toBe('coverage_file_limit_reached');
    expect(limited.coverage.filesOmitted).toHaveLength(1);
    expect(limited.totals.countsAreLowerBounds).toBe(true);
    expect(limited.answers.q1_open_and_terminal.countBasis).toBe('lower_bound');
    expect(limited.nextAction.join('|')).toContain('coverage_file_limit_reached');
  });

  it('truncates output at the invocation limit with explicit omission counts', () => {
    const dir = workspace();
    const lines: string[] = [];
    for (let index = 0; index < 1001; index += 1) {
      const id = `inv-${String(index).padStart(4, '0')}`;
      lines.push(adaptiveLine({ state: 'open', hookInvocationId: id, ts: '2026-11-05T08:00:00.000Z' }, dir));
      lines.push(adaptiveLine({ state: 'closed', hookInvocationId: id, ts: '2026-11-05T09:00:00.000Z' }, dir));
    }
    writeEvents(dir, '2026-11-05', lines);
    const report = run(dir);
    expect(report.invocations).toHaveLength(1000);
    expect(report.outputTruncated).toBe(true);
    expect(report.truncation?.limit).toBe(1000);
    expect(report.truncation?.included).toBe(1000);
    expect(report.truncation?.omitted).toBe(1);
    expect(report.truncation?.omittedByClassification).toEqual({
      paired_open_and_terminal: 1,
      open_only: 0,
      terminal_only: 0,
      conflicted: 0,
      invalid: 0,
    });
    expect(report.answers.q1_open_and_terminal.countBasis).toBe('lower_bound');
    expect(report.nextAction.join('|')).toContain('缩小窗口');
  });

  it('retains the omitted conflicted count when output is truncated', () => {
    const dir = workspace();
    const lines: string[] = [];
    // Two conflicted invocations sort first; a smaller limit must still report omitted conflicts.
    for (const id of ['conf-1', 'conf-2']) {
      lines.push(adaptiveLine({ state: 'open', hookInvocationId: id, ts: '2026-11-05T08:00:00.000Z', artifactId: 'art-a' }, dir));
      lines.push(adaptiveLine({ state: 'open', hookInvocationId: id, ts: '2026-11-05T08:10:00.000Z', artifactId: 'art-b' }, dir));
      lines.push(adaptiveLine({ state: 'closed', hookInvocationId: id, ts: '2026-11-05T09:00:00.000Z', artifactId: 'art-a' }, dir));
    }
    lines.push(adaptiveLine({ state: 'open', hookInvocationId: 'paired-1', ts: '2026-11-05T08:20:00.000Z' }, dir));
    lines.push(adaptiveLine({ state: 'closed', hookInvocationId: 'paired-1', ts: '2026-11-05T09:10:00.000Z' }, dir));
    writeEvents(dir, '2026-11-05', lines);
    const report = run(dir, { limits: { maxInvocations: 1 } });
    expect(report.truncation?.omittedByClassification.conflicted).toBe(1);
    expect(report.truncation?.omittedByClassification.paired_open_and_terminal).toBe(1);
    expect(report.truncation?.omitted).toBe(2);
  });

  it('truncates terminal variants at the per-invocation limit and keeps the conflict conclusion', () => {
    const dir = workspace();
    const lines: string[] = [adaptiveLine({ state: 'open', hookInvocationId: 'inv-1', ts: '2026-11-05T08:00:00.000Z' }, dir)];
    for (let index = 0; index < 6; index += 1) {
      lines.push(adaptiveLine({
        state: 'closed',
        hookInvocationId: 'inv-1',
        ts: `2026-11-05T08:${String(10 + index).padStart(2, '0')}:00.000Z`,
        execution: index === 0 ? 'completed' : 'degraded',
        payload: index === 0 ? 'prepared' : 'none',
        selection: index === 0 ? 'selected' : 'skipped',
        reason: `reason-${index}`,
      }, dir));
    }
    writeEvents(dir, '2026-11-05', lines);
    const report = run(dir);
    const invocation = findInvocation(report, 'inv-1');
    expect(invocation.classification).toBe('conflicted');
    expect(invocation.reasonCodes).toContain('terminal_variants_truncated');
    expect(invocation.reasonCodes).toContain('output_truncated');
    expect(invocation.terminalVariants).toHaveLength(4);
    expect(invocation.terminalVariantsOmitted).toBe(1);
    expect(report.outputTruncated).toBe(true);
    expect(report.truncation?.terminalVariantsOmitted).toBe(1);
    expect(report.totals.countsAreLowerBounds).toBe(true);
  });

  it('transcribes recorded evidence flags without re-verifying (acceptance 19)', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      adaptiveLine({ state: 'open', hookInvocationId: 'inv-1', ts: '2026-11-05T08:00:00.000Z' }, dir),
      adaptiveLine({
        state: 'closed',
        hookInvocationId: 'inv-1',
        ts: '2026-11-05T09:00:00.000Z',
        execution: 'completed',
        payload: 'confirmed',
        selection: 'selected',
        submission: 'unknown',
        evidence: { reference: 'ev-1', independentlyVerified: true, hostKillConfirmed: false },
      }, dir),
    ]);
    const report = run(dir);
    const invocation = findInvocation(report, 'inv-1');
    expect(invocation.terminal?.evidenceReferencePresent).toBe(true);
    expect(invocation.terminal?.evidenceIndependentlyVerifiedAsRecorded).toBe(true);
    expect(invocation.terminal?.hostKillConfirmedAsRecorded).toBe(false);
    expect(invocation.terminal?.submission).toBe('unknown');
    const q5 = JSON.stringify(report.answers.q5);
    expect(q5).not.toContain('已独立验证');
    expect(q5).not.toContain('已送达');
    expect(q5).toContain('不重新认证');
  });
});

describe('reconcileAdaptiveJournal — read-only guarantees and errors', () => {
  it('leaves every input file byte-identical and adds no files', () => {
    const dir = workspace();
    writeEvents(dir, '2026-10-30', [adaptiveLine({ state: 'open', hookInvocationId: 'inv-a', ts: '2026-10-30T09:00:00.000Z' }, dir)]);
    writeEvents(dir, '2026-11-05', [adaptiveLine({ state: 'closed', hookInvocationId: 'inv-a' }, dir)]);
    writeEvents(dir, '2026-11-05', [adaptiveLine({ state: 'open', hookInvocationId: 'inv-b' }, dir)], '.state/logs');
    const before = hashTree(dir);
    const report = run(dir);
    const after = hashTree(dir);
    expect(before).toEqual(after);
    expect(report.readOnly).toBe(true);
    expect(report.coverage.filesRead).toBe(3);
  });

  it('reports unavailable coverage with null counts when no log directory exists', () => {
    const dir = workspace();
    const report = run(dir);
    expect(report.coverage.status).toBe('unavailable');
    expect(report.coverage.sourceDirsFound).toBe(0);
    expect(report.totals.uniqueInvocations).toBeNull();
    expect(report.totals.countsAreLowerBounds).toBe(false);
    expect(report.answers.q1_open_and_terminal.count).toBeNull();
    expect(report.answers.q1_open_and_terminal.countBasis).toBeNull();
    expect(report.answers.q5.unknowns[0]).toContain('不等于零调用');
  });

  it('treats an unreadable log file as partial coverage, never as zero events', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [adaptiveLine({ state: 'open', hookInvocationId: 'inv-1' }, dir)]);
    const file = path.join(dir, '.pd', 'logs', 'events_2026-11-04.jsonl');
    fs.writeFileSync(file, '');
    // Directory-style path: readBoundedLines' statSync throws → read_failed.
    fs.rmSync(file);
    fs.mkdirSync(file, { recursive: true });
    const report = run(dir);
    expect(report.coverage.status).toBe('partial');
    expect(report.coverage.filesSkipped).toBe(1);
    expect(report.coverage.errors.some((entry) => entry.code === 'read_failed')).toBe(true);
    expect(report.totals.countsAreLowerBounds).toBe(true);
  });

  it('rejects invalid parameters with structured errors', () => {
    const dir = workspace();
    const result = reconcileAdaptiveJournal({ workspaceDir: dir, now: NOW, since: '2026-11-05T12:00:00.000Z' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('since_after_until');
    expect(result.schemaVersion).toBe(ADAPTIVE_JOURNAL_SCHEMA_VERSION);
    expect(result.readOnly).toBe(true);

    const future = reconcileAdaptiveJournal({ workspaceDir: dir, now: NOW, until: '2026-11-05T11:00:00.000Z' });
    expect(future.ok).toBe(false);
    if (future.ok) return;
    expect(future.error.code).toBe('until_after_now');

    const badLimit = reconcileAdaptiveJournal({ workspaceDir: dir, now: NOW, limits: { maxInvocations: 0 } });
    expect(badLimit.ok).toBe(false);
    if (badLimit.ok) return;
    expect(badLimit.error.code).toBe('invalid_limit');

    const badHost = reconcileAdaptiveJournal({ workspaceDir: dir, now: NOW, host: 'codex' });
    expect(badHost.ok).toBe(false);
    if (badHost.ok) return;
    expect(badHost.error.code).toBe('unsupported_host');
  });
});
