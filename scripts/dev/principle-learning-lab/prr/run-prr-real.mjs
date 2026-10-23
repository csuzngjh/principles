#!/usr/bin/env node
// PRI-1002 — PRR real A/C entry point. OFF BY DEFAULT, FAIL-CLOSED.
//
// Trust root (owner review round 7): approval evidence comes EXCLUSIVELY
// from an INDEPENDENT trusted Owner-decision resolver (--evidence-resolver).
// The resolver's attestation is strictly reconciled against the submitted
// protocol — the computed protocolApprovalDigest, the frozen commit, the
// dataset hash, the decision reference and the official pricing schedule —
// and the reconciliation MUST pass before anything runs. The caller-supplied
// authorization JSON is routing metadata only; it can never vouch for
// itself. `--transport pi` additionally requires a clean worktree (the
// running code must be provably the approved commit) and builds its
// transport ONLY through the existing PRI-966 authorized chain
// (createAuthorizedPiTransport: OD-1/2/3 + budgeted fetch). `--transport
// mock` exists for wired-path rehearsals and tests and never touches a
// model.
//
// Usage:
//   node scripts/dev/principle-learning-lab/prr/run-prr-real.mjs \
//     --dataset <dir> --freeze <freeze.json> --prereg <prereg.json> \
//     --authorization <auth.json> [--transport mock|pi] [--out <dir>] \
//     [--evidence-resolver <module.mjs>] [--allow-dirty-worktree-for-mock]
//
// The evidence resolver module must default-export verify() resolving the
// AUTHORITATIVE Owner decision record and the official pricing schedule.

import fs from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPrrDataset, healthCheckPrrDataset } from './lib/prr-dataset.mjs';
import { protocolApprovalDigest, validateFreezeForRealRun } from './lib/prr-freeze.mjs';
import { runPrrRealAc } from './lib/prr-real-runner.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dataset') args.dataset = argv[++i];
    else if (a === '--freeze') args.freeze = argv[++i];
    else if (a === '--prereg') args.prereg = argv[++i];
    else if (a === '--authorization') args.authorization = argv[++i];
    else if (a === '--transport') args.transport = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--evidence-resolver') args.evidenceResolver = argv[++i];
    else if (a === '--allow-dirty-worktree-for-mock') args.allowDirtyForMock = true;
    else {
      console.error(`[prr-real] unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function readJsonFile(file, label) {
  if (!file) {
    console.error(`[prr-real] REFUSED: --${label} is required. This run is OFF until an Owner-frozen protocol is supplied (no defaults, no env fallback).`);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`[prr-real] REFUSED: cannot read ${label} file: ${error.message}`);
    process.exit(1);
  }
}

function runningCommitAndWorktreeState() {
  try {
    const commit = execSync('git rev-parse HEAD', { cwd: path.resolve(SCRIPT_DIR, '..', '..', '..', '..'), encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { cwd: path.resolve(SCRIPT_DIR, '..', '..', '..', '..'), encoding: 'utf8' }).trim();
    return { commit, dirty: dirty.length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const transportKind = args.transport ?? 'mock';

  // ── Data admission FIRST (before any transport construction) ──
  const freeze = readJsonFile(args.freeze, 'freeze');
  const preregBody = readJsonFile(args.prereg, 'prereg');
  readJsonFile(args.authorization, 'authorization'); // routing metadata; NOT approval evidence (round 7)
  const dataset = loadPrrDataset(args.dataset); // deep-frozen snapshot
  const healthProblems = healthCheckPrrDataset(dataset);
  if (healthProblems.length > 0) {
    console.error(`[prr-real] REFUSED — dataset failed semantic admission (${healthProblems.length} problem(s)):`);
    for (const p of healthProblems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const { commit: runningCommitSha, dirty: worktreeDirty } = runningCommitAndWorktreeState();
  if (transportKind === 'pi' && !args.evidenceResolver) {
    console.error('[prr-real] REFUSED — --transport pi requires --evidence-resolver <module>: an INDEPENDENT trusted Owner-decision resolver. The authorization file alone cannot vouch for itself, and the O-05 production resolver is not yet available — the real execution path is NOT ready without it.');
    process.exit(1);
  }
  if (transportKind === 'pi' && worktreeDirty) {
    // A dirty worktree means the executing code may differ from the approved
    // commit — a real run can never start from one.
    console.error('[prr-real] REFUSED — worktree is dirty (uncommitted changes): the running code cannot be proven identical to the Owner-approved frozen commit. Commit or stash and retry.');
    process.exit(1);
  }

  // ── Owner review round 7 (A): the approval evidence is bound to the
  // COMPLETE protocol. The digest is COMPUTED here from the submitted freeze
  // record + prereg body and handed to the resolver as the expectation; the
  // resolver must return its own independently-saved attestation, and every
  // field it returns is strictly reconciled below. Missing resolver + pi =
  // refusal; the authorization JSON is routing metadata only.
  const expectedDigest = protocolApprovalDigest({ freeze, preregBody });
  const expectedCommitSha = freeze.ownerApproval?.frozenCommitSha;
  const decisionRef = freeze.ownerApproval?.decisionRef;
  const fz06 = freeze.items.find((i) => i.id === 'FZ-06');
  const budget = fz06 && typeof fz06.value === 'object' && fz06.value !== null ? fz06.value : null;

  let trustedEvidence = null;
  if (args.evidenceResolver) {
    let trusted;
    try {
      const resolverUrl = `file://${path.resolve(args.evidenceResolver)}`;
      const module = await import(resolverUrl);
      trusted = module.verify ?? module.default?.verify ?? module.default;
      if (typeof trusted !== 'function') throw new Error('module must export verify()');
    } catch (error) {
      console.error(`[prr-real] REFUSED — cannot load the trusted evidence resolver: ${error.message}`);
      process.exit(1);
    }
    try {
      trustedEvidence = {
        ownerDecision: await trusted({
          kind: 'owner-decision',
          decisionRef,
          expectedProtocolDigest: expectedDigest,
          expectedCommitSha,
          expectedFixtureHash: dataset.fixtureHash,
          expectedBudget: budget,
        }),
        pricing: budget?.costBasisRef
          ? await trusted({ kind: 'cost-basis', reference: budget.costBasisRef, provider: budget.provider, model: budget.model, expectedBudget: budget })
          : null,
      };
    } catch (error) {
      console.error(`[prr-real] REFUSED — trusted resolver failure: ${error.message}`);
      process.exit(1);
    }
    const od = trustedEvidence.ownerDecision;
    const pricing = trustedEvidence.pricing;
    const reconciliations = [
      [!od || typeof od !== 'object', 'resolver returned no owner-decision evidence'],
      [od && od.verified !== true, 'resolver did not verify the decision record'],
      [od && od.approved !== true, 'resolver confirmed the decision record is not an approval'],
      [od && od.decisionRef !== decisionRef, `resolver decisionRef (${String(od?.decisionRef)}) does not match the freeze record (${String(decisionRef)})`],
      [od && od.approvedProtocolDigest !== expectedDigest, 'resolver protocol digest does not match the submitted protocol (a frozen value, the prereg body, or the studyId changed after approval)'],
      [od && od.frozenCommitSha !== expectedCommitSha, 'resolver frozen commit does not match the freeze record'],
      [od && od.frozenFixtureHash !== dataset.fixtureHash, 'resolver dataset hash does not match the loaded dataset'],
      [!pricing || typeof pricing !== 'object', 'resolver returned no official pricing evidence (required by FZ-06)'],
      [pricing && pricing.verified !== true, 'resolver did not verify the official pricing schedule'],
      [pricing && pricing.reference !== budget?.costBasisRef, 'resolver pricing reference does not match the frozen costBasisRef'],
    ];
    const failed = reconciliations.filter(([bad]) => bad).map(([, message]) => message);
    if (failed.length > 0) {
      console.error(`[prr-real] REFUSED — trusted-evidence reconciliation FAILED (${failed.length}):`);
      for (const message of failed) console.error(`  - ${message}`);
      console.error('[prr-real] No transport was constructed; zero model calls, zero cost.');
      process.exit(1);
    }
    console.log('[prr-real] Trusted evidence reconciled: approval, protocol digest, frozen commit, dataset hash and pricing all match the authoritative records.');
  } else if (transportKind === 'pi') {
    console.error('[prr-real] REFUSED — --transport pi requires --evidence-resolver <module>: an INDEPENDENT trusted Owner-decision resolver. The authorization file alone cannot vouch for itself, and the O-05 production resolver is not yet available — the real execution path is NOT ready without it.');
    process.exit(1);
  }

  // The gate's evidence comes ONLY from the reconciled resolver attestation.
  // Without a resolver there is no independent proof of approval and the
  // gate refuses (fail-closed) — the authorization file alone is never
  // enough, and nothing is filled in from local data.
  const verifyOwnerApproval = trustedEvidence
    ? ({ decisionRef: gateDecisionRef }) => {
      const od = trustedEvidence.ownerDecision;
      if (od.decisionRef !== gateDecisionRef) return { verified: false, reason: 'resolver decisionRef does not match the freeze record' };
      return {
        verified: od.verified === true,
        approved: od.approved === true,
        decisionRef: od.decisionRef,
        frozenCommitSha: od.frozenCommitSha,
        approvedProtocolDigest: od.approvedProtocolDigest,
        frozenFixtureHash: od.frozenFixtureHash,
      };
    }
    : () => ({ verified: false, reason: 'no trusted resolver provided — the authorization file is not independent evidence of approval' });

  // Pre-flight: surface the full refusal list BEFORE transport work.
  const preflight = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval, dataset, runningCommitSha });
  if (preflight.problems.length > 0) {
    console.error(`[prr-real] REFUSED — the real-run gate found ${preflight.problems.length} problem(s):`);
    for (const p of preflight.problems) console.error(`  - ${p}`);
    console.error('[prr-real] No transport was constructed; zero model calls, zero cost.');
    process.exit(1);
  }

  let transportFor = null;
  let budgetTelemetry = null;

  if (transportKind === 'mock') {
    if (worktreeDirty && !args.allowDirtyForMock) {
      console.error('[prr-real] REFUSED — worktree is dirty. Mock rehearsals may pass --allow-dirty-worktree-for-mock explicitly; real runs can never start dirty.');
      process.exit(1);
    }
    const scriptedFile = args.out && fs.existsSync(path.join(args.out, 'mock-script.json'))
      ? path.join(args.out, 'mock-script.json')
      : null;
    const scripted = scriptedFile ? JSON.parse(fs.readFileSync(scriptedFile, 'utf8')) : {};
    console.log('[prr-real] MOCK transport (wired-path rehearsal; no model is called).');
    transportFor = () => ({
      async complete({ taskId }) {
        const scriptedRow = scripted[taskId];
        if (!scriptedRow) throw Object.assign(new Error(`no scripted behavior for ${taskId}`), { kind: 'no_response' });
        return { payload: scriptedRow.payload, usage: scriptedRow.usage ?? null };
      },
    });
  } else if (transportKind === 'pi') {
    if (!budget || !budget.httpRequestsPerArm || !budget.httpRequestsPerStudy || !budget.perRunCostCapUsd || !budget.totalCostCapUsd
      || !budget.httpRequestsPerOpportunity) {
      console.error('[prr-real] REFUSED — FZ-06 must freeze the complete budget shape (httpRequestsPerOpportunity/PerArm/PerStudy, perRunCostCapUsd, totalCostCapUsd, provider, model, baseUrl, apiKeyEnv, credentialsAvailable, costBasisRef, costBasis) before a PI transport can be built.');
      process.exit(1);
    }

    console.log('[prr-real] PI transport requested — building through createAuthorizedPiTransport (P1-02 gate) with trusted evidence.');
    const { createHttpBudgetLedger } = await import('../lib/http-budget.mjs');
    const { createAuthorizedPiTransport } = await import('../lib/actor.mjs');

    // Correct hierarchy per lib/http-budget.mjs: study parent (whole-study
    // caps) → arm child (per-arm caps). createAuthorizedPiTransport checks
    // arm==od2.per-run and study==od2.total on BOTH cost and request levels.
    const studyLedger = createHttpBudgetLedger({
      scope: `study:prr-${freeze.studyId}`,
      cap: budget.httpRequestsPerStudy,
      costCapUsd: budget.totalCostCapUsd,
      reason: 'PRR real A/C whole-study budget (FZ-06)',
    });
    const armLedger = createHttpBudgetLedger({
      scope: `arm:prr-${freeze.studyId}`,
      cap: budget.httpRequestsPerArm,
      costCapUsd: budget.perRunCostCapUsd,
      parent: studyLedger,
      reason: 'PRR real A/C per-arm budget (FZ-06)',
    });

    // OD-3 reads dataset.histories as the frozen execution order; PRR datasets
    // carry tasks, so the runner's exact execution order is exposed as the
    // compatibility view (same content, same order the runner will execute).
    const executionOrder = dataset.tasks.tasks.flatMap((t) => [`A:${t.taskId}`, `C:${t.taskId}`]);
    const datasetForGate = {
      ...dataset,
      histories: Object.fromEntries(executionOrder.map((armId) => [armId, { prrExecutionArm: armId }])),
    };

    const authorizationRecord = {
      schemaVersion: 'g2-real-run-authorization.v1',
      od1: {
        approved: true,
        decisionRef, // freeze-derived; reconciled against the resolver above
        frozenFixtureHash: dataset.fixtureHash,
      },
      od2: {
        provider: budget.provider,
        model: budget.model,
        baseUrl: budget.baseUrl,
        apiKeyEnv: budget.apiKeyEnv,
        credentialsAvailable: budget.credentialsAvailable === true,
        perRunCostCapUsd: budget.perRunCostCapUsd,
        totalCostCapUsd: budget.totalCostCapUsd,
        httpRequestsPerOpportunity: budget.httpRequestsPerOpportunity,
        httpRequestsPerArm: budget.httpRequestsPerArm,
        httpRequestsPerStudy: budget.httpRequestsPerStudy,
        stopCondition: budget.stopCondition ?? 'budget or error-rate stop per FZ-06/AC-S4',
        costBasisRef: budget.costBasisRef,
        costBasis: budget.costBasis,
      },
      od3: { seeds: 1, executionOrder, frozen: true },
    };
    const budgetsForGate = {
      httpRequestsPerOpportunity: budget.httpRequestsPerOpportunity,
      httpRequestsPerArm: budget.httpRequestsPerArm,
      httpRequestsPerStudy: budget.httpRequestsPerStudy,
      perRunCostCapUsd: budget.perRunCostCapUsd,
      totalCostCapUsd: budget.totalCostCapUsd,
    };

    // Round 7: PURE passthrough of the reconciled resolver attestation.
    // Nothing is filled in from local data — a field the resolver did not
    // attest stays undefined, and the factory's own OD checks then refuse.
    const trustedEvidenceVerifier = ({ kind }) => {
      const od = trustedEvidence.ownerDecision;
      const pricing = trustedEvidence.pricing;
      if (kind === 'owner-decision') {
        return {
          verified: od.verified === true,
          approved: od.approved === true,
          reference: od.decisionRef,
          frozenFixtureHash: od.frozenFixtureHash,
        };
      }
      if (kind === 'cost-basis') {
        return {
          verified: pricing.verified === true,
          reference: pricing.reference,
          provider: pricing.provider,
          model: pricing.model,
          currency: pricing.currency,
          inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
          outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
          maxInputTokensPerRequest: pricing.maxInputTokensPerRequest,
          maxOutputTokensPerRequest: pricing.maxOutputTokensPerRequest,
          effectiveDate: pricing.effectiveDate,
        };
      }
      return { verified: false, approved: false };
    };

    const adapterConfig = {
      provider: budget.provider,
      model: budget.model,
      baseUrl: budget.baseUrl,
      apiKeyEnv: budget.apiKeyEnv, // drift-checked against od2.apiKeyEnv by the gate
    };
    const { transport } = await createAuthorizedPiTransport({
      authorization: authorizationRecord,
      prereg: { status: 'OWNER_APPROVED' }, // derived: the PRR freeze gate above passed with zero problems
      dataset: datasetForGate,
      adapterConfig,
      budgets: budgetsForGate,
      ledger: armLedger,
      evidenceVerifier: trustedEvidenceVerifier,
    });
    // The Pi transport is a stateless single-turn `complete()` — sharing the
    // instance across A/C is safe; isolation comes from the isolated delivery
    // content and the absence of session state (preregistration requirement).
    transportFor = () => transport;
    budgetTelemetry = () => armLedger.snapshot();
    console.log('[prr-real] PI transport constructed through the full authorization chain.');
  } else {
    console.error(`[prr-real] REFUSED — unknown transport kind '${transportKind}' (mock|pi).`);
    process.exit(1);
  }

  const studyRequestCap = Number.isSafeInteger(budget?.httpRequestsPerStudy) ? budget.httpRequestsPerStudy : null;
  const armRequestCap = Number.isSafeInteger(budget?.httpRequestsPerArm) ? budget.httpRequestsPerArm : null;
  const result = await runPrrRealAc({
    studyId: freeze.studyId,
    freeze,
    preregBody,
    dataset,
    verifyOwnerApproval,
    runningCommitSha,
    transportFor,
    studyRequestCap,
    armRequestCap,
    budgetTelemetry,
  });

  const outDir = args.out ?? path.join(process.cwd(), '.tmp', 'prr-real-run');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'real-run-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`[prr-real] executed=${result.executed}; adjudications=${result.adjudications.length}; notExecuted=${result.notExecutedTasks.length}; result → ${path.join(outDir, 'real-run-result.json')}`);
  if (!result.executed) {
    console.error('[prr-real] REFUSED by the gate chain (see real-run-result.json refusalReasons).');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[prr-real] fatal: ${error?.stack ?? error?.message ?? error}`);
  process.exit(1);
});
