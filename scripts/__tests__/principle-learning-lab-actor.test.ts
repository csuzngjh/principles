// PRI-966 G2 — real-actor wiring offline rehearsal suite (task Phase B4).
//
// Proves the real-actor plumbing with deterministic fake transports ONLY:
// interactive observation→action reactivity, terminal stop, bounded invalid
// handling, hard caps, canary (NT-01) abort, cross-arm isolation, freeze
// integrity, same-channel delivery, oracle↔evaluator consistency, and the
// production-boundary wiring shape (schema ref + StartRunInput placement via
// a fake adapter — no socket is ever opened).
//
// These tests validate WIRING, not model behavior: a green suite does NOT
// say anything about real principle learning (prereg C-E/C-A stay
// NOT_ESTIMABLE until OD-authorized real runs).

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Value } from '@sinclair/typebox/value';
import {
  LearningLabActorActionV1Schema,
  LEARNING_LAB_ACTOR_ACTION_NAMES,
} from '@principles/core/runtime-v2';

import {
  DEFAULT_REAL_ACTOR_CAPS,
  createFakeActorTransport,
  createPiAdapterTransport,
  runRealActorOpportunity,
  validateActorAction,
} from '../dev/principle-learning-lab/lib/actor.mjs';
import { REAL_ACTOR_STRATEGY_ID, runRealArm, runRealStudy } from '../dev/principle-learning-lab/lib/real-runner.mjs';
import {
  allOpportunities,
  goldFor,
  loadDataset,
  sha256,
} from '../dev/principle-learning-lab/lib/fixture.mjs';
import { ACTION_COSTS } from '../dev/principle-learning-lab/lib/oracle.mjs';
import { buildStudySidecar, validateSidecar } from '../dev/principle-learning-lab/lib/sidecar.mjs';
import { deliverPayload } from '../dev/principle-learning-lab/lib/g2.mjs';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dev', 'principle-learning-lab', 'fixtures');
const dataset = loadDataset(FIXTURES);
const MANUAL_TEXT = dataset.worldManual.manualText.join('\n');
const KNOWN_ACTIONS = Object.keys(ACTION_COSTS);

// ── deterministic offline "model": a fixed policy expressed as a function of
// ── the actual round prompt (exactly the evidence a real model would get).
function offlinePolicyModel(request: any): { payload: any } {
  if (String(request.taskId).endsWith('#i0-reflection')) {
    const arm = String(request.taskId).split(':')[0];
    return {
      payload: {
        policyText: `[${arm}-policy-marker] Run the cheapest discriminating consumer check before deploying when no current credible evidence covers the change; rely on current credible evidence when it exists.`,
      },
    };
  }
  const taskText = request.userPrompt.split('\n\n--- applied context ---')[0];
  const transcript = request.userPrompt.split('--- transcript so far ---')[1] ?? '';
  const key = taskText.match(/config key `([^`]+)`/)?.[1];
  const didCheck = transcript.includes('"type":"consumer-graph-query"');
  const rot = transcript.includes('is NOT current');
  const currentEvidence = /attached harness coverage report/.test(taskText) && /generated (now|2 days ago)/.test(taskText);
  const runbookReliance = /your runbook plan is to rely on it/i.test(taskText);
  const harnessId = taskText.match(/([a-z]+-contracts)/)?.[1];
  const askedHarness = transcript.includes('"type":"harness-status"');

  if (runbookReliance && harnessId && !askedHarness && !rot) {
    return { payload: { type: 'harness-status', args: { harness: harnessId } } };
  }
  if (rot && !didCheck) {
    return { payload: { type: 'consumer-graph-query', args: { key } } };
  }
  if (didCheck) {
    const discovered = transcript.match(/consumers: ([^\n]+)/)?.[1] ?? '';
    const ids = discovered.split(',').map((s: string) => s.trim().match(/([a-z0-9-]+)/)?.[1] ?? '').filter(Boolean);
    const shimmed = [...transcript.matchAll(/compat alias added for consumer '([a-z0-9-]+)'/g)].map((m) => m[1]);
    const missing = ids.find((id: string) => !shimmed.includes(id));
    if (missing) return { payload: { type: 'compat-shim', args: { consumer: missing } } };
    return { payload: { type: 'proceed' } };
  }
  if (currentEvidence && !rot) {
    return { payload: { type: 'proceed' } };
  }
  return { payload: { type: 'consumer-graph-query', args: { key } } };
}

function armTransport(historyId: string) {
  return createFakeActorTransport({ rounds: offlinePolicyModel });
}

describe('core contract ↔ lab registry (single action truth)', () => {
  it('the registered schema action union equals the oracle ACTION_COSTS registry', () => {
    expect([...LEARNING_LAB_ACTOR_ACTION_NAMES].sort()).toEqual([...KNOWN_ACTIONS].sort());
  });

  it('a well-formed action validates against the production schema; malformed ones fail', () => {
    expect(Value.Check(LearningLabActorActionV1Schema, { type: 'consumer-graph-query', args: { key: 'payment.retryLimit' } })).toBe(true);
    expect(Value.Check(LearningLabActorActionV1Schema, { type: 'teleport' })).toBe(false);
    expect(Value.Check(LearningLabActorActionV1Schema, { type: 'proceed', secretField: 1 })).toBe(false);
  });

  it('lab-side validateActorAction mirrors the schema verdicts', () => {
    expect(validateActorAction({ type: 'decline', args: { reason: 'x' } }, KNOWN_ACTIONS).ok).toBe(true);
    expect(validateActorAction({ type: 'nope' }, KNOWN_ACTIONS).ok).toBe(false);
    expect(validateActorAction('proceed', KNOWN_ACTIONS).ok).toBe(false);
    expect(validateActorAction({ type: 'proceed', args: { key: 42 } }, KNOWN_ACTIONS).ok).toBe(false);
  });
});

describe('production transport wiring (offline — fake adapter, no socket)', () => {
  it('createPiAdapterTransport drives the PDRuntimeAdapter boundary with the registered schema ref', async () => {
    const started: any[] = [];
    const fakeAdapter = {
      async startRun(input: any) {
        started.push(input);
        return { runId: `run-${started.length}` };
      },
      async fetchOutput(runId: string) {
        return { runId, payload: { type: 'proceed' } };
      },
    };
    const transport = createPiAdapterTransport({ adapter: fakeAdapter });
    const out = await transport.complete({
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      outputSchemaRef: 'learning-lab-actor-action-v1',
      maxTokens: 512,
      timeoutMs: 1000,
      taskId: 'EA#P1#turn1',
    });
    expect(out.payload).toEqual({ type: 'proceed' });
    expect(started).toHaveLength(1);
    expect(started[0].agentSpec).toEqual({ agentId: 'learning-lab-actor', schemaVersion: 'v1' });
    expect(started[0].outputSchemaRef).toBe('learning-lab-actor-action-v1');
    expect(started[0].inputPayload).toBe('USER');
    expect(started[0].systemPrompt).toBe('SYS');
    expect(started[0].contextItems).toEqual([]);
  });

  it('a null fetchOutput becomes a labeled no_response failure', async () => {
    const fakeAdapter = {
      async startRun() {
        return { runId: 'r1' };
      },
      async fetchOutput() {
        return null;
      },
    };
    const transport = createPiAdapterTransport({ adapter: fakeAdapter });
    await expect(
      transport.complete({ systemPrompt: 's', userPrompt: 'u', outputSchemaRef: 'learning-lab-actor-action-v1', maxTokens: 64, timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'no_response' });
  });

  it('rejects an adapter without the boundary methods', () => {
    expect(() => createPiAdapterTransport({ adapter: {} as any })).toThrow(/startRun\/fetchOutput/);
  });
});

describe('interactive actor loop (offline fake transport)', () => {
  const deliveryEA = deliverPayload({ armId: 'EA:REAL_ACTOR_I0', content: '[EA-policy-marker] policy text' });

  it('reacts to the first observation: harness-status → rot reveal → consumer-graph (actions change because the observation changed)', async () => {
    const transport = createFakeActorTransport({
      rounds: [
        { payload: { type: 'harness-status', args: { harness: 'search-contracts' } } },
        (req: any) => {
          // second round MUST see the rot observation from round one
          const sawRot = req.userPrompt.includes('is NOT current');
          return sawRot
            ? { payload: { type: 'consumer-graph-query', args: { key: 'search.pageSize' } } }
            : { payload: { type: 'proceed' } };
        },
        () => ({ payload: { type: 'proceed' } }),
      ],
    });
    const result = await runRealActorOpportunity({
      transport,
      environment: dataset.probes.P4.opportunities[0].environment,
      knownActionNames: KNOWN_ACTIONS,
      manualText: MANUAL_TEXT,
      taskText: dataset.probes.P4.opportunities[0].taskInstructions.join('\n'),
      delivery: deliveryEA,
      goldRecord: goldFor(dataset, 'P4', 'P4:phase-a'),
      opportunityId: 'P4:phase-a',
    });
    expect(result.failure).toBeNull();
    expect(result.actorRunStatus).toBe('COMPLETED');
    expect(result.outcome.rotRevealed).toBe(true);
    expect(result.outcome.checksRun).toEqual(['harness-status', 'consumer-graph-query']);
    expect(transport.calls()).toHaveLength(3);
  });

  it('stops calling the model once the task reaches a terminal action', async () => {
    const transport = createFakeActorTransport({ rounds: [{ payload: { type: 'proceed' } }, { payload: { type: 'proceed' } }] });
    const result = await runRealActorOpportunity({
      transport,
      environment: dataset.probes.P2.environment,
      knownActionNames: KNOWN_ACTIONS,
      manualText: MANUAL_TEXT,
      taskText: dataset.probes.P2.taskInstructions.join('\n'),
      delivery: deliveryEA,
      goldRecord: goldFor(dataset, 'P2', 'P2'),
      opportunityId: 'P2',
    });
    expect(result.outcome.terminalAction).toBe('proceed');
    expect(result.usage.requests).toBe(1);
    expect(transport.calls()).toHaveLength(1); // the scripted second round was never consumed
  });

  it('invalid output is recorded, never executed, and only re-prompted within the bounded allowance', async () => {
    const transport = createFakeActorTransport({
      rounds: [
        { payload: { type: 'time-travel' } }, // unknown action
        { payload: 'not-an-object' }, // garbage
        { payload: { type: 'proceed' } }, // would run only if allowance allowed a 3rd try — it must not
      ],
    });
    const result = await runRealActorOpportunity({
      transport,
      environment: dataset.probes.P1.environment,
      knownActionNames: KNOWN_ACTIONS,
      manualText: MANUAL_TEXT,
      taskText: dataset.probes.P1.taskInstructions.join('\n'),
      delivery: deliveryEA,
      goldRecord: goldFor(dataset, 'P1', 'P1'),
      opportunityId: 'P1',
    });
    expect(result.failure?.kind).toBe('invalid_output');
    expect(result.actorRunStatus).toBe('FAILED');
    expect(result.usage.invalidActions).toBe(DEFAULT_REAL_ACTOR_CAPS.maxInvalidActions);
    expect(result.usage.steps).toBe(0); // no invalid action ever reached the oracle
    expect(result.outcome.checksRun).toEqual([]);
    expect(transport.calls()).toHaveLength(2); // bounded: the third script entry was never sent
  });

  it('a transport error fails the run loudly and is recorded', async () => {
    const transport = createFakeActorTransport({ rounds: [new Error('socket ECONNREFUSED (simulated)')] });
    const result = await runRealActorOpportunity({
      transport,
      environment: dataset.probes.P1.environment,
      knownActionNames: KNOWN_ACTIONS,
      manualText: MANUAL_TEXT,
      taskText: dataset.probes.P1.taskInstructions.join('\n'),
      delivery: deliveryEA,
      goldRecord: goldFor(dataset, 'P1', 'P1'),
      opportunityId: 'P1',
    });
    expect(result.failure?.kind).toBe('transport_error');
    expect(result.actorRunStatus).toBe('FAILED');
  });

  it('the per-opportunity request cap is enforced with test evidence', async () => {
    const transport = createFakeActorTransport({ rounds: offlinePolicyModel });
    const caps = { ...DEFAULT_REAL_ACTOR_CAPS, maxRequestsPerOpportunity: 2 };
    const result = await runRealActorOpportunity({
      transport,
      environment: dataset.probes.P1.environment,
      knownActionNames: KNOWN_ACTIONS,
      manualText: MANUAL_TEXT,
      taskText: dataset.probes.P1.taskInstructions.join('\n'),
      delivery: deliveryEA,
      goldRecord: goldFor(dataset, 'P1', 'P1'),
      opportunityId: 'P1',
      caps,
    });
    expect(result.usage.requests).toBe(2);
    expect(result.failure?.kind).toBe('budget_capped');
    expect(result.actorRunStatus).toBe('INTERRUPTED');
    expect(result.outcome.terminalAction).toBe('timeout');
  });

  it('a judge-only canary entering a round prompt aborts as INVALID_PROTOCOL before any model call', async () => {
    const canary = goldFor(dataset, 'P1', 'P1').canaryStrings[0];
    const poisoned = deliverPayload({ armId: 'EA:REAL_ACTOR_I0', content: `policy that leaks ${canary}` });
    const transport = createFakeActorTransport({ rounds: offlinePolicyModel });
    const result = await runRealActorOpportunity({
      transport,
      environment: dataset.probes.P1.environment,
      knownActionNames: KNOWN_ACTIONS,
      manualText: MANUAL_TEXT,
      taskText: dataset.probes.P1.taskInstructions.join('\n'),
      delivery: poisoned,
      goldRecord: goldFor(dataset, 'P1', 'P1'),
      opportunityId: 'P1',
    });
    expect(result.failure?.kind).toBe('invalid_protocol');
    expect(result.canaryLeak).toBe(canary);
    expect(result.usage.requests).toBe(0); // the guard fired BEFORE the transport call
    expect(transport.calls()).toHaveLength(0);
  });
});

describe('real arm + real study (offline rehearsal, all four arms)', () => {
  const transports = new Map<string, ReturnType<typeof armTransport>>();
  const transportForArm = (historyId: string) => {
    const t = armTransport(historyId);
    transports.set(historyId, t);
    return t;
  };

  it('runs E0/EA/EB/EN end-to-end: I0 freeze → same-channel delivery → oracle → three-layer adjudication → valid sidecar', async () => {
    const run = await runRealStudy({ dataset, transportForArm, studyId: 'PLE-PILOT-01-G2-REHEARSAL' });
    expect(run.stopped).toBeNull();
    expect(run.arms.map((a: any) => a.historyId)).toEqual(['E0', 'EA', 'EB', 'EN']);
    expect(run.adjudications).toHaveLength(4 * allOpportunities(dataset).length); // 4 arms × 5 opportunities
    expect(run.adjudications.every((r: any) => r.actorRunStatus === 'COMPLETED' && r.dataQualityFlag === 'VALID')).toBe(true);

    const study = buildStudySidecar({
      dataset,
      studyId: 'PLE-PILOT-01-G2-REHEARSAL',
      arms: run.arms,
      claims: [
        {
          claimId: 'C-E',
          contrastId: 'E0-vs-EA-vs-EB-vs-EN',
          competingExplanations: ['fake-transport rehearsal cannot estimate anything about real agents'],
          analysisUnit: 'episode',
          status: 'NOT_ESTIMABLE',
          interpretation: 'Offline wiring rehearsal with a deterministic fake transport — no real model was called; nothing here supports any experience-sensitivity claim.',
        },
        {
          claimId: 'C-A',
          contrastId: 'real-candidate-vs-summary-vs-raw-vs-none',
          competingExplanations: ['not estimable without real frozen candidates'],
          analysisUnit: 'paired probe',
          status: 'NOT_ESTIMABLE',
          interpretation: 'C-A requires OD-authorized real I0/I1 candidates (pilot-run-config OD-2).',
        },
      ],
      assignment: { randomization: 'none — deterministic offline rehearsal', executionOrder: run.arms.map((a: any) => a.armId), repetitions: 1 },
      runtime: {
        host: 'offline-rehearsal',
        model: 'fake-deterministic-policy-transport',
        costModel: 'zero-offline-mock',
        llmJudge: 'NOT_SUPPORTED (mechanical oracle only)',
        pipelineReachabilityPolicy: 'real-actor rehearsal arms are NOT_REACHED — no PD activation exists or is claimed',
      },
    });
    const problems = validateSidecar({
      dataset,
      study,
      adjudications: run.adjudications,
      actorInputs: run.actorInputs,
      knownStrategyIds: new Set([REAL_ACTOR_STRATEGY_ID]),
    });
    expect(problems).toEqual([]);
  });

  it('freezes the real I0 output verbatim (hash over the exact bytes — no hand-polishing)', async () => {
    const transport = armTransport('EA');
    const { arm } = await runRealArm({ dataset, historyId: 'EA', transport, studyId: 'S' });
    const expectedPolicy = (offlinePolicyModel({ taskId: 'EA:REAL_ACTOR_I0#i0-reflection', userPrompt: '' }) as any).payload.policyText;
    expect(arm.frozenCandidate.policyText).toBe(expectedPolicy);
    expect(arm.frozenCandidate.contentHash).toBe(sha256(expectedPolicy));
    expect(arm.frozenCandidate.sourceStage).toBe('i0-reflection');
    expect(arm.frozenCandidate.principleId).toBeNull(); // NT-06 — no fabricated governance identity
    expect(arm.delivery.payloadText).toBe(expectedPolicy); // same-channel: delivered bytes == frozen bytes
  });

  it('E0 is the none-arm: no I0 call, empty payload, transparent sentinel freeze', async () => {
    const transport = armTransport('E0');
    const { arm } = await runRealArm({ dataset, historyId: 'E0', transport, studyId: 'S' });
    const reflectionCalls = transport.calls().filter((c: any) => String(c.taskId).endsWith('#i0-reflection'));
    expect(reflectionCalls).toHaveLength(0);
    expect(arm.delivery.payloadText).toBe('');
    expect(arm.frozenCandidate.deliveredRepresentation).toBe('none');
  });

  it('no cross-arm memory leakage: every arm only ever sees its own delivered policy', async () => {
    await runRealStudy({ dataset, transportForArm, studyId: 'S' });
    const markers = ['[E0-policy-marker]', '[EA-policy-marker]', '[EB-policy-marker]', '[EN-policy-marker]'];
    for (const [historyId, transport] of transports) {
      const own = `[${historyId}-policy-marker]`;
      const postReflection = transport.calls().filter((c: any) => !String(c.taskId).endsWith('#i0-reflection'));
      expect(postReflection.length).toBeGreaterThan(0);
      for (const call of postReflection) {
        const text = `${call.systemPrompt}\n${call.userPrompt}`;
        for (const marker of markers) {
          if (marker === own) {
            // E0 delivers nothing — its own marker never appears either
            if (historyId === 'E0') expect(text.includes(marker)).toBe(false);
            else expect(text.includes(marker)).toBe(true);
          } else {
            expect(text.includes(marker)).toBe(false);
          }
        }
      }
    }
  });

  it('oracle-recorded actions and evaluator rows agree (P2: zero checks, direct proceed on current evidence)', async () => {
    const run = await runRealStudy({ dataset, transportForArm, studyId: 'S' });
    const row = run.adjudications.find((r: any) => r.armId === 'EA:REAL_ACTOR_I0' && r.opportunityId === 'P2');
    expect(row).toBeDefined();
    expect(row.realOutcomes.checksRun).toEqual([]);
    expect(row.realOutcomes.terminalAction).toBe('proceed');
    expect(row.realOutcomes.taskCompleted).toBe(true);
    expect(row.objectiveTaskStatus).toBe('PASS');
    const p2Calls = transports.get('EA')!.calls().filter((c: any) => String(c.taskId).includes('#P2#'));
    expect(p2Calls).toHaveLength(1); // terminal ended the opportunity — exactly one model round
  });

  it('a judge-leak arm stops the study: later arms are not started', async () => {
    const canary = goldFor(dataset, 'P1', 'P1').canaryStrings[0];
    const poisonedPolicy = (req: any) => {
      if (String(req.taskId).endsWith('#i0-reflection')) {
        return { payload: { policyText: `leaky policy mentioning ${canary}` } };
      }
      return offlinePolicyModel(req);
    };
    const run = await runRealStudy({
      dataset,
      transportForArm: (historyId) => createFakeActorTransport({ rounds: historyId === 'EA' ? poisonedPolicy : offlinePolicyModel }),
      studyId: 'S',
      historyIds: ['E0', 'EA', 'EB'],
    });
    expect(run.stopped?.atArm).toBe('EA:REAL_ACTOR_I0');
    expect(run.arms.map((a: any) => a.historyId)).toEqual(['E0', 'EA']); // EB never started
    expect(run.adjudications.some((r: any) => r.dataQualityFlag === 'INVALID_PROTOCOL')).toBe(true);
  });
});
