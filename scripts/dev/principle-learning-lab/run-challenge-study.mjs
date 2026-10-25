#!/usr/bin/env node
// SPEC-PD-EXAMINER-001 v0.3 — Phase 1B offline golden-path CLI.
//
// Runs the frozen CEB-001-style suite end-to-end with a DETERMINISTIC STUB
// strategy (no transport, no network, no DB, no model). Intended for study
// directory COPIES (e.g. under .tmp/) — running against the pristine frozen
// study would append run records to its append-only ledgers, which is legal
// but permanent; tests and demos use copies.
//
//   node run-challenge-study.mjs --study-dir <path> --strategy perfect-play \
//        [--arms A,B,C] [--max-attempts 40] [--owner demo]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFrozenStudy, verifyArmConfigsFrozen, runChallengeStudy, STUB_STRATEGIES } from './lib/challenge-runner.mjs';

const labRoot = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const studyDir = arg('--study-dir');
if (!studyDir) {
  console.error('run-challenge-study: --study-dir <path> required');
  process.exit(1);
}
const strategy = arg('--strategy', 'perfect-play');
if (!STUB_STRATEGIES[strategy]) {
  console.error(`run-challenge-study: unknown strategy '${strategy}' (available: ${Object.keys(STUB_STRATEGIES).join(', ')})`);
  process.exit(1);
}
const arms = (arg('--arms', 'A,B,C') || '').split(',').map((s) => s.trim()).filter(Boolean);
const maxAttemptsTotal = Number(arg('--max-attempts', '40'));
const owner = arg('--owner', 'challenge-runner-cli');

const resolved = path.resolve(process.cwd(), studyDir);
try {
  const frozen = verifyFrozenStudy(resolved);
  const armCheck = verifyArmConfigsFrozen(resolved);
  console.log(`run-challenge-study: frozen OK — study=${frozen.studyId} suiteHash=${frozen.suiteHash.slice(0, 12)}… arms=A/B/C audited`);

  const summary = runChallengeStudy({
    studyDir: resolved,
    plan: { arms, cases: frozen.manifest.cases.map((c) => c.caseId), repetitions: [1] },
    actorFactory: (ctx) => STUB_STRATEGIES[strategy](ctx),
    maxAttemptsTotal,
    owner,
  });

  const counts = {};
  for (const u of summary.units) counts[u.state] = (counts[u.state] || 0) + 1;
  const outcomes = {};
  for (const u of summary.units) if (u.objectiveTaskOutcome) outcomes[u.objectiveTaskOutcome] = (outcomes[u.objectiveTaskOutcome] || 0) + 1;
  console.log(`run-challenge-study: DONE — units=${summary.units.length} states=${JSON.stringify(counts)} objectiveOutcomes=${JSON.stringify(outcomes)}`);
  console.log(`  budget RESERVE rows: ${summary.units.filter((u) => !u.skipped && !u.refused).length} (never returned on crash)`);
} catch (e) {
  console.error(`run-challenge-study: FAIL — ${e.message}`);
  process.exit(1);
}
