#!/usr/bin/env node
// G1 unified entry — SPEC-PD-PL-001 v0.3 PR-01 offline pilot (PRI-966..PRI-971).
//
// One command runs the complete offline loop:
//   load frozen dataset → health check → assemble actor inputs (leak-audited)
//   → learn/freeze per arm → run strategies against the mechanical oracle
//   → adjudicate (3 separate outcome layers) → validate the research sidecar
//   → run the frozen calibration battery → evaluate the G1 gate → write the
//   experiment-manifest + sidecar + adjudications + comparison report.
//
// Deterministic: identical inputs produce byte-identical sidecar outputs
// (experiment-manifest.json carries the real run time and is the only file
// exempt from the replay-identity hash).
//
// Usage:
//   node scripts/dev/principle-learning-lab/run-pilot.mjs [--out <dir>] [--quiet]
// Exit code 0 = G1 gate PASS; 1 = gate FAIL (honest failure, never faked).

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { healthCheck, loadDataset } from './lib/fixture.mjs';
import { ACTION_COSTS } from './lib/oracle.mjs';
import { runCalibration } from './lib/evaluator.mjs';
import { STRATEGIES } from './lib/strategies.mjs';
import { runAllArms } from './lib/runner.mjs';
import {
  adjudicationsToJsonl,
  buildStudySidecar,
  studyHash,
  validateSidecar,
} from './lib/sidecar.mjs';
import { validatePrereg } from './lib/prereg.mjs';
import { buildReportJson, evaluateG1Gate, renderReportMd } from './lib/report.mjs';
import { newManifestTemplate, parseManifest } from '../pipeline-evolution/lib/experiment-manifest.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');

function parseArgs(argv) {
  const args = { out: null, dataset: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--dataset') args.dataset = argv[++i];
    else if (argv[i] === '--quiet') args.quiet = true;
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return args;
}

function gitCommit() {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasetDir = args.dataset ?? path.join(SCRIPT_DIR, 'fixtures');
  const outDir = args.out ?? path.join(REPO_ROOT, '.tmp', 'principle-learning-lab', 'PLE-PILOT-01-G1');
  fs.mkdirSync(outDir, { recursive: true });

  const log = (...m) => {
    if (!args.quiet) console.log(...m);
  };

  // 1. Frozen dataset + health check.
  const dataset = loadDataset(datasetDir);
  const healthProblems = healthCheck(dataset, ACTION_COSTS);
  log(`[pl-lab] dataset ${dataset.manifest.datasetId} fixtureHash=${dataset.fixtureHash.slice(0, 12)}…`);
  if (healthProblems.length > 0) {
    console.error(`[pl-lab] fixture health check FAILED:\n  - ${healthProblems.join('\n  - ')}`);
    process.exit(1);
  }
  log('[pl-lab] fixture health check: PASS');

  // 2. Run every arm (learn → freeze → oracle → adjudicate).
  const studyId = 'PLE-PILOT-01';
  const { arms, adjudications, actorInputs } = runAllArms({ dataset, strategies: STRATEGIES, studyId });
  log(`[pl-lab] ran ${arms.length} arms × ${adjudications.length / arms.length} opportunities = ${adjudications.length} adjudications`);

  // 3. Study sidecar + validation.
  const study = buildStudySidecar({
    dataset,
    studyId,
    arms,
    claims: [
      {
        claimId: 'C-E',
        contrastId: 'E0-vs-EA-vs-EB-vs-EN',
        competingExplanations: [
          'base-model prior suffices from the manual alone',
          'answer leakage from history text',
          'surface-form sensitivity to any textual delta',
        ],
        analysisUnit: 'episode',
        status: 'METHOD_VALIDATED_ONLY',
        interpretation:
          'G1 demonstrates the fixture/oracle/evaluator discriminate good from bad strategies and record arm-level deltas; no real agent was involved, so no experience-sensitivity claim about real agents is supported.',
      },
      {
        claimId: 'C-A',
        contrastId: 'real-candidate-vs-summary-vs-raw-vs-none',
        competingExplanations: ['length/token differences', 'retrieval differences', 'researcher cherry-picking'],
        analysisUnit: 'paired probe',
        status: 'NOT_ESTIMABLE',
        interpretation: 'requires frozen REAL I0/I1 candidates and a same-channel delivery — G2/G3, not run here.',
      },
    ],
    assignment: {
      randomization: 'none — deterministic simulation',
      executionOrder: arms.map((a) => a.armId),
      repetitions: 1,
    },
    runtime: {
      host: 'simulated',
      model: null,
      costModel: 'zero-simulation',
      llmJudge: 'NOT_SUPPORTED (mechanical oracle only in G1)',
      pipelineReachabilityPolicy: 'all simulated arms are NOT_REACHED — no PD activation exists or is claimed',
    },
  });
  const sidecarProblems = validateSidecar({
    dataset,
    study,
    adjudications,
    actorInputs,
    knownStrategyIds: new Set(STRATEGIES.map((s) => s.id)),
  });

  // 4. Calibration battery.
  const calibration = runCalibration(dataset.calibration, dataset.probes, dataset.gold);
  log(`[pl-lab] calibration battery: ${calibration.results.filter((r) => r.ok).length}/${calibration.results.length} PASS`);

  // 5. Preregistration draft check.
  const prereg = JSON.parse(fs.readFileSync(path.join(datasetDir, 'preregistration.json'), 'utf8'));
  const preregProblems = validatePrereg({ prereg, study });

  // 6. G1 gate.
  const gate = evaluateG1Gate({ healthProblems, calibration, arms, adjudications, sidecarProblems });

  // 7. Write outputs.
  const runHash = studyHash(study, adjudications);
  const manifest = parseManifest(
    newManifestTemplate({
      experimentId: studyId,
      scenarioId: dataset.manifest.episodeId,
      host: 'simulated',
      pdCommit: gitCommit(),
      fixtureHash: dataset.fixtureHash,
      startedAt: new Date().toISOString(),
      model: { provider: 'none', name: 'simulated-strategies', thinking: null, timeoutMs: null },
    }),
  );
  writeJson(path.join(outDir, 'experiment-manifest.json'), manifest);
  writeJson(path.join(outDir, 'principle-study.json'), study);
  fs.writeFileSync(path.join(outDir, 'adjudications.jsonl'), adjudicationsToJsonl(adjudications), 'utf8');
  writeJson(path.join(outDir, 'memory-manifest.json'), {
    schemaVersion: 'memory-manifest.v0.1',
    note: 'G1 simulated arms carry no external memory; per-arm manifests are embedded in principle-study.json arms[].initialMemoryManifest',
    arms: Object.fromEntries(arms.map((a) => [a.armId, a.initialMemoryManifest])),
  });
  writeJson(path.join(outDir, 'preregistration-check.json'), {
    status: prereg.status,
    pass: preregProblems.length === 0,
    problems: preregProblems,
    ownerDecisionsPending: prereg.ownerDecisionsPending,
  });

  const reportJson = buildReportJson({ dataset, study, adjudications, calibration, gate, studyHash: runHash, arms });
  writeJson(path.join(outDir, 'comparison-report.json'), reportJson);
  fs.writeFileSync(path.join(outDir, 'comparison-report.md'), renderReportMd(reportJson), 'utf8');

  log(`[pl-lab] outputs written to ${outDir}`);
  log(`[pl-lab] studyHash=${runHash}`);
  log(`[pl-lab] prereg draft check: ${preregProblems.length === 0 ? 'PASS (DRAFT — not Owner-approved)' : `FAIL: ${preregProblems.join('; ')}`}`);
  log(`[pl-lab] G1 gate: ${gate.pass ? 'PASS' : 'FAIL'}`);
  if (!gate.pass) {
    console.error(`[pl-lab] gate failures:\n  - ${gate.failures.join('\n  - ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[pl-lab] fatal: ${err.stack ?? err.message}`);
  process.exit(1);
});
