/**
 * ADR-0019: Diagnostician LLM rate-limit graceful degradation tests.
 *
 * Verifies the three acceptance criteria from ADR-0019 §4 (MVP Three Questions):
 *   1. Rate-limit regex classifies error signatures correctly (rate_limit, not execution_failed)
 *   2. Flag off / no effectiveConfig → rate_limit flows to max_attempts_exceeded (legacy behavior)
 *   3. Flag on → rate_limit degrades with markTaskFailed('rate_limit') + diag_llm_rate_limit_degraded
 *      telemetry carrying nextAction (rc-9: no silent fallback)
 *
 * Also verifies:
 *   4. Non-rate_limit errors are NOT degraded (e.g. execution_failed → normal path)
 *   5. Permanent errors still bypass degradation (e.g. storage_unavailable)
 *
 * ERR entries considered:
 *   - ERR-002 / EP-03: catch-and-degrade must emit reason + nextAction (not silent)
 *   - ERR-015 / EP-05: each retry attempt reads fresh error state (regex re-evaluated)
 *   - rc-9: degradation path includes observable telemetry with nextAction
 *
 * @see docs/adr/0019-diagnostician-llm-rate-limit-degradation.md
 * @see packages/principles-core/src/runtime-v2/runner/base-peer-runner.ts (retryOrFail, isDegradationEnabled)
 * @see packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts (completeWithRetry regex)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BasePeerRunner } from '../base-peer-runner.js';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle } from '../../runtime-protocol.js';
import type { StoreEventEmitter } from '../../store/event-emitter.js';
import type { PIArtifactStore } from '../../internalization/pi-artifact.js';
import type { TaskRecord } from '../../task-status.js';
import type { PDErrorCategory } from '../../error-categories.js';
import type { EffectivePdConfig } from '../../config/pd-config-types.js';
import { getDefaultPdConfig } from '../../config/pd-config-defaults.js';
import { resolveProfile } from '../../config/pd-profile-constants.js';
import type {
  PeerRunnerDeps,
  PeerRunnerResult,
  PeerRunnerValidationResult,
  FailureContext,
} from '../peer-runner-types.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────

interface TestContext {
  contextHash: string;
}

interface TestOutput {
  data: string;
}

/**
 * The rate-limit detection regex used in pi-ai-runtime-adapter.ts completeWithRetry.
 * Duplicated here for contract testing — if the adapter regex changes, this test
 * must be updated to match (documenting the classification contract).
 */
const RATE_LIMIT_REGEX = /rate.?limit|429|quota|too many requests/i;

const TASK_ID = 'task-rate-limit-001';

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: TASK_ID,
    taskKind: 'dreamer',
    status: 'leased',
    attemptCount: 3,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Build an EffectivePdConfig with diagnostician_llm_degradation flag on or off.
 * Mirrors the makeEffectiveConfig pattern from diag-rootcause-intent-tension.test.ts.
 */
function makeEffectiveConfig(opts: { degradationEnabled?: boolean }): EffectivePdConfig {
  const base = getDefaultPdConfig();
  return {
    config: {
      ...base,
      features: {
        ...base.features,
        diagnostician_llm_degradation: {
          category: 'quiet',
          enabled: opts.degradationEnabled === true,
        },
      },
    },
    source: 'user_config',
    warnings: [],
    featuresChangedFromDefault: opts.degradationEnabled ? ['diagnostician_llm_degradation'] : [],
    resolvedProfile: resolveProfile({}),
    resolvedContextInjection: {
      thinkingOs: false,
      projectFocus: 'off',
      evolutionContext: { enabled: true, maxMessages: 4, maxCharsPerMessage: 200 },
    },
  };
}

/**
 * Test runner that exposes retryOrFail for direct testing.
 * permanentErrorCategories excludes rate_limit (so rate_limit is retryable/degradable).
 */
class DegradationTestRunner extends BasePeerRunner<TestContext, TestOutput> {
  constructor(deps: PeerRunnerDeps, effectiveConfig?: EffectivePdConfig) {
    super(
      deps,
      { owner: 'test', runtimeKind: 'test-double' },
      {
        runnerName: 'test',
        expectedTaskKind: 'dreamer',
        defaultAgentId: 'test',
        resultRefPrefix: 'test',
        effectiveConfig,
      },
    );
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  get permanentErrorCategories(): ReadonlySet<PDErrorCategory> {
    // rate_limit is intentionally NOT permanent — it should be degradable
    return new Set(['storage_unavailable', 'workspace_invalid', 'capability_missing', 'cancelled', 'input_invalid', 'output_invalid']);
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async buildContext(): Promise<TestContext> {
    return { contextHash: 'test-hash' };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async invokeRuntime(): Promise<RunHandle> {
    return { runId: 'run-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validateOutput(): Promise<PeerRunnerValidationResult> {
    return { valid: true, errors: [] };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this, @typescript-eslint/max-params
  async succeedTask(taskId: string, runId: string, _output: TestOutput, task: TaskRecord): Promise<PeerRunnerResult<TestOutput>> {
    return { status: 'succeeded', taskId, runId, attemptCount: task.attemptCount };
  }

  /** Expose protected retryOrFail for direct testing. */
  async callRetryOrFail(ctx: FailureContext): Promise<PeerRunnerResult<TestOutput>> {
    return this.retryOrFail(ctx);
  }
}

function createMockDeps(overrides?: Partial<PeerRunnerDeps>): PeerRunnerDeps {
  return {
    stateManager: {
      getRetryPolicy: vi.fn().mockReturnValue({
        shouldRetry: vi.fn().mockReturnValue(false),
      }),
      markTaskFailed: vi.fn().mockResolvedValue({}),
      markTaskRetryWait: vi.fn().mockResolvedValue({}),
      markTaskSucceeded: vi.fn().mockResolvedValue({}),
      updateRunOutput: vi.fn().mockResolvedValue({}),
    } as unknown as RuntimeStateManager,
    runtimeAdapter: {} as unknown as PDRuntimeAdapter,
    eventEmitter: {
      emitTelemetry: vi.fn(),
    } as unknown as StoreEventEmitter,
    artifactStore: {} as unknown as PIArtifactStore,
    ...overrides,
  };
}

// Telemetry call arg narrowing (mirrors diag-rootcause-intent-tension.test.ts pattern)
type TelemetryCallsArg = { eventType: string; payload?: Record<string, unknown> };
function telemetryCalls(mock: ReturnType<typeof vi.fn>): TelemetryCallsArg[] {
  return (mock.mock.calls as unknown[][]).map((call) => call[0] as TelemetryCallsArg);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ADR-0019: rate-limit regex classification', () => {
  it('matches common rate-limit error signatures', () => {
    const positiveCases = [
      'Rate limit exceeded',
      'rate_limit hit',
      'RateLimitError: 429 Too Many Requests',
      'HTTP 429',
      '429',
      'quota exceeded for today',
      'Too many requests, please slow down',
      'API quota depleted',
    ];
    for (const msg of positiveCases) {
      expect(RATE_LIMIT_REGEX.test(msg), `should match: "${msg}"`).toBe(true);
    }
  });

  it('does NOT match non-rate-limit error signatures', () => {
    const negativeCases = [
      'internal server error',
      'connection timeout',
      'invalid API key',
      'model not found',
      'context length exceeded',
      'execution failed',
      '',
    ];
    for (const msg of negativeCases) {
      expect(RATE_LIMIT_REGEX.test(msg), `should NOT match: "${msg}"`).toBe(false);
    }
  });

  it('is case-insensitive', () => {
    expect(RATE_LIMIT_REGEX.test('RATE LIMIT EXCEEDED')).toBe(true);
    expect(RATE_LIMIT_REGEX.test('RateLimit')).toBe(true);
    expect(RATE_LIMIT_REGEX.test('QUOTA')).toBe(true);
  });
});

describe('ADR-0019: rate-limit graceful degradation — flag off / no effectiveConfig (legacy)', () => {
  let mockDeps: PeerRunnerDeps;
  let task: TaskRecord;

  beforeEach(() => {
    mockDeps = createMockDeps();
    task = makeTask();
  });

  it('rate_limit error → max_attempts_exceeded when effectiveConfig is undefined', async () => {
    // No effectiveConfig passed → isDegradationEnabled() returns false → legacy path
    const runner = new DegradationTestRunner(mockDeps);

    const ctx: FailureContext = {
      taskId: TASK_ID,
      task,
      errorCategory: 'rate_limit',
      failureReason: 'LLM rate limit hit: 429 Too Many Requests',
    };

    const result = await runner.callRetryOrFail(ctx);

    // Should fall through to max_attempts_exceeded (retry policy returns false)
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('max_attempts_exceeded');

    // markTaskFailed called with max_attempts_exceeded, NOT rate_limit
    expect(mockDeps.stateManager.markTaskFailed).toHaveBeenCalledWith(
      TASK_ID,
      'max_attempts_exceeded',
      expect.stringContaining('Max attempts exceeded'),
    );

    // NO degradation telemetry emitted
    const calls = telemetryCalls(mockDeps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>);
    expect(calls.find((c) => c.eventType === 'test_diag_llm_rate_limit_degraded')).toBeUndefined();
  });

  it('rate_limit error → max_attempts_exceeded when flag is explicitly off', async () => {
    const effectiveConfig = makeEffectiveConfig({ degradationEnabled: false });
    const runner = new DegradationTestRunner(mockDeps, effectiveConfig);

    const ctx: FailureContext = {
      taskId: TASK_ID,
      task,
      errorCategory: 'rate_limit',
      failureReason: 'LLM rate limit hit: 429',
    };

    const result = await runner.callRetryOrFail(ctx);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('max_attempts_exceeded');
    expect(mockDeps.stateManager.markTaskFailed).toHaveBeenCalledWith(
      TASK_ID,
      'max_attempts_exceeded',
      expect.any(String),
    );

    const calls = telemetryCalls(mockDeps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>);
    expect(calls.find((c) => c.eventType === 'test_diag_llm_rate_limit_degraded')).toBeUndefined();
  });
});

describe('ADR-0019: rate-limit graceful degradation — flag on (degradation)', () => {
  let mockDeps: PeerRunnerDeps;
  let task: TaskRecord;
  let runner: DegradationTestRunner;

  beforeEach(() => {
    mockDeps = createMockDeps();
    task = makeTask();
    const effectiveConfig = makeEffectiveConfig({ degradationEnabled: true });
    runner = new DegradationTestRunner(mockDeps, effectiveConfig);
  });

  it('rate_limit error → markTaskFailed(rate_limit) + diag_llm_rate_limit_degraded telemetry', async () => {
    const ctx: FailureContext = {
      taskId: TASK_ID,
      task,
      errorCategory: 'rate_limit',
      failureReason: 'LLM rate limit hit: 429 Too Many Requests',
    };

    const result = await runner.callRetryOrFail(ctx);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('rate_limit');
    expect(result.failureReason).toContain('LLM rate limit degraded');

    // markTaskFailed called with rate_limit (NOT max_attempts_exceeded)
    expect(mockDeps.stateManager.markTaskFailed).toHaveBeenCalledWith(
      TASK_ID,
      'rate_limit',
      expect.stringContaining('LLM rate limit degraded'),
    );

    // Degradation telemetry emitted
    const calls = telemetryCalls(mockDeps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>);
    const degradedEvent = calls.find((c) => c.eventType === 'test_diag_llm_rate_limit_degraded');
    expect(degradedEvent).toBeDefined();
    expect(degradedEvent?.payload).toMatchObject({
      errorCategory: 'rate_limit',
      attemptCount: 3,
      failureReason: 'LLM rate limit hit: 429 Too Many Requests',
    });
  });

  it('telemetry event includes nextAction field (rc-9: no silent fallback)', async () => {
    const ctx: FailureContext = {
      taskId: TASK_ID,
      task,
      errorCategory: 'rate_limit',
      failureReason: 'quota exceeded',
    };

    await runner.callRetryOrFail(ctx);

    const calls = telemetryCalls(mockDeps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>);
    const degradedEvent = calls.find((c) => c.eventType === 'test_diag_llm_rate_limit_degraded');
    expect(degradedEvent).toBeDefined();
    // rc-9: nextAction MUST be present — silent fallback is a bug
    expect(degradedEvent?.payload).toHaveProperty('nextAction');
    expect(typeof degradedEvent?.payload?.nextAction).toBe('string');
    expect(degradedEvent?.payload?.nextAction).toContain('pd pain retry');
  });

  it('non-rate_limit errors are NOT degraded (execution_failed → max_attempts_exceeded)', async () => {
    const ctx: FailureContext = {
      taskId: TASK_ID,
      task,
      errorCategory: 'execution_failed',
      failureReason: 'LLM execution failed: internal server error',
    };

    const result = await runner.callRetryOrFail(ctx);

    // execution_failed should NOT trigger degradation — flows to max_attempts_exceeded
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('max_attempts_exceeded');

    // markTaskFailed called with max_attempts_exceeded, NOT rate_limit
    expect(mockDeps.stateManager.markTaskFailed).toHaveBeenCalledWith(
      TASK_ID,
      'max_attempts_exceeded',
      expect.any(String),
    );

    const calls = telemetryCalls(mockDeps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>);
    expect(calls.find((c) => c.eventType === 'test_diag_llm_rate_limit_degraded')).toBeUndefined();
  });

  it('permanent errors still bypass degradation (storage_unavailable)', async () => {
    // storage_unavailable is in permanentErrorCategories — should be handled
    // by the permanent-error branch BEFORE the rate_limit degradation branch.
    const ctx: FailureContext = {
      taskId: TASK_ID,
      task,
      errorCategory: 'storage_unavailable',
      failureReason: 'SQLite database locked',
    };

    const result = await runner.callRetryOrFail(ctx);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('storage_unavailable');

    // markTaskFailed called with storage_unavailable (permanent error), NOT rate_limit
    expect(mockDeps.stateManager.markTaskFailed).toHaveBeenCalledWith(
      TASK_ID,
      'storage_unavailable',
      'SQLite database locked',
    );

    // NO degradation telemetry
    const calls = telemetryCalls(mockDeps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>);
    expect(calls.find((c) => c.eventType === 'test_diag_llm_rate_limit_degraded')).toBeUndefined();
  });

  it('rate_limit degradation with markTaskFailed error → storage_unavailable fallback', async () => {
    // If markTaskFailed throws, the degradation path must not silently swallow —
    // it returns storage_unavailable + emits mark_failed_error (ERR-002).
    (mockDeps.stateManager.markTaskFailed as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('SQLite database locked'),
    );

    const ctx: FailureContext = {
      taskId: TASK_ID,
      task,
      errorCategory: 'rate_limit',
      failureReason: 'LLM rate limit hit: 429',
    };

    const result = await runner.callRetryOrFail(ctx);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('storage_unavailable');
    expect(result.failureReason).toContain('State manager error');

    // mark_failed_error telemetry emitted (not silent)
    const calls = telemetryCalls(mockDeps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>);
    const markFailedErr = calls.find((c) => c.eventType === 'test_mark_failed_error');
    expect(markFailedErr).toBeDefined();
    expect(markFailedErr?.payload?.errorCategory).toBe('storage_unavailable');
  });
});
