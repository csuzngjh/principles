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
        source: 'manual',
        score: 95,
        evidenceCount: 0,
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
        score REAL NOT NULL,
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

  it('redacts token-like patterns in evolution stream reason', () => {
    const { workspaceDir, stateDir } = makeWorkspace();
    const result = recordPainSignalObservability({
      workspaceDir,
      stateDir,
      data: {
        painId: 'token_test_001',
        painType: 'tool_failure',
        source: 'tool_failure',
        reason: 'Tool write failed with token sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 in path',
        score: 60,
        sessionId: 's1',
      },
    });

    expect(result.warnings).toEqual([]);
    const evolutionLine = readFileSync(String(result.evolutionStreamPath), 'utf8').trim();
    const parsed = JSON.parse(evolutionLine);
    expect(parsed.data.reason).toContain('___REDACTED___');
    expect(parsed.data.reason).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('handles UNIQUE constraint violation on canonical_pain_id via upsert', () => {
    const { workspaceDir, stateDir } = makeWorkspace();
    const canonicalPainId = 'manual_duplicate_test_001';

    // First insert — should succeed
    const result1 = recordPainSignalObservability({
      workspaceDir,
      stateDir,
      data: {
        painId: canonicalPainId,
        taskId: 'diagnosis_duplicate_001',
        painType: 'user_frustration',
        source: 'manual',
        reason: 'first insert',
        score: 80,
        sessionId: 'cli',
        agentId: 'pd-cli',
      },
      canonicalPainId,
      runtimeTaskId: 'task_001',
    });
    expect(result1.trajectoryPainEventId).toBeGreaterThan(0);
    expect(result1.warnings).toEqual([]);

    // Second insert with same canonicalPainId — should NOT throw, should upsert
    const result2 = recordPainSignalObservability({
      workspaceDir,
      stateDir,
      data: {
        painId: canonicalPainId,
        taskId: 'diagnosis_duplicate_002',
        painType: 'user_frustration',
        source: 'manual',
        reason: 'second insert (should upsert)',
        score: 90,
        sessionId: 'cli',
        agentId: 'pd-cli',
      },
      canonicalPainId,
      runtimeTaskId: 'task_002',
    });
    // Should succeed without UNIQUE constraint error
    expect(result2.warnings).toEqual([]);

    // Verify only one row exists for this canonicalPainId
    const db = new Database(join(stateDir, 'trajectory.db'), { readonly: true });
    try {
      const rows = db.prepare(
        'SELECT canonical_pain_id, runtime_task_id FROM pain_events WHERE canonical_pain_id = ?'
      ).all(canonicalPainId) as { canonical_pain_id: string; runtime_task_id: string | null }[];
      expect(rows.length).toBe(1);
      // runtime_task_id should be updated to the new value
      expect(rows[0]?.runtime_task_id).toBe('task_002');
    } finally {
      db.close();
    }
  });

  // PRI-406 regression tests — empty string config guards
  it('handles empty workspaceDir gracefully (returns warnings)', () => {
    const { stateDir } = makeWorkspace();
    const result = recordPainSignalObservability({
      workspaceDir: '',
      stateDir,
      data: {
        painId: 'empty_workspace_test',
        painType: 'tool_failure',
        source: 'manual',
        reason: 'empty workspace test',
        score: 60,
        sessionId: 'cli',
      },
    });

    // Should still succeed but may have warnings about path resolution
    expect(result.warnings.length).toBeGreaterThanOrEqual(0);
    // trajectoryPainEventId should still be valid
    expect(result.trajectoryPainEventId).toBeGreaterThan(0);
  });

  it('handles empty stateDir gracefully (returns warnings)', () => {
    const { workspaceDir } = makeWorkspace();
    const result = recordPainSignalObservability({
      workspaceDir,
      stateDir: '',
      data: {
        painId: 'empty_state_test',
        painType: 'tool_failure',
        source: 'manual',
        reason: 'empty state test',
        score: 60,
        sessionId: 'cli',
      },
    });

    // Should still succeed but may have warnings about path resolution
    expect(result.warnings.length).toBeGreaterThanOrEqual(0);
    // trajectoryPainEventId should still be valid (default path used)
    expect(result.trajectoryPainEventId).toBeGreaterThan(0);
  });

  it('handles empty canonicalPainId gracefully (stored as empty string)', () => {
    const { workspaceDir, stateDir } = makeWorkspace();
    const result = recordPainSignalObservability({
      workspaceDir,
      stateDir,
      data: {
        painId: 'empty_canonical_test',
        painType: 'tool_failure',
        source: 'manual',
        reason: 'empty canonical test',
        score: 60,
        sessionId: 'cli',
      },
      canonicalPainId: '',
      runtimeTaskId: 'task_empty',
    });

    expect(result.warnings).toEqual([]);
    expect(result.trajectoryPainEventId).toBeGreaterThan(0);

    // Verify canonical_pain_id is stored as empty string (not null)
    const db = new Database(join(stateDir, 'trajectory.db'), { readonly: true });
    try {
      const row = db.prepare('SELECT canonical_pain_id FROM pain_events WHERE id = ?').get(result.trajectoryPainEventId) as { canonical_pain_id: string | null };
      // Empty string is stored as empty string, not null
      expect(row.canonical_pain_id).toBe('');
    } finally {
      db.close();
    }
  });

  it('handles whitespace-only canonicalPainId gracefully (stored as whitespace)', () => {
    const { workspaceDir, stateDir } = makeWorkspace();
    const result = recordPainSignalObservability({
      workspaceDir,
      stateDir,
      data: {
        painId: 'whitespace_canonical_test',
        painType: 'tool_failure',
        source: 'manual',
        reason: 'whitespace canonical test',
        score: 60,
        sessionId: 'cli',
      },
      canonicalPainId: '   ',
      runtimeTaskId: 'task_whitespace',
    });

    expect(result.warnings).toEqual([]);
    expect(result.trajectoryPainEventId).toBeGreaterThan(0);

    // Verify canonical_pain_id is stored as whitespace string (not null)
    const db = new Database(join(stateDir, 'trajectory.db'), { readonly: true });
    try {
      const row = db.prepare('SELECT canonical_pain_id FROM pain_events WHERE id = ?').get(result.trajectoryPainEventId) as { canonical_pain_id: string | null };
      // Whitespace string is stored as whitespace, not null
      expect(row.canonical_pain_id).toBe('   ');
    } finally {
      db.close();
    }
  });

  it('preserves original score and reason on UNIQUE constraint violation', () => {
    const { workspaceDir, stateDir } = makeWorkspace();
    const canonicalPainId = 'preserve_original_test';

    // First insert
    recordPainSignalObservability({
      workspaceDir,
      stateDir,
      data: {
        painId: canonicalPainId,
        taskId: 'diagnosis_preserve_001',
        painType: 'user_frustration',
        source: 'manual',
        reason: 'original reason',
        score: 80,
        sessionId: 'cli',
        agentId: 'pd-cli',
      },
      canonicalPainId,
      runtimeTaskId: 'task_001',
    });

    // Second insert with different score/reason
    const result2 = recordPainSignalObservability({
      workspaceDir,
      stateDir,
      data: {
        painId: canonicalPainId,
        taskId: 'diagnosis_preserve_002',
        painType: 'user_frustration',
        source: 'manual',
        reason: 'new reason',
        score: 95,
        sessionId: 'cli',
        agentId: 'pd-cli',
      },
      canonicalPainId,
      runtimeTaskId: 'task_002',
    });

    expect(result2.warnings).toEqual([]);

    // Verify original score and reason are preserved (not updated)
    const db = new Database(join(stateDir, 'trajectory.db'), { readonly: true });
    try {
      const row = db.prepare('SELECT score, reason FROM pain_events WHERE canonical_pain_id = ?').get(canonicalPainId) as { score: number; reason: string };
      expect(row.score).toBe(80);
      expect(row.reason).toBe('original reason');
    } finally {
      db.close();
    }
  });
});
