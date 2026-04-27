import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted for all mock factories that reference each other
const { MockRuntimeStateManager } = vi.hoisted(() => {
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
    connection = {} as Record<string, unknown>;
    taskStore = {};
    runStore = {};
  }
  return { MockRuntimeStateManager };
}, { validateType: true });

// Mock resolveWorkspaceDir FIRST before any other imports
vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/fake-workspace'),
}));

// Mock @principles/core/runtime-v2
vi.mock('@principles/core/runtime-v2', () => {
  return {
    RuntimeStateManager: vi.fn().mockImplementation(function () {
      return new MockRuntimeStateManager();
    }),
    SqliteHistoryQuery: vi.fn().mockImplementation(function () { return {}; }),
    SqliteContextAssembler: vi.fn().mockImplementation(function () { return {}; }),
    SqliteDiagnosticianCommitter: vi.fn().mockImplementation(function () { return {}; }),
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

// Import the command handler AFTER mocks are set up
import { handleDiagnoseRun, type DiagnoseRunOptions } from '../../src/commands/diagnose.js';

describe('pd diagnose run --runtime routing', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-setup run mock for each test
    const { run } = await import('@principles/core/runtime-v2');
    vi.mocked(run).mockResolvedValue({
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
    });
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

  it('HG-03: --runtime openclaw-cli without mode flag exits with error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'openclaw-cli',
      json: false,
    } as DiagnoseRunOptions);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'error: --openclaw-local or --openclaw-gateway is required when using --runtime openclaw-cli'
    );
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

  it('CLI-04: unknown runtime kind exits with error and exit code 1', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'invalid-runtime',
      json: true,
    } as DiagnoseRunOptions);

    expect(consoleErrorSpy).toHaveBeenCalledWith("error: unknown runtime kind 'invalid-runtime'");
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
