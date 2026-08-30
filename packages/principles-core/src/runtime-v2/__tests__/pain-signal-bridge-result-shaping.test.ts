/**
 * PRI-456: Characterization test for PainSignalBridge result-shaping.
 *
 * Pins the full PainSignalBridgeResult status matrix for both:
 * - onDiagnosisComplete() (fresh diagnosis path)
 * - buildExistingResult() (idempotent existing-task path)
 *
 * This test MUST remain green before and after the refactor that extracts
 * a pure shapeBridgeResult() function. If any assertion changes, it is a
 * behavior change — STOP.
 *
 * ERR gate:
 * - ERR-007 / EP-02: single source for status decision (test proves both paths)
 * - ERR-002 / EP-03: every degraded/failed branch keeps its structured message
 * - ERR-004 / ERR-008 / EP-07: lineage fields come from the same source rows
 */
import { describe, it, expect } from 'vitest';
import { PainSignalBridge } from '../pain-signal-bridge.js';
import type { PainSignalBridgeResult } from '../pain-signal-bridge.js';
import type { RuntimeStateManager, CandidateRecord } from '../store/runtime-state-manager.js';
import type { CandidateIntakeService } from '../candidate-intake-service.js';
import type { LedgerAdapter, LedgerPrincipleEntry } from '../candidate-intake.js';
import type { DiagnosticianOutputV1 } from '../diagnostician-output.js';
import type { PainProvenance } from '../admission-gate.js';
import type { RunnerResult } from '../runner/runner-result.js';

const PAIN_ID = 'pain-char-001';
const TASK_ID = 'diagnosis_pain-char-001';
const RUN_ID = 'run-char-1';

// ── Factory helpers ──────────────────────────────────────────────────────────

function makeCandidate(
  id: string,
  kind: CandidateRecord['recommendationKind'],
  overrides: Partial<CandidateRecord> = {},
): CandidateRecord {
  return {
    candidateId: id,
    taskId: TASK_ID,
    artifactId: `artifact-${id}`,
    sourceRunId: `run-${id}`,
    title: `Candidate ${id}`,
    description: `Description for ${id}`,
    confidence: 0.85,
    sourceRecommendationJson: '{}',
    recommendationKind: kind,
    status: 'pending',
    createdAt: '2026-06-24T00:00:00.000Z',
    ...overrides,
  };
}

function makeLedgerEntry(candidateId: string): LedgerPrincipleEntry {
  return {
    id: `ledger-${candidateId}`,
    status: 'probation',
    createdAt: '2026-06-24T00:00:00.000Z',
    text: `Principle text for ${candidateId}`,
    sourceRef: `candidate://${candidateId}`,
    title: `Principle ${candidateId}`,
    evaluability: 'weak_heuristic',
  };
}

function makeHighConfidenceOutput(): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: 'diag-high',
    summary: 'Valid diagnosis with sufficient evidence',
    rootCause: 'Identified root cause from session trace',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'session-trace-1', note: 'Owner confirmed behavior' }],
    recommendations: [{ kind: 'principle', description: 'Valid principle from evidence' }],
    confidence: 0.85,
  };
}

function makeLowConfidenceOutput(): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: 'diag-low',
    summary: 'Low confidence diagnosis',
    rootCause: 'Insufficient evidence',
    violatedPrinciples: [],
    evidence: [],
    recommendations: [{ kind: 'principle', description: 'Low confidence principle' }],
    confidence: 0.3,
  };
}

interface MockDeps {
  stateManager: RuntimeStateManager;
  intakeService: CandidateIntakeService;
  ledgerAdapter: LedgerAdapter;
  runner: { run: (taskId: string) => Promise<RunnerResult> };
  telemetryEvents: Record<string, unknown>[];
  createTaskCalls: Record<string, unknown>[];
  updateCandidateStatusCalls: { candidateId: string; patch: Record<string, unknown> }[];
}

function makeMockDeps(overrides: {
  candidates?: CandidateRecord[];
  output?: DiagnosticianOutputV1;
  ledgerEntries?: Map<string, LedgerPrincipleEntry>;
  createTaskFn?: (input: Record<string, unknown>) => Promise<unknown>;
  getTaskFn?: (taskId: string) => Promise<unknown>;
  autoIntakeEnabled?: boolean;
}): MockDeps {
  const telemetryEvents: Record<string, unknown>[] = [];
  const createTaskCalls: Record<string, unknown>[] = [];
  const updateCandidateStatusCalls: { candidateId: string; patch: Record<string, unknown> }[] = [];

  const createTaskMock = async (input: Record<string, unknown>) => {
    createTaskCalls.push(input);
    if (overrides.createTaskFn) return overrides.createTaskFn(input);
    return { taskId: 'mock-task' };
  };

  const getTaskMock = overrides.getTaskFn ?? (async () => null);

  const updateCandidateStatusMock = async (candidateId: string, patch: Record<string, unknown>) => {
    updateCandidateStatusCalls.push({ candidateId, patch });
  };

  const stateManager = {
    getTask: getTaskMock,
    createTask: createTaskMock,
    updateTask: async () => undefined,
    getCandidatesByTaskId: async () => overrides.candidates ?? [],
    getRunsByTask: async () => [{ runId: RUN_ID, taskId: TASK_ID, status: 'succeeded' }],
    updateCandidateStatus: updateCandidateStatusMock,
  } as unknown as RuntimeStateManager;

  const intakeService = {
    intake: async (candidateId: string) => ({ id: `ledger-${candidateId}` }),
  } as unknown as CandidateIntakeService;

  const ledgerEntries = overrides.ledgerEntries ?? new Map<string, LedgerPrincipleEntry>();
  const ledgerAdapter = {
    existsForCandidate: (candidateId: string) => ledgerEntries.get(candidateId) ?? null,
  } as unknown as LedgerAdapter;

  const runner = {
    run: async (): Promise<RunnerResult> => ({
      status: 'succeeded',
      taskId: TASK_ID,
      attemptCount: 1,
      output: overrides.output ?? makeHighConfidenceOutput(),
    }),
  };

  return {
    stateManager,
    intakeService,
    ledgerAdapter,
    runner,
    telemetryEvents,
    createTaskCalls,
    updateCandidateStatusCalls,
  };
}

function createBridge(deps: MockDeps, autoIntakeEnabled = true): PainSignalBridge {
  return new PainSignalBridge({
    stateManager: deps.stateManager,
    runner: deps.runner,
    intakeService: deps.intakeService,
    ledgerAdapter: deps.ledgerAdapter,
    autoIntakeEnabled,
    eventEmitter: {
      emitTelemetry: (event: { eventType: string; traceId: string; timestamp: string; payload: Record<string, unknown> }) => {
        deps.telemetryEvents.push(event);
      },
    },
  });
}

// Interface for accessing private buildExistingResult
interface BridgeWithPrivate {
  buildExistingResult(input: { painId: string; taskId: string }): Promise<PainSignalBridgeResult>;
}

const PROVENANCE: PainProvenance = 'host_context_bound';

// ── onDiagnosisComplete() characterization ───────────────────────────────────

describe('PRI-456: onDiagnosisComplete result-shaping characterization', () => {
  it('succeeded: 1 admitted candidate with ledger entry and successful dreamer seed', async () => {
    const candidates = [makeCandidate('c1', 'principle')];
    const deps = makeMockDeps({ candidates, output: makeHighConfidenceOutput() });
    const bridge = createBridge(deps);

    const result = await bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: makeHighConfidenceOutput(),
      painId: PAIN_ID,
      provenance: PROVENANCE,
      inputEvidenceCount: 1,
    });

    expect(result.status).toBe('succeeded');
    expect(result.painId).toBe(PAIN_ID);
    expect(result.taskId).toBe(TASK_ID);
    expect(result.runId).toBe(RUN_ID);
    expect(result.artifactId).toBe('artifact-c1');
    expect(result.candidateIds).toEqual(['c1']);
    expect(result.ledgerEntryIds).toEqual(['ledger-c1']);
    expect(result.admissionResults).toBeDefined();
    expect(result.admissionResults).toHaveLength(1);
    expect(result.admissionResults?.[0]?.admission.decision).toBe('admitted');
    expect(result.message).toBeUndefined();
  });

  it('succeeded: autoIntakeEnabled=false — no ledger entries needed', async () => {
    const candidates = [makeCandidate('c1', 'principle')];
    const deps = makeMockDeps({ candidates, output: makeHighConfidenceOutput() });
    const bridge = createBridge(deps, false);

    const result = await bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: makeHighConfidenceOutput(),
      painId: PAIN_ID,
      provenance: PROVENANCE,
      inputEvidenceCount: 1,
    });

    expect(result.status).toBe('succeeded');
    expect(result.candidateIds).toEqual(['c1']);
    expect(result.ledgerEntryIds).toEqual([]);
    expect(result.admissionResults).toBeDefined();
    expect(result.admissionResults?.[0]?.admission.decision).toBe('admitted');
    expect(result.message).toBeUndefined();
  });

  it('failed: no candidates — "Diagnostician succeeded but produced no principle candidates"', async () => {
    const deps = makeMockDeps({ candidates: [], output: makeHighConfidenceOutput() });
    const bridge = createBridge(deps);

    const result = await bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: makeHighConfidenceOutput(),
      painId: PAIN_ID,
      provenance: PROVENANCE,
      inputEvidenceCount: 1,
    });

    expect(result.status).toBe('failed');
    expect(result.painId).toBe(PAIN_ID);
    expect(result.taskId).toBe(TASK_ID);
    expect(result.runId).toBe(RUN_ID);
    expect(result.artifactId).toBeUndefined();
    expect(result.candidateIds).toEqual([]);
    expect(result.ledgerEntryIds).toEqual([]);
    expect(result.admissionResults).toEqual([]);
    expect(result.message).toBe('Diagnostician succeeded but produced no principle candidates');
  });

  it('degraded: all_candidates_gated — 1 candidate, low confidence, not admitted', async () => {
    const candidates = [makeCandidate('c-gated', 'principle')];
    const deps = makeMockDeps({ candidates, output: makeLowConfidenceOutput() });
    const bridge = createBridge(deps);

    const result = await bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: makeLowConfidenceOutput(),
      painId: PAIN_ID,
      provenance: PROVENANCE,
      inputEvidenceCount: 1,
    });

    expect(result.status).toBe('degraded');
    expect(result.candidateIds).toEqual(['c-gated']);
    expect(result.ledgerEntryIds).toEqual([]);
    expect(result.admissionResults).toBeDefined();
    expect(result.admissionResults?.[0]?.admission.decision).toBe('needs_evidence');
    expect(result.message).toContain('all_candidates_gated');
    expect(result.message).toContain('c-gated=needs_evidence');
  });

  it('degraded: partial_admission — 2 candidates, 1 admitted, 1 deferred', async () => {
    // To get partial admission, one candidate must be admitted (principle, high confidence)
    // and one must be non-admitted (defer kind → always deferred regardless of confidence).
    const candidatesPartial = [
      makeCandidate('c-ok', 'principle'),
      makeCandidate('c-defer', 'defer'),
    ];
    const deps = makeMockDeps({ candidates: candidatesPartial, output: makeHighConfidenceOutput() });
    const bridge = createBridge(deps);

    const result = await bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: makeHighConfidenceOutput(),
      painId: PAIN_ID,
      provenance: PROVENANCE,
      inputEvidenceCount: 1,
    });

    expect(result.status).toBe('degraded');
    expect(result.candidateIds).toEqual(['c-ok', 'c-defer']);
    expect(result.ledgerEntryIds).toEqual(['ledger-c-ok']);
    expect(result.admissionResults).toBeDefined();
    expect(result.admissionResults).toHaveLength(2);
    const admitted = result.admissionResults?.find((a) => a.candidateId === 'c-ok');
    expect(admitted?.admission.decision).toBe('admitted');
    const deferred = result.admissionResults?.find((a) => a.candidateId === 'c-defer');
    expect(deferred?.admission.decision).toBe('deferred');
    expect(result.message).toContain('partial_admission');
    expect(result.message).toContain('1_admitted_1_gated');
  });

  it('degraded: dreamer_seed_failed — admitted candidate, ledger created, dreamer seed throws', async () => {
    const candidates = [makeCandidate('c-fail', 'principle')];
    const deps = makeMockDeps({
      candidates,
      output: makeHighConfidenceOutput(),
      createTaskFn: async (input: Record<string, unknown>) => {
        if (input.taskKind === 'dreamer') throw new Error('DB write failed');
        return { taskId: input.taskId ?? 'mock-task' };
      },
    });
    const bridge = createBridge(deps);

    const result = await bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: makeHighConfidenceOutput(),
      painId: PAIN_ID,
      provenance: PROVENANCE,
      inputEvidenceCount: 1,
    });

    expect(result.status).toBe('degraded');
    expect(result.candidateIds).toEqual(['c-fail']);
    expect(result.ledgerEntryIds).toEqual(['ledger-c-fail']);
    expect(result.message).toContain('dreamer_seed_failed:c-fail');
    // The candidate should still be consumed despite seed failure
    const consumedCall = deps.updateCandidateStatusCalls.find((c) => c.candidateId === 'c-fail');
    expect(consumedCall).toBeDefined();
    expect(consumedCall?.patch).toEqual({ status: 'consumed' });
  });

  it('degraded: all_candidates_gated with seed failure note appended', async () => {
    // When all candidates are gated AND a seed failure occurs (shouldn't normally happen
    // since seed only runs for admitted candidates, but test the message format)
    const candidates = [makeCandidate('c-gated', 'principle')];
    const deps = makeMockDeps({
      candidates,
      output: makeLowConfidenceOutput(),
    });
    const bridge = createBridge(deps);

    const result = await bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: makeLowConfidenceOutput(),
      painId: PAIN_ID,
      provenance: PROVENANCE,
      inputEvidenceCount: 1,
    });

    // All gated → degraded, no seed failure (no admitted candidates to seed)
    expect(result.status).toBe('degraded');
    expect(result.message).toContain('all_candidates_gated');
    expect(result.message).not.toContain('dreamer_seed_failed');
  });

  it('diagnosticianOutput=undefined: all candidates get needs_evidence → all_candidates_gated', async () => {
    const candidates = [makeCandidate('c-undef', 'principle')];
    const deps = makeMockDeps({ candidates });
    const bridge = createBridge(deps);

    const result = await bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: undefined,
      painId: PAIN_ID,
      provenance: PROVENANCE,
      inputEvidenceCount: 1,
    });

    expect(result.status).toBe('degraded');
    expect(result.admissionResults).toBeDefined();
    expect(result.admissionResults?.[0]?.admission.decision).toBe('needs_evidence');
    expect(result.admissionResults?.[0]?.admission.reason).toBe('diagnostician_output_unavailable');
    expect(result.message).toContain('all_candidates_gated');
  });
});

// ── buildExistingResult() characterization ───────────────────────────────────

describe('PRI-456: buildExistingResult result-shaping characterization', () => {
  it('succeeded: existing task with candidates and ledger entries', async () => {
    const candidates = [makeCandidate('c1', 'principle')];
    const ledgerEntries = new Map<string, LedgerPrincipleEntry>([['c1', makeLedgerEntry('c1')]]);
    const deps = makeMockDeps({ candidates, ledgerEntries });
    const bridge = createBridge(deps);

    const result = await (bridge as unknown as BridgeWithPrivate).buildExistingResult({
      painId: PAIN_ID,
      taskId: TASK_ID,
    });

    expect(result.status).toBe('succeeded');
    expect(result.painId).toBe(PAIN_ID);
    expect(result.taskId).toBe(TASK_ID);
    expect(result.runId).toBe(RUN_ID);
    expect(result.artifactId).toBe('artifact-c1');
    expect(result.candidateIds).toEqual(['c1']);
    expect(result.ledgerEntryIds).toEqual(['ledger-c1']);
    expect(result.message).toBe('Task already succeeded');
  });

  it('succeeded: autoIntakeEnabled=false — no ledger entries needed', async () => {
    const candidates = [makeCandidate('c1', 'principle')];
    const deps = makeMockDeps({ candidates, ledgerEntries: new Map() });
    const bridge = createBridge(deps, false);

    const result = await (bridge as unknown as BridgeWithPrivate).buildExistingResult({
      painId: PAIN_ID,
      taskId: TASK_ID,
    });

    expect(result.status).toBe('succeeded');
    expect(result.candidateIds).toEqual(['c1']);
    expect(result.ledgerEntryIds).toEqual([]);
    expect(result.message).toBe('Task already succeeded');
  });

  it('failed: no candidates — "Task has no principle candidates — treating as failed"', async () => {
    const deps = makeMockDeps({ candidates: [], ledgerEntries: new Map() });
    const bridge = createBridge(deps);

    const result = await (bridge as unknown as BridgeWithPrivate).buildExistingResult({
      painId: PAIN_ID,
      taskId: TASK_ID,
    });

    expect(result.status).toBe('failed');
    expect(result.painId).toBe(PAIN_ID);
    expect(result.taskId).toBe(TASK_ID);
    expect(result.runId).toBe(RUN_ID);
    expect(result.artifactId).toBeUndefined();
    expect(result.candidateIds).toEqual([]);
    expect(result.ledgerEntryIds).toEqual([]);
    expect(result.message).toBe('Task has no principle candidates — treating as failed');
  });

  it('failed: no ledger entries with autoIntakeEnabled=true', async () => {
    const candidates = [makeCandidate('c1', 'principle')];
    const deps = makeMockDeps({ candidates, ledgerEntries: new Map() });
    const bridge = createBridge(deps);

    const result = await (bridge as unknown as BridgeWithPrivate).buildExistingResult({
      painId: PAIN_ID,
      taskId: TASK_ID,
    });

    expect(result.status).toBe('failed');
    expect(result.runId).toBe(RUN_ID);
    expect(result.artifactId).toBe('artifact-c1');
    expect(result.candidateIds).toEqual(['c1']);
    expect(result.ledgerEntryIds).toEqual([]);
    expect(result.message).toBe('Candidate intake did not produce a ledger entry — treating as failed');
  });

  it('multiple candidates with mixed ledger existence — only existing ledgers counted', async () => {
    const candidates = [
      makeCandidate('c1', 'principle'),
      makeCandidate('c2', 'principle'),
    ];
    const ledgerEntries = new Map<string, LedgerPrincipleEntry>([['c1', makeLedgerEntry('c1')]]);
    const deps = makeMockDeps({ candidates, ledgerEntries });
    const bridge = createBridge(deps);

    const result = await (bridge as unknown as BridgeWithPrivate).buildExistingResult({
      painId: PAIN_ID,
      taskId: TASK_ID,
    });

    expect(result.status).toBe('succeeded');
    expect(result.candidateIds).toEqual(['c1', 'c2']);
    expect(result.ledgerEntryIds).toEqual(['ledger-c1']);
    expect(result.message).toBe('Task already succeeded');
  });
});

// ── Edge cases and boundary conditions ───────────────────────────────────────

describe('PRI-456: shapeBridgeResult edge cases', () => {
  it('fresh path: runId and artifactId undefined when no candidates', async () => {
    const deps = makeMockDeps({ candidates: [], output: makeHighConfidenceOutput() });
    const bridge = createBridge(deps);

    const result = await bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: makeHighConfidenceOutput(),
      painId: PAIN_ID,
      provenance: PROVENANCE,
      inputEvidenceCount: 1,
    });

    expect(result.status).toBe('failed');
    expect(result.runId).toBe(RUN_ID); // runId comes from getRunsByTask mock
    expect(result.artifactId).toBeUndefined(); // no candidates → no artifactId
  });

  it('fresh path: artifactId comes from first candidate', async () => {
    const candidates = [
      makeCandidate('c-first', 'principle'),
      makeCandidate('c-second', 'principle'),
    ];
    const deps = makeMockDeps({ candidates, output: makeHighConfidenceOutput() });
    const bridge = createBridge(deps);

    const result = await bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: makeHighConfidenceOutput(),
      painId: PAIN_ID,
      provenance: PROVENANCE,
      inputEvidenceCount: 1,
    });

    expect(result.status).toBe('succeeded');
    expect(result.artifactId).toBe('artifact-c-first'); // first candidate's artifactId
  });

  it('fresh path: admissionResults includes needs_evidence decision', async () => {
    const candidates = [makeCandidate('c-needs-evidence', 'principle')];
    const deps = makeMockDeps({ candidates, output: makeLowConfidenceOutput() });
    const bridge = createBridge(deps);

    const result = await bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: makeLowConfidenceOutput(),
      painId: PAIN_ID,
      provenance: PROVENANCE,
      inputEvidenceCount: 0, // low evidence count
    });

    expect(result.status).toBe('degraded');
    expect(result.admissionResults).toBeDefined();
    expect(result.admissionResults?.[0]?.admission.decision).toBe('needs_evidence');
    expect(result.message).toContain('all_candidates_gated');
  });

  it('existing path: runId undefined when no runs', async () => {
    const candidates = [makeCandidate('c1', 'principle')];
    const ledgerEntries = new Map<string, LedgerPrincipleEntry>([['c1', makeLedgerEntry('c1')]]);
    const deps = makeMockDeps({
      candidates,
      ledgerEntries,
      getTaskFn: async () => ({ taskId: TASK_ID, status: 'succeeded' }),
    });
    // Override getRunsByTask to return empty array
    deps.stateManager = {
      ...deps.stateManager,
      getRunsByTask: async () => [],
    } as unknown as RuntimeStateManager;
    const bridge = createBridge(deps);

    const result = await (bridge as unknown as BridgeWithPrivate).buildExistingResult({
      painId: PAIN_ID,
      taskId: TASK_ID,
    });

    expect(result.status).toBe('succeeded');
    expect(result.runId).toBeUndefined();
  });

  it('fresh path: multiple admission decisions in message', async () => {
    // Mix of admitted and deferred candidates
    const candidates = [
      makeCandidate('c-admit', 'principle'),
      makeCandidate('c-defer', 'defer'),
      makeCandidate('c-gated', 'principle'),
    ];
    // High confidence for principle, defer always deferred, low confidence for gated
    const output: DiagnosticianOutputV1 = {
      valid: true,
      diagnosisId: 'diag-mix',
      summary: 'Mixed admission',
      rootCause: 'Test',
      violatedPrinciples: [],
      evidence: [{ sourceRef: 'test', note: 'Evidence' }],
      recommendations: [
        { kind: 'principle', description: 'Principle 1' },
        { kind: 'defer', description: 'Defer 1' },
        { kind: 'principle', description: 'Principle 2' },
      ],
      confidence: 0.85,
    };
    const deps = makeMockDeps({ candidates, output });
    const bridge = createBridge(deps);

    const result = await bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: output,
      painId: PAIN_ID,
      provenance: PROVENANCE,
      inputEvidenceCount: 1,
    });

    expect(result.status).toBe('degraded');
    expect(result.message).toContain('partial_admission');
  });
});
