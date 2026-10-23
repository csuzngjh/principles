// PRI-1002 — real A/C CLI-path authorization reconciliation suite (round 7).
//
// Exercises the REAL CLI (spawned via prr-real-cli-spawn.mjs) against a temp
// fixture set with an independently-written trusted resolver module:
// protocol-digest, frozen-commit, dataset-hash, decision-ref and pricing
// mismatches must all refuse at the evidence-reconciliation stage — BEFORE
// any transport construction. A fully matching resolver completes the
// authorization chain and the mock transport finishes the study. Zero real
// models, zero network. (CLI spawning itself lives in
// prr-real-cli-spawn.mjs, which uses execFileSync with a fixed argument
// array and shell:false.)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { protocolApprovalDigest, buildDraftFreeze } from '../dev/principle-learning-lab/prr/lib/prr-freeze.mjs';
import { loadPrrDataset } from '../dev/principle-learning-lab/prr/lib/prr-dataset.mjs';
import { runPrrRealAc } from '../dev/principle-learning-lab/prr/lib/prr-real-runner.mjs';
import { buildPrrDatasetFiles, writePrrDataset } from './prr-test-fixtures';
import { runCli, gitHead } from './prr-real-cli-spawn.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-cli-'));
const datasetDir = writePrrDataset(path.join(tmpRoot, 'dataset'));
const dataset = loadPrrDataset(datasetDir);
const preregBody = { studyId: 'PRR-AC-SYNTH-01-real', note: 'cli prereg body' };
// The frozen-commit fixture MUST pin the real running commit — the gate
// refuses a run whose executing commit differs from the approved one.
const COMMIT = gitHead();

/** Build the freeze record for the given dataset hash + commit. */
function buildFreeze({ fixtureHash, commitSha, decisionRef = 'owner-decision-1', minPairs = 3 }) {
  const draft = buildDraftFreeze({ studyId: preregBody.studyId, preregBody });
  return {
    ...draft,
    status: 'OWNER_APPROVED_FROZEN',
    items: draft.items.map((item: any) => {
      let value: unknown = { frozen: true };
      if (item.id === 'FZ-01') value = { taskSetHash: fixtureHash };
      if (item.id === 'FZ-06') value = {
        provider: 'mock-provider', model: 'mock-model', baseUrl: 'https://mock.invalid/v1', apiKeyEnv: 'MOCK_PRR_API_KEY',
        credentialsAvailable: true, httpRequestsPerOpportunity: 4, httpRequestsPerArm: 40, httpRequestsPerStudy: 80,
        perRunCostCapUsd: 1, totalCostCapUsd: 2, costBasisRef: 'official-pricing-ref-1', stopCondition: 'test',
        costBasis: { provider: 'mock-provider', model: 'mock-model', currency: 'USD', inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2, maxInputTokensPerRequest: 1024, maxOutputTokensPerRequest: 1024, effectiveDate: '2026-01-01' },
      };
      if (item.id === 'FZ-11') value = { minPairs, derivationBasis: 'owner-frozen detectable difference' };
      return { ...item, status: 'VALUE_FROZEN', value, ownerApprovalRef: decisionRef };
    }),
    ownerApproval: { approvedBy: 'owner', decisionRef, frozenCommitSha: commitSha },
  };
}

/** An INDEPENDENT trusted resolver module: it holds the approved protocol
 * snapshot and only attests what matches its own records. */
function writeResolverModule(dir: string, approved: { decisionRef: string; digest: string; commitSha: string; fixtureHash: string; costBasisRef: string; pricingVerified: boolean }) {
  const module = `
export async function verify(req) {
  const APPROVED = {
    decisionRef: ${JSON.stringify(approved.decisionRef)},
    approvedProtocolDigest: ${JSON.stringify(approved.digest)},
    frozenCommitSha: ${JSON.stringify(approved.commitSha)},
    frozenFixtureHash: ${JSON.stringify(approved.fixtureHash)},
  };
  if (req.kind === 'owner-decision') {
    return {
      verified: true,
      approved: true,
      decisionRef: APPROVED.decisionRef,
      approvedProtocolDigest: APPROVED.approvedProtocolDigest,
      frozenCommitSha: APPROVED.frozenCommitSha,
      frozenFixtureHash: APPROVED.frozenFixtureHash,
    };
  }
  if (req.kind === 'cost-basis') {
    return {
      verified: ${approved.pricingVerified},
      reference: ${JSON.stringify(approved.costBasisRef)},
      provider: 'mock-provider',
      model: 'mock-model',
      currency: 'USD',
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 2,
      maxInputTokensPerRequest: 1024,
      maxOutputTokensPerRequest: 1024,
      effectiveDate: '2026-01-01',
    };
  }
  return { verified: false };
}
`;
  const file = path.join(dir, `resolver-${Math.random().toString(36).slice(2, 8)}.mjs`);
  fs.writeFileSync(file, module, 'utf8');
  return file;
}

function writeMockScript(dir: string) {
  const scripted = {
    'A:t1-history-decides': { payload: { decisionId: 'd-generic-cautious-path', evidenceRefs: ['ev-current-manifest'] } },
    'C:t1-history-decides': { payload: { decisionId: 'd-add-compat-shims', evidenceRefs: ['ev-consumer-incident-ledger', 'ev-current-manifest'] } },
    'A:t3-old-context-conflicts': { payload: { decisionId: 'd-daytime-window-with-owner-note', evidenceRefs: ['ev-current-runbook'] } },
    'C:t3-old-context-conflicts': { payload: { decisionId: 'd-night-window-batch', evidenceRefs: ['ev-current-runbook'] } },
    'A:t2-c-resists-history': { payload: { decisionId: 'd-accept-signed-package', evidenceRefs: ['ev-upstream-signature'] } },
    'C:t2-c-resists-history': { payload: { decisionId: 'd-accept-signed-package', evidenceRefs: ['ev-upstream-signature'] } },
    'A:t3-c-rejects-stale-history': { payload: { decisionId: 'd-shadow-first-then-primary', evidenceRefs: ['ev-active-active-architecture'] } },
    'C:t3-c-rejects-stale-history': { payload: { decisionId: 'd-shadow-first-then-primary', evidenceRefs: ['ev-active-active-architecture'] } },
  };
  fs.writeFileSync(path.join(dir, 'mock-script.json'), JSON.stringify(scripted, null, 2), 'utf8');
}

beforeAll(() => {
  fs.writeFileSync(path.join(tmpRoot, 'prereg.json'), JSON.stringify(preregBody, null, 2), 'utf8');
  fs.writeFileSync(path.join(tmpRoot, 'auth.json'), JSON.stringify({ approvedBy: 'owner', approved: true, decisionRef: 'owner-decision-1', frozenCommitSha: COMMIT, approvedProtocolDigest: '0'.repeat(64) }, null, 2), 'utf8');
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('CLI authorization reconciliation (real CLI, real reconciliation stage)', () => {
  it('a matching resolver completes the authorization chain and the mock study runs', () => {
    const freeze = buildFreeze({ fixtureHash: dataset.fixtureHash, commitSha: COMMIT });
    const freezeFile = path.join(tmpRoot, 'freeze-happy.json');
    fs.writeFileSync(freezeFile, JSON.stringify(freeze, null, 2), 'utf8');
    const digest = protocolApprovalDigest({ freeze: JSON.parse(JSON.stringify(freeze)), preregBody });
    const resolverFile = writeResolverModule(tmpRoot, {
      decisionRef: 'owner-decision-1', digest, commitSha: COMMIT,
      fixtureHash: dataset.fixtureHash, costBasisRef: 'official-pricing-ref-1', pricingVerified: true,
    });
    const outDir = path.join(tmpRoot, 'out-happy');
    fs.mkdirSync(outDir, { recursive: true });
    writeMockScript(outDir);
    const res = runCli({ datasetDir, freezeFile, preregFile: path.join(tmpRoot, 'prereg.json'), authFile: path.join(tmpRoot, 'auth.json'), resolverFile, outDir });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Trusted evidence reconciled');
    const result = JSON.parse(fs.readFileSync(path.join(outDir, 'real-run-result.json'), 'utf8'));
    expect(result.executed).toBe(true);
    expect(result.adjudications.length).toBe(25);
  });

  it('a tampered frozen value (protocol digest mismatch) refuses before any transport', () => {
    const untampered = buildFreeze({ fixtureHash: dataset.fixtureHash, commitSha: COMMIT });
    const freeze = buildFreeze({ fixtureHash: dataset.fixtureHash, commitSha: COMMIT });
    (freeze.items.find((i: any) => i.id === 'FZ-11') as any).value.minPairs = 1; // quiet tamper
    const freezeFile = path.join(tmpRoot, 'freeze-digest.json');
    fs.writeFileSync(freezeFile, JSON.stringify(freeze, null, 2), 'utf8');
    const resolverFile = writeResolverModule(tmpRoot, {
      decisionRef: 'owner-decision-1',
      // The resolver saved the digest of the UN-tampered protocol.
      digest: protocolApprovalDigest({ freeze: JSON.parse(JSON.stringify(untampered)), preregBody }),
      commitSha: COMMIT, fixtureHash: dataset.fixtureHash, costBasisRef: 'official-pricing-ref-1', pricingVerified: true,
    });
    const outDir = path.join(tmpRoot, 'out-digest');
    const res = runCli({ datasetDir, freezeFile, preregFile: path.join(tmpRoot, 'prereg.json'), authFile: path.join(tmpRoot, 'auth.json'), resolverFile, outDir });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('trusted-evidence reconciliation FAILED');
    expect(res.stderr).toContain('protocol digest does not match');
    expect(fs.existsSync(path.join(outDir, 'real-run-result.json'))).toBe(false);
  });

  it('a frozen-commit mismatch refuses (resolver attests a different approved commit)', () => {
    // The freeze pins the REAL running commit (the gate's own running-commit
    // check passes); the RESOLVER attests a different approved commit — the
    // reconciliation layer must refuse.
    const freeze = buildFreeze({ fixtureHash: dataset.fixtureHash, commitSha: COMMIT });
    const freezeFile = path.join(tmpRoot, 'freeze-commit.json');
    fs.writeFileSync(freezeFile, JSON.stringify(freeze, null, 2), 'utf8');
    const resolverFile = writeResolverModule(tmpRoot, {
      decisionRef: 'owner-decision-1',
      digest: protocolApprovalDigest({ freeze: JSON.parse(JSON.stringify(freeze)), preregBody }),
      commitSha: 'b'.repeat(40), // resolver approved a DIFFERENT commit
      fixtureHash: dataset.fixtureHash, costBasisRef: 'official-pricing-ref-1', pricingVerified: true,
    });
    const res = runCli({ datasetDir, freezeFile, preregFile: path.join(tmpRoot, 'prereg.json'), authFile: path.join(tmpRoot, 'auth.json'), resolverFile, outDir: path.join(tmpRoot, 'out-commit') });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('frozen commit does not match');
  });

  it('a dataset-hash mismatch refuses (resolver attests a different task set)', () => {
    const freeze = buildFreeze({ fixtureHash: dataset.fixtureHash, commitSha: COMMIT });
    const freezeFile = path.join(tmpRoot, 'freeze-hash.json');
    fs.writeFileSync(freezeFile, JSON.stringify(freeze, null, 2), 'utf8');
    const resolverFile = writeResolverModule(tmpRoot, {
      decisionRef: 'owner-decision-1',
      digest: protocolApprovalDigest({ freeze: JSON.parse(JSON.stringify(freeze)), preregBody }),
      commitSha: COMMIT,
      fixtureHash: 'f'.repeat(64), // resolver approved a DIFFERENT task set
      costBasisRef: 'official-pricing-ref-1', pricingVerified: true,
    });
    const res = runCli({ datasetDir, freezeFile, preregFile: path.join(tmpRoot, 'prereg.json'), authFile: path.join(tmpRoot, 'auth.json'), resolverFile, outDir: path.join(tmpRoot, 'out-hash') });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('dataset hash does not match');
  });

  it('a decision-ref mismatch refuses (resolver attests a different decision)', () => {
    const freeze = buildFreeze({ fixtureHash: dataset.fixtureHash, commitSha: COMMIT, decisionRef: 'other-decision' });
    const freezeFile = path.join(tmpRoot, 'freeze-ref.json');
    fs.writeFileSync(freezeFile, JSON.stringify(freeze, null, 2), 'utf8');
    const resolverFile = writeResolverModule(tmpRoot, {
      decisionRef: 'owner-decision-1', // resolver approved a DIFFERENT decision
      digest: protocolApprovalDigest({ freeze: JSON.parse(JSON.stringify(freeze)), preregBody }),
      commitSha: COMMIT, fixtureHash: dataset.fixtureHash, costBasisRef: 'official-pricing-ref-1', pricingVerified: true,
    });
    const res = runCli({ datasetDir, freezeFile, preregFile: path.join(tmpRoot, 'prereg.json'), authFile: path.join(tmpRoot, 'auth.json'), resolverFile, outDir: path.join(tmpRoot, 'out-ref') });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('decisionRef');
    expect(res.stderr).toContain('does not match');
  });

  it('pricing evidence that is unverified or references a different schedule refuses', () => {
    const freeze = buildFreeze({ fixtureHash: dataset.fixtureHash, commitSha: COMMIT });
    const freezeFile = path.join(tmpRoot, 'freeze-pricing.json');
    fs.writeFileSync(freezeFile, JSON.stringify(freeze, null, 2), 'utf8');
    const digest = protocolApprovalDigest({ freeze: JSON.parse(JSON.stringify(freeze)), preregBody });
    const resolverFile = writeResolverModule(tmpRoot, {
      decisionRef: 'owner-decision-1', digest, commitSha: COMMIT,
      fixtureHash: dataset.fixtureHash, costBasisRef: 'a-DIFFERENT-costBasisRef', pricingVerified: false,
    });
    const res = runCli({ datasetDir, freezeFile, preregFile: path.join(tmpRoot, 'prereg.json'), authFile: path.join(tmpRoot, 'auth.json'), resolverFile, outDir: path.join(tmpRoot, 'out-pricing') });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('pricing reference does not match');
    expect(res.stderr).toContain('did not verify the official pricing schedule');
  });

  it('pi transport without an evidence resolver refuses (real path NOT ready)', () => {
    const freeze = buildFreeze({ fixtureHash: dataset.fixtureHash, commitSha: COMMIT });
    const freezeFile = path.join(tmpRoot, 'freeze-pi-nores.json');
    fs.writeFileSync(freezeFile, JSON.stringify(freeze, null, 2), 'utf8');
    const res = runCli({ datasetDir, freezeFile, preregFile: path.join(tmpRoot, 'prereg.json'), authFile: path.join(tmpRoot, 'auth.json'), resolverFile: null, outDir: path.join(tmpRoot, 'out-pi-nores'), transport: 'pi' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('NOT ready');
  });
});

describe('arm-level budget STOP (round 7, B)', () => {
  it('an exhausted arm ledger halts before any call; remaining tasks are all retained', async () => {
    const freeze = buildFreeze({ fixtureHash: dataset.fixtureHash, commitSha: COMMIT });
    const snapshot = JSON.parse(JSON.stringify(freeze));
    const digest = protocolApprovalDigest({ freeze: snapshot, preregBody });
    const verifier = () => ({
      verified: true,
      approved: true,
      frozenCommitSha: snapshot.ownerApproval.frozenCommitSha,
      approvedProtocolDigest: digest,
    });
    let calls = 0;
    const result = await runPrrRealAc({
      studyId: preregBody.studyId, freeze, preregBody, dataset,
      verifyOwnerApproval: verifier, runningCommitSha: COMMIT,
      armRequestCap: 40,
      budgetTelemetry: () => ({
        levels: [
          { scope: `arm:${preregBody.studyId}`, cap: 40, used: 40 }, // arm ledger exhausted
          { scope: `study:${preregBody.studyId}`, cap: 80, used: 40 },
        ],
      }),
      transportFor: () => ({
        async complete() {
          calls += 1;
          return { payload: { decisionId: 'd-1', evidenceRefs: ['ev-1'] }, usage: { requests: null } };
        },
      }),
    });
    expect(calls).toBe(0);
    expect(result.executed).toBe(true);
    // 26 (group×task) − 1 pre-exposure unauthorized exclusion.
    expect(result.notExecutedTasks.length).toBe(2 * dataset.tasks.tasks.length - 1);
    for (const row of result.notExecutedTasks) expect(row.reasonCode).toBe('arm_budget_exhausted');
    expect(result.stopEvents[0]).toMatchObject({ type: 'AC-S4_BUDGET_STOP', counterBasis: 'budget_ledger' });
    expect(result.denominators.requestCounterBasis).toBe('budget_ledger');
  });
});
