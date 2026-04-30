import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { describe, expect, it, afterEach } from 'vitest';
import { recordPainSignalObservability } from '../pain-signal-observability.js';

const tempDirs: string[] = [];

function makeWorkspace(): { workspaceDir: string; stateDir: string } {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'pd-observability-'));
  tempDirs.push(workspaceDir);
  return { workspaceDir, stateDir: join(workspaceDir, '.state') };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('recordPainSignalObservability', () => {
  it('records manual Runtime v2 pain signals without writing legacy evolution_tasks', () => {
    const { workspaceDir, stateDir } = makeWorkspace();
    const result = recordPainSignalObservability({
      workspaceDir,
      stateDir,
      data: {
        painId: 'manual_test_001',
        taskId: 'diagnosis_manual_test_001',
        painType: 'user_frustration',
        source: 'manual',
        reason: 'manual pain diagnosis',
        score: 95,
        sessionId: 'cli',
        agentId: 'pd-cli',
      },
    });

    expect(result.warnings).toEqual([]);
    expect(result.eventLogPath).toContain('events_');
    expect(result.evolutionStreamPath).toBe(join(workspaceDir, 'memory', 'evolution.jsonl'));
    expect(result.trajectoryPainEventId).toBeGreaterThan(0);
    const {eventLogPath} = result;
    const {evolutionStreamPath} = result;
    expect(eventLogPath).toBeDefined();
    expect(evolutionStreamPath).toBeDefined();

    const eventLogLine = readFileSync(String(eventLogPath), 'utf8').trim();
    expect(JSON.parse(eventLogLine)).toMatchObject({
      type: 'pain_signal',
      category: 'detected',
      sessionId: 'cli',
      data: {
        eventId: 'manual_test_001',
        score: 95,
        source: 'manual',
        origin: 'user_manual',
      },
    });

    const evolutionLine = readFileSync(String(evolutionStreamPath), 'utf8').trim();
    expect(JSON.parse(evolutionLine)).toMatchObject({
      type: 'pain_detected',
      data: {
        painId: 'manual_test_001',
        taskId: 'diagnosis_manual_test_001',
      },
    });

    const db = new Database(join(stateDir, 'trajectory.db'), { readonly: true });
    try {
      const painRow = db.prepare('SELECT session_id, source, score, reason FROM pain_events').get() as {
        session_id: string;
        source: string;
        score: number;
        reason: string;
      };
      expect(painRow).toEqual({
        session_id: 'cli',
        source: 'manual',
        score: 95,
        reason: 'manual pain diagnosis',
      });

      const hasEvolutionTasks = db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'evolution_tasks'
      `).get();
      expect(hasEvolutionTasks).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('records pain_events into an existing sessions table WITHOUT metadata_json column', () => {
    // Simulate an old workspace with legacy sessions schema (no metadata_json)
    const { workspaceDir, stateDir } = makeWorkspace();
    const dbPath = join(stateDir, 'trajectory.db');

    // Ensure stateDir exists before opening database
    mkdirSync(stateDir, { recursive: true });

    // Create legacy schema directly (old workspace snapshot)
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        started_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE pain_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        score INTEGER NOT NULL,
        reason TEXT,
        severity TEXT,
        origin TEXT,
        confidence REAL,
        text TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_pain_events_session_id ON pain_events(session_id);
      CREATE INDEX idx_pain_events_created_at ON pain_events(created_at);
    `);
    db.close();

    // recordPainSignalObservability should work without ALTER/DROP
    const result = recordPainSignalObservability({
      workspaceDir,
      stateDir,
      data: {
        painId: 'legacy_schema_test_001',
        taskId: 'diagnosis_legacy_schema_test_001',
        painType: 'user_frustration',
        source: 'manual',
        reason: 'legacy schema pain diagnosis',
        score: 85,
        sessionId: 'cli',
        agentId: 'pd-cli',
      },
    });

    expect(result.warnings).toEqual([]);
    expect(result.trajectoryPainEventId).toBeGreaterThan(0);

    // Verify pain_events was written
    const dbRead = new Database(join(stateDir, 'trajectory.db'), { readonly: true });
    try {
      const painRow = dbRead.prepare('SELECT session_id, source, score, reason FROM pain_events').get() as {
        session_id: string;
        source: string;
        score: number;
        reason: string;
      };
      expect(painRow).toEqual({
        session_id: 'cli',
        source: 'manual',
        score: 85,
        reason: 'legacy schema pain diagnosis',
      });

      // Verify sessions table was NOT modified (no metadata_json added)
      const sessionColumns = dbRead.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
      const columnNames = sessionColumns.map((c) => c.name);
      expect(columnNames).not.toContain('metadata_json');
      expect(columnNames).toContain('session_id');
      expect(columnNames).toContain('started_at');
      expect(columnNames).toContain('updated_at');
    } finally {
      dbRead.close();
    }
  });
});
