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
        status TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        output_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

      const remediation = new InternalizationIntegrityRemediation({ workspaceDir: tmpDir });
      const result = remediation.repair({ dryRun: false });

      expect(getTaskField('diagnostician-001', 'status')).toBe('succeeded');
      expect(result.actions.find(a => a.taskId === 'diagnostician-001')).toBeUndefined();
    });

    it('does not touch dreamer tasks with artifact and successor', () => {
      insertTask({ taskId: 'dreamer-ok', taskKind: 'dreamer', status: 'succeeded' });
      insertArtifact({ artifactId: 'art-ok', sourceTaskId: 'dreamer-ok', kind: 'principle', content: '{"valid":true}' });
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
});
