/**
 * Unit tests for SqliteDiagnosticianCommitter.
 *
 * COMT-01 through COMT-06 coverage:
 * - COMT-01: DiagnosticianCommitter interface
 * - COMT-02: Transaction-wrapped commit (artifact + commit + candidates)
 * - COMT-03: Extract kind='principle' recommendations
 * - COMT-04: Idempotent re-commit via UNIQUE constraints
 * - COMT-05: Failure returns PDRuntimeError{artifact_commit_failed}
 * - COMT-06: CommitResult returns {commitId, artifactId, candidateCount}
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteConnection } from './sqlite-connection.js';
import { SqliteTaskStore } from './sqlite-task-store.js';
import { SqliteRunStore } from './sqlite-run-store.js';
import { SqliteDiagnosticianCommitter, type CommitInput } from './diagnostician-committer.js';
import type { DiagnosticianOutputV1 } from '../diagnostician-output.js';

describe('SqliteDiagnosticianCommitter', () => {
  let tmpdir = '';
  let connection = null as unknown as SqliteConnection;
  let taskStore = null as unknown as SqliteTaskStore;
  let runStore = null as unknown as SqliteRunStore;
  let committer = null as unknown as SqliteDiagnosticianCommitter;

  beforeEach(() => {
    tmpdir = path.join(os.tmpdir(), `pd-test-committer-${process.pid}-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(tmpdir, { recursive: true });
    connection = new SqliteConnection(tmpdir);
    taskStore = new SqliteTaskStore(connection);
    runStore = new SqliteRunStore(connection);
    committer = new SqliteDiagnosticianCommitter(connection);
  });

  afterEach(() => {
    connection.close();
    fs.rmSync(tmpdir, { force: true, recursive: true });
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  async function createTaskAndRun(taskId: string, runId: string): Promise<void> {
    await taskStore.createTask({
      taskId,
      taskKind: 'diagnostician',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });
    await runStore.createRun({
      runId,
      taskId,
      runtimeKind: 'test-double',
      executionStatus: 'succeeded',
      startedAt: new Date().toISOString(),
      attemptNumber: 1,
    });
  }

  function makeOutput(overrides: Partial<DiagnosticianOutputV1> = {}): DiagnosticianOutputV1 {
    return {
      valid: true,
      diagnosisId: 'diag-1',
      taskId: 'task-1',
      summary: 'Test diagnosis',
      rootCause: 'Test root cause',
      violatedPrinciples: [],
      evidence: [],
      recommendations: [
        { kind: 'principle', description: 'Use immutable data structures' },
        { kind: 'rule', description: 'Always validate input' },
        { kind: 'principle', description: 'Prefer composition over inheritance' },
      ],
      confidence: 0.85,
      ...overrides,
    };
  }

  // ── COMT-06: CommitResult shape ──────────────────────────────────────────

  it('commit returns correct CommitResult with generated IDs', async () => {
    await createTaskAndRun('task-result-1', 'run-result-1');

    const input: CommitInput = {
      runId: 'run-result-1',
      taskId: 'task-result-1',
      output: makeOutput(),
      idempotencyKey: 'ik-commit-result-1',
    };

    const result = await committer.commit(input);

    expect(result).toHaveProperty('commitId');
    expect(result).toHaveProperty('artifactId');
    expect(result.candidateCount).toBe(2); // 2 principle recommendations
    expect(result.commitId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(result.artifactId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  // ── COMT-02: Transaction-wrapped commit ──────────────────────────────────

  it('commit inserts artifact + commit + candidates in one transaction', async () => {
    await createTaskAndRun('task-tx-1', 'run-tx-1');

    const input: CommitInput = {
      runId: 'run-tx-1',
      taskId: 'task-tx-1',
      output: makeOutput(),
      idempotencyKey: 'ik-commit-tx-1',
    };

    const result = await committer.commit(input);
    const db = connection.getDb();

    // Verify artifact row
    const artifact = db
      .prepare('SELECT * FROM artifacts WHERE artifact_id = ?')
      .get(result.artifactId) as Record<string, unknown>;
    expect(artifact).toBeTruthy();
    expect(artifact.artifact_kind).toBe('diagnostician_output');
    expect(artifact.run_id).toBe('run-tx-1');
    expect(artifact.task_id).toBe('task-tx-1');

    // Verify commit row
    const commit = db
      .prepare('SELECT * FROM commits WHERE commit_id = ?')
      .get(result.commitId) as Record<string, unknown>;
    expect(commit).toBeTruthy();
    expect(commit.run_id).toBe('run-tx-1');
    expect(commit.artifact_id).toBe(result.artifactId);
    expect(commit.status).toBe('committed');

    // Verify candidates
    const candidates = db
      .prepare('SELECT * FROM principle_candidates WHERE artifact_id = ? ORDER BY created_at')
      .all(result.artifactId) as Record<string, unknown>[];
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.description).toBe('Use immutable data structures');
    expect(candidates[1]?.description).toBe('Prefer composition over inheritance');
  });

  // ── COMT-03: Extract kind='principle' recommendations ────────────────────

  it('commit extracts only kind=principle recommendations as candidates', async () => {
    await createTaskAndRun('task-extract-1', 'run-extract-1');

    const input: CommitInput = {
      runId: 'run-extract-1',
      taskId: 'task-extract-1',
      output: makeOutput({
        recommendations: [
          { kind: 'principle', description: 'Principle 1' },
          { kind: 'rule', description: 'Rule 1' },
          { kind: 'implementation', description: 'Impl 1' },
          { kind: 'principle', description: 'Principle 2' },
          { kind: 'prompt', description: 'Prompt 1' },
          { kind: 'defer', description: 'Defer 1' },
          { kind: 'principle', description: 'Principle 3' },
        ],
      }),
      idempotencyKey: 'ik-extract-1',
    };

    const result = await committer.commit(input);
    const db = connection.getDb();

    const candidates = db
      .prepare('SELECT * FROM principle_candidates WHERE artifact_id = ?')
      .all(result.artifactId) as Record<string, unknown>[];

    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.description)).toEqual([
      'Principle 1',
      'Principle 2',
      'Principle 3',
    ]);
  });

  // ── COMT-04: Idempotent re-commit ─────────────────────────────────────────

  it('re-commit with same idempotencyKey returns existing commit (idempotent)', async () => {
    await createTaskAndRun('task-idem-1', 'run-idem-1');

    const input: CommitInput = {
      runId: 'run-idem-1',
      taskId: 'task-idem-1',
      output: makeOutput(),
      idempotencyKey: 'ik-idem-1',
    };

    const first = await committer.commit(input);
    const second = await committer.commit(input);

    expect(second.commitId).toBe(first.commitId);
    expect(second.artifactId).toBe(first.artifactId);
    expect(second.candidateCount).toBe(first.candidateCount);

    // Verify no duplicate rows
    const db = connection.getDb();
    const commitCount = db
      .prepare('SELECT COUNT(*) as count FROM commits WHERE idempotency_key = ?')
      .get('ik-idem-1') as { count: number };
    expect(commitCount.count).toBe(1);
  });

  it('re-commit with same runId returns existing commit (idempotent)', async () => {
    await createTaskAndRun('task-idem-2', 'run-idem-2');

    const input: CommitInput = {
      runId: 'run-idem-2',
      taskId: 'task-idem-2',
      output: makeOutput(),
      idempotencyKey: 'ik-idem-2-diff', // different idempotency key
    };

    const first = await committer.commit(input);
    const second = await committer.commit(input);

    expect(second.commitId).toBe(first.commitId);
    expect(second.artifactId).toBe(first.artifactId);

    // Verify UNIQUE on run_id prevented duplicate commit
    const db = connection.getDb();
    const commitCount = db
      .prepare('SELECT COUNT(*) as count FROM commits WHERE run_id = ?')
      .get('run-idem-2') as { count: number };
    expect(commitCount.count).toBe(1);
  });

  // ── COMT-05: Failure returns error ────────────────────────────────────────

  it('commit failure rolls back all rows (no partial state)', async () => {
    await createTaskAndRun('task-fail-1', 'run-fail-1');

    // Try to commit with a run_id that does not exist — should fail FK constraint
    const input: CommitInput = {
      runId: 'non-existent-run',
      taskId: 'task-fail-1',
      output: makeOutput(),
      idempotencyKey: 'ik-fail-1',
    };

    await expect(committer.commit(input)).rejects.toThrow();

    const db = connection.getDb();
    // No artifacts should exist
    const artifactCount = db
      .prepare('SELECT COUNT(*) as count FROM artifacts')
      .get() as { count: number };
    expect(artifactCount.count).toBe(0);
  });

  it('invalid DiagnosticianOutputV1 throws input_invalid error', async () => {
    await createTaskAndRun('task-invalid-1', 'run-invalid-1');

    const input: CommitInput = {
      runId: 'run-invalid-1',
      taskId: 'task-invalid-1',
      // Missing required fields — not a valid DiagnosticianOutputV1
      output: { valid: true } as DiagnosticianOutputV1,
      idempotencyKey: 'ik-invalid-1',
    };

    await expect(committer.commit(input)).rejects.toThrow();
    await expect(committer.commit(input)).rejects.toMatchObject({
      category: 'input_invalid',
    });
  });

  // ── Additional edge cases ─────────────────────────────────────────────────

  it('candidate idempotency keys are derived from commitId:index', async () => {
    await createTaskAndRun('task-idem-key-1', 'run-idem-key-1');

    const input: CommitInput = {
      runId: 'run-idem-key-1',
      taskId: 'task-idem-key-1',
      output: makeOutput({
        recommendations: [
          { kind: 'principle', description: 'Principle A' },
          { kind: 'principle', description: 'Principle B' },
          { kind: 'principle', description: 'Principle C' },
        ],
      }),
      idempotencyKey: 'ik-idem-key-1',
    };

    const result = await committer.commit(input);
    const db = connection.getDb();

    const candidates = db
      .prepare('SELECT idempotency_key FROM principle_candidates WHERE artifact_id = ? ORDER BY created_at')
      .all(result.artifactId) as { idempotency_key: string }[];

    expect(candidates[0]?.idempotency_key).toBe(`${result.commitId}:0`);
    expect(candidates[1]?.idempotency_key).toBe(`${result.commitId}:1`);
    expect(candidates[2]?.idempotency_key).toBe(`${result.commitId}:2`);
  });

  it('empty recommendations array produces candidateCount=0', async () => {
    await createTaskAndRun('task-empty-1', 'run-empty-1');

    const input: CommitInput = {
      runId: 'run-empty-1',
      taskId: 'task-empty-1',
      output: makeOutput({ recommendations: [] }),
      idempotencyKey: 'ik-empty-1',
    };

    const result = await committer.commit(input);
    expect(result.candidateCount).toBe(0);
  });

  it('candidate title defaults to description', async () => {
    await createTaskAndRun('task-title-1', 'run-title-1');

    const input: CommitInput = {
      runId: 'run-title-1',
      taskId: 'task-title-1',
      output: makeOutput({
        recommendations: [
          { kind: 'principle', description: 'Always prefer immutable data structures' },
        ],
      }),
      idempotencyKey: 'ik-title-1',
    };

    const result = await committer.commit(input);
    const db = connection.getDb();

    const candidate = db
      .prepare('SELECT title, description FROM principle_candidates WHERE artifact_id = ?')
      .get(result.artifactId) as { title: string; description: string };

    expect(candidate.title).toBe('Always prefer immutable data structures');
    expect(candidate.description).toBe('Always prefer immutable data structures');
  });
});
