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

const { MockRuntimeStateManager, rearmGateSeams, mockGetCandidatesByTaskId, mockCreateTask, mockGetTask } = vi.hoisted(() => {
  const mockGetCandidatesByTaskId = vi.fn().mockResolvedValue([]);
  const mockUpdateCandidateStatus = vi.fn().mockResolvedValue(undefined);
  const mockCreateTask = vi.fn().mockResolvedValue(undefined);
  const mockGetAdmissionDocument = vi.fn();
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
  return { MockRuntimeStateManager, rearmGateSeams, mockGetCandidatesByTaskId, mockCreateTask, mockGetTask };
});

const { mockIntake, MockCandidateIntakeService } = vi.hoisted(() => {
  const mockIntake = vi.fn();
  function MockCandidateIntakeService(this: unknown) {
    return { intake: mockIntake };
  }
  return { mockIntake, MockCandidateIntakeService };
});

const { MockPrincipleTreeLedgerAdapter } = vi.hoisted(() => {
  function MockPrincipleTreeLedgerAdapter(this: unknown) {
    return {
      resolveCandidatePrincipleIdentity: () => ({ status: 'unresolved', reason: 'missing', nextAction: 'none' }),
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

  it('invalid raw kind: zero dreamer seeding, consumed+refused records coexist, no internalize instruction', async () => {
    mockGetCandidatesByTaskId.mockResolvedValue([
      makeCandidate('c-invalid-kind', 'wizardry', 'principle'),
      makeCandidate('c-valid-prompt', 'prompt', 'prompt'),
    ]);
    mockIntake.mockImplementation(async (candidateId: string) => {
      if (candidateId === 'c-invalid-kind') {
        return {
          outcome: 'refused',
          reason: 'candidate_kind_invalid',
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
    // BOTH records coexist: consumed(+ledgerWriteRefused) is not overwritten
    expect(invalidRecords.some((r) => r.status === 'consumed' && r.ledgerWriteRefused === 'candidate_kind_invalid')).toBe(true);
    expect(invalidRecords.some((r) => r.status === 'refused' && r.reason === 'candidate_kind_invalid')).toBe(true);
    // the refused candidate never receives an internalize instruction
    const nextAction = String(output.nextAction ?? '');
    expect(nextAction).not.toContain('c-invalid-kind');
    const internalizable = output.internalizableCandidateIds as string[] | undefined;
    if (internalizable !== undefined) {
      expect(internalizable).not.toContain('c-invalid-kind');
    }
  });

  it('missing raw kind: zero dreamer seeding', async () => {
    mockGetCandidatesByTaskId.mockResolvedValue([
      makeCandidate('c-missing-kind', null, 'principle'),
    ]);
    mockIntake.mockImplementation(async (candidateId: string) => ({
      outcome: 'refused',
      reason: 'candidate_kind_invalid',
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
      reason: 'candidate_kind_invalid',
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
      reason: 'candidate_kind_invalid',
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
