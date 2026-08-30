/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { PainSignalBridge } from '../../pain-signal-bridge.js';
import type { RuntimeStateManager, CandidateRecord } from '../../store/runtime-state-manager.js';
import type { CandidateIntakeService } from '../../candidate-intake-service.js';
import type { LedgerAdapter, LedgerPrincipleEntry } from '../../candidate-intake.js';
import type { RunnerResult } from '../runner-result.js';
import type { DiagnosticianOutputV1 } from '../../diagnostician-output.js';

const PAIN_ID = 'manual_1779766506353_uotlzvdu';
const TASK_ID = `diagnosis_${PAIN_ID}`;

function makeCandidate(id: string, kind: CandidateRecord['recommendationKind']): CandidateRecord {
  return {
    candidateId: id,
    taskId: TASK_ID,
    artifactId: `artifact-${id}`,
    sourceRunId: `run-${id}`,
    title: `Candidate ${id}`,
    description: `Description for ${id}`,
    confidence: 0.35,
    sourceRecommendationJson: '{}',
    recommendationKind: kind,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}

function makeLedgerEntry(candidateId: string): LedgerPrincipleEntry {
  return {
    id: `ledger-${candidateId}`,
    status: 'probation',
    createdAt: new Date().toISOString(),
    text: `Principle text for ${candidateId}`,
    sourceRef: `candidate://${candidateId}`,
    title: `Principle ${candidateId}`,
    evaluability: 'weak_heuristic',
  };
}

function makeLowConfidenceOutput(): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: 'diag-001',
    summary: 'Conversation entries with empty text content prevent root cause analysis',
    rootCause: 'No other evidence available; only ambiguity note indicates empty content',
    violatedPrinciples: [],
    evidence: [],
    recommendations: [
      { kind: 'principle', description: 'Ensure conversation entries have text content' },
      { kind: 'rule', description: 'Validate input before diagnosis' },
      { kind: 'implementation', description: 'Add input validation' },
      { kind: 'prompt', description: 'Prompt for evidence' },
      { kind: 'defer', description: 'Defer until evidence available' },
    ],
    confidence: 0.35,
    ambiguityNotes: ['No other evidence available; only ambiguity note indicates empty content'],
  };
}

function makeHighConfidenceOutput(): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: 'diag-002',
    summary: 'Valid diagnosis with sufficient evidence',
    rootCause: 'Identified root cause from session trace',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'session-trace-1', note: 'Owner confirmed behavior' }],
    recommendations: [
      { kind: 'principle', description: 'Valid principle from evidence' },
    ],
    confidence: 0.85,
  };
}

function makeBridgeDeps(overrides: {
  candidates?: CandidateRecord[];
  output?: DiagnosticianOutputV1;
  intakeResults?: Map<string, { id: string }>;
}) {
  const intakeResults = overrides.intakeResults ?? new Map<string, { id: string }>();
  const telemetryEvents: Record<string, unknown>[] = [];

  const stateManager: RuntimeStateManager = {
    getTask: async () => null,
    createTask: async () => { return; },
    updateTask: async () => { return; },
    getCandidatesByTaskId: async () => overrides.candidates ?? [],
    getRunsByTask: async () => [{ runId: 'run-1', taskId: TASK_ID, status: 'succeeded' }],
    updateCandidateStatus: async () => { return; },
  } as unknown as RuntimeStateManager;

  const runner = {
    run: async (): Promise<RunnerResult> => ({
      status: 'succeeded',
      taskId: TASK_ID,
      attemptCount: 1,
      output: overrides.output ?? makeLowConfidenceOutput(),
    }),
  };

  const intakeService: CandidateIntakeService = {
    intake: async (candidateId: string) => {
      const result = intakeResults.get(candidateId);
      if (result) return result;
      const entry = { id: `ledger-${candidateId}` };
      intakeResults.set(candidateId, entry);
      return entry;
    },
  } as unknown as CandidateIntakeService;

  const ledgerAdapter: LedgerAdapter = {
    existsForCandidate: (candidateId: string) => {
      const entry = intakeResults.get(candidateId);
      if (entry) return makeLedgerEntry(candidateId);
      return null;
    },
  } as unknown as LedgerAdapter;

  const eventEmitter = {
    emitTelemetry: (event: Record<string, unknown>) => {
      telemetryEvents.push(event);
    },
  };

  return { stateManager, runner, intakeService, ledgerAdapter, eventEmitter, telemetryEvents };
}

describe('PainSignalBridge admission gate integration', () => {
  it('evidence-incomplete diagnosis produces no ledger intake', async () => {
    const candidates = [
      makeCandidate('c-1', 'principle'),
      makeCandidate('c-2', 'rule'),
      makeCandidate('c-3', 'implementation'),
      makeCandidate('c-4', 'prompt'),
      makeCandidate('c-5', 'defer'),
    ];
    const deps = makeBridgeDeps({
      candidates,
      output: makeLowConfidenceOutput(),
    });

    const bridge = new PainSignalBridge({
      stateManager: deps.stateManager,
      runner: deps.runner,
      intakeService: deps.intakeService,
      ledgerAdapter: deps.ledgerAdapter,
      eventEmitter: deps.eventEmitter,
    });

    const result = await bridge.onPainDetected({
      painId: PAIN_ID,
      painType: 'user_frustration',
      source: 'manual',
      reason: 'Test reason',
      provenance: 'owner_reported_no_host_trace',
    });

    expect(result.ledgerEntryIds).toHaveLength(0);
    expect(result.status).toBe('degraded');
    expect(result.admissionResults).toBeDefined();
    const admitted = result.admissionResults?.filter((a) => a.admission.decision === 'admitted') ?? [];
    expect(admitted).toHaveLength(0);
  });

  it('admitted diagnosis creates expected candidate/ledger evidence', async () => {
    const candidates = [makeCandidate('c-admit', 'principle')];
    const deps = makeBridgeDeps({
      candidates,
      output: makeHighConfidenceOutput(),
    });

    const bridge = new PainSignalBridge({
      stateManager: deps.stateManager,
      runner: deps.runner,
      intakeService: deps.intakeService,
      ledgerAdapter: deps.ledgerAdapter,
      eventEmitter: deps.eventEmitter,
    });

    const result = await bridge.onPainDetected({
      painId: 'pain-ok',
      painType: 'tool_failure',
      source: 'openclaw',
      reason: 'Valid reason',
      sessionId: 'session-123',
      provenance: 'host_context_bound',
      evidence: [{ sourceRef: 'session-trace-1', note: 'test evidence' }],
    });

    expect(result.status).toBe('succeeded');
    expect(result.ledgerEntryIds).toHaveLength(1);
    expect(result.admissionResults).toBeDefined();
    const firstAdmission = result.admissionResults?.find((a) => a.candidateId === 'c-admit');
    expect(firstAdmission?.admission.decision).toBe('admitted');
  });

  it('defer recommendation is not treated as activation candidate', async () => {
    const candidates = [makeCandidate('c-defer', 'defer')];
    const deps = makeBridgeDeps({
      candidates,
      output: makeHighConfidenceOutput(),
    });

    const bridge = new PainSignalBridge({
      stateManager: deps.stateManager,
      runner: deps.runner,
      intakeService: deps.intakeService,
      ledgerAdapter: deps.ledgerAdapter,
      eventEmitter: deps.eventEmitter,
    });

    const result = await bridge.onPainDetected({
      painId: 'pain-defer',
      painType: 'user_frustration',
      source: 'openclaw',
      reason: 'Test',
      sessionId: 'session-456',
      provenance: 'host_context_bound',
      evidence: [{ sourceRef: 'session-trace-2', note: 'test evidence' }],
    });

    expect(result.ledgerEntryIds).toHaveLength(0);
    expect(result.admissionResults).toBeDefined();
    const deferResult = result.admissionResults?.find((a) => a.candidateId === 'c-defer');
    expect(deferResult?.admission.decision).toBe('deferred');
    expect(deferResult?.admission.reason).toBe('recommendation_kind_defer_not_actionable');
  });

  it('emits structured telemetry for gated candidates', async () => {
    const candidates = [makeCandidate('c-gated', 'principle')];
    const deps = makeBridgeDeps({
      candidates,
      output: makeLowConfidenceOutput(),
    });

    const bridge = new PainSignalBridge({
      stateManager: deps.stateManager,
      runner: deps.runner,
      intakeService: deps.intakeService,
      ledgerAdapter: deps.ledgerAdapter,
      eventEmitter: deps.eventEmitter,
    });

    await bridge.onPainDetected({
      painId: PAIN_ID,
      painType: 'user_frustration',
      source: 'manual',
      reason: 'Test',
      provenance: 'owner_reported_no_host_trace',
    });

    expect(deps.telemetryEvents.length).toBeGreaterThan(0);
    const [event] = deps.telemetryEvents;
    expect(event?.eventType).toBe('candidate_admission_decision');
    expect(event?.payload).toHaveProperty('decision');
    expect(event?.payload).toHaveProperty('reason');
    expect(event?.payload).toHaveProperty('nextAction');
  });

  it('partial admission: some admitted, some gated', async () => {
    const candidates = [
      makeCandidate('c-ok', 'principle'),
      makeCandidate('c-defer', 'defer'),
    ];
    const deps = makeBridgeDeps({
      candidates,
      output: makeHighConfidenceOutput(),
    });

    const bridge = new PainSignalBridge({
      stateManager: deps.stateManager,
      runner: deps.runner,
      intakeService: deps.intakeService,
      ledgerAdapter: deps.ledgerAdapter,
      eventEmitter: deps.eventEmitter,
    });

    const result = await bridge.onPainDetected({
      painId: 'pain-mixed',
      painType: 'tool_failure',
      source: 'openclaw',
      reason: 'Mixed',
      sessionId: 'session-789',
      provenance: 'host_context_bound',
      evidence: [{ sourceRef: 'session-trace-3', note: 'test evidence' }],
    });

    expect(result.status).toBe('degraded');
    expect(result.ledgerEntryIds).toHaveLength(1);
    expect(result.message).toContain('partial_admission');
  });

  it('admission result JSON has stable reason and nextAction string literals', async () => {
    const candidates = [makeCandidate('c-json', 'principle')];
    const deps = makeBridgeDeps({
      candidates,
      output: makeLowConfidenceOutput(),
    });

    const bridge = new PainSignalBridge({
      stateManager: deps.stateManager,
      runner: deps.runner,
      intakeService: deps.intakeService,
      ledgerAdapter: deps.ledgerAdapter,
      eventEmitter: deps.eventEmitter,
    });

    const result = await bridge.onPainDetected({
      painId: PAIN_ID,
      painType: 'user_frustration',
      source: 'manual',
      reason: 'Test',
      provenance: 'owner_reported_no_host_trace',
    });

    const admission = result.admissionResults?.find((a) => a.candidateId === 'c-json')?.admission;
    expect(typeof admission?.reason).toBe('string');
    expect(typeof admission?.nextAction).toBe('string');
    expect(admission?.reason).not.toMatch(/[\u4e00-\u9fff]/);
    expect(admission?.nextAction).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('inferProvenance: manual source without session produces owner_reported_no_host_trace', async () => {
    const candidates = [makeCandidate('c-prov', 'principle')];
    const deps = makeBridgeDeps({
      candidates,
      output: makeLowConfidenceOutput(),
    });

    const bridge = new PainSignalBridge({
      stateManager: deps.stateManager,
      runner: deps.runner,
      intakeService: deps.intakeService,
      ledgerAdapter: deps.ledgerAdapter,
      eventEmitter: deps.eventEmitter,
    });

    const result = await bridge.onPainDetected({
      painId: PAIN_ID,
      painType: 'user_frustration',
      source: 'manual',
      reason: 'Owner reported issue',
    });

    expect(result.admissionResults).toBeDefined();
    const gated = result.admissionResults?.filter((a) => a.admission.decision === 'needs_evidence') ?? [];
    expect(gated.length).toBeGreaterThan(0);
    expect(gated[0]?.admission.evidenceStatus).toBe('owner_reported_no_host_trace');
  });
});

describe('PainSignalBridge dreamer task seeding', () => {
  const PAIN_ID_DREAMER = 'pain-dreamer-001';
  const TASK_ID_DREAMER = `diagnosis_${PAIN_ID_DREAMER}`;

  function makeDreamerCandidate(id: string, kind: CandidateRecord['recommendationKind']): CandidateRecord {
    return {
      candidateId: id,
      taskId: TASK_ID_DREAMER,
      artifactId: `artifact-${id}`,
      sourceRunId: `run-${id}`,
      title: `Candidate ${id}`,
      description: `Description for ${id}`,
      confidence: 0.85,
      sourceRecommendationJson: '{}',
      recommendationKind: kind,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
  }

  function makeDreamerDeps(overrides: {
    candidates: CandidateRecord[];
    createTaskFn?: (input: any) => Promise<any>;
    getTaskFn?: (taskId: string) => Promise<any>;
  }) {
    const telemetryEvents: Record<string, unknown>[] = [];
    const createTaskCalls: any[] = [];
    const createTaskMock = async (input: any) => {
      createTaskCalls.push(input);
      if (overrides.createTaskFn) return overrides.createTaskFn(input);
      return { taskId: 'mock-task' };
    };
    const getTaskMock = overrides.getTaskFn ?? (async () => null);
    const updateCandidateStatusCalls: { candidateId: string; patch: any }[] = [];
    const updateCandidateStatusMock = async (candidateId: string, patch: any) => {
      updateCandidateStatusCalls.push({ candidateId, patch });
    };

    const stateManager = {
      getTask: getTaskMock,
      createTask: createTaskMock,
      updateTask: async () => { return; },
      getCandidatesByTaskId: async () => overrides.candidates,
      getRunsByTask: async () => [{ runId: 'run-1', taskId: TASK_ID_DREAMER, status: 'succeeded' }],
      updateCandidateStatus: updateCandidateStatusMock,
    } as unknown as RuntimeStateManager;

    const runner = {
      run: async (): Promise<RunnerResult> => ({
        status: 'succeeded',
        taskId: TASK_ID_DREAMER,
        attemptCount: 1,
        output: makeHighConfidenceOutput(),
      }),
    };

    const intakeService: CandidateIntakeService = {
      intake: async (candidateId: string) => ({ id: `ledger-${candidateId}` }),
    } as unknown as CandidateIntakeService;

    const ledgerAdapter: LedgerAdapter = {
      existsForCandidate: (candidateId: string) => makeLedgerEntry(candidateId),
    } as unknown as LedgerAdapter;

    const eventEmitter = {
      emitTelemetry: (event: Record<string, unknown>) => {
        telemetryEvents.push(event);
      },
    };

    return {
      stateManager,
      runner,
      intakeService,
      ledgerAdapter,
      eventEmitter,
      telemetryEvents,
      createTaskCalls,
      updateCandidateStatusCalls,
    };
  }

  it('admitted candidate with MVP-enabled channel seeds dreamer task', async () => {
    const deps = makeDreamerDeps({
      candidates: [makeDreamerCandidate('c-seed1', 'principle')],
    });

    const bridge = new PainSignalBridge({
      stateManager: deps.stateManager,
      runner: deps.runner,
      intakeService: deps.intakeService,
      ledgerAdapter: deps.ledgerAdapter,
      eventEmitter: deps.eventEmitter,
    });

    const result = await bridge.onPainDetected({
      painId: PAIN_ID_DREAMER,
      painType: 'tool_failure',
      source: 'openclaw',
      reason: 'Test dreamer seeding',
      sessionId: 'session-dreamer',
      provenance: 'host_context_bound',
      evidence: [{ sourceRef: 'dreamer-src', note: 'test evidence' }],
    });

    expect(result.status).toBe('succeeded');
    const dreamerCall = deps.createTaskCalls.find((c) => c?.taskKind === 'dreamer');
    expect(dreamerCall).toBeDefined();
    expect(dreamerCall.taskKind).toBe('dreamer');
    expect(dreamerCall.taskId).toContain('dreamer-c-seed1');

    const seededEvent = deps.telemetryEvents.find((e) => e.eventType === 'candidate_dreamer_task_seeded');
    expect(seededEvent).toBeDefined();
    expect((seededEvent as any).payload.taskId).toContain('dreamer-c-seed1');
    expect((seededEvent as any).payload.channel).toBe('prompt');
  });

  it('non-MVP channel candidate does not create dreamer task', async () => {
    const deps = makeDreamerDeps({
      candidates: [makeDreamerCandidate('c-impl', 'implementation')],
    });

    const bridge = new PainSignalBridge({
      stateManager: deps.stateManager,
      runner: deps.runner,
      intakeService: deps.intakeService,
      ledgerAdapter: deps.ledgerAdapter,
      eventEmitter: deps.eventEmitter,
    });

    const result = await bridge.onPainDetected({
      painId: 'pain-impl-001',
      painType: 'tool_failure',
      source: 'openclaw',
      reason: 'Test non-MVP channel',
      sessionId: 'session-impl',
      provenance: 'host_context_bound',
      evidence: [{ sourceRef: 'impl-src', note: 'test evidence' }],
    });

    // PRI-539: non-MVP channel (implementation→skill) surfaces as degraded with
    // notInternalizable populated, instead of silently returning succeeded.
    expect(result.status).toBe('degraded');
    expect(result.notInternalizable).toEqual([
      { candidateId: 'c-impl', reason: expect.stringContaining('MVP-disabled') },
    ]);
    expect(result.message).toContain('not_internalizable');
    const dreamerCall = deps.createTaskCalls.find((c) => c?.taskKind === 'dreamer');
    expect(dreamerCall).toBeUndefined();

    const seededEvent = deps.telemetryEvents.find((e) => e.eventType === 'candidate_dreamer_task_seeded');
    expect(seededEvent).toBeUndefined();

    const notInternalizableEvent = deps.telemetryEvents.find((e) => e.eventType === 'candidate_not_internalizable');
    expect(notInternalizableEvent).toBeDefined();
    expect((notInternalizableEvent as any).payload.reason).toContain('MVP-disabled');
  });

  it('seedIntakeTask failure degrades gracefully — candidate still consumed, result includes seed failure note', async () => {
    const deps = makeDreamerDeps({
      candidates: [makeDreamerCandidate('c-fail', 'principle')],
      createTaskFn: async (input: any) => {
        if (input?.taskKind === 'dreamer') throw new Error('DB write failed');
        return { taskId: input?.taskId ?? 'mock-task' };
      },
    });

    const bridge = new PainSignalBridge({
      stateManager: deps.stateManager,
      runner: deps.runner,
      intakeService: deps.intakeService,
      ledgerAdapter: deps.ledgerAdapter,
      eventEmitter: deps.eventEmitter,
    });

    const result = await bridge.onPainDetected({
      painId: 'pain-fail-001',
      painType: 'tool_failure',
      source: 'openclaw',
      reason: 'Test seed failure',
      sessionId: 'session-fail',
      provenance: 'host_context_bound',
      evidence: [{ sourceRef: 'fail-src', note: 'test evidence' }],
    });

    expect(result.status).toBe('degraded');
    expect(result.message).toContain('dreamer_seed_failed:c-fail');
    const consumedCall = deps.updateCandidateStatusCalls.find((c) => c.candidateId === 'c-fail');
    expect(consumedCall).toBeDefined();
    if (consumedCall) {
      expect(consumedCall.patch).toEqual({ status: 'consumed' });
    }

    const failedEvent = deps.telemetryEvents.find((e) => e.eventType === 'candidate_dreamer_task_seed_failed');
    expect(failedEvent).toBeDefined();
    expect((failedEvent as any).payload.error).toContain('DB write failed');
  });
});
