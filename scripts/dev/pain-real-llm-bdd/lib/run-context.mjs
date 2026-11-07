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
import { fileURLToPath } from 'node:url';

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
  if (!/^[A-Za-z0-9._-]+$/.test(String(runIdArg ?? '')) && runIdArg !== null && runIdArg !== undefined) {
    throw new Error(`invalid run_id '${runIdArg}': only [A-Za-z0-9._-] are allowed`);
  }
  const runId = runIdArg ?? generateRunId();
  const runDir = path.join(resultsRoot, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const metaPath = path.join(runDir, 'run-meta.json');
  let meta;
  if (fs.existsSync(metaPath)) {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (meta.run_id !== runId) {
      throw new Error(`run-meta.json run_id mismatch: file says '${meta.run_id}', requested '${runId}'`);
    }
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
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
  return { runId, runDir, meta, metaPath, createdNew: !fs.existsSync(path.join(runDir, 'run-meta.json')) || Object.keys(meta.phases).length === 0 };
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
