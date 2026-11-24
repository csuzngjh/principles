#!/usr/bin/env node
/**
 * PD pipeline funnel baseline — SPEC-PD-PIPELINE-SPINE-001 v0.9 Phase 0
 * (PRI-1290).
 *
 * Read-only funnel statistics over a PRODUCTION workspace's two SQLite
 * databases plus the principle ledger file:
 *
 *   Pain → 诊断 → 候选准入 → 账本入库 → 内化 → 激活 → 注入/拦截
 *
 * Safety contract (SPEC §6 Phase 0, AGENTS §1.1):
 *   - the workspace originals are NEVER opened with SQLite. Both databases
 *     are read through `stageWalSnapshot` — the WAL-safe, fingerprint-
 *     verified staged copy already proven by pain-recall-readonly.test.ts;
 *   - database paths come from the canonical resolvers
 *     (`@principles/core/runtime/storage-paths`), never hardcoded;
 *   - staged copies are opened `{ readonly: true, fileMustExist: true }`;
 *   - a snapshot whose fingerprints drift under concurrent writers is
 *     RETRIED (max 3) and then fails loud — a half-torn snapshot is never
 *     read, never reported as success;
 *   - snapshot ownership is registered the moment a staged copy exists:
 *     a failure while acquiring the second database (or while re-taking the
 *     earlier one after a skew breach) disposes every copy this run created;
 *     nothing is left behind in the temp dir (review round 2, P2-2);
 *   - every SQLite connection is closed BEFORE `dispose()` (Windows keeps
 *     temp files hostage through open handles);
 *   - the ONLY write of this script is the report, and only into the
 *     repository's `docs/reports/` directory under the strict report file
 *     name, through a same-directory temp file and an atomic rename
 *     (review round 2, P1-1 — see "Report output path safety" below);
 *   - no user content is ever emitted: only aggregates, ids, timestamps and
 *     categorical reason codes. `text`/`raw_excerpt`/free-form error strings
 *     are never selected.
 *
 * Report output path safety (review round 2, P1-1). `--out` used to accept
 * any path and truncate it — a mistyped `--out` could overwrite the very
 * production database this script promises not to touch. The destination is
 * now an ALLOWLIST, validated before any snapshot work:
 *   1. never inside the measured workspace (its `.pd/`/`.state/` data dirs
 *      first, for a precise reason code), never inside an installed runtime
 *      root (`~/.pd`, the installed plugin directory — AGENTS §1.1);
 *   2. the REAL parent directory (symlinks and junctions resolved) must be
 *      exactly the reports directory — no sub-directory, no `..`, no link
 *      pointing elsewhere;
 *   3. the file name must match `PD_PIPELINE_FUNNEL_BASELINE_<YYYYMMDD>.md`;
 *   4. an existing destination must be a regular, single-link file (a
 *      symlink, a directory/special file or a hard link to another file is
 *      refused, so an outside inode is never written through);
 *   5. the report is written to an exclusively-created temp file in the same
 *      directory and swapped in with one atomic rename — an existing file is
 *      replaced by inode, never truncated in place.
 *
 * Cross-database semantics (SPEC Phase 0 v0.5/v0.6):
 *   - the two snapshots are independent linearization points (T1 = the WAL
 *     read inside stageWalSnapshot; `capturedAt` is that instant);
 *   - snapshot skew window: |T1_state − T1_trajs| ≤ 5 s (suggested value,
 *     NOT production-calibrated). On breach the earlier database is
 *     re-snapshotted ONCE; a remaining breach is flagged in the report, not
 *     hidden;
 *   - cross-db write allowance: a record may legitimately land in the other
 *     database up to 60 s after the first database's T1 (suggested value,
 *     NOT production-calibrated). A link missing INSIDE that window is
 *     reported as `skew_window_candidate` (re-checkable later), never as
 *     data loss. Until both thresholds are calibrated against production
 *     write-path evidence, out-of-window misses are ALSO reported as
 *     `skew_window_candidate` with a "threshold not calibrated" marker —
 *     this baseline refuses to declare definitive loss from skew logic
 *     alone;
 *   - "cross-database skew" counts ONLY relations whose two ends live in
 *     different databases (pain→task, task→pain). A consumed candidate
 *     without a Dreamer task is a SAME-database relation (both rows come
 *     from the single state.db snapshot) and is reported separately,
 *     classified by evidence (review round 2, P2-1).
 *
 * Usage:
 *   node scripts/dev/pipeline-funnel-snapshot.mjs --workspace <dir> \
 *        [--out docs/reports/PD_PIPELINE_FUNNEL_BASELINE_<YYYYMMDD>.md] \
 *        [--days 30] [--json]
 *
 * Exit codes: 0 = report produced; 1 = snapshot/verification/output-path
 * failure (fail-loud, nothing reported as success).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
// Namespace imports keep the export-surface admission's consumer proof
// honest: each symbol is used as `<ns>.<symbol>` and the gate's AST check
// can see it.
import * as painRecall from '@principles/core/runtime/pain-recall';
import * as storagePaths from '@principles/core/runtime/storage-paths';
import * as principleTreeLedger from '@principles/core/principle-tree-ledger';

/** Suggested (uncalibrated) snapshot skew window between the two T1 points. */
export const SNAPSHOT_SKEW_MAX_MS = 5_000;
/** Suggested (uncalibrated) cross-database write allowance. */
export const CROSS_DB_WRITE_DELAY_MS = 60_000;
/** Max snapshot attempts per database before failing loud. */
export const SNAPSHOT_MAX_ATTEMPTS = 3;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── Report output allowlist ──────────────────────────────────────────────────

/** The only directory this script may write to (SPEC Phase 0 output path). */
export const DEFAULT_REPORTS_DIR = path.join(REPO_ROOT, 'docs', 'reports');
/** The only file names allowed inside it (the report, by run date). */
export const REPORT_FILENAME_RE = /^PD_PIPELINE_FUNNEL_BASELINE_\d{8}\.md$/u;
/** Installed runtime roots — never written by agents or dev tooling (AGENTS §1.1). */
export const DEFAULT_PROTECTED_ROOTS = Object.freeze([
  path.join(os.homedir(), '.pd'),
  path.join(os.homedir(), '.openclaw', 'extensions', 'principles-disciple'),
]);

const PEER_RUNNER_KINDS = Object.freeze(['dreamer', 'philosopher', 'scribe', 'artificer', 'evaluator', 'rollout_reviewer']);
const DIAGNOSTICIAN_KINDS = Object.freeze(['diagnostician', 'diag_rootcause', 'diag_distiller', 'diag_router']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Raw recommendation kinds the pipeline never routes to a Dreamer task. */
const NO_SEED_ROUTE_KINDS = Object.freeze(['implementation', 'defer']);
const KNOWN_CANDIDATE_KINDS = Object.freeze(['principle', 'rule', 'prompt', 'implementation', 'defer']);

// ── Argument parsing ─────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const options = { workspace: null, out: null, days: 30, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--workspace' || arg === '-w') {
      options.workspace = argv[++i];
    } else if (arg === '--out') {
      options.out = argv[++i];
    } else if (arg === '--days') {
      const days = Number.parseInt(argv[++i], 10);
      if (!Number.isInteger(days) || days <= 0) throw new Error(`--days must be a positive integer, got: ${argv[i]}`);
      options.days = days;
    } else if (arg === '--json') {
      options.json = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.workspace) throw new Error('--workspace <dir> is required (the PD workspace whose funnel is measured)');
  return options;
}

// ── Report output path safety (pure fs checks, unit-tested) ──────────────────

/** Real (symlink/junction-resolved, canonical-case) path, or null when absent. */
function realOf(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return null;
  }
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

class ReportOutputRefusedError extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.name = 'ReportOutputRefusedError';
    this.reason = reason;
  }
}

/**
 * Validate the report destination. Every check is a refusal with a stable
 * reason code; nothing is created here. `reportsDir`/`protectedRoots` are
 * injectable so tests can exercise the real checks against synthetic trees —
 * the CLI has no flag for them.
 */
export function resolveReportTarget({
  outArg,
  runDate,
  reportsDir = DEFAULT_REPORTS_DIR,
  workspaceDir,
  protectedRoots = DEFAULT_PROTECTED_ROOTS,
}) {
  const defaultPath = path.join(reportsDir, `PD_PIPELINE_FUNNEL_BASELINE_${runDate}.md`);
  const outPath = path.resolve(outArg === null ? defaultPath : outArg);
  const filename = path.basename(outPath);
  // Containment checks run on the CANONICAL destination: the real parent
  // (symlinks, junctions, 8.3 short names and case resolved) plus the file
  // name. A lexical path can spell the same location differently (e.g. a
  // short-name TEMP alias), which would slip past a string comparison.
  const parentReal = realOf(path.dirname(outPath));
  const canonicalOutPath = parentReal === null ? outPath : path.join(parentReal, filename);

  // 1. Never inside the measured workspace; its data directories get the
  //    most precise reason because they hold the databases being measured.
  for (const dataDir of ['.pd', '.state']) {
    const real = realOf(path.join(workspaceDir, dataDir));
    if (real !== null && isInside(canonicalOutPath, real)) {
      throw new ReportOutputRefusedError('report_out_in_workspace_data_dir', `${outPath} is inside the measured workspace's ${dataDir}/ (read-only)`);
    }
  }
  const workspaceReal = realOf(workspaceDir);
  if (workspaceReal !== null && isInside(canonicalOutPath, workspaceReal)) {
    throw new ReportOutputRefusedError('report_out_in_measured_workspace', `${outPath} is inside the measured workspace (read-only)`);
  }
  // 2. Never inside an installed runtime root (installer-owned).
  for (const root of protectedRoots) {
    const real = realOf(root);
    if (real !== null && isInside(canonicalOutPath, real)) {
      throw new ReportOutputRefusedError('report_out_in_install_dir', `${outPath} is inside the installer-owned runtime root ${root} (AGENTS §1.1)`);
    }
  }
  // 3. Exactly the reports directory — compared on REAL paths, so a symlink
  //    or junction in the chain cannot redirect the write.
  const reportsReal = realOf(reportsDir);
  if (reportsReal === null) {
    throw new ReportOutputRefusedError('report_out_reports_dir_missing', `the reports directory ${reportsDir} does not exist`);
  }
  if (parentReal === null) {
    throw new ReportOutputRefusedError('report_out_parent_missing', `the parent directory of ${outPath} does not exist`);
  }
  if (parentReal !== reportsReal) {
    throw new ReportOutputRefusedError(
      'report_out_outside_reports_dir',
      `${outPath} resolves to ${parentReal}, which is not the reports directory ${reportsReal}; the report may only be written directly into it`,
    );
  }
  // 4. Strict report file name.
  if (!REPORT_FILENAME_RE.test(filename)) {
    throw new ReportOutputRefusedError('report_out_invalid_filename', `${filename} does not match PD_PIPELINE_FUNNEL_BASELINE_<YYYYMMDD>.md`);
  }
  assertReplaceableRegularFile(outPath);
  return { ok: true, outPath };
}

/** An existing destination may only be a regular file with a single link. */
function assertReplaceableRegularFile(outPath) {
  let stat;
  try {
    stat = fs.lstatSync(outPath);
  } catch (error) {
    if (error.code === 'ENOENT') return; // new report: nothing to inspect
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new ReportOutputRefusedError('report_out_is_symlink', `${outPath} is a symlink; the report is never written through a link`);
  }
  if (!stat.isFile()) {
    throw new ReportOutputRefusedError('report_out_not_regular_file', `${outPath} exists and is not a regular file`);
  }
  if (stat.nlink > 1) {
    throw new ReportOutputRefusedError('report_out_hardlinked', `${outPath} has ${stat.nlink} hard links; writing it would reach a file outside the reports directory`);
  }
}

/**
 * Write the report through an exclusively-created temp file in the
 * destination directory and ONE atomic rename. An existing report is
 * replaced by inode (its old content is never truncated in place), so no
 * outside file can be modified through this write.
 */
export function writeReportAtomically(outPath, content) {
  const tmpPath = `${outPath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  // 'wx' = create exclusively: a pre-existing (possibly hard-linked) inode
  // is never opened for writing.
  fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', flag: 'wx' });
  try {
    // Re-validate right before the swap: the destination may have changed
    // between the pre-flight check and now.
    assertReplaceableRegularFile(outPath);
    fs.renameSync(tmpPath, outPath);
  } finally {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // the rename succeeded and the temp name no longer exists
    }
  }
}

// ── Cross-db miss classification (pure, unit-tested) ─────────────────────────

/**
 * Classify a missing cross-database link from the SURVIVING record's own
 * timestamp versus the OTHER database's snapshot T1 (SPEC v0.5: the missing
 * row has no timestamp of its own to consult).
 *
 * Returns 'skew_window_candidate' when the other database could still have
 * received the write (within the allowance), and 'skew_window_candidate'
 * with `thresholdUncalibrated: true` when the allowance is exceeded —
 * deliberately the same bucket, because the 60 s allowance is a suggested
 * value that this first baseline is not allowed to turn into a hard loss
 * verdict (SPEC v0.6 calibration clause).
 */
export function classifyMissingLink({ recordTimestamp, otherDbT1, allowDelayMs = CROSS_DB_WRITE_DELAY_MS }) {
  if (recordTimestamp === null || otherDbT1 === null) {
    return { bucket: 'skew_window_candidate', thresholdUncalibrated: true };
  }
  const recordMs = Date.parse(recordTimestamp);
  const t1Ms = Date.parse(otherDbT1);
  if (!Number.isFinite(recordMs) || !Number.isFinite(t1Ms)) {
    return { bucket: 'skew_window_candidate', thresholdUncalibrated: true };
  }
  const ageBeyondT1 = t1Ms - recordMs;
  if (ageBeyondT1 <= allowDelayMs) {
    return { bucket: 'skew_window_candidate', thresholdUncalibrated: false };
  }
  return { bucket: 'skew_window_candidate', thresholdUncalibrated: true };
}

// ── SQLite helpers (staged copies only) ──────────────────────────────────────

function openStagedReadonly(stagedDbPath) {
  return new Database(stagedDbPath, { readonly: true, fileMustExist: true });
}

function tableExists(db, name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return row !== undefined;
}

function safeAll(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch (error) {
    if (String(error).includes('no such table')) return null;
    throw error;
  }
}

function countBy(db, table, column, extraWhere = '', params = []) {
  if (!tableExists(db, table)) return null;
  const rows = db.prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM ${table} ${extraWhere} GROUP BY ${column} ORDER BY n DESC`).all(...params);
  const out = {};
  for (const row of rows) out[row.k === null ? '(null)' : String(row.k)] = row.n;
  return out;
}

function totalCount(db, table, extraWhere = '', params = []) {
  if (!tableExists(db, table)) return null;
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${extraWhere}`).get(...params).n;
}

/**
 * COUNT of rows whose timestamp column falls inside the window
 * [cutoff, snapshot T1). Returns null when the table is missing.
 *
 * `unparseableTimestamps` counts non-NULL values SQLite's datetime() cannot
 * read (epoch integers, malformed text): such rows silently fall outside
 * the window, so they are SURFACED next to the count, never dropped.
 */
function windowedCount(db, table, column, cutoffIso, extraWhere = '', params = []) {
  if (!tableExists(db, table)) return null;
  const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE datetime(${column}) >= datetime(?) ${extraWhere}`).get(cutoffIso, ...params).n;
  const unparseable = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IS NOT NULL AND datetime(${column}) IS NULL ${extraWhere}`).get(...params).n;
  return { count, unparseableTimestamps: unparseable };
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

// ── Snapshot acquisition (ownership registered on acquisition) ───────────────

function stageWalSnapshotOf(dbPath, relSegments) {
  return painRecall.stageWalSnapshot(dbPath, relSegments);
}

function snapshotWithRetry(stage, dbPath, relSegments, label) {
  let lastReason = 'not_attempted';
  for (let attempt = 1; attempt <= SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
    const staged = stage(dbPath, relSegments);
    if (staged.ok) {
      return { staged, attempts: attempt };
    }
    lastReason = staged.reason;
  }
  throw new Error(
    `wal_snapshot_failed: ${label} (${dbPath}) could not obtain a fingerprint-verified snapshot after `
    + `${SNAPSHOT_MAX_ATTEMPTS} attempts (last reason: ${lastReason}); refusing to read a torn snapshot`,
  );
}

/**
 * Snapshot both databases, keeping the two T1 points within the suggested
 * skew window when possible: on breach, only the EARLIER database is
 * re-snapshotted once (re-snapshotting the later one can only widen the
 * gap). A remaining breach is returned as a flag — the report must carry
 * it, not swallow it.
 *
 * Ownership: every staged copy is registered in `owned` the moment it
 * exists and is disposed by THIS function on any failure path. Only the
 * single success path transfers ownership to the caller (by emptying the
 * registry), so a failure while acquiring the second database, or while
 * re-taking the earlier one, leaves no staged copy behind. No SQLite
 * connection has been opened at this point, so disposing is always safe on
 * Windows. `stage` is injectable for the failure-path tests; the CLI always
 * uses the real `stageWalSnapshot`.
 */
export function snapshotPair(stateDbPath, trajectoryDbPath, { stage = stageWalSnapshotOf } = {}) {
  const owned = new Set();
  const acquire = (dbPath, relSegments, label) => {
    const snapshot = snapshotWithRetry(stage, dbPath, relSegments, label);
    owned.add(snapshot.staged);
    return snapshot;
  };
  const release = (staged) => {
    // delete-first keeps a repeated release a no-op even if dispose were not idempotent
    if (owned.delete(staged)) staged.dispose();
  };
  try {
    const state = acquire(stateDbPath, ['funnel', 'state.db'], 'state.db');
    const trajectory = acquire(trajectoryDbPath, ['funnel', 'trajectory.db'], 'trajectory.db');
    const skewMs = Math.abs(Date.parse(state.staged.capturedAt) - Date.parse(trajectory.staged.capturedAt));
    if (skewMs > SNAPSHOT_SKEW_MAX_MS) {
      const earlierIsState = Date.parse(state.staged.capturedAt) <= Date.parse(trajectory.staged.capturedAt);
      const earlier = earlierIsState ? state : trajectory;
      const replacement = acquire(
        earlierIsState ? stateDbPath : trajectoryDbPath,
        earlierIsState ? ['funnel', 'state.db'] : ['funnel', 'trajectory.db'],
        earlierIsState ? 'state.db' : 'trajectory.db',
      );
      release(earlier.staged);
      if (earlierIsState) {
        const pair = {
          state: replacement,
          trajectory,
          skewRetried: true,
          skewExceededMs: Math.abs(Date.parse(replacement.staged.capturedAt) - Date.parse(trajectory.staged.capturedAt)),
        };
        owned.clear(); // ownership transferred to the caller
        return pair;
      }
      const pair = {
        state,
        trajectory: replacement,
        skewRetried: true,
        skewExceededMs: Math.abs(Date.parse(state.staged.capturedAt) - Date.parse(replacement.staged.capturedAt)),
      };
      owned.clear(); // ownership transferred to the caller
      return pair;
    }
    const pair = { state, trajectory, skewRetried: false, skewExceededMs: skewMs };
    owned.clear(); // ownership transferred to the caller
    return pair;
  } finally {
    for (const staged of owned) {
      try {
        staged.dispose();
      } catch (error) {
        // Best effort on an already-failing path; never mask the original error.
        process.stderr.write(`warning: staged snapshot could not be disposed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }
}

// ── Funnel collection (staged copies + ledger file) ──────────────────────────

function parseAdmissionSummary(admissionJson) {
  if (admissionJson === null || admissionJson === undefined) return { kind: 'absent' };
  let parsed;
  try {
    parsed = JSON.parse(admissionJson);
  } catch {
    return { kind: 'invalid' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'invalid' };
  const evaluations = Array.isArray(parsed.evaluations) ? parsed.evaluations : [];
  const currentId = typeof parsed.currentEvaluationId === 'string' ? parsed.currentEvaluationId : null;
  const current = evaluations.find((e) => e && typeof e === 'object' && e.evaluationId === currentId) ?? null;
  const processing = parsed !== null && typeof parsed.processing === 'object' && parsed.processing !== null && !Array.isArray(parsed.processing)
    ? parsed.processing
    : null;
  return {
    kind: 'present',
    decision: current && typeof current.decision === 'string' ? current.decision : null,
    reason: current && typeof current.reason === 'string' ? current.reason : null,
    processingState: processing && typeof processing.state === 'string' ? processing.state : null,
    ownerDecisions: Array.isArray(parsed.ownerDecisions) ? parsed.ownerDecisions.length : 0,
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectLedgerStats(workspaceDir) {
  const readAt = new Date().toISOString();
  const state = principleTreeLedger.readLedgerFileState(path.join(workspaceDir, '.state'));
  if (state.availability.status !== 'ok') {
    return { readAt, availability: state.availability.status, principles: null, derivedCandidateIds: new Set(), reuseCandidateIds: new Set() };
  }
  const principles = isRecord(state.ledger.tree.principles) ? state.ledger.tree.principles : {};
  const entries = Object.values(principles).filter(isRecord);
  const derivedCandidateIds = new Set();
  const reuseCandidateIds = new Set();
  let reuseEdges = 0;
  let principlesWithReuse = 0;
  let principlesWithDerived = 0;
  for (const entry of entries) {
    const derived = Array.isArray(entry.derivedFromPainIds) ? entry.derivedFromPainIds : [];
    if (derived.length > 0) principlesWithDerived += 1;
    // `derivedFromPainIds` is the ledger lineage field; it holds candidate ids
    // (same lookup as the identity authority's resolveCandidatePrincipleIdentity).
    for (const id of derived) {
      if (typeof id === 'string' && id.length > 0) derivedCandidateIds.add(id);
    }
    const reuse = Array.isArray(entry.reuseEvidence) ? entry.reuseEvidence : [];
    if (reuse.length > 0) principlesWithReuse += 1;
    for (const edge of reuse) {
      if (isRecord(edge) && typeof edge.candidateId === 'string') {
        reuseCandidateIds.add(edge.candidateId);
        reuseEdges += 1;
      }
    }
  }
  const linkedCandidateIds = new Set([...derivedCandidateIds, ...reuseCandidateIds]);
  return {
    readAt,
    availability: 'ok',
    principles: {
      total: entries.length,
      withReuseEvidence: principlesWithReuse,
      withDerivedCandidates: principlesWithDerived,
      reuseEdges,
      linkedCandidateCount: linkedCandidateIds.size,
    },
    linkedCandidateIds,
    derivedCandidateIds,
    reuseCandidateIds,
  };
}

/**
 * Failed runs by error category, restricted to tasks of the given kinds via
 * the `runs.task_id → tasks.task_id` relation. Without the join, failures of
 * ANY stage (internalization runners reuse the same `runs` table) would be
 * reported as diagnostic failures (review round 2, P2-3).
 */
function runFailureCategories(db, kinds) {
  if (!tableExists(db, 'runs') || !tableExists(db, 'tasks')) return null;
  const rows = db.prepare(
    `SELECT r.error_category AS k, COUNT(*) AS n
       FROM runs r JOIN tasks t ON t.task_id = r.task_id
      WHERE r.execution_status = 'failed' AND r.error_category IS NOT NULL AND t.task_kind IN (${placeholders(kinds)})
      GROUP BY r.error_category ORDER BY n DESC`,
  ).all(...kinds);
  const out = {};
  for (const row of rows) out[String(row.k)] = row.n;
  return out;
}

function collectStateFunnel(db, cutoffIso) {
  const funnel = {};

  // ── 诊断 stage ──
  funnel.diagnosis = { available: true };
  {
    const rows = safeAll(db, 'SELECT task_kind AS k, status AS s, COUNT(*) AS n FROM tasks GROUP BY task_kind, status');
    if (rows === null) {
      funnel.diagnosis.taskKindStatus = null;
      funnel.diagnosis.kindTotals = null;
    } else {
      const kindStatus = {};
      const kindTotals = {};
      for (const row of rows) {
        kindStatus[`${row.k}/${row.s}`] = row.n;
        kindTotals[row.k] = (kindTotals[row.k] ?? 0) + row.n;
      }
      funnel.diagnosis.taskKindStatus = kindStatus;
      funnel.diagnosis.kindTotals = kindTotals;
    }
  }
  funnel.diagnosis.failedTasksByKind = countBy(db, 'tasks', 'task_kind', "WHERE status = 'failed'");
  // Diagnostic failures only (Diagnostician task kinds). Internalization and
  // whole-pipeline rankings are separate, explicitly named metrics below.
  funnel.diagnosis.diagnosticianRunFailuresByErrorCategory = runFailureCategories(db, DIAGNOSTICIAN_KINDS);
  funnel.diagnosis.deadLetterPains = {
    total: totalCount(db, 'dead_letter_pains'),
    unretried: totalCount(db, 'dead_letter_pains', 'WHERE retried_at IS NULL'),
    retried: totalCount(db, 'dead_letter_pains', 'WHERE retried_at IS NOT NULL'),
  };
  funnel.diagnosis.painDiagnoses = {
    total: totalCount(db, 'pain_diagnoses'),
    windowed: windowedCount(db, 'pain_diagnoses', 'created_at', cutoffIso)?.count ?? null,
  };

  // ── 候选 + 准入 stage ──
  funnel.candidates = { available: true };
  funnel.candidates.total = totalCount(db, 'principle_candidates');
  funnel.candidates.windowed = windowedCount(db, 'principle_candidates', 'created_at', cutoffIso)?.count ?? null;
  funnel.candidates.byStatus = countBy(db, 'principle_candidates', 'status');
  // recommendation_kind IS the raw persisted kind (candidate-store maps
  // rawRecommendationKind = r.recommendation_kind; the normalized view is
  // derived at read time and is deliberately not what we count here).
  funnel.candidates.byRawKind = countBy(db, 'principle_candidates', 'recommendation_kind');
  {
    const rows = safeAll(db, 'SELECT admission_json AS a, status AS s FROM principle_candidates');
    if (rows === null) {
      funnel.candidates.admission = null;
    } else {
      const decisionCounts = {};
      const reasonCounts = {};
      const refusalReasonCounts = {};
      const processingCounts = {};
      let invalid = 0;
      let absent = 0;
      let ownerDecisionPending = 0;
      for (const row of rows) {
        const summary = parseAdmissionSummary(row.a);
        if (summary.kind === 'absent') {
          absent += 1;
          processingCounts['(no document)'] = (processingCounts['(no document)'] ?? 0) + 1;
          continue;
        }
        if (summary.kind === 'invalid') {
          invalid += 1;
          continue;
        }
        const decision = summary.decision ?? '(no current evaluation)';
        decisionCounts[decision] = (decisionCounts[decision] ?? 0) + 1;
        if (summary.reason !== null) {
          reasonCounts[summary.reason] = (reasonCounts[summary.reason] ?? 0) + 1;
          if (decision !== 'admitted') {
            refusalReasonCounts[summary.reason] = (refusalReasonCounts[summary.reason] ?? 0) + 1;
          }
        }
        const proc = summary.processingState ?? '(none)';
        processingCounts[proc] = (processingCounts[proc] ?? 0) + 1;
        if (summary.ownerDecisions > 0) ownerDecisionPending += 1;
      }
      funnel.candidates.admission = {
        absent,
        invalid,
        decisions: decisionCounts,
        reasonsTop: topN(reasonCounts, 8),
        refusalReasonsTop: topN(refusalReasonCounts, 8),
        processingStates: processingCounts,
        candidatesWithOwnerDecisions: ownerDecisionPending,
      };
    }
  }

  // ── 内化 stage ──
  funnel.internalization = { available: true };
  {
    const rows = safeAll(db, 'SELECT task_kind AS k, status AS s, COUNT(*) AS n FROM tasks GROUP BY task_kind, status');
    const byKind = {};
    for (const row of rows ?? []) {
      if (!PEER_RUNNER_KINDS.includes(row.k)) continue;
      byKind[row.k] = byKind[row.k] ?? { total: 0, byStatus: {} };
      byKind[row.k].total += row.n;
      byKind[row.k].byStatus[row.s] = row.n;
    }
    funnel.internalization.peerTasksByKind = rows === null ? null : byKind;
  }
  // Internalization failures only (peer runner kinds), counted per run (attempt).
  funnel.internalization.peerRunFailuresByErrorCategory = runFailureCategories(db, PEER_RUNNER_KINDS);

  // ── 激活 stage ──
  funnel.activation = { available: true };
  funnel.activation.approvalsByStatus = countBy(db, 'approvals', 'status');
  funnel.activation.approvalsByChannel = countBy(db, 'approvals', 'channel');
  funnel.activation.activationsByAction = countBy(db, 'activations', 'action');
  funnel.activation.activationsByChannel = countBy(db, 'activations', 'channel');
  {
    // A rule activation targets its rule: `impl://<ruleId>_<artifactVersion>`
    // (rule-host-writer). It is a rule identity, never a principle UUID.
    const rows = safeAll(db, 'SELECT DISTINCT target_ref AS t FROM activations');
    if (rows === null) {
      funnel.activation.targets = null;
    } else {
      let uuidShaped = 0;
      let implUriShaped = 0;
      let other = 0;
      for (const row of rows) {
        if (typeof row.t === 'string' && UUID_RE.test(row.t.trim())) uuidShaped += 1;
        else if (typeof row.t === 'string' && row.t.startsWith('impl://')) implUriShaped += 1;
        else other += 1;
      }
      funnel.activation.targets = { distinct: rows.length, uuidShaped, implUriShaped, otherShaped: other };
    }
  }
  funnel.activation.piArtifacts = {
    total: totalCount(db, 'pi_artifacts'),
    byKind: countBy(db, 'pi_artifacts', 'artifact_kind'),
    byValidationStatus: countBy(db, 'pi_artifacts', 'validation_status'),
    withSourcePrincipleId: totalCount(db, 'pi_artifacts', 'WHERE source_principle_id IS NOT NULL'),
  };

  // ── 注入/拦截 stage ──
  funnel.application = { available: true };
  funnel.application.byKind = countBy(db, 'principle_applications', 'kind');
  funnel.application.byLevel = countBy(db, 'principle_applications', 'level');
  funnel.application.total = totalCount(db, 'principle_applications');
  funnel.application.windowed = windowedCount(db, 'principle_applications', 'created_at', cutoffIso)?.count ?? null;
  {
    const rows = safeAll(db, 'SELECT COUNT(DISTINCT principle_id) AS n FROM principle_applications');
    funnel.application.distinctPrinciples = rows === null ? null : rows[0].n;
  }
  funnel.application.interventionEvidenceRecords = totalCount(db, 'intervention_evidence_records');

  // ── whole-pipeline failure ranking (explicitly NOT the diagnostic one) ──
  funnel.failures = {
    available: true,
    // Every failed run regardless of task kind — kept as its own, clearly
    // named metric so it can no longer be mistaken for diagnostic failures.
    allPipelineRunFailuresByErrorCategory: countBy(db, 'runs', 'error_category', "WHERE execution_status = 'failed' AND error_category IS NOT NULL"),
    allPipelineFailedTasksByKind: funnel.diagnosis.failedTasksByKind,
  };
  return funnel;
}

function topN(counts, n) {
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n));
}

function collectTrajectoryFunnel(db, cutoffIso) {
  const funnel = {};
  funnel.pain = { available: true };
  funnel.pain.total = totalCount(db, 'pain_events');
  funnel.pain.windowed = windowedCount(db, 'pain_events', 'created_at', cutoffIso)?.count ?? null;
  funnel.pain.bySource = countBy(db, 'pain_events', 'source');
  funnel.pain.byHostKind = countBy(db, 'pain_events', 'host_kind');
  funnel.pain.bySeverity = countBy(db, 'pain_events', 'severity');
  funnel.pain.withCanonicalId = totalCount(db, 'pain_events', 'WHERE canonical_pain_id IS NOT NULL');
  funnel.pain.withRuntimeTaskId = totalCount(db, 'pain_events', 'WHERE runtime_task_id IS NOT NULL');
  funnel.interception = { available: true };
  funnel.interception.gateBlocks = {
    total: totalCount(db, 'gate_blocks'),
    windowed: windowedCount(db, 'gate_blocks', 'created_at', cutoffIso)?.count ?? null,
    byTool: countBy(db, 'gate_blocks', 'tool_name'),
  };
  return funnel;
}

// ── Recent window (every stage on one explicit window) ───────────────────────

/** The per-stage window definition. `timeField` is declared in the report:
 * every stage uses its own real event-time column, never "now". */
const WINDOW_STAGES = Object.freeze([
  { stage: 'pain', label: 'Pain', db: 'trajectory', table: 'pain_events', column: 'created_at' },
  { stage: 'diagnostician', label: 'Diagnostician 任务（父任务 + diag_* 子任务）', db: 'state', table: 'tasks', column: 'created_at', kinds: DIAGNOSTICIAN_KINDS },
  { stage: 'dreamer', label: 'Dreamer', db: 'state', table: 'tasks', column: 'created_at', kinds: ['dreamer'] },
  { stage: 'philosopher', label: 'Philosopher', db: 'state', table: 'tasks', column: 'created_at', kinds: ['philosopher'] },
  { stage: 'scribe', label: 'Scribe', db: 'state', table: 'tasks', column: 'created_at', kinds: ['scribe'] },
  { stage: 'artificer', label: 'Artificer', db: 'state', table: 'tasks', column: 'created_at', kinds: ['artificer'] },
  { stage: 'evaluator', label: 'Evaluator', db: 'state', table: 'tasks', column: 'created_at', kinds: ['evaluator'] },
  { stage: 'rollout_reviewer', label: 'RolloutReviewer', db: 'state', table: 'tasks', column: 'created_at', kinds: ['rollout_reviewer'] },
  { stage: 'approvals', label: 'Approval 请求', db: 'state', table: 'approvals', column: 'requested_at' },
  { stage: 'activations', label: 'Activation', db: 'state', table: 'activations', column: 'activated_at' },
]);

/**
 * One explicit window [cutoffIso, snapshot T1) for every stage (SPEC Phase 0:
 * "全量与近 30 天各阶段数量"). A missing table yields `null` — rendered as
 * NA, never as a fabricated 0.
 */
function collectWindow(stateDb, trajectoryDb, cutoffIso) {
  const stages = {};
  for (const def of WINDOW_STAGES) {
    const db = def.db === 'state' ? stateDb : trajectoryDb;
    const extraWhere = def.kinds ? `AND task_kind IN (${placeholders(def.kinds)})` : '';
    const windowed = windowedCount(db, def.table, def.column, cutoffIso, extraWhere, def.kinds ?? []);
    stages[def.stage] = {
      label: def.label,
      table: def.db === 'state' ? `state.${def.table}` : `trajectory.${def.table}`,
      column: def.column,
      count: windowed === null ? null : windowed.count,
      unparseableTimestamps: windowed === null ? null : windowed.unparseableTimestamps,
    };
  }

  // How the windowed rows split — failure / awaiting Owner / legal no-seed
  // route / missing link are different outcomes and must not be merged.
  const taskStatus = safeAll(
    stateDb,
    `SELECT task_kind AS k, status AS s, COUNT(*) AS n FROM tasks WHERE datetime(created_at) >= datetime(?) GROUP BY task_kind, status`,
    [cutoffIso],
  );
  const taskStatusByKind = {};
  for (const row of taskStatus ?? []) {
    taskStatusByKind[row.k] = taskStatusByKind[row.k] ?? {};
    taskStatusByKind[row.k][row.s] = row.n;
  }
  const candidates = safeAll(
    stateDb,
    `SELECT candidate_id AS id, status AS s, recommendation_kind AS k, consumed_at AS consumed_at, admission_json AS a, created_at AS c
       FROM principle_candidates WHERE datetime(created_at) >= datetime(?)`,
    [cutoffIso],
  );
  const candidateBreakdown = candidates === null
    ? null
    : summarizeCandidateRows(candidates.map((row) => ({
      candidateId: row.id,
      rawKind: row.k,
      status: row.s,
      createdAt: row.c,
      admission: parseAdmissionSummary(row.a),
    })));
  const approvalsByStatus = countBy(
    stateDb,
    'approvals',
    'status',
    'WHERE datetime(requested_at) >= datetime(?)',
    [cutoffIso],
  );
  const activationsByAction = countBy(
    stateDb,
    'activations',
    'action',
    'WHERE datetime(activated_at) >= datetime(?)',
    [cutoffIso],
  );
  return { cutoffIso, stages, taskStatusByKind: taskStatus === null ? null : taskStatusByKind, candidateBreakdown, approvalsByStatus, activationsByAction };
}

// ── Consumed-without-Dreamer classification (pure, unit-tested) ──────────────

/** Why a consumed candidate has no Dreamer task. Both rows live in the SAME
 * database snapshot, so this relation is never a cross-database skew sample. */
export const NO_DREAMER_CLASSIFICATION = Object.freeze({
  LEGAL_NO_SEED_ROUTE: 'legal_no_seed_route',
  INVALID_RAW_KIND: 'invalid_raw_kind',
  LEGAL_REUSE_RESOLVED: 'legal_reuse_resolved',
  AWAITING_OWNER: 'awaiting_owner_decision',
  UNEXPLAINED: 'unexplained_requires_investigation',
});

/**
 * Classify why a consumed candidate has no Dreamer task. Both rows live in
 * the SAME database snapshot, so this is not a cross-database skew sample.
 */
export function classifyConsumedWithoutDreamer({ rawKind, hasReuseEvidence, admissionProcessingState }) {
  const kind = typeof rawKind === 'string' ? rawKind : '';
  if (NO_SEED_ROUTE_KINDS.includes(kind)) {
    // implementation → channel 'skill' is MVP-disabled; defer → deferred route.
    return NO_DREAMER_CLASSIFICATION.LEGAL_NO_SEED_ROUTE;
  }
  if (!KNOWN_CANDIDATE_KINDS.includes(kind)) {
    return NO_DREAMER_CLASSIFICATION.INVALID_RAW_KIND;
  }
  if (hasReuseEvidence) {
    // The candidate resolved onto an existing principle: a new independent
    // Dreamer seed is suppressed by design (candidate-seed-suppression).
    return NO_DREAMER_CLASSIFICATION.LEGAL_REUSE_RESOLVED;
  }
  if (admissionProcessingState === 'awaiting_owner') {
    // Parked for an Owner decision (AdmissionProcessingState). The candidate
    // is not in the ledger yet, so NOT seeding a Dreamer is the required
    // behaviour — an Owner backlog item, not a pipeline gap.
    return NO_DREAMER_CLASSIFICATION.AWAITING_OWNER;
  }
  return NO_DREAMER_CLASSIFICATION.UNEXPLAINED;
}

/** Split a set of candidate rows by raw kind, status and admission outcome.
 * `awaitingOwner` follows the admission state machine
 * (`AdmissionProcessingState`): `awaiting_owner`, or an Owner decision
 * recorded on the document; `exhausted` is the machine's failed terminal. */
function summarizeCandidateRows(rows) {
  const byRawKind = {};
  const byStatus = {};
  const processingStates = {};
  let awaitingOwner = 0;
  let exhausted = 0;
  let consumed = 0;
  for (const row of rows) {
    const kind = row.rawKind === null ? '(null)' : String(row.rawKind);
    byRawKind[kind] = (byRawKind[kind] ?? 0) + 1;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    if (row.status === 'consumed') consumed += 1;
    const admission = row.admission;
    if (admission.kind === 'present') {
      const state = admission.processingState ?? '(none)';
      processingStates[state] = (processingStates[state] ?? 0) + 1;
      if (state === 'awaiting_owner' || admission.ownerDecisions > 0) awaitingOwner += 1;
      if (state === 'exhausted') exhausted += 1;
    } else {
      const state = admission.kind === 'absent' ? '(no document)' : '(invalid document)';
      processingStates[state] = (processingStates[state] ?? 0) + 1;
    }
  }
  return { total: rows.length, byRawKind, byStatus, consumed, processingStates, awaitingOwner, exhausted };
}

// ── Cross-database linkage ───────────────────────────────────────────────────

function collectLinkage(stateDb, trajectoryDb, stateT1, trajectoryT1, ledger) {
  const linkage = { notes: [] };

  // pain_events.runtime_task_id → state.tasks (the two databases cannot see
  // each other inside one SQL statement; fetch both sides and join in JS)
  {
    const rows = safeAll(
      trajectoryDb,
      'SELECT id AS id, runtime_task_id AS t, created_at AS c FROM pain_events WHERE runtime_task_id IS NOT NULL',
    );
    const taskIds = new Set((safeAll(stateDb, 'SELECT task_id AS t FROM tasks') ?? []).map((r) => r.t));
    const missing = (rows ?? []).filter((r) => !taskIds.has(r.t));
    const buckets = { skew_window_candidate: 0 };
    let thresholdUncalibrated = 0;
    const samples = [];
    for (const row of missing) {
      const verdict = classifyMissingLink({ recordTimestamp: row.c, otherDbT1: stateT1 });
      buckets[verdict.bucket] += 1;
      if (verdict.thresholdUncalibrated) thresholdUncalibrated += 1;
      samples.push({ painEventId: row.id, runtimeTaskId: row.t, createdAt: row.c, thresholdUncalibrated: verdict.thresholdUncalibrated });
    }
    linkage.painToTask = {
      crossDatabase: true,
      painsWithRuntimeTaskRef: rows === null ? null : rows.length,
      missingTaskRefs: missing.length,
      buckets,
      thresholdUncalibrated,
      samples,
    };
  }

  // diag parent tasks → trajectory pain_events (via diagnostic_json.sourcePainId)
  {
    const rows = safeAll(
      stateDb,
      `SELECT task_id AS id, created_at AS c, diagnostic_json AS d FROM tasks
        WHERE task_kind = 'diagnostician' AND diagnostic_json IS NOT NULL`,
    );
    const painIds = new Set(
      (safeAll(trajectoryDb, 'SELECT canonical_pain_id AS p FROM pain_events WHERE canonical_pain_id IS NOT NULL') ?? [])
        .map((r) => r.p),
    );
    const painRowIds = new Set((safeAll(trajectoryDb, 'SELECT id AS i FROM pain_events') ?? []).map((r) => String(r.i)));
    let diagnosed = 0;
    const missing = [];
    let unparsable = 0;
    for (const row of rows ?? []) {
      let sourcePainId = null;
      try {
        const parsed = JSON.parse(row.d);
        if (isRecord(parsed) && typeof parsed.sourcePainId === 'string') sourcePainId = parsed.sourcePainId;
      } catch {
        unparsable += 1;
      }
      if (sourcePainId === null) continue;
      if (painIds.has(sourcePainId) || painRowIds.has(sourcePainId)) diagnosed += 1;
      else missing.push({ taskId: row.id, sourcePainId, created: row.c });
    }
    const buckets = { skew_window_candidate: 0 };
    let thresholdUncalibrated = 0;
    const samples = [];
    for (const m of missing) {
      const verdict = classifyMissingLink({ recordTimestamp: m.created, otherDbT1: trajectoryT1 });
      buckets[verdict.bucket] += 1;
      if (verdict.thresholdUncalibrated) thresholdUncalibrated += 1;
      samples.push({ taskId: m.taskId, sourcePainId: m.sourcePainId, createdAt: m.created, thresholdUncalibrated: verdict.thresholdUncalibrated });
    }
    linkage.taskToPain = {
      crossDatabase: true,
      diagnosticianTasksWithJson: (rows ?? []).length,
      linkedPainFound: diagnosed,
      painMissing: missing.length,
      diagnosticJsonUnparsable: unparsable,
      buckets,
      thresholdUncalibrated,
      samples,
    };
  }

  // consumed candidates → dreamer task. SAME database (both sides come from
  // the single state.db snapshot): there is no snapshot time difference to
  // blame, so this relation is NOT part of the cross-database skew total.
  // It is classified by evidence instead, and every sample is kept traceable.
  {
    const rows = safeAll(
      stateDb,
      `SELECT c.candidate_id AS cid, c.created_at AS c, c.recommendation_kind AS k, c.admission_json AS a FROM principle_candidates c
        WHERE c.status = 'consumed'
          AND NOT EXISTS (
            SELECT 1 FROM tasks t
             WHERE t.task_kind = 'dreamer' AND t.task_id LIKE 'dreamer-' || c.candidate_id || '-%'
          )
        ORDER BY c.candidate_id`,
    );
    const consumedTotal = totalCount(stateDb, 'principle_candidates', "WHERE status = 'consumed'");
    const byRawKind = {};
    const classification = {};
    const samples = [];
    for (const row of rows ?? []) {
      const rawKind = row.k === null ? null : String(row.k);
      const admission = parseAdmissionSummary(row.a);
      const verdict = classifyConsumedWithoutDreamer({
        rawKind,
        hasReuseEvidence: ledger.reuseCandidateIds.has(row.cid),
        admissionProcessingState: admission.kind === 'present' ? admission.processingState : null,
      });
      const kindKey = rawKind === null ? '(null)' : rawKind;
      byRawKind[kindKey] = (byRawKind[kindKey] ?? 0) + 1;
      classification[verdict] = (classification[verdict] ?? 0) + 1;
      samples.push({
        candidateId: row.cid,
        rawKind,
        createdAt: row.c,
        classification: verdict,
        admissionDecision: admission.kind === 'present' ? admission.decision : null,
        admissionProcessingState: admission.kind === 'present' ? admission.processingState : null,
        ledgerDerived: ledger.derivedCandidateIds.has(row.cid),
        ledgerReuse: ledger.reuseCandidateIds.has(row.cid),
      });
    }
    linkage.candidateToDreamer = {
      crossDatabase: false,
      consumedCandidates: consumedTotal,
      consumedWithoutDreamerTask: rows === null ? null : rows.length,
      byRawKind: rows === null ? null : byRawKind,
      classification: rows === null ? null : classification,
      samples,
    };
  }

  return linkage;
}

/**
 * Skew totals (review round 2, P2-1). ONLY relations whose two ends live in
 * different databases are cross-database skew; the same-database
 * candidate→Dreamer relation is reported apart and never added to it.
 */
export function summarizeLinkage(linkage) {
  const skewOf = (relation) => relation?.buckets?.skew_window_candidate ?? null;
  const painToTask = skewOf(linkage.painToTask);
  const taskToPain = skewOf(linkage.taskToPain);
  return {
    crossDbSkewWindowCandidates: painToTask === null || taskToPain === null ? null : painToTask + taskToPain,
    crossDbByRelation: { painToTask, taskToPain },
    sameDbConsumedWithoutDreamer: linkage.candidateToDreamer?.consumedWithoutDreamerTask ?? null,
  };
}

// ── Report rendering ─────────────────────────────────────────────────────────

function fmtCounts(counts) {
  if (counts === null || counts === undefined) return '_table missing_';
  const entries = Object.entries(counts);
  if (entries.length === 0) return '(none)';
  return entries.map(([k, v]) => `${k}: ${v}`).join(', ');
}

function sumOrNA(counts) {
  if (counts === null || counts === undefined) return null;
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

/** Observed conversion with explicit numerator/denominator; NA — never 0 —
 * when either side's table is missing or the denominator is 0. */
function ratio(num, den) {
  if (num === null || den === null || den === undefined || num === undefined || den === 0) return 'NA';
  return `${(Number(num) / Number(den)).toFixed(3)}`;
}

function renderReport(model) {
  const lines = [];
  const push = (s = '') => lines.push(s);
  const skew = summarizeLinkage(model.linkage);
  push(`# PD Pipeline Funnel Baseline — ${model.meta.runDate}`);
  push();
  push('- 规范：SPEC-PD-PIPELINE-SPINE-001 v0.9 §6 Phase 0（PRI-1290）');
  push('- 性质：**只读基线**。未修改生产数据库、账本文件与任何运行中 Agent 的状态。');
  push(`- 工作区：\`${model.meta.workspace}\``);
  push();
  push('## 1. 数据来源与快照方式');
  push();
  push('- 两个数据库均通过 `stageWalSnapshot`（WAL 双文件 T0/T1 指纹校验暂存快照）复制到系统临时目录后以 `{ readonly: true, fileMustExist: true }` 打开；源库从未被 SQLite 打开，源目录零 `-shm` 新增。');
  push('- 数据库路径经 canonical `resolveStateDbPath` / `resolveTrajectoryDbPath` 解析（`.pd/state.db`、`.state/trajectory.db`），无硬编码路径。');
  push('- 账本为纯 JSON 文件，经既有 `readLedgerFileState` 只读读取（无 WAL 语义）。');
  push('- 报告是本脚本唯一的写入：目标路径经白名单校验（仅限仓库 `docs/reports/` 下、真实父目录逐字相等、文件名固定、拒绝符号链接/硬链接/非常规文件），经同目录临时文件原子替换写入；被拒绝时不产生任何写入。');
  push('- 快照所有权在取得时即登记：第二个库失败或超差补拍失败时，本轮已创建的全部暂存副本都会被释放。');
  push();
  push('## 2. 快照时间（T1 线性化点）与文件指纹');
  push();
  push('| 库 | T1 (capturedAt) | main SHA-256 | main size | wal state | wal SHA-256 | 快照尝试次数 |');
  push('|---|---|---|---|---|---|---|');
  push(`| state.db | ${model.meta.stateT1} | \`${model.meta.stateFingerprint.mainSha256}\` | ${model.meta.stateFingerprint.mainSize} | ${model.meta.stateFingerprint.walState} | ${model.meta.stateFingerprint.walSha256 ? '`' + model.meta.stateFingerprint.walSha256 + '`' : '—'} | ${model.meta.stateAttempts} |`);
  push(`| trajectory.db | ${model.meta.trajectoryT1} | \`${model.meta.trajectoryFingerprint.mainSha256}\` | ${model.meta.trajectoryFingerprint.mainSize} | ${model.meta.trajectoryFingerprint.walState} | ${model.meta.trajectoryFingerprint.walSha256 ? '`' + model.meta.trajectoryFingerprint.walSha256 + '`' : '—'} | ${model.meta.trajectoryAttempts} |`);
  push(`| ledger.json | ${model.meta.ledgerReadAt} | （整文件读取，availability=${model.meta.ledgerAvailability}） | — | — | — | 1 |`);
  push();
  push('## 3. 快照偏差窗口（两 T1 之差）');
  push();
  push(`- 实测偏差：**${model.meta.skewMs} ms**（建议阈值 ≤ ${SNAPSHOT_SKEW_MAX_MS} ms，未经生产校准）。`);
  push(`- 超差重试：${model.meta.skewRetried ? '已执行一次（对较早的库重新快照）' : '未触发'}。`);
  if (model.meta.skewExceeded) {
    push(`- **重试后仍超出建议窗口**（当前偏差 ${model.meta.skewMs} ms）。两次快照非原子，跨库对比按第 4 节窗口语义解读。`);
  }
  push();
  push('## 4. 跨库写入允许延迟假设');
  push();
  push(`- 建议值 ≤ ${CROSS_DB_WRITE_DELAY_MS / 1000} s，**未经生产实证校准**。`);
  push('- 判定规则：跨库关联缺失以**现存记录自身时间戳 vs 对方库 T1** 判定；窗口内（以及校准前超窗）一律标 `skew_window_candidate`，可延迟复查；本基线不据此判定确定流失。');
  push('- 适用范围：仅两端分属不同数据库的关系（`pain→task`、`task→pain`）。同一快照内的关系（`candidate→dreamer`）不存在快照时间差，单独统计，不计入跨库偏斜。');
  push();
  push('## 5. 全量漏斗（自库创建起）');
  push();
  push('```text');
  push(`Pain 提交总量            ${valueOrNA(model.trajectory.pain.total)}`);
  push(`  └ 有 canonical id      ${valueOrNA(model.trajectory.pain.withCanonicalId)}`);
  push(`  └ 引用 runtime task    ${valueOrNA(model.trajectory.pain.withRuntimeTaskId)}`);
  push(`诊断父任务 diagnostician ${kindTotal(model.state.diagnosis, 'diagnostician')}`);
  push(`  └ diag_rootcause       ${kindTotal(model.state.diagnosis, 'diag_rootcause')}`);
  push(`  └ diag_distiller       ${kindTotal(model.state.diagnosis, 'diag_distiller')}`);
  push(`  └ diag_router          ${kindTotal(model.state.diagnosis, 'diag_router')}`);
  push(`死信 dead_letter_pains    ${valueOrNA(model.state.diagnosis.deadLetterPains?.total)}（未重放 ${valueOrNA(model.state.diagnosis.deadLetterPains?.unretried)}）`);
  push(`诊断持久化 pain_diagnoses ${valueOrNA(model.state.diagnosis.painDiagnoses?.total)}`);
  push(`候选 principle_candidates ${valueOrNA(model.state.candidates.total)}`);
  push(`账本 principles           ${model.meta.ledgerPrinciples === null ? 'NA(' + model.meta.ledgerAvailability + ')' : model.meta.ledgerPrinciples.total}`);
  push(`内化 dreamer               ${kindTotal(model.state.internalization, 'dreamer', true)}`);
  push(`  └ philosopher           ${kindTotal(model.state.internalization, 'philosopher', true)}`);
  push(`  └ scribe                ${kindTotal(model.state.internalization, 'scribe', true)}`);
  push(`  └ artificer             ${kindTotal(model.state.internalization, 'artificer', true)}`);
  push(`  └ evaluator             ${kindTotal(model.state.internalization, 'evaluator', true)}`);
  push(`  └ rollout_reviewer      ${kindTotal(model.state.internalization, 'rollout_reviewer', true)}`);
  push(`审批 approvals             ${valueOrNA(sumOrNA(model.state.activation.approvalsByStatus))}`);
  push(`激活 activations           ${valueOrNA(sumOrNA(model.state.activation.activationsByAction))}`);
  push(`应用 principle_applications ${valueOrNA(model.state.application.total)}（原则数 ${valueOrNA(model.state.application.distinctPrinciples)}）`);
  push(`拦截 gate_blocks            ${valueOrNA(model.trajectory.interception.gateBlocks?.total)}`);
  push('```');
  push();
  renderWindow(push, model);
  push('## 7. 阶段明细与状态分布');
  push();
  push('### Pain（trajectory.pain_events）');
  push();
  push(`- 来源分布：${fmtCounts(model.trajectory.pain.bySource)}`);
  push(`- 宿主分布：${fmtCounts(model.trajectory.pain.byHostKind)}`);
  push(`- 严重度分布：${fmtCounts(model.trajectory.pain.bySeverity)}`);
  push();
  push('### 诊断（state.tasks / runs / dead_letter_pains）');
  push();
  push(`- task_kind × status：${fmtCounts(model.state.diagnosis.taskKindStatus)}`);
  push(`- 失败任务（按 kind）：${fmtCounts(model.state.diagnosis.failedTasksByKind)}`);
  push(`- 诊断运行失败（runs ⋈ tasks，仅 Diagnostician 类任务；按 run/尝试计数）error_category：${fmtCounts(topN(model.state.diagnosis.diagnosticianRunFailuresByErrorCategory ?? {}, 8))}`);
  push();
  push('### 候选与准入（principle_candidates / admission_json）');
  push();
  push(`- 状态分布：${fmtCounts(model.state.candidates.byStatus)}`);
  push(`- 原始 recommendation_kind 分布（该列即原始持久化值，非归一化视图）：${fmtCounts(model.state.candidates.byRawKind)}`);
  if (model.state.candidates.admission) {
    push(`- 准入决定分布：${fmtCounts(model.state.candidates.admission.decisions)}`);
    push(`- 当前评估 reason Top（含 admitted）：${fmtCounts(model.state.candidates.admission.reasonsTop)}`);
    push(`- processing.state 分布：${fmtCounts(model.state.candidates.admission.processingStates)}`);
    push(`- 文档缺失：${model.state.candidates.admission.absent}；文档损坏（JSON 无效）：${model.state.candidates.admission.invalid}；带 Owner 决策记录：${model.state.candidates.admission.candidatesWithOwnerDecisions}`);
  } else {
    push('- 准入文档：_表缺失_');
  }
  push();
  push('### 账本（ledger.json）');
  push();
  if (model.meta.ledgerPrinciples === null) {
    push(`- availability = ${model.meta.ledgerAvailability}（未计入漏斗）`);
  } else {
    const p = model.meta.ledgerPrinciples;
    push(`- 原则总数 ${p.total}；带 reuseEvidence ${p.withReuseEvidence}（共 ${p.reuseEdges} 条边）；带 derivedFromPainIds ${p.withDerivedCandidates}；关联候选数 ${p.linkedCandidateCount}`);
  }
  push();
  push('### 内化（peer 任务 × status）');
  push();
  for (const kind of PEER_RUNNER_KINDS) {
    push(`- ${kind}：${kindTotal(model.state.internalization, kind, true)}`);
  }
  push(`- 内化运行失败（runs ⋈ tasks，仅 peer runner 任务；按 run/尝试计数）error_category：${fmtCounts(topN(model.state.internalization.peerRunFailuresByErrorCategory ?? {}, 8))}`);
  push();
  push('### 激活（approvals / activations / pi_artifacts）');
  push();
  push(`- approvals 状态：${fmtCounts(model.state.activation.approvalsByStatus)}`);
  push(`- approvals 渠道：${fmtCounts(model.state.activation.approvalsByChannel)}`);
  push(`- activations 动作：${fmtCounts(model.state.activation.activationsByAction)}`);
  push(`- activations 渠道：${fmtCounts(model.state.activation.activationsByChannel)}`);
  push(`- 激活目标形态：${JSON.stringify(model.state.activation.targets)}（规则激活的 target_ref 是 \`impl://<ruleId>_<artifactVersion>\`——规则身份，不是 principle UUID；principle UUID 以 \`pi_artifacts.source_principle_id\` / \`principle_applications.principle_id\` 为准。）`);
  push(`- pi_artifacts：总数 ${valueOrNA(model.state.activation.piArtifacts?.total)}，带 source_principle_id ${valueOrNA(model.state.activation.piArtifacts?.withSourcePrincipleId)}，验证状态 ${fmtCounts(model.state.activation.piArtifacts?.byValidationStatus)}`);
  push();
  push('### 注入/拦截（principle_applications / gate_blocks）');
  push();
  push(`- 应用类型：${fmtCounts(model.state.application.byKind)}`);
  push(`- 应用层级：${fmtCounts(model.state.application.byLevel)}`);
  push(`- 拦截工具分布：${fmtCounts(model.trajectory.interception.gateBlocks?.byTool)}`);
  push(`- 干预证据记录：${valueOrNA(model.state.application.interventionEvidenceRecords)}`);
  push();
  push('## 8. 转化率（全量；分子/分母口径逐条声明）');
  push();
  push('| 转化 | 分子（口径） | 分母（口径） | 值 |');
  push('|---|---|---|---|');
  const diagParents = kindTotalOrNull(model.state.diagnosis, 'diagnostician');
  push(`| Pain→诊断 | diagnostician 父任务数 | pain_events 总量（两者为不同登记面，仅作比例参考） | ${ratio(diagParents, model.trajectory.pain.total)} |`);
  push(`| 诊断→候选 | principle_candidates 总量 | diagnostician 父任务数 | ${ratio(model.state.candidates.total, diagParents)} |`);
  const consumed = model.state.candidates.byStatus?.consumed ?? null;
  const dreamerTotal = kindTotalOrNull(model.state.internalization, 'dreamer', true);
  push(`| 候选consumed→播种 | dreamer 任务数 | status='consumed' 的候选数 | ${ratio(dreamerTotal, consumed)} |`);
  const scribeTotal = kindTotalOrNull(model.state.internalization, 'scribe', true);
  push(`| 播种→Scribe | scribe 任务数 | dreamer 任务数 | ${ratio(scribeTotal, dreamerTotal)} |`);
  const approved = model.state.activation.approvalsByStatus?.approved ?? null;
  push(`| 审批通过 | approvals status='approved' | approvals 全部 | ${ratio(approved, sumOrNA(model.state.activation.approvalsByStatus))} |`);
  push(`| 激活→应用 | DISTINCT principle_id in principle_applications | 激活目标 DISTINCT target_ref | ${ratio(model.state.application.distinctPrinciples, model.state.activation.targets?.distinct)} |`);
  push();
  push('> 上述比率是**观测比例**而非严格漏斗转化（各阶段登记面与去重口径不同，已在分子/分母列声明）。');
  push();
  push('## 9. 失败与拒绝原因分布（按阶段分开）');
  push();
  push(`- 诊断运行失败 error_category（仅 Diagnostician 任务：${DIAGNOSTICIAN_KINDS.join(', ')}）：${fmtCounts(topN(model.state.diagnosis.diagnosticianRunFailuresByErrorCategory ?? {}, 8))}`);
  push(`- 内化运行失败 error_category（仅 peer runner 任务：${PEER_RUNNER_KINDS.join(', ')}）：${fmtCounts(topN(model.state.internalization.peerRunFailuresByErrorCategory ?? {}, 8))}`);
  push(`- 全管道运行失败 error_category（全部任务类型，含上述两类；单独命名，不与诊断混同）：${fmtCounts(topN(model.state.failures.allPipelineRunFailuresByErrorCategory ?? {}, 8))}`);
  push(`- 任务失败（status='failed'，按 kind）：${fmtCounts(model.state.failures.allPipelineFailedTasksByKind)}`);
  if (model.state.candidates.admission) {
    push(`- 非 admitted 决定的 reason Top：${fmtCounts(model.state.candidates.admission.refusalReasonsTop)}`);
  }
  push();
  renderLinkage(push, model, skew);
  push('## 12. 当前无法确定的问题');
  push();
  push('- 5 s / 60 s 两个窗口阈值未经生产写入链路实证校准；本报告的跨库缺失因此全部按 `skew_window_candidate` 输出。');
  push('- Shadow 与 Live 激活的区分依赖 activations.channel/action 的语义组合，本报告只按原始值分布输出，不做语义归类。');
  push('- 候选→账本 的未关联候选包含合法 pending/待审路径（Owner 未 intake 的候选本就不在账本），该差值不是流失。');
  push('- task→pain 的缺失可能由 trajectory.db 的保留期清理（trajectory-retention）造成——旧 pain 行被清理后诊断任务仍在；该方向缺失在保留策略确认前不解读为写入断线。');
  push('- 近 N 天漏斗按各阶段自身的创建/请求/激活时间计数，不是同一批 Pain 的队列（cohort）转化：跨窗口血缘（窗口前创建的候选在窗口内播种）会使相邻阶段比例偏离真实转化。');
  push();
  push('## 13. 对 D1/D2/D4 与架构收敛工作的影响判断');
  push();
  push('- 本基线为 Phase 1A/1B（PRI-1291）的红灯对照与漏斗对照提供**修复前**的真实分布快照；');
  push('- `candidate→dreamer`（同库）缺失按原始 kind 与账本证据分类：合法不播种路由与 reuse 解决不计为缺口，其余 principle/rule/prompt 候选逐条列出候选 ID 供调查；');
  push('- `task→pain` 缺失与诊断任务分布可作为 D1（同步授权与轨迹读取器）修复后诊断覆盖率的对照基线；');
  push('- Pain 阶段的来源/宿主分布为后续阈值校准（写入链路节奏）提供样本量依据。');
  push();
  push('---');
  push();
  push(`生成命令：\`node scripts/dev/pipeline-funnel-snapshot.mjs --workspace "${model.meta.workspace}"\`（PRI-1290 Phase 0，只读）`);
  return lines.join('\n') + '\n';
}

function renderWindow(push, model) {
  const window = model.window;
  push(`## 6. 近 ${model.meta.days} 天漏斗（窗口 [${window.cutoffIso}, 快照 T1)）`);
  push();
  push('每个阶段使用自身的真实事件时间列（见「时间列」），全部落在同一个窗口内；表缺失时记 `NA(表缺失)`，不补零。');
  push();
  push('| 阶段 | 表 | 时间列 | 窗口内数量 | 无法解析时间戳 |');
  push('|---|---|---|---|---|');
  for (const stage of Object.values(window.stages)) {
    push(`| ${stage.label} | ${stage.table} | ${stage.column} | ${valueOrNA(stage.count)} | ${valueOrNA(stage.unparseableTimestamps)} |`);
  }
  push();
  push('阶段转化率（观测比例；相邻阶段窗口内数量之比）：');
  push();
  push('| 转化 | 分子 | 分母 | 值 |');
  push('|---|---|---|---|');
  const s = window.stages;
  push(`| Pain→诊断 | Diagnostician 任务（父任务 + diag_* 子任务） | Pain | ${ratio(s.diagnostician?.count, s.pain?.count)} |`);
  push(`| 诊断→候选 | 候选（principle_candidates.created_at） | Diagnostician 任务（父任务 + diag_* 子任务） | ${ratio(model.state.candidates.windowed, s.diagnostician?.count)} |`);
  push(`| 候选→播种 | Dreamer | 候选 | ${ratio(s.dreamer?.count, model.state.candidates.windowed)} |`);
  push(`| 播种→Philosopher | Philosopher | Dreamer | ${ratio(s.philosopher?.count, s.dreamer?.count)} |`);
  push(`| Philosopher→Scribe | Scribe | Philosopher | ${ratio(s.scribe?.count, s.philosopher?.count)} |`);
  push(`| Scribe→Artificer | Artificer | Scribe | ${ratio(s.artificer?.count, s.scribe?.count)} |`);
  push(`| Artificer→Evaluator | Evaluator | Artificer | ${ratio(s.evaluator?.count, s.artificer?.count)} |`);
  push(`| Evaluator→RolloutReviewer | RolloutReviewer | Evaluator | ${ratio(s.rollout_reviewer?.count, s.evaluator?.count)} |`);
  push(`| RolloutReviewer→审批请求 | Approval 请求 | RolloutReviewer | ${ratio(s.approvals?.count, s.rollout_reviewer?.count)} |`);
  push(`| 审批请求→激活 | Activation | Approval 请求 | ${ratio(s.activations?.count, s.approvals?.count)} |`);
  push();
  push('窗口内结果拆分（失败 / 等待 Owner / 合法跳过 / 缺失关联分开计）：');
  push();
  const taskStatus = window.taskStatusByKind;
  for (const kind of ['diagnostician', 'dreamer', 'philosopher', 'scribe', 'artificer', 'evaluator', 'rollout_reviewer']) {
    push(`- ${kind} 任务状态：${taskStatus === null ? '_table missing_' : fmtCounts(taskStatus[kind] ?? {})}`);
  }
  const cb = window.candidateBreakdown;
  if (cb === null) {
    push('- 候选：_table missing_');
  } else {
    const legalNoSeed = Object.entries(cb.byRawKind)
      .filter(([kind]) => NO_SEED_ROUTE_KINDS.includes(kind))
      .reduce((acc, [, n]) => acc + n, 0);
    push(`- 候选（窗口内 ${cb.total}）：按原始 kind ${fmtCounts(cb.byRawKind)}；按状态 ${fmtCounts(cb.byStatus)}；已消费 ${cb.consumed}`);
    push(`  - 合法跳过（implementation/defer，本就不播种）：${legalNoSeed}`);
    push(`  - 等待 Owner（准入 processing.state=awaiting_owner，或文档带 Owner 决策记录）：${cb.awaitingOwner}；准入耗尽（processing.state=exhausted）：${cb.exhausted}；processing.state：${fmtCounts(cb.processingStates)}`);
  }
  push(`- Approval 请求按状态（pending=等待 Owner）：${fmtCounts(window.approvalsByStatus)}`);
  push(`- Activation 按动作：${fmtCounts(window.activationsByAction)}`);
  const sameDb = model.linkage.candidateToDreamer;
  push(`- 缺失关联（已消费但无 Dreamer，全量口径，同库）：${valueOrNA(sameDb?.consumedWithoutDreamerTask)}（分类见第 10 节）`);
  push();
}

function renderLinkage(push, model, skew) {
  push('## 10. 关联缺失记录');
  push();
  push('### 10.1 跨库关联缺失（计入 skew_window_candidate）');
  push();
  push('```text');
  push(`pain→task:     引用 runtime_task_id 的 pain ${valueOrNA(model.linkage.painToTask?.painsWithRuntimeTaskRef)} 条，其中任务缺失 ${model.linkage.painToTask?.missingTaskRefs ?? 'NA'} 条 → ${JSON.stringify(model.linkage.painToTask?.buckets ?? {})}（阈值未校准 ${model.linkage.painToTask?.thresholdUncalibrated ?? 'NA'}）`);
  push(`task→pain:     带 diagnostic_json 的 diagnostician 任务 ${valueOrNA(model.linkage.taskToPain?.diagnosticianTasksWithJson)} 条，pain 可见 ${valueOrNA(model.linkage.taskToPain?.linkedPainFound)} 条，缺失 ${model.linkage.taskToPain?.painMissing ?? 'NA'} 条 → ${JSON.stringify(model.linkage.taskToPain?.buckets ?? {})}（阈值未校准 ${model.linkage.taskToPain?.thresholdUncalibrated ?? 'NA'}）`);
  push('```');
  push();
  push('### 10.2 同库关联缺失：已消费候选无 Dreamer 任务（不计入跨库偏斜）');
  push();
  const c2d = model.linkage.candidateToDreamer;
  if (c2d === null || c2d === undefined || c2d.consumedWithoutDreamerTask === null) {
    push('- _table missing_');
  } else {
    push(`- 已消费候选 ${valueOrNA(c2d.consumedCandidates)} 条，其中无 Dreamer 任务 ${c2d.consumedWithoutDreamerTask} 条；按原始 kind：${fmtCounts(c2d.byRawKind)}`);
    push(`- 分类：${fmtCounts(c2d.classification)}`);
    push('  - `legal_no_seed_route`：implementation（通道 MVP 未启用）/ defer（延迟路由）——设计上不播种，不是异常。');
    push('  - `legal_reuse_resolved`：账本 reuseEvidence 记录该候选已复用既有原则——按设计抑制独立 Dreamer 播种。');
    push('  - `awaiting_owner_decision`：准入处理停在 awaiting_owner（等待 Owner 决策/入库），尚未入账本——不播种是规定行为，属 Owner 待办而非管道缺口。');
    push('  - `invalid_raw_kind`：原始 kind 不在已知集合——数据问题，逐条列出。');
    push('  - `unexplained_requires_investigation`：既无不播种理由、无 reuse 证据、也未停在等待 Owner——需要逐条调查。');
    const awaitingOwner = (c2d.samples ?? []).filter((sample) => sample.classification === NO_DREAMER_CLASSIFICATION.AWAITING_OWNER);
    if (awaitingOwner.length === 0) {
      push('  - 等待 Owner 决策的候选：无。');
    } else {
      push('  - 等待 Owner 决策的候选（候选 ID / 原始 kind / 创建时间 / 准入决定 / processing.state）：');
      for (const sample of awaitingOwner) {
        push(`    - \`${sample.candidateId}\` · ${sample.rawKind ?? '(null)'} · ${sample.createdAt} · ${sample.admissionDecision ?? '(无当前评估)'} · ${sample.admissionProcessingState ?? '(none)'}`);
      }
    }
    const investigate = (c2d.samples ?? []).filter((sample) => sample.classification === NO_DREAMER_CLASSIFICATION.UNEXPLAINED || sample.classification === NO_DREAMER_CLASSIFICATION.INVALID_RAW_KIND);
    if (investigate.length === 0) {
      push('  - 需调查样本：无。');
    } else {
      push('  - 需调查样本（候选 ID / 原始 kind / 创建时间 / 准入决定 / processing.state / 是否入账本 derived / 分类）：');
      for (const sample of investigate) {
        push(`    - \`${sample.candidateId}\` · ${sample.rawKind ?? '(null)'} · ${sample.createdAt} · ${sample.admissionDecision ?? '(无当前评估)'} · ${sample.admissionProcessingState ?? '(none)'} · derived=${sample.ledgerDerived} · ${sample.classification}`);
      }
    }
  }
  push();
  push('## 11. skew_window_candidate 总数（跨库）：**' + valueOrNA(skew.crossDbSkewWindowCandidates) + '**');
  push();
  push(`- 口径：仅 pain→task（${valueOrNA(skew.crossDbByRelation.painToTask)}）+ task→pain（${valueOrNA(skew.crossDbByRelation.taskToPain)}）两类跨库关系之和。`);
  push(`- 同库的「已消费无 Dreamer」（${valueOrNA(skew.sameDbConsumedWithoutDreamer)}）不计入本总数，见第 10.2 节。`);
  push();
  push('（跨库缺失均落入该桶；其中标注「阈值未校准」的条目为超出 60 s 建议窗口者——在校准完成前不判定确定流失，可延迟复查。全部样本 ID 见 `--json` 输出的 `model.linkage`。）');
  push();
}

function valueOrNA(v) {
  return v === null || v === undefined ? 'NA(表缺失)' : String(v);
}

function kindTotal(section, kind, fromByKind = false) {
  return valueOrNA(kindTotalOrNull(section, kind, fromByKind));
}

/** Stage count, or null when the backing table is missing (never a fake 0). */
function kindTotalOrNull(section, kind, fromByKind = false) {
  if (!section) return null;
  if (fromByKind) {
    if (section.peerTasksByKind === null || section.peerTasksByKind === undefined) return null;
    const v = section.peerTasksByKind[kind]?.total;
    return v === undefined ? 0 : v;
  }
  if (section.kindTotals === null || section.kindTotals === undefined) return null;
  const v = section.kindTotals[kind];
  return v === undefined ? 0 : v;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  const workspace = path.resolve(options.workspace);
  if (!fs.existsSync(workspace)) {
    throw new Error(`workspace_not_found: ${workspace}`);
  }
  const runDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  // Output path is validated BEFORE any snapshot work: a refused
  // destination must not cost a snapshot or create a staging directory.
  const target = resolveReportTarget({
    outArg: options.out,
    runDate,
    reportsDir: deps.reportsDir ?? DEFAULT_REPORTS_DIR,
    workspaceDir: workspace,
    protectedRoots: deps.protectedRoots ?? DEFAULT_PROTECTED_ROOTS,
  });

  const stateDbPath = storagePaths.resolveStateDbPath(workspace);
  const trajectoryDbPath = storagePaths.resolveTrajectoryDbPath(workspace);
  for (const [label, dbPath] of [['state.db', stateDbPath], ['trajectory.db', trajectoryDbPath]]) {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`database_missing: ${label} not found at canonical path ${dbPath} (resolved via storage-paths; refusing to guess)`);
    }
  }

  const pair = snapshotPair(stateDbPath, trajectoryDbPath);
  let stateDb = null;
  let trajectoryDb = null;
  let model;
  try {
    stateDb = openStagedReadonly(pair.state.staged.stagedDbPath);
    trajectoryDb = openStagedReadonly(pair.trajectory.staged.stagedDbPath);
    const laterT1 = Date.parse(pair.state.staged.capturedAt) >= Date.parse(pair.trajectory.staged.capturedAt)
      ? pair.state.staged.capturedAt
      : pair.trajectory.staged.capturedAt;
    const cutoffIso = new Date(Date.parse(laterT1) - options.days * 24 * 60 * 60 * 1000).toISOString();

    const ledger = collectLedgerStats(workspace);
    const state = collectStateFunnel(stateDb, cutoffIso);
    const trajectory = collectTrajectoryFunnel(trajectoryDb, cutoffIso);
    const linkage = collectLinkage(stateDb, trajectoryDb, pair.state.staged.capturedAt, pair.trajectory.staged.capturedAt, ledger);
    const window = collectWindow(stateDb, trajectoryDb, cutoffIso);

    model = {
      meta: {
        runDate,
        workspace,
        days: options.days,
        cutoffIso,
        stateT1: pair.state.staged.capturedAt,
        stateFingerprint: pair.state.staged.fingerprint,
        stateAttempts: pair.state.attempts,
        trajectoryT1: pair.trajectory.staged.capturedAt,
        trajectoryFingerprint: pair.trajectory.staged.fingerprint,
        trajectoryAttempts: pair.trajectory.attempts,
        skewMs: pair.skewExceededMs,
        skewRetried: pair.skewRetried,
        skewExceeded: pair.skewExceededMs > SNAPSHOT_SKEW_MAX_MS,
        ledgerReadAt: ledger.readAt,
        ledgerAvailability: ledger.availability,
        ledgerPrinciples: ledger.principles,
      },
      trajectory,
      state,
      window,
      linkage,
      skewSummary: summarizeLinkage(linkage),
    };
  } finally {
    // Close EVERY connection before dispose (Windows temp-file hostage rule).
    if (trajectoryDb !== null) trajectoryDb.close();
    if (stateDb !== null) stateDb.close();
    pair.state.staged.dispose();
    pair.trajectory.staged.dispose();
  }

  const report = renderReport(model);
  writeReportAtomically(target.outPath, report);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, out: target.outPath, meta: model.meta, skewSummary: model.skewSummary, model })}\n`);
  } else {
    process.stdout.write(`funnel baseline written: ${target.outPath}\n`);
    process.stdout.write(`state T1=${model.meta.stateT1} traj T1=${model.meta.trajectoryT1} skew=${model.meta.skewMs}ms${model.meta.skewExceeded ? ' (EXCEEDED, flagged)' : ''}\n`);
    process.stdout.write(`cross-db skew_window_candidate=${valueOrNA(model.skewSummary.crossDbSkewWindowCandidates)} (same-db consumed-without-dreamer=${valueOrNA(model.skewSummary.sameDbConsumedWithoutDreamer)}, reported separately)\n`);
  }
  return model;
}

const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
