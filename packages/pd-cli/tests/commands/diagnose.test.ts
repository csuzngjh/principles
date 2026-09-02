import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { Command } from 'commander';

const { MockRuntimeStateManager, mockGetCandidatesByTaskId, mockUpdateCandidateStatus, mockCreateTask, mockGetTask } = vi.hoisted(() => {
  const mockGetCandidatesByTaskId = vi.fn().mockResolvedValue([]);
  const mockUpdateCandidateStatus = vi.fn().mockResolvedValue(undefined);
  const mockCreateTask = vi.fn().mockResolvedValue(undefined);
  const mockGetTask = vi.fn().mockResolvedValue({
    taskId: 'test-task-1',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    lastError: null,
  });

  class MockRuntimeStateManager {
    initialize = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    getTask = mockGetTask;
    createTask = mockCreateTask;
    getCandidatesByTaskId = mockGetCandidatesByTaskId;
    updateCandidateStatus = mockUpdateCandidateStatus;
    connection = {} as Record<string, unknown>;
    taskStore = {};
    runStore = {};
    piArtifactStore = {};
    getRetryPolicy = vi.fn().mockReturnValue({
      shouldRetry: () => true,
      calculateBackoff: () => 10,
    });
  }
  return { MockRuntimeStateManager, mockGetCandidatesByTaskId, mockUpdateCandidateStatus, mockCreateTask, mockGetTask };
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

const { mockResolveRuntimeFromPdConfig } = vi.hoisted(() => {
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
  return { mockResolveRuntimeFromPdConfig };
});

// BUG-1: capture runner constructor args to verify effectiveConfig wiring
const { diagRootCauseRunnerCtor, diagDistillerRunnerCtor, diagRouterRunnerCtor } = vi.hoisted(() => {
  const diagRootCauseRunnerCtor = vi.fn().mockImplementation(function () { return {}; });
  const diagDistillerRunnerCtor = vi.fn().mockImplementation(function () { return {}; });
  const diagRouterRunnerCtor = vi.fn().mockImplementation(function () { return {}; });
  return { diagRootCauseRunnerCtor, diagDistillerRunnerCtor, diagRouterRunnerCtor };
});

// BUG-2: capture buildDreamerSeedFromCandidate sourcePainId arg + mock resolver
const { buildDreamerSeedCalls, mockResolveSourcePainId } = vi.hoisted(() => {
  const buildDreamerSeedCalls: Array<{ candidateId: string; sourcePainId?: string }> = [];
  const mockResolveSourcePainId = vi.fn().mockResolvedValue('pain_test-source-1');
  return { buildDreamerSeedCalls, mockResolveSourcePainId };
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
    // PRI-503: admission gate mock — admit by default so existing diagnose/intake
    // tests keep their original flow. Tests that need to assert refusal behavior
    // can override this mock per-test.
    evaluateCandidateAdmissionFromRecord: vi.fn().mockReturnValue({
      decision: 'admitted',
      reason: 'mock_admitted',
      nextAction: 'none',
      evidenceStatus: 'unknown',
    }),
    resolveRuntimeConfig: vi.fn().mockReturnValue({
      runtimeKind: 'pi-ai',
      provider: 'test-provider',
      model: 'test-model',
      apiKeyEnv: 'TEST_KEY',
      timeoutMs: 300000,
      agentId: 'main',
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
        valid: true,
        diagnosisId: 'diag-123',
        taskId: 'test-task-1',
        summary: 'Test diagnosis summary',
        rootCause: 'Test: test root cause',
        violatedPrinciples: [],
        evidence: [],
        recommendations: [{ kind: 'implementation', description: 'Test recommendation' }],
        confidence: 0.9,
      },
    }),
    status: vi.fn(),
    PrincipleTreeLedgerAdapter: MockPrincipleTreeLedgerAdapter,
    // Defect-004 dreamer seed mocks — minimal stubs that mirror real behavior
    // BUG-2: capture sourcePainId arg to verify lineage wiring
    buildDreamerSeedFromCandidate: vi.fn().mockImplementation((candidate: { candidateId: string }, opts: { route: string; ready: boolean; sourcePainId?: string }) => {
      buildDreamerSeedCalls.push({ candidateId: candidate.candidateId, sourcePainId: opts?.sourcePainId });
      return {
        taskId: `dreamer-${candidate.candidateId}`,
        taskKind: 'dreamer' as const,
        channel: 'prompt' as const,
        diagnosticJson: JSON.stringify({ candidateId: candidate.candidateId }),
        status: 'pending' as const,
        attemptCount: 0,
        maxAttempts: 3,
      };
    }),
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
}));

vi.mock('../../src/services/resolve-runtime-from-pd-config.js', () => ({
  resolveRuntimeFromPdConfig: mockResolveRuntimeFromPdConfig,
}));

// BUG-2: mock resolveSourcePainIdFromDiagnostician imported by diagnose.ts from candidate.js
vi.mock('../../src/commands/candidate.js', () => ({
  resolveSourcePainIdFromDiagnostician: mockResolveSourcePainId,
}));

import { handleDiagnoseRun, handleDiagnoseStatus, type DiagnoseRunOptions } from '../../src/commands/diagnose.js';

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

// ERR-067: reset the mocked run() to a clean successful default after each test
// so later tests don't see leftover mockResolvedValueOnce() chains or call counts.
const DEFAULT_SUCCEEDED_RUN_RESULT = {
  status: 'succeeded' as const,
  taskId: 'test-task-1',
  output: SUCCEEDED_RESULT.output,
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

  it('HG-03: --runtime openclaw-cli without mode (no file config) fails via resolveRuntimeFromPdConfig', async () => {
    mockResolveRuntimeFromPdConfig.mockReturnValueOnce({
      result: {
        ok: false,
        reason: 'missing_openclaw_mode',
        message: 'runtimeKind is openclaw-cli but no mode specified',
        nextAction: 'Provide exactly one mode',
      },
      legacyWarnings: [],
      configSource: '.pd/config.yaml',
      configLoadResult: { ok: true, effective: {}, defaults: {}, legacyFilesDetected: [] },
    });

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'openclaw-cli',
      json: false,
    } as DiagnoseRunOptions);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('no mode resolved'));
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

  it('DPB-09: openclaw-cli flag overrides file config mode (config=gateway, flag=local → runtimeMode=local)', async () => {
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

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'openclaw-cli',
      openclawLocal: true,
      json: false,
    } as DiagnoseRunOptions);

    // Flag override: config says gateway, flag says local → adapter gets local
    const OpenClawCliMock = vi.mocked(
      await import('@principles/core/runtime-v2').then(m => m.OpenClawCliRuntimeAdapter),
    );
    expect(OpenClawCliMock).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeMode: 'local' }),
    );
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('DPB-09: openclaw-cli missing mode (--json) outputs JSON error', async () => {
    mockResolveRuntimeFromPdConfig.mockReturnValueOnce({
      result: {
        runtimeKind: 'openclaw-cli',
        openclawMode: undefined,
        timeoutMs: 300000,
        agentId: 'main',
      },
      legacyWarnings: [],
      configSource: '.pd/config.yaml',
      configLoadResult: { ok: true, effective: {}, defaults: {}, legacyFilesDetected: [] },
    });

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
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'invalid-runtime',
      json: true,
    } as DiagnoseRunOptions);

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(jsonOutput.ok).toBe(false);
    expect(jsonOutput.reason).toBe('unsupported_runtime_kind: invalid-runtime');
    expect(jsonOutput.nextAction).toContain('openclaw-cli');
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleLogSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('P1: missing --runtime with no config binding refuses with missing_runtime (no test-double default)', async () => {
    // Regression for the silent test-double default bug. Without --runtime and
    // with no usable .pd/config.yaml binding, the command must refuse loudly
    // (rc-9-no-silent-fallback) instead of defaulting to test-double and
    // producing fake/failed diagnostic data in a real workspace.
    mockResolveRuntimeFromPdConfig.mockReturnValueOnce({
      result: { ok: false, reason: 'no_runtime_binding', message: 'no binding', nextAction: 'set runtime' },
      legacyWarnings: [],
      configSource: '.pd/config.yaml',
      configLoadResult: { ok: true, effective: {}, defaults: {}, legacyFilesDetected: [] } as never,
    });
    mockIsRuntimeConfigError.mockReturnValueOnce(true);

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      // runtime intentionally omitted
      json: true,
    } as DiagnoseRunOptions);

    // Config was consulted (not silently skipped).
    expect(mockResolveRuntimeFromPdConfig).toHaveBeenCalledWith('/tmp/fake-workspace');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(jsonOutput.ok).toBe(false);
    expect(jsonOutput.reason).toBe('missing_runtime');
    expect(jsonOutput.nextAction).toContain('--runtime');

    consoleLogSpy.mockRestore();
    consoleErrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('P1: missing --runtime resolves kind from .pd/config.yaml (honors config, no test-double default)', async () => {
    // When --runtime is absent but .pd/config.yaml binds openclaw-cli, the
    // resolved kind must come from config — proving test-double is no longer
    // the default. Mirrors DPB-09 but omits --runtime to exercise the new
    // config-resolution path.
    mockResolveRuntimeFromPdConfig.mockReturnValueOnce({
      result: {
        runtimeKind: 'openclaw-cli',
        openclawMode: 'gateway',
        timeoutMs: 300000,
        agentId: 'main',
      },
      legacyWarnings: [],
      configSource: '.pd/config.yaml',
      configLoadResult: { ok: true, effective: {}, defaults: {}, legacyFilesDetected: [] } as never,
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      // runtime intentionally omitted — must be resolved from config
      openclawGateway: true,
      json: false,
    } as DiagnoseRunOptions);

    expect(mockResolveRuntimeFromPdConfig).toHaveBeenCalledWith('/tmp/fake-workspace');
    const OpenClawCliMock = vi.mocked(
      await import('@principles/core/runtime-v2').then(m => m.OpenClawCliRuntimeAdapter),
    );
    expect(OpenClawCliMock).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeMode: 'gateway' }),
    );
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('DPB-09: openclaw-cli --openclaw-gateway constructs adapter with runtimeMode=gateway', async () => {
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

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'openclaw-cli',
      openclawGateway: true,
      json: false,
    } as DiagnoseRunOptions);

    const OpenClawCliMock = vi.mocked(
      await import('@principles/core/runtime-v2').then(m => m.OpenClawCliRuntimeAdapter),
    );
    expect(OpenClawCliMock).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeMode: 'gateway' }),
    );
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('DPB-09: openclaw-cli --openclaw-local constructs adapter with runtimeMode=local', async () => {
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

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'openclaw-cli',
      openclawLocal: true,
      json: false,
    } as DiagnoseRunOptions);

    const OpenClawCliMock = vi.mocked(
      await import('@principles/core/runtime-v2').then(m => m.OpenClawCliRuntimeAdapter),
    );
    expect(OpenClawCliMock).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeMode: 'local' }),
    );
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
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

describe('pd status stalled-threshold validation', () => {
  it('accepts valid positive integers', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const runtimeV2 = await import('@principles/core/runtime-v2');
    vi.mocked(runtimeV2.status).mockResolvedValueOnce({
      taskId: 'test-task-1',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      lastError: null,
      commitId: null,
      artifactId: null,
      candidateCount: null,
    });

    await handleDiagnoseStatus({
      taskId: 'test-task-1',
      stalledThreshold: '123',
    });

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('rejects invalid inputs (0, negative, decimals, NaN, empty)', async () => {
    const invalidInputs = ['0', '-10', '1.5', 'abc', 'NaN', ''];
    for (const input of invalidInputs) {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await handleDiagnoseStatus({
        taskId: 'test-task-1',
        stalledThreshold: input,
      });

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('positive integer'));

      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it('rejects invalid inputs in JSON mode', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleDiagnoseStatus({
      taskId: 'test-task-1',
      stalledThreshold: '0',
      json: true,
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleSpy).toHaveBeenCalled();
    const output = JSON.parse((consoleSpy.mock.calls[0] as string[])[0]);
    expect(output.ok).toBe(false);
    expect(output.reason).toBe('invalid_stalled_threshold');
    expect(output.nextAction).toContain('positive integer');

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

// ERR-067: 1 initial run + maxRetryLoops(10) before the safety limit converts retried to failed.
const EXPECTED_MAX_RETRY_CALLS = 11;

describe('ERR-067: pd diagnose run retry loop for retried status', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { run } = await import('@principles/core/runtime-v2');
    vi.mocked(run).mockResolvedValue(DEFAULT_SUCCEEDED_RUN_RESULT);
  });

  afterEach(async () => {
    const { run } = await import('@principles/core/runtime-v2');
    vi.mocked(run).mockResolvedValue(DEFAULT_SUCCEEDED_RUN_RESULT);
  });

  it('ERR-067-01: retried status triggers retry loop, succeeds on second attempt', async () => {
    const { run } = await import('@principles/core/runtime-v2');
    const runMock = vi.mocked(run);
    runMock
      .mockResolvedValueOnce({
        status: 'retried' as const,
        taskId: 'test-task-1',
        attemptCount: 1,
      })
      .mockResolvedValueOnce(SUCCEEDED_RESULT);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: false,
    } as DiagnoseRunOptions);

    expect(runMock).toHaveBeenCalledTimes(2);
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
    runMock.mockResolvedValue(DEFAULT_SUCCEEDED_RUN_RESULT);
  });

  it('ERR-067-02: retried status loops until maxRetryLoops, then converts to failed (P0-1 fix)', async () => {
    const { run } = await import('@principles/core/runtime-v2');
    const runMock = vi.mocked(run);
    runMock.mockResolvedValue({
      status: 'retried' as const,
      taskId: 'test-task-1',
      attemptCount: 1,
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: false,
    } as DiagnoseRunOptions);

    expect(runMock).toHaveBeenCalledTimes(EXPECTED_MAX_RETRY_CALLS);
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
    runMock.mockResolvedValue(DEFAULT_SUCCEEDED_RUN_RESULT);
  });

  it('ERR-067-03: retried with failureReason propagates to failed status (P0-1 fix)', async () => {
    const { run } = await import('@principles/core/runtime-v2');
    const runMock = vi.mocked(run);
    runMock.mockResolvedValue({
      status: 'retried' as const,
      taskId: 'test-task-1',
      attemptCount: 1,
      failureReason: 'Schema validation failed',
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    expect(runMock).toHaveBeenCalledTimes(EXPECTED_MAX_RETRY_CALLS);

    const jsonOutput = consoleSpy.mock.calls.find(call => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.status === 'failed';
      } catch { return false; }
    });
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse((jsonOutput as [string])[0]);
    expect(parsed.status).toBe('failed');
    expect(parsed.failureReason).toContain('Max retry loops');
    expect(parsed.failureReason).toContain('Schema validation failed');

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
    runMock.mockResolvedValue(DEFAULT_SUCCEEDED_RUN_RESULT);
  });

  it('ERR-067-04: succeeded status does NOT trigger retry loop', async () => {
    const { run } = await import('@principles/core/runtime-v2');
    const runMock = vi.mocked(run);
    runMock.mockResolvedValue(SUCCEEDED_RESULT);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: false,
    } as DiagnoseRunOptions);

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
    runMock.mockResolvedValue(DEFAULT_SUCCEEDED_RUN_RESULT);
  });

  it('ERR-067-05: failed status does NOT trigger retry loop', async () => {
    const { run } = await import('@principles/core/runtime-v2');
    const runMock = vi.mocked(run);
    runMock.mockResolvedValue({
      status: 'failed' as const,
      taskId: 'test-task-1',
      attemptCount: 3,
      failureReason: 'Max attempts exceeded',
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: false,
    } as DiagnoseRunOptions);

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
    runMock.mockResolvedValue(DEFAULT_SUCCEEDED_RUN_RESULT);
  });
});

// Defect-004 Part 2: dreamer seed after intake
describe('Defect-004: pd diagnose run — dreamer seed after intake', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { run } = await import('@principles/core/runtime-v2');
    vi.mocked(run).mockResolvedValue(SUCCEEDED_RESULT);
    mockGetCandidatesByTaskId.mockResolvedValue([]);
    mockUpdateCandidateStatus.mockResolvedValue(undefined);
    mockCreateTask.mockResolvedValue(undefined);
    // For dreamer seed tests, getTask should return null (dreamer task doesn't exist yet)
    // so createTask gets called. Individual tests can override this if needed.
    mockGetTask.mockResolvedValue(null);
    mockIntake.mockReset();
    mockIntake.mockResolvedValue({ id: 'ledger-1', title: 'P1', status: 'probation' });
  });

  it('DREAMER-01: principle candidate — dreamer task created via createTask', async () => {
    const candidates = [
      { candidateId: 'cand-1', artifactId: 'art-1', taskId: 'test-task-1', status: 'pending', recommendationKind: 'principle' },
    ];
    mockGetCandidatesByTaskId.mockResolvedValue(candidates);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    // Verify createTask was called for the dreamer task
    expect(mockCreateTask).toHaveBeenCalled();
    const createCall = mockCreateTask.mock.calls[0]?.[0];
    expect(createCall?.taskKind).toBe('dreamer');
    expect(createCall?.taskId).toBe('dreamer-cand-1');
    expect(createCall?.status).toBe('pending');

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('DREAMER-02: defer candidate — no dreamer task created', async () => {
    const candidates = [
      { candidateId: 'cand-defer', artifactId: 'art-1', taskId: 'test-task-1', status: 'pending', recommendationKind: 'defer' },
    ];
    mockGetCandidatesByTaskId.mockResolvedValue(candidates);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    // No dreamer task should be created for defer candidates
    expect(mockCreateTask).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('DREAMER-03: implementation candidate — no dreamer task created', async () => {
    const candidates = [
      { candidateId: 'cand-impl', artifactId: 'art-1', taskId: 'test-task-1', status: 'pending', recommendationKind: 'implementation' },
    ];
    mockGetCandidatesByTaskId.mockResolvedValue(candidates);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    // No dreamer task should be created for implementation candidates
    expect(mockCreateTask).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('DREAMER-04: --no-intake skips dreamer seed', async () => {
    const candidates = [
      { candidateId: 'cand-1', artifactId: 'art-1', taskId: 'test-task-1', status: 'pending', recommendationKind: 'principle' },
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

    // No dreamer task should be created when intake is disabled
    expect(mockCreateTask).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('DREAMER-05: dreamer seed failure surfaces in intake results but does not fail the command', async () => {
    const candidates = [
      { candidateId: 'cand-1', artifactId: 'art-1', taskId: 'test-task-1', status: 'pending', recommendationKind: 'principle' },
    ];
    mockGetCandidatesByTaskId.mockResolvedValue(candidates);
    // Make createTask throw to simulate seed failure
    mockCreateTask.mockRejectedValueOnce(new Error('DB write failed'));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    // Command should still succeed (exit 0) — dreamer seed failure is best-effort
    expect(exitSpy).not.toHaveBeenCalledWith(1);

    // JSON output should include dreamer_seed_failed status
    const jsonOutput = consoleSpy.mock.calls.find(call => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.intake && Array.isArray(parsed.intake.candidates);
      } catch { return false; }
    });
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse((jsonOutput as [string])[0]);
    const seedResult = parsed.intake.candidates.find((c: { candidateId: string; status: string }) => c.candidateId === 'cand-1' && c.status === 'dreamer_seed_failed');
    expect(seedResult).toBeDefined();
    expect(seedResult.error).toContain('DB write failed');

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// DEFECT-005 (PRI-514): A single defer candidate's intake_failed must NOT poison
// the dreamer seed loop for other successfully-consumed candidates. Previously
// `intakeFailed` was a global flag gating the ENTIRE dreamer seed loop — one
// defer candidate (admission gate deferred) set it true, skipping dreamer seed
// for ALL candidates including ones that succeeded intake (EP-03 / ERR-089
// sibling-branch defect: one branch's failure punished all sibling branches).
describe('DEFECT-005 (PRI-514): defer intake_failed must not poison other candidates dreamer seed', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { run, evaluateCandidateAdmissionFromRecord } = await import('@principles/core/runtime-v2');
    vi.mocked(run).mockResolvedValue(SUCCEEDED_RESULT);
    mockGetCandidatesByTaskId.mockResolvedValue([]);
    mockUpdateCandidateStatus.mockResolvedValue(undefined);
    mockCreateTask.mockResolvedValue(undefined);
    mockGetTask.mockResolvedValue(null);
    mockIntake.mockReset();
    mockIntake.mockResolvedValue({ id: 'ledger-1', title: 'P1', status: 'probation' });
    // Default: admit all candidates. Individual tests override for defer.
    vi.mocked(evaluateCandidateAdmissionFromRecord).mockReturnValue({
      decision: 'admitted',
      reason: 'mock_admitted',
      nextAction: 'none',
      evidenceStatus: 'unknown',
    });
  });

  // Restore the factory-default admission decision so later describe blocks
  // (which do `vi.clearAllMocks()` but do not re-set the implementation) see
  // `admitted` again. Without this, a `mockReturnValue({deferred})` from
  // DEFECT-005-B would leak into BUG-2 and refuse all its candidates.
  afterEach(async () => {
    const { evaluateCandidateAdmissionFromRecord } = await import('@principles/core/runtime-v2');
    vi.mocked(evaluateCandidateAdmissionFromRecord).mockReturnValue({
      decision: 'admitted',
      reason: 'mock_admitted',
      nextAction: 'none',
      evidenceStatus: 'unknown',
    });
  });

  it('DEFECT-005-A: defer deferred + principle/rule/prompt consumed — principle/rule/prompt still dreamer_seeded', async () => {
    // Admission gate defers ONLY defer candidates; admits everything else.
    const { evaluateCandidateAdmissionFromRecord } = await import('@principles/core/runtime-v2');
    vi.mocked(evaluateCandidateAdmissionFromRecord).mockImplementation((record) => {
      if (record.recommendationKind === 'defer') {
        return {
          decision: 'deferred',
          reason: 'recommendation_kind_defer_not_actionable',
          nextAction: 'review_defer_disposition_manually',
          evidenceStatus: 'unknown',
        };
      }
      return {
        decision: 'admitted',
        reason: 'mock_admitted',
        nextAction: 'none',
        evidenceStatus: 'unknown',
      };
    });

    const candidates = [
      { candidateId: 'cand-defer', artifactId: 'art-d', taskId: 'test-task-1', status: 'pending', recommendationKind: 'defer', confidence: 0.9 },
      { candidateId: 'cand-principle', artifactId: 'art-p', taskId: 'test-task-1', status: 'pending', recommendationKind: 'principle', confidence: 0.9 },
      { candidateId: 'cand-rule', artifactId: 'art-r', taskId: 'test-task-1', status: 'pending', recommendationKind: 'rule', confidence: 0.9 },
      { candidateId: 'cand-prompt', artifactId: 'art-pp', taskId: 'test-task-1', status: 'pending', recommendationKind: 'prompt', confidence: 0.9 },
      { candidateId: 'cand-impl', artifactId: 'art-i', taskId: 'test-task-1', status: 'pending', recommendationKind: 'implementation', confidence: 0.9 },
    ];
    mockGetCandidatesByTaskId.mockResolvedValue(candidates);

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
    const results = parsed.intake.candidates as Array<{ candidateId: string; status: string }>;

    // defer candidate: intake_failed (admission gate deferred) — correct.
    // intakeResults may carry multiple entries per candidate (intake + seed),
    // so we match on BOTH candidateId and status (same pattern as DREAMER-05).
    const deferFailed = results.find(r => r.candidateId === 'cand-defer' && r.status === 'intake_failed');
    expect(deferFailed).toBeDefined();

    // principle/rule/prompt: dreamer_seeded — MUST NOT be poisoned by defer's intake_failed
    const principleSeeded = results.find(r => r.candidateId === 'cand-principle' && r.status === 'dreamer_seeded');
    expect(principleSeeded).toBeDefined();

    const ruleSeeded = results.find(r => r.candidateId === 'cand-rule' && r.status === 'dreamer_seeded');
    expect(ruleSeeded).toBeDefined();

    const promptSeeded = results.find(r => r.candidateId === 'cand-prompt' && r.status === 'dreamer_seeded');
    expect(promptSeeded).toBeDefined();

    // 3 dreamer tasks created (principle + rule + prompt).
    // defer was refused at the gate (no intake, no seed).
    // implementation is skipped by the dreamer seed loop (`if kind === 'implementation' continue`).
    expect(mockCreateTask).toHaveBeenCalledTimes(3);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('DEFECT-005-B: all candidates intake_failed — 0 dreamer_seeded (boundary)', async () => {
    // Refuse everything via admission gate
    const { evaluateCandidateAdmissionFromRecord } = await import('@principles/core/runtime-v2');
    vi.mocked(evaluateCandidateAdmissionFromRecord).mockReturnValue({
      decision: 'deferred',
      reason: 'mock_deferred',
      nextAction: 'none',
      evidenceStatus: 'unknown',
    });

    const candidates = [
      { candidateId: 'cand-1', artifactId: 'art-1', taskId: 'test-task-1', status: 'pending', recommendationKind: 'principle', confidence: 0.9 },
      { candidateId: 'cand-2', artifactId: 'art-2', taskId: 'test-task-1', status: 'pending', recommendationKind: 'rule', confidence: 0.9 },
    ];
    mockGetCandidatesByTaskId.mockResolvedValue(candidates);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    // No dreamer tasks should be created when no candidate was consumed
    expect(mockCreateTask).not.toHaveBeenCalled();

    const jsonOutput = consoleSpy.mock.calls.find(call => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.intake && Array.isArray(parsed.intake.candidates);
      } catch { return false; }
    });
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse((jsonOutput as [string])[0]);
    const results = parsed.intake.candidates as Array<{ candidateId: string; status: string }>;
    expect(results.every(r => r.status === 'intake_failed')).toBe(true);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// BUG-1 (PRI-442): effectiveConfig must be passed to split-pipeline runners
// so that ADR-0019 LLM rate-limit degradation (isDegradationEnabled) can fire.
// Without this wiring, isDegradationEnabled() always returns false because
// this.config.effectiveConfig is undefined. EP-02: production path wiring.
describe('BUG-1 (PRI-442): effectiveConfig wiring to split-pipeline runners', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { run } = await import('@principles/core/runtime-v2');
    vi.mocked(run).mockResolvedValue(SUCCEEDED_RESULT);
    mockGetCandidatesByTaskId.mockResolvedValue([]);
    mockUpdateCandidateStatus.mockResolvedValue(undefined);
    mockIntake.mockReset();
  });

  it('passes effectiveConfig to DiagRootCauseRunner when split pipeline is enabled', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    expect(diagRootCauseRunnerCtor).toHaveBeenCalled();
    const optionsArg = diagRootCauseRunnerCtor.mock.calls[0]?.[1];
    expect(optionsArg?.effectiveConfig).toBeDefined();
    expect(optionsArg?.effectiveConfig).toEqual(
      expect.objectContaining({ config: expect.anything(), source: 'file' }),
    );

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('passes effectiveConfig to DiagDistillerRunner and DiagRouterRunner', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    const distillerOptions = diagDistillerRunnerCtor.mock.calls[0]?.[1];
    expect(distillerOptions?.effectiveConfig).toBeDefined();

    const routerOptions = diagRouterRunnerCtor.mock.calls[0]?.[1];
    expect(routerOptions?.effectiveConfig).toBeDefined();

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // CR-2 (CodeRabbit P2): loadPdConfig mock only covered ok:true. The
  // ok:false fallback branch (effectiveConfig = defaults) was untested.
  // This test locks in the fallback behavior + asserts rc-9 observability.
  it('warns and falls back to defaults when configLoadResult.ok is false', async () => {
    // Override the module-level mock for this test only
    const { loadPdConfig } = await import('../../src/services/pd-config-loader.js');
    vi.mocked(loadPdConfig).mockReturnValueOnce({
      ok: false,
      source: 'malformed',
      configPath: '/tmp/fake-workspace/.pd/config.yaml',
      errors: [
        { path: 'featureFlags.diagnostician_llm_degradation', reason: 'expected boolean, got string', nextAction: 'Fix the value to be a boolean' },
      ],
      defaults: { config: {}, source: 'defaults', warnings: [] },
      warnings: [],
      legacyFilesDetected: [],
      legacyFileNextActions: [],
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    // Assert warning was emitted (rc-9: no silent fallback)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[pd diagnose]'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('malformed'),
    );

    // Assert runners still received effectiveConfig (the defaults-based one)
    expect(diagRootCauseRunnerCtor).toHaveBeenCalled();
    const optionsArg = diagRootCauseRunnerCtor.mock.calls[0]?.[1];
    expect(optionsArg?.effectiveConfig).toBeDefined();
    expect(optionsArg?.effectiveConfig).toEqual(
      expect.objectContaining({ source: 'defaults' }),
    );

    warnSpy.mockRestore();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// BUG-2 (PRI-442): sourcePainId must be resolved from the diagnostician task
// chain and passed to buildDreamerSeedFromCandidate. Without this, the dreamer
// task's diagnosticJson omits sourcePainId, breaking run-rulehost lineage.
// rc-6: lineage consistency. ERR-004: never invent lineage.
describe('BUG-2 (PRI-442): sourcePainId resolution for dreamer seed', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    buildDreamerSeedCalls.length = 0;
    const { run } = await import('@principles/core/runtime-v2');
    vi.mocked(run).mockResolvedValue(SUCCEEDED_RESULT);
    mockGetCandidatesByTaskId.mockResolvedValue([]);
    mockUpdateCandidateStatus.mockResolvedValue(undefined);
    mockCreateTask.mockResolvedValue(undefined);
    mockGetTask.mockResolvedValue(null);
    mockIntake.mockReset();
    mockIntake.mockResolvedValue({ id: 'ledger-1', title: 'P1', status: 'probation' });
    mockResolveSourcePainId.mockResolvedValue('pain_test-source-1');
  });

  it('passes resolved sourcePainId to buildDreamerSeedFromCandidate (lineage consistency)', async () => {
    const candidates = [
      { candidateId: 'cand-1', artifactId: 'art-1', taskId: 'test-task-1', status: 'pending', recommendationKind: 'principle' },
    ];
    mockGetCandidatesByTaskId.mockResolvedValue(candidates);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'test-task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    // resolveSourcePainIdFromDiagnostician should have been called
    expect(mockResolveSourcePainId).toHaveBeenCalled();
    // buildDreamerSeedFromCandidate should have received the resolved sourcePainId
    expect(buildDreamerSeedCalls.length).toBeGreaterThan(0);
    expect(buildDreamerSeedCalls[0].sourcePainId).toBe('pain_test-source-1');

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ── PRI-638: unified capability-disabled semantics ───────────────────────────
//
// The CLI owns no kill switch of its own: it reads the canonical authority
// (internalAgents.agents.diagnostician.enabled) through the same resolver the
// runtime factory uses. Owner-disabled must come out as a structured
// `capability_disabled` result — never as missing_runtime / config failure —
// with no adapter constructed and no provider contacted.

describe('PRI-638: pd diagnose run when Diagnostician capability is disabled', () => {
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

  it('DIAG-638-01: --json emits a structured capability_disabled result and exits 1', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'diag_task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: true,
    } as DiagnoseRunOptions);

    const jsonLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.trim().startsWith('{'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine as string);
    expect(parsed.reason).toBe('capability_disabled');
    expect(parsed.nextAction).toContain('internalAgents.agents.diagnostician.enabled');
    expect(parsed.message).toContain('disabled');

    // Kill switch fires before any runtime machinery: no adapter, no runner.
    const runtimeV2 = await import('@principles/core/runtime-v2');
    expect(runtimeV2.TestDoubleRuntimeAdapter).not.toHaveBeenCalled();
    expect(runtimeV2.SplitDiagnosticianRunner).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('DIAG-638-02: human-readable output names the reason and the recovery action', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

    await handleDiagnoseRun({
      taskId: 'diag_task-1',
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json: false,
    } as DiagnoseRunOptions);

    const out = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('diagnostician');
    expect(out).toContain('capability_disabled');
    expect(out).toContain('internalAgents.agents.diagnostician.enabled');

    const runtimeV2b = await import('@principles/core/runtime-v2');
    expect(runtimeV2b.TestDoubleRuntimeAdapter).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
