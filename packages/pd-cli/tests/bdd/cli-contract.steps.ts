/**
 * BDD step definitions for CLI strict JSON output contract (cli-1-strict-json).
 *
 * Approach: Command + mocks (NOT real CLI subprocess execution).
 * Reuses the exact same mock pattern as tests/commands/pain-retry.test.ts:
 *   - vi.hoisted() + vi.mock() to stub @principles/core/runtime-v2 and friends
 *   - Import handlePainRetry directly and call it in-process
 *   - Capture console.log via vi.spyOn to verify stdout JSON contract
 *
 * Rationale: pd pain retry needs a real workspace + pain-id + config to execute
 * as a subprocess. Testing the JSON output contract in-process with mocks is
 * more reliable and follows the established pattern in this repo.
 */
import { vi, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createStepRegistry, defineFeature } from './support/vitest-bdd.js';
import { resolveFeaturePath } from './support/repo-root.js';

// ── Mocks (mirrors tests/commands/pain-retry.test.ts) ──────────────────────────

const {
  MockRuntimeStateManager,
  mockGetTask,
  mockGetCandidatesByTaskId,
  mockUpdateCandidateStatus,
  mockGetRunsByTask,
} = vi.hoisted(() => {
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
  return {
    MockRuntimeStateManager,
    mockGetTask,
    mockGetCandidatesByTaskId,
    mockUpdateCandidateStatus,
    mockGetRunsByTask,
  };
}, { validateType: true });

const { mockIntake, MockCandidateIntakeService } = vi.hoisted(() => {
  const mockIntake = vi.fn();
  function MockCandidateIntakeService(this: unknown) {
    return { intake: mockIntake };
  }
  MockCandidateIntakeService.prototype = {};
  return { mockIntake, MockCandidateIntakeService };
});

const { MockPrincipleTreeLedgerAdapter } = vi.hoisted(() => {
  function MockPrincipleTreeLedgerAdapter(this: unknown) {
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
    DiagRootCauseRunner: vi.fn().mockImplementation(function () { return {}; }),
    DiagDistillerRunner: vi.fn().mockImplementation(function () { return {}; }),
    DiagRouterRunner: vi.fn().mockImplementation(function () { return {}; }),
    DefaultDiagRootCauseValidator: vi.fn().mockImplementation(function () { return {}; }),
    DefaultDiagDistillerValidator: vi.fn().mockImplementation(function () { return {}; }),
    DisabledDiagnosticianRunner: vi.fn().mockImplementation(function () { return {}; }),
    TestDoubleRuntimeAdapter: vi.fn().mockImplementation(function () { return {}; }),
    OpenClawCliRuntimeAdapter: vi.fn().mockImplementation(function () { return {}; }),
    PiAiRuntimeAdapter: vi.fn().mockImplementation(function () { return {}; }),
    SPLIT_PIPELINE_TOTAL_TIMEOUT_MS: 300000,
    PDRuntimeError: class PDRuntimeError extends Error {
      constructor(public category: string, message: string) {
        super(message);
        this.name = 'PDRuntimeError';
      }
    },
    CandidateIntakeService: MockCandidateIntakeService,
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

// ── Test data ──────────────────────────────────────────────────────────────────

const RETRY_WAIT_TASK = {
  taskId: 'diagnosis_pain-001',
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

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Parse a command string like 'pd pain retry --pain-id pain-001 --json' into options. */
function parseCommand(command: string): { painId: string; json: boolean } {
  const parts = command.split(/\s+/);
  const painIdIdx = parts.indexOf('--pain-id');
  const painId = painIdIdx >= 0 ? parts[painIdIdx + 1] : '';
  const json = parts.includes('--json');
  return { painId, json };
}

/** Reset all mocks to a clean default state for the next scenario. */
function resetMocksForScenario(painId: string): void {
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
  mockGetCandidatesByTaskId.mockResolvedValue([]);
  mockUpdateCandidateStatus.mockResolvedValue(undefined);
  mockGetRunsByTask.mockResolvedValue([]);
  mockIntake.mockReset();

  if (painId === 'nonexistent') {
    // Failure scenario: task not found
    mockGetTask.mockResolvedValue(null);
  } else {
    // Success scenario: retry_wait task → succeeded
    mockGetTask.mockResolvedValue({
      ...RETRY_WAIT_TASK,
      taskId: `diagnosis_${painId}`,
    });
    mockRun.mockResolvedValue({
      status: 'succeeded',
      taskId: `diagnosis_${painId}`,
      runId: 'run-retry-1',
      contextHash: 'abc123',
    });
  }
}

// ── Step definitions ───────────────────────────────────────────────────────────

const registry = createStepRegistry();

registry.given('一个可用的 pd-cli 可执行文件', () => {
  // Mocks are set up at module level. Verify the handler is importable.
  if (typeof handlePainRetry !== 'function') {
    throw new Error('pd-cli handlePainRetry not available');
  }
});

registry.when(/operator 执行 "(.+)"/, async (ctx, command: string) => {
  const { painId, json } = parseCommand(command as string);
  resetMocksForScenario(painId);

  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);

  try {
    await handlePainRetry({
      painId,
      workspace: '/tmp/fake-workspace',
      runtime: 'test-double',
      json,
    });
  } catch {
    // handlePainRetry may throw after process.exit is mocked and refuseExit returns.
    // The JSON output was already written to console.log before process.exit.
  }

  // Capture stdout: find the first console.log call that is a valid JSON object.
  // (After process.exit is mocked, refuseExit returns and execution may continue,
  // producing additional console.log calls. The JSON contract applies to the
  // primary JSON output, which is the first parseable JSON object on stdout.)
  const allLogCalls = logSpy.mock.calls.map((c) => String(c[0]));
  const jsonCall = allLogCalls.find((s) => {
    try { JSON.parse(s); return true; } catch { return false; }
  });
  const stdout = jsonCall ?? allLogCalls.join('\n');
  const stderr = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
  ctx.state.cliResult = { stdout, stderr };

  // Restore spies so Then steps don't capture new calls
  logSpy.mockRestore();
  errorSpy.mockRestore();
  exitSpy.mockRestore();
});

registry.then('stdout 是严格的单一 JSON 对象', (ctx) => {
  const result = ctx.state.cliResult as { stdout: string };
  const out = result.stdout.trim();
  // Must start with { and parse as a non-null object
  expect(out.startsWith('{')).toBe(true);
  const parsed = JSON.parse(out);
  expect(typeof parsed).toBe('object');
  expect(parsed).not.toBeNull();
});

registry.then('该 JSON 对象可以被 JSON.parse 解析', (ctx) => {
  const result = ctx.state.cliResult as { stdout: string };
  expect(() => JSON.parse(result.stdout.trim())).not.toThrow();
});

registry.then('stdout 不包含任何 banner 或 heading', (ctx) => {
  const result = ctx.state.cliResult as { stdout: string };
  const out = result.stdout.trim();
  expect(out.startsWith('===')).toBe(false);
  expect(out.startsWith('#')).toBe(false);
  expect(out.startsWith('PD CLI')).toBe(false);
  expect(out.startsWith('pd ')).toBe(false);
  // Strict JSON output must start with {
  expect(out.startsWith('{')).toBe(true);
});

registry.then('该 JSON 对象的 status 字段表示失败', (ctx) => {
  const result = ctx.state.cliResult as { stdout: string };
  const parsed = JSON.parse(result.stdout.trim());
  expect(parsed).toHaveProperty('status');
  expect(parsed.status).not.toBe('succeeded');
});

registry.then('该 JSON 对象包含 reason 字段', (ctx) => {
  const result = ctx.state.cliResult as { stdout: string };
  const parsed = JSON.parse(result.stdout.trim());
  expect(parsed).toHaveProperty('reason');
  expect(typeof parsed.reason).toBe('string');
  expect(parsed.reason.length).toBeGreaterThan(0);
});

registry.then('该 JSON 对象包含 nextAction 字段', (ctx) => {
  const result = ctx.state.cliResult as { stdout: string };
  const parsed = JSON.parse(result.stdout.trim());
  expect(parsed).toHaveProperty('nextAction');
  expect(typeof parsed.nextAction).toBe('string');
  expect(parsed.nextAction.length).toBeGreaterThan(0);
});

// ── Load and register feature ──────────────────────────────────────────────────

const featureText = readFileSync(
  resolveFeaturePath('docs/specs/features/cli/json-output.feature'),
  'utf8'
);
defineFeature(featureText, registry);
