/**
 * Tests for buildTrajectoryEvidenceFromDb — PRI-341
 *
 * Uses real temporary SQLite DBs (trajectory.db) to validate evidence extraction.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MAX_EVIDENCE_ENTRIES } from '@principles/core/runtime-v2';
import { buildTrajectoryEvidenceFromDb } from '../../src/commands/build-trajectory-evidence.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let stateDir: string;

function createStateDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-test-'));
  stateDir = path.join(tmpDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

function createTrajectoryDb(): Database.Database {
  const dbPath = path.join(stateDir, 'trajectory.db');
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      started_at TEXT,
      updated_at TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      run_id TEXT,
      provider TEXT,
      model TEXT,
      raw_text TEXT,
      sanitized_text TEXT,
      blob_ref TEXT,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL DEFAULT 0,
      raw_excerpt TEXT,
      correction_detected INTEGER NOT NULL DEFAULT 0,
      correction_cue TEXT,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      outcome TEXT NOT NULL,
      duration_ms INTEGER,
      exit_code INTEGER,
      error_type TEXT,
      error_message TEXT,
      gfi_before REAL,
      gfi_after REAL,
      params_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )
  `);

  return db;
}

function insertAssistantTurn(
  db: Database.Database,
  sessionId: string,
  sanitizedText: string,
  createdAt: string,
): void {
  db.prepare(`
    INSERT INTO assistant_turns (session_id, sanitized_text, created_at)
    VALUES (?, ?, ?)
  `).run(sessionId, sanitizedText, createdAt);
}

function insertUserTurn(
  db: Database.Database,
  sessionId: string,
  rawExcerpt: string,
  correctionDetected: boolean,
  createdAt: string,
): void {
  db.prepare(`
    INSERT INTO user_turns (session_id, turn_index, raw_excerpt, correction_detected, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, 0, rawExcerpt, correctionDetected ? 1 : 0, createdAt);
}

function insertToolCall(
  db: Database.Database,
  sessionId: string,
  toolName: string,
  outcome: string,
  errorType: string | null,
  exitCode: number | null,
  createdAt: string,
): void {
  db.prepare(`
    INSERT INTO tool_calls (session_id, tool_name, outcome, error_type, exit_code, duration_ms, params_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, toolName, outcome, errorType, exitCode, 100, '{}', createdAt);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('buildTrajectoryEvidenceFromDb — PRI-341', () => {
  beforeEach(() => {
    createStateDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // 用例 A: trajectory.db contains 3 assistant turns for session '123'
  // → returns evidence with length ≤ MAX_EVIDENCE_ENTRIES, each entry has sourceRef and note
  it('A: returns evidence entries from assistant turns (≤ MAX_EVIDENCE_ENTRIES)', () => {
    const db = createTrajectoryDb();
    insertAssistantTurn(db, '123', 'First assistant response about backups', '2026-01-01T10:00:00Z');
    insertAssistantTurn(db, '123', 'Second response about validation', '2026-01-01T10:01:00Z');
    insertAssistantTurn(db, '123', 'Third response about error handling', '2026-01-01T10:02:00Z');
    db.close();

    const evidence = buildTrajectoryEvidenceFromDb(stateDir, '123', tmpDir);

    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE_ENTRIES);
    for (const entry of evidence) {
      expect(entry.sourceRef).toBeTruthy();
      expect(entry.note).toBeTruthy();
      expect(typeof entry.sourceRef).toBe('string');
      expect(typeof entry.note).toBe('string');
    }
  });

  // 用例 B: sessionId is undefined or trajectory.db doesn't exist
  // → returns placeholder entry, does not throw, does not return empty array
  it('B: returns placeholder when sessionId is undefined', () => {
    const evidence = buildTrajectoryEvidenceFromDb(stateDir, undefined, tmpDir);

    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence[0].sourceRef).toBe('owner_reported:cli');
    expect(evidence[0].note).toBeTruthy();
  });

  it('B2: returns placeholder when trajectory.db does not exist', () => {
    const evidence = buildTrajectoryEvidenceFromDb(stateDir, 'some-session', tmpDir);

    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence[0].sourceRef).toBe('owner_reported:cli');
  });

  it('B3: returns placeholder when sessionId is "cli"', () => {
    const evidence = buildTrajectoryEvidenceFromDb(stateDir, 'cli', tmpDir);

    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence[0].sourceRef).toBe('owner_reported:cli');
  });

  // Additional: user correction turns are surfaced
  it('surfaces user correction turns with correctionDetected=true', () => {
    const db = createTrajectoryDb();
    insertUserTurn(db, '123', 'Please fix the backup logic', true, '2026-01-01T09:59:00Z');
    insertAssistantTurn(db, '123', 'I will fix the backup logic', '2026-01-01T10:00:00Z');
    db.close();

    const evidence = buildTrajectoryEvidenceFromDb(stateDir, '123', tmpDir);

    expect(evidence.length).toBeGreaterThan(0);
    const ownerEntry = evidence.find(e => e.sourceRef.startsWith('owner_message:'));
    expect(ownerEntry).toBeDefined();
    expect(ownerEntry!.note).toContain('fix the backup logic');
  });

  // Additional: empty trajectory DB (tables exist but no rows) → meaningful placeholder
  it('returns trajectory:empty placeholder when DB has no turns for session', () => {
    const db = createTrajectoryDb();
    db.close();

    const evidence = buildTrajectoryEvidenceFromDb(stateDir, 'nonexistent-session', tmpDir);

    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence[0].sourceRef).toBe('trajectory:empty');
  });

  // ── PRI-358: Failed tool_calls evidence ────────────────────────────────────

  describe('PRI-358: failed tool_calls evidence', () => {
    it('extracts failed tool_calls as evidence entries', () => {
      const db = createTrajectoryDb();
      insertToolCall(db, '123', 'bash', 'failure', 'non_zero_exit', 1, '2026-01-01T10:00:00Z');
      insertToolCall(db, '123', 'write_file', 'success', null, 0, '2026-01-01T10:01:00Z');
      insertToolCall(db, '123', 'bash', 'failure', 'timeout', 124, '2026-01-01T10:02:00Z');
      db.close();

      const evidence = buildTrajectoryEvidenceFromDb(stateDir, '123', tmpDir);

      const failureEntries = evidence.filter(e => e.sourceRef.startsWith('tool_call_failure:'));
      expect(failureEntries.length).toBe(2);
      expect(failureEntries[0].note).toContain('bash');
      expect(failureEntries[0].note).toContain('non_zero_exit');
      expect(failureEntries[1].note).toContain('timeout');
    });

    it('does not add tool_call_failure entries when no failures exist', () => {
      const db = createTrajectoryDb();
      insertToolCall(db, '123', 'bash', 'success', null, 0, '2026-01-01T10:00:00Z');
      db.close();

      const evidence = buildTrajectoryEvidenceFromDb(stateDir, '123', tmpDir);

      const failureEntries = evidence.filter(e => e.sourceRef.startsWith('tool_call_failure:'));
      expect(failureEntries.length).toBe(0);
    });

    it('limits failed tool_calls to 3 entries', () => {
      const db = createTrajectoryDb();
      insertToolCall(db, '123', 'bash', 'failure', 'err1', 1, '2026-01-01T10:00:00Z');
      insertToolCall(db, '123', 'bash', 'failure', 'err2', 2, '2026-01-01T10:01:00Z');
      insertToolCall(db, '123', 'bash', 'failure', 'err3', 3, '2026-01-01T10:02:00Z');
      insertToolCall(db, '123', 'bash', 'failure', 'err4', 4, '2026-01-01T10:03:00Z');
      db.close();

      const evidence = buildTrajectoryEvidenceFromDb(stateDir, '123', tmpDir);

      const failureEntries = evidence.filter(e => e.sourceRef.startsWith('tool_call_failure:'));
      expect(failureEntries.length).toBe(3);
    });

    it('handles missing tool_calls table gracefully', () => {
      // Create DB without tool_calls table
      const dbPath = path.join(stateDir, 'trajectory.db');
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, started_at TEXT, updated_at TEXT)
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS assistant_turns (
          id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
          sanitized_text TEXT, created_at TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_turns (
          id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
          turn_index INTEGER NOT NULL DEFAULT 0, raw_excerpt TEXT,
          correction_detected INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
        )
      `);
      db.close();

      const evidence = buildTrajectoryEvidenceFromDb(stateDir, '123', tmpDir);

      // Should not throw, should have some evidence (trajectory:empty or unavailable)
      expect(evidence.length).toBeGreaterThan(0);
      // Should NOT have tool_call_failure:unavailable since we have no other evidence
      // and the table simply doesn't exist (not an error condition worth reporting)
    });
  });
});
