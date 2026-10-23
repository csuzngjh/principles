#!/usr/bin/env node
// PRI-1002 — PRR real A/C entry point. OFF BY DEFAULT, FAIL-CLOSED.
//
// Without an Owner-frozen record + a verified protocol approval digest + a
// trusted running commit + a resolvable decision record, this command refuses
// before any transport exists — zero model calls, zero cost. Real transports
// are ONLY built through the existing PRI-966 authorized chain
// (createAuthorizedPiTransport: OD-1/OD-2/OD-3 + budgeted fetch); `--transport
// mock` exists for wired-path rehearsals and tests and never touches a model.
//
// Usage:
//   node scripts/dev/principle-learning-lab/prr/run-prr-real.mjs \
//     --dataset <dir> --freeze <freeze.json> --prereg <prereg.json> \
//     --authorization <auth.json> [--transport mock|pi] [--out <dir>]
//
// The authorization file is the STAND-IN resolver input: it must carry
// decisionRef/approvedProtocolDigest/frozenCommitSha and is fully
// reconciled against the freeze record and the running commit. The
// production-grade resolver (Owner decision-record store) is an O-05 follow-up.

import fs from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPrrDataset } from './lib/prr-dataset.mjs';
import { validateFreezeForRealRun } from './lib/prr-freeze.mjs';
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

function trustedRunningCommitSha() {
  try {
    return execSync('git rev-parse HEAD', { cwd: path.resolve(SCRIPT_DIR, '..', '..', '..', '..'), encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const transportKind = args.transport ?? 'mock';

  // Everything is read and validated BEFORE any transport construction.
  const freeze = readJsonFile(args.freeze, 'freeze');
  const preregBody = readJsonFile(args.prereg, 'prereg');
  const authorization = readJsonFile(args.authorization, 'authorization');
  const dataset = loadPrrDataset(args.dataset); // deep-frozen snapshot
  const runningCommitSha = trustedRunningCommitSha();

  const verifyOwnerApproval = ({ decisionRef }) => {
    if (!authorization || typeof authorization !== 'object') return { verified: false, reason: 'authorization record missing' };
    if (authorization.decisionRef !== decisionRef) return { verified: false, reason: 'decisionRef does not match the authorization record' };
    if (authorization.approvedBy !== 'owner') return { verified: false, reason: 'authorization was not issued by the Owner' };
    return {
      verified: true,
      approved: authorization.approved === true,
      frozenCommitSha: typeof authorization.frozenCommitSha === 'string' ? authorization.frozenCommitSha : undefined,
      approvedProtocolDigest: typeof authorization.approvedProtocolDigest === 'string' ? authorization.approvedProtocolDigest : undefined,
    };
  };

  // Pre-flight: surface the full refusal list BEFORE transport work.
  const preflight = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval, dataset, runningCommitSha });
  if (preflight.problems.length > 0) {
    console.error(`[prr-real] REFUSED — the real-run gate found ${preflight.problems.length} problem(s):`);
    for (const p of preflight.problems) console.error(`  - ${p}`);
    console.error('[prr-real] No transport was constructed; zero model calls, zero cost.');
    process.exit(1);
  }

  let transportFor;
  if (transportKind === 'mock') {
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
    // Real model path — ONLY via the existing PRI-966 authorized chain.
    console.log('[prr-real] PI transport requested — building through createAuthorizedPiTransport (P1-02 gate).');
    const { createBudgetedFetch, createCostBudgetGuard, createHttpBudgetLedger } = await import('../lib/http-budget.mjs');
    const { createAuthorizedPiTransport } = await import('../lib/actor.mjs');
    const fz06 = freeze.items.find((i) => i.id === 'FZ-06');
    const budget = fz06 && typeof fz06.value === 'object' && fz06.value !== null ? fz06.value : null;
    if (!budget || !budget.httpRequestsPerArm || !budget.totalCostCapUsd) {
      console.error('[prr-real] REFUSED — FZ-06 does not carry a real-run budget (httpRequestsPerArm/totalCostCapUsd); a PI transport cannot be built.');
      process.exit(1);
    }
    const authorizationRecord = {
      schemaVersion: 'g2-real-run-authorization.v1',
      od1: {
        approved: true,
        decisionRef: authorization.decisionRef,
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
        httpRequestsPerOpportunity: budget.httpRequestsPerTask ?? budget.httpRequestsPerArm,
        httpRequestsPerArm: budget.httpRequestsPerArm,
        httpRequestsPerStudy: budget.httpRequestsPerStudy,
        stopCondition: budget.stopCondition ?? 'budget or error-rate stop per FZ-06/AC-S4',
        costBasisRef: budget.costBasisRef,
        costBasis: budget.costBasis,
      },
      od3: { seeds: 1, executionOrder: dataset.tasks.tasks.flatMap((t) => [`A:${t.taskId}`, `C:${t.taskId}`]), frozen: true },
    };
    const ledger = createHttpBudgetLedger({
      scope: `arm:prr-${freeze.studyId}`,
      costCapUsd: budget.perRunCostCapUsd,
      requestCap: budget.httpRequestsPerArm,
      studyCostCapUsd: budget.totalCostCapUsd,
      studyRequestCap: budget.httpRequestsPerStudy,
    });
    const { transport, adapter } = await createAuthorizedPiTransport({
      authorization: authorizationRecord,
      prereg: { status: 'OWNER_APPROVED' },
      dataset,
      adapterConfig: { provider: budget.provider, model: budget.model, baseUrl: budget.baseUrl, apiKey: process.env[budget.apiKeyEnv ?? ''] },
      ledger,
      evidenceVerifier: ({ kind: k, reference }) => {
        if (k !== 'owner-decision' || reference !== authorization.decisionRef) return { verified: false, approved: false };
        return { verified: true, approved: authorization.approved === true, reference, frozenFixtureHash: dataset.fixtureHash };
      },
    });
    void adapter;
    transportFor = () => ({ transport });
  } else {
    console.error(`[prr-real] REFUSED — unknown transport kind '${transportKind}' (mock|pi).`);
    process.exit(1);
  }

  const result = await runPrrRealAc({
    studyId: freeze.studyId,
    freeze,
    preregBody,
    dataset,
    verifyOwnerApproval,
    runningCommitSha,
    transportFor,
  });

  const outDir = args.out ?? path.join(process.cwd(), '.tmp', 'prr-real-run');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'real-run-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`[prr-real] executed=${result.executed}; adjudications=${result.adjudications.length}; result → ${path.join(outDir, 'real-run-result.json')}`);
  if (!result.executed) {
    console.error('[prr-real] REFUSED by the gate chain (see real-run-result.json refusalReasons).');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[prr-real] fatal: ${error?.stack ?? error?.message ?? error}`);
  process.exit(1);
});
