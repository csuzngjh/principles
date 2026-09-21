/**
 * Test temp-resource lifecycle — SPEC docs/specs/test-temp-lifecycle-management.md.
 *
 * WHY: per-file finally cleanup is provably unreliable on Windows (SQLite
 * EBUSY while handles are open, vitest worker kills), and 431 test files
 * create temp dirs through os.tmpdir()/mkdtemp. Instead of fixing each file,
 * every vitest run redirects TMPDIR/TEMP/TMP into a run-scoped directory
 * under the managed root (.pd-test-temp, a sibling of the repo checkout)
 * and reclaims stale runs at the START of the next run: cleanup is an async contract between runs, not a synchronous promise.
 * Teardown deletion is best-effort only.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// The managed root MUST live outside the repository tree. Tests that simulate
// an installed runtime pass a tmp-dir moduleDir to
// product-telemetry/eligibility.isRepoCheckoutModuleDir(), which walks up to 8
// ancestors looking for packages/principles-core — a repo-internal temp root
// would make every such "outside any checkout" fixture self-detect as a repo
// checkout and suppress telemetry. Host-verified 2026-09-21.
function defaultTempRoot() {
  return path.join(path.dirname(REPO_ROOT), '.pd-test-temp');
}

/**
 * Resolved temp root for this process.
 * - `PD_TEST_TEMP_ROOT=system` → null (redirection disabled; escape hatch)
 * - any other value → used as the base directory (advanced/test use)
 * - unset → sibling of the repo checkout: <parent(repoRoot)>/.pd-test-temp
 *   (worktree-isolated by construction; MUST stay outside the repo tree, see
 *   defaultTempRoot above)
 */
export function resolveTempRoot() {
  const override = process.env.PD_TEST_TEMP_ROOT;
  if (override === 'system') return null;
  if (override) return path.resolve(override);
  return defaultTempRoot();
}

export function sanitizeLabel(label) {
  const safe = String(label ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40);
  return safe || 'run';
}

function runIdStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Create an isolated run directory under `base` and return its path. */
export function createRunDir({ base = resolveTempRoot(), label = 'run' } = {}) {
  // A null base means redirection is disabled (PD_TEST_TEMP_ROOT=system):
  // callers like check-pipeline-contract still need *a* directory, and the
  // documented semantics of "system" are exactly that.
  const root = base ?? os.tmpdir();
  const runId = `${sanitizeLabel(label)}-${runIdStamp()}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(root, runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Remove entries in `base` older than `maxAgeMs`. Never traverses symlinks /
 * junctions, refuses a `base` that is itself a symlink, and refuses the system
 * temp root — this function must only ever operate inside our own
 * `.pd-test-temp` managed directories. `systemTemp` must be captured BEFORE
 * any TMPDIR/TEMP/TMP redirection (see globalSetup below): os.tmpdir()
 * derives from those env vars, so calling it after the redirect makes the
 * refusal compare against our own run dir and silently never fire.
 */
export function sweepStale({
  base = resolveTempRoot(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now(),
  systemTemp = os.tmpdir(),
} = {}) {
  const result = { removed: [], kept: 0, failed: [] };
  if (!base) return result;
  // CWE-59: path.resolve() does not resolve symlinks or 8.3 short paths, and
  // the per-entry lstat guard below only protects children — a symlinked base
  // would otherwise escape the system-temp check entirely.
  try {
    if (fs.lstatSync(base).isSymbolicLink()) {
      result.refused = 'base-symlink';
      return result;
    }
  } catch {
    // Absent/unreadable base: readdir below records ENOENT/errno as before.
  }
  const baseReal = safeRealpath(base) ?? path.resolve(base);
  const systemReal = safeRealpath(systemTemp) ?? path.resolve(systemTemp);
  if (baseReal === systemReal) {
    result.refused = 'system-temp-root';
    return result;
  }
  let entries;
  try {
    entries = fs.readdirSync(base);
  } catch (err) {
    // rc-9: only a genuinely absent base is "nothing to sweep"; any other
    // error stays observable instead of masquerading as an empty result.
    if (err?.code !== 'ENOENT') result.error = err?.code ?? String(err);
    return result;
  }
  for (const name of entries) {
    const full = path.join(base, name);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (now - stat.mtimeMs <= maxAgeMs) {
      result.kept++;
      continue;
    }
    try {
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      result.removed.push(name);
    } catch {
      result.failed.push(name); // still locked by a dead-but-not-reaped process; next run retries
    }
  }
  return result;
}

// Timestamped run residue written inside the repo by e2e scripts, e.g.
// e2e-1780049707469-b07bb3b5 / acceptance-l3e-1786418574 / verify-fix-1786423073.
// The trailing 10-13 digit epoch anchor is what keeps durable fixtures
// (e2e-fixture-*, e2e-helpers, ...) out of the recursive-delete path.
const E2E_RESIDUE_RE = /^(e2e|acceptance|verify-fix)(-[A-Za-z0-9]+)*-\d{10,13}(-[0-9a-f]{6,8})?$/;

/** Sweep stale timestamped workspaces under tests/e2e-workspace (fixtures untouched). */
export function sweepE2eWorkspace({
  repoRoot = REPO_ROOT,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now(),
} = {}) {
  const result = { removed: [], kept: 0, failed: [] };
  const base = path.join(repoRoot, 'tests', 'e2e-workspace');
  let entries;
  try {
    entries = fs.readdirSync(base);
  } catch (err) {
    if (err?.code !== 'ENOENT') result.error = err?.code ?? String(err);
    return result;
  }
  for (const name of entries) {
    if (!E2E_RESIDUE_RE.test(name)) continue;
    const full = path.join(base, name);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (now - stat.mtimeMs <= maxAgeMs) {
      result.kept++;
      continue;
    }
    try {
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      result.removed.push(name);
    } catch {
      result.failed.push(name);
    }
  }
  return result;
}

function describeSweep(name, r) {
  const parts = [];
  if (r.removed.length) parts.push(`removed ${r.removed.length}`);
  if (r.failed.length) parts.push(`failed ${r.failed.length}`);
  if (r.kept) parts.push(`kept ${r.kept}`);
  if (r.refused) parts.push(`refused ${r.refused}`);
  if (r.error) parts.push(`error ${r.error}`);
  return `[temp-lifecycle] ${name}: ${parts.join(', ') || 'nothing to do'}`;
}

/**
 * vitest globalSetup entry. Registered via `globalSetup` in every vitest
 * config. Mutates process.env.TMPDIR/TEMP/TMP; fork/threads workers are
 * spawned afterwards and inherit them (verified against vitest 5.0.0), and
 * spawn-sites using `{ ...process.env }` propagate further to CLI children.
 */
export default async function tempLifecycleGlobalSetup(ctx) {
  // Capture the real system temp BEFORE writing any env var: os.tmpdir()
  // derives from TMPDIR/TEMP/TMP on Windows, so a sweep that ran after the
  // redirect (or read os.tmpdir() late) would compare our run dir against
  // itself and the system-temp refusal would silently never fire — even when
  // PD_TEST_TEMP_ROOT points AT the system temp.
  const systemTemp = os.tmpdir();
  const base = resolveTempRoot();
  if (!base) {
    console.log('[temp-lifecycle] PD_TEST_TEMP_ROOT=system — redirection disabled');
    return;
  }
  const swept = sweepStale({ base, systemTemp });
  const e2e = sweepE2eWorkspace();
  const label = sanitizeLabel(`vitest-${ctx?.name ?? ''}`);
  const runDir = createRunDir({ base, label });
  const previous = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TMPDIR = runDir;
  process.env.TEMP = runDir;
  process.env.TMP = runDir;

  console.log(describeSweep(path.basename(base), swept));
  if (e2e.removed.length || e2e.failed.length || e2e.error) console.log(describeSweep('tests/e2e-workspace', e2e));
  console.log(`[temp-lifecycle] TMPDIR -> ${runDir}`);

  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (process.env.PD_KEEP_TEST_TEMP === '1') {
      console.log(`[temp-lifecycle] kept ${runDir} (PD_KEEP_TEST_TEMP=1)`);
      return;
    }
    try {
      fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (err) {
      // Not a test failure: the next run's startup sweep reclaims it.
      console.log(`[temp-lifecycle] kept ${runDir} (${err?.code ?? 'cleanup-deferred'})`);
    }
  };
}
