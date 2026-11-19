/**
 * PD-SPEC-001 preflight — config-driven since PD-Lab v0.3 T3b (PRI-1254).
 *
 * Fail-fast, no warn-and-continue. Two clearly separated modes:
 *
 *  GENERIC checks (always executed, for new experiments AND legacy batches —
 *  legacy never skips them): they come from preflightChecks() in ab-lib,
 *  which layers on top of the T3a loader (schema, forbidden roots, dataset/
 *  snapshot/blob digests, workspaceFiles fencing, preregistration binding +
 *  front-matter experimentId, feature-flag registration, two-arm identity):
 *    - physical isolation + env pointer hygiene;
 *    - per-arm HEAD == expectedHead (CF-04) + pd-cli dist existence;
 *    - modelEnv presence (names only, values never read);
 *    - two-arm derived-config structured diff, declared keys only (CF-07).
 *
 *  BATCH-SPECIFIC checks (only when config.legacy.batch === 'prompt-v2-round1',
 *  the single registered value that enables them): the round-1 frozen-head /
 *  prompt-fingerprint / source-delta / 16-sample dataset / local manifest /
 *  snapshot-cross-check checks as historical facts.
 *
 * Any failure → non-zero exit with every problem listed (an unparseable
 * config or a missing historical path is reported per-item, never an
 * uncaught exception), no task creation, no model call.
 *
 * Usage: node ab-preflight.mjs --config <experiment-config.json>
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  bootstrapConfigContext, preflightChecks, currentConfig, configArms, armWorktree,
  datasetFile, snapshotDir, sha256File, childEnv, gitHead,
} from './ab-lib.mjs';
import { computePromptFingerprint } from '../dump-v2-prompts.mjs';

const argv = process.argv.slice(2);
const USAGE = 'usage: node ab-preflight.mjs --config <experiment-config.json>';
bootstrapConfigContext(argv, USAGE);
const cfg = currentConfig();

const report = { spec: 'PD-SPEC-001', phase: 'preflight-config-driven', at: new Date().toISOString(), checks: [] };
const add = (name, ok, detail) => { report.checks.push({ name, ok, detail }); if (!ok) report.failed = true; };

// ── GENERIC checks (loader-backed + HEAD/dist/modelEnv/derived-diff). ─────
const generic = preflightChecks();
for (const c of generic.checks) add(c.name, c.ok, c.detail);
report.experimentId = generic.experimentId;
report.configSha256 = generic.configSha256;
report.preregistrationStatus = generic.preregistrationStatus;
report.preregistrationSha256 = generic.preregistrationSha256;
report.legacyBatch = generic.legacyBatch;

// ── BATCH-SPECIFIC checks — ONLY for the registered legacy batch. ─────────
if (cfg.legacy?.batch === 'prompt-v2-round1') {
  const arms = configArms();
  const [baselineArm, candidateArm] = arms;

  // Round-1 baseline arm frozen at the exact base SHA — the historical value
  // is now carried by the config's expectedHead; the generic arm-head check
  // already compares it. What stays batch-specific is the PROMPT FINGERPRINT
  // of the candidate arm: recompute the variants from its dist and require
  // an exact match with the committed manifest (content-anchored prompt
  // version — a drifted dist fails here, not in the experiment).
  const manifestPath = path.join(armWorktree(candidateArm), 'experiment/prompt-v2/prompts/prompt-hashes-v2.json');
  let fingerprintOk = false;
  let fingerprintDetail = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const live = await computePromptFingerprint(armWorktree(candidateArm));
    const expected = new Map(manifest.prompts.map((p) => [`${p.agent}.${p.variant}`, p.sha256]));
    const mismatches = live.prompts.filter((p) => expected.get(`${p.agent}.${p.variant}`) !== p.sha256);
    fingerprintOk = live.prompts.length === manifest.prompts.length && mismatches.length === 0;
    fingerprintDetail = { liveCount: live.prompts.length, manifestCount: manifest.prompts.length, mismatches: mismatches.map((m) => `${m.agent}.${m.variant}`), scribeVersion: live.scribePromptContractVersion, v2HeadRecorded: manifest.v2WorktreeHead };
  } catch (e) {
    fingerprintDetail = { error: String(e?.message ?? e).slice(0, 200) };
  }
  add('legacy:prompt-fingerprint-matches-manifest', fingerprintOk, fingerprintDetail);

  // Runtime delta scope between arms: EXACTLY the 7 prompt-layer files
  // (+ tests/snapshots).
  {
    const baselineHead = gitHead(armWorktree(baselineArm));
    const diff = execFileSync('git', ['diff', '--name-only', baselineHead, 'HEAD', '--', 'packages/principles-core/src/runtime'], { cwd: armWorktree(candidateArm), env: childEnv() }).toString().trim().split('\n').filter(Boolean);
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
    add('legacy:arm-runtime-delta-scope', runtimeUnexpected.length === 0, { unexpected: runtimeUnexpected, changed: diff.length });
  }

  // Full-fidelity dataset batch facts: 16 samples, SHA pinned in the local
  // dataset manifest, snapshot hashes cross-checked against the dataset's
  // recorded snapshotHashes (digest-vs-declared was already verified by the
  // loader; these are the round-1-specific cross-references).
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
} else if (cfg.legacy && cfg.legacy.batch !== undefined) {
  add(`legacy:known-batch:${cfg.legacy.batch}`, false, { error: `batch ${JSON.stringify(cfg.legacy.batch)} has no prompt-v2-round1 checks — this preflight only carries the prompt-v2-round1 batch checks; dreamer-v21-round2 uses ab-preflight-v21.mjs` });
}

report.ok = !report.failed;
console.log(JSON.stringify(report, null, 2));
process.exit(report.failed ? 1 : 0);
