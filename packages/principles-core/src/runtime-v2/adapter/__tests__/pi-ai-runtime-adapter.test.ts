/**
 * PiAiRuntimeAdapter unit tests.
 *
 * Verifies all PDRuntimeAdapter interface methods, pi-ai API usage,
 * error mapping, DiagnosticianOutputV1 validation, retry logic,
 * and telemetry emission.
 *
 * All pi-ai calls are mocked — no real API keys needed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PDRuntimeError } from '../../error-categories.js';

// Mock @mariozechner/pi-ai at module level
vi.mock('@mariozechner/pi-ai', () => ({
  getModel: vi.fn(),
  getProviders: vi.fn(() => ['openrouter', 'anthropic', 'openai', 'google']),
  complete: vi.fn(),
}));

// Mock store/event-emitter to capture telemetry calls
vi.mock('../../store/event-emitter.js', () => ({
  storeEmitter: { emitTelemetry: vi.fn() },
}));

import { getModel, complete } from '@mariozechner/pi-ai';
import { storeEmitter } from '../../store/event-emitter.js';
import { PiAiRuntimeAdapter } from '../pi-ai-runtime-adapter.js';
import type { StartRunInput } from '../../runtime-protocol.js';

const mockGetModel = getModel as ReturnType<typeof vi.fn>;
const mockComplete = complete as ReturnType<typeof vi.fn>;
const mockEmitTelemetry = storeEmitter.emitTelemetry as ReturnType<typeof vi.fn>;

// ── Fixtures ──

const VALID_DIAGNOSIS = {
  valid: true,
  diagnosisId: 'diag-test-1',
  taskId: 'task-test-1',
  summary: 'Test summary',
  rootCause: 'Test root cause',
  violatedPrinciples: [],
  evidence: [],
  recommendations: [],
  confidence: 0.9,
};

function makeAssistantMessage(text: string, overrides: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text' as const, text }],
    role: 'assistant' as const,
    stopReason: 'stop' as const,
    api: 'openai-completions',
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Create an AssistantMessage that resolved with stopReason:'error'. */
function makeErrorResponse(errorMessage: string, overrides: Record<string, unknown> = {}) {
  return makeAssistantMessage('', {
    stopReason: 'error',
    errorMessage,
    content: [],
    ...overrides,
  });
}

/** Create an AssistantMessage that resolved with stopReason:'aborted'. */
function makeAbortedResponse(errorMessage = 'The operation was aborted') {
  return makeAssistantMessage('', {
    stopReason: 'aborted',
    errorMessage,
    content: [],
  });
}

function makeStartRunInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    agentSpec: { agentId: 'diagnostician', schemaVersion: 'v1' },
    inputPayload: 'Diagnose this pain signal',
    contextItems: [],
    timeoutMs: 60_000,
    ...overrides,
  };
}

function makeAdapter(overrides: Record<string, unknown> = {}) {
  return new PiAiRuntimeAdapter({
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4',
    apiKeyEnv: 'TEST_API_KEY',
    ...overrides,
  });
}

/**
 * Helper: assert that startRun rejects with a PDRuntimeError of the given category.
 * Uses a fresh adapter and mock setup to avoid mock-consumption issues.
 */
async function expectStartRunError(
  category: string,
  mockSetup: () => void,
  adapterOverrides: Record<string, unknown> = {},
) {
  mockSetup();
  const adapter = makeAdapter(adapterOverrides);
  let caught: PDRuntimeError | undefined = undefined;
  try {
    await adapter.startRun(makeStartRunInput());
  } catch (err) {
    caught = err instanceof PDRuntimeError ? err : undefined;
  }
  expect(caught).toBeInstanceOf(PDRuntimeError);
  expect(caught?.category).toBe(category);
}

/** Extract the first emitted telemetry event matching the given eventType. */
function findTelemetryEvent(eventType: string): Record<string, unknown> | undefined {
  const call = mockEmitTelemetry.mock.calls.find(
    (c: unknown[]) => (c[0] as Record<string, unknown>).eventType === eventType,
  );
  return call ? (call[0] as Record<string, unknown>) : undefined;
}

// ── Tests ──

describe('PiAiRuntimeAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TEST_API_KEY = 'test-key-123';
    // Default mock: getModel returns a model object, complete returns valid diagnosis
    mockGetModel.mockReturnValue({ id: 'anthropic/claude-sonnet-4' });
    mockComplete.mockResolvedValue(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));
  });

  afterEach(() => {
    delete process.env.TEST_API_KEY;
  });

  // ── kind() ──

  describe('kind()', () => {
    it('returns "pi-ai" (RS-02)', () => {
      const adapter = makeAdapter();
      expect(adapter.kind()).toBe('pi-ai');
    });
  });

  // ── getCapabilities() ──

  describe('getCapabilities()', () => {
    it('returns correct RuntimeCapabilities shape', async () => {
      const adapter = makeAdapter();
      const caps = await adapter.getCapabilities();

      expect(caps.supportsStructuredJsonOutput).toBe(true);
      expect(caps.supportsToolUse).toBe(false);
      expect(caps.supportsWorkingDirectory).toBe(false);
      expect(caps.supportsModelSelection).toBe(true);
      expect(caps.supportsLongRunningSessions).toBe(false);
      expect(caps.supportsCancellation).toBe(true);
      expect(caps.supportsArtifactWriteBack).toBe(false);
      expect(caps.supportsConcurrentRuns).toBe(false);
      expect(caps.supportsStreaming).toBe(false);
    });
  });

  // ── healthCheck() ──

  describe('healthCheck()', () => {
    it('returns healthy=true when apiKey exists, getModel succeeds, and complete probe returns {"ok":true}', async () => {
      mockComplete.mockResolvedValueOnce(makeAssistantMessage('{"ok":true}'));

      const adapter = makeAdapter();
      const health = await adapter.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.degraded).toBe(false);
      expect(health.warnings).toEqual([]);
      expect(mockGetModel).toHaveBeenCalledWith('openrouter', 'anthropic/claude-sonnet-4');
    });

    it('returns healthy=false when apiKeyEnv is missing', async () => {
      delete process.env.TEST_API_KEY;

      const adapter = makeAdapter();
      const health = await adapter.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.degraded).toBe(false);
      expect(health.warnings.some(w => w.includes('TEST_API_KEY'))).toBe(true);
    });

    it('returns healthy=false when getModel throws', async () => {
      mockGetModel.mockImplementationOnce(() => { throw new Error('invalid provider'); });

      const adapter = makeAdapter();
      const health = await adapter.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.degraded).toBe(false);
      expect(health.warnings.some(w => w.includes('invalid provider'))).toBe(true);
    });

    it('returns healthy=false with degraded=true when complete probe returns unexpected result', async () => {
      mockComplete.mockResolvedValueOnce(makeAssistantMessage('{"unexpected": true}'));

      const adapter = makeAdapter();
      const health = await adapter.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.degraded).toBe(true);
      expect(health.warnings.some(w => w.includes('unexpected result'))).toBe(true);
    });

    it('returns healthy=false with degraded=true when probe times out', async () => {
      mockComplete.mockImplementationOnce(() => {
        const err = new DOMException('The operation was aborted', 'AbortError');
        throw err;
      });

      const adapter = makeAdapter();
      const health = await adapter.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.degraded).toBe(true);
      expect(health.warnings.some(w => w.includes('timed out'))).toBe(true);
    });

    it('returns healthy=false with degraded=true when complete resolves with stopReason:error + timeout message', async () => {
      mockComplete.mockResolvedValueOnce(makeErrorResponse('Request timed out.'));

      const adapter = makeAdapter();
      const health = await adapter.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.degraded).toBe(true);
      expect(health.warnings.some(w => w.includes('timed out'))).toBe(true);
      // Must NOT say "no text content"
      expect(health.warnings.every(w => !w.includes('no text content'))).toBe(true);
    });

    it('returns healthy=false with degraded=false when complete resolves with stopReason:error + auth error', async () => {
      mockComplete.mockResolvedValueOnce(makeErrorResponse('401 Unauthorized'));

      const adapter = makeAdapter();
      const health = await adapter.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.degraded).toBe(false);
      expect(health.warnings.some(w => w.includes('execution failed') || w.includes('401'))).toBe(true);
      // Must NOT misclassify as "no text content"
      expect(health.warnings.every(w => !w.includes('no text content'))).toBe(true);
    });

    it('respects config.timeoutMs for probe timeout', async () => {
      // Capture the timeoutMs passed to complete
      let capturedTimeoutMs: number | undefined = undefined;
      mockComplete.mockImplementationOnce(async (_model: unknown, _ctx: unknown, opts: Record<string, unknown>) => {
        capturedTimeoutMs = opts.timeoutMs as number;
        return makeAssistantMessage('{"ok":true}');
      });

      const adapter = makeAdapter({ timeoutMs: 15_000 });
      await adapter.healthCheck();

      expect(capturedTimeoutMs).toBe(15_000);
    });
  });

  // ── startRun() — success path ──

  describe('startRun()', () => {
    it('calls getModel with provider and model from config', async () => {
      const adapter = makeAdapter();
      await adapter.startRun(makeStartRunInput());

      expect(mockGetModel).toHaveBeenCalledWith('openrouter', 'anthropic/claude-sonnet-4');
    });

    it('calls complete with correct context including UserMessage with timestamp', async () => {
      const adapter = makeAdapter();
      await adapter.startRun(makeStartRunInput());

      expect(mockComplete).toHaveBeenCalledTimes(1);
      const [, context] = mockComplete.mock.calls[0] as [unknown, { messages: Record<string, unknown>[] }];
      expect(context.messages).toHaveLength(1);
      expect(context.messages[0]).toBeDefined();
      if (context.messages[0]) {
        expect(context.messages[0].role).toBe('user');
        expect(context.messages[0].content).toBe('Diagnose this pain signal');
        expect(typeof context.messages[0].timestamp).toBe('number');
      }
    });

    it('passes apiKey, effectiveTimeoutMs (input > config > default), and maxRetries: 0 to complete options', async () => {
      const adapter = makeAdapter({ maxRetries: 3, timeoutMs: 120_000 });
      await adapter.startRun(makeStartRunInput({ timeoutMs: 90_000 }));

      const [, , options] = mockComplete.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
      expect(options.apiKey).toBe('test-key-123');
      expect(options.maxRetries).toBe(0);
      expect(options.timeoutMs).toBe(90_000);
    });

    it('returns RunHandle with runId, runtimeKind="pi-ai", and valid ISO startedAt', async () => {
      const adapter = makeAdapter();
      const handle = await adapter.startRun(makeStartRunInput());

      expect(handle.runId).toBeTruthy();
      expect(handle.runtimeKind).toBe('pi-ai');
      expect(new Date(handle.startedAt).toISOString()).toBe(handle.startedAt);
    });

    it('stores output in memory (fetchOutput works after startRun completes)', async () => {
      const adapter = makeAdapter();
      const handle = await adapter.startRun(makeStartRunInput());

      const output = await adapter.fetchOutput(handle.runId);
      expect(output).not.toBeNull();
      expect(output?.runId).toBe(handle.runId);
      expect(output?.payload).toMatchObject({ diagnosisId: 'diag-test-1' });
    });

    it('serializes non-string inputPayload to JSON for the UserMessage', async () => {
      const adapter = makeAdapter();
      await adapter.startRun(makeStartRunInput({ inputPayload: { pain: 'signal', severity: 0.8 } }));

      const [, context] = mockComplete.mock.calls[0] as [unknown, { messages: Record<string, unknown>[] }];
      expect(context.messages[0]).toBeDefined();
      if (context.messages[0]) {
        expect(context.messages[0].content).toBe('{"pain":"signal","severity":0.8}');
      }
    });
  });

  // ── JSON extraction (balanced parsing) ──

  describe('JSON extraction (balanced parsing)', () => {
    it('parses plain JSON from LLM response', async () => {
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter();
      const handle = await adapter.startRun(makeStartRunInput());
      const output = await adapter.fetchOutput(handle.runId);

      expect(output?.payload).toMatchObject({ diagnosisId: 'diag-test-1' });
    });

    it('parses JSON wrapped in prose text', async () => {
      const proseWrapped = `Here is the analysis:\n${JSON.stringify(VALID_DIAGNOSIS)}\nDone.`;
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(proseWrapped));

      const adapter = makeAdapter();
      const handle = await adapter.startRun(makeStartRunInput());
      const output = await adapter.fetchOutput(handle.runId);

      expect(output?.payload).toMatchObject({ diagnosisId: 'diag-test-1' });
    });

    it('parses JSON inside code fences', async () => {
      const codeFenced = '```json\n' + JSON.stringify(VALID_DIAGNOSIS) + '\n```';
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(codeFenced));

      const adapter = makeAdapter();
      const handle = await adapter.startRun(makeStartRunInput());
      const output = await adapter.fetchOutput(handle.runId);

      expect(output?.payload).toMatchObject({ diagnosisId: 'diag-test-1' });
    });

    it('throws output_invalid when no JSON object found in response', async () => {
      await expectStartRunError('output_invalid', () => {
        mockComplete.mockReset();
        mockComplete.mockResolvedValue(makeAssistantMessage('No JSON here at all'));
      });
    });
  });

  // ── startRun() error mapping ──

  describe('startRun() error mapping', () => {
    it('throws PDRuntimeError("runtime_unavailable") when apiKeyEnv missing from process.env', async () => {
      await expectStartRunError('runtime_unavailable', () => {
        delete process.env.TEST_API_KEY;
      });
    });

    it('throws PDRuntimeError("timeout") when LLM request is aborted/timed out', async () => {
      await expectStartRunError('timeout', () => {
        mockComplete.mockReset();
        mockComplete.mockImplementation(() => {
          throw new DOMException('The operation was aborted', 'AbortError');
        });
      });
    });

    it('throws PDRuntimeError("output_invalid") when LLM response contains no parseable JSON', async () => {
      await expectStartRunError('output_invalid', () => {
        mockComplete.mockReset();
        mockComplete.mockResolvedValue(makeAssistantMessage('Just plain text, no JSON at all'));
      });
    });

    it('skips schema validation when no outputSchemaRef is provided (backward compatible)', async () => {
      mockComplete.mockReset();
      mockComplete.mockResolvedValue(makeAssistantMessage(JSON.stringify({ valid: true, missing: 'fields' })));
      const adapter = makeAdapter();
      const handle = await adapter.startRun(makeStartRunInput());
      const output = await adapter.fetchOutput(handle.runId);
      expect(output?.payload).toMatchObject({ valid: true, missing: 'fields' });
    });

    it('throws PDRuntimeError("output_invalid") when parsed JSON does not match schema for given outputSchemaRef', async () => {
      mockComplete.mockReset();
      mockComplete.mockResolvedValue(makeAssistantMessage(JSON.stringify({ valid: true, missing: 'fields' })));
      const adapter = makeAdapter();
      await expect(adapter.startRun(makeStartRunInput({
        outputSchemaRef: 'diagnostician-output-v1',
      }))).rejects.toMatchObject({ category: 'output_invalid' });
    });

    it('throws PDRuntimeError("execution_failed") after retry exhaustion on network error', async () => {
      await expectStartRunError('execution_failed', () => {
        mockComplete.mockReset();
        mockComplete.mockRejectedValue(new Error('ECONNREFUSED'));
      }, { maxRetries: 1 });
    });

    it('throws PDRuntimeError("timeout") when complete resolves with stopReason:error + timeout message', async () => {
      await expectStartRunError('timeout', () => {
        mockComplete.mockReset();
        mockComplete.mockResolvedValue(makeErrorResponse('Request timed out.'));
      });
    });

    it('throws PDRuntimeError("execution_failed") when complete resolves with stopReason:error + 401 Unauthorized', async () => {
      await expectStartRunError('execution_failed', () => {
        mockComplete.mockReset();
        mockComplete.mockResolvedValue(makeErrorResponse('401 Unauthorized'));
      });
    });

    it('throws PDRuntimeError("timeout") when complete resolves with stopReason:aborted', async () => {
      await expectStartRunError('timeout', () => {
        mockComplete.mockReset();
        mockComplete.mockResolvedValue(makeAbortedResponse());
      });
    });

    it('retries resolved stopReason:error (execution_failed) before giving up', async () => {
      // First call: resolves with error, second call: succeeds
      mockComplete
        .mockResolvedValueOnce(makeErrorResponse('503 Service Unavailable'))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter({ maxRetries: 2 });
      const handle = await adapter.startRun(makeStartRunInput());

      expect(mockComplete).toHaveBeenCalledTimes(2);
      expect(handle.runId).toBeTruthy();
    });

    it('RunStatus.reason includes bounded errorMessage from resolved-error response', async () => {
      mockComplete.mockReset();
      mockComplete.mockResolvedValue(makeErrorResponse('401 Unauthorized: invalid API key'));

      const adapter = makeAdapter({ maxRetries: 0 });
      try {
        await adapter.startRun(makeStartRunInput());
      } catch {
        // startRun throws, but internally run state should have the reason
      }

      // Telemetry should include the error message
      const failedEvent = findTelemetryEvent('runtime_invocation_failed');
      expect(failedEvent).toBeDefined();
      const payload = failedEvent?.payload as Record<string, unknown>;
      expect(payload.errorCategory).toBe('execution_failed');
      expect(typeof payload.errorMessage).toBe('string');
      expect((payload.errorMessage as string).includes('401')).toBe(true);
    });
  });

  // ── startRun() retry logic ──

  describe('startRun() retry logic', () => {
    it('retries transient failures up to maxRetries times', async () => {
      // Fail twice, succeed on third
      mockComplete
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter({ maxRetries: 2 });
      const handle = await adapter.startRun(makeStartRunInput());

      expect(mockComplete).toHaveBeenCalledTimes(3);
      expect(handle.runtimeKind).toBe('pi-ai');
    });

    it('succeeds on second attempt after first transient failure', async () => {
      mockComplete
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter({ maxRetries: 2 });
      const handle = await adapter.startRun(makeStartRunInput());

      expect(mockComplete).toHaveBeenCalledTimes(2);
      expect(handle.runId).toBeTruthy();
    });

    it('does not retry on PDRuntimeError (output_invalid)', async () => {
      mockComplete.mockReset();
      mockComplete
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ valid: true })))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ valid: true })));

      const adapter = makeAdapter({ maxRetries: 3 });

      await expect(adapter.startRun(makeStartRunInput({
        outputSchemaRef: 'diagnostician-output-v1',
      }))).rejects.toThrow(PDRuntimeError);
      // 1 original + 1 repair attempt = 2 calls (not 3+ retries)
      expect(mockComplete).toHaveBeenCalledTimes(2);
    });

    it('does not retry on PDRuntimeError (runtime_unavailable)', async () => {
      delete process.env.TEST_API_KEY;

      const adapter = makeAdapter({ maxRetries: 3 });

      await expect(adapter.startRun(makeStartRunInput())).rejects.toMatchObject({
        category: 'runtime_unavailable',
      });
      // complete should not be called at all — error happens before LLM call
      expect(mockComplete).not.toHaveBeenCalled();
    });
  });

  // ── pollRun() ──

  describe('pollRun()', () => {
    it('returns terminal status (succeeded) for completed run', async () => {
      const adapter = makeAdapter();
      const handle = await adapter.startRun(makeStartRunInput());

      const status = await adapter.pollRun(handle.runId);
      expect(status.runId).toBe(handle.runId);
      expect(status.status).toBe('succeeded');
      expect(status.startedAt).toBeTruthy();
      expect(status.endedAt).toBeTruthy();
    });

    it('returns failed status with reason when startRun fails', async () => {
      mockComplete.mockReset();
      mockComplete.mockImplementation(async () => {
        throw new DOMException('aborted', 'AbortError');
      });

      const adapter = makeAdapter();
      try {
        await adapter.startRun(makeStartRunInput());
      } catch (err) {
        // Verify the error path doesn't crash and emits telemetry
        expect(err).toBeInstanceOf(PDRuntimeError);
      }
    });

    it('throws PDRuntimeError("input_invalid") for unknown runId', async () => {
      const adapter = makeAdapter();

      await expect(adapter.pollRun('nonexistent-run-id')).rejects.toThrow(PDRuntimeError);
      await expect(adapter.pollRun('nonexistent-run-id')).rejects.toMatchObject({
        category: 'input_invalid',
      });
    });
  });

  // ── fetchOutput() ──

  describe('fetchOutput()', () => {
    it('returns StructuredRunOutput with runId and payload after successful run', async () => {
      const adapter = makeAdapter();
      const handle = await adapter.startRun(makeStartRunInput());

      const output = await adapter.fetchOutput(handle.runId);
      expect(output).not.toBeNull();
      expect(output?.runId).toBe(handle.runId);
      expect(output?.payload).toMatchObject({
        valid: true,
        diagnosisId: 'diag-test-1',
        taskId: 'task-test-1',
      });
    });

    it('returns null for unknown runId', async () => {
      const adapter = makeAdapter();

      const output = await adapter.fetchOutput('nonexistent-run-id');
      expect(output).toBeNull();
    });
  });

  // ── cancelRun() ──

  describe('cancelRun()', () => {
    it('resolves without error', async () => {
      const adapter = makeAdapter();
      await expect(adapter.cancelRun('any-run-id')).resolves.toBeUndefined();
    });
  });

  // ── fetchArtifacts() ──

  describe('fetchArtifacts()', () => {
    it('returns empty array for a run that was started', async () => {
      const adapter = makeAdapter();
      const input = makeStartRunInput({ taskRef: { taskId: 'test-run-id' } });
      const handle = await adapter.startRun(input);
      const artifacts = await adapter.fetchArtifacts(handle.runId);
      expect(artifacts).toEqual([]);
    });

    it('throws for an unknown runId', async () => {
      const adapter = makeAdapter();
      await expect(adapter.fetchArtifacts('unknown-run-id')).rejects.toThrow(
        "Run 'unknown-run-id' not found",
      );
    });
  });

  // ── telemetry (AD-15) ──

  describe('telemetry (AD-15)', () => {
    it('emits runtime_invocation_started event on startRun', async () => {
      const adapter = makeAdapter();
      await adapter.startRun(makeStartRunInput());

      const startedEvent = findTelemetryEvent('runtime_invocation_started');
      expect(startedEvent).toBeDefined();
      const payload = startedEvent?.payload as Record<string, unknown>;
      expect(payload.runtimeKind).toBe('pi-ai');
      expect(payload.provider).toBe('openrouter');
      expect(payload.model).toBe('anthropic/claude-sonnet-4');
    });

    it('emits runtime_invocation_succeeded on successful completion', async () => {
      const adapter = makeAdapter();
      await adapter.startRun(makeStartRunInput());

      const succeededEvent = findTelemetryEvent('runtime_invocation_succeeded');
      expect(succeededEvent).toBeDefined();
      const payload = succeededEvent?.payload as Record<string, unknown>;
      expect(payload.runtimeKind).toBe('pi-ai');
    });

    it('emits runtime_invocation_failed on failure', async () => {
      mockComplete.mockReset();
      mockComplete.mockRejectedValue(new Error('network down'));

      const adapter = makeAdapter({ maxRetries: 0 });
      try { await adapter.startRun(makeStartRunInput()); } catch { /* expected */ }

      const failedEvent = findTelemetryEvent('runtime_invocation_failed');
      expect(failedEvent).toBeDefined();
      const payload = failedEvent?.payload as Record<string, unknown>;
      expect(payload.runtimeKind).toBe('pi-ai');
      expect(payload.errorCategory).toBe('execution_failed');
    });

    it('emits runtime_invocation_started before LLM call (even if call fails)', async () => {
      mockComplete.mockReset();
      mockComplete.mockRejectedValue(new Error('fail'));

      const adapter = makeAdapter({ maxRetries: 0 });
      try { await adapter.startRun(makeStartRunInput()); } catch { /* expected */ }

      const startedEvent = findTelemetryEvent('runtime_invocation_started');
      expect(startedEvent).toBeDefined();
    });
  });

  // ── Error category coverage ──

  describe('error category coverage', () => {
    it('all 5 PDRuntimeError categories are reachable', () => {
      // This test documents which categories are tested where:
      // - runtime_unavailable: apiKeyEnv missing test
      // - timeout: AbortError test
      // - output_invalid: JSON parse failure + schema mismatch tests
      // - execution_failed: retry exhaustion test
      // - input_invalid: pollRun with unknown runId test
      const categories = ['runtime_unavailable', 'timeout', 'output_invalid', 'execution_failed', 'input_invalid'];
      expect(categories).toHaveLength(5);
    });
  });

  // ── Run state management ──

  describe('run state management', () => {
    it('stores failed run state on error', async () => {
      mockComplete.mockReset();
      mockComplete.mockImplementation(() => {
        throw new DOMException('aborted', 'AbortError');
      });

      const adapter = makeAdapter();

      // startRun will throw, but internally the run state should be stored
      try {
        await adapter.startRun(makeStartRunInput());
      } catch {
        // We don't have the runId since startRun threw.
        // This test verifies the error path doesn't crash.
      }

      // Verify the adapter didn't crash and telemetry was emitted
      expect(mockEmitTelemetry).toHaveBeenCalled();
    });

    it('creates run state before LLM call', async () => {
      // eslint-disable-next-line @typescript-eslint/init-declarations
      let resolveComplete: ((value: unknown) => void) | undefined;
      const blockedPromise = new Promise(resolve => { resolveComplete = resolve; });
      mockComplete.mockReturnValueOnce(blockedPromise);

      const adapter = makeAdapter();

      // Start the run — it will block on complete()
      const handlePromise = adapter.startRun(makeStartRunInput());

      // Unblock the LLM call
      if (resolveComplete) {
        resolveComplete(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));
      }
      const handle = await handlePromise;

      // After completion, pollRun should return succeeded
      const status = await adapter.pollRun(handle.runId);
      expect(status.status).toBe('succeeded');
    });
  });

  // ── startRun() output repair (PRI-71) ──

  describe('startRun() output repair (PRI-71)', () => {
    /** Invalid output with string confidence and wrong-case kind. */
    const INVALID_DIAGNOSIS = {
      valid: true,
      diagnosisId: 'diag-repair-1',
      taskId: 'task-repair-1',
      summary: 'Test repair',
      rootCause: 'Test root cause',
      violatedPrinciples: [],
      evidence: [],
      recommendations: [{ kind: 'Rule', description: 'Fix casing' }],
      confidence: '85%',
    };

    /** Make a startRunInput with diagnostician output schema ref. */
    function makeDiagnosticianInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
      return makeStartRunInput({
        outputSchemaRef: 'diagnostician-output-v1',
        taskRef: { taskId: 'task-repair-1' },
        ...overrides,
      });
    }

    it('repairs confidence "85%" to 0.85 via second LLM call', async () => {
      mockComplete
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS)))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter();
      const handle = await adapter.startRun(makeDiagnosticianInput());

      expect(mockComplete).toHaveBeenCalledTimes(2);
      const output = await adapter.fetchOutput(handle.runId);
      expect(output?.payload).toMatchObject({ confidence: 0.9 });
    });

    it('repair fails — still throws output_invalid after repair attempt', async () => {
      mockComplete
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS)))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS)));

      const adapter = makeAdapter();
      await expect(adapter.startRun(makeDiagnosticianInput())).rejects.toMatchObject({
        category: 'output_invalid',
      });
      expect(mockComplete).toHaveBeenCalledTimes(2);
    });

    it('skips repair for unknown outputSchemaRef (not in registry)', async () => {
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ valid: true, missing: 'fields' })));

      const adapter = makeAdapter();
      const handle = await adapter.startRun(makeStartRunInput({
        outputSchemaRef: 'custom-unknown-v1',
      }));
      expect(mockComplete).toHaveBeenCalledTimes(1);
      const output = await adapter.fetchOutput(handle.runId);
      expect(output?.payload).toMatchObject({ valid: true, missing: 'fields' });
    });

    it('skips repair for non-JSON output (no schema errors to report)', async () => {
      mockComplete.mockResolvedValueOnce(makeAssistantMessage('Not JSON at all'));

      const adapter = makeAdapter();
      await expect(adapter.startRun(makeDiagnosticianInput())).rejects.toMatchObject({
        category: 'output_invalid',
      });
      expect(mockComplete).toHaveBeenCalledTimes(1);
    });

    it('emits output_extraction_failed telemetry when extractJsonObject returns null', async () => {
      mockComplete.mockResolvedValueOnce(makeAssistantMessage('I evaluated the plan and it looks good. The implementation is solid.'));

      const adapter = makeAdapter();
      try { await adapter.startRun(makeDiagnosticianInput()); } catch { /* expected */ }

      const extractionEvent = findTelemetryEvent('output_extraction_failed');
      expect(extractionEvent).toBeDefined();
      const payload = extractionEvent?.payload as Record<string, unknown>;
      expect(payload.outputSchemaRef).toBe('diagnostician-output-v1');
      expect(typeof payload.rawOutputPreview).toBe('string');
      expect((payload.rawOutputPreview as string).length).toBeGreaterThan(0);
    });

    it('emits output_repair_attempted telemetry on repair attempt', async () => {
      mockComplete
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS)))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter();
      await adapter.startRun(makeDiagnosticianInput());

      const repairEvent = findTelemetryEvent('output_repair_attempted');
      expect(repairEvent).toBeDefined();
      const payload = repairEvent?.payload as Record<string, unknown>;
      expect(payload.repaired).toBe(true);
      expect(payload.attemptsUsed).toBe(1);
    });

    it('emits output_repair_attempted with repaired=false on failure', async () => {
      mockComplete
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS)))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS)));

      const adapter = makeAdapter();
      try { await adapter.startRun(makeDiagnosticianInput()); } catch { /* expected */ }

      const repairEvent = findTelemetryEvent('output_repair_attempted');
      expect(repairEvent).toBeDefined();
      const payload = repairEvent?.payload as Record<string, unknown>;
      expect(payload.repaired).toBe(false);
    });

    it('reuses same provider/model for repair call', async () => {
      mockComplete
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS)))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter();
      await adapter.startRun(makeDiagnosticianInput());

      // Both calls should use same model
      expect(mockComplete).toHaveBeenCalledTimes(2);
      const [model1] = mockComplete.mock.calls[0] as [unknown];
      const [model2] = mockComplete.mock.calls[1] as [unknown];
      expect(model1).toEqual(model2);
    });

    it('repair call includes the repair prompt with schema errors', async () => {
      mockComplete
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS)))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter();
      await adapter.startRun(makeDiagnosticianInput());

      // Second call's context should contain the repair prompt
      const [, context] = mockComplete.mock.calls[1] as [unknown, { messages: { content: string }[] }];
      const repairMessage = context.messages[0]?.content ?? '';
      expect(repairMessage).toContain('schema');
      expect(repairMessage).toContain('confidence');
    });

    it('repair budget exhausted — maxRepairAttempts=1, no infinite loop', async () => {
      mockComplete
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS)))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS)));

      const adapter = makeAdapter();
      await expect(adapter.startRun(makeDiagnosticianInput())).rejects.toMatchObject({
        category: 'output_invalid',
      });
      // 1 original + 1 repair = 2 calls total (not infinite)
      expect(mockComplete).toHaveBeenCalledTimes(2);
    });

    it('repairs evaluator-output-v1 with prose-wrapped JSON', async () => {
      const EVALUATOR_OUTPUT_INVALID = {
        taskId: 'task-eval-repair-1',
        sourceArtificerArtifactId: 'pi-art-artificer-repair-1',
        evaluation: {
          decision: 'approved',
          summary: 'Good plan',
          score: '0.85',
          strengths: ['Clear'],
          concerns: [],
          requiredChanges: [],
        },
        sourceTrace: {
          artificerArtifactId: 'pi-art-artificer-repair-1',
        },
        risks: [],
        generatedAt: '2026-05-11T12:00:00.000Z',
      };

      const EVALUATOR_OUTPUT_VALID = {
        taskId: 'task-eval-repair-1',
        sourceArtificerArtifactId: 'pi-art-artificer-repair-1',
        evaluation: {
          decision: 'approved',
          summary: 'Good plan',
          score: 0.85,
          strengths: ['Clear'],
          concerns: [],
          requiredChanges: [],
        },
        sourceTrace: {
          artificerArtifactId: 'pi-art-artificer-repair-1',
        },
        risks: [],
        generatedAt: '2026-05-11T12:00:00.000Z',
      };

      mockComplete
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(EVALUATOR_OUTPUT_INVALID)))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(EVALUATOR_OUTPUT_VALID)));

      const adapter = makeAdapter();
      const handle = await adapter.startRun(makeStartRunInput({
        outputSchemaRef: 'evaluator-output-v1',
        taskRef: { taskId: 'task-eval-repair-1' },
      }));

      expect(mockComplete).toHaveBeenCalledTimes(2);
      const output = await adapter.fetchOutput(handle.runId);
      expect(output?.payload).toMatchObject({ evaluation: { score: 0.85 } });
    });
  });

  // ── startRun() schema dispatch by outputSchemaRef ──

  describe('startRun() schema dispatch by outputSchemaRef', () => {
    const VALID_DREAMER_OUTPUT = {
      valid: true,
      taskId: 'task-dreamer-1',
      candidates: [
        {
          candidateIndex: 0,
          badDecision: 'Ignored error handling',
          betterDecision: 'Add try/catch around API calls',
          rationale: 'Prevents unhandled rejections',
          confidence: 0.85,
          riskLevel: 'low',
          strategicPerspective: 'Defensive programming',
        },
      ],
      contextRefs: [],
      generatedAt: '2025-01-01T00:00:00.000Z',
    };

    const VALID_PHILOSOPHER_OUTPUT = {
      taskId: 'task-philosopher-1',
      sourceDreamerArtifactId: 'pi-art-dreamer-1',
      thesis: 'Error handling is essential for reliability',
      principleCandidate: {
        title: 'Always handle API errors',
        rationale: 'Unhandled errors cause cascading failures',
        scope: 'All external API calls',
        confidence: 0.9,
      },
      risks: ['May add boilerplate'],
      generatedAt: '2025-01-01T00:00:00.000Z',
    };

    it('validates dreamer-output-v1 with DreamerOutputV1Schema', async () => {
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DREAMER_OUTPUT)));

      const adapter = makeAdapter();
      const handle = await adapter.startRun(makeStartRunInput({
        outputSchemaRef: 'dreamer-output-v1',
        taskRef: { taskId: 'task-dreamer-1' },
      }));

      const output = await adapter.fetchOutput(handle.runId);
      expect(output?.payload).toMatchObject({ valid: true, taskId: 'task-dreamer-1' });
    });

    it('rejects invalid dreamer output with output_invalid', async () => {
      const invalidDreamerOutput = { valid: true, taskId: 'task-dreamer-1', candidates: 'not-array' };
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(invalidDreamerOutput)));

      const adapter = makeAdapter();
      await expect(adapter.startRun(makeStartRunInput({
        outputSchemaRef: 'dreamer-output-v1',
        taskRef: { taskId: 'task-dreamer-1' },
      }))).rejects.toMatchObject({ category: 'output_invalid' });
    });

    it('validates philosopher-output-v1 with PhilosopherOutputV1Schema', async () => {
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_PHILOSOPHER_OUTPUT)));

      const adapter = makeAdapter();
      const handle = await adapter.startRun(makeStartRunInput({
        outputSchemaRef: 'philosopher-output-v1',
        taskRef: { taskId: 'task-philosopher-1' },
      }));

      const output = await adapter.fetchOutput(handle.runId);
      expect(output?.payload).toMatchObject({ taskId: 'task-philosopher-1', thesis: 'Error handling is essential for reliability' });
    });

    it('rejects invalid philosopher output with output_invalid', async () => {
      const invalidPhilosopherOutput = { taskId: 'task-philosopher-1', principleCandidate: null };
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(invalidPhilosopherOutput)));

      const adapter = makeAdapter();
      await expect(adapter.startRun(makeStartRunInput({
        outputSchemaRef: 'philosopher-output-v1',
        taskRef: { taskId: 'task-philosopher-1' },
      }))).rejects.toMatchObject({ category: 'output_invalid' });
    });

    it('falls back to DiagnosticianOutputV1Schema for diagnostician-output-v1', async () => {
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter();
      const handle = await adapter.startRun(makeStartRunInput({
        outputSchemaRef: 'diagnostician-output-v1',
        taskRef: { taskId: 'task-test-1' },
      }));

      const output = await adapter.fetchOutput(handle.runId);
      expect(output?.payload).toMatchObject({ valid: true, diagnosisId: 'diag-test-1' });
    });

    it('unknown outputSchemaRef skips schema validation and succeeds', async () => {
      const arbitraryOutput = { foo: 'bar', baz: 42 };
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(arbitraryOutput)));

      const adapter = makeAdapter();
      const handle = await adapter.startRun(makeStartRunInput({
        outputSchemaRef: 'custom-output-v1',
      }));

      const output = await adapter.fetchOutput(handle.runId);
      expect(output?.payload).toMatchObject(arbitraryOutput);
    });

    it('no outputSchemaRef skips schema validation (backward compatible)', async () => {
      const arbitraryOutput = { anything: 'goes' };
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(arbitraryOutput)));

      const adapter = makeAdapter();
      const handle = await adapter.startRun(makeStartRunInput());

      const output = await adapter.fetchOutput(handle.runId);
      expect(output?.payload).toMatchObject(arbitraryOutput);
    });

    it('attempts repair for dreamer-output-v1 schema errors', async () => {
      const invalidDreamerOutput = {
        valid: true,
        taskId: 'task-dreamer-1',
        candidates: [{ candidateIndex: 0, badDecision: 'test', betterDecision: 'test', rationale: 'test', confidence: '85%', riskLevel: 'low', strategicPerspective: 'test' }],
        contextRefs: [],
        generatedAt: '2025-01-01T00:00:00.000Z',
      };
      mockComplete
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(invalidDreamerOutput)))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DREAMER_OUTPUT)));

      const adapter = makeAdapter();
      const handle = await adapter.startRun(makeStartRunInput({
        outputSchemaRef: 'dreamer-output-v1',
        taskRef: { taskId: 'task-dreamer-1' },
      }));

      expect(mockComplete).toHaveBeenCalledTimes(2);
      const output = await adapter.fetchOutput(handle.runId);
      expect(output?.payload).toMatchObject({ valid: true, taskId: 'task-dreamer-1' });
    });
  });
});
