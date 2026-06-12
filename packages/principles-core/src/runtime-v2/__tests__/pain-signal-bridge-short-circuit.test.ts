/**
 * PRI-345: Short-circuit tests for empty input evidence in PainSignalBridge.
 *
 * Tests that onPainDetected short-circuits before runner.run when input evidence
 * is empty and source is not owner-initiated (manual/pain/skill:pain).
 *
 * Also verifies owner manual paths are NOT short-circuited (PRI-311 regression guard).
 */
import { describe, it, expect, vi } from 'vitest';
import { PainSignalBridge } from '../pain-signal-bridge.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { DiagnosticianRunnerLike } from '../pain-signal-bridge.js';
import type { CandidateIntakeService } from '../candidate-intake-service.js';
import type { LedgerAdapter } from '../candidate-intake.js';

interface MockStateManager {
  getTask: ReturnType<typeof vi.fn>;
  createTask: ReturnType<typeof vi.fn>;
  updateTask: ReturnType<typeof vi.fn>;
  getCandidatesByTaskId: ReturnType<typeof vi.fn>;
  getRunsByTask: ReturnType<typeof vi.fn>;
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
  };

  const runner: MockRunner = {
    run: vi.fn().mockResolvedValue({
      status: 'succeeded',
      taskId: 'diagnosis_pain-sc-001',
      attemptCount: 1,
      output: {
        valid: true,
        diagnosisId: 'diag-sc',
        summary: 'Test',
        rootCause: 'Test',
        violatedPrinciples: [],
        evidence: [{ sourceRef: 'src-1', note: 'evidence' }],
        recommendations: [{ kind: 'principle', description: 'Test' }],
        confidence: 0.85,
      },
    }),
  };

  const intakeService = {
    intake: vi.fn().mockResolvedValue({ id: 'ledger-sc-1' }),
  } as unknown as CandidateIntakeService;

  const ledgerAdapter: LedgerAdapter = {
    register: vi.fn(),
    existsForCandidate: vi.fn().mockReturnValue({
      id: 'ledger-sc-1',
      status: 'probation',
      createdAt: new Date().toISOString(),
      text: 'Test principle',
      sourceRef: 'candidate://c-sc-1',
      title: 'Test',
      evaluability: 'weak_heuristic',
    }),
    getEntries: vi.fn(),
  } as unknown as LedgerAdapter;

  return {
    stateManager: stateManager as unknown as RuntimeStateManager,
    runner: runner as unknown as DiagnosticianRunnerLike,
    intakeService,
    ledgerAdapter,
    _stateManager: stateManager,
    _runner: runner,
  };
}

describe('PRI-345: PainSignalBridge empty-evidence short circuit', () => {
  // 用例 D（短路）: evidence=[], source='tool_failure' → runner.run NOT called
  // IMPORTANT: Idempotency check (getTask) is called FIRST before short-circuit decision.
  // This ensures that existing succeeded tasks are returned correctly.
  it('short-circuits when evidence is empty and source is tool_failure (not owner-initiated)', async () => {
    const mocks = createMocks();
    // getTask returns null → no existing task → short-circuit applies
    mocks._stateManager.getTask.mockResolvedValue(null);

    const bridge = new PainSignalBridge({
      stateManager: mocks.stateManager,
      runner: mocks.runner,
      intakeService: mocks.intakeService,
      ledgerAdapter: mocks.ledgerAdapter,
    });

    const result = await bridge.onPainDetected({
      painId: 'pain-sc-001',
      painType: 'tool_failure',
      source: 'tool_failure',
      reason: 'Test tool failure',
      evidence: [],
    });

    // runner.run must NOT be called
    expect(mocks._runner.run).not.toHaveBeenCalled();
    // stateManager.getTask IS called for idempotency check (priority over short-circuit)
    expect(mocks._stateManager.getTask).toHaveBeenCalledTimes(1);
    // createTask must NOT be called (zero side effects after short-circuit)
    expect(mocks._stateManager.createTask).not.toHaveBeenCalled();

    // Result must be skipped with reason + nextAction (ERR-002)
    expect(result.status).toBe('skipped');
    expect(result.painId).toBe('pain-sc-001');
    expect(result.candidateIds).toHaveLength(0);
    expect(result.ledgerEntryIds).toHaveLength(0);
    expect(result.message).toContain('short_circuited');
    expect(result.message).toContain('input evidence empty');
    expect(result.message).toContain('re-trigger');
  });

  // 用例 E（正常路径回归）: evidence has entries → runner.run called
  it('does NOT short-circuit when evidence has entries (normal path)', async () => {
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
      painId: 'pain-normal-001',
      painType: 'tool_failure',
      source: 'tool_failure',
      reason: 'Test with evidence',
      evidence: [
        { sourceRef: 'src-1', note: 'real evidence entry 1' },
        { sourceRef: 'src-2', note: 'real evidence entry 2' },
      ],
    });

    // runner.run must be called
    expect(mocks._runner.run).toHaveBeenCalledTimes(1);
  });

  // 用例 F（owner 手动豁免）: evidence=[], source='manual' → runner.run still called
  it('does NOT short-circuit when source=manual even with empty evidence (PRI-311 regression guard)', async () => {
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
      painId: 'pain-manual-001',
      painType: 'user_frustration',
      source: 'manual',
      reason: 'Owner reported issue',
      evidence: [],
      provenance: 'owner_reported_no_host_trace',
    });

    // runner.run must be called — owner intent overrides empty evidence
    expect(mocks._runner.run).toHaveBeenCalledTimes(1);
  });

  it('does NOT short-circuit when source=pain even with empty evidence', async () => {
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
      painId: 'pain-source-pain-001',
      painType: 'tool_failure',
      source: 'pain',
      reason: 'Pain source path',
      evidence: [],
    });

    expect(mocks._runner.run).toHaveBeenCalledTimes(1);
  });

  it('does NOT short-circuit when source=skill:pain even with empty evidence', async () => {
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
      painId: 'pain-skill-pain-001',
      painType: 'tool_failure',
      source: 'skill:pain',
      reason: 'Skill pain source path',
      evidence: [],
    });

    expect(mocks._runner.run).toHaveBeenCalledTimes(1);
  });

  it('short-circuits when evidence is undefined (treated as empty) and source is not owner', async () => {
    const mocks = createMocks();
    // getTask returns null → no existing task → short-circuit applies
    mocks._stateManager.getTask.mockResolvedValue(null);

    const bridge = new PainSignalBridge({
      stateManager: mocks.stateManager,
      runner: mocks.runner,
      intakeService: mocks.intakeService,
      ledgerAdapter: mocks.ledgerAdapter,
    });

    const result = await bridge.onPainDetected({
      painId: 'pain-undef-001',
      painType: 'tool_failure',
      source: 'subagent_error',
      reason: 'No evidence field',
      // evidence is intentionally undefined
    });

    expect(mocks._runner.run).not.toHaveBeenCalled();
    expect(result.status).toBe('skipped');
    expect(result.message).toContain('short_circuited');
  });
});
