// PRI-966 G2 P1-01/P1-02/P1-03 — HTTP request budget ledger, fail-closed
// real-run authorization gate, and token-usage audit tests.
//
// Zero network, zero credentials: the budgeted fetch is exercised against a
// fake baseFetch (the SAME interception point the real PRI-683 transport
// occupies in production wiring); the authorization gate is exercised at the
// factory boundary where a refusal means NO transport and NO HTTP request can
// ever exist. Nothing here is a real experiment (REAL_G2 stays NOT_RUN).

import { describe, expect, it } from 'vitest';

declare module 'vitest' {
  interface Assertion<T> {
    toThrowRealRunAuthorization(pattern: RegExp): T;
  }
}

import {
  BudgetExhaustedError,
  CostBudgetExhaustedError,
  auditTokenUsage,
  createBudgetedFetch,
  createCostBudgetGuard,
  createHttpBudgetLedger,
} from '../dev/principle-learning-lab/lib/http-budget.mjs';
import {
  DEFAULT_REAL_ACTOR_CAPS,
  PREREG_FROZEN_STATUS,
  REAL_RUN_AUTHORIZATION_SCHEMA,
  createAuthorizedPiTransport,
  createFakeActorTransport,
  runRealActorOpportunity,
  verifyRealRunAuthorization,
} from '../dev/principle-learning-lab/lib/actor.mjs';
import { runRealStudy } from '../dev/principle-learning-lab/lib/real-runner.mjs';
import { goldFor, loadDataset } from '../dev/principle-learning-lab/lib/fixture.mjs';
import { deliverPayload } from '../dev/principle-learning-lab/lib/g2.mjs';
import { ACTION_COSTS } from '../dev/principle-learning-lab/lib/oracle.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dev', 'principle-learning-lab', 'fixtures');
const dataset = loadDataset(FIXTURES);
const MANUAL_TEXT = dataset.worldManual.manualText.join('\n');
const KNOWN_ACTIONS = Object.keys(ACTION_COSTS);
const prereg = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'preregistration.json'), 'utf8'));

// ── helpers ─────────────────────────────────────────────────────────────────

function sseResponseWithUsage(bodyText, usage) {
  const chunks = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: bodyText }, finish_reason: null }] },
  ];
  if (usage) {
    chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
  } else {
    chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Valid authorization record over the CURRENT fixtures/prereg values. */
function validAuthorization() {
  return {
    schemaVersion: REAL_RUN_AUTHORIZATION_SCHEMA,
    od1: {
      approved: true,
      decisionRef: 'OWNER-DECISION-2026-10-18-OD123 (example shape; real runs cite the actual record)',
      frozenFixtureHash: dataset.fixtureHash,
    },
    od2: {
      provider: 'sensenova',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://token.sensenova.cn/v1',
      apiKeyEnv: 'LAB_REAL_RUN_KEY',
      credentialsAvailable: true,
      perRunCostCapUsd: 0.2,
      totalCostCapUsd: 1.0,
      costBasisRef: 'official-provider-pricing-page-snapshot (test verifier only)',
      costBasis: {
        provider: 'sensenova',
        model: 'deepseek-v4-flash',
        currency: 'USD',
        inputUsdPerMillionTokens: 0.5,
        outputUsdPerMillionTokens: 1.5,
        maxInputTokensPerRequest: 50_000,
        maxOutputTokensPerRequest: 1_024,
        effectiveDate: '2026-10-01',
      },
      httpRequestsPerOpportunity: 24,
      httpRequestsPerArm: 130,
      httpRequestsPerStudy: 540,
      stopCondition: 'stop when totalCostCapUsd is reached or any arm exceeds its cap mid-opportunity',
    },
    od3: {
      seeds: 3,
      executionOrder: ['E0', 'EA', 'EB', 'EN'],
      frozen: true,
    },
  };
}

function validBudgets() {
  return {
    httpRequestsPerOpportunity: 24,
    httpRequestsPerArm: 130,
    httpRequestsPerStudy: 540,
    perRunCostCapUsd: 0.2,
    totalCostCapUsd: 1.0,
  };
}

/** Unit-only verifier fixture; production must wire a trusted authoritative resolver. */
function testEvidenceVerifier() {
  const auth = validAuthorization();
  return ({ kind, reference }: { kind: string; reference: string }) => {
    if (kind === 'owner-decision') {
      return {
        verified: true,
        reference,
        approved: true,
        frozenFixtureHash: dataset.fixtureHash,
      };
    }
    if (kind === 'cost-basis') {
      return {
        verified: true,
        reference,
        provider: auth.od2.provider,
        model: auth.od2.model,
        currency: auth.od2.costBasis.currency,
        inputUsdPerMillionTokens: auth.od2.costBasis.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: auth.od2.costBasis.outputUsdPerMillionTokens,
        effectiveDate: auth.od2.costBasis.effectiveDate,
      };
    }
    return { verified: false, reference };
  };
}

function frozenPrereg() {
  return { ...prereg, status: PREREG_FROZEN_STATUS };
}

const validAdapterConfig = {
  provider: 'sensenova',
  model: 'deepseek-v4-flash',
  baseUrl: 'https://token.sensenova.cn/v1',
  apiKeyEnv: 'LAB_REAL_RUN_KEY',
  maxRetries: 0,
  timeoutMs: 30_000,
};

// ── P1-01: hierarchical HTTP budget ledger ──────────────────────────────────

describe('P1-01: hierarchical HTTP request ledger (fail-closed at the outbound boundary)', () => {
  it('reserve() commits the whole chain atomically; snapshot reports every level', () => {
    const study = createHttpBudgetLedger({ scope: 'study:S', cap: 10 });
    const arm = createHttpBudgetLedger({ scope: 'arm:EA', cap: 4, parent: study });
    const opp = createHttpBudgetLedger({ scope: 'arm:EA#P1', cap: 2, parent: arm });

    opp.reserve('r1');
    opp.reserve('r2');

    expect(opp.used()).toBe(2);
    expect(arm.used()).toBe(2);
    expect(study.used()).toBe(2);
    const snap = opp.snapshot();
    expect(snap.levels).toEqual([
      { scope: 'arm:EA#P1', cap: 2, used: 2 },
      { scope: 'arm:EA', cap: 4, used: 2 },
      { scope: 'study:S', cap: 10, used: 2 },
    ]);
  });

  it('opportunity cap exhaustion refuses BEFORE send and leaves arm/study untouched', () => {
    const study = createHttpBudgetLedger({ scope: 'study:S', cap: 10 });
    const arm = createHttpBudgetLedger({ scope: 'arm:EA', cap: 4, parent: study });
    const opp = createHttpBudgetLedger({ scope: 'arm:EA#P1', cap: 2, parent: arm });
    opp.reserve();
    opp.reserve();
    expect(() => opp.reserve('third request')).toThrow(BudgetExhaustedError);
    expect(opp.used()).toBe(2);
    expect(arm.used()).toBe(2);
    expect(study.used()).toBe(2);
  });

  it('arm caps are cumulative ACROSS opportunities of the same arm (levels never reset)', () => {
    const study = createHttpBudgetLedger({ scope: 'study:S', cap: 100 });
    const arm = createHttpBudgetLedger({ scope: 'arm:EA', cap: 3, parent: study });
    const p1 = createHttpBudgetLedger({ scope: 'arm:EA#P1', cap: 10, parent: arm });
    const p2 = createHttpBudgetLedger({ scope: 'arm:EA#P2', cap: 10, parent: arm });
    p1.reserve(); p1.reserve();
    p2.reserve();
    expect(() => p2.reserve('fourth arm-level request')).toThrow(BudgetExhaustedError);
    try {
      p2.reserve();
    } catch (err) {
      expect(err.scope).toBe('arm:EA');
      expect(err.used).toBe(3);
      expect(err.cap).toBe(3);
    }
  });

  it('study caps are cumulative across arms; the audit reason survives the error', () => {
    const study = createHttpBudgetLedger({ scope: 'study:S', cap: 3, reason: 'study cap' });
    const armA = createHttpBudgetLedger({ scope: 'arm:E0', cap: null, parent: study });
    const armB = createHttpBudgetLedger({ scope: 'arm:EA', cap: null, parent: study });
    armA.reserve(); armA.reserve();
    armB.reserve();
    expect(() => armB.reserve('fourth study-level request')).toThrow(BudgetExhaustedError);
    try {
      armB.reserve();
    } catch (err) {
      expect(err.scope).toBe('study:S');
      expect(err.reason).toBe('study cap');
    }
  });

  it('multiple callers competing for the LAST slot: exactly one wins, the loser never reaches the fetch', async () => {
    const ledger = createHttpBudgetLedger({ scope: 'race', cap: 1 });
    let baseCalls = 0;
    const baseFetch = async () => {
      baseCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5)); // keep both in flight
      return sseResponseWithUsage('{}', { prompt_tokens: 1, completion_tokens: 1 });
    };
    const fetchA = createBudgetedFetch({ ledger, baseFetch });
    const fetchB = createBudgetedFetch({ ledger, baseFetch });
    const results = await Promise.allSettled([fetchA('https://unit.test/x', {}), fetchB('https://unit.test/x', {})]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BudgetExhaustedError);
    expect(baseCalls).toBe(1); // the loser NEVER reached the fetch
    expect(ledger.used()).toBe(1);
    expect(ledger.requests()).toHaveLength(1);
  });

  it('caps are validated at creation (0/negative/float refused — no silently useless budget)', () => {
    expect(() => createHttpBudgetLedger({ scope: 'x', cap: 0 })).toThrow(/positive integer or null/);
    expect(() => createHttpBudgetLedger({ scope: 'x', cap: -3 })).toThrow(/positive integer or null/);
    expect(() => createHttpBudgetLedger({ scope: 'x', cap: 1.5 })).toThrow(/positive integer or null/);
  });

  it('budgetedFetch: the SECOND request never reaches the base fetch once the cap is spent (fail-closed before send)', async () => {
    const ledger = createHttpBudgetLedger({ scope: 'cap1', cap: 1 });
    let baseCalls = 0;
    const fetch = createBudgetedFetch({
      ledger,
      baseFetch: async () => {
        baseCalls += 1;
        return sseResponseWithUsage('{"policyText":"x"}', { prompt_tokens: 7, completion_tokens: 3 });
      },
    });
    await fetch('https://unit.test/a', {});
    expect(baseCalls).toBe(1);
    await expect(fetch('https://unit.test/b', {})).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(baseCalls).toBe(1); // unchanged — nothing was sent
    const row = ledger.requests()[0];
    expect(row.tokenUsage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(row.usageSource).toBe('http_stream_usage');
  });

  it('budgetedFetch records provider-absent usage as explicitly unavailable (never guessed) and keeps error rows', async () => {
    const ledger = createHttpBudgetLedger({ scope: 'usage-audit', cap: null });
    const baseFetch = async (input: string) => {
      if (String(input).endsWith('boom')) throw new Error('ECONNRESET (simulated)');
      return sseResponseWithUsage('{"policyText":"no usage chunk"}', undefined);
    };
    const fetch = createBudgetedFetch({ ledger, baseFetch });
    await fetch('https://unit.test/no-usage', {});
    await expect(fetch('https://unit.test/boom', {})).rejects.toThrow(/ECONNRESET/);
    const rows = ledger.requests();
    expect(rows).toHaveLength(2);
    expect(rows[0].tokenUsage).toBeNull();
    expect(rows[0].usageSource).toBe('unavailable');
    expect(rows[1].status).toBeNull();
    expect(rows[1].error).toContain('ECONNRESET');
    expect(rows[1].usageSource).toBe('unavailable');
    const audit = auditTokenUsage(ledger.requests());
    expect(audit.httpRequests).toBe(2);
    expect(audit.totalsAvailable).toBe(false);
    expect(audit.requestsWithoutUsage).toBe(2);
  });
});

// ── P1-02: fail-closed real-run authorization gate ──────────────────────────

describe('P1-02: real-model transport authorization gate (zero HTTP on refusal)', () => {
  it('refuses a DRAFT preregistration (DRAFT_NOT_OWNER_APPROVED can never authorize) and lists all problems', () => {
    expect(() =>
      verifyRealRunAuthorization({ authorization: validAuthorization(), prereg, dataset, adapterConfig: validAdapterConfig, budgets: validBudgets() }),).toThrowRealRunAuthorization(/OD-1.*DRAFT_NOT_OWNER_APPROVED/);
  });

  it('refuses when authorization is entirely missing', () => {
    expect(() =>
      verifyRealRunAuthorization({ authorization: null, prereg: frozenPrereg(), dataset, adapterConfig: validAdapterConfig, budgets: validBudgets() }),
    ).toThrowRealRunAuthorization(/authorization record missing/);
  });

  it('refuses od1 with a literal-true violation, a missing decision ref, or a stale fixture hash', () => {
    const stale = validAuthorization();
    stale.od1.frozenFixtureHash = 'deadbeef';
    expect(() => verifyRealRunAuthorization({ authorization: stale, prereg: frozenPrereg(), dataset, adapterConfig: validAdapterConfig, budgets: validBudgets() }))
      .toThrowRealRunAuthorization(/frozenFixtureHash/);

    const unapproved = validAuthorization();
    unapproved.od1.approved = 'yes' as unknown as boolean;
    expect(() => verifyRealRunAuthorization({ authorization: unapproved, prereg: frozenPrereg(), dataset, adapterConfig: validAdapterConfig, budgets: validBudgets() }))
      .toThrowRealRunAuthorization(/literal true/);

    const noRef = validAuthorization();
    noRef.od1.decisionRef = '';
    expect(() => verifyRealRunAuthorization({ authorization: noRef, prereg: frozenPrereg(), dataset, adapterConfig: validAdapterConfig, budgets: validBudgets() }))
      .toThrowRealRunAuthorization(/decisionRef/);
  });

  it('refuses od2 missing cost caps, missing cost basis, or total < per-run', () => {
    const noCost = validAuthorization();
    noCost.od2.perRunCostCapUsd = undefined as unknown as number;
    expect(() => verifyRealRunAuthorization({ authorization: noCost, prereg: frozenPrereg(), dataset, adapterConfig: validAdapterConfig, budgets: validBudgets() }))
      .toThrowRealRunAuthorization(/perRunCostCapUsd/);

    const noBasis = validAuthorization();
    noBasis.od2.costBasisRef = '';
    expect(() => verifyRealRunAuthorization({ authorization: noBasis, prereg: frozenPrereg(), dataset, adapterConfig: validAdapterConfig, budgets: validBudgets() }))
      .toThrowRealRunAuthorization(/costBasisRef/);

    const inverted = validAuthorization();
    inverted.od2.totalCostCapUsd = 0.1;
    expect(() => verifyRealRunAuthorization({ authorization: inverted, prereg: frozenPrereg(), dataset, adapterConfig: validAdapterConfig, budgets: validBudgets() }))
      .toThrowRealRunAuthorization(/totalCostCapUsd must be >= perRunCostCapUsd/);
  });

  it('refuses od3 with zero seeds or an unfrozen record', () => {
    const noSeeds = validAuthorization();
    noSeeds.od3.seeds = 0;
    expect(() => verifyRealRunAuthorization({ authorization: noSeeds, prereg: frozenPrereg(), dataset, adapterConfig: validAdapterConfig, budgets: validBudgets() }))
      .toThrowRealRunAuthorization(/seeds/);

    const unfrozen = validAuthorization();
    unfrozen.od3.frozen = false;
    expect(() => verifyRealRunAuthorization({ authorization: unfrozen, prereg: frozenPrereg(), dataset, adapterConfig: validAdapterConfig, budgets: validBudgets() }))
      .toThrowRealRunAuthorization(/frozen/);
  });

  it('refuses parameter drift (provider/model/baseUrl or budget caps differ from the authorized values)', () => {
    const driftModel = { ...validAdapterConfig, model: 'some-other-model' };
    expect(() => verifyRealRunAuthorization({ authorization: validAuthorization(), prereg: frozenPrereg(), dataset, adapterConfig: driftModel, budgets: validBudgets() }))
      .toThrowRealRunAuthorization(/drift: adapterConfig\.model/);

    const driftBudgets = { ...validBudgets(), httpRequestsPerStudy: 999_999 };
    expect(() => verifyRealRunAuthorization({ authorization: validAuthorization(), prereg: frozenPrereg(), dataset, adapterConfig: validAdapterConfig, budgets: driftBudgets }))
      .toThrowRealRunAuthorization(/drift: budgets\.httpRequestsPerStudy/);
  });

  it('createAuthorizedPiTransport throws BEFORE constructing anything when the gate refuses — zero HTTP possible', async () => {
    await expect(
      createAuthorizedPiTransport({ authorization: validAuthorization(), prereg, dataset, adapterConfig: validAdapterConfig, budgets: validBudgets(), ledger: createHttpBudgetLedger({ scope: 'x', cap: 5 }) }),
    ).rejects.toThrowRealRunAuthorization(/DRAFT_NOT_OWNER_APPROVED/);
  });

  // timeout: the factory dynamically imports the core dist — under a fully
  // parallel suite run that first load can take seconds; the default 5s test
  // timeout is too tight for a cold cache.
  it('createAuthorizedPiTransport refuses fetch/eventEmitter injection (no bypass path) and builds a budget-wired adapter when valid', { timeout: 120_000 }, async () => {
    const bypass = { ...validAdapterConfig, fetch: (async () => new Response('{}')) as unknown };
    await expect(
      createAuthorizedPiTransport({ authorization: validAuthorization(), prereg: frozenPrereg(), dataset, adapterConfig: bypass, budgets: validBudgets(), ledger: createHttpBudgetLedger({ scope: 'x', cap: 5 }), evidenceVerifier: testEvidenceVerifier() }),
    ).rejects.toThrow(/adapterConfig\.fetch must be unset/);

    const emitterBypass = { ...validAdapterConfig, eventEmitter: {} as unknown };
    await expect(
      createAuthorizedPiTransport({ authorization: validAuthorization(), prereg: frozenPrereg(), dataset, adapterConfig: emitterBypass, budgets: validBudgets(), ledger: createHttpBudgetLedger({ scope: 'x', cap: 5 }), evidenceVerifier: testEvidenceVerifier() }),
    ).rejects.toThrow(/eventEmitter must be unset/);

    // Valid gate → transport exists; the wired fetch is the budgeted one: with
    // the ledger already at cap, calling it refuses BEFORE any network access.
    const studyLedger = createHttpBudgetLedger({ scope: 'study:AUTH-TEST', cap: 540, costCapUsd: 1.0 });
    const ledger = createHttpBudgetLedger({
      scope: 'EA:REAL_ACTOR_I0',
      cap: 130,
      costCapUsd: 0.2,
      parent: studyLedger,
    });
    const { transport, adapter } = await createAuthorizedPiTransport({
      authorization: validAuthorization(),
      prereg: frozenPrereg(),
      dataset,
      adapterConfig: validAdapterConfig,
      budgets: validBudgets(),
      ledger,
      evidenceVerifier: testEvidenceVerifier(),
    });
    expect(transport.kind).toBe('pi-adapter');
    const wiredConfig = (adapter as unknown as { config: { fetch: unknown } }).config;
    expect(typeof wiredConfig.fetch).toBe('function');
    for (let i = 0; i < 130; i += 1) ledger.reserve('consume the arm HTTP cap');
    const boundedBody = JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'offline guard check' }], max_tokens: 1 });
    await expect((wiredConfig.fetch as (i: string, init?: unknown) => Promise<unknown>)('https://token.sensenova.cn/v1/chat/completions', { method: 'POST', body: boundedBody })).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(ledger.telemetry).toEqual({ retries: 0, repairs: 0 });
  });
});

// ── P1-01/P1-03: actor loop + runner integration (offline rehearsal) ────────

describe('P1-01/P1-03: actor loop and runner budget/usage integration (offline, no network)', () => {
  const goldP1 = goldFor(dataset, 'P1', 'P1');
  const taskP1 = dataset.probes.P1.taskInstructions.join('\n');
  const delivery = deliverPayload({ armId: 'EA:REAL_ACTOR_I0', content: '[EA-policy-marker] policy text' });

  it('usage distinguishes modelRounds from httpRequests; without a ledger httpRequests is null (not zero-by-assumption)', async () => {
    const transport = createFakeActorTransport({ rounds: [{ payload: { type: 'proceed' } }] });
    const noLedger = await runRealActorOpportunity({
      transport, environment: dataset.probes.P1.environment, knownActionNames: KNOWN_ACTIONS,
      manualText: MANUAL_TEXT, taskText: taskP1, delivery, goldRecord: goldP1, opportunityId: 'P1',
    });
    expect(noLedger.usage.modelRounds).toBe(1);
    expect(noLedger.usage.httpRequests).toBeNull();

    const ledger = createHttpBudgetLedger({ scope: 'EA:REAL_ACTOR_I0#P1', cap: 5 });
    const wiredTransport = createFakeActorTransport({ rounds: [{ payload: { type: 'proceed' } }], httpLedger: ledger });
    const withLedger = await runRealActorOpportunity({
      transport: wiredTransport, environment: dataset.probes.P1.environment, knownActionNames: KNOWN_ACTIONS,
      manualText: MANUAL_TEXT, taskText: taskP1, delivery, goldRecord: goldP1, opportunityId: 'P1', httpLedger: ledger,
    });
    expect(withLedger.usage.modelRounds).toBe(1);
    expect(withLedger.usage.httpRequests).toBe(1);
  });

  it('HTTP budget exhaustion is fail-closed MID-opportunity: auditable termination before the next send', async () => {
    const ledger = createHttpBudgetLedger({ scope: 'EA:REAL_ACTOR_I0#P1', cap: 2 });
    // Three scripted rounds, but the opportunity may only spend 2 HTTP requests.
    const transport = createFakeActorTransport({
      rounds: [
        { payload: { type: 'consumer-graph-query', args: { key: 'payment.retryLimit' } } },
        { payload: { type: 'consumer-graph-query', args: { key: 'payment.retryLimit' } } },
        { payload: { type: 'consumer-graph-query', args: { key: 'payment.retryLimit' } } },
      ],
      httpLedger: ledger,
    });
    const result = await runRealActorOpportunity({
      transport, environment: dataset.probes.P1.environment, knownActionNames: KNOWN_ACTIONS,
      manualText: MANUAL_TEXT, taskText: taskP1, delivery, goldRecord: goldP1, opportunityId: 'P1', httpLedger: ledger,
      caps: { ...DEFAULT_REAL_ACTOR_CAPS, maxRequestsPerOpportunity: 16 },
    });
    expect(result.failure?.kind).toBe('budget_exhausted');
    expect(result.actorRunStatus).toBe('INTERRUPTED');
    // Semantics pinned: the refused round counts as an ATTEMPTED model round
    // (it happened, and failed before send) but consumed NO HTTP budget.
    expect(result.usage.modelRounds).toBe(3);
    expect(result.usage.httpRequests).toBe(2);
    expect(ledger.used()).toBe(2);
    const snap = ledger.snapshot();
    expect(snap.levels[0]).toEqual({ scope: 'EA:REAL_ACTOR_I0#P1', cap: 2, used: 2 });
  });

  it('study/arm/opportunity budget chain flows through runRealStudy and lands in arm.usage (audit + retry/repair attribution)', async () => {
    const fakeModel = (request: any) => {
      if (String(request.taskId).endsWith('#i0-reflection')) {
        return { payload: { policyText: '[EA-policy-marker] fake policy' } };
      }
      return { payload: { type: 'proceed' } };
    };
    const run = await runRealStudy({
      dataset,
      transportForArm: (historyId: string, armLedger: unknown) =>
        createFakeActorTransport({ rounds: fakeModel, httpLedger: armLedger ?? undefined }),
      studyId: 'PLE-PILOT-01-BUDGET-REHEARSAL',
      budgets: { httpRequestsPerOpportunity: 3, httpRequestsPerArm: 20, httpRequestsPerStudy: 90 },
    });
    expect(run.stopped).toBeNull();
    expect(run.arms).toHaveLength(4);
    expect(run.budget.levels[0]).toEqual({ scope: 'study:PLE-PILOT-01-BUDGET-REHEARSAL', cap: 90, used: run.budget.levels[0].used });

    const arm = run.arms.find((a: any) => a.historyId === 'EA');
    expect(arm.usage.budget.levels.map((l: any) => l.scope)).toEqual(['EA:REAL_ACTOR_I0', 'study:PLE-PILOT-01-BUDGET-REHEARSAL']);
    expect(arm.usage.budget.levels[0].cap).toBe(20);
    // every opportunity carried its own scoped snapshot with the opportunity cap
    for (const opp of arm.usage.opportunities) {
      expect(opp.budget.levels[0].cap).toBe(3);
      expect(opp.httpRequests).toBeGreaterThan(0);
      expect(opp.httpRequests).toBeLessThanOrEqual(3);
    }
    // P1-03 audit: fake-transport rows are rehearsal rows — usage explicitly unavailable
    expect(arm.usage.tokenAudit.httpRequests).toBe(arm.usage.budget.levels[0].used);
    expect(arm.usage.tokenAudit.totalsAvailable).toBe(false);
    expect(arm.usage.tokenAudit.requestsWithoutUsage).toBe(arm.usage.tokenAudit.httpRequests);
    // retry/repair attribution is not wired for fake transports — explicit null
    expect(arm.usage.retries).toBeNull();
    expect(arm.usage.repairs).toBeNull();
  });

  it('token audit aggregates available usage exactly and flags partial availability', () => {
    const ledger = createHttpBudgetLedger({ scope: 'audit', cap: null });
    const g1 = ledger.reserve();
    ledger.record(g1, { url: 'a', status: 200, tokenUsage: { inputTokens: 10, outputTokens: 5 }, usageSource: 'http_stream_usage' });
    const g2 = ledger.reserve();
    ledger.record(g2, { url: 'b', status: 200, tokenUsage: { inputTokens: 20, outputTokens: 8 }, usageSource: 'http_stream_usage' });
    const g3 = ledger.reserve();
    ledger.record(g3, { url: 'c', status: 200, tokenUsage: null, usageSource: 'unavailable' });

    const audit = auditTokenUsage(ledger.requests());
    expect(audit.httpRequests).toBe(3);
    expect(audit.requestsWithUsage).toBe(2);
    expect(audit.requestsWithoutUsage).toBe(1);
    expect(audit.inputTokens).toBe(30);
    expect(audit.outputTokens).toBe(13);
    expect(audit.totalsAvailable).toBe(false); // partial provider coverage is visible, not averaged away
    expect(audit.usageSourceCounts).toEqual({ http_stream_usage: 2, unavailable: 1 });

    const full = createHttpBudgetLedger({ scope: 'audit2', cap: null });
    const f1 = full.reserve();
    full.record(f1, { url: 'a', status: 200, tokenUsage: { inputTokens: 1, outputTokens: 2 }, usageSource: 'http_stream_usage' });
    const auditFull = auditTokenUsage(full.requests());
    expect(auditFull.totalsAvailable).toBe(true);
    expect(auditFull.inputTokens).toBe(1);
    expect(auditFull.outputTokens).toBe(2);
  });
});

// gate-refusal matcher: refusals must be RealRunAuthorizationError with reasons

expect.extend({
  toThrowRealRunAuthorization(received: unknown, pattern: RegExp) {
    let caught: unknown;
    if (received instanceof Error) {
      caught = received; // vitest hands rejected promises to the matcher as Errors
    } else if (typeof received === "function") {
      try {
        const out = (received as () => unknown)();
        void out;
      } catch (err) {
        caught = err;
      }
    }
    const errObj = caught as { name?: string; message?: string; problems?: unknown[] };
    const pass = caught instanceof Error
      && errObj.name === "RealRunAuthorizationError"
      && pattern.test(errObj.message ?? "")
      && Array.isArray(errObj.problems);
    return {
      pass,
      message: () => pass
        ? "expected the gate NOT to refuse with " + String(pattern)
        : "expected a RealRunAuthorizationError matching " + String(pattern) + ", got: " + (caught instanceof Error ? caught.message : String(caught)),
    };
  },
});

describe('P1-01: hierarchical HTTP request ledger (fail-closed at the outbound boundary)', () => {
  it('reserve() commits the whole chain atomically; snapshot reports every level', () => {
    const study = createHttpBudgetLedger({ scope: 'study:S', cap: 10 });
    const arm = createHttpBudgetLedger({ scope: 'arm:EA', cap: 4, parent: study });
    const opp = createHttpBudgetLedger({ scope: 'arm:EA#P1', cap: 2, parent: arm });

    opp.reserve('r1');
    opp.reserve('r2');

    expect(opp.used()).toBe(2);
    expect(arm.used()).toBe(2);
    expect(study.used()).toBe(2);
    const snap = opp.snapshot();
    expect(snap.levels).toEqual([
      { scope: 'arm:EA#P1', cap: 2, used: 2 },
      { scope: 'arm:EA', cap: 4, used: 2 },
      { scope: 'study:S', cap: 10, used: 2 },
    ]);
  });

  it('opportunity cap exhaustion refuses BEFORE send and leaves arm/study untouched', () => {
    const study = createHttpBudgetLedger({ scope: 'study:S', cap: 10 });
    const arm = createHttpBudgetLedger({ scope: 'arm:EA', cap: 4, parent: study });
    const opp = createHttpBudgetLedger({ scope: 'arm:EA#P1', cap: 2, parent: arm });
    opp.reserve();
    opp.reserve();
    expect(() => opp.reserve('third request')).toThrow(BudgetExhaustedError);
    expect(opp.used()).toBe(2);
    expect(arm.used()).toBe(2);
    expect(study.used()).toBe(2);
  });

  it('arm caps are cumulative ACROSS opportunities of the same arm (levels never reset)', () => {
    const study = createHttpBudgetLedger({ scope: 'study:S', cap: 100 });
    const arm = createHttpBudgetLedger({ scope: 'arm:EA', cap: 3, parent: study });
    const p1 = createHttpBudgetLedger({ scope: 'arm:EA#P1', cap: 10, parent: arm });
    const p2 = createHttpBudgetLedger({ scope: 'arm:EA#P2', cap: 10, parent: arm });
    p1.reserve(); p1.reserve();
    p2.reserve();
    expect(() => p2.reserve('fourth arm-level request')).toThrow(BudgetExhaustedError);
    try {
      p2.reserve();
    } catch (err) {
      expect(err.scope).toBe('arm:EA');
      expect(err.used).toBe(3);
      expect(err.cap).toBe(3);
    }
  });

  it('study caps are cumulative across arms; the audit reason survives the error', () => {
    const study = createHttpBudgetLedger({ scope: 'study:S', cap: 3, reason: 'study cap' });
    const armA = createHttpBudgetLedger({ scope: 'arm:E0', cap: null, parent: study });
    const armB = createHttpBudgetLedger({ scope: 'arm:EA', cap: null, parent: study });
    armA.reserve(); armA.reserve();
    armB.reserve();
    expect(() => armB.reserve('fourth study-level request')).toThrow(BudgetExhaustedError);
    try {
      armB.reserve();
    } catch (err) {
      expect(err.scope).toBe('study:S');
      expect(err.reason).toBe('study cap');
    }
  });

  it('multiple callers competing for the LAST slot: exactly one wins, the loser never reaches the fetch', async () => {
    const ledger = createHttpBudgetLedger({ scope: 'race', cap: 1 });
    let baseCalls = 0;
    const baseFetch = async () => {
      baseCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5)); // keep both in flight
      return sseResponseWithUsage('{}', { prompt_tokens: 1, completion_tokens: 1 });
    };
    const fetchA = createBudgetedFetch({ ledger, baseFetch });
    const fetchB = createBudgetedFetch({ ledger, baseFetch });
    const results = await Promise.allSettled([fetchA('https://unit.test/x', {}), fetchB('https://unit.test/x', {})]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BudgetExhaustedError);
    expect(baseCalls).toBe(1); // the loser NEVER reached the fetch
    expect(ledger.used()).toBe(1);
    expect(ledger.requests()).toHaveLength(1);
  });

  it('caps are validated at creation (0/negative/float refused — no silently useless budget)', () => {
    expect(() => createHttpBudgetLedger({ scope: 'x', cap: 0 })).toThrow(/positive integer or null/);
    expect(() => createHttpBudgetLedger({ scope: 'x', cap: -3 })).toThrow(/positive integer or null/);
    expect(() => createHttpBudgetLedger({ scope: 'x', cap: 1.5 })).toThrow(/positive integer or null/);
  });

  it('budgetedFetch: the SECOND request never reaches the base fetch once the cap is spent (fail-closed before send)', async () => {
    const ledger = createHttpBudgetLedger({ scope: 'cap1', cap: 1 });
    let baseCalls = 0;
    const fetch = createBudgetedFetch({
      ledger,
      baseFetch: async () => {
        baseCalls += 1;
        return sseResponseWithUsage('{"policyText":"x"}', { prompt_tokens: 7, completion_tokens: 3 });
      },
    });
    await fetch('https://unit.test/a', {});
    expect(baseCalls).toBe(1);
    await expect(fetch('https://unit.test/b', {})).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(baseCalls).toBe(1); // unchanged — nothing was sent
    const row = ledger.requests()[0];
    expect(row.tokenUsage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(row.usageSource).toBe('http_stream_usage');
  });

  it('budgetedFetch records provider-absent usage as explicitly unavailable (never guessed) and keeps error rows', async () => {
    const ledger = createHttpBudgetLedger({ scope: 'usage-audit', cap: null });
    const baseFetch = async (input: string) => {
      if (String(input).endsWith('boom')) throw new Error('ECONNRESET (simulated)');
      return sseResponseWithUsage('{"policyText":"no usage chunk"}', undefined);
    };
    const fetch = createBudgetedFetch({ ledger, baseFetch });
    await fetch('https://unit.test/no-usage', {});
    await expect(fetch('https://unit.test/boom', {})).rejects.toThrow(/ECONNRESET/);
    const rows = ledger.requests();
    expect(rows).toHaveLength(2);
    expect(rows[0].tokenUsage).toBeNull();
    expect(rows[0].usageSource).toBe('unavailable');
    expect(rows[1].status).toBeNull();
    expect(rows[1].error).toContain('ECONNRESET');
    expect(rows[1].usageSource).toBe('unavailable');
    const audit = auditTokenUsage(ledger.requests());
    expect(audit.httpRequests).toBe(2);
    expect(audit.totalsAvailable).toBe(false);
    expect(audit.requestsWithoutUsage).toBe(2);
  });
});

// ── P1-02: fail-closed real-run authorization gate ──────────────────────────

describe('P1-02: real-model transport authorization gate (zero HTTP on refusal)', () => {
  it('refuses a DRAFT preregistration (DRAFT_NOT_OWNER_APPROVED can never authorize) and lists all problems', () => {
    expect(() =>
      verifyRealRunAuthorization({ authorization: validAuthorization(), prereg, dataset, adapterConfig: validAdapterConfig, budgets: validBudgets() }),).toThrowRealRunAuthorization(/OD-1.*DRAFT_NOT_OWNER_APPROVED/);
  });

  it('refuses when authorization is entirely missing', () => {
    expect(() =>
      verifyRealRunAuthorization({ authorization: null, prereg: frozenPrereg(), dataset, adapterConfig: validAdapterConfig, budgets: validBudgets() }),
    ).toThrowRealRunAuthorization(/authorization record missing/);
  });

  it('refuses od1 with a literal-true violation, a missing decision ref, or a stale fixture hash', () => {
    const stale = validAuthorization();
    stale.od1.frozenFixtureHash = 'deadbeef';
    expect(() => verifyRealRunAuthorization({ authorization: stale, prereg: frozenPrereg(), dataset, adapterConfig: validAdapterConfig, budgets: validBudgets() }))
      .toThrowRealRunAuthorization(/frozenFixtureHash/);

    const unapproved = validAuthorization();
    unapproved.od1.approved = 'yes' as unknown as boolean;
    expect(() => verifyRealRunAuthorization({ authorization: unapproved, prereg: frozenPrereg(), dataset, adapterConfig: validAdapterConfig, budgets: validBudgets() }))
      .toThrowRealRunAuthorization(/literal true/);

    const noRef = validAuthorization();
    noRef.od1.decisionRef = '';
    expect(() => verifyRealRunAuthorization({ authorization: noRef, prereg: frozenPrereg(), dataset, adapterConfig: validAdapterConfig, budgets: validBudgets() }))
      .toThrowRealRunAuthorization(/decisionRef/);
  });

  it('refuses od2 missing cost caps, missing cost basis, or total < per-run', () => {
    const noCost = validAuthorization();
    noCost.od2.perRunCostCapUsd = undefined as unknown as number;
    expect(() => verifyRealRunAuthorization({ authorization: noCost, prereg: frozenPrereg(), dataset, adapterConfig: validAdapterConfig, budgets: validBudgets() }))
      .toThrowRealRunAuthorization(/perRunCostCapUsd/);

    const noBasis = validAuthorization();
    noBasis.od2.costBasisRef = '';
    expect(() => verifyRealRunAuthorization({ authorization: noBasis, prereg: frozenPrereg(), dataset, adapterConfig: validAdapterConfig, budgets: validBudgets() }))
      .toThrowRealRunAuthorization(/costBasisRef/);

    const inverted = validAuthorization();
    inverted.od2.totalCostCapUsd = 0.1;
    expect(() => verifyRealRunAuthorization({ authorization: inverted, prereg: frozenPrereg(), dataset, adapterConfig: validAdapterConfig, budgets: validBudgets() }))
      .toThrowRealRunAuthorization(/totalCostCapUsd must be >= perRunCostCapUsd/);
  });

  it('refuses od3 with zero seeds or an unfrozen record', () => {
    const noSeeds = validAuthorization();
    noSeeds.od3.seeds = 0;
    expect(() => verifyRealRunAuthorization({ authorization: noSeeds, prereg: frozenPrereg(), dataset, adapterConfig: validAdapterConfig, budgets: validBudgets() }))
      .toThrowRealRunAuthorization(/seeds/);

    const unfrozen = validAuthorization();
    unfrozen.od3.frozen = false;
    expect(() => verifyRealRunAuthorization({ authorization: unfrozen, prereg: frozenPrereg(), dataset, adapterConfig: validAdapterConfig, budgets: validBudgets() }))
      .toThrowRealRunAuthorization(/frozen/);
  });

  it('refuses parameter drift (provider/model/baseUrl or budget caps differ from the authorized values)', () => {
    const driftModel = { ...validAdapterConfig, model: 'some-other-model' };
    expect(() => verifyRealRunAuthorization({ authorization: validAuthorization(), prereg: frozenPrereg(), dataset, adapterConfig: driftModel, budgets: validBudgets() }))
      .toThrowRealRunAuthorization(/drift: adapterConfig\.model/);

    const driftBudgets = { ...validBudgets(), httpRequestsPerStudy: 999_999 };
    expect(() => verifyRealRunAuthorization({ authorization: validAuthorization(), prereg: frozenPrereg(), dataset, adapterConfig: validAdapterConfig, budgets: driftBudgets }))
      .toThrowRealRunAuthorization(/drift: budgets\.httpRequestsPerStudy/);
  });

  it('createAuthorizedPiTransport throws BEFORE constructing anything when the gate refuses — zero HTTP possible', async () => {
    await expect(
      createAuthorizedPiTransport({ authorization: validAuthorization(), prereg, dataset, adapterConfig: validAdapterConfig, budgets: validBudgets(), ledger: createHttpBudgetLedger({ scope: 'x', cap: 5 }) }),
    ).rejects.toThrowRealRunAuthorization(/DRAFT_NOT_OWNER_APPROVED/);
  });

  // timeout: the factory dynamically imports the core dist — under a fully
  // parallel suite run that first load can take seconds; the default 5s test
  // timeout is too tight for a cold cache.
  it('createAuthorizedPiTransport refuses fetch/eventEmitter injection (no bypass path) and builds a budget-wired adapter when valid', { timeout: 120_000 }, async () => {
    const bypass = { ...validAdapterConfig, fetch: (async () => new Response('{}')) as unknown };
    await expect(
      createAuthorizedPiTransport({ authorization: validAuthorization(), prereg: frozenPrereg(), dataset, adapterConfig: bypass, budgets: validBudgets(), ledger: createHttpBudgetLedger({ scope: 'x', cap: 5 }), evidenceVerifier: testEvidenceVerifier() }),
    ).rejects.toThrow(/adapterConfig\.fetch must be unset/);

    const emitterBypass = { ...validAdapterConfig, eventEmitter: {} as unknown };
    await expect(
      createAuthorizedPiTransport({ authorization: validAuthorization(), prereg: frozenPrereg(), dataset, adapterConfig: emitterBypass, budgets: validBudgets(), ledger: createHttpBudgetLedger({ scope: 'x', cap: 5 }), evidenceVerifier: testEvidenceVerifier() }),
    ).rejects.toThrow(/eventEmitter must be unset/);

    // Valid gate → transport exists; the wired fetch is the budgeted one: with
    // the ledger already at cap, calling it refuses BEFORE any network access.
    const studyLedger = createHttpBudgetLedger({ scope: 'study:AUTH-TEST', cap: 540, costCapUsd: 1.0 });
    const ledger = createHttpBudgetLedger({
      scope: 'EA:REAL_ACTOR_I0',
      cap: 130,
      costCapUsd: 0.2,
      parent: studyLedger,
    });
    const { transport, adapter } = await createAuthorizedPiTransport({
      authorization: validAuthorization(),
      prereg: frozenPrereg(),
      dataset,
      adapterConfig: validAdapterConfig,
      budgets: validBudgets(),
      ledger,
      evidenceVerifier: testEvidenceVerifier(),
    });
    expect(transport.kind).toBe('pi-adapter');
    const wiredConfig = (adapter as unknown as { config: { fetch: unknown } }).config;
    expect(typeof wiredConfig.fetch).toBe('function');
    for (let i = 0; i < 130; i += 1) ledger.reserve('consume the arm HTTP cap');
    const boundedBody = JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'offline guard check' }], max_tokens: 1 });
    await expect((wiredConfig.fetch as (i: string, init?: unknown) => Promise<unknown>)('https://token.sensenova.cn/v1/chat/completions', { method: 'POST', body: boundedBody })).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(ledger.telemetry).toEqual({ retries: 0, repairs: 0 });
  });
});

// ── P1-01/P1-03: actor loop + runner integration (offline rehearsal) ────────

describe('P1-01/P1-03: actor loop and runner budget/usage integration (offline, no network)', () => {
  const goldP1 = goldFor(dataset, 'P1', 'P1');
  const taskP1 = dataset.probes.P1.taskInstructions.join('\n');
  const delivery = deliverPayload({ armId: 'EA:REAL_ACTOR_I0', content: '[EA-policy-marker] policy text' });

  it('usage distinguishes modelRounds from httpRequests; without a ledger httpRequests is null (not zero-by-assumption)', async () => {
    const transport = createFakeActorTransport({ rounds: [{ payload: { type: 'proceed' } }] });
    const noLedger = await runRealActorOpportunity({
      transport, environment: dataset.probes.P1.environment, knownActionNames: KNOWN_ACTIONS,
      manualText: MANUAL_TEXT, taskText: taskP1, delivery, goldRecord: goldP1, opportunityId: 'P1',
    });
    expect(noLedger.usage.modelRounds).toBe(1);
    expect(noLedger.usage.httpRequests).toBeNull();

    const ledger = createHttpBudgetLedger({ scope: 'EA:REAL_ACTOR_I0#P1', cap: 5 });
    const wiredTransport = createFakeActorTransport({ rounds: [{ payload: { type: 'proceed' } }], httpLedger: ledger });
    const withLedger = await runRealActorOpportunity({
      transport: wiredTransport, environment: dataset.probes.P1.environment, knownActionNames: KNOWN_ACTIONS,
      manualText: MANUAL_TEXT, taskText: taskP1, delivery, goldRecord: goldP1, opportunityId: 'P1', httpLedger: ledger,
    });
    expect(withLedger.usage.modelRounds).toBe(1);
    expect(withLedger.usage.httpRequests).toBe(1);
  });

  it('HTTP budget exhaustion is fail-closed MID-opportunity: auditable termination before the next send', async () => {
    const ledger = createHttpBudgetLedger({ scope: 'EA:REAL_ACTOR_I0#P1', cap: 2 });
    // Three scripted rounds, but the opportunity may only spend 2 HTTP requests.
    const transport = createFakeActorTransport({
      rounds: [
        { payload: { type: 'consumer-graph-query', args: { key: 'payment.retryLimit' } } },
        { payload: { type: 'consumer-graph-query', args: { key: 'payment.retryLimit' } } },
        { payload: { type: 'consumer-graph-query', args: { key: 'payment.retryLimit' } } },
      ],
      httpLedger: ledger,
    });
    const result = await runRealActorOpportunity({
      transport, environment: dataset.probes.P1.environment, knownActionNames: KNOWN_ACTIONS,
      manualText: MANUAL_TEXT, taskText: taskP1, delivery, goldRecord: goldP1, opportunityId: 'P1', httpLedger: ledger,
      caps: { ...DEFAULT_REAL_ACTOR_CAPS, maxRequestsPerOpportunity: 16 },
    });
    expect(result.failure?.kind).toBe('budget_exhausted');
    expect(result.actorRunStatus).toBe('INTERRUPTED');
    // Semantics pinned: the refused round counts as an ATTEMPTED model round
    // (it happened, and failed before send) but consumed NO HTTP budget.
    expect(result.usage.modelRounds).toBe(3);
    expect(result.usage.httpRequests).toBe(2);
    expect(ledger.used()).toBe(2);
    const snap = ledger.snapshot();
    expect(snap.levels[0]).toEqual({ scope: 'EA:REAL_ACTOR_I0#P1', cap: 2, used: 2 });
  });

  it('study/arm/opportunity budget chain flows through runRealStudy and lands in arm.usage (audit + retry/repair attribution)', async () => {
    const fakeModel = (request: any) => {
      if (String(request.taskId).endsWith('#i0-reflection')) {
        return { payload: { policyText: '[EA-policy-marker] fake policy' } };
      }
      return { payload: { type: 'proceed' } };
    };
    const run = await runRealStudy({
      dataset,
      transportForArm: (historyId: string, armLedger: unknown) =>
        createFakeActorTransport({ rounds: fakeModel, httpLedger: armLedger ?? undefined }),
      studyId: 'PLE-PILOT-01-BUDGET-REHEARSAL',
      budgets: { httpRequestsPerOpportunity: 3, httpRequestsPerArm: 20, httpRequestsPerStudy: 90 },
    });
    expect(run.stopped).toBeNull();
    expect(run.arms).toHaveLength(4);
    expect(run.budget.levels[0]).toEqual({ scope: 'study:PLE-PILOT-01-BUDGET-REHEARSAL', cap: 90, used: run.budget.levels[0].used });

    const arm = run.arms.find((a: any) => a.historyId === 'EA');
    expect(arm.usage.budget.levels.map((l: any) => l.scope)).toEqual(['EA:REAL_ACTOR_I0', 'study:PLE-PILOT-01-BUDGET-REHEARSAL']);
    expect(arm.usage.budget.levels[0].cap).toBe(20);
    // every opportunity carried its own scoped snapshot with the opportunity cap
    for (const opp of arm.usage.opportunities) {
      expect(opp.budget.levels[0].cap).toBe(3);
      expect(opp.httpRequests).toBeGreaterThan(0);
      expect(opp.httpRequests).toBeLessThanOrEqual(3);
    }
    // P1-03 audit: fake-transport rows are rehearsal rows — usage explicitly unavailable
    expect(arm.usage.tokenAudit.httpRequests).toBe(arm.usage.budget.levels[0].used);
    expect(arm.usage.tokenAudit.totalsAvailable).toBe(false);
    expect(arm.usage.tokenAudit.requestsWithoutUsage).toBe(arm.usage.tokenAudit.httpRequests);
    // retry/repair attribution is not wired for fake transports — explicit null
    expect(arm.usage.retries).toBeNull();
    expect(arm.usage.repairs).toBeNull();
  });

  it('token audit aggregates available usage exactly and flags partial availability', () => {
    const ledger = createHttpBudgetLedger({ scope: 'audit', cap: null });
    const g1 = ledger.reserve();
    ledger.record(g1, { url: 'a', status: 200, tokenUsage: { inputTokens: 10, outputTokens: 5 }, usageSource: 'http_stream_usage' });
    const g2 = ledger.reserve();
    ledger.record(g2, { url: 'b', status: 200, tokenUsage: { inputTokens: 20, outputTokens: 8 }, usageSource: 'http_stream_usage' });
    const g3 = ledger.reserve();
    ledger.record(g3, { url: 'c', status: 200, tokenUsage: null, usageSource: 'unavailable' });

    const audit = auditTokenUsage(ledger.requests());
    expect(audit.httpRequests).toBe(3);
    expect(audit.requestsWithUsage).toBe(2);
    expect(audit.requestsWithoutUsage).toBe(1);
    expect(audit.inputTokens).toBe(30);
    expect(audit.outputTokens).toBe(13);
    expect(audit.totalsAvailable).toBe(false); // partial provider coverage is visible, not averaged away
    expect(audit.usageSourceCounts).toEqual({ http_stream_usage: 2, unavailable: 1 });

    const full = createHttpBudgetLedger({ scope: 'audit2', cap: null });
    const f1 = full.reserve();
    full.record(f1, { url: 'a', status: 200, tokenUsage: { inputTokens: 1, outputTokens: 2 }, usageSource: 'http_stream_usage' });
    const auditFull = auditTokenUsage(full.requests());
    expect(auditFull.totalsAvailable).toBe(true);
    expect(auditFull.inputTokens).toBe(1);
    expect(auditFull.outputTokens).toBe(2);
  });
});

describe('P1-01 USD cost guard: conservative pre-send reservation', () => {
  const costGuard = () => createCostBudgetGuard({
    provider: 'provider-a',
    model: 'model-a',
    baseUrl: 'https://unit.test',
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 10,
    maxInputTokensPerRequest: 10_000,
    maxOutputTokensPerRequest: 1_024,
    perRequestCostCapUsd: 0.2,
  });
  const body = JSON.stringify({
    model: 'model-a',
    messages: [{ role: 'user', content: 'bounded test request' }],
    max_tokens: 1_000,
  });

  it('reserves arm and shared study USD caps before send; a later arm cannot exceed the study cap', async () => {
    const study = createHttpBudgetLedger({ scope: 'study:usd', costCapUsd: 0.015 });
    const armA = createHttpBudgetLedger({ scope: 'arm:A', costCapUsd: 0.012, parent: study });
    const armB = createHttpBudgetLedger({ scope: 'arm:B', costCapUsd: 0.012, parent: study });
    let baseCalls = 0;
    const baseFetch = async () => {
      baseCalls += 1;
      return sseResponseWithUsage('{}', { prompt_tokens: 1, completion_tokens: 1 });
    };
    const fetchA = createBudgetedFetch({ ledger: armA, costGuard: costGuard(), baseFetch });
    const fetchB = createBudgetedFetch({ ledger: armB, costGuard: costGuard(), baseFetch });

    await fetchA('https://unit.test/a', { method: 'POST', body });
    await expect(fetchB('https://unit.test/b', { method: 'POST', body })).rejects.toBeInstanceOf(CostBudgetExhaustedError);

    expect(baseCalls).toBe(1);
    expect(armA.snapshot().costLevels[0].reservedUsd).toBeGreaterThan(0);
    expect(study.snapshot().costLevels[0].reservedUsd).toBeGreaterThan(0);
    expect(study.snapshot().costLevels[0].reservedUsd).toBeLessThanOrEqual(0.015);
  });

  it('fails closed before HTTP when the body has no explicit output-token ceiling', async () => {
    const ledger = createHttpBudgetLedger({ scope: 'arm:bad-request', costCapUsd: 0.2 });
    let baseCalls = 0;
    const fetch = createBudgetedFetch({
      ledger,
      costGuard: costGuard(),
      baseFetch: async () => {
        baseCalls += 1;
        return new Response('{}');
      },
    });
    await expect(fetch('https://unit.test/no-cap', {
      method: 'POST',
      body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'no output cap' }] }),
    })).rejects.toBeInstanceOf(CostBudgetExhaustedError);
    expect(baseCalls).toBe(0);
    expect(ledger.used()).toBe(0);
    expect(ledger.costUsedUsd()).toBe(0);
  });
});

describe('P1-02 trusted authorization evidence', () => {
  it('refuses non-empty approval/pricing references unless a trusted resolver verifies them', () => {
    expect(() => verifyRealRunAuthorization({
      authorization: validAuthorization(),
      prereg: frozenPrereg(),
      dataset,
      adapterConfig: validAdapterConfig,
      budgets: validBudgets(),
    })).toThrowRealRunAuthorization(/trusted evidenceVerifier missing/);
  });

  it('refuses a decision reference whose authoritative evidence does not approve the frozen fixture', () => {
    const verifier = testEvidenceVerifier();
    const unapprovedVerifier = (request: { kind: string; reference: string }) => {
      const evidence = verifier(request);
      return request.kind === 'owner-decision'
        ? { ...evidence, approved: false }
        : evidence;
    };
    expect(() => verifyRealRunAuthorization({
      authorization: validAuthorization(),
      prereg: frozenPrereg(),
      dataset,
      adapterConfig: validAdapterConfig,
      budgets: validBudgets(),
      evidenceVerifier: unapprovedVerifier,
    })).toThrowRealRunAuthorization(/referenced Owner decision is not explicitly approved/);
  });

  it('refuses rates that differ from the independently verified official price schedule', () => {
    const verifier = testEvidenceVerifier();
    const stalePriceVerifier = (request: { kind: string; reference: string }) => {
      const evidence = verifier(request);
      return request.kind === 'cost-basis'
        ? { ...evidence, outputUsdPerMillionTokens: evidence.outputUsdPerMillionTokens + 1 }
        : evidence;
    };
    expect(() => verifyRealRunAuthorization({
      authorization: validAuthorization(),
      prereg: frozenPrereg(),
      dataset,
      adapterConfig: validAdapterConfig,
      budgets: validBudgets(),
      evidenceVerifier: stalePriceVerifier,
    })).toThrowRealRunAuthorization(/do not match the verified official pricing evidence/);
  });
});
