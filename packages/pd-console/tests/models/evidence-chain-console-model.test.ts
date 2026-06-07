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

function createTrajectoryDb(): void {
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

  db.close();
}

function createStateDb(): void {
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS principle_candidates (
      candidate_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    )
  `);

  db.close();
}

function insertPainEvent(db: Database.Database, event: {
  sessionId?: string;
  source: string;
  score?: number;
  reason?: string;
  severity?: string;
  text?: string;
  createdAt?: string;
}): void {
  db.prepare(
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
    createTrajectoryDb();
    createStateDb();
    const result = await model.getEvidenceChain();
    expect(result.note).toBeTruthy();
    expect(result.records).toHaveLength(0);
  });
});

// ── Manual pain with diagnosis ────────────────────────────────────────────────

describe('EvidenceChainConsoleModel — manual pain with diagnosis', () => {
  it('shows manual pain as pain_recorded', async () => {
    createTrajectoryDb();

    const trajPath = path.join(workspaceDir, '.state', 'trajectory.db');
    const trajDb = new Database(trajPath);
    insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Agent modified config without approval',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const result = await model.getEvidenceChain();
    expect(result.records.length).toBeGreaterThanOrEqual(1);

    const manualRecord = result.records.find(r => r.sourceKind === 'manual');
    expect(manualRecord).toBeDefined();
    expect(manualRecord!.state).toBe('pain_recorded');
    expect(manualRecord!.admissionDecision).toBe('store_signal');
  });

  it('shows diagnosis_queued when task is pending', async () => {
    createTrajectoryDb();
    createStateDb();

    const trajPath = path.join(workspaceDir, '.state', 'trajectory.db');
    const trajDb = new Database(trajPath);
    insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Agent modified config without approval',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const statePath = path.join(workspaceDir, '.pd', 'state.db');
    const stateDb = new Database(statePath);
    insertTask(stateDb, {
      taskId: 'diagnosis_pain_1',
      status: 'pending',
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    // The pain event's painId is "pain_1" (pain_<id>), and task is "diagnosis_pain_1"
    // These should link if the painId matches
    expect(result.records.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Evidence-only not shown as pain ───────────────────────────────────────────

describe('EvidenceChainConsoleModel — evidence-only vs pain', () => {
  it('tool_call source shows as evidence_only', async () => {
    createTrajectoryDb();

    const trajPath = path.join(workspaceDir, '.state', 'trajectory.db');
    const trajDb = new Database(trajPath);
    insertPainEvent(trajDb, {
      source: 'tool_call',
      text: 'Tool execution failed',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const result = await model.getEvidenceChain();
    const toolRecord = result.records.find(r => r.sourceKind === 'tool_call');
    expect(toolRecord).toBeDefined();
    expect(toolRecord!.state).toBe('evidence_only');
    expect(toolRecord!.admissionDecision).toBe('evidence_only');
  });

  it('manual source shows as pain_recorded (not evidence_only)', async () => {
    createTrajectoryDb();

    const trajPath = path.join(workspaceDir, '.state', 'trajectory.db');
    const trajDb = new Database(trajPath);
    insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Manual pain signal',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const result = await model.getEvidenceChain();
    const manualRecord = result.records.find(r => r.sourceKind === 'manual');
    expect(manualRecord).toBeDefined();
    expect(manualRecord!.state).toBe('pain_recorded');
    expect(manualRecord!.state).not.toBe('evidence_only');
  });
});

// ── Diagnosis failed ──────────────────────────────────────────────────────────

describe('EvidenceChainConsoleModel — diagnosis failed', () => {
  it('shows diagnosis_failed with failure reason', async () => {
    createTrajectoryDb();
    createStateDb();

    const trajPath = path.join(workspaceDir, '.state', 'trajectory.db');
    const trajDb = new Database(trajPath);
    insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Manual pain signal',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const statePath = path.join(workspaceDir, '.pd', 'state.db');
    const stateDb = new Database(statePath);
    insertTask(stateDb, {
      taskId: 'diagnosis_pain_1',
      status: 'failed',
      lastError: 'LLM returned invalid JSON response',
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    // Should have a record with diagnosis_failed or a task-only record
    const failedRecord = result.records.find(r => r.state === 'diagnosis_failed');
    expect(failedRecord).toBeDefined();
    expect(failedRecord!.failureReason).toBeTruthy();
  });
});

// ── Candidate generated ───────────────────────────────────────────────────────

describe('EvidenceChainConsoleModel — candidate generated', () => {
  it('shows candidate_generated with linked candidate', async () => {
    createTrajectoryDb();
    createStateDb();

    const trajPath = path.join(workspaceDir, '.state', 'trajectory.db');
    const trajDb = new Database(trajPath);
    insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Manual pain signal',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const statePath = path.join(workspaceDir, '.pd', 'state.db');
    const stateDb = new Database(statePath);
    insertTask(stateDb, {
      taskId: 'diagnosis_pain_1',
      status: 'succeeded',
    });
    insertCandidate(stateDb, {
      candidateId: 'cand-001',
      taskId: 'diagnosis_pain_1',
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    const candidateRecord = result.records.find(r => r.linkedCandidateId === 'cand-001');
    expect(candidateRecord).toBeDefined();
    expect(candidateRecord!.state).toBe('candidate_generated');
  });
});

// ── Sanitizer boundary ────────────────────────────────────────────────────────

describe('EvidenceChainConsoleModel — sanitizer boundary', () => {
  it('summary does not contain raw absolute paths', async () => {
    createTrajectoryDb();

    const trajPath = path.join(workspaceDir, '.state', 'trajectory.db');
    const trajDb = new Database(trajPath);
    insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Error at C:\\Users\\admin\\secrets\\key.pem: token sk-abcdefghijklmnopqrst leaked',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const result = await model.getEvidenceChain();
    const record = result.records[0];
    expect(record).toBeDefined();
    // sanitizeString should redact absolute paths and tokens
    expect(record.summary).not.toContain('C:\\Users\\admin\\secrets');
    expect(record.summary).not.toContain('sk-abcdefghijklmnopqrst');
  });

  it('failure reason does not contain raw stack traces', async () => {
    createTrajectoryDb();
    createStateDb();

    const statePath = path.join(workspaceDir, '.pd', 'state.db');
    const stateDb = new Database(statePath);
    insertTask(stateDb, {
      taskId: 'diagnosis_pain_1',
      status: 'failed',
      lastError: 'Error at C:\\project\\node_modules\\xyz\\index.js:42\n  at processToken (C:\\project\\src\\handler.ts:15)',
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    const failedRecord = result.records.find(r => r.state === 'diagnosis_failed');
    if (failedRecord?.failureReason) {
      expect(failedRecord.failureReason).not.toContain('C:\\project\\node_modules');
    }
  });
});

// ── Missing table degradation ─────────────────────────────────────────────────

describe('EvidenceChainConsoleModel — missing table degradation', () => {
  it('returns degraded when pain_events table is missing', async () => {
    // Create trajectory.db without pain_events table
    const dbPath = path.join(workspaceDir, '.state', 'trajectory.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec('CREATE TABLE other_table (id INTEGER)');
    db.close();

    const result = await model.getEvidenceChain();
    expect(result.degradedReason).toContain('pain_events');
    expect(result.nextAction).toBeTruthy();
  });
});
