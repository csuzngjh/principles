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

// PRI-934/935: the barrel mock must provide the new single-authority imports.
// recoverFailedTask defaults to null (nothing recovered → no mutation), which
// keeps pre-fix tests on their original path; each describe re-primes it after
// vi.clearAllMocks().
const { mockRecoverFailedTask, mockPersistPainDiagnosis } = vi.hoisted(() => {
  const mockRecoverFailedTask = vi.fn().mockResolvedValue(null);
  const mockPersistPainDiagnosis = vi.fn().mockResolvedValue(undefined);
  return { mockRecoverFailedTask, mockPersistPainDiagnosis };
});

const { MockPrincipleTreeLedgerAdapter } = vi.hoisted(() => {
  function MockPrincipleTreeLedgerAdapter(this: any) {
    return {};
  }
  MockPrincipleTreeLedgerAdapter.prototype = {};
  return { MockPrincipleTreeLedgerAdapter };
});

// PRI-935: capture PainSignalBridge constructor args so the dead-letter
// replay branch can be asserted to receive the persistence flag + emitter.
const { MockPainSignalBridge, painSignalBridgeCtorCalls } = vi.hoisted(() => {
  const painSignalBridgeCtorCalls: Record<string, unknown>[] = [];
  function MockPainSignalBridge(this: any, opts: Record<string, unknown>) {
    painSignalBridgeCtorCalls.push(opts);
    return {
      onPainDetected: vi.fn().mockResolvedValue({ status: 'succeeded', candidateIds: [], ledgerEntryIds: [] }),
    };
  }
  MockPainSignalBridge.prototype = {};
  return { MockPainSignalBridge, painSignalBridgeCtorCalls };
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
  // PRI-935: the dead-letter replay branch reads the full-pipeline seed mode;
  // default to the non-full-chain mode so replay seeds stay minimal.
  resolvePromptFullPipelineSeedMode: vi.fn().mockReturnValue(undefined),
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
    markRetried = vi.fn().mockReturnValue({ ok: true });
    constructor(_connection: unknown) {}
  }
  return { MockSqliteDeadLetterStore, mockDeadLetterGetByPainId };
});

vi.mock('@principles/core/runtime-v2', async (importOriginal) => {
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
    SqliteDeadLetterStore: MockSqliteDeadLetterStore,
    PainSignalBridge: MockPainSignalBridge,
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
    // PRI-917 v0.3.3: the Reuse Review Gate hook builder — undefined hook in
    // tests keeps the pre-v0.3.3 intake flow unless a test opts in.
    createReuseRecommendationHook: vi.fn(() => undefined),
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
    // PRI-934/935: recovery + ledger single authorities (see hoisted mocks).
    recoverFailedTask: mockRecoverFailedTask,
    persistPainDiagnosis: mockPersistPainDiagnosis,
    // Single rc-9 telemetry bridge (factory-owned); CLI sites receive a
    // no-op emitter from it.
    createBridgeTelemetryEventEmitter: vi.fn().mockReturnValue({ emitTelemetry: vi.fn() }),
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
    // PRI-934: default "nothing recovered" after clearAllMocks() (null = no
    // mutation), keeping pre-fix tests on their original path.
    mockRecoverFailedTask.mockResolvedValue(null);
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
    // PRI-934: null = nothing recovered, no mutation (post-clearAllMocks re-prime).
    mockRecoverFailedTask.mockResolvedValue(null);
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
    mockIntake.mockResolvedValue({ outcome: 'ledger_entry', written: true, entry: { id: 'ledger-1', title: 'Principle 1', status: 'probation' } });

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

  it('RETRY-06b (P2-4): parked candidate surfaces review guidance and is EXCLUDED from internalize nextAction', async () => {
    mockGetTask.mockResolvedValue(RETRY_WAIT_TASK);
    mockGetCandidatesByTaskId.mockResolvedValue([
      { candidateId: 'cand-ok', artifactId: 'art-1', taskId: 'diagnosis_test-pain-1', status: 'pending' },
      { candidateId: 'cand-parked', artifactId: 'art-2', taskId: 'diagnosis_test-pain-1', status: 'pending' },
    ]);
    mockIntake
      .mockResolvedValueOnce({ outcome: 'ledger_entry', written: true, entry: { id: 'ledger-ok', title: 'OK', status: 'probation' } })
      .mockResolvedValueOnce({
        outcome: 'refused',
        reason: 'reuse_pending_owner',
        candidateId: 'cand-parked',
        rawRecommendationKind: 'principle',
        message: 'suspected duplicate — parked for the Owner',
        reuseRecommendation: {
          status: 'recommended',
          recommendation: 'reuse',
          selectedPrincipleId: 'existing-p1',
          rationale: 'same experience',
          confidence: 0.9,
        },
      });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    });

    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.intake.candidates[1].status).toBe('review_required');
    expect(output.intake.candidates[1].reusedPrincipleId).toBe('existing-p1');
    expect(output.intake.candidates[1].nextAction).toContain('pd candidate review --candidate-id cand-parked --decide reuse|create');
    // The parked candidate is NOT told to internalize (P2-4).
    expect(output.nextAction).toContain('pd candidate internalize --candidate-id cand-ok');
    expect(output.nextAction).not.toContain('internalize --candidate-id cand-parked');
    expect(output.nextAction).toContain('pd candidate review');
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
    mockIntake.mockResolvedValue({ outcome: 'ledger_entry', written: true, entry: { id: 'ledger-1', title: 'Principle 1', status: 'probation' } });

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
    // PRI-934: default "nothing recovered" after clearAllMocks() (null = no
    // mutation), keeping pre-fix tests on their original path.
    mockRecoverFailedTask.mockResolvedValue(null);
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
    mockIntake.mockResolvedValue({ outcome: 'ledger_entry', written: true, entry: { id: 'ledger-1', title: 'Principle 1', status: 'probation' } });

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
    // PRI-934: null = nothing recovered, no mutation (post-clearAllMocks re-prime).
    mockRecoverFailedTask.mockResolvedValue(null);
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

// ── PRI-934: failed diagnostician family must be recovered before re-run ─────
//
// Before this fix, `pd pain retry` on a failed task died with lease_conflict
// (DefaultLeaseManager accepts pending/retry_wait only) and the exhausted
// split-pipeline stage tasks could not be re-pended by the runner either. The
// handler now resets the whole diagnostician family through the single
// recovery authority (recoverFailedTask, shared with the sweep service).

describe('PRI-934: pd pain retry — failed-task recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCandidatesByTaskId.mockResolvedValue([]);
    mockUpdateCandidateStatus.mockResolvedValue(undefined);
    mockGetRunsByTask.mockResolvedValue([]);
    mockIntake.mockReset();
    mockRecoverFailedTask.mockResolvedValue(null);
    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'diagnosis_test-pain-failed',
      runId: 'run-retry-1',
      contextHash: 'abc123',
    });
  });

  it('REC-01: failed parent → family reset (parent + 3 stages, force) BEFORE the runner executes', async () => {
    mockGetTask.mockResolvedValue(FAILED_TASK);
    mockRecoverFailedTask.mockImplementation(async (_sm: unknown, taskId: string) => ({
      taskId, previousStatus: 'failed', newStatus: 'pending',
      attemptCount: 0, maxAttempts: 6, forceApplied: true,
    }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-failed',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    });

    const family = mockRecoverFailedTask.mock.calls.map((call) => call[1]);
    expect(family).toEqual([
      'diagnosis_test-pain-failed',
      'diag_rootcause-diagnosis_test-pain-failed',
      'diag_distiller-diagnosis_test-pain-failed',
      'diag_router-diagnosis_test-pain-failed',
    ]);
    // force=true: an explicit pain retry IS the operator recovery decision
    // (stage tasks are typically budget-exhausted).
    for (const call of mockRecoverFailedTask.mock.calls) {
      expect(call[2]).toBe(true);
    }
    // Recovery precedes execution — otherwise the parent lease acquisition
    // fails on the still-failed status (the original dead end).
    expect(mockRecoverFailedTask.mock.invocationCallOrder[0])
      .toBeLessThan(mockRun.mock.invocationCallOrder[0]);

    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.status).toBe('succeeded');
    expect(output.recoveredTasks).toEqual([
      'diagnosis_test-pain-failed',
      'diag_rootcause-diagnosis_test-pain-failed',
      'diag_distiller-diagnosis_test-pain-failed',
      'diag_router-diagnosis_test-pain-failed',
    ]);
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('REC-02: retry_wait task with no failed stages → recovery attempted but nothing reset (cli-5)', async () => {
    mockGetTask.mockResolvedValue(RETRY_WAIT_TASK);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    });

    // The family is probed (recoverFailedTask is the status authority), but
    // every member is non-failed, so the mock's null default resets nothing.
    expect(mockRecoverFailedTask).toHaveBeenCalledTimes(4);
    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.recoveredTasks).toEqual([]);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('REC-05: retry_wait parent + failed stages → stages reset, parent untouched (CodeRabbit #1885)', async () => {
    mockGetTask.mockResolvedValue({ ...RETRY_WAIT_TASK, taskId: 'diagnosis_test-pain-rw', lastError: null });
    mockRecoverFailedTask.mockImplementation(async (_sm: unknown, taskId: string) => {
      if (taskId === 'diagnosis_test-pain-rw') return null; // retry_wait parent — authority no-ops
      return {
        taskId, previousStatus: 'failed', newStatus: 'pending',
        attemptCount: 0, maxAttempts: 6, forceApplied: true,
      };
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-rw',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    });

    const family = mockRecoverFailedTask.mock.calls.map((call) => call[1]);
    expect(family).toEqual([
      'diagnosis_test-pain-rw',
      'diag_rootcause-diagnosis_test-pain-rw',
      'diag_distiller-diagnosis_test-pain-rw',
      'diag_router-diagnosis_test-pain-rw',
    ]);
    expect(mockRecoverFailedTask.mock.invocationCallOrder[0])
      .toBeLessThan(mockRun.mock.invocationCallOrder[0]);

    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.status).toBe('succeeded');
    // Only the three failed stages are reported — the retry_wait parent is
    // not reset (recoverFailedTask returns null for non-failed statuses).
    expect(output.recoveredTasks).toEqual([
      'diag_rootcause-diagnosis_test-pain-rw',
      'diag_distiller-diagnosis_test-pain-rw',
      'diag_router-diagnosis_test-pain-rw',
    ]);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('REC-03: surviving lease_conflict → nextAction names the authoritative recovery tool (cli-6)', async () => {
    mockGetTask.mockResolvedValue(FAILED_TASK);
    mockRun.mockResolvedValueOnce({
      status: 'failed',
      taskId: 'diagnosis_test-pain-failed',
      errorCategory: 'lease_conflict',
      failureReason: 'Parent task lease acquisition failed',
      attemptCount: 1,
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-failed',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    });

    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.status).toBe('failed');
    expect(output.errorCategory).toBe('lease_conflict');
    // cli-1: failure branch carries the same recoveredTasks shape as success.
    expect(output.recoveredTasks).toEqual([]);
    expect(output.nextAction).toContain('pd runtime recovery failed-tasks');
    expect(output.nextAction).toContain('--confirm');
    expect(output.nextAction).toContain('pd pain retry --pain-id test-pain-failed');
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('REC-04: text mode lease_conflict also carries the recovery nextAction', async () => {
    mockGetTask.mockResolvedValue(FAILED_TASK);
    mockRun.mockResolvedValueOnce({
      status: 'failed',
      taskId: 'diagnosis_test-pain-failed',
      errorCategory: 'lease_conflict',
      failureReason: 'Parent task lease acquisition failed',
      attemptCount: 1,
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-failed',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: false,
    });

    const allOutput = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(allOutput).toContain('Next Action');
    expect(allOutput).toContain('pd runtime recovery failed-tasks');
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('REC-05b: text-mode FAILURE path still lists recovered tasks (review §3 regression)', async () => {
    mockGetTask.mockResolvedValue(FAILED_TASK);
    mockRecoverFailedTask.mockImplementation(async (_sm: unknown, taskId: string) => ({
      taskId, previousStatus: 'failed', newStatus: 'pending',
      attemptCount: 0, maxAttempts: 6, forceApplied: true,
    }));
    mockRun.mockResolvedValueOnce({
      status: 'failed',
      taskId: 'diagnosis_test-pain-failed',
      errorCategory: 'lease_conflict',
      failureReason: 'Stage lease acquisition failed',
      attemptCount: 1,
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-failed',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: false,
    });

    const allOutput = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(allOutput).toContain('Retry failed');
    // Operators need the recovery list exactly where the runner died.
    expect(allOutput).toContain('Recovered:');
    expect(allOutput).toContain('diag_router-diagnosis_test-pain-failed');
    // ...printed once, not duplicated (F1).
    expect(allOutput.match(/Recovered:/g)).toHaveLength(1);
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ── PRI-935: CLI retry path must dispatch the pain_diagnoses ledger write ────
//
// persistPainDiagnosis is the single ledger authority (bridge + CLI). The
// flag is derived from the same canonical computation the production factory
// uses; the dead-letter replay branch must pass it to the bridge like the
// factory does.

describe('PRI-935: pd pain retry — pain_diagnoses ledger dispatch', () => {
  const RETRY_SUCCESS_OUTPUT = {
    valid: true as const,
    diagnosisId: 'diag-935',
    summary: 'test diagnosis',
    rootCause: 'People: Agent retried without inspecting the lease state',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'tool_calls:1', note: 'test evidence' }],
    recommendations: [{ kind: 'defer' as const, description: 'no actionable principle' }],
    confidence: 0.7,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCandidatesByTaskId.mockResolvedValue([
      { candidateId: 'cand-1', artifactId: 'art-1', taskId: 'diagnosis_test-pain-1', status: 'pending' },
    ]);
    mockUpdateCandidateStatus.mockResolvedValue(undefined);
    mockGetRunsByTask.mockResolvedValue([]);
    mockIntake.mockReset();
    mockIntake.mockResolvedValue({ outcome: 'ledger_entry', written: true, entry: { id: 'ledger-1', title: 'P1', status: 'probation' } });
    mockRecoverFailedTask.mockResolvedValue(null);
    mockPersistPainDiagnosis.mockResolvedValue(undefined);
    painSignalBridgeCtorCalls.length = 0;
    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: 'diagnosis_test-pain-1',
      runId: 'run-retry-1',
      contextHash: 'abc123',
      output: RETRY_SUCCESS_OUTPUT,
    });
  });

  it('LEDGER-01: flag on + diagnosis output → persist dispatched before intake with the requested painId, JSON says attempted', async () => {
    mockGetTask.mockResolvedValue(RETRY_WAIT_TASK);
    const runtimeV2 = await import('@principles/core/runtime-v2');
    vi.mocked(runtimeV2.isFeatureEnabled).mockReturnValue(true);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    });

    expect(mockPersistPainDiagnosis).toHaveBeenCalledTimes(1);
    const [deps, opts] = mockPersistPainDiagnosis.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(opts.painId).toBe('test-pain-1');
    expect(opts.taskId).toBe('diagnosis_test-pain-1');
    expect(opts.artifactId).toBe('art-1');
    expect(deps.stateManager).toBeDefined();
    // persist-before-admission ordering (mirrors the bridge).
    expect(mockPersistPainDiagnosis.mock.invocationCallOrder[0]).toBeLessThan(mockIntake.mock.invocationCallOrder[0]);

    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.painDiagnosisLedgerWrite).toBe('attempted');
    // The handler must consult the canonical flag name, not a CLI-local one.
    expect(vi.mocked(runtimeV2.isFeatureEnabled).mock.calls.some((call) => call[1] === 'pain_diagnosis_persistence')).toBe(true);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('LEDGER-04: task.inputRef diverges from CLI painId → ledger uses canonical inputRef (rc-6)', async () => {
    mockGetTask.mockResolvedValue({ ...RETRY_WAIT_TASK, inputRef: 'pain-authoritative-9' });
    const runtimeV2 = await import('@principles/core/runtime-v2');
    vi.mocked(runtimeV2.isFeatureEnabled).mockReturnValue(true);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    });

    expect(mockPersistPainDiagnosis).toHaveBeenCalledTimes(1);
    const [, opts] = mockPersistPainDiagnosis.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    // The task record is the attribution authority, not the CLI argument.
    expect(opts.painId).toBe('pain-authoritative-9');

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('LEDGER-02: flag off (default) → no ledger dispatch, JSON says disabled', async () => {
    mockGetTask.mockResolvedValue(RETRY_WAIT_TASK);
    const runtimeV2 = await import('@principles/core/runtime-v2');
    vi.mocked(runtimeV2.isFeatureEnabled).mockReturnValue(false);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    });

    expect(mockPersistPainDiagnosis).not.toHaveBeenCalled();
    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.painDiagnosisLedgerWrite).toBe('disabled');

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('LEDGER-03: dead-letter replay bridge receives the flag + telemetry wiring like the factory', async () => {
    mockGetTask.mockResolvedValue(null);
    mockDeadLetterGetByPainId.mockReturnValue({
      id: 'dl-1',
      painId: 'test-pain-1',
      painData: {
        painId: 'test-pain-1',
        painType: 'tool_failure',
        source: 'openclaw',
        reason: 'tool call failed',
      },
      failedAt: '2026-09-27T00:00:00.000Z',
      retryCount: 0,
      retriedAt: null,
    });
    const runtimeV2 = await import('@principles/core/runtime-v2');
    vi.mocked(runtimeV2.isFeatureEnabled).mockReturnValue(true);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    });

    // The dead-letter branch constructs the bridge with the persistence flag
    // (previously absent → replays silently skipped the ledger).
    expect(painSignalBridgeCtorCalls.length).toBeGreaterThan(0);
    const bridgeOpts = painSignalBridgeCtorCalls[painSignalBridgeCtorCalls.length - 1];
    expect(bridgeOpts.diagnosisPersistenceEnabled).toBe(true);
    expect(bridgeOpts.eventEmitter).toBeDefined();

    const output = JSON.parse(logSpy.mock.calls.find((call) => {
      try { JSON.parse(call[0] as string); return true; } catch { return false; }
    })![0] as string);
    expect(output.source).toBe('dead_letter');
    // mvp-q-2: the dead-letter branch must also OBSERVE the ledger dispatch.
    expect(output.painDiagnosisLedgerWrite).toBe('attempted');

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('LEDGER-05: dead-letter JSON says disabled when the persistence flag is off', async () => {
    mockGetTask.mockResolvedValue(null);
    mockDeadLetterGetByPainId.mockReturnValue({
      id: 'dl-2',
      painId: 'test-pain-2',
      painData: {
        painId: 'test-pain-2',
        painType: 'tool_failure',
        source: 'openclaw',
        reason: 'tool call failed',
      },
      failedAt: '2026-09-27T00:00:00.000Z',
      retryCount: 0,
      retriedAt: null,
    });
    const runtimeV2 = await import('@principles/core/runtime-v2');
    vi.mocked(runtimeV2.isFeatureEnabled).mockReturnValue(false);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handlePainRetry({
      painId: 'test-pain-2',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    });

    const output = JSON.parse(logSpy.mock.calls.find((call) => {
      try { JSON.parse(call[0] as string); return true; } catch { return false; }
    })![0] as string);
    expect(output.source).toBe('dead_letter');
    expect(output.painDiagnosisLedgerWrite).toBe('disabled');

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
