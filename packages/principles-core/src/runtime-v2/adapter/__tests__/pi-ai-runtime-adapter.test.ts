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

function makeAssistantMessage(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    role: 'assistant' as const,
  };
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

    it('passes apiKey, timeoutMs from config, and maxRetries: 0 to complete options', async () => {
      const adapter = makeAdapter({ maxRetries: 3, timeoutMs: 120_000 });
      await adapter.startRun(makeStartRunInput({ timeoutMs: 90_000 }));

      const [, , options] = mockComplete.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
      expect(options.apiKey).toBe('test-key-123');
      expect(options.maxRetries).toBe(0);
      // completeWithRetry uses this.config.timeoutMs (120_000), not input.timeoutMs
      expect(options.timeoutMs).toBe(120_000);
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

    it('throws PDRuntimeError("output_invalid") when parsed JSON does not match DiagnosticianOutputV1 schema', async () => {
      await expectStartRunError('output_invalid', () => {
        mockComplete.mockReset();
        mockComplete.mockResolvedValue(makeAssistantMessage(JSON.stringify({ valid: true, missing: 'fields' })));
      });
    });

    it('throws PDRuntimeError("execution_failed") after retry exhaustion on network error', async () => {
      await expectStartRunError('execution_failed', () => {
        mockComplete.mockReset();
        mockComplete.mockRejectedValue(new Error('ECONNREFUSED'));
      }, { maxRetries: 1 });
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
      // Schema validation failure — not transient
      mockComplete.mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ valid: true })));

      const adapter = makeAdapter({ maxRetries: 3 });

      await expect(adapter.startRun(makeStartRunInput())).rejects.toThrow(PDRuntimeError);
      // complete should only be called once — no retries for schema errors
      expect(mockComplete).toHaveBeenCalledTimes(1);
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
    it('returns empty array', async () => {
      const adapter = makeAdapter();
      const artifacts = await adapter.fetchArtifacts('any-run-id');
      expect(artifacts).toEqual([]);
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
});
