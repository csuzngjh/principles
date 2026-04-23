/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * SqliteHistoryQuery comprehensive test suite.
 *
 * Tests cursor pagination, time windows, entry mapping, page size
 * enforcement, error handling for malformed cursors, and schema validation.
 *
 * Uses createFixture() factory pattern (no let+beforeEach) to satisfy
 * no-non-null-assertion lint rule.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Value } from '@sinclair/typebox/value';
import { SqliteConnection } from './sqlite-connection.js';
import { SqliteTaskStore } from './sqlite-task-store.js';
import { SqliteRunStore } from './sqlite-run-store.js';
import { SqliteHistoryQuery } from './sqlite-history-query.js';
import type { HistoryQueryOptions } from './history-query.js';
import { HistoryQueryResultSchema } from '../context-payload.js';
import type { RunRecord, RunExecutionStatus } from '../runtime-protocol.js';

function makeTaskInput(taskId: string) {
  return {
    taskId,
    taskKind: 'diagnostician' as const,
    status: 'pending' as const,
    attemptCount: 0,
    maxAttempts: 3,
  };
}

interface RunOverrides {
  startedAt?: string;
  endedAt?: string;
  inputPayload?: string;
  outputPayload?: string;
  executionStatus?: RunExecutionStatus;
}

function makeRunInput(
  taskId: string,
  attemptNumber = 1,
  overrides?: RunOverrides,
): Omit<RunRecord, never> {
  const startedAt = overrides?.startedAt ?? new Date().toISOString();
  return {
    runId: `run_${taskId}_${attemptNumber}`,
    taskId,
    runtimeKind: 'openclaw' as const,
    executionStatus: overrides?.executionStatus ?? ('succeeded'),
    startedAt,
    endedAt: overrides?.endedAt,
    attemptNumber,
    createdAt: startedAt,
    updatedAt: startedAt,
    inputPayload: overrides?.inputPayload,
    outputPayload: overrides?.outputPayload,
  };
}

interface TestFixture {
  tmpDir: string;
  connection: SqliteConnection;
  taskStore: SqliteTaskStore;
  runStore: SqliteRunStore;
  historyQuery: SqliteHistoryQuery;
}

function createFixture(): TestFixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-history-query-test-'));
  const connection = new SqliteConnection(tmpDir);
  return {
    tmpDir,
    connection,
    taskStore: new SqliteTaskStore(connection),
    runStore: new SqliteRunStore(connection),
    historyQuery: new SqliteHistoryQuery(connection),
  };
}

function cleanupFixture(fixture: TestFixture): void {
  fixture.connection.close();
  fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
}

describe('SqliteHistoryQuery', () => {

  describe('basic query', () => {
    it('returns empty entries when no runs exist for taskId', async () => {
      const f = createFixture();
      try {
        await f.taskStore.createTask(makeTaskInput('task_1'));
        const result = await f.historyQuery.query('task_1');
        expect(result.entries).toEqual([]);
        expect(result.truncated).toBe(false);
        expect(result.nextCursor).toBeUndefined();
        expect(result.sourceRef).toBe('task_1');
      } finally { cleanupFixture(f); }
    });

    it('returns 2 entries per run (system + assistant)', async () => {
      const f = createFixture();
      try {
        await f.taskStore.createTask(makeTaskInput('task_1'));
        await f.runStore.createRun(makeRunInput('task_1', 1, {
          inputPayload: 'diagnose pain-001',
          outputPayload: 'found issue in auth',
        }));
        const result = await f.historyQuery.query('task_1');
        expect(result.entries).toHaveLength(2);
        expect(result.entries[0]!.role).toBe('system');
        expect(result.entries[0]!.text).toBe('diagnose pain-001');
        expect(result.entries[1]!.role).toBe('assistant');
        expect(result.entries[1]!.text).toBe('found issue in auth');
      } finally { cleanupFixture(f); }
    });

    it('orders entries by started_at DESC (newest first)', async () => {
      const f = createFixture();
      try {
        await f.taskStore.createTask(makeTaskInput('task_1'));
        await f.runStore.createRun(makeRunInput('task_1', 1, {
          startedAt: '2026-04-20T10:00:00.000Z',
        }));
        await f.runStore.createRun(makeRunInput('task_1', 2, {
          startedAt: '2026-04-22T10:00:00.000Z',
        }));
        const result = await f.historyQuery.query('task_1', undefined, {
          timeWindowStart: '2026-04-19T00:00:00.000Z',
          timeWindowEnd: '2026-04-23T00:00:00.000Z',
        });
        // 4 entries total (2 per run), newest run's entries first
        expect(result.entries).toHaveLength(4);
        expect(result.entries[0]!.ts).toBe('2026-04-22T10:00:00.000Z');
      } finally { cleanupFixture(f); }
    });
  });

  describe('entry mapping', () => {
    it('maps system entry with ts=startedAt, text=inputPayload', async () => {
      const f = createFixture();
      try {
        const now = new Date();
        const startedAt = new Date(now.getTime() - 60_000).toISOString(); // 1 min ago
        await f.taskStore.createTask(makeTaskInput('task_1'));
        await f.runStore.createRun(makeRunInput('task_1', 1, {
          startedAt,
          inputPayload: 'analyze code quality',
        }));
        const result = await f.historyQuery.query('task_1');
        expect(result.entries.length).toBeGreaterThanOrEqual(1);
        const systemEntry = result.entries.find(e => e.role === 'system');
        expect(systemEntry).toBeDefined();
        expect(systemEntry!.role).toBe('system');
        expect(systemEntry!.ts).toBe(startedAt);
        expect(systemEntry!.text).toBe('analyze code quality');
      } finally { cleanupFixture(f); }
    });

    it('maps assistant entry with ts=endedAt (or startedAt fallback), text=outputPayload', async () => {
      const f = createFixture();
      try {
        const now = new Date();
        const startedAt = new Date(now.getTime() - 120_000).toISOString(); // 2 min ago
        const endedAt = new Date(now.getTime() - 60_000).toISOString(); // 1 min ago
        await f.taskStore.createTask(makeTaskInput('task_1'));

        // Run WITH endedAt
        await f.runStore.createRun(makeRunInput('task_1', 1, {
          startedAt,
          endedAt,
          outputPayload: 'analysis complete',
        }));
        const resultWithEnd = await f.historyQuery.query('task_1');
        expect(resultWithEnd.entries.length).toBeGreaterThanOrEqual(2);
        const assistantEntry = resultWithEnd.entries.find(e => e.role === 'assistant');
        expect(assistantEntry).toBeDefined();
        expect(assistantEntry!.role).toBe('assistant');
        expect(assistantEntry!.ts).toBe(endedAt);
        expect(assistantEntry!.text).toBe('analysis complete');
      } finally { cleanupFixture(f); }

      // Run WITHOUT endedAt — assistant entry uses startedAt
      const f2 = createFixture();
      try {
        const now2 = new Date();
        const startedAt2 = new Date(now2.getTime() - 180_000).toISOString(); // 3 min ago
        await f2.taskStore.createTask(makeTaskInput('task_2'));
        await f2.runStore.createRun(makeRunInput('task_2', 1, {
          startedAt: startedAt2,
          outputPayload: 'no end time',
        }));
        const resultNoEnd = await f2.historyQuery.query('task_2');
        expect(resultNoEnd.entries.length).toBeGreaterThanOrEqual(2);
        const assistantEntryNoEnd = resultNoEnd.entries.find(e => e.role === 'assistant');
        expect(assistantEntryNoEnd).toBeDefined();
        expect(assistantEntryNoEnd!.ts).toBe(startedAt2);
      } finally { cleanupFixture(f2); }
    });

    it('produces entry with text=undefined for null/empty payloads', async () => {
      const f = createFixture();
      try {
        const now = new Date();
        const startedAt = new Date(now.getTime() - 240_000).toISOString(); // 4 min ago
        await f.taskStore.createTask(makeTaskInput('task_1'));
        // Create run with no inputPayload/outputPayload
        await f.runStore.createRun(makeRunInput('task_1', 1, {
          startedAt,
        }));
        const result = await f.historyQuery.query('task_1');
        expect(result.entries.length).toBeGreaterThanOrEqual(2);
        // System entry: text should be undefined (not omitted)
        expect(result.entries[0]!.text).toBeUndefined();
        // Assistant entry: text should be undefined (not omitted)
        expect(result.entries[1]!.text).toBeUndefined();
      } finally { cleanupFixture(f); }
    });
  });

  describe('page size', () => {
    it('returns all entries when count is within limit', async () => {
      const f = createFixture();
      try {
        await f.taskStore.createTask(makeTaskInput('task_1'));
        // Create 3 runs = 6 entries, with explicit time window
        for (let i = 1; i <= 3; i++) {
          await f.runStore.createRun(makeRunInput('task_1', i, {
            startedAt: `2026-04-22T${10 + i}:00:00.000Z`,
          }));
        }
        const result = await f.historyQuery.query('task_1', undefined, {
          limit: 10,
          timeWindowStart: '2026-04-22T00:00:00.000Z',
          timeWindowEnd: '2026-04-23T00:00:00.000Z',
        });
        expect(result.entries).toHaveLength(6);
        expect(result.truncated).toBe(false);
      } finally { cleanupFixture(f); }
    });

    it('respects custom limit option', async () => {
      const f = createFixture();
      try {
        await f.taskStore.createTask(makeTaskInput('task_1'));
        // Create 5 runs = 10 entries
        for (let i = 1; i <= 5; i++) {
          await f.runStore.createRun(makeRunInput('task_1', i, {
            startedAt: `2026-04-22T${10 + i}:00:00.000Z`,
          }));
        }
        // limit=4 entries => effectively 2 runs (4 entries)
        const result = await f.historyQuery.query('task_1', undefined, {
          limit: 4,
          timeWindowStart: '2026-04-22T00:00:00.000Z',
          timeWindowEnd: '2026-04-23T00:00:00.000Z',
        });
        expect(result.entries).toHaveLength(4);
        expect(result.truncated).toBe(true);
        expect(result.nextCursor).toBeDefined();
      } finally { cleanupFixture(f); }
    });

    it('clamps limit to MAX_HISTORY_PAGE_SIZE (200)', async () => {
      const f = createFixture();
      try {
        await f.taskStore.createTask(makeTaskInput('task_1'));
        // Create 3 runs = 6 entries, request limit=500
        for (let i = 1; i <= 3; i++) {
          await f.runStore.createRun(makeRunInput('task_1', i, {
            startedAt: `2026-04-22T${10 + i}:00:00.000Z`,
          }));
        }
        const result = await f.historyQuery.query('task_1', undefined, {
          limit: 500,
          timeWindowStart: '2026-04-22T00:00:00.000Z',
          timeWindowEnd: '2026-04-23T00:00:00.000Z',
        });
        // Only 6 entries exist, limit is clamped to 200, so all fit
        expect(result.entries).toHaveLength(6);
        expect(result.truncated).toBe(false);
      } finally { cleanupFixture(f); }
    });
  });

  describe('time window', () => {
    it('filters runs by started_at within time window', async () => {
      const f = createFixture();
      try {
        await f.taskStore.createTask(makeTaskInput('task_1'));
        const now = new Date('2026-04-22T12:00:00.000Z');
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
        const twentyFiveHoursAgo = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
        const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

        await f.runStore.createRun(makeRunInput('task_1', 1, {
          startedAt: oneHourAgo,
        }));
        await f.runStore.createRun(makeRunInput('task_1', 2, {
          startedAt: twentyFiveHoursAgo,
        }));
        await f.runStore.createRun(makeRunInput('task_1', 3, {
          startedAt: fortyEightHoursAgo,
        }));

        // Default 24h window from "now" — only t-1h should appear
        const result = await f.historyQuery.query('task_1', undefined, {
          timeWindowStart: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
          timeWindowEnd: now.toISOString(),
        });
        // Only the t-1h run should be within the 24h window
        expect(result.entries).toHaveLength(2); // 1 run = 2 entries
        expect(result.entries[0]!.ts).toBe(oneHourAgo);
      } finally { cleanupFixture(f); }
    });

    it('respects custom timeWindowStart and timeWindowEnd', async () => {
      const f = createFixture();
      try {
        await f.taskStore.createTask(makeTaskInput('task_1'));
        await f.runStore.createRun(makeRunInput('task_1', 1, {
          startedAt: '2026-04-20T10:00:00.000Z',
        }));
        await f.runStore.createRun(makeRunInput('task_1', 2, {
          startedAt: '2026-04-21T10:00:00.000Z',
        }));
        await f.runStore.createRun(makeRunInput('task_1', 3, {
          startedAt: '2026-04-22T10:00:00.000Z',
        }));

        // Custom window: only Apr 21
        const result = await f.historyQuery.query('task_1', undefined, {
          timeWindowStart: '2026-04-21T00:00:00.000Z',
          timeWindowEnd: '2026-04-21T23:59:59.999Z',
        });
        expect(result.entries).toHaveLength(2); // 1 run = 2 entries
        expect(result.entries[0]!.ts).toBe('2026-04-21T10:00:00.000Z');
      } finally { cleanupFixture(f); }
    });
  });

  describe('cursor pagination', () => {
    it('returns nextCursor when truncated=true', async () => {
      const f = createFixture();
      try {
        await f.taskStore.createTask(makeTaskInput('task_1'));
        // Create 4 runs = 8 entries
        for (let i = 1; i <= 4; i++) {
          await f.runStore.createRun(makeRunInput('task_1', i, {
            startedAt: `2026-04-22T${10 + i}:00:00.000Z`,
          }));
        }
        // limit=4 entries => 2 runs, truncated because 8 > 4
        const result = await f.historyQuery.query('task_1', undefined, {
          limit: 4,
          timeWindowStart: '2026-04-22T00:00:00.000Z',
          timeWindowEnd: '2026-04-23T00:00:00.000Z',
        });
        expect(result.truncated).toBe(true);
        expect(result.nextCursor).toBeDefined();
        // Verify it's valid base64 JSON
        const decoded = JSON.parse(
          Buffer.from(result.nextCursor as string, 'base64').toString('utf-8'),
        );
        expect(decoded.taskId).toBe('task_1');
        expect(decoded.lastRunId).toBeDefined();
        expect(decoded.direction).toBe('forward');
      } finally { cleanupFixture(f); }
    });

    it('second page starts after first page cursor position', async () => {
      const f = createFixture();
      try {
        await f.taskStore.createTask(makeTaskInput('task_1'));
        // Create 6 runs = 12 entries
        for (let i = 1; i <= 6; i++) {
          await f.runStore.createRun(makeRunInput('task_1', i, {
            startedAt: `2026-04-22T${10 + i}:00:00.000Z`,
          }));
        }

        const opts: HistoryQueryOptions = {
          limit: 4,
          timeWindowStart: '2026-04-22T00:00:00.000Z',
          timeWindowEnd: '2026-04-23T00:00:00.000Z',
        };

        // Page 1
        const page1 = await f.historyQuery.query('task_1', undefined, opts);
        expect(page1.entries).toHaveLength(4);
        expect(page1.truncated).toBe(true);
        expect(page1.nextCursor).toBeDefined();

        // Page 2
        const page2 = await f.historyQuery.query('task_1', page1.nextCursor, opts);
        expect(page2.entries).toHaveLength(4);
        expect(page2.truncated).toBe(true);

        // No overlap: page1 entries should all be newer than page2 entries
        const page1NewestTs = page1.entries[0]!.ts;
        const page2OldestTs = page2.entries[page2.entries.length - 1]!.ts;
        expect(page1NewestTs >= page2OldestTs).toBe(true);

        // The last entry of page1 should be different from first entry of page2
        const page1LastTs = page1.entries[page1.entries.length - 1]!.ts;
        const page1LastRole = page1.entries[page1.entries.length - 1]!.role;
        const page2FirstTs = page2.entries[0]!.ts;
        const page2FirstRole = page2.entries[0]!.role;
        // Different entries (either different timestamp or different role)
        const sameEntry = page1LastTs === page2FirstTs && page1LastRole === page2FirstRole;
        expect(sameEntry).toBe(false);

        // Page 3
        const page3 = await f.historyQuery.query('task_1', page2.nextCursor, opts);
        expect(page3.entries).toHaveLength(4);
        expect(page3.truncated).toBe(false);
        expect(page3.nextCursor).toBeUndefined();
      } finally { cleanupFixture(f); }
    });

    it('no nextCursor when truncated=false (last page)', async () => {
      const f = createFixture();
      try {
        await f.taskStore.createTask(makeTaskInput('task_1'));
        // Create 2 runs = 4 entries, limit=10
        await f.runStore.createRun(makeRunInput('task_1', 1, {
          startedAt: '2026-04-22T10:00:00.000Z',
        }));
        await f.runStore.createRun(makeRunInput('task_1', 2, {
          startedAt: '2026-04-22T11:00:00.000Z',
        }));
        const result = await f.historyQuery.query('task_1', undefined, {
          limit: 10,
          timeWindowStart: '2026-04-22T00:00:00.000Z',
          timeWindowEnd: '2026-04-23T00:00:00.000Z',
        });
        expect(result.entries).toHaveLength(4);
        expect(result.truncated).toBe(false);
        expect(result.nextCursor).toBeUndefined();
      } finally { cleanupFixture(f); }
    });

    it('throws PDRuntimeError(input_invalid) for malformed cursor', async () => {
      const f = createFixture();
      try {
        await f.taskStore.createTask(makeTaskInput('task_1'));
        await expect(
          f.historyQuery.query('task_1', 'not-valid-base64!!'),
        ).rejects.toThrow('[input_invalid]');
      } finally { cleanupFixture(f); }
    });

    it('throws PDRuntimeError(input_invalid) for cursor with wrong taskId', async () => {
      const f = createFixture();
      try {
        await f.taskStore.createTask(makeTaskInput('task_1'));
        await f.taskStore.createTask(makeTaskInput('task_2'));
        // Create 3 runs so limit=1 produces truncation
        for (let i = 1; i <= 3; i++) {
          await f.runStore.createRun(makeRunInput('task_1', i, {
            startedAt: `2026-04-22T${10 + i}:00:00.000Z`,
          }));
        }

        // Get a cursor for task_1
        const result = await f.historyQuery.query('task_1', undefined, {
          limit: 1,
          timeWindowStart: '2026-04-22T00:00:00.000Z',
          timeWindowEnd: '2026-04-23T00:00:00.000Z',
        });
        const cursor = result.nextCursor;
        expect(cursor).toBeDefined();

        // Use cursor for task_2 — should throw
        await expect(
          f.historyQuery.query('task_2', cursor),
        ).rejects.toThrow('[input_invalid]');
      } finally { cleanupFixture(f); }
    });

    it('throws PDRuntimeError(input_invalid) for cursor referencing deleted run', async () => {
      const f = createFixture();
      try {
        await f.taskStore.createTask(makeTaskInput('task_1'));
        // Create 4 runs so limit=2 produces truncation
        for (let i = 1; i <= 4; i++) {
          await f.runStore.createRun(makeRunInput('task_1', i, {
            startedAt: `2026-04-22T${10 + i}:00:00.000Z`,
          }));
        }

        // Get a cursor that references the last run of page 1
        const result = await f.historyQuery.query('task_1', undefined, {
          limit: 2,
          timeWindowStart: '2026-04-22T00:00:00.000Z',
          timeWindowEnd: '2026-04-23T00:00:00.000Z',
        });
        const cursor = result.nextCursor;
        expect(cursor).toBeDefined();

        // Decode cursor to find the referenced run
        const cursorData = JSON.parse(
          Buffer.from(cursor as string, 'base64').toString('utf-8'),
        );

        // Delete the referenced run
        await f.runStore.deleteRun(cursorData.lastRunId);

        // Use cursor — should throw because referenced run is gone
        await expect(
          f.historyQuery.query('task_1', cursor),
        ).rejects.toThrow('[input_invalid]');
      } finally { cleanupFixture(f); }
    });
  });

  describe('schema validation', () => {
    it('result validates against HistoryQueryResultSchema', async () => {
      const f = createFixture();
      try {
        await f.taskStore.createTask(makeTaskInput('task_1'));
        await f.runStore.createRun(makeRunInput('task_1', 1, {
          startedAt: '2026-04-22T10:00:00.000Z',
          inputPayload: 'test input',
          outputPayload: 'test output',
        }));
        const result = await f.historyQuery.query('task_1');
        // Verify result passes TypeBox schema validation
        expect(Value.Check(HistoryQueryResultSchema, result)).toBe(true);
      } finally { cleanupFixture(f); }
    });

    it('sourceRef equals the trajectoryRef passed in', async () => {
      const f = createFixture();
      try {
        await f.taskStore.createTask(makeTaskInput('my_task_42'));
        const result = await f.historyQuery.query('my_task_42');
        expect(result.sourceRef).toBe('my_task_42');
      } finally { cleanupFixture(f); }
    });

    it('pretty-prints JSON object payloads and passes plain strings through unchanged', async () => {
      const f = createFixture();
      try {
        await f.taskStore.createTask(makeTaskInput('task_json_payload'));
        await f.runStore.createRun(makeRunInput('task_json_payload', 1, {
          inputPayload: '{"diagnosing":"pain-001","principleId":"P-42"}',
          outputPayload: 'plain text response',
        }));
        const result = await f.historyQuery.query('task_json_payload');
        const {entries} = result;
        // JSON input should be pretty-printed (2-space indent)
        expect(entries[0]!.text).toBe('{\n  "diagnosing": "pain-001",\n  "principleId": "P-42"\n}');
        // Plain string output should be unchanged
        expect(entries[1]!.text).toBe('plain text response');
      } finally { cleanupFixture(f); }
    });
  });
});
