/**
 * PRI-1251 / PD-Lab v0.3 T1 — snapshot tool contract tests.
 *
 * Drives the REAL `snapshot-and-discover.mjs` as a subprocess against a
 * synthetic workspace built with the REAL schemas:
 *  - `state.db` created by `SqliteConnection` (the runtime's own initSchema);
 *  - `trajectory.db` created by `applyTrajectorySchemaBase`.
 *
 * The fixture carries one assistant turn whose body is externalized as a blob
 * (mirroring `storeRawText`: `assistant-<sha256>.txt` referenced by
 * `blob_ref`), one inline user turn, one tool call, one pain event, and one
 * ORPHAN blob file nothing references.
 *
 * Contract under test (HANDOFF T1 / TECH §5.1):
 *  1. both snapshot DBs exist and pass `integrity_check` (re-checked by
 *     opening the copies, not by trusting the report);
 *  2. the referenced blob is copied byte-identical, the orphan is NOT copied;
 *  3. `blob-manifest.json` hashes match the actual copied files, and the
 *     report records the manifest's own SHA-256;
 *  4. every source file's SHA-256 and mtime are unchanged after the run
 *     (read-only discipline);
 *  5. the consistency window and both DBs' latest row timestamps are
 *     recorded; a quiet source yields CONSISTENT_WITHIN_WINDOW;
 *  6. missing `--source-workspace` or `--out` exits 2 with usage;
 *  7. a workspace without initialized DBs exits 1 with a structured reason.
 *
 * Cases 2 (orphan exclusion) and 6 (exit 2) are the negative controls that
 * fail against the pre-PRI-1251 script, which hardcoded its source paths and
 * defaulted `--out` (it would have exited 0 here and copied nothing portable).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3'); // resolved from the repo root, same as the script
const { SqliteConnection, applyTrajectorySchemaBase } = require('@principles/core/runtime');

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'experiment', 'prompt-v2', 'scripts', 'snapshot-and-discover.mjs');

const PAST_ISO = '2026-01-05T10:00:00.000Z';
const SESSION_ID = 'sess-pd-lab-snapshot-0001';
const BLOB_BODY = 'A'.repeat(300) + ' externalized assistant turn body (>=16KB in production; shape is what matters here)';
const BLOB_NAME = `assistant-${createHash('sha256').update(BLOB_BODY, 'utf8').digest('hex')}.txt`;
const ORPHAN_NAME = `assistant-${'0'.repeat(64)}.txt`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The vitest globalSetup redirects TMPDIR/TEMP/TMP into a managed run dir. */
function tmpRoot(): string {
  const raw = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP;
  return fs.realpathSync(typeof raw === 'string' && raw.length > 0 ? raw : os.tmpdir());
}

function sha256File(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** rel path -> { sha256, mtimeMs } for every file under `dir`. */
function fingerprintTree(dir: string): Map<string, { sha256: string; mtimeMs: number }> {
  const out = new Map<string, { sha256: string; mtimeMs: number }>();
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current)) {
      const full = path.join(current, entry);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) {
        walk(full, `${prefix}${entry}/`);
        continue;
      }
      if (st.isFile()) {
        out.set(`${prefix}${entry}`, { sha256: sha256File(full), mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(dir, '');
  return out;
}

interface Fixture {
  workspace: string;
  outDir: string;
  root: string;
  stateDb: string;
  trajectoryDb: string;
  blobDir: string;
}

/** Build a synthetic PD workspace with the real schemas and one orphan blob. */
function buildFixture(root: string, label: string): Fixture {
  const workspace = fs.mkdtempSync(path.join(root, `ws-${label}-`));
  const outDir = fs.mkdtempSync(path.join(root, `out-${label}-`));

  // state.db through the runtime's own schema init.
  const conn = new SqliteConnection(workspace);
  const stateDb = conn.getDb();
  stateDb
    .prepare('INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('task-pd-lab-0001', 'diagnostician', 'pending', PAST_ISO, PAST_ISO);
  stateDb.pragma('journal_mode = DELETE'); // keep the source free of WAL sidecar files
  conn.close();

  // trajectory.db through the canonical base schema.
  const trajectoryDbPath = path.join(workspace, '.state', 'trajectory.db');
  const blobDir = path.join(workspace, '.state', 'blobs');
  fs.mkdirSync(blobDir, { recursive: true });
  const traj = new Database(trajectoryDbPath);
  applyTrajectorySchemaBase(traj);
  traj
    .prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)')
    .run(SESSION_ID, PAST_ISO, PAST_ISO);
  // Long assistant turn: body externalized as a blob, only excerpt inline.
  traj
    .prepare(
      'INSERT INTO assistant_turns (session_id, run_id, provider, model, raw_text, sanitized_text, usage_json, empathy_signal_json, blob_ref, raw_excerpt, created_at)'
      + ' VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      SESSION_ID,
      'run-0001',
      'probe-provider',
      'probe-model',
      '[sanitized]',
      '{}',
      '{}',
      BLOB_NAME,
      `${BLOB_BODY.slice(0, 197)}...`,
      PAST_ISO,
    );
  traj
    .prepare('INSERT INTO user_turns (session_id, turn_index, raw_text, created_at) VALUES (?, ?, ?, ?)')
    .run(SESSION_ID, 0, 'inline user turn', PAST_ISO);
  traj
    .prepare('INSERT INTO tool_calls (session_id, tool_name, outcome, params_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(SESSION_ID, 'Bash', 'success', '{}', PAST_ISO);
  traj
    .prepare('INSERT INTO pain_events (session_id, source, score, created_at) VALUES (?, ?, ?, ?)')
    .run(SESSION_ID, 'user_frustration', 80, PAST_ISO);
  traj.pragma('journal_mode = DELETE');
  traj.close();

  fs.writeFileSync(path.join(blobDir, BLOB_NAME), BLOB_BODY, 'utf8');
  fs.writeFileSync(path.join(blobDir, ORPHAN_NAME), 'orphan payload nobody references', 'utf8');

  return { workspace, outDir, root, stateDb: path.join(workspace, '.pd', 'state.db'), trajectoryDb: trajectoryDbPath, blobDir };
}

function runScript(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    cwd: REPO_ROOT,
  });
}

describe('pd-lab snapshot tool (PRI-1251 T1)', () => {
  it('snapshots both DBs + referenced blobs, excludes orphans, never writes the source', () => {
    const fixture = buildFixture(tmpRoot(), 'main');
    try {
      const before = fingerprintTree(fixture.workspace);
      expect(before.size).toBeGreaterThanOrEqual(4); // state.db, trajectory.db, 2 blobs

      const run = runScript(['--source-workspace', fixture.workspace, '--out', fixture.outDir]);
      expect(run.status).toBe(0);

      // 1. Both copies exist and pass integrity_check when opened directly.
      for (const name of ['state.db', 'trajectory.db']) {
        const copyPath = path.join(fixture.outDir, 'snapshot', name);
        expect(fs.existsSync(copyPath), `snapshot/${name} must exist`).toBe(true);
        const copy = new Database(copyPath, { readonly: true });
        const integrity = copy.pragma('integrity_check', { simple: true });
        copy.close();
        expect(integrity, `${name} integrity_check`).toBe('ok');
      }

      // 2. Referenced blob copied byte-identical; orphan NOT copied.
      const copiedBlob = path.join(fixture.outDir, 'snapshot', 'blobs', BLOB_NAME);
      expect(fs.existsSync(copiedBlob)).toBe(true);
      expect(fs.readFileSync(copiedBlob, 'utf8')).toBe(BLOB_BODY);
      expect(fs.existsSync(path.join(fixture.outDir, 'snapshot', 'blobs', ORPHAN_NAME))).toBe(false);
      expect(fs.readdirSync(path.join(fixture.outDir, 'snapshot', 'blobs'))).toEqual([BLOB_NAME]);

      // 3. Manifest hashes match the actual files; report carries manifest sha.
      const manifestPath = path.join(fixture.outDir, 'snapshot', 'blob-manifest.json');
      const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!isRecord(manifest) || !Array.isArray(manifest.files)) throw new Error('manifest shape invalid');
      expect(manifest.files).toHaveLength(1);
      const file0 = manifest.files[0];
      if (!isRecord(file0)) throw new Error('manifest.files[0] shape invalid');
      expect(file0.sha256).toBe(sha256File(copiedBlob));
      expect(file0.ref).toBe(BLOB_NAME);
      expect(file0.referenceCount).toBe(1);
      if (!Array.isArray(file0.referencedBy)) throw new Error('referencedBy shape invalid');
      expect(file0.referencedBy).toContain('assistant_turns');
      const counts = manifest.counts;
      if (!isRecord(counts)) throw new Error('manifest.counts shape invalid');
      expect(counts.copied).toBe(1);
      expect(counts.orphansNotCopied).toBe(1);

      // 4. Report: integrity, counts, manifest sha, consistency window.
      const report: unknown = JSON.parse(
        fs.readFileSync(path.join(fixture.outDir, 'snapshot-report.json'), 'utf8'),
      );
      if (!isRecord(report)) throw new Error('report shape invalid');
      const snapshots = report.snapshots;
      if (!isRecord(snapshots) || !isRecord(snapshots.state) || !isRecord(snapshots.trajectory)) {
        throw new Error('report.snapshots shape invalid');
      }
      expect(snapshots.state.integrityCheck).toBe('ok');
      expect(snapshots.trajectory.integrityCheck).toBe('ok');
      expect(snapshots.state.sha256).toBe(sha256File(path.join(fixture.outDir, 'snapshot', 'state.db')));
      expect(snapshots.trajectory.sha256).toBe(
        sha256File(path.join(fixture.outDir, 'snapshot', 'trajectory.db')),
      );
      const countsReport = report.counts;
      if (!isRecord(countsReport) || !isRecord(countsReport.trajectory)) {
        throw new Error('report.counts shape invalid');
      }
      const painCounts = countsReport.trajectory['pain_events'];
      if (!isRecord(painCounts)) throw new Error('pain_events counts shape invalid');
      expect(painCounts.source).toBe(1);
      expect(painCounts.snapshot).toBe(1);
      expect(painCounts.match).toBe(true);
      const blobsReport = report.blobs;
      if (!isRecord(blobsReport)) throw new Error('report.blobs shape invalid');
      expect(blobsReport.manifestSha256).toBe(sha256File(manifestPath));
      const consistency = report.consistency;
      if (!isRecord(consistency)) throw new Error('report.consistency shape invalid');
      expect(consistency.status).toBe('CONSISTENT_WITHIN_WINDOW');
      expect(consistency.stateLatestRowAt).toBe(PAST_ISO);
      expect(consistency.trajectoryLatestRowAt).toBe(PAST_ISO);
      expect(typeof consistency.windowStart).toBe('string');
      expect(typeof consistency.windowEnd).toBe('string');
      const params = report.params;
      if (!isRecord(params)) throw new Error('report.params shape invalid');
      expect(path.resolve(String(params.sourceWorkspace))).toBe(path.resolve(fixture.workspace));

      // README index exists and cites the manifest hash (git-16).
      const readme = fs.readFileSync(path.join(fixture.outDir, 'README.md'), 'utf8');
      expect(readme).toContain(String(blobsReport.manifestSha256));
      expect(readme).toContain('orphans NOT copied');

      // 5. Read-only discipline: every source file keeps hash + mtime.
      const after = fingerprintTree(fixture.workspace);
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
      for (const [rel, meta] of before) {
        const now = after.get(rel);
        expect(now, `source file must still exist: ${rel}`).toBeDefined();
        if (now === undefined) continue;
        expect(now.sha256, `source content unchanged: ${rel}`).toBe(meta.sha256);
        expect(now.mtimeMs, `source mtime unchanged: ${rel}`).toBe(meta.mtimeMs);
      }
    } finally {
      fs.rmSync(fixture.workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      fs.rmSync(fixture.outDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('exits 2 with usage when a required flag is missing', () => {
    for (const args of [
      [],
      ['--source-workspace', 'x'],
      ['--out', 'x'],
      ['--source-workspace'], // valueless
      ['--out'],
      ['--source-workspace', 'x', '--out'], // trailing valueless
    ]) {
      const run = runScript(args);
      expect(run.status, `args=${JSON.stringify(args)}`).toBe(2);
      expect(run.stderr, `usage on stderr for ${JSON.stringify(args)}`).toContain('usage:');
    }
  });

  it('exits 1 with a structured reason for a workspace without initialized DBs', () => {
    const root = tmpRoot();
    const empty = fs.mkdtempSync(path.join(root, 'pd-lab-snap-empty-'));
    const out = fs.mkdtempSync(path.join(root, 'pd-lab-snap-out-'));
    try {
      const run = runScript(['--source-workspace', empty, '--out', out]);
      expect(run.status).toBe(1);
      const parsed: unknown = JSON.parse(run.stderr);
      if (!isRecord(parsed) || typeof parsed.reason !== 'string') throw new Error('stderr not structured');
      expect(parsed.reason).toContain('source_db_missing');
      // Nothing was written into the output directory.
      expect(fs.readdirSync(out)).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      fs.rmSync(out, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('refuses an --out inside the source workspace (read-only discipline)', () => {
    const root = tmpRoot();
    const fixture = buildFixture(root, 'inside-out');
    try {
      const innerOut = path.join(fixture.workspace, 'snapshot-out');
      const run = runScript(['--source-workspace', fixture.workspace, '--out', innerOut]);
      expect(run.status).toBe(1);
      const parsed: unknown = JSON.parse(run.stderr);
      if (!isRecord(parsed) || typeof parsed.reason !== 'string') throw new Error('stderr not structured');
      expect(parsed.reason).toContain('out_inside_source_workspace');
      expect(fs.existsSync(innerOut)).toBe(false);
    } finally {
      fs.rmSync(fixture.workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});
