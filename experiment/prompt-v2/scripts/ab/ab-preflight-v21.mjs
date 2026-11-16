/**
 * PD-SPEC-001 round 2 (Dreamer V2.1) — fail-fast preflight.
 *
 * Round-2 arm layout:
 *   v2c — control arm worktree pinned at 9b87e9bc4 (round-1 V2 prompts);
 *   v21 — treatment arm (this task worktree; only dreamer-prompt-builder.ts
 *         differs from v2c).
 *
 * Checks (any failure → non-zero exit, no task creation, no model call):
 *  1. isolation containment + child-env pointer hygiene;
 *  2. control arm HEAD == the Owner-referenced head 9b87e9bc4 (full 40 digits);
 *  3. treatment arm HEAD == origin PR head; treatment descends from the
 *     control head (merge-base == 9b87e9bc4);
 *  4. control-arm prompt fingerprint (19 variants recomputed from its dist)
 *     == round-1 committed manifest prompt-hashes-v2.json — the control arm
 *     really runs first-round V2 prompts;
 *  5. treatment-arm fingerprint: 17 non-dreamer variants == round-1 manifest
 *     (only-dreamer-changed proof at fingerprint level) AND 2 dreamer variants
 *     == the committed V2.1 snapshot manifest (dreamer-v2.1-fingerprints.json);
 *  6. source delta between arms is EXACTLY the dreamer prompt builder
 *     (+ tests / experiment tooling / snapshot files);
 *  7. FULL-fidelity dataset: exists, NOT git-tracked, NOT the redacted copy,
 *     16 samples, SHA pinned in the local dataset manifest;
 *  8. snapshot files present with recorded hashes;
 *  9. dist readiness both arms; zai model env present.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  WORKTREES, DATASET_FILE, SNAPSHOT_DIR, sha256File, childEnv, preflightIsolation,
} from './ab-lib.mjs';
import { computePromptFingerprint } from '../dump-v2-prompts.mjs';

const R2_CONTROL_HEAD = '9b87e9bc460894ce982cc5cfbe20089233055062';
const report = { spec: 'PD-SPEC-001-round2', phase: 'preflight', at: new Date().toISOString(), checks: [] };
const add = (name, ok, detail) => { report.checks.push({ name, ok, detail }); if (!ok) report.failed = true; };

// 1. Isolation.
add('isolation-containment+env', preflightIsolation().ok, preflightIsolation());

const git = (args, cwd) => execFileSync('git', args, { cwd, env: childEnv(), encoding: 'utf8' }).trim();

// 2/3. Arm heads.
const controlHead = git(['rev-parse', 'HEAD'], WORKTREES.v2c);
add('control-arm-frozen-at-9b87e9bc4', controlHead === R2_CONTROL_HEAD, { head: controlHead, expected: R2_CONTROL_HEAD });

const treatmentHead = git(['rev-parse', 'HEAD'], WORKTREES.v21);
git(['fetch', 'origin', 'ai/adhoc-20261115-prompt-v2-k4wz9t'], WORKTREES.v21);
const originHead = git(['rev-parse', 'FETCH_HEAD'], WORKTREES.v21);
add('treatment-arm-synced-with-remote-head', treatmentHead === originHead, { head: treatmentHead, originHead });
const mergeBase = git(['merge-base', R2_CONTROL_HEAD, treatmentHead], WORKTREES.v21);
add('treatment-descends-from-control', mergeBase === R2_CONTROL_HEAD, { mergeBase });

// 4. Control arm fingerprint == round-1 V2 manifest.
const round1ManifestPath = path.join(WORKTREES.v21, 'experiment/prompt-v2/prompts/prompt-hashes-v2.json');
const round1Manifest = JSON.parse(fs.readFileSync(round1ManifestPath, 'utf8'));
const controlFp = await computePromptFingerprint(WORKTREES.v2c);
const expected1 = new Map(round1Manifest.prompts.map((p) => [`${p.agent}.${p.variant}`, p.sha256]));
const controlMismatch = controlFp.prompts.filter((p) => expected1.get(`${p.agent}.${p.variant}`) !== p.sha256);
add('control-fingerprint-matches-round1-v2-manifest',
  controlFp.prompts.length === round1Manifest.prompts.length && controlMismatch.length === 0,
  { mismatches: controlMismatch.map((m) => `${m.agent}.${m.variant}`), count: controlFp.prompts.length });

// 5. Treatment arm fingerprint: non-dreamer == round-1, dreamer == V2.1 manifest.
const v21ManifestPath = path.join(WORKTREES.v21, 'experiment/prompt-v2/snapshots/dreamer-v2.1-fingerprints.json');
const v21Manifest = JSON.parse(fs.readFileSync(v21ManifestPath, 'utf8'));
const v21ByVariant = new Map(v21Manifest.variants.map((v) => [v.variant, v.sha256]));
const treatmentFp = await computePromptFingerprint(WORKTREES.v21);
const treatmentNonDreamerMismatch = treatmentFp.prompts
  .filter((p) => p.agent !== 'dreamer')
  .filter((p) => expected1.get(`${p.agent}.${p.variant}`) !== p.sha256);
const treatmentDreamerMismatch = treatmentFp.prompts
  .filter((p) => p.agent === 'dreamer')
  .filter((p) => {
    // fingerprint variant 'base'|'core-grounding' maps to V2.1 manifest 'plain'|'core-grounding'
    const r2Name = p.variant === 'base' ? 'plain' : p.variant;
    return v21ByVariant.get(r2Name) !== p.sha256;
  });
add('treatment-non-dreamer-fingerprints-unchanged', treatmentNonDreamerMismatch.length === 0,
  { mismatches: treatmentNonDreamerMismatch.map((m) => `${m.agent}.${m.variant}`) });
add('treatment-dreamer-fingerprints-match-v21-snapshot', treatmentDreamerMismatch.length === 0,
  { mismatches: treatmentDreamerMismatch.map((m) => `${m.agent}.${m.variant}`), manifestTemplateSha: v21Manifest.templateSnapshot.sha256 });

// 6. Source delta between arms: only the dreamer prompt builder in packages/.
const srcDiff = git(['diff', '--name-only', R2_CONTROL_HEAD, treatmentHead, '--', 'packages'], WORKTREES.v21)
  .split('\n').filter(Boolean);
const allowedSrc = new Set([
  'packages/principles-core/src/runtime/internalization/dreamer-prompt-builder.ts',
  'packages/principles-core/src/runtime/internalization/__tests__/dreamer-prompt-builder.test.ts',
  'packages/principles-core/src/runtime/internalization/__tests__/dreamer-v21-verbatim.test.ts',
  'packages/principles-core/src/runtime/internalization/__tests__/peer-prompt-builder-contract.test.ts',
  'packages/principles-core/src/runtime/__tests__/prompt-v2-markers.test.ts',
]);
const srcUnexpected = srcDiff.filter((f) => !allowedSrc.has(f) && !/(__snapshots__|changeset)/.test(f));
add('arm-src-delta-only-dreamer', srcUnexpected.length === 0, { unexpected: srcUnexpected, changed: srcDiff.length });

// 7. Full-fidelity dataset integrity (same checks as round-1 preflight).
{
  const checks = {};
  checks.exists = fs.existsSync(DATASET_FILE);
  if (checks.exists) {
    const tracked = (() => { try { git(['ls-files', '--error-unmatch', path.relative(WORKTREES.v21, DATASET_FILE)], WORKTREES.v21); return true; } catch { return false; } })();
    checks.notGitTracked = !tracked;
    const raw = fs.readFileSync(DATASET_FILE, 'utf8');
    checks.notRedactedCopy = !raw.includes('«redacted');
    let dataset = null;
    try { dataset = JSON.parse(raw); checks.parses = true; } catch { checks.parses = false; }
    if (dataset) {
      checks.sampleCount16 = Array.isArray(dataset.samples) && dataset.samples.length === 16;
      checks.manifestSha = (() => {
        const mf = path.join(WORKTREES.v21, '.tmp/prompt-v2-inventory/dataset-manifest.local.json');
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

// 8. Snapshots present + hashed.
{
  const state = path.join(SNAPSHOT_DIR, 'state.db');
  const traj = path.join(SNAPSHOT_DIR, 'trajectory.db');
  add('snapshots-present+hashed', fs.existsSync(state) && fs.existsSync(traj), {
    trajectorySha256: fs.existsSync(traj) ? sha256File(traj) : null,
    stateSha256: fs.existsSync(state) ? sha256File(state) : null,
  });
}

// 9. Dist readiness + zai env + derived-config profile.
for (const arm of ['v2c', 'v21']) {
  const cli = path.join(WORKTREES[arm], 'packages/pd-cli/dist/index.js');
  const core = path.join(WORKTREES[arm], 'packages/principles-core/dist/runtime/internalization/dreamer-prompt-builder.js');
  add(`dist-ready-${arm}`, fs.existsSync(cli) && fs.existsSync(core), { cli: fs.existsSync(cli), core: fs.existsSync(core) });
}
add('model-api-key-env', Boolean(process.env.ZAI_API_KEY), { apiKeyEnv: 'ZAI_API_KEY', valueRecorded: false });
{
  // Derive the experiment config for a throwaway path and assert the zai binding.
  const probeWs = path.join(WORKTREES.v21, '.tmp', 'preflight-v21-probe-ws');
  fs.rmSync(probeWs, { recursive: true, force: true });
  const { deriveExperimentConfig } = await import('./ab-lib.mjs');
  const cfg = deriveExperimentConfig(probeWs);
  fs.rmSync(probeWs, { recursive: true, force: true });
  add('derived-config-binds-zai-profile', cfg.includes(': pi-ai.glm') && !cfg.includes(': pi-ai.amd-ds-vision'), { profile: 'pi-ai.glm' });
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.failed ? 1 : 0);
