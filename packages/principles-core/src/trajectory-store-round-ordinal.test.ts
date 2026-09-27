import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  nextSessionTurnOrdinal,
  resolveTrajectoryDbPath,
  TrajectoryDbUnavailableError,
} from './trajectory-store.js';

/**
 * PRI-904: the deterministic round fact behind prompt principle fair
 * rotation. These tests write REAL rows into a REAL trajectory.db (same
 * table, same path, same index the production writer uses) — no mocks, so
 * the +1 advancement contract is proven against the actual storage.
 */
let tmpDir: string;

function seedTrajectoryDb(): string {
  const stateDir = path.join(tmpDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  const dbPath = path.join(stateDir, 'trajectory.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE user_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      raw_text TEXT,
      correction_detected INTEGER DEFAULT 0,
      created_at TEXT
    );
    CREATE INDEX idx_user_turns_session_id ON user_turns(session_id);
  `);
  db.close();
  return dbPath;
}

function recordTurn(sessionId: string, turnIndex: number): void {
  const db = new Database(resolveTrajectoryDbPath(tmpDir));
  try {
    db.prepare(
      'INSERT INTO user_turns (session_id, turn_index, raw_text, correction_detected, created_at) VALUES (?, ?, ?, 0, ?)',
    ).run(sessionId, turnIndex, `user message ${turnIndex}`, new Date().toISOString());
  } finally {
    db.close();
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri904-round-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort (Windows handles) */ }
});

describe('nextSessionTurnOrdinal (PRI-904 deterministic round fact)', () => {
  it('returns 1 for a session with no recorded turn yet', () => {
    seedTrajectoryDb();
    expect(nextSessionTurnOrdinal(tmpDir, 'fresh-session')).toBe(1);
  });

  it('advances by exactly one per recorded user turn (the bounded-fairness precondition)', () => {
    seedTrajectoryDb();
    const observed: number[] = [];
    for (let turn = 1; turn <= 5; turn++) {
      observed.push(nextSessionTurnOrdinal(tmpDir, 's1'));
      recordTurn('s1', turn);
    }
    // Ordinals read across consecutive rounds: 1,2,3,4,5 — contiguous.
    expect(observed).toEqual([1, 2, 3, 4, 5]);
    expect(nextSessionTurnOrdinal(tmpDir, 's1')).toBe(6);
  });

  it('is scoped per session (two sessions advance independently)', () => {
    seedTrajectoryDb();
    recordTurn('a', 1);
    recordTurn('a', 2);
    recordTurn('b', 1);
    expect(nextSessionTurnOrdinal(tmpDir, 'a')).toBe(3);
    expect(nextSessionTurnOrdinal(tmpDir, 'b')).toBe(2);
  });

  it('consecutive ordinals cover every ring position within N rounds (INV-F02)', () => {
    seedTrajectoryDb();
    const N = 16;
    const starts: number[] = [];
    for (let round = 0; round < N; round++) {
      const ordinal = nextSessionTurnOrdinal(tmpDir, 'cover');
      starts.push(ordinal % N);
      recordTurn('cover', ordinal);
    }
    expect(new Set(starts).size).toBe(N); // every position exactly once
  });

  it('tolerates a non-1 base (pruned history) without breaking the +1 contract', () => {
    seedTrajectoryDb();
    recordTurn('s2', 111);
    recordTurn('s2', 112);
    expect(nextSessionTurnOrdinal(tmpDir, 's2')).toBe(113);
  });

  it('throws TrajectoryDbUnavailableError when the database does not exist (callers must degrade)', () => {
    expect(() => nextSessionTurnOrdinal(tmpDir, 'any')).toThrow(TrajectoryDbUnavailableError);
  });
});
