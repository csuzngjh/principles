import { describe, it, expect, vi } from 'vitest';
import { PainSignalBridge, createDiagnosticianTaskId } from '../pain-signal-bridge.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { DiagnosticianRunnerLike } from '../pain-signal-bridge.js';
import type { CandidateIntakeService } from '../candidate-intake-service.js';
import type { LedgerAdapter } from '../candidate-intake.js';
import type { CandidateRecord } from '../store/runtime-state-manager.js';

interface MockStateManager {
  getTask: ReturnType<typeof vi.fn>;
  createTask: ReturnType<typeof vi.fn>;
  updateTask: ReturnType<typeof vi.fn>;
  getCandidatesByTaskId: ReturnType<typeof vi.fn>;
  getRunsByTask: ReturnType<typeof vi.fn>;
  updateCandidateStatus: ReturnType<typeof vi.fn>;
}

interface MockRunner {
  run: ReturnType<typeof vi.fn>;
}

function createMocks() {
  const stateManager: MockStateManager = {
    getTask: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    getCandidatesByTaskId: vi.fn(),
    getRunsByTask: vi.fn(),
    updateCandidateStatus: vi.fn(),
  };

  const runner: MockRunner = {
    run: vi.fn().mockResolvedValue({
      status: 'succeeded',
      taskId: 'diagnosis_pain-001',
      attemptCount: 1,
      output: {
        valid: true,
        diagnosisId: 'diag-001',
        summary: 'Test diagnosis',
        rootCause: 'Test root cause',
        violatedPrinciples: [],
        evidence: [{ sourceRef: 'src-1', note: 'evidence' }],
        recommendations: [{ kind: 'principle', description: 'Test recommendation' }],
        confidence: 0.85,
      },
    }),
  };

  const intakeService = {
    intake: vi.fn().mockResolvedValue({ id: 'ledger-entry-1' }),
  } as unknown as CandidateIntakeService;

  const ledgerAdapter: LedgerAdapter = {
    existsForCandidate: vi.fn().mockReturnValue(null),
    writeProbationEntry: vi.fn((entry: { id: string }) => ({ ...entry })),
  } as unknown as LedgerAdapter;

  return {
    stateManager: stateManager as unknown as RuntimeStateManager,
    runner: runner as unknown as DiagnosticianRunnerLike,
    intakeService,
    ledgerAdapter,
    _stateManager: stateManager,
    _runner: runner,
    _ledgerAdapter: ledgerAdapter,
  };
}

const makeCandidate = (overrides: Partial<CandidateRecord> = {}): CandidateRecord => ({
  candidateId: 'cand-1',
  taskId: 'task-1',
  artifactId: 'art-1',
  title: 'Test Candidate',
  description: 'Test description',
  sourceRecommendationJson: JSON.stringify({ text: 'Recommendation text' }),
  recommendationKind: 'principle',
  status: 'pending',
  ...overrides,
});

describe('createDiagnosticianTaskId', () => {
  it('generates correct task ID from painId', () => {
    const result = createDiagnosticianTaskId('pain-abc123');
    expect(result).toBe('diagnosis_pain-abc123');
  });

  it('handles painId with special characters', () => {
    const result = createDiagnosticianTaskId('pain/some:id');
    expect(result).toBe('diagnosis_pain/some:id');
  });
});

describe('PainSignalBridge', () => {
  describe('submitPainSignal', () => {
    it('creates pending task with generated taskId', async () => {
      const mocks = createMocks();
      mocks._stateManager.createTask.mockResolvedValue(undefined);

      const bridge = new PainSignalBridge({
        stateManager: mocks.stateManager,
        runner: mocks.runner,
        intakeService: mocks.intakeService,
        ledgerAdapter: mocks.ledgerAdapter,
      });

      const result = await bridge.submitPainSignal({
        painId: 'pain-submit-001',
        painType: 'tool_failure',
        source: 'manual',
        reason: 'Test submit',
      });

      expect(result.taskId).toBe('diagnosis_pain-submit-001');
      expect(mocks._stateManager.createTask).toHaveBeenCalledWith(expect.objectContaining({
        taskId: 'diagnosis_pain-submit-001',
        taskKind: 'diagnostician',
        inputRef: 'pain-submit-001',
        status: 'pending',
        maxAttempts: 3,
      }));
    });

    it('uses provided taskId when specified', async () => {
      const mocks = createMocks();
      mocks._stateManager.createTask.mockResolvedValue(undefined);

      const bridge = new PainSignalBridge({
        stateManager: mocks.stateManager,
        runner: mocks.runner,
        intakeService: mocks.intakeService,
        ledgerAdapter: mocks.ledgerAdapter,
      });

      const result = await bridge.submitPainSignal({
        painId: 'pain-submit-002',
        taskId: 'custom-task-id',
        painType: 'tool_failure',
        source: 'manual',
        reason: 'Test with custom taskId',
      });

      expect(result.taskId).toBe('custom-task-id');
      expect(mocks._stateManager.createTask).toHaveBeenCalledWith(expect.objectContaining({
        taskId: 'custom-task-id',
      }));
    });
  });

  describe('onPainDetected idempotency', () => {
    it('returns existing succeeded task result', async () => {
      const mocks = createMocks();
      mocks._stateManager.getTask.mockResolvedValue({
        taskId: 'diagnosis_pain-001',
        status: 'succeeded',
      });
      mocks._stateManager.getCandidatesByTaskId.mockResolvedValue([makeCandidate()]);
      mocks._stateManager.getRunsByTask.mockResolvedValue([{ runId: 'run-001' }]);
      mocks._ledgerAdapter.existsForCandidate.mockReturnValue({
        id: 'ledger-entry-1',
        title: 'Test',
        text: 'Test',
        status: 'probation',
        evaluability: 'weak_heuristic',
        sourceRef: 'candidate://cand-1',
        createdAt: new Date().toISOString(),
      });

      const bridge = new PainSignalBridge({
        stateManager: mocks.stateManager,
        runner: mocks.runner,
        intakeService: mocks.intakeService,
        ledgerAdapter: mocks.ledgerAdapter,
      });

      const result = await bridge.onPainDetected({
        painId: 'pain-001',
        painType: 'tool_failure',
        source: 'manual',
        reason: 'Test',
        evidence: [{ sourceRef: 'src-1', note: 'evidence' }],
      });

      expect(mocks._runner.run).not.toHaveBeenCalled();
      expect(result.status).toBe('succeeded');
      expect(result.candidateIds).toEqual(['cand-1']);
    });

    it('skips when task is leased and lease not expired', async () => {
      const mocks = createMocks();
      const recentTime = new Date(Date.now() - 1000).toISOString();
      mocks._stateManager.getTask.mockResolvedValue({
        taskId: 'diagnosis_pain-002',
        status: 'leased',
        leaseExpiresAt: recentTime,
      });

      const bridge = new PainSignalBridge({
        stateManager: mocks.stateManager,
        runner: mocks.runner,
        intakeService: mocks.intakeService,
        ledgerAdapter: mocks.ledgerAdapter,
      });

      const result = await bridge.onPainDetected({
        painId: 'pain-002',
        painType: 'tool_failure',
        source: 'manual',
        reason: 'Test',
        evidence: [{ sourceRef: 'src-1', note: 'evidence' }],
      });

      expect(mocks._runner.run).not.toHaveBeenCalled();
      expect(result.status).toBe('skipped');
      expect(result.message).toContain('already leased');
    });

    it('proceeds when task is leased but lease expired', async () => {
      const mocks = createMocks();
      const expiredTime = new Date(Date.now() - 400000).toISOString();
      mocks._stateManager.getTask.mockResolvedValue({
        taskId: 'diagnosis_pain-003',
        status: 'leased',
        leaseExpiresAt: expiredTime,
      });
      mocks._stateManager.createTask.mockResolvedValue(undefined);
      mocks._stateManager.getCandidatesByTaskId.mockResolvedValue([]);
      mocks._stateManager.getRunsByTask.mockResolvedValue([]);

      const bridge = new PainSignalBridge({
        stateManager: mocks.stateManager,
        runner: mocks.runner,
        intakeService: mocks.intakeService,
        ledgerAdapter: mocks.ledgerAdapter,
      });

      await bridge.onPainDetected({
        painId: 'pain-003',
        painType: 'tool_failure',
        source: 'manual',
        reason: 'Test',
        evidence: [{ sourceRef: 'src-1', note: 'evidence' }],
      });

      expect(mocks._runner.run).toHaveBeenCalled();
    });

    it('resets pending task with existing non-succeeded status', async () => {
      const mocks = createMocks();
      mocks._stateManager.getTask.mockResolvedValue({
        taskId: 'diagnosis_pain-004',
        status: 'failed',
        attemptCount: 2,
      });
      mocks._stateManager.updateTask.mockResolvedValue(undefined);
      mocks._stateManager.createTask.mockResolvedValue(undefined);
      mocks._stateManager.getCandidatesByTaskId.mockResolvedValue([]);
      mocks._stateManager.getRunsByTask.mockResolvedValue([]);

      const bridge = new PainSignalBridge({
        stateManager: mocks.stateManager,
        runner: mocks.runner,
        intakeService: mocks.intakeService,
        ledgerAdapter: mocks.ledgerAdapter,
      });

      await bridge.onPainDetected({
        painId: 'pain-004',
        painType: 'tool_failure',
        source: 'manual',
        reason: 'Test',
        evidence: [{ sourceRef: 'src-1', note: 'evidence' }],
      });

      expect(mocks._stateManager.updateTask).toHaveBeenCalledWith('diagnosis_pain-004', expect.objectContaining({
        status: 'pending',
        attemptCount: 0,
      }));
    });
  });

  describe('onPainDetected runner failure', () => {
    it('returns failed status when runner fails', async () => {
      const mocks = createMocks();
      mocks._stateManager.getTask.mockResolvedValue(null);
      mocks._stateManager.createTask.mockResolvedValue(undefined);
      mocks._runner.run.mockResolvedValue({
        status: 'failed',
        taskId: 'diagnosis_pain-fail',
        failureReason: 'Runner failed',
        errorCategory: 'runtime_error',
      });

      const bridge = new PainSignalBridge({
        stateManager: mocks.stateManager,
        runner: mocks.runner,
        intakeService: mocks.intakeService,
        ledgerAdapter: mocks.ledgerAdapter,
      });

      const result = await bridge.onPainDetected({
        painId: 'pain-fail',
        painType: 'tool_failure',
        source: 'manual',
        reason: 'Test',
        evidence: [{ sourceRef: 'src-1', note: 'evidence' }],
      });

      expect(result.status).toBe('failed');
      expect(result.runnerStatus).toBe('failed');
      expect(result.message).toBe('Runner failed');
    });

    it('returns retried status when runner returns retried', async () => {
      const mocks = createMocks();
      mocks._stateManager.getTask.mockResolvedValue(null);
      mocks._stateManager.createTask.mockResolvedValue(undefined);
      mocks._runner.run.mockResolvedValue({
        status: 'retried',
        taskId: 'diagnosis_pain-retry',
        failureReason: 'Transient error',
      });

      const bridge = new PainSignalBridge({
        stateManager: mocks.stateManager,
        runner: mocks.runner,
        intakeService: mocks.intakeService,
        ledgerAdapter: mocks.ledgerAdapter,
      });

      const result = await bridge.onPainDetected({
        painId: 'pain-retry',
        painType: 'tool_failure',
        source: 'manual',
        reason: 'Test',
        evidence: [{ sourceRef: 'src-1', note: 'evidence' }],
      });

      expect(result.status).toBe('retried');
      expect(result.runnerStatus).toBe('retried');
    });
  });

  describe('onDiagnosisComplete', () => {
    it('processes candidates with admissions', async () => {
      const mocks = createMocks();
      mocks._stateManager.getCandidatesByTaskId.mockResolvedValue([makeCandidate({ recommendationKind: 'principle' })]);
      mocks._stateManager.getRunsByTask.mockResolvedValue([{ runId: 'run-001' }]);

      const bridge = new PainSignalBridge({
        stateManager: mocks.stateManager,
        runner: mocks.runner,
        intakeService: mocks.intakeService,
        ledgerAdapter: mocks.ledgerAdapter,
      });

      const result = await bridge.onDiagnosisComplete({
        taskId: 'task-1',
        diagnosticianOutput: {
          valid: true,
          diagnosisId: 'diag-001',
          summary: 'Test',
          rootCause: 'Test',
          violatedPrinciples: [],
          evidence: [{ sourceRef: 'src-1', note: 'evidence' }],
          recommendations: [{ kind: 'principle', description: 'Test' }],
          confidence: 0.85,
        },
        painId: 'pain-001',
        provenance: 'openclaw_context_bound',
        inputEvidenceCount: 1,
      });

      expect(result.status).toBe('succeeded');
      expect(result.ledgerEntryIds).toEqual(['ledger-entry-1']);
    });

    it('marks candidates as consumed after intake', async () => {
      const mocks = createMocks();
      mocks._stateManager.getCandidatesByTaskId.mockResolvedValue([makeCandidate({ status: 'pending', recommendationKind: 'principle' })]);
      mocks._stateManager.getRunsByTask.mockResolvedValue([{ runId: 'run-001' }]);

      const bridge = new PainSignalBridge({
        stateManager: mocks.stateManager,
        runner: mocks.runner,
        intakeService: mocks.intakeService,
        ledgerAdapter: mocks.ledgerAdapter,
      });

      await bridge.onDiagnosisComplete({
        taskId: 'task-1',
        diagnosticianOutput: {
          valid: true,
          diagnosisId: 'diag-001',
          summary: 'Test',
          rootCause: 'Test',
          violatedPrinciples: [],
          evidence: [{ sourceRef: 'src-1', note: 'evidence' }],
          recommendations: [{ kind: 'principle', description: 'Test' }],
          confidence: 0.85,
        },
        painId: 'pain-001',
        provenance: 'openclaw_context_bound',
        inputEvidenceCount: 1,
      });

      expect(mocks._stateManager.updateCandidateStatus).toHaveBeenCalledWith('cand-1', { status: 'consumed' });
    });

    it('skips intake when autoIntakeEnabled is false', async () => {
      const mocks = createMocks();
      mocks._stateManager.getCandidatesByTaskId.mockResolvedValue([makeCandidate()]);
      mocks._stateManager.getRunsByTask.mockResolvedValue([{ runId: 'run-001' }]);

      const bridge = new PainSignalBridge({
        stateManager: mocks.stateManager,
        runner: mocks.runner,
        intakeService: mocks.intakeService,
        ledgerAdapter: mocks.ledgerAdapter,
        autoIntakeEnabled: false,
      });

      const result = await bridge.onDiagnosisComplete({
        taskId: 'task-1',
        diagnosticianOutput: {
          valid: true,
          diagnosisId: 'diag-001',
          summary: 'Test',
          rootCause: 'Test',
          violatedPrinciples: [],
          evidence: [{ sourceRef: 'src-1', note: 'evidence' }],
          recommendations: [{ kind: 'principle', description: 'Test' }],
          confidence: 0.85,
        },
        painId: 'pain-001',
        provenance: 'openclaw_context_bound',
      });

      expect(mocks.intakeService.intake).not.toHaveBeenCalled();
      expect(result.ledgerEntryIds).toEqual([]);
    });

    it('handles missing diagnosticianOutput', async () => {
      const mocks = createMocks();
      mocks._stateManager.getCandidatesByTaskId.mockResolvedValue([makeCandidate()]);
      mocks._stateManager.getRunsByTask.mockResolvedValue([{ runId: 'run-001' }]);

      const bridge = new PainSignalBridge({
        stateManager: mocks.stateManager,
        runner: mocks.runner,
        intakeService: mocks.intakeService,
        ledgerAdapter: mocks.ledgerAdapter,
      });

      const result = await bridge.onDiagnosisComplete({
        taskId: 'task-1',
        diagnosticianOutput: undefined,
        painId: 'pain-001',
        provenance: 'openclaw_context_bound',
      });

      expect(result.admissionResults).toBeDefined();
      expect(result.admissionResults![0].admission.decision).toBe('needs_evidence');
    });
  });

  describe('provenance inference', () => {
    it('infers owner_reported_no_host_trace for manual source without sessionId', async () => {
      const mocks = createMocks();
      mocks._stateManager.getTask.mockResolvedValue(null);
      mocks._stateManager.createTask.mockResolvedValue(undefined);
      mocks._stateManager.getCandidatesByTaskId.mockResolvedValue([]);
      mocks._stateManager.getRunsByTask.mockResolvedValue([]);

      const bridge = new PainSignalBridge({
        stateManager: mocks.stateManager,
        runner: mocks.runner,
        intakeService: mocks.intakeService,
        ledgerAdapter: mocks.ledgerAdapter,
      });

      await bridge.onPainDetected({
        painId: 'pain-provenance-1',
        painType: 'user_frustration',
        source: 'manual',
        reason: 'Manual report',
        evidence: [{ sourceRef: 'src-1', note: 'evidence' }],
      });

      expect(mocks._stateManager.createTask).toHaveBeenCalledWith(expect.objectContaining({
        diagnosticJson: expect.stringContaining('owner_reported_no_host_trace'),
      }));
    });

    it('infers openclaw_context_bound when sessionId is present', async () => {
      const mocks = createMocks();
      mocks._stateManager.getTask.mockResolvedValue(null);
      mocks._stateManager.createTask.mockResolvedValue(undefined);
      mocks._stateManager.getCandidatesByTaskId.mockResolvedValue([]);
      mocks._stateManager.getRunsByTask.mockResolvedValue([]);

      const bridge = new PainSignalBridge({
        stateManager: mocks.stateManager,
        runner: mocks.runner,
        intakeService: mocks.intakeService,
        ledgerAdapter: mocks.ledgerAdapter,
      });

      await bridge.onPainDetected({
        painId: 'pain-provenance-2',
        painType: 'tool_failure',
        source: 'hook',
        reason: 'Hook detected',
        evidence: [{ sourceRef: 'src-1', note: 'evidence' }],
        sessionId: 'session-abc123',
      });

      expect(mocks._stateManager.createTask).toHaveBeenCalledWith(expect.objectContaining({
        diagnosticJson: expect.stringContaining('openclaw_context_bound'),
      }));
    });
  });
});