/**
 * Tests for pd pain retry command.
 *
 * Covers:
 * - Command parser/registration: --pain-id, --json, --force
 * - Success path: retry_wait + last_error → succeeded + last_error cleared
 * - Not found path: JSON single object + reason + nextAction
 * - Already succeeded without --force: refused
 * - Force path: allow retry of succeeded task
 * - Strict JSON: --json stdout exactly one parseable JSON object
 * - No mutation on failed validation: no run/candidate/ledger created when task not found
 * - painId with diagnosis_ prefix: rejected with reason + nextAction
 * - Wrong taskKind: rejected with reason + nextAction
 * - Missing pi-ai config: rejected with reason + nextAction
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const { MockRuntimeStateManager, mockGetTask, mockGetCandidatesByTaskId, mockUpdateCandidateStatus, mockGetRunsByTask } = vi.hoisted(() => {
  const mockGetTask = vi.fn().mockResolvedValue(null);
  const mockGetCandidatesByTaskId = vi.fn().mockResolvedValue([]);
  const mockUpdateCandidateStatus = vi.fn().mockResolvedValue(undefined);
  const mockGetRunsByTask = vi.fn().mockResolvedValue([]);

  class MockRuntimeStateManager {
    initialize = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    getTask = mockGetTask;
    getCandidatesByTaskId = mockGetCandidatesByTaskId;
    updateCandidateStatus = mockUpdateCandidateStatus;
    getRunsByTask = mockGetRunsByTask;
    connection = {} as Record<string, unknown>;
    taskStore = {};
    runStore = {};
  }
  return { MockRuntimeStateManager, mockGetTask, mockGetCandidatesByTaskId, mockUpdateCandidateStatus, mockGetRunsByTask };
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

const { mockRun, mockResolveRuntimeConfig, mockResolveRuntimeFromPdConfig } = vi.hoisted(() => {
  const mockRun = vi.fn().mockResolvedValue({
    status: 'succeeded',
    taskId: 'diagnosis_test-pain-1',
    runId: 'run-retry-1',
    contextHash: 'abc123',
  });
  const mockResolveRuntimeConfig = vi.fn().mockReturnValue({
    runtimeKind: 'pi-ai',
    provider: 'test-provider',
    model: 'test-model',
    apiKeyEnv: 'TEST_KEY',
    timeoutMs: 300000,
    agentId: 'main',
  });
  const mockResolveRuntimeFromPdConfig = vi.fn().mockReturnValue({
    result: {
      runtimeKind: 'pi-ai',
      provider: 'test-provider',
      model: 'test-model',
      apiKeyEnv: 'TEST_KEY',
      timeoutMs: 300000,
      agentId: 'main',
    },
    legacyWarnings: [],
    configSource: '.pd/config.yaml',
    configLoadResult: { ok: true, effective: {}, defaults: {}, legacyFilesDetected: [] },
  });
  return { mockRun, mockResolveRuntimeConfig, mockResolveRuntimeFromPdConfig };
});

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/fake-workspace'),
}));

// BUG-1 (PRI-442): capture runner constructor args to verify effectiveConfig wiring
const { diagRootCauseRunnerCtor, diagDistillerRunnerCtor, diagRouterRunnerCtor } = vi.hoisted(() => {
  const diagRootCauseRunnerCtor = vi.fn().mockImplementation(function () { return {}; });
  const diagDistillerRunnerCtor = vi.fn().mockImplementation(function () { return {}; });
  const diagRouterRunnerCtor = vi.fn().mockImplementation(function () { return {}; });
  return { diagRootCauseRunnerCtor, diagDistillerRunnerCtor, diagRouterRunnerCtor };
});

vi.mock('../../src/services/pd-config-loader.js', () => ({
  loadPdConfig: vi.fn().mockReturnValue({
    ok: true,
    effective: { config: { featureFlags: { diagnostician_llm_degradation: true } }, source: 'file', warnings: [] },
    defaults: { config: {}, source: 'defaults', warnings: [] },
  }),
  computeFlagsFromLoadResult: vi.fn().mockReturnValue({}),
}));

// Dead-letter store mock: getByPainId returns null by default so the
// implementation produces status='not_found' with reason='task_not_found'.
// Tests that need to exercise the dead-letter replay path override this.
const { MockSqliteDeadLetterStore, mockDeadLetterGetByPainId } = vi.hoisted(() => {
  const mockDeadLetterGetByPainId = vi.fn().mockReturnValue(null);
  class MockSqliteDeadLetterStore {
    getByPainId = mockDeadLetterGetByPainId;
    constructor(_connection: unknown) {}
  }
  return { MockSqliteDeadLetterStore, mockDeadLetterGetByPainId };
});

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
    SqliteDeadLetterStore: MockSqliteDeadLetterStore,
    PainSignalBridge: vi.fn().mockImplementation(function () { return {}; }),
    StoreEventEmitter: vi.fn().mockImplementation(function () { return {}; }),
    storeEmitter: { emitTelemetry: vi.fn() },
    SplitDiagnosticianRunner: vi.fn().mockImplementation(function () { return {}; }),
    DiagRootCauseRunner: diagRootCauseRunnerCtor,
    DiagDistillerRunner: diagDistillerRunnerCtor,
    DiagRouterRunner: diagRouterRunnerCtor,
    DefaultDiagRootCauseValidator: vi.fn().mockImplementation(function () { return {}; }),
    DefaultDiagDistillerValidator: vi.fn().mockImplementation(function () { return {}; }),
    DisabledDiagnosticianRunner: vi.fn().mockImplementation(function () { return {}; }),
    TestDoubleRuntimeAdapter: vi.fn().mockImplementation(function () { return {}; }),
    OpenClawCliRuntimeAdapter: vi.fn().mockImplementation(function () { return {}; }),
    PiAiRuntimeAdapter: vi.fn().mockImplementation(function () { return {}; }),
    SPLIT_PIPELINE_TOTAL_TIMEOUT_MS: 300000,
    // PRI-638: capability gate — available by default; disabled cases override this.
    resolveDiagnosticianCapability: vi.fn((): { available: boolean; reason?: string; message?: string; nextAction?: string } => ({ available: true })),
    PDRuntimeError: class PDRuntimeError extends Error {
      constructor(public category: string, message: string) {
        super(message);
        this.name = 'PDRuntimeError';
      }
    },
    CandidateIntakeService: MockCandidateIntakeService,
    // PRI-503: admission gate mock — admit by default so existing retry/intake
    // tests keep their original flow. Tests that need to assert refusal behavior
    // can override this mock per-test.
    evaluateCandidateAdmissionFromRecord: vi.fn().mockReturnValue({
      decision: 'admitted',
      reason: 'mock_admitted',
      nextAction: 'none',
      evidenceStatus: 'unknown',
    }),
    resolveRuntimeConfig: mockResolveRuntimeConfig,
    isRuntimeConfigError: vi.fn().mockReturnValue(false),
    isFeatureEnabled: vi.fn().mockReturnValue(true),
    resolveOutputLanguage: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
    validatePdConfig: vi.fn().mockReturnValue({ valid: true, errors: [] }),
    computeEffectivePdConfig: vi.fn().mockReturnValue({ config: {}, source: 'defaults', warnings: [] }),
    computeFeatureFlagsFromConfig: vi.fn().mockReturnValue({}),
    redactPdConfig: vi.fn().mockImplementation((c) => c),
    run: mockRun,
    status: vi.fn(),
    PrincipleTreeLedgerAdapter: MockPrincipleTreeLedgerAdapter,
  };
});

vi.mock('../../src/config-reader.js', () => ({
  readOutputLanguageFromWorkspace: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
}));

vi.mock('../../src/services/resolve-runtime-from-pd-config.js', () => ({
  resolveRuntimeFromPdConfig: mockResolveRuntimeFromPdConfig,
}));

import { handlePainRetry } from '../../src/commands/pain-retry.js';

// ── Test Data ──────────────────────────────────────────────────────────────────

const RETRY_WAIT_TASK = {
  taskId: 'diagnosis_test-pain-1',
  taskKind: 'diagnostician',
  status: 'retry_wait' as const,
  attemptCount: 1,
  maxAttempts: 3,
  lastError: 'output_invalid',
  leaseOwner: null,
  leaseExpiresAt: null,
  resultRef: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const FAILED_TASK = {
  taskId: 'diagnosis_test-pain-failed',
  taskKind: 'diagnostician',
  status: 'failed' as const,
  attemptCount: 3,
  maxAttempts: 3,
  lastError: 'timeout',
  leaseOwner: null,
  leaseExpiresAt: null,
  resultRef: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const SUCCEEDED_TASK = {
  taskId: 'diagnosis_test-pain-succeeded',
  taskKind: 'diagnostician',
  status: 'succeeded' as const,
  attemptCount: 2,
  maxAttempts: 3,
  lastError: null,
  leaseOwner: null,
  leaseExpiresAt: null,
  resultRef: 'commit://abc',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const NON_DIAGNOSTICIAN_TASK = {
  taskId: 'diagnosis_test-pain-wrong',
  taskKind: 'dreamer',
  status: 'failed' as const,
  attemptCount: 1,
  maxAttempts: 3,
  lastError: 'timeout',
  leaseOwner: null,
  leaseExpiresAt: null,
  resultRef: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('pd pain retry — validation and error paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveRuntimeConfig.mockReturnValue({
      runtimeKind: 'pi-ai',
      provider: 'test-provider',
      model: 'test-model',
      apiKeyEnv: 'TEST_KEY',
      timeoutMs: 300000,
      agentId: 'main',
    });
    mockResolveRuntimeFromPdConfig.mockReturnValue({
      result: {
        runtimeKind: 'pi-ai',
        provider: 'test-provider',
        model: 'test-model',
        apiKeyEnv: 'TEST_KEY',
        timeoutMs: 300000,
        agentId: 'main',
      },
      legacyWarnings: [],
      configSource: '.pd/config.yaml',
      configLoadResult: { ok: true, effective: {}, defaults: {}, legacyFilesDetected: [] },
    });
    mockGetTask.mockResolvedValue(null);
    mockGetCandidatesByTaskId.mockResolvedValue([]);
    mockUpdateCandidateStatus.mockResolvedValue(undefined);
    mockGetRunsByTask.mockResolvedValue([]);
    mockIntake.mockReset();
    mockDeadLetterGetByPainId.mockReturnValue(null);
    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'diagnosis_test-pain-1',
      runId: 'run-retry-1',
      contextHash: 'abc123',
    });
  });

  it('RETRY-01: painId not found — JSON output with reason + nextAction', async () => {
    mockGetTask.mockResolvedValue(null);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'nonexistent-pain',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    });

    const jsonCall = logSpy.mock.calls.find((call) => {
      try { JSON.parse(call[0] as string); return true; } catch { return false; }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall![0] as string);
    expect(output.status).toBe('not_found');
    expect(output.painId).toBe('nonexistent-pain');
    expect(output.reason).toContain('task_not_found');
    expect(output.nextAction).toBeDefined();
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('RETRY-02: painId with diagnosis_ prefix — rejected with reason + nextAction', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'diagnosis_test-pain-1',
      workspace: '/tmp/fake-workspace',
      json: true,
    });

    // Find the JSON output (may be mixed with other logs)
    const jsonCall = logSpy.mock.calls.find((call) => {
      try { JSON.parse(call[0] as string); return true; } catch { return false; }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall![0] as string);
    expect(output.status).toBe('refused');
    expect(output.reason).toContain('diagnosis_');
    expect(output.nextAction).toContain('pd diagnose run');
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('RETRY-03: task is not diagnostician — refused with reason + nextAction', async () => {
    mockGetTask.mockResolvedValue(NON_DIAGNOSTICIAN_TASK);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-wrong',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    });

    const jsonCall = logSpy.mock.calls.find((call) => {
      try { JSON.parse(call[0] as string); return true; } catch { return false; }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall![0] as string);
    expect(output.status).toBe('refused');
    expect(output.reason).toContain('wrong_task_kind');
    expect(output.nextAction).toBeDefined();
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('RETRY-04: already succeeded without --force — refused', async () => {
    mockGetTask.mockResolvedValue(SUCCEEDED_TASK);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-succeeded',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    });

    const jsonCall = logSpy.mock.calls.find((call) => {
      try { JSON.parse(call[0] as string); return true; } catch { return false; }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall![0] as string);
    expect(output.status).toBe('refused');
    expect(output.reason).toContain('already_succeeded');
    expect(output.nextAction).toContain('--force');
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('RETRY-05: no mutation on failed validation — run not called when task not found', async () => {
    mockGetTask.mockResolvedValue(null);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'nonexistent',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    });

    expect(mockRun).not.toHaveBeenCalled();
    expect(mockGetCandidatesByTaskId).not.toHaveBeenCalled();
    expect(mockIntake).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it('RETRY-05a: missing --runtime and no config — refused with reason + nextAction (JSON)', async () => {
    mockGetTask.mockResolvedValue(RETRY_WAIT_TASK);
    // PRI-393: resolveRuntimeFromPdConfig returns error → no runtime resolved
    mockResolveRuntimeFromPdConfig.mockReturnValueOnce({
      result: {
        reason: 'config_not_found',
        message: 'No .pd/config.yaml found',
        nextAction: 'Create .pd/config.yaml or pass --runtime',
      },
      legacyWarnings: [],
      configSource: '.pd/config.yaml',
      configLoadResult: { ok: false, effective: {}, defaults: {}, legacyFilesDetected: [] },
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-1',
      workspace: '/tmp/fake-workspace',
      // No runtime specified
      json: true,
    });

    const jsonCall = logSpy.mock.calls.find((call) => {
      try { JSON.parse(call[0] as string); return true; } catch { return false; }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall![0] as string);
    expect(output.status).toBe('refused');
    expect(output.reason).toContain('missing_runtime');
    expect(output.nextAction).toContain('--runtime');
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('RETRY-05b: conflicting flags --openclaw-local + --openclaw-gateway — JSON output', async () => {
    mockGetTask.mockResolvedValue(RETRY_WAIT_TASK);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'openclaw-cli',
      openclawLocal: true,
      openclawGateway: true,
      json: true,
    });

    const jsonCall = logSpy.mock.calls.find((call) => {
      try { JSON.parse(call[0] as string); return true; } catch { return false; }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall![0] as string);
    expect(output.status).toBe('refused');
    expect(output.reason).toContain('conflicting_flags');
    expect(output.nextAction).toBeDefined();
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('RETRY-05c: blank provider/model/apiKeyEnv — refused with missing_required_config', async () => {
    mockGetTask.mockResolvedValue(RETRY_WAIT_TASK);
    // PRI-393: resolveRuntimeFromPdConfig returns config with blank strings
    mockResolveRuntimeFromPdConfig.mockReturnValueOnce({
      result: {
        runtimeKind: 'pi-ai',
        provider: '',
        model: '   ',
        apiKeyEnv: '',
        timeoutMs: 300000,
        agentId: 'main',
      },
      legacyWarnings: [],
      configSource: '.pd/config.yaml',
      configLoadResult: { ok: true, effective: {}, defaults: {}, legacyFilesDetected: [] },
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'pi-ai',
      json: true,
    });

    const jsonCall = logSpy.mock.calls.find((call) => {
      try { JSON.parse(call[0] as string); return true; } catch { return false; }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall![0] as string);
    expect(output.status).toBe('refused');
    expect(output.reason).toContain('missing_required_config');
    expect(output.reason).toContain('provider');
    expect(output.reason).toContain('model');
    expect(output.reason).toContain('apiKeyEnv');
    expect(output.nextAction).toBeDefined();
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('DPB-09: openclaw-cli flag overrides file config mode (config=gateway, flag=local → runtimeMode=local)', async () => {
    mockGetTask.mockResolvedValue(RETRY_WAIT_TASK);
    mockResolveRuntimeFromPdConfig.mockReturnValueOnce({
      result: {
        runtimeKind: 'openclaw-cli',
        openclawMode: 'gateway',
        timeoutMs: 300000,
        agentId: 'main',
      },
      legacyWarnings: [],
      configSource: '.pd/config.yaml',
      configLoadResult: { ok: true, effective: {}, defaults: {}, legacyFilesDetected: [] },
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'openclaw-cli',
      openclawLocal: true,
      json: true,
    });

    // Flag override: config says gateway, flag says local → adapter gets local
    const OpenClawCliMock = vi.mocked(
      await import('@principles/core/runtime-v2').then(m => m.OpenClawCliRuntimeAdapter),
    );
    expect(OpenClawCliMock).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeMode: 'local' }),
    );
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('DPB-09: openclaw-cli flag overrides file config mode (config=local, flag=gateway → runtimeMode=gateway)', async () => {
    mockGetTask.mockResolvedValue(RETRY_WAIT_TASK);
    mockResolveRuntimeFromPdConfig.mockReturnValueOnce({
      result: {
        runtimeKind: 'openclaw-cli',
        openclawMode: 'local',
        timeoutMs: 300000,
        agentId: 'main',
      },
      legacyWarnings: [],
      configSource: '.pd/config.yaml',
      configLoadResult: { ok: true, effective: {}, defaults: {}, legacyFilesDetected: [] },
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'openclaw-cli',
      openclawGateway: true,
      json: true,
    });

    const OpenClawCliMock = vi.mocked(
      await import('@principles/core/runtime-v2').then(m => m.OpenClawCliRuntimeAdapter),
    );
    expect(OpenClawCliMock).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeMode: 'gateway' }),
    );
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe('pd pain retry — success paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCandidatesByTaskId.mockResolvedValue([]);
    mockUpdateCandidateStatus.mockResolvedValue(undefined);
    mockGetRunsByTask.mockResolvedValue([]);
    mockIntake.mockReset();
    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'diagnosis_test-pain-1',
      runId: 'run-retry-1',
      contextHash: 'abc123',
    });
  });

  it('RETRY-06: retry_wait + last_error → succeeded — JSON output with previousTaskStatus and previousLastError', async () => {
    mockGetTask.mockResolvedValue(RETRY_WAIT_TASK);
    mockGetCandidatesByTaskId.mockResolvedValue([
      { candidateId: 'cand-1', artifactId: 'art-1', taskId: 'diagnosis_test-pain-1', status: 'pending' },
    ]);
    mockIntake.mockResolvedValue({ id: 'ledger-1', title: 'Principle 1', status: 'probation' });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.status).toBe('succeeded');
    expect(output.painId).toBe('test-pain-1');
    expect(output.taskId).toBe('diagnosis_test-pain-1');
    expect(output.previousTaskStatus).toBe('retry_wait');
    expect(output.previousLastError).toBe('output_invalid');
    expect(output.newTaskStatus).toBe('succeeded');
    expect(output.candidateIds).toContain('cand-1');
    expect(output.nextAction).toContain('pd candidate internalize');
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('RETRY-07: failed task → succeeded — JSON output', async () => {
    mockGetTask.mockResolvedValue(FAILED_TASK);
    mockGetCandidatesByTaskId.mockResolvedValue([]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-failed',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.status).toBe('succeeded');
    expect(output.previousTaskStatus).toBe('failed');
    expect(output.previousLastError).toBe('timeout');
    expect(output.nextAction).toContain('No candidates');
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('RETRY-08: --force allows retry of succeeded task', async () => {
    mockGetTask.mockResolvedValue(SUCCEEDED_TASK);
    mockGetCandidatesByTaskId.mockResolvedValue([]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-succeeded',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
      force: true,
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.status).toBe('succeeded');
    expect(output.previousTaskStatus).toBe('succeeded');
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('RETRY-09: --json outputs exactly one parseable JSON object', async () => {
    mockGetTask.mockResolvedValue(RETRY_WAIT_TASK);
    mockGetCandidatesByTaskId.mockResolvedValue([]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const rawOutput = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(rawOutput);
    expect(parsed.status).toBe('succeeded');
    expect(parsed.painId).toBe('test-pain-1');
    expect(parsed.nextAction).toBeDefined();
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('RETRY-10: nextAction mentions internalization is NOT automatic', async () => {
    mockGetTask.mockResolvedValue(RETRY_WAIT_TASK);
    mockGetCandidatesByTaskId.mockResolvedValue([
      { candidateId: 'cand-1', artifactId: 'art-1', taskId: 'diagnosis_test-pain-1', status: 'pending' },
    ]);
    mockIntake.mockResolvedValue({ id: 'ledger-1', title: 'Principle 1', status: 'probation' });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    });

    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.nextAction).toContain('NOT started automatically');
    expect(output.nextAction).toContain('pd candidate internalize --candidate-id cand-1');
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('RETRY-11: failed retry — JSON output with errorCategory + nextAction', async () => {
    mockGetTask.mockResolvedValue(RETRY_WAIT_TASK);
    mockRun.mockResolvedValueOnce({
      status: 'failed',
      taskId: 'diagnosis_test-pain-1',
      errorCategory: 'output_invalid',
      failureReason: 'LLM output failed validation',
      attemptCount: 2,
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.status).toBe('failed');
    expect(output.errorCategory).toBe('output_invalid');
    expect(output.nextAction).toBeDefined();
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('RETRY-12: intake failure — JSON output with intake_failed + nextAction', async () => {
    mockGetTask.mockResolvedValue(RETRY_WAIT_TASK);
    mockGetCandidatesByTaskId.mockResolvedValue([
      { candidateId: 'cand-fail', artifactId: 'art-1', taskId: 'diagnosis_test-pain-1', status: 'pending' },
    ]);
    mockIntake.mockImplementation(() => { throw new Error('Ledger write failed'); });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    });

    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.intake.candidates[0].status).toBe('intake_failed');
    expect(output.intake.candidates[0].nextAction).toContain('pd candidate intake');
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe('pd pain retry — human-readable output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCandidatesByTaskId.mockResolvedValue([]);
    mockUpdateCandidateStatus.mockResolvedValue(undefined);
    mockGetRunsByTask.mockResolvedValue([]);
    mockIntake.mockReset();
    mockDeadLetterGetByPainId.mockReturnValue(null);
    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'diagnosis_test-pain-1',
      runId: 'run-retry-1',
      contextHash: 'abc123',
    });
  });

  it('RETRY-13: not found — human-readable error with nextAction', async () => {
    mockGetTask.mockResolvedValue(null);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'nonexistent',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: false,
    });

    const allErrors = errorSpy.mock.calls.map(call => call[0]).join('\n');
    expect(allErrors).toContain('nonexistent');
    expect(allErrors).toContain('nextAction');
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('RETRY-14: success — human-readable output shows previous status and nextAction', async () => {
    mockGetTask.mockResolvedValue(RETRY_WAIT_TASK);
    mockGetCandidatesByTaskId.mockResolvedValue([
      { candidateId: 'cand-1', artifactId: 'art-1', taskId: 'diagnosis_test-pain-1', status: 'pending' },
    ]);
    mockIntake.mockResolvedValue({ id: 'ledger-1', title: 'Principle 1', status: 'probation' });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: false,
    });

    const allOutput = logSpy.mock.calls.map(call => call[0]).join('\n');
    expect(allOutput).toContain('retry_wait');
    expect(allOutput).toContain('output_invalid');
    expect(allOutput).toContain('succeeded');
    expect(allOutput).toContain('pd candidate internalize');
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe('Commander wiring for pd pain retry', () => {
  function createPainRetryProgram(): { program: Command; capturedOpts: Record<string, unknown> } {
    const program = new Command();
    program.exitOverride();
    const capturedOpts: Record<string, unknown> = {};

    program
      .command('pain')
      .command('retry')
      .requiredOption('-p, --pain-id <painId>', 'Pain ID')
      .option('-w, --workspace <path>', 'Workspace directory')
      .option('-r, --runtime <kind>', 'Runtime kind')
      .option('--openclaw-local', 'Use local OpenClaw')
      .option('--openclaw-gateway', 'Use gateway OpenClaw')
      .option('-a, --agent <agentId>', 'Agent ID')
      .option('--provider <name>', 'LLM provider')
      .option('--model <id>', 'Model ID')
      .option('--apiKeyEnv <name>', 'API key env var')
      .option('--baseUrl <url>', 'Custom base URL')
      .option('--maxRetries <n>', 'Max retries', parseInt)
      .option('--timeoutMs <ms>', 'Timeout ms', parseInt)
      .option('--force', 'Force retry of succeeded task')
      .option('--json', 'Output raw JSON')
      .action(async (opts) => {
        Object.assign(capturedOpts, opts);
      });

    return { program, capturedOpts };
  }

  it('CMD-01: --pain-id is required, missing → error', async () => {
    const { program } = createPainRetryProgram();
    await expect(
      program.parseAsync(['node', 'pd', 'pain', 'retry', '--json'])
    ).rejects.toThrow();
  });

  it('CMD-02: --pain-id sets opts.painId', async () => {
    const { program, capturedOpts } = createPainRetryProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'retry', '--pain-id', 'abc123']);
    expect(capturedOpts.painId).toBe('abc123');
  });

  it('CMD-03: -p short form sets opts.painId', async () => {
    const { program, capturedOpts } = createPainRetryProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'retry', '-p', 'abc123']);
    expect(capturedOpts.painId).toBe('abc123');
  });

  it('CMD-04: --force sets opts.force === true', async () => {
    const { program, capturedOpts } = createPainRetryProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'retry', '--pain-id', 'abc', '--force']);
    expect(capturedOpts.force).toBe(true);
  });

  it('CMD-05: default (no --force) → opts.force === undefined', async () => {
    const { program, capturedOpts } = createPainRetryProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'retry', '--pain-id', 'abc']);
    expect(capturedOpts.force).toBeUndefined();
  });

  it('CMD-06: --json sets opts.json === true', async () => {
    const { program, capturedOpts } = createPainRetryProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'retry', '--pain-id', 'abc', '--json']);
    expect(capturedOpts.json).toBe(true);
  });

  it('CMD-07: --runtime sets opts.runtime', async () => {
    const { program, capturedOpts } = createPainRetryProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'retry', '--pain-id', 'abc', '--runtime', 'pi-ai']);
    expect(capturedOpts.runtime).toBe('pi-ai');
  });

  // REGRESSION: PRI-337 — all options must route through pain retry
  it('CMD-08: --baseUrl sets opts.baseUrl', async () => {
    const { program, capturedOpts } = createPainRetryProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'retry', '--pain-id', 'abc', '--baseUrl', 'https://custom.api.com']);
    expect(capturedOpts.baseUrl).toBe('https://custom.api.com');
  });

  it('CMD-09: --maxRetries sets opts.maxRetries as number', async () => {
    const { program, capturedOpts } = createPainRetryProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'retry', '--pain-id', 'abc', '--maxRetries', '5']);
    expect(capturedOpts.maxRetries).toBe(5);
  });

  it('CMD-10: --timeoutMs sets opts.timeoutMs as number', async () => {
    const { program, capturedOpts } = createPainRetryProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'retry', '--pain-id', 'abc', '--timeoutMs', '60000']);
    expect(capturedOpts.timeoutMs).toBe(60000);
  });

  it('CMD-11: --provider sets opts.provider', async () => {
    const { program, capturedOpts } = createPainRetryProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'retry', '--pain-id', 'abc', '--provider', 'openrouter']);
    expect(capturedOpts.provider).toBe('openrouter');
  });

  it('CMD-12: --model sets opts.model', async () => {
    const { program, capturedOpts } = createPainRetryProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'retry', '--pain-id', 'abc', '--model', 'anthropic/claude-sonnet-4']);
    expect(capturedOpts.model).toBe('anthropic/claude-sonnet-4');
  });

  it('CMD-13: --apiKeyEnv sets opts.apiKeyEnv', async () => {
    const { program, capturedOpts } = createPainRetryProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'retry', '--pain-id', 'abc', '--apiKeyEnv', 'OPENROUTER_KEY']);
    expect(capturedOpts.apiKeyEnv).toBe('OPENROUTER_KEY');
  });

  it('CMD-14: -a (--agent) sets opts.agent', async () => {
    const { program, capturedOpts } = createPainRetryProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'retry', '--pain-id', 'abc', '-a', 'main']);
    expect(capturedOpts.agent).toBe('main');
  });

  it('CMD-15: --openclaw-local sets opts.openclawLocal === true', async () => {
    const { program, capturedOpts } = createPainRetryProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'retry', '--pain-id', 'abc', '--openclaw-local']);
    expect(capturedOpts.openclawLocal).toBe(true);
  });

  it('CMD-16: --openclaw-gateway sets opts.openclawGateway === true', async () => {
    const { program, capturedOpts } = createPainRetryProgram();
    await program.parseAsync(['node', 'pd', 'pain', 'retry', '--pain-id', 'abc', '--openclaw-gateway']);
    expect(capturedOpts.openclawGateway).toBe(true);
  });
});

// BUG-1 (PRI-442): effectiveConfig must be passed to split-pipeline runners
// so that ADR-0019 LLM rate-limit degradation (isDegradationEnabled) can fire.
// EP-02: production path wiring.
describe('BUG-1 (PRI-442): pain retry — effectiveConfig wiring to split-pipeline runners', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCandidatesByTaskId.mockResolvedValue([]);
    mockUpdateCandidateStatus.mockResolvedValue(undefined);
    mockGetRunsByTask.mockResolvedValue([]);
    mockIntake.mockReset();
    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'diagnosis_test-pain-1',
      runId: 'run-retry-1',
      contextHash: 'abc123',
    });
  });

  it('passes effectiveConfig to all three runners when split pipeline is enabled', async () => {
    mockGetTask.mockResolvedValue(RETRY_WAIT_TASK);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    });

    expect(diagRootCauseRunnerCtor).toHaveBeenCalled();
    const rootOptions = diagRootCauseRunnerCtor.mock.calls[0]?.[1];
    expect(rootOptions?.effectiveConfig).toBeDefined();
    expect(rootOptions?.effectiveConfig).toEqual(
      expect.objectContaining({ config: expect.anything(), source: 'file' }),
    );

    const distillerOptions = diagDistillerRunnerCtor.mock.calls[0]?.[1];
    expect(distillerOptions?.effectiveConfig).toBeDefined();

    const routerOptions = diagRouterRunnerCtor.mock.calls[0]?.[1];
    expect(routerOptions?.effectiveConfig).toBeDefined();

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ── PRI-638: unified capability-disabled semantics ───────────────────────────
//
// On main, an Owner-disabled Diagnostician surfaced from `pd pain retry` as
// `missing_runtime` ("no .pd/config.yaml runtime binding found") — telling the
// Owner their config was broken when they had deliberately switched the agent
// off. The capability gate now runs BEFORE runtime resolution and reads the
// same canonical authority the runtime factory uses.

describe('PRI-638: pd pain retry when Diagnostician capability is disabled', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const runtimeV2 = await import('@principles/core/runtime-v2');
    vi.mocked(runtimeV2.resolveDiagnosticianCapability).mockReturnValue({
      available: false,
      reason: 'capability_disabled',
      message: "Agent 'diagnostician' is disabled",
      nextAction: "Enable agent 'diagnostician' in .pd/config.yaml internalAgents.agents.diagnostician.enabled",
    });
  });

  afterEach(async () => {
    const runtimeV2 = await import('@principles/core/runtime-v2');
    vi.mocked(runtimeV2.resolveDiagnosticianCapability).mockReset();
  });

  it('RETRY-638-01: --json refuses with capability_disabled, not missing_runtime', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'pain-638',
      workspace: '/tmp/fake-workspace',
      json: true,
    });

    const jsonCall = logSpy.mock.calls.find((call) => String(call[0]).trim().startsWith('{'));
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(String(jsonCall?.[0]));
    expect(parsed.reason).toBe('capability_disabled');
    expect(parsed.reason).not.toBe('missing_runtime');
    expect(parsed.nextAction).toContain('internalAgents.agents.diagnostician.enabled');
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('RETRY-638-02: capability gate fires before the runtime adapter is built', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'pain-638',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: false,
    });

    const out = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('capability_disabled');
    const runtimeV2 = await import('@principles/core/runtime-v2');
    expect(runtimeV2.TestDoubleRuntimeAdapter).not.toHaveBeenCalled();
    expect(runtimeV2.SplitDiagnosticianRunner).not.toHaveBeenCalled();

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
