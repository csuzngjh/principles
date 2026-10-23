// PRI-1002 — generate a formal PRR B0 freeze record (prr-b0-freeze.v0.1)
// from an Owner-approved decision-values file.
//
// The DECISION VALUES file is the Owner-approved card (all 12 items with
// concrete values). This tool ONLY assembles the freeze record and prints
// the signing template for Linear PRI-1001 — it NEVER marks the record
// approved by itself: status starts OWNER_APPROVED_FROZEN only because the
// decision file carries `ownerApproved: true` + the Linear approval
// reference, and the real authorization still requires the independent
// resolver to find the MATCHING Owner signature on PRI-1001.
//
// Usage:
//   node generate-prr-freeze.mjs --decisions <decisions.json> --dataset <dir> \
//     --commit <frozen-commit-sha> --out <freeze.json>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256 } from '../lib/fixture.mjs';
import { loadPrrDataset } from './lib/prr-dataset.mjs';
import { protocolApprovalDigest } from './lib/prr-freeze.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--decisions') args.decisions = argv[++i];
    else if (argv[i] === '--dataset') args.dataset = argv[++i];
    else if (argv[i] === '--commit') args.commit = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const decisions = JSON.parse(fs.readFileSync(args.decisions, 'utf8'));
  const dataset = loadPrrDataset(path.resolve(args.dataset));
  const commit = args.commit;

  if (decisions.ownerApproved !== true || typeof decisions.ownerApprovalRef !== 'string' || decisions.ownerApprovalRef.trim() === '') {
    console.error('REFUSED: the decision file must carry ownerApproved=true and a non-empty ownerApprovalRef (the Linear PRI-1001 approval reference). Tooling never signs on the Owner\'s behalf.');
    process.exit(1);
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    console.error('REFUSED: --commit must be the 40-hex frozen execution commit.');
    process.exit(1);
  }
  const preregBody = {
    studyId: decisions.studyId,
    kind: 'PRR_B0_AC_REAL',
    dataset: { datasetId: dataset.manifest.datasetId, datasetVersion: dataset.manifest.datasetVersion, fixtureHash: dataset.fixtureHash },
    decisionRef: decisions.ownerApprovalRef,
    note: 'Real A/C preregistration body generated from the Owner-approved decision card (PRI-1001).',
  };

  const items = [
    ['FZ-01', { datasetId: dataset.manifest.datasetId, datasetVersion: dataset.manifest.datasetVersion, taskSetHash: dataset.fixtureHash, taskCount: dataset.tasks.tasks.length }],
    ['FZ-02', { injectionTextFrozen: true, fixtureHash: dataset.fixtureHash }],
    ['FZ-03', decisions.fz03],
    ['FZ-04', decisions.fz04],
    ['FZ-05', decisions.fz05 ?? { tools: 'none — single-round decision protocol' }],
    ['FZ-06', decisions.fz06],
    ['FZ-07', decisions.fz07 ?? { rubric: 'prr-gold.v0.1 (frozen dataset gold)', judge: 'prr-mechanical-v1' }],
    ['FZ-08', decisions.fz08],
    ['FZ-09', decisions.fz09],
    ['FZ-10', decisions.fz10 ?? { nt1: 'misapplied_history_decision on AC-T3', nt2: 'history_induced_error on AC-T1/T2', nt3: 'hedging without verdict improvement' }],
    ['FZ-11', decisions.fz11],
    ['FZ-12', decisions.fz12 ?? { classification: 'B0 §8.2 (invalid/timeout/no-response/budget rows retained)' }],
    ['FZ-13', decisions.fz13 ?? { stopConditions: ['AC-S1..AC-S8 per B0 v0.2 §8.1'] }],
    ['FZ-14', decisions.fz14 ?? { retention: 'results and redacted materials in .tmp per B0 §7.4; destroy after report' }],
    ['FZ-15', { note: 'completed by this record: prereg hash + protocol digest + owner approval reference' }],
  ].map(([id, value]) => ({ id, title: id, ownerExclusive: true, status: 'VALUE_FROZEN', value, ownerApprovalRef: decisions.ownerApprovalRef }));

  const freeze = {
    schemaVersion: 'prr-b0-freeze.v0.1',
    studyId: decisions.studyId,
    status: 'OWNER_APPROVED_FROZEN',
    note: `Formal freeze generated from the Owner-approved decision card. Approval reference: ${decisions.ownerApprovalRef}. Real authorization additionally requires the independent Linear resolver to attest the SAME protocol digest / commit / dataset hash.`,
    prereg: {
      canonicalSha256: sha256(canonicalJson(preregBody)),
      bodyNote: 'The hash lives in this record, never in the hashed body (self-reference is unsatisfiable).',
    },
    items,
    ownerApproval: {
      approvedBy: 'owner',
      decisionRef: decisions.ownerApprovalRef,
      frozenCommitSha: commit,
    },
  };

  const out = args.out ?? 'prr-freeze.json';
  fs.writeFileSync(out, `${JSON.stringify(freeze, null, 2)}\n`, 'utf8');
  const digest = protocolApprovalDigest({ freeze: JSON.parse(JSON.stringify(freeze)), preregBody });

  console.log([
    `freeze record written: ${out}`,
    `prereg canonical SHA-256: ${freeze.prereg.canonicalSha256}`,
    `protocolApprovalDigest: ${digest}`,
    `frozenCommitSha: ${commit}`,
    `fixtureHash: ${dataset.fixtureHash}`,
    '',
    'NEXT (Owner action — REQUIRED, tooling cannot do this): post the following',
    'verbatim as a comment on Linear PRI-1001 from the Owner account:',
    '',
    '[PRR-FREEZE-APPROVAL]',
    `decisionRef: ${decisions.ownerApprovalRef}`,
    `protocolDigest: ${digest}`,
    `frozenCommitSha: ${commit}`,
    `fixtureHash: ${dataset.fixtureHash}`,
    `costBasisRef: ${decisions.fz06?.costBasisRef ?? 'SET-ME'}`,
    `pricingMode: ${decisions.fz06?.pricingMode ?? 'SET-ME (free-tier|zai-coding-plan)'}`,
    'approved: yes',
    '',
    'The independent linear-owner-resolver.mjs will then attest the freeze.',
  ].join('\n'));
}

main();
