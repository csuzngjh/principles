import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { InternalizationChainIntegrityReadModel, extractPIMetadata } from '../internalization-chain-integrity-read-model.js';
import { InternalizationIntegrityRemediation } from '../internalization-integrity-remediation.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS principle_candidates (
  candidate_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  task_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  input_ref TEXT,
  result_ref TEXT,
  last_error TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  diagnostic_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  execution_status TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  output_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pi_artifacts (
  artifact_id TEXT PRIMARY KEY,
  source_task_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL,
  content_json TEXT NOT NULL,
  validation_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function setupDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  db.close();
}

describe('Chain Integrity Attack Tests (PRI-209)', () => {
  let tmpDir = '';
  let dbPath = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pri209-attack-'));
    fs.mkdirSync(path.join(tmpDir, '.pd'), { recursive: true });
    dbPath = path.join(tmpDir, '.pd', 'state.db');
    setupDb(dbPath);
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function insertCandidate(opts: { candidateId: string; taskId: string; sourceRunId: string; status?: string }): void {
    const db = new Database(dbPath);
    db.prepare(
      `INSERT OR REPLACE INTO principle_candidates (candidate_id, task_id, source_run_id, status) VALUES (?, ?, ?, ?)`,
    ).run(opts.candidateId, opts.taskId, opts.sourceRunId, opts.status ?? 'consumed');
    db.close();
  }

  function insertTask(opts: {
    taskId: string; taskKind: string; status: string;
    resultRef?: string; diagnosticJson?: string;
    attemptCount?: number; leaseOwner?: string; leaseExpiresAt?: string;
  }): void {
    const db = new Database(dbPath);
    db.prepare(
      `INSERT OR REPLACE INTO tasks (task_id, task_kind, status, attempt_count, max_attempts, result_ref, diagnostic_json, lease_owner, lease_expires_at)
       VALUES (?, ?, ?, ?, 3, ?, ?, ?, ?)`,
    ).run(opts.taskId, opts.taskKind, opts.status, opts.attemptCount ?? 1, opts.resultRef ?? null, opts.diagnosticJson ?? null, opts.leaseOwner ?? null, opts.leaseExpiresAt ?? null);
    db.close();
  }

  function insertRun(opts: { runId: string; taskId: string; executionStatus: string }): void {
    const db = new Database(dbPath);
    db.prepare(
      `INSERT OR REPLACE INTO runs (run_id, task_id, execution_status) VALUES (?, ?, ?)`,
    ).run(opts.runId, opts.taskId, opts.executionStatus);
    db.close();
  }

  function insertPIArtifact(opts: { artifactId: string; sourceTaskId: string; artifactKind: string; contentJson?: string }): void {
    const db = new Database(dbPath);
    db.prepare(
      `INSERT OR REPLACE INTO pi_artifacts (artifact_id, source_task_id, artifact_kind, content_json) VALUES (?, ?, ?, ?)`,
    ).run(opts.artifactId, opts.sourceTaskId, opts.artifactKind, opts.contentJson ?? '{}');
    db.close();
  }

  function _insertArtifact(opts: { artifactId: string; taskId: string; artifactKind: string; runId?: string; contentJson?: string }): void {
    const db = new Database(dbPath);
    db.prepare(
      `INSERT OR REPLACE INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json) VALUES (?, ?, ?, ?, ?)`,
    ).run(opts.artifactId, opts.runId ?? 'run-default', opts.taskId, opts.artifactKind, opts.contentJson ?? '{}');
    db.close();
  }

  function getTaskStatus(taskId: string): string | null {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId) as { status: string } | undefined;
    db.close();
    return row?.status ?? null;
  }

  it('healthy chain: consumed candidate → dreamer succeeded → principle artifact → philosopher → all links OK', () => {
    insertCandidate({ candidateId: 'c1', taskId: 'dreamer-001', sourceRunId: 'run-c1' });
    insertTask({ taskId: 'dreamer-001', taskKind: 'dreamer', status: 'succeeded', diagnosticJson: '{"candidateId":"c1"}' });
    insertRun({ runId: 'run-d1', taskId: 'dreamer-001', executionStatus: 'succeeded' });
    insertPIArtifact({ artifactId: 'pi-001', sourceTaskId: 'dreamer-001', artifactKind: 'principle' });
    insertTask({
      taskId: 'philosopher-001', taskKind: 'philosopher', status: 'pending',
      diagnosticJson: '{"parentTaskId":"dreamer-001","dependencyTaskIds":["dreamer-001"]}',
    });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir: tmpDir });
    const result = model.check();

    expect(result.overallStatus).toBe('ok');
    expect(result.brokenLinks.length).toBe(0);
    expect(result.chainSummaries.totalCandidates).toBe(1);
    expect(result.chainSummaries.totalDreamerTasks).toBe(1);
    expect(result.chainSummaries.totalPhilosopherTasks).toBe(1);
    expect(result.chainSummaries.totalPIArtifacts).toBe(1);
  });

  it('missing artifact: succeeded dreamer with no principle artifact → missing_dreamer_pi_artifact', () => {
    insertTask({ taskId: 'dreamer-002', taskKind: 'dreamer', status: 'succeeded' });
    insertRun({ runId: 'run-d2', taskId: 'dreamer-002', executionStatus: 'succeeded' });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir: tmpDir });
    const result = model.check();

    expect(result.overallStatus).not.toBe('ok');
    const broken = result.brokenLinks.find(l => l.type === 'missing_dreamer_pi_artifact');
    expect(broken).toBeDefined();
    expect(broken?.taskId).toBe('dreamer-002');
    expect(broken?.severity).toBe('error');
    expect(broken?.recommendedAction.length).toBeGreaterThan(0);
  });

  it('malformed metadata: extractPIMetadata with null, invalid JSON, missing fields', () => {
    expect(extractPIMetadata(null)).toEqual({});
    expect(extractPIMetadata('')).toEqual({});
    expect(extractPIMetadata('not-json{{{')).toEqual({});
    expect(extractPIMetadata('42')).toEqual({});
    expect(extractPIMetadata('"hello"')).toEqual({});
    expect(extractPIMetadata('[]')).toEqual({});
    expect(extractPIMetadata('{}')).toEqual({});
    expect(extractPIMetadata('{"parentTaskId":42}')).toEqual({});
    expect(extractPIMetadata('{"dependencyTaskIds":"not-array"}')).toEqual({});
    expect(extractPIMetadata('{"dependencyTaskIds":[42,true]}')).toEqual({});
    expect(extractPIMetadata('{"parentTaskId":"t1","dependencyTaskIds":["t2"]}')).toEqual({ parentTaskId: 't1', dependencyTaskIds: ['t2'] });
    expect(extractPIMetadata('{"pi_metadata":{"parentTaskId":"t3"}}')).toEqual({ parentTaskId: 't3' });
    expect(extractPIMetadata('{"pi_metadata":{"parentTaskId":123}}')).toEqual({});
    expect(extractPIMetadata('{"dependencyTaskIds":["t1",42,"t3"]}')).toEqual({ dependencyTaskIds: ['t1', 't3'] });
  });

  it('inherited property "constructor" is not read as pi_metadata', () => {
    const result = extractPIMetadata(JSON.stringify({ constructor: 'malicious' }));
    expect(result).toEqual({});
  });

  it('unrelated artifact: artifact with different sourceTaskId → task reports missing, not mismatch', () => {
    insertTask({ taskId: 'dreamer-003', taskKind: 'dreamer', status: 'succeeded' });
    insertRun({ runId: 'run-d3', taskId: 'dreamer-003', executionStatus: 'succeeded' });
    insertPIArtifact({ artifactId: 'pi-mismatch', sourceTaskId: 'dreamer-wrong', artifactKind: 'principle' });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir: tmpDir });
    const result = model.check();

    const missingArtifact = result.brokenLinks.find(l => l.type === 'missing_dreamer_pi_artifact' && l.taskId === 'dreamer-003');
    expect(missingArtifact).toBeDefined();
  });

  it('lineage_mismatch: succeeded task result_ref points to artifact with wrong task_id', () => {
    insertTask({ taskId: 'dreamer-lm', taskKind: 'dreamer', status: 'succeeded', resultRef: 'artifact-lm' });
    insertRun({ runId: 'run-lm', taskId: 'dreamer-lm', executionStatus: 'succeeded' });
    _insertArtifact({ artifactId: 'artifact-lm', taskId: 'wrong-task', artifactKind: 'principle' });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir: tmpDir });
    const result = model.check();

    const mismatch = result.brokenLinks.find(l => l.type === 'lineage_mismatch' && l.taskId === 'dreamer-lm');
    expect(mismatch).toBeDefined();
    expect(mismatch?.artifactId).toBe('artifact-lm');
  });

  it('multi-dependency: A has artifact, B missing — B reported as missing_dreamer_pi_artifact, NOT lineage_mismatch', () => {
    insertTask({ taskId: 'dreamer-A', taskKind: 'dreamer', status: 'succeeded' });
    insertTask({ taskId: 'dreamer-B', taskKind: 'dreamer', status: 'succeeded' });
    insertRun({ runId: 'run-dA', taskId: 'dreamer-A', executionStatus: 'succeeded' });
    insertRun({ runId: 'run-dB', taskId: 'dreamer-B', executionStatus: 'succeeded' });
    insertPIArtifact({ artifactId: 'pi-A', sourceTaskId: 'dreamer-A', artifactKind: 'principle' });

    insertTask({
      taskId: 'philosopher-multi', taskKind: 'philosopher', status: 'pending',
      diagnosticJson: '{"parentTaskId":"dreamer-A","dependencyTaskIds":["dreamer-A","dreamer-B"]}',
    });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir: tmpDir });
    const result = model.check();

    const missingB = result.brokenLinks.find(l => l.type === 'missing_dreamer_pi_artifact' && l.taskId === 'dreamer-B');
    expect(missingB).toBeDefined();
    expect(missingB?.severity).toBe('error');

    const lineageMismatch = result.brokenLinks.find(l => l.type === 'lineage_mismatch');
    expect(lineageMismatch).toBeUndefined();

    const missingA = result.brokenLinks.find(l => l.type === 'missing_dreamer_pi_artifact' && l.taskId === 'dreamer-A');
    expect(missingA).toBeUndefined();
  });

  it('duplicate artifacts: two artifacts with same source_task_id and artifact_kind → pi_artifact_duplicate', () => {
    insertTask({ taskId: 'dreamer-dup', taskKind: 'dreamer', status: 'succeeded' });
    insertRun({ runId: 'run-dup', taskId: 'dreamer-dup', executionStatus: 'succeeded' });
    insertPIArtifact({ artifactId: 'pi-dup-1', sourceTaskId: 'dreamer-dup', artifactKind: 'principle' });
    insertPIArtifact({ artifactId: 'pi-dup-2', sourceTaskId: 'dreamer-dup', artifactKind: 'principle' });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir: tmpDir });
    const result = model.check();

    const duplicate = result.brokenLinks.find(l => l.type === 'pi_artifact_duplicate');
    expect(duplicate).toBeDefined();
    expect(duplicate?.reason).toContain('dreamer-dup');
    expect(duplicate?.reason).toContain('2 times');
  });

  it('remediation dry-run: does not modify DB state', () => {
    insertTask({ taskId: 'dreamer-001', taskKind: 'dreamer', status: 'succeeded' });

    const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
    const result = remediation.repair({ dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(getTaskStatus('dreamer-001')).toBe('succeeded');
  });

  it('remediation confirm: requeues broken dreamer task, idempotent on second call', () => {
    insertTask({ taskId: 'dreamer-001', taskKind: 'dreamer', status: 'succeeded' });

    const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
    const result1 = remediation.repair({ dryRun: false });

    expect(result1.repairedCount).toBeGreaterThanOrEqual(1);
    expect(getTaskStatus('dreamer-001')).toBe('retry_wait');

    const result2 = remediation.repair({ dryRun: false });

    expect(result2.repairedCount).toBe(0);
    expect(getTaskStatus('dreamer-001')).toBe('retry_wait');
  });

  it('test artifacts schema matches production: has task_id, no source_task_id', () => {
    const db = new Database(dbPath, { readonly: true });
    const columns = db.prepare('PRAGMA table_info(artifacts)').all() as { name: string }[];
    db.close();
    const columnNames = columns.map(c => c.name);
    expect(columnNames).toContain('task_id');
    expect(columnNames).not.toContain('source_task_id');
  });
});
