/**
 * Unified temp root for session/test scratch (Owner request 2026-11-06).
 *
 * WHY: ad-hoc agent commands kept creating `D:\pd-review-*`, `D:\pd-probe-*`,
 * `D:\pd-ci-fix` directories at the DRIVE ROOT. Nothing scanned the drive root,
 * so every PR-review / probe / CI-fix session added another directory and they
 * accumulated forever. This module is the single entrypoint that replaces them.
 *
 * Usage (works identically from PowerShell and bash — it is plain `node`):
 *
 *   node scripts/dev/pd-tmp.mjs new <label>      # prints the created path
 *   node scripts/dev/pd-tmp.mjs list             # existing managed dirs
 *   node scripts/dev/pd-tmp.mjs sweep [--dry-run] [--ttl-hours N]
 *   node scripts/dev/pd-tmp.mjs check            # read-only drive-root audit
 *
 * Root resolution (first match wins):
 *   PD_TMP_ROOT=<dir>  explicit override (any shell, no PowerShell/bash syntax)
 *   default            <shared-base>/.pd-tmp/<repo-name>
 *     primary checkout  D:\Code\principles                  -> D:\Code\.pd-tmp\principles
 *     task worktree     D:\Code\_worktrees\principles\PRI-1 -> D:\Code\.pd-tmp\principles
 *   The shared base is DERIVED from the repository layout, never a hardcoded
 *   drive letter, so the same file works on any workstation.
 *
 * Layout:
 *   <root>/<YYYYMMDD>/task-<label>-<HHmmss>-<rand6>   agent scratch
 *   <root>/test-runs/<label>-<stamp>-<rand6>          vitest run dirs
 *   <root>/cleanup.log                                JSONL sweep log (rotated)
 *
 * Rules this module enforces:
 *   - the root is never the filesystem root and is refused if it is a symlink;
 *   - sweep never traverses symlinks/junctions and only deletes entries whose
 *     directory mtime is older than the TTL;
 *   - a failed delete stays observable (logged + returned), never silently
 *     swallowed, and is retried on the next sweep;
 *   - `check` is read-only and exists so the "no new drive-root dirs" claim can
 *     be verified instead of asserted.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const DEFAULT_TTL_HOURS = 7 * 24;
const LOG_MAX_BYTES = 512 * 1024;

/** Derive (shared base, repo name) from the checkout's location. */
export function repoLayout(repoRoot = REPO_ROOT) {
  const parent = path.dirname(repoRoot);
  const grand = path.dirname(parent);
  // git-10 worktree pool: <base>/_worktrees/<repo>/<task>
  if (path.basename(grand) === '_worktrees') {
    return { base: path.dirname(grand), name: path.basename(parent) };
  }
  return { base: parent, name: path.basename(repoRoot) };
}

/** Resolved managed temp root for this process. */
export function resolveTmpRoot(env = process.env, repoRoot = REPO_ROOT) {
  const override = env.PD_TMP_ROOT;
  if (override) return path.resolve(override);
  const { base, name } = repoLayout(repoRoot);
  return path.join(base, '.pd-tmp', name);
}

export function sanitizeLabel(label) {
  const safe = String(label ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40);
  return safe || 'task';
}

function stamp(now) {
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`,
    time: `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`,
  };
}

/** Create an isolated, task-scoped directory under the managed root. */
export function createTaskDir({ label, kind = 'task', root = resolveTmpRoot(), now = new Date() } = {}) {
  const { date, time } = stamp(now);
  const rand = crypto.randomBytes(3).toString('hex');
  const name = `${sanitizeLabel(kind)}-${sanitizeLabel(label)}-${time}-${rand}`;
  const dir = path.join(root, date, name);
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

function appendLog(root, entry) {
  try {
    const logFile = path.join(root, 'cleanup.log');
    try {
      if (fs.statSync(logFile).size > LOG_MAX_BYTES) {
        fs.renameSync(logFile, `${logFile}.1`);
      }
    } catch {
      // no log yet — nothing to rotate
    }
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    process.stderr.write(`[pd-tmp] cleanup.log not writable: ${err?.code ?? err}\n`);
  }
}

/**
 * Delete managed entries older than `ttlHours`. Only direct children of `root`
 * (date dirs) and — for legacy layouts — direct child task dirs are considered.
 * Symlinks are never followed and never deleted.
 */
export function sweep({ root = resolveTmpRoot(), ttlHours = DEFAULT_TTL_HOURS, now = Date.now(), dryRun = false, log = true } = {}) {
  const result = { root, removed: [], failed: [], kept: 0, dryRun };

  const resolved = path.resolve(root);
  const fsRoot = path.parse(resolved).root;
  if (resolved === fsRoot) {
    result.refused = 'filesystem-root';
    return result;
  }
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      result.refused = 'root-symlink';
      return result;
    }
    if (!stat.isDirectory()) {
      result.refused = 'not-a-directory';
      return result;
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') result.error = err?.code ?? String(err);
    return result;
  }

  const maxAgeMs = ttlHours * 60 * 60 * 1000;
  let entries;
  try {
    entries = fs.readdirSync(resolved);
  } catch (err) {
    result.error = err?.code ?? String(err);
    return result;
  }

  for (const name of entries) {
    if (name === 'cleanup.log' || name === 'cleanup.log.1') continue;
    const full = path.join(resolved, name);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      result.kept++;
      continue;
    }
    if (now - stat.mtimeMs <= maxAgeMs) {
      result.kept++;
      continue;
    }
    if (dryRun) {
      result.removed.push(name);
      continue;
    }
    try {
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      result.removed.push(name);
    } catch {
      result.failed.push(name); // still locked: retried on the next sweep
    }
  }

  if (log) {
    appendLog(resolved, {
      ts: new Date(now).toISOString(),
      ttlHours,
      dryRun,
      removed: result.removed.length,
      failed: result.failed.length,
      kept: result.kept,
      error: result.error ?? null,
      refused: result.refused ?? null,
    });
  }
  return result;
}

/** List managed date/task directories (read-only). */
export function listManaged(root = resolveTmpRoot()) {
  let names;
  try {
    names = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter((d) => d.isDirectory() && !d.isSymbolicLink())
    .map((d) => path.join(root, d.name));
}

function dirSizeBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let items;
    try {
      items = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      const full = path.join(current, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) stack.push(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          // unreadable file: skip, size is best-effort
        }
      }
    }
  }
  return total;
}

/**
 * Read-only audit of drive-root residue this module is meant to replace.
 * Pattern is the observed ad-hoc prefix family, not the whole disk.
 */
export function driveRootAudit({ driveRoot = path.parse(REPO_ROOT).root, pattern = /^pd-/ } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(driveRoot, { withFileTypes: true });
  } catch (err) {
    return { driveRoot, error: err?.code ?? String(err), residue: [] };
  }
  const residue = [];
  for (const entry of entries) {
    if (!pattern.test(entry.name) || entry.isSymbolicLink()) continue;
    const full = path.join(driveRoot, entry.name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    residue.push({
      path: full,
      name: entry.name,
      isDirectory: entry.isDirectory(),
      mtime: stat.mtime.toISOString(),
      bytes: entry.isDirectory() ? dirSizeBytes(full) : stat.size,
    });
  }
  return { driveRoot, residue };
}

function mb(bytes) {
  return `${Math.round((bytes / (1024 * 1024)) * 100) / 100} MB`;
}

function main(argv) {
  const [command, ...rest] = argv;
  const flags = { dryRun: false, ttlHours: DEFAULT_TTL_HOURS };
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--ttl-hours') flags.ttlHours = Number(rest[++i]);
    else positional.push(arg);
  }

  switch (command) {
    case 'new': {
      const dir = createTaskDir({ label: positional[0] });
      process.stdout.write(`${dir}\n`); // path only: machine-usable from any shell
      return 0;
    }
    case 'list': {
      const dirs = listManaged();
      if (!dirs.length) {
        process.stdout.write('(empty)\n');
        return 0;
      }
      for (const dir of dirs) process.stdout.write(`${dir}\n`);
      return 0;
    }
    case 'sweep': {
      if (!Number.isFinite(flags.ttlHours) || flags.ttlHours <= 0) {
        process.stderr.write('--ttl-hours must be a positive number\n');
        return 2;
      }
      const r = sweep({ ttlHours: flags.ttlHours, dryRun: flags.dryRun });
      const parts = [
        `root=${r.root}`,
        `removed=${r.removed.length}`,
        `failed=${r.failed.length}`,
        `kept=${r.kept}`,
      ];
      if (r.refused) parts.push(`refused=${r.refused}`);
      if (r.error) parts.push(`error=${r.error}`);
      if (r.dryRun) parts.push('dry-run');
      process.stdout.write(`${parts.join(' ')}\n`);
      for (const name of r.failed) process.stderr.write(`failed to remove: ${name}\n`);
      return 0;
    }
    case 'check': {
      const r = driveRootAudit();
      process.stdout.write(`drive-root=${r.driveRoot}\n`);
      if (!r.residue.length) {
        process.stdout.write('no drive-root residue\n');
        return 0;
      }
      let total = 0;
      for (const item of r.residue.sort((a, b) => b.bytes - a.bytes)) {
        total += item.bytes;
        process.stdout.write(`${item.isDirectory ? 'dir ' : 'file'} ${item.path}  ${mb(item.bytes)}  ${item.mtime}\n`);
      }
      process.stdout.write(`total=${mb(total)}\n`);
      return 0;
    }
    default:
      process.stderr.write(
        'usage: node scripts/dev/pd-tmp.mjs <new <label>|list|sweep [--dry-run] [--ttl-hours N]|check>\n',
      );
      return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
