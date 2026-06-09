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
});
