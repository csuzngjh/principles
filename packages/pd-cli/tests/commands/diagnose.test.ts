import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

const { MockRuntimeStateManager, mockGetCandidatesByTaskId, mockUpdateCandidateStatus } = vi.hoisted(() => {
  const mockGetCandidatesByTaskId = vi.fn().mockResolvedValue([]);
  const mockUpdateCandidateStatus = vi.fn().mockResolvedValue(undefined);

  class MockRuntimeStateManager {
    initialize = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    getTask = vi.fn().mockResolvedValue({
      taskId: 'test-task-1',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      lastError: null,
    });
    getCandidatesByTaskId = mockGetCandidatesByTaskId;
    updateCandidateStatus = mockUpdateCandidateStatus;
    connection = {} as Record<string, unknown>;
    taskStore = {};
    runStore = {};
  }
  return { MockRuntimeStateManager, mockGetCandidatesByTaskId, mockUpdateCandidateStatus };
}, { validateType: true });

const { mockIntake, MockCandidateIntakeService } = vi.hoisted(() => {
  const mockIntake = vi.fn();
  function MockCandidateIntakeService(this: any) {
    return { intake: mockIntake };
  }
  MockCandidateIntakeService.prototype = {};
  return { mockIntake, MockCandidateIntakeService };
});

const { MockPrincipleTreeLedgerAdapter } = vi.hoisted(() => {
  function MockPrincipleTreeLedgerAdapter(this: any) {
    return {};
  }
  MockPrincipleTreeLedgerAdapter.prototype = {};
  return { MockPrincipleTreeLedgerAdapter };
});

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/fake-workspace'),
}));

vi.mock('@principles/core/runtime-v2', () => {
  return {
    RuntimeStateManager: vi.fn().mockImplementation(function () {
      return new MockRuntimeStateManager();
    }),
    SqliteHistoryQuery: vi.fn().mockImplementation(function () { return {}; }),
    SqliteContextAssembler: vi.fn().mockImplementation(function () { return {}; }),
    SqliteDiagnosticianCommitter: vi.fn().mockImplementation(function () { return {}; }),
    SqliteTrajectoryLocator: vi.fn().mockImplementation(function () { return {}; }),
    SqliteSourceTraceLocator: vi.fn().mockImplementation(function () { return {}; }),
    StoreEventEmitter: vi.fn().mockImplementation(function () { return {}; }),
    storeEmitter: { emitTelemetry: vi.fn() },
    DiagnosticianRunner: vi.fn().mockImplementation(function () { return {}; }),
    PassThroughValidator: vi.fn().mockImplementation(function () { return {}; }),
    DefaultDiagnosticianValidator: vi.fn().mockImplementation(function () { return {}; }),
    TestDoubleRuntimeAdapter: vi.fn().mockImplementation(function () { return {}; }),
    OpenClawCliRuntimeAdapter: vi.fn().mockImplementation(function () { return {}; }),
    PDRuntimeError: class PDRuntimeError extends Error {
      constructor(public category: string, message: string) {
        super(message);
        this.name = 'PDRuntimeError';
      }
    },
    CandidateIntakeService: MockCandidateIntakeService,
    resolveRuntimeConfig: vi.fn().mockReturnValue({
      runtimeKind: 'pi-ai',
      provider: 'test-provider',
      model: 'test-model',
      apiKeyEnv: 'TEST_KEY',
      timeoutMs: 300000,
      agentId: 'main',
    }),
    isRuntimeConfigError: vi.fn().mockReturnValue(false),
    run: vi.fn().mockResolvedValue({
      status: 'succeeded',
      taskId: 'test-task-1',
      output: {
        valid: true,
        diagnosisId: 'diag-123',
        taskId: 'test-task-1',
        summary: 'Test diagnosis summary',
        rootCause: 'Test: test root cause',
        violatedPrinciples: [],
        evidence: [],
        recommendations: [],
        confidence: 0.9,
      },
    }),
    status: vi.fn(),
  };
});

vi.mock('../../src/principle-tree-ledger-adapter.js', () => ({
  PrincipleTreeLedgerAdapter: MockPrincipleTreeLedgerAdapter,
}));

import { handleDiagnoseRun, type DiagnoseRunOptions } from '../../src/commands/diagnose.js';

const SUCCEEDED_RESULT = {
  status: 'succeeded' as const,
  taskId: 'test-task-1',
  output: {
    valid: true,
    diagnosisId: 'diag-123',
    taskId: 'test-task-1',
    summary: 'Test diagnosis summary',
    rootCause: 'Test: test root cause',
    violatedPrinciples: [],
    evidence: [],
    recommendations: [
      { kind: 'principle', description: 'Always validate tool arguments before execution' },
    ],
    confidence: 0.9,
  },
  attemptCount: 1,
};

describe('pd diagnose run --runtime routing', () => {
  let mockResolveRuntimeConfig: ReturnType<typeof vi.fn>;
  let mockIsRuntimeConfigError: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const runtimeV2 = await import('@principles/core/runtime-v2');
    mockResolveRuntimeConfig = vi.mocked(runtimeV2.resolveRuntimeConfig);
    mockIsRuntimeConfigError = vi.mocked(runtimeV2.isRuntimeConfigError);
    const { run } = runtimeV2;
    vi.mocked(run).mockResolvedValue(SUCCEEDED_RESULT);
    mockGetCandidatesByTaskId.mockResolvedValue([]);
    mockUpdateCandidateStatus.mockResolvedValue(undefined);
    mockIntake.mockReset();
  });

  it('CLI-01: --runtime test-double routes to TestDoubleRuntimeAdapter (regression)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: false,
    } as DiagnoseRunOptions);

    expect(consoleSpy).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('HG-03: --runtime openclaw-cli without mode (no file config) fails via resolveRuntimeConfig', async () => {
    mockResolveRuntimeConfig.mockReturnValueOnce({
      ok: false,
      reason: 'missing_openclaw_mode',
      message: 'runtimeKind is openclaw-cli but no mode specified',
      nextAction: 'Provide exactly one mode',
    });
    mockIsRuntimeConfigError.mockReturnValueOnce(true);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'openclaw-cli',
      json: false,
    } as DiagnoseRunOptions);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('no mode specified'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('HG-03: both --openclaw-local and --openclaw-gateway exits with error (mutually exclusive)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'openclaw-cli',
      openclawLocal: true,
      openclawGateway: true,
      json: false,
    } as DiagnoseRunOptions);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'error: --openclaw-local and --openclaw-gateway are mutually exclusive'
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('DPB-09: openclaw-cli with file config openclawMode succeeds without CLI flag', async () => {
    mockResolveRuntimeConfig.mockReturnValueOnce({
      runtimeKind: 'openclaw-cli',
      openclawMode: 'local',
      timeoutMs: 300000,
      agentId: 'main',
    });
    mockIsRuntimeConfigError.mockReturnValueOnce(false);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'openclaw-cli',
      json: false,
    } as DiagnoseRunOptions);

    expect(exitSpy).not.toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('DPB-09: openclaw-cli flag overrides file config mode', async () => {
    mockResolveRuntimeConfig.mockReturnValueOnce({
      runtimeKind: 'openclaw-cli',
      openclawMode: 'gateway',
      timeoutMs: 300000,
      agentId: 'main',
    });
    mockIsRuntimeConfigError.mockReturnValueOnce(false);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'openclaw-cli',
      openclawLocal: true,
      json: false,
    } as DiagnoseRunOptions);

    expect(exitSpy).not.toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('DPB-09: openclaw-cli missing mode (--json) outputs JSON error', async () => {
    mockResolveRuntimeConfig.mockReturnValueOnce({
      ok: false,
      reason: 'missing_openclaw_mode',
      message: 'runtimeKind is openclaw-cli but no mode specified',
      nextAction: 'Provide exactly one mode',
    });
    mockIsRuntimeConfigError.mockReturnValueOnce(true);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'openclaw-cli',
      json: true,
    } as DiagnoseRunOptions);

    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0]);
    expect(jsonOutput.ok).toBe(false);
    expect(jsonOutput.reason).toBe('missing_openclaw_mode');
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('CLI-04: unknown runtime kind exits with error and exit code 1', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'invalid-runtime',
      json: true,
    } as DiagnoseRunOptions);

    expect(consoleErrorSpy).toHaveBeenCalledWith("error: unknown runtime kind 'invalid-runtime' (supported: openclaw-cli, test-double, pi-ai)");
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe('pd diagnose run — auto-intake after success', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { run } = await import('@principles/core/runtime-v2');
    vi.mocked(run).mockResolvedValue(SUCCEEDED_RESULT);
    mockGetCandidatesByTaskId.mockResolvedValue([]);
    mockUpdateCandidateStatus.mockResolvedValue(undefined);
    mockIntake.mockReset();
  });

  it('INTAKE-01: successful diagnose + intake — candidates consumed, JSON includes intake evidence', async () => {
    const candidates = [
      { candidateId: 'cand-1', artifactId: 'art-1', taskId: 'test-task-1', status: 'pending' },
      { candidateId: 'cand-2', artifactId: 'art-2', taskId: 'test-task-1', status: 'pending' },
    ];
    mockGetCandidatesByTaskId.mockResolvedValue(candidates);
    mockIntake
      .mockResolvedValueOnce({ id: 'ledger-1', title: 'Principle 1', status: 'probation' })
      .mockResolvedValueOnce({ id: 'ledger-2', title: 'Principle 2', status: 'probation' });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    expect(mockIntake).toHaveBeenCalledTimes(2);
    expect(mockIntake).toHaveBeenCalledWith('cand-1');
    expect(mockIntake).toHaveBeenCalledWith('cand-2');
    expect(mockUpdateCandidateStatus).toHaveBeenCalledTimes(2);
    expect(mockUpdateCandidateStatus).toHaveBeenCalledWith('cand-1', { status: 'consumed' });
    expect(mockUpdateCandidateStatus).toHaveBeenCalledWith('cand-2', { status: 'consumed' });

    const jsonOutput = consoleSpy.mock.calls.find(call => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.intake && Array.isArray(parsed.intake.candidates);
      } catch { return false; }
    });
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse((jsonOutput as [string])[0]);
    expect(parsed.intake.enabled).toBe(true);
    expect(parsed.intake.candidates).toHaveLength(2);
    expect(parsed.intake.candidates[0].candidateId).toBe('cand-1');
    expect(parsed.intake.candidates[0].status).toBe('consumed');
    expect(parsed.intake.candidates[0].ledgerEntryId).toBe('ledger-1');
    expect(parsed.intake.candidates[1].candidateId).toBe('cand-2');
    expect(parsed.intake.candidates[1].status).toBe('consumed');
    expect(parsed.intake.candidates[1].ledgerEntryId).toBe('ledger-2');
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('INTAKE-02: successful diagnose + intake failure — exits non-zero with nextAction', async () => {
    const candidates = [
      { candidateId: 'cand-ok', artifactId: 'art-1', taskId: 'test-task-1', status: 'pending' },
      { candidateId: 'cand-fail', artifactId: 'art-2', taskId: 'test-task-1', status: 'pending' },
    ];
    mockGetCandidatesByTaskId.mockResolvedValue(candidates);
    mockIntake
      .mockResolvedValueOnce({ id: 'ledger-ok', title: 'OK', status: 'probation' })
      .mockImplementationOnce(() => { throw new Error('Ledger write failed'); });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    const jsonOutput = consoleSpy.mock.calls.find(call => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.intake && Array.isArray(parsed.intake.candidates);
      } catch { return false; }
    });
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse((jsonOutput as [string])[0]);
    expect(parsed.intake.candidates).toHaveLength(2);
    expect(parsed.intake.candidates[0].status).toBe('consumed');
    expect(parsed.intake.candidates[1].status).toBe('intake_failed');
    expect(parsed.intake.candidates[1].error).toContain('Ledger write failed');
    expect(parsed.intake.candidates[1].nextAction).toContain('pd candidate intake --candidate-id cand-fail');
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('INTAKE-03: --no-intake skips intake, candidates remain pending with advisory', async () => {
    const candidates = [
      { candidateId: 'cand-1', artifactId: 'art-1', taskId: 'test-task-1', status: 'pending' },
    ];
    mockGetCandidatesByTaskId.mockResolvedValue(candidates);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
      intake: false,
    } as DiagnoseRunOptions);

    expect(mockIntake).not.toHaveBeenCalled();
    expect(mockUpdateCandidateStatus).not.toHaveBeenCalled();

    const jsonOutput = consoleSpy.mock.calls.find(call => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.intake && Array.isArray(parsed.intake.candidates);
      } catch { return false; }
    });
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse((jsonOutput as [string])[0]);
    expect(parsed.intake.enabled).toBe(false);
    expect(parsed.intake.candidates).toHaveLength(1);
    expect(parsed.intake.candidates[0].candidateId).toBe('cand-1');
    expect(parsed.intake.candidates[0].status).toBe('skipped');
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('INTAKE-04: --no-intake human-readable output shows advisory with manual intake commands', async () => {
    const candidates = [
      { candidateId: 'cand-1', artifactId: 'art-1', taskId: 'test-task-1', status: 'pending' },
    ];
    mockGetCandidatesByTaskId.mockResolvedValue(candidates);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: false,
      intake: false,
    } as DiagnoseRunOptions);

    const allOutput = consoleSpy.mock.calls.map(call => call[0]).join('\n');
    expect(allOutput).toContain('--no-intake');
    expect(allOutput).toContain('pd candidate intake --candidate-id cand-1');
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('INTAKE-05: intake failure human-readable output shows nextAction', async () => {
    const candidates = [
      { candidateId: 'cand-fail', artifactId: 'art-1', taskId: 'test-task-1', status: 'pending' },
    ];
    mockGetCandidatesByTaskId.mockResolvedValue(candidates);
    mockIntake.mockImplementation(() => { throw new Error('Ledger write failed'); });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: false,
    } as DiagnoseRunOptions);

    const allOutput = consoleSpy.mock.calls.map(call => call[0]).join('\n');
    expect(allOutput).toContain('INTAKE FAILED');
    expect(allOutput).toContain('Next action: pd candidate intake --candidate-id cand-fail');
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('INTAKE-06: does not bypass ledger — consumed only set after intake succeeds', async () => {
    const candidates = [
      { candidateId: 'cand-1', artifactId: 'art-1', taskId: 'test-task-1', status: 'pending' },
    ];
    mockGetCandidatesByTaskId.mockResolvedValue(candidates);
    mockIntake.mockImplementation(() => { throw new Error('Ledger write failed'); });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    expect(mockIntake).toHaveBeenCalledWith('cand-1');
    expect(mockUpdateCandidateStatus).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('INTAKE-07: already-consumed candidate — intake called but updateCandidateStatus skipped', async () => {
    const candidates = [
      { candidateId: 'cand-consumed', artifactId: 'art-1', taskId: 'test-task-1', status: 'consumed' },
    ];
    mockGetCandidatesByTaskId.mockResolvedValue(candidates);
    mockIntake.mockResolvedValue({ id: 'ledger-existing', title: 'Existing', status: 'probation' });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    expect(mockIntake).toHaveBeenCalledWith('cand-consumed');
    expect(mockUpdateCandidateStatus).not.toHaveBeenCalled();

    const jsonOutput = consoleSpy.mock.calls.find(call => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.intake && Array.isArray(parsed.intake.candidates);
      } catch { return false; }
    });
    const parsed = JSON.parse((jsonOutput as [string])[0]);
    expect(parsed.intake.candidates[0].status).toBe('consumed');
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('INTAKE-08: no candidates produced — intake not called, output shows empty intake', async () => {
    mockGetCandidatesByTaskId.mockResolvedValue([]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    expect(mockIntake).not.toHaveBeenCalled();
    expect(mockUpdateCandidateStatus).not.toHaveBeenCalled();

    const jsonOutput = consoleSpy.mock.calls.find(call => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.intake;
      } catch { return false; }
    });
    const parsed = JSON.parse((jsonOutput as [string])[0]);
    expect(parsed.intake.candidates).toHaveLength(0);
    expect(parsed.intake.enabled).toBe(true);
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('INTAKE-09: successful diagnose + intake — human-readable output shows consumed candidates', async () => {
    const candidates = [
      { candidateId: 'cand-1', artifactId: 'art-1', taskId: 'test-task-1', status: 'pending' },
    ];
    mockGetCandidatesByTaskId.mockResolvedValue(candidates);
    mockIntake.mockResolvedValue({ id: 'ledger-1', title: 'Principle 1', status: 'probation' });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: false,
    } as DiagnoseRunOptions);

    const allOutput = consoleSpy.mock.calls.map(call => call[0]).join('\n');
    expect(allOutput).toContain('Candidate Intake');
    expect(allOutput).toContain('cand-1: consumed');
    expect(allOutput).toContain('ledger-1');
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('INTAKE-10: --json mode outputs exactly one console.log with parseable JSON (no text header leak)', async () => {
    mockGetCandidatesByTaskId.mockResolvedValue([]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const rawOutput = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(rawOutput);
    expect(parsed.status).toBe('succeeded');
    expect(parsed.intake).toBeDefined();
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('INTAKE-11: --json intake failure nextAction contains executable command with workspace', async () => {
    const candidates = [
      { candidateId: 'cand-err', artifactId: 'art-1', taskId: 'test-task-1', status: 'pending' },
    ];
    mockGetCandidatesByTaskId.mockResolvedValue(candidates);
    mockIntake.mockImplementation(() => { throw new Error('DB locked'); });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    const rawOutput = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(rawOutput);
    const failed = parsed.intake.candidates[0];
    expect(failed.status).toBe('intake_failed');
    expect(failed.nextAction).toMatch(/^pd candidate intake --candidate-id cand-err --workspace "/);
    expect(failed.nextAction).toContain('/tmp/fake-workspace');
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('INTAKE-12: failed diagnosis does not trigger intake (process.exit stubbed)', async () => {
    const { run } = await import('@principles/core/runtime-v2');
    vi.mocked(run).mockResolvedValueOnce({
      status: 'failed',
      taskId: 'test-task-1',
      errorCategory: 'timeout',
      failureReason: 'LLM call timed out',
      attemptCount: 3,
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    expect(mockGetCandidatesByTaskId).not.toHaveBeenCalled();
    expect(mockIntake).not.toHaveBeenCalled();
    expect(mockUpdateCandidateStatus).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe('Commander wiring for --no-intake', () => {
  function createDiagnoseProgram(): { program: Command; capturedOpts: Record<string, unknown> } {
    const program = new Command();
    program.exitOverride();
    const capturedOpts: Record<string, unknown> = {};

    program
      .command('diagnose')
      .command('run')
      .option('--no-intake', 'Skip candidate intake after successful diagnosis')
      .option('--json', 'Output raw JSON')
      .action(async (opts) => {
        Object.assign(capturedOpts, opts);
      });

    return { program, capturedOpts };
  }

  it('CMD-01: --no-intake accepted, sets opts.intake === false', async () => {
    const { program, capturedOpts } = createDiagnoseProgram();
    await program.parseAsync(['node', 'pd', 'diagnose', 'run', '--no-intake']);
    expect(capturedOpts.intake).toBe(false);
  });

  it('CMD-02: default (no flag) → opts.intake === true', async () => {
    const { program, capturedOpts } = createDiagnoseProgram();
    await program.parseAsync(['node', 'pd', 'diagnose', 'run']);
    expect(capturedOpts.intake).toBe(true);
  });

  it('CMD-03: --intake is not a valid option (Commander rejects it)', async () => {
    const { program } = createDiagnoseProgram();
    await expect(
      program.parseAsync(['node', 'pd', 'diagnose', 'run', '--intake'])
    ).rejects.toThrow();
  });
});
