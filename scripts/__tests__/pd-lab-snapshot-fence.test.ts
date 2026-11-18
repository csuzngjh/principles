/**
 * PRI-1251 remediation round 3 — Nested Staging Directory Fence.
 *
 * Defect (independently reproduced on real Windows against head 31ed5e959):
 * `assertStagingIntact()` verified ONLY the staging ROOT's identity. An
 * attacker-controlled `hooks.afterBackup` hook could delete
 * `<staging>/snapshot`, replace it with a junction pointing INSIDE the source
 * workspace, and the pipeline kept running: the remaining backup, every blob
 * copy, the blob manifest and the final publish all resolved THROUGH the
 * junction into the source workspace. The run still returned
 * `CONSISTENT_WITHIN_WINDOW` with `ok: true` — the snapshot tool became a
 * weapon that writes into the source it must never touch.
 *
 * This suite pins the POST-fix contract (repro-first discipline: every case
 * here was run RED against 31ed5e959 before the fix landed — see the PR for
 * the captured evidence):
 *
 *  FENCE-0  positive control: a quiet run publishes ok:true/published:true.
 *  FENCE-1  CRITICAL: junction swap of <staging>/snapshot in afterBackup
 *           (target = the source's live .pd dir). Must fail the run with a
 *           structured staging-fence reason naming the phase; the source
 *           workspace fingerprint (file set + sha256 + mtime per file, plus
 *           the attacked directory's own mtime) must be EXACTLY unchanged —
 *           the writes the pre-fix chain produced (trajectory.db,
 *           blob-manifest.json, blobs/ inside .pd) must provably not happen.
 *  FENCE-2  same swap after the SECOND backup; detection must happen before
 *           the copy integrity gate opens the replaced path.
 *  FENCE-3a junction swap of <staging>/snapshot/blobs (quiet source) must
 *           fail and publish nothing (pre-fix it published ok:true with the
 *           published blobs/ layer being a junction into the source).
 *  FENCE-3b junction swap of blobs + mid-window rewrite of the referenced
 *           source blob (pre-fix the post-copy re-verification re-copied the
 *           blob THROUGH the junction into the source). Post-fix: no
 *           write-through, structured failure, nothing published.
 *  FENCE-4  symlink (not junction) swap of the snapshot layer is refused even
 *           when the link target stays inside staging (identity is path-bound,
 *           not target-bound). Skipped where the platform refuses symlink
 *           creation (Windows EPERM without privilege).
 *  FENCE-5  junction swap before the manifest phase cannot divert
 *           blob-manifest.json into the source (pre-fix it was written
 *           through the junction into the workspace).
 *  FENCE-6  junction swap right before publish cannot publish a snapshot
 *           whose snapshot/ layer is a link into the source's live .pd dir.
 *  FENCE-9  delete-and-recreate of the snapshot layer with a REAL directory
 *           (same path, fresh inode) is caught by the platform identity
 *           anchor — realpath equality alone was the pre-fix weakness.
 *  FENCE-10 staging ROOT recreated as a real directory: the identity gate
 *           fails and cleanup REFUSES to delete a directory whose identity it
 *           cannot prove (structured cleanup note, residue left behind).
 *  FENCE-11 staging ROOT replaced by a junction: cleanup detaches the link
 *           itself (unlink/rmdir) and never recurses into its target.
 *  FENCE-7  PARTIAL_CONSISTENCY result semantics: ok:false + published:true,
 *           and every published artifact (report JSON, manifest, README)
 *           agrees; the CLI still exits non-zero and its stdout ok field is
 *           consistent (FENCE-8).
 *  FENCE-8  CLI end-to-end with a live concurrent writer on the source:
 *           exit 1, stdout JSON ok:false, published directory still flagged
 *           PARTIAL_CONSISTENCY (publication is NOT success).
 *
 * Source-safety assertions are manifest comparisons over the real filesystem
 * (fingerprintTree: every file's relative path, sha256 and mtimeMs), never a
 * bare boolean. Real SQLite (better-sqlite3 backup API), real blobs, real
 * Windows junctions via `fs.symlinkSync(target, path, 'junction')`.
 *
 * The hooks (afterBackup / afterBlobCopy / beforePublish) exist ONLY for
 * tests; the CLI passes none and its observable behavior does not depend on
 * them.
 */
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
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
const SESSION_ID = 'sess-pd-lab-fence-0001';
const BLOB_BODY = 'F'.repeat(300) + ' externalized assistant turn body for the fence fixture';
const BLOB_NAME = `assistant-${createHash('sha256').update(BLOB_BODY, 'utf8').digest('hex')}.txt`;
const ORPHAN_NAME = `assistant-${'f'.repeat(64)}.txt`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reasonOf(e: unknown): string {
  if (!isRecord(e) || typeof e.reason !== 'string') return '';
  return e.reason;
}

function stageOf(e: unknown): string {
  if (!isRecord(e) || typeof e.stage !== 'string') return '';
  return e.stage;
}

function detailsOf(e: unknown): Record<string, unknown> {
  if (!isRecord(e) || !isRecord(e.details)) return {};
  return e.details;
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
      if (st.isSymbolicLink()) continue; // never follow a reparse point
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

/** Print any source-tree delta so a RED run documents exactly what leaked. */
function logTreeDelta(before: Map<string, { sha256: string; mtimeMs: number }>, after: Map<string, { sha256: string; mtimeMs: number }>, what: string): void {
  const lines: string[] = [];
  for (const [rel, meta] of after) {
    const old = before.get(rel);
    if (old === undefined) lines.push(`ADDED ${rel} (${meta.sha256})`);
    else if (old.sha256 !== meta.sha256) lines.push(`CHANGED ${rel}`);
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) lines.push(`REMOVED ${rel}`);
  }
  if (lines.length > 0) console.error(`[fence delta:${what}] source tree was mutated:\n  ${lines.join('\n  ')}`);
  else console.error(`[fence delta:${what}] source tree unchanged`);
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

interface Fixture {
  root: string;
  workspace: string;
  outParent: string;
  outDir: string;
  stateDb: string;
  trajectoryDb: string;
  blobDir: string;
}

/**
 * Build a synthetic PD workspace with the real schemas: state.db via the
 * runtime's own SqliteConnection init, trajectory.db via the canonical base
 * schema, one referenced blob + one orphan blob.
 */
function buildFixture(root: string, label: string): Fixture {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(root, `ws-${label}-`)));
  const outParent = fs.mkdtempSync(path.join(root, `out-${label}-`));
  const outDir = path.join(outParent, 'snapshot');

  const conn = new SqliteConnection(workspace);
  const stateDb = conn.getDb();
  stateDb
    .prepare('INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('task-fence-0001', 'diagnostician', 'pending', PAST_ISO, PAST_ISO);
  stateDb.pragma('journal_mode = DELETE');
  conn.close();

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
  fs.writeFileSync(path.join(blobDir, ORPHAN_NAME), 'orphan payload nobody references', 'utf8');

  return { root, workspace, outParent, outDir, stateDb: path.join(workspace, '.pd', 'state.db'), trajectoryDb: trajectoryDbPath, blobDir };
}

function cleanupFixture(fx: Fixture): void {
  for (const dir of [fx.workspace, fx.outParent]) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

function expectNoStagingResidue(outParent: string): void {
  const residue = fs.readdirSync(outParent).filter((n) => n.includes('staging'));
  expect(residue).toEqual([]);
}

/** Junction on Windows, directory symlink elsewhere; null when refused. */
function createDirectoryAlias(target: string, link: string): 'junction' | 'dir' | null {
  if (process.platform === 'win32') {
    try {
      fs.symlinkSync(target, link, 'junction');
      return 'junction';
    } catch {
      /* fall through */
    }
  }
  try {
    fs.symlinkSync(target, link, 'dir');
    return 'dir';
  } catch {
    return null;
  }
}

/** True directory symlink (NOT a junction); null when the platform refuses. */
function createDirSymlinkOrNull(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, 'dir');
    return true;
  } catch {
    return false;
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
  stagingDir?: unknown;
  outDir?: unknown;
}
type Hook = (info: HookInfo) => void;
type Hooks = { afterBackup?: Hook; afterBlobCopy?: Hook; beforePublish?: Hook };
type PipelineFn = (
  options: { sourceWorkspace: string; outDir: string },
  hooks?: Hooks,
) => Promise<unknown>;

interface PipelineResult {
  ok: unknown;
  published: unknown;
  status: string;
  report: Record<string, unknown>;
  manifest: Record<string, unknown>;
  outDir: unknown;
}

async function loadPipeline(): Promise<PipelineFn> {
  const mod = await moduleNs();
  if (typeof mod.runSnapshotPipeline !== 'function') throw new Error('snapshot module must export runSnapshotPipeline(options, hooks)');
  const f: unknown = mod.runSnapshotPipeline;
  if (typeof f !== 'function') throw new Error('runSnapshotPipeline export is not a function');
  return (options, hooks) => Promise.resolve().then(() => f(options, hooks));
}

async function runPipeline(fx: Fixture, hooks: Hooks): Promise<PipelineResult> {
  const run = await loadPipeline();
  const result: unknown = await run({ sourceWorkspace: fx.workspace, outDir: fx.outDir }, hooks);
  if (!isRecord(result) || typeof result.status !== 'string' || !isRecord(result.report) || !isRecord(result.manifest)) {
    throw new Error('pipeline result shape invalid');
  }
  return { ok: result.ok, published: result.published, status: result.status, report: result.report, manifest: result.manifest, outDir: result.outDir };
}

/**
 * The staging dir is discoverable from the documented hook payload: the hook
 * receives the staged DB path `<staging>/snapshot/<name>.db`.
 */
function stagingDirOf(info: HookInfo): string {
  if (typeof info.stagingDbPath !== 'string') throw new Error('hook payload missing stagingDbPath');
  return path.dirname(path.dirname(info.stagingDbPath));
}

/**
 * Attack primitive: delete `<staging>/snapshot` (destroying the backup copy
 * inside it) and replace it with a reparse point aimed at `target`.
 */
function swapSnapshotLayerToAlias(stagingDir: string, target: string): void {
  const snapDir = path.join(stagingDir, 'snapshot');
  fs.rmSync(snapDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  const kind = createDirectoryAlias(target, snapDir);
  if (kind === null) throw new Error('platform refused alias creation inside attack hook');
}

/**
 * Attack primitive: destroy and recreate `<staging>/snapshot` as a REAL,
 * empty directory at the same path (same realpath, fresh platform identity).
 */
function recreateSnapshotLayer(stagingDir: string): void {
  const snapDir = path.join(stagingDir, 'snapshot');
  fs.rmSync(snapDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  fs.mkdirSync(snapDir, { recursive: true });
}

/**
 * Attack primitive: delete `<staging>/snapshot/blobs` and replace it with a
 * reparse point aimed at `target`. Used from the afterBlobCopy hook, where
 * the snapshot directory itself still carries an OPEN sqlite handle on
 * Windows (deleting it would EBUSY); the blobs layer has no open handle.
 */
function swapBlobsLayerToAlias(stagingDir: string, target: string): void {
  const blobsDir = path.join(stagingDir, 'snapshot', 'blobs');
  fs.rmSync(blobsDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  const kind = createDirectoryAlias(target, blobsDir);
  if (kind === null) throw new Error('platform refused alias creation inside attack hook');
}

/** Extract the leading JSON document from CLI stdout (summary lines follow). */
function parseLeadingJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no JSON object found in CLI stdout');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('unterminated JSON object in CLI stdout');
}

/** Assert the whole source workspace is byte-for-byte + mtime identical. */
function expectSourceUntouched(fx: Fixture, before: Map<string, { sha256: string; mtimeMs: number }>, what: string): void {
  const after = fingerprintTree(fx.workspace);
  logTreeDelta(before, after, what);
  expectSameTree(before, after, what);
}

/** Assert an attack-target directory gained nothing (entries AND mtime). */
function expectDirUntouched(dir: string, beforeMtimeMs: number, beforeEntries: string[], what: string): void {
  expect(fs.readdirSync(dir).sort(), `${what}: no new entries in the attacked dir`).toEqual([...beforeEntries].sort());
  expect(fs.statSync(dir).mtimeMs, `${what}: attacked dir mtime unchanged (no writes even at directory level)`).toBe(beforeMtimeMs);
}

// ───────────────────────── helpers for CLI partial run ─────────────────────────

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn the CLI and hammer the source state.db with INSERT/DELETE commits. */
function runCliWithConcurrentWriter(fx: Fixture, timeoutMs = 60_000): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, '--source-workspace', fx.workspace, '--out', fx.outDir], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    const writer = setInterval(() => {
      let db;
      try {
        db = new Database(fx.stateDb);
        db.prepare('INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(`task-fence-writer-${Date.now()}`, 'diagnostician', 'pending', PAST_ISO, PAST_ISO);
        db.prepare('DELETE FROM tasks WHERE task_id = ?').run(`task-fence-writer-${Date.now()}`);
      } catch {
        /* momentarily locked by the tool's backup read — retry next tick */
      } finally {
        try {
          db?.close();
        } catch {
          /* already closed */
        }
      }
    }, 4);
    const timer = setTimeout(() => {
      clearInterval(writer);
      child.kill('kill');
      reject(new Error('CLI run with concurrent writer timed out'));
    }, timeoutMs);
    child.on('close', (code) => {
      clearInterval(writer);
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on('error', (err) => {
      clearInterval(writer);
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ────────────────────────────── the fence suite ──────────────────────────────

describe('PRI-1251 round 3: nested staging directory fence', () => {
  it('FENCE-0 positive control: quiet run publishes ok:true + published:true and the source is untouched', { timeout: 90_000 }, async () => {
    const fx = buildFixture(tmpRoot(), 'fence0-ok');
    try {
      const before = fingerprintTree(fx.workspace);
      const result = await runPipeline(fx, {});
      expect(result.status).toBe('CONSISTENT_WITHIN_WINDOW');
      expect(result.ok, 'complete snapshot must be ok:true').toBe(true);
      expect(result.published, 'complete snapshot is published').toBe(true);
      expect(fs.existsSync(path.join(fx.outDir, 'snapshot', 'state.db'))).toBe(true);
      expectNoStagingResidue(fx.outParent);
      expectSourceUntouched(fx, before, 'fence0 positive control');
    } finally {
      cleanupFixture(fx);
    }
  });

  it('FENCE-1 CRITICAL: junction swap of <staging>/snapshot after the state backup fails the run and writes NOTHING into the source', { timeout: 120_000 }, async () => {
    const fx = buildFixture(tmpRoot(), 'fence1-junction-snapshot');
    // The attack target: the source's own LIVE state dir (.pd). Pre-fix this
    // chain diverted the trajectory backup, blob copies and the manifest into
    // it and still returned ok:true / CONSISTENT_WITHIN_WINDOW. The attacker
    // pre-creates a blobs/ subdir in the target (they control the target), so
    // copyFileSync has a parent to land in — exactly what makes the full
    // pre-fix chain (backup + blobs + manifest) write through.
    const attackedDir = path.join(fx.workspace, '.pd');
    fs.mkdirSync(path.join(attackedDir, 'blobs'), { recursive: true });
    try {
      const beforeTree = fingerprintTree(fx.workspace);
      const beforeAttackedMtime = fs.statSync(attackedDir).mtimeMs;
      const beforeAttackedEntries = fs.readdirSync(attackedDir);

      let thrown: unknown = null;
      let resolved: PipelineResult | null = null;
      try {
        resolved = await runPipeline(fx, {
          afterBackup: (info) => {
            if (info.name !== 'state') return;
            swapSnapshotLayerToAlias(stagingDirOf(info), attackedDir);
          },
        });
      } catch (e) {
        thrown = e;
      }

      // Document the pre-fix behavior BEFORE asserting (red evidence): the
      // pre-fix pipeline RESOLVED through the junction and polluted the
      // source workspace; the delta below names exactly which files leaked.
      if (resolved !== null) {
        console.error(`[fence red evidence] FENCE-1 pipeline RESOLVED pre-fix: status=${resolved.status} ok=${String(resolved.ok)}`);
      }
      expectSourceUntouched(fx, beforeTree, 'fence1 junction swap');

      // Fail closed with a structured, phase-bearing reason.
      expect(thrown, 'the pipeline must refuse to continue through the replaced layer').not.toBeNull();
      expect(reasonOf(thrown)).toContain('staging_layer_reparse:snapshot');
      expect(reasonOf(thrown)).toContain('backup:state:post-hook');
      expect(stageOf(thrown)).toBe('staging-fence:backup:state:post-hook');

      // Zero publication.
      expect(fs.existsSync(fx.outDir), 'nothing is published').toBe(false);
      expectNoStagingResidue(fx.outParent);

      // The proof that the previously-successful write chain cannot happen:
      // manifest comparison, not a boolean.
      expectDirUntouched(attackedDir, beforeAttackedMtime, beforeAttackedEntries, 'fence1 junction swap');
    } finally {
      cleanupFixture(fx);
    }
  });

  it('FENCE-2: junction swap after the trajectory backup is caught before the copy integrity gate opens the replaced path', { timeout: 120_000 }, async () => {
    const fx = buildFixture(tmpRoot(), 'fence2-junction-second-backup');
    const attackedDir = path.join(fx.workspace, '.pd');
    fs.mkdirSync(path.join(attackedDir, 'blobs'), { recursive: true });
    try {
      const beforeTree = fingerprintTree(fx.workspace);
      const beforeAttackedMtime = fs.statSync(attackedDir).mtimeMs;
      const beforeAttackedEntries = fs.readdirSync(attackedDir);

      let thrown: unknown = null;
      let calls = 0;
      try {
        await runPipeline(fx, {
          afterBackup: (info) => {
            calls += 1;
            if (calls < 2 || info.name !== 'trajectory') return;
            swapSnapshotLayerToAlias(stagingDirOf(info), attackedDir);
          },
        });
      } catch (e) {
        thrown = e;
      }

      expect(thrown).not.toBeNull();
      expect(reasonOf(thrown)).toContain('staging_layer_reparse:snapshot');
      expect(reasonOf(thrown)).toContain('backup:trajectory:post-hook');
      // The fence fired BEFORE the snapshot integrity gate opened
      // <staging>/snapshot/trajectory.db through the junction.
      expect(reasonOf(thrown)).not.toContain('snapshot_open_failed');
      expect(reasonOf(thrown)).not.toContain('snapshot_integrity_not_ok');

      expect(fs.existsSync(fx.outDir)).toBe(false);
      expectNoStagingResidue(fx.outParent);
      expectSourceUntouched(fx, beforeTree, 'fence2 second-backup swap');
      expectDirUntouched(attackedDir, beforeAttackedMtime, beforeAttackedEntries, 'fence2 second-backup swap');
    } finally {
      cleanupFixture(fx);
    }
  });

  it('FENCE-3a: junction swap of <staging>/snapshot/blobs (quiet source) fails the run and publishes nothing', { timeout: 120_000 }, async () => {
    const fx = buildFixture(tmpRoot(), 'fence3a-junction-blobs');
    const attackedDir = path.join(fx.workspace, 'attacked-blobs');
    fs.mkdirSync(attackedDir);
    try {
      const beforeTree = fingerprintTree(fx.workspace);
      const beforeAttackedMtime = fs.statSync(attackedDir).mtimeMs;

      let thrown: unknown = null;
      let resolved: PipelineResult | null = null;
      try {
        resolved = await runPipeline(fx, {
          afterBlobCopy: (info) => {
            if (typeof info.stagingBlobDir !== 'string') return;
            const stagingDir = path.dirname(path.dirname(info.stagingBlobDir));
            swapBlobsLayerToAlias(stagingDir, attackedDir);
          },
        });
      } catch (e) {
        thrown = e;
      }

      if (resolved !== null) {
        console.error(`[fence red evidence] FENCE-3a pipeline RESOLVED pre-fix: status=${resolved.status} ok=${String(resolved.ok)} (published blobs/ layer was a junction into the source)`);
      }
      expectSourceUntouched(fx, beforeTree, 'fence3a blobs swap');

      expect(thrown).not.toBeNull();
      expect(reasonOf(thrown)).toContain('staging_layer_reparse:blobs');
      expect(reasonOf(thrown)).toContain('blob-copy:post-hook');
      expect(fs.existsSync(fx.outDir)).toBe(false);
      expectNoStagingResidue(fx.outParent);
      expectDirUntouched(attackedDir, beforeAttackedMtime, [], 'fence3a blobs swap');
    } finally {
      cleanupFixture(fx);
    }
  });

  it('FENCE-3b: junction swap of blobs + mid-window blob rewrite proves the re-copy cannot write through into the source', { timeout: 120_000 }, async () => {
    const fx = buildFixture(tmpRoot(), 'fence3b-blobs-write-through');
    const attackedDir = path.join(fx.workspace, 'attacked-blobs');
    fs.mkdirSync(attackedDir, { recursive: true });
    try {
      const beforeTree = fingerprintTree(fx.workspace);
      const beforeAttackedMtime = fs.statSync(attackedDir).mtimeMs;
      const beforeAttackedEntries = fs.readdirSync(attackedDir);
      const blobRel = `.state/blobs/${BLOB_NAME}`;
      const rewrittenBody = `${BLOB_BODY} (rewritten mid-window)`;
      const rewrittenSha = createHash('sha256').update(rewrittenBody, 'utf8').digest('hex');

      let thrown: unknown = null;
      try {
        await runPipeline(fx, {
          afterBlobCopy: (info) => {
            if (typeof info.stagingBlobDir !== 'string' || typeof info.sourceBlobDir !== 'string') return;
            const stagingDir = path.dirname(path.dirname(info.stagingBlobDir));
            swapBlobsLayerToAlias(stagingDir, attackedDir);
            // Rewrite a referenced source blob so the pre-fix pipeline's
            // post-copy re-verification would re-copy it THROUGH the junction
            // into the source workspace (that file was the red evidence).
            fs.writeFileSync(path.join(info.sourceBlobDir, BLOB_NAME), rewrittenBody, 'utf8');
          },
        });
      } catch (e) {
        thrown = e;
      }

      expect(thrown).not.toBeNull();
      expect(reasonOf(thrown)).toContain('staging_layer_reparse:blobs');
      expect(reasonOf(thrown)).toContain('blob-copy:post-hook');
      expect(fs.existsSync(fx.outDir)).toBe(false);
      expectNoStagingResidue(fx.outParent);

      // The ONLY permitted source delta is the attack hook's OWN rewrite of
      // the referenced blob (the hook performs it deliberately). Everything
      // else — file set, hashes, mtimes — must be untouched, and above all
      // the pre-fix write-through file attacked-blobs/<BLOB_NAME> must NOT
      // exist. Pre-fix red evidence: that file appeared AND the run resolved.
      const after = fingerprintTree(fx.workspace);
      logTreeDelta(beforeTree, after, 'fence3b blobs write-through');
      expect([...after.keys()].sort()).toEqual([...beforeTree.keys()].sort());
      const rewrittenEntry = after.get(blobRel);
      expect(rewrittenEntry, 'the hook-rewritten blob still exists').toBeDefined();
      expect(rewrittenEntry?.sha256).toBe(rewrittenSha);
      for (const [rel, meta] of beforeTree) {
        if (rel === blobRel) continue;
        const now = after.get(rel);
        expect(now?.sha256, `${rel} content unchanged`).toBe(meta.sha256);
        expect(now?.mtimeMs, `${rel} mtime unchanged`).toBe(meta.mtimeMs);
      }
      expectDirUntouched(attackedDir, beforeAttackedMtime, beforeAttackedEntries, 'fence3b blobs write-through');
    } finally {
      cleanupFixture(fx);
    }
  });

  it('FENCE-4: a plain symlink swap of the snapshot layer is refused even when the target stays inside staging', { timeout: 120_000 }, async (ctx) => {
    const fx = buildFixture(tmpRoot(), 'fence4-symlink');
    try {
      // Probe privilege first: creating a real directory symlink needs
      // developer mode / privilege on Windows; the junction cases above cover
      // the same isSymbolicLink rejection when this is skipped.
      if (!createDirSymlinkOrNull(fx.workspace, path.join(fx.outParent, 'fence4-probe'))) {
        ctx.skip('platform refused directory symlink creation');
        return;
      }
      fs.rmSync(path.join(fx.outParent, 'fence4-probe'), { force: true });

      const beforeTree = fingerprintTree(fx.workspace);
      const shadow = path.join(fx.outParent, 'snapshot-shadow');
      fs.mkdirSync(shadow, { recursive: true });

      let thrown: unknown = null;
      try {
        await runPipeline(fx, {
          afterBackup: (info) => {
            if (info.name !== 'state') return;
            const stagingDir = stagingDirOf(info);
            const snapDir = path.join(stagingDir, 'snapshot');
            fs.rmSync(snapDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            if (!createDirSymlinkOrNull(shadow, snapDir)) throw new Error('platform refused symlink inside hook');
          },
        });
      } catch (e) {
        thrown = e;
      }

      expect(thrown).not.toBeNull();
      expect(reasonOf(thrown)).toContain('staging_layer_reparse:snapshot');
      expect(fs.existsSync(fx.outDir)).toBe(false);
      expectNoStagingResidue(fx.outParent);
      expectSourceUntouched(fx, beforeTree, 'fence4 symlink swap');
    } finally {
      cleanupFixture(fx);
    }
  });

  it('FENCE-5: a junction planted before the manifest phase is rejected before Phase 6 can write anywhere', { timeout: 120_000 }, async () => {
    const fx = buildFixture(tmpRoot(), 'fence5-manifest-divert');
    const attackedDir = path.join(fx.workspace, 'attacked-manifest');
    fs.mkdirSync(attackedDir);
    try {
      const beforeTree = fingerprintTree(fx.workspace);
      const beforeAttackedMtime = fs.statSync(attackedDir).mtimeMs;

      let thrown: unknown = null;
      let resolved: PipelineResult | null = null;
      try {
        resolved = await runPipeline(fx, {
          afterBlobCopy: (info) => {
            if (typeof info.stagingBlobDir !== 'string') return;
            const stagingDir = path.dirname(path.dirname(info.stagingBlobDir));
            swapBlobsLayerToAlias(stagingDir, attackedDir);
          },
        });
      } catch (e) {
        thrown = e;
      }

      // The fence must fire in the blob-copy:post-hook verification, i.e.
      // BEFORE Phase 6 (manifest), Phase 7 (discovery), Phase 8 (README,
      // report, publish) can run against a hijacked staging area. Pre-fix
      // red evidence: the pipeline RESOLVED and published with the hijacked
      // layer in place.
      if (resolved !== null) {
        console.error(`[fence red evidence] FENCE-5 pipeline RESOLVED pre-fix: status=${resolved.status} ok=${String(resolved.ok)}`);
      }
      expectSourceUntouched(fx, beforeTree, 'fence5 manifest divert');

      expect(thrown).not.toBeNull();
      expect(reasonOf(thrown)).toContain('staging_layer_reparse:blobs');
      expect(reasonOf(thrown)).toContain('blob-copy:post-hook');
      expect(fs.existsSync(fx.outDir)).toBe(false);
      expectNoStagingResidue(fx.outParent);
      expectDirUntouched(attackedDir, beforeAttackedMtime, [], 'fence5 manifest divert');
    } finally {
      cleanupFixture(fx);
    }
  });

  it('FENCE-6: a junction planted right before publish cannot publish a snapshot whose snapshot/ layer is a link into the source .pd dir', { timeout: 120_000 }, async () => {
    const fx = buildFixture(tmpRoot(), 'fence6-publish-swap');
    const attackedDir = path.join(fx.workspace, '.pd');
    try {
      const beforeTree = fingerprintTree(fx.workspace);
      const beforeAttackedMtime = fs.statSync(attackedDir).mtimeMs;
      const beforeAttackedEntries = fs.readdirSync(attackedDir);

      let thrown: unknown = null;
      let resolved: PipelineResult | null = null;
      try {
        resolved = await runPipeline(fx, {
          beforePublish: (info) => {
            if (typeof info.stagingDir !== 'string') return;
            swapSnapshotLayerToAlias(info.stagingDir, attackedDir);
          },
        });
      } catch (e) {
        thrown = e;
      }

      // Pre-fix red evidence: no publish-phase gate existed, so the hijacked
      // staging area was renamed into place and the run returned ok:true.
      if (resolved !== null) {
        console.error(`[fence red evidence] FENCE-6 pipeline RESOLVED pre-fix: status=${resolved.status} ok=${String(resolved.ok)}`);
      }
      expectSourceUntouched(fx, beforeTree, 'fence6 publish swap');

      expect(thrown).not.toBeNull();
      expect(reasonOf(thrown)).toContain('staging_layer_reparse:snapshot');
      expect(reasonOf(thrown)).toContain('publish:pre');
      expect(fs.existsSync(fx.outDir), 'the hijacked staging must never be renamed into place').toBe(false);
      expectNoStagingResidue(fx.outParent);
      expectSourceUntouched(fx, beforeTree, 'fence6 publish swap');
      expectDirUntouched(attackedDir, beforeAttackedMtime, beforeAttackedEntries, 'fence6 publish swap');
    } finally {
      cleanupFixture(fx);
    }
  });

  it('FENCE-9: delete-and-recreate of the snapshot layer with a REAL directory is caught by the platform identity anchor', { timeout: 120_000 }, async () => {
    const fx = buildFixture(tmpRoot(), 'fence9-recreate');
    try {
      const beforeTree = fingerprintTree(fx.workspace);

      let thrown: unknown = null;
      try {
        await runPipeline(fx, {
          afterBackup: (info) => {
            if (info.name !== 'state') return;
            recreateSnapshotLayer(stagingDirOf(info));
          },
        });
      } catch (e) {
        thrown = e;
      }

      expect(thrown).not.toBeNull();
      expect(reasonOf(thrown)).toContain('staging_layer_identity_changed:snapshot');
      expect(reasonOf(thrown)).toContain('backup:state:post-hook');
      expect(fs.existsSync(fx.outDir)).toBe(false);
      // PRI-1252 r4 ownership policy: the recreated snapshot layer is a REAL
      // directory whose identity cannot be proven to be ours — cleanup must
      // PRESERVE it (the pre-r4 flat deletion of unproven layers is exactly
      // the ownership defect this round closes) and the staging root stays
      // behind, reported on the error for a human decision.
      const cleanupNote = String(detailsOf(thrown).stagingCleanup ?? '');
      expect(cleanupNote).toContain('staging_cleanup_preserved_foreign_layers');
      expect(cleanupNote).toContain('snapshot');
      const residue = fs.readdirSync(fx.outParent).filter((n) => n.includes('staging'));
      expect(residue, 'the preserved foreign layer keeps its staging root on disk').toHaveLength(1);
      expectSourceUntouched(fx, beforeTree, 'fence9 recreate');
    } finally {
      cleanupFixture(fx);
    }
  });

  it('FENCE-10: staging ROOT recreated as a real directory fails the identity gate; cleanup skips the unprovable directory and records it', { timeout: 120_000 }, async () => {
    const fx = buildFixture(tmpRoot(), 'fence10-root-recreate');
    try {
      const beforeTree = fingerprintTree(fx.workspace);

      let thrown: unknown = null;
      try {
        await runPipeline(fx, {
          afterBackup: (info) => {
            if (info.name !== 'state') return;
            const stagingDir = stagingDirOf(info);
            fs.rmSync(stagingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            fs.mkdirSync(stagingDir, { recursive: true }); // same path, fresh identity
          },
        });
      } catch (e) {
        thrown = e;
      }

      expect(thrown).not.toBeNull();
      expect(reasonOf(thrown)).toContain('staging_layer_identity_changed:staging');
      expect(fs.existsSync(fx.outDir)).toBe(false);
      // The recreated directory's identity cannot be proven to be ours, so
      // cleanup must NOT delete it — it records the refusal instead, and the
      // unprovable directory stays on disk for a human decision.
      const details = detailsOf(thrown);
      expect(String(details.stagingCleanup ?? '')).toContain('staging_cleanup_skipped');
      expect(fs.existsSync(fx.outParent)).toBe(true);
      const residue = fs.readdirSync(fx.outParent).filter((n) => n.includes('staging'));
      expect(residue, 'the unprovable recreated directory is left for a human').toHaveLength(1);
      expectSourceUntouched(fx, beforeTree, 'fence10 root recreate');
    } finally {
      cleanupFixture(fx);
    }
  });

  it('FENCE-11: staging ROOT replaced by a junction: cleanup detaches the link and never recurses into its target', { timeout: 120_000 }, async () => {
    const fx = buildFixture(tmpRoot(), 'fence11-root-junction');
    const attackedDir = path.join(fx.workspace, 'attacked-root');
    fs.mkdirSync(attackedDir);
    fs.writeFileSync(path.join(attackedDir, 'treasure.txt'), 'must survive cleanup', 'utf8');
    try {
      const beforeTree = fingerprintTree(fx.workspace);
      const beforeTreasureSha = sha256File(path.join(attackedDir, 'treasure.txt'));

      let thrown: unknown = null;
      try {
        await runPipeline(fx, {
          afterBackup: (info) => {
            if (info.name !== 'state') return;
            const stagingDir = stagingDirOf(info);
            fs.rmSync(stagingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            const kind = createDirectoryAlias(attackedDir, stagingDir);
            if (kind === null) throw new Error('platform refused alias creation inside attack hook');
          },
        });
      } catch (e) {
        thrown = e;
      }

      expect(thrown).not.toBeNull();
      expect(reasonOf(thrown)).toContain('staging_layer_reparse:staging');
      expect(fs.existsSync(fx.outDir)).toBe(false);
      // Cleanup detached the link without traversing it: the target's content
      // survived untouched (only the attacker's own mtime-level operations
      // happened, which are the attacker's own doing).
      expect(fs.existsSync(path.join(attackedDir, 'treasure.txt'))).toBe(true);
      expect(sha256File(path.join(attackedDir, 'treasure.txt'))).toBe(beforeTreasureSha);
      expect(fs.existsSync(fx.outParent)).toBe(true);
      const residue = fs.readdirSync(fx.outParent).filter((n) => n.includes('staging'));
      expect(residue, 'the detached link must not leave a staging path behind').toEqual([]);
      expectSourceUntouched(fx, beforeTree, 'fence11 root junction');
    } finally {
      cleanupFixture(fx);
    }
  });
});

describe('PRI-1251 round 3: API status semantics (ok vs published)', () => {
  it('FENCE-7: PARTIAL_CONSISTENCY result carries ok:false + published:true, and every published artifact agrees', { timeout: 90_000 }, async () => {
    const fx = buildFixture(tmpRoot(), 'fence7-partial');
    try {
      const result = await runPipeline(fx, {
        afterBackup: (info) => {
          if (info.name !== 'state' || typeof info.sourceDbPath !== 'string') return;
          const db = new Database(info.sourceDbPath);
          db.prepare('INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('task-fence-partial', 'diagnostician', 'pending', PAST_ISO, PAST_ISO);
          db.close();
        },
      });
      expect(result.status).toBe('PARTIAL_CONSISTENCY');
      expect(result.ok, 'a PARTIAL_CONSISTENCY snapshot is NOT ok').toBe(false);
      expect(result.published, '...but it WAS published (flagged)').toBe(true);

      const reportText = fs.readFileSync(path.join(fx.outDir, 'snapshot-report.json'), 'utf8');
      const report: unknown = JSON.parse(reportText);
      if (!isRecord(report)) throw new Error('report shape invalid');
      expect(report.ok).toBe(false);
      expect(report.published).toBe(true);
      const consistency = report.consistency;
      if (!isRecord(consistency)) throw new Error('report.consistency missing');
      expect(consistency.status).toBe('PARTIAL_CONSISTENCY');

      const manifest: unknown = JSON.parse(fs.readFileSync(path.join(fx.outDir, 'snapshot', 'blob-manifest.json'), 'utf8'));
      if (!isRecord(manifest)) throw new Error('manifest shape invalid');
      expect(manifest.ok).toBe(false);
      expect(manifest.consistencyStatus).toBe('PARTIAL_CONSISTENCY');

      const readme = fs.readFileSync(path.join(fx.outDir, 'README.md'), 'utf8');
      expect(readme).toContain('PARTIAL_CONSISTENCY');
    } finally {
      cleanupFixture(fx);
    }
  });

  it('FENCE-8 CLI: a live concurrent writer makes the run exit 1 with stdout ok:false while the directory stays published-but-flagged', { timeout: 120_000 }, async () => {
    const fx = buildFixture(tmpRoot(), 'fence8-cli-partial');
    try {
      const run = await runCliWithConcurrentWriter(fx);
      expect(run.code, `stderr=${run.stderr}`).toBe(1);

      // stdout: the documented machine-readable summary (a JSON document
      // followed by human summary lines); ok must be false BECAUSE the
      // status is partial — publication is not success.
      const stdoutJson: unknown = parseLeadingJson(run.stdout);
      if (!isRecord(stdoutJson)) throw new Error('stdout was not a JSON object');
      expect(stdoutJson.ok).toBe(false);
      expect(stdoutJson.published).toBe(true);
      expect(stdoutJson.consistencyStatus).toBe('PARTIAL_CONSISTENCY');

      // stderr: the structured fail-loud explanation.
      const stderrJson: unknown = JSON.parse(run.stderr);
      if (!isRecord(stderrJson)) throw new Error('stderr was not a JSON object');
      expect(String(stderrJson.reason)).toContain('consistency_unprovable');
      expect(stderrJson.ok).toBe(false);

      // Published artifacts all flag the partial status; none claim ok.
      const report: unknown = JSON.parse(fs.readFileSync(path.join(fx.outDir, 'snapshot-report.json'), 'utf8'));
      if (!isRecord(report)) throw new Error('report shape invalid');
      expect(report.ok).toBe(false);
      expect(report.published).toBe(true);
      const consistency = report.consistency;
      if (!isRecord(consistency)) throw new Error('report.consistency missing');
      expect(consistency.status).toBe('PARTIAL_CONSISTENCY');
      const manifest: unknown = JSON.parse(fs.readFileSync(path.join(fx.outDir, 'snapshot', 'blob-manifest.json'), 'utf8'));
      if (!isRecord(manifest)) throw new Error('manifest shape invalid');
      expect(manifest.ok).toBe(false);
    } finally {
      cleanupFixture(fx);
    }
  });
});

// ---------------------------------------------------------------------------
// PRI-1252 r4 — TEST-2695-A/B/C/D: ownership-safe cleanup, FIFO marker,
// marker-deletion failure containment. Real SQLite, real junctions, real
// directories — no mocks. Platform-adaptive only where the platform cannot
// host the attack (FIFO creation on Windows), with the reason stated.
// ---------------------------------------------------------------------------
describe('PRI-1252 r4 — ownership-safe cleanup and marker containment', () => {
  it('TEST-2695-A: a foreign real directory swapped in as snapshot/ keeps its evidence — cleanup preserves it and reports the skip', { timeout: 120_000 }, async () => {
    const fx = buildFixture(tmpRoot(), 'r4-foreign-evidence');
    try {
      const beforeTree = fingerprintTree(fx.workspace);
      let thrown: unknown = null;
      try {
        await runPipeline(fx, {
          afterBackup: (info) => {
            if (info.name !== 'state') return;
            const stagingDir = stagingDirOf(info);
            const snapDir = path.join(stagingDir, 'snapshot');
            fs.rmSync(snapDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            fs.mkdirSync(snapDir, { recursive: true });
            fs.writeFileSync(path.join(snapDir, 'foreign-evidence.txt'), 'attacker evidence must survive cleanup', 'utf8');
          },
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).not.toBeNull();
      expect(reasonOf(thrown)).toContain('staging_layer_identity_changed:snapshot');
      expect(fs.existsSync(fx.outDir)).toBe(false);
      // Ownership policy: the unprovable foreign layer is PRESERVED with its
      // evidence file intact; the cleanup note names the skip explicitly.
      const cleanupNote = String(detailsOf(thrown).stagingCleanup ?? '');
      expect(cleanupNote).toContain('staging_cleanup_preserved_foreign_layers');
      const residue = fs.readdirSync(fx.outParent).filter((n) => n.includes('staging'));
      expect(residue, 'staging root stays with the preserved foreign layer').toHaveLength(1);
      const preservedEvidence = path.join(fx.outParent, residue[0], 'snapshot', 'foreign-evidence.txt');
      expect(fs.readFileSync(preservedEvidence, 'utf8')).toBe('attacker evidence must survive cleanup');
      expectSourceUntouched(fx, beforeTree, 'r4 foreign evidence');
    } finally {
      cleanupFixture(fx);
    }
  });

  it('TEST-2695-B: a blobs-layer junction to an external dir is detached — the external target keeps every byte', { timeout: 120_000 }, async () => {
    const fx = buildFixture(tmpRoot(), 'r4-blobs-junction');
    const externalDir = path.join(path.dirname(fx.outParent), 'r4-blobs-external');
    fs.mkdirSync(externalDir, { recursive: true });
    const treasurePath = path.join(externalDir, 'treasure.txt');
    fs.writeFileSync(treasurePath, 'external target must survive cleanup', 'utf8');
    const treasureSha = sha256File(treasurePath);
    try {
      const beforeTree = fingerprintTree(fx.workspace);
      let thrown: unknown = null;
      try {
        await runPipeline(fx, {
          afterBackup: (info) => {
            if (info.name !== 'state') return;
            const stagingDir = stagingDirOf(info);
            const blobsDir = path.join(stagingDir, 'snapshot', 'blobs');
            fs.rmSync(blobsDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            const kind = createDirectoryAlias(externalDir, blobsDir);
            if (kind === null) throw new Error('platform refused junction creation in attack hook');
          },
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).not.toBeNull();
      expect(reasonOf(thrown)).toContain('staging_layer_reparse:blobs');
      expect(fs.existsSync(fx.outDir)).toBe(false);
      // The link was detached, never traversed: the external target is intact.
      expect(fs.existsSync(treasurePath)).toBe(true);
      expect(sha256File(treasurePath)).toBe(treasureSha);
      expectSourceUntouched(fx, beforeTree, 'r4 blobs junction');
    } finally {
      try { fs.rmSync(externalDir, { recursive: true, force: true }); } catch { /* scratch */ }
      cleanupFixture(fx);
    }
  });

  it('TEST-2695-C: a FIFO planted at a fence marker fails fast instead of blocking (Linux; Windows cannot mkfifo)', { timeout: 120_000 }, async (ctx) => {
    if (process.platform === 'win32') {
      // Windows has no FIFOs; the O_NONBLOCK/O_NOFOLLOW single-fd read is
      // POSIX-only hardening. Verified live on the ubuntu CI lane — the PR
      // records the job log evidence (skip is NOT a pass on Windows).
      ctx.skip();
    }
    const fx = buildFixture(tmpRoot(), 'r4-fifo-marker');
    try {
      const beforeTree = fingerprintTree(fx.workspace);
      let thrown: unknown = null;
      try {
        await runPipeline(fx, {
          afterBackup: (info) => {
            if (info.name !== 'state') return;
            const stagingDir = stagingDirOf(info);
            const markerPath = path.join(stagingDir, '.pd-snapshot-fence-marker');
            fs.rmSync(markerPath, { force: true });
            const mkfifo = spawnSync('mkfifo', [markerPath], { encoding: 'utf8' });
            if (mkfifo.status !== 0) throw new Error(`mkfifo unavailable: ${mkfifo.stderr ?? ''}`);
            if (!fs.lstatSync(markerPath).isFIFO()) throw new Error('mkfifo produced a non-FIFO entry');
          },
        });
      } catch (e) {
        thrown = e;
      }
      // Fast structured failure (the 120s test timeout doubles as the
      // not-blocked proof: a blocking open would hang until vitest kills it).
      // The non-blocking open succeeds on the FIFO, the single-fd fstat
      // classifies it as a non-file, and the marker reads as missing —
      // the reason carries `marker_missing`, never a hang.
      expect(thrown).not.toBeNull();
      expect(reasonOf(thrown)).toContain('marker_missing');
      expect(fs.existsSync(fx.outDir)).toBe(false);
      expectSourceUntouched(fx, beforeTree, 'r4 fifo marker');
    } finally {
      cleanupFixture(fx);
    }
  });

  it('TEST-2695-D1: a missing ROOT marker leaves the ENTIRE staging root untouched (identity unprovable → preserve, report)', { timeout: 120_000 }, async () => {
    const fx = buildFixture(tmpRoot(), 'r4-root-marker-gone');
    try {
      const beforeTree = fingerprintTree(fx.workspace);
      let thrown: unknown = null;
      try {
        await runPipeline(fx, {
          afterBackup: (info) => {
            if (info.name !== 'state') return;
            const stagingDir = stagingDirOf(info);
            fs.rmSync(path.join(stagingDir, '.pd-snapshot-fence-marker'), { force: true });
          },
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).not.toBeNull();
      expect(fs.existsSync(fx.outDir)).toBe(false);
      // Cleanup must not guess: without the root marker nothing is provably
      // ours, so NOTHING is deleted and the refusal is explicit.
      const cleanupNote = String(detailsOf(thrown).stagingCleanup ?? '');
      expect(cleanupNote).toContain('staging_cleanup_skipped_identity_changed:marker');
      const residue = fs.readdirSync(fx.outParent).filter((n) => n.includes('staging'));
      expect(residue, 'the whole staging root is preserved for a human').toHaveLength(1);
      expectSourceUntouched(fx, beforeTree, 'r4 root marker gone');
    } finally {
      cleanupFixture(fx);
    }
  });

  it('TEST-2695-D2: a blobs-marker failure does not cascade — snapshot/ (still proven) is cleaned, blobs/ is preserved', { timeout: 120_000 }, async () => {
    const fx = buildFixture(tmpRoot(), 'r4-marker-no-cascade');
    try {
      const beforeTree = fingerprintTree(fx.workspace);
      let thrown: unknown = null;
      try {
        await runPipeline(fx, {
          afterBackup: (info) => {
            if (info.name !== 'state') return;
            const stagingDir = stagingDirOf(info);
            // Destroy ONLY the blobs layer marker: the blobs layer loses its
            // identity proof while the snapshot layer above it stays proven.
            fs.rmSync(path.join(stagingDir, 'snapshot', 'blobs', '.pd-snapshot-fence-marker'), { force: true });
          },
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).not.toBeNull();
      expect(reasonOf(thrown)).toContain('blobs');
      expect(fs.existsSync(fx.outDir)).toBe(false);
      const cleanupNote = String(detailsOf(thrown).stagingCleanup ?? '');
      // Non-cascade proof: blobs is preserved (marker proof lost)...
      expect(cleanupNote).toContain('staging_cleanup_preserved_foreign_layers');
      expect(cleanupNote).toContain('blobs');
      const residue = fs.readdirSync(fx.outParent).filter((n) => n.includes('staging'));
      expect(residue).toHaveLength(1);
      const stagingRoot = path.join(fx.outParent, residue[0]);
      // The preserved branch keeps its ANCESTOR chain (snapshot/ must remain
      // as the holder of the unprovable blobs/), but every OWNED payload
      // around it (the staged DB backups) is removed — deletion is pruned,
      // never cascading through the preserved branch.
      expect(fs.existsSync(path.join(stagingRoot, 'snapshot'))).toBe(true);
      expect(fs.existsSync(path.join(stagingRoot, 'snapshot', 'blobs'))).toBe(true);
      const snapshotRemainder = fs.readdirSync(path.join(stagingRoot, 'snapshot')).filter((n) => n !== 'blobs');
      expect(snapshotRemainder, 'owned payload around the preserved layer is cleaned').toEqual([]);
      expectSourceUntouched(fx, beforeTree, 'r4 marker no cascade');
    } finally {
      cleanupFixture(fx);
    }
  });
});
