import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { rmSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import os from 'os';
import Database from 'better-sqlite3';

import { CentralDatabase, getCentralDatabase, resetCentralDatabase } from '../../src/service/central-database.js';

// ── Home dir ────────────────────────────────────────────────────────────────

const REAL_HOME = os.homedir();
const OPENCLAW_DIR = join(REAL_HOME, '.openclaw');
const CENTRAL_DB_DIR = '.central';
const CENTRAL_DB_PATH = join(OPENCLAW_DIR, CENTRAL_DB_DIR, 'aggregated.db');

function makeWorkspaceName(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanupTestDirs() {
  // Clean up central DB and test workspace dirs
  if (existsSync(OPENCLAW_DIR)) {
    for (const entry of readdirSync(OPENCLAW_DIR)) {
      if (entry.startsWith('cdb-test-') || entry === '.central') {
        try {
          rmSync(join(OPENCLAW_DIR, entry), { recursive: true, force: true });
        } catch { /* noop */ }
      }
    }
  }
}

beforeEach(() => {
  cleanupTestDirs();
  resetCentralDatabase();
});

afterEach(() => {
  resetCentralDatabase();
  cleanupTestDirs();
});

// ── Trajectory DB helper ────────────────────────────────────────────────────

function makeTrajectoryDb(workspaceName: string) {
  // openclawDir = ~/.openclaw, so workspace dir is ~/.openclaw/<workspaceName>
  const wsDir = join(OPENCLAW_DIR, workspaceName);
  mkdirSync(wsDir, { recursive: true });
  const stateDir = join(wsDir, '.state');
  mkdirSync(stateDir, { recursive: true });
  const db = new Database(join(stateDir, 'trajectory.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, error_type TEXT, error_message TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, correction_cue TEXT, correction_detected INTEGER DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS principle_events (id INTEGER PRIMARY KEY AUTOINCREMENT, principle_id TEXT, event_type TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS thinking_model_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, model_id TEXT NOT NULL, matched_pattern TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS correction_samples (sample_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, bad_assistant_turn_id INTEGER NOT NULL, quality_score REAL, review_status TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, task_id TEXT, outcome TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  return { db, wsDir };
}

function seedSessions(db: Database.Database, count: number) {
  for (let i = 0; i < count; i++) {
    db.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)')
      .run(`sess-${i}`, '2026-04-01T00:00:00Z', '2026-04-01T00:10:00Z');
  }
}

function seedToolCalls(db: Database.Database, successes = 0, failures = 0, errorType = 'ENOENT') {
  for (let i = 0; i < successes; i++) {
    db.prepare('INSERT INTO tool_calls (session_id, tool_name, outcome, duration_ms, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('sess-0', 'write_file', 'success', 100, '2026-04-01T00:00:00Z');
  }
  for (let i = 0; i < failures; i++) {
    db.prepare('INSERT INTO tool_calls (session_id, tool_name, outcome, duration_ms, error_type, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('sess-0', 'bash', 'failure', 100, errorType, '2026-04-01T00:00:00Z');
  }
}

function seedPainEvents(db: Database.Database, count: number) {
  for (let i = 0; i < count; i++) {
    db.prepare('INSERT INTO pain_events (session_id, source, score, reason, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('sess-0', 'tool_failure', 75, 'test', '2026-04-01T00:00:00Z');
  }
}

function seedCorrections(db: Database.Database, count: number) {
  for (let i = 0; i < count; i++) {
    db.prepare('INSERT INTO user_turns (session_id, correction_cue, correction_detected, created_at) VALUES (?, ?, 1, ?)')
      .run('sess-0', 'stop doing that', '2026-04-01T00:00:00Z');
  }
}

function seedPrincipleEvents(db: Database.Database, count: number) {
  for (let i = 0; i < count; i++) {
    db.prepare('INSERT INTO principle_events (principle_id, event_type, created_at) VALUES (?, ?, ?)')
      .run(`p-${i}`, 'candidate_created', '2026-04-01T00:00:00Z');
  }
}

function seedThinkingEvents(db: Database.Database, count: number) {
  for (let i = 0; i < count; i++) {
    db.prepare('INSERT INTO thinking_model_events (session_id, model_id, matched_pattern, created_at) VALUES (?, ?, ?, ?)')
      .run('sess-0', 'claude-3-5-sonnet', 'error_pattern', '2026-04-01T00:00:00Z');
  }
}

function seedSamples(db: Database.Database) {
  db.prepare('INSERT INTO correction_samples (sample_id, session_id, bad_assistant_turn_id, quality_score, review_status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('s1', 'sess-0', 1, 0.9, 'pending', '2026-04-01T00:00:00Z');
  db.prepare('INSERT INTO correction_samples (sample_id, session_id, bad_assistant_turn_id, quality_score, review_status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('s2', 'sess-0', 1, 0.7, 'approved', '2026-04-01T00:00:00Z');
  db.prepare('INSERT INTO correction_samples (sample_id, session_id, bad_assistant_turn_id, quality_score, review_status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('s3', 'sess-0', 1, 0.5, 'rejected', '2026-04-01T00:00:00Z');
}

function seedTaskOutcomes(db: Database.Database, count: number) {
  for (let i = 0; i < count; i++) {
    db.prepare('INSERT INTO task_outcomes (session_id, task_id, outcome, created_at) VALUES (?, ?, ?, ?)')
      .run('sess-0', `task-${i}`, 'success', '2026-04-01T00:00:00Z');
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CentralDatabase', () => {
  test('creates schema on construction', () => {
    const db = new CentralDatabase();
    expect(() => db.getOverviewStats()).not.toThrow();
    db.dispose();
  });

  test('isClosed reflects disposal state', () => {
    const db = new CentralDatabase();
    expect(db.isClosed).toBe(false);
    db.dispose();
    expect(db.isClosed).toBe(true);
  });

  test('dispose prevents further operations', () => {
    const db = new CentralDatabase();
    db.dispose();
    expect(() => db.getOverviewStats()).toThrow();
  });

  test('getOverviewStats returns zeros when no data', () => {
    const db = new CentralDatabase();
    const stats = db.getOverviewStats();
    expect(stats.totalSessions).toBe(0);
    expect(stats.totalToolCalls).toBe(0);
    expect(stats.totalFailures).toBe(0);
    expect(stats.totalPainEvents).toBe(0);
    db.dispose();
  });

  test('getTopRegressions returns empty array when no failures', () => {
    const db = new CentralDatabase();
    expect(db.getTopRegressions()).toEqual([]);
    db.dispose();
  });

  test('addCustomWorkspace inserts and enables workspace', () => {
    const db = new CentralDatabase();
    db.addCustomWorkspace('my-ws', '/custom/path');
    const configs = db.getWorkspaceConfigs();
    const found = configs.find(c => c.workspaceName === 'my-ws');
    expect(found).toBeDefined();
    expect(found?.enabled).toBe(true);
    expect(found?.syncEnabled).toBe(true);
    db.dispose();
  });

  test('updateWorkspaceConfig updates displayName and enabled', () => {
    const db = new CentralDatabase();
    db.addCustomWorkspace('cfg-ws', '/path');
    db.updateWorkspaceConfig('cfg-ws', { displayName: 'Display', enabled: false });
    const configs = db.getWorkspaceConfigs();
    const found = configs.find(c => c.workspaceName === 'cfg-ws');
    expect(found?.displayName).toBe('Display');
    expect(found?.enabled).toBe(false);
    db.dispose();
  });

  test('isWorkspaceEnabled returns true when no config', () => {
    const db = new CentralDatabase();
    expect(db.isWorkspaceEnabled('unknown')).toBe(true);
    db.dispose();
  });

  test('isWorkspaceEnabled returns false when disabled', () => {
    const db = new CentralDatabase();
    db.addCustomWorkspace('dis-ws', '/path');
    db.updateWorkspaceConfig('dis-ws', { enabled: false });
    expect(db.isWorkspaceEnabled('dis-ws')).toBe(false);
    db.dispose();
  });

  test('removeWorkspace disables workspace', () => {
    const db = new CentralDatabase();
    db.addCustomWorkspace('rem-ws', '/path');
    db.removeWorkspace('rem-ws');
    expect(db.isWorkspaceEnabled('rem-ws')).toBe(false);
    db.dispose();
  });

  test('setGlobalConfig and getGlobalConfig round-trip', () => {
    const db = new CentralDatabase();
    db.setGlobalConfig('key', 'value');
    expect(db.getGlobalConfig('key')).toBe('value');
    db.setGlobalConfig('key', 'value2');
    expect(db.getGlobalConfig('key')).toBe('value2');
    expect(db.getGlobalConfig('missing')).toBeNull();
    db.dispose();
  });

  test('clearAll deletes all aggregated data', () => {
    const db = new CentralDatabase();
    db.clearAll();
    expect(db.getOverviewStats().totalSessions).toBe(0);
    db.dispose();
  });

  // ── syncWorkspace ─────────────────────────────────────────────────────────

  test('syncWorkspace throws for unknown workspace', () => {
    const db = new CentralDatabase();
    expect(() => db.syncWorkspace('nonexistent')).toThrow();
    db.dispose();
  });

  test('syncWorkspace returns 0 when no trajectory.db', () => {
    const wsName = makeWorkspaceName('cdb-test-empty');
    const db = new CentralDatabase();
    db.addCustomWorkspace(wsName, join(OPENCLAW_DIR, wsName));
    // Create workspace dir without trajectory.db
    mkdirSync(join(OPENCLAW_DIR, wsName, '.state'), { recursive: true });
    expect(db.syncWorkspace(wsName)).toBe(0);
    db.dispose();
  });

  test('syncWorkspace syncs sessions', () => {
    const wsName = makeWorkspaceName('cdb-test-sessions');
    const { db: trajDb } = makeTrajectoryDb(wsName);
    seedSessions(trajDb, 5);
    trajDb.close();
    const db = new CentralDatabase();
    db.addCustomWorkspace(wsName, join(OPENCLAW_DIR, wsName));
    db.syncWorkspace(wsName);
    expect(db.getOverviewStats().totalSessions).toBeGreaterThanOrEqual(5);
    db.dispose();
  });

  test('syncWorkspace syncs tool calls with failures', () => {
    const wsName = makeWorkspaceName('cdb-test-tools');
    const { db: trajDb } = makeTrajectoryDb(wsName);
    seedSessions(trajDb, 1);
    seedToolCalls(trajDb, 3, 2, 'ENOENT');
    trajDb.close();
    const db = new CentralDatabase();
    db.addCustomWorkspace(wsName, join(OPENCLAW_DIR, wsName));
    db.syncWorkspace(wsName);
    const stats = db.getOverviewStats();
    expect(stats.totalToolCalls).toBeGreaterThanOrEqual(5);
    expect(stats.totalFailures).toBeGreaterThanOrEqual(2);
    db.dispose();
  });

  test('syncWorkspace syncs pain events', () => {
    const wsName = makeWorkspaceName('cdb-test-pain');
    const { db: trajDb } = makeTrajectoryDb(wsName);
    seedSessions(trajDb, 1);
    seedPainEvents(trajDb, 4);
    trajDb.close();
    const db = new CentralDatabase();
    db.addCustomWorkspace(wsName, join(OPENCLAW_DIR, wsName));
    db.syncWorkspace(wsName);
    expect(db.getOverviewStats().totalPainEvents).toBeGreaterThanOrEqual(4);
    db.dispose();
  });

  test('syncWorkspace syncs user corrections', () => {
    const wsName = makeWorkspaceName('cdb-test-corr');
    const { db: trajDb } = makeTrajectoryDb(wsName);
    seedSessions(trajDb, 1);
    seedCorrections(trajDb, 3);
    trajDb.close();
    const db = new CentralDatabase();
    db.addCustomWorkspace(wsName, join(OPENCLAW_DIR, wsName));
    db.syncWorkspace(wsName);
    expect(db.getOverviewStats().totalCorrections).toBeGreaterThanOrEqual(3);
    db.dispose();
  });

  test('syncWorkspace syncs principle events', () => {
    const wsName = makeWorkspaceName('cdb-test-principle');
    const { db: trajDb } = makeTrajectoryDb(wsName);
    seedSessions(trajDb, 1);
    seedPrincipleEvents(trajDb, 2);
    trajDb.close();
    const db = new CentralDatabase();
    db.addCustomWorkspace(wsName, join(OPENCLAW_DIR, wsName));
    db.syncWorkspace(wsName);
    expect(db.getPrincipleEventCount()).toBeGreaterThanOrEqual(2);
    db.dispose();
  });

  test('syncWorkspace syncs thinking model events', () => {
    const wsName = makeWorkspaceName('cdb-test-thinking');
    const { db: trajDb } = makeTrajectoryDb(wsName);
    seedSessions(trajDb, 1);
    seedThinkingEvents(trajDb, 3);
    trajDb.close();
    const db = new CentralDatabase();
    db.addCustomWorkspace(wsName, join(OPENCLAW_DIR, wsName));
    db.syncWorkspace(wsName);
    expect(db.getThinkingModelStats().totalModels).toBeGreaterThanOrEqual(1);
    db.dispose();
  });

  test('syncWorkspace syncs correction samples with review_status', () => {
    const wsName = makeWorkspaceName('cdb-test-samples');
    const { db: trajDb } = makeTrajectoryDb(wsName);
    seedSessions(trajDb, 1);
    seedSamples(trajDb);
    trajDb.close();
    const db = new CentralDatabase();
    db.addCustomWorkspace(wsName, join(OPENCLAW_DIR, wsName));
    db.syncWorkspace(wsName);
    const counters = db.getSampleCountersByStatus();
    expect(counters['pending']).toBeGreaterThanOrEqual(1);
    expect(counters['approved']).toBeGreaterThanOrEqual(1);
    expect(counters['rejected']).toBeGreaterThanOrEqual(1);
    db.dispose();
  });

  test('syncWorkspace syncs task outcomes', () => {
    const wsName = makeWorkspaceName('cdb-test-tasks');
    const { db: trajDb } = makeTrajectoryDb(wsName);
    seedSessions(trajDb, 1);
    seedTaskOutcomes(trajDb, 4);
    trajDb.close();
    const db = new CentralDatabase();
    db.addCustomWorkspace(wsName, join(OPENCLAW_DIR, wsName));
    db.syncWorkspace(wsName);
    expect(db.getTaskOutcomes()).toBeGreaterThanOrEqual(4);
    db.dispose();
  });

  test('syncWorkspace updates last_sync timestamp', () => {
    const wsName = makeWorkspaceName('cdb-test-sync');
    const { db: trajDb } = makeTrajectoryDb(wsName);
    seedSessions(trajDb, 1);
    trajDb.close();
    const db = new CentralDatabase();
    db.addCustomWorkspace(wsName, join(OPENCLAW_DIR, wsName));
    db.syncWorkspace(wsName);
    const ws = db.getWorkspaces().find(w => w.name === wsName);
    expect(ws?.lastSync).not.toBeNull();
    db.dispose();
  });

  test('getTopRegressions returns error types ordered by occurrences', () => {
    const wsName = makeWorkspaceName('cdb-test-regr');
    const { db: trajDb } = makeTrajectoryDb(wsName);
    seedSessions(trajDb, 1);
    trajDb.prepare('INSERT INTO tool_calls (session_id, tool_name, outcome, error_type, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('sess-0', 'bash', 'failure', 'ENOENT', 100, '2026-04-01T00:00:00Z');
    trajDb.prepare('INSERT INTO tool_calls (session_id, tool_name, outcome, error_type, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('sess-0', 'bash', 'failure', 'ENOENT', 100, '2026-04-01T00:01:00Z');
    trajDb.prepare('INSERT INTO tool_calls (session_id, tool_name, outcome, error_type, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('sess-0', 'bash', 'failure', 'EPERM', 100, '2026-04-01T00:02:00Z');
    trajDb.close();
    const db = new CentralDatabase();
    db.addCustomWorkspace(wsName, join(OPENCLAW_DIR, wsName));
    db.syncWorkspace(wsName);
    const regressions = db.getTopRegressions(5);
    expect(regressions[0].errorType).toBe('ENOENT');
    expect(regressions[0].occurrences).toBe(2);
    db.dispose();
  });

  test('getSamplePreview returns recent pending/approved samples', () => {
    const wsName = makeWorkspaceName('cdb-test-preview');
    const { db: trajDb } = makeTrajectoryDb(wsName);
    seedSessions(trajDb, 1);
    seedSamples(trajDb);
    trajDb.close();
    const db = new CentralDatabase();
    db.addCustomWorkspace(wsName, join(OPENCLAW_DIR, wsName));
    db.syncWorkspace(wsName);
    const preview = db.getSamplePreview(5);
    expect(preview.length).toBeGreaterThanOrEqual(2);
    db.dispose();
  });

  test('getMostRecentSync returns null when no sync', () => {
    const db = new CentralDatabase();
    expect(db.getMostRecentSync()).toBeNull();
    db.dispose();
  });

  test('getMostRecentSync returns timestamp after sync', () => {
    const wsName = makeWorkspaceName('cdb-test-recent');
    const { db: trajDb } = makeTrajectoryDb(wsName);
    seedSessions(trajDb, 1);
    trajDb.close();
    const db = new CentralDatabase();
    db.addCustomWorkspace(wsName, join(OPENCLAW_DIR, wsName));
    db.syncWorkspace(wsName);
    expect(db.getMostRecentSync()).not.toBeNull();
    db.dispose();
  });

  // ── Singleton ────────────────────────────────────────────────────────────

  test('getCentralDatabase returns same instance', () => {
    const db1 = getCentralDatabase();
    const db2 = getCentralDatabase();
    expect(db1).toBe(db2);
    resetCentralDatabase();
  });

  test('resetCentralDatabase clears instance', () => {
    const db1 = getCentralDatabase();
    resetCentralDatabase();
    const db2 = getCentralDatabase();
    expect(db1).not.toBe(db2);
    resetCentralDatabase();
  });

  test('getCentralDatabase reopens after close', () => {
    const db1 = getCentralDatabase();
    db1.dispose();
    const db2 = getCentralDatabase();
    expect(db2.isClosed).toBe(false);
    resetCentralDatabase();
  });
});