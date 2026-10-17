/**
 * SPEC-PD-PI12-COMPAT-001 Phase 0 spike (E04) — PiAiRuntimeAdapter (one-shot)
 * on Pi 1.2.
 *
 * Drives the REAL compat `completeSimple` against the faux provider through
 * the adapter's production paths: success extraction, PD-owned retry on a
 * rate-limit error, error/stopReason mapping, and abort/timeout classification.
 * The `onPayload` request mutations (tool_choice / response_format) are
 * consumed inside the per-API HTTP adapters, which the faux provider bypasses —
 * that specific behavior is source-verified in the audit report instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../store/event-emitter.js', () => ({
  storeEmitter: { emitTelemetry: vi.fn() },
}));

const spike = vi.hoisted(() => {
  const state: { fauxModel: unknown } = { fauxModel: undefined };
  return state;
});

vi.mock('@earendil-works/pi-ai/compat', async (importActual) => {
  const actual: Record<string, unknown> = await importActual();
  const actualGetModel = actual.getModel as (provider: unknown, id: unknown) => unknown;
  const actualGetProviders = actual.getProviders as () => unknown[];
  return {
    ...actual,
    getModel: vi.fn((provider: unknown, id: unknown) =>
      provider === 'faux' ? spike.fauxModel : actualGetModel(provider, id)),
    getProviders: vi.fn(() => ['faux', ...actualGetProviders()]),
  };
});

import { storeEmitter } from '../../store/event-emitter.js';
import { registerFauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/compat';
import { PiAiRuntimeAdapter } from '../pi-ai-runtime-adapter.js';
import type { StartRunInput } from '../../runtime-protocol.js';

const emitTelemetryMock = storeEmitter.emitTelemetry as unknown as ReturnType<typeof vi.fn>;

let registration: ReturnType<typeof registerFauxProvider> | undefined;

/** Guarded accessor — the repo forbids non-null assertions. */
function faux(): ReturnType<typeof registerFauxProvider> {
  if (!registration) throw new Error('faux provider not registered (beforeEach missing?)');
  return registration;
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

function makeAdapter(overrides: Record<string, unknown> = {}): PiAiRuntimeAdapter {
  return new PiAiRuntimeAdapter({
    provider: 'faux',
    model: 'faux-1',
    apiKeyEnv: 'TEST_API_KEY',
    _testBackoffDelayMs: 1,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  registration = registerFauxProvider({ models: [{ id: 'faux-1' }] });
  spike.fauxModel = registration.getModel('faux-1');
  process.env.TEST_API_KEY = 'test-key';
});

afterEach(() => {
  registration?.unregister();
  registration = undefined;
});

const VALID_DIAGNOSIS_JSON = JSON.stringify({
  valid: true,
  diagnosisId: 'diag-spike-1',
  summary: 'Test summary',
  rootCause: 'Test root cause',
  violatedPrinciples: [],
  evidence: [],
  recommendations: [{ kind: 'defer', description: 'no actionable recommendation' }],
  confidence: 0.9,
});

describe('SPEC-PD-PI12-COMPAT-001 E04 — one-shot PiAiRuntimeAdapter on real Pi 1.2 completeSimple', () => {
  it('success: JSON extraction + stopReason/usage finish telemetry on 1.2', async () => {
    faux().setResponses([fauxAssistantMessage(VALID_DIAGNOSIS_JSON)]);
    const adapter = makeAdapter();

    const handle = await adapter.startRun(makeStartRunInput());
    const output = await adapter.fetchOutput(handle.runId);
    expect(output?.payload).toEqual(JSON.parse(VALID_DIAGNOSIS_JSON));
    expect(faux().state.callCount).toBe(1);
    // Success telemetry fires on 1.2 (stopReason consumption is proven by the
    // error/abort tests below — a non-'stop' reason would have failed those).
    const events = emitTelemetryMock.mock.calls.map((c) => (c[0] as { eventType?: string }).eventType);
    expect(events).toContain('runtime_invocation_succeeded');
  });

  it('PD-owned retry: a rate-limit error response is retried and the second call succeeds (no double output)', async () => {
    faux().setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'rate limit exceeded: 429 quota' }),
      fauxAssistantMessage(VALID_DIAGNOSIS_JSON),
    ]);
    const adapter = makeAdapter({ maxRetries: 2 });

    const handle = await adapter.startRun(makeStartRunInput());
    const output = await adapter.fetchOutput(handle.runId);
    expect(output?.payload).toEqual(JSON.parse(VALID_DIAGNOSIS_JSON));
    expect(faux().state.callCount).toBe(2);
  });

  it('hard provider error maps to a loud PDRuntimeError (no silent empty output)', async () => {
    faux().setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'upstream exploded' }),
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'upstream exploded again' }),
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'upstream exploded third time' }),
    ]);
    const adapter = makeAdapter({ maxRetries: 2 });

    await expect(adapter.startRun(makeStartRunInput())).rejects.toMatchObject({ category: 'execution_failed' });
    // 1 initial + 2 retries — bounded by PD's own retry budget.
    expect(faux().state.callCount).toBe(3);
  });

  it('timeout: an input timeoutMs aborts a slow model call and classifies as timeout', async () => {
    faux().setResponses([
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 800));
        return fauxAssistantMessage('too late');
      },
    ]);
    const adapter = makeAdapter();

    await expect(adapter.startRun(makeStartRunInput({ timeoutMs: 80 }))).rejects.toMatchObject({ category: 'timeout' });
    expect(faux().state.callCount).toBe(1);
  });
});
