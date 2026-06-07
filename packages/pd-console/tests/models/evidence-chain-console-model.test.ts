/**
 * EvidenceChainConsoleModel Tests — PRI-331
 *
 * Tests the evidence chain read model that reads from:
 * - pain_events table in trajectory.db
 * - tasks table in state.db
 * - principle_candidates table in state.db
 * - principle ledger JSON
 *
 * ERR entries:
 * - ERR-001/005: No `as` bypasses on untrusted data
 * - ERR-002: Degradation includes reason + nextAction, never silent fallback
 * - ERR-009: Required fields fail loud when missing
 * - ERR-014/016/017: Evidence previews bounded via sanitizeString
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { EvidenceChainConsoleModel } from '../../src/server/models/EvidenceChainConsoleModel.js';

// ── Test Setup ───────────────────────────────────────────────────────────────

let tempDir: string;
let workspaceDir: string;
let model: EvidenceChainConsoleModel;

function createTrajectoryDb(): Database.Database {
  const dbPath = path.join(workspaceDir, '.state', 'trajectory.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS pain_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      source TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      reason TEXT,
      severity TEXT,
      origin TEXT,
      confidence REAL,
      text TEXT,
      created_at TEXT NOT NULL
    )
  `);

  return db;
}

function createStateDb(withCandidates = true): Database.Database {
  const dbPath = path.join(workspaceDir, '.pd', 'state.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      task_kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  if (withCandidates) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS principle_candidates (
        candidate_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      )
    `);
  }

  return db;
}

function insertPainEvent(db: Database.Database, event: {
  sessionId?: string;
  source: string;
  score?: number;
  reason?: string;
  severity?: string;
  text?: string;
  createdAt?: string;
}): number {
  const info = db.prepare(
    'INSERT INTO pain_events (session_id, source, score, reason, severity, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    event.sessionId ?? 'session-001',
    event.source,
    event.score ?? 0.8,
    event.reason ?? '',
    event.severity ?? 'medium',
    event.text ?? 'Agent modified config without approval',
    event.createdAt ?? '2026-06-07T10:00:00.000Z',
  );
  return Number(info.lastInsertRowid);
}

function insertTask(db: Database.Database, task: {
  taskId: string;
  taskKind?: string;
  status?: string;
  createdAt?: string;
  lastError?: string;
}): void {
  db.prepare(
    'INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, last_error, attempt_count) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    task.taskId,
    task.taskKind ?? 'diagnostician',
    task.status ?? 'pending',
    task.createdAt ?? '2026-06-07T10:00:00.000Z',
    task.createdAt ?? '2026-06-07T10:00:00.000Z',
    task.lastError ?? null,
    1,
  );
}

function insertCandidate(db: Database.Database, candidate: {
  candidateId: string;
  taskId: string;
  status?: string;
  createdAt?: string;
}): void {
  db.prepare(
    'INSERT INTO principle_candidates (candidate_id, task_id, status, created_at) VALUES (?, ?, ?, ?)',
  ).run(
    candidate.candidateId,
    candidate.taskId,
    candidate.status ?? 'pending',
    candidate.createdAt ?? '2026-06-07T10:00:00.000Z',
  );
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-evidence-chain-'));
  workspaceDir = tempDir;
  model = new EvidenceChainConsoleModel(workspaceDir);
});

afterEach(() => {
  model.dispose();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── No data ───────────────────────────────────────────────────────────────────

describe('EvidenceChainConsoleModel — no data', () => {
  it('returns degraded when trajectory.db does not exist', async () => {
    const result = await model.getEvidenceChain();
    expect(result.degradedReason).toBeTruthy();
    expect(result.nextAction).toBeTruthy();
    expect(result.records).toHaveLength(0);
  });

  it('returns note when databases exist but are empty', async () => {
    const trajDb = createTrajectoryDb(); trajDb.close();
    const stateDb = createStateDb(); stateDb.close();
    const result = await model.getEvidenceChain();
    expect(result.note).toBeTruthy();
    expect(result.records).toHaveLength(0);
  });
});

// ── P1 fix: SQLite INTEGER PRIMARY KEY returns number ─────────────────────────

describe('EvidenceChainConsoleModel — numeric event.id (P1 fix)', () => {
  it('generates correct painId from numeric id — not pain_', async () => {
    const trajDb = createTrajectoryDb();
    const rowId = insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Manual pain signal',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    // SQLite AUTOINCREMENT returns a number
    expect(typeof rowId).toBe('number');
    expect(rowId).toBeGreaterThan(0);

    const result = await model.getEvidenceChain();
    expect(result.records).toHaveLength(1);
    // The painId must be "pain_<number>", never "pain_" (empty)
    expect(result.records[0].id).toBe(`pain_${rowId}`);
    expect(result.records[0].id).not.toBe('pain_');
  });

  it('links task to pain event when task ID matches diagnosis_pain_<numericId>', async () => {
    const trajDb = createTrajectoryDb();
    const rowId = insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Manual pain signal',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const stateDb = createStateDb();
    insertTask(stateDb, {
      taskId: `diagnosis_pain_${rowId}`,
      status: 'running',
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    expect(result.records).toHaveLength(1);
    expect(result.records[0].id).toBe(`pain_${rowId}`);
    expect(result.records[0].linkedTaskId).toBe(`diagnosis_pain_${rowId}`);
    expect(result.records[0].linkedTaskStatus).toBe('running');
    expect(result.records[0].state).toBe('diagnosis_running');
  });

  it('links candidate to pain event via task', async () => {
    const trajDb = createTrajectoryDb();
    const rowId = insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Manual pain signal',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const stateDb = createStateDb();
    insertTask(stateDb, {
      taskId: `diagnosis_pain_${rowId}`,
      status: 'succeeded',
    });
    insertCandidate(stateDb, {
      candidateId: 'cand-001',
      taskId: `diagnosis_pain_${rowId}`,
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    expect(result.records).toHaveLength(1);
    expect(result.records[0].linkedCandidateId).toBe('cand-001');
    expect(result.records[0].state).toBe('candidate_generated');
  });
});

// ── Manual pain with diagnosis ────────────────────────────────────────────────

describe('EvidenceChainConsoleModel — manual pain with diagnosis', () => {
  it('shows manual pain as pain_recorded', async () => {
    const trajDb = createTrajectoryDb();
    insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Agent modified config without approval',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const result = await model.getEvidenceChain();
    expect(result.records).toHaveLength(1);
    expect(result.records[0].sourceKind).toBe('manual');
    expect(result.records[0].state).toBe('pain_recorded');
    expect(result.records[0].admissionDecision).toBe('store_signal');
  });

  it('shows diagnosis_queued when task is pending', async () => {
    const trajDb = createTrajectoryDb();
    const rowId = insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Agent modified config without approval',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const stateDb = createStateDb();
    insertTask(stateDb, {
      taskId: `diagnosis_pain_${rowId}`,
      status: 'pending',
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    expect(result.records).toHaveLength(1);
    expect(result.records[0].state).toBe('diagnosis_queued');
    expect(result.records[0].linkedTaskId).toBe(`diagnosis_pain_${rowId}`);
  });
});

// ── Evidence-only not shown as pain ───────────────────────────────────────────

describe('EvidenceChainConsoleModel — evidence-only vs pain', () => {
  it('tool_call source shows as evidence_only', async () => {
    const trajDb = createTrajectoryDb();
    insertPainEvent(trajDb, {
      source: 'tool_call',
      text: 'Tool execution failed',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const result = await model.getEvidenceChain();
    expect(result.records).toHaveLength(1);
    expect(result.records[0].sourceKind).toBe('tool_call');
    expect(result.records[0].state).toBe('evidence_only');
    expect(result.records[0].admissionDecision).toBe('evidence_only');
  });

  it('manual source shows as pain_recorded (not evidence_only)', async () => {
    const trajDb = createTrajectoryDb();
    insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Manual pain signal',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const result = await model.getEvidenceChain();
    expect(result.records).toHaveLength(1);
    expect(result.records[0].state).toBe('pain_recorded');
    expect(result.records[0].state).not.toBe('evidence_only');
  });

  it('empathy_inferred source shows as owner_confirmation_required', async () => {
    const trajDb = createTrajectoryDb();
    insertPainEvent(trajDb, {
      source: 'empathy',
      text: 'Inferred discomfort',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const result = await model.getEvidenceChain();
    expect(result.records).toHaveLength(1);
    expect(result.records[0].sourceKind).toBe('empathy_inferred');
    expect(result.records[0].admissionDecision).toBe('owner_confirmation_required');
  });
});

// ── Diagnosis failed ──────────────────────────────────────────────────────────

describe('EvidenceChainConsoleModel — diagnosis failed', () => {
  it('shows diagnosis_failed with failure reason', async () => {
    const trajDb = createTrajectoryDb();
    const rowId = insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Manual pain signal',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const stateDb = createStateDb();
    insertTask(stateDb, {
      taskId: `diagnosis_pain_${rowId}`,
      status: 'failed',
      lastError: 'LLM returned invalid JSON response',
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    const failedRecord = result.records.find(r => r.id === `pain_${rowId}`);
    expect(failedRecord).toBeDefined();
    expect(failedRecord!.state).toBe('diagnosis_failed');
    expect(failedRecord!.failureReason).toContain('invalid JSON');
    expect(failedRecord!.nextAction).toBeTruthy();
  });

  it('shows diagnosis_retry_wait with nextAction', async () => {
    const trajDb = createTrajectoryDb();
    const rowId = insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Manual pain signal',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const stateDb = createStateDb();
    insertTask(stateDb, {
      taskId: `diagnosis_pain_${rowId}`,
      status: 'retry_wait',
      lastError: 'Rate limited',
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    const retryRecord = result.records.find(r => r.id === `pain_${rowId}`);
    expect(retryRecord).toBeDefined();
    expect(retryRecord!.state).toBe('diagnosis_retry_wait');
    expect(retryRecord!.nextAction).toBeTruthy();
  });
});

// ── Candidate generated ───────────────────────────────────────────────────────

describe('EvidenceChainConsoleModel — candidate generated', () => {
  it('shows candidate_generated with linked candidate', async () => {
    const trajDb = createTrajectoryDb();
    const rowId = insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Manual pain signal',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const stateDb = createStateDb();
    insertTask(stateDb, {
      taskId: `diagnosis_pain_${rowId}`,
      status: 'succeeded',
    });
    insertCandidate(stateDb, {
      candidateId: 'cand-001',
      taskId: `diagnosis_pain_${rowId}`,
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    const record = result.records.find(r => r.id === `pain_${rowId}`);
    expect(record).toBeDefined();
    expect(record!.linkedCandidateId).toBe('cand-001');
    expect(record!.state).toBe('candidate_generated');
  });
});

// ── Sanitizer boundary ────────────────────────────────────────────────────────

describe('EvidenceChainConsoleModel — sanitizer boundary', () => {
  it('summary does not contain raw absolute paths', async () => {
    const trajDb = createTrajectoryDb();
    insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Error at C:\\Users\\admin\\secrets\\key.pem: token sk-abcdefghijklmnopqrst leaked',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const result = await model.getEvidenceChain();
    expect(result.records).toHaveLength(1);
    expect(result.records[0].summary).not.toContain('C:\\Users\\admin\\secrets');
    expect(result.records[0].summary).not.toContain('sk-abcdefghijklmnopqrst');
  });

  it('failure reason does not contain raw stack traces', async () => {
    const trajDb = createTrajectoryDb();
    const rowId = insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Manual pain signal',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const stateDb = createStateDb();
    insertTask(stateDb, {
      taskId: `diagnosis_pain_${rowId}`,
      status: 'failed',
      lastError: 'Error at C:\\project\\node_modules\\xyz\\index.js:42\n  at processToken (C:\\project\\src\\handler.ts:15)',
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    const failedRecord = result.records.find(r => r.state === 'diagnosis_failed');
    expect(failedRecord).toBeDefined();
    expect(failedRecord!.failureReason).toBeDefined();
    expect(failedRecord!.failureReason!).not.toContain('C:\\project\\node_modules');
  });
});

// ── Missing table degradation ─────────────────────────────────────────────────

describe('EvidenceChainConsoleModel — missing table degradation', () => {
  it('returns degraded when pain_events table is missing', async () => {
    const dbPath = path.join(workspaceDir, '.state', 'trajectory.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec('CREATE TABLE other_table (id INTEGER)');
    db.close();

    const result = await model.getEvidenceChain();
    expect(result.degradedReason).toContain('pain_events');
    expect(result.nextAction).toBeTruthy();
  });

  it('returns degraded when candidates table is missing (ERR-002)', async () => {
    const trajDb = createTrajectoryDb();
    const rowId = insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Manual pain signal',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    // Create state.db WITHOUT principle_candidates table
    const stateDb = createStateDb(false);
    insertTask(stateDb, {
      taskId: `diagnosis_pain_${rowId}`,
      status: 'succeeded',
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    // ERR-002: must not silently swallow missing candidates table
    expect(result.degradedReason).toContain('Candidates table');
    expect(result.nextAction).toBeTruthy();
    // Record should still exist (from pain_events + tasks)
    expect(result.records.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Task-only records (no matching pain_event) ────────────────────────────────

describe('EvidenceChainConsoleModel — task-only records', () => {
  it('includes tasks that have no matching pain_event', async () => {
    const trajDb = createTrajectoryDb(); trajDb.close();

    const stateDb = createStateDb();
    insertTask(stateDb, {
      taskId: 'diagnosis_pain_manual_abc',
      status: 'failed',
      lastError: 'Diagnosis timeout',
      createdAt: '2026-06-07T09:00:00.000Z',
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    const taskOnlyRecord = result.records.find(r => r.linkedTaskId === 'diagnosis_pain_manual_abc');
    expect(taskOnlyRecord).toBeDefined();
    expect(taskOnlyRecord!.state).toBe('diagnosis_failed');
    expect(taskOnlyRecord!.failureReason).toContain('timeout');
  });
});
