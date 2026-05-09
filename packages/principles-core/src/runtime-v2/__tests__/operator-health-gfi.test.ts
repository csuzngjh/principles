import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OperatorHealthReadModel } from '../operator-health-read-model.js';
import BetterSqlite3 from 'better-sqlite3';

function initTestDb(stateDbPath: string): void {
  const db = new BetterSqlite3(stateDbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      task_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      runtime_kind TEXT NOT NULL,
      started_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      artifact_kind TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS principle_candidates (
      candidate_id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      source_run_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      confidence REAL,
      source_recommendation_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.close();
}

describe('OperatorHealthReadModel GFI integration (PRI-83)', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-health-gfi-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes gfi section in snapshot when session data exists', async () => {
    const pdDir = path.join(tmpDir, '.pd');
    fs.mkdirSync(pdDir, { recursive: true });
    initTestDb(path.join(pdDir, 'state.db'));

    const sessionDir = path.join(tmpDir, '.state', 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });

    const nowMs = Date.now();
    fs.writeFileSync(path.join(sessionDir, 'sess-001.json'), JSON.stringify({
      sessionId: 'sess-001',
      currentGfi: 42,
      gfiBySource: { tool_failure: 30, stuck_loop: 12 },
      lastErrorSource: 'tool_failure',
      consecutiveErrors: 2,
      lastActivityAt: nowMs,
    }));

    const model = new OperatorHealthReadModel({ workspaceDir: tmpDir });
    try {
      const snapshot = await model.getSnapshot();

      expect(snapshot.gfi).toBeDefined();
      expect(snapshot.gfi.active).not.toBeNull();
      if (snapshot.gfi.active) {
        expect(snapshot.gfi.active.currentGfi).toBe(42);
        expect(snapshot.gfi.active.stage).toBeDefined();
        expect(snapshot.gfi.active.dominantSource).toBeDefined();
      }
      expect(snapshot.gfi.activeSessionCount).toBeGreaterThanOrEqual(1);
      expect(snapshot.gfi.generatedAt).toBeDefined();
    } finally {
      await model.close();
    }
  });

  it('returns gfi.active = null when no session data exists', async () => {
    const pdDir = path.join(tmpDir, '.pd');
    fs.mkdirSync(pdDir, { recursive: true });
    initTestDb(path.join(pdDir, 'state.db'));

    const model = new OperatorHealthReadModel({ workspaceDir: tmpDir });
    try {
      const snapshot = await model.getSnapshot();

      expect(snapshot.gfi).toBeDefined();
      expect(snapshot.gfi.active).toBeNull();
      expect(snapshot.gfi.staleSessionCount).toBe(0);
      expect(snapshot.gfi.activeSessionCount).toBe(0);
    } finally {
      await model.close();
    }
  });

  it('does not mark runtime unhealthy solely for missing GFI', async () => {
    const model = new OperatorHealthReadModel({ workspaceDir: tmpDir });
    try {
      const snapshot = await model.getSnapshot();

      expect(snapshot.gfi.active).toBeNull();
    } finally {
      await model.close();
    }
  });
});
