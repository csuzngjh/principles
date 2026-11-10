#!/usr/bin/env node
/**
 * PRI-1149 — GFI 历史 workspace JSON 迁移.
 *
 * Implements GFI-COMPLETE-REMOVAL-001 SPEC §6.2 / §6.3 (see PR #2332):
 *   - `.state/sessions/*.json`  -> drop the seven retired top-level GFI keys.
 *   - `.state/logs/daily-stats.json` -> drop the `gfi` sub-object of each day.
 *
 * WHY A STANDALONE SCRIPT: `session-tracker.ts` loads only sessions newer than
 * two hours and writes the whole parsed object back, so a hook-path cleanup
 * would never reach expired session files. This tool walks the directory.
 *
 * SAFETY CONTRACT:
 *   - DRY-RUN BY DEFAULT. `--apply` is the only switch that writes.
 *   - `--apply` additionally requires `--confirm-owner-authorization`, because
 *     SPEC §15.3 / the issue require separate Owner approval for real data.
 *   - Nothing in this repository's own state is touched by the test suite;
 *     tests build isolated workspaces under the managed temp root.
 *   - Before any write: back up EVERY file that would change. A backup failure
 *     aborts the whole run without writing anything (fail-closed).
 *   - Writes are atomic (same-directory temp + rename, with Windows lock retry),
 *     matching `packages/openclaw-plugin/src/utils/io.ts`.
 *   - After each write the file is re-read and compared to the planned object;
 *     a mismatch triggers a rollback of already-written files from the backup.
 *   - Idempotent: a second run finds zero changes and writes nothing.
 *
 * STOP THE PD HOST PROCESS BEFORE RUNNING `--apply`. A live process can hold a
 * parsed session in memory and write the retired keys back after migration.
 *
 * Usage:
 *   node scripts/gfi-workspace-json-migration.mjs --workspace <dir> [--json]
 *   node scripts/gfi-workspace-json-migration.mjs --workspace <dir> --apply \
 *       --confirm-owner-authorization [--state-dir <dir>] [--backup-dir <dir>] [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Retired top-level keys of a persisted SessionState (SPEC §6.2). */
export const SESSION_GFI_KEYS = Object.freeze([
  'currentGfi',
  'gfiBySource',
  'lastErrorHash',
  'lastErrorSource',
  'consecutiveErrors',
  'lastGfiDecayAt',
  'dailyGfiPeak',
]);

/** Retired aggregate inside each day of daily-stats.json (SPEC §6.3). */
export const DAILY_STATS_GFI_KEY = 'gfi';

const SESSIONS_REL = 'sessions';
const STATS_REL = path.join('logs', 'daily-stats.json');
const BACKUP_ROOT_REL = 'gfi-migration-backups';

const USAGE = `GFI 历史 workspace JSON 迁移 (PRI-1149 / SPEC §6.2 §6.3)

只读盘点（默认，不写任何文件）:
  node scripts/gfi-workspace-json-migration.mjs --workspace <dir> [--state-dir <dir>] [--json]

实际迁移（需 Owner 单独授权）:
  node scripts/gfi-workspace-json-migration.mjs --workspace <dir> --apply \\
      --confirm-owner-authorization [--backup-dir <dir>] [--json]

参数:
  --workspace <dir>                  目标工作区；默认状态目录为 <workspace>/.state
  --state-dir <dir>                  显式指定状态目录，覆盖默认 .state
  --backup-dir <dir>                 备份目录；默认 <state-dir>/gfi-migration-backups/<UTC 时间戳>
  --apply                            执行写入；缺省只做 dry-run
  --confirm-owner-authorization      --apply 必需；确认 Owner 已单独授权改动真实数据
  --json                             stdout 只输出一个 JSON 对象

执行 --apply 前请先停止 PD 宿主进程，避免内存中的旧 session 被写回。
回滚: 把备份目录内的文件按原相对路径复制回状态目录覆盖即可。
`;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Atomic write, semantically aligned with
 * `packages/openclaw-plugin/src/utils/io.ts::atomicWriteFileSync`. The script is
 * a standalone .mjs and cannot import that TypeScript module, so the small
 * primitive is repeated here rather than introducing a cross-package seam.
 */
function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.gfi-migration.tmp`);
  fs.writeFileSync(tmp, content, 'utf8');
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (err) {
      lastError = err;
      const transient = err && ['EPERM', 'EBUSY', 'EACCES'].includes(err.code);
      if (transient && attempt < 2) continue;
      break;
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    // best effort: the original file was never touched
  }
  throw lastError ?? new Error(`atomic write failed: ${filePath}`);
}

/**
 * Injectable failure points. Only the three operations that can fail on real
 * Owner data are injectable, so the fail-closed paths are deterministically
 * testable without depending on Windows read-only attribute semantics.
 */
export function defaultDeps() {
  return {
    probeWritable(file) {
      try {
        const fd = fs.openSync(file, 'r+');
        fs.closeSync(fd);
        return true;
      } catch {
        return false;
      }
    },
    copyFile(src, dest) {
      fs.copyFileSync(src, dest);
    },
    atomicWrite(file, content) {
      atomicWriteFileSync(file, content);
    },
  };
}

/** Pure: remove only the seven retired keys from a session object. */
export function stripSessionGfiKeys(value) {
  if (!isPlainObject(value)) return { value, removed: [], invalid: true };
  const next = { ...value };
  const removed = [];
  for (const key of SESSION_GFI_KEYS) {
    if (hasOwn(next, key)) {
      delete next[key];
      removed.push(key);
    }
  }
  return { value: next, removed, invalid: false };
}

/** Pure: remove only the `gfi` sub-object of each daily record. */
export function stripDailyStatsGfiKeys(value) {
  if (!isPlainObject(value)) return { value, removed: [], invalid: true };
  const next = { ...value };
  const removed = [];
  for (const [date, record] of Object.entries(next)) {
    if (isPlainObject(record) && hasOwn(record, DAILY_STATS_GFI_KEY)) {
      const clean = { ...record };
      delete clean[DAILY_STATS_GFI_KEY];
      next[date] = clean;
      removed.push(`${date}.${DAILY_STATS_GFI_KEY}`);
    }
  }
  return { value: next, removed, invalid: false };
}

function inspectEntry(file, relative, kind, deps) {
  const base = { file, relative, kind, removedKeys: [] };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ...base, status: 'unreadable', reason: String(err?.message ?? err) };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ...base, status: 'invalid_json', reason: String(err?.message ?? err), originalText: text };
  }
  const strip = kind === 'session'
    ? stripSessionGfiKeys(parsed)
    : stripDailyStatsGfiKeys(parsed);
  if (strip.invalid) {
    return { ...base, status: 'invalid_shape', reason: 'top-level JSON value is not an object', originalText: text };
  }
  if (strip.removed.length === 0) {
    return { ...base, status: 'unchanged' };
  }
  if (!deps.probeWritable(file)) {
    return { ...base, status: 'readonly', reason: 'file is not writable', removedKeys: strip.removed };
  }
  return {
    ...base,
    status: 'change',
    removedKeys: strip.removed,
    cleaned: strip.value,
    cleanedText: JSON.stringify(strip.value, null, 2),
    originalText: text,
  };
}

function publicProblem(entry) {
  return {
    file: entry.file,
    status: entry.status,
    reason: entry.reason ?? '',
    keys: entry.removedKeys,
  };
}

function publicEntry(entry) {
  return { file: entry.file, relative: entry.relative, kind: entry.kind, status: entry.status, keys: entry.removedKeys };
}

/** Read-only plan. Never writes. */
export function planMigration({ workspaceDir, stateDir, deps = defaultDeps() } = {}) {
  if (!workspaceDir && !stateDir) {
    throw new Error('planMigration requires --workspace or --state-dir');
  }
  const resolvedStateDir = stateDir
    ? path.resolve(stateDir)
    : path.join(path.resolve(workspaceDir), '.state');
  const entries = [];
  const sessionsDir = path.join(resolvedStateDir, SESSIONS_REL);

  if (fs.existsSync(sessionsDir)) {
    const names = fs.readdirSync(sessionsDir).filter((name) => name.endsWith('.json')).sort();
    for (const name of names) {
      const file = path.join(sessionsDir, name);
      if (!fs.statSync(file).isFile()) continue;
      entries.push(inspectEntry(file, path.join(SESSIONS_REL, name), 'session', deps));
    }
  }
  const statsFile = path.join(resolvedStateDir, STATS_REL);
  if (fs.existsSync(statsFile) && fs.statSync(statsFile).isFile()) {
    entries.push(inspectEntry(statsFile, STATS_REL, 'daily-stats', deps));
  }

  const changes = entries.filter((e) => e.status === 'change');
  const problems = entries.filter((e) => !['change', 'unchanged'].includes(e.status));
  return {
    stateDir: resolvedStateDir,
    exists: fs.existsSync(resolvedStateDir),
    entries,
    changes,
    problems,
    summary: {
      filesScanned: entries.length,
      filesToChange: changes.length,
      keysToRemove: changes.reduce((n, e) => n + e.removedKeys.length, 0),
      problems: problems.length,
    },
  };
}

function backupStamp(now) {
  return `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
}

function verifyWritten(entry) {
  const actualText = fs.readFileSync(entry.file, 'utf8');
  let actual;
  try {
    actual = JSON.parse(actualText);
  } catch (err) {
    throw new Error(`post-write JSON is unparseable: ${String(err?.message ?? err)}`);
  }
  // Same key order: the cleaned object is serialized verbatim, so a string
  // comparison proves no field was lost, added or duplicated.
  if (JSON.stringify(actual) !== JSON.stringify(entry.cleaned)) {
    throw new Error('post-write integrity mismatch: content differs from the planned object');
  }
  const survivors = entry.kind === 'session'
    ? SESSION_GFI_KEYS.filter((key) => hasOwn(actual, key))
    : Object.entries(actual)
      .filter(([, record]) => isPlainObject(record) && hasOwn(record, DAILY_STATS_GFI_KEY))
      .map(([date]) => `${date}.${DAILY_STATS_GFI_KEY}`);
  if (survivors.length > 0) {
    throw new Error(`retired keys survived the write: ${survivors.join(', ')}`);
  }
}

/**
 * Apply the plan. Fail-closed: any unreadable/corrupt/readonly file blocks the
 * WHOLE run, and any backup or write failure leaves the original data intact.
 */
export function applyMigration({
  workspaceDir,
  stateDir,
  backupDir,
  confirmOwnerAuthorization = false,
  deps = defaultDeps(),
  now = Date.now(),
} = {}) {
  if (!confirmOwnerAuthorization) {
    return {
      ok: false,
      mode: 'apply',
      reason: 'owner_authorization_required',
      hint: 'pass --confirm-owner-authorization only after the Owner has approved changing real data',
      summary: { filesChanged: 0, keysRemoved: 0, verifiedFiles: 0, skipped: 0 },
    };
  }

  const plan = planMigration({ workspaceDir, stateDir, deps });
  const emptySummary = { filesChanged: 0, keysRemoved: 0, verifiedFiles: 0, skipped: plan.problems.length };

  if (!plan.exists) {
    return {
      ok: false, mode: 'apply', reason: 'state_dir_missing',
      stateDir: plan.stateDir, planSummary: plan.summary, summary: emptySummary,
      backupDir: null, problems: plan.problems.map(publicProblem),
    };
  }
  if (plan.problems.length > 0) {
    return {
      ok: false, mode: 'apply', reason: 'blocked_by_problems',
      stateDir: plan.stateDir, planSummary: plan.summary, summary: emptySummary,
      backupDir: null, problems: plan.problems.map(publicProblem),
      hint: 'fix or move the listed files, then re-run; nothing was written',
    };
  }
  if (plan.changes.length === 0) {
    return {
      ok: true, mode: 'apply', reason: 'no_changes',
      stateDir: plan.stateDir, planSummary: plan.summary, summary: emptySummary,
      backupDir: null, problems: [],
      hint: 'idempotent: no retired keys remain',
    };
  }

  const backupRoot = path.resolve(
    backupDir ?? path.join(plan.stateDir, BACKUP_ROOT_REL, backupStamp(now)),
  );

  // Phase 1: back up EVERY planned file before touching anything.
  const backedUp = [];
  try {
    for (const entry of plan.changes) {
      const dest = path.join(backupRoot, entry.relative);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      deps.copyFile(entry.file, dest);
      backedUp.push({ entry, dest });
    }
  } catch (err) {
    return {
      ok: false, mode: 'apply', reason: 'backup_failed',
      stateDir: plan.stateDir, planSummary: plan.summary, summary: emptySummary,
      backupDir: backupRoot, problems: [],
      error: String(err?.message ?? err),
      hint: 'backup failed before any write; original files are untouched',
    };
  }

  // Phase 2: atomic write + post-write verification, file by file.
  const written = [];
  const writeFailures = [];
  for (const { entry } of backedUp) {
    try {
      deps.atomicWrite(entry.file, entry.cleanedText);
      verifyWritten(entry);
      written.push(entry);
    } catch (err) {
      writeFailures.push({ file: entry.file, reason: String(err?.message ?? err) });
      break;
    }
  }

  // Phase 3: any failure restores the whole run from the backup.
  const rollbackErrors = [];
  if (writeFailures.length > 0) {
    for (const entry of written) {
      try {
        deps.copyFile(path.join(backupRoot, entry.relative), entry.file);
      } catch (err) {
        rollbackErrors.push({ file: entry.file, reason: String(err?.message ?? err) });
      }
    }
  }

  const ok = writeFailures.length === 0 && rollbackErrors.length === 0;
  return {
    ok,
    mode: 'apply',
    reason: ok ? 'applied' : 'write_failed_rolled_back',
    stateDir: plan.stateDir,
    planSummary: plan.summary,
    summary: {
      filesChanged: writeFailures.length === 0 ? written.length : 0,
      keysRemoved: writeFailures.length === 0 ? written.reduce((n, e) => n + e.removedKeys.length, 0) : 0,
      verifiedFiles: writeFailures.length === 0 ? written.length : 0,
      skipped: 0,
    },
    backupDir: backupRoot,
    problems: [],
    writeFailures,
    rollbackErrors,
    rollbackHint: `copy the files in ${backupRoot} back over ${plan.stateDir} by their relative paths`,
  };
}

function formatDryRun(plan) {
  const lines = [
    '[gfi-migration] DRY-RUN — 未写入任何文件',
    `  state dir : ${plan.stateDir}`,
    `  scanned   : ${plan.summary.filesScanned} 个 JSON 文件`,
    `  to change : ${plan.summary.filesToChange} 个文件 / ${plan.summary.keysToRemove} 个键`,
    '',
  ];
  if (!plan.exists) {
    lines.push('  ⚠ 状态目录不存在，请确认 --workspace / --state-dir。');
    return lines.join('\n');
  }
  lines.push('将修改:');
  if (plan.changes.length === 0) {
    lines.push('  (无 — 已是干净状态，重复运行 0 变更)');
  }
  for (const entry of plan.changes) {
    lines.push(`  ${entry.file}`);
    lines.push(`    keys: ${entry.removedKeys.join(', ')}`);
  }
  if (plan.problems.length > 0) {
    lines.push('', '将跳过（原文件不改动）:');
    for (const entry of plan.problems) {
      lines.push(`  ${entry.file} — ${entry.status} (${entry.reason})`);
    }
  }
  lines.push('', '执行前请停止 PD 宿主进程；确认无误后加 --apply --confirm-owner-authorization。');
  return lines.join('\n');
}

function formatApply(result) {
  const lines = [
    `[gfi-migration] ${result.ok ? 'APPLIED' : 'REFUSED / FAILED'} — ${result.reason}`,
    `  before : ${result.planSummary ? `${result.planSummary.filesToChange} 个待改文件 / ${result.planSummary.keysToRemove} 个待删键` : 'n/a'}`,
    `  after  : ${result.summary.filesChanged} 个文件已改 / ${result.summary.keysRemoved} 个键已删 / ${result.summary.verifiedFiles} 个文件回读校验通过`,
  ];
  if (result.backupDir) lines.push(`  backup : ${result.backupDir}`);
  for (const problem of result.problems ?? []) {
    lines.push(`  skipped: ${problem.file} — ${problem.status} (${problem.reason})`);
  }
  for (const failure of result.writeFailures ?? []) {
    lines.push(`  failed : ${failure.file} — ${failure.reason}`);
  }
  for (const failure of result.rollbackErrors ?? []) {
    lines.push(`  ROLLBACK FAILED: ${failure.file} — ${failure.reason}`);
  }
  if (result.error) lines.push(`  error  : ${result.error}`);
  if (result.hint) lines.push(`  hint   : ${result.hint}`);
  if (result.ok && result.backupDir) {
    lines.push('', `  回滚: 把 ${result.backupDir} 内文件按相对路径复制回 ${result.stateDir} 覆盖。`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = {
    workspace: null, stateDir: null, backupDir: null,
    apply: false, confirmOwnerAuthorization: false, json: false, help: false,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--workspace') args.workspace = rest[++i];
    else if (arg === '--state-dir') args.stateDir = rest[++i];
    else if (arg === '--backup-dir') args.backupDir = rest[++i];
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--confirm-owner-authorization') args.confirmOwnerAuthorization = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '-h' || arg === '--help') args.help = true;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return args;
}

function publicPlan(plan) {
  return {
    ok: true,
    mode: 'dry-run',
    stateDir: plan.stateDir,
    exists: plan.exists,
    summary: plan.summary,
    wouldChange: plan.changes.map((e) => ({ file: e.file, keys: e.removedKeys })),
    skipped: plan.problems.map(publicProblem),
    entries: plan.entries.map(publicEntry),
    applyHint: '--apply --confirm-owner-authorization',
  };
}

export function main(argv = process.argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`[gfi-migration] ${String(err?.message ?? err)}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!args.workspace && !args.stateDir) {
    console.error('[gfi-migration] --workspace (or --state-dir) is required.');
    console.error(USAGE);
    return 2;
  }
  const common = { workspaceDir: args.workspace, stateDir: args.stateDir };

  if (!args.apply) {
    const plan = planMigration(common);
    if (args.json) console.log(JSON.stringify(publicPlan(plan), null, 2));
    else console.log(formatDryRun(plan));
    return plan.exists ? 0 : 1;
  }
  if (!args.confirmOwnerAuthorization) {
    console.error('[gfi-migration] --apply requires --confirm-owner-authorization (Owner approval for real data).');
    return 2;
  }
  const result = applyMigration({
    ...common,
    backupDir: args.backupDir,
    confirmOwnerAuthorization: true,
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatApply(result));
  return result.ok ? 0 : 1;
}

const isMain = process.argv[1] && process.argv[1].endsWith('gfi-workspace-json-migration.mjs');
if (isMain) {
  process.exitCode = main(process.argv);
}
