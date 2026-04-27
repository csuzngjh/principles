import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';

describe('E2E: pd candidate intake flow', () => {
  let tempWorkspace: string;
  let db: Database.Database;
  const pdCliPath = join(process.cwd(), 'packages/pd-cli/dist/index.js');

  beforeEach(() => {
    tempWorkspace = mkdtempSync(join(tmpdir(), 'pd-e2e-'));
    const pdDir = join(tempWorkspace, '.pd');
    mkdirSync(pdDir, { recursive: true });

    const dbPath = join(pdDir, 'state.db');
    db = new Database(dbPath);

    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        task_kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        last_error TEXT,
        input_ref TEXT,
        result_ref TEXT,
        diagnostic_json TEXT
      );

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        runtime_kind TEXT NOT NULL,
        execution_status TEXT NOT NULL DEFAULT 'queued',
        started_at TEXT NOT NULL,
        ended_at TEXT,
        reason TEXT,
        output_ref TEXT,
        input_payload TEXT,
        output_payload TEXT,
        error_category TEXT,
        attempt_number INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        artifact_kind TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS commits (
        commit_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        artifact_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'committed',
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
        FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS principle_candidates (
        candidate_id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        confidence REAL,
        source_recommendation_json TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY (source_run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );
    `);
  });

  afterEach(() => {
    if (db) db.close();
    if (existsSync(tempWorkspace)) {
      rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });

  function insertPendingCandidate(candidateId: string, taskId: string, artifactId: string, runId: string) {
    const now = new Date().toISOString();

    db.prepare('INSERT OR IGNORE INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, 'diagnostician', 'succeeded', now, now);

    db.prepare('INSERT OR IGNORE INTO runs (run_id, task_id, runtime_kind, execution_status, attempt_number, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(runId, taskId, 'openclaw-cli', 'completed', 1, now, now, now);

    const artifactContent = JSON.stringify({
      recommendation: {
        title: 'Test Principle',
        text: 'Always write tests',
        triggerPattern: 'missing tests',
        action: 'add test files',
      },
    });
    db.prepare('INSERT OR IGNORE INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(artifactId, runId, taskId, 'diagnostician_output_v1', artifactContent, now);

    db.prepare('INSERT OR IGNORE INTO commits (commit_id, task_id, run_id, artifact_id, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`commit-${candidateId}`, taskId, runId, artifactId, `key-${candidateId}`, 'committed', now);

    db.prepare(`INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence, source_recommendation_json, idempotency_key, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(candidateId, artifactId, taskId, runId, 'Test Principle', 'Always write tests', 0.95, artifactContent, `candidate-key-${candidateId}`, 'pending', now);
  }

  function runPdCommand(args: string[]): { stdout: string; stderr: string; status: number } {
    try {
      const stdout = execFileSync('node', [pdCliPath, ...args], {
        env: { ...process.env, NODE_PATH: '' },
        encoding: 'utf-8',
        timeout: 30000,
      });
      return { stdout, stderr: '', status: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || '',
        status: err.status || 1,
      };
    }
  }

  function readLedgerFile(workspace: string): any[] {
    const ledgerPath = join(workspace, '.pd', 'principle-tree-ledger.json');
    if (!existsSync(ledgerPath)) return [];
    const content = readFileSync(ledgerPath, 'utf-8');
    const data = JSON.parse(content);
    return data.principles || [];
  }

  it('Test 1 (Happy path E2E): pending candidate → intake → consumed → ledgerEntryId in output', () => {
    const candidateId = 'e2e-cand-001';
    const taskId = 'e2e-task-001';
    const artifactId = 'e2e-art-001';
    const runId = 'e2e-run-001';

    insertPendingCandidate(candidateId, taskId, artifactId, runId);

    const { stdout, status } = runPdCommand([
      'candidate', 'intake',
      '--candidate-id', candidateId,
      '--workspace', tempWorkspace,
      '--json',
    ]);

    expect(status).toBe(0);

    const result = JSON.parse(stdout);
    expect(result.candidateId).toBe(candidateId);
    expect(result.status).toBe('consumed');
    expect(result.ledgerEntryId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('Test 2 (Ledger entry created): ledger file contains entry with correct sourceRef', () => {
    const candidateId = 'e2e-cand-002';
    const taskId = 'e2e-task-002';
    const artifactId = 'e2e-art-002';
    const runId = 'e2e-run-002';

    insertPendingCandidate(candidateId, taskId, artifactId, runId);

    runPdCommand([
      'candidate', 'intake',
      '--candidate-id', candidateId,
      '--workspace', tempWorkspace,
      '--json',
    ]);

    const ledgerEntries = readLedgerFile(tempWorkspace);
    expect(ledgerEntries.length).toBe(1);
    expect(ledgerEntries[0].sourceRef).toBe(`candidate://${candidateId}`);
    expect(ledgerEntries[0].status).toBe('probation');
    expect(ledgerEntries[0].evaluability).toBe('weak_heuristic');
  });

  it('Test 3 (Idempotency): intake same candidate twice → one ledger entry, no duplicate', () => {
    const candidateId = 'e2e-cand-003';
    const taskId = 'e2e-task-003';
    const artifactId = 'e2e-art-003';
    const runId = 'e2e-run-003';

    insertPendingCandidate(candidateId, taskId, artifactId, runId);

    const { stdout: stdout1 } = runPdCommand([
      'candidate', 'intake',
      '--candidate-id', candidateId,
      '--workspace', tempWorkspace,
      '--json',
    ]);
    const result1 = JSON.parse(stdout1);
    expect(result1.status).toBe('consumed');

    const { stdout: stdout2, status: status2 } = runPdCommand([
      'candidate', 'intake',
      '--candidate-id', candidateId,
      '--workspace', tempWorkspace,
      '--json',
    ]);
    expect(status2).toBe(0);
    const result2 = JSON.parse(stdout2);
    expect(result2.status).toBe('already_consumed');
    expect(result2.ledgerEntryId).toBe(result1.ledgerEntryId);

    const ledgerEntries = readLedgerFile(tempWorkspace);
    expect(ledgerEntries.length).toBe(1);
  });

  it('Test 4 (pd candidate list): shows candidate with consumed status after intake', () => {
    const candidateId = 'e2e-cand-004';
    const taskId = 'e2e-task-004';
    const artifactId = 'e2e-art-004';
    const runId = 'e2e-run-004';

    insertPendingCandidate(candidateId, taskId, artifactId, runId);

    runPdCommand([
      'candidate', 'intake',
      '--candidate-id', candidateId,
      '--workspace', tempWorkspace,
      '--json',
    ]);

    const { stdout, status } = runPdCommand([
      'candidate', 'list',
      '--task-id', taskId,
      '--workspace', tempWorkspace,
      '--json',
    ]);
    expect(status).toBe(0);

    const result = JSON.parse(stdout);
    expect(result.taskId).toBe(taskId);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].candidateId).toBe(candidateId);
    expect(result.candidates[0].status).toBe('consumed');
  });

  it('Test 5 (pd candidate show with ledger link): shows ledgerEntryId after intake', () => {
    const candidateId = 'e2e-cand-005';
    const taskId = 'e2e-task-005';
    const artifactId = 'e2e-art-005';
    const runId = 'e2e-run-005';

    insertPendingCandidate(candidateId, taskId, artifactId, runId);

    const { stdout: intakeStdout } = runPdCommand([
      'candidate', 'intake',
      '--candidate-id', candidateId,
      '--workspace', tempWorkspace,
      '--json',
    ]);
    const intakeResult = JSON.parse(intakeStdout);
    const ledgerEntryId = intakeResult.ledgerEntryId;

    const { stdout, status } = runPdCommand([
      'candidate', 'show',
      candidateId,
      '--workspace', tempWorkspace,
      '--json',
    ]);
    expect(status).toBe(0);

    const result = JSON.parse(stdout);
    expect(result.candidateId).toBe(candidateId);
    expect(result.status).toBe('consumed');
    expect(result.ledgerEntryId).toBe(ledgerEntryId);
  });

  it('Test 6 (DB state): candidate status is consumed in DB after intake', () => {
    const candidateId = 'e2e-cand-006';
    const taskId = 'e2e-task-006';
    const artifactId = 'e2e-art-006';
    const runId = 'e2e-run-006';

    insertPendingCandidate(candidateId, taskId, artifactId, runId);

    runPdCommand([
      'candidate', 'intake',
      '--candidate-id', candidateId,
      '--workspace', tempWorkspace,
      '--json',
    ]);

    const row = db.prepare('SELECT status FROM principle_candidates WHERE candidate_id = ?')
      .get(candidateId) as { status: string };
    expect(row.status).toBe('consumed');
  });
});
