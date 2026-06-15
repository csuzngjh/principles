import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { InternalizationIntegrityRemediation } from '../internalization-integrity-remediation.js';
import type { RemediationAction } from '../remediation-contract.js';

describe('InternalizationIntegrityRemediation', () => {
  let tmpDir = '';
  let dbPath = '';
  let db: Database.Database = null as unknown as Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pri108-test-'));
    fs.mkdirSync(path.join(tmpDir, '.pd'), { recursive: true });
    dbPath = path.join(tmpDir, '.pd', 'state.db');
    db = new Database(dbPath);

    db.exec(`
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

      CREATE TABLE IF NOT EXISTS pi_artifacts (
        artifact_id TEXT PRIMARY KEY,
        source_task_id TEXT NOT NULL,
        artifact_kind TEXT NOT NULL,
        content_json TEXT NOT NULL,
        validation_status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        runtime_kind TEXT NOT NULL DEFAULT 'openclaw',
        execution_status TEXT NOT NULL DEFAULT 'queued',
        started_at TEXT,
        ended_at TEXT,
        reason TEXT,
        output_ref TEXT,
        input_payload TEXT,
        output_payload TEXT,
        error_category TEXT,
        attempt_number INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.close();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  interface TaskInsertOpts {
    taskId: string;
    taskKind: string;
    status: string;
    diagnosticJson?: string;
    attemptCount?: number;
  }

  function insertTask(opts: TaskInsertOpts): void {
    const d = new Database(dbPath);
    d.prepare(
      `INSERT OR REPLACE INTO tasks (task_id, task_kind, status, attempt_count, max_attempts, diagnostic_json)
       VALUES (?, ?, ?, ?, 3, ?)`,
    ).run(opts.taskId, opts.taskKind, opts.status, opts.attemptCount ?? 1, opts.diagnosticJson ?? null);
    d.close();
  }

  interface ArtifactInsertOpts {
    artifactId: string;
    sourceTaskId: string;
    kind: string;
    content: string;
  }

  function insertArtifact(opts: ArtifactInsertOpts): void {
    const d = new Database(dbPath);
    d.prepare(
      `INSERT OR REPLACE INTO pi_artifacts (artifact_id, source_task_id, artifact_kind, content_json)
       VALUES (?, ?, ?, ?)`,
    ).run(opts.artifactId, opts.sourceTaskId, opts.kind, opts.content);
    d.close();
  }

  function getTaskField(taskId: string, field: string): string | number | null {
    const d = new Database(dbPath);
    const row = d.prepare(`SELECT ${field} FROM tasks WHERE task_id = ?`).get(taskId) as Record<string, unknown> | undefined;
    d.close();
    return (row?.[field] as string | number | null) ?? null;
  }

  function getRunField(runId: string, field: string): string | number | null {
    const d = new Database(dbPath);
    const row = d.prepare(`SELECT ${field} FROM runs WHERE run_id = ?`).get(runId) as Record<string, unknown> | undefined;
    d.close();
    return (row?.[field] as string | number | null) ?? null;
  }

  function insertRun(opts: { runId: string; taskId: string; executionStatus: string; runtimeKind?: string; attemptNumber?: number; }) {
    const d = new Database(dbPath);
    const now = new Date().toISOString();
    // runtime_kind defaults to 'openclaw' (a valid RuntimeKindSchema enum value)
    // so the row passes schema validation and is NOT flagged as malformed by
    // detectMalformedRuns. Tests that need a malformed row use insertMalformedRunRow.
    d.prepare(
      `INSERT OR REPLACE INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, attempt_number, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(opts.runId, opts.taskId, opts.runtimeKind ?? 'openclaw', opts.executionStatus, now, opts.attemptNumber ?? 1, now, now);
    d.close();
  }

  function findAction(actions: RemediationAction[], taskId: string, type: string): RemediationAction | undefined {
    return actions.find(a => a.taskId === taskId && a.type === type);
  }

  describe('dry-run', () => {
    it('does not modify DB on dry-run', () => {
      insertTask({ taskId: 'dreamer-001', taskKind: 'dreamer', status: 'succeeded' });

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(getTaskField('dreamer-001', 'status')).toBe('succeeded');
    });

    it('reports missing_dreamer_pi_artifact as requeue action', () => {
      insertTask({ taskId: 'dreamer-001', taskKind: 'dreamer', status: 'succeeded' });

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: true });

      const action = findAction(result.actions, 'dreamer-001', 'missing_dreamer_pi_artifact');
      expect(action).toBeDefined();
      expect(action?.recommendedAction).toBe('requeue');
      expect(action?.previousStatus).toBe('succeeded');
      expect(action?.newStatus).toBe('retry_wait');
    });

    it('reports missing_philosopher_successor with artifact present as enqueue_successor action', () => {
      insertTask({ taskId: 'dreamer-002', taskKind: 'dreamer', status: 'succeeded' });
      insertArtifact({ artifactId: 'art-002', sourceTaskId: 'dreamer-002', kind: 'principle', content: '{"valid":true}' });

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: true });

      const action = findAction(result.actions, 'dreamer-002', 'missing_philosopher_successor');
      expect(action).toBeDefined();
      expect(action?.recommendedAction).toBe('enqueue_successor');
    });

    it('reports missing_philosopher_successor without artifact as skip (Case C)', () => {
      insertTask({ taskId: 'dreamer-003', taskKind: 'dreamer', status: 'succeeded' });

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: true });

      const action = findAction(result.actions, 'dreamer-003', 'missing_philosopher_successor');
      expect(action).toBeDefined();
      expect(action?.recommendedAction).toBe('skip_missing_artifact');
    });

    it('returns repairedCount=0 and skippedCount on dry-run', () => {
      insertTask({ taskId: 'dreamer-001', taskKind: 'dreamer', status: 'succeeded' });

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: true });

      expect(result.repairedCount).toBe(0);
      expect(result.skippedCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('confirm', () => {
    it('requeues succeeded dreamer with missing artifact to retry_wait', () => {
      insertTask({ taskId: 'dreamer-001', taskKind: 'dreamer', status: 'succeeded' });

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: false });

      expect(result.dryRun).toBe(false);
      expect(getTaskField('dreamer-001', 'status')).toBe('retry_wait');
      expect(getTaskField('dreamer-001', 'lease_owner')).toBeNull();

      const action = findAction(result.actions, 'dreamer-001', 'missing_dreamer_pi_artifact');
      expect(action?.previousStatus).toBe('succeeded');
      expect(action?.newStatus).toBe('retry_wait');
      expect(action?.reason).toContain('operator repair');
    });

    it('creates philosopher successor when dreamer has artifact but no successor', () => {
      insertTask({ taskId: 'dreamer-002', taskKind: 'dreamer', status: 'succeeded' });
      insertArtifact({ artifactId: 'art-002', sourceTaskId: 'dreamer-002', kind: 'principle', content: '{"valid":true}' });

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: false });

      const action = findAction(result.actions, 'dreamer-002', 'missing_philosopher_successor');
      expect(action?.recommendedAction).toBe('enqueue_successor');
      expect(action?.successorTaskId).toBeDefined();
    });

    it('skips philosopher successor creation when dreamer has no artifact (Case C)', () => {
      insertTask({ taskId: 'dreamer-003', taskKind: 'dreamer', status: 'succeeded' });

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: false });

      const action = findAction(result.actions, 'dreamer-003', 'missing_philosopher_successor');
      expect(action?.recommendedAction).toBe('skip_missing_artifact');
    });

    it('is idempotent — second confirm does not re-requeue or create duplicate successor', () => {
      insertTask({ taskId: 'dreamer-002', taskKind: 'dreamer', status: 'succeeded' });
      insertArtifact({ artifactId: 'art-002', sourceTaskId: 'dreamer-002', kind: 'principle', content: '{"valid":true}' });

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result1 = remediation.repair({ dryRun: false });
      const result2 = remediation.repair({ dryRun: false });

      expect(result1.repairedCount).toBeGreaterThan(0);
      expect(result2.repairedCount).toBe(0);
      expect(result2.actions.every(a => a.recommendedAction === 'already_repaired' || a.recommendedAction === 'successor_exists')).toBe(true);
    });

    it('increments repairedCount for each repaired action', () => {
      insertTask({ taskId: 'dreamer-a', taskKind: 'dreamer', status: 'succeeded' });
      insertTask({ taskId: 'dreamer-b', taskKind: 'dreamer', status: 'succeeded' });
      insertArtifact({ artifactId: 'art-b', sourceTaskId: 'dreamer-b', kind: 'principle', content: '{"valid":true}' });

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: false });

      expect(result.repairedCount).toBeGreaterThanOrEqual(2);
    });

    it('fails closed when DB is not readable', () => {
      const badDir = path.join(os.tmpdir(), 'nonexistent-' + Date.now());
      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: badDir });

      expect(() => remediation.repair({ dryRun: false })).toThrow();
    });

    it('JSON output includes repairedCount, skippedCount, actions', () => {
      insertTask({ taskId: 'dreamer-001', taskKind: 'dreamer', status: 'succeeded' });

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: false });

      expect(result).toHaveProperty('repairedCount');
      expect(result).toHaveProperty('skippedCount');
      expect(result).toHaveProperty('actions');
      expect(Array.isArray(result.actions)).toBe(true);
    });

    it('does not touch non-dreamer tasks', () => {
      insertTask({ taskId: 'diagnostician-001', taskKind: 'diagnostician', status: 'succeeded' });
      insertRun({ runId: 'run-diag-1', taskId: 'diagnostician-001', executionStatus: 'succeeded' });

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: false });

      expect(getTaskField('diagnostician-001', 'status')).toBe('succeeded');
      expect(result.actions.find(a => a.taskId === 'diagnostician-001')).toBeUndefined();
    });

    it('does not touch dreamer tasks with artifact and successor', () => {
      insertTask({ taskId: 'dreamer-ok', taskKind: 'dreamer', status: 'succeeded' });
      insertArtifact({ artifactId: 'art-ok', sourceTaskId: 'dreamer-ok', kind: 'principle', content: '{"valid":true}' });
      insertRun({ runId: 'run-dream-ok', taskId: 'dreamer-ok', executionStatus: 'succeeded' });
      insertTask({
        taskId: 'philosopher-ok',
        taskKind: 'philosopher',
        status: 'pending',
        diagnosticJson: JSON.stringify({ dependencyTaskIds: ['dreamer-ok'], channel: 'prompt' }),
      });

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: false });

      const action = result.actions.find(a => a.taskId === 'dreamer-ok');
      expect(action).toBeUndefined();
    });

    it('resets attempt_count to 0 when requeuing succeeded dreamer', () => {
      insertTask({ taskId: 'dreamer-maxed', taskKind: 'dreamer', status: 'succeeded', attemptCount: 3 });

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: false });

      expect(getTaskField('dreamer-maxed', 'status')).toBe('retry_wait');
      expect(getTaskField('dreamer-maxed', 'attempt_count')).toBe(0);

      const action = findAction(result.actions, 'dreamer-maxed', 'missing_dreamer_pi_artifact');
      expect(action?.newStatus).toBe('retry_wait');
    });
  });

  describe('lease_stuck and running_run_stuck', () => {
    it('dry-run reports lease_stuck as force_expire_lease action', () => {
      const pastDate = new Date(Date.now() - 60000).toISOString();

      const d = new Database(dbPath);
      d.prepare(
        "INSERT INTO tasks (task_id, task_kind, status, attempt_count, max_attempts, lease_owner, lease_expires_at) VALUES (?, ?, 'leased', 1, 3, ?, ?)"
      ).run('stuck-task', 'dreamer', 'auto-consumer', pastDate);
      insertRun({ runId: 'run-stuck', taskId: 'stuck-task', executionStatus: 'running' });
      d.close();

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: true });

      const action = findAction(result.actions, 'stuck-task', 'lease_stuck');
      expect(action).toBeDefined();
      expect(action?.recommendedAction).toBe('force_expire_lease');
      expect(action?.previousStatus).toBe('leased');
      expect(action?.newStatus).toBe('pending');

      // Verify DB not modified
      expect(getTaskField('stuck-task', 'status')).toBe('leased');
    });

    it('confirm force-expires stuck lease and marks run as failed', () => {
      const pastDate = new Date(Date.now() - 60000).toISOString();

      const d = new Database(dbPath);
      d.prepare(
        "INSERT INTO tasks (task_id, task_kind, status, attempt_count, max_attempts, lease_owner, lease_expires_at) VALUES (?, ?, 'leased', 1, 3, ?, ?)"
      ).run('stuck-task2', 'dreamer', 'auto-consumer', pastDate);
      insertRun({ runId: 'run-stuck2', taskId: 'stuck-task2', executionStatus: 'running' });
      d.close();

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: false });

      // Task should be force-expired to pending
      expect(getTaskField('stuck-task2', 'status')).toBe('pending');
      expect(getTaskField('stuck-task2', 'lease_owner')).toBeNull();

      // Run should be marked as failed
      expect(getRunField('run-stuck2', 'execution_status')).toBe('failed');
      expect(getRunField('run-stuck2', 'error_category')).toBe('lease_expired');

      const action = findAction(result.actions, 'stuck-task2', 'lease_stuck');
      expect(action).toBeDefined();
      expect(action?.recommendedAction).toBe('force_expire_lease');
    });

    it('is idempotent - second confirm skips already repaired lease_stuck', () => {
      const pastDate = new Date(Date.now() - 60000).toISOString();

      const d = new Database(dbPath);
      d.prepare(
        "INSERT INTO tasks (task_id, task_kind, status, attempt_count, max_attempts, lease_owner, lease_expires_at) VALUES (?, ?, 'leased', 1, 3, ?, ?)"
      ).run('stuck-idem', 'dreamer', 'auto-consumer', pastDate);
      insertRun({ runId: 'run-idem', taskId: 'stuck-idem', executionStatus: 'running' });
      d.close();

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result1 = remediation.repair({ dryRun: false });
      const result2 = remediation.repair({ dryRun: false });

      expect(result1.repairedCount).toBeGreaterThan(0);
      expect(result2.repairedCount).toBe(0);
      const secondActions = result2.actions.filter(a => a.type === 'lease_stuck');
      expect(secondActions.every(a => a.recommendedAction === 'already_repaired')).toBe(true);
    });

    it('dry-run reports running_run_stuck as mark_run_failed', () => {
      // Task is succeeded but run is still running — orphaned run
      const d = new Database(dbPath);
      d.prepare(
        "INSERT INTO tasks (task_id, task_kind, status, attempt_count, max_attempts) VALUES (?, ?, 'succeeded', 1, 3)"
      ).run('orphan-task', 'dreamer');
      insertRun({ runId: 'run-orphan', taskId: 'orphan-task', executionStatus: 'running' });
      d.close();

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: true });

      const action = findAction(result.actions, 'orphan-task', 'running_run_stuck');
      expect(action).toBeDefined();
      expect(action?.recommendedAction).toBe('mark_run_failed');
      expect(action?.previousStatus).toBe('running');
      expect(action?.newStatus).toBe('failed');

      // Verify DB not modified
      expect(getRunField('run-orphan', 'execution_status')).toBe('running');
    });

    it('confirm marks orphaned running run as failed', () => {
      const d = new Database(dbPath);
      d.prepare(
        "INSERT INTO tasks (task_id, task_kind, status, attempt_count, max_attempts) VALUES (?, ?, 'failed', 1, 3)"
      ).run('orphan-task2', 'dreamer');
      insertRun({ runId: 'run-orphan2', taskId: 'orphan-task2', executionStatus: 'running' });
      d.close();

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: false });

      // Run should be marked as failed
      expect(getRunField('run-orphan2', 'execution_status')).toBe('failed');

      const action = findAction(result.actions, 'orphan-task2', 'running_run_stuck');
      expect(action).toBeDefined();
      expect(action?.recommendedAction).toBe('mark_run_failed');
      expect(action?.reason).toContain('recovery repair');
    });

    it('skips running_run_stuck when run is already failed', () => {
      const d = new Database(dbPath);
      d.prepare(
        "INSERT INTO tasks (task_id, task_kind, status, attempt_count, max_attempts) VALUES (?, ?, 'failed', 1, 3)"
      ).run('orphan-task3', 'dreamer');
      insertRun({ runId: 'run-orphan3', taskId: 'orphan-task3', executionStatus: 'failed' });
      d.close();

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: false });

      expect(result.actions.filter(a => a.type === 'running_run_stuck').length).toBe(0);
    });

    it('combines lease_stuck + dreamer repair in one pass', () => {
      // A stuck lease + a succeeded dreamer with missing artifact
      const pastDate = new Date(Date.now() - 60000).toISOString();

      const d = new Database(dbPath);
      d.prepare(
        "INSERT INTO tasks (task_id, task_kind, status, attempt_count, max_attempts, lease_owner, lease_expires_at) VALUES (?, ?, 'leased', 1, 3, ?, ?)"
      ).run('stuck-combo', 'dreamer', 'auto-consumer', pastDate);
      insertRun({ runId: 'run-combo', taskId: 'stuck-combo', executionStatus: 'running' });
      insertTask({ taskId: 'dreamer-combo', taskKind: 'dreamer', status: 'succeeded' });
      d.close();

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: false });

      expect(getTaskField('stuck-combo', 'status')).toBe('pending');
      expect(getRunField('run-combo', 'execution_status')).toBe('failed');
      expect(getTaskField('dreamer-combo', 'status')).toBe('retry_wait');

      const leaseAction = findAction(result.actions, 'stuck-combo', 'lease_stuck');
      expect(leaseAction).toBeDefined();
      expect(leaseAction?.recommendedAction).toBe('force_expire_lease');

      const dreamerAction = findAction(result.actions, 'dreamer-combo', 'missing_dreamer_pi_artifact');
      expect(dreamerAction).toBeDefined();
      expect(dreamerAction?.recommendedAction).toBe('requeue');
    });

    it('refuses to repair unsafe stuck lease with null or unparseable lease_expires_at', () => {
      const d = new Database(dbPath);
      // null expires_at
      d.prepare(
        "INSERT INTO tasks (task_id, task_kind, status, attempt_count, max_attempts, lease_owner, lease_expires_at) VALUES (?, ?, 'leased', 1, 3, ?, NULL)"
      ).run('unsafe-null-task', 'dreamer', 'auto-consumer');
      // unparseable expires_at
      d.prepare(
        "INSERT INTO tasks (task_id, task_kind, status, attempt_count, max_attempts, lease_owner, lease_expires_at) VALUES (?, ?, 'leased', 1, 3, ?, ?)"
      ).run('unsafe-bad-task', 'dreamer', 'auto-consumer', 'not-a-date');
      d.close();

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: false });

      // DB should not be changed for these tasks
      expect(getTaskField('unsafe-null-task', 'status')).toBe('leased');
      expect(getTaskField('unsafe-bad-task', 'status')).toBe('leased');

      // Actions should refuse repair and warnings should be generated
      const actionNull = findAction(result.actions, 'unsafe-null-task', 'lease_stuck');
      expect(actionNull).toBeDefined();
      expect(actionNull?.action).toBe('refuse_repair');
      expect(actionNull?.recommendedAction).toBe('manual_intervention');
      expect(actionNull?.reason).toContain('missing/null');

      const actionBad = findAction(result.actions, 'unsafe-bad-task', 'lease_stuck');
      expect(actionBad).toBeDefined();
      expect(actionBad?.action).toBe('refuse_repair');
      expect(actionBad?.recommendedAction).toBe('manual_intervention');
      expect(actionBad?.reason).toContain('unparseable');

      expect(result.warnings.length).toBe(2);
      expect(result.safeToConfirm).toBe(false);
    });
  });

  // ── Malformed run row quarantine (PRI-392 follow-up) ────────────────────────
  describe('malformed run row quarantine', () => {
    /**
     * Insert a schema-malformed run row via raw SQL. runtime_kind='config'
     * is not in the RuntimeKindSchema enum, so Value.Check(RunRecordSchema)
     * fails — exactly the failure mode that throws MalformedRunError from
     * SqliteRunStore and historically blocked runner recovery.
     */
    function insertMalformedRunRow(runId: string, taskId: string): void {
      const d = new Database(dbPath);
      const now = new Date().toISOString();
      d.prepare(
        `INSERT OR REPLACE INTO runs (run_id, task_id, runtime_kind, started_at, attempt_number, execution_status, created_at, updated_at)
         VALUES (?, ?, 'config', ?, 1, 'queued', ?, ?)`,
      ).run(runId, taskId, now, now, now);
      d.close();
    }

    it('dry-run detects malformed run row but does NOT mutate DB', () => {
      // Need a task row so detection has something to attribute.
      insertTask({ taskId: 'malf-task-1', taskKind: 'dreamer', status: 'succeeded' });
      insertMalformedRunRow('run-malf-1', 'malf-task-1');

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: true });

      expect(result.dryRun).toBe(true);
      const action = findAction(result.actions, 'malf-task-1', 'malformed_run_row');
      expect(action).toBeDefined();
      expect(action?.targetId).toBe('run-malf-1');
      expect(action?.recommendedAction).toBe('quarantine_malformed_run');
      expect(action?.reason).toContain('schema validation');
      expect(action?.newStatus).toBe('failed');

      // Dry-run must NOT mutate the DB.
      expect(getRunField('run-malf-1', 'execution_status')).toBe('queued');
    });

    it('confirm refuses to repair malformed run row when required fields are unrecoverable', () => {
      insertTask({ taskId: 'malf-task-2', taskKind: 'dreamer', status: 'succeeded' });
      insertMalformedRunRow('run-malf-2', 'malf-task-2');

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: false });

      // runtime_kind='config' fails RuntimeKindSchema validation in
      // safeUpdateRunRow pre-write check → refuse_repair with manual_intervention
      const action = findAction(result.actions, 'malf-task-2', 'malformed_run_row');
      expect(action).toBeDefined();
      expect(action?.recommendedAction).toBe('manual_intervention');
      expect(action?.action).toBe('refuse_repair');

      // Row must NOT be mutated (we refused, not quarantined)
      expect(getRunField('run-malf-2', 'execution_status')).toBe('queued');
      expect(getRunField('run-malf-2', 'error_category')).toBeNull();

      // Warnings must be emitted explaining the refusal
      expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    });

    it('confirm quarantines malformed run row when optional fields are invalid (recoverable)', () => {
      insertTask({ taskId: 'malf-task-6', taskKind: 'dreamer', status: 'succeeded' });

      // Insert a row where required fields (task_id, runtime_kind, started_at,
      // created_at, attempt_number) are VALID, but execution_status is invalid.
      // rowToRecord fails because execution_status='invalid_status' is not a
      // valid RunExecutionStatus → detectMalformedRuns catches it.
      // safeUpdateRunRow replaces execution_status with 'failed' → quarantine succeeds.
      const d = new Database(dbPath);
      const now = new Date().toISOString();
      d.prepare(
        `INSERT OR REPLACE INTO runs (run_id, task_id, runtime_kind, started_at, attempt_number, execution_status, created_at, updated_at)
         VALUES (?, ?, 'openclaw', ?, 1, 'invalid_status', ?, ?)`,
      ).run('run-malf-6', 'malf-task-6', now, now, now);
      d.close();

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: false });

      expect(result.repairedCount).toBeGreaterThanOrEqual(1);
      const action = findAction(result.actions, 'malf-task-6', 'malformed_run_row');
      expect(action).toBeDefined();
      expect(action?.recommendedAction).toBe('quarantine_malformed_run');

      // Row must be quarantined
      expect(getRunField('run-malf-6', 'execution_status')).toBe('failed');
      expect(getRunField('run-malf-6', 'error_category')).toBe('storage_unavailable');
      const reason = getRunField('run-malf-6', 'reason');
      expect(String(reason)).toContain('quarantined');

      // Never marked succeeded
      expect(getRunField('run-malf-6', 'execution_status')).not.toBe('succeeded');
    });

    it('is idempotent — second confirm skips already-quarantined rows', () => {
      insertTask({ taskId: 'malf-task-3', taskKind: 'dreamer', status: 'succeeded' });
      // Use recoverable malformed row (invalid execution_status, valid runtime_kind)
      const d = new Database(dbPath);
      const now = new Date().toISOString();
      d.prepare(
        `INSERT OR REPLACE INTO runs (run_id, task_id, runtime_kind, started_at, attempt_number, execution_status, created_at, updated_at)
         VALUES (?, ?, 'openclaw', ?, 1, 'invalid_status', ?, ?)`,
      ).run('run-malf-3', 'malf-task-3', now, now, now);
      d.close();

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result1 = remediation.repair({ dryRun: false });
      const result2 = remediation.repair({ dryRun: false });

      // First run quarantines the row.
      const action1 = findAction(result1.actions, 'malf-task-3', 'malformed_run_row');
      expect(action1?.recommendedAction).toBe('quarantine_malformed_run');

      // Second run: row is already failed → already_repaired, no new mutation.
      const action2 = findAction(result2.actions, 'malf-task-3', 'malformed_run_row');
      expect(action2?.recommendedAction).toBe('already_repaired');
      // repairedCount on the second pass must not count the already-failed row.
      const secondQuarantineActions = result2.actions.filter(
        (a) => a.type === 'malformed_run_row' && a.recommendedAction === 'quarantine_malformed_run',
      );
      expect(secondQuarantineActions.length).toBe(0);
    });

    it('valid run rows are NOT flagged as malformed', () => {
      insertTask({ taskId: 'malf-task-4', taskKind: 'dreamer', status: 'succeeded' });
      // Insert a fully-valid run row.
      const d = new Database(dbPath);
      const now = new Date().toISOString();
      d.prepare(
        `INSERT INTO runs (run_id, task_id, runtime_kind, started_at, attempt_number, execution_status, created_at, updated_at)
         VALUES (?, ?, 'openclaw', ?, 1, 'succeeded', ?, ?)`,
      ).run('run-valid-4', 'malf-task-4', now, now, now);
      d.close();

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: true });

      const action = findAction(result.actions, 'malf-task-4', 'malformed_run_row');
      expect(action).toBeUndefined();
    });
  });

  describe('task_succeeded_no_succeeded_run', () => {
    it('dry-run reports task_succeeded_no_succeeded_run but does not mutate DB', () => {
      insertTask({ taskId: 'task-no-run-1', taskKind: 'diagnostician', status: 'succeeded' });

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: true });

      const action = findAction(result.actions, 'task-no-run-1', 'task_succeeded_no_succeeded_run');
      expect(action).toBeDefined();
      expect(action?.recommendedAction).toBe('supplement_succeeded_run');

      // Check that DB is not mutated (no run inserted)
      const d = new Database(dbPath);
      const row = d.prepare("SELECT 1 FROM runs WHERE task_id = 'task-no-run-1'").get();
      d.close();
      expect(row).toBeUndefined();
    });

    it('confirm supplements a canonical succeeded run and is schema-valid', () => {
      insertTask({ taskId: 'task-no-run-2', taskKind: 'diagnostician', status: 'succeeded' });

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: false });

      expect(result.repairedCount).toBe(1);
      const action = findAction(result.actions, 'task-no-run-2', 'task_succeeded_no_succeeded_run');
      expect(action).toBeDefined();
      expect(action?.recommendedAction).toBe('supplement_succeeded_run');

      // Check that DB contains a valid succeeded run
      const d = new Database(dbPath);
      const run = d.prepare("SELECT * FROM runs WHERE task_id = 'task-no-run-2' AND execution_status = 'succeeded'").get() as Record<string, unknown> | undefined;
      d.close();
      expect(run).toBeDefined();
      expect(run?.runtime_kind).toBe('openclaw');
      expect(run?.attempt_number).toBe(1);
      expect(run?.reason).toContain('Supplemented');
    });

    it('is idempotent — second confirm skips already-supplemented runs', () => {
      insertTask({ taskId: 'task-no-run-3', taskKind: 'diagnostician', status: 'succeeded' });

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result1 = remediation.repair({ dryRun: false });
      const result2 = remediation.repair({ dryRun: false });

      expect(result1.repairedCount).toBe(1);
      expect(result2.repairedCount).toBe(0);

      const action = findAction(result2.actions, 'task-no-run-3', 'task_succeeded_no_succeeded_run');
      expect(action).toBeUndefined();
    });

    it('dry-run reports supplement_succeeded_run when succeeded task has only malformed succeeded run rows', () => {
      insertTask({ taskId: 'task-malf-run', taskKind: 'diagnostician', status: 'succeeded' });

      // Insert a schema-invalid succeeded run (runtime_kind='config' not in RuntimeKindSchema)
      const d = new Database(dbPath);
      const now = new Date().toISOString();
      d.prepare(
        `INSERT OR REPLACE INTO runs (run_id, task_id, runtime_kind, started_at, attempt_number, execution_status, created_at, updated_at)
         VALUES (?, ?, 'config', ?, 1, 'succeeded', ?, ?)`,
      ).run('run-schema-invalid', 'task-malf-run', now, now, now);
      d.close();

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: true });

      // The malformed succeeded run is not a valid succeeded run, so
      // supplement_succeeded_run should be shown
      const action = findAction(result.actions, 'task-malf-run', 'task_succeeded_no_succeeded_run');
      expect(action).toBeDefined();
      expect(action?.recommendedAction).toBe('supplement_succeeded_run');

      // DB must NOT be mutated (dry-run)
      const d2 = new Database(dbPath);
      const rows = d2.prepare("SELECT execution_status FROM runs WHERE task_id = 'task-malf-run'").all() as { execution_status: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.execution_status).toBe('succeeded');
      d2.close();
    });
  });
});
