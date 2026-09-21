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

/**
 * Remove entries in `base` older than `maxAgeMs`. Never traverses symlinks /
 * junctions and refuses to sweep the system temp root — this function must
 * only ever operate inside our own `.tmp-tests`-style directories.
 */
export function sweepStale({
  base = resolveTempRoot(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now(),
} = {}) {
  const result = { removed: [], kept: 0, failed: [] };
  if (!base) return result;
  if (path.resolve(base) === path.resolve(os.tmpdir())) {
    result.refused = 'system-temp-root';
    return result;
  }
  let entries;
  try {
    entries = fs.readdirSync(base);
  } catch {
    return result; // no directory yet — nothing to sweep
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
const E2E_RESIDUE_RE = /^(e2e|acceptance|verify-fix)-/;

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
  } catch {
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
  return `[temp-lifecycle] ${name}: ${parts.join(', ') || 'nothing to do'}`;
}

/**
 * vitest globalSetup entry. Registered via `globalSetup` in every vitest
 * config. Mutates process.env.TMPDIR/TEMP/TMP; fork/threads workers are
 * spawned afterwards and inherit them (verified against vitest 5.0.0), and
 * spawn-sites using `{ ...process.env }` propagate further to CLI children.
 */
export default async function tempLifecycleGlobalSetup(ctx) {
  const base = resolveTempRoot();
  if (!base) {
    console.log('[temp-lifecycle] PD_TEST_TEMP_ROOT=system — redirection disabled');
    return;
  }
  const label = sanitizeLabel(`vitest-${ctx?.name ?? ''}`);
  const runDir = createRunDir({ base, label });
  const previous = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TMPDIR = runDir;
  process.env.TEMP = runDir;
  process.env.TMP = runDir;

  const swept = sweepStale({ base });
  console.log(describeSweep(path.basename(base), swept));
  const e2e = sweepE2eWorkspace();
  if (e2e.removed.length || e2e.failed.length) console.log(describeSweep('tests/e2e-workspace', e2e));
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
