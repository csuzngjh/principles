/**
 * pipeline-funnel-snapshot.mjs tests — SPEC-PD-PIPELINE-SPINE-001 v0.9
 * Phase 0 (PRI-1290).
 *
 * Script-level contract on synthetic workspaces:
 *   - database location goes through the canonical resolvers
 *     (`.pd/state.db` + `.state/trajectory.db`), never a hardcoded path;
 *   - both databases are read through the WAL-safe staged snapshot: an
 *     un-checkpointed `-wal` commit is visible in the funnel counts, the
 *     source directory gains no `-shm`, and source bytes stay identical;
 *   - the ONLY write is the report, into an allowlisted directory under the
 *     strict report name, via temp file + atomic rename; a refused
 *     destination (workspace data dir, symlink/junction, hard link, …)
 *     leaves every existing byte unchanged and takes no snapshot;
 *   - snapshot ownership is registered on acquisition: a failure while
 *     acquiring the second database or re-taking the earlier one leaves no
 *     staging directory behind, and dispose is safe to repeat;
 *   - cross-database skew counts ONLY the two relations that span the two
 *     databases; the same-database candidate→Dreamer relation is classified
 *     apart, by raw kind and ledger evidence;
 *   - failure rankings are split by stage (diagnostician / peer runners /
 *     whole pipeline) through the `runs ⋈ tasks` relation;
 *   - the recent window reports every stage on its own real time column,
 *     flags unparseable timestamps, and marks a missing table NA (never 0);
 *   - `--json` emits exactly one machine-readable object; failures fail
 *     loud instead of producing a half report.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import * as painRecall from '@principles/core/runtime/pain-recall';

import {
  parseArgs,
  classifyMissingLink,
  main,
  resolveReportTarget,
  writeReportAtomically,
  snapshotPair,
  summarizeLinkage,
  classifyConsumedWithoutDreamer,
  NO_DREAMER_CLASSIFICATION,
  SNAPSHOT_SKEW_MAX_MS,
  CROSS_DB_WRITE_DELAY_MS,
  SNAPSHOT_MAX_ATTEMPTS,
} from '../dev/pipeline-funnel-snapshot.mjs';

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows may briefly hold handles; leftover temp dirs are inert.
    }
  }
});

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** Open the report, read it and stat it through the SAME descriptor. */
function inspectReport(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    return {
      content: fs.readFileSync(fd, 'utf-8'),
      inode: fs.fstatSync(fd, { bigint: true }).ino,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function inodeOfReport(filePath) {
  return inspectReport(filePath).inode;
}

function captureTreeState(rootDir) {
  const entries = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const rel = path.relative(rootDir, abs);
      const stat = fs.statSync(abs);
      entries.push(stat.isFile() ? `${rel}:${sha256File(abs)}` : `${rel}/`);
      if (stat.isDirectory()) walk(abs);
    }
  };
  walk(rootDir);
  return entries;
}

/** Staging roots left by stageWalSnapshot. vitest points TMPDIR at a
 * per-run directory, so this listing is private to the test run. */
function stagingRootsInTmp() {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('pd-pain-recall-stage-'));
}

let stagingBaseline = new Set();
beforeEach(() => {
  stagingBaseline = new Set(stagingRootsInTmp());
});

/** Staging roots created since this test started — isolated from whatever
 * an earlier (possibly failing) test may have left, so one broken test can
 * neither cause nor hide a leak in another. */
function stagingRootsCreatedByThisTest() {
  return stagingRootsInTmp().filter((name) => !stagingBaseline.has(name));
}

/** Assert `action` creates no staging root (a refusal must cost no snapshot). */
async function expectNoStagingCreated(action) {
  await action();
  expect(stagingRootsCreatedByThisTest()).toEqual([]);
}

const REPORT_NAME = 'PD_PIPELINE_FUNNEL_BASELINE_20261124.md';
const OUTSIDE_WINDOW_DAYS = 40;

/** ISO timestamp `days` days before the real clock — window membership is
 * relative, so this file carries no calendar time bomb. */
function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Every base-fixture row is stamped one day ago: inside a 30-day window. */
const SEED_AT = daysAgoIso(1);

/** Build a synthetic PD workspace with WAL-mode databases laid out at the
 * canonical paths. `leaveWalOpen` keeps a writer connection open with an
 * un-checkpointed commit so the staged snapshot must replay the `-wal`. */
function seedWorkspace({ leaveWalOpen = false } = {}) {
  const workspace = makeTempDir('pd-funnel-ws-');
  const stateDbPath = path.join(workspace, '.pd', 'state.db');
  const trajectoryDbPath = path.join(workspace, '.state', 'trajectory.db');
  fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
  fs.mkdirSync(path.dirname(trajectoryDbPath), { recursive: true });

  const state = new Database(stateDbPath);
  state.pragma('journal_mode = WAL');
  state.exec(`CREATE TABLE tasks (task_id TEXT PRIMARY KEY, task_kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, lease_owner TEXT, lease_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
      last_error TEXT, input_ref TEXT, result_ref TEXT, diagnostic_json TEXT, lease_generation INTEGER NOT NULL DEFAULT 0)`);
  state.exec(`CREATE TABLE runs (run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, runtime_kind TEXT NOT NULL, execution_status TEXT NOT NULL DEFAULT 'queued',
      started_at TEXT NOT NULL, ended_at TEXT, reason TEXT, output_ref TEXT, input_payload TEXT, output_payload TEXT,
      error_category TEXT, attempt_number INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  state.exec(`CREATE TABLE principle_candidates (candidate_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, task_id TEXT NOT NULL,
      source_run_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, confidence REAL, source_recommendation_json TEXT,
      idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, consumed_at TEXT,
      recommendation_kind TEXT NOT NULL DEFAULT 'principle', trigger_pattern TEXT, action TEXT, abstracted_principle TEXT, admission_json TEXT)`);
  state.exec(`CREATE TABLE approvals (approval_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, channel TEXT NOT NULL, risk_level TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', confidence REAL, requested_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT,
      decision_note TEXT, rejection_reason TEXT)`);
  state.exec(`CREATE TABLE activations (activation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, artifact_id TEXT NOT NULL,
      channel TEXT NOT NULL, action TEXT NOT NULL, target_ref TEXT NOT NULL, activated_at TEXT NOT NULL, promoted_at TEXT, deactivated_at TEXT)`);
  state.exec(`CREATE TABLE pi_artifacts (artifact_id TEXT PRIMARY KEY, artifact_kind TEXT NOT NULL, source_task_id TEXT NOT NULL,
      source_principle_id TEXT, source_rule_id TEXT, lineage_artifact_ids TEXT NOT NULL DEFAULT '[]',
      validation_status TEXT NOT NULL DEFAULT 'pending', content_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  state.exec(`CREATE TABLE principle_applications (id INTEGER PRIMARY KEY AUTOINCREMENT, principle_id TEXT NOT NULL, activation_id TEXT,
      rule_id TEXT, channel TEXT NOT NULL, level TEXT NOT NULL, kind TEXT NOT NULL, session_id TEXT, tool_name TEXT, file_path TEXT,
      digest TEXT, created_at TEXT NOT NULL)`);
  state.exec(`CREATE TABLE dead_letter_pains (id TEXT PRIMARY KEY, pain_id TEXT NOT NULL, pain_data TEXT NOT NULL,
      failed_at TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, retried_at TEXT)`);
  state.exec(`CREATE TABLE pain_diagnoses (id TEXT PRIMARY KEY, pain_id TEXT NOT NULL, task_id TEXT NOT NULL, diagnosis_id TEXT NOT NULL,
      category TEXT NOT NULL, root_cause TEXT NOT NULL, evidence_json TEXT, confidence REAL, artifact_id TEXT, created_at TEXT NOT NULL)`);
  state.prepare(`INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, diagnostic_json) VALUES (?, 'diagnostician', 'completed', ?, ?, ?)`)
    .run('diag-parent-1', SEED_AT, SEED_AT, JSON.stringify({ sourcePainId: 'pain-canon-1' }));
  state.prepare(`INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, 'dreamer', 'completed', ?, ?)`)
    .run('dreamer-11111111-1111-4111-8111-111111111111-r1', SEED_AT, SEED_AT);
  state.prepare(`INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, idempotency_key, status, created_at, recommendation_kind, admission_json)
      VALUES ('11111111-1111-4111-8111-111111111111', 'a1', 'diag-parent-1', 'r1', 't', 'd', 'k1', 'consumed', ?, 'principle', ?)`)
    .run(SEED_AT, JSON.stringify({
      evaluations: [{ evaluationId: 'e1', decision: 'admitted', reason: 'sufficient_input_evidence', nextAction: 'n', evaluatedAt: SEED_AT, policyVersion: 'p', provenance: 'auto', inputEvidenceCount: 2, ownerStatementPresent: false, recommendationKind: 'principle', confidence: 0.5, materialFingerprint: 'f', materialSummary: { inputEvidenceCount: 2, outputEvidenceCount: 0, ownerStatementPresent: false } }],
      currentEvaluationId: 'e1',
      processing: { state: 'complete', attempts: 1 },
    }));
  state.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
      VALUES ('act1', 'ik1', 'a1', 'prompt', 'activate', '11111111-2222-4111-8111-111111111111', ?)`).run(SEED_AT);
  state.prepare(`INSERT INTO principle_applications (principle_id, channel, level, kind, created_at)
      VALUES ('11111111-2222-4111-8111-111111111111', 'prompt', 'presence', 'prompt_injected', ?)`).run(SEED_AT);

  const trajectory = new Database(trajectoryDbPath);
  trajectory.pragma('journal_mode = WAL');
  trajectory.exec(`CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL,
      score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT,
      runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)`);
  trajectory.exec(`CREATE TABLE gate_blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, tool_name TEXT NOT NULL,
      file_path TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL)`);
  trajectory.prepare(`INSERT INTO pain_events (session_id, source, score, canonical_pain_id, runtime_task_id, host_kind, created_at)
      VALUES ('s1', 'auto_detect', 0.8, 'pain-canon-1', 'diag-parent-1', 'openclaw', ?)`).run(SEED_AT);
  trajectory.prepare(`INSERT INTO gate_blocks (session_id, tool_name, reason, created_at) VALUES ('s1', 'Bash', 'rule_match', ?)`).run(SEED_AT);

  if (leaveWalOpen) {
    // The un-checkpointed commit lives only in the -wal: the funnel must
    // still count it through the staged snapshot's wal replay.
    trajectory.prepare(`INSERT INTO pain_events (session_id, source, score, canonical_pain_id, host_kind, created_at)
      VALUES ('s2', 'mcp_submit', 0.9, 'pain-canon-wal-only', 'codex', ?)`).run(SEED_AT);
  } else {
    state.close();
    trajectory.close();
  }
  return {
    workspace,
    stateDbPath,
    trajectoryDbPath,
    close: () => {
      state.close();
      trajectory.close();
    },
  };
}

/** Run `fn` with a short-lived connection on the workspace's state.db. */
function withState(ws, fn) {
  const db = new Database(ws.stateDbPath);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function insertTask(db, taskId, kind, status, createdAt) {
  db.prepare(`INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(taskId, kind, status, createdAt, createdAt);
}

function insertFailedRun(db, runId, taskId, errorCategory, createdAt) {
  db.prepare(`INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, ended_at, error_category, created_at, updated_at)
      VALUES (?, ?, 'scripted', 'failed', ?, ?, ?, ?, ?)`)
    .run(runId, taskId, createdAt, createdAt, errorCategory, createdAt, createdAt);
}

function insertCandidate(db, candidateId, rawKind, status, createdAt, admissionJson = null) {
  db.prepare(`INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, idempotency_key, status, created_at, consumed_at, recommendation_kind, admission_json)
      VALUES (?, ?, 'diag-parent-1', 'r1', 't', 'd', ?, ?, ?, ?, ?, ?)`)
    .run(candidateId, `artifact-${candidateId}`, `key-${candidateId}`, status, createdAt, status === 'consumed' ? createdAt : null, rawKind, admissionJson);
}

describe('parseArgs', () => {
  it('requires --workspace and rejects unknown flags', () => {
    expect(() => parseArgs([])).toThrow(/--workspace/);
    expect(() => parseArgs(['--workspace', 'w', '--nope'])).toThrow(/unknown argument/);
    expect(parseArgs(['--workspace', 'w'])).toEqual({ workspace: 'w', out: null, days: 30, json: false });
    expect(() => parseArgs(['--workspace', 'w', '--days', 'x'])).toThrow(/positive integer/);
  });
});

describe('classifyMissingLink', () => {
  it('classifies in-window misses as skew_window_candidate (not calibrated = false)', () => {
    const verdict = classifyMissingLink({
      recordTimestamp: '2026-11-24T00:00:10.000Z',
      otherDbT1: '2026-11-24T00:00:30.000Z',
    });
    expect(verdict.bucket).toBe('skew_window_candidate');
    expect(verdict.thresholdUncalibrated).toBe(false);
  });

  it('keeps out-of-window misses in the same bucket but marks the threshold uncalibrated', () => {
    const verdict = classifyMissingLink({
      recordTimestamp: '2026-11-23T00:00:00.000Z',
      otherDbT1: '2026-11-24T00:00:30.000Z',
    });
    expect(verdict.bucket).toBe('skew_window_candidate');
    expect(verdict.thresholdUncalibrated).toBe(true);
  });

  it('handles unparsable timestamps fail-safe as uncalibrated candidates', () => {
    const verdict = classifyMissingLink({ recordTimestamp: null, otherDbT1: '2026-11-24T00:00:00.000Z' });
    expect(verdict.bucket).toBe('skew_window_candidate');
    expect(verdict.thresholdUncalibrated).toBe(true);
  });

  it('honors a custom allowDelayMs', () => {
    const verdict = classifyMissingLink({
      recordTimestamp: '2026-11-24T00:00:00.000Z',
      otherDbT1: '2026-11-24T00:00:02.000Z',
      allowDelayMs: 1000,
    });
    expect(verdict.bucket).toBe('skew_window_candidate');
    expect(verdict.thresholdUncalibrated).toBe(true);
  });
});

// ── Report output path safety (review round 2, P1-1) ─────────────────────────

describe('report output path allowlist', () => {
  /** A workspace plus a private "reports directory". Tests inject the
   * directory through the programmatic seam; the CLI has no flag for it and
   * always writes to the repository's docs/reports. */
  function fixture() {
    const ws = seedWorkspace();
    const reportsDir = makeTempDir('pd-funnel-reports-');
    const run = (args, extraDeps = {}) => main(['--workspace', ws.workspace, ...args], { reportsDir, ...extraDeps });
    const out = (...segments) => path.join(reportsDir, ...segments);
    return { ws, reportsDir, run, out };
  }

  it('writes a normal report path (explicit --out and the default name)', async () => {
    const { reportsDir, run, out } = fixture();
    const explicit = out(REPORT_NAME);
    await run(['--out', explicit]);
    expect(fs.readFileSync(explicit, 'utf-8')).toContain('# PD Pipeline Funnel Baseline');

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const model = await run([]);
    expect(model.meta.runDate).toBe(today);
    expect(fs.readFileSync(path.join(reportsDir, `PD_PIPELINE_FUNNEL_BASELINE_${today}.md`), 'utf-8')).toContain('# PD Pipeline Funnel Baseline');
  });

  it('refuses --out pointing at the workspace .pd/state.db and leaves its bytes unchanged', async () => {
    const { run, ws } = fixture();
    const before = sha256File(ws.stateDbPath);
    await expectNoStagingCreated(async () => {
      await expect(run(['--out', ws.stateDbPath])).rejects.toThrow(/report_out_in_workspace_data_dir/);
    });
    expect(sha256File(ws.stateDbPath)).toBe(before);
  });

  it('refuses --out pointing at the workspace trajectory.db and leaves its bytes unchanged', async () => {
    const { run, ws } = fixture();
    const before = sha256File(ws.trajectoryDbPath);
    await expectNoStagingCreated(async () => {
      await expect(run(['--out', ws.trajectoryDbPath])).rejects.toThrow(/report_out_in_workspace_data_dir/);
    });
    expect(sha256File(ws.trajectoryDbPath)).toBe(before);
  });

  it('refuses a symlinked/junctioned directory that resolves into the workspace data dir', async () => {
    const { reportsDir, run, out, ws } = fixture();
    // 'junction' needs no privilege on Windows and degrades to a plain
    // directory symlink elsewhere — the bypass being tested is the same.
    const linkPath = path.join(reportsDir, 'linked');
    fs.symlinkSync(path.join(ws.workspace, '.pd'), linkPath, 'junction');
    const before = captureTreeState(path.join(ws.workspace, '.pd'));
    try {
      await expectNoStagingCreated(async () => {
        // the destination is judged where it really lands: inside the
        // workspace's data directory, so that is the reason reported
        await expect(run(['--out', out('linked', REPORT_NAME)])).rejects.toThrow(/report_out_in_workspace_data_dir/);
      });
      // the whole workspace data tree is byte-identical: nothing appeared, nothing changed
      expect(captureTreeState(path.join(ws.workspace, '.pd'))).toEqual(before);
    } finally {
      fs.rmSync(linkPath, { force: true, recursive: true }); // removes the link only, never its target
    }
  });

  it('judges containment on the canonical destination, not on how the path is spelled (link alias)', async () => {
    const { run, ws } = fixture();
    // The same database reached through an alias of the workspace directory:
    // a lexical "is it under <workspace>/.pd" test would miss it.
    const alias = path.join(makeTempDir('pd-funnel-alias-'), 'ws-alias');
    fs.symlinkSync(ws.workspace, alias, 'junction');
    const before = sha256File(ws.stateDbPath);
    try {
      await expectNoStagingCreated(async () => {
        await expect(run(['--out', path.join(alias, '.pd', 'state.db')])).rejects.toThrow(/report_out_in_workspace_data_dir/);
      });
      expect(sha256File(ws.stateDbPath)).toBe(before);
    } finally {
      fs.rmSync(alias, { force: true, recursive: true }); // removes the link only, never its target
    }
  });

  it('refuses a symlink report file pointing at the production database', async (ctx) => {
    const { run, out, ws } = fixture();
    const linkPath = out(REPORT_NAME);
    try {
      fs.symlinkSync(ws.stateDbPath, linkPath, 'file');
    } catch (error) {
      // Creating FILE symlinks needs a privilege Windows may withhold; the
      // directory-link case above covers the same realpath defence.
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        ctx.skip();
        return;
      }
      throw error;
    }
    const before = sha256File(ws.stateDbPath);
    try {
      await expectNoStagingCreated(async () => {
        await expect(run(['--out', linkPath])).rejects.toThrow(/report_out_is_symlink/);
      });
      expect(sha256File(ws.stateDbPath)).toBe(before);
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true); // the link itself is left alone too
    } finally {
      fs.rmSync(linkPath, { force: true });
    }
  });

  it('refuses a link wearing the report name itself (lstat check), whatever it points at', async () => {
    const { reportsDir, run, out } = fixture();
    // Runs on every platform: a directory link needs no privilege on Windows
    // (a FILE symlink does, see the skipped case above). The defence under
    // test is the same lstat branch either way.
    const outsideDir = makeTempDir('pd-funnel-outside-');
    const outsidePath = path.join(outsideDir, 'precious.db');
    fs.writeFileSync(outsidePath, 'PRECIOUS BYTES\n');
    const linkPath = out(REPORT_NAME);
    fs.symlinkSync(outsideDir, linkPath, 'junction');
    const before = sha256File(outsidePath);
    try {
      await expectNoStagingCreated(async () => {
        await expect(run(['--out', linkPath])).rejects.toThrow(/report_out_is_symlink/);
      });
      expect(sha256File(outsidePath)).toBe(before);
      expect(fs.readdirSync(outsideDir)).toEqual(['precious.db']); // no report appeared behind the link
    } finally {
      fs.rmSync(linkPath, { force: true, recursive: true }); // removes the link only, never its target
    }
  });

  it('refuses a hard-linked report target and never overwrites the outside file', async (ctx) => {
    const { reportsDir, run, out } = fixture();
    const outsidePath = path.join(makeTempDir('pd-funnel-outside-'), 'outside.md');
    fs.writeFileSync(outsidePath, 'OUTSIDE CONTENT — must survive\n');
    const target = out(REPORT_NAME);
    try {
      fs.linkSync(outsidePath, target);
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOTSUP') {
        ctx.skip(); // file system without hard links
        return;
      }
      throw error;
    }
    expect(fs.statSync(target).nlink).toBe(2);
    const before = sha256File(outsidePath);
    await expectNoStagingCreated(async () => {
      await expect(run(['--out', target])).rejects.toThrow(/report_out_hardlinked/);
    });
    // same inode, same bytes: the outside file was NOT overwritten
    expect(sha256File(outsidePath)).toBe(before);
    expect(sha256File(target)).toBe(before);
    // a direct write is refused as well — there is no pre-flight to hide behind
    expect(() => writeReportAtomically(target, 'x')).toThrow(/report_out_hardlinked/);
    expect(sha256File(outsidePath)).toBe(before);
    expect(fs.readdirSync(reportsDir)).toEqual([REPORT_NAME]); // no temp residue
  });

  it('refuses destinations outside the reports directory (other dir, .., sub-dir, missing parent)', async () => {
    const { run, out } = fixture();
    const elsewhere = path.join(makeTempDir('pd-funnel-elsewhere-'), REPORT_NAME);
    await expect(run(['--out', elsewhere])).rejects.toThrow(/report_out_outside_reports_dir/);
    await expect(run(['--out', out('..', REPORT_NAME)])).rejects.toThrow(/report_out_outside_reports_dir/);
    await expect(run(['--out', out('missing', REPORT_NAME)])).rejects.toThrow(/report_out_parent_missing/);
    fs.mkdirSync(out('sub'));
    await expect(run(['--out', out('sub', REPORT_NAME)])).rejects.toThrow(/report_out_outside_reports_dir/);
  });

  it('refuses names that are not the strict report name, and non-regular files', async () => {
    const { run, out } = fixture();
    await expect(run(['--out', out('notes.md')])).rejects.toThrow(/report_out_invalid_filename/);
    await expect(run(['--out', out('PD_PIPELINE_FUNNEL_BASELINE_20261124.txt')])).rejects.toThrow(/report_out_invalid_filename/);
    await expect(run(['--out', out('PD_PIPELINE_FUNNEL_BASELINE_2026112.md')])).rejects.toThrow(/report_out_invalid_filename/);
    fs.mkdirSync(out(REPORT_NAME)); // a directory wearing the report's name
    await expect(run(['--out', out(REPORT_NAME)])).rejects.toThrow(/report_out_not_regular_file/);
    expect(fs.statSync(out(REPORT_NAME)).isDirectory()).toBe(true); // left as found
  });

  it('refuses destinations inside the measured workspace and inside installer-owned roots', async () => {
    const { run, ws, out } = fixture();
    await expect(run(['--out', path.join(ws.workspace, REPORT_NAME)])).rejects.toThrow(/report_out_in_measured_workspace/);
    // a synthetic installer-owned root — the real ~/.pd is never touched by a test
    const fakeInstallRoot = makeTempDir('pd-funnel-install-');
    await expect(
      main(['--workspace', ws.workspace, '--out', path.join(fakeInstallRoot, REPORT_NAME)], { protectedRoots: [fakeInstallRoot] }),
    ).rejects.toThrow(/report_out_in_install_dir/);
    // …and even when the reports directory itself sits inside that root, the
    // installer-owned check wins
    await expect(
      main(['--workspace', ws.workspace, '--out', path.join(fakeInstallRoot, REPORT_NAME)], { reportsDir: fakeInstallRoot, protectedRoots: [fakeInstallRoot] }),
    ).rejects.toThrow(/report_out_in_install_dir/);
    expect(fs.readdirSync(fakeInstallRoot)).toEqual([]);
    expect(fs.existsSync(out(REPORT_NAME))).toBe(false);
  });

  it('replaces an existing valid report by inode (atomic swap, no temp residue)', async () => {
    const { reportsDir, run, out } = fixture();
    const target = out(REPORT_NAME);
    // The existing report is produced by the script itself (first run); the
    // second run replaces it. Both inspections open a DESCRIPTOR and read
    // through it — the name is swapped on purpose between the two runs.
    await run(['--out', target]);
    const inodeBefore = inodeOfReport(target);
    expect(fs.readdirSync(reportsDir)).toEqual([REPORT_NAME]);

    await run(['--out', target]);

    const inspection = inspectReport(target);
    expect(inspection.content).toContain('# PD Pipeline Funnel Baseline');
    // a NEW inode now carries the name — the old one was never truncated in place
    expect(inspection.inode).not.toBe(inodeBefore);
    expect(fs.readdirSync(reportsDir)).toEqual([REPORT_NAME]);
  });

  it('leaves no temp file behind when the swap itself is refused', (ctx) => {
    const reportsDir = makeTempDir('pd-funnel-swap-');
    const outsidePath = path.join(makeTempDir('pd-funnel-outside-'), 'outside.md');
    fs.writeFileSync(outsidePath, 'OUTSIDE CONTENT — must survive\n');
    const target = path.join(reportsDir, REPORT_NAME);
    try {
      fs.linkSync(outsidePath, target);
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOTSUP') {
        ctx.skip();
        return;
      }
      throw error;
    }
    const before = sha256File(outsidePath);
    expect(() => writeReportAtomically(target, 'NEW REPORT\n')).toThrow(/report_out_hardlinked/);
    expect(sha256File(outsidePath)).toBe(before);
    expect(fs.readdirSync(reportsDir)).toEqual([REPORT_NAME]);
  });
});

describe('resolveReportTarget (pure checks)', () => {
  it('resolves the default path and an explicit report path inside the reports directory', () => {
    const reportsDir = makeTempDir('pd-funnel-pure-');
    const ws = seedWorkspace();
    const call = (outArg) => resolveReportTarget({
      outArg,
      runDate: '20261124',
      reportsDir,
      workspaceDir: ws.workspace,
      protectedRoots: [],
    });
    expect(call(null)).toEqual({ ok: true, outPath: path.join(reportsDir, REPORT_NAME) });
    expect(call(path.join(reportsDir, 'PD_PIPELINE_FUNNEL_BASELINE_20261123.md'))).toEqual({
      ok: true,
      outPath: path.join(reportsDir, 'PD_PIPELINE_FUNNEL_BASELINE_20261123.md'),
    });
    // a relative --out is resolved against the working directory, then judged
    const previousCwd = process.cwd();
    try {
      process.chdir(reportsDir);
      expect(call(REPORT_NAME).outPath).toBe(path.join(reportsDir, REPORT_NAME));
      expect(() => call('notes.md')).toThrow(/report_out_invalid_filename/);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

// ── Snapshot ownership (review round 2, P2-2) ────────────────────────────────

describe('snapshotPair ownership', () => {
  /** The REAL stageWalSnapshot, recording every staging root it creates so a
   * test can prove each one was removed. */
  function realStageRecording(roots) {
    return (dbPath, relSegments) => {
      const result = painRecall.stageWalSnapshot(dbPath, relSegments);
      if (result.ok) roots.push(result.root);
      return result;
    };
  }

  it('disposes the first database when the second one fails every attempt', () => {
    const ws = seedWorkspace();
    const roots = [];
    let trajectoryAttempts = 0;
    const stage = (dbPath, relSegments) => {
      if (dbPath.endsWith('missing.db')) trajectoryAttempts += 1;
      return realStageRecording(roots)(dbPath, relSegments);
    };
    expect(() => snapshotPair(ws.stateDbPath, path.join(ws.workspace, '.state', 'missing.db'), { stage }))
      .toThrow(/wal_snapshot_failed: trajectory\.db .*main_missing_or_unreadable/);
    expect(trajectoryAttempts).toBe(SNAPSHOT_MAX_ATTEMPTS);
    expect(roots).toHaveLength(1); // state.db was staged once …
    expect(fs.existsSync(roots[0])).toBe(false); // … and is gone again
    expect(stagingRootsCreatedByThisTest()).toEqual([]);
  });

  it('disposes every staged copy when the skew re-snapshot fails', () => {
    const ws = seedWorkspace();
    const roots = [];
    const calls = [];
    const stage = (dbPath, relSegments) => {
      calls.push(path.basename(dbPath));
      // The re-take of state.db (any state.db call after the first) fails
      // WITHOUT creating a copy — as the real primitive does, a failed
      // attempt cleans up after itself and reports `ok: false`.
      if (calls.filter((name) => name === 'state.db').length > 1) {
        return { ok: false, reason: 't1_main_drift' };
      }
      const result = realStageRecording(roots)(dbPath, relSegments);
      // Make trajectory.db look 60 s LATER than state.db, so state.db is the
      // earlier one that must be re-taken.
      if (path.basename(dbPath) === 'trajectory.db' && result.ok) {
        return { ...result, capturedAt: new Date(Date.parse(result.capturedAt) + 60_000).toISOString() };
      }
      return result;
    };
    expect(() => snapshotPair(ws.stateDbPath, ws.trajectoryDbPath, { stage })).toThrow(/wal_snapshot_failed: state\.db .*t1_main_drift/);
    expect(calls).toEqual(['state.db', 'trajectory.db', 'state.db', 'state.db', 'state.db']);
    expect(roots).toHaveLength(2); // state.db + trajectory.db, both really staged
    for (const root of roots) expect(fs.existsSync(root)).toBe(false);
    expect(stagingRootsCreatedByThisTest()).toEqual([]);
  });

  it('disposes only the replaced copy when the skew re-snapshot succeeds, and hands the rest to the caller', () => {
    const ws = seedWorkspace();
    const roots = [];
    let shifted = false;
    const stage = (dbPath, relSegments) => {
      const result = realStageRecording(roots)(dbPath, relSegments);
      if (path.basename(dbPath) === 'trajectory.db' && result.ok && !shifted) {
        shifted = true;
        return { ...result, capturedAt: new Date(Date.parse(result.capturedAt) + 60_000).toISOString() };
      }
      return result;
    };
    const pair = snapshotPair(ws.stateDbPath, ws.trajectoryDbPath, { stage });
    expect(pair.skewRetried).toBe(true);
    expect(pair.skewExceededMs).toBeGreaterThan(SNAPSHOT_SKEW_MAX_MS);
    expect(roots).toHaveLength(3);
    const [replacedState, trajectory, replacementState] = roots;
    expect(fs.existsSync(replacedState)).toBe(false); // the superseded copy is gone …
    expect(fs.existsSync(trajectory)).toBe(true); // … the pair owns the other two
    expect(fs.existsSync(replacementState)).toBe(true);
    pair.state.staged.dispose();
    pair.trajectory.staged.dispose();
    expect(stagingRootsCreatedByThisTest()).toEqual([]);
  });

  it('disposes the first copy when acquiring the second throws', () => {
    const ws = seedWorkspace();
    const roots = [];
    const stage = (dbPath, relSegments) => {
      if (path.basename(dbPath) === 'trajectory.db') throw new Error('mkdtemp failed (simulated)');
      return realStageRecording(roots)(dbPath, relSegments);
    };
    expect(() => snapshotPair(ws.stateDbPath, ws.trajectoryDbPath, { stage })).toThrow(/mkdtemp failed \(simulated\)/);
    expect(roots).toHaveLength(1);
    expect(fs.existsSync(roots[0])).toBe(false);
    expect(stagingRootsCreatedByThisTest()).toEqual([]);
  });

  it('repeated dispose calls are safe (idempotent)', () => {
    const ws = seedWorkspace();
    const staged = painRecall.stageWalSnapshot(ws.stateDbPath, ['funnel', 'state.db']);
    expect(staged.ok).toBe(true);
    const root = staged.root;
    expect(fs.existsSync(root)).toBe(true);
    staged.dispose();
    expect(fs.existsSync(root)).toBe(false);
    expect(() => {
      staged.dispose();
      staged.dispose();
    }).not.toThrow();
    expect(stagingRootsCreatedByThisTest()).toEqual([]);
  });

  it('a successful main() run leaves no staging root behind either', async () => {
    const ws = seedWorkspace();
    const reportsDir = makeTempDir('pd-funnel-reports-');
    await main(['--workspace', ws.workspace], { reportsDir });
    expect(stagingRootsCreatedByThisTest()).toEqual([]);
  });
});

// ── main (synthetic workspace) ───────────────────────────────────────────────

describe('main (synthetic workspace)', () => {
  it('produces a report from WAL databases at the canonical paths without touching the source', async () => {
    const ws = seedWorkspace({ leaveWalOpen: true });
    const reportsDir = makeTempDir('pd-funnel-reports-');
    const outPath = path.join(reportsDir, REPORT_NAME);
    try {
      const before = {
        pdTree: captureTreeState(path.join(ws.workspace, '.pd')),
        stateTree: captureTreeState(path.join(ws.workspace, '.state')),
      };
      const model = await main(['--workspace', ws.workspace, '--out', outPath], { reportsDir });

      const report = fs.readFileSync(outPath, 'utf-8');
      // required report sections (SPEC Phase 0 deliverable list)
      for (const marker of [
        '## 1. 数据来源与快照方式',
        '## 2. 快照时间（T1 线性化点）与文件指纹',
        '## 3. 快照偏差窗口',
        '## 4. 跨库写入允许延迟假设',
        '## 5. 全量漏斗',
        '## 6. 近 30 天漏斗',
        '## 8. 转化率',
        '## 9. 失败与拒绝原因分布（按阶段分开）',
        '## 10. 关联缺失记录',
        '## 11. skew_window_candidate 总数（跨库）',
        '## 13. 对 D1/D2/D4 与架构收敛工作的影响判断',
      ]) {
        expect(report).toContain(marker);
      }
      // T1s recorded for both databases
      expect(report).toContain(model.meta.stateT1);
      expect(report).toContain(model.meta.trajectoryT1);
      // the un-checkpointed WAL-only commit IS counted (wal replay worked)
      expect(model.trajectory.pain.total).toBe(2);
      expect(model.trajectory.pain.withCanonicalId).toBe(2);
      // skew within the suggested window on a quiet synthetic workspace
      expect(model.meta.skewMs).toBeLessThanOrEqual(SNAPSHOT_SKEW_MAX_MS);

      // the source trees are byte-identical: nothing new appeared (the
      // fixture writer's own -wal/-shm predate `before`) and no existing
      // file changed — that subsumes "the snapshot created no -shm".
      expect(captureTreeState(path.join(ws.workspace, '.pd'))).toEqual(before.pdTree);
      expect(captureTreeState(path.join(ws.workspace, '.state'))).toEqual(before.stateTree);
      // funnel content sanity on the fixture
      expect(model.state.candidates.total).toBe(1);
      expect(model.state.candidates.byRawKind.principle).toBe(1);
      expect(model.state.candidates.admission.decisions.admitted).toBe(1);
      expect(model.state.internalization.peerTasksByKind.dreamer.total).toBe(1);
      expect(model.state.activation.targets.uuidShaped).toBe(1);
      expect(model.state.application.byKind.prompt_injected).toBe(1);
      expect(model.trajectory.interception.gateBlocks.total).toBe(1);
      // linkage: the fixture pain references an existing task — no missing refs
      expect(model.linkage.painToTask.missingTaskRefs).toBe(0);
      expect(model.linkage.taskToPain.linkedPainFound).toBe(1);
      expect(model.linkage.candidateToDreamer.consumedWithoutDreamerTask).toBe(0);
      expect(model.skewSummary.crossDbSkewWindowCandidates).toBe(0);
      // no staged copy survives the run
      expect(stagingRootsCreatedByThisTest()).toEqual([]);
    } finally {
      ws.close();
    }
  });

  it('emits exactly one JSON object with --json (meta, skew summary and the full model)', async () => {
    const ws = seedWorkspace();
    const reportsDir = makeTempDir('pd-funnel-json-');
    const outPath = path.join(reportsDir, REPORT_NAME);
    const originalWrite = process.stdout.write.bind(process.stdout);
    const chunks = [];
    process.stdout.write = (chunk) => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await main(['--workspace', ws.workspace, '--out', outPath, '--json'], { reportsDir });
    } finally {
      process.stdout.write = originalWrite;
    }
    const stdout = chunks.join('');
    expect(stdout.trim().split('\n')).toHaveLength(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.out).toBe(outPath);
    expect(parsed.meta.stateT1).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // the full model travels with --json so the report can be recomputed
    // independently from the recorded numbers
    expect(parsed.skewSummary.crossDbSkewWindowCandidates).toBe(0);
    expect(parsed.model.linkage.candidateToDreamer).not.toHaveProperty('buckets');
    expect(parsed.model.state.diagnosis.diagnosticianRunFailuresByErrorCategory).toEqual({});
    // quiet-sidecar workspace (handles closed): the funnel run must not
    // create a -shm beside either source database
    for (const tree of ['.pd', '.state']) {
      const files = fs.readdirSync(path.join(ws.workspace, tree));
      expect(files.some((f) => f.endsWith('-shm'))).toBe(false);
    }
  });

  it('fails loud when a canonical database is missing (no report fabricated)', async () => {
    const workspace = makeTempDir('pd-funnel-empty-');
    fs.mkdirSync(path.join(workspace, '.pd'), { recursive: true });
    await expect(main(['--workspace', workspace])).rejects.toThrow(/database_missing: state\.db/);
  });
});

// ── Skew accounting / same-database relation (review round 2, P2-1) ──────────

describe('skew accounting', () => {
  it('sums ONLY the two cross-database relations into the skew total', () => {
    const linkage = {
      painToTask: { buckets: { skew_window_candidate: 4 } },
      taskToPain: { buckets: { skew_window_candidate: 25 } },
      // a same-database relation — even one that (legacy shape) carries a bucket
      candidateToDreamer: { consumedWithoutDreamerTask: 44, buckets: { skew_window_candidate: 44 } },
    };
    const summary = summarizeLinkage(linkage);
    expect(summary.crossDbSkewWindowCandidates).toBe(29); // NOT 73
    expect(summary.crossDbByRelation).toEqual({ painToTask: 4, taskToPain: 25 });
    expect(summary.sameDbConsumedWithoutDreamer).toBe(44);
  });

  it('reports 0 for a relation with no miss and NA (null) when a relation could not be measured', () => {
    const clean = { buckets: { skew_window_candidate: 0 } };
    expect(summarizeLinkage({ painToTask: clean, taskToPain: clean }).crossDbSkewWindowCandidates).toBe(0);
    expect(summarizeLinkage({ painToTask: null, taskToPain: clean }).crossDbSkewWindowCandidates).toBeNull();
  });

  it('classifies a consumed candidate without a Dreamer by raw kind, ledger evidence and admission state', () => {
    const c = NO_DREAMER_CLASSIFICATION;
    expect(classifyConsumedWithoutDreamer({ rawKind: 'implementation', hasReuseEvidence: false })).toBe(c.LEGAL_NO_SEED_ROUTE);
    expect(classifyConsumedWithoutDreamer({ rawKind: 'defer', hasReuseEvidence: false })).toBe(c.LEGAL_NO_SEED_ROUTE);
    expect(classifyConsumedWithoutDreamer({ rawKind: 'wizardry', hasReuseEvidence: false })).toBe(c.INVALID_RAW_KIND);
    expect(classifyConsumedWithoutDreamer({ rawKind: null, hasReuseEvidence: false })).toBe(c.INVALID_RAW_KIND);
    expect(classifyConsumedWithoutDreamer({ rawKind: 'principle', hasReuseEvidence: true })).toBe(c.LEGAL_REUSE_RESOLVED);
    expect(classifyConsumedWithoutDreamer({ rawKind: 'prompt', hasReuseEvidence: true })).toBe(c.LEGAL_REUSE_RESOLVED);
    // A saved Owner park with no typed decision remains actionable.
    expect(classifyConsumedWithoutDreamer({ rawKind: 'principle', hasReuseEvidence: false, admissionProcessingState: 'awaiting_owner' })).toBe(c.AWAITING_OWNER);
    expect(classifyConsumedWithoutDreamer({ rawKind: 'rule', hasReuseEvidence: false, admissionProcessingState: 'awaiting_owner' })).toBe(c.AWAITING_OWNER);
    // Typed Owner history is pending only while executionStatus is pending.
    expect(classifyConsumedWithoutDreamer({ rawKind: 'principle', admissionPendingOwnerDecision: true, admissionOwnerDecisionCount: 1 })).toBe(c.AWAITING_OWNER);
    expect(classifyConsumedWithoutDreamer({ rawKind: 'principle', admissionProcessingState: 'awaiting_owner', admissionProcessingBlockedReason: 'candidate_kind_invalid', admissionOwnerDecisionCount: 0 })).toBe(c.UNEXPLAINED);
    expect(classifyConsumedWithoutDreamer({ rawKind: 'principle', admissionProcessingState: 'awaiting_owner', admissionOwnerDecisionCount: 1 })).toBe(c.UNEXPLAINED);
    // every other state (complete, exhausted, no document, …) is unexplained
    for (const state of ['complete', 'exhausted', 'not_started', 'in_progress', null, undefined]) {
      expect(classifyConsumedWithoutDreamer({ rawKind: 'principle', hasReuseEvidence: false, admissionProcessingState: state }), String(state)).toBe(c.UNEXPLAINED);
    }
    expect(classifyConsumedWithoutDreamer({ rawKind: 'rule', hasReuseEvidence: false })).toBe(c.UNEXPLAINED);
    expect(classifyConsumedWithoutDreamer({ rawKind: 'prompt', hasReuseEvidence: false })).toBe(c.UNEXPLAINED);
    // an invalid kind stays invalid even if the ledger or the admission record reference it
    expect(classifyConsumedWithoutDreamer({ rawKind: 'wizardry', hasReuseEvidence: true })).toBe(c.INVALID_RAW_KIND);
    expect(classifyConsumedWithoutDreamer({ rawKind: 'wizardry', admissionProcessingState: 'awaiting_owner' })).toBe(c.INVALID_RAW_KIND);
  });
});

// ── Failure classification by stage (review round 2, P2-3) ───────────────────

describe('failure classification by stage', () => {
  it('keeps internalization (and other-stage) failures out of the diagnostic failure ranking', async () => {
    const ws = seedWorkspace();
    withState(ws, (db) => {
      insertTask(db, 'diag-failed', 'diagnostician', 'failed', SEED_AT);
      insertFailedRun(db, 'run-diag', 'diag-failed', 'timeout', SEED_AT);
      insertTask(db, 'artificer-failed', 'artificer', 'failed', SEED_AT);
      insertFailedRun(db, 'run-art', 'artificer-failed', 'output_invalid', SEED_AT);
      insertTask(db, 'dreamer-failed', 'dreamer', 'failed', SEED_AT);
      insertFailedRun(db, 'run-dreamer', 'dreamer-failed', 'budget_exceeded', SEED_AT);
      // a task kind outside both groups: only the whole-pipeline ranking may carry it
      insertTask(db, 'maint-failed', 'maintenance', 'failed', SEED_AT);
      insertFailedRun(db, 'run-maint', 'maint-failed', 'other', SEED_AT);
    });
    const reportsDir = makeTempDir('pd-funnel-reports-');
    const outPath = path.join(reportsDir, REPORT_NAME);
    const model = await main(['--workspace', ws.workspace, '--out', outPath], { reportsDir });

    expect(model.state.diagnosis.diagnosticianRunFailuresByErrorCategory).toEqual({ timeout: 1 });
    expect(model.state.internalization.peerRunFailuresByErrorCategory).toEqual({ budget_exceeded: 1, output_invalid: 1 });
    expect(model.state.failures.allPipelineRunFailuresByErrorCategory).toEqual({ budget_exceeded: 1, other: 1, output_invalid: 1, timeout: 1 });

    const report = fs.readFileSync(outPath, 'utf-8');
    const diagnosticLine = report.split('\n').find((line) => line.startsWith('- 诊断运行失败 error_category'));
    const internalizationLine = report.split('\n').find((line) => line.startsWith('- 内化运行失败 error_category'));
    const pipelineLine = report.split('\n').find((line) => line.startsWith('- 全管道运行失败 error_category'));
    expect(diagnosticLine).toMatch(/仅 Diagnostician 任务：/);
    expect(diagnosticLine).toMatch(/：timeout: 1$/);
    for (const foreign of ['output_invalid', 'budget_exceeded', 'other']) {
      expect(diagnosticLine).not.toContain(foreign);
    }
    expect(internalizationLine).toContain('output_invalid: 1');
    expect(internalizationLine).toContain('budget_exceeded: 1');
    expect(internalizationLine).not.toContain('timeout');
    expect(pipelineLine).toContain('output_invalid');
    expect(pipelineLine).toContain('timeout');
    expect(pipelineLine).toContain('other');
  });
});

// ── Same-database candidate→Dreamer relation at the script level ─────────────

describe('same-database candidate→Dreamer relation (script level)', () => {
  it('is reported apart from the cross-database skew total and classified by raw kind', async () => {
    const ws = seedWorkspace();
    withState(ws, (db) => {
      insertCandidate(db, 'c-impl', 'implementation', 'consumed', SEED_AT); // legal: no seed route
      insertCandidate(db, 'c-principle-gap', 'principle', 'consumed', SEED_AT); // no rule explains it → investigate
      insertCandidate(db, 'c-defer', 'defer', 'consumed', SEED_AT); // legal: deferred route
      // admitted, parked for an Owner decision, never intaken: no seed is correct
      insertCandidate(db, 'c-principle-parked', 'principle', 'consumed', SEED_AT, JSON.stringify({
        evaluations: [{ evaluationId: 'e-parked', decision: 'admitted', reason: 'evidence_sufficient' }],
        currentEvaluationId: 'e-parked',
        processing: { state: 'awaiting_owner', attempts: 1 },
      }));
    });
    const traj = new Database(ws.trajectoryDbPath);
    try {
      // one genuine cross-database miss: a pain row referencing a task that state.db does not have
      traj.prepare(`INSERT INTO pain_events (session_id, source, score, runtime_task_id, host_kind, created_at)
        VALUES ('s-miss', 'manual', 0.5, 'task-that-is-not-in-state', 'codex', ?)`).run(SEED_AT);
    } finally {
      traj.close();
    }
    const reportsDir = makeTempDir('pd-funnel-reports-');
    const outPath = path.join(reportsDir, REPORT_NAME);
    const model = await main(['--workspace', ws.workspace, '--out', outPath], { reportsDir });

    const c2d = model.linkage.candidateToDreamer;
    expect(c2d.crossDatabase).toBe(false);
    expect(c2d.consumedCandidates).toBe(5); // the fixture candidate + the four above
    expect(c2d.consumedWithoutDreamerTask).toBe(4);
    expect(c2d.byRawKind).toEqual({ defer: 1, implementation: 1, principle: 2 });
    expect(c2d.classification).toEqual({
      legal_no_seed_route: 2,
      awaiting_owner_decision: 1,
      unexplained_requires_investigation: 1,
    });
    expect(c2d.samples.map((s) => [s.candidateId, s.classification])).toEqual([
      ['c-defer', 'legal_no_seed_route'],
      ['c-impl', 'legal_no_seed_route'],
      ['c-principle-gap', 'unexplained_requires_investigation'],
      ['c-principle-parked', 'awaiting_owner_decision'],
    ]);

    // cross-database skew = the pain→task miss ONLY (the 29-not-73 rule)
    expect(model.linkage.painToTask.missingTaskRefs).toBe(1);
    expect(model.linkage.painToTask.samples.map((s) => s.runtimeTaskId)).toEqual(['task-that-is-not-in-state']);
    expect(model.skewSummary).toEqual({
      crossDbSkewWindowCandidates: 1,
      crossDbByRelation: { painToTask: 1, taskToPain: 0 },
      sameDbConsumedWithoutDreamer: 4,
    });

    const report = fs.readFileSync(outPath, 'utf-8');
    expect(report).toContain('## 11. skew_window_candidate 总数（跨库）：**1**');
    // every sample stays traceable under the list that matches its outcome
    expect(report).toMatch(/需调查样本[^\n]*\n\s+- `c-principle-gap` · principle ·/);
    expect(report).toMatch(/等待 Owner 决策的候选[^\n]*\n\s+- `c-principle-parked` · principle · [^\n]* · admitted · awaiting_owner/);
    // legal outcomes are counted, not listed as needing action
    expect(report).not.toContain('`c-impl` · implementation ·');
    expect(report).not.toContain('`c-defer` · defer ·');
  });
});

// ── Recent window (review round 2, P2-4) ─────────────────────────────────────

describe('recent window', () => {
  /** The base fixture (all rows one day old = inside the window) plus one
   * in-window and one out-of-window row for every stage. */
  function seedWindowedWorkspace() {
    const ws = seedWorkspace();
    const inside = daysAgoIso(1);
    const outside = daysAgoIso(OUTSIDE_WINDOW_DAYS);
    withState(ws, (db) => {
      for (const kind of ['philosopher', 'scribe', 'artificer', 'evaluator', 'rollout_reviewer']) {
        insertTask(db, `in-${kind}`, kind, kind === 'artificer' ? 'failed' : 'completed', inside);
        insertTask(db, `out-${kind}`, kind, 'completed', outside);
      }
      insertTask(db, 'in-diagnostician', 'diagnostician', 'completed', inside);
      insertTask(db, 'in-dreamer', 'dreamer', 'completed', inside);
      insertTask(db, 'out-diagnostician', 'diagnostician', 'completed', outside);
      insertTask(db, 'out-dreamer', 'dreamer', 'completed', outside);
      for (const kind of ['diag_rootcause', 'diag_distiller', 'diag_router']) {
        insertTask(db, `in-${kind}`, kind, 'completed', inside);
        insertTask(db, `out-${kind}`, kind, 'completed', outside);
      }
      const approval = db.prepare(`INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, requested_at)
        VALUES (?, 'a', 'prompt', 'low', ?, ?)`);
      approval.run('appr-in', 'pending', inside);
      approval.run('appr-out', 'approved', outside);
      // an epoch-millisecond timestamp: SQLite's datetime() cannot read it, so
      // it must be FLAGGED — never silently dropped from the window
      approval.run('appr-unparseable', 'pending', String(Date.now()));
      const activation = db.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
        VALUES (?, ?, 'a', 'prompt', 'activate', ?, ?)`);
      activation.run('act-in', 'ik-in', 'p-1', inside);
      activation.run('act-out', 'ik-out', 'p-2', outside);
      // candidates: a legal no-seed route, one explicit pending Owner intent,
      // one applied + superseded history, one invalid-kind blocker (not an
      // Owner decision), one exhausted admission, and one out of window.
      insertCandidate(db, 'c-impl', 'implementation', 'consumed', inside);
      insertCandidate(db, 'c-prompt-owner', 'prompt', 'pending', inside, JSON.stringify({
        evaluations: [],
        currentEvaluationId: null,
        processing: { state: 'awaiting_owner', blockedReason: 'reuse_pending_owner' },
        ownerDecisions: [{
          decisionId: 'decision-pending',
          candidateId: 'c-prompt-owner',
          decision: 'create',
          ownerId: 'owner-test',
          identitySource: 'test',
          reason: 'pending lifecycle fixture',
          decidedAt: inside,
          executionStatus: 'pending',
          policyVersion: 'owner-decision@1',
        }],
      }));
      insertCandidate(db, 'c-prompt-awaiting', 'prompt', 'pending', inside, JSON.stringify({
        evaluations: [],
        currentEvaluationId: null,
        processing: { state: 'awaiting_owner', blockedReason: 'needs_evidence:evidence_array_empty' },
        ownerDecisions: [],
      }));
      insertCandidate(db, 'c-prompt-applied', 'prompt', 'pending', inside, JSON.stringify({
        evaluations: [],
        currentEvaluationId: null,
        processing: { state: 'complete' },
        ownerDecisions: [
          {
            decisionId: 'decision-superseded',
            candidateId: 'c-prompt-applied',
            decision: 'create',
            ownerId: 'owner-test',
            identitySource: 'test',
            reason: 'superseded lifecycle fixture',
            decidedAt: inside,
            executionStatus: 'superseded',
            policyVersion: 'owner-decision@1',
          },
          {
            decisionId: 'decision-applied',
            candidateId: 'c-prompt-applied',
            decision: 'create',
            ownerId: 'owner-test',
            identitySource: 'test',
            reason: 'applied lifecycle fixture',
            decidedAt: inside,
            executionStatus: 'applied',
            policyVersion: 'owner-decision@1',
            executedAt: inside,
            resultingPrincipleId: 'principle-fixture',
          },
        ],
      }));
      insertCandidate(db, 'c-invalid-kind-awaiting', 'wizardry', 'pending', inside, JSON.stringify({
        evaluations: [],
        currentEvaluationId: null,
        processing: { state: 'awaiting_owner', blockedReason: 'candidate_kind_invalid' },
        ownerDecisions: [],
      }));
      insertCandidate(db, 'c-exhausted', 'principle', 'pending', inside, JSON.stringify({
        evaluations: [],
        currentEvaluationId: null,
        processing: { state: 'exhausted' },
      }));
      insertCandidate(db, 'c-out', 'principle', 'pending', outside);
    });
    const traj = new Database(ws.trajectoryDbPath);
    try {
      const pain = traj.prepare(`INSERT INTO pain_events (session_id, source, score, host_kind, created_at) VALUES (?, 'manual', 0.5, 'codex', ?)`);
      pain.run('s-in', inside);
      pain.run('s-out', outside);
    } finally {
      traj.close();
    }
    return ws;
  }

  it('reports every stage on one explicit window, using each stage own real time column', async () => {
    const ws = seedWindowedWorkspace();
    const reportsDir = makeTempDir('pd-funnel-reports-');
    const outPath = path.join(reportsDir, REPORT_NAME);
    const model = await main(['--workspace', ws.workspace], { reportsDir });

    const stages = model.window.stages;
    // counts are window-only: the out-of-window rows never leak in
    expect(stages.pain).toMatchObject({ table: 'trajectory.pain_events', column: 'created_at', count: 2, unparseableTimestamps: 0 });
    expect(stages.diagnostician).toMatchObject({ table: 'state.tasks', column: 'created_at', count: 5 });
    expect(stages.dreamer).toMatchObject({ column: 'created_at', count: 2 });
    for (const kind of ['philosopher', 'scribe', 'artificer', 'evaluator', 'rollout_reviewer']) {
      expect(stages[kind], kind).toMatchObject({ column: 'created_at', count: 1 });
    }
    expect(stages.approvals).toMatchObject({ table: 'state.approvals', column: 'requested_at', count: 1, unparseableTimestamps: 1 });
    expect(stages.activations).toMatchObject({ table: 'state.activations', column: 'activated_at', count: 2, unparseableTimestamps: 0 });
    // all-history numbers are reported separately and are NOT reused for the window
    expect(model.state.candidates.total).toBe(8);
    expect(model.state.candidates.windowed).toBe(7);

    // windowed outcomes stay distinct: failure / awaiting Owner / exhausted / legal no-seed
    expect(model.window.taskStatusByKind.artificer).toEqual({ failed: 1 });
    expect(model.window.taskStatusByKind.diag_rootcause).toEqual({ completed: 1 });
    expect(model.window.taskStatusByKind.diag_distiller).toEqual({ completed: 1 });
    expect(model.window.taskStatusByKind.diag_router).toEqual({ completed: 1 });
    expect(model.window.approvalsByStatus).toEqual({ pending: 1 });
    expect(model.window.activationsByAction).toEqual({ activate: 2 });
    expect(model.window.candidateBreakdown).toMatchObject({
      total: 7,
      consumed: 2,
      awaitingOwner: 2,
      pendingOwnerDecisionCandidates: 1,
      exhausted: 1,
      ownerDecisionRecordsByStatus: { pending: 1, applied: 1, superseded: 1 },
    });
    expect(model.window.candidateBreakdown.byRawKind).toEqual({ implementation: 1, principle: 2, prompt: 3, wizardry: 1 });

    const report = fs.readFileSync(path.join(reportsDir, `PD_PIPELINE_FUNNEL_BASELINE_${model.meta.runDate}.md`), 'utf-8');
    expect(report).toContain(`## 6. 近 30 天漏斗（共同窗口 [${model.window.cutoffIso}, ${model.window.windowT1Iso})）`);
    expect(report).toContain(`- 共同窗口 T1：${model.window.windowT1Iso}`);
    expect(report).toContain('| Pain | trajectory.pain_events | created_at | 2 | 0 |');
    expect(report).toContain('| Diagnostician 任务（父任务 + diag_* 子任务） | state.tasks | created_at | 5 | 0 |');
    expect(report).toContain('| Approval 请求 | state.approvals | requested_at | 1 | 1 |');
    expect(report).toContain('| Activation | state.activations | activated_at | 2 | 0 |');
    expect(report).toContain('- artificer 任务状态：failed: 1');
    expect(report).toContain('- diag_rootcause 任务状态：completed: 1');
    expect(report).toContain('- diag_distiller 任务状态：completed: 1');
    expect(report).toContain('- diag_router 任务状态：completed: 1');
    expect(report).toContain('- Approval 请求按状态（pending=等待 Owner）：pending: 1');
    expect(report).toContain('- 合法跳过（implementation/defer，本就不播种）：1');
    expect(report).toContain('等待 Owner（awaiting_owner 且 blocker 非 candidate_kind_invalid，或存在 pending 决策）：2；其中显式 pending 决策候选：1');
    expect(report).toContain('准入耗尽（processing.state=exhausted）：1');
  });

  it('stops counting an Owner decision as pending after it is applied, while retaining its audit history', async () => {
    const ws = seedWorkspace();
    const reportsDir = makeTempDir('pd-funnel-owner-lifecycle-');
    const candidateId = 'candidate-owner-lifecycle';
    const pendingDecision = {
      decisionId: 'decision-owner-lifecycle',
      candidateId,
      decision: 'create',
      ownerId: 'owner-test',
      identitySource: 'test',
      reason: 'exercise pending to applied transition',
      decidedAt: SEED_AT,
      executionStatus: 'pending',
      policyVersion: 'owner-decision@1',
    };
    const pendingDocument = {
      evaluations: [],
      currentEvaluationId: null,
      processing: { state: 'awaiting_owner', blockedReason: 'reuse_pending_owner' },
      ownerDecisions: [pendingDecision],
    };
    withState(ws, (db) => insertCandidate(db, candidateId, 'principle', 'pending', SEED_AT, JSON.stringify(pendingDocument)));

    const pendingModel = await main(['--workspace', ws.workspace], { reportsDir });
    expect(pendingModel.window.candidateBreakdown.awaitingOwner).toBe(1);
    expect(pendingModel.window.candidateBreakdown.ownerDecisionRecordsByStatus).toEqual({ pending: 1 });
    expect(pendingModel.state.candidates.admission.candidatesWithPendingOwnerDecision).toBe(1);

    const appliedDocument = {
      ...pendingDocument,
      processing: { state: 'complete' },
      ownerDecisions: [{
        ...pendingDecision,
        executionStatus: 'applied',
        executedAt: SEED_AT,
        resultingPrincipleId: 'principle-owner-lifecycle',
      }],
    };
    withState(ws, (db) => {
      db.prepare('UPDATE principle_candidates SET admission_json = ? WHERE candidate_id = ?')
        .run(JSON.stringify(appliedDocument), candidateId);
    });

    const appliedModel = await main(['--workspace', ws.workspace], { reportsDir });
    expect(appliedModel.window.candidateBreakdown.awaitingOwner).toBe(0);
    expect(appliedModel.window.candidateBreakdown.pendingOwnerDecisionCandidates).toBe(0);
    expect(appliedModel.window.candidateBreakdown.ownerDecisionRecordsByStatus).toEqual({ applied: 1 });
    expect(appliedModel.state.candidates.admission.candidatesWithOwnerDecisions).toBe(1);
    expect(appliedModel.state.candidates.admission.candidatesWithPendingOwnerDecision).toBe(0);
    expect(appliedModel.state.candidates.admission.candidatesAwaitingOwner).toBe(0);
    expect(appliedModel.state.candidates.admission.ownerDecisionRecordsByStatus).toEqual({ applied: 1 });
  });

  it('reports 0% approvals when the denominator is positive and NA only when it is zero', async () => {
    const ws = seedWorkspace();
    const reportsDir = makeTempDir('pd-funnel-zero-approval-');
    withState(ws, (db) => {
      const insert = db.prepare(`INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, requested_at)
        VALUES (?, 'artifact', 'prompt', 'low', ?, ?)`);
      insert.run('approval-pending', 'pending', SEED_AT);
      insert.run('approval-rejected', 'rejected', SEED_AT);
    });

    const firstModel = await main(['--workspace', ws.workspace], { reportsDir });
    const reportPath = path.join(reportsDir, `PD_PIPELINE_FUNNEL_BASELINE_${firstModel.meta.runDate}.md`);
    const withDenominator = fs.readFileSync(reportPath, 'utf-8');
    expect(withDenominator).toContain("| 审批通过 | approvals status='approved' | approvals 全部 | 0.000 |");

    withState(ws, (db) => db.exec('DELETE FROM approvals'));
    await main(['--workspace', ws.workspace], { reportsDir });
    const withoutDenominator = fs.readFileSync(reportPath, 'utf-8');
    expect(withoutDenominator).toContain("| 审批通过 | approvals status='approved' | approvals 全部 | NA |");
  });

  it('marks a missing table NA instead of fabricating a zero', async () => {
    const ws = seedWorkspace();
    withState(ws, (db) => db.exec('DROP TABLE approvals'));
    const reportsDir = makeTempDir('pd-funnel-reports-');
    const model = await main(['--workspace', ws.workspace], { reportsDir });

    expect(model.window.stages.approvals.count).toBeNull();
    expect(model.window.stages.approvals.unparseableTimestamps).toBeNull();
    expect(model.window.approvalsByStatus).toBeNull();
    expect(model.state.activation.approvalsByStatus).toBeNull();

    const report = fs.readFileSync(path.join(reportsDir, `PD_PIPELINE_FUNNEL_BASELINE_${model.meta.runDate}.md`), 'utf-8');
    expect(report).toContain('| Approval 请求 | state.approvals | requested_at | NA(表缺失) | NA(表缺失) |');
    expect(report).toContain('| 审批请求→激活 | Activation | Approval 请求 | NA |');
    expect(report).toMatch(/审批 approvals\s+NA\(表缺失\)/);
    expect(report).toMatch(/- Approval 请求按状态（pending=等待 Owner）：_table missing_/);
  });
});

describe('recent window boundaries', () => {
  it('uses one UTC half-open [cutoff, earliest snapshot T1) window at millisecond boundaries for every stage', async () => {
    const ws = seedWorkspace();
    const fixedT1 = '2030-02-01T00:00:00.000Z';
    const laterT1 = '2030-02-01T00:00:00.003Z';
    const fixedCutoff = '2030-01-02T00:00:00.000Z';
    const boundaryRows = [
      ['before-cutoff', '2030-01-01T23:59:59.999Z'],
      ['at-cutoff', fixedCutoff],
      ['before-t1', '2030-01-31T23:59:59.999Z'],
      ['at-t1', fixedT1],
      ['after-t1', '2030-02-01T00:00:00.001Z'],
    ];
    const taskKinds = [
      'diagnostician', 'diag_rootcause', 'diag_distiller', 'diag_router',
      'dreamer', 'philosopher', 'scribe', 'artificer', 'evaluator', 'rollout_reviewer',
    ];
    withState(ws, (db) => {
      for (const kind of taskKinds) {
        for (const [label, timestamp] of boundaryRows) {
          insertTask(db, `boundary-${kind}-${label}`, kind, 'completed', timestamp);
        }
      }
      for (const [label, timestamp] of boundaryRows) {
        insertCandidate(db, `boundary-candidate-${label}`, 'principle', 'pending', timestamp);
        db.prepare(`INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, requested_at)
          VALUES (?, 'artifact', 'prompt', 'low', 'pending', ?)`).run(`boundary-approval-${label}`, timestamp);
        db.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
          VALUES (?, ?, 'artifact', 'prompt', 'activate', ?, ?)`)
          .run(`boundary-activation-${label}`, `ik-${label}`, `target-${label}`, timestamp);
        db.prepare(`INSERT INTO pain_diagnoses (id, pain_id, task_id, diagnosis_id, category, root_cause, created_at)
          VALUES (?, ?, 'diag-parent-1', ?, 'test', 'test', ?)`)
          .run(`boundary-diagnosis-${label}`, `pain-${label}`, `diagnosis-${label}`, timestamp);
        db.prepare(`INSERT INTO principle_applications (principle_id, channel, level, kind, created_at)
          VALUES (?, 'prompt', 'presence', 'prompt_injected', ?)`)
          .run(`principle-${label}`, timestamp);
        db.prepare(`INSERT INTO gate_blocks (session_id, tool_name, reason, created_at)
          VALUES (?, 'Bash', 'test', ?)`).run(`session-${label}`, timestamp);
      }
    });
    const trajectory = new Database(ws.trajectoryDbPath);
    try {
      const insertPain = trajectory.prepare(`INSERT INTO pain_events (session_id, source, score, host_kind, created_at)
        VALUES (?, 'manual', 0.5, 'codex', ?)`);
      for (const [label, timestamp] of boundaryRows) insertPain.run(`pain-session-${label}`, timestamp);
    } finally {
      trajectory.close();
    }

    const stageSnapshot = (dbPath, relSegments) => {
      const staged = painRecall.stageWalSnapshot(dbPath, relSegments);
      if (!staged.ok) return staged;
      // The state snapshot is the earlier linearization point; all stage
      // queries must use it as their shared upper bound.
      return { ...staged, capturedAt: path.basename(dbPath) === 'state.db' ? fixedT1 : laterT1 };
    };
    const reportsDir = makeTempDir('pd-funnel-boundary-');
    const model = await main(['--workspace', ws.workspace], { reportsDir, stageSnapshot });

    expect(model.meta.windowT1).toBe(fixedT1);
    expect(model.window.windowT1Iso).toBe(fixedT1);
    expect(model.window.cutoffIso).toBe(fixedCutoff);
    expect(model.window.stages.pain.count).toBe(2);
    expect(model.window.stages.diagnostician.count).toBe(8);
    for (const kind of ['dreamer', 'philosopher', 'scribe', 'artificer', 'evaluator', 'rollout_reviewer']) {
      expect(model.window.stages[kind].count, kind).toBe(2);
    }
    expect(model.window.stages.approvals.count).toBe(2);
    expect(model.window.stages.activations.count).toBe(2);
    expect(model.window.taskStatusByKind.diag_rootcause).toEqual({ completed: 2 });
    expect(model.window.taskStatusByKind.diag_distiller).toEqual({ completed: 2 });
    expect(model.window.taskStatusByKind.diag_router).toEqual({ completed: 2 });
    expect(model.window.approvalsByStatus).toEqual({ pending: 2 });
    expect(model.window.activationsByAction).toEqual({ activate: 2 });
    expect(model.window.candidateBreakdown.total).toBe(2);
    expect(model.state.candidates.windowed).toBe(2);
    expect(model.state.diagnosis.painDiagnoses.windowed).toBe(2);
    expect(model.state.application.windowed).toBe(2);
    expect(model.trajectory.pain.windowed).toBe(2);
    expect(model.trajectory.interception.gateBlocks.windowed).toBe(2);
  });
});

describe('window constants', () => {
  it('keeps the suggested (uncalibrated) thresholds stable', () => {
    expect(SNAPSHOT_SKEW_MAX_MS).toBe(5_000);
    expect(CROSS_DB_WRITE_DELAY_MS).toBe(60_000);
  });
});
