/**
 * D4 automatic-entry seed gate for `pd diagnose run` —
 * SPEC-PD-PIPELINE-SPINE-001 v0.9 §3.4.2 注 3 / §3.7 Layer B
 * (PRI-1291 Phase 1A red-first).
 *
 * Verified defect (origin/main): the Dreamer seed loop keys off the intake
 * record's `status === 'consumed'` and routes/validates via the NORMALIZED
 * `candidate.recommendationKind`, so a candidate whose RAW persisted kind is
 * invalid — already refused by Intake with `ledgerWriteRefused` — still gets
 * seeded because the fail-open view folds the kind to 'principle'.
 *
 * Post-fix contract (v0.7/v0.8/v0.9):
 *   - seed gate validates the RAW kind first: invalid/missing → zero seeding;
 *   - the refusal is expressed as an ADDITIONAL intakeResults record
 *     `{status:'refused', reason:'candidate_kind_invalid'}` — the existing
 *     `'consumed'` + `ledgerWriteRefused` record is NOT overwritten;
 *   - refused candidates disappear from `internalizableCandidateIds` and
 *     never receive a `pd candidate internalize` instruction;
 *   - TTY prints `DREAMER SEED REFUSED` + reason; an all-refused run reports
 *     the refusal instead of the misleading "No candidates were generated".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  MockRuntimeStateManager, rearmGateSeams, mockGetCandidatesByTaskId, mockCreateTask, mockGetTask,
  mockUpdateCandidateStatus,
  // review round 2 (P2-2): seams the mixed-outcome tests reconfigure
  mockGetAdmissionDocument, identityResolution,
} = vi.hoisted(() => {
  const mockGetCandidatesByTaskId = vi.fn().mockResolvedValue([]);
  const mockUpdateCandidateStatus = vi.fn().mockResolvedValue(undefined);
  const mockCreateTask = vi.fn().mockResolvedValue(undefined);
  const mockGetAdmissionDocument = vi.fn();
  // Ledger identity seam: default = no ledger identity (never intaken).
  const identityResolution: { value: unknown } = {
    value: { status: 'unresolved', reason: 'missing', nextAction: 'none' },
  };
  const mockAppendAdmissionEvaluation = vi.fn();
  const mockGetRunsByTask = vi.fn();
  const mockGetRun = vi.fn();
  const mockGetArtifact = vi.fn();
  const mockGetCandidateImpl = vi.fn(async (candidateId: string) => {
    const all = await mockGetCandidatesByTaskId('any');
    return all.find((c: { candidateId: string }) => c.candidateId === candidateId) ?? null;
  });
  function rearmGateSeams(): void {
    mockGetTask.mockResolvedValue({
      taskId: 'test-task-1', status: 'pending', attemptCount: 0, maxAttempts: 3, lastError: null,
      diagnosticJson: JSON.stringify({ sourcePainId: 'pain-test', reasonSummary: 'r', source: 'manual', severity: 'moderate', sessionIdHint: null, agentIdHint: null, provenance: 'owner_reported_no_host_trace', provenanceReason: 'seeded', evidence: [{ sourceRef: 's:1', note: 'n' }], workspaceDir: null }),
    });
    mockGetAdmissionDocument.mockResolvedValue({
      ok: true,
      document: {
        schemaVersion: 1,
        evaluations: [{
          evaluationId: 'ae_mock', decision: 'admitted', reason: 'evidence_sufficient', nextAction: 'none',
          evaluatedAt: '2026-10-14T00:00:00.000Z', policyVersion: 'admission-gate@cr-03',
          provenance: 'owner_reported_no_host_trace', inputEvidenceCount: 2, ownerStatementPresent: false,
          recommendationKind: 'principle', confidence: 0.9, materialFingerprint: 'fp_mock',
          materialSummary: { inputEvidenceCount: 2, outputEvidenceCount: 2, ownerStatementPresent: false },
        }],
        currentEvaluationId: 'ae_mock',
      },
    });
    mockAppendAdmissionEvaluation.mockResolvedValue({ status: 'appended', document: { schemaVersion: 1, evaluations: [], currentEvaluationId: null } });
    mockGetRunsByTask.mockResolvedValue([{
      runId: 'run-underlying', status: 'succeeded',
      outputPayload: JSON.stringify({ schemaVersion: 'diagnostician-output-v2', valid: true, diagnosisId: 'd', summary: 's', rootCause: 'rc', violatedPrinciples: [], evidence: [{ sourceRef: 's:1', note: 'n' }], recommendations: [{ kind: 'principle', recommendationRef: 'x-1', description: 'd' }], confidence: 0.95 }),
    }]);
    mockGetRun.mockImplementation(async (runId: string) => (runId === 'run-underlying' ? {
      runId: 'run-underlying', taskId: 'test-task-1', status: 'succeeded', executionStatus: 'succeeded' as const,
      outputPayload: JSON.stringify({ schemaVersion: 'diagnostician-output-v2', valid: true, diagnosisId: 'd', summary: 's', rootCause: 'rc', violatedPrinciples: [], evidence: [{ sourceRef: 's:1', note: 'n' }], recommendations: [{ kind: 'principle', recommendationRef: 'x-1', description: 'd' }], confidence: 0.95 }),
    } : null));
    mockGetArtifact.mockResolvedValue(null);
  }
  const mockGetTask = vi.fn();
  class MockRuntimeStateManager {
    initialize = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    getTask = mockGetTask;
    createTask = mockCreateTask;
    getCandidatesByTaskId = mockGetCandidatesByTaskId;
    updateCandidateStatus = mockUpdateCandidateStatus;
    getAdmissionDocument = mockGetAdmissionDocument;
    appendAdmissionEvaluation = mockAppendAdmissionEvaluation;
    getCandidate = mockGetCandidateImpl;
    getRunsByTask = mockGetRunsByTask;
    getRun = mockGetRun;
    getArtifact = mockGetArtifact;
    connection = {} as Record<string, unknown>;
    taskStore = {};
    runStore = {};
    piArtifactStore = {};
    getRetryPolicy = vi.fn().mockReturnValue({ shouldRetry: () => true, calculateBackoff: () => 10 });
  }
  return {
    MockRuntimeStateManager,
    rearmGateSeams,
    mockGetCandidatesByTaskId,
    mockCreateTask,
    mockGetTask,
    mockGetAdmissionDocument,
    identityResolution,
    mockUpdateCandidateStatus,
  };
}, { validateType: true });

const { mockIntake, MockCandidateIntakeService } = vi.hoisted(() => {
  const mockIntake = vi.fn();
  function MockCandidateIntakeService(this: unknown) {
    return { intake: mockIntake };
  }
  return { mockIntake, MockCandidateIntakeService };
});

const { MockPrincipleTreeLedgerAdapter } = vi.hoisted(() => {
  function MockPrincipleTreeLedgerAdapter(this: unknown) {
    // `identityResolution` (hoisted above) is the mutable seam: by default the
    // candidate has no ledger identity; suppression tests point it at a
    // reuse-resolved identity.
    return {
      withCandidateCoordination: async (_candidateId: string, operation: () => Promise<unknown>) => operation(),
      resolveCandidatePrincipleIdentity: () => identityResolution.value,
    };
  }
  return { MockPrincipleTreeLedgerAdapter };
});

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/fake-workspace'),
}));

vi.mock('@principles/core/runtime', async (importOriginal) => {
  return {
    ...(await importOriginal<object>()),
    RuntimeStateManager: vi.fn().mockImplementation(function () {
      return new MockRuntimeStateManager();
    }),
    SqliteHistoryQuery: vi.fn().mockImplementation(function () { return {}; }),
    SqliteContextAssembler: vi.fn().mockImplementation(function () { return {}; }),
    SqliteDiagnosticianCommitter: vi.fn().mockImplementation(function () { return {}; }),
    SqliteTrajectoryLocator: vi.fn().mockImplementation(function () { return {}; }),
    SqliteSourceTraceLocator: vi.fn().mockImplementation(function () { return {}; }),
    storeEmitter: { emitTelemetry: vi.fn() },
    SplitDiagnosticianRunner: vi.fn().mockImplementation(function () { return {}; }),
    DiagRootCauseRunner: vi.fn().mockImplementation(function () { return {}; }),
    DiagDistillerRunner: vi.fn().mockImplementation(function () { return {}; }),
    DiagRouterRunner: vi.fn().mockImplementation(function () { return {}; }),
    DefaultDiagRootCauseValidator: vi.fn().mockImplementation(function () { return {}; }),
    DefaultDiagDistillerValidator: vi.fn().mockImplementation(function () { return {}; }),
    DisabledDiagnosticianRunner: vi.fn().mockImplementation(function () { return {}; }),
    TestDoubleRuntimeAdapter: vi.fn().mockImplementation(function () { return {}; }),
    PiAiRuntimeAdapter: vi.fn().mockImplementation(function () { return {}; }),
    SPLIT_PIPELINE_TOTAL_TIMEOUT_MS: 300000,
    resolveDiagnosticianCapability: vi.fn(() => ({ available: true })),
    PDRuntimeError: class PDRuntimeError extends Error {
      constructor(public category: string, message: string) {
        super(message);
        this.name = 'PDRuntimeError';
      }
    },
    CandidateIntakeService: MockCandidateIntakeService,
    createReuseRecommendationHook: vi.fn(() => undefined),
    evaluateCandidateAdmissionFromRecord: vi.fn().mockReturnValue({
      decision: 'admitted',
      reason: 'mock_admitted',
      nextAction: 'none',
      evidenceStatus: 'unknown',
    }),
    resolveRuntimeConfig: vi.fn().mockReturnValue({
      runtimeKind: 'pi-ai', provider: 'test-provider', model: 'test-model', apiKeyEnv: 'TEST_KEY', timeoutMs: 300000, agentId: 'main',
    }),
    isRuntimeConfigError: vi.fn().mockReturnValue(false),
    isFeatureEnabled: vi.fn().mockReturnValue(true),
    resolveOutputLanguage: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
    validatePdConfig: vi.fn().mockReturnValue({ valid: true, errors: [] }),
    computeEffectivePdConfig: vi.fn().mockReturnValue({ config: {}, source: 'defaults', warnings: [] }),
    computeFeatureFlagsFromConfig: vi.fn().mockReturnValue({}),
    redactPdConfig: vi.fn().mockImplementation((c) => c),
    run: vi.fn().mockResolvedValue({
      status: 'succeeded',
      taskId: 'test-task-1',
      output: {
        schemaVersion: 'diagnostician-output-v2',
        valid: true,
        diagnosisId: 'diag-123',
        summary: 'Test diagnosis summary',
        rootCause: 'Test root cause',
        violatedPrinciples: [],
        evidence: [],
        recommendations: [{ kind: 'principle', recommendationRef: 'x-1', description: 'Test recommendation' }],
        confidence: 0.9,
      },
    }),
    status: vi.fn(),
    PrincipleTreeLedgerAdapter: MockPrincipleTreeLedgerAdapter,
    buildDreamerSeedFromCandidate: vi.fn().mockImplementation((candidate: { candidateId: string }) => ({
      taskId: `dreamer-${candidate.candidateId}`,
      taskKind: 'dreamer' as const,
      channel: 'prompt' as const,
      diagnosticJson: JSON.stringify({ candidateId: candidate.candidateId }),
      status: 'pending' as const,
      attemptCount: 0,
      maxAttempts: 3,
    })),
    findExistingDreamerTask: vi.fn().mockResolvedValue(null),
    CANDIDATE_KIND_TO_ROUTE: {
      principle: 'principle-candidate',
      rule: 'rule-candidate',
      prompt: 'prompt-candidate',
    },
    ROUTE_CHANNEL_MAP: {
      'principle-candidate': 'prompt',
      'rule-candidate': 'code_tool_hook',
      'prompt-candidate': 'prompt',
    },
    MVP_ENABLED_CHANNELS: new Set(['prompt', 'code_tool_hook', 'defer_archive']),
    persistPainDiagnosis: vi.fn().mockResolvedValue(undefined),
    createBridgeTelemetryEventEmitter: vi.fn().mockReturnValue({ emitTelemetry: vi.fn() }),
  };
});

vi.mock('../../src/config-reader.js', () => ({
  readOutputLanguageFromWorkspace: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
}));

vi.mock('../../src/services/pd-config-loader.js', () => ({
  loadPdConfig: vi.fn().mockReturnValue({
    ok: true,
    effective: { config: { featureFlags: { diagnostician_llm_degradation: true } }, source: 'file', warnings: [] },
    defaults: { config: {}, source: 'defaults', warnings: [] },
  }),
  computeFlagsFromLoadResult: vi.fn().mockReturnValue({}),
  resolvePromptFullPipelineSeedMode: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../../src/services/resolve-runtime-from-pd-config.js', () => ({
  resolveRuntimeFromPdConfig: vi.fn().mockReturnValue({
    result: { runtimeKind: 'pi-ai', provider: 'test-provider', model: 'test-model', apiKeyEnv: 'TEST_KEY', timeoutMs: 300000, agentId: 'main' },
    legacyWarnings: [],
    configSource: '.pd/config.yaml',
    configLoadResult: { ok: true, effective: {}, defaults: {}, legacyFilesDetected: [] },
  }),
}));

vi.mock('../../src/commands/candidate.js', () => ({
  resolveSourcePainIdFromDiagnostician: vi.fn().mockResolvedValue('pain_test-source-1'),
}));

import { handleDiagnoseRun, type DiagnoseRunOptions } from '../../src/commands/diagnose.js';

/** raw ≠ normalized: the persisted column is invalid, the read view folds it. */
function makeCandidate(candidateId: string, raw: string | null, normalized: string) {
  return {
    candidateId,
    taskId: 'test-task-1',
    artifactId: `artifact-${candidateId}`,
    sourceRunId: 'run-underlying',
    title: `Candidate ${candidateId}`,
    description: 'desc',
    confidence: 0.9,
    sourceRecommendationJson: '{}',
    recommendationKind: normalized,
    rawRecommendationKind: raw,
    status: 'pending',
    createdAt: '2026-11-23T00:00:00.000Z',
  };
}

function dreamerCreationsFor(candidateId: string): unknown[] {
  return mockCreateTask.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((input) => String(input.taskKind) === 'dreamer' && String(input.taskId).includes(candidateId));
}

function readJsonOutput(logSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const lines = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.trim().startsWith('{'));
  expect(lines.length).toBeGreaterThanOrEqual(1);
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

describe('D4 — pd diagnose seed gate refuses invalid RAW kinds', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    rearmGateSeams();
    mockGetTask.mockResolvedValue({
      taskId: 'test-task-1', status: 'pending', attemptCount: 0, maxAttempts: 3, lastError: null,
      diagnosticJson: JSON.stringify({ sourcePainId: 'pain-test', reasonSummary: 'r', source: 'manual', severity: 'moderate', sessionIdHint: null, agentIdHint: null, provenance: 'owner_reported_no_host_trace', provenanceReason: 'seeded', evidence: [{ sourceRef: 's:1', note: 'n' }], workspaceDir: null }),
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('invalid raw kind: zero dreamer seeding, candidate remains pending, no internalize instruction', async () => {
    mockGetCandidatesByTaskId.mockResolvedValue([
      makeCandidate('c-invalid-kind', 'wizardry', 'principle'),
      makeCandidate('c-valid-prompt', 'prompt', 'prompt'),
    ]);
    mockIntake.mockImplementation(async (candidateId: string) => {
      if (candidateId === 'c-invalid-kind') {
        return {
          outcome: 'refused',
          reason: 'unknown_kind',
          candidateId,
          rawRecommendationKind: 'wizardry',
          message: 'recommendation_kind is not a valid kind',
        };
      }
      return { outcome: 'ledger_entry', written: true, entry: { id: 'ledger-1' }, candidateId };
    });

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    // zero seeding for the invalid raw kind; the legal prompt candidate seeds
    expect(dreamerCreationsFor('c-invalid-kind')).toEqual([]);
    expect(dreamerCreationsFor('c-valid-prompt')).toHaveLength(1);

    const output = readJsonOutput(logSpy);
    const intake = output.intake as { candidates?: Array<Record<string, unknown>> } | undefined;
    const intakeResults = intake?.candidates ?? [];
    const invalidRecords = intakeResults.filter((r) => r.candidateId === 'c-invalid-kind');
    // The invalid candidate has exactly one refusal record and is never
    // consumed; a valid sibling can still seed independently.
    expect(invalidRecords).toHaveLength(1);
    expect(invalidRecords[0]).toMatchObject({ status: 'refused', reason: 'candidate_kind_invalid' });
    expect(mockUpdateCandidateStatus.mock.calls.some(([id]) => id === 'c-invalid-kind')).toBe(false);
    // the refused candidate never receives an intake or internalize
    // instruction — and IS named in the refusal notice, so the operator
    // knows which candidate is invalid (review round 2, P2-2).
    const nextAction = String(output.nextAction ?? '');
    expect(nextAction).not.toContain('pd candidate internalize --candidate-id c-invalid-kind');
    expect(nextAction).not.toContain('pd candidate intake --candidate-id c-invalid-kind');
    expect(nextAction).toMatch(/REFUSED \(candidate_kind_invalid[^)]*\): c-invalid-kind/);
    // every candidate in exactly one outcome class (machine-readable)
    const intakeWithClasses = output.intake as { outcomeClasses?: Record<string, string[]> } | undefined;
    expect(intakeWithClasses?.outcomeClasses?.seed_refused).toEqual(['c-invalid-kind']);
    expect(intakeWithClasses?.outcomeClasses?.seeded).toEqual(['c-valid-prompt']);
    for (const [cls, ids] of Object.entries(intakeWithClasses?.outcomeClasses ?? {})) {
      if (cls !== 'seed_refused' && cls !== 'seeded') expect(ids, cls).toEqual([]);
    }
  });

  it('missing raw kind: zero dreamer seeding', async () => {
    mockGetCandidatesByTaskId.mockResolvedValue([
      makeCandidate('c-missing-kind', null, 'principle'),
    ]);
    mockIntake.mockImplementation(async (candidateId: string) => ({
      outcome: 'refused',
      reason: 'unknown_kind',
      candidateId,
      message: 'missing kind',
    }));

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    expect(dreamerCreationsFor('c-missing-kind')).toEqual([]);
  });

  it('TTY prints DREAMER SEED REFUSED with the structured reason', async () => {
    mockGetCandidatesByTaskId.mockResolvedValue([
      makeCandidate('c-invalid-tty', 'wizardry', 'principle'),
    ]);
    mockIntake.mockImplementation(async (candidateId: string) => ({
      outcome: 'refused',
      reason: 'unknown_kind',
      candidateId,
      message: 'invalid kind',
    }));

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: false,
    } as DiagnoseRunOptions);

    const tty = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(tty).toContain('DREAMER SEED REFUSED');
    expect(tty).toContain('candidate_kind_invalid');
    expect(dreamerCreationsFor('c-invalid-tty')).toEqual([]);
  });

  it('all candidates refused: nextAction reports the refusal instead of "No candidates were generated"', async () => {
    mockGetCandidatesByTaskId.mockResolvedValue([
      makeCandidate('c-only-invalid', 'wizardry', 'principle'),
    ]);
    mockIntake.mockImplementation(async (candidateId: string) => ({
      outcome: 'refused',
      reason: 'unknown_kind',
      candidateId,
      message: 'invalid kind',
    }));

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    const output = readJsonOutput(logSpy);
    const nextAction = String(output.nextAction ?? '');
    expect(nextAction).not.toBe('No candidates were generated from this diagnosis.');
    expect(nextAction).toMatch(/candidate_kind_invalid|refus/i);
  });
});

/**
 * Review round 2 (P2-2): mixed outcomes and the `--no-intake` path.
 *
 * Every candidate lands in exactly ONE outcome class; the guidance reports
 * every class a run actually contains with its own next step, and only ever
 * suggests a command that is valid for the candidate's RAW kind and state.
 */
describe('P2-2 — diagnose guidance classifies every candidate and suggests only valid commands', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  const NO_IDENTITY = { status: 'unresolved', reason: 'missing', nextAction: 'none' };
  const REUSE_RESOLVED = {
    status: 'resolved',
    candidateId: 'c-reuse',
    principleId: '11111111-2222-4111-8111-111111111111',
    basis: 'principle_reuse',
    checkedAt: '2026-11-24T00:00:00.000Z',
  };

  function needsEvidenceDocument(candidateId: string): Record<string, unknown> {
    return {
      ok: true,
      document: {
        schemaVersion: 1,
        evaluations: [{
          evaluationId: `ae-${candidateId}`,
          decision: 'needs_evidence',
          reason: 'confidence_below_threshold:0.45<0.50',
          nextAction: 'provide_additional_evidence_or_manual_review',
          evaluatedAt: '2026-10-14T00:00:00.000Z',
          policyVersion: 'admission-gate@cr-03',
          provenance: 'owner_reported_no_host_trace',
          inputEvidenceCount: 2,
          ownerStatementPresent: false,
          recommendationKind: 'principle',
          confidence: 0.45,
          materialFingerprint: 'fp_mock',
          materialSummary: { inputEvidenceCount: 2, outputEvidenceCount: 2, ownerStatementPresent: false },
        }],
        currentEvaluationId: `ae-${candidateId}`,
      },
    };
  }

  /** The admission gate refuses exactly `refusedId`; everyone else stays admitted. */
  async function refuseAtAdmissionGate(refusedId: string): Promise<void> {
    const admitted = await mockGetAdmissionDocument('any');
    mockGetAdmissionDocument.mockImplementation(async (candidateId: string) =>
      (candidateId === refusedId ? needsEvidenceDocument(candidateId) : admitted));
  }

  async function run(opts: { json: boolean; intake?: boolean }): Promise<{ output: Record<string, unknown>; tty: string }> {
    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      ...opts,
    } as DiagnoseRunOptions);
    return { output: opts.json ? readJsonOutput(logSpy) : {}, tty: logSpy.mock.calls.map((c) => c.join(' ')).join('\n') };
  }

  function classesOf(output: Record<string, unknown>): Record<string, string[]> {
    const intake = output.intake as { outcomeClasses?: Record<string, string[]> } | undefined;
    expect(intake?.outcomeClasses).toBeDefined();
    return intake?.outcomeClasses ?? {};
  }

  /** Every candidate in exactly one class, and nothing outside the known classes. */
  function expectPartition(classes: Record<string, string[]>, expected: Record<string, string[]>): void {
    expect(classes).toEqual(expected);
    const all = Object.values(classes).flat();
    expect(new Set(all).size).toBe(all.length);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    identityResolution.value = NO_IDENTITY;
    rearmGateSeams();
    mockGetTask.mockResolvedValue({
      taskId: 'test-task-1', status: 'pending', attemptCount: 0, maxAttempts: 3, lastError: null,
      diagnosticJson: JSON.stringify({ sourcePainId: 'pain-test', reasonSummary: 'r', source: 'manual', severity: 'moderate', sessionIdHint: null, agentIdHint: null, provenance: 'owner_reported_no_host_trace', provenanceReason: 'seeded', evidence: [{ sourceRef: 's:1', note: 'n' }], workspaceDir: null }),
    });
    mockIntake.mockReset();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  const EMPTY = {
    seeded: [], seed_failed: [], parked: [], suppressed: [], admission_refused: [],
    seed_refused: [], intake_failed: [], internalizable: [], intake_first: [], no_route: [],
  };
  const withClasses = (overrides: Record<string, string[]>): Record<string, string[]> => ({ ...EMPTY, ...overrides });

  it('mixed run: invalid kind + parked + admission-refused + seeded — each class reported with its own step (JSON)', async () => {
    await refuseAtAdmissionGate('c-admission');
    mockGetCandidatesByTaskId.mockResolvedValue([
      makeCandidate('c-invalid', 'wizardry', 'principle'),
      makeCandidate('c-parked', 'principle', 'principle'),
      makeCandidate('c-admission', 'principle', 'principle'),
      makeCandidate('c-ok', 'principle', 'principle'),
    ]);
    mockIntake.mockImplementation(async (candidateId: string) => {
      if (candidateId === 'c-invalid') {
        return { outcome: 'refused', reason: 'unknown_kind', candidateId, rawRecommendationKind: 'wizardry', message: 'invalid kind' };
      }
      if (candidateId === 'c-parked') {
        return {
          outcome: 'refused', reason: 'reuse_pending_owner', candidateId, rawRecommendationKind: 'principle', message: 'parked',
          reuseRecommendation: { status: 'recommended', recommendation: 'reuse', selectedPrincipleId: 'existing-p1', rationale: 'same', confidence: 0.9 },
        };
      }
      return { outcome: 'ledger_entry', written: true, entry: { id: `ledger-${candidateId}` }, candidateId };
    });

    const { output } = await run({ json: true });
    expectPartition(classesOf(output), withClasses({
      seeded: ['c-ok'],
      parked: ['c-parked'],
      admission_refused: ['c-admission'],
      seed_refused: ['c-invalid'],
    }));

    const nextAction = String(output.nextAction);
    // C keeps flowing: it was seeded and the guidance says so
    expect(dreamerCreationsFor('c-ok')).toHaveLength(1);
    expect(nextAction).toContain('Dreamer tasks seeded automatically for 1 candidate(s)');
    // B: parked → review, and the run is NOT reported as "all parked"
    expect(nextAction).toContain('pd candidate review --candidate-id c-parked --decide reuse|create');
    expect(nextAction).not.toContain('All candidates are parked');
    // A: named in the refusal, never offered a command
    expect(nextAction).toMatch(/REFUSED \(candidate_kind_invalid[^)]*\): c-invalid/);
    // admission refusal carries its own next step
    expect(nextAction).toContain('REFUSED by the admission gate');
    expect(nextAction).toContain('provide_additional_evidence_or_manual_review');
    for (const refused of ['c-invalid', 'c-parked', 'c-admission']) {
      expect(nextAction).not.toContain(`pd candidate internalize --candidate-id ${refused}`);
      expect(nextAction).not.toContain(`pd candidate intake --candidate-id ${refused}`);
    }
    expect(nextAction).not.toContain('No candidates were generated');
    expect(nextAction).toContain('\n\n');
    // an admission refusal keeps the PRI-1222 exit-code contract
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('mixed REFUSALS only (seed-refused + admission-refused, nothing internalizable) — never "No candidates were generated"', async () => {
    await refuseAtAdmissionGate('c-admission');
    mockGetCandidatesByTaskId.mockResolvedValue([
      makeCandidate('c-invalid', 'wizardry', 'principle'),
      makeCandidate('c-admission', 'principle', 'principle'),
    ]);
    mockIntake.mockImplementation(async (candidateId: string) => ({
      outcome: 'refused', reason: 'unknown_kind', candidateId, rawRecommendationKind: 'wizardry', message: 'invalid kind',
    }));

    const { output } = await run({ json: true });
    expectPartition(classesOf(output), withClasses({ admission_refused: ['c-admission'], seed_refused: ['c-invalid'] }));
    const nextAction = String(output.nextAction);
    expect(nextAction).not.toContain('No candidates were generated');
    expect(nextAction).not.toContain('pd candidate internalize');
    expect(nextAction).toMatch(/1 candidate\(s\) were REFUSED \(candidate_kind_invalid[^)]*\): c-invalid/);
    expect(nextAction).toMatch(/1 candidate\(s\) were REFUSED by the admission gate/);
  });

  it('all parked: review guidance for each, no internalize command, not "no candidates"', async () => {
    mockGetCandidatesByTaskId.mockResolvedValue([
      makeCandidate('c-park-1', 'principle', 'principle'),
      makeCandidate('c-park-2', 'principle', 'principle'),
    ]);
    mockIntake.mockImplementation(async (candidateId: string) => ({
      outcome: 'refused', reason: 'reuse_pending_owner', candidateId, rawRecommendationKind: 'principle', message: 'parked',
    }));
    const { output } = await run({ json: true });
    expectPartition(classesOf(output), withClasses({ parked: ['c-park-1', 'c-park-2'] }));
    const nextAction = String(output.nextAction);
    expect(nextAction).toContain('pd candidate review --candidate-id c-park-1 --decide reuse|create');
    expect(nextAction).toContain('pd candidate review --candidate-id c-park-2 --decide reuse|create');
    expect(nextAction).not.toContain('pd candidate internalize');
    expect(nextAction).not.toContain('No candidates were generated');
    // a park is not an intake failure
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('all suppressed (reuse-resolved): reported as suppressed by design, no command, not "no candidates"', async () => {
    identityResolution.value = REUSE_RESOLVED;
    mockGetCandidatesByTaskId.mockResolvedValue([makeCandidate('c-reuse', 'principle', 'principle')]);
    mockIntake.mockResolvedValue({ outcome: 'ledger_entry', written: true, entry: { id: 'ledger-1' } });

    const { output } = await run({ json: true });
    expectPartition(classesOf(output), withClasses({ suppressed: ['c-reuse'] }));
    expect(dreamerCreationsFor('c-reuse')).toEqual([]);
    const nextAction = String(output.nextAction);
    expect(nextAction).toContain('Dreamer seed SUPPRESSED');
    expect(nextAction).not.toContain('pd candidate internalize');
    expect(nextAction).not.toContain('No candidates were generated');
  });

  it('--no-intake (JSON): the suggested command follows the RAW kind; an invalid kind gets none', async () => {
    mockGetCandidatesByTaskId.mockResolvedValue([
      makeCandidate('c-invalid', 'wizardry', 'principle'),
      makeCandidate('c-principle', 'principle', 'principle'),
      makeCandidate('c-rule', 'rule', 'rule'),
      makeCandidate('c-impl', 'implementation', 'implementation'),
    ]);

    const { output } = await run({ json: true, intake: false });
    expect(mockIntake).not.toHaveBeenCalled();
    expect(dreamerCreationsFor('')).toEqual([]);
    expectPartition(classesOf(output), withClasses({
      seed_refused: ['c-invalid'],
      intake_first: ['c-principle'],
      internalizable: ['c-rule'],
      no_route: ['c-impl'],
    }));

    const nextAction = String(output.nextAction);
    // a principle candidate is outside the ledger under --no-intake: intake FIRST
    const intakeIndex = nextAction.indexOf('pd candidate intake --candidate-id c-principle --workspace "/tmp/fake-workspace"');
    const internalizeIndex = nextAction.indexOf('pd candidate internalize --candidate-id c-principle --workspace "/tmp/fake-workspace"');
    expect(intakeIndex).toBeGreaterThanOrEqual(0);
    expect(internalizeIndex).toBeGreaterThan(intakeIndex);
    expect(nextAction).toContain('Intake writes the ledger only; it does NOT start Dreamer');
    // intake answers non_principle_kind for a rule candidate: internalize is the valid step
    expect(nextAction).toContain('pd candidate internalize --candidate-id c-rule --workspace "/tmp/fake-workspace"');
    expect(nextAction).not.toContain('pd candidate intake --candidate-id c-rule');
    // implementation has no enabled route
    expect(nextAction).not.toContain('--candidate-id c-impl');
    // the invalid kind is refused on the --no-intake path too (no seed result exists there)
    expect(nextAction).not.toContain('pd candidate intake --candidate-id c-invalid');
    expect(nextAction).not.toContain('pd candidate internalize --candidate-id c-invalid');
    expect(nextAction).toMatch(/REFUSED \(candidate_kind_invalid[^)]*\): c-invalid/);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('--no-intake (TTY): prints the same steps and never a command for the invalid kind', async () => {
    mockGetCandidatesByTaskId.mockResolvedValue([
      makeCandidate('c-invalid', 'wizardry', 'principle'),
      makeCandidate('c-principle', 'principle', 'principle'),
      makeCandidate('c-rule', 'rule', 'rule'),
    ]);

    const { tty } = await run({ json: false, intake: false });
    expect(tty).toContain('--no-intake');
    expect(tty).toContain('pd candidate intake --candidate-id c-principle --workspace "/tmp/fake-workspace"');
    expect(tty).toContain('pd candidate internalize --candidate-id c-rule --workspace "/tmp/fake-workspace"');
    expect(tty).not.toContain('pd candidate intake --candidate-id c-invalid');
    expect(tty).not.toContain('pd candidate internalize --candidate-id c-invalid');
    expect(tty).not.toContain('pd candidate intake --candidate-id c-rule');
    // the refusal is still visible, with the candidate named
    expect(tty).toMatch(/DREAMER SEED REFUSED \(candidate_kind_invalid\) — do NOT intake or internalize: c-invalid/);
  });

  it('TTY (intake on): mixed run prints review + refusal notes and an internalize block only for the class that needs it', async () => {
    await refuseAtAdmissionGate('c-admission');
    mockGetCandidatesByTaskId.mockResolvedValue([
      makeCandidate('c-invalid', 'wizardry', 'principle'),
      makeCandidate('c-parked', 'principle', 'principle'),
      makeCandidate('c-admission', 'principle', 'principle'),
      makeCandidate('c-ok', 'principle', 'principle'),
    ]);
    mockIntake.mockImplementation(async (candidateId: string) => {
      if (candidateId === 'c-invalid') {
        return { outcome: 'refused', reason: 'unknown_kind', candidateId, rawRecommendationKind: 'wizardry', message: 'invalid kind' };
      }
      if (candidateId === 'c-parked') {
        return { outcome: 'refused', reason: 'reuse_pending_owner', candidateId, rawRecommendationKind: 'principle', message: 'parked' };
      }
      return { outcome: 'ledger_entry', written: true, entry: { id: `ledger-${candidateId}` }, candidateId };
    });

    const { tty } = await run({ json: false });
    expect(tty).toContain('DREAMER SEED REFUSED — candidate_kind_invalid');
    expect(tty).toContain('pd candidate review --candidate-id c-parked --decide reuse|create');
    expect(tty).not.toContain('pd candidate internalize --candidate-id c-invalid');
    expect(tty).not.toContain('pd candidate internalize --candidate-id c-parked');
    expect(tty).not.toContain('pd candidate internalize --candidate-id c-admission');
    // c-ok was seeded: nothing left to start manually, so no "NOT started" claim
    expect(tty).toContain('dreamer seeded');
    expect(tty).not.toContain('has NOT started automatically');
  });
  it('invalid RAW kind outranks storage retry and never receives intake/internalize; retry command follows principle vs rule', async () => {
    const guidance = await import('../../src/commands/intake-outcome-guidance.js');
    const result = guidance.buildIntakeOutcomeGuidance({
      workspaceDir: '/tmp/fake-workspace',
      intakeEnabled: true,
      candidates: [
        { candidateId: 'c-invalid', rawRecommendationKind: 'wizardry' },
        { candidateId: 'c-principle', rawRecommendationKind: 'principle' },
        { candidateId: 'c-rule', rawRecommendationKind: 'rule' },
        { candidateId: 'c-prompt', rawRecommendationKind: 'prompt' },
      ],
      intakeResults: [
        { candidateId: 'c-invalid', status: 'intake_failed', nextAction: 'storage retry' },
        { candidateId: 'c-invalid', status: 'refused', nextAction: 'repair raw kind' },
        { candidateId: 'c-principle', status: 'intake_failed' },
        { candidateId: 'c-rule', status: 'intake_failed' },
        { candidateId: 'c-prompt', status: 'intake_failed' },
      ],
    });
    expect(result.byClass.seed_refused).toEqual(['c-invalid']);
    expect(result.byClass.intake_failed).toEqual(['c-principle', 'c-rule', 'c-prompt']);
    expect(result.nextAction).not.toContain('pd candidate intake --candidate-id c-invalid');
    expect(result.nextAction).not.toContain('pd candidate internalize --candidate-id c-invalid');
    expect(result.nextAction).toContain('pd candidate intake --candidate-id c-principle');
    expect(result.nextAction).toContain('pd candidate internalize --candidate-id c-rule');
    expect(result.nextAction).toContain('pd candidate internalize --candidate-id c-prompt');
  });

});
