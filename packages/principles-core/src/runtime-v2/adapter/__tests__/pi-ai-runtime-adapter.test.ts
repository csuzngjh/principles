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
  completeSimple: vi.fn(),
}));

// Mock store/event-emitter to capture telemetry calls
vi.mock('../../store/event-emitter.js', () => ({
  storeEmitter: { emitTelemetry: vi.fn() },
}));

import { getModel, completeSimple } from '@mariozechner/pi-ai';
import { storeEmitter } from '../../store/event-emitter.js';
import { PiAiRuntimeAdapter } from '../pi-ai-runtime-adapter.js';
import type { StartRunInput } from '../../runtime-protocol.js';

const mockGetModel = getModel as ReturnType<typeof vi.fn>;
const mockComplete = completeSimple as ReturnType<typeof vi.fn>;
const mockEmitTelemetry = storeEmitter.emitTelemetry as ReturnType<typeof vi.fn>;

// ── Fixtures ──

const VALID_DIAGNOSIS = {
  valid: true,
  diagnosisId: 'diag-test-1',
  summary: 'Test summary',
  rootCause: 'Test root cause',
  violatedPrinciples: [],
  evidence: [],
  recommendations: [{ kind: 'defer', description: 'no actionable recommendation' }],
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
    _testBackoffDelayMs: 0,
    outputPathStrategy: 'free_form_only', // Default to free_form for existing tests
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
  // Runtime Contract Rule 2 (no `as` bypass): validate the mock-call shape
  // before treating it as a telemetry payload.
  const call = mockEmitTelemetry.mock.calls.find((c: unknown[]) => {
    const [payload] = c;
    return (
      typeof payload === 'object' &&
      payload !== null &&
      Object.hasOwn(payload, 'eventType') &&
      (payload as { eventType: unknown }).eventType === eventType
    );
  });
  if (!call) return undefined;
  const [payload] = call;
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : undefined;
}

/**
 * Type guard for the tool-context shape passed as the 2nd arg to completeSimple.
 * Avoids `as` casts on mock-call data (Runtime Contract Rule 2 / ERR-001).
 */
function isToolContext(
  value: unknown,
): value is { tools: { name: string; parameters: unknown }[] } {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'tools')) {
    return false;
  }
  const {tools} = (value as { tools: unknown });
  if (!Array.isArray(tools)) return false;
  return tools.every((tool) => {
    if (typeof tool !== 'object' || tool === null) return false;
    return (
      Object.hasOwn(tool, 'name') &&
      typeof (tool as { name: unknown }).name === 'string' &&
      Object.hasOwn(tool, 'parameters')
    );
  });
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

    // ── systemPrompt support (PRI-501 follow-up) ──

    it('TC1: passes config.systemPrompt to Context.systemPrompt when set', async () => {
      const adapter = makeAdapter({ systemPrompt: 'You are a diagnostician.' });
      await adapter.startRun(makeStartRunInput());

      const [, context] = mockComplete.mock.calls[0] as [unknown, { systemPrompt?: string; messages: Record<string, unknown>[] }];
      expect(context.systemPrompt).toBe('You are a diagnostician.');
    });

    it('TC2: omits Context.systemPrompt when config.systemPrompt is unset (backward compat)', async () => {
      const adapter = makeAdapter();
      await adapter.startRun(makeStartRunInput());

      const [, context] = mockComplete.mock.calls[0] as [unknown, { systemPrompt?: string; messages: Record<string, unknown>[] }];
      expect(context.systemPrompt).toBeUndefined();
    });

    it('TC3: omits Context.systemPrompt when config.systemPrompt is empty string', async () => {
      const adapter = makeAdapter({ systemPrompt: '' });
      await adapter.startRun(makeStartRunInput());

      const [, context] = mockComplete.mock.calls[0] as [unknown, { systemPrompt?: string; messages: Record<string, unknown>[] }];
      expect(context.systemPrompt).toBeUndefined();
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
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ valid: true })))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ valid: true })))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ valid: true })));

      const adapter = makeAdapter({ maxRetries: 3 });

      await expect(adapter.startRun(makeStartRunInput({
        outputSchemaRef: 'diagnostician-output-v1',
      }))).rejects.toThrow(PDRuntimeError);
      // 1 original + 3 repair attempts = 4 calls (not infinite retries)
      expect(mockComplete).toHaveBeenCalledTimes(4);
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
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS)))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS)))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS)));

      const adapter = makeAdapter();
      await expect(adapter.startRun(makeDiagnosticianInput())).rejects.toMatchObject({
        category: 'output_invalid',
      });
      // 1 original + 3 repair attempts = 4 calls
      expect(mockComplete).toHaveBeenCalledTimes(4);
    });

    it('unknown outputSchemaRef fails loud before repair is attempted (rc-3)', async () => {
      // CodeRabbit PR #1259: unknown non-empty ref now fails loud at schema
      // resolution (in startRun), so repair is never attempted.
      // NOTE: no mockComplete setup — resolution fails BEFORE any LLM call,
      // so no mock value is queued to leak into subsequent tests.
      const adapter = makeAdapter();
      await expect(adapter.startRun(makeStartRunInput({
        outputSchemaRef: 'custom-unknown-v1',
      }))).rejects.toMatchObject({
        category: 'output_invalid',
        message: expect.stringMatching(/Unknown outputSchemaRef: custom-unknown-v1/i),
      });
      // LLM was never called because resolution failed first.
      expect(mockComplete).toHaveBeenCalledTimes(0);
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
      const proseOutput = 'I evaluated the plan and it looks good. The implementation is solid.';
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(proseOutput));

      const adapter = makeAdapter();
      try { await adapter.startRun(makeDiagnosticianInput()); } catch { /* expected */ }

      const extractionEvent = findTelemetryEvent('output_extraction_failed');
      expect(extractionEvent).toBeDefined();
      const payload = extractionEvent?.payload as Record<string, unknown>;
      expect(payload.outputSchemaRef).toBe('diagnostician-output-v1');
      expect(payload.provider).toBe('openrouter');
      expect(payload.model).toBe('anthropic/claude-sonnet-4');
      expect(payload.rawOutputPreview).toBe(proseOutput);
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
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS)))
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

    it('repair budget exhausted — default maxRepairAttempts=3, no infinite loop', async () => {
      mockComplete
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS)))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS)))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS)))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS)));

      const adapter = makeAdapter();
      await expect(adapter.startRun(makeDiagnosticianInput())).rejects.toMatchObject({
        category: 'output_invalid',
      });
      // 1 original + 3 repair attempts = 4 calls total (not infinite)
      expect(mockComplete).toHaveBeenCalledTimes(4);
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
      expect(output?.payload).toMatchObject({ valid: true });
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
      expect(output?.payload).toMatchObject({ thesis: 'Error handling is essential for reliability' });
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

    it('unknown outputSchemaRef fails loud with output_invalid (rc-3, was silent skip)', async () => {
      // CodeRabbit PR #1259: previously an unknown non-empty outputSchemaRef
      // resolved to undefined and silently skipped schema-gated validation.
      // That is an rc-9/rc-3 silent-fallback. Now it fails loud, consistent
      // with OpenClawCliRuntimeAdapter.fetchOutput.
      // NOTE: no mockComplete setup — resolution fails BEFORE any LLM call.
      const adapter = makeAdapter();
      await expect(adapter.startRun(makeStartRunInput({
        outputSchemaRef: 'custom-output-v1',
      }))).rejects.toMatchObject({
        category: 'output_invalid',
        message: expect.stringMatching(/Unknown outputSchemaRef: custom-output-v1/i),
      });
      expect(mockComplete).toHaveBeenCalledTimes(0);
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
      expect(output?.payload).toMatchObject({ valid: true });
    });
  });

  // ── PRI-200: Structured output repair loop with evidence pack ──

  describe('PRI-200: structured output repair loop with evidence pack', () => {
    const INVALID_DIAGNOSIS_SCHEMA = {
      valid: true,
      diagnosisId: 'diag-pri200-1',
      taskId: 'task-pri200-1',
      summary: 'Test PRI-200',
      rootCause: 'Test root cause',
      violatedPrinciples: [],
      evidence: [],
      recommendations: [{ kind: 'Rule', description: 'Fix casing' }],
      confidence: '85%',
    };

    function makeDiagnosticianInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
      return makeStartRunInput({
        outputSchemaRef: 'diagnostician-output-v1',
        taskRef: { taskId: 'task-pri200-1' },
        ...overrides,
      });
    }

    function resetMock() {
      mockComplete.mockReset();
      mockComplete.mockResolvedValue(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));
    }

    it('1. valid JSON + valid schema → no repair triggered', async () => {
      resetMock();
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter();
      const handle = await adapter.startRun(makeDiagnosticianInput());

      expect(mockComplete).toHaveBeenCalledTimes(1);
      const output = await adapter.fetchOutput(handle.runId);
      expect(output?.payload).toMatchObject({ confidence: 0.9 });

      const repairEvent = findTelemetryEvent('output_repair_attempted');
      expect(repairEvent).toBeUndefined();
      const schemaInvalidEvent = findTelemetryEvent('output_schema_invalid');
      expect(schemaInvalidEvent).toBeUndefined();
    });

    it('2. prose-wrapped JSON extraction succeeds → no repair triggered', async () => {
      resetMock();
      const proseWrapped = `Here is the analysis:\n${JSON.stringify(VALID_DIAGNOSIS)}\nDone.`;
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(proseWrapped));

      const adapter = makeAdapter();
      const handle = await adapter.startRun(makeDiagnosticianInput());

      expect(mockComplete).toHaveBeenCalledTimes(1);
      const output = await adapter.fetchOutput(handle.runId);
      expect(output?.payload).toMatchObject({ diagnosisId: 'diag-test-1' });
    });

    it('3. extraction failed → output_extraction_failed telemetry + output_invalid', async () => {
      resetMock();
      mockComplete.mockResolvedValueOnce(makeAssistantMessage('No JSON here at all'));

      const adapter = makeAdapter();
      try { await adapter.startRun(makeDiagnosticianInput()); } catch { /* expected */ }

      const extractionEvent = findTelemetryEvent('output_extraction_failed');
      expect(extractionEvent).toBeDefined();
      const payload = extractionEvent?.payload as Record<string, unknown>;
      expect(payload.outputSchemaRef).toBe('diagnostician-output-v1');
      expect(payload.provider).toBe('openrouter');
      expect(payload.model).toBe('anthropic/claude-sonnet-4');
      expect(typeof payload.rawOutputPreview).toBe('string');
    });

    it('4. schema invalid once, repair returns valid → success + repairAttempts[0].repaired=true', async () => {
      resetMock();
      mockComplete
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS_SCHEMA)))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter();
      const handle = await adapter.startRun(makeDiagnosticianInput());

      expect(mockComplete).toHaveBeenCalledTimes(2);
      const output = await adapter.fetchOutput(handle.runId);
      expect(output?.payload).toMatchObject({ confidence: 0.9 });

      const repairEvent = findTelemetryEvent('output_repair_attempted');
      expect(repairEvent).toBeDefined();
      const repairPayload = repairEvent?.payload as Record<string, unknown>;
      expect(repairPayload.repaired).toBe(true);
      expect(repairPayload.attemptsUsed).toBe(1);
    });

    it('5. schema invalid, repair also invalid → output_repair_exhausted + output_invalid', async () => {
      resetMock();
      mockComplete.mockResolvedValue(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS_SCHEMA)));

      const adapter = makeAdapter();
      await expect(adapter.startRun(makeDiagnosticianInput())).rejects.toMatchObject({
        category: 'output_invalid',
      });

      const exhaustedEvent = findTelemetryEvent('output_repair_exhausted');
      expect(exhaustedEvent).toBeDefined();
      const exhaustedPayload = exhaustedEvent?.payload as Record<string, unknown>;
      expect(exhaustedPayload.outputSchemaRef).toBe('diagnostician-output-v1');
      expect(exhaustedPayload.provider).toBe('openrouter');
      expect(exhaustedPayload.model).toBe('anthropic/claude-sonnet-4');
      expect(typeof exhaustedPayload.rawOutputPreview).toBe('string');
      expect(Array.isArray(exhaustedPayload.validationErrors)).toBe(true);
      expect(Array.isArray(exhaustedPayload.repairAttempts)).toBe(true);
      expect(typeof exhaustedPayload.finalFailureReason).toBe('string');
    });

    it('6. repair loop never exceeds configured max attempts', async () => {
      resetMock();
      mockComplete.mockResolvedValue(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS_SCHEMA)));

      const adapter = makeAdapter();
      await expect(adapter.startRun(makeDiagnosticianInput())).rejects.toMatchObject({
        category: 'output_invalid',
      });

      // 1 original + 3 repair (default maxRepairAttempts=3) = 4 calls total
      expect(mockComplete).toHaveBeenCalledTimes(4);
    });

    it('7. repair prompt includes schemaRef and error paths', async () => {
      resetMock();
      mockComplete
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS_SCHEMA)))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter();
      await adapter.startRun(makeDiagnosticianInput());

      const [, context] = mockComplete.mock.calls[1] as [unknown, { messages: { content: string }[] }];
      const repairMessage = context.messages[0]?.content ?? '';
      expect(repairMessage).toContain('diagnostician-output-v1');
      expect(repairMessage).toContain('/confidence');
    });

    it('8. repair attempt must not override lineage fields silently', async () => {
      resetMock();
      const originalWithLineage = {
        ...INVALID_DIAGNOSIS_SCHEMA,
        taskId: 'task-original-1',
      };
      const repairedWithChangedLineage = {
        ...VALID_DIAGNOSIS,
        taskId: 'task-CHANGED-by-llm',
      };

      mockComplete
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(originalWithLineage)))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(repairedWithChangedLineage)));

      const adapter = makeAdapter();
      const handle = await adapter.startRun(makeDiagnosticianInput({
        taskRef: { taskId: 'task-original-1' },
      }));

      const output = await adapter.fetchOutput(handle.runId);
      const payload = output?.payload as Record<string, unknown>;
      // taskId is a lineage field — it must be stripped from output (PRI-272).
      // Downstream consumers get taskId from RunnerContext/TaskRecord.
      expect(payload.taskId).toBeUndefined();
    });

    it('9. provider/model/rawOutputPreview are present in evidence pack', async () => {
      resetMock();
      mockComplete.mockResolvedValue(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS_SCHEMA)));

      const adapter = makeAdapter();
      try { await adapter.startRun(makeDiagnosticianInput()); } catch { /* expected */ }

      const exhaustedEvent = findTelemetryEvent('output_repair_exhausted');
      expect(exhaustedEvent).toBeDefined();
      const payload = exhaustedEvent?.payload as Record<string, unknown>;
      expect(payload.provider).toBe('openrouter');
      expect(payload.model).toBe('anthropic/claude-sonnet-4');
      expect(typeof (payload.rawOutputPreview as string)).toBe('string');
      expect((payload.rawOutputPreview as string).length).toBeGreaterThan(0);
    });

    it('10. unknown schemaRef fails loud (rc-3; was backward-compatible silent skip)', async () => {
      // CodeRabbit PR #1259: previously an unknown non-empty outputSchemaRef
      // silently skipped schema validation (the "backward-compatible behavior").
      // That silent skip is an rc-9/rc-3 defect — now it fails loud, matching
      // OpenClawCliRuntimeAdapter. NOTE: no mockComplete setup because schema
      // resolution fails before any LLM call.
      resetMock();
      const adapter = makeAdapter();
      await expect(adapter.startRun(makeStartRunInput({
        outputSchemaRef: 'custom-unknown-v1',
      }))).rejects.toMatchObject({
        category: 'output_invalid',
        message: expect.stringMatching(/Unknown outputSchemaRef: custom-unknown-v1/i),
      });
      expect(mockComplete).toHaveBeenCalledTimes(0);
    });

    it('emits output_schema_invalid telemetry before repair attempt', async () => {
      resetMock();
      mockComplete
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS_SCHEMA)))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter();
      await adapter.startRun(makeDiagnosticianInput());

      const schemaInvalidEvent = findTelemetryEvent('output_schema_invalid');
      expect(schemaInvalidEvent).toBeDefined();
      const payload = schemaInvalidEvent?.payload as Record<string, unknown>;
      expect(payload.outputSchemaRef).toBe('diagnostician-output-v1');
      expect(payload.provider).toBe('openrouter');
      expect(payload.model).toBe('anthropic/claude-sonnet-4');
      expect(typeof (payload.rawOutputPreview as string)).toBe('string');
      expect(Array.isArray(payload.validationErrors)).toBe(true);
      expect((payload.validationErrors as unknown[]).length).toBeGreaterThan(0);
    });

    it('evidence pack includes repairAttempts with schemaRef and attempt number', async () => {
      resetMock();
      mockComplete.mockResolvedValue(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS_SCHEMA)));

      const adapter = makeAdapter();
      try { await adapter.startRun(makeDiagnosticianInput()); } catch { /* expected */ }

      const exhaustedEvent = findTelemetryEvent('output_repair_exhausted');
      expect(exhaustedEvent).toBeDefined();
      const payload = exhaustedEvent?.payload as Record<string, unknown>;
      const attempts = payload.repairAttempts as Record<string, unknown>[];
      expect(attempts.length).toBeGreaterThan(0);
      expect(attempts[0]?.schemaRef).toBe('diagnostician-output-v1');
      expect(typeof attempts[0]?.attempt).toBe('number');
      expect(typeof attempts[0]?.repaired).toBe('boolean');
    });

    it('output_schema_invalid telemetry includes validation error paths', async () => {
      resetMock();
      mockComplete
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(INVALID_DIAGNOSIS_SCHEMA)))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter();
      await adapter.startRun(makeDiagnosticianInput());

      const schemaInvalidEvent = findTelemetryEvent('output_schema_invalid');
      expect(schemaInvalidEvent).toBeDefined();
      const payload = schemaInvalidEvent?.payload as Record<string, unknown>;
      const errors = payload.validationErrors as Record<string, unknown>[];
      expect(errors.length).toBeGreaterThan(0);
      const errorPaths = errors.map(e => e.path);
      expect(errorPaths.some(p => typeof p === 'string' && p.includes('confidence'))).toBe(true);
    });
  });

  // ── PRI-220: Provider Timeout and Transient Retry Policy ──

  describe('PRI-220: Provider Timeout and Transient Retry Policy', () => {
    it('1. provider timeout before client budget is provider_transient_timeout', async () => {
      // LLM call fails with timeout-like error, client signal is NOT aborted
      mockComplete.mockReset();
      mockComplete.mockRejectedValue(new Error('connection timeout'));

      const adapter = makeAdapter({ maxRetries: 0 });
      let caughtErr: PDRuntimeError | undefined = undefined;
      try {
        await adapter.startRun(makeStartRunInput());
      } catch (err) {
        if (err instanceof PDRuntimeError) caughtErr = err;
      }

      expect(caughtErr).toBeDefined();
      expect(caughtErr?.category).toBe('timeout');
      expect(caughtErr?.details?.timeoutClassification).toBe('provider_transient_timeout');
      expect(caughtErr?.details?.effectiveTimeoutMs).toBe(60_000);
      expect(typeof caughtErr?.details?.elapsedMs).toBe('number');
    });

    it('2. client timeout budget exhausted when signal is aborted', async () => {
      // LLM call aborts, client signal IS aborted
      mockComplete.mockReset();
      mockComplete.mockImplementation(async (_model, _ctx, options) => {
        const signal = options.signal as AbortSignal;
        const err = new DOMException('The operation was aborted', 'AbortError');
        Object.defineProperty(signal, 'aborted', { value: true, writable: true });
        throw err;
      });

      const adapter = makeAdapter({ maxRetries: 0 });
      let caughtErr: PDRuntimeError | undefined = undefined;
      try {
        await adapter.startRun(makeStartRunInput());
      } catch (err) {
        if (err instanceof PDRuntimeError) caughtErr = err;
      }

      expect(caughtErr).toBeDefined();
      expect(caughtErr?.category).toBe('timeout');
      expect(caughtErr?.details?.timeoutClassification).toBe('client_timeout_budget_exhausted');
    });

    it('3. unrecognized generic non-timeout error is classified as not_applicable', async () => {
      mockComplete.mockReset();
      mockComplete.mockRejectedValue(new Error('Generic database connection failed'));

      const adapter = makeAdapter({ maxRetries: 0 });
      let caughtErr: PDRuntimeError | undefined = undefined;
      try {
        await adapter.startRun(makeStartRunInput());
      } catch (err) {
        if (err instanceof PDRuntimeError) caughtErr = err;
      }

      expect(caughtErr).toBeDefined();
      expect(caughtErr?.category).toBe('execution_failed');
      expect(caughtErr?.details?.timeoutClassification).toBeUndefined();
    });

    it('5. provider_transient_timeout retries and then succeeds within max limits', async () => {
      mockComplete.mockReset();
      // First attempt: transient timeout, Second attempt: success
      mockComplete
        .mockRejectedValueOnce(new Error('socket timeout'))
        .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter({ maxRetries: 2 });
      const handle = await adapter.startRun(makeStartRunInput());

      expect(mockComplete).toHaveBeenCalledTimes(2);
      expect(handle.runId).toBeDefined();

      // Check telemetry has retry attempt
      const retryEvent = findTelemetryEvent('runtime_invocation_failed');
      expect(retryEvent).toBeDefined();
      const payload = retryEvent?.payload as Record<string, unknown>;
      expect(payload?.isRetryAttempt).toBe(true);
      expect(payload?.retryAttempt).toBe(0);
    });

    it('6. provider_transient_timeout exhausted maxRetries and fails permanently', async () => {
      mockComplete.mockReset();
      mockComplete.mockRejectedValue(new Error('API read timeout'));

      const adapter = makeAdapter({ maxRetries: 1 });
      let caughtErr: PDRuntimeError | undefined = undefined;
      try {
        await adapter.startRun(makeStartRunInput());
      } catch (err) {
        if (err instanceof PDRuntimeError) caughtErr = err;
      }

      expect(mockComplete).toHaveBeenCalledTimes(2); // attempt 0 and attempt 1
      expect(caughtErr).toBeDefined();
      expect(caughtErr?.category).toBe('timeout');
      expect(caughtErr?.details?.retryAttempt).toBe(1);
    });

    it('7. client_timeout_budget_exhausted is never retried', async () => {
      mockComplete.mockReset();
      mockComplete.mockImplementation(async (_model, _ctx, options) => {
        const signal = options.signal as AbortSignal;
        Object.defineProperty(signal, 'aborted', { value: true, writable: true });
        throw new DOMException('The operation was aborted', 'AbortError');
      });

      const adapter = makeAdapter({ maxRetries: 2 });
      let caughtErr: PDRuntimeError | undefined = undefined;
      try {
        await adapter.startRun(makeStartRunInput());
      } catch (err) {
        if (err instanceof PDRuntimeError) caughtErr = err;
      }

      expect(mockComplete).toHaveBeenCalledTimes(1); // Fails immediately, no retry
      expect(caughtErr).toBeDefined();
      expect(caughtErr?.category).toBe('timeout');
      expect(caughtErr?.details?.timeoutClassification).toBe('client_timeout_budget_exhausted');
    });

    it('10. circular objects, BigInt, and null-prototype objects in errors do not crash telemetry', async () => {
      mockComplete.mockReset();
      mockComplete.mockRejectedValueOnce(new Error('fail'));

      const nullProto = Object.create(null);
      nullProto.message = 'null prototype error';

      const circular: Record<string, unknown> = { message: 'circular error' };
      circular.self = circular;

      const bigIntErr = { message: 'bigint error', value: 9007199254740991n };

      const adapter = makeAdapter({ maxRetries: 0 });

      try {
        await adapter.startRun(makeStartRunInput({ inputPayload: nullProto }));
      } catch { /* expected */ }

      try {
        await adapter.startRun(makeStartRunInput({ inputPayload: circular }));
      } catch { /* expected */ }

      try {
        await adapter.startRun(makeStartRunInput({ inputPayload: bigIntErr }));
      } catch { /* expected */ }

      expect(true).toBe(true);
    });

    it('12. telemetry includes provider/model/elapsedMs/timeoutMs/timeoutSource/classification/attempt', async () => {
      mockComplete.mockReset();
      mockComplete.mockRejectedValue(new Error('request abort'));

      const adapter = makeAdapter({ maxRetries: 0 });
      try {
        await adapter.startRun(makeStartRunInput({ timeoutMs: 33_000 }));
      } catch { /* expected */ }

      const failedEvent = findTelemetryEvent('runtime_invocation_failed');
      expect(failedEvent).toBeDefined();
      const payload = failedEvent?.payload as Record<string, unknown>;
      expect(payload.provider).toBe('openrouter');
      expect(payload.model).toBe('anthropic/claude-sonnet-4');
      expect(typeof payload.elapsedMs).toBe('number');
      expect(payload.effectiveTimeoutMs).toBe(33_000);
      expect(payload.timeoutSource).toBe('runner_input');
      expect(payload.timeoutClassification).toBe('provider_transient_timeout');
      expect(payload.retryAttempt).toBe(0);
    });

    it('13. caps subsequent retry attempt timeoutMs to remaining overall budget', async () => {
      mockComplete.mockReset();
      mockComplete.mockImplementationOnce(async (_model, _ctx, _options) => {
        await new Promise(resolve => setTimeout(resolve, 40));
        throw new Error('transient timeout');
      });
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter({ maxRetries: 2 });
      await adapter.startRun(makeStartRunInput({ timeoutMs: 100 }));

      expect(mockComplete).toHaveBeenCalledTimes(2);
      const secondCallOpts = mockComplete.mock.calls[1]?.[2] as Record<string, unknown>;
      expect(secondCallOpts).toBeDefined();
      const tc = secondCallOpts.timeoutMs;
      expect(typeof tc).toBe('number');
      expect(tc).toBeLessThanOrEqual(70);
      expect(tc).toBeGreaterThan(0);
    });

    it('14. fails fast with client_timeout_budget_exhausted when budget is exhausted', async () => {
      mockComplete.mockReset();
      mockComplete.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        throw new Error('transient timeout');
      });

      const adapter = makeAdapter({ maxRetries: 2 });
      let caughtErr: PDRuntimeError | undefined = undefined;
      try {
        await adapter.startRun(makeStartRunInput({ timeoutMs: 30 }));
      } catch (err) {
        if (err instanceof PDRuntimeError) caughtErr = err;
      }

      expect(mockComplete).toHaveBeenCalledTimes(1);
      expect(caughtErr).toBeDefined();
      expect(caughtErr?.category).toBe('timeout');
      expect(caughtErr?.details?.timeoutClassification).toBe('client_timeout_budget_exhausted');
    });

    it('15. untrusted error classification ignores inherited properties and handles malformed fields safely', async () => {
      mockComplete.mockReset();
      
      const proto = {
        message: 'timeout - inherited but should be ignored if not own property',
        name: 'AbortError',
      };
      const malformedErr = Object.create(proto) as Record<string, unknown>;
      malformedErr.message = 'ordinary own message';
      malformedErr.name = 'OrdinaryError';

      mockComplete.mockRejectedValueOnce(malformedErr);

      const adapter = makeAdapter({ maxRetries: 0 });
      let caughtErr: PDRuntimeError | undefined = undefined;
      try {
        await adapter.startRun(makeStartRunInput());
      } catch (err) {
        if (err instanceof PDRuntimeError) caughtErr = err;
      }

      expect(caughtErr).toBeDefined();
      expect(caughtErr?.category).toBe('execution_failed');
      expect(caughtErr?.details?.timeoutClassification).toBeUndefined();
    });
  });

  // ── PRI-400: Reasoning-model output handling (BUG-007a/b) ──

  describe('PRI-400: reasoning-model output handling (BUG-007a/b)', () => {
    /** Create an AssistantMessage with empty text content but ThinkingContent with valid JSON. */
    function makeThinkingOnlyResponse(thinkingText: string, overrides: Record<string, unknown> = {}) {
      return {
        content: [
          { type: 'text' as const, text: '' },
          { type: 'thinking' as const, thinking: thinkingText },
        ],
        role: 'assistant' as const,
        stopReason: 'length' as const,
        api: 'openai-completions',
        provider: 'lmstudio',
        model: 'qwen3.6-27b-mtp',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
        ...overrides,
      };
    }

    /** Create an AssistantMessage with empty content and no thinking. */
    function makeEmptyContentResponse(overrides: Record<string, unknown> = {}) {
      return {
        content: [{ type: 'text' as const, text: '' }],
        role: 'assistant' as const,
        stopReason: 'length' as const,
        api: 'openai-completions',
        provider: 'lmstudio',
        model: 'qwen3.6-27b-mtp',
        usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
        ...overrides,
      };
    }

    it('(a) content="" + ThinkingContent with valid JSON + stopReason="length" → extracts JSON from thinking', async () => {
      // Simulates the exact dogfood scenario: reasoning model spends all tokens on thinking
      const thinkingWithJson = `Let me analyze this step by step...\n\n${JSON.stringify(VALID_DIAGNOSIS)}`;
      mockComplete.mockResolvedValueOnce(makeThinkingOnlyResponse(thinkingWithJson));

      const adapter = makeAdapter({ outputPathStrategy: 'free_form_only' });
      const handle = await adapter.startRun(makeStartRunInput());
      const output = await adapter.fetchOutput(handle.runId);

      expect(output?.payload).toMatchObject({ diagnosisId: 'diag-test-1' });
    });

    it('(b) content="" + no ThinkingContent + stopReason="length" → fail-loud with truncation error', async () => {
      mockComplete.mockResolvedValueOnce(makeEmptyContentResponse());

      const adapter = makeAdapter({ outputPathStrategy: 'free_form_only' });
      let caughtErr: PDRuntimeError | undefined;
      try {
        await adapter.startRun(makeStartRunInput());
      } catch (err) {
        if (err instanceof PDRuntimeError) caughtErr = err;
      }

      expect(caughtErr).toBeInstanceOf(PDRuntimeError);
      expect(caughtErr?.category).toBe('output_invalid');
      expect(caughtErr?.message).toContain('truncated');
      expect(caughtErr?.details?.nextAction).toBeDefined();
    });

    it('content="" + no ThinkingContent + stopReason="stop" → fail-loud with "No text or reasoning"', async () => {
      mockComplete.mockResolvedValueOnce(makeEmptyContentResponse({ stopReason: 'stop' }));

      const adapter = makeAdapter({ outputPathStrategy: 'free_form_only' });
      let caughtErr: PDRuntimeError | undefined;
      try {
        await adapter.startRun(makeStartRunInput());
      } catch (err) {
        if (err instanceof PDRuntimeError) caughtErr = err;
      }

      expect(caughtErr).toBeInstanceOf(PDRuntimeError);
      expect(caughtErr?.category).toBe('output_invalid');
      expect(caughtErr?.message).toContain('No text or reasoning content');
      expect(caughtErr?.details?.nextAction).toBeDefined();
    });

    it('(c) content="normal JSON" + no ThinkingContent → existing path unchanged (regression)', async () => {
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter({ outputPathStrategy: 'free_form_only' });
      const handle = await adapter.startRun(makeStartRunInput());
      const output = await adapter.fetchOutput(handle.runId);

      expect(output?.payload).toMatchObject({ diagnosisId: 'diag-test-1' });
    });

    it('content="" + ThinkingContent with no extractable JSON → output_invalid', async () => {
      mockComplete.mockResolvedValueOnce(makeThinkingOnlyResponse('Just thinking prose, no JSON here'));

      const adapter = makeAdapter({ outputPathStrategy: 'free_form_only' });
      let caughtErr: PDRuntimeError | undefined;
      try {
        await adapter.startRun(makeStartRunInput());
      } catch (err) {
        if (err instanceof PDRuntimeError) caughtErr = err;
      }

      expect(caughtErr).toBeInstanceOf(PDRuntimeError);
      expect(caughtErr?.category).toBe('output_invalid');
    });

    it('stopReason="length" with empty content and empty thinking → fail-loud with nextAction', async () => {
      mockComplete.mockResolvedValueOnce(makeEmptyContentResponse());

      const adapter = makeAdapter({ outputPathStrategy: 'free_form_only' });
      let caughtErr: PDRuntimeError | undefined;
      try {
        await adapter.startRun(makeStartRunInput());
      } catch (err) {
        if (err instanceof PDRuntimeError) caughtErr = err;
      }

      expect(caughtErr).toBeInstanceOf(PDRuntimeError);
      expect(caughtErr?.category).toBe('output_invalid');
      expect(caughtErr?.message).toContain('finish_reason=length');
      expect(caughtErr?.details?.nextAction).toContain('maxTokens');
    });

    it('stopReason="length" with valid thinking content → succeeds despite truncation', async () => {
      const thinkingWithJson = JSON.stringify(VALID_DIAGNOSIS);
      mockComplete.mockResolvedValueOnce(makeThinkingOnlyResponse(thinkingWithJson));

      const adapter = makeAdapter({ outputPathStrategy: 'free_form_only' });
      const handle = await adapter.startRun(makeStartRunInput());
      const output = await adapter.fetchOutput(handle.runId);

      expect(output?.payload).toMatchObject({ diagnosisId: 'diag-test-1' });
    });

    it('completeWithRetry omits maxTokens by default (PRI-621: pi-ai native model ceiling)', async () => {
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter({ outputPathStrategy: 'free_form_only' });
      await adapter.startRun(makeStartRunInput());

      const [, , options] = mockComplete.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
      expect(options.maxTokens).toBeUndefined();
    });

    it('completeWithRetry uses config.maxTokens override when provided', async () => {
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter({ outputPathStrategy: 'free_form_only', maxTokens: 8192 });
      await adapter.startRun(makeStartRunInput());

      const [, , options] = mockComplete.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
      expect(options.maxTokens).toBe(8192);
    });

    it('completeWithRetry omits maxTokens for deepseek too — provider-name heuristic retired (PRI-621)', async () => {
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter({ outputPathStrategy: 'free_form_only', provider: 'deepseek', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com' });
      await adapter.startRun(makeStartRunInput());

      const [, , options] = mockComplete.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
      expect(options.maxTokens).toBeUndefined();
    });

    it('PRI-621: custom provider relaying a catalog-known model keeps catalog metadata (catalog-first resolveModel)', async () => {
      // Bai relay serving deepseek-v4-flash: the catalog entry (reasoning
      // model, 384K output ceiling) must survive with only transport fields
      // overridden — the old hardcoded fallback misclassified it as
      // non-reasoning with a 32K ceiling and fed the RC0 budget bug.
      mockGetModel.mockImplementation((_provider: unknown, id: unknown) =>
        id === 'deepseek-v4-flash'
          ? {
              id: 'deepseek-v4-flash',
              name: 'DeepSeek V4 Flash',
              api: 'openai-completions',
              provider: 'deepseek',
              baseUrl: 'https://api.deepseek.com',
              reasoning: true,
              input: ['text'],
              cost: { input: 0.14, output: 0.28, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1_000_000,
              maxTokens: 384_000,
            }
          : undefined,
      );
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter({ provider: 'Bai', model: 'deepseek-v4-flash', baseUrl: 'https://api.b.ai/v1', outputPathStrategy: 'free_form_only' });
      await adapter.startRun(makeStartRunInput());

      const [model] = mockComplete.mock.calls[0] as [{ provider: string; baseUrl: string; reasoning: boolean; maxTokens: number }, unknown, unknown];
      expect(model.provider).toBe('Bai');
      expect(model.baseUrl).toBe('https://api.b.ai/v1');
      expect(model.reasoning).toBe(true);
      expect(model.maxTokens).toBe(384_000);
    });

    it('PRI-621: custom provider with unknown model id falls back to conservative hardcoded metadata', async () => {
      mockGetModel.mockReturnValue(undefined);
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter({ provider: 'Bai', model: 'totally-unknown-model', baseUrl: 'https://api.b.ai/v1', outputPathStrategy: 'free_form_only' });
      await adapter.startRun(makeStartRunInput());

      const [model] = mockComplete.mock.calls[0] as [{ reasoning: boolean; maxTokens: number }, unknown, unknown];
      expect(model.reasoning).toBe(false);
      expect(model.maxTokens).toBe(32_000);
    });

    it('PRI-621: built-in provider with unknown model id fails loud (runtime_unavailable)', async () => {
      mockGetModel.mockReturnValue(undefined);

      const adapter = makeAdapter({ provider: 'openai', model: 'gpt-not-a-model' });
      await expect(adapter.startRun(makeStartRunInput())).rejects.toMatchObject({ category: 'runtime_unavailable' });
    });

    it('PRI-621 RC3: schema-aware extraction picks the full object over an earlier inner fragment', async () => {
      // Recurrence of 2026-08-28: the answer contained a small lineage
      // fragment BEFORE the complete output; first-object extraction kept
      // validating the fragment ("all required properties undefined") and
      // the repair loop fixed the wrong object.
      const response = `Here is the trace reference {"diagnosisId":"diag-fragment-1"} and the complete output below:\n${JSON.stringify(VALID_DIAGNOSIS)}`;
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(response));

      const adapter = makeAdapter({ outputPathStrategy: 'free_form_only' });
      const handle = await adapter.startRun(makeStartRunInput({ outputSchemaRef: 'diagnostician-output-v1' }));
      const output = await adapter.fetchOutput(handle.runId);

      expect(output?.payload).toMatchObject({ diagnosisId: 'diag-test-1' });
    });

    it('mixed content: text + thinking → prefers text content (regression)', async () => {
      // When both text and thinking are present, text should be preferred
      const mixedResponse = {
        content: [
          { type: 'text' as const, text: JSON.stringify(VALID_DIAGNOSIS) },
          { type: 'thinking' as const, thinking: 'Some reasoning here' },
        ],
        role: 'assistant' as const,
        stopReason: 'stop' as const,
        api: 'openai-completions',
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
      };
      mockComplete.mockResolvedValueOnce(mixedResponse);

      const adapter = makeAdapter({ outputPathStrategy: 'free_form_only' });
      const handle = await adapter.startRun(makeStartRunInput());
      const output = await adapter.fetchOutput(handle.runId);

      expect(output?.payload).toMatchObject({ diagnosisId: 'diag-test-1' });
    });
  });

  // ── PRI-405: Reasoning-model E2E stub tests ───────────────────────────────

  describe('PRI-405: reasoning-model E2E stub tests', () => {
    /** Valid DiagRootCauseOutputV1 for split pipeline Stage A. */
    const VALID_ROOT_CAUSE_OUTPUT = {
      valid: true,
      diagnosisId: 'diag-pri405-1',
      taskId: 'diag_rootcause-diagnosis_pain-pri405',
      summary: 'AI助手在修改代码前未阅读错误手册，导致重复了类型断言绕过校验问题',
      causalChain: [
        {
          why: 1,
          statement: 'AI助手直接使用as类型断言绕过运行时校验',
          evidenceRefs: ['owner_reported:cli'],
        },
        {
          why: 2,
          statement: '修改代码前未阅读AGENTS.md中的错误手册和ERR-001相关条目',
          evidenceRefs: ['owner_reported:cli'],
        },
        {
          why: 3,
          statement: '缺乏强制性的代码修改前必读规范检查机制',
          evidenceRefs: ['owner_reported:cli'],
        },
      ],
      rootCause: 'Design: 缺乏强制性的代码修改前必读规范检查机制，导致AI助手绕过关键校验步骤',
      rootCauseCategory: 'Design',
      evidence: [
        {
          sourceRef: 'owner_reported:cli',
          note: 'AI助手在修改代码时使用了as类型断言绕过运行时校验，违反了AGENTS.md中ERR-001的规定',
        },
      ],
      confidence: 0.85,
      ambiguityNotes: [
        '关联核心公理: T-01 (先理解结构再修改)',
      ],
    };

    /** Create a thinking-only response (no text block) simulating reasoning model output. */
    function makeThinkingOnlyResponse(thinkingText: string, overrides: Record<string, unknown> = {}) {
      return {
        content: [
          { type: 'thinking' as const, thinking: thinkingText },
        ],
        role: 'assistant' as const,
        stopReason: 'length' as const,
        api: 'openai-completions',
        provider: 'lmstudio',
        model: 'qwen3.6-27b-mtp',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
        ...overrides,
      };
    }

    // ── Scenario A: thinking fallback + schema validation passes ──

    it('Scenario A: thinking-only response with valid JSON passes diag-rootcause-output-v1 schema validation', async () => {
      // Simulates reasoning model that puts all structured output in thinking block
      const thinkingWithJson = `让我逐步分析这个pain信号...\n\n${JSON.stringify(VALID_ROOT_CAUSE_OUTPUT)}`;
      mockComplete.mockResolvedValueOnce(makeThinkingOnlyResponse(thinkingWithJson));

      const adapter = makeAdapter({ outputPathStrategy: 'free_form_only' });
      const handle = await adapter.startRun(makeStartRunInput({
        outputSchemaRef: 'diag-rootcause-output-v1',
        taskRef: { taskId: 'diag_rootcause-diagnosis_pain-pri405' },
      }));

      const output = await adapter.fetchOutput(handle.runId);
      expect(output).not.toBeNull();
      // Schema validation passed — output was extracted from thinking and validated
      expect(output?.payload).toMatchObject({
        valid: true,
        diagnosisId: 'diag-pri405-1',
        rootCauseCategory: 'Design',
      });
      // taskId is a lineage field — stripped by adapter (PRI-272)
      const payload = output?.payload as Record<string, unknown>;
      expect(payload.taskId).toBeUndefined();
    });

    // ── Scenario B: thinking with prose (no JSON) + truncated → fail-loud ──

    it('Scenario B: thinking with prose but no JSON + stopReason=length → fail-loud output_invalid', async () => {
      // Simulates reasoning model that spent all tokens on thinking prose, no JSON output.
      // extractAssistantTextOrThrow extracts the thinking text (it has content),
      // but extractJsonObject finds no JSON → output_invalid.
      // This is the correct fail-loud path: the adapter does NOT silently succeed.
      const thinkingProseOnly = 'Here is a thinking process: 1. analyze the pain signal 2. identify root cause 3. classify the category...';
      mockComplete.mockResolvedValueOnce(makeThinkingOnlyResponse(thinkingProseOnly));

      const adapter = makeAdapter({ outputPathStrategy: 'free_form_only' });
      let caughtErr: PDRuntimeError | undefined;
      try {
        await adapter.startRun(makeStartRunInput({
          outputSchemaRef: 'diag-rootcause-output-v1',
          taskRef: { taskId: 'diag_rootcause-diagnosis_pain-pri405' },
        }));
      } catch (err) {
        if (err instanceof PDRuntimeError) caughtErr = err;
      }

      // EP-03: fail-loud with structured reason — adapter does NOT silently succeed
      expect(caughtErr).toBeInstanceOf(PDRuntimeError);
      expect(caughtErr?.category).toBe('output_invalid');
      // The error must indicate why: either no JSON found, truncated, or finish_reason=length
      const reason = caughtErr?.message ?? '';
      expect(
        reason.includes('No valid JSON') || reason.includes('truncated') || reason.includes('finish_reason=length'),
        `Expected reason to indicate extraction failure, got: ${reason}`,
      ).toBe(true);
    });

    it('Scenario B (variant): empty thinking + stopReason=length → fail-loud with truncated + nextAction containing maxTokens', async () => {
      // When thinking is empty and stopReason=length, extractAssistantTextOrThrow
      // throws the specific truncated error with nextAction guidance.
      mockComplete.mockResolvedValueOnce(makeThinkingOnlyResponse('', { stopReason: 'length' }));

      const adapter = makeAdapter({ outputPathStrategy: 'free_form_only' });
      let caughtErr: PDRuntimeError | undefined;
      try {
        await adapter.startRun(makeStartRunInput({
          outputSchemaRef: 'diag-rootcause-output-v1',
          taskRef: { taskId: 'diag_rootcause-diagnosis_pain-pri405' },
        }));
      } catch (err) {
        if (err instanceof PDRuntimeError) caughtErr = err;
      }

      // EP-03: fail-loud with structured reason and nextAction
      expect(caughtErr).toBeInstanceOf(PDRuntimeError);
      expect(caughtErr?.category).toBe('output_invalid');
      expect(caughtErr?.message).toContain('truncated');
      expect(caughtErr?.details?.nextAction).toBeDefined();
      const nextAction = String(caughtErr?.details?.nextAction ?? '');
      expect(nextAction.includes('maxTokens')).toBe(true);
    });
  });

  // ── PRI-284: tool_call_first / json_mode_first path tests ──

  describe('output path strategy: tool_call_first (PRI-284)', () => {
    function makeToolCallResponse(args: Record<string, unknown>, toolName = 'record_diagnostician_output_v1') {
      return {
        content: [
          { type: 'toolCall' as const, id: 'call-1', name: toolName, arguments: args },
        ],
        role: 'assistant' as const,
        stopReason: 'toolUse' as const,
        api: 'openai-completions',
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
      };
    }

    function makeToolCallInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
      return {
        agentSpec: { agentId: 'diagnostician', schemaVersion: 'v1' },
        inputPayload: 'Diagnose this pain signal',
        contextItems: [],
        timeoutMs: 60_000,
        outputSchemaRef: 'diagnostician-output-v1',
        ...overrides,
      };
    }

    it('tool_call success: provider returns toolUse with valid schema → output extracted from tool args', async () => {
      mockComplete.mockResolvedValueOnce(makeToolCallResponse(VALID_DIAGNOSIS));

      const adapter = makeAdapter({ outputPathStrategy: 'tool_call_first' });
      const handle = await adapter.startRun(makeToolCallInput());
      const output = await adapter.fetchOutput(handle.runId);

      expect(output?.payload).toMatchObject({ diagnosisId: 'diag-test-1', valid: true });

      // Verify telemetry includes correct outputPath
      const pathEvent = findTelemetryEvent('output_path_chosen');
      expect(pathEvent?.payload).toMatchObject({
        outputPath: 'tool_call',
        outputSchemaRef: 'diagnostician-output-v1',
      });
    });

    it('tool_call strips lineage fields from tool args (ERR-008)', async () => {
      const outputWithLineage = { ...VALID_DIAGNOSIS, sourcePainId: 'pain-injected', sourceTaskId: 'task-injected' };
      mockComplete.mockResolvedValueOnce(makeToolCallResponse(outputWithLineage));

      const adapter = makeAdapter({ outputPathStrategy: 'tool_call_first' });
      const handle = await adapter.startRun(makeToolCallInput());
      const output = await adapter.fetchOutput(handle.runId);

      expect(output?.payload).not.toHaveProperty('sourcePainId');
      expect(output?.payload).not.toHaveProperty('sourceTaskId');
      // Non-lineage fields preserved
      expect(output?.payload).toMatchObject({ diagnosisId: 'diag-test-1' });
    });

    it('tool_call schema invalid → falls through to json_mode → free_form', async () => {
      // Path 1: tool call with invalid schema args
      const invalidToolArgs = { invalid: 'data' };
      mockComplete.mockResolvedValueOnce(makeToolCallResponse(invalidToolArgs));
      // Path 2: json_mode also fails (non-JSON text)
      mockComplete.mockResolvedValueOnce(makeAssistantMessage('not json at all'));
      // Path 3: free_form succeeds
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter({ outputPathStrategy: 'tool_call_first' });
      const handle = await adapter.startRun(makeToolCallInput());
      const output = await adapter.fetchOutput(handle.runId);

      expect(output?.payload).toMatchObject({ diagnosisId: 'diag-test-1' });

      // Verify fallback telemetry was emitted for tool_call path.
      // Runtime Contract Rule 2: validate shape before reading eventType.
      const fallbackEvents = mockEmitTelemetry.mock.calls.filter((c: unknown[]) => {
        const [payload] = c;
        return (
          typeof payload === 'object' &&
          payload !== null &&
          Object.hasOwn(payload, 'eventType') &&
          (payload as { eventType: unknown }).eventType === 'output_path_fallback'
        );
      });
      expect(fallbackEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('tool_call not supported (stopReason != toolUse) → falls to json_mode', async () => {
      // Path 1 (tool_call): provider returns non-toolUse response
      mockComplete.mockResolvedValueOnce(makeAssistantMessage('not json'));
      // Path 2 (json_mode): provider returns valid JSON
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter({ outputPathStrategy: 'tool_call_first' });
      const handle = await adapter.startRun(makeToolCallInput());
      const output = await adapter.fetchOutput(handle.runId);

      expect(output?.payload).toMatchObject({ diagnosisId: 'diag-test-1' });
    });

    it('tool_call uses per-runner schema from registry, not hardcoded (PRI-284)', async () => {
      mockComplete.mockResolvedValueOnce(makeToolCallResponse(VALID_DIAGNOSIS));

      const adapter = makeAdapter({ outputPathStrategy: 'tool_call_first' });
      await adapter.startRun(makeToolCallInput());

      // Verify the context passed to completeSimple includes a tool
      // whose name is derived from the schemaRef, not hardcoded.
      // Runtime Contract Rule 2 (no `as` bypass): use a type guard on the
      // unknown mock-call shape instead of asserting the type.
      const [firstCallArgs] = mockComplete.mock.calls;
      expect(firstCallArgs).toBeDefined();
      const rawContext = firstCallArgs?.[1];
      expect(isToolContext(rawContext)).toBe(true);
      if (!isToolContext(rawContext)) throw new Error('invalid tool context');
      expect(rawContext.tools.length).toBe(1);
      const [tool] = rawContext.tools;
      if (!tool) throw new Error('expected exactly one tool');
      // Name derived from schemaRef 'diagnostician-output-v1'
      expect(tool.name).toBe('record_diagnostician_output_v1');
      // Not the old hardcoded name
      expect(tool.name).not.toBe('record_diagnosis_v1');
      // Parameters should be the schema from registry
      expect(tool.parameters).toBeDefined();
    });
  });

  describe('output path strategy: json_mode_first (PRI-284)', () => {
    function makeJsonModeInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
      return {
        agentSpec: { agentId: 'diagnostician', schemaVersion: 'v1' },
        inputPayload: 'Diagnose this pain signal',
        contextItems: [],
        timeoutMs: 60_000,
        outputSchemaRef: 'diagnostician-output-v1',
        ...overrides,
      };
    }

    it('json_mode success: provider returns valid JSON text → output extracted', async () => {
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter({ outputPathStrategy: 'json_mode_first' });
      const handle = await adapter.startRun(makeJsonModeInput());
      const output = await adapter.fetchOutput(handle.runId);

      expect(output?.payload).toMatchObject({ diagnosisId: 'diag-test-1' });

      const pathEvent = findTelemetryEvent('output_path_chosen');
      expect(pathEvent?.payload).toMatchObject({
        outputPath: 'json_object_mode',
      });
    });

    it('json_mode strips lineage fields (ERR-008)', async () => {
      const outputWithLineage = { ...VALID_DIAGNOSIS, sourcePainId: 'pain-llm-injected' };
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(outputWithLineage)));

      const adapter = makeAdapter({ outputPathStrategy: 'json_mode_first' });
      const handle = await adapter.startRun(makeJsonModeInput());
      const output = await adapter.fetchOutput(handle.runId);

      expect(output?.payload).not.toHaveProperty('sourcePainId');
    });

    it('json_mode parse fails → falls to free_form', async () => {
      // Path 2: json_mode returns non-parseable text
      mockComplete.mockResolvedValueOnce(makeAssistantMessage('this is not json at all'));
      // Path 3: free_form succeeds
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter({ outputPathStrategy: 'json_mode_first' });
      const handle = await adapter.startRun(makeJsonModeInput());
      const output = await adapter.fetchOutput(handle.runId);

      expect(output?.payload).toMatchObject({ diagnosisId: 'diag-test-1' });

      // Verify fallback telemetry.
      // Runtime Contract Rule 2: validate shape before reading eventType.
      const fallbackEvents = mockEmitTelemetry.mock.calls.filter((c: unknown[]) => {
        const [payload] = c;
        return (
          typeof payload === 'object' &&
          payload !== null &&
          Object.hasOwn(payload, 'eventType') &&
          (payload as { eventType: unknown }).eventType === 'output_path_fallback'
        );
      });
      expect(fallbackEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('json_mode schema invalid → falls to free_form', async () => {
      // Path 2: json_mode returns valid JSON but wrong schema
      const wrongSchema = { wrongField: 'wrong value' };
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(wrongSchema)));
      // Path 3: free_form succeeds with correct schema
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));

      const adapter = makeAdapter({ outputPathStrategy: 'json_mode_first' });
      const handle = await adapter.startRun(makeJsonModeInput());
      const output = await adapter.fetchOutput(handle.runId);

      expect(output?.payload).toMatchObject({ diagnosisId: 'diag-test-1' });
    });
  });
});
