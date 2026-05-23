import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { InternalizationChainIntegrityReadModel, extractPIMetadata } from '../internalization-chain-integrity-read-model.js';
import type { PIMetadataParseResult } from '../internalization-chain-integrity-read-model.js';
import { InternalizationIntegrityRemediation } from '../internalization-integrity-remediation.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  task_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  result_ref TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt_count INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  diagnostic_json TEXT,
  input_ref TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  execution_status TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pi_artifacts (
  artifact_id TEXT PRIMARY KEY,
  artifact_kind TEXT NOT NULL,
  source_task_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  artifact_kind TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS principle_candidates (
  candidate_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  source_run_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

function createTempWorkspace(): { workspaceDir: string; db: Database.Database } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pri209-test-'));
  fs.mkdirSync(path.join(tmpDir, '.pd'), { recursive: true });
  const dbPath = path.join(tmpDir, '.pd', 'state.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  return { workspaceDir: tmpDir, db };
}

describe('Chain Integrity — Real Production Path', () => {
  let workspaceDir = '';
  let db: Database.Database = null as unknown as Database.Database;

  beforeEach(() => {
    ({ workspaceDir, db } = createTempWorkspace());
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function insertTask(opts: {
    taskId: string;
    taskKind: string;
    status: string;
    resultRef?: string | null;
    diagnosticJson?: string | null;
    attemptCount?: number;
    maxAttempts?: number;
    leaseOwner?: string | null;
    leaseExpiresAt?: string | null;
  }) {
    db.prepare(
      `INSERT OR REPLACE INTO tasks (task_id, task_kind, status, result_ref, lease_owner, lease_expires_at, attempt_count, max_attempts, diagnostic_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.taskId,
      opts.taskKind,
      opts.status,
      opts.resultRef ?? null,
      opts.leaseOwner ?? null,
      opts.leaseExpiresAt ?? null,
      opts.attemptCount ?? 0,
      opts.maxAttempts ?? 3,
      opts.diagnosticJson ?? null,
    );
  }

  function insertRun(opts: { runId: string; taskId: string; executionStatus: string }) {
    db.prepare(
      `INSERT OR REPLACE INTO runs (run_id, task_id, execution_status) VALUES (?, ?, ?)`,
    ).run(opts.runId, opts.taskId, opts.executionStatus);
  }

  function insertPIArtifact(opts: { artifactId: string; artifactKind: string; sourceTaskId: string }) {
    db.prepare(
      `INSERT OR REPLACE INTO pi_artifacts (artifact_id, artifact_kind, source_task_id) VALUES (?, ?, ?)`,
    ).run(opts.artifactId, opts.artifactKind, opts.sourceTaskId);
  }

  function _insertArtifact(opts: { artifactId: string; artifactKind: string; taskId: string; runId?: string; contentJson?: string }) {
    db.prepare(
      `INSERT OR REPLACE INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json) VALUES (?, ?, ?, ?, ?)`,
    ).run(opts.artifactId, opts.runId ?? 'run-default', opts.taskId, opts.artifactKind, opts.contentJson ?? '{}');
  }

  function insertCandidate(opts: { candidateId: string; taskId: string; status: string; sourceRunId?: string }) {
    db.prepare(
      `INSERT OR REPLACE INTO principle_candidates (candidate_id, task_id, status, source_run_id) VALUES (?, ?, ?, ?)`,
    ).run(opts.candidateId, opts.taskId, opts.status, opts.sourceRunId ?? null);
  }

  it('dependency artifact exists and lineage correct → healthy/passed', () => {
    insertCandidate({ candidateId: 'c1', taskId: 'dreamer-1', status: 'consumed', sourceRunId: 'run-1' });
    insertTask({
      taskId: 'dreamer-1',
      taskKind: 'dreamer',
      status: 'succeeded',
      diagnosticJson: JSON.stringify({ candidateId: 'c1' }),
    });
    insertRun({ runId: 'run-1', taskId: 'dreamer-1', executionStatus: 'succeeded' });
    insertPIArtifact({ artifactId: 'pi-1', artifactKind: 'principle', sourceTaskId: 'dreamer-1' });
    insertTask({
      taskId: 'phil-1',
      taskKind: 'philosopher',
      status: 'pending',
      diagnosticJson: JSON.stringify({ parentTaskId: 'dreamer-1', dependencyTaskIds: ['dreamer-1'] }),
    });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir });
    const { brokenLinks, overallStatus } = model.check();

    expect(overallStatus).toBe('ok');
    expect(brokenLinks.some(l => l.type === 'missing_dreamer_pi_artifact')).toBe(false);
  });

  it('dependency artifact missing → missing_artifact detected', () => {
    insertCandidate({ candidateId: 'c2', taskId: 'dreamer-2', status: 'consumed', sourceRunId: 'run-2' });
    insertTask({
      taskId: 'dreamer-2',
      taskKind: 'dreamer',
      status: 'succeeded',
      diagnosticJson: JSON.stringify({ candidateId: 'c2' }),
    });
    insertRun({ runId: 'run-2', taskId: 'dreamer-2', executionStatus: 'succeeded' });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir });
    const result = model.check();

    expect(result.brokenLinks.some(l => l.type === 'missing_dreamer_pi_artifact')).toBe(true);
    const link = result.brokenLinks.find(l => l.type === 'missing_dreamer_pi_artifact');
    expect(link?.taskId).toBe('dreamer-2');
  });

  it('unrelated artifact with different sourceTaskId → task reports missing, not mismatch', () => {
    insertTask({
      taskId: 'dreamer-3',
      taskKind: 'dreamer',
      status: 'succeeded',
      diagnosticJson: null,
    });
    insertRun({ runId: 'run-3', taskId: 'dreamer-3', executionStatus: 'succeeded' });
    insertPIArtifact({ artifactId: 'pi-3', artifactKind: 'principle', sourceTaskId: 'wrong-task-id' });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir });
    const result = model.check();

    expect(result.brokenLinks.some(l => l.type === 'missing_dreamer_pi_artifact' && l.taskId === 'dreamer-3')).toBe(true);
  });

  it('succeeded task result_ref points to artifact with wrong task_id → lineage_mismatch', () => {
    insertTask({
      taskId: 'dreamer-lm',
      taskKind: 'dreamer',
      status: 'succeeded',
      resultRef: 'artifact-lm',
    });
    insertRun({ runId: 'run-lm', taskId: 'dreamer-lm', executionStatus: 'succeeded' });
    _insertArtifact({
      artifactId: 'artifact-lm',
      artifactKind: 'principle',
      taskId: 'wrong-task-id',
    });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir });
    const result = model.check();

    const mismatch = result.brokenLinks.find(l => l.type === 'lineage_mismatch' && l.taskId === 'dreamer-lm');
    expect(mismatch).toBeDefined();
    expect(mismatch?.artifactId).toBe('artifact-lm');
    expect(mismatch?.reason).toContain('wrong-task-id');
  });

  it('unrelated artifact remains missing, not lineage_mismatch (multi-dep)', () => {
    insertTask({
      taskId: 'dreamer-X',
      taskKind: 'dreamer',
      status: 'succeeded',
    });
    insertRun({ runId: 'run-X', taskId: 'dreamer-X', executionStatus: 'succeeded' });
    insertPIArtifact({ artifactId: 'pi-unrelated', artifactKind: 'principle', sourceTaskId: 'other-task' });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir });
    const result = model.check();

    const missing = result.brokenLinks.find(l => l.type === 'missing_dreamer_pi_artifact' && l.taskId === 'dreamer-X');
    expect(missing).toBeDefined();

    const mismatch = result.brokenLinks.find(l => l.type === 'lineage_mismatch' && l.taskId === 'dreamer-X');
    expect(mismatch).toBeUndefined();
  });

  it('dependency A has artifact, dependency B missing → B is missing_artifact, not lineage_mismatch', () => {
    insertTask({
      taskId: 'dreamer-A',
      taskKind: 'dreamer',
      status: 'succeeded',
      diagnosticJson: null,
    });
    insertRun({ runId: 'run-A', taskId: 'dreamer-A', executionStatus: 'succeeded' });
    insertPIArtifact({ artifactId: 'pi-A', artifactKind: 'principle', sourceTaskId: 'dreamer-A' });

    insertTask({
      taskId: 'dreamer-B',
      taskKind: 'dreamer',
      status: 'succeeded',
      diagnosticJson: null,
    });
    insertRun({ runId: 'run-B', taskId: 'dreamer-B', executionStatus: 'succeeded' });

    insertTask({
      taskId: 'phil-2',
      taskKind: 'philosopher',
      status: 'pending',
      diagnosticJson: JSON.stringify({ dependencyTaskIds: ['dreamer-A', 'dreamer-B'] }),
    });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir });
    const result = model.check();

    const missingB = result.brokenLinks.find(l => l.type === 'missing_dreamer_pi_artifact' && l.taskId === 'dreamer-B');
    expect(missingB).toBeDefined();

    const lineageMismatchForB = result.brokenLinks.find(l => l.type === 'lineage_mismatch' && l.taskId === 'dreamer-B');
    expect(lineageMismatchForB).toBeUndefined();

    const missingA = result.brokenLinks.find(l => l.type === 'missing_dreamer_pi_artifact' && l.taskId === 'dreamer-A');
    expect(missingA).toBeUndefined();
  });

  it('duplicate/conflicting artifacts → pi_artifact_duplicate broken link', () => {
    insertTask({
      taskId: 'dreamer-4',
      taskKind: 'dreamer',
      status: 'succeeded',
      diagnosticJson: null,
    });
    insertRun({ runId: 'run-4', taskId: 'dreamer-4', executionStatus: 'succeeded' });
    insertPIArtifact({ artifactId: 'pi-4a', artifactKind: 'principle', sourceTaskId: 'dreamer-4' });
    insertPIArtifact({ artifactId: 'pi-4b', artifactKind: 'principle', sourceTaskId: 'dreamer-4' });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir });
    const result = model.check();

    expect(result.brokenLinks.some(l => l.type === 'pi_artifact_duplicate')).toBe(true);
  });

  it('remediation dry-run → does not modify state', () => {
    insertTask({
      taskId: 'dreamer-5',
      taskKind: 'dreamer',
      status: 'succeeded',
      diagnosticJson: null,
    });
    insertRun({ runId: 'run-5', taskId: 'dreamer-5', executionStatus: 'succeeded' });

    const remediation = new InternalizationIntegrityRemediation({ workspaceDir });
    const result = remediation.repair({ dryRun: true });

    expect(result.mode).toBe('dry_run');

    const row = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get('dreamer-5') as { status: string } | undefined;
    expect(row?.status).toBe('succeeded');
  });

  it('remediation confirm → modifies behavior, idempotent', () => {
    insertTask({
      taskId: 'dreamer-6',
      taskKind: 'dreamer',
      status: 'succeeded',
      diagnosticJson: null,
    });
    insertRun({ runId: 'run-6', taskId: 'dreamer-6', executionStatus: 'succeeded' });

    const remediation = new InternalizationIntegrityRemediation({ workspaceDir });
    const result1 = remediation.repair({ dryRun: false });

    const row1 = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get('dreamer-6') as { status: string } | undefined;
    expect(row1?.status).toBe('retry_wait');
    expect(result1.repairedCount).toBeGreaterThan(0);

    const result2 = remediation.repair({ dryRun: false });

    const row2 = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get('dreamer-6') as { status: string } | undefined;
    expect(row2?.status).toBe('retry_wait');
    expect(result2.repairedCount).toBe(0);

    const requeueAction = result2.actions.find(a => a.taskId === 'dreamer-6' && a.recommendedAction === 'requeue');
    expect(requeueAction).toBeUndefined();
  });
  it('test artifacts schema matches production: has task_id, no source_task_id', () => {
    const columns = db.prepare('PRAGMA table_info(artifacts)').all() as { name: string }[];
    const columnNames = columns.map(c => c.name);
    expect(columnNames).toContain('task_id');
    expect(columnNames).not.toContain('source_task_id');
  });

  it('task with malformed diagnosticJson → metadata_malformed broken link (PRI-225)', () => {
    insertCandidate({ candidateId: 'c-mf', taskId: 'dreamer-mf', status: 'consumed', sourceRunId: 'run-mf' });
    insertTask({
      taskId: 'dreamer-mf',
      taskKind: 'dreamer',
      status: 'succeeded',
      diagnosticJson: JSON.stringify({ candidateId: 'c-mf' }),
    });
    insertRun({ runId: 'run-mf', taskId: 'dreamer-mf', executionStatus: 'succeeded' });
    insertPIArtifact({ artifactId: 'pi-mf', artifactKind: 'principle', sourceTaskId: 'dreamer-mf' });
    insertTask({
      taskId: 'phil-mf',
      taskKind: 'philosopher',
      status: 'pending',
      diagnosticJson: 'not-json{{{',
    });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir });
    const result = model.check();

    const malformed = result.brokenLinks.find(l => l.type === 'metadata_malformed' && l.taskId === 'phil-mf');
    expect(malformed).toBeDefined();
    expect(malformed?.severity).toBe('warning');
    expect(malformed?.reason.length).toBeGreaterThan(0);
    expect(malformed?.recommendedAction.length).toBeGreaterThan(0);
  });

  it('task with dependencyTaskIds containing non-strings → metadata_malformed (PRI-225)', () => {
    insertTask({
      taskId: 'phil-mixed',
      taskKind: 'philosopher',
      status: 'pending',
      diagnosticJson: JSON.stringify({ dependencyTaskIds: ['valid', 42] }),
    });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir });
    const result = model.check();

    const malformed = result.brokenLinks.find(l => l.type === 'metadata_malformed' && l.taskId === 'phil-mixed');
    expect(malformed).toBeDefined();
  });

  it('healthy chain with valid metadata → no metadata_malformed broken links (PRI-225)', () => {
    insertCandidate({ candidateId: 'c-healthy', taskId: 'dreamer-healthy', status: 'consumed', sourceRunId: 'run-healthy' });
    insertTask({
      taskId: 'dreamer-healthy',
      taskKind: 'dreamer',
      status: 'succeeded',
      diagnosticJson: JSON.stringify({ candidateId: 'c-healthy' }),
    });
    insertRun({ runId: 'run-healthy', taskId: 'dreamer-healthy', executionStatus: 'succeeded' });
    insertPIArtifact({ artifactId: 'pi-healthy', artifactKind: 'principle', sourceTaskId: 'dreamer-healthy' });
    insertTask({
      taskId: 'phil-healthy',
      taskKind: 'philosopher',
      status: 'pending',
      diagnosticJson: JSON.stringify({ parentTaskId: 'dreamer-healthy', dependencyTaskIds: ['dreamer-healthy'] }),
    });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir });
    const result = model.check();

    expect(result.overallStatus).toBe('ok');
    expect(result.brokenLinks.some(l => l.type === 'metadata_malformed')).toBe(false);
  });

  it('null diagnosticJson on philosopher → missing (not malformed), no metadata_malformed (PRI-225)', () => {
    insertTask({
      taskId: 'phil-null',
      taskKind: 'philosopher',
      status: 'pending',
      diagnosticJson: null,
    });

    const model = new InternalizationChainIntegrityReadModel({ workspaceDir });
    const result = model.check();

    const malformed = result.brokenLinks.find(l => l.type === 'metadata_malformed' && l.taskId === 'phil-null');
    expect(malformed).toBeUndefined();
  });
});

describe('extractPIMetadata — PIMetadataParseResult contract (PRI-225)', () => {
  it('null diagnosticJson → missing', () => {
    const r = extractPIMetadata(null);
    expect(r.status).toBe('missing');
  });

  it('empty string diagnosticJson → missing', () => {
    const r = extractPIMetadata('');
    expect(r.status).toBe('missing');
  });

  it('valid top-level metadata → parsed', () => {
    const r: PIMetadataParseResult = extractPIMetadata(JSON.stringify({ parentTaskId: 't1', dependencyTaskIds: ['t2'] }));
    expect(r.status).toBe('parsed');
    if (r.status === 'parsed') {
      expect(r.parentTaskId).toBe('t1');
      expect(r.dependencyTaskIds).toEqual(['t2']);
    }
  });

  it('valid nested pi_metadata → parsed', () => {
    const r: PIMetadataParseResult = extractPIMetadata(JSON.stringify({
      pi_metadata: { parentTaskId: 't1', dependencyTaskIds: ['t2', 't3'] },
    }));
    expect(r.status).toBe('parsed');
    if (r.status === 'parsed') {
      expect(r.parentTaskId).toBe('t1');
      expect(r.dependencyTaskIds).toEqual(['t2', 't3']);
    }
  });

  it('valid metadata with only parentTaskId → parsed', () => {
    const r = extractPIMetadata(JSON.stringify({ parentTaskId: 't1' }));
    expect(r.status).toBe('parsed');
    if (r.status === 'parsed') {
      expect(r.parentTaskId).toBe('t1');
      expect(r.dependencyTaskIds).toBeUndefined();
    }
  });

  it('valid metadata with only dependencyTaskIds → parsed', () => {
    const r = extractPIMetadata(JSON.stringify({ dependencyTaskIds: ['t1'] }));
    expect(r.status).toBe('parsed');
    if (r.status === 'parsed') {
      expect(r.parentTaskId).toBeUndefined();
      expect(r.dependencyTaskIds).toEqual(['t1']);
    }
  });

  it('malformed JSON → malformed with reason', () => {
    const r = extractPIMetadata('not-json{{{');
    expect(r.status).toBe('malformed');
    if (r.status === 'malformed') {
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it('JSON array → malformed', () => {
    const r = extractPIMetadata('[1,2,3]');
    expect(r.status).toBe('malformed');
  });

  it('JSON number → malformed', () => {
    const r = extractPIMetadata('42');
    expect(r.status).toBe('malformed');
  });

  it('JSON string → malformed', () => {
    const r = extractPIMetadata('"hello"');
    expect(r.status).toBe('malformed');
  });

  it('JSON boolean → malformed', () => {
    const r = extractPIMetadata('true');
    expect(r.status).toBe('malformed');
  });

  it('pi_metadata is array → malformed', () => {
    const r = extractPIMetadata(JSON.stringify({ pi_metadata: [1, 2] }));
    expect(r.status).toBe('malformed');
  });

  it('pi_metadata is number → malformed', () => {
    const r = extractPIMetadata(JSON.stringify({ pi_metadata: 42 }));
    expect(r.status).toBe('malformed');
  });

  it('pi_metadata is string → malformed', () => {
    const r = extractPIMetadata(JSON.stringify({ pi_metadata: 'bad' }));
    expect(r.status).toBe('malformed');
  });

  it('pi_metadata is null → malformed', () => {
    const r = extractPIMetadata(JSON.stringify({ pi_metadata: null }));
    expect(r.status).toBe('malformed');
  });

  it('parentTaskId is number → malformed', () => {
    const r = extractPIMetadata(JSON.stringify({ parentTaskId: 42 }));
    expect(r.status).toBe('malformed');
    if (r.status === 'malformed') {
      expect(r.reason).toContain('parentTaskId');
    }
  });

  it('dependencyTaskIds is string → malformed', () => {
    const r = extractPIMetadata(JSON.stringify({ dependencyTaskIds: 'x' }));
    expect(r.status).toBe('malformed');
    if (r.status === 'malformed') {
      expect(r.reason).toContain('dependencyTaskIds');
    }
  });

  it('dependencyTaskIds with mixed valid and invalid elements → malformed (not partially accepted)', () => {
    const r = extractPIMetadata(JSON.stringify({ dependencyTaskIds: ['valid', 42] }));
    expect(r.status).toBe('malformed');
    if (r.status === 'malformed') {
      expect(r.reason).toContain('dependencyTaskIds');
    }
  });

  it('dependencyTaskIds with all non-string elements → malformed', () => {
    const r = extractPIMetadata(JSON.stringify({ dependencyTaskIds: [42, null, true] }));
    expect(r.status).toBe('malformed');
  });

  it('empty object → missing (no pi metadata fields)', () => {
    const r = extractPIMetadata('{}');
    expect(r.status).toBe('missing');
  });

  it('object with only unrelated fields → missing', () => {
    const r = extractPIMetadata(JSON.stringify({ foo: 'bar', baz: 42 }));
    expect(r.status).toBe('missing');
  });

  it('inherited parentTaskId is not read as legitimate metadata', () => {
    const obj = Object.create({ parentTaskId: 'inherited' });
    obj.ownField = 'value';
    const r = extractPIMetadata(JSON.stringify(obj));
    expect(r.status).toBe('missing');
  });

  it('inherited dependencyTaskIds is not read as legitimate metadata', () => {
    const obj = Object.create({ dependencyTaskIds: ['inherited'] });
    obj.ownField = 'value';
    const r = extractPIMetadata(JSON.stringify(obj));
    expect(r.status).toBe('missing');
  });

  it('malformed reason does not leak full diagnosticJson payload', () => {
    const longPayload = 'x'.repeat(500);
    const r = extractPIMetadata(longPayload);
    expect(r.status).toBe('malformed');
    if (r.status === 'malformed') {
      expect(r.reason.length).toBeLessThan(200);
    }
  });
});
