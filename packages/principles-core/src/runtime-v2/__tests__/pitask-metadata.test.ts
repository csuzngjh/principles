/**
 * PITaskMetadata — Persistence & Hydration Tests (PRI-65)
 *
 * RED phase: tests define the expected contract for serializing PITaskMetadata
 * into diagnosticJson and hydrating it back into PITaskRecord at runtime.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { TaskRecord } from '../task-status.js';
import type { PITaskRecord, InternalizationChannel, ArtifactRef } from '../internalization/index.js';
import {
  serializePITaskMetadata,
  parsePITaskMetadata,
  hydratePITaskRecord,
  createPITaskDiagnosticJson,
  PI_METADATA_KEY,
} from '../internalization/pitask-metadata.js';
import { isValidPITaskRecord } from '../internalization/index.js';
import { SqliteTaskStore } from '../store/task/sqlite-task-store.js';
import { SqliteConnection } from '../store/sqlite-connection.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pitask-metadata-test-${process.pid}-`));
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    // Report but don't throw — cleanup failure shouldn't fail the test
    console.error('[pitask-metadata.test] cleanupDir failed:', dir, err);
  }
}

function makeBaseTaskRecord(overrides: Partial<TaskRecord> & { taskId: string }): TaskRecord {
  return {
    taskKind: overrides.taskKind ?? 'dreamer',
    status: overrides.status ?? 'pending',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    attemptCount: 0,
    maxAttempts: 3,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    lastError: undefined,
    inputRef: undefined,
    resultRef: undefined,
    ...overrides,
  };
}

import type { PITaskMetadata } from '../internalization/pitask-metadata.js';

function makeMetadata(overrides?: Partial<PITaskMetadata>) {
  return {
    dependencyTaskIds: overrides?.dependencyTaskIds ?? [],
    channel: overrides?.channel ?? ('prompt'),
    timeoutMs: overrides?.timeoutMs ?? 300000,
    inputArtifactRefs: overrides?.inputArtifactRefs ?? ([] as ArtifactRef[]),
    outputArtifactRefs: overrides?.outputArtifactRefs ?? ([] as ArtifactRef[]),
    parentTaskId: overrides?.parentTaskId,
    correlationId: overrides?.correlationId,
    rejectionCount: overrides?.rejectionCount,
  };
}

describe('PITaskMetadata serialization', () => {
  it('serializePITaskMetadata produces valid JSON with pi_metadata envelope', () => {
    const meta = makeMetadata({ channel: 'prompt', timeoutMs: 60000 });
    const json = serializePITaskMetadata(meta);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveProperty(PI_METADATA_KEY);
    expect(parsed[PI_METADATA_KEY]).toEqual(meta);
  });

  it('serializePITaskMetadata includes all required fields', () => {
    const meta = makeMetadata({ channel: 'skill', timeoutMs: 120000 });
    const json = serializePITaskMetadata(meta);
    const parsed = JSON.parse(json)[PI_METADATA_KEY];
    expect(parsed.dependencyTaskIds).toEqual([]);
    expect(parsed.channel).toBe('skill');
    expect(parsed.timeoutMs).toBe(120000);
    expect(parsed.inputArtifactRefs).toEqual([]);
    expect(parsed.outputArtifactRefs).toEqual([]);
  });

  it('serializePITaskMetadata includes optional fields when provided', () => {
    const meta = makeMetadata({
      parentTaskId: 'parent-1',
      correlationId: 'corr-abc',
    });
    const json = serializePITaskMetadata(meta);
    const parsed = JSON.parse(json)[PI_METADATA_KEY];
    expect(parsed.parentTaskId).toBe('parent-1');
    expect(parsed.correlationId).toBe('corr-abc');
  });

  it('createPITaskDiagnosticJson is alias for serializePITaskMetadata', () => {
    const meta = makeMetadata({ channel: 'code_tool_hook' });
    expect(createPITaskDiagnosticJson(meta)).toBe(serializePITaskMetadata(meta));
  });
});

describe('parsePITaskMetadata', () => {
  it('valid JSON with all required fields → returns PITaskMetadata', () => {
    const meta = makeMetadata({ channel: 'code_tool_hook', timeoutMs: 900000 });
    const json = serializePITaskMetadata(meta);
    const result = parsePITaskMetadata(json);
    expect(result).not.toBeNull();
    if (result === null) return; // exhaustive guard
    expect(result.channel).toBe('code_tool_hook');
    expect(result.timeoutMs).toBe(900000);
    expect(result.dependencyTaskIds).toEqual([]);
    expect(result.inputArtifactRefs).toEqual([]);
    expect(result.outputArtifactRefs).toEqual([]);
  });

  it('invalid JSON → returns null', () => {
    expect(parsePITaskMetadata('not json at all')).toBeNull();
    expect(parsePITaskMetadata('{ "pi_metadata": invalid }')).toBeNull();
    expect(parsePITaskMetadata('')).toBeNull();
  });

  it('missing pi_metadata key → returns null', () => {
    expect(parsePITaskMetadata('{}')).toBeNull();
    expect(parsePITaskMetadata('{"other": "data"}')).toBeNull();
  });

  it('JSON.parse result is not an object (null/number/string/array) → returns null', () => {
    expect(parsePITaskMetadata('null')).toBeNull();
    expect(parsePITaskMetadata('123')).toBeNull();
    expect(parsePITaskMetadata('"foo"')).toBeNull();
    expect(parsePITaskMetadata('[]')).toBeNull();
    // pi_metadata present but top-level value is array (not object)
    expect(parsePITaskMetadata('{"pi_metadata": []}')).toBeNull();
  });

  it('dependencyTaskIds with non-string elements → returns null', () => {
    const meta = {
      pi_metadata: { ...makeMetadata({ channel: 'prompt' }), dependencyTaskIds: ['dep-1', 123, null] },
    };
    expect(parsePITaskMetadata(JSON.stringify(meta))).toBeNull();
  });

  it('invalid channel → returns null', () => {
    const meta = { pi_metadata: { ...makeMetadata(), channel: 'invalid_channel' as InternalizationChannel } };
    expect(parsePITaskMetadata(JSON.stringify(meta))).toBeNull();
  });

  it('missing required fields → returns null', () => {
    const meta = { pi_metadata: { channel: 'prompt' } }; // missing timeoutMs, arrays
    expect(parsePITaskMetadata(JSON.stringify(meta))).toBeNull();
  });

  it('parentTaskId explicitly null → returns null (fail closed)', () => {
    const meta = { pi_metadata: { ...makeMetadata({ channel: 'prompt' }), parentTaskId: null as unknown as string } };
    expect(parsePITaskMetadata(JSON.stringify(meta))).toBeNull();
  });

  it('correlationId explicitly null → returns null (fail closed)', () => {
    const meta = { pi_metadata: { ...makeMetadata({ channel: 'defer_archive' }), correlationId: null as unknown as string } };
    expect(parsePITaskMetadata(JSON.stringify(meta))).toBeNull();
  });

  it('timeoutMs is 0, negative, NaN, or Infinity → returns null', () => {
    const validMeta = makeMetadata({ channel: 'prompt' });
    expect(parsePITaskMetadata(JSON.stringify({ pi_metadata: { ...validMeta, timeoutMs: 0 } }))).toBeNull();
    expect(parsePITaskMetadata(JSON.stringify({ pi_metadata: { ...validMeta, timeoutMs: -1 } }))).toBeNull();
    expect(parsePITaskMetadata(JSON.stringify({ pi_metadata: { ...validMeta, timeoutMs: NaN } }))).toBeNull();
    expect(parsePITaskMetadata(JSON.stringify({ pi_metadata: { ...validMeta, timeoutMs: Infinity } }))).toBeNull();
  });

  it('inputArtifactRefs with invalid element → returns null', () => {
    const meta = {
      pi_metadata: {
        ...makeMetadata({ channel: 'prompt' }),
        inputArtifactRefs: [{ artifactType: 'principle', ref: 'artifact-1' }, { artifactType: 123, ref: 'bad' }],
      },
    };
    expect(parsePITaskMetadata(JSON.stringify(meta))).toBeNull();
  });

  it('outputArtifactRefs with invalid element → returns null', () => {
    const meta = {
      pi_metadata: {
        ...makeMetadata({ channel: 'prompt' }),
        outputArtifactRefs: [{ artifactType: 'principle', ref: 'artifact-2' }, { artifactType: 'rule', ref: '' }],
      },
    };
    expect(parsePITaskMetadata(JSON.stringify(meta))).toBeNull();
  });

  it('parentTaskId present but not non-empty string → returns null (fail closed)', () => {
    const meta = { pi_metadata: { ...makeMetadata({ channel: 'prompt' }), parentTaskId: '' as string } };
    expect(parsePITaskMetadata(JSON.stringify(meta))).toBeNull();
  });

  it('correlationId present but not non-empty string → returns null (fail closed)', () => {
    const meta = { pi_metadata: { ...makeMetadata({ channel: 'defer_archive' }), correlationId: '   ' } };
    expect(parsePITaskMetadata(JSON.stringify(meta))).toBeNull();
  });

  it('adversarialFeedback present but malformed → returns null (fail closed)', () => {
    const meta = { pi_metadata: { ...makeMetadata({ channel: 'prompt' }), adversarialFeedback: 42 } };
    expect(parsePITaskMetadata(JSON.stringify(meta))).toBeNull();
  });

  it('whitespace-only diagnosticJson → returns null', () => {
    expect(parsePITaskMetadata('   ')).toBeNull();
    expect(parsePITaskMetadata('\n\t')).toBeNull();
  });
});

describe('hydratePITaskRecord', () => {
  it('valid diagnosticJson → returns PITaskRecord passing isValidPITaskRecord()', () => {
    const meta = makeMetadata({ channel: 'skill', timeoutMs: 180000 });
    const task = makeBaseTaskRecord({ taskId: 'task-hydrated-1', taskKind: 'philosopher' });
    (task as Record<string, unknown>).diagnosticJson = createPITaskDiagnosticJson(meta);

    const result = hydratePITaskRecord(task);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(isValidPITaskRecord(result)).toBe(true);
    expect(result.taskId).toBe('task-hydrated-1');
    expect((result).channel).toBe('skill');
    expect((result).timeoutMs).toBe(180000);
    expect((result).dependencyTaskIds).toEqual([]);
  });

  it('no diagnosticJson → returns null', () => {
    const task = makeBaseTaskRecord({ taskId: 'task-no-diag' });
    expect(hydratePITaskRecord(task)).toBeNull();
  });

  it('empty diagnosticJson string → returns null', () => {
    const task = makeBaseTaskRecord({ taskId: 'task-empty-diag' });
    (task as Record<string, unknown>).diagnosticJson = '';
    expect(hydratePITaskRecord(task)).toBeNull();
  });

  it('whitespace-only diagnosticJson → returns null', () => {
    const task = makeBaseTaskRecord({ taskId: 'task-whitespace-diag' });
    (task as Record<string, unknown>).diagnosticJson = '   \n';
    expect(hydratePITaskRecord(task)).toBeNull();
  });

  it('invalid JSON in diagnosticJson → returns null', () => {
    const task = makeBaseTaskRecord({ taskId: 'task-bad-json' });
    (task as Record<string, unknown>).diagnosticJson = 'not json';
    expect(hydratePITaskRecord(task)).toBeNull();
  });

  it('valid JSON but wrong envelope key → returns null', () => {
    const task = makeBaseTaskRecord({ taskId: 'task-wrong-key' });
    (task as Record<string, unknown>).diagnosticJson = JSON.stringify({ other_key: {} });
    expect(hydratePITaskRecord(task)).toBeNull();
  });

  it('with dependencyTaskIds and artifactRefs → hydrates correctly', () => {
    const meta = makeMetadata({
      channel: 'prompt',
      dependencyTaskIds: ['dep-1', 'dep-2'],
      inputArtifactRefs: [{ artifactType: 'principle', ref: 'artifact-1' }],
      outputArtifactRefs: [{ artifactType: 'rule', ref: 'artifact-2' }],
    });
    const task = makeBaseTaskRecord({ taskId: 'task-full-meta', taskKind: 'scribe' });
    (task as Record<string, unknown>).diagnosticJson = createPITaskDiagnosticJson(meta);

    const result = hydratePITaskRecord(task);
    expect(result).not.toBeNull();
    const pi = result as PITaskRecord;
    expect(pi.dependencyTaskIds).toEqual(['dep-1', 'dep-2']);
    expect(pi.inputArtifactRefs).toEqual([{ artifactType: 'principle', ref: 'artifact-1' }]);
    expect(pi.outputArtifactRefs).toEqual([{ artifactType: 'rule', ref: 'artifact-2' }]);
  });

  it('taskKind not a PeerRunnerKind (e.g. diagnostician) → returns null (fail closed)', () => {
    // hydratePITaskRecord now rejects non-peer task kinds at the hydration boundary.
    // This closes the Agent-Software Contract gap where a non-PI task with valid
    // pi_metadata in diagnosticJson could be treated as a PITaskRecord.
    const meta = makeMetadata({ channel: 'defer_archive' });
    const task = makeBaseTaskRecord({ taskId: 'task-diagnostician', taskKind: 'diagnostician' });
    (task as Record<string, unknown>).diagnosticJson = createPITaskDiagnosticJson(meta);

    const result = hydratePITaskRecord(task);
    expect(result).toBeNull();
  });

  it('every valid PeerRunnerKind still hydrates successfully', () => {
    const validKinds = ['dreamer', 'philosopher', 'scribe', 'artificer', 'evaluator', 'rollout_reviewer'] as const;
    const meta = makeMetadata({ channel: 'prompt', timeoutMs: 60000 });

    for (const kind of validKinds) {
      const task = makeBaseTaskRecord({ taskId: `task-${kind}`, taskKind: kind });
      (task as Record<string, unknown>).diagnosticJson = createPITaskDiagnosticJson(meta);

      const result = hydratePITaskRecord(task);
      expect(result).not.toBeNull();
      if (result !== null) {
        expect(result.taskKind).toBe(kind);
        expect(result.channel).toBe('prompt');
        expect(result.timeoutMs).toBe(60000);
      }
    }
  });

  it('diagnostician with valid pi_metadata is rejected', () => {
    const meta = makeMetadata({ channel: 'prompt', timeoutMs: 60000 });
    const task = makeBaseTaskRecord({ taskId: 'task-diag-reject', taskKind: 'diagnostician' });
    (task as Record<string, unknown>).diagnosticJson = createPITaskDiagnosticJson(meta);

    expect(hydratePITaskRecord(task)).toBeNull();
  });

  it('parentTaskId and correlationId present → hydrates correctly', () => {
    const meta = makeMetadata({
      channel: 'prompt',
      parentTaskId: 'parent-task-xyz',
      correlationId: 'corr-123',
    });
    const task = makeBaseTaskRecord({ taskId: 'task-optional-fields' });
    (task as Record<string, unknown>).diagnosticJson = createPITaskDiagnosticJson(meta);

    const result = hydratePITaskRecord(task);
    expect(result).not.toBeNull();
    const pi = result as PITaskRecord;
    expect(pi.parentTaskId).toBe('parent-task-xyz');
    expect(pi.correlationId).toBe('corr-123');
  });
});

describe('SqliteTaskStore roundtrip', () => {
  afterEach(() => {
    // cleanup handled per-test below
  });

  it('createTask with diagnosticJson → getTask returns diagnosticJson', async () => {
    const tmpDir = createTempDir();
    const conn = new SqliteConnection(tmpDir);
    const store = new SqliteTaskStore(conn);
    const meta = makeMetadata({ channel: 'code_tool_hook', timeoutMs: 600000 });
    const diagJson = createPITaskDiagnosticJson(meta);

    const task = makeBaseTaskRecord({ taskId: 'task-sqlite-roundtrip', taskKind: 'artificer' });
    const created = await store.createTask(task);
    await store.updateTask(created.taskId, { diagnosticJson: diagJson });

    const retrieved = await store.getTask(created.taskId);
    expect(retrieved).not.toBeNull();
    if (retrieved === null) return;
    expect((retrieved as Record<string, unknown>).diagnosticJson).toBe(diagJson);

    // Hydration still works
    const hydrated = hydratePITaskRecord(retrieved);
    expect(hydrated).not.toBeNull();
    if (hydrated !== null) {
      expect(isValidPITaskRecord(hydrated)).toBe(true);
    }

    conn.close();
    cleanupDir(tmpDir);
  });

  it('createTask with diagnosticJson directly → getTask returns it', async () => {
    const tmpDir = createTempDir();
    const conn = new SqliteConnection(tmpDir);
    const store = new SqliteTaskStore(conn);

    const meta = makeMetadata({ channel: 'skill', timeoutMs: 120000 });
    const diagJson = createPITaskDiagnosticJson(meta);

    const task = makeBaseTaskRecord({
      taskId: 'task-inline-diag',
      taskKind: 'evaluator',
      diagnosticJson: diagJson,
    });

    const created = await store.createTask(task);
    const retrieved = await store.getTask(created.taskId);
    expect(retrieved).not.toBeNull();
    if (retrieved === null) return;
    expect((retrieved as Record<string, unknown>).diagnosticJson).toBe(diagJson);

    const hydrated = hydratePITaskRecord(retrieved);
    expect(hydrated).not.toBeNull();
    if (hydrated !== null) {
      expect((hydrated).channel).toBe('skill');
    }

    conn.close();
    cleanupDir(tmpDir);
  });
});
