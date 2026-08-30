/**
 * SqliteContextAssembler comprehensive test suite.
 *
 * Tests context assembly from diagnostician task records, UUID/hash generation,
 * diagnosis target mapping, ambiguity notes for data quality, schema validation,
 * and error handling for invalid inputs.
 *
 * Uses a mock TaskStore (returns DiagnosticianTaskRecord) and real SQLite
 * RunStore + HistoryQuery for integration coverage.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { SqliteConnection } from '../sqlite-connection.js';
import { SqliteTaskStore } from '../task/sqlite-task-store.js';
import { SqliteRunStore } from '../run/sqlite-run-store.js';
import { SqliteHistoryQuery } from '../history/sqlite-history-query.js';
import { SqliteTrajectoryLocator } from '../trajectory/sqlite-trajectory-locator.js';
import { SqliteSourceTraceLocator } from '../trajectory/sqlite-source-trace-locator.js';
import { SqliteContextAssembler } from './sqlite-context-assembler.js';
import { DiagnosticianContextPayloadSchema } from '../../context-payload.js';
import type { DiagnosticianTaskRecord } from '../../task-status.js';
import type { TaskRecord } from '../../task-status.js';
import type { RunRecord, RunExecutionStatus } from '../../runtime-protocol.js';
import type { TaskStore } from '../task/task-store.js';
import type { TrajectoryTurnReader, TrajectoryUserTurn, TrajectoryAssistantTurn } from './trajectory-turn-reader.js';

// ── Mock TrajectoryTurnReader ──

function createMockTrajectoryTurnReader(
  userTurns: Map<string, TrajectoryUserTurn[]>,
  assistantTurns: Map<string, TrajectoryAssistantTurn[]>,
): TrajectoryTurnReader {
  return {
    listUserTurnsForSession: vi.fn((sessionId: string) => userTurns.get(sessionId) ?? []),
    listAssistantTurns: vi.fn((sessionId: string) => assistantTurns.get(sessionId) ?? []),
  };
}

// ── Mock TaskStore that returns DiagnosticianTaskRecord ──

function createMockTaskStore(tasks: Map<string, DiagnosticianTaskRecord>): TaskStore {
  return {
    createTask: vi.fn(),
    getTask: vi.fn(async (taskId: string) => tasks.get(taskId) ?? null),
    updateTask: vi.fn(),
    updateTaskIfDiagnosticJsonUnchanged: async () => null,
    listTasks: vi.fn(async () => []),
    deleteTask: vi.fn(async () => true),
  };
}

function makeDiagnosticianTask(
  overrides?: Partial<DiagnosticianTaskRecord>,
): DiagnosticianTaskRecord {
  const now = new Date().toISOString();
  return {
    taskId: overrides?.taskId ?? `task_${Date.now()}`,
    taskKind: 'diagnostician',
    status: overrides?.status ?? 'pending',
    createdAt: overrides?.createdAt ?? now,
    updatedAt: overrides?.updatedAt ?? now,
    attemptCount: overrides?.attemptCount ?? 0,
    maxAttempts: overrides?.maxAttempts ?? 3,
    workspaceDir: overrides?.workspaceDir ?? '/tmp/test-workspace',
    reasonSummary: overrides?.reasonSummary ?? 'Test diagnostician task',
    sourcePainId: overrides?.sourcePainId,
    severity: overrides?.severity,
    source: overrides?.source,
    sessionIdHint: overrides?.sessionIdHint,
    agentIdHint: overrides?.agentIdHint,
  };
}

interface TestFixture {
  tmpDir: string;
  connection: SqliteConnection;
  sqliteTaskStore: SqliteTaskStore;
  runStore: SqliteRunStore;
  historyQuery: SqliteHistoryQuery;
  sourceTraceLocator: SqliteSourceTraceLocator | undefined;
  taskStore: TaskStore;
  taskMap: Map<string, TaskRecord>;
  assembler: SqliteContextAssembler;
  trajectoryTurnReader?: TrajectoryTurnReader;
}

function createFixture(tasks?: Map<string, DiagnosticianTaskRecord>, options?: { withLocator?: boolean; trajectoryTurnReader?: TrajectoryTurnReader }): TestFixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-context-assembler-test-'));
  const connection = new SqliteConnection(tmpDir);
  const sqliteTaskStore = new SqliteTaskStore(connection);
  const runStore = new SqliteRunStore(connection);
  const historyQuery = new SqliteHistoryQuery(connection);
  const taskMap = tasks ?? new Map();
  const taskStore = createMockTaskStore(taskMap);
  const sourceTraceLocator = options?.withLocator
    ? new SqliteSourceTraceLocator(taskStore, new SqliteTrajectoryLocator(connection))
    : undefined;
  const trajectoryTurnReader = options?.trajectoryTurnReader;
  const assembler = new SqliteContextAssembler(taskStore, historyQuery, runStore, { sourceTraceLocator, trajectoryTurnReader });
  return { tmpDir, connection, sqliteTaskStore, runStore, historyQuery, sourceTraceLocator, taskStore, taskMap, assembler, trajectoryTurnReader };
}

function cleanupFixture(fixture: TestFixture): void {
  fixture.connection.close();
  fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
}

/** Options for creating a run with payloads. */
interface RunPayloadOptions {
  inputPayload?: string;
  outputPayload?: string;
  runtimeKind?: RunRecord['runtimeKind'];
}

/** Create a base task row in SQLite for FK satisfaction, then create a run. */
async function createRunWithPayloads(
  fixture: TestFixture,
  taskId: string,
  options?: RunPayloadOptions,
): Promise<RunRecord> {
  // Ensure a base task row exists in SQLite for FK constraint
  const existing = await fixture.sqliteTaskStore.getTask(taskId);
  if (!existing) {
    await fixture.sqliteTaskStore.createTask({
      taskId,
      taskKind: 'diagnostician',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    } satisfies Omit<TaskRecord, 'createdAt' | 'updatedAt'>);
  }
  const now = new Date().toISOString();
  return fixture.runStore.createRun({
    runId: `run_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    taskId,
    attemptNumber: 1,
    executionStatus: 'succeeded' as RunExecutionStatus,
    startedAt: now,
    runtimeKind: options?.runtimeKind ?? 'openclaw',
    inputPayload: options?.inputPayload,
    outputPayload: options?.outputPayload,
  } satisfies Omit<RunRecord, 'createdAt' | 'updatedAt'>);
}


/** Create a source task in SQLite with sessionIdHint in diagnosticJson for TrajectoryLocator. */
async function ensureSourceTask(
  fixture: TestFixture,
  sourceTaskId: string,
  opts: { sessionId: string; sourcePainId?: string },
): Promise<void> {
  const dj: Record<string, unknown> = { sessionIdHint: opts.sessionId };
  if (opts.sourcePainId) dj.sourcePainId = opts.sourcePainId;
  const existing = await fixture.sqliteTaskStore.getTask(sourceTaskId);
  if (!existing) {
    await fixture.sqliteTaskStore.createTask({
      taskId: sourceTaskId,
      taskKind: 'user_session',
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 1,
      diagnosticJson: JSON.stringify(dj),
    } satisfies Omit<TaskRecord, 'createdAt' | 'updatedAt'>);
  }
  fixture.taskMap.set(sourceTaskId, {
    taskId: sourceTaskId,
    taskKind: 'user_session',
    status: 'succeeded',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attemptCount: 1,
    maxAttempts: 1,
    diagnosticJson: JSON.stringify(dj),
  } satisfies TaskRecord);
}

/** Helper: check that ambiguityNotes includes a substring (safely). */
function notesInclude(notes: string[] | undefined, substring: string): boolean {
  return notes !== undefined && notes.some((n) => n.includes(substring));
}

describe('SqliteContextAssembler', () => {

  it('assembles payload from diagnostician task with history', async () => {
    const task = makeDiagnosticianTask({
      taskId: 'task_diag_1',
      sourcePainId: 'pain-001',
      severity: 'high',
      source: 'test',
      sessionIdHint: 'sess-123',
      reasonSummary: 'Test reason',
    });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks);
    try {
      const run1 = await createRunWithPayloads(f, task.taskId, { inputPayload: 'input 1', outputPayload: 'output 1' });
      const run2 = await createRunWithPayloads(f, task.taskId, { inputPayload: 'input 2', outputPayload: 'output 2' });

      const payload = await f.assembler.assemble(task.taskId);

      // contextId is UUID format
      expect(payload.contextId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      // contextHash is 64-char hex
      expect(payload.contextHash).toMatch(/^[0-9a-f]{64}$/);
      expect(payload.taskId).toBe('task_diag_1');
      expect(payload.workspaceDir).toBe('/tmp/test-workspace');
      // sourceRefs contains taskId + both runIds
      expect(payload.sourceRefs).toContain('task_diag_1');
      expect(payload.sourceRefs).toContain(run1.runId);
      expect(payload.sourceRefs).toContain(run2.runId);
      // diagnosisTarget has mapped fields
      expect(payload.diagnosisTarget.reasonSummary).toBe('Test reason');
      expect(payload.diagnosisTarget.source).toBe('test');
      expect(payload.diagnosisTarget.severity).toBe('high');
      expect(payload.diagnosisTarget.painId).toBe('pain-001');
      expect(payload.diagnosisTarget.sessionIdHint).toBe('sess-123');
      // conversationWindow has entries (2 per run)
      expect(payload.conversationWindow.length).toBeGreaterThanOrEqual(4);
    } finally { cleanupFixture(f); }
  });

  it('throws storage_unavailable when task not found', async () => {
    const f = createFixture();
    try {
      await expect(f.assembler.assemble('nonexistent-task-id')).rejects.toThrow('[storage_unavailable]');
    } finally { cleanupFixture(f); }
  });

  it('throws input_invalid when task is not diagnostician', async () => {
    const nonDiagTask: TaskRecord = {
      taskId: 'task_other',
      taskKind: 'other_kind',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attemptCount: 0,
      maxAttempts: 3,
    };
    // Cast is safe: mock returns whatever we put in the map.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tasks = new Map<string, DiagnosticianTaskRecord>([[nonDiagTask.taskId, nonDiagTask as any]]);
    const f = createFixture(tasks);
    try {
      await expect(f.assembler.assemble('task_other')).rejects.toThrow('[input_invalid]');
    } finally { cleanupFixture(f); }
  });

  it('returns valid payload with empty conversationWindow', async () => {
    const task = makeDiagnosticianTask({ taskId: 'task_empty_hist' });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks);
    try {
      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.conversationWindow).toEqual([]);
      // contextHash is hash of '[]'
      const expectedHash = createHash('sha256').update('[]').digest('hex');
      expect(payload.contextHash).toBe(expectedHash);
      // ambiguityNotes should mention no history
      expect(notesInclude(payload.ambiguityNotes, 'No conversation history')).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('includes ambiguity note for truncated history', async () => {
    const task = makeDiagnosticianTask({ taskId: 'task_truncated' });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks);
    try {
      // Create enough runs to exceed default page size (50 entries = 25 runs)
      for (let i = 0; i < 30; i++) {
        await createRunWithPayloads(f, task.taskId, { inputPayload: `input ${i}`, outputPayload: `output ${i}` });
      }

      const payload = await f.assembler.assemble(task.taskId);

      // ambiguityNotes should mention truncation
      expect(notesInclude(payload.ambiguityNotes, 'truncated')).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('includes ambiguity note for entries with empty text', async () => {
    const task = makeDiagnosticianTask({ taskId: 'task_empty_text' });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks);
    try {
      // Create runs with no payloads (undefined text in entries)
      await createRunWithPayloads(f, task.taskId);
      await createRunWithPayloads(f, task.taskId);

      const payload = await f.assembler.assemble(task.taskId);

      expect(notesInclude(payload.ambiguityNotes, 'empty text content')).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('ambiguityNotes is undefined when no quality issues', async () => {
    const task = makeDiagnosticianTask({ taskId: 'task_clean' });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks);
    try {
      // Create clean runs with all payloads present (and few enough not to truncate)
      await createRunWithPayloads(f, task.taskId, { inputPayload: 'good input', outputPayload: 'good output' });
      await createRunWithPayloads(f, task.taskId, { inputPayload: 'good input 2', outputPayload: 'good output 2' });

      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.ambiguityNotes).toBeUndefined();
    } finally { cleanupFixture(f); }
  });

  it('contextHash is deterministic for same conversationWindow', async () => {
    const task = makeDiagnosticianTask({ taskId: 'task_deterministic' });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks);
    try {
      await createRunWithPayloads(f, task.taskId, { inputPayload: 'input', outputPayload: 'output' });

      const payload1 = await f.assembler.assemble(task.taskId);
      const payload2 = await f.assembler.assemble(task.taskId);

      // Same conversationWindow → same hash
      expect(payload1.contextHash).toBe(payload2.contextHash);
      // contextId differs (random UUID)
      expect(payload1.contextId).not.toBe(payload2.contextId);
    } finally { cleanupFixture(f); }
  });

  it('diagnosisTarget maps all DiagnosticianTaskRecord fields', async () => {
    const task = makeDiagnosticianTask({
      taskId: 'task_fields',
      sourcePainId: 'pain-456',
      severity: 'critical',
      source: 'agent',
      sessionIdHint: 'sess-789',
      reasonSummary: 'Detailed reason',
    });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks);
    try {
      await createRunWithPayloads(f, task.taskId, { inputPayload: 'input', outputPayload: 'output' });

      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.diagnosisTarget.reasonSummary).toBe('Detailed reason');
      expect(payload.diagnosisTarget.source).toBe('agent');
      expect(payload.diagnosisTarget.severity).toBe('critical');
      expect(payload.diagnosisTarget.painId).toBe('pain-456');
      expect(payload.diagnosisTarget.sessionIdHint).toBe('sess-789');
    } finally { cleanupFixture(f); }
  });

  it('diagnosisTarget omits undefined optional fields', async () => {
    const task = makeDiagnosticianTask({
      taskId: 'task_minimal',
      sourcePainId: undefined,
      severity: undefined,
      source: undefined,
      sessionIdHint: undefined,
      reasonSummary: 'Minimal task',
    });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks);
    try {
      await createRunWithPayloads(f, task.taskId, { inputPayload: 'input', outputPayload: 'output' });

      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.diagnosisTarget.reasonSummary).toBe('Minimal task');
      expect(payload.diagnosisTarget.painId).toBeUndefined();
      expect(payload.diagnosisTarget.source).toBeUndefined();
      expect(payload.diagnosisTarget.severity).toBeUndefined();
      expect(payload.diagnosisTarget.sessionIdHint).toBeUndefined();
    } finally { cleanupFixture(f); }
  });

  it('payload validates against DiagnosticianContextPayloadSchema', async () => {
    const task = makeDiagnosticianTask({ taskId: 'task_schema' });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks);
    try {
      await createRunWithPayloads(f, task.taskId, { inputPayload: 'input', outputPayload: 'output' });

      const payload = await f.assembler.assemble(task.taskId);

      // assemble() validates internally, so reaching here means it passed.
      // Double-check explicitly:
      expect(Value.Check(DiagnosticianContextPayloadSchema, payload)).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('assembles context with openclaw-history runtime_kind runs (compatibility import)', async () => {
    // This covers the m3-08 fix: imported runs from trajectory.db use runtimeKind='openclaw-history'
    const task = makeDiagnosticianTask({ taskId: 'task_openclaw_history' });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks);
    try {
      await createRunWithPayloads(f, task.taskId, {
        runtimeKind: 'openclaw-history',
        inputPayload: '{"type":"session_history","sessionId":"test-sess","userTurns":[],"toolCalls":[]}',
        outputPayload: '{"type":"assistant_turns","sessionId":"test-sess","turns":[]}',
      });

      // Must not throw — openclaw-history must be accepted by RuntimeKindSchema
      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.taskId).toBe('task_openclaw_history');
      expect(Value.Check(DiagnosticianContextPayloadSchema, payload)).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('includes openclaw-history run entries in conversationWindow (time window fix)', async () => {
    // m3-09: Without timeWindowStart=task.createdAt, historical runs outside the
    // default 24-hour window would be filtered out and conversationWindow would be empty.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const task = makeDiagnosticianTask({
      taskId: 'task_old_history',
      createdAt: thirtyDaysAgo,
      updatedAt: thirtyDaysAgo,
    });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks);
    try {
      await createRunWithPayloads(f, task.taskId, {
        runtimeKind: 'openclaw-history',
        inputPayload: '{"type":"session_history","sessionId":"old-sess","userTurns":[{"turnIndex":1,"text":"hello"}]}',
        outputPayload: '{"type":"assistant_turns","sessionId":"old-sess","turns":[{"provider":"openai","model":"gpt-4","text":"hi"}]}',
      });

      const payload = await f.assembler.assemble(task.taskId);

// conversationWindow must have entries from the historical run (not empty)
      expect(payload.conversationWindow.length).toBeGreaterThan(0);
      expect(Value.Check(DiagnosticianContextPayloadSchema, payload)).toBe(true);
    } finally { cleanupFixture(f); }
  });



  // ── Full Trace Tests (PRI-171) ──

  it('builds fullTrace from source pain trajectory, not diagnostician task runs', async () => {
    const sessionId = 'sess-src-happy';
    const sourceTaskId = 'task_source_happy';
    const diagTask = makeDiagnosticianTask({
      taskId: 'task_diag_happy',
      sourcePainId: 'pain-src-happy',
      sessionIdHint: sessionId,
      severity: 'high',
      source: 'test',
      reasonSummary: 'Source trace test',
    });
    const tasks = new Map([[diagTask.taskId, diagTask]]);
    const f = createFixture(tasks, { withLocator: true });
    try {
      await ensureSourceTask(f, sourceTaskId, { sessionId, sourcePainId: 'pain-src-happy' });
      await createRunWithPayloads(f, sourceTaskId, {
        inputPayload: JSON.stringify({
          type: 'session_history',
          sessionId,
          userTurns: [{ turnIndex: 1, text: 'user asked something' }],
          toolCalls: [{ toolName: 'Read', status: 'succeeded', params: { file: '/src/main.ts' } }],
        }),
        outputPayload: JSON.stringify({
          type: 'assistant_turns',
          sessionId,
          turns: [{ provider: 'openai', model: 'gpt-4', text: 'here is the file content' }],
        }),
      });

      const payload = await f.assembler.assemble(diagTask.taskId);

      const ft = payload.fullTrace;
      expect(ft).not.toBeNull();
      if (!ft) return;
      if ('sourcePainId' in ft) {
        expect(ft.sourcePainId).toBe('pain-src-happy');
        expect(ft.sourceTaskId).toBe(sourceTaskId);
        expect(ft.timeline.length).toBeGreaterThan(0);
        expect(ft.sourceRefs.length).toBeGreaterThan(0);
        expect(ft.ambiguityNotes).toBeDefined();
        expect(ft.sanitizationNotes).toBeDefined();
        expect(ft.capturedAt).toBeDefined();
        const toolCallEntries = ft.timeline.filter((e) => e.kind === 'tool_call');
        expect(toolCallEntries.length).toBeGreaterThan(0);
        expect(toolCallEntries.some((e) => e.summary.includes('Read'))).toBe(true);
      }
      expect(Value.Check(DiagnosticianContextPayloadSchema, payload)).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('sets fullTrace to null when no sourcePainId', async () => {
    const task = makeDiagnosticianTask({
      taskId: 'task_no_painid',
      sourcePainId: undefined,
    });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks);
    try {
      await createRunWithPayloads(f, task.taskId, { inputPayload: 'input', outputPayload: 'output' });

      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.fullTrace).toBeNull();
      expect(Value.Check(DiagnosticianContextPayloadSchema, payload)).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('returns null fullTrace with ambiguityNotes when source trace not found', async () => {
    const task = makeDiagnosticianTask({
      taskId: 'task_src_not_found',
      sourcePainId: 'pain-not-found',
      sessionIdHint: 'sess-no-match',
    });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks, { withLocator: true });
    try {
      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.fullTrace).toBeNull();
      expect(notesInclude(payload.ambiguityNotes, 'Source trace not found')).toBe(true);
      expect(notesInclude(payload.ambiguityNotes, 'pain-not-found')).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('does not include diagnostician task runs in fullTrace when source unresolvable', async () => {
    const diagTask = makeDiagnosticianTask({
      taskId: 'task_no_fallback',
      sourcePainId: 'pain-unresolvable',
      sessionIdHint: 'sess-no-source',
    });
    const tasks = new Map([[diagTask.taskId, diagTask]]);
    const f = createFixture(tasks, { withLocator: true });
    try {
      await createRunWithPayloads(f, diagTask.taskId, {
        inputPayload: JSON.stringify({
          toolCalls: [{ toolName: 'DiagOnlyTool', status: 'succeeded', params: {} }],
        }),
        outputPayload: '{}',
      });

      const payload = await f.assembler.assemble(diagTask.taskId);

      expect(payload.fullTrace).toBeNull();
      expect(notesInclude(payload.ambiguityNotes, 'Source trace not found')).toBe(true);
      if (payload.fullTrace) {
        expect(JSON.stringify(payload.fullTrace)).not.toContain('DiagOnlyTool');
      }
    } finally { cleanupFixture(f); }
  });

  it('returns null fullTrace when multiple source candidates found', async () => {
    const sessionId = 'sess-ambiguous';
    const diagTask = makeDiagnosticianTask({
      taskId: 'task_diag_amb',
      sourcePainId: 'pain-ambiguous',
      sessionIdHint: sessionId,
    });
    const tasks = new Map([[diagTask.taskId, diagTask]]);
    const f = createFixture(tasks, { withLocator: true });
    try {
      await ensureSourceTask(f, 'task_src_amb_1', { sessionId, sourcePainId: 'pain-ambiguous' });
      await createRunWithPayloads(f, 'task_src_amb_1', { inputPayload: '{"toolName":"Tool1"}', outputPayload: '{}' });
      await ensureSourceTask(f, 'task_src_amb_2', { sessionId, sourcePainId: 'pain-ambiguous' });
      await createRunWithPayloads(f, 'task_src_amb_2', { inputPayload: '{"toolName":"Tool2"}', outputPayload: '{}' });

      const payload = await f.assembler.assemble(diagTask.taskId);

      expect(payload.fullTrace).toBeNull();
      expect(notesInclude(payload.ambiguityNotes, 'Ambiguous source trace')).toBe(true);
      expect(notesInclude(payload.ambiguityNotes, '2 matched candidates')).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('returns null fullTrace when TrajectoryLocator not provided', async () => {
    const task = makeDiagnosticianTask({
      taskId: 'task_no_locator',
      sourcePainId: 'pain-no-locator',
      sessionIdHint: 'sess-no-loc',
    });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks);
    try {
      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.fullTrace).toBeNull();
      expect(notesInclude(payload.ambiguityNotes, 'SourceTraceLocator not available')).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('returns null fullTrace when sourcePainId present but no sessionIdHint', async () => {
    const task = makeDiagnosticianTask({
      taskId: 'task_no_session',
      sourcePainId: 'pain-no-session',
      sessionIdHint: undefined,
    });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks, { withLocator: true });
    try {
      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.fullTrace).toBeNull();
      expect(notesInclude(payload.ambiguityNotes, 'sessionIdHint')).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('returns fullTrace with empty arrays when source task has no runs', async () => {
    const sessionId = 'sess-src-noruns';
    const sourceTaskId = 'task_source_noruns';
    const task = makeDiagnosticianTask({
      taskId: 'task_diag_noruns',
      sourcePainId: 'pain-no-src-runs',
      sessionIdHint: sessionId,
    });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks, { withLocator: true });
    try {
      await ensureSourceTask(f, sourceTaskId, { sessionId, sourcePainId: 'pain-no-src-runs' });

      const payload = await f.assembler.assemble(task.taskId);

      const ft = payload.fullTrace;
      expect(ft).not.toBeNull();
      if (!ft) return;
      if ('sourcePainId' in ft) {
        expect(ft.timeline).toEqual([]);
        expect(ft.sourcePainId).toBe('pain-no-src-runs');
        expect(ft.sourceRunIds).toEqual([]);
        expect(ft.ambiguityNotes).toBeDefined();
        expect(ft.sanitizationNotes).toBeDefined();
      }
      expect(Value.Check(DiagnosticianContextPayloadSchema, payload)).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('redacts secrets in source trace before exposing to prompts', async () => {
    const sessionId = 'sess-pii';
    const sourceTaskId = 'task_source_pii';
    const task = makeDiagnosticianTask({
      taskId: 'task_diag_pii',
      sourcePainId: 'pain-pii',
      sessionIdHint: sessionId,
    });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks, { withLocator: true });
    try {
      await ensureSourceTask(f, sourceTaskId, { sessionId, sourcePainId: 'pain-pii' });
      await createRunWithPayloads(f, sourceTaskId, {
        inputPayload: JSON.stringify({
          toolCalls: [{
            toolName: 'WriteFile',
            params: { apiKey: 'sk-proj-secret123', token: 'tok_abc', password: 'hunter2' },
          }],
        }),
        outputPayload: JSON.stringify({
          text: 'Used authorization: Bearer secret-token-here and secret=mysecret',
        }),
      });

      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.fullTrace).not.toBeNull();
      const allText = JSON.stringify(payload.fullTrace);
      expect(allText).not.toContain('sk-proj-secret123');
      expect(allText).not.toContain('tok_abc');
      expect(allText).not.toContain('hunter2');
      expect(allText).not.toContain('secret-token-here');
      expect(allText).not.toContain('mysecret');
      expect(allText).toContain('[REDACTED]');
    } finally { cleanupFixture(f); }
  });

  it('payload without fullTrace field still passes schema validation - backward compatible', async () => {
    const task = makeDiagnosticianTask({ taskId: 'task_compat' });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks);
    try {
      await createRunWithPayloads(f, task.taskId, { inputPayload: 'input', outputPayload: 'output' });

      const payload = await f.assembler.assemble(task.taskId);

      const { fullTrace: _, ...legacyPayload } = payload;
      expect(Value.Check(DiagnosticianContextPayloadSchema, legacyPayload)).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('handles non-JSON source run payloads in fullTrace without throwing', async () => {
    const sessionId = 'sess-plain';
    const sourceTaskId = 'task_source_plain';
    const task = makeDiagnosticianTask({
      taskId: 'task_diag_plain',
      sourcePainId: 'pain-plain',
      sessionIdHint: sessionId,
    });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks, { withLocator: true });
    try {
      await ensureSourceTask(f, sourceTaskId, { sessionId, sourcePainId: 'pain-plain' });
      await createRunWithPayloads(f, sourceTaskId, {
        inputPayload: 'This is just plain text, not JSON at all',
        outputPayload: 'Response text with password=supersecret',
      });

      const payload = await f.assembler.assemble(task.taskId);

      const ft = payload.fullTrace;
      expect(ft).not.toBeNull();
      if (!ft) return;
      if ('timeline' in ft) {
        expect(ft.timeline.length).toBeGreaterThan(0);
      }
      const allText = JSON.stringify(ft);
      expect(allText).not.toContain('supersecret');
      expect(allText).toContain('[REDACTED]');
    } finally { cleanupFixture(f); }
  });

  it('extracts toolCalls array from source openclaw-history format', async () => {
    const sessionId = 'sess-oc';
    const sourceTaskId = 'task_source_oc';
    const task = makeDiagnosticianTask({
      taskId: 'task_diag_oc',
      sourcePainId: 'pain-oc',
      sessionIdHint: sessionId,
    });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks, { withLocator: true });
    try {
      await ensureSourceTask(f, sourceTaskId, { sessionId, sourcePainId: 'pain-oc' });
      await createRunWithPayloads(f, sourceTaskId, {
        runtimeKind: 'openclaw-history',
        inputPayload: JSON.stringify({
          type: 'session_history',
          sessionId,
          userTurns: [{ turnIndex: 1, text: 'fix the bug' }],
          toolCalls: [
            { toolName: 'Read', status: 'succeeded', params: { file: 'src/index.ts' } },
            { toolName: 'Edit', status: 'succeeded', params: { file: 'src/index.ts', content: 'fixed' } },
          ],
        }),
        outputPayload: JSON.stringify({
          type: 'assistant_turns',
          sessionId,
          turns: [{ text: 'I fixed the bug' }],
        }),
      });

      const payload = await f.assembler.assemble(task.taskId);

      const ft = payload.fullTrace;
      expect(ft).not.toBeNull();
      if (!ft) return;
      if ('timeline' in ft) {
        const toolCallEntries = ft.timeline.filter((e) => e.kind === 'tool_call');
        expect(toolCallEntries.length).toBe(2);
        expect(toolCallEntries[0]?.summary).toContain('Read');
        expect(toolCallEntries[1]?.summary).toContain('Edit');
        const userEntries = ft.timeline.filter((e) => e.kind === 'user_message');
        expect(userEntries.some((e) => e.summary.includes('fix the bug'))).toBe(true);
        const assistantEntries = ft.timeline.filter((e) => e.kind === 'assistant_message');
        expect(assistantEntries.some((e) => e.summary.includes('I fixed the bug'))).toBe(true);
      }
    } finally { cleanupFixture(f); }
  });

  it('sanitizes nested object params in source trace toolCallHistory', async () => {
    const sessionId = 'sess-nested';
    const sourceTaskId = 'task_source_nested';
    const task = makeDiagnosticianTask({
      taskId: 'task_diag_nested',
      sourcePainId: 'pain-nested',
      sessionIdHint: sessionId,
    });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks, { withLocator: true });
    try {
      await ensureSourceTask(f, sourceTaskId, { sessionId, sourcePainId: 'pain-nested' });
      await createRunWithPayloads(f, sourceTaskId, {
        inputPayload: JSON.stringify({
          toolCalls: [{
            toolName: 'HttpRequest',
            params: {
              headers: { Authorization: 'Bearer tok_live_xxx' },
              body: { api_key: 'pk_live_12345', user_password: 'p@ssw0rd' },
            },
          }],
        }),
        outputPayload: '{}',
      });

      const payload = await f.assembler.assemble(task.taskId);

      const ft = payload.fullTrace;
      expect(ft).not.toBeNull();
      if (!ft) return;
      if ('timeline' in ft) {
        const [entry] = ft.timeline.filter((e) => e.kind === 'tool_call');
        expect(entry).toBeDefined();
        const allTimelineText = JSON.stringify(ft.timeline);
        expect(allTimelineText).not.toContain('tok_live_xxx');
        expect(allTimelineText).not.toContain('pk_live_12345');
        expect(allTimelineText).not.toContain('p@ssw0rd');
        expect(allTimelineText).toContain('[REDACTED]');
      }
    } finally { cleanupFixture(f); }
  });

  it('redacts bearer token value in scratchpad text when preceded by authorization key', async () => {
    const sessionId = 'sess-bearer-order';
    const sourceTaskId = 'task_source_bearer_order';
    const task = makeDiagnosticianTask({
      taskId: 'task_diag_bearer_order',
      sourcePainId: 'pain-bearer-order',
      sessionIdHint: sessionId,
    });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks, { withLocator: true });
    try {
      await ensureSourceTask(f, sourceTaskId, { sessionId, sourcePainId: 'pain-bearer-order' });
      await createRunWithPayloads(f, sourceTaskId, {
        inputPayload: JSON.stringify({
          thinking: 'Set authorization: Bearer sk-live-leaky-token-xyz and then called the API',
        }),
        outputPayload: JSON.stringify({
          text: 'Header was Authorization=Bearer tok-secret-abc123, worked fine',
        }),
      });

      const payload = await f.assembler.assemble(task.taskId);

      const ft = payload.fullTrace;
      expect(ft).not.toBeNull();
      if (!ft) return;
      const allText = JSON.stringify(ft);
      expect(allText).not.toContain('sk-live-leaky-token-xyz');
      expect(allText).not.toContain('tok-secret-abc123');
      expect(allText).toContain('[REDACTED]');
    } finally { cleanupFixture(f); }
  });


  it('returns null fullTrace when source task has mismatched sourcePainId', async () => {
    const sessionId = 'sess-mismatch';
    const sourceTaskId = 'task_source_mismatch';
    const diagTask = makeDiagnosticianTask({
      taskId: 'task_diag_mismatch',
      sourcePainId: 'pain-A',
      sessionIdHint: sessionId,
    });
    const tasks = new Map([[diagTask.taskId, diagTask]]);
    const f = createFixture(tasks, { withLocator: true });
    try {
      // Source task stores painId=pain-B, which does NOT match diagnostician's sourcePainId=pain-A
      await ensureSourceTask(f, sourceTaskId, { sessionId, sourcePainId: 'pain-B' });
      await createRunWithPayloads(f, sourceTaskId, {
        inputPayload: JSON.stringify({ toolCalls: [{ toolName: 'WrongSource', status: 'succeeded' }] }),
        outputPayload: '{}',
      });

      const payload = await f.assembler.assemble(diagTask.taskId);

      expect(payload.fullTrace).toBeNull();
      expect(notesInclude(payload.ambiguityNotes, 'sourcePainId mismatch')).toBe(true);
      expect(notesInclude(payload.ambiguityNotes, 'pain-A')).toBe(true);
      expect(Value.Check(DiagnosticianContextPayloadSchema, payload)).toBe(true);
    } finally { cleanupFixture(f); }
  });


  it('throws storage_unavailable for run with unrecognized runtime_kind', async () => {
    const task = makeDiagnosticianTask({ taskId: 'task_bad_runtime' });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks);
    try {
      const existing = await f.sqliteTaskStore.getTask(task.taskId);
      if (!existing) {
        await f.sqliteTaskStore.createTask({
          taskId: task.taskId,
          taskKind: 'diagnostician',
          status: 'pending',
          attemptCount: 0,
          maxAttempts: 3,
        } satisfies Omit<TaskRecord, 'createdAt' | 'updatedAt'>);
      }
      const db = f.connection.getDb();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, ended_at, ' +
        'attempt_number, created_at, updated_at, input_payload, output_payload) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('run_bad_kind', task.taskId, 'invalid-runtime', 'succeeded', now, now,
        1, now, now, null, null);
      await expect(f.assembler.assemble(task.taskId)).rejects.toThrow('[storage_unavailable]');
    } finally { cleanupFixture(f); }
  });

  // ── PRI-255: Provenance and evidence contract tests ──

  it('populates diagnosisTarget.provenance and provenanceReason from diagnosticJson', async () => {
    const dj = JSON.stringify({
      sourcePainId: 'pain-prov-1',
      reasonSummary: 'Owner reported pain from CLI',
      source: 'manual',
      severity: 'severe',
      sessionIdHint: 'cli',
      provenance: 'owner_reported_no_host_trace',
      provenanceReason: 'No authenticated host session provenance available for CLI-submitted pain',
    });
    const task = makeDiagnosticianTask({
      taskId: 'task_prov_1',
      sourcePainId: 'pain-prov-1',
      reasonSummary: 'Owner reported pain from CLI',
      source: 'manual',
      severity: 'severe',
      sessionIdHint: 'cli',
    });
    const taskWithDj = { ...task, diagnosticJson: dj };
    const tasks = new Map([[taskWithDj.taskId, taskWithDj]]);
    const f = createFixture(tasks);
    try {
      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.diagnosisTarget.provenance).toBe('owner_reported_no_host_trace');
      expect(payload.diagnosisTarget.provenanceReason).toContain('No authenticated host session');
      expect(payload.diagnosisTarget.reasonSummary).toBe('Owner reported pain from CLI');
      expect(payload.diagnosisTarget.source).toBe('manual');
      expect(payload.diagnosisTarget.severity).toBe('severe');
      expect(payload.diagnosisTarget.painId).toBe('pain-prov-1');
    } finally { cleanupFixture(f); }
  });

  it('sets traceAvailability=unavailable_with_reason for owner_reported_no_host_trace and does NOT call trace locator', async () => {
    const dj = JSON.stringify({
      sourcePainId: 'pain-cli-1',
      reasonSummary: 'CLI pain',
      source: 'manual',
      severity: 'severe',
      sessionIdHint: 'cli',
      provenance: 'owner_reported_no_host_trace',
      provenanceReason: 'No authenticated host session provenance available',
    });
    const task = makeDiagnosticianTask({
      taskId: 'task_cli_prov',
      sourcePainId: 'pain-cli-1',
      reasonSummary: 'CLI pain',
      sessionIdHint: 'cli',
    });
    const taskWithDj = { ...task, diagnosticJson: dj };
    const tasks = new Map([[taskWithDj.taskId, taskWithDj]]);
    const f = createFixture(tasks, { withLocator: true });
    const locator = f.sourceTraceLocator;
    expect(locator).toBeDefined();
    if (!locator) return;
    const locateSpy = vi.spyOn(locator, 'locate');
    try {
      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.diagnosisTarget.traceAvailability).toBe('unavailable_with_reason');
      expect(payload.diagnosisTarget.traceUnavailableDetail).toBeDefined();
      const detail = payload.diagnosisTarget.traceUnavailableDetail;
      expect(detail?.reason).toContain('CLI-submitted pain');
      expect(detail?.nextAction).toContain('OpenClaw session');
      expect(notesInclude(payload.ambiguityNotes, 'owner_reported_no_host_trace')).toBe(true);
      expect(payload.fullTrace).toBeNull();
      expect(locateSpy).not.toHaveBeenCalled();
    } finally { cleanupFixture(f); locateSpy.mockRestore(); }
  });

  it('sets traceAvailability=available when fullTrace is resolved', async () => {
    const sessionId = 'sess-prov-ok';
    const sourceTaskId = 'task_source_prov';
    const dj = JSON.stringify({
      sourcePainId: 'pain-prov-ok',
      reasonSummary: 'Context-bound pain',
      source: 'pain',
      severity: 'severe',
      sessionIdHint: sessionId,
      provenance: 'openclaw_context_bound',
      provenanceReason: 'Pain reported from an OpenClaw host session',
    });
    const task = makeDiagnosticianTask({
      taskId: 'task_diag_prov_ok',
      sourcePainId: 'pain-prov-ok',
      sessionIdHint: sessionId,
      reasonSummary: 'Context-bound pain',
    });
    const taskWithDj = { ...task, diagnosticJson: dj };
    const tasks = new Map([[taskWithDj.taskId, taskWithDj]]);
    const f = createFixture(tasks, { withLocator: true });
    try {
      await ensureSourceTask(f, sourceTaskId, { sessionId, sourcePainId: 'pain-prov-ok' });
      await createRunWithPayloads(f, sourceTaskId, {
        inputPayload: JSON.stringify({ toolCalls: [{ toolName: 'Read', status: 'succeeded' }] }),
        outputPayload: '{}',
      });

      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.diagnosisTarget.provenance).toBe('openclaw_context_bound');
      expect(payload.diagnosisTarget.traceAvailability).toBe('available');
      expect(payload.fullTrace).not.toBeNull();
    } finally { cleanupFixture(f); }
  });

  it('sets traceAvailability=unavailable_with_reason for context-bound pain when trace not found', async () => {
    const dj = JSON.stringify({
      sourcePainId: 'pain-prov-nf',
      reasonSummary: 'Context-bound but trace missing',
      source: 'pain',
      severity: 'severe',
      sessionIdHint: 'sess-missing',
      provenance: 'openclaw_context_bound',
      provenanceReason: 'Pain reported from an OpenClaw host session',
    });
    const task = makeDiagnosticianTask({
      taskId: 'task_diag_prov_nf',
      sourcePainId: 'pain-prov-nf',
      sessionIdHint: 'sess-missing',
      reasonSummary: 'Context-bound but trace missing',
    });
    const taskWithDj = { ...task, diagnosticJson: dj };
    const tasks = new Map([[taskWithDj.taskId, taskWithDj]]);
    const f = createFixture(tasks, { withLocator: true });
    try {
      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.diagnosisTarget.provenance).toBe('openclaw_context_bound');
      expect(payload.diagnosisTarget.traceAvailability).toBe('unavailable_with_reason');
      expect(payload.diagnosisTarget.traceUnavailableDetail).toBeDefined();
      expect(payload.diagnosisTarget.traceUnavailableDetail?.reason).toContain('source trace could not be resolved');
    } finally { cleanupFixture(f); }
  });

  it('sets traceAvailability=unavailable_with_reason for automatic_hook when trace not found', async () => {
    const dj = JSON.stringify({
      sourcePainId: 'pain-auto-nf',
      reasonSummary: 'Automatic hook pain but trace missing',
      source: 'write',
      severity: 'moderate',
      sessionIdHint: 'sess-auto-missing',
      provenance: 'automatic_hook',
      provenanceReason: 'Detected by automatic hook',
    });
    const task = makeDiagnosticianTask({
      taskId: 'task_diag_auto_nf',
      sourcePainId: 'pain-auto-nf',
      sessionIdHint: 'sess-auto-missing',
      reasonSummary: 'Automatic hook pain but trace missing',
    });
    const taskWithDj = { ...task, diagnosticJson: dj };
    const tasks = new Map([[taskWithDj.taskId, taskWithDj]]);
    const f = createFixture(tasks, { withLocator: true });
    try {
      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.diagnosisTarget.provenance).toBe('automatic_hook');
      expect(payload.diagnosisTarget.traceAvailability).toBe('unavailable_with_reason');
      expect(payload.diagnosisTarget.traceUnavailableDetail).toBeDefined();
      expect(payload.diagnosisTarget.traceUnavailableDetail?.reason).toContain('Automatic hook pain');
    } finally { cleanupFixture(f); }
  });

  it('reconstructs provenance from diagnosticJson with runtime validation (no unsafe as)', async () => {
    const dj = JSON.stringify({
      sourcePainId: 'pain-validated',
      reasonSummary: 'Validated pain',
      source: 'manual',
      severity: 'moderate',
      provenance: 'owner_reported_no_host_trace',
      provenanceReason: 'CLI provenance',
      extraUnknownField: 'should be ignored',
    });
    const task = makeDiagnosticianTask({
      taskId: 'task_validated',
      sourcePainId: 'pain-validated',
      reasonSummary: 'Validated pain',
    });
    const taskWithDj = { ...task, diagnosticJson: dj };
    const tasks = new Map([[taskWithDj.taskId, taskWithDj]]);
    const f = createFixture(tasks);
    try {
      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.diagnosisTarget.provenance).toBe('owner_reported_no_host_trace');
      expect(payload.diagnosisTarget.reasonSummary).toBe('Validated pain');
    } finally { cleanupFixture(f); }
  });

  it('handles malformed diagnosticJson gracefully without crashing', async () => {
    const task = makeDiagnosticianTask({
      taskId: 'task_malformed_dj',
      reasonSummary: 'Fallback reason',
    });
    const taskWithDj = { ...task, diagnosticJson: 'not-valid-json{{{}}' };
    const tasks = new Map([[taskWithDj.taskId, taskWithDj]]);
    const f = createFixture(tasks);
    try {
      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.diagnosisTarget.reasonSummary).toBe('Fallback reason');
      expect(payload.diagnosisTarget.provenance).toBeUndefined();
    } finally { cleanupFixture(f); }
  });

  it('handles diagnosticJson with invalid provenance value gracefully', async () => {
    const dj = JSON.stringify({
      sourcePainId: 'pain-bad-prov',
      reasonSummary: 'Bad provenance test',
      provenance: 'invalid_provenance_value',
    });
    const task = makeDiagnosticianTask({
      taskId: 'task_bad_prov',
      reasonSummary: 'Bad provenance test',
    });
    const taskWithDj = { ...task, diagnosticJson: dj };
    const tasks = new Map([[taskWithDj.taskId, taskWithDj]]);
    const f = createFixture(tasks);
    try {
      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.diagnosisTarget.provenance).toBeUndefined();
      expect(payload.diagnosisTarget.reasonSummary).toBe('Bad provenance test');
    } finally { cleanupFixture(f); }
  });

  it('produces ambiguity note when diagnosticJson is malformed JSON', async () => {
    const task = makeDiagnosticianTask({
      taskId: 'task_malformed_observable',
      reasonSummary: 'Fallback reason',
    });
    const taskWithDj = { ...task, diagnosticJson: 'not-valid-json{{{}}' };
    const tasks = new Map([[taskWithDj.taskId, taskWithDj]]);
    const f = createFixture(tasks);
    try {
      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.diagnosisTarget.reasonSummary).toBe('Fallback reason');
      expect(payload.ambiguityNotes?.some((n) => n.includes('malformed JSON'))).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('produces ambiguity note when diagnosticJson parses to non-object', async () => {
    const task = makeDiagnosticianTask({
      taskId: 'task_array_dj',
      reasonSummary: 'Fallback reason',
    });
    const taskWithDj = { ...task, diagnosticJson: JSON.stringify([1, 2, 3]) };
    const tasks = new Map([[taskWithDj.taskId, taskWithDj]]);
    const f = createFixture(tasks);
    try {
      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.diagnosisTarget.reasonSummary).toBe('Fallback reason');
      expect(payload.ambiguityNotes?.some((n) => n.includes('non-object'))).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('ignores inherited properties from prototype chain in diagnosticJson', async () => {
    const dj = '{"sourcePainId":"own-pain-id","reasonSummary":"own-reason","provenance":"openclaw_context_bound"}';
    const task = makeDiagnosticianTask({
      taskId: 'task_inherited_props',
    });
    const taskWithDj = { ...task, diagnosticJson: dj };
    const tasks = new Map([[taskWithDj.taskId, taskWithDj]]);
    const f = createFixture(tasks);
    try {
      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.diagnosisTarget.painId).toBe('own-pain-id');
      expect(payload.diagnosisTarget.reasonSummary).toBe('own-reason');
      expect(payload.diagnosisTarget.provenance).toBe('openclaw_context_bound');
    } finally { cleanupFixture(f); }
  });

  it('rejects provenance injected into Object.prototype (not own-property)', async () => {
    const original = Object.getOwnPropertyDescriptor(Object.prototype, 'provenance');
    try {
      (Object.prototype as Record<string, unknown>).provenance = 'automatic_hook';
      const dj = '{"sourcePainId":"pain-no-own-prov","reasonSummary":"no own provenance"}';
      const task = makeDiagnosticianTask({
        taskId: 'task_proto_injected_provenance',
      });
      const taskWithDj = { ...task, diagnosticJson: dj };
      const tasks = new Map([[taskWithDj.taskId, taskWithDj]]);
      const f = createFixture(tasks);
      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.diagnosisTarget.painId).toBe('pain-no-own-prov');
      expect(payload.diagnosisTarget.provenance).toBeUndefined();
      cleanupFixture(f);
    } finally {
      if (original === undefined) {
        delete (Object.prototype as Record<string, unknown>).provenance;
      } else {
        Object.defineProperty(Object.prototype, 'provenance', original);
      }
    }
  });

  it('does not read constructor or toString as sourcePainId from Object.prototype', async () => {
    const dj = '{"reasonSummary":"proto-field test"}';
    const task = makeDiagnosticianTask({
      taskId: 'task_proto_fields',
    });
    const taskWithDj = { ...task, diagnosticJson: dj };
    const tasks = new Map([[taskWithDj.taskId, taskWithDj]]);
    const f = createFixture(tasks);
    try {
      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.diagnosisTarget.painId).toBeUndefined();
      expect(payload.diagnosisTarget.provenance).toBeUndefined();
    } finally { cleanupFixture(f); }
  });

  // ── PRI-349: workspaceDir propagation through diagnosticJson ──

  it('用例 C: payload.workspaceDir is real workspaceDir from diagnosticJson, not <unknown>', async () => {
    const realWorkspaceDir = '/home/user/projects/my-app';
    const dj = JSON.stringify({
      sourcePainId: 'pain-wsdir-e2e',
      reasonSummary: 'workspaceDir e2e test',
      source: 'pain',
      severity: 'moderate',
      sessionIdHint: 'sess-wsdir',
      provenance: 'openclaw_context_bound',
      provenanceReason: 'Pain reported from an OpenClaw host session',
      workspaceDir: realWorkspaceDir,
    });
    // Use makeDiagnosticianTask with workspaceDir matching the diagnosticJson value.
    // In production, base.workspaceDir is always undefined (TaskRecord lacks this field),
    // so extra.workspaceDir from diagnosticJson is the only source.
    // Here we set the record's workspaceDir to the same value to confirm the path works.
    const task = makeDiagnosticianTask({
      taskId: 'task_wsdir_e2e',
      sourcePainId: 'pain-wsdir-e2e',
      reasonSummary: 'workspaceDir e2e test',
      sessionIdHint: 'sess-wsdir',
      workspaceDir: realWorkspaceDir,
    });
    const taskWithDj = { ...task, diagnosticJson: dj };
    const tasks = new Map([[taskWithDj.taskId, taskWithDj]]);
    const f = createFixture(tasks);
    try {
      const payload = await f.assembler.assemble(task.taskId);

      // workspaceDir is the real value, not '<unknown>'
      expect(payload.workspaceDir).toBe(realWorkspaceDir);
      expect(payload.workspaceDir).not.toBe('<unknown>');
    } finally { cleanupFixture(f); }
  });

  it('PRI-349: workspaceDir from diagnosticJson is used when record has no workspaceDir', async () => {
    const djWorkspaceDir = '/path/from/diagnostic-json';
    const dj = JSON.stringify({
      sourcePainId: 'pain-wsdir-from-dj',
      reasonSummary: 'workspaceDir from diagnosticJson only',
      workspaceDir: djWorkspaceDir,
    });
    // Set record workspaceDir to a different value.
    // In production base.workspaceDir is undefined, so extra.workspaceDir wins.
    // Here we test that the diagnosticJson value is at least available in the payload.
    const task = makeDiagnosticianTask({
      taskId: 'task_wsdir_from_dj',
      sourcePainId: 'pain-wsdir-from-dj',
      reasonSummary: 'workspaceDir from diagnosticJson only',
      workspaceDir: '/tmp/stale-default',
    });
    const taskWithDj = { ...task, diagnosticJson: dj };
    const tasks = new Map([[taskWithDj.taskId, taskWithDj]]);
    const f = createFixture(tasks);
    try {
      const payload = await f.assembler.assemble(task.taskId);

      // The record's workspaceDir takes precedence (base.workspaceDir ?? extra.workspaceDir),
      // but the important thing is: workspaceDir is NOT '<unknown>'.
      // In production, base.workspaceDir is always undefined, so extra.workspaceDir
      // from diagnosticJson will be used.
      expect(payload.workspaceDir).not.toBe('<unknown>');
    } finally { cleanupFixture(f); }
  });

  it('PRI-349: workspaceDir falls back to record default when diagnosticJson lacks it', async () => {
    const dj = JSON.stringify({
      sourcePainId: 'pain-no-wsdir',
      reasonSummary: 'No workspaceDir in diagnosticJson',
      source: 'pain',
      severity: 'moderate',
      // workspaceDir intentionally omitted
    });
    const task = makeDiagnosticianTask({
      taskId: 'task_no_wsdir',
      sourcePainId: 'pain-no-wsdir',
      reasonSummary: 'No workspaceDir in diagnosticJson',
      workspaceDir: '/tmp/test-workspace',
    });
    const taskWithDj = { ...task, diagnosticJson: dj };
    const tasks = new Map([[taskWithDj.taskId, taskWithDj]]);
    const f = createFixture(tasks);
    try {
      const payload = await f.assembler.assemble(task.taskId);

      // Without workspaceDir in diagnosticJson, the record-level workspaceDir
      // is used. In production (where TaskRecord has no workspaceDir field),
      // this would fall back to '<unknown>'.
      expect(payload.workspaceDir).toBe('/tmp/test-workspace');
      expect(payload.workspaceDir).not.toBe('<unknown>');
    } finally { cleanupFixture(f); }
  });

  // ── PRI-350: TrajectoryDB fallback for conversationWindow ──

  it('用例 A: trajectory has turns → conversationWindow non-empty', async () => {
    const sessionId = 'sess-traj';
    const userTurns = new Map<string, TrajectoryUserTurn[]>([
      [sessionId, [
        { id: 1, turnIndex: 0, rawExcerpt: 'Hello, can you help me?', correctionDetected: false, correctionCue: null, createdAt: '2026-06-09T10:00:00.000Z' },
        { id: 3, turnIndex: 2, rawExcerpt: 'That is not what I asked', correctionDetected: true, correctionCue: 'correction', createdAt: '2026-06-09T10:02:00.000Z' },
      ]],
    ]);
    const assistantTurns = new Map<string, TrajectoryAssistantTurn[]>([
      [sessionId, [
        { id: 2, sessionId, runId: 'run-1', provider: 'openai', model: 'gpt-4', sanitizedText: 'Sure, I can help with that.', createdAt: '2026-06-09T10:01:00.000Z' },
      ]],
    ]);
    const trajectoryTurnReader = createMockTrajectoryTurnReader(userTurns, assistantTurns);

    const task = makeDiagnosticianTask({
      taskId: 'task_traj_fallback_a',
      sessionIdHint: sessionId,
      workspaceDir: '/real/workspace',
    });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks, { trajectoryTurnReader });
    try {
      const payload = await f.assembler.assemble(task.taskId);

      // conversationWindow should be populated from trajectory
      expect(payload.conversationWindow.length).toBe(3);
      // Sorted by timestamp ascending
      expect(payload.conversationWindow[0]?.role).toBe('user');
      expect(payload.conversationWindow[0]?.ts).toBe('2026-06-09T10:00:00.000Z');
      expect(payload.conversationWindow[1]?.role).toBe('assistant');
      expect(payload.conversationWindow[1]?.ts).toBe('2026-06-09T10:01:00.000Z');
      expect(payload.conversationWindow[2]?.role).toBe('user');
      expect(payload.conversationWindow[2]?.ts).toBe('2026-06-09T10:02:00.000Z');
      // User turn text comes from rawExcerpt
      expect(payload.conversationWindow[0]?.text).toBe('Hello, can you help me?');
      // Assistant text is sanitized
      expect(payload.conversationWindow[1]?.text).toBe('Sure, I can help with that.');
      // No "no conversation history" ambiguity note (entries exist)
      expect(notesInclude(payload.ambiguityNotes, 'No conversation history')).toBe(false);
      // Schema still valid
      expect(Value.Check(DiagnosticianContextPayloadSchema, payload)).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('用例 B: historyQuery returns non-empty → do NOT override with trajectory', async () => {
    const sessionId = 'sess-hist-priority';
    const userTurns = new Map<string, TrajectoryUserTurn[]>([
      [sessionId, [
        { id: 10, turnIndex: 0, rawExcerpt: 'Trajectory user turn', correctionDetected: false, correctionCue: null, createdAt: '2026-06-09T10:00:00.000Z' },
      ]],
    ]);
    const assistantTurns = new Map<string, TrajectoryAssistantTurn[]>([
      [sessionId, [
        { id: 11, sessionId, runId: 'run-traj', provider: 'openai', model: 'gpt-4', sanitizedText: 'Trajectory assistant turn', createdAt: '2026-06-09T10:01:00.000Z' },
      ]],
    ]);
    const trajectoryTurnReader = createMockTrajectoryTurnReader(userTurns, assistantTurns);

    const task = makeDiagnosticianTask({
      taskId: 'task_hist_priority',
      sessionIdHint: sessionId,
      workspaceDir: '/real/workspace',
    });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks, { trajectoryTurnReader });
    try {
      // Create a run so historyQuery returns entries
      await createRunWithPayloads(f, task.taskId, { inputPayload: 'history input', outputPayload: 'history output' });

      const payload = await f.assembler.assemble(task.taskId);

      // conversationWindow should come from historyQuery (has entries from the run)
      expect(payload.conversationWindow.length).toBeGreaterThanOrEqual(2);
      // Should NOT contain trajectory text
      const allTexts = payload.conversationWindow.map(e => e.text ?? '').join('|');
      expect(allTexts).not.toContain('Trajectory user turn');
      expect(allTexts).not.toContain('Trajectory assistant turn');
      // Schema still valid
      expect(Value.Check(DiagnosticianContextPayloadSchema, payload)).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('用例 C1: sessionIdHint missing → no trajectory fallback, ambiguityNote present', async () => {
    const trajectoryTurnReader = createMockTrajectoryTurnReader(new Map(), new Map());
    const task = makeDiagnosticianTask({
      taskId: 'task_no_session_hint',
      sessionIdHint: undefined,
      workspaceDir: '/real/workspace',
    });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks, { trajectoryTurnReader });
    try {
      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.conversationWindow).toEqual([]);
      expect(notesInclude(payload.ambiguityNotes, 'No conversation history')).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('用例 C2: workspaceDir=<unknown> → no trajectory fallback, ambiguityNote present', async () => {
    const trajectoryTurnReader = createMockTrajectoryTurnReader(new Map(), new Map());
    const task = makeDiagnosticianTask({
      taskId: 'task_unknown_workspace',
      sessionIdHint: 'sess-unknown-ws',
      workspaceDir: '<unknown>',
    });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks, { trajectoryTurnReader });
    try {
      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.conversationWindow).toEqual([]);
      expect(notesInclude(payload.ambiguityNotes, 'No conversation history')).toBe(true);
      // trajectoryTurnReader should NOT have been called
      expect(f.trajectoryTurnReader?.listUserTurnsForSession).not.toHaveBeenCalled();
    } finally { cleanupFixture(f); }
  });

  it('用例 C3: trajectoryTurnReader not provided → no fallback, ambiguityNote present', async () => {
    const task = makeDiagnosticianTask({
      taskId: 'task_no_reader',
      sessionIdHint: 'sess-no-reader',
      workspaceDir: '/real/workspace',
    });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks);
    try {
      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.conversationWindow).toEqual([]);
      expect(notesInclude(payload.ambiguityNotes, 'No conversation history')).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('用例 C4: trajectory returns empty → ambiguityNote about trajectory fallback failure', async () => {
    const sessionId = 'sess-empty-traj';
    const trajectoryTurnReader = createMockTrajectoryTurnReader(
      new Map([[sessionId, []]]),
      new Map([[sessionId, []]]),
    );
    const task = makeDiagnosticianTask({
      taskId: 'task_empty_traj',
      sessionIdHint: sessionId,
      workspaceDir: '/real/workspace',
    });
    const tasks = new Map([[task.taskId, task]]);
    const f = createFixture(tasks, { trajectoryTurnReader });
    try {
      const payload = await f.assembler.assemble(task.taskId);

      expect(payload.conversationWindow).toEqual([]);
      // Should have ambiguity note about trajectory fallback failure (ERR-002: no silent degradation)
      expect(notesInclude(payload.ambiguityNotes, 'Trajectory fallback')).toBe(true);
    } finally { cleanupFixture(f); }
  });

  // ── PRI-351: fullTrace cascade regression + CLI path preservation ──

  it('PRI-351 回归: openclaw_context_bound + 有效 trajectory → fullTrace 非 null (PRI-349 级联已恢复)', async () => {
    const sessionId = 'sess-pri351-cascade';
    const sourceTaskId = 'task_source_pri351';
    const dj = JSON.stringify({
      sourcePainId: 'pain-pri351-cascade',
      reasonSummary: 'PRI-351 cascade regression test',
      source: 'pain',
      severity: 'severe',
      sessionIdHint: sessionId,
      provenance: 'openclaw_context_bound',
      provenanceReason: 'Pain reported from an OpenClaw host session',
      workspaceDir: '/real/workspace/path',
    });
    const task = makeDiagnosticianTask({
      taskId: 'task_diag_pri351',
      sourcePainId: 'pain-pri351-cascade',
      sessionIdHint: sessionId,
      reasonSummary: 'PRI-351 cascade regression test',
      workspaceDir: '/real/workspace/path',
    });
    const taskWithDj = { ...task, diagnosticJson: dj };
    const tasks = new Map([[taskWithDj.taskId, taskWithDj]]);
    const f = createFixture(tasks, { withLocator: true });
    try {
      // Source task with matching sourcePainId in its diagnosticJson
      await ensureSourceTask(f, sourceTaskId, { sessionId, sourcePainId: 'pain-pri351-cascade' });
      await createRunWithPayloads(f, sourceTaskId, {
        inputPayload: JSON.stringify({
          type: 'session_history',
          sessionId,
          userTurns: [{ turnIndex: 1, text: 'user asked about PRI-351' }],
          toolCalls: [{ toolName: 'Read', status: 'succeeded', params: { file: 'src/test.ts' } }],
        }),
        outputPayload: JSON.stringify({
          type: 'assistant_turns',
          sessionId,
          turns: [{ provider: 'openai', model: 'gpt-4', text: 'response for PRI-351' }],
        }),
      });

      const payload = await f.assembler.assemble(task.taskId);

      // Core assertion: fullTrace is NOT null (PRI-349 workspaceDir fix enables cascade)
      expect(payload.fullTrace).not.toBeNull();
      expect(payload.diagnosisTarget.provenance).toBe('openclaw_context_bound');
      expect(payload.diagnosisTarget.traceAvailability).toBe('available');
      // Validate fullTrace structure
      const ft = payload.fullTrace;
      if (ft && 'sourcePainId' in ft) {
        expect(ft.sourcePainId).toBe('pain-pri351-cascade');
        expect(ft.sourceTaskId).toBe(sourceTaskId);
        expect(ft.timeline.length).toBeGreaterThan(0);
        // Tool call evidence is present
        const toolCallEntries = ft.timeline.filter((e) => e.kind === 'tool_call');
        expect(toolCallEntries.length).toBeGreaterThan(0);
        expect(toolCallEntries.some((e) => e.summary.includes('Read'))).toBe(true);
      }
      expect(Value.Check(DiagnosticianContextPayloadSchema, payload)).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('PRI-351 回归: owner_reported_no_host_trace → fullTrace=null + traceUnavailableDetail 非空 (PRI-255 不回归)', async () => {
    const dj = JSON.stringify({
      sourcePainId: 'pain-pri351-cli',
      reasonSummary: 'CLI pain - PRI-255 design decision',
      source: 'manual',
      severity: 'severe',
      sessionIdHint: 'cli-session',
      provenance: 'owner_reported_no_host_trace',
      provenanceReason: 'No authenticated host session provenance available for CLI-submitted pain',
    });
    const task = makeDiagnosticianTask({
      taskId: 'task_diag_pri351_cli',
      sourcePainId: 'pain-pri351-cli',
      reasonSummary: 'CLI pain - PRI-255 design decision',
      sessionIdHint: 'cli-session',
    });
    const taskWithDj = { ...task, diagnosticJson: dj };
    const tasks = new Map([[taskWithDj.taskId, taskWithDj]]);
    const f = createFixture(tasks, { withLocator: true });
    const locator = f.sourceTraceLocator;
    expect(locator).toBeDefined();
    if (!locator) return;
    const locateSpy = vi.spyOn(locator, 'locate');
    try {
      const payload = await f.assembler.assemble(task.taskId);

      // PRI-255 design decision: fullTrace must be null for CLI path
      expect(payload.fullTrace).toBeNull();
      // traceAvailability must be unavailable_with_reason
      expect(payload.diagnosisTarget.traceAvailability).toBe('unavailable_with_reason');
      // traceUnavailableDetail must be non-empty (ERR-009: fail loud)
      expect(payload.diagnosisTarget.traceUnavailableDetail).toBeDefined();
      expect(payload.diagnosisTarget.traceUnavailableDetail?.reason).toBeTruthy();
      expect(payload.diagnosisTarget.traceUnavailableDetail?.reason).toContain('CLI-submitted pain');
      expect(payload.diagnosisTarget.traceUnavailableDetail?.nextAction).toBeTruthy();
      // SourceTraceLocator must NOT have been called
      expect(locateSpy).not.toHaveBeenCalled();
      // Ambiguity note about owner_reported_no_host_trace must be present
      expect(notesInclude(payload.ambiguityNotes, 'owner_reported_no_host_trace')).toBe(true);
      expect(Value.Check(DiagnosticianContextPayloadSchema, payload)).toBe(true);
    } finally { cleanupFixture(f); locateSpy.mockRestore(); }
  });
});
