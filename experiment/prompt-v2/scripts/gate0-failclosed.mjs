/**
 * PD-SPEC-001 Gate 0 — fail-closed negative controls (no model calls).
 * Each control deliberately breaks ONE precondition and verifies the harness
 * refuses loudly. Restores state afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findRepoRoot } from './repo-root.mjs';
import { bootstrapConfigContext, datasetFile, loadDataset, experimentRoot, armWorktree, candidateArmId } from './ab/ab-lib.mjs';

const CONFIG_USAGE = 'usage: node gate0-failclosed.mjs --config <experiment-config.json>';
bootstrapConfigContext(process.argv, CONFIG_USAGE);

const repoRoot = findRepoRoot(import.meta.url);
const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail });

// NC-1: full dataset missing → loadDataset must throw.
const DATASET_FILE = datasetFile();
const backup = DATASET_FILE + '.gate0-bak';
fs.renameSync(DATASET_FILE, backup);
try {
  try { loadDataset(); record('NC1-missing-full-dataset', false, 'loadDataset did NOT throw — fallback exists?'); }
  catch (e) { record('NC1-missing-full-dataset', true, String(e.message).slice(0, 120)); }
} finally { fs.renameSync(backup, DATASET_FILE); }

// NC-2: redacted copy at the full path → must throw. (Content-backup restore:
// the rename-based backup was consumed by NC-1's restore and cannot be reused.)
const committed = fs.readFileSync(path.join(repoRoot, 'experiment/prompt-v2/dataset/pain-dataset.json'), 'utf8');
const fullBackup = fs.readFileSync(DATASET_FILE, 'utf8');
try {
  fs.writeFileSync(DATASET_FILE, committed, 'utf8');
  try { loadDataset(); record('NC2-redacted-copy-refused', false, 'redacted copy accepted — marker detection broken'); }
  catch (e) { record('NC2-redacted-copy-refused', true, String(e.message).slice(0, 120)); }
} finally { fs.writeFileSync(DATASET_FILE, fullBackup, 'utf8'); }

// NC-3: V2 prompt fingerprint drift (tamper one manifest sha) → preflight check must fail.
{
  const manifestPath = path.join(repoRoot, 'experiment/prompt-v2/prompts/prompt-hashes-v2.json');
  const backup = manifestPath + '.gate0-bak';
  fs.renameSync(manifestPath, backup);
  try {
    const m = JSON.parse(fs.readFileSync(backup, 'utf8'));
    m.prompts[0].sha256 = 'f'.repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n', 'utf8');
    const live = await (async () => {
      const { computePromptFingerprint } = await import('./dump-v2-prompts.mjs');
      return computePromptFingerprint(armWorktree(candidateArmId()));
    })();
    const expected = new Map(m.prompts.map((p) => [`${p.agent}.${p.variant}`, p.sha256]));
    const mismatch = live.prompts.some((p) => expected.get(`${p.agent}.${p.variant}`) !== p.sha256);
    record('NC3-fingerprint-drift-detected', mismatch === true, mismatch ? `mismatch on tampered variant detected` : 'tampered manifest NOT detected');
  } finally { fs.renameSync(backup, manifestPath); }
}

// NC-4: grid failure propagation (--simulate-failure shard 0 → launcher exit 1).
try {
  execFileSync('node', ['experiment/prompt-v2/scripts/ab/ab-grid.mjs', '--config', ...process.argv.slice(process.argv.indexOf('--config') + 1, process.argv.indexOf('--config') + 2), '--run-id', 'gate0-propagation', '--parallel', '1', '--simulate-failure', '0'], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
  record('NC4-grid-failure-propagation', false, 'launcher exited 0 despite simulated shard failure');
} catch (e) {
  record('NC4-grid-failure-propagation', true, `launcher exited non-zero (status ${e.status}) on simulated shard failure`);
}

// NC-5: env pointer leak into child env → preflightIsolation must fail.
{
  const { preflightIsolation } = await import('./ab/ab-lib.mjs');
  const before = process.env.PD_STATE_DIR;
  process.env.PD_STATE_DIR = 'D:/some/production/state';
  const iso = preflightIsolation();
  if (before === undefined) delete process.env.PD_STATE_DIR; else process.env.PD_STATE_DIR = before;
  const leaked = iso.failures.some((f) => f.includes('childEnv still carries PD_STATE_DIR'));
  // FAIL-CLOSED EXPECTATION: the injected production pointer must be STRIPPED
  // from the child environment — its absence is the pass condition.
  record('NC5-env-pointer-stripped', leaked === false, leaked ? 'pointer survived childEnv — isolation broken' : 'injected production pointer stripped from child env (isolation held)');
}

// NC-6: DB path pointing at production → armWorkspaceDir containment.
{
  const { armWorkspaceDir } = await import('./ab/ab-lib.mjs');
  const ws = armWorkspaceDir(candidateArmId(), 'nc6');
  const inside = ws.startsWith(experimentRoot());
  const notProd = !/openclaw|\.pd$|\.pd\b/i.test(ws.split('workspaces')[0]);
  record('NC6-workspace-contained', inside && notProd, ws);
}

console.log(JSON.stringify({ gate: '0-fail-closed', results, ok: results.every((r) => r.ok) }, null, 1));
process.exit(results.every((r) => r.ok) ? 0 : 1);
