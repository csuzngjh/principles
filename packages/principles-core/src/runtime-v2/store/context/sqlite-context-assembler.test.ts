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
import { SqliteContextAssembler } from './sqlite-context-assembler.js';
import { DiagnosticianContextPayloadSchema } from '../../context-payload.js';
import type { DiagnosticianTaskRecord } from '../../task-status.js';
import type { TaskRecord } from '../../task-status.js';
import type { RunRecord, RunExecutionStatus } from '../../runtime-protocol.js';
import type { TaskStore } from '../task/task-store.js';

// ── Mock TaskStore that returns DiagnosticianTaskRecord ──

function createMockTaskStore(tasks: Map<string, DiagnosticianTaskRecord>): TaskStore {
  return {
    createTask: vi.fn(),
    getTask: vi.fn(async (taskId: string) => tasks.get(taskId) ?? null),
    updateTask: vi.fn(),
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
  trajectoryLocator: SqliteTrajectoryLocator | undefined;
  taskStore: TaskStore;
  taskMap: Map<string, TaskRecord>;
  assembler: SqliteContextAssembler;
}

function createFixture(tasks?: Map<string, DiagnosticianTaskRecord>, options?: { withLocator?: boolean }): TestFixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-context-assembler-test-'));
  const connection = new SqliteConnection(tmpDir);
  const sqliteTaskStore = new SqliteTaskStore(connection);
  const runStore = new SqliteRunStore(connection);
  const historyQuery = new SqliteHistoryQuery(connection);
  const taskMap = tasks ?? new Map();
  const taskStore = createMockTaskStore(taskMap);
  const trajectoryLocator = options?.withLocator ? new SqliteTrajectoryLocator(connection) : undefined;
  const assembler = new SqliteContextAssembler(taskStore, historyQuery, runStore, { trajectoryLocator });
  return { tmpDir, connection, sqliteTaskStore, runStore, historyQuery, trajectoryLocator, taskStore, taskMap, assembler };
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
      expect(ft.painContext.painId).toBe('pain-src-happy');
      expect(ft.painContext.severity).toBe('high');
      expect(ft.scratchpad.length).toBeGreaterThan(0);
      expect(ft.toolCallHistory.length).toBeGreaterThan(0);
      expect(ft.toolCallHistory[0]?.toolName).toBe('Read');
      expect(ft.toolCallHistory[0]?.status).toBe('succeeded');
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
      expect(notesInclude(payload.ambiguityNotes, 'TrajectoryLocator not available')).toBe(true);
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
      expect(notesInclude(payload.ambiguityNotes, 'No sessionIdHint')).toBe(true);
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
      expect(ft.scratchpad).toEqual([]);
      expect(ft.toolCallHistory).toEqual([]);
      expect(ft.painContext.painId).toBe('pain-no-src-runs');
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
      expect(ft.scratchpad.length).toBeGreaterThan(0);
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
      expect(ft.toolCallHistory.length).toBe(2);
      expect(ft.toolCallHistory[0]?.toolName).toBe('Read');
      expect(ft.toolCallHistory[1]?.toolName).toBe('Edit');
      expect(ft.scratchpad).toContain('fix the bug');
      expect(ft.scratchpad).toContain('I fixed the bug');
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
      const params = ft.toolCallHistory[0]?.params;
      expect(params).toBeDefined();
      if (!params) return;
      expect(params).not.toContain('tok_live_xxx');
      expect(params).not.toContain('pk_live_12345');
      expect(params).not.toContain('p@ssw0rd');
      expect(params).toContain('[REDACTED]');
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
});
