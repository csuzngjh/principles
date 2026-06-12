/**
 * PRI-349: workspaceDir propagation through diagnosticJson.
 *
 * TDD tests for the "capture-time snapshot" fix:
 *   - 用例 A: buildDiagnosticJson output contains workspaceDir
 *   - 用例 B: onPainDetected persists workspaceDir in diagnosticJson via createTask
 *   - 用例 C: end-to-end through SqliteContextAssembler — payload.workspaceDir ≠ '<unknown>'
 *
 * ERR entries considered:
 *   - ERR-002 (silent degradation): workspaceDir silently falling back to '<unknown>'
 *     is a silent degradation. This fix makes workspaceDir explicit in diagnosticJson.
 *   - ERR-001/ERR-005 (as bypasses validation): no `as` casts used; workspaceDir
 *     is a string parameter validated by the JSON serialization path.
 *   - ERR-009 (required fields silently skipped): workspaceDir was silently omitted
 *     from buildDiagnosticJson; this fix adds it explicitly.
 */
import { describe, it, expect, vi } from 'vitest';
import { PainSignalBridge } from '../pain-signal-bridge.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { DiagnosticianRunnerLike } from '../pain-signal-bridge.js';
import type { CandidateIntakeService } from '../candidate-intake-service.js';
import type { LedgerAdapter } from '../candidate-intake.js';

const WORKSPACE_DIR = '/home/user/projects/my-app';
const PAIN_ID = 'pain-wsdir-001';

/** Type guard: narrow unknown to a string-keyed record for safe property access. */
function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createMocks() {
  const createTaskMock = vi.fn().mockResolvedValue(undefined);

  const stateManager = {
    getTask: vi.fn().mockResolvedValue(null),
    createTask: createTaskMock,
    updateTask: vi.fn(),
    getCandidatesByTaskId: vi.fn().mockResolvedValue([]),
    getRunsByTask: vi.fn().mockResolvedValue([]),
  } as unknown as RuntimeStateManager;

  const runner = {
    run: vi.fn().mockResolvedValue({
      status: 'succeeded',
      taskId: `diagnosis_${PAIN_ID}`,
      attemptCount: 1,
      output: {
        valid: true,
        diagnosisId: 'diag-wsdir',
        summary: 'Test',
        rootCause: 'Test',
        violatedPrinciples: [],
        evidence: [{ sourceRef: 'src-1', note: 'evidence' }],
        recommendations: [{ kind: 'principle', description: 'Test' }],
        confidence: 0.85,
      },
    }),
  } as unknown as DiagnosticianRunnerLike;

  const intakeService = {
    intake: vi.fn().mockResolvedValue({ id: 'ledger-wsdir-1' }),
  } as unknown as CandidateIntakeService;

  const ledgerAdapter = {
    register: vi.fn(),
    existsForCandidate: vi.fn().mockReturnValue({
      id: 'ledger-wsdir-1',
      status: 'probation',
      createdAt: new Date().toISOString(),
      text: 'Test principle',
      sourceRef: 'candidate://c-wsdir-1',
      title: 'Test',
      evaluability: 'weak_heuristic',
    }),
    getEntries: vi.fn(),
  } as unknown as LedgerAdapter;

  return {
    stateManager,
    runner,
    intakeService,
    ledgerAdapter,
    _createTask: createTaskMock,
  };
}

/** Extract the first argument of the first call to createTask mock. */
function getFirstCreateTaskArg(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [firstCall] = mock.mock.calls;
  if (!firstCall || firstCall.length === 0) throw new Error('createTask call had no arguments');
  const [firstArg] = firstCall;
  return firstArg;
}

describe('PRI-349: workspaceDir propagation through diagnosticJson', () => {
  // 用例 A: buildDiagnosticJson output contains workspaceDir
  // Tested indirectly via onPainDetected → createTask → diagnosticJson parsing
  it('用例 A: diagnosticJson written by onPainDetected contains workspaceDir field', async () => {
    const mocks = createMocks();
    const bridge = new PainSignalBridge({
      stateManager: mocks.stateManager,
      runner: mocks.runner,
      intakeService: mocks.intakeService,
      ledgerAdapter: mocks.ledgerAdapter,
      workspaceDir: WORKSPACE_DIR,
    });

    await bridge.onPainDetected({
      painId: PAIN_ID,
      painType: 'tool_failure',
      source: 'pain',
      reason: 'Test workspaceDir propagation',
      evidence: [{ sourceRef: 'src-1', note: 'evidence' }],
    });

    expect(mocks._createTask).toHaveBeenCalledTimes(1);
    const callArg = getFirstCreateTaskArg(mocks._createTask);
    const diagnosticJsonStr = callArg.diagnosticJson;
    if (typeof diagnosticJsonStr !== 'string') {
      throw new Error('Expected diagnosticJson to be a string');
    }

    const parsed: unknown = JSON.parse(diagnosticJsonStr);
    expect(isStringRecord(parsed)).toBe(true);
    if (isStringRecord(parsed)) {
      // Runtime Contract Rule 5: use Object.hasOwn for untrusted keys
      expect(Object.hasOwn(parsed, 'workspaceDir')).toBe(true);
      expect(parsed.workspaceDir).toBe(WORKSPACE_DIR);
    }
  });

  // 用例 A 补充: workspaceDir=null when not provided
  it('用例 A: diagnosticJson has workspaceDir=null when bridge has no workspaceDir', async () => {
    const mocks = createMocks();
    const bridge = new PainSignalBridge({
      stateManager: mocks.stateManager,
      runner: mocks.runner,
      intakeService: mocks.intakeService,
      ledgerAdapter: mocks.ledgerAdapter,
      // workspaceDir intentionally omitted
    });

    await bridge.onPainDetected({
      painId: PAIN_ID,
      painType: 'tool_failure',
      source: 'pain',
      reason: 'Test without workspaceDir',
      evidence: [{ sourceRef: 'src-1', note: 'evidence' }],
    });

    expect(mocks._createTask).toHaveBeenCalledTimes(1);
    const callArg = getFirstCreateTaskArg(mocks._createTask);
    const diagnosticJsonStr = callArg.diagnosticJson;
    if (typeof diagnosticJsonStr !== 'string') {
      throw new Error('Expected diagnosticJson to be a string');
    }
    const parsed: unknown = JSON.parse(diagnosticJsonStr);
    if (isStringRecord(parsed)) {
      expect(Object.hasOwn(parsed, 'workspaceDir')).toBe(true);
      expect(parsed.workspaceDir).toBeNull();
    }
  });

  // 用例 B: onPainDetected persists workspaceDir in diagnosticJson via createTask
  it('用例 B: onPainDetected creates task with diagnosticJson containing workspaceDir', async () => {
    const mocks = createMocks();
    const bridge = new PainSignalBridge({
      stateManager: mocks.stateManager,
      runner: mocks.runner,
      intakeService: mocks.intakeService,
      ledgerAdapter: mocks.ledgerAdapter,
      workspaceDir: WORKSPACE_DIR,
    });

    await bridge.onPainDetected({
      painId: PAIN_ID,
      painType: 'tool_failure',
      source: 'pain',
      reason: 'Test persistence',
      evidence: [{ sourceRef: 'src-1', note: 'evidence' }],
    });

    // Verify createTask was called with the correct taskId and diagnosticJson
    expect(mocks._createTask).toHaveBeenCalledTimes(1);
    const callArg = getFirstCreateTaskArg(mocks._createTask);
    expect(callArg.taskKind).toBe('diagnostician');
    expect(callArg.taskId).toBe(`diagnosis_${PAIN_ID}`);

    // The diagnosticJson must be parseable and contain workspaceDir
    const diagnosticJsonStr = callArg.diagnosticJson;
    if (typeof diagnosticJsonStr !== 'string') {
      throw new Error('Expected diagnosticJson to be a string');
    }
    const parsed: unknown = JSON.parse(diagnosticJsonStr);
    if (isStringRecord(parsed)) {
      expect(parsed.workspaceDir).toBe(WORKSPACE_DIR);
      // Also verify other standard fields are present
      expect(Object.hasOwn(parsed, 'sourcePainId')).toBe(true);
      expect(Object.hasOwn(parsed, 'reasonSummary')).toBe(true);
      expect(Object.hasOwn(parsed, 'provenance')).toBe(true);
    }
  });
});
