/**
 * PRI-1251 remediation — P1 review findings A1..A4 for snapshot-and-discover.mjs.
 *
 * Repro-first discipline: every case here is written against the POST-fix
 * contract and was run RED against the pre-fix source (commit 7ee862f45).
 *
 *  A1 physical path containment — junction/symlink aliases must not defeat the
 *     "out lives outside the source workspace" rule, and blob sources must be
 *     regular files that resolve inside the authorized blob dir. Failure cases
 *     additionally assert the source workspace kept its exact fingerprint
 *     (SHA-256 + mtime per file), not merely a boolean rejection.
 *  A2 snapshot integrity hard gates — corrupted copies, missing core tables
 *     and unexplained row-count divergence must exit non-zero, publish nothing
 *     that looks like a successful snapshot, and report reason + next action.
 *  A3 cross-source consistency — the only honest proof of "no concurrent write
 *     during the window" is a source-side baseline (PRAGMA data_version +
 *     per-table COUNT/MAX(rowid) + blob-dir hashes) captured before the backup
 *     and re-read after the copies. The test drives the REAL pipeline through
 *     documented deterministic fault-injection hooks and mutates the source
 *     with a second real SQLite connection between phases (no timers, no
 *     sleeps, no mocks).
 *  A4 write-once publishing — an existing target directory is refused (even
 *     empty); the run materializes in a private staging directory and is
 *     atomically renamed into place only after every check passed; failures
 *     clean the staging dir and leave any pre-existing snapshot untouched.
 *
 * The hooks (afterBackup / afterBlobCopy) exist ONLY for tests; the CLI passes
 * none and its observable behavior does not depend on them.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { SqliteConnection, applyTrajectorySchemaBase } = require('@principles/core/runtime');

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'experiment', 'prompt-v2', 'scripts', 'snapshot-and-discover.mjs');
const SCRIPT_URL = pathToFileURL(SCRIPT).href;

const PAST_ISO = '2026-01-05T10:00:00.000Z';
const SESSION_ID = 'sess-pd-lab-harden-0001';
const BLOB_BODY = 'B'.repeat(300) + ' externalized assistant turn body for the hardening fixture';
const BLOB_NAME = `assistant-${createHash('sha256').update(BLOB_BODY, 'utf8').digest('hex')}.txt`;
const BLOB_BODY_V2 = BLOB_BODY + ' (concurrently rewritten during the window)';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** .reason of a thrown structured error ('' when absent). */
function reasonOf(e: unknown): string {
  if (!isRecord(e) || typeof e.reason !== 'string') return '';
  return e.reason;
}

/** The vitest globalSetup redirects TMPDIR/TEMP/TMP into a managed run dir. */
function tmpRoot(): string {
  const raw = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP;
  return fs.realpathSync(typeof raw === 'string' && raw.length > 0 ? raw : os.tmpdir());
}

function sha256File(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** rel path -> { sha256, mtimeMs } for every regular file under `dir`. */
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

function expectSameTree(
  before: Map<string, { sha256: string; mtimeMs: number }>,
  after: Map<string, { sha256: string; mtimeMs: number }>,
  what: string,
): void {
  expect([...after.keys()].sort(), `${what}: file set unchanged`).toEqual([...before.keys()].sort());
  for (const [rel, meta] of before) {
    const now = after.get(rel);
    expect(now, `${what}: ${rel} still exists`).toBeDefined();
    if (now === undefined) continue;
    expect(now.sha256, `${what}: ${rel} content unchanged`).toBe(meta.sha256);
    expect(now.mtimeMs, `${what}: ${rel} mtime unchanged`).toBe(meta.mtimeMs);
  }
}

function parseStructuredStderr(stderr: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stderr);
  if (!isRecord(parsed)) throw new Error('stderr was not a structured JSON object');
  return parsed;
}

interface Fixture {
  workspace: string;
  outParent: string;
  outDir: string;
  stateDb: string;
  trajectoryDb: string;
  blobDir: string;
}

interface BuildOptions {
  /** DROP these tables from state.db after schema init (core-table gate). */
  dropStateTables?: string[];
  /** Overwrite page 2 of state.db with garbage (deterministic corruption). */
  corruptStateDbPageBytes?: boolean;
  /** Turn the referenced blob file into an alias that leaves the blob dir. */
  blobAlias?: 'outside-junction-or-symlink' | 'plain-directory';
}

/**
 * Build a synthetic PD workspace with the real schemas: state.db via the
 * runtime's own SqliteConnection init, trajectory.db via the canonical base
 * schema, one referenced blob + one orphan blob.
 */
function buildFixture(root: string, label: string, opts: BuildOptions = {}): Fixture {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(root, `ws-${label}-`)));
  const outParent = fs.mkdtempSync(path.join(root, `out-${label}-`));
  // Write-once contract: the final --out must NOT pre-exist; the parent does.
  const outDir = path.join(outParent, 'snapshot');

  const conn = new SqliteConnection(workspace);
  const stateDb = conn.getDb();
  stateDb
    .prepare('INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('task-harden-0001', 'diagnostician', 'pending', PAST_ISO, PAST_ISO);
  stateDb.pragma('journal_mode = DELETE');
  conn.close();

  if (opts.dropStateTables && opts.dropStateTables.length > 0) {
    const db = new Database(path.join(workspace, '.pd', 'state.db'));
    for (const t of opts.dropStateTables) db.exec(`DROP TABLE IF EXISTS "${t}"`);
    db.pragma('journal_mode = DELETE');
    db.close();
  }
  if (opts.corruptStateDbPageBytes) {
    const dbPath = path.join(workspace, '.pd', 'state.db');
    const buf = fs.readFileSync(dbPath);
    if (buf.length < 8192) throw new Error(`fixture db too small to corrupt safely: ${buf.length}`);
    buf.fill(0xde, 4096, 8192);
    fs.writeFileSync(dbPath, buf);
  }

  const trajectoryDbPath = path.join(workspace, '.state', 'trajectory.db');
  const blobDir = path.join(workspace, '.state', 'blobs');
  fs.mkdirSync(blobDir, { recursive: true });
  const traj = new Database(trajectoryDbPath);
  applyTrajectorySchemaBase(traj);
  traj.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)').run(SESSION_ID, PAST_ISO, PAST_ISO);
  traj
    .prepare(
      'INSERT INTO assistant_turns (session_id, run_id, provider, model, raw_text, sanitized_text, usage_json, empathy_signal_json, blob_ref, raw_excerpt, created_at)'
      + ' VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)',
    )
    .run(SESSION_ID, 'run-0001', 'probe-provider', 'probe-model', '[sanitized]', '{}', '{}', BLOB_NAME, `${BLOB_BODY.slice(0, 197)}...`, PAST_ISO);
  traj.prepare('INSERT INTO pain_events (session_id, source, score, created_at) VALUES (?, ?, ?, ?)').run(SESSION_ID, 'user_frustration', 80, PAST_ISO);
  traj.pragma('journal_mode = DELETE');
  traj.close();

  fs.writeFileSync(path.join(blobDir, BLOB_NAME), BLOB_BODY, 'utf8');
  fs.writeFileSync(path.join(blobDir, 'assistant-orphan0000000000000000000000000000000000000000000000000000000000.txt'), 'orphan payload nobody references', 'utf8');

  if (opts.blobAlias) {
    const blobPath = path.join(blobDir, BLOB_NAME);
    fs.rmSync(blobPath);
    if (opts.blobAlias === 'plain-directory') {
      // A directory occupying the blob file's name: not a regular file.
      fs.mkdirSync(blobPath);
    } else if (process.platform === 'win32') {
      // Windows cannot create file symlinks without privilege; a junction to a
      // directory OUTSIDE the blob dir exercises the identical realpath
      // containment rejection (the alias resolves outside the blob dir).
      const outside = fs.mkdtempSync(path.join(root, `outside-${label}-`));
      fs.writeFileSync(path.join(outside, 'payload.txt'), 'should never be copied');
      fs.symlinkSync(outside, blobPath, 'junction');
    } else {
      const outside = fs.mkdtempSync(path.join(root, `outside-${label}-`));
      const outsideFile = path.join(outside, 'payload.txt');
      fs.writeFileSync(outsideFile, 'should never be copied');
      fs.symlinkSync(outsideFile, blobPath, 'file');
    }
  }

  return { workspace, outParent, outDir, stateDb: path.join(workspace, '.pd', 'state.db'), trajectoryDb: trajectoryDbPath, blobDir };
}

function cleanupFixture(fx: Fixture): void {
  for (const dir of [fx.workspace, fx.outParent]) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

function runScript(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 120_000, cwd: REPO_ROOT });
}

/**
 * Create a directory alias (junction on Windows, dir symlink elsewhere) that
 * resolves to `target`. Returns null when the platform refuses creation.
 */
function createDirectoryAlias(target: string, link: string): 'junction' | 'dir' | null {
  if (process.platform === 'win32') {
    try {
      fs.symlinkSync(target, link, 'junction');
      return 'junction';
    } catch {
      /* fall through to dir symlink attempt */
    }
  }
  try {
    fs.symlinkSync(target, link, 'dir');
    return 'dir';
  } catch {
    return null;
  }
}

// Dynamic import of the real ESM script (cached module namespace).
let modulePromise: Promise<Record<string, unknown>> | null = null;
function moduleNs(): Promise<Record<string, unknown>> {
  if (modulePromise === null) modulePromise = import(SCRIPT_URL);
  return modulePromise;
}

interface HookInfo {
  name?: unknown;
  stagingDbPath?: unknown;
  sourceDbPath?: unknown;
  stagingBlobDir?: unknown;
  sourceBlobDir?: unknown;
}
type Hook = (info: HookInfo) => void;
type PipelineFn = (
  options: { sourceWorkspace: string; outDir: string },
  hooks?: { afterBackup?: Hook; afterBlobCopy?: Hook },
) => Promise<unknown>;

function pipelineOf(mod: Record<string, unknown>): PipelineFn {
  const f: unknown = mod.runSnapshotPipeline;
  if (typeof f !== 'function') throw new Error('snapshot module must export runSnapshotPipeline(options, hooks)');
  return (options, hooks) => Promise.resolve().then(() => f(options, hooks));
}

async function loadPipeline(): Promise<PipelineFn> {
  const mod = await moduleNs();
  if (typeof mod.SnapshotError !== 'function') throw new Error('snapshot module must export SnapshotError');
  return pipelineOf(mod);
}

/** Residue check: no leftover staging directory beside the target. */
function expectNoStagingResidue(outParent: string): void {
  const residue = fs.readdirSync(outParent).filter((n) => n.includes('staging'));
  expect(residue).toEqual([]);
}

interface PipelineResult {
  status: string;
  report: Record<string, unknown>;
  manifest: Record<string, unknown>;
}

/** Run the pipeline and read back the structured result through type guards. */
async function runPipeline(fx: Fixture, hooks: { afterBackup?: Hook; afterBlobCopy?: Hook }): Promise<PipelineResult> {
  const run = await loadPipeline();
  const result: unknown = await run({ sourceWorkspace: fx.workspace, outDir: fx.outDir }, hooks);
  if (!isRecord(result) || typeof result.status !== 'string' || !isRecord(result.report) || !isRecord(result.manifest)) {
    throw new Error('pipeline result shape invalid');
  }
  return { status: result.status, report: result.report, manifest: result.manifest };
}

function consistencyOf(report: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(report.consistency)) throw new Error('report.consistency missing');
  return report.consistency;
}

function reasonsOf(consistency: Record<string, unknown>): string[] {
  if (!Array.isArray(consistency.reasons)) throw new Error('consistency.reasons missing');
  return consistency.reasons.map(String);
}

// ────────────────────────────── A1: path containment ──────────────────────────────

describe('A1: --out containment and blob sources (real filesystem)', () => {
  it('rejects a plain nested --out inside the source workspace and writes nothing', { timeout: 60_000 }, () => {
    const root = tmpRoot();
    const fx = buildFixture(root, 'a1-plain');
    try {
      const before = fingerprintTree(fx.workspace);
      const nestedOut = path.join(fx.workspace, 'nested', 'snapshot-out');
      const run = runScript(['--source-workspace', fx.workspace, '--out', nestedOut]);
      expect(run.status, `stderr=${run.stderr}`).toBe(1);
      const parsed = parseStructuredStderr(run.stderr);
      expect(parsed.reason).toContain('out_inside_source_workspace');
      expect(typeof parsed.nextAction).toBe('string');
      expect(fs.existsSync(nestedOut)).toBe(false);
      expectSameTree(before, fingerprintTree(fx.workspace), 'plain nested out');
    } finally {
      cleanupFixture(fx);
    }
  });

  it('rejects a --out behind a junction/symlink alias pointing at the source workspace', { timeout: 60_000 }, (ctx) => {
    const root = tmpRoot();
    const fx = buildFixture(root, 'a1-alias');
    const alias = path.join(root, `alias-${path.basename(fx.outParent)}`);
    try {
      const kind = createDirectoryAlias(fx.workspace, alias);
      if (kind === null) {
        ctx.skip('platform refused junction/symlink creation');
        return;
      }
      const before = fingerprintTree(fx.workspace);
      const aliasedOut = path.join(alias, 'snapshot-out');
      const run = runScript(['--source-workspace', fx.workspace, '--out', aliasedOut]);
      expect(run.status, `alias=${kind} stderr=${run.stderr}`).toBe(1);
      const parsed = parseStructuredStderr(run.stderr);
      expect(parsed.reason).toContain('out_inside_source_workspace');
      // The alias must NOT have become a write path into the workspace.
      expect(fs.existsSync(aliasedOut)).toBe(false);
      expect(fs.existsSync(path.join(fx.workspace, 'snapshot-out'))).toBe(false);
      expectSameTree(before, fingerprintTree(fx.workspace), 'junction alias out');
    } finally {
      cleanupFixture(fx);
      fs.rmSync(alias, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('rejects a --out whose non-existing parent chain sits behind an alias to the source workspace', { timeout: 60_000 }, (ctx) => {
    const root = tmpRoot();
    const fx = buildFixture(root, 'a1-alias-deep');
    const alias = path.join(root, `alias-deep-${path.basename(fx.outParent)}`);
    try {
      const kind = createDirectoryAlias(fx.workspace, alias);
      if (kind === null) {
        ctx.skip('platform refused junction/symlink creation');
        return;
      }
      const before = fingerprintTree(fx.workspace);
      // Neither newdir nor deeper exists: containment must resolve through the
      // nearest EXISTING ancestor (the alias) and catch the indirection.
      const deepOut = path.join(alias, 'newdir', 'deeper');
      const run = runScript(['--source-workspace', fx.workspace, '--out', deepOut]);
      expect(run.status, `alias=${kind} stderr=${run.stderr}`).toBe(1);
      const parsed = parseStructuredStderr(run.stderr);
      expect(parsed.reason).toContain('out_inside_source_workspace');
      expect(fs.existsSync(deepOut)).toBe(false);
      expect(fs.existsSync(path.join(fx.workspace, 'newdir'))).toBe(false);
      expectSameTree(before, fingerprintTree(fx.workspace), 'alias + missing parents out');
    } finally {
      cleanupFixture(fx);
      fs.rmSync(alias, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('accepts a normal independent --out that does not exist yet (positive control)', { timeout: 60_000 }, () => {
    const root = tmpRoot();
    const fx = buildFixture(root, 'a1-ok');
    try {
      const before = fingerprintTree(fx.workspace);
      const run = runScript(['--source-workspace', fx.workspace, '--out', fx.outDir]);
      expect(run.status, `stderr=${run.stderr} stdout=${run.stdout}`).toBe(0);
      expect(fs.existsSync(path.join(fx.outDir, 'snapshot', 'state.db'))).toBe(true);
      expect(fs.existsSync(path.join(fx.outDir, 'snapshot-report.json'))).toBe(true);
      expectSameTree(before, fingerprintTree(fx.workspace), 'positive control');
    } finally {
      cleanupFixture(fx);
    }
  });

  it('rejects a referenced blob whose alias resolves outside the blob dir (no source writes)', { timeout: 60_000 }, () => {
    const root = tmpRoot();
    const fx = buildFixture(root, 'a1-blob-alias', { blobAlias: 'outside-junction-or-symlink' });
    try {
      const before = fingerprintTree(fx.workspace);
      const run = runScript(['--source-workspace', fx.workspace, '--out', fx.outDir]);
      expect(run.status, `stderr=${run.stderr}`).toBe(1);
      const parsed = parseStructuredStderr(run.stderr);
      expect(parsed.reason).toContain('blob_source_outside_blob_dir');
      expect(parsed.reason).toContain(BLOB_NAME);
      expect(fs.existsSync(fx.outDir)).toBe(false);
      expectSameTree(before, fingerprintTree(fx.workspace), 'blob alias outside');
    } finally {
      cleanupFixture(fx);
    }
  });

  it('rejects a referenced blob name that is a directory, not a regular file', { timeout: 60_000 }, () => {
    const root = tmpRoot();
    const fx = buildFixture(root, 'a1-blob-dir', { blobAlias: 'plain-directory' });
    try {
      const before = fingerprintTree(fx.workspace);
      const run = runScript(['--source-workspace', fx.workspace, '--out', fx.outDir]);
      expect(run.status, `stderr=${run.stderr}`).toBe(1);
      const parsed = parseStructuredStderr(run.stderr);
      expect(parsed.reason).toContain('blob_source_not_regular_file');
      expect(fs.existsSync(fx.outDir)).toBe(false);
      expectSameTree(before, fingerprintTree(fx.workspace), 'blob dir not regular file');
    } finally {
      cleanupFixture(fx);
    }
  });
});

// ────────────────────────────── A2: integrity hard gates ──────────────────────────────

describe('A2: integrity and divergence fail loud (subprocess + hooks)', () => {
  it('exits 1 when a core table is missing from the source state.db and publishes nothing', { timeout: 60_000 }, () => {
    const root = tmpRoot();
    const fx = buildFixture(root, 'a2-missing-table', { dropStateTables: ['pi_artifacts'] });
    try {
      const before = fingerprintTree(fx.workspace);
      const run = runScript(['--source-workspace', fx.workspace, '--out', fx.outDir]);
      expect(run.status, `stderr=${run.stderr} stdout=${run.stdout}`).toBe(1);
      const parsed = parseStructuredStderr(run.stderr);
      expect(parsed.reason).toContain('core_table_missing');
      expect(parsed.reason).toContain('pi_artifacts');
      expect(typeof parsed.nextAction).toBe('string');
      expect(fs.existsSync(fx.outDir)).toBe(false);
      expectSameTree(before, fingerprintTree(fx.workspace), 'core table missing');
    } finally {
      cleanupFixture(fx);
    }
  });

  it('exits 1 with a structured reason when the source db is corrupted (no output directory left)', { timeout: 60_000 }, () => {
    const root = tmpRoot();
    const fx = buildFixture(root, 'a2-corrupt-source', { corruptStateDbPageBytes: true });
    try {
      const run = runScript(['--source-workspace', fx.workspace, '--out', fx.outDir]);
      expect(run.status, `stderr=${run.stderr}`).toBe(1);
      const parsed = parseStructuredStderr(run.stderr);
      expect(parsed.reason).toContain('source_integrity_not_ok');
      // No directory that looks like a snapshot may remain at the target.
      expect(fs.existsSync(fx.outDir)).toBe(false);
    } finally {
      cleanupFixture(fx);
    }
  });

  it('a tampered snapshot copy fails the copy integrity gate and publishes nothing', { timeout: 90_000 }, async () => {
    const root = tmpRoot();
    const fx = buildFixture(root, 'a2-corrupt-copy');
    try {
      let reasonSeen = '';
      try {
        await runPipeline(fx, {
          afterBackup: (info) => {
            if (info.name !== 'state' || typeof info.stagingDbPath !== 'string') return;
            // Header stays readable; page 2 bytes become garbage (probes show
            // integrity_check reliably reports non-ok for this shape).
            const buf = fs.readFileSync(info.stagingDbPath);
            buf.fill(0xde, 4096, 8192);
            fs.writeFileSync(info.stagingDbPath, buf);
          },
        });
      } catch (e) {
        reasonSeen = reasonOf(e);
      }
      expect(reasonSeen).toContain('snapshot_integrity_not_ok:state');
      expect(fs.existsSync(fx.outDir)).toBe(false);
      expectNoStagingResidue(fx.outParent);
    } finally {
      cleanupFixture(fx);
    }
  });

  it('unexplained row-count divergence (quiet source, tampered copy) fails loud', { timeout: 90_000 }, async () => {
    const root = tmpRoot();
    const fx = buildFixture(root, 'a2-count-divergence');
    try {
      let reasonSeen = '';
      try {
        await runPipeline(fx, {
          afterBackup: (info) => {
            if (info.name !== 'state' || typeof info.stagingDbPath !== 'string') return;
            const db = new Database(info.stagingDbPath);
            db.prepare('INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
              .run('task-tampered-in-copy', 'diagnostician', 'pending', PAST_ISO, PAST_ISO);
            db.close();
          },
        });
      } catch (e) {
        reasonSeen = reasonOf(e);
      }
      expect(reasonSeen).toContain('snapshot_divergence_unexplained');
      expect(reasonSeen).toContain('state:tasks');
      expect(fs.existsSync(fx.outDir)).toBe(false);
      expectNoStagingResidue(fx.outParent);
    } finally {
      cleanupFixture(fx);
    }
  });
});

// ────────────────────────────── A3: cross-source consistency ──────────────────────────────

describe('A3: deterministic concurrency injection through real phase hooks', () => {
  it('quiet source yields CONSISTENT_WITHIN_WINDOW and a published snapshot', { timeout: 90_000 }, async () => {
    const root = tmpRoot();
    const fx = buildFixture(root, 'a3-quiet');
    try {
      const result = await runPipeline(fx, {});
      expect(result.status).toBe('CONSISTENT_WITHIN_WINDOW');
      expect(fs.existsSync(path.join(fx.outDir, 'snapshot-report.json'))).toBe(true);
      const consistency = consistencyOf(result.report);
      expect(consistency.status).toBe('CONSISTENT_WITHIN_WINDOW');
      expect(reasonsOf(consistency)).toEqual([]);
      // staging no longer exists after publish
      expectNoStagingResidue(fx.outParent);
    } finally {
      cleanupFixture(fx);
    }
  });

  it('INSERT during the window downgrades to PARTIAL_CONSISTENCY (detected, flagged, published)', { timeout: 90_000 }, async () => {
    const root = tmpRoot();
    const fx = buildFixture(root, 'a3-insert');
    try {
      const result = await runPipeline(fx, {
        afterBackup: (info) => {
          if (info.name !== 'state' || typeof info.sourceDbPath !== 'string') return;
          const db = new Database(info.sourceDbPath);
          db.prepare('INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('task-concurrent-insert', 'diagnostician', 'pending', PAST_ISO, PAST_ISO);
          db.close();
        },
      });
      expect(result.status).toBe('PARTIAL_CONSISTENCY');
      const consistency = consistencyOf(result.report);
      expect(consistency.status).toBe('PARTIAL_CONSISTENCY');
      const reasons = reasonsOf(consistency);
      expect(reasons.some((r) => r.includes('source_committed_during_window'))).toBe(true);
      expect(reasons.some((r) => r.includes('state:tasks'))).toBe(true);
      // Outputs exist but every artifact carries the flag (never claims full).
      expect(result.manifest.consistencyStatus).toBe('PARTIAL_CONSISTENCY');
      const readme = fs.readFileSync(path.join(fx.outDir, 'README.md'), 'utf8');
      expect(readme).toContain('PARTIAL_CONSISTENCY');
      const reportText = fs.readFileSync(path.join(fx.outDir, 'snapshot-report.json'), 'utf8');
      expect(reportText).toContain('PARTIAL_CONSISTENCY');
    } finally {
      cleanupFixture(fx);
    }
  });

  it('UPDATE that leaves created_at untouched is still caught (PRAGMA data_version, not timestamps)', { timeout: 90_000 }, async () => {
    const root = tmpRoot();
    const fx = buildFixture(root, 'a3-update');
    try {
      const result = await runPipeline(fx, {
        afterBackup: (info) => {
          if (info.name !== 'state' || typeof info.sourceDbPath !== 'string') return;
          const db = new Database(info.sourceDbPath);
          db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?').run('done', 'task-harden-0001');
          db.close();
        },
      });
      expect(result.status).toBe('PARTIAL_CONSISTENCY');
      const consistency = consistencyOf(result.report);
      const reasons = reasonsOf(consistency);
      expect(reasons.some((r) => r.includes('source_committed_during_window'))).toBe(true);
      // The retired timestamp-only mechanism would have seen nothing here:
      // created_at is unchanged and no row is newer than windowStart.
      expect(consistency.rowsNewerThanWindowStart).toBe(0);
    } finally {
      cleanupFixture(fx);
    }
  });

  it('DELETE during the window downgrades to PARTIAL_CONSISTENCY', { timeout: 90_000 }, async () => {
    const root = tmpRoot();
    const fx = buildFixture(root, 'a3-delete');
    try {
      const result = await runPipeline(fx, {
        afterBackup: (info) => {
          if (info.name !== 'state' || typeof info.sourceDbPath !== 'string') return;
          const db = new Database(info.sourceDbPath);
          db.prepare('DELETE FROM tasks WHERE task_id = ?').run('task-harden-0001');
          db.close();
        },
      });
      expect(result.status).toBe('PARTIAL_CONSISTENCY');
      const reasons = reasonsOf(consistencyOf(result.report));
      expect(reasons.some((r) => r.includes('source_committed_during_window') || r.includes('source_table_changed'))).toBe(true);
    } finally {
      cleanupFixture(fx);
    }
  });

  it('a blob rewritten between copy and verify is re-copied stably and flagged PARTIAL_CONSISTENCY', { timeout: 90_000 }, async () => {
    const root = tmpRoot();
    const fx = buildFixture(root, 'a3-blob-change');
    try {
      const result = await runPipeline(fx, {
        afterBlobCopy: (info) => {
          if (typeof info.sourceBlobDir !== 'string') return;
          fs.writeFileSync(path.join(info.sourceBlobDir, BLOB_NAME), BLOB_BODY_V2, 'utf8');
        },
      });
      expect(result.status).toBe('PARTIAL_CONSISTENCY');
      const reasons = reasonsOf(consistencyOf(result.report));
      expect(reasons.some((r) => r.includes(BLOB_NAME) || r.includes('source_blob_changed'))).toBe(true);
      // The published copy holds the stable end-state bytes, manifest matches.
      const copied = path.join(fx.outDir, 'snapshot', 'blobs', BLOB_NAME);
      expect(fs.readFileSync(copied, 'utf8')).toBe(BLOB_BODY_V2);
      if (!Array.isArray(result.manifest.files)) throw new Error('manifest.files missing');
      const file0: unknown = result.manifest.files[0];
      if (!isRecord(file0)) throw new Error('manifest.files[0] shape invalid');
      expect(file0.sha256).toBe(sha256File(copied));
    } finally {
      cleanupFixture(fx);
    }
  });
});

// ────────────────────────────── A4: write-once staging ──────────────────────────────

describe('A4: write-once publishing', () => {
  it('first run succeeds; a second run against the same --out is refused and leaves the snapshot byte-identical', { timeout: 120_000 }, () => {
    const root = tmpRoot();
    const fx = buildFixture(root, 'a4-writeonce');
    try {
      const run1 = runScript(['--source-workspace', fx.workspace, '--out', fx.outDir]);
      expect(run1.status, `first run stderr=${run1.stderr}`).toBe(0);
      const before = fingerprintTree(fx.outDir);
      expect(before.size).toBeGreaterThanOrEqual(3);

      const run2 = runScript(['--source-workspace', fx.workspace, '--out', fx.outDir]);
      expect(run2.status, `second run stdout=${run2.stdout}`).toBe(1);
      const parsed = parseStructuredStderr(run2.stderr);
      expect(parsed.reason).toContain('out_already_exists');
      expectSameTree(before, fingerprintTree(fx.outDir), 'frozen snapshot after refused second run');
    } finally {
      cleanupFixture(fx);
    }
  });

  it('refuses a pre-existing EMPTY target directory (strict write-once)', { timeout: 60_000 }, () => {
    const root = tmpRoot();
    const fx = buildFixture(root, 'a4-empty');
    try {
      fs.mkdirSync(fx.outDir); // empty
      const run = runScript(['--source-workspace', fx.workspace, '--out', fx.outDir]);
      expect(run.status, `stderr=${run.stderr}`).toBe(1);
      const parsed = parseStructuredStderr(run.stderr);
      expect(parsed.reason).toContain('out_already_exists');
      // Nothing leaked into the empty dir; no staging residue beside it.
      expect(fs.readdirSync(fx.outDir)).toEqual([]);
      expectNoStagingResidue(fx.outParent);
    } finally {
      cleanupFixture(fx);
    }
  });

  it('an interrupted run (corrupted source) never leaves a success-looking directory', { timeout: 60_000 }, () => {
    const root = tmpRoot();
    const fx = buildFixture(root, 'a4-interrupted', { corruptStateDbPageBytes: true });
    try {
      const run = runScript(['--source-workspace', fx.workspace, '--out', fx.outDir]);
      expect(run.status).toBe(1);
      expect(fs.existsSync(fx.outDir)).toBe(false);
      expectNoStagingResidue(fx.outParent);
    } finally {
      cleanupFixture(fx);
    }
  });

  it('runSnapshotPipeline refuses an existing out dir in-process with a structured reason', { timeout: 90_000 }, async () => {
    const root = tmpRoot();
    const fx = buildFixture(root, 'a4-inproc');
    try {
      fs.mkdirSync(fx.outDir);
      let reasonSeen = '';
      try {
        await runPipeline(fx, {});
      } catch (e) {
        reasonSeen = reasonOf(e);
      }
      expect(reasonSeen).toContain('out_already_exists');
      expect(fs.readdirSync(fx.outDir)).toEqual([]);
    } finally {
      cleanupFixture(fx);
    }
  });
});
