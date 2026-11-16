/**
 * PD-SPEC-001 Phase 2 — isolation & integrity preflight (remediation v2).
 *
 * Fail-fast, no warn-and-continue. Checks (Owner remediation §3/§6):
 *  1. containment + child-env pointer hygiene;
 *  2. V1 arm HEAD == full 40-digit base SHA; V2 arm prompt FINGERPRINT
 *     (19-variant recompute from the arm's dist) == committed manifest — the
 *     prompt version is anchored by content, not by a head guess;
 *  3. runtime code delta between arms is EXACTLY the 7 prompt-layer files
 *     (+ tests/snapshots);
 *  4. FULL-fidelity dataset: exists, NOT git-tracked, NOT the redacted copy,
 *     16 samples, SHA-256 recorded in the local dataset manifest;
 *  5. snapshot integrity (source-vs-snapshot counts were proven in Phase 0c;
 *     here the snapshot SHA is re-verified against the recorded report);
 *  6. dist readiness both arms; model env present.
 * Any failure → non-zero exit, no task creation, no model call.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  preflightIsolation, WORKTREES, gitHead, V1_BASE_COMMIT, DATASET_FILE,
  SNAPSHOT_DIR, sha256File, sha256, EXPERIMENT_ROOT, childEnv, armWorkspaceDir,
} from './ab-lib.mjs';
import { computePromptFingerprint } from '../dump-v2-prompts.mjs';

const report = { spec: 'PD-SPEC-001', phase: '2-preflight-remediated', at: new Date().toISOString(), checks: [] };
const add = (name, ok, detail) => { report.checks.push({ name, ok, detail }); if (!ok) report.failed = true; };

// 1. Containment + env pointers.
const iso = preflightIsolation();
add('isolation-containment+env', iso.ok, iso);

// 2a. V1 arm frozen at the exact base SHA (full 40 digits).
const v1Head = gitHead(WORKTREES.v1);
add('v1-arm-frozen-base', v1Head === V1_BASE_COMMIT, { head: v1Head, expected: V1_BASE_COMMIT });

// 2b. V2 prompt FINGERPRINT: recompute 19 variants from the v2 dist and
// require an exact match with the committed V2 manifest (content-anchored
// prompt version — the V2 PROMPT commit is the one whose fingerprint the
// manifest records; a drifted dist fails here, not in the experiment).
const manifestPath = path.join(WORKTREES.v2, 'experiment/prompt-v2/prompts/prompt-hashes-v2.json');
let fingerprintOk = false;
let fingerprintDetail = null;
try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const live = await computePromptFingerprint(WORKTREES.v2);
  const expected = new Map(manifest.prompts.map((p) => [`${p.agent}.${p.variant}`, p.sha256]));
  const mismatches = live.prompts.filter((p) => expected.get(`${p.agent}.${p.variant}`) !== p.sha256);
  fingerprintOk = live.prompts.length === manifest.prompts.length && mismatches.length === 0;
  fingerprintDetail = { liveCount: live.prompts.length, manifestCount: manifest.prompts.length, mismatches: mismatches.map((m) => `${m.agent}.${m.variant}`), scribeVersion: live.scribePromptContractVersion, v2HeadRecorded: manifest.v2WorktreeHead };
} catch (e) {
  fingerprintDetail = { error: String(e?.message ?? e).slice(0, 200) };
}
add('v2-prompt-fingerprint-matches-manifest', fingerprintOk, fingerprintDetail);

// 3. Runtime delta scope between arms.
{
  const diff = execFileSync('git', ['diff', '--name-only', v1Head, 'HEAD', '--', 'packages/principles-core/src/runtime'], { cwd: WORKTREES.v2, env: childEnv() }).toString().trim().split('\n').filter(Boolean);
  const allowed = new Set([
    'packages/principles-core/src/runtime/diagnostician/rootcause-prompt-builder.ts',
    'packages/principles-core/src/runtime/diagnostician/distiller-prompt-builder.ts',
    'packages/principles-core/src/runtime/diagnostician/router-prompt-builder.ts',
    'packages/principles-core/src/runtime/internalization/dreamer-prompt-builder.ts',
    'packages/principles-core/src/runtime/internalization/philosopher-prompt-builder.ts',
    'packages/principles-core/src/runtime/internalization/scribe-prompt-builder.ts',
    'packages/principles-core/src/runtime/adapter/schema-prompt-adapter.ts',
  ]);
  const runtimeUnexpected = diff.filter((f) => !allowed.has(f) && !f.includes('__tests__') && !f.includes('__snapshots__'));
  add('arm-runtime-delta-scope', runtimeUnexpected.length === 0, { unexpected: runtimeUnexpected, changed: diff.length });
}

// 4. Full-fidelity dataset: exist, untracked, non-redacted, 16 samples, SHA pinned.
{
  const checks = {};
  checks.exists = fs.existsSync(DATASET_FILE);
  if (checks.exists) {
    const tracked = (() => {
      try { execFileSync('git', ['ls-files', '--error-unmatch', path.relative(WORKTREES.v2, DATASET_FILE)], { cwd: WORKTREES.v2, stdio: 'pipe' }); return true; } catch { return false; }
    })();
    checks.notGitTracked = !tracked;
    const raw = fs.readFileSync(DATASET_FILE, 'utf8');
    checks.notRedactedCopy = !raw.includes('«redacted');
    let dataset = null;
    try { dataset = JSON.parse(raw); checks.parses = true; } catch { checks.parses = false; }
    if (dataset) {
      checks.sampleCount16 = Array.isArray(dataset.samples) && dataset.samples.length === 16;
      checks.manifestSha = (() => {
        const mf = path.join(WORKTREES.v2, '.tmp/prompt-v2-inventory/dataset-manifest.local.json');
        if (!fs.existsSync(mf)) return 'missing-local-manifest';
        const local = JSON.parse(fs.readFileSync(mf, 'utf8'));
        return local.datasetFullSha256 === sha256File(DATASET_FILE) ? 'match' : 'mismatch';
      })();
      checks.snapshotConsistency = (() => {
        const recorded = dataset.snapshotHashes?.trajectory?.sha256;
        const actual = sha256File(path.join(SNAPSHOT_DIR, 'trajectory.db'));
        return recorded === actual ? 'match' : 'mismatch';
      })();
    }
  }
  const ok = checks.exists === true && checks.notGitTracked === true && checks.notRedactedCopy === true
    && checks.parses === true && checks.sampleCount16 === true && checks.manifestSha === 'match' && checks.snapshotConsistency === 'match';
  add('full-dataset-integrity', ok, checks);
}

// 5. Snapshot files present with recorded hashes.
{
  const state = path.join(SNAPSHOT_DIR, 'state.db');
  const traj = path.join(SNAPSHOT_DIR, 'trajectory.db');
  add('snapshots-present+hashed', fs.existsSync(state) && fs.existsSync(traj), {
    trajectorySha256: fs.existsSync(traj) ? sha256File(traj) : null,
    stateSha256: fs.existsSync(state) ? sha256File(state) : null,
  });
}

// 6. Dist readiness both arms + frozen-file proof + model env.
for (const arm of ['v1', 'v2']) {
  const cli = path.join(WORKTREES[arm], 'packages/pd-cli/dist/index.js');
  const core = path.join(WORKTREES[arm], 'packages/principles-core/dist/runtime/diagnostician/router-prompt-builder.js');
  add(`dist-ready-${arm}`, fs.existsSync(cli) && fs.existsSync(core), { cli: fs.existsSync(cli), core: fs.existsSync(core) });
}
add('model-api-key-env', process.env.AMD_RADEON_API_KEY !== undefined && process.env.AMD_RADEON_API_KEY !== '', { apiKeyEnv: 'AMD_RADEON_API_KEY', valueRecorded: false });

console.log(JSON.stringify(report, null, 2));
process.exit(report.failed ? 1 : 0);
