/**
 * Runtime Config Contract tests (PRI-103).
 *
 * Locks down provider/model/timeout precedence across runner and adapter layers.
 * Retry backoff is owned by the task lifecycle layer, not this adapter contract.
 * Any change to the timeout precedence chain
 * MUST update this file.
 *
 * Precedence (highest → lowest):
 *   1. input.timeoutMs (from CLI --timeout-ms via runner StartRunInput)
 *   2. config.timeoutMs (from workflows.yaml via PiAiRuntimeAdapterConfig)
 *   3. 300_000 (hardcoded default)
 *
 * Telemetry contract (runtime_invocation_started):
 *   - timeoutMs: effective timeout in ms
 *   - timeoutSource: 'runner_input' | 'adapter_config' | 'default'
 *   - provider: LLM provider name
 *   - model: model ID string
 *   - runnerKind: agent/runner identifier from StartRunInput.agentSpec.agentId
 *   - outputSchemaRef: schema reference for output validation
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @mariozechner/pi-ai
vi.mock('@mariozechner/pi-ai', () => ({
  getModel: vi.fn(),
  getProviders: vi.fn(() => ['openrouter', 'anthropic', 'openai', 'google']),
  complete: vi.fn(),
  completeSimple: vi.fn(),
}));

// Mock store/event-emitter
vi.mock('../../store/event-emitter.js', () => ({
  storeEmitter: { emitTelemetry: vi.fn() },
}));

import { complete, completeSimple, getModel } from '@mariozechner/pi-ai';
import { storeEmitter } from '../../store/event-emitter.js';
import { PiAiRuntimeAdapter } from '../pi-ai-runtime-adapter.js';
import type { StartRunInput } from '../../runtime-protocol.js';

const mockComplete = complete as ReturnType<typeof vi.fn>;
const mockCompleteSimple = completeSimple as ReturnType<typeof vi.fn>;
const mockGetModel = getModel as ReturnType<typeof vi.fn>;
const mockEmitTelemetry = storeEmitter.emitTelemetry as ReturnType<typeof vi.fn>;

const VALID_DIAGNOSIS = {
  valid: true,
  diagnosisId: 'diag-contract-1',
  taskId: 'task-contract-1',
  summary: 'Contract test',
  rootCause: 'Test',
  violatedPrinciples: [],
  evidence: [],
  recommendations: [{ kind: 'defer', description: 'no actionable recommendation' }],
  confidence: 0.9,
};

// Matches DreamerOutputV1Schema for outputSchemaRef: 'dreamer-output-v1' tests
const VALID_DREAMER_OUTPUT = {
  valid: true,
  taskId: 'task-contract-dreamer',
  candidates: [{
    candidateIndex: 0,
    badDecision: 'Ignored error',
    betterDecision: 'Handle error properly',
    rationale: 'Prevents crashes',
    confidence: 0.85,
    riskLevel: 'low',
    strategicPerspective: 'defensive-programming',
  }],
  contextRefs: [],
  generatedAt: new Date().toISOString(),
};

function makeAssistantMessage(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    role: 'assistant' as const,
    stopReason: 'stop' as const,
    api: 'openai-completions',
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  };
}

function makeStartRunInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    agentSpec: { agentId: 'diagnostician', schemaVersion: 'v1' },
    inputPayload: 'Generate a principle',
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

/** Extract telemetry event matching eventType from mock calls. */
function findTelemetryEvent(eventType: string): Record<string, unknown> | undefined {
  const call = mockEmitTelemetry.mock.calls.find(
    (c: unknown[]) => (c[0] as Record<string, unknown>).eventType === eventType,
  );
  return call ? (call[0] as Record<string, unknown>) : undefined;
}

function requireTelemetryPayload(eventType: string): Record<string, unknown> {
  const event = findTelemetryEvent(eventType);
  expect(event).toBeDefined();
  return event?.payload as Record<string, unknown>;
}

describe('Runtime Config Contract (PRI-103)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TEST_API_KEY = 'test-key-123';
    // resolveModel fails loud on unknown catalog ids (PRI-621) — give the
    // default fixture model a catalog entry like the sibling adapter tests.
    mockGetModel.mockReturnValue({ id: 'anthropic/claude-sonnet-4' });
    mockComplete.mockResolvedValue(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));
    mockCompleteSimple.mockResolvedValue(makeAssistantMessage(JSON.stringify(VALID_DIAGNOSIS)));
  });

  afterEach(() => {
    delete process.env.TEST_API_KEY;
  });

  // ── Timeout Precedence ──────────────────────────────────────────────────

  describe('timeout precedence', () => {
    it('uses input.timeoutMs when provided (highest priority: runner/CLI override)', async () => {
      const adapter = makeAdapter({ timeoutMs: 200_000 });
      await adapter.startRun(makeStartRunInput({ timeoutMs: 45_000 }));

      const event = findTelemetryEvent('runtime_invocation_started');
      const payload = event?.payload as Record<string, unknown>;
      expect(payload.timeoutMs).toBe(45_000);
      expect(payload.timeoutSource).toBe('runner_input');
    });

    it('still attributes timeout to runner_input when input.timeoutMs equals config.timeoutMs', async () => {
      // input.timeoutMs = config.timeoutMs → still treated as runner_input
      const adapter = makeAdapter({ timeoutMs: 120_000 });
      await adapter.startRun(makeStartRunInput({ timeoutMs: 120_000 }));

      const event = findTelemetryEvent('runtime_invocation_started');
      const payload = event?.payload as Record<string, unknown>;
      expect(payload.timeoutMs).toBe(120_000);
      expect(payload.timeoutSource).toBe('runner_input');
    });

    it('uses adapter_config when input is absent but config has timeoutMs', async () => {
      // When runner doesn't pass timeout (shouldn't happen in practice since
      // StartRunInput.timeoutMs is required, but contract covers the fallback)
      const adapter = makeAdapter({ timeoutMs: 180_000 });
      // Use undefined via type assertion to test the fallback path
      await adapter.startRun(makeStartRunInput({ timeoutMs: undefined as unknown as number }));

      const event = findTelemetryEvent('runtime_invocation_started');
      const payload = event?.payload as Record<string, unknown>;
      expect(payload.timeoutMs).toBe(180_000);
      expect(payload.timeoutSource).toBe('adapter_config');
    });

    it('uses default 300_000 when neither input nor config specifies timeout', async () => {
      const adapter = makeAdapter(); // no timeoutMs
      await adapter.startRun(makeStartRunInput({ timeoutMs: undefined as unknown as number }));

      const event = findTelemetryEvent('runtime_invocation_started');
      const payload = event?.payload as Record<string, unknown>;
      expect(payload.timeoutMs).toBe(300_000);
      expect(payload.timeoutSource).toBe('default');
    });
  });

  // ── Telemetry Field Completeness ────────────────────────────────────────

  describe('telemetry: runtime_invocation_started field contract', () => {
    it('includes all required fields: runId, runtimeKind, runnerKind, provider, model, timeoutMs, timeoutSource, outputSchemaRef', async () => {
      mockCompleteSimple.mockResolvedValue(makeAssistantMessage(JSON.stringify(VALID_DREAMER_OUTPUT)));
      const adapter = makeAdapter({ provider: 'anthropic', model: 'claude-sonnet-4' });
      await adapter.startRun(makeStartRunInput({
        timeoutMs: 90_000,
        outputSchemaRef: 'dreamer-output-v1',
      }));

      const payload = requireTelemetryPayload('runtime_invocation_started');
      expect(payload.runId).toBeDefined();
      expect(payload.runtimeKind).toBe('pi-ai');
      expect(payload.runnerKind).toBe('diagnostician');
      expect(payload.provider).toBe('anthropic');
      expect(payload.model).toBe('claude-sonnet-4');
      expect(payload.timeoutMs).toBe(90_000);
      expect(payload.timeoutSource).toBe('runner_input');
      expect(payload.outputSchemaRef).toBe('dreamer-output-v1');
    });

    it('defaults outputSchemaRef to "unknown" when not provided', async () => {
      const adapter = makeAdapter();
      await adapter.startRun(makeStartRunInput());

      const payload = requireTelemetryPayload('runtime_invocation_started');
      expect(payload.outputSchemaRef).toBe('unknown');
    });

    it('reports correct provider and model from adapter config', async () => {
      const adapter = makeAdapter({ provider: 'openai', model: 'gpt-4o' });
      await adapter.startRun(makeStartRunInput({ outputSchemaRef: undefined }));

      const payload = requireTelemetryPayload('runtime_invocation_started');
      expect(payload.provider).toBe('openai');
      expect(payload.model).toBe('gpt-4o');
    });
  });

  // ── Architecture Guard ──────────────────────────────────────────────────

  describe('architecture guard: adapter cannot ignore runner timeout', () => {
    it('PiAiRuntimeAdapter.startRun() propagates input.timeoutMs to pi-ai completeSimple() call', async () => {
      const adapter = makeAdapter({ timeoutMs: 500_000 });
      const inputTimeout = 42_000;
      await adapter.startRun(makeStartRunInput({ timeoutMs: inputTimeout, outputSchemaRef: undefined }));

      // Verify the completeSimple() call received the runner's timeout, not config's
      expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
      const [, , options] = mockCompleteSimple.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
      // The effectiveTimeoutMs passed through completeWithRetry → completeSimple
      // must equal the runner input, not the adapter config
      expect(options.timeoutMs).toBe(inputTimeout);
    });

    it('PDRuntimeAdapter interface defines timeoutMs as required field in StartRunInput', async () => {
      // Import the schema to verify the contract at the type level
      const { StartRunInputSchema } = await import('../../runtime-protocol.js');
      const { Value } = await import('@sinclair/typebox/value');

      // Verify timeoutMs is a required number property
      const schema = StartRunInputSchema;
      const props = (schema as unknown as { properties: Record<string, unknown> }).properties;
      expect(props).toHaveProperty('timeoutMs');

      // Verify a valid StartRunInput with timeoutMs passes validation
      const valid = Value.Check(schema, makeStartRunInput());
      expect(valid).toBe(true);
    });
  });

  // ── Provider/Model Resolution ───────────────────────────────────────────

  describe('provider/model resolution', () => {
    it('built-in provider uses getModel() for provider+model resolution', async () => {
      mockGetModel.mockReturnValue({ id: 'anthropic/claude-sonnet-4' });

      const adapter = makeAdapter({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4' });
      await adapter.startRun(makeStartRunInput({ outputSchemaRef: undefined }));

      expect(mockGetModel).toHaveBeenCalledWith('openrouter', 'anthropic/claude-sonnet-4');
    });

    it('custom provider with catalog-known model looks the model up (PRI-621 catalog-first)', async () => {
      const adapter = makeAdapter({
        provider: 'custom-llm',
        model: 'custom-model-v1',
        baseUrl: 'https://llm.example.com/v1',
      });
      await adapter.startRun(makeStartRunInput({ outputSchemaRef: undefined }));

      // PRI-621: the catalog scan calls getModel with built-in provider names
      // — never with the custom provider name (it is not a known provider).
      expect(mockGetModel).not.toHaveBeenCalledWith('custom-llm', 'custom-model-v1');
    });

    it('custom provider without baseUrl throws PDRuntimeError', async () => {
      const adapter = makeAdapter({
        provider: 'unknown-provider',
        model: 'some-model',
      });

      await expect(adapter.startRun(makeStartRunInput({ outputSchemaRef: undefined }))).rejects.toThrow(
        /not a built-in pi-ai provider and requires a custom baseUrl/,
      );
    });
  });
});
