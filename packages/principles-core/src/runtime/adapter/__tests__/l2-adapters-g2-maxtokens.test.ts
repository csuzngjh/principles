/**
 * PRI-966 G2 P2 — cross-adapter StartRunInput.maxTokens contract for the two
 * L2 agent-loop adapters:
 *   - Dreamer: the per-request budget applies to EVERY agent-loop turn and the
 *     L1 fallback (loopConfig.maxTokens; this closes the AC-6 B1 wire-ceiling
 *     gap where max_tokens fell back to borrowed catalog metadata 384000);
 *   - Artificer: effective = min(per-request, profile config, model ceiling).
 * Invalid values fail loud (input_invalid). Absent values keep legacy
 * behavior byte-identical (native defaulting / profile default).
 *
 * The REAL pi-agent-core loop and the REAL pi-ai compat stream run against the
 * Pi 1.2 faux provider — no network, no keys. Only the catalog lookups
 * (getModel / getProviders) are stubbed, so the assertions observe the options
 * that actually reach the provider rather than the config object handed to a
 * mocked loop: a wrapper that narrows the option bag (pdStreamSimple) or a host
 * that stops forwarding a field is visible here and invisible to a loop mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@earendil-works/pi-ai/compat', async (importActual) =>
  (await import('./fixtures/faux-pi-ai-harness.js')).fauxCompatMockFactory(importActual));

vi.mock('../../store/event-emitter.js', () => ({
  storeEmitter: { emitTelemetry: vi.fn() },
}));

import { registerFauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/compat';
import { setFauxCompatModel } from './fixtures/faux-pi-ai-harness.js';
import { L2AgentLoopAdapter } from '../l2-agent-loop-adapter.js';
import { ArtificerL2Adapter } from '../artificer-l2-adapter.js';
import { DefaultArtificerValidator } from '../../internalization/artificer-output.js';
import type { StartRunInput } from '../../runtime-protocol.js';

/** One provider call as the model actually saw it. */
interface WireCall {
  hasMaxTokens: boolean;
  maxTokens?: number;
}

const wire: WireCall[] = [];
let registration: ReturnType<typeof registerFauxProvider> | undefined;

/** Guarded accessor — the repo forbids non-null assertions. */
function faux(): ReturnType<typeof registerFauxProvider> {
  if (!registration) throw new Error('faux provider not registered (beforeEach missing?)');
  return registration;
}

/**
 * Script one provider response and record the options that reached it.
 * `toolTurn` keeps the agent loop running (a second turn follows); `textTurn`
 * answers without a tool call so the loop ends after this turn.
 */
function recordWire(toolTurn: boolean) {
  return (_context: unknown, options?: { maxTokens?: number }) => {
    wire.push({
      hasMaxTokens: options ? Object.hasOwn(options, 'maxTokens') : false,
      maxTokens: options?.maxTokens,
    });
    return toolTurn
      ? fauxAssistantMessage([fauxToolCall('read_principles', {})], { stopReason: 'toolUse' })
      : fauxAssistantMessage('no tool call, plain text');
  };
}

function makeInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    agentSpec: { agentId: 'dreamer', schemaVersion: 'v1' },
    taskRef: { taskId: 'g2-l2-maxtokens' },
    inputPayload: 'produce output',
    contextItems: [],
    timeoutMs: 30_000,
    ...overrides,
  };
}

const dreamerDeps = {
  artifactReader: { getArtifactById: async () => null, listBySourceTaskId: async () => [] },
  principleReader: { listActivePrinciples: async () => [] },
};

const API_KEY_ENV = 'G2_L2_MAXTOKENS_KEY';

function makeDreamer(): L2AgentLoopAdapter {
  return new L2AgentLoopAdapter(
    {
      provider: 'faux',
      model: 'faux-1',
      apiKeyEnv: API_KEY_ENV,
      maxTurns: 2,
      maxEmptyRetries: 0,
      l2FallbackToL1: false,
      totalBudgetMs: 10_000,
    },
    dreamerDeps,
  );
}

function makeArtificer(maxTokens: number | undefined): ArtificerL2Adapter {
  return new ArtificerL2Adapter({
    provider: 'faux',
    model: 'faux-1',
    apiKeyEnv: API_KEY_ENV,
    gateDeps: { evaluateInSandbox: () => ({ success: true, failedCases: [], executionTimeMs: 1, forbiddenPatternViolations: [] }) },
    validator: new DefaultArtificerValidator(),
    maxTurns: 2,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    totalBudgetMs: 10_000,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  wire.length = 0;
  process.env[API_KEY_ENV] = 'offline-dummy-not-a-credential';
  // Model ceiling 32000 (faux default is 16384) keeps the min() chain assertable.
  registration = registerFauxProvider({ models: [{ id: 'faux-1', maxTokens: 32_000 }] });
  setFauxCompatModel(registration.getModel('faux-1'));
});

afterEach(() => {
  registration?.unregister();
  registration = undefined;
});

describe('P2: Dreamer L2 honors StartRunInput.maxTokens on every loop turn', () => {
  it('a present budget reaches the provider verbatim on every turn', async () => {
    faux().setResponses([recordWire(true), recordWire(true), recordWire(true)]);
    try {
      await makeDreamer().startRun(makeInput({ maxTokens: 1234 }));
    } catch { /* no submit_output — the recorded wire options are the assertion */ }
    expect(wire.map((call) => call.maxTokens)).toEqual([1234, 1234]);
  });

  it('an absent budget keeps legacy behavior: no maxTokens key reaches the provider (pi-ai native defaulting)', async () => {
    faux().setResponses([recordWire(false)]);
    try {
      await makeDreamer().startRun(makeInput());
    } catch { /* no submit_output */ }
    expect(wire.length).toBe(1);
    const [first] = wire;
    if (!first) throw new Error('the provider was never called');
    expect(first.hasMaxTokens).toBe(false);
  });

  it('the model output ceiling caps an oversized budget (32000 over 99000)', async () => {
    faux().setResponses([recordWire(false)]);
    try {
      await makeDreamer().startRun(makeInput({ maxTokens: 99_000 }));
    } catch { /* no submit_output */ }
    expect(wire.length).toBe(1);
    expect(wire[0]?.maxTokens).toBe(32_000);
  });

  it('invalid budgets fail loud as input_invalid before any loop runs', async () => {
    const adapter = makeDreamer();
    await expect(adapter.startRun(makeInput({ maxTokens: 0 }))).rejects.toMatchObject({ category: 'input_invalid' });
    await expect(adapter.startRun(makeInput({ maxTokens: -5 }))).rejects.toMatchObject({ category: 'input_invalid' });
    await expect(adapter.startRun(makeInput({ maxTokens: 12.5 }))).rejects.toMatchObject({ category: 'input_invalid' });
    expect(wire.length).toBe(0);
  });
});

describe('P2: Artificer L2 honors StartRunInput.maxTokens (min with profile default)', () => {
  it('per-request 777 wins over the profile default (8192)', async () => {
    faux().setResponses([recordWire(false), recordWire(false), recordWire(false)]);
    try {
      await makeArtificer(8192).startRun(makeInput({ maxTokens: 777, agentSpec: { agentId: 'artificer', schemaVersion: 'v1' } }));
    } catch { /* no submit_rulecode */ }
    expect(wire.length).toBeGreaterThan(0);
    expect(wire.every((call) => call.maxTokens === 777)).toBe(true);
  });

  it('profile default still applies when no per-request budget is passed (8192)', async () => {
    faux().setResponses([recordWire(false), recordWire(false), recordWire(false)]);
    try {
      await makeArtificer(8192).startRun(makeInput({ agentSpec: { agentId: 'artificer', schemaVersion: 'v1' } }));
    } catch { /* no submit_rulecode */ }
    expect(wire.length).toBeGreaterThan(0);
    expect(wire.every((call) => call.maxTokens === 8192)).toBe(true);
  });

  it('an oversized per-request budget is capped by the profile (4096 over 900000)', async () => {
    faux().setResponses([recordWire(false), recordWire(false), recordWire(false)]);
    try {
      await makeArtificer(4096).startRun(makeInput({ maxTokens: 900_000, agentSpec: { agentId: 'artificer', schemaVersion: 'v1' } }));
    } catch { /* no submit_rulecode */ }
    expect(wire.length).toBeGreaterThan(0);
    expect(wire.every((call) => call.maxTokens === 4096)).toBe(true);
  });

  it('invalid budgets fail loud as input_invalid', async () => {
    await expect(makeArtificer(4096).startRun(makeInput({ maxTokens: Number.NaN, agentSpec: { agentId: 'artificer', schemaVersion: 'v1' } })))
      .rejects.toMatchObject({ category: 'input_invalid' });
    expect(wire.length).toBe(0);
  });
});
