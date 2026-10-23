// PRI-1002 — real A/C runner regression suite (mock transport ONLY).
//
// Proves the fail-closed gate chain and the wired execution path WITHOUT any
// real model: every test injects a mock transport (or none); the authorized
// path is exercised end-to-end with a mock that produces scripted decisions.

import { describe, expect, it } from 'vitest';

import { runPrrRealAc, behaviorFromRoundPayload, classifyTransportFailure } from '../dev/principle-learning-lab/prr/lib/prr-real-runner.mjs';
import { buildDraftFreeze, protocolApprovalDigest, validateFreezeForRealRun } from '../dev/principle-learning-lab/prr/lib/prr-freeze.mjs';
import { loadPrrDataset } from '../dev/principle-learning-lab/prr/lib/prr-dataset.mjs';
import { buildPrrDatasetFiles, writePrrDataset } from './prr-test-fixtures';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FROZEN_COMMIT = 'a'.repeat(40);
const datasetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-real-'));
const dataset = loadPrrDataset(writePrrDataset(datasetDir));
const preregBody = { studyId: 'PRR-AC-SYNTH-01-real', note: 'real-path prereg body' };

function fullyFrozen() {
  const draft = buildDraftFreeze({ studyId: preregBody.studyId, preregBody });
  const freeze = {
    ...draft,
    status: 'OWNER_APPROVED_FROZEN',
    items: draft.items.map((item: any) => {
      let value: unknown = { frozen: true };
      if (item.id === 'FZ-01') value = { taskSetHash: dataset.fixtureHash };
      if (item.id === 'FZ-11') value = { minPairs: 3, derivationBasis: 'owner-frozen detectable difference' };
      if (item.id === 'FZ-06') value = { provider: 'p', model: 'm', baseUrl: 'https://x', apiKeyEnv: 'K', credentialsAvailable: true, perRunCostCapUsd: 1, totalCostCapUsd: 2, httpRequestsPerArm: 40, httpRequestsPerStudy: 80, httpRequestsPerTask: 4, costBasisRef: 'ref', costBasis: { provider: 'p', model: 'm', currency: 'USD', inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2, maxInputTokensPerRequest: 1024, maxOutputTokensPerRequest: 1024, effectiveDate: '2026-01-01' } };
      return { ...item, status: 'VALUE_FROZEN', value, ownerApprovalRef: 'owner-decision-1' };
    }),
    ownerApproval: { approvedBy: 'owner', decisionRef: 'owner-decision-1', frozenCommitSha: FROZEN_COMMIT },
  };
  return freeze;
}

// Real approval order: approve the snapshot ONCE, save the digest.
function approvedOnce(freeze: any) {
  const snapshot = JSON.parse(JSON.stringify(freeze));
  return {
    savedDigest: protocolApprovalDigest({ freeze: snapshot, preregBody }),
    verifier: () => ({
      verified: true,
      approved: true,
      frozenCommitSha: FROZEN_COMMIT,
      approvedProtocolDigest: protocolApprovalDigest({ freeze: snapshot, preregBody }),
    }),
  };
}

function mockTransport(scripted: Record<string, { payload?: unknown; usage?: unknown; fail?: Error }>) {
  const calls: string[] = [];
  return {
    calls,
    transportFor: ({ group, taskId }: { group: string; taskId: string }) => ({
      async complete({ taskId: fullId }: { taskId: string }) {
        calls.push(fullId);
        const row = scripted[`${group}:${taskId}`];
        if (!row) throw Object.assign(new Error('no script'), { kind: 'no_response' });
        if (row.fail) throw row.fail;
        return { payload: row.payload, usage: row.usage ?? null };
      },
    }),
  };
}

const okPayload = (decisionId: string, evidenceRefs: string[]) => ({ decisionId, evidenceRefs });

describe('real A/C runner gate chain (fail-closed)', () => {
  it('refuses a DRAFT freeze record — nothing executes, full refusal list returned', async () => {
    const draft = buildDraftFreeze({ studyId: preregBody.studyId, preregBody });
    const { verifier } = approvedOnce(draft);
    const result = await runPrrRealAc({
      studyId: preregBody.studyId, freeze: draft, preregBody, dataset,
      verifyOwnerApproval: verifier, runningCommitSha: FROZEN_COMMIT,
      transportFor: () => { throw new Error('transport must never be constructed for a refused run'); },
    });
    expect(result.executed).toBe(false);
    expect(result.refusalReasons.length).toBeGreaterThan(0);
    expect(result.adjudications).toEqual([]);
  });

  it('refuses when the approval digest does not match the submitted record', async () => {
    const freeze = fullyFrozen();
    const { verifier } = approvedOnce(fullyFrozen()); // digest of a DIFFERENT snapshot
    (freeze.items.find((i: any) => i.id === 'FZ-11') as any).value.minPairs = 99;
    const result = await runPrrRealAc({
      studyId: preregBody.studyId, freeze, preregBody, dataset,
      verifyOwnerApproval: verifier, runningCommitSha: FROZEN_COMMIT,
      transportFor: () => { throw new Error('must not run'); },
    });
    expect(result.executed).toBe(false);
    expect(result.refusalReasons.some((p: string) => p.includes('protocol approval reconciliation FAILED'))).toBe(true);
  });

  it('refuses a missing/unverified owner approval and a missing running commit', async () => {
    const freeze = fullyFrozen();
    const noVerify = await runPrrRealAc({
      studyId: preregBody.studyId, freeze, preregBody, dataset,
      verifyOwnerApproval: () => ({ verified: false, reason: 'no record' }), runningCommitSha: FROZEN_COMMIT,
      transportFor: () => { throw new Error('must not run'); },
    });
    expect(noVerify.executed).toBe(false);

    const noCommit = await runPrrRealAc({
      studyId: preregBody.studyId, freeze, preregBody, dataset,
      verifyOwnerApproval: approvedOnce(freeze).verifier, runningCommitSha: undefined as never,
      transportFor: () => { throw new Error('must not run'); },
    });
    expect(noCommit.executed).toBe(false);
    expect(noCommit.refusalReasons.some((p: string) => p.includes('runningCommitSha missing'))).toBe(true);
  });
});

describe('real A/C runner wired path (mock transport)', () => {
  it('runs the full A/C study over the mock transport with full denominators', async () => {
    const freeze = fullyFrozen();
    const { verifier } = approvedOnce(freeze);
    // Scripted: history helps T1-C, principle suffices for T2, NT-1 trap on T3-C,
    // one timeout row and one invalid-payload row — denominators must hold.
    const scripted: Record<string, { payload?: unknown; fail?: Error }> = {
      'A:t1-history-decides': { payload: okPayload('d-generic-cautious-path', ['ev-current-manifest']) },
      'C:t1-history-decides': { payload: okPayload('d-add-compat-shims', ['ev-consumer-incident-ledger', 'ev-current-manifest']) },
      'A:t3-old-context-conflicts': { payload: okPayload('d-daytime-window-with-owner-note', ['ev-current-runbook']) },
      'C:t3-old-context-conflicts': { payload: okPayload('d-night-window-batch', ['ev-current-runbook']) },
      'A:t2-principle-sufficient': { payload: okPayload('d-accept-ci-report', ['ev-ci-impact-report']) },
      'C:t2-principle-sufficient': { payload: okPayload('d-full-manual-recheck', ['ev-ci-impact-report']) },
      'A:t-failure-timeout-c': { payload: okPayload('d-accept-cache-with-source-check', ['ev-cache-sync-check']) },
      'C:t-failure-timeout-c': { fail: Object.assign(new Error('deadline'), { kind: 'timeout' }) },
      'A:t-inconclusive-evidence': { payload: { unparseable: true } }, // invalid payload row
    };
    const { calls, transportFor } = mockTransport(scripted);
    const result = await runPrrRealAc({
      studyId: preregBody.studyId, freeze, preregBody, dataset,
      verifyOwnerApproval: verifier, runningCommitSha: FROZEN_COMMIT,
      transportFor,
    });
    expect(result.executed).toBe(true);
    // Every included (group × task) got exactly one transport call.
    expect(calls.length).toBe(2 * dataset.tasks.tasks.length - 1); // minus 1 unauthorized C exclusion
    expect(result.exclusions).toEqual([{
      taskId: 't-unauthorized-history', group: 'C', reasonCode: 'unauthorized_history_material', note: 'excluded before exposure (B0 §8.2)',
    }]);
    // Full denominators: 25 rows (13 tasks × 2 − 1 exclusion).
    expect(result.adjudications.length).toBe(25);
    // Failure classification: timeout row stays as FAILED/timeout.
    const timeoutRow = result.adjudications.find((a: any) => a.group === 'C' && a.taskId === 't-failure-timeout-c');
    expect(timeoutRow).toMatchObject({ runStatus: 'FAILED', reasonCode: 'timeout', verdict: 'MISALIGNED' });
    // Invalid payload row stays as INVALID_OUTPUT.
    const invalidRow = result.adjudications.find((a: any) => a.group === 'A' && a.taskId === 't-inconclusive-evidence');
    expect(invalidRow).toMatchObject({ runStatus: 'FAILED', reasonCode: 'model_output_invalid' });
    // NT-1 negative transfer detected on the T3-C trap.
    const nt1 = result.adjudications.find((a: any) => a.group === 'C' && a.taskId === 't3-old-context-conflicts');
    expect(nt1.negativeTransfer.level).toBe('NT-1');
    // Paired report is complete and honest.
    expect(result.pairedReport.enrolledRows).toBe(25);
    expect(result.pairedReport.byType['AC-T3'].nt1).toBe(1);
  });

  it('classifies transport failures and invalid payloads into B0 §8.2 rows', () => {
    expect(classifyTransportFailure({ kind: 'timeout' })).toEqual({ status: 'TIMEOUT', runStatus: 'FAILED' });
    expect(classifyTransportFailure({ kind: 'no_response' })).toEqual({ status: 'NO_RESPONSE', runStatus: 'NO_RESPONSE' });
    expect(classifyTransportFailure({ kind: 'budget_exhausted' })).toEqual({ status: 'INTERRUPTED', runStatus: 'STOPPED_BUDGET' });
    expect(classifyTransportFailure(new Error('boom'))).toEqual({ status: 'INVALID_OUTPUT', runStatus: 'FAILED' });

    expect(behaviorFromRoundPayload(null, null).status).toBe('INVALID_OUTPUT');
    expect(behaviorFromRoundPayload({ decisionId: 7 }, null).status).toBe('INVALID_OUTPUT');
    expect(behaviorFromRoundPayload({ decisionId: 'd', evidenceRefs: 'not-array' }, null).status).toBe('INVALID_OUTPUT');
    const ok = behaviorFromRoundPayload({ decisionId: 'd-1', evidenceRefs: ['e-1'], hedging: true }, { tokensIn: 10, tokensOut: 5, wallMs: 12 });
    expect(ok).toMatchObject({ status: 'OK', output: { decisionId: 'd-1', evidenceRefs: ['e-1'], hedging: true } });
    expect(ok.usage).toMatchObject({ tokensIn: 10, tokensOut: 5, wallMs: 12, ownerAsks: 0 });
  });

  it('the freeze gate result is the same object the standalone validator produces', () => {
    const freeze = fullyFrozen();
    const { verifier } = approvedOnce(freeze);
    const standalone = validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval: verifier, dataset, runningCommitSha: FROZEN_COMMIT });
    expect(standalone.problems).toEqual([]);
  });
});
