/**
 * PRI-1147 harness — run identity + result isolation (P1-2).
 *
 * Every full experiment uses ONE run_id across all phases; every phase writes
 * only inside `<resultsRoot>/runs/<runId>/`. Existing results are NEVER
 * silently overwritten or appended: writing to a path that already exists
 * fails loud unless the caller passes `--append` (explicit authorization,
 * e.g. resuming a partial run). Metrics only read the run directory named by
 * --run-id and cross-check that all phase summaries carry the SAME run_id.
 *
 * run-meta.json records the audit facts: run_id, git commit SHA, golden
 * dataset SHA-256, provider/model (credential NAMES only — never values),
 * per-phase start/end times and sample counts.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const PHASES = Object.freeze({
  codexChain: 'codex_chain',
  d6Pending: 'd6_pending',
  faultInjection: 'fault_injection',
  openclawHost: 'openclaw_host',
  metrics: 'metrics',
});

export function generateRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const rand = crypto.randomBytes(2).toString('hex');
  return `run-${stamp}-${rand}`;
}

export function validateRunId(runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw Object.assign(
      new Error(`invalid run_id '${String(runId)}': must match [A-Za-z0-9][A-Za-z0-9._-]* and must not start with a dot (no path escape)`),
      { code: 'invalid_run_id', nextAction: 'use a filesystem-safe run id beginning with a letter or digit' },
    );
  }
  return runId;
}

/**
 * Acquire one exclusive process lock for the entire run_id.
 *
 * Every phase (including metrics) holds this lock until process exit, so
 * --append cannot accidentally authorize two concurrent writers. A lock left
 * by a forced process termination is deliberately NOT auto-stolen: inspect
 * its pid and remove it manually only after confirming that process is gone.
 */
export function acquireRunLock({ runDir, runId, phase }) {
  validateRunId(runId);
  const lockPath = path.join(runDir, '.active-run.lock');
  const token = crypto.randomBytes(16).toString('hex');
  const lockRecord = {
    schema: 'pri-1147-run-lock/1',
    run_id: runId,
    phase,
    pid: process.pid,
    started_at: new Date().toISOString(),
    token,
  };

  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(lockRecord, null, 2));
    fs.fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve original error */ }
      fd = undefined;
      try { fs.unlinkSync(lockPath); } catch { /* preserve original error */ }
    }
    if (error?.code === 'EEXIST') {
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { /* lock may be partial/unreadable */ }
      const details = holder
        ? `phase=${holder.phase ?? 'unknown'} pid=${holder.pid ?? 'unknown'} started_at=${holder.started_at ?? 'unknown'}`
        : 'holder metadata is unreadable';
      throw Object.assign(
        new Error(`run_id '${runId}' is already active (${details})`),
        {
          code: 'run_already_active',
          nextAction: 'wait for the active phase to finish. If it was forcibly terminated, verify the recorded PID is gone before manually removing .active-run.lock; --append does not bypass this lock.',
        },
      );
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (current.token === token) fs.unlinkSync(lockPath);
    } catch {
      // Exit cleanup is best-effort; never mask the original process result.
    }
  };
  const onSignal = (signal) => {
    release();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('exit', release);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return { lockPath, release };
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function gitCommitSha(repoRoot) {
  return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

/**
 * Resolve (and create) the run directory for this phase.
 *
 * @param {object} input
 * @param {string|null} input.runIdArg  --run-id value (null → generate)
 * @param {string} input.resultsRoot    e.g. .tmp/pri-1147 (relative to cwd)
 * @param {string} input.repoRoot       worktree root (for git sha)
 * @param {string} input.datasetPath    golden dataset path (for sha256)
 * @param {object} input.phaseInfo      {phase, provider, model, apiKeyEnv}
 * @returns {{runId, runDir, meta: object, createdNew: boolean}}
 */
export function openRunContext({ runIdArg, resultsRoot, repoRoot, datasetPath, phaseInfo }) {
  const runId = runIdArg === null || runIdArg === undefined ? generateRunId() : String(runIdArg);
  validateRunId(runId);
  const runDir = path.join(resultsRoot, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const metaPath = path.join(runDir, 'run-meta.json');
  let meta;
  let createdNew;
  // Read-first (ENOENT = absent): avoids the existsSync→write check-then-act
  // race shape for the MATCH decision — the writer itself is exclusive below.
  let existingText = null;
  try {
    existingText = fs.readFileSync(metaPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existingText !== null) {
    meta = JSON.parse(existingText);
    if (meta.run_id !== runId) {
      throw new Error(`run-meta.json run_id mismatch: file says '${meta.run_id}', requested '${runId}'`);
    }
    createdNew = false;
  } else {
    meta = {
      run_id: runId,
      created_at: new Date().toISOString(),
      git_commit_sha: gitCommitSha(repoRoot),
      dataset_sha256: sha256File(datasetPath),
      provider: phaseInfo.provider,
      model: phaseInfo.model,
      api_key_env: phaseInfo.apiKeyEnv,
      phases: {},
    };
    // PRI-1150 review P2-F (CodeQL js/file-system-race high; PRI-913
    // precedent): the CREATE write is exclusive ('wx') — two concurrent
    // processes racing to open the same NEW run cannot both succeed; the
    // loser fails loud instead of silently overwriting.
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), { flag: 'wx' });
    createdNew = true;
  }
  return { runId, runDir, meta, metaPath, createdNew };
}

/**
 * Fail loud when this phase's target output already exists — P1-2: rerunning
 * into the same run directory without authorization must NOT overwrite or
 * append. `appendAuthorized` (--append) explicitly permits appending.
 */
export function assertFreshOutputs({ runDir, outputs, appendAuthorized }) {
  const existing = outputs.filter((p) => fs.existsSync(p));
  if (existing.length === 0) return;
  if (appendAuthorized) return;
  throw Object.assign(new Error(`existing results refuse to run: ${existing.join(', ')}`), {
    code: 'existing_results',
    nextAction: 'use a new --run-id for a fresh experiment, or pass --append to explicitly authorize appending to this run',
  });
}

/** Merge one phase's facts into run-meta.json (idempotent, last-writer-wins per field). */
export function recordPhase(metaPath, meta, phase, facts) {
  meta.phases[phase] = { ...(meta.phases[phase] ?? {}), ...facts, updated_at: new Date().toISOString() };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return meta;
}
