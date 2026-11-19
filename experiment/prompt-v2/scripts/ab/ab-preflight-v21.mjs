/**
 * PD-SPEC-001 round 2 (Dreamer V2.1) — fail-fast preflight, config-driven
 * since PD-Lab v0.3 T3b (PRI-1254).
 *
 * GENERIC checks (always run, from preflightChecks() in ab-lib — legacy
 * batches never skip them): isolation + env pointers, per-arm HEAD vs
 * expectedHead, pd-cli dist existence, modelEnv presence, two-arm derived
 * config structured diff; the T3a loader in front covers schema/forbidden
 * roots/dataset/snapshot/blob digests/workspaceFiles fencing/preregistration.
 *
 * BATCH-SPECIFIC checks (only when config.legacy.batch === 'dreamer-v21-round2'):
 *   - control (baseline) arm HEAD == the Owner-referenced head — now carried
 *     by the config's expectedHead (generic check compares it);
 *   - treatment arm synced with its remote head + descends from the control
 *     head (merge-base == control expectedHead);
 *   - control-arm prompt fingerprint == round-1 committed manifest;
 *   - treatment fingerprint: non-dreamer variants == round-1, dreamer
 *     variants == the committed V2.1 snapshot manifest;
 *   - source delta between arms is EXACTLY the dreamer prompt builder
 *     (+ tests / snapshot files);
 *   - round-2 dataset batch facts (16 samples, local manifest, snapshot
 *     cross-check) + derived-config zai binding probe.
 *
 * Usage: node ab-preflight-v21.mjs --config <experiment-config.json>
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  bootstrapConfigContext, preflightChecks, currentConfig, configArms, armWorktree,
  datasetFile, snapshotDir, sha256File, childEnv, deriveExperimentConfig,
} from './ab-lib.mjs';
import { computePromptFingerprint } from '../dump-v2-prompts.mjs';

const argv = process.argv.slice(2);
const USAGE = 'usage: node ab-preflight-v21.mjs --config <experiment-config.json>';
bootstrapConfigContext(argv, USAGE);
const cfg = currentConfig();
const [controlArm, treatmentArm] = configArms(); // baseline, candidate
const controlWorktree = armWorktree(controlArm);
const treatmentWorktree = armWorktree(treatmentArm);
const R2_CONTROL_HEAD = cfg.arms[controlArm].expectedHead.toLowerCase();

const report = { spec: 'PD-SPEC-001-round2', phase: 'preflight-config-driven', at: new Date().toISOString(), checks: [] };
const add = (name, ok, detail) => { report.checks.push({ name, ok, detail }); if (!ok) report.failed = true; };

// ── GENERIC checks (never skipped for legacy). ────────────────────────────
const generic = preflightChecks();
for (const c of generic.checks) add(c.name, c.ok, c.detail);
report.experimentId = generic.experimentId;
report.configSha256 = generic.configSha256;
report.preregistrationStatus = generic.preregistrationStatus;
report.legacyBatch = generic.legacyBatch;

const git = (args, cwd) => execFileSync('git', args, { cwd, env: childEnv(), encoding: 'utf8' }).trim();

if (cfg.legacy?.batch === 'dreamer-v21-round2') {
  // Treatment arm synced with its remote head + descends from the control head.
  const treatmentHead = git(['rev-parse', 'HEAD'], treatmentWorktree);
  git(['fetch', 'origin', 'ai/adhoc-20261115-prompt-v2-k4wz9t'], treatmentWorktree);
  const originHead = git(['rev-parse', 'FETCH_HEAD'], treatmentWorktree);
  add('treatment-arm-synced-with-remote-head', treatmentHead === originHead, { head: treatmentHead, originHead });
  const mergeBase = git(['merge-base', R2_CONTROL_HEAD, treatmentHead], treatmentWorktree);
  add('treatment-descends-from-control', mergeBase === R2_CONTROL_HEAD, { mergeBase, controlExpectedHead: R2_CONTROL_HEAD });

  // Control arm fingerprint == round-1 V2 manifest.
  const round1ManifestPath = path.join(treatmentWorktree, 'experiment/prompt-v2/prompts/prompt-hashes-v2.json');
  const round1Manifest = JSON.parse(fs.readFileSync(round1ManifestPath, 'utf8'));
  const controlFp = await computePromptFingerprint(controlWorktree);
  const expected1 = new Map(round1Manifest.prompts.map((p) => [`${p.agent}.${p.variant}`, p.sha256]));
  const controlMismatch = controlFp.prompts.filter((p) => expected1.get(`${p.agent}.${p.variant}`) !== p.sha256);
  add('control-fingerprint-matches-round1-v2-manifest',
    controlFp.prompts.length === round1Manifest.prompts.length && controlMismatch.length === 0,
    { mismatches: controlMismatch.map((m) => `${m.agent}.${m.variant}`), count: controlFp.prompts.length });

  // Treatment arm fingerprint: non-dreamer == round-1, dreamer == V2.1 manifest.
  const v21ManifestPath = path.join(treatmentWorktree, 'experiment/prompt-v2/snapshots/dreamer-v2.1-fingerprints.json');
  const v21Manifest = JSON.parse(fs.readFileSync(v21ManifestPath, 'utf8'));
  const v21ByVariant = new Map(v21Manifest.variants.map((v) => [v.variant, v.sha256]));
  const treatmentFp = await computePromptFingerprint(treatmentWorktree);
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

  // Source delta between arms: only the dreamer prompt builder in packages/.
  const treatmentHeadNow = git(['rev-parse', 'HEAD'], treatmentWorktree);
  const srcDiff = git(['diff', '--name-only', R2_CONTROL_HEAD, treatmentHeadNow, '--', 'packages'], treatmentWorktree)
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

  // Round-2 dataset batch facts (digest-vs-declared already loader-verified).
  {
    const checks = {};
    const dsPath = datasetFile();
    checks.exists = fs.existsSync(dsPath);
    if (checks.exists) {
      const raw = fs.readFileSync(dsPath, 'utf8');
      let dataset = null;
      try { dataset = JSON.parse(raw); checks.parses = true; } catch { checks.parses = false; }
      if (dataset) {
        checks.sampleCount16 = Array.isArray(dataset.samples) && dataset.samples.length === 16;
        checks.manifestSha = (() => {
          const mf = path.join(path.dirname(dsPath), 'dataset-manifest.local.json');
          if (!fs.existsSync(mf)) return 'missing-local-manifest';
          const local = JSON.parse(fs.readFileSync(mf, 'utf8'));
          return local.datasetFullSha256 === sha256File(dsPath) ? 'match' : 'mismatch';
        })();
        checks.snapshotConsistency = (() => {
          const recorded = dataset.snapshotHashes?.trajectory?.sha256;
          const actual = sha256File(path.join(snapshotDir(), 'trajectory.db'));
          return recorded === actual ? 'match' : 'mismatch';
        })();
      }
    }
    const ok = checks.exists === true && checks.parses === true && checks.sampleCount16 === true && checks.manifestSha === 'match' && checks.snapshotConsistency === 'match';
    add('legacy:full-dataset-batch-facts', ok, checks);
  }

  // Derived-config binding probe: profileRebind must land the zai profile in
  // the treatment arm's derived config (throwaway path, nothing written).
  {
    const probeWs = path.join(treatmentWorktree, '.tmp', 'preflight-v21-probe-ws');
    const derivedText = deriveExperimentConfig(probeWs, treatmentArm);
    const rebindTo = cfg.profileRebind?.to ?? null;
    const rebindFrom = cfg.profileRebind?.from ?? null;
    const bindsTarget = rebindTo !== null && derivedText.includes(`: ${rebindTo}`);
    const noStaleFrom = rebindFrom === null || !derivedText.includes(`: ${rebindFrom}`);
    add('derived-config-binds-rebound-profile', bindsTarget && noStaleFrom, { profileRebind: cfg.profileRebind ?? null });
  }
} else if (cfg.legacy && cfg.legacy.batch !== undefined) {
  add(`legacy:known-batch:${cfg.legacy.batch}`, false, { error: `batch ${JSON.stringify(cfg.legacy.batch)} is not dreamer-v21-round2 — the round-2 batch checks only run for that registered batch (prompt-v2-round1 uses ab-preflight.mjs)` });
}

report.ok = !report.failed;
console.log(JSON.stringify(report, null, 2));
process.exit(report.failed ? 1 : 0);
