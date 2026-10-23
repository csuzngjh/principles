#!/usr/bin/env node
// PRI-966 — FORMAL real-model study entry (external-model route).
//
// Thin orchestrator over the EXISTING machinery — it implements no model
// loop of its own:
//
//   load dataset → recompute fixtureHash → read the Owner authorization
//   record (g2-real-run-authorization.v1) → evidenceVerifier resolves the
//   Owner decision + cost basis from files → createAuthorizedPiTransport
//   (fail-closed gate: no authorization ⇒ no HTTP) → runRealStudy(armSpecs)
//   → sidecar + adjudications + budget audit + report.
//
// Hard stops BEFORE any model call: missing authorization record, missing/
// non-approving Owner decision, fixtureHash drift, missing credentials,
// malformed caps, provider/model drift between record and gate.
//
// Usage:
//   node run-formal-study.mjs --authorization runs/formal-2026-10-23/authorization.json \
//        [--seed-count 1] [--out <dir>] [--dry-run]
//
// Exit 0 = study completed and sidecar valid; 1 = refused or failed (honest).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(SCRIPT_DIR, 'lib');
const url = (p) => 'file:///' + p.replace(/\\/g, '/');

const { loadDataset, canonicalJson } = await import(url(path.join(LIB, 'fixture.mjs')));
const { validatePrereg } = await import(url(path.join(LIB, 'prereg.mjs')));
const {
  buildStudySidecar,
  adjudicationsToJsonl,
  studyHash,
  validateSidecar,
} = await import(url(path.join(LIB, 'sidecar.mjs')));
const { runRealStudy, REAL_CONTENT_MODES } = await import(url(path.join(LIB, 'real-runner.mjs')));
const { verifyRealRunAuthorization } = await import(url(path.join(LIB, 'actor.mjs')));
const { createFileEvidenceVerifier, composeApprovedPreregView } = await import(url(path.join(LIB, 'evidence-verifier.mjs')));

function parseArgs(argv) {
  const args = { seedCount: 1, out: null, dryRun: false, authorization: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--authorization') args.authorization = argv[++i];
    else if (a === '--seed-count') args.seedCount = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

// The C-A contrast arms (prereg contrastId real-candidate-vs-summary-vs-raw-
// vs-none): one history (EA — the relevant high-stakes lesson), four content
// conditions, FIXED paired order, repeated per seed. Nothing here redefines
// the experiment — the conditions are the preregistration's own.
const FORMAL_ARM_SPECS = [
  { historyId: 'EA', contentMode: 'policy' },
  { historyId: 'EA', contentMode: 'summary' },
  { historyId: 'EA', contentMode: 'raw' },
  { historyId: 'EA', contentMode: 'none' },
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.authorization) {
    console.error('[formal] REFUSED: --authorization <file> is required (fail-closed)');
    process.exit(1);
  }
  if (!Number.isSafeInteger(args.seedCount) || args.seedCount < 1 || args.seedCount > 3) {
    console.error('[formal] REFUSED: --seed-count must be an integer in [1,3] (preregistered plan)');
    process.exit(1);
  }
  const authPath = path.resolve(args.authorization);
  const authDir = path.dirname(authPath);
  const authorization = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  if (authorization.schemaVersion !== 'g2-real-run-authorization.v1') {
    console.error('[formal] REFUSED: authorization.schemaVersion must be g2-real-run-authorization.v1');
    process.exit(1);
  }

  // 1-3. frozen dataset + FRESH fixtureHash (never trusted from the record).
  const dataset = loadDataset(path.join(SCRIPT_DIR, 'fixtures'));
  console.log(`[formal] dataset ${dataset.manifest.datasetId} fixtureHash=${dataset.fixtureHash.slice(0, 12)}… (freshly computed)`);

  // 4. evidence resolution + gate verification (throws BEFORE any transport).
  const evidenceVerifier = createFileEvidenceVerifier({ baseDir: authDir });
  const decisionRef = authorization.od1?.decisionRef;
  if (typeof decisionRef !== 'string' || decisionRef.length === 0) {
    console.error('[formal] REFUSED: authorization.od1.decisionRef missing');
    process.exit(1);
  }
  const decision = evidenceVerifier({ kind: 'owner-decision', reference: decisionRef });
  if (decision.fixtureHash !== dataset.fixtureHash) {
    console.error(`[formal] REFUSED: Owner decision approves fixtureHash ${decision.fixtureHash.slice(0, 12)}… but the loaded dataset hashes to ${dataset.fixtureHash.slice(0, 12)}… (drift = no run)`);
    process.exit(1);
  }
  const costEvidence = evidenceVerifier({ kind: 'cost-basis', reference: authorization.od2.costBasisRef });
  const preregDraft = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, 'fixtures', 'preregistration.json'), 'utf8'));
  const preregView = composeApprovedPreregView({
    prereg: preregDraft,
    decisionRecord: { approved: true, reference: decisionRef, decidedBy: decision.decidedBy, decidedAt: decision.decidedAt },
  });

  // 5. credentials must exist in the environment BEFORE any call is planned.
  const apiKey = process.env[authorization.od2.apiKeyEnv];
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    console.error(`[formal] REFUSED: ${authorization.od2.apiKeyEnv} is not set — credentials missing (fail-closed, zero HTTP)`);
    process.exit(1);
  }

  // 6. caps: the gate re-validates every field against the record and the
  // ledger chain; construction happens inside runRealStudy per arm.
  const budgets = {
    httpRequestsPerOpportunity: authorization.od2.httpRequestsPerOpportunity,
    httpRequestsPerArm: authorization.od2.httpRequestsPerArm,
    httpRequestsPerStudy: authorization.od2.httpRequestsPerStudy,
    perRunCostCapUsd: authorization.od2.perRunCostCapUsd,
    totalCostCapUsd: authorization.od2.totalCostCapUsd,
  };
  const adapterConfig = {
    provider: authorization.od2.provider,
    model: authorization.od2.model,
    apiKeyEnv: authorization.od2.apiKeyEnv,
    baseUrl: authorization.od2.baseUrl,
  };
  verifyRealRunAuthorization({
    authorization,
    prereg: preregView,
    dataset,
    adapterConfig,
    budgets,
    evidenceVerifier,
  });
  console.log(`[formal] authorization verified (decision: ${decision.decidedBy} @ ${decision.decidedAt}; cost basis effective ${costEvidence.effectiveDate}, officialPriceVerified=${costEvidence.officialPriceVerified})`);
  console.log(`[formal] plan-quota semantics: ${authorization.od2.costBillingSemantics ?? 'per-token list-price ceiling reserved; actual plan draw recorded from usage'}`);

  // 7. arm list + a machine-checkable plan summary.
  const studyIdBase = authorization.studyId ?? 'PLE-PILOT-01-FORMAL';
  console.log(`[formal] arms: ${FORMAL_ARM_SPECS.map((s) => `${s.historyId}:${s.contentMode}`).join(' → ')} × ${args.seedCount} seed(s)`);

  if (args.dryRun) {
    console.log('[formal] DRY RUN — authorization, credentials, hash and caps all verified; zero model calls made. Plan hash:', require0(canonicalJson({ studyIdBase, budgets, adapterConfig, armSpecs: FORMAL_ARM_SPECS, seedCount: args.seedCount })));
    return;
  }

  // 8-10. run per seed, each seed = one isolated study (own ledgers/arms).
  const outRoot = args.out ?? path.join(SCRIPT_DIR, '..', '..', '..', '.tmp', 'principle-learning-lab', 'FORMAL');
  fs.mkdirSync(outRoot, { recursive: true });
  for (let seed = 1; seed <= args.seedCount; seed += 1) {
    const studyId = args.seedCount === 1 ? studyIdBase : `${studyIdBase}-S${seed}`;
    const outDir = path.join(outRoot, studyId);
    fs.mkdirSync(outDir, { recursive: true });
    console.log(`[formal] === seed ${seed}/${args.seedCount}: ${studyId} ===`);
    const run = await runRealStudy({
      dataset,
      studyId,
      armSpecs: FORMAL_ARM_SPECS.map((s) => ({ ...s })),
      budgets,
      transportForArm: (historyId, armLedger, contentMode) => {
        // The gate builds the ONLY real transport (budgeted fetch + verified
        // authorization); contentMode changes nothing about the transport.
        return import(url(path.join(LIB, 'actor.mjs'))).then(({ createAuthorizedPiTransport }) =>
          createAuthorizedPiTransport({
            authorization,
            prereg: preregView,
            dataset,
            adapterConfig,
            budgets,
            ledger: armLedger,
            evidenceVerifier,
          }).then((t) => t.transport),
        );
      },
    });

    // sidecar + audit + report
    const claims = [
      {
        claimId: 'C-E',
        contrastId: 'E0-vs-EA-vs-EB-vs-EN',
        competingExplanations: ['single-history formal run — C-E contrasts are out of scope for this run'],
        analysisUnit: 'episode',
        status: 'NOT_ESTIMABLE',
        interpretation: 'This formal run executes the C-A contrast only; C-E history contrasts were not enrolled.',
      },
      {
        claimId: 'C-A',
        contrastId: 'real-candidate-vs-summary-vs-raw-vs-none',
        competingExplanations: preregDraft.claims.find((c) => c.claimId === 'C-A').competingExplanations,
        analysisUnit: 'paired probe within episode',
        status: 'PARTIALLY_OBSERVABLE',
        interpretation: 'Formal same-channel four-condition contrast on the EA history. See comparison-report.json for the four separately-reported metric families.',
      },
    ];
    const study = buildStudySidecar({
      dataset,
      studyId,
      arms: run.arms,
      claims,
      assignment: {
        randomization: 'none — fixed paired order per seed (preregistered)',
        executionOrder: run.arms.map((a) => a.armId),
        repetitions: 1,
      },
      runtime: {
        host: 'external-model',
        model: `${authorization.od2.provider}/${authorization.od2.model}`,
        costModel: authorization.od2.costBillingSemantics ?? 'list-price ceiling reserved pre-send',
        llmJudge: 'NOT_SUPPORTED (mechanical oracle only)',
        pipelineReachabilityPolicy: 'research-side same-channel delivery; no production PD activation is claimed',
        seed,
      },
    });
    const problems = validateSidecar({
      dataset,
      study,
      adjudications: run.adjudications,
      actorInputs: run.actorInputs,
      knownStrategyIds: new Set(['REAL_ACTOR_I0']),
    });
    const hash = studyHash(study, run.adjudications);
    fs.writeFileSync(path.join(outDir, 'principle-study.json'), `${JSON.stringify(study, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(outDir, 'adjudications.jsonl'), adjudicationsToJsonl(run.adjudications), 'utf8');
    fs.writeFileSync(path.join(outDir, 'actor-inputs.json'), `${JSON.stringify(run.actorInputs, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(outDir, 'budget-audit.json'), `${JSON.stringify({ budget: run.budget, perArm: run.arms.map((a) => ({ armId: a.armId, usage: a.usage })) }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(outDir, 'study-hash.txt'), `${hash}\n`, 'utf8');
    fs.writeFileSync(path.join(outDir, 'sidecar-validation.json'), `${JSON.stringify({ problems }, null, 2)}\n`, 'utf8');
    console.log(`[formal] seed ${seed}: studyHash=${hash.slice(0, 16)}… | sidecar problems: ${problems.length} | arms: ${run.arms.length} | adjudications: ${run.adjudications.length} | stopped: ${JSON.stringify(run.stopped)}`);
    if (problems.length > 0) {
      console.error(`[formal] seed ${seed} sidecar INVALID (results kept on disk for audit, exit 1)`);
      console.error(problems.map((p) => `  - ${p}`).join('\n'));
      process.exitCode = 1;
    }
  }
  console.log(`[formal] complete — outputs under ${outRoot}`);
}

function require0(text) {
  // stable plan hash (sha256 via node crypto is intentionally avoided here —
  // canonicalJson identity is enough for a dry-run echo)
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

main().catch((err) => {
  console.error(`[formal] REFUSED/FAILED: ${err?.message ?? err}`);
  if (err?.problems) console.error(err.problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
});
