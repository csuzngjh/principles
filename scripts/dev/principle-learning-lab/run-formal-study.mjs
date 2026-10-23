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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(SCRIPT_DIR, 'lib');
const url = (p) => 'file:///' + p.replace(/\\/g, '/');

const { loadDataset, canonicalJson } = await import(url(path.join(LIB, 'fixture.mjs')));
const {
  buildStudySidecar,
  adjudicationsToJsonl,
  studyHash,
  validateSidecar,
} = await import(url(path.join(LIB, 'sidecar.mjs')));
const { runRealStudy } = await import(url(path.join(LIB, 'real-runner.mjs')));
const { verifyRealRunAuthorization } = await import(url(path.join(LIB, 'actor.mjs')));
const { createFileEvidenceVerifier, composeApprovedPreregView } = await import(url(path.join(LIB, 'evidence-verifier.mjs')));

function parseArgs(argv) {
  const args = { seedCount: 1, startSeed: 1, out: null, dryRun: false, authorization: null, dataset: null, arms: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--authorization') args.authorization = argv[++i];
    else if (a === '--seed-count') args.seedCount = Number(argv[++i]);
    else if (a === '--start-seed') args.startSeed = Number(argv[++i]);
    else if (a === '--dataset') args.dataset = argv[++i];
    else if (a === '--arms') args.arms = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

// All arm plans are the preregistration's OWN contrasts — nothing here
// redefines the experiment:
//   formal-ca (v1): EA x {policy, summary, raw, none} — the completed C-A round.
//   formal-ce (v1): E0/EA/EB/EN x policy — the completed C-E round.
//   formal-v2 (PLE-PILOT-02-G): the five-condition mechanism-validation plan —
//     E0 baseline, G generic-context control (v2 optional history), EA/EB/EN
//     lesson histories, every one through the same policy (I0) pipeline.
const FORMAL_ARM_PLANS = {
  'formal-ca': [
    { historyId: 'EA', contentMode: 'policy' },
    { historyId: 'EA', contentMode: 'summary' },
    { historyId: 'EA', contentMode: 'raw' },
    { historyId: 'EA', contentMode: 'none' },
  ],
  'formal-ce': [
    { historyId: 'E0', contentMode: 'policy' },
    { historyId: 'EA', contentMode: 'policy' },
    { historyId: 'EB', contentMode: 'policy' },
    { historyId: 'EN', contentMode: 'policy' },
  ],
  'formal-v2': [
    { historyId: 'E0', contentMode: 'policy' },
    { historyId: 'G', contentMode: 'policy' },
    { historyId: 'EA', contentMode: 'policy' },
    { historyId: 'EB', contentMode: 'policy' },
    { historyId: 'EN', contentMode: 'policy' },
  ],
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.authorization) {
    console.error('[formal] REFUSED: --authorization <file> is required (fail-closed)');
    process.exit(1);
  }
  const armPlanName = args.arms ?? 'formal-ca';
  const FORMAL_ARM_SPECS = FORMAL_ARM_PLANS[armPlanName];
  if (!FORMAL_ARM_SPECS) {
    console.error(`[formal] REFUSED: --arms must be one of: ${Object.keys(FORMAL_ARM_PLANS).join(', ')}`);
    process.exit(1);
  }
  if (!Number.isSafeInteger(args.seedCount) || args.seedCount < 1 || args.seedCount > 3) {
    console.error('[formal] REFUSED: --seed-count must be an integer in [1,3] (preregistered plan)');
    process.exit(1);
  }
  if (!Number.isSafeInteger(args.startSeed) || args.startSeed < 1 || args.startSeed > 3) {
    console.error('[formal] REFUSED: --start-seed must be an integer in [1,3] (preregistered plan)');
    process.exit(1);
  }
  if (args.startSeed + args.seedCount - 1 > 3) {
    console.error(`[formal] REFUSED: seeds ${args.startSeed}..${args.startSeed + args.seedCount - 1} exceed the preregistered 1-3 range`);
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
  // The dataset directory selects the research round: v1 `fixtures` (the
  // frozen PLE-PILOT-01 world of the completed C-A/C-E rounds) or v2
  // `fixtures-v2` (PLE-PILOT-02: adds the G control, repairs the P3
  // affordance — its own independent hash).
  const datasetDir = args.dataset ? path.resolve(args.dataset) : path.join(SCRIPT_DIR, 'fixtures');
  const dataset = loadDataset(datasetDir);
  console.log(`[formal] dataset ${dataset.manifest.datasetId} fixtureHash=${dataset.fixtureHash.slice(0, 12)}… (freshly computed)`);

  // 4. evidence resolution + gate verification (throws BEFORE any transport).
  const evidenceVerifier = createFileEvidenceVerifier({ baseDir: authDir });
  const decisionRef = authorization.od1?.decisionRef;
  if (typeof decisionRef !== 'string' || decisionRef.length === 0) {
    console.error('[formal] REFUSED: authorization.od1.decisionRef missing');
    process.exit(1);
  }
  // Research-protocol binding FIRST: the preregistration lives outside the
  // fixture hash, so it gets an INDEPENDENT hash that must match (a) the
  // Owner decision record and (b) the authorization record — any prereg edit
  // (hypotheses/conditions/order) fails closed even with an unchanged
  // fixtureHash.
  const expectedPreregistrationHash = dataset.preregistrationHash;
  if (expectedPreregistrationHash === undefined) {
    console.error('[formal] REFUSED: the dataset directory carries no preregistration.json — a formal run without a hash-bound research protocol is refused (fail-closed)');
    process.exit(1);
  }
  const decision = evidenceVerifier({ kind: 'owner-decision', reference: decisionRef, expectedFixtureHash: dataset.fixtureHash, expectedPreregistrationHash });
  if (decision.fixtureHash !== dataset.fixtureHash) {
    console.error(`[formal] REFUSED: Owner decision approves fixtureHash ${decision.fixtureHash.slice(0, 12)}… but the loaded dataset hashes to ${dataset.fixtureHash.slice(0, 12)}… (drift = no run)`);
    process.exit(1);
  }
  const costEvidence = evidenceVerifier({ kind: 'cost-basis', reference: authorization.od2.costBasisRef });
  const preregDraft = JSON.parse(fs.readFileSync(path.join(datasetDir, 'preregistration.json'), 'utf8'));
  // Order-scheme single source of truth: the preregistration's
  // contrastDesign.armOrder. The built-in per-seed table must match it or
  // the run refuses (no silent plan substitution).
  if (armPlanName === 'formal-v2') {
    const preregOrders = preregDraft.contrastDesign?.armOrder?.seedOrders;
    const expectedOrders = { 1: ['E0', 'G', 'EA', 'EB', 'EN'], 2: ['EA', 'EB', 'EN', 'E0', 'G'], 3: ['EN', 'E0', 'G', 'EA', 'EB'] };
    if (!preregOrders || JSON.stringify(preregOrders) !== JSON.stringify(expectedOrders)) {
      console.error('[formal] REFUSED: the loaded preregistration armOrder does not match the pre-registered Latin-rectangle order table — research-protocol drift (fail-closed)');
      process.exit(1);
    }
  }
  const preregView = composeApprovedPreregView({
    prereg: preregDraft,
    decisionRecord: { approved: true, reference: decisionRef, decidedBy: decision.decidedBy, decidedAt: decision.decidedAt },
  });

  // 5. credentials must exist in the environment BEFORE any call is planned.
  // The variable NAME is never logged — only the fact of absence.
  const apiKey = process.env[authorization.od2.apiKeyEnv];
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    console.error('[formal] REFUSED: the credential environment variable named in authorization.od2.apiKeyEnv is not set — credentials missing (fail-closed, zero HTTP)');
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
  // Research-protocol binding is enforced ABOVE (decision resolution carries
  // both expected hashes). The gate re-checks the authorization copy.
  verifyRealRunAuthorization({
    authorization,
    prereg: preregView,
    dataset,
    adapterConfig,
    budgets,
    evidenceVerifier,
    expectedPreregistrationHash,
  });
  console.log(`[formal] authorization verified (decision: ${decision.decidedBy} @ ${decision.decidedAt}; cost basis effective ${costEvidence.effectiveDate}, officialPriceVerified=${costEvidence.officialPriceVerified})`);
  console.log(`[formal] plan-quota semantics: ${authorization.od2.costBillingSemantics ?? 'per-token list-price ceiling reserved; actual plan draw recorded from usage'}`);

  // 7. arm list + seed window + a machine-checkable plan summary. The seed
  // window and output-dir occupancy are checked BEFORE the dry-run return so
  // a dry run audits the exact plan (and collisions) a real run would hit.
  const studyIdBase = authorization.studyId ?? 'PLE-PILOT-01-FORMAL';

  // Order counterbalancing (v2 only): a fixed arm order across all seeds
  // would confound condition with wall-clock position (provider drift,
  // time-of-day effects) — with 3 seeds the correlation would be perfect.
  // The deterministic Latin rectangle below (pre-registered in the v2
  // preregistration, NO randomness) gives every condition a mix of early /
  // middle / late positions. Within-seed pairing (the analysis unit) is
  // untouched: each seed still runs all five conditions back-to-back in one
  // isolated session chain. v1 plans keep their historical fixed order
  // (their rounds are complete).
  const V2_SEED_ARM_ORDERS = {
    1: [0, 1, 2, 3, 4], // E0 → G → EA → EB → EN
    2: [2, 3, 4, 0, 1], // EA → EB → EN → E0 → G
    3: [4, 0, 1, 2, 3], // EN → E0 → G → EA → EB
  };
  const armSpecsForSeed = (seed) => {
    const order = armPlanName === 'formal-v2' ? V2_SEED_ARM_ORDERS[seed] : null;
    const specs = order
      ? order.map((i) => ({ ...FORMAL_ARM_SPECS[i] }))
      : FORMAL_ARM_SPECS.map((s) => ({ ...s }));
    return { specs, orderLabel: specs.map((s) => `${s.historyId}:${s.contentMode}`).join(' → ') };
  };
  if (armPlanName === 'formal-v2') {
    console.log('[formal] arms (formal-v2): per-seed deterministic Latin rectangle —');
    for (const seed of [1, 2, 3]) console.log(`  seed ${seed}: ${armSpecsForSeed(seed).orderLabel}`);
  } else {
    console.log(`[formal] arms (${armPlanName}): ${FORMAL_ARM_SPECS.map((s) => `${s.historyId}:${s.contentMode}`).join(' → ')} × ${args.seedCount} seed(s)`);
  }

  // Study ids: the single-seed-from-1 invocation keeps the historical base id
  // (Seed 1's on-disk identity); every other seed gets its own -S<seed> id so
  // completed seeds are NEVER re-run or overwritten.
  const outRoot = args.out ?? path.join(SCRIPT_DIR, '..', '..', '..', '.tmp', 'principle-learning-lab', 'FORMAL');
  const seedPlan = [];
  for (let seed = args.startSeed; seed < args.startSeed + args.seedCount; seed += 1) {
    const studyId = args.seedCount === 1 && args.startSeed === 1 ? studyIdBase : `${studyIdBase}-S${seed}`;
    seedPlan.push({ seed, studyId, outDir: path.join(outRoot, studyId) });
  }
  for (const plan of seedPlan) {
    if (fs.existsSync(path.join(plan.outDir, 'principle-study.json'))) {
      console.error(`[formal] REFUSED: ${plan.outDir} already holds a completed study — completed seeds are never re-run or overwritten`);
      process.exit(1);
    }
  }
  console.log(`[formal] seeds ${args.startSeed}..${args.startSeed + args.seedCount - 1} → ${seedPlan.map((p) => p.studyId).join(', ')}`);

  if (args.dryRun) {
    const orderPlan = armPlanName === 'formal-v2'
      ? Object.fromEntries([1, 2, 3].map((seed) => [seed, armSpecsForSeed(seed).orderLabel]))
      : { fixed: FORMAL_ARM_SPECS.map((s) => `${s.historyId}:${s.contentMode}`).join(' → ') };
    console.log('[formal] DRY RUN — authorization, credentials, hash, caps, seed window and output occupancy all verified; zero model calls made. Plan hash:', require0(canonicalJson({ armPlanName, studyIdBase, budgets, adapterConfig, armSpecs: FORMAL_ARM_SPECS, seedCount: args.seedCount, seedPlan: seedPlan.map((p) => p.studyId), orderPlan })));
    return;
  }

  // 8-10. run per seed, each seed = one isolated study (own ledgers/arms).
  fs.mkdirSync(outRoot, { recursive: true });
  for (const { seed, studyId, outDir } of seedPlan) {
    fs.mkdirSync(outDir, { recursive: true });
    const { orderLabel } = armSpecsForSeed(seed);
    console.log(`[formal] === seed ${seed} (range ${args.startSeed}..${args.startSeed + args.seedCount - 1}): ${studyId} | arms: ${orderLabel} ===`);
    const run = await runRealStudy({
      dataset,
      studyId,
      armSpecs: armSpecsForSeed(seed).specs,
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

    // sidecar + audit + report. The enrolled claim is the one this plan
    // actually contrasts; the others stay honestly NOT_ESTIMABLE.
    const preregClaim = (id, fallbackCompeting) => {
      const found = (preregDraft.claims ?? []).find((c) => c.claimId === id);
      return { competingExplanations: found?.competingExplanations ?? fallbackCompeting };
    };
    const claims = armPlanName === 'formal-v2'
      ? [
          {
            claimId: 'C-G',
            contrastId: 'E0-vs-G-vs-EA-vs-EB-vs-EN',
            competingExplanations: preregClaim('C-G', ['length differences', 'pipeline differences']).competingExplanations,
            analysisUnit: 'paired opportunity within seed',
            status: 'PARTIALLY_OBSERVABLE',
            interpretation: 'Mechanism-validation pilot: generic-context control vs lesson histories vs empty baseline, same I0 pipeline. Four separately-reported layers in the adjudications; length-band constraint and post-hoc length reporting per the v2 prereg.',
          },
          {
            claimId: 'C-E2',
            contrastId: 'EA-vs-EB-vs-EN within v2 (P3 affordance-repaired)',
            competingExplanations: preregClaim('C-E2', ['single-model limits']).competingExplanations,
            analysisUnit: 'paired opportunity within seed',
            status: 'NOT_ESTIMABLE',
            interpretation: 'Secondary contrast; evaluated only in the v2 summary report, not claimed by the run itself.',
          },
        ]
      : [
          {
            claimId: 'C-E',
            contrastId: 'E0-vs-EA-vs-EB-vs-EN',
            competingExplanations: preregDraft.claims.find((c) => c.claimId === 'C-E').competingExplanations,
            analysisUnit: 'episode',
            status: enrolledCE ? 'PARTIALLY_OBSERVABLE' : 'NOT_ESTIMABLE',
            interpretation: enrolledCE
              ? 'Formal four-history contrast through the same policy generation. See comparison layers in the adjudications; EA-vs-EN equivalence is the stability requirement.'
              : 'This run executed the C-A contrast only; the C-E history contrasts were not enrolled.',
          },
          {
            claimId: 'C-A',
            contrastId: 'real-candidate-vs-summary-vs-raw-vs-none',
            competingExplanations: preregDraft.claims.find((c) => c.claimId === 'C-A').competingExplanations,
            analysisUnit: 'paired probe within episode',
            status: enrolledCE ? 'NOT_ESTIMABLE' : 'PARTIALLY_OBSERVABLE',
            interpretation: enrolledCE
              ? 'This run executed the C-E contrast only; the C-A content conditions were not enrolled (C-A three-seed evidence lives in runs/formal-2026-10-23).'
              : 'Formal same-channel four-condition contrast on the EA history. See comparison-report.json for the four separately-reported metric families.',
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
