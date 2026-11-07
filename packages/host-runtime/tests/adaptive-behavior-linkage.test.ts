/**
 * PRI-1114 — read-only behavior evidence linkage (design v0.2).
 *
 * Counterexamples O1–O5 are required by the Owner and must fail before the
 * implementation exists, then pass. The remaining cases cover the twelve
 * pre-existing acceptance counterexamples (design §8).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyTrajectorySchemaBase } from '@principles/core/runtime';
import {
  ADAPTIVE_BEHAVIOR_LINKAGE_SCHEMA_VERSION,
  type BehaviorLinkageReport,
  linkAdaptiveBehaviorEvidence,
} from '../src/adaptive-behavior-linkage.js';

const NOW = new Date('2026-11-05T10:00:00.000Z');
const OPEN_TS = '2026-11-05T09:00:00.000Z';
const TERMINAL_TS = '2026-11-05T09:05:00.000Z';

const tempDirs: string[] = [];

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-link-'));
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

interface AdaptiveSpec {
  ts?: string;
  id?: string;
  state?: 'open' | 'closed' | 'reconciled';
  sessionId?: string;
  runId?: string;
  artifactId?: string;
  activationId?: string;
  fingerprint?: string;
  targetBodySha256?: string | null;
  reason?: string;
  workspaceDir?: string | null;
}

function adaptiveLine(spec: AdaptiveSpec, workspaceDir: string): string {
  const ts = spec.ts ?? OPEN_TS;
  const state = spec.state ?? 'open';
  const data: Record<string, unknown> = {
    host: 'openclaw',
    runtimeMode: 'shadow',
    workspaceDir: spec.workspaceDir === undefined ? workspaceDir : spec.workspaceDir,
    sessionId: spec.sessionId ?? 'sess-1',
    runId: spec.runId ?? 'run-1',
    artifactId: spec.artifactId ?? 'art-1',
    activationId: spec.activationId ?? 'act-1',
    hostVersion: 'unknown',
    pluginVersion: 'unknown',
    effectiveHookSetFingerprint: spec.fingerprint ?? 'fp-a',
    evidenceCoverage: 'partial',
    hookInvocationId: spec.id ?? 'inv-1',
    receiptState: state,
    execution: state === 'open' ? 'unknown' : 'completed',
    payload: state === 'open' ? 'unknown' : 'prepared',
    selection: state === 'open' ? 'unavailable' : 'selected',
    submission: 'unknown',
  };
  if (state === 'open') data.selectionPending = true;
  if (state !== 'open') {
    data.reason = spec.reason ?? 'native_entry_preserved';
    data.addedTarget = false;
    if (spec.targetBodySha256 !== null) data.targetBodySha256 = spec.targetBodySha256 ?? 'sha-body';
  }
  return JSON.stringify({
    ts,
    date: ts.slice(0, 10),
    type: 'adaptive_delivery',
    category: 'written',
    sessionId: data.sessionId,
    data,
  });
}

interface ToolCallSpec {
  ts?: string;
  sessionId?: string;
  runId?: string | null;
  toolCallId?: string;
  toolName?: string;
  filePath?: string | null;
  error?: string | null;
  errorType?: string | null;
  exitCode?: number | null;
}

function toolCallLine(spec: ToolCallSpec): string {
  const ts = spec.ts ?? '2026-11-05T09:02:00.000Z';
  const data: Record<string, unknown> = { toolName: spec.toolName ?? 'read' };
  if (spec.runId !== null) data.runId = spec.runId ?? 'run-1';
  if (spec.toolCallId !== undefined) data.toolCallId = spec.toolCallId;
  if (spec.filePath !== null) data.filePath = spec.filePath ?? 'src/a.ts';
  if (spec.error !== null && spec.error !== undefined) data.error = spec.error;
  if (spec.errorType !== null && spec.errorType !== undefined) data.errorType = spec.errorType;
  if (spec.exitCode !== null && spec.exitCode !== undefined) data.exitCode = spec.exitCode;
  return JSON.stringify({
    ts,
    date: ts.slice(0, 10),
    type: 'tool_call',
    category: (data.error ?? (typeof data.exitCode === 'number' && data.exitCode !== 0)) ? 'failure' : 'success',
    sessionId: spec.sessionId ?? 'sess-1',
    data,
  });
}

interface TrajectoryFixture {
  assistantTurns?: { id?: number; sessionId?: string; runId: string; createdAt?: string }[];
  userTurns?: {
    id?: number;
    sessionId?: string;
    turnIndex: number;
    correctionDetected: 0 | 1;
    referencesAssistantTurnId?: number | null;
    createdAt?: string;
  }[];
  toolCalls?: {
    id?: number;
    sessionId?: string;
    toolName: string;
    outcome: string;
    createdAt?: string;
    paramsJson?: string;
    resultPreview?: string;
    exitCode?: number | null;
    errorType?: string | null;
  }[];
  taskOutcomes?: {
    sessionId?: string;
    taskId?: string | null;
    outcome: string;
    summary?: string;
    principleIdsJson?: string;
    createdAt?: string;
  }[];
}

function createTrajectory(workspaceDir: string, fixture: TrajectoryFixture): string {
  const dbPath = path.join(workspaceDir, '.state', 'trajectory.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  applyTrajectorySchemaBase(db);
  for (const turn of fixture.assistantTurns ?? []) {
    db.prepare(`
      INSERT INTO assistant_turns (id, session_id, run_id, provider, model, sanitized_text, usage_json, empathy_signal_json, created_at)
      VALUES (?, ?, ?, 'openclaw', 'model', 'assistant text', '{}', '{}', ?)
    `).run(turn.id ?? null, turn.sessionId ?? 'sess-1', turn.runId, turn.createdAt ?? OPEN_TS);
  }
  for (const turn of fixture.userTurns ?? []) {
    db.prepare(`
      INSERT INTO user_turns (id, session_id, turn_index, correction_detected, references_assistant_turn_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      turn.id ?? null,
      turn.sessionId ?? 'sess-1',
      turn.turnIndex,
      turn.correctionDetected,
      turn.referencesAssistantTurnId ?? null,
      turn.createdAt ?? TERMINAL_TS,
    );
  }
  for (const call of fixture.toolCalls ?? []) {
    db.prepare(`
      INSERT INTO tool_calls (id, session_id, tool_name, outcome, exit_code, error_type, params_json, result_preview, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      call.id ?? null,
      call.sessionId ?? 'sess-1',
      call.toolName,
      call.outcome,
      call.exitCode ?? null,
      call.errorType ?? null,
      call.paramsJson ?? '{}',
      call.resultPreview ?? null,
      call.createdAt ?? '2026-11-05T09:02:00.000Z',
    );
  }
  for (const outcome of fixture.taskOutcomes ?? []) {
    db.prepare(`
      INSERT INTO task_outcomes (session_id, task_id, outcome, summary, principle_ids_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      outcome.sessionId ?? 'sess-1',
      outcome.taskId ?? null,
      outcome.outcome,
      outcome.summary ?? null,
      outcome.principleIdsJson ?? '[]',
      outcome.createdAt ?? TERMINAL_TS,
    );
  }
  db.close();
  return dbPath;
}

function run(
  workspaceDir: string,
  overrides: Partial<Parameters<typeof linkAdaptiveBehaviorEvidence>[0]> = {},
): BehaviorLinkageReport {
  const result = linkAdaptiveBehaviorEvidence({ workspaceDir, now: NOW, ...overrides });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`unexpected failure: ${result.error.code}`);
  expect(result.report.schemaVersion).toBe(ADAPTIVE_BEHAVIOR_LINKAGE_SCHEMA_VERSION);
  return result.report;
}

function invocation(report: BehaviorLinkageReport, id: string) {
  const found = report.invocations.find((item) => item.intervention.hookInvocationId === id);
  expect(found).toBeDefined();
  return found!;
}

function hashTree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) result[`dir:${path.relative(root, absolute)}`] = 'dir';
      else result[`file:${path.relative(root, absolute)}`] = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
      if (entry.isDirectory()) walk(absolute);
    }
  };
  walk(root);
  return result;
}

const SINGLE_RUN_JOURNAL = (dir: string): string[] => [
  adaptiveLine({ ts: OPEN_TS, state: 'open' }, dir),
  adaptiveLine({ ts: TERMINAL_TS, state: 'closed' }, dir),
];

describe('PRI-1114 — strong run-level association', () => {
  it('links a run only when range, identity, conflict, uniqueness and config hold', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      ...SINGLE_RUN_JOURNAL(dir),
      toolCallLine({ runId: 'run-1', toolCallId: 'tc-1', toolName: 'read' }),
    ]);
    const report = run(dir);
    const item = invocation(report, 'inv-1');
    expect(item.association).toBe('strong_run');
    expect(item.associationReasons).toContain('run_identity_proven');
    expect(item.facts.actions).toHaveLength(1);
    expect(item.facts.actions[0]?.strength).toBe('run_strong');
    // Owner correction 2: open is a journal timestamp, never a delivery time.
    expect(item.facts.actions[0]?.ordering).toBe('unknown');
  });
});

describe('O1 — truncation must never manufacture uniqueness', () => {
  it('stays unknown when the journal range is truncated but only one injection is visible', () => {
    const dir = workspace();
    // Older date file is omitted by the 1-file coverage limit.
    writeEvents(dir, '2026-11-04', [adaptiveLine({ ts: '2026-11-04T09:00:00.000Z', id: 'inv-old' }, dir)]);
    writeEvents(dir, '2026-11-05', SINGLE_RUN_JOURNAL(dir));
    const report = run(dir, { limits: { maxDateFilesPerDir: 1 } });
    expect(report.coverage.journal.complete).toBe(false);
    expect(report.coverage.eventLog.filesRead).toBeLessThanOrEqual(1);
    expect(report.coverage.eventLog.omittedFiles).toBeGreaterThanOrEqual(1);
    expect(invocation(report, 'inv-1').association).toBe('unknown');
    expect(invocation(report, 'inv-1').associationReasons).toContain('journal_range_incomplete');
  });
});

describe('O2 — one run with multiple requests', () => {
  it('marks both invocations ambiguous instead of promoting either to a request-level link', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      adaptiveLine({ ts: '2026-11-05T08:00:00.000Z', id: 'inv-a', state: 'open' }, dir),
      adaptiveLine({ ts: '2026-11-05T08:05:00.000Z', id: 'inv-a', state: 'closed' }, dir),
      adaptiveLine({ ts: '2026-11-05T09:00:00.000Z', id: 'inv-b', state: 'open' }, dir),
      adaptiveLine({ ts: '2026-11-05T09:05:00.000Z', id: 'inv-b', state: 'closed' }, dir),
    ]);
    const report = run(dir);
    for (const item of report.invocations) {
      expect(item.association).toBe('ambiguous');
      expect(item.associationReasons).toContain('run_has_multiple_invocations');
    }
  });
});

describe('O3 — action after open is not proof of ordering', () => {
  it('keeps ordering unknown when the action falls between open and any hypothetical delivery', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      ...SINGLE_RUN_JOURNAL(dir),
      toolCallLine({ ts: '2026-11-05T09:01:00.000Z', runId: 'run-1' }),
    ]);
    const report = run(dir);
    const action = invocation(report, 'inv-1').facts.actions[0];
    expect(action?.ordering).toBe('unknown');
    expect(action?.relativeToRecordedOpen).toBe('after_open');
    // No field may claim the intervention preceded the action.
    expect(JSON.stringify(action)).not.toContain('before_delivery');
    expect(JSON.stringify(action)).not.toContain('interventionBeforeAction');
  });
});

describe('O4 — completed is a model-output record, not task success', () => {
  it('never upgrades a completed outcome to success even when a tool failed', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      ...SINGLE_RUN_JOURNAL(dir),
      toolCallLine({ ts: '2026-11-05T09:06:00.000Z', runId: 'run-1', error: 'boom', errorType: 'tool_error' }),
    ]);
    createTrajectory(dir, {
      taskOutcomes: [{ sessionId: 'sess-1', taskId: 'run-1', outcome: 'completed', createdAt: '2026-11-05T09:07:00.000Z' }],
    });
    const report = run(dir);
    const outcome = invocation(report, 'inv-1').facts.outcomes[0];
    expect(outcome?.recordedOutcome).toBe('completed');
    expect(outcome?.modelCompletionRecorded).toBe(true);
    expect(outcome?.semantics).toBe('model_completion_only');
    expect(outcome?.taskSuccess).toBe('unknown');
  });
});

describe('O5 — declared write target is not a produced artifact', () => {
  it('reports declared targets but never confirms an artifact', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      ...SINGLE_RUN_JOURNAL(dir),
      toolCallLine({ ts: '2026-11-05T09:06:00.000Z', runId: 'run-1', toolName: 'write', filePath: 'src/secret.ts' }),
    ]);
    const report = run(dir);
    const artifacts = invocation(report, 'inv-1').facts.artifacts;
    expect(artifacts.declaredTargetCount).toBe(1);
    expect(artifacts.declaredByToolNames).toEqual(['write']);
    expect(artifacts.confirmedCount).toBe(0);
    expect(artifacts.confirmation).toBe('unknown');
  });
});

describe('pre-existing counterexamples', () => {
  it('does not link across sessions even when the principle artifact is identical', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      adaptiveLine({ ts: OPEN_TS, state: 'open', sessionId: 'sess-1', runId: 'run-1' }, dir),
      adaptiveLine({ ts: TERMINAL_TS, state: 'closed', sessionId: 'sess-1', runId: 'run-1' }, dir),
      adaptiveLine({ ts: '2026-11-05T09:10:00.000Z', state: 'open', id: 'inv-2', sessionId: 'sess-2', runId: 'run-2' }, dir),
      adaptiveLine({ ts: '2026-11-05T09:15:00.000Z', state: 'closed', id: 'inv-2', sessionId: 'sess-2', runId: 'run-2' }, dir),
      toolCallLine({ ts: '2026-11-05T09:20:00.000Z', sessionId: 'sess-2', runId: 'run-2', toolName: 'read' }),
    ]);
    const report = run(dir);
    expect(invocation(report, 'inv-1').facts.actions).toHaveLength(0);
    expect(invocation(report, 'inv-2').facts.actions).toHaveLength(1);
  });

  it('keeps session/time-only trajectory rows as unverified weak candidates', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', SINGLE_RUN_JOURNAL(dir));
    createTrajectory(dir, {
      toolCalls: [{ sessionId: 'sess-1', toolName: 'read', outcome: 'success', createdAt: '2026-11-05T09:02:00.000Z' }],
    });
    const report = run(dir);
    const item = invocation(report, 'inv-1');
    expect(item.facts.actions).toHaveLength(0);
    expect(item.weakCandidates).toHaveLength(1);
    expect(item.weakCandidates[0]?.verified).toBe(false);
    expect(item.weakCandidates[0]?.reason).toBe('session_tool_time_only');
  });

  it('retains every action and correction for one opportunity', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      ...SINGLE_RUN_JOURNAL(dir),
      toolCallLine({ ts: '2026-11-05T09:06:00.000Z', runId: 'run-1', toolCallId: 'tc-1', toolName: 'read' }),
      toolCallLine({ ts: '2026-11-05T09:08:00.000Z', runId: 'run-1', toolCallId: 'tc-2', toolName: 'write' }),
    ]);
    createTrajectory(dir, {
      assistantTurns: [{ id: 7, sessionId: 'sess-1', runId: 'run-1' }],
      userTurns: [
        { sessionId: 'sess-1', turnIndex: 1, correctionDetected: 1, referencesAssistantTurnId: 7, createdAt: '2026-11-05T09:20:00.000Z' },
        { sessionId: 'sess-1', turnIndex: 2, correctionDetected: 1, referencesAssistantTurnId: 7, createdAt: '2026-11-05T09:30:00.000Z' },
      ],
    });
    const report = run(dir);
    const item = invocation(report, 'inv-1');
    expect(item.facts.actions).toHaveLength(2);
    expect(item.facts.corrections).toHaveLength(2);
    // Later corrections never replace the first action.
    expect(item.facts.actions.map((action) => action.toolName)).toEqual(['read', 'write']);
  });

  it('keeps conflicted terminal variants without picking a winner', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      adaptiveLine({ ts: OPEN_TS, state: 'open' }, dir),
      adaptiveLine({ ts: TERMINAL_TS, state: 'closed', reason: 'native_entry_preserved' }, dir),
      adaptiveLine({ ts: '2026-11-05T09:06:00.000Z', state: 'closed', reason: 'deadline' }, dir),
    ]);
    const report = run(dir);
    const item = invocation(report, 'inv-1');
    expect(item.association).toBe('conflict');
    expect(item.conflicts.length).toBeGreaterThan(0);
    expect(item.intervention.terminal.variants).toBe(1);
  });

  it('flags an action before open without claiming it happened after the injection', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      ...SINGLE_RUN_JOURNAL(dir),
      toolCallLine({ ts: '2026-11-05T08:50:00.000Z', runId: 'run-1', toolCallId: 'tc-early' }),
    ]);
    const report = run(dir);
    const action = invocation(report, 'inv-1').facts.actions[0];
    expect(action?.relativeToRecordedOpen).toBe('before_open');
    expect(action?.ordering).toBe('unknown');
    expect(invocation(report, 'inv-1').associationReasons).toContain('action_before_open');
  });

  it('keeps missing terminal facts unknown rather than assuming success', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [adaptiveLine({ ts: OPEN_TS, state: 'open' }, dir)]);
    const report = run(dir);
    const item = invocation(report, 'inv-1');
    expect(item.association).toBe('weak');
    expect(item.associationReasons).toContain('terminal_not_visible_in_range');
    expect(item.unknowns.some((entry) => entry.reasonCode === 'terminal_not_visible_in_range')).toBe(true);
  });

  it('marks a configuration identity change instead of reusing the old snapshot', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      adaptiveLine({ ts: OPEN_TS, state: 'open', fingerprint: 'fp-a' }, dir),
      adaptiveLine({ ts: TERMINAL_TS, state: 'closed', fingerprint: 'fp-b' }, dir),
    ]);
    const report = run(dir);
    const item = invocation(report, 'inv-1');
    expect(item.association).toBe('unknown');
    expect(item.associationReasons).toContain('config_changed');
    expect(item.conflicts.some((entry) => entry.kind === 'config_identity')).toBe(true);
  });

  it('reports exhausted read budgets instead of silently shrinking evidence', () => {
    const dir = workspace();
    const lines: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      lines.push(toolCallLine({ ts: `2026-11-05T09:0${index % 5}:0${index % 10}.000Z`, runId: 'run-1', toolCallId: `tc-${index}` }));
    }
    writeEvents(dir, '2026-11-05', [...SINGLE_RUN_JOURNAL(dir), ...lines]);
    const report = run(dir, { limits: { maxEventLogLines: 10 } });
    expect(report.coverage.eventLog.truncated).toBe(true);
    expect(report.coverage.eventLog.linesRead).toBeLessThanOrEqual(10);
    expect(report.coverage.incompleteReasons).toContain('event_log_parse_limit_reached');
  });

  it('reports a missing trajectory database as unavailable and never creates it', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', SINGLE_RUN_JOURNAL(dir));
    const report = run(dir);
    expect(report.coverage.trajectory.status).toBe('unavailable');
    expect(report.coverage.trajectory.reasons).toContain('trajectory_db_unavailable');
    expect(fs.existsSync(path.join(dir, '.state', 'trajectory.db'))).toBe(false);
  });

  it('reports an incomplete trajectory schema as unavailable without migrating it', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', SINGLE_RUN_JOURNAL(dir));
    const dbPath = path.join(dir, '.state', 'trajectory.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec('CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, params_json TEXT NOT NULL, created_at TEXT NOT NULL)');
    db.close();
    const report = run(dir);
    expect(report.coverage.trajectory.status).toBe('unavailable');
    expect(report.coverage.trajectory.reasons).toContain('trajectory_schema_incomplete');
  });

  it('does not pretend a session-level principle set proves run-level agreement', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', SINGLE_RUN_JOURNAL(dir));
    createTrajectory(dir, {
      taskOutcomes: [{ sessionId: 'sess-1', taskId: 'run-1', outcome: 'completed', principleIdsJson: '["principle-x"]' }],
    });
    const report = run(dir);
    const item = invocation(report, 'inv-1');
    expect(item.facts.outcomes[0]?.principleBinding).toBe('session_level_unknown');
    expect(item.conflicts.some((entry) => entry.kind === 'principle_ids')).toBe(false);
  });
});

describe('review — coverage completeness and claim layers', () => {
  it('does not prove uniqueness when the journal scan dropped malformed lines', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      ...SINGLE_RUN_JOURNAL(dir),
      '{"ts":"2026-11-05T09:06:00.000Z","type":"adaptive_delivery",broken',
    ]);
    const report = run(dir);
    expect(report.coverage.journal.malformedLines).toBe(1);
    expect(report.coverage.journal.complete).toBe(false);
    expect(invocation(report, 'inv-1').association).toBe('unknown');
    expect(report.coverage.incompleteReasons).toContain('journal_range_incomplete');
  });

  it('reports EventLog parse failures as incomplete coverage', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      ...SINGLE_RUN_JOURNAL(dir),
      '{"ts":"2026-11-05T09:06:00.000Z","type":"tool_call",broken',
    ]);
    const report = run(dir);
    expect(report.coverage.eventLog.parseErrors).toBe(1);
    expect(report.coverage.incompleteReasons).toContain('event_log_parse_errors');
  });

  it('treats omitted EventLog date files as truncated coverage', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-04', [toolCallLine({ ts: '2026-11-04T09:02:00.000Z', runId: 'run-1' })]);
    writeEvents(dir, '2026-11-05', SINGLE_RUN_JOURNAL(dir));
    const report = run(dir, { limits: { maxDateFilesPerDir: 1 } });
    expect(report.coverage.eventLog.omittedFiles).toBeGreaterThanOrEqual(1);
    expect(report.coverage.eventLog.truncated).toBe(true);
    expect(report.coverage.incompleteReasons).toContain('event_log_files_omitted');
  });

  it('marks per-invocation action caps as incomplete coverage', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      ...SINGLE_RUN_JOURNAL(dir),
      toolCallLine({ ts: '2026-11-05T09:06:00.000Z', runId: 'run-1', toolCallId: 'tc-1' }),
      toolCallLine({ ts: '2026-11-05T09:07:00.000Z', runId: 'run-1', toolCallId: 'tc-2' }),
    ]);
    const report = run(dir, { limits: { maxActionsPerInvocation: 1 } });
    expect(invocation(report, 'inv-1').facts.actions).toHaveLength(1);
    expect(report.coverage.complete).toBe(false);
    expect(report.coverage.incompleteReasons).toContain('action_limit_reached');
  });

  it('separates run-level association from request-level, adherence and causal claims', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      ...SINGLE_RUN_JOURNAL(dir),
      toolCallLine({ runId: 'run-1', toolCallId: 'tc-1' }),
    ]);
    const report = run(dir);
    expect(invocation(report, 'inv-1').evidenceLayers).toEqual({
      runAssociation: 'strong_run',
      requestAssociation: 'unknown',
      principleAdherence: 'unknown',
      behaviorImprovement: 'unknown',
    });
  });

  it('treats a partially invalid principle id array as incomparable, not absent', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', SINGLE_RUN_JOURNAL(dir));
    createTrajectory(dir, {
      taskOutcomes: [{ sessionId: 'sess-1', taskId: 'run-1', outcome: 'completed', principleIdsJson: '[null]' }],
    });
    const report = run(dir);
    expect(invocation(report, 'inv-1').facts.outcomes[0]?.principleBinding).toBe('session_level_unknown');
  });

  it('counts tool events whose run identity is missing instead of silently dropping them', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      ...SINGLE_RUN_JOURNAL(dir),
      toolCallLine({ runId: null, toolCallId: 'tc-1' }),
    ]);
    const report = run(dir);
    expect(report.coverage.eventLog.unattributedToolCalls).toBe(1);
    expect(invocation(report, 'inv-1').facts.actions).toHaveLength(0);
  });

  it('reports an unavailable EventLog source instead of an empty result', () => {
    const dir = workspace();
    const report = run(dir);
    expect(report.coverage.eventLog.dirsFound).toBe(0);
    expect(report.coverage.incompleteReasons).toContain('event_log_unavailable');
  });
});

describe('read-only and privacy contracts', () => {
  it('leaves every workspace file byte-identical', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      ...SINGLE_RUN_JOURNAL(dir),
      toolCallLine({ runId: 'run-1', toolCallId: 'tc-1' }),
    ]);
    createTrajectory(dir, {
      taskOutcomes: [{ sessionId: 'sess-1', taskId: 'run-1', outcome: 'completed' }],
    });
    const before = hashTree(dir);
    run(dir);
    const after = hashTree(dir);
    expect(after).toEqual(before);
  });

  it('projects no raw command, params, result preview, summary, path or session text', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      ...SINGLE_RUN_JOURNAL(dir),
      toolCallLine({
        runId: 'run-1',
        toolName: 'bash',
        filePath: 'C:/secret/secret.ts',
        error: 'TOP_SECRET_ERROR rm -rf /',
      }),
    ]);
    createTrajectory(dir, {
      toolCalls: [{
        sessionId: 'sess-1',
        toolName: 'bash',
        outcome: 'failure',
        paramsJson: JSON.stringify({ command: 'rm -rf /', filePath: 'C:/secret/secret.ts' }),
        resultPreview: 'TOP_SECRET_PREVIEW',
      }],
      taskOutcomes: [{ sessionId: 'sess-1', taskId: 'run-1', outcome: 'completed', summary: 'TOP_SECRET_SUMMARY' }],
    });
    const report = run(dir);
    const serialized = JSON.stringify(report);
    for (const secret of ['TOP_SECRET', 'rm -rf', 'secret.ts', 'C:/secret']) {
      expect(serialized).not.toContain(secret);
    }
  });
});

// Each case builds a 200-row-per-table fixture to place the target at row 201;
// the slowest case measures ~4.8s against vitest's 5s default and timed out once
// when the full suite competed for CPU. Explicit budget, unchanged assertions.
describe('coverage propagation — session row truncation is not a complete read', { timeout: 15000 }, () => {
  const SAME_TS = '2026-11-05T09:03:00.000Z';

  it('reports incomplete when the target outcome sits beyond the per-session row cap', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', [
      ...SINGLE_RUN_JOURNAL(dir),
      toolCallLine({ runId: 'run-1', toolCallId: 'tc-1' }),
    ]);
    const otherRunOutcomes = Array.from({ length: 200 }, (_, index) => ({
      sessionId: 'sess-1',
      taskId: `other-run-${index}`,
      outcome: 'completed',
      createdAt: SAME_TS,
    }));
    createTrajectory(dir, {
      taskOutcomes: [
        ...otherRunOutcomes,
        { sessionId: 'sess-1', taskId: 'run-1', outcome: 'completed', createdAt: SAME_TS },
      ],
    });
    const report = run(dir);
    const item = invocation(report, 'inv-1');
    // The target outcome is row 201 and must not be presented as "no outcome".
    expect(item.facts.outcomes).toHaveLength(0);
    expect(report.coverage.complete).toBe(false);
    expect(report.coverage.trajectory.truncated).toBe(true);
    expect(report.coverage.incompleteReasons).toContain('session_rows_truncated');
    expect(item.unknowns).toEqual(expect.arrayContaining([
      { fact: 'outcomes', reasonCode: 'session_rows_truncated' },
    ]));
    expect(report.nextAction.join(' ')).toContain('单会话 200 行上限');
    expect(report.nextAction.join(' ')).toContain('缩小 --since/--until');
    expect(report.nextAction.join(' ')).not.toContain('提高 --max-trajectory-rows');
  });

  it('reports incomplete when the target correction sits beyond the per-session row cap', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', SINGLE_RUN_JOURNAL(dir));
    const otherRunTurns = Array.from({ length: 200 }, (_, index) => ({
      id: index + 1,
      sessionId: 'sess-1',
      runId: `other-run-${index}`,
      createdAt: SAME_TS,
    }));
    createTrajectory(dir, {
      assistantTurns: [
        ...otherRunTurns,
        { id: 201, sessionId: 'sess-1', runId: 'run-1', createdAt: SAME_TS },
      ],
      userTurns: [
        ...Array.from({ length: 200 }, (_, index) => ({
          sessionId: 'sess-1',
          turnIndex: index + 1,
          correctionDetected: 1 as const,
          referencesAssistantTurnId: index + 1,
          createdAt: SAME_TS,
        })),
        {
          sessionId: 'sess-1',
          turnIndex: 201,
          correctionDetected: 1 as const,
          referencesAssistantTurnId: 201,
          createdAt: SAME_TS,
        },
      ],
    });
    const report = run(dir);
    const item = invocation(report, 'inv-1');
    expect(item.facts.corrections).toHaveLength(0);
    expect(report.coverage.complete).toBe(false);
    expect(report.coverage.trajectory.truncated).toBe(true);
    expect(report.coverage.incompleteReasons).toContain('session_rows_truncated');
    expect(item.unknowns).toEqual(expect.arrayContaining([
      { fact: 'corrections', reasonCode: 'session_rows_truncated' },
    ]));
  });

  it('reports incomplete when the target weak tool call sits beyond the per-session row cap', () => {
    const dir = workspace();
    writeEvents(dir, '2026-11-05', SINGLE_RUN_JOURNAL(dir));
    createTrajectory(dir, {
      toolCalls: [
        ...Array.from({ length: 200 }, (_, index) => ({
          sessionId: 'sess-1',
          toolName: 'read',
          outcome: 'success',
          createdAt: SAME_TS,
        })),
        { sessionId: 'sess-1', toolName: 'write', outcome: 'success', createdAt: SAME_TS },
      ],
    });
    const report = run(dir, { limits: { maxWeakCandidatesPerInvocation: 200 } });
    const item = invocation(report, 'inv-1');
    expect(item.weakCandidates).toHaveLength(200);
    expect(report.coverage.complete).toBe(false);
    expect(report.coverage.trajectory.truncated).toBe(true);
    expect(report.coverage.incompleteReasons).toContain('session_rows_truncated');
    expect(item.unknowns).toEqual(expect.arrayContaining([
      { fact: 'weak_candidates', reasonCode: 'session_rows_truncated' },
    ]));
  });
});
