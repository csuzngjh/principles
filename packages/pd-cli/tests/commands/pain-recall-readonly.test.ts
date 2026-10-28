/**
 * pd pain recall strict read-only contract tests — SPEC-PD-PAIN-RECALL-CLI-001 §6/§9.2.
 *
 * Recall must never create, migrate, or mutate any database or ledger file:
 * missing databases stay missing, byte hashes stay identical, and no WAL/SHM
 * sidecar files appear. Verified entirely on synthetic temp fixtures.
 *
 * WAL matrix (SPEC-PD-AGENT-CAPABILITY-API-001 v0.3 §10.3.1): both production
 * databases are persisted in WAL journal mode, so the contract is additionally
 * asserted for WAL databases — quiet (no `-wal`, the production resting state),
 * live writer (sidecars present, un-checkpointed committed frames), empty
 * `-wal` (post-TRUNCATE checkpoint), crashed-writer trio, and mixed
 * WAL/journal databases.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';

import { recallPains, painRecallSnapshotTestHooks } from '../../src/services/pain-recall.js';

const P1 = '11111111-1111-4111-8111-111111111111';
const PAIN_1 = 'pain-readonly-001';
const PAIN_2 = 'pain-readonly-002';

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

/** Like makeFullWorkspace but both databases are persisted in WAL journal
 * mode (the production resting state) with a clean writer close, i.e. no
 * sidecar files remain. The ledger gains explicit reuseEvidence edges so a
 * recall returns real rows (freshness is observable through the result). */
function makeWalWorkspace(): string {
  const dir = makeFullWorkspace();
  const stateDir = path.join(dir, '.state');
  const ledgerPath = path.join(stateDir, 'principle_training_state.json');
  const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as {
    _tree: { principles: Record<string, Record<string, unknown>> };
  };
  parsed._tree.principles[P1]!.reuseEvidence = [
    { painId: PAIN_1, candidateId: 'cand-1', decidedAt: '2026-01-02T00:00:00.000Z' },
    { painId: PAIN_2, candidateId: 'cand-2', decidedAt: '2026-01-03T00:00:00.000Z' },
  ];
  fs.writeFileSync(ledgerPath, JSON.stringify(parsed));

  const tdb = new Database(path.join(stateDir, 'trajectory.db'));
  tdb.pragma('journal_mode = WAL');
  tdb.prepare(`INSERT INTO pain_events
      (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, host_kind, created_at)
    VALUES ('s2', 'manual', 70, 'wal fixture', 'moderate', 'user_manual', NULL, NULL, ?, NULL, NULL, '2026-10-02T10:00:00.000Z')`).run(PAIN_2);
  tdb.close();

  const sdb = new Database(path.join(dir, '.pd', 'state.db'));
  sdb.pragma('journal_mode = WAL');
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

describe('recallPains: WAL-mode strict read-only (production journal mode)', () => {
  it('quiet WAL databases create no sidecars, stay byte-identical, and return full results (ro-5)', async () => {
    const dir = makeWalWorkspace();
    const tdbPath = path.join(dir, '.state', 'trajectory.db');
    const sdbPath = path.join(dir, '.pd', 'state.db');
    expect(sidecarFiles(tdbPath)).toEqual([]); // fixture precondition: quiet WAL
    expect(sidecarFiles(sdbPath)).toEqual([]);
    const before = { t: sha256(tdbPath), s: sha256(sdbPath), ts: fs.statSync(tdbPath).size, ss: fs.statSync(sdbPath).size };

    const result = await recallPains(dir, { requestedPrincipleId: P1, limit: 3 });

    // Freshness: both reuse-evidence pains are visible through the staged copies.
    expect(result.status).toBe('ok');
    expect(result.summary.returned).toBe(2);
    expect(result.sources).toEqual({ ledger: 'ok', trajectoryDb: 'ok', stateDb: 'ok' });
    // Zero side effects: no sidecars anywhere, main files byte-identical.
    expect(sidecarFiles(tdbPath)).toEqual([]);
    expect(sidecarFiles(sdbPath)).toEqual([]);
    expect(fs.readdirSync(path.join(dir, '.state')).sort()).toEqual(
      ['principle_training_state.json', 'trajectory.db'],
    );
    expect(fs.readdirSync(path.join(dir, '.pd')).sort()).toEqual(['state.db']);
    expect(sha256(tdbPath)).toBe(before.t);
    expect(sha256(sdbPath)).toBe(before.s);
    expect(fs.statSync(tdbPath).size).toBe(before.ts);
    expect(fs.statSync(sdbPath).size).toBe(before.ss);
  });

  it('WAL with a live writer attaches read-only: fresh data, no new files (ro-6)', async () => {
    const dir = makeWalWorkspace();
    const tdbPath = path.join(dir, '.state', 'trajectory.db');
    const writer = new Database(tdbPath);
    writer.prepare(`INSERT INTO pain_events
        (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, host_kind, created_at)
      VALUES ('s3', 'manual', 60, 'live writer', 'moderate', 'user_manual', NULL, NULL, 'pain-readonly-003', NULL, NULL, '2026-10-03T10:00:00.000Z')`).run();
    // Give the live-session row a ledger edge so seeing it proves the read
    // went through the live -wal (un-checkpointed), not a stale snapshot.
    const ledgerPath = path.join(dir, '.state', 'principle_training_state.json');
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as {
      _tree: { principles: Record<string, { reuseEvidence?: unknown[] }> };
    };
    const evidence = (parsed._tree.principles[P1]!.reuseEvidence ?? []) as Record<string, unknown>[];
    evidence.push({ painId: 'pain-readonly-003', candidateId: 'cand-3', decidedAt: '2026-01-04T00:00:00.000Z' });
    parsed._tree.principles[P1]!.reuseEvidence = evidence;
    fs.writeFileSync(ledgerPath, JSON.stringify(parsed));
    const stateBefore = fs.readdirSync(path.join(dir, '.state')).sort();
    const pdBefore = fs.readdirSync(path.join(dir, '.pd')).sort();
    const walBefore = sha256(`${tdbPath}-wal`);
    const shmBefore = sha256(`${tdbPath}-shm`);
    try {
      const walBytes = fs.readFileSync(`${tdbPath}-wal`).length;
      expect(walBytes).toBeGreaterThan(0); // precondition: un-checkpointed frames exist
      const result = await recallPains(dir, { requestedPrincipleId: P1, limit: 10 });
      expect(result.status).toBe('ok');
      expect(result.summary.returned).toBe(3); // includes the un-checkpointed live row
      // No NEW files in either directory (sidecars may pre-exist from the writer).
      expect(fs.readdirSync(path.join(dir, '.state')).sort()).toEqual(stateBefore);
      expect(fs.readdirSync(path.join(dir, '.pd')).sort()).toEqual(pdBefore);
      // P1-1: the live writer's WAL and SHM must be untouched by the staged
      // pair snapshot — not created, not deleted, not rewritten.
      expect(sha256(`${tdbPath}-wal`)).toBe(walBefore);
      expect(sha256(`${tdbPath}-shm`)).toBe(shmBefore);
    } finally {
      writer.close();
    }
  });

  it('WAL with an empty -wal (post-TRUNCATE) reads via staging and never creates -shm (ro-7)', async () => {
    const dir = makeWalWorkspace();
    const tdbPath = path.join(dir, '.state', 'trajectory.db');
    fs.writeFileSync(`${tdbPath}-wal`, Buffer.alloc(0)); // simulate leftover empty wal
    const sdbPath = path.join(dir, '.pd', 'state.db');
    const before = { t: sha256(tdbPath), s: sha256(sdbPath) };

    const result = await recallPains(dir, { requestedPrincipleId: P1, limit: 3 });

    expect(result.status).toBe('ok');
    expect(result.summary.returned).toBe(2);
    expect(fs.existsSync(`${tdbPath}-shm`)).toBe(false); // staging: no shm creation
    expect(fs.existsSync(`${sdbPath}-shm`)).toBe(false);
    expect(fs.statSync(`${tdbPath}-wal`).size).toBe(0); // empty wal untouched
    expect(sha256(tdbPath)).toBe(before.t);
    expect(sha256(sdbPath)).toBe(before.s);
  });

  it('crashed-writer trio (non-empty -wal, no live writer) reads fresh without creating files (ro-8)', async () => {
    const dir = makeWalWorkspace();
    const tdbPath = path.join(dir, '.state', 'trajectory.db');
    // Build the crashed trio: commit rows into the WAL, then snapshot db+wal+shm
    // into a fresh workspace while the writer still holds them, and abandon
    // (close) the originals afterwards.
    const writer = new Database(tdbPath);
    writer.prepare(`INSERT INTO pain_events
        (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, host_kind, created_at)
      VALUES ('s4', 'manual', 50, 'crash residue', 'moderate', 'user_manual', NULL, NULL, ?, NULL, NULL, '2026-10-04T10:00:00.000Z')`).run('pain-readonly-004');
    const crashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-recall-crash-'));
    tempDirs.push(crashDir);
    fs.mkdirSync(path.join(crashDir, '.state'), { recursive: true });
    fs.mkdirSync(path.join(crashDir, '.pd'), { recursive: true });
    fs.copyFileSync(tdbPath, path.join(crashDir, '.state', 'trajectory.db'));
    fs.copyFileSync(`${tdbPath}-wal`, path.join(crashDir, '.state', 'trajectory.db-wal'));
    fs.copyFileSync(`${tdbPath}-shm`, path.join(crashDir, '.state', 'trajectory.db-shm'));
    fs.copyFileSync(path.join(dir, '.state', 'principle_training_state.json'), path.join(crashDir, '.state', 'principle_training_state.json'));
    fs.copyFileSync(path.join(dir, '.pd', 'state.db'), path.join(crashDir, '.pd', 'state.db'));
    writer.close();
    // Give the WAL-only row (pain-readonly-004, committed but never
    // checkpointed into the copied main file) a ledger edge, so seeing it in
    // the result proves the read recovered -wal content, not a stale
    // main-file-only view.
    const crashLedger = path.join(crashDir, '.state', 'principle_training_state.json');
    const crashParsed = JSON.parse(fs.readFileSync(crashLedger, 'utf8')) as {
      _tree: { principles: Record<string, { reuseEvidence?: unknown[] }> };
    };
    const evidence = (crashParsed._tree.principles[P1]!.reuseEvidence ?? []) as Record<string, unknown>[];
    evidence.push({ painId: 'pain-readonly-004', candidateId: 'cand-4', decidedAt: '2026-01-04T00:00:00.000Z' });
    crashParsed._tree.principles[P1]!.reuseEvidence = evidence;
    fs.writeFileSync(crashLedger, JSON.stringify(crashParsed));

    const crashTdb = path.join(crashDir, '.state', 'trajectory.db');
    const filesBefore = fs.readdirSync(path.join(crashDir, '.state')).sort();
    const mainBefore = sha256(crashTdb);
    const walBefore = sha256(`${crashTdb}-wal`);
    const shmBefore = sha256(`${crashTdb}-shm`);

    const result = await recallPains(crashDir, { requestedPrincipleId: P1, limit: 3 });

    // pain-readonly-004 lives ONLY in the copied -wal (never checkpointed
    // into the copied main file): seeing all three proves the read recovered
    // WAL content (fresh), not a main-file-only stale view.
    expect(result.status).toBe('ok');
    expect(result.summary.returned).toBe(3);
    expect(result.results.map((r) => r.painId).sort()).toEqual([PAIN_1, PAIN_2, 'pain-readonly-004'].sort());
    // P1-1: crash residue stays byte-identical — main AND both sidecars; the
    // query may not rewrite the -shm via WAL-index recovery or remove anything.
    expect(fs.readdirSync(path.join(crashDir, '.state')).sort()).toEqual(filesBefore);
    expect(sha256(crashTdb)).toBe(mainBefore);
    expect(sha256(`${crashTdb}-wal`)).toBe(walBefore);
    expect(sha256(`${crashTdb}-shm`)).toBe(shmBefore);
  });

  it('non-empty WAL without any -shm reads fresh and creates no sidecar in the workspace (ro-10)', async () => {
    // Crash-residue variant: db + non-empty wal, no shm at all. A direct
    // readonly open would have to materialize a -shm beside the workspace db;
    // the staged snapshot must read fresh without any workspace change.
    const dir = makeWalWorkspace();
    const tdbPath = path.join(dir, '.state', 'trajectory.db');
    const writer = new Database(tdbPath);
    writer.prepare(`INSERT INTO pain_events
        (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, host_kind, created_at)
      VALUES ('s5', 'manual', 40, 'no-shm crash', 'moderate', 'user_manual', NULL, NULL, ?, NULL, NULL, '2026-10-05T10:00:00.000Z')`).run('pain-readonly-005');
    const crashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-recall-crash-'));
    tempDirs.push(crashDir);
    fs.mkdirSync(path.join(crashDir, '.state'), { recursive: true });
    fs.mkdirSync(path.join(crashDir, '.pd'), { recursive: true });
    fs.copyFileSync(tdbPath, path.join(crashDir, '.state', 'trajectory.db'));
    fs.copyFileSync(`${tdbPath}-wal`, path.join(crashDir, '.state', 'trajectory.db-wal'));
    // deliberately NO -shm copy
    fs.copyFileSync(path.join(dir, '.state', 'principle_training_state.json'), path.join(crashDir, '.state', 'principle_training_state.json'));
    fs.copyFileSync(path.join(dir, '.pd', 'state.db'), path.join(crashDir, '.pd', 'state.db'));
    writer.close();
    const crashLedger = path.join(crashDir, '.state', 'principle_training_state.json');
    const crashParsed = JSON.parse(fs.readFileSync(crashLedger, 'utf8')) as {
      _tree: { principles: Record<string, { reuseEvidence?: unknown[] }> };
    };
    const evidence = (crashParsed._tree.principles[P1]!.reuseEvidence ?? []) as Record<string, unknown>[];
    evidence.push({ painId: 'pain-readonly-005', candidateId: 'cand-5', decidedAt: '2026-01-05T00:00:00.000Z' });
    crashParsed._tree.principles[P1]!.reuseEvidence = evidence;
    fs.writeFileSync(crashLedger, JSON.stringify(crashParsed));

    const crashTdb = path.join(crashDir, '.state', 'trajectory.db');
    const filesBefore = fs.readdirSync(path.join(crashDir, '.state')).sort();
    const mainBefore = sha256(crashTdb);
    const walBefore = sha256(`${crashTdb}-wal`);

    const result = await recallPains(crashDir, { requestedPrincipleId: P1, limit: 10 });

    // Fresh: pain-readonly-005 exists only inside the -wal.
    expect(result.status).toBe('ok');
    expect(result.summary.returned).toBe(3);
    expect(result.results.map((r) => r.painId)).toContain('pain-readonly-005');
    // Strict: no -shm materialized, no existing file touched.
    expect(fs.readdirSync(path.join(crashDir, '.state')).sort()).toEqual(filesBefore);
    expect(fs.existsSync(`${crashTdb}-shm`)).toBe(false);
    expect(sha256(crashTdb)).toBe(mainBefore);
    expect(sha256(`${crashTdb}-wal`)).toBe(walBefore);
  });

  it('state.db live writer: committed diagnosis is read fresh from the -wal, workspace untouched (ro-11)', async () => {
    const dir = makeWalWorkspace();
    const sdbPath = path.join(dir, '.pd', 'state.db');
    const writer = new Database(sdbPath);
    writer.prepare(`INSERT INTO pain_diagnoses (id, pain_id, task_id, diagnosis_id, category, root_cause, evidence_json, confidence, artifact_id, created_at)
      VALUES ('diag-live-1', ?, 'task-live', 'diagnosis-live', 'Tooling', 'un-checkpointed live root cause', '[]', 0.9, NULL, '2026-10-06T10:00:00.000Z')`).run(PAIN_1);
    const filesBefore = fs.readdirSync(path.join(dir, '.pd')).sort();
    const mainBefore = sha256(sdbPath);
    const walBefore = sha256(`${sdbPath}-wal`);
    const shmBefore = sha256(`${sdbPath}-shm`);
    try {
      const result = await recallPains(dir, { requestedPrincipleId: P1, limit: 3 });
      expect(result.status).toBe('ok');
      // Freshness through the staged pair: the diagnosis lives only in the
      // un-checkpointed -wal of the live writer.
      const diag = result.results.find((r) => r.painId === PAIN_1)?.diagnoses ?? [];
      expect(diag.map((d) => d.rootCause)).toContain('un-checkpointed live root cause');
      expect(result.sources.stateDb).toBe('ok');
      // Workspace state.db trio untouched.
      expect(fs.readdirSync(path.join(dir, '.pd')).sort()).toEqual(filesBefore);
      expect(sha256(sdbPath)).toBe(mainBefore);
      expect(sha256(`${sdbPath}-wal`)).toBe(walBefore);
      expect(sha256(`${sdbPath}-shm`)).toBe(shmBefore);
    } finally {
      writer.close();
    }
  });

  it('mixed modes: journal trajectory + quiet-WAL state.db stay side-effect free (ro-9)', async () => {
    const dir = makeWalWorkspace();
    // Revert trajectory.db to rollback-journal mode; keep state.db quiet-WAL.
    const tdb = new Database(path.join(dir, '.state', 'trajectory.db'));
    tdb.pragma('journal_mode = DELETE');
    tdb.close();
    const tdbPath = path.join(dir, '.state', 'trajectory.db');
    const sdbPath = path.join(dir, '.pd', 'state.db');
    const before = { t: sha256(tdbPath), s: sha256(sdbPath) };

    const result = await recallPains(dir, { requestedPrincipleId: P1, limit: 3 });

    expect(result.status).toBe('ok');
    expect(result.summary.returned).toBe(2);
    expect(sidecarFiles(tdbPath)).toEqual([]);
    expect(sidecarFiles(sdbPath)).toEqual([]);
    expect(sha256(tdbPath)).toBe(before.t);
    expect(sha256(sdbPath)).toBe(before.s);
  });
});

describe('recallPains: deterministic snapshot-race and failure injection', () => {
  afterEach(() => {
    delete painRecallSnapshotTestHooks.statSync;
    delete painRecallSnapshotTestHooks.mkdtempSync;
    delete painRecallSnapshotTestHooks.afterCopyFile;
  });

  function injectAfterCopyOn(target: string, mutate: (source: string, staged: string) => void): void {
    painRecallSnapshotTestHooks.afterCopyFile = (source: string, staged: string) => {
      if (source === target) mutate(source, staged);
    };
  }

  it('writer modifies the main file mid-snapshot: fingerprint drift rejects the copy (race-1)', async () => {
    const dir = makeWalWorkspace();
    const tdbPath = path.join(dir, '.state', 'trajectory.db');
    injectAfterCopyOn(tdbPath, (source) => {
      fs.appendFileSync(source, 'writer-race-byte'); // simulate a writer committing into the main file
    });
    const result = await recallPains(dir, { requestedPrincipleId: P1, limit: 3 });
    // The post-copy source fingerprint no longer matches → trajectory is
    // unreadable, never a possibly-stale ok/no_matches.
    expect(result.status).toBe('source_unreadable');
    expect(result.sources.trajectoryDb).toBe('unreadable');
  });

  it('writer commits a -wal transaction mid-snapshot: wal appearance rejects the copy (race-2)', async () => {
    const dir = makeWalWorkspace(); // quiet: no -wal at snapshot start
    const tdbPath = path.join(dir, '.state', 'trajectory.db');
    expect(fs.existsSync(`${tdbPath}-wal`)).toBe(false);
    injectAfterCopyOn(tdbPath, () => {
      fs.writeFileSync(`${tdbPath}-wal`, Buffer.from('simulated-wal-commit')); // wal appears mid-snapshot
    });
    const result = await recallPains(dir, { requestedPrincipleId: P1, limit: 3 });
    expect(result.status).toBe('source_unreadable');
    expect(result.sources.trajectoryDb).toBe('unreadable');
  });

  it('writer completes checkpoint and deletes the -wal mid-snapshot: absence at the endpoint is not acceptance (race-3)', async () => {
    // Crash-residue workspace: main WITHOUT the committed row + non-empty -wal
    // WITH it (built by a real writer, copied open, writer then closed).
    const sourceDir = makeWalWorkspace();
    const sourceTdb = path.join(sourceDir, '.state', 'trajectory.db');
    const writer = new Database(sourceTdb);
    writer.prepare(`INSERT INTO pain_events
        (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, host_kind, created_at)
      VALUES ('s6', 'manual', 30, 'checkpoint race', 'moderate', 'user_manual', NULL, NULL, 'pain-race-006', NULL, NULL, '2026-10-07T10:00:00.000Z')`).run();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-recall-race-'));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.state'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.pd'), { recursive: true });
    fs.copyFileSync(sourceTdb, path.join(dir, '.state', 'trajectory.db'));
    fs.copyFileSync(`${sourceTdb}-wal`, path.join(dir, '.state', 'trajectory.db-wal'));
    fs.copyFileSync(path.join(sourceDir, '.state', 'principle_training_state.json'), path.join(dir, '.state', 'principle_training_state.json'));
    fs.copyFileSync(path.join(sourceDir, '.pd', 'state.db'), path.join(dir, '.pd', 'state.db'));
    writer.close();
    // A stale-ok WOULD return pain-race-006 (it is in the copied -wal) — give
    // it a ledger edge so "accepted the old copy" is maximally distinguishable
    // from "rejected".
    const ledgerPath = path.join(dir, '.state', 'principle_training_state.json');
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as {
      _tree: { principles: Record<string, { reuseEvidence?: unknown[] }> };
    };
    const evidence = (ledger._tree.principles[P1]!.reuseEvidence ?? []) as Record<string, unknown>[];
    evidence.push({ painId: 'pain-race-006', candidateId: 'cand-race', decidedAt: '2026-01-06T00:00:00.000Z' });
    ledger._tree.principles[P1]!.reuseEvidence = evidence;
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger));

    const tdbPath = path.join(dir, '.state', 'trajectory.db');
    const mainBefore = sha256(tdbPath);
    injectAfterCopyOn(`${tdbPath}-wal`, (source) => {
      // Simulate checkpoint completion + wal removal mid-snapshot: the main
      // file is rewritten and the -wal disappears at the endpoint.
      fs.rmSync(source);
      fs.appendFileSync(tdbPath, 'checkpoint-rewrote-main');
    });

    const result = await recallPains(dir, { requestedPrincipleId: P1, limit: 10 });

    // Accepting the already-copied pair would return ok with pain-race-006
    // from the deleted wal; the drifted endpoint fingerprints must reject it.
    expect(result.status).toBe('source_unreadable');
    expect(result.sources.trajectoryDb).toBe('unreadable');
    expect(fs.existsSync(`${tdbPath}-wal`)).toBe(false);
    expect(sha256(tdbPath)).not.toBe(mainBefore);
  });

  it('staged copy does not match the fingerprinted source: no ok is ever returned (race-4)', async () => {
    const dir = makeWalWorkspace();
    const tdbPath = path.join(dir, '.state', 'trajectory.db');
    const stateDbPath = path.join(dir, '.pd', 'state.db');
    const before = { t: sha256(tdbPath), s: sha256(stateDbPath) };
    injectAfterCopyOn(tdbPath, (_source, staged) => {
      fs.writeFileSync(staged, Buffer.from('tampered-copy-bytes')); // torn/corrupted copy
    });
    const result = await recallPains(dir, { requestedPrincipleId: P1, limit: 3 });
    expect(result.status).toBe('source_unreadable');
    expect(result.sources.trajectoryDb).toBe('unreadable');
    // The workspace itself was never touched by the failed staging.
    expect(sha256(tdbPath)).toBe(before.t);
    expect(sha256(stateDbPath)).toBe(before.s);
  });

  it('-wal stat failure (non-ENOENT) fails closed as unreadable, never as quiet (inj-stat)', async () => {
    const dir = makeWalWorkspace();
    const tdbPath = path.join(dir, '.state', 'trajectory.db');
    const stateDbPath = path.join(dir, '.pd', 'state.db');
    const before = { t: sha256(tdbPath), s: sha256(stateDbPath), dirState: fs.readdirSync(path.join(dir, '.state')).sort() };
    const realStat = fs.statSync.bind(fs);
    painRecallSnapshotTestHooks.statSync = (p: string) => {
      if (p.endsWith('-wal')) {
        const err = new Error('EACCES: permission denied, stat (simulated)') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return realStat(p);
    };
    const result = await recallPains(dir, { requestedPrincipleId: P1, limit: 3 });
    // P2-1: an undecidable -wal state is unverifiable → source unreadable.
    expect(result.status).toBe('source_unreadable');
    expect(result.sources.trajectoryDb).toBe('unreadable');
    expect(result.sources.stateDb).toBe('unreadable');
    expect(sha256(tdbPath)).toBe(before.t);
    expect(sha256(stateDbPath)).toBe(before.s);
    expect(fs.readdirSync(path.join(dir, '.state')).sort()).toEqual(before.dirState);
  });

  it('mkdtemp failure: no throw, sources degrade per contract, nothing to leak (inj-mkdtemp-throw)', async () => {
    const dir = makeWalWorkspace();
    const stateDirFiles = fs.readdirSync(path.join(dir, '.state')).sort();
    painRecallSnapshotTestHooks.mkdtempSync = () => {
      throw new Error('simulated mkdtemp failure (EACCES)');
    };
    const result = await recallPains(dir, { requestedPrincipleId: P1, limit: 3 });
    // P2-2: mkdtemp is inside the staging error boundary — the query returns
    // a classified result instead of throwing; state.db degrades while
    // trajectory.db (the pain authority) fails as source_unreadable.
    expect(result.status).toBe('source_unreadable');
    expect(result.sources.trajectoryDb).toBe('unreadable');
    expect(result.sources.stateDb).toBe('unreadable');
    expect(fs.readdirSync(path.join(dir, '.state')).sort()).toEqual(stateDirFiles);
  });

  it('staging root created then copy fails: root is removed on the failure path (inj-mkdtemp-cleanup)', async () => {
    const dir = makeWalWorkspace();
    const realMkdtemp = fs.mkdtempSync.bind(fs);
    const createdRoots: string[] = [];
    painRecallSnapshotTestHooks.mkdtempSync = (prefix: string) => {
      const created = realMkdtemp(prefix);
      createdRoots.push(created);
      return created;
    };
    painRecallSnapshotTestHooks.afterCopyFile = () => {
      throw new Error('simulated copy failure after staging');
    };
    const result = await recallPains(dir, { requestedPrincipleId: P1, limit: 3 });
    expect(result.status).toBe('source_unreadable');
    expect(createdRoots.length).toBeGreaterThanOrEqual(2); // state.db + trajectory.db both staged
    for (const root of createdRoots) {
      expect(fs.existsSync(root)).toBe(false); // cleanup ran on every failure path
    }
  });

  // ── ABA / endpoint-equivalence contract (directive round 3) ──────────────
  // Acceptance means: staged bytes == the endpoint (T1) sample of the source.
  // These tests turn each branch of that contract into executable evidence.

  it('real SQLite ABA full cycle mid-snapshot (commit→checkpoint→wal delete) is rejected (aba-1)', async () => {
    const dir = makeWalWorkspace();
    const tdbPath = path.join(dir, '.state', 'trajectory.db');
    injectAfterCopyOn(tdbPath, (source) => {
      // A real writer completes the ENTIRE commit cycle inside the fingerprint
      // window: insert → commit → checkpoint → close (wal removed).
      const writer = new Database(source);
      writer.prepare(`INSERT INTO pain_events
          (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, host_kind, created_at)
        VALUES ('aba', 'manual', 20, 'aba commit', 'moderate', 'user_manual', NULL, NULL, 'pain-aba-100', NULL, NULL, '2026-10-08T10:00:00.000Z')`).run();
      writer.pragma('wal_checkpoint(TRUNCATE)');
      writer.close();
    });
    const result = await recallPains(dir, { requestedPrincipleId: P1, limit: 10 });
    // The commit survived to the endpoint: the file change counter and the
    // checkpointed pages force the main bytes away from T0, so the endpoint
    // re-check MUST reject instead of returning a pre-commit view.
    expect(result.status).toBe('source_unreadable');
    expect(result.sources.trajectoryDb).toBe('unreadable');
    expect(fs.existsSync(`${tdbPath}-wal`)).toBe(false); // cycle really completed
  });

  it('uncommitted writer rollback mid-snapshot: acceptance is correct and the rolled-back row is absent (aba-2)', async () => {
    const dir = makeWalWorkspace();
    const tdbPath = path.join(dir, '.state', 'trajectory.db');
    const mainBefore = sha256(tdbPath);
    injectAfterCopyOn(tdbPath, (source) => {
      // Writer writes into the -wal but NEVER commits; close rolls back and
      // removes the wal. The main file never changes.
      const writer = new Database(source);
      writer.exec('BEGIN');
      writer.prepare(`INSERT INTO pain_events
          (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, host_kind, created_at)
        VALUES ('aba', 'manual', 20, 'never committed', 'moderate', 'user_manual', NULL, NULL, 'pain-aba-rolled', NULL, NULL, '2026-10-08T11:00:00.000Z')`).run();
      writer.close(); // rolls the open transaction back
    });
    const result = await recallPains(dir, { requestedPrincipleId: P1, limit: 10 });
    // The endpoint state genuinely is the T0 state (rollback left no trace),
    // so acceptance is the correct, fresh answer — and the uncommitted row
    // must not appear.
    expect(result.status).toBe('ok');
    expect(result.summary.returned).toBe(2);
    expect(result.results.map((r) => r.painId)).not.toContain('pain-aba-rolled');
    expect(sha256(tdbPath)).toBe(mainBefore);
    expect(fs.existsSync(`${tdbPath}-wal`)).toBe(false);
  });

  it('byte-restoring ABA mid-snapshot: acceptance equals the restored endpoint state (aba-3)', async () => {
    const dir = makeWalWorkspace();
    const tdbPath = path.join(dir, '.state', 'trajectory.db');
    const mainBefore = sha256(tdbPath);
    const m0 = fs.readFileSync(tdbPath);
    injectAfterCopyOn(tdbPath, (source) => {
      // Real commit → checkpoint → close, THEN a non-SQLite byte-level
      // restore of the T0 main image (the directive's endpoint-equal case).
      const writer = new Database(source);
      writer.prepare(`INSERT INTO pain_events
          (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, host_kind, created_at)
        VALUES ('aba', 'manual', 20, 'restored away', 'moderate', 'user_manual', NULL, NULL, 'pain-aba-restore', NULL, NULL, '2026-10-08T12:00:00.000Z')`).run();
      writer.pragma('wal_checkpoint(TRUNCATE)');
      writer.close();
      fs.writeFileSync(source, m0);
    });
    const result = await recallPains(dir, { requestedPrincipleId: P1, limit: 10 });
    // After the byte restore the CURRENT database state is M0 — the staged
    // copy equals it, so returning it is fresh (never a stale view), and the
    // restored-away row is not part of that state.
    expect(result.status).toBe('ok');
    expect(result.summary.returned).toBe(2);
    expect(result.results.map((r) => r.painId)).not.toContain('pain-aba-restore');
    expect(sha256(tdbPath)).toBe(mainBefore); // endpoint == T0 image
    expect(fs.existsSync(`${tdbPath}-wal`)).toBe(false);
  });

  it('source main file disappears mid-snapshot: rejected and staging cleaned (aba-4)', async () => {
    const dir = makeWalWorkspace();
    const tdbPath = path.join(dir, '.state', 'trajectory.db');
    const realMkdtemp = fs.mkdtempSync.bind(fs);
    const createdRoots: string[] = [];
    painRecallSnapshotTestHooks.mkdtempSync = (prefix: string) => {
      const created = realMkdtemp(prefix);
      createdRoots.push(created);
      return created;
    };
    injectAfterCopyOn(tdbPath, (source) => {
      fs.rmSync(source); // source vanishes after the copy
    });
    const result = await recallPains(dir, { requestedPrincipleId: P1, limit: 10 });
    // The snapshot staging rejected (T1 re-check: present → absent), and the
    // post-failure classification reports the file as it now IS — missing —
    // per the "missing stays missing" contract. Either way: no ok, no
    // no_matches, and the failed staging is cleaned.
    expect(result.status).toBe('source_missing');
    expect(result.sources.trajectoryDb).toBe('missing');
    for (const root of createdRoots) {
      expect(fs.existsSync(root)).toBe(false); // failed staging is cleaned
    }
  });

  it('state.db changed mid-snapshot: state degrades unreadable while verifiable results survive (aba-5)', async () => {
    const dir = makeWalWorkspace();
    const sdbPath = path.join(dir, '.pd', 'state.db');
    injectAfterCopyOn(sdbPath, (source) => {
      fs.appendFileSync(source, 'writer-race-byte'); // state.db raced mid-snapshot
    });
    const result = await recallPains(dir, { requestedPrincipleId: P1, limit: 3 });
    // trajectory.db (the pain authority) still reads; state.db degrades per
    // its optional-source contract while the reuse-evidence rows survive.
    expect(result.sources.trajectoryDb).toBe('ok');
    expect(result.sources.stateDb).toBe('unreadable');
    expect(result.status).toBe('partial');
    expect(result.summary.returned).toBe(2);
  });

  // ── T1 non-atomic pair sampling (round-4 directive) ──────────────────────
  // A writer whose full commit→checkpoint→close cycle fits between the T1
  // main fingerprint read and the T1 wal fingerprint read leaves BOTH reads
  // matching their T0 values (stale main M0 read pre-cycle, wal absent again
  // post-cycle) — the pre-fix two-read re-check accepted the stale snapshot.

  afterEach(() => {
    delete painRecallSnapshotTestHooks.afterT1MainFingerprint;
  });

  function injectMidRecheckCycle(targetSuffix: string, insertSql: string): void {
    painRecallSnapshotTestHooks.afterT1MainFingerprint = (sourceDbPath: string) => {
      if (!sourceDbPath.endsWith(targetSuffix)) return; // only the targeted database
      const writer = new Database(sourceDbPath);
      writer.exec(insertSql);
      writer.pragma('wal_checkpoint(TRUNCATE)');
      writer.close(); // commits, checkpoints, and deletes the wal
    };
  }

  it('writer completes commit+checkpoint+wal-delete between the two T1 reads: stale snapshot must be rejected (interleave-1)', async () => {
    const dir = makeWalWorkspace();
    const tdbPath = path.join(dir, '.state', 'trajectory.db');
    // Give the mid-window row a ledger edge so a stale-ok would return 2 rows
    // while the database has 3 committed — the staleness is observable.
    const ledgerPath = path.join(dir, '.state', 'principle_training_state.json');
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as {
      _tree: { principles: Record<string, { reuseEvidence?: unknown[] }> };
    };
    const evidence = (ledger._tree.principles[P1]!.reuseEvidence ?? []) as Record<string, unknown>[];
    evidence.push({ painId: 'pain-interleave-1', candidateId: 'cand-il1', decidedAt: '2026-01-07T00:00:00.000Z' });
    ledger._tree.principles[P1]!.reuseEvidence = evidence;
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger));

    const mainBefore = sha256(tdbPath);
    injectMidRecheckCycle('trajectory.db', `INSERT INTO pain_events
        (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, host_kind, created_at)
      VALUES ('il1', 'manual', 10, 'mid-recheck commit', 'moderate', 'user_manual', NULL, NULL, 'pain-interleave-1', NULL, NULL, '2026-10-09T10:00:00.000Z')`);

    const result = await recallPains(dir, { requestedPrincipleId: P1, limit: 10 });

    // Precondition proofs: the injected cycle really committed + checkpointed
    // + deleted the wal, and the endpoint main is no longer M0.
    expect(fs.existsSync(`${tdbPath}-wal`)).toBe(false);
    expect(sha256(tdbPath)).not.toBe(mainBefore);
    // The contract: a snapshot that predates a commit completed BEFORE the
    // protocol's last observation may not be returned as ok/no_matches.
    expect(result.status).toBe('source_unreadable');
    expect(result.sources.trajectoryDb).toBe('unreadable');
    expect(result.results).toEqual([]);
    // Reader-side zero side effects (asserted BEFORE the verification probe
    // below — a readonly open of a WAL database is itself a shm-creating
    // operation, the exact behavior this suite pins down): recall created no
    // coordination sidecars next to the writer's outcome.
    expect(fs.existsSync(`${tdbPath}-shm`)).toBe(false);
    expect(fs.existsSync(`${tdbPath}-journal`)).toBe(false);
    // Post-hoc verification probe: the committed row really is in the
    // database (its own -shm is a probe artifact, removed on close).
    const probe = new Database(tdbPath, { readonly: true });
    expect(probe.prepare("SELECT COUNT(*) c FROM pain_events WHERE canonical_pain_id = 'pain-interleave-1'").get())
      .toEqual({ c: 1 });
    probe.close();
    for (const probeSidecar of [`${tdbPath}-shm`, `${tdbPath}-wal`]) {
      try { fs.rmSync(probeSidecar, { force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
    }
  });

  it('state.db mid-recheck cycle: optional source degrades unreadable, verifiable rows survive (interleave-2)', async () => {
    const dir = makeWalWorkspace();
    const sdbPath = path.join(dir, '.pd', 'state.db');
    const filesBefore = fs.readdirSync(path.join(dir, '.pd')).sort();
    injectMidRecheckCycle('state.db', `INSERT INTO pain_diagnoses
        (id, pain_id, task_id, diagnosis_id, category, root_cause, evidence_json, confidence, artifact_id, created_at)
      VALUES ('diag-il2', '${PAIN_1}', 'task-il2', 'diagnosis-il2', 'Tooling', 'mid-recheck diagnosis', '[]', 0.9, NULL, '2026-10-09T11:00:00.000Z')`);

    const result = await recallPains(dir, { requestedPrincipleId: P1, limit: 3 });

    expect(fs.existsSync(`${sdbPath}-wal`)).toBe(false); // cycle completed
    // state.db is an optional source: it degrades unreadable while the
    // trajectory-verified rows survive — distinct from interleave-1's
    // authority-source rejection.
    expect(result.status).toBe('partial');
    expect(result.sources.stateDb).toBe('unreadable');
    expect(result.sources.trajectoryDb).toBe('ok');
    expect(result.summary.returned).toBe(2);
    expect(fs.readdirSync(path.join(dir, '.pd')).sort()).toEqual(filesBefore);
    expect(fs.existsSync(`${sdbPath}-shm`)).toBe(false);
  });
});
