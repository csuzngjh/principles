#!/usr/bin/env node
// PRI-1002 — PRR offline A/C rehearsal entry (B0 §10.3 six rehearsal items).
//
// One command runs the complete OFFLINE loop — zero network, zero model, zero
// real workspace:
//   load PRR dataset → health check → draft freeze record (real-run gate
//   must REFUSE it — fail-closed proof) → A/C groups delivered through the
//   SAME channel (deliverPayload, research-same-channel-v1) → deterministic
//   scripted behaviors (incl. failure rows and a budget-stop row) → mechanical
//   adjudication (five-value + negative transfer + reason codes) → paired
//   delta report (full denominators) → design-check battery → read-only
//   failure-semantics rehearsal (ledger four-way classification + sqlite
//   readonly proofs + state-unchanged assertions) → rehearsal gate.
//
// This is FIXTURE_ONLY evidence about the METHOD. It is not — and can never
// be reported as — evidence about real history-recall value (B0 §10.2).
//
// Usage:
//   node scripts/dev/principle-learning-lab/prr/run-prr-rehearsal.mjs \
//     --dataset <dir> --out <dir> [--quiet]
// Exit code 0 = rehearsal gate PASS; 1 = FAIL (honest failure, never faked).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256 } from '../lib/fixture.mjs';
import { composeActorPrompt, deliverPayload, checkNoCrossContamination, verifyPromptIsolation, buildMemoryManifest } from '../lib/g2.mjs';
import {
  healthCheckPrrDataset,
  loadPrrDataset,
  PRR_GROUPS,
} from './lib/prr-dataset.mjs';
import { adjudicatePrr, runPrrDesignChecks } from './lib/prr-adjudicate.mjs';
import { buildPairedReport, evaluateRehearsalGate } from './lib/prr-paired.mjs';
import { buildDraftFreeze, validateFreezeForRealRun } from './lib/prr-freeze.mjs';
import {
  assertStateUnchanged,
  classifyLedgerAvailability,
  measureLedgerPrinciples,
  readSyntheticLedger,
  rehearseSqliteReadonlySemantics,
  snapshotTree,
} from './lib/prr-readonly.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..', '..');

export const PRR_REHEARSAL_STUDY_ID = 'PRR-AC-REHEARSAL-FIXTURE-ONLY';

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
  if (!args.dataset) {
    console.error('usage: run-prr-rehearsal.mjs --dataset <dir> --out <dir> [--quiet]');
    process.exit(2);
  }
  return args;
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Group payload content — the ONLY thing that differs between A and C. */
export function composeGroupPayload({ group, task, principleText }) {
  if (group === 'A') return principleText;
  return `${principleText}\n\n--- 历史证据（经授权披露，长度受限） ---\n${task.historyMaterial.text}`;
}

function buildLedgerFixture(stateDir, principlesByStatus) {
  fs.mkdirSync(stateDir, { recursive: true });
  const principles = {};
  for (const entry of principlesByStatus) {
    principles[entry.id] = {
      id: entry.id,
      title: entry.title ?? entry.id,
      status: entry.status,
      derivedFromPainIds: entry.derivedFromPainIds ?? [],
      reuseEvidence: entry.reuseEvidence ?? [],
    };
  }
  const ledger = { tree: { principles, rules: {}, implementations: {}, metrics: {}, lastUpdated: '2026-01-01T00:00:00.000Z' }, trainingStore: {} };
  fs.writeFileSync(path.join(stateDir, 'principle_training_state.json'), JSON.stringify(ledger), 'utf8');
}

async function rehearseLedgerSemantics({ workDir }) {
  const problems = [];
  const stateProblems = [];
  const p = (msg) => problems.push(msg);
  const cases = [];

  const runCase = async ({ case: caseName, prepare, expectedClass, expect, authorization, trueZeroEvidence }) => {
    const dir = path.join(workDir, caseName);
    fs.rmSync(dir, { recursive: true, force: true }); // rehearsal-owned output; keep reruns idempotent
    fs.mkdirSync(dir, { recursive: true });
    prepare(dir);
    const before = snapshotTree(dir);
    const { coreResult, problem } = await readSyntheticLedger(dir);
    if (problem) {
      p(`${caseName}: ${problem}`);
      return;
    }
    const measure = measureLedgerPrinciples({ coreResult, authorization, trueZeroEvidence });
    stateProblems.push(...assertStateUnchanged(before, snapshotTree(dir), caseName));
    if (measure.availabilityClass !== expectedClass) {
      p(`${caseName}: availability class ${measure.availabilityClass} != expected ${expectedClass}`);
    }
    for (const [field, expected] of Object.entries(expect ?? {})) {
      const actual = field.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), measure);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        p(`${caseName}: ${field} = ${JSON.stringify(actual)} != expected ${JSON.stringify(expected)}`);
      }
    }
    // The core anti-pattern checks: a non-ok ledger must NEVER surface as a
    // confident zero eligible count, and a zero count must never claim a
    // proven true zero without independent evidence (B0 G5 / v1.3 §1.2 / F-03).
    if (expectedClass === 'unreadable' && measure.m1.count === 0) {
      p(`${caseName}: unreadable ledger was misreported as 0 eligible principles`);
    }
    if (measure.m1.trueZero === true && !trueZeroEvidence) {
      p(`${caseName}: trueZero=true without independent auditable evidence`);
    }
    if (expectedClass === 'ok_but_empty_ledger' && measure.m1.trueZero !== false) {
      p(`${caseName}: parse-lenient empty ledger must not be marked a proven true zero`);
    }
    if (measure.m1.reasonCode === 'availability_status_unknown') {
      p(`${caseName}: unknown availability leaked into a declared-class case`);
    }
    cases.push({ case: caseName, expectedClass, measure: { availabilityClass: measure.availabilityClass, authorizationBasis: measure.authorizationBasis, m1: measure.m1, m2: measure.m2, m3: measure.m3, m4: measure.m4, m5: measure.m5 } });
  };

  await runCase({
    case: 'ledger-ok-nonempty',
    prepare: (dir) => buildLedgerFixture(dir, [
      { id: 'p-syn-1', status: 'active', derivedFromPainIds: ['cand-syn-1'], reuseEvidence: [] },
      { id: 'p-syn-2', status: 'active', derivedFromPainIds: [], reuseEvidence: [{ candidateId: 'cand-syn-1', painId: 'pain-syn-1', evidenceQuality: 'exact' }] },
      { id: 'p-syn-3', status: 'deactivated', derivedFromPainIds: [], reuseEvidence: [] },
    ]),
    authorization: { summaryFieldsAllowed: true },
    expectedClass: 'ok',
    expect: { 'm1.count': 2, 'm2.count': 2, 'm3.count': 2, 'm4.count': 1, 'm3.reasonCode': 'ok' },
    // cand-syn-1 is claimed by p-syn-1 (derived) AND p-syn-2 (reuse) — an
    // explicit M4 conflict; both principles still locate pain-syn-1 (M2), the
    // conflict is flagged, never resolved by last-write-wins.
  });

  await runCase({
    case: 'ledger-ok-structurally-empty',
    prepare: (dir) => fs.writeFileSync(path.join(dir, 'principle_training_state.json'), '[]', 'utf8'),
    expectedClass: 'ok_but_empty_ledger',
    expect: { 'm1.count': 0, 'm1.trueZero': false },
  });

  await runCase({
    case: 'ledger-zero-byte',
    prepare: (dir) => fs.writeFileSync(path.join(dir, 'principle_training_state.json'), '', 'utf8'),
    expectedClass: 'empty',
    expect: { 'm1.count': 0, 'm1.trueZero': false, 'm1.reasonCode': 'ledger_empty__true_zero_unproven_requires_independent_evidence' },
  });

  await runCase({
    case: 'ledger-zero-byte-with-independent-evidence',
    prepare: (dir) => fs.writeFileSync(path.join(dir, 'principle_training_state.json'), '', 'utf8'),
    trueZeroEvidence: { auditor: 'offline-rehearsal', recordRef: 'synthetic independent audit record (fixture)' },
    expectedClass: 'empty',
    expect: { 'm1.count': 0, 'm1.trueZero': true, 'm1.reasonCode': 'ledger_empty_with_independent_true_zero_evidence' },
  });

  await runCase({
    case: 'ledger-malformed-entries',
    prepare: (dir) => fs.writeFileSync(path.join(dir, 'principle_training_state.json'), JSON.stringify({ tree: { principles: { p1: 'garbage-string-entry', p2: { title: 'no id here' } } } }), 'utf8'),
    trueZeroEvidence: { auditor: 'offline-rehearsal', recordRef: 'synthetic independent audit record (fixture)' },
    expectedClass: 'malformed_entries__semantic_review_required',
    expect: { 'm1.count': null, 'm1.trueZero': false, 'm1.reasonCode': 'malformed_ledger_entries__semantic_review_required' },
  });

  await runCase({
    case: 'ledger-lenient-empty-cannot-be-true-zero',
    prepare: (dir) => fs.writeFileSync(path.join(dir, 'principle_training_state.json'), '[]', 'utf8'),
    trueZeroEvidence: { auditor: 'offline-rehearsal', recordRef: 'synthetic independent audit record (fixture)' },
    expectedClass: 'ok_but_empty_ledger',
    expect: { 'm1.count': 0, 'm1.trueZero': false, 'm1.reasonCode': 'ok_but_empty_ledger__semantic_review_required' },
  });

  await runCase({
    case: 'ledger-invalid-json',
    prepare: (dir) => fs.writeFileSync(path.join(dir, 'principle_training_state.json'), '{"tree": nope', 'utf8'),
    expectedClass: 'unreadable',
    expect: { 'm1.count': null, 'm1.trueZero': false },
  });

  await runCase({
    case: 'ledger-ambiguous-attribution',
    prepare: (dir) => buildLedgerFixture(dir, [
      { id: 'p-syn-a', status: 'active', derivedFromPainIds: ['cand-shared'], reuseEvidence: [] },
      { id: 'p-syn-b', status: 'active', derivedFromPainIds: ['cand-shared'], reuseEvidence: [] },
      { id: 'p-syn-c', status: 'active', derivedFromPainIds: [], reuseEvidence: [{ candidateId: 'cand-clean', painId: 'pain-clean', evidenceQuality: 'excerpt_only' }] },
    ]),
    authorization: { summaryFieldsAllowed: true },
    expectedClass: 'ok',
    expect: {
      'm4.count': 1,
      // cand-shared binds to no pain anywhere → p-a/p-b untraceable; p-c direct.
      'm2.count': 1,
      'm2.ambiguousFlagged': 2,
    },
  });

  // D-01 authorization semantics — three declared/undeclared states must be
  // observably different; omission is treated as UNAUTHORIZED, never allowed.
  {
    const fixture = [
      { id: 'p-syn-u', status: 'active', derivedFromPainIds: [], reuseEvidence: [{ candidateId: 'cand-u', painId: 'pain-u', evidenceQuality: 'exact' }] },
    ];
    const build = (dir) => buildLedgerFixture(dir, fixture);

    await runCase({
      case: 'ledger-authorization-omitted',
      prepare: build,
      expectedClass: 'ok',
      expect: {
        'm3.count': 0,
        'm3.reasonCode': 'summary_authorization_not_declared',
        'm5.unauthorizedCount': 1,
      },
    });
    if (cases.length > 0) {
      const last = cases[cases.length - 1];
      if (last.measure.authorizationBasis !== 'NOT_DECLARED_TREATED_AS_UNAUTHORIZED' || last.measure.m5.unauthorizedField == null) {
        p('ledger-authorization-omitted: basis/field markers missing — omission must be observably unauthorized');
      }
    }

    await runCase({
      case: 'ledger-summary-unauthorized',
      prepare: build,
      authorization: { summaryFieldsAllowed: false },
      expectedClass: 'ok',
      expect: {
        'm3.count': 0,
        'm3.reasonCode': 'summary_fields_unauthorized_d01',
        'm5.unauthorizedCount': 1,
      },
    });
    if (cases[cases.length - 1].measure.authorizationBasis !== 'D01_NOT_GRANTED_DECLARED') {
      p('ledger-summary-unauthorized: declared-false basis marker missing');
    }

    await runCase({
      case: 'ledger-summary-authorized',
      prepare: build,
      authorization: { summaryFieldsAllowed: true },
      expectedClass: 'ok',
      expect: { 'm3.count': 1, 'm3.reasonCode': 'ok', 'm5.unauthorizedCount': 0 },
    });
    if (cases[cases.length - 1].measure.authorizationBasis !== 'D01_GRANTED_DECLARED') {
      p('ledger-summary-authorized: declared-true basis marker missing');
    }
  }

  // Unknown availability status, malformed entries and malformed
  // authorization must fail loud; trueZero must be unreachable from any
  // malformed path even when evidence is supplied.
  {
    const unknownStatus = classifyLedgerAvailability({ ledger: {}, availability: {} });
    const missingStatus = classifyLedgerAvailability({});
    const inconsistent = classifyLedgerAvailability({ availability: { status: 'unreadable' }, ledger: { tree: { principles: { p: {} } } } });
    if (unknownStatus !== 'unmeasurable_unknown_availability' || missingStatus !== 'unmeasurable_unknown_availability') {
      p(`unknown/missing availability must be unmeasurable (got ${unknownStatus}/${missingStatus})`);
    }
    if (inconsistent !== 'unreadable') {
      p(`authority status must win over ledger content (got ${inconsistent})`);
    }
    const stringEntry = classifyLedgerAvailability({ availability: { status: 'ok' }, ledger: { tree: { principles: { p1: 'garbage' } } } });
    const noStatusEntry = classifyLedgerAvailability({ availability: { status: 'ok' }, ledger: { tree: { principles: { p1: { id: 'p1' } } } } });
    if (stringEntry !== 'malformed_entries__semantic_review_required' || noStatusEntry !== 'malformed_entries__semantic_review_required') {
      p(`malformed entries must be semantic-review cases (got ${stringEntry}/${noStatusEntry})`);
    }
    const unknownMeasure = measureLedgerPrinciples({ coreResult: { availability: {} }, authorization: { summaryFieldsAllowed: true } });
    if (unknownMeasure.m1.count !== null || unknownMeasure.m1.reasonCode !== 'availability_status_unknown' || unknownMeasure.m1.trueZero !== false) {
      p(`unknown availability must measure nothing (${JSON.stringify(unknownMeasure.m1)})`);
    }
    const lenientEmpty = measureLedgerPrinciples({
      coreResult: { availability: { status: 'ok' }, ledger: { tree: {} } },
      authorization: { summaryFieldsAllowed: true },
      trueZeroEvidence: { auditor: 'x', recordRef: 'y' },
    });
    if (lenientEmpty.m1.trueZero !== false) {
      p(`parse-lenient empty ledger must never be promoted to trueZero (${JSON.stringify(lenientEmpty.m1)})`);
    }
    let malformedThrew = false;
    try {
      measureLedgerPrinciples({ coreResult: { availability: { status: 'ok' } }, authorization: { summaryFieldsAllowed: 'yes' } });
    } catch {
      malformedThrew = true;
    }
    if (!malformedThrew) p('malformed authorization (non-boolean summaryFieldsAllowed) must throw (rc-3)');
    cases.push({ case: 'semantic-probe-unknown-status-and-authorization', expectedClass: 'unmeasurable_unknown_availability', measure: { availabilityClass: unknownStatus, authorizationBasis: 'D01_GRANTED_DECLARED', m1: unknownMeasure.m1 } });
    cases.push({ case: 'semantic-probe-malformed-entries', expectedClass: 'malformed_entries__semantic_review_required', measure: { availabilityClass: stringEntry, authorizationBasis: 'D01_GRANTED_DECLARED', m1: { trueZero: lenientEmpty.m1.trueZero } } });
  }

  return { problems, stateProblems, cases };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.out ?? path.join(REPO_ROOT, '.tmp', 'principle-learning-lab', 'PRR-AC-REHEARSAL');
  fs.mkdirSync(outDir, { recursive: true });
  const log = (...m) => {
    if (!args.quiet) console.log(...m);
  };

  // 1. Dataset + health check.
  const dataset = loadPrrDataset(args.dataset);
  const healthProblems = healthCheckPrrDataset(dataset);
  log(`[prr-lab] dataset ${dataset.manifest.datasetId} v${dataset.manifest.datasetVersion} fixtureHash=${dataset.fixtureHash.slice(0, 12)}…`);
  if (healthProblems.length > 0) {
    console.error(`[prr-lab] dataset health check FAILED:\n  - ${healthProblems.join('\n  - ')}`);
    process.exit(1);
  }
  log('[prr-lab] dataset health check: PASS');

  // 2. Freeze gate: build the honest DRAFT and prove the real-run gate
  //    refuses it (fail-closed evidence — this rehearsal is NOT authorized).
  const preregBody = {
    studyId: PRR_REHEARSAL_STUDY_ID,
    kind: 'PRR_A/C_OFFLINE_REHEARSAL',
    dataset: { datasetId: dataset.manifest.datasetId, datasetVersion: dataset.manifest.datasetVersion, fixtureHash: dataset.fixtureHash },
    mainResearchQuestion: 'Does the offline rehearsal machinery (delivery, isolation, adjudication, pairing, freeze gate, read-only semantics) run end-to-end deterministically?',
    note: 'Synthetic rehearsal prereg body. Real A/C preregistration is FZ-15-gated and Owner-approved separately; this body authorizes nothing.',
  };
  const freeze = buildDraftFreeze({ studyId: PRR_REHEARSAL_STUDY_ID, preregBody });
  const realRunCheck = validateFreezeForRealRun({
    freeze,
    preregBody,
    verifyOwnerApproval: () => ({ verified: false, reason: 'offline rehearsal has no Owner decision record' }),
    dataset,
  });

  // 3. A/C runs through the SAME channel.
  const deliveries = {};
  const receipts = [];
  const taskTextByArm = {};
  const adjudications = [];
  const exclusions = [];
  const stopEvents = [];
  const adjudicationsByGroupTask = new Map();

  for (const task of dataset.tasks.tasks) {
    const principle = dataset.principlesById.get(task.principleId);
    for (const group of PRR_GROUPS) {
      const armId = `${group}:${task.taskId}`;
      if (group === 'C' && task.historyMaterial.disclosureStatus === 'unauthorized') {
        exclusions.push({
          taskId: task.taskId,
          group: 'C',
          reasonCode: 'unauthorized_history_material',
          note: 'disclosureStatus=unauthorized — excluded before exposure per B0 §8.2; recorded here, never silently dropped',
        });
        continue;
      }
      const behavior = dataset.behaviors.behaviors[armId];
      const delivery = deliverPayload({
        armId,
        content: composeGroupPayload({ group, task, principleText: principle.text }),
        budgetChars: dataset.manifest.cMaterialBudgetChars,
      });
      deliveries[armId] = delivery;
      taskTextByArm[armId] = task.taskText;
      receipts.push({
        armId,
        payloadHash: delivery.payloadHash,
        promptHash: sha256(composeActorPrompt({ taskText: task.taskText, delivery })),
      });

      const budgetExhausted = typeof behavior.usage.requests === 'number' && behavior.usage.requests > dataset.manifest.maxRequestsPerTask;
      if (budgetExhausted) {
        stopEvents.push({
          type: 'AC-S4_BUDGET_STOP',
          group,
          taskId: task.taskId,
          requests: behavior.usage.requests,
          cap: dataset.manifest.maxRequestsPerTask,
          action: 'row retained and graded budget_exhausted; partial results reported as-is',
        });
      }
      const adjudication = adjudicatePrr({
        studyId: PRR_REHEARSAL_STUDY_ID,
        group,
        taskId: task.taskId,
        taskType: task.taskType,
        goldRecord: dataset.goldByTask[task.taskId],
        behavior,
        budgetExhausted,
      });
      adjudications.push(adjudication);
      adjudicationsByGroupTask.set(armId, adjudication);
    }
  }

  const contaminationProblems = checkNoCrossContamination({ receipts, deliveries });
  const promptIsolationProblems = verifyPromptIsolation({ receipts, deliveries, taskTextByArm });
  const memoryManifestA = buildMemoryManifest({ files: [] });
  const memoryManifestC = buildMemoryManifest({ files: [] });
  const memoryManifestEqual = JSON.stringify(memoryManifestA) === JSON.stringify(memoryManifestC);

  // 4. Design-check battery (fixture discrimination + adjudicator calibration).
  const designChecks = runPrrDesignChecks({ designChecks: dataset.designChecks, dataset, adjudicationsByGroupTask });
  log(`[prr-lab] design-check battery: ${designChecks.results.filter((r) => r.ok).length}/${designChecks.results.length} PASS`);

  // 5. Paired report.
  const taskTypeById = new Map(dataset.tasks.tasks.map((t) => [t.taskId, t.taskType]));
  const pairedReport = buildPairedReport({ studyId: PRR_REHEARSAL_STUDY_ID, adjudications, exclusions, taskTypeById });

  // 6. Read-only semantics rehearsal (ledger four-way + sqlite readonly).
  const readonlyDir = path.join(outDir, 'readonly');
  fs.mkdirSync(readonlyDir, { recursive: true });
  const ledgerRehearsal = await rehearseLedgerSemantics({ workDir: readonlyDir });
  const sqliteRehearsal = rehearseSqliteReadonlySemantics({ workDir: readonlyDir });
  const readonlyProblems = [...ledgerRehearsal.problems, ...sqliteRehearsal.problems];
  const stateUnchangedProblems = [...ledgerRehearsal.stateProblems, ...sqliteRehearsal.stateProblems];

  log(`[prr-lab] readonly semantics: ${readonlyProblems.length === 0 ? 'PASS' : `${readonlyProblems.length} problem(s)`}`);
  log(`[prr-lab] read-only state unchanged: ${stateUnchangedProblems.length === 0 ? 'PASS' : `${stateUnchangedProblems.length} problem(s)`}`);

  // 7. Rehearsal gate.
  const gate = evaluateRehearsalGate({
    healthProblems,
    designChecks,
    contaminationProblems,
    promptIsolationProblems,
    pairedReport,
    stopEvents,
    readonlyProblems,
    stateUnchangedProblems,
    freezeRealRunProblems: realRunCheck.problems,
  });

  // 8. Outputs (deterministic — no timestamps anywhere).
  const result = {
    schemaVersion: 'prr-rehearsal-result.v0.1',
    studyId: PRR_REHEARSAL_STUDY_ID,
    dataset: { datasetId: dataset.manifest.datasetId, datasetVersion: dataset.manifest.datasetVersion, fixtureHash: dataset.fixtureHash, dir: args.dataset },
    evidenceType: 'FIXTURE_ONLY',
    determinism: 'byte-identical on identical inputs (no timestamps, no randomness)',
    freezeGate: {
      draftStatus: freeze.status,
      realRunRefused: realRunCheck.problems.length > 0,
      refusalProblems: realRunCheck.problems,
      minPairsEligible: realRunCheck.minPairsEligible,
    },
    isolation: {
      channel: 'research-same-channel-v1',
      contaminationProblems,
      promptIsolationProblems,
      memoryManifestEqual,
    },
    adjudications,
    pairedReport,
    stopEvents,
    designChecks: designChecks.results.map((r) => ({ caseId: r.caseId, ok: r.ok, diffs: r.diffs })),
    readonly: {
      ledgerCases: ledgerRehearsal.cases,
      sqliteCases: sqliteRehearsal.cases,
      problems: readonlyProblems,
      stateProblems: stateUnchangedProblems,
    },
    gate,
    limitations: [
      'FIXTURE_ONLY: this rehearsal proves the METHOD (delivery/isolation/adjudication/pairing/freeze/read-only semantics), never any real history-recall value.',
      'All actor behaviors are scripted fixtures; no model was called, cost is zero, token fields are honest nulls unless scripted.',
      'The freeze record is a DRAFT refused by the real-run gate; no Owner authorization exists or is implied.',
      'M1~M5 numbers inside readonly cases are synthetic-fixture classifications, not real workspace measurements (real M1~M5: NOT_MEASURED).',
    ],
  };
  result.studyHash = sha256(JSON.stringify(result));
  writeJson(path.join(outDir, 'rehearsal-result.json'), result);
  writeJson(path.join(outDir, 'paired-report.json'), pairedReport);

  log(`[prr-lab] outputs written to ${outDir}`);
  log(`[prr-lab] studyHash=${result.studyHash}`);
  log(`[prr-lab] freeze real-run gate: REFUSED (${realRunCheck.problems.length} problem(s) — draft cannot authorize)`);
  log(`[prr-lab] rehearsal gate: ${gate.pass ? 'PASS' : 'FAIL'}`);
  if (!gate.pass) {
    console.error(`[prr-lab] gate failures:\n  - ${gate.failures.join('\n  - ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[prr-lab] fatal: ${err.stack ?? err.message}`);
  process.exit(1);
});
