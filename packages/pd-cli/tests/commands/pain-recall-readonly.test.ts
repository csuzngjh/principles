/**
 * pd pain recall strict read-only contract tests — SPEC-PD-PAIN-RECALL-CLI-001 §6/§9.2.
 *
 * Recall must never create, migrate, or mutate any database or ledger file:
 * missing databases stay missing, byte hashes stay identical, and no WAL/SHM
 * sidecar files appear. Verified entirely on synthetic temp fixtures.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';

import { recallPains } from '../../src/services/pain-recall.js';

const P1 = '11111111-1111-4111-8111-111111111111';
const PAIN_1 = 'pain-readonly-001';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows can briefly hold SQLite handles after close; the vitest
      // temp-lifecycle keeper sweeps leftovers. Cleanup failure must not
      // fail the test.
    }
  }
});

function openReadonly(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true });
}

/** Minimal state.db schema built statement-by-statement (fixture seeding only). */
function seedStateDbSchema(db: Database.Database): void {
  db.prepare(`CREATE TABLE tasks (task_id TEXT PRIMARY KEY, task_kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, lease_owner TEXT, lease_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
      last_error TEXT, input_ref TEXT, result_ref TEXT, diagnostic_json TEXT)`).run();
  db.prepare(`CREATE TABLE principle_candidates (candidate_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, task_id TEXT NOT NULL,
      source_run_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, confidence REAL,
      source_recommendation_json TEXT, idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL, consumed_at TEXT, recommendation_kind TEXT NOT NULL DEFAULT 'principle',
      trigger_pattern TEXT, action TEXT, abstracted_principle TEXT, admission_json TEXT)`).run();
  db.prepare(`CREATE TABLE pain_diagnoses (id TEXT PRIMARY KEY, pain_id TEXT NOT NULL, task_id TEXT NOT NULL,
      diagnosis_id TEXT NOT NULL, category TEXT NOT NULL, root_cause TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]', confidence REAL, artifact_id TEXT, created_at TEXT NOT NULL)`).run();
}

function makeFullWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-recall-ro-'));
  tempDirs.push(dir);

  // Ledger
  const stateDir = path.join(dir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'principle_training_state.json'),
    JSON.stringify({
      _tree: {
        principles: {
          [P1]: {
            id: P1,
            version: 1,
            text: 'verify first',
            triggerPattern: 'when in doubt',
            action: 'check',
            status: 'active',
            derivedFromPainIds: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
        rules: {},
        implementations: {},
        metrics: {},
        lastUpdated: '2026-01-01T00:00:00.000Z',
      },
    }),
  );

  // trajectory.db
  const tdb = new Database(path.join(stateDir, 'trajectory.db'));
  tdb.prepare(`CREATE TABLE pain_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT,
      severity TEXT, origin TEXT, confidence REAL, text TEXT,
      canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL
    )`).run();
  tdb.prepare(`INSERT INTO pain_events
      (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, host_kind, created_at)
    VALUES ('s1', 'manual', 80, 'ro fixture', 'moderate', 'user_manual', NULL, NULL, ?, NULL, NULL, '2026-10-01T10:00:00.000Z')`).run(PAIN_1);
  tdb.close();

  // state.db — plain minimal schema so a readonly open succeeds.
  const pdDir = path.join(dir, '.pd');
  fs.mkdirSync(pdDir, { recursive: true });
  const sdb = new Database(path.join(pdDir, 'state.db'));
  seedStateDbSchema(sdb);
  sdb.close();

  return dir;
}

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sidecarFiles(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`].filter((p) => fs.existsSync(p));
}

describe('recallPains: strict read-only side effects', () => {
  it('creates no files or directories when every source is missing (ro-1)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-recall-empty-'));
    tempDirs.push(dir);
    const result = await recallPains(dir, { requestedPrincipleId: P1, limit: 3 });
    expect(result.status).toBe('source_missing');
    expect(fs.readdirSync(dir).sort()).toEqual([]);
  });

  it('leaves trajectory.db and state.db byte-identical, same size and journal mode (ro-2)', async () => {
    const dir = makeFullWorkspace();
    const tdbPath = path.join(dir, '.state', 'trajectory.db');
    const sdbPath = path.join(dir, '.pd', 'state.db');
    const before = { t: sha256(tdbPath), s: sha256(sdbPath), ts: fs.statSync(tdbPath).size, ss: fs.statSync(sdbPath).size };
    const tProbe = openReadonly(tdbPath);
    const sProbe = openReadonly(sdbPath);
    const tJournal = tProbe.pragma('journal_mode', { simple: true });
    const sJournal = sProbe.pragma('journal_mode', { simple: true });
    tProbe.close();
    sProbe.close();

    // Exercise every read path: principle resolution + pain lookup + diagnoses.
    await recallPains(dir, { requestedPrincipleId: P1, limit: 3 });
    await recallPains(dir, { requestedPrincipleId: P1, painId: PAIN_1, limit: 3 });
    await recallPains(dir, { requestedPrincipleId: 'unknown', limit: 3 });

    expect(sha256(tdbPath)).toBe(before.t);
    expect(sha256(sdbPath)).toBe(before.s);
    expect(fs.statSync(tdbPath).size).toBe(before.ts);
    expect(fs.statSync(sdbPath).size).toBe(before.ss);
    const tAfter = openReadonly(tdbPath);
    const sAfter = openReadonly(sdbPath);
    expect(tAfter.pragma('journal_mode', { simple: true })).toBe(tJournal);
    expect(sAfter.pragma('journal_mode', { simple: true })).toBe(sJournal);
    tAfter.close();
    sAfter.close();
    expect(sidecarFiles(tdbPath)).toEqual([]);
    expect(sidecarFiles(sdbPath)).toEqual([]);
    // The ledger file is untouched too.
    expect(fs.existsSync(path.join(dir, '.state', 'principle_training_state.json.lock'))).toBe(false);
  });

  it('does not bootstrap a missing state.db alongside present sources (ro-3)', async () => {
    const dir = makeFullWorkspace();
    fs.rmSync(path.join(dir, '.pd', 'state.db'));
    const result = await recallPains(dir, { requestedPrincipleId: P1, limit: 3 });
    expect(result.status).toBe('no_matches'); // principle has no edges at all
    expect(result.sources.stateDb).toBe('missing');
    expect(fs.existsSync(path.join(dir, '.pd', 'state.db'))).toBe(false);
  });

  it('schema stays intact after recall (no migrations, no new tables) (ro-4)', async () => {
    const dir = makeFullWorkspace();
    const sdbPath = path.join(dir, '.pd', 'state.db');
    const beforeProbe = openReadonly(sdbPath);
    const tablesBefore = beforeProbe
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map((r) => (r as { name: string }).name);
    beforeProbe.close();
    await recallPains(dir, { requestedPrincipleId: P1, limit: 3 });
    const afterProbe = openReadonly(sdbPath);
    const tablesAfter = afterProbe
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map((r) => (r as { name: string }).name);
    afterProbe.close();
    expect(tablesAfter).toEqual(tablesBefore);
    expect(tablesAfter).not.toContain(expect.stringMatching(/migration|recall/i));
  });
});
