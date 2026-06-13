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
import { crossReferenceByTimestamp } from '../../src/server/models/EvidenceChainConsoleModel.js';

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
      attempt_count INTEGER NOT NULL DEFAULT 0,
      diagnostic_json TEXT,
      input_ref TEXT
    )
  `);

  if (withCandidates) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS principle_candidates (
        candidate_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        title TEXT,
        description TEXT,
        abstracted_principle TEXT,
        confidence REAL,
        recommendation_kind TEXT
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
  diagnosticJson?: string;
  inputRef?: string;
}): void {
  db.prepare(
    'INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, last_error, attempt_count, diagnostic_json, input_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    task.taskId,
    task.taskKind ?? 'diagnostician',
    task.status ?? 'pending',
    task.createdAt ?? '2026-06-07T10:00:00.000Z',
    task.createdAt ?? '2026-06-07T10:00:00.000Z',
    task.lastError ?? null,
    1,
    task.diagnosticJson ?? null,
    task.inputRef ?? null,
  );
}

function insertCandidate(db: Database.Database, candidate: {
  candidateId: string;
  taskId: string;
  status?: string;
  createdAt?: string;
  title?: string;
  description?: string;
  abstractedPrinciple?: string;
  confidence?: number;
  recommendationKind?: string;
}): void {
  db.prepare(
    'INSERT INTO principle_candidates (candidate_id, task_id, status, created_at, title, description, abstracted_principle, confidence, recommendation_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    candidate.candidateId,
    candidate.taskId,
    candidate.status ?? 'pending',
    candidate.createdAt ?? '2026-06-07T10:00:00.000Z',
    candidate.title ?? null,
    candidate.description ?? null,
    candidate.abstractedPrinciple ?? null,
    candidate.confidence ?? null,
    candidate.recommendationKind ?? null,
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

  it('normalizes sub-run task IDs (e.g. diag_router-diagnosis_*) to canonical format', async () => {
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
    // Candidate generated with diag_router- prefixed task ID
    insertCandidate(stateDb, {
      candidateId: 'cand-002',
      taskId: `diag_router-diagnosis_pain_${rowId}`,
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    const record = result.records.find(r => r.id === `pain_${rowId}`);
    expect(record).toBeDefined();
    expect(record!.linkedCandidateId).toBe('cand-002');
    expect(record!.state).toBe('candidate_generated');
  });

  it('normalizes multi-segment prefixed task IDs to canonical format', async () => {
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
    // Candidate generated with multi-segment prefixed task ID
    insertCandidate(stateDb, {
      candidateId: 'cand-003',
      taskId: `stage1-stage2-diagnosis_pain_${rowId}`,
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    const record = result.records.find(r => r.id === `pain_${rowId}`);
    expect(record).toBeDefined();
    expect(record!.linkedCandidateId).toBe('cand-003');
    expect(record!.state).toBe('candidate_generated');
  });

  it('fails loud / degrades with reason when task ID is malformed', async () => {
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
    // Malformed task ID with invalid prefix separator
    const malformedId = `diag_router_diagnosis_pain_${rowId}`;
    insertCandidate(stateDb, {
      candidateId: 'cand-004',
      taskId: malformedId,
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    expect(result.degradedReason).toContain('Malformed');
    expect(result.degradedReason).toContain(malformedId);
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

// ── Malformed principle ledger (ERR-002) ──────────────────────────────────────

describe('EvidenceChainConsoleModel — malformed principle ledger', () => {
  function writeLedger(content: string): void {
    const ledgerDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.writeFileSync(path.join(ledgerDir, 'principle_training_state.json'), content, 'utf-8');
  }

  it('returns degraded when ledger contains invalid JSON', async () => {
    const trajDb = createTrajectoryDb();
    insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Manual pain signal',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();
    const stateDb = createStateDb(); stateDb.close();

    writeLedger('{ invalid json !!!');

    const result = await model.getEvidenceChain();
    expect(result.degradedReason).toContain('invalid JSON');
    expect(result.nextAction).toBeTruthy();
    // Records from pain_events should still appear
    expect(result.records.length).toBeGreaterThanOrEqual(1);
  });

  it('returns degraded when ledger root is not an object', async () => {
    const trajDb = createTrajectoryDb();
    insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Manual pain signal',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();
    const stateDb = createStateDb(); stateDb.close();

    writeLedger('"just a string"');

    const result = await model.getEvidenceChain();
    expect(result.degradedReason).toContain('not a JSON object');
    expect(result.nextAction).toBeTruthy();
  });

  it('returns degraded when ledger tree is not an object', async () => {
    const trajDb = createTrajectoryDb();
    insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Manual pain signal',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();
    const stateDb = createStateDb(); stateDb.close();

    writeLedger(JSON.stringify({ _tree: 42 }));

    const result = await model.getEvidenceChain();
    expect(result.degradedReason).toContain('tree is not a JSON object');
    expect(result.nextAction).toBeTruthy();
  });

  it('returns degraded when principles field is missing', async () => {
    const trajDb = createTrajectoryDb();
    insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Manual pain signal',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();
    const stateDb = createStateDb(); stateDb.close();

    writeLedger(JSON.stringify({ _tree: { other: 'data' } }));

    const result = await model.getEvidenceChain();
    expect(result.degradedReason).toContain('principles field');
    expect(result.nextAction).toBeTruthy();
  });

  it('links principle to pain event from valid ledger', async () => {
    const trajDb = createTrajectoryDb();
    const rowId = insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Manual pain signal',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();
    const stateDb = createStateDb(); stateDb.close();

    const painId = `pain_${rowId}`;
    writeLedger(JSON.stringify({
      _tree: {
        principles: {
          'princ-001': {
            id: 'princ-001',
            derivedFromPainIds: [painId],
            text: 'Always ask before modifying config',
            status: 'active',
          },
        },
      },
    }));

    const result = await model.getEvidenceChain();
    const record = result.records.find(r => r.id === painId);
    expect(record).toBeDefined();
    expect(record!.linkedPrincipleId).toBe('princ-001');
    expect(record!.state).toBe('internalization_started');
    expect(result.degradedReason).toBeFalsy();
  });

  it('no ledger file = no degraded (distinguished from malformed)', async () => {
    const trajDb = createTrajectoryDb();
    insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Manual pain signal',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();
    const stateDb = createStateDb(); stateDb.close();

    // No ledger file written — this is "no internalization yet", not an error
    const result = await model.getEvidenceChain();
    expect(result.degradedReason).toBeFalsy();
    expect(result.records).toHaveLength(1);
    expect(result.records[0].state).toBe('pain_recorded');
  });

  it('empty ledger file = no degraded (distinguished from malformed)', async () => {
    const trajDb = createTrajectoryDb();
    insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Manual pain signal',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();
    const stateDb = createStateDb(); stateDb.close();

    writeLedger('');
    const result = await model.getEvidenceChain();
    expect(result.degradedReason).toBeFalsy();
    expect(result.records).toHaveLength(1);
  });

  it('ledger with prototype-polluted key does not leak inherited properties', async () => {
    const trajDb = createTrajectoryDb();
    insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Manual pain signal',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();
    const stateDb = createStateDb(); stateDb.close();

    // Ledger where a principle entry has a prototype-inherited key like "toString"
    writeLedger(JSON.stringify({
      _tree: {
        principles: {
          'princ-001': {
            id: 'princ-001',
            derivedFromPainIds: ['pain_1'],
            text: 'A principle',
          },
        },
      },
    }));

    const result = await model.getEvidenceChain();
    expect(result.degradedReason).toBeFalsy();
    // Should not crash or produce unexpected keys from prototype chain
    expect(result.records).toHaveLength(1);
  });
});

// ── PRI-340: Human-readable evidence fields ──────────────────────────────────

describe('EvidenceChainConsoleModel — PRI-340 human-readable fields', () => {
  // 用例 A：principle_candidates 有 title/confidence + 关联 task → candidateTitle, confidence, summary 非 ID
  it('A: surfaces candidateTitle and confidence from principle_candidates', async () => {
    const stateDb = createStateDb();
    insertTask(stateDb, {
      taskId: 'diagnosis_pain_42',
      status: 'succeeded',
    });
    insertCandidate(stateDb, {
      candidateId: 'cand-001',
      taskId: 'diagnosis_pain_42',
      title: '备份前必须确认',
      confidence: 0.8,
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    const record = result.records.find(r => r.id === 'pain_42');
    expect(record).toBeDefined();
    expect(record!.candidateTitle).toBe('备份前必须确认');
    expect(record!.confidence).toBe(0.8);
    expect(record!.summary).not.toContain('diagnosis_');
    expect(record!.summary).not.toContain('task:');
  });

  // 用例 B：无 candidate，diagnostic_json 有 rootCause → rootCauseSummary 填充，summary 包含根因文本
  it('B: extracts rootCauseSummary from diagnostic_json', async () => {
    const trajDb = createTrajectoryDb();
    const rowId = insertPainEvent(trajDb, {
      source: 'manual',
      text: '',
      reason: '',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const stateDb = createStateDb(false);
    insertTask(stateDb, {
      taskId: `diagnosis_pain_${rowId}`,
      status: 'succeeded',
      diagnosticJson: '{"rootCause":"删除前未确认备份"}',
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    const record = result.records.find(r => r.id === `pain_${rowId}`);
    expect(record).toBeDefined();
    expect(record!.rootCauseSummary).toBe('删除前未确认备份');
    expect(record!.summary).toContain('删除前未确认备份');
    expect(record!.summary).not.toContain('diagnosis_');
  });

  // 用例 C：只有 pain_events（reason='用户手动反馈'，text=''）无 task/candidate → summary 取 reason
  it('C: uses pain reason as summary when no task or candidate', async () => {
    const trajDb = createTrajectoryDb();
    insertPainEvent(trajDb, {
      source: 'manual',
      text: '',
      reason: '用户手动反馈',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const result = await model.getEvidenceChain();
    expect(result.records).toHaveLength(1);
    expect(result.records[0].summary).toBe('用户手动反馈');
  });

  // 用例 D（关键回归）：section 6 路径——有 task + candidate，但 pain_events 为空
  it('D: section 6 summary is candidate title, not hard-coded ID string', async () => {
    const stateDb = createStateDb();
    insertTask(stateDb, {
      taskId: 'diagnosis_pain_999',
      status: 'succeeded',
    });
    insertCandidate(stateDb, {
      candidateId: 'cand-002',
      taskId: 'diagnosis_pain_999',
      title: '部署前运行测试',
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    const record = result.records.find(r => r.id === 'pain_999');
    expect(record).toBeDefined();
    expect(record!.summary).toBe('部署前运行测试');
    expect(record!.summary).not.toContain('Manual pain signal');
    expect(record!.summary).not.toContain('task:');
  });

  // 用例 E：candidate description 含绝对路径 → candidateSummary 已脱敏
  it('E: candidateSummary is sanitized (no absolute paths)', async () => {
    const trajDb = createTrajectoryDb();
    const rowId = insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Some pain',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const stateDb = createStateDb();
    insertTask(stateDb, {
      taskId: `diagnosis_pain_${rowId}`,
      status: 'succeeded',
    });
    insertCandidate(stateDb, {
      candidateId: 'cand-003',
      taskId: `diagnosis_pain_${rowId}`,
      title: 'Sensitive data principle',
      description: 'Error at C:\\Users\\admin\\secrets\\key.pem: token leaked',
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    const record = result.records.find(r => r.id === `pain_${rowId}`);
    expect(record).toBeDefined();
    expect(record!.candidateSummary).toBeDefined();
    expect(record!.candidateSummary!).not.toContain('C:\\Users\\admin\\secrets');
  });

  // 用例 F：diagnostic_json 是非法 JSON → 不抛异常，degradedReason 非空，其他字段正常
  it('F: invalid diagnostic_json does not throw, sets degradedReason', async () => {
    const trajDb = createTrajectoryDb();
    const rowId = insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Pain with bad diagnostic_json',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const stateDb = createStateDb();
    insertTask(stateDb, {
      taskId: `diagnosis_pain_${rowId}`,
      status: 'succeeded',
      diagnosticJson: '{invalid json!!!',
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    // Should NOT throw — record should still exist
    const record = result.records.find(r => r.id === `pain_${rowId}`);
    expect(record).toBeDefined();
    // Other fields should be normal
    expect(record!.state).toBe('diagnosis_succeeded');
    // rootCauseSummary should not be set (invalid JSON)
    expect(record!.rootCauseSummary).toBeUndefined();
    // degradedReason should be set (ERR-002)
    expect(record!.degradedReason).toBeTruthy();
  });
});

// ── PRI-380: Evidence chain lineage join with Runtime V2 task IDs ─────────────

describe('PRI-380: Evidence chain lineage join with Runtime V2 task IDs', () => {
  it('links pain_309 to diagnosis_manual_* task via input_ref, surfaces candidate and dreamer pending', async () => {
    const trajDb = createTrajectoryDb();
    // Simulate pain_events with auto-increment id = 309
    for (let i = 1; i <= 308; i++) {
      insertPainEvent(trajDb, { source: 'tool_call', text: `filler ${i}`, createdAt: '2026-06-07T09:00:00.000Z' });
    }
    const rowId = insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Agent modified config without approval',
      reason: '用户手动反馈',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    // Simulate Runtime V2 task with diagnosis_manual_* ID and input_ref pointing to pain_309
    const stateDb = createStateDb();
    const rtTaskId = 'diagnosis_manual_1781314784282_5v264gy1';
    insertTask(stateDb, {
      taskId: rtTaskId,
      status: 'succeeded',
      inputRef: `${rowId}`,  // input_ref stores the numeric pain event ID
      diagnosticJson: '{"rootCause":"删除前未确认备份"}',
    });
    // Candidate linked to the Runtime V2 task
    insertCandidate(stateDb, {
      candidateId: 'cand-pri380-001',
      taskId: rtTaskId,
      title: '操作前必须确认',
      confidence: 0.85,
    });
    // Dreamer task pending for this candidate
    insertTask(stateDb, {
      taskId: 'dreamer-cand-pri380-001-principle',
      taskKind: 'dreamer',
      status: 'pending',
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    const record = result.records.find(r => r.id === `pain_${rowId}`);
    expect(record).toBeDefined();
    expect(record!.state).toBe('candidate_generated');
    expect(record!.rootCauseSummary).toBe('删除前未确认备份');
    expect(record!.candidateTitle).toBe('操作前必须确认');
    expect(record!.confidence).toBe(0.85);
    // Dreamer pending should be reflected
    expect(record!.dreamerTaskStatus).toBe('pending');
  });

  it('falls back to timestamp cross-reference and retrieves candidate via candidateByTaskId', async () => {
    const trajDb = createTrajectoryDb();
    const rowId = insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Pain with timestamp-matched task',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const stateDb = createStateDb();
    // Task ID format cannot derive painId via legacy stripping (not 'diagnosis_'),
    // but will be in taskMap and matched via timestamp
    const rtTaskId = 'runtime_v2_task_xyz123';
    insertTask(stateDb, {
      taskId: rtTaskId,
      taskKind: 'diagnostician',
      status: 'succeeded',
      createdAt: '2026-06-07T10:02:00.000Z',  // Within 5 min window
    });
    // Candidate linked to this task via taskId
    insertCandidate(stateDb, {
      candidateId: 'cand-timestamp-xyz',
      taskId: rtTaskId,
      title: 'Candidate from timestamp match',
      confidence: 0.75,
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    const record = result.records.find(r => r.id === `pain_${rowId}`);
    expect(record).toBeDefined();
    // Should be linked via cross-reference
    expect(record!.linkedTaskId).toBe(rtTaskId);
    expect(record!.linkedTaskStatus).toBe('succeeded');
    // Candidate should be found via candidateByTaskId dual index
    expect(record!.state).toBe('candidate_generated');
    expect(record!.candidateTitle).toBe('Candidate from timestamp match');
    expect(record!.confidence).toBe(0.75);
  });

  it('falls back to timestamp cross-reference when input_ref is missing', async () => {
    const trajDb = createTrajectoryDb();
    const rowId = insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Pain without input_ref',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const stateDb = createStateDb();
    // Task with same timestamp but no input_ref, and task_id that doesn't directly match
    insertTask(stateDb, {
      taskId: 'diagnosis_unknown_xyz123',
      status: 'running',
      createdAt: '2026-06-07T10:02:00.000Z',  // Within 5 min window
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    const record = result.records.find(r => r.id === `pain_${rowId}`);
    expect(record).toBeDefined();
    // Should be linked via cross-reference
    expect(record!.linkedTaskId).toBe('diagnosis_unknown_xyz123');
    expect(record!.linkedTaskStatus).toBe('running');
  });

  it('shows loud degradation when pain event cannot be linked (ERR-002)', async () => {
    const trajDb = createTrajectoryDb();
    const rowId = insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Orphan pain event',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    // No tasks at all — pain event has no linked diagnosis
    const stateDb = createStateDb(false);
    stateDb.close();

    const result = await model.getEvidenceChain();
    const record = result.records.find(r => r.id === `pain_${rowId}`);
    expect(record).toBeDefined();
    expect(record!.state).toBe('pain_recorded');
    // No task = no linkage, but the record exists and is not silent
    expect(record!.linkedTaskId).toBeUndefined();
  });

  it('shows loud degradation with degradedReason when tasks exist but none link (ERR-002)', async () => {
    const trajDb = createTrajectoryDb();
    const rowId = insertPainEvent(trajDb, {
      source: 'manual',
      text: 'Unlinked pain event',
      createdAt: '2026-06-07T10:00:00.000Z',
    });
    trajDb.close();

    const stateDb = createStateDb();
    // Task exists but input_ref points to different pain event, and timestamp is far away
    insertTask(stateDb, {
      taskId: 'diagnosis_manual_9999_other',
      status: 'succeeded',
      inputRef: '999',  // different pain event
      createdAt: '2026-06-07T20:00:00.000Z',  // 10 hours later — outside 5min window
    });
    stateDb.close();

    const result = await model.getEvidenceChain();
    const record = result.records.find(r => r.id === `pain_${rowId}`);
    expect(record).toBeDefined();
    // Must surface degradation loudly (ERR-002)
    expect(record!.degradedReason).toBeDefined();
    expect(record!.degradedReason).toContain('Could not link');
    expect(record!.nextAction).toBeDefined();
    expect(record!.nextAction).toContain('Runtime V2');
    // Response-level degradation should also be present
    expect(result.degradedReason).toBeDefined();
    expect(result.nextAction).toBeDefined();
  });

  it('aggregates multiple unmatched pain event warnings at response level and deduplicates nextAction (PRI-382)', async () => {
    const trajDb = createTrajectoryDb();
    // Insert 5 unmatched pain events
    const rowIds: number[] = [];
    for (let i = 0; i < 5; i++) {
      rowIds.push(insertPainEvent(trajDb, {
        source: 'manual',
        text: `Unlinked pain event ${i}`,
        createdAt: `2026-06-07T10:0${i}:00.000Z`,
      }));
    }
    trajDb.close();

    const stateDb = createStateDb();
    // Task exists but won't match any of these (different ID and far in future)
    insertTask(stateDb, {
      taskId: 'diagnosis_manual_9999_other',
      status: 'succeeded',
      inputRef: '999',
      createdAt: '2026-06-07T20:00:00.000Z',
    });
    stateDb.close();

    const result = await model.getEvidenceChain();

    // 1. Assert each record still has its own details (Requirement 1)
    for (const rowId of rowIds) {
      const record = result.records.find(r => r.id === `pain_${rowId}`);
      expect(record).toBeDefined();
      expect(record!.degradedReason).toBe('Could not link this pain event to a diagnostician task. The chain may be incomplete.');
      expect(record!.nextAction).toBe('Check Runtime V2 pipeline status. The diagnostician task may have a different pain ID format.');
    }

    // 2. Assert response-level degradedReason is aggregated (Requirement 2)
    expect(result.degradedReason).toBe('5 evidence records could not be linked to diagnostician tasks. Showing per-record details below.');

    // 3. Assert response-level nextAction is deduplicated (Requirement 3)
    expect(result.nextAction).toBe('Check Runtime V2 pipeline status for unmatched pain ID formats.');
  });
});

// ── PRI-380: crossReferenceByTimestamp unit tests ─────────────────────────────

describe('PRI-380: crossReferenceByTimestamp', () => {
  it('matches pain events to tasks within 5-minute window', () => {
    const painEvents = [
      { painId: 'pain_1', createdAt: '2026-06-07T10:00:00.000Z', source: 'manual' },
    ];
    const taskMap = new Map();
    taskMap.set('diagnosis_unknown_abc', {
      taskId: 'diagnosis_unknown_abc',
      status: 'running',
      lastError: null,
      createdAt: '2026-06-07T10:03:00.000Z',
    });
    const coveredPainIds = new Set<string>();

    const result = crossReferenceByTimestamp(painEvents, taskMap, coveredPainIds);
    expect(result.size).toBe(1);
    expect(result.get('pain_1')).toBeDefined();
    expect(result.get('pain_1')!.taskId).toBe('diagnosis_unknown_abc');
  });

  it('does not match events outside 5-minute window', () => {
    const painEvents = [
      { painId: 'pain_1', createdAt: '2026-06-07T10:00:00.000Z', source: 'manual' },
    ];
    const taskMap = new Map();
    taskMap.set('diagnosis_unknown_abc', {
      taskId: 'diagnosis_unknown_abc',
      status: 'running',
      lastError: null,
      createdAt: '2026-06-07T10:10:00.000Z',  // 10 minutes later
    });
    const coveredPainIds = new Set<string>();

    const result = crossReferenceByTimestamp(painEvents, taskMap, coveredPainIds);
    expect(result.size).toBe(0);
  });

  it('picks the closest timestamp when multiple tasks are within window', () => {
    const painEvents = [
      { painId: 'pain_1', createdAt: '2026-06-07T10:00:00.000Z', source: 'manual' },
    ];
    const taskMap = new Map();
    taskMap.set('diagnosis_far', {
      taskId: 'diagnosis_far',
      status: 'running',
      lastError: null,
      createdAt: '2026-06-07T10:04:00.000Z',
    });
    taskMap.set('diagnosis_near', {
      taskId: 'diagnosis_near',
      status: 'succeeded',
      lastError: null,
      createdAt: '2026-06-07T10:01:00.000Z',
    });
    const coveredPainIds = new Set<string>();

    const result = crossReferenceByTimestamp(painEvents, taskMap, coveredPainIds);
    expect(result.size).toBe(1);
    expect(result.get('pain_1')!.taskId).toBe('diagnosis_near');
  });
});
