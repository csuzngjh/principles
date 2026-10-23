// PRI-1002 — real A/C PI-path regression suite (mock Pi adapter; zero HTTP).
//
// Exercises the REAL authorization chain (verifyRealRunAuthorization +
// createAuthorizedPiTransport + http-budget ledgers) against a MOCK Pi
// adapter: no real model, no network. Every authorization refusal must
// happen BEFORE the first HTTP request (fetch spy stays at zero).

import { describe, expect, it, vi } from 'vitest';

// The factory dynamic-imports '@principles/core/runtime-v2'; substitute a
// mock Pi adapter whose `fetch` is the spy — the budgeted fetch wraps it,
// so a fetch-spy count of 0 proves no HTTP attempt was made.
const fetchSpy = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
const completeSpy = vi.fn(() => Promise.resolve({ payload: { decisionId: 'd-mock', evidenceRefs: ['ev-1'] } }));

class MockPiAiRuntimeAdapter {
  constructor(config: any) {
    this.config = config;
  }

  config: any;
  private runs = new Map<string, { payload: unknown }>();
  private seq = 0;

  // PDRuntimeAdapter boundary (required by createPiAdapterTransport).
  async startRun(_input: any) {
    const runId = `mock-run-${++this.seq}`;
    // completeSpy already yields the fetchOutput shape: { payload }.
    this.runs.set(runId, await completeSpy());
    return { runId };
  }

  async fetchOutput(runId: string) {
    return this.runs.get(runId) ?? null;
  }

  // The budgeted fetch is what the factory wires; expose it so the test can
  // prove refusals happened before any HTTP attempt.
  getFetch() {
    return this.config?.fetch;
  }
}

vi.mock('@principles/core/runtime-v2', () => ({
  PiAiRuntimeAdapter: MockPiAiRuntimeAdapter,
  getPiAiFetchForApi: () => (input: unknown, init: unknown) => fetchSpy(input, init),
  StoreEventEmitter: class {
    handlers: ((e: unknown) => void)[] = [];

    onTelemetry(fn: (e: unknown) => void) {
      this.handlers.push(fn);
    }
  },
}));

import { runPrrRealAc, behaviorFromRoundPayload } from '../dev/principle-learning-lab/prr/lib/prr-real-runner.mjs';
import { buildDraftFreeze, protocolApprovalDigest, validateFreezeForRealRun } from '../dev/principle-learning-lab/prr/lib/prr-freeze.mjs';
import { loadPrrDataset, healthCheckPrrDataset } from '../dev/principle-learning-lab/prr/lib/prr-dataset.mjs';
import { createHttpBudgetLedger } from '../dev/principle-learning-lab/prr/../lib/http-budget.mjs';
import { createAuthorizedPiTransport } from '../dev/principle-learning-lab/prr/../lib/actor.mjs';
import { buildPrrDatasetFiles, writePrrDataset } from './prr-test-fixtures';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FROZEN_COMMIT = 'a'.repeat(40);
const datasetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-pi-'));
const dataset = loadPrrDataset(writePrrDataset(datasetDir));
const preregBody = { studyId: 'PRR-AC-SYNTH-01-real', note: 'pi-path prereg body' };

const BUDGET = {
  provider: 'mock-provider',
  model: 'mock-model',
  baseUrl: 'https://mock.invalid/v1',
  apiKeyEnv: 'MOCK_PRR_API_KEY',
  credentialsAvailable: true,
  httpRequestsPerOpportunity: 4,
  httpRequestsPerArm: 40,
  httpRequestsPerStudy: 80,
  perRunCostCapUsd: 1,
  totalCostCapUsd: 2,
  costBasisRef: 'official-pricing-ref-1',
  stopCondition: 'test stop',
  costBasis: {
    provider: 'mock-provider',
    model: 'mock-model',
    currency: 'USD',
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 2,
    maxInputTokensPerRequest: 1024,
    maxOutputTokensPerRequest: 1024,
    effectiveDate: '2026-01-01',
  },
};

function fullyFrozen(budgetOverride: Record<string, unknown> = {}) {
  const draft = buildDraftFreeze({ studyId: preregBody.studyId, preregBody });
  const freeze = {
    ...draft,
    status: 'OWNER_APPROVED_FROZEN',
    items: draft.items.map((item: any) => {
      let value: unknown = { frozen: true };
      if (item.id === 'FZ-01') value = { taskSetHash: dataset.fixtureHash };
      if (item.id === 'FZ-06') value = { ...BUDGET, ...budgetOverride };
      if (item.id === 'FZ-11') value = { minPairs: 3, derivationBasis: 'owner-frozen detectable difference' };
      return { ...item, status: 'VALUE_FROZEN', value, ownerApprovalRef: 'owner-decision-1' };
    }),
    ownerApproval: { approvedBy: 'owner', decisionRef: 'owner-decision-1', frozenCommitSha: FROZEN_COMMIT },
  };
  return freeze;
}

function trustedResolver(overrides: Record<string, unknown> = {}) {
  const freeze = fullyFrozen();
  const digest = protocolApprovalDigest({ freeze: JSON.parse(JSON.stringify(freeze)), preregBody });
  // SYNCHRONOUS implementation: the actor's evidenceVerifier contract resolves
  // evidence inline (no await), so an async impl would return a Promise whose
  // fields all read as undefined. Plain function + vi.fn wrapper so an
  // override can delegate to the base behavior without recursing.
  const impl = ({ kind, reference }: { kind: string; reference?: string }) => {
    if (kind === 'owner-decision') {
      return {
        verified: true,
        approved: true,
        reference: reference ?? 'owner-decision-1',
        frozenCommitSha: FROZEN_COMMIT,
        approvedProtocolDigest: digest,
        frozenFixtureHash: dataset.fixtureHash,
        ...overrides,
      };
    }
    return {
      verified: true,
      reference: BUDGET.costBasisRef,
      provider: BUDGET.provider,
      model: BUDGET.model,
      currency: 'USD',
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 2,
      maxInputTokensPerRequest: 1024,
      maxOutputTokensPerRequest: 1024,
      effectiveDate: '2026-01-01',
      ...overrides,
    };
  };
  return {
    digest,
    verify: vi.fn(impl),
    base: impl,
  };
}

/** Build the PI transport through the REAL factory with correct contracts. */
async function buildPiTransport({ freeze, resolver, budgetsOverride = {} as Record<string, unknown>, omitBudgets = false } = {}) {
  const resolved = resolver ?? trustedResolver(freeze ?? fullyFrozen());
  const f = freeze ?? fullyFrozen();
  const budget = (f.items.find((i: any) => i.id === 'FZ-06') as any).value;
  const executionOrder = dataset.tasks.tasks.flatMap((t: any) => [`A:${t.taskId}`, `C:${t.taskId}`]);
  const datasetForGate = { ...dataset, histories: Object.fromEntries(executionOrder.map((a: string) => [a, { prrExecutionArm: a }])) };
  const studyLedger = createHttpBudgetLedger({
    scope: `study:prr-${f.studyId}`,
    cap: budget.httpRequestsPerStudy,
    costCapUsd: budget.totalCostCapUsd,
  });
  const armLedger = createHttpBudgetLedger({
    scope: `arm:prr-${f.studyId}`,
    cap: budget.httpRequestsPerArm,
    costCapUsd: budget.perRunCostCapUsd,
    parent: studyLedger,
  });
  const factoryArgs: Record<string, unknown> = {
    authorization: {
      schemaVersion: 'g2-real-run-authorization.v1',
      od1: { approved: true, decisionRef: 'owner-decision-1', frozenFixtureHash: dataset.fixtureHash },
      od2: {
        provider: budget.provider,
        model: budget.model,
        baseUrl: budget.baseUrl,
        apiKeyEnv: budget.apiKeyEnv,
        credentialsAvailable: true,
        perRunCostCapUsd: budget.perRunCostCapUsd,
        totalCostCapUsd: budget.totalCostCapUsd,
        httpRequestsPerOpportunity: budget.httpRequestsPerOpportunity,
        httpRequestsPerArm: budget.httpRequestsPerArm,
        httpRequestsPerStudy: budget.httpRequestsPerStudy,
        stopCondition: 'test',
        costBasisRef: budget.costBasisRef,
        costBasis: budget.costBasis,
      },
      od3: { seeds: 1, executionOrder, frozen: true },
    },
    prereg: { status: 'OWNER_APPROVED' },
    dataset: datasetForGate,
    adapterConfig: { provider: budget.provider, model: budget.model, baseUrl: budget.baseUrl, apiKeyEnv: budget.apiKeyEnv },
    ledger: armLedger,
    evidenceVerifier: ({ kind, reference }: { kind: string; reference?: string }) => resolved.verify({ kind, reference }),
  };
  if (!omitBudgets) {
    factoryArgs.budgets = {
      httpRequestsPerOpportunity: budget.httpRequestsPerOpportunity,
      httpRequestsPerArm: budget.httpRequestsPerArm,
      httpRequestsPerStudy: budget.httpRequestsPerStudy,
      perRunCostCapUsd: budget.perRunCostCapUsd,
      totalCostCapUsd: budget.totalCostCapUsd,
      ...budgetsOverride,
    };
  }
  const { transport } = await createAuthorizedPiTransport(factoryArgs as never);
  return { transport, armLedger, resolved, executionOrder };
}

describe('PI factory through the REAL authorization chain (mock adapter)', () => {
  it('constructs a runner-compatible transport when every authorization element is valid', async () => {
    const { transport } = await buildPiTransport();
    expect(typeof transport.complete).toBe('function');
    expect(fetchSpy).not.toHaveBeenCalled(); // construction alone never sends HTTP
    // A single mock round through the real transport works and pays the ledger.
    const round = await transport.complete({ systemPrompt: 's', userPrompt: 'u', taskId: 'A:t1' });
    expect(round.payload).toEqual({ decisionId: 'd-mock', evidenceRefs: ['ev-1'] });
  });

  it('missing budgets refuse BEFORE any HTTP (drift check)', async () => {
    await expect(buildPiTransport({ omitBudgets: true })).rejects.toThrow(/budgets missing/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a wrong execution order refuses BEFORE any HTTP (OD-3)', async () => {
    // Build with a deliberately wrong od3 order against the CORRECT dataset
    // order — the mismatch must refuse.
    const resolver = trustedResolver();
    const freeze = fullyFrozen();
    const budget = (freeze.items.find((i: any) => i.id === 'FZ-06') as any).value;
    const correctOrder = dataset.tasks.tasks.flatMap((t: any) => [`A:${t.taskId}`, `C:${t.taskId}`]);
    const studyLedger = createHttpBudgetLedger({ scope: 'study:x', cap: 80, costCapUsd: 2 });
    const armLedger = createHttpBudgetLedger({ scope: 'arm:x', cap: 40, costCapUsd: 1, parent: studyLedger });
    await expect(createAuthorizedPiTransport({
      authorization: {
        schemaVersion: 'g2-real-run-authorization.v1',
        od1: { approved: true, decisionRef: 'owner-decision-1', frozenFixtureHash: dataset.fixtureHash },
        od2: {
          provider: budget.provider, model: budget.model, baseUrl: budget.baseUrl, apiKeyEnv: budget.apiKeyEnv,
          credentialsAvailable: true, perRunCostCapUsd: 1, totalCostCapUsd: 2,
          httpRequestsPerOpportunity: 4, httpRequestsPerArm: 40, httpRequestsPerStudy: 80,
          stopCondition: 't', costBasisRef: budget.costBasisRef, costBasis: budget.costBasis,
        },
        od3: { seeds: 1, executionOrder: ['wrong-order'], frozen: true },
      },
      prereg: { status: 'OWNER_APPROVED' },
      dataset: { ...dataset, histories: Object.fromEntries(correctOrder.map((a: string) => [a, { prrExecutionArm: a }])) },
      adapterConfig: { provider: budget.provider, model: budget.model, baseUrl: budget.baseUrl, apiKeyEnv: budget.apiKeyEnv },
      budgets: {
        httpRequestsPerOpportunity: 4, httpRequestsPerArm: 40, httpRequestsPerStudy: 80,
        perRunCostCapUsd: 1, totalCostCapUsd: 2,
      },
      ledger: armLedger,
      evidenceVerifier: ({ kind, reference }: { kind: string; reference?: string }) => resolver.verify({ kind, reference }),
    })).rejects.toThrow(/executionOrder must exactly match/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('invalid pricing evidence refuses BEFORE any HTTP (OD-2 cost-basis verification)', async () => {
    const failing = trustedResolver();
    const base = failing.base;
    failing.verify.mockImplementation(async (args: { kind: string; reference?: string }) => {
      if (args.kind === 'cost-basis') return { verified: false, reason: 'pricing schedule not found' };
      return base(args);
    });
    await expect(buildPiTransport({ resolver: failing })).rejects.toThrow(/costBasisRef was not verified/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a tampered budget in the authorization refuses BEFORE any HTTP (budgets drift)', async () => {
    await expect(buildPiTransport({ budgetsOverride: { perRunCostCapUsd: 999 } })).rejects.toThrow(/drift: budgets\.perRunCostCapUsd/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('an unapproved / non-Owner decision record refuses at the PRR gate with zero transport construction', async () => {
    const freeze = fullyFrozen();
    const gate = validateFreezeForRealRun({
      freeze, preregBody,
      verifyOwnerApproval: () => ({ verified: true, approved: false }),
      dataset, runningCommitSha: FROZEN_COMMIT,
    });
    expect(gate.problems.some((p: string) => p.includes('not BOTH verified and approved'))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('runner: STOP semantics, denominators and unknown-cost honesty (round 6)', () => {
  it('halts on the study request cap: no further model calls, remaining tasks explicitly listed', async () => {
    const freeze = fullyFrozen();
    const { verifier } = approvedOnceFixture(freeze);
    let calls = 0;
    const result = await runPrrRealAc({
      studyId: preregBody.studyId, freeze, preregBody, dataset,
      verifyOwnerApproval: verifier, runningCommitSha: FROZEN_COMMIT,
      studyRequestCap: 2,
      transportFor: () => ({
        async complete() {
          calls += 1;
          return { payload: okPayload('d-generic-cautious-path', ['ev-current-manifest']), usage: { requests: 1 } };
        },
      }),
    });
    expect(result.executed).toBe(true);
    expect(calls).toBe(2); // hard stop after the cap
    expect(result.stopEvents.some((e: any) => e.type === 'AC-S4_BUDGET_STOP' && e.studyCap === 2)).toBe(true);
    // 26 (group×task) − 2 executed − 1 pre-exposure unauthorized exclusion.
    expect(result.notExecutedTasks.length).toBe(2 * dataset.tasks.tasks.length - calls - 1);
    for (const row of result.notExecutedTasks) expect(row.reasonCode).toBe('study_budget_exhausted');
    expect(result.denominators).toMatchObject({ enrolledRows: dataset.tasks.tasks.length * 2, executedAdjudications: calls });
  });

  it('the live budget-ledger telemetry is the authoritative counter; unknown usage is never inferred', async () => {
    const freeze = fullyFrozen();
    const { verifier } = approvedOnceFixture(freeze);
    const studyLedger = createHttpBudgetLedger({ scope: 'study:prr-live', cap: 3, costCapUsd: 5 });
    // The ledger ALREADY shows 3 used requests — the runner must stop before
    // calling the transport at all, even though task-reported usage is null.
    for (let i = 0; i < 3; i += 1) studyLedger.reserve('pre-existing usage', 0);
    let calls = 0;
    const result = await runPrrRealAc({
      studyId: preregBody.studyId, freeze, preregBody, dataset,
      verifyOwnerApproval: verifier, runningCommitSha: FROZEN_COMMIT,
      studyRequestCap: 3,
      budgetTelemetry: () => armSnapshotFixture(studyLedger),
      transportFor: () => ({
        async complete() {
          calls += 1;
          return { payload: okPayload('d-1', ['ev-1']), usage: { requests: null } };
        },
      }),
    });
    expect(calls).toBe(0);
    // 26 (group×task) − 1 pre-exposure unauthorized exclusion; the excluded
    // row never enters notExecuted (it has its own exclusion record).
    expect(result.notExecutedTasks.length).toBe(2 * dataset.tasks.tasks.length - 1);
    expect(result.denominators.requestCounterBasis).toBe('budget_ledger');
  });

  it('unknown disclosure status is refused for delivery even inside the runner (defense in depth)', async () => {
    const dir = writePrrDataset(fs.mkdtempSync(path.join(os.tmpdir(), 'prr-unk-')), buildPrrDatasetFiles());
    const mutated = JSON.parse(JSON.stringify(buildPrrDatasetFiles()));
    const t = (mutated['tasks.json'] as any).tasks.find((x: any) => x.taskId === 't1-history-decides');
    t.historyMaterial.disclosureStatus = 'unknown_provenance';
    (mutated['tasks.json'] as any).tasks = [t];
    (mutated['gold.json'] as any).gold = { 't1-history-decides': (mutated['gold.json'] as any).gold['t1-history-decides'] };
    (mutated['behaviors.json'] as any).behaviors = { 'A:t1-history-decides': (mutated['behaviors.json'] as any).behaviors['A:t1-history-decides'] };
    (mutated['design-checks.json'] as any).cases = [];
    const files = mutated;
    fs.rmSync(dir, { recursive: true, force: true });
    const dir2 = writePrrDataset(fs.mkdtempSync(path.join(os.tmpdir(), 'prr-unk2-')), files);
    const ds = loadPrrDataset(dir2);
    expect(healthCheckPrrDataset(ds).some((p: string) => p.includes('disclosureStatus'))).toBe(true);

    const freeze = fullyFrozen();
    const fz01: any = freeze.items.find((i: any) => i.id === 'FZ-01');
    fz01.value = { taskSetHash: ds.fixtureHash };
    // Single-task variant: the sample-size gate must not fire before the
    // disclosure assertion is reached — set minPairs to the available pairs.
    const fz11: any = freeze.items.find((i: any) => i.id === 'FZ-11');
    fz11.value = { minPairs: 1, derivationBasis: 'single-task variant' };
    const { verifier } = approvedOnceFixture(freeze, preregBodyFor(ds));
    await expect(runPrrRealAc({
      studyId: preregBody.studyId, freeze, preregBody: preregBodyFor(ds), dataset: ds,
      verifyOwnerApproval: verifier, runningCommitSha: FROZEN_COMMIT,
      transportFor: () => ({ async complete() { throw new Error('must never be called'); } }),
    })).rejects.toThrow(/non-authorized disclosure status/);
  });

  it('unknown cost fields stay null — round payloads never invent request counts', () => {
    const ok = behaviorFromRoundPayload({ decisionId: 'd', evidenceRefs: ['e'] }, { tokensIn: 3 });
    expect(ok.usage.requests).toBeNull();
    expect(ok.usage.tokensIn).toBe(3);
    expect(behaviorFromRoundPayload({ decisionId: 'd', evidenceRefs: ['e'] }, null).usage.requests).toBeNull();
  });
});

// ── helpers ──
function okPayload(decisionId: string, evidenceRefs: string[]) {
  return { decisionId, evidenceRefs };
}

function preregBodyFor(_ds: any) {
  // Same body content as the freeze was built from — only the DATASET varies
  // in this scenario; a changed body would (correctly) fail the prereg hash
  // reconciliation before the disclosure assertion is ever reached.
  return preregBody;
}

function approvedOnceFixture(freeze: any, body = preregBody) {
  const snapshot = JSON.parse(JSON.stringify(freeze));
  const digest = protocolApprovalDigest({ freeze: snapshot, preregBody: body });
  return {
    savedDigest: digest,
    verifier: () => ({
      verified: true,
      approved: true,
      frozenCommitSha: FROZEN_COMMIT,
      approvedProtocolDigest: digest,
    }),
  };
}

function armSnapshotFixture(studyLedger: any) {
  // Mirror the runner's lookup: the STUDY level of a ledger chain.
  const snap = studyLedger.snapshot();
  return snap;
}
