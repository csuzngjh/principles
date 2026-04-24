import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleDiagnoseRun, type DiagnoseRunOptions } from '../../src/commands/diagnose.js';
import { RuntimeStateManager } from '@principles/core/runtime-v2/index.js';

// Mock RuntimeStateManager at module level
vi.mock('@principles/core/runtime-v2/index.js', async () => {
  const actual = await vi.importActual('@principles/core/runtime-v2/index.js');
  return {
    ...actual as object,
    RuntimeStateManager: vi.fn().mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getTask: vi.fn().mockResolvedValue({
        taskId: 'test-task-1',
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 3,
        lastError: null,
      }),
    })),
  };
});

describe('pd diagnose run --runtime routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('CLI-01: --runtime test-double routes to TestDoubleRuntimeAdapter (regression)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: undefined,
      runtime: 'test-double',
      json: false,
    } as DiagnoseRunOptions);

    // Should have logged output (diagnose run succeeded with test-double)
    expect(consoleSpy).toHaveBeenCalled();
    // Should not have called process.exit with error
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('HG-03: --runtime openclaw-cli without mode flag exits with error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: undefined,
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
      workspace: undefined,
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

  it('CLI-04: unknown runtime kind exits with error in JSON format', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: undefined,
      runtime: 'invalid-runtime',
      json: true,
    } as DiagnoseRunOptions);

    // Should have printed JSON error
    const jsonOutput = consoleLogSpy.mock.calls.find(call => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.status === 'failed' && parsed.errorCategory;
      } catch { return false; }
    });
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse((jsonOutput as [string])[0]);
    expect(parsed.status).toBe('failed');
    expect(parsed.errorCategory).toBeDefined();
    expect(parsed.runtimeKind).toBe('invalid-runtime');

    consoleLogSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
