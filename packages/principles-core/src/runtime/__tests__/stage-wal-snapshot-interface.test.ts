/**
 * stageWalSnapshot controlled-interface tests — SPEC-PD-PIPELINE-SPINE-001
 * v0.9 Phase 0 (PRI-1290).
 *
 * The staging mechanism itself (T0/T1 fingerprint protocol, race injection,
 * WAL matrix) is proven by pain-recall-readonly.test.ts. This file pins the
 * PRI-1290 interface contract added on top of that mechanism:
 *
 *   1. the `ok` discriminant survives verbatim — failure branches keep
 *      failing closed and now carry a machine-readable `reason`;
 *   2. success carries `stagedDbPath` / `fingerprint` / `capturedAt` /
 *      `dispose()` in addition to the pre-existing `root`;
 *   3. an active un-checkpointed `-wal` is fully replayed in the staged copy
 *      (the funnel baseline reads the latest committed state);
 *   4. `dispose()` removes ONLY its own staging root, is idempotent, and the
 *      workspace source (bytes and sidecar set) is untouched throughout.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';

import { stageWalSnapshot } from '../pain-recall-read-model.js';
import { painRecallSnapshotTestHooks } from '../pain-recall-snapshot-hooks.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows can briefly hold SQLite handles after close; cleanup failure
      // must not fail the test.
    }
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createWalDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)').run();
  return db;
}

/** Snapshot of the observable filesystem state that must not change. */
function captureSourceState(dbPath: string): { files: string[]; mainHash: string } {
  const dir = path.dirname(dbPath);
  const files = fs.readdirSync(dir).sort();
  return { files, mainHash: sha256File(dbPath) };
}

describe('stageWalSnapshot controlled interface (PRI-1290 Phase 0)', () => {
  it('returns ok:true with stagedDbPath, fingerprint, capturedAt, dispose and root', () => {
    const workspace = makeTempDir('pd-snapiface-ok-');
    const dbPath = path.join(workspace, '.pd', 'state.db');
    const db = createWalDb(dbPath);
    db.close(); // quiet WAL resting state (checkpointed on close)

    const before = captureSourceState(dbPath);
    const staged = stageWalSnapshot(dbPath, ['funnel', 'state.db']);

    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.root).toMatch(/pd-pain-recall-stage-/);
    expect(staged.stagedDbPath).toBe(path.join(staged.root, 'funnel', 'state.db'));
    expect(fs.existsSync(staged.stagedDbPath)).toBe(true);
    // fingerprint describes the frozen bytes of the source main file
    expect(staged.fingerprint.mainSha256).toBe(before.mainHash);
    expect(staged.fingerprint.mainSize).toBe(fs.statSync(dbPath).size);
    expect(staged.fingerprint.walState).toBe('absent'); // closed clean, wal removed by SQLite
    // capturedAt is an ISO instant at/after file creation
    expect(Number.isFinite(Date.parse(staged.capturedAt))).toBe(true);
    expect(typeof staged.dispose).toBe('function');

    // source untouched: same sidecar set, same bytes
    expect(captureSourceState(dbPath)).toEqual(before);

    staged.dispose();
    expect(fs.existsSync(staged.root)).toBe(false);
    // idempotent
    staged.dispose();
    expect(fs.existsSync(staged.root)).toBe(false);
    expect(captureSourceState(dbPath)).toEqual(before);
  });

  it('replays an active un-checkpointed -wal so the staged copy sees the latest commit', () => {
    const workspace = makeTempDir('pd-snapiface-wal-');
    const dbPath = path.join(workspace, '.pd', 'state.db');
    const db = createWalDb(dbPath);
    db.prepare('INSERT INTO t (id, v) VALUES (1, ?)').run('committed-only-in-wal');
    // keep the connection OPEN so SQLite cannot checkpoint on close: the
    // commit lives in the -wal file only.
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);

    const before = captureSourceState(dbPath);
    const staged = stageWalSnapshot(dbPath, ['funnel', 'state.db']);
    expect(staged.ok).toBe(true);
    if (!staged.ok) { db.close(); return; }
    expect(staged.fingerprint.walState).toBe('active');
    expect(typeof staged.fingerprint.walSha256).toBe('string');

    const stagedDb = new Database(staged.stagedDbPath, { readonly: true, fileMustExist: true });
    const row = stagedDb.prepare('SELECT v FROM t WHERE id = 1').get() as { v: string } | undefined;
    stagedDb.close();
    expect(row?.v).toBe('committed-only-in-wal');

    // while the fixture's own writer is still open (pre-close, so SQLite has
    // not checkpointed anything): the source sidecar set and bytes are intact
    expect(captureSourceState(dbPath)).toEqual(before);

    staged.dispose();
    db.close(); // fixture close checkpoints its own wal — outside the contract
    expect(fs.existsSync(staged.root)).toBe(false);
  });

  it('dispose() removes only its own staging root, never a sibling snapshot', () => {
    const workspace = makeTempDir('pd-snapiface-twins-');
    const dbPath = path.join(workspace, '.pd', 'state.db');
    const db = createWalDb(dbPath);
    db.close();

    const first = stageWalSnapshot(dbPath, ['a', 'state.db']);
    const second = stageWalSnapshot(dbPath, ['b', 'state.db']);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    first.dispose();
    expect(fs.existsSync(first.root)).toBe(false);
    expect(fs.existsSync(second.stagedDbPath)).toBe(true);
    second.dispose();
    expect(fs.existsSync(second.root)).toBe(false);
  });

  it('keeps failing closed with a machine-readable reason on fingerprint drift', () => {
    const workspace = makeTempDir('pd-snapiface-drift-');
    const dbPath = path.join(workspace, '.pd', 'state.db');
    const db = createWalDb(dbPath);
    db.close();

    const original = painRecallSnapshotTestHooks.afterT1MainFingerprint;
    let fired = 0;
    painRecallSnapshotTestHooks.afterT1MainFingerprint = () => {
      fired += 1;
      // A write completing between the T1 bracketing reads must invalidate
      // the snapshot (rc-7): mutate the main file behind the protocol's back.
      const fd = fs.openSync(dbPath, 'r+');
      try {
        fs.writeSync(fd, Buffer.from('drift'), 0, 5, 0);
      } finally {
        fs.closeSync(fd);
      }
    };
    try {
      const staged = stageWalSnapshot(dbPath, ['funnel', 'state.db']);
      expect(fired).toBe(1); // injection-sanity: the hook actually ran
      expect(staged.ok).toBe(false);
      if (staged.ok) return;
      expect(typeof staged.reason).toBe('string');
      expect(staged.reason).not.toBe('');
      expect(['t1_wal_drift', 't1_trailing_main_drift', 'staging_error', 't1_main_drift']).toContain(staged.reason);
    } finally {
      painRecallSnapshotTestHooks.afterT1MainFingerprint = original;
    }
  });

  it('fails closed on a missing main database without creating anything', () => {
    const workspace = makeTempDir('pd-snapiface-missing-');
    const staged = stageWalSnapshot(path.join(workspace, 'absent.db'), ['funnel', 'absent.db']);
    expect(staged.ok).toBe(false);
    if (staged.ok) return;
    expect(staged.reason).toBe('main_missing_or_unreadable');
    expect(fs.readdirSync(workspace)).toEqual([]);
  });
});
