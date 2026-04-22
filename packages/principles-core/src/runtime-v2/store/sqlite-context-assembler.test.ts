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
import { SqliteConnection } from './sqlite-connection.js';
import { SqliteTaskStore } from './sqlite-task-store.js';
import { SqliteRunStore } from './sqlite-run-store.js';
import { SqliteHistoryQuery } from './sqlite-history-query.js';
import { SqliteContextAssembler } from './sqlite-context-assembler.js';
import { DiagnosticianContextPayloadSchema } from '../context-payload.js';
import type { DiagnosticianTaskRecord } from '../task-status.js';
import type { TaskRecord } from '../task-status.js';
import type { RunRecord, RunExecutionStatus } from '../runtime-protocol.js';
import type { TaskStore } from './task-store.js';

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
  taskStore: TaskStore;
  assembler: SqliteContextAssembler;
}

function createFixture(tasks?: Map<string, DiagnosticianTaskRecord>): TestFixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-context-assembler-test-'));
  const connection = new SqliteConnection(tmpDir);
  const sqliteTaskStore = new SqliteTaskStore(connection);
  const runStore = new SqliteRunStore(connection);
  const historyQuery = new SqliteHistoryQuery(connection);
  const taskMap = tasks ?? new Map();
  const taskStore = createMockTaskStore(taskMap);
  const assembler = new SqliteContextAssembler(taskStore, historyQuery, runStore);
  return { tmpDir, connection, sqliteTaskStore, runStore, historyQuery, taskStore, assembler };
}

function cleanupFixture(fixture: TestFixture): void {
  fixture.connection.close();
  fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
}

/** Options for creating a run with payloads. */
interface RunPayloadOptions {
  inputPayload?: string;
  outputPayload?: string;
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
    runtimeKind: 'openclaw',
    inputPayload: options?.inputPayload,
    outputPayload: options?.outputPayload,
  } satisfies Omit<RunRecord, never>);
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
});
