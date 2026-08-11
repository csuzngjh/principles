/**
 * PRI-419 §M3 — L2AgentLoopAdapter integration tests.
 *
 * Mocks runAgentLoop (no real LLM calls) to verify the adapter's orchestration:
 *   - submit_output capture terminates the loop (primary extraction)
 *   - maxTurns cap forces stop when submit_output is never called
 *   - fallback extraction from the last text-bearing assistant message
 *   - beforeToolCall whitelist blocks non-allowlisted tools
 *   - telemetry events (dreamer_l2_turn / dreamer_l2_complete) are emitted
 *   - output goes through the same shape as L1 (StructuredRunOutput)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted runs before vi.mock factories, so shared mutable state lives here.
type LoopCfg = { shouldStopAfterTurn?: () => boolean; beforeToolCall?: (ctx: { toolCall: { name: string } }) => Promise<unknown> };
type LoopImpl = ((...args: never[]) => Promise<unknown[]>) | null;

const hoisted = vi.hoisted((): {
  lastLoopConfig: LoopCfg;
  mockReturn: { role: string; content: unknown }[];
  impl: LoopImpl;
} => {
  return {
    lastLoopConfig: {},
    mockReturn: [],
    impl: null,
  };
});

/* eslint-disable @typescript-eslint/max-params -- runAgentLoop mock mirrors the real 5-param signature */
// Mock runAgentLoop — the adapter's only entry into pi-agent-core.
vi.mock('@earendil-works/pi-agent-core', () => ({
   
  runAgentLoop: vi.fn(async (
    prompts: unknown,
    context: unknown,
    config: typeof hoisted.lastLoopConfig,
    emit: unknown,
    signal?: AbortSignal,
  ) => {
    hoisted.lastLoopConfig = config;
    // Per-test override via mockImplementation takes precedence; otherwise return the staged transcript.
    if (typeof hoisted.impl === 'function') {
      const fn = hoisted.impl as (p: unknown, c: unknown, cfg: unknown, e: unknown, sig?: AbortSignal) => Promise<unknown[]>;
      return fn(prompts, context, config, emit, signal);
    }
    return hoisted.mockReturn.slice();
  }),
}));
/* eslint-enable @typescript-eslint/max-params */

// PRI-420: mock completeSimple for L1 fallback tests. getModel/getProviders are used by resolveL2Model
// in all tests (via the custom baseUrl path), so provide stubs.
vi.mock('@earendil-works/pi-ai/compat', () => ({
  completeSimple: vi.fn(),
  streamSimple: vi.fn(),
  getModel: vi.fn(() => ({ id: 'test', name: 'test', api: 'openai-completions', provider: 'test-provider' })),
  getProviders: vi.fn(() => []),
}));

// Mock store/event-emitter to capture telemetry.
vi.mock('../../store/event-emitter.js', () => ({
  storeEmitter: { emitTelemetry: vi.fn() },
}));

import { storeEmitter } from '../../store/event-emitter.js';
import { completeSimple } from '@earendil-works/pi-ai/compat';
import { L2AgentLoopAdapter } from '../l2-agent-loop-adapter.js';
import type { StartRunInput } from '../../runtime-protocol.js';
import type { PdL2ArtifactReader, PdL2PrincipleReader } from '../../tools/agent-tool-contract.js';

const emitTelemetryMock = storeEmitter.emitTelemetry as unknown as ReturnType<typeof vi.fn>;
const mockComplete = completeSimple as unknown as ReturnType<typeof vi.fn>;

// Minimal fakes for the injected readers.
const artifactReader: PdL2ArtifactReader = {
  getArtifactById: async () => null,
  listBySourceTaskId: async () => [],
};
const principleReader: PdL2PrincipleReader = {
  listActivePrinciples: async () => [],
};

const VALID_DREAMER_OUTPUT = {
  valid: true,
  taskId: 'task-dreamer-1',
  candidates: [
    { candidateIndex: 0, badDecision: 'x', betterDecision: 'y', rationale: 'r', confidence: 0.5, riskLevel: 'low', strategicPerspective: 's' },
  ],
  contextRefs: ['ref-1'],
  generatedAt: '2026-06-16T00:00:00.000Z',
};

function makeStartRun(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    agentSpec: { agentId: 'dreamer', schemaVersion: 'v1' },
    taskRef: { taskId: 'task-dreamer-1' },
    inputPayload: '{"prompt":"generate candidates"}',
    contextItems: [],
    outputSchemaRef: 'dreamer-output-v1',
    timeoutMs: 300000,
    ...overrides,
  };
}

function makeAdapter(overrides: { maxTurns?: number; totalBudgetMs?: number; maxEmptyRetries?: number; l2FallbackToL1?: boolean } = {}): L2AgentLoopAdapter {
  return new L2AgentLoopAdapter(
    {
      // Custom baseUrl so resolveL2Model builds the model inline (no getModel lookup).
      provider: 'test-provider',
      model: 'test-model',
      apiKeyEnv: 'TEST_API_KEY',
      baseUrl: 'http://localhost:1234/v1',
      maxTurns: overrides.maxTurns,
      maxEmptyRetries: overrides.maxEmptyRetries,
      l2FallbackToL1: overrides.l2FallbackToL1,
      totalBudgetMs: overrides.totalBudgetMs ?? 60_000,
    },
    { artifactReader, principleReader },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.mockReturn = [];
  hoisted.impl = null;
  hoisted.lastLoopConfig = {};
  process.env.TEST_API_KEY = 'test-key';
});

describe('PRI-419 L2AgentLoopAdapter — submit_output capture (primary extraction)', () => {
  it('returns the captured output when submit_output was called', async () => {
    const adapter = makeAdapter();
    // Simulate: the tool factory's submit_output execute() writes to outputCapture.
    // The adapter reads outputCapture.output after the loop. We can't directly set the
    // capture from here, so we verify via the shouldStopAfterTurn hook: after the loop
    // returns, the adapter checks outputCapture. To exercise the capture path, we make
    // runAgentLoop invoke the built tools' submit_output before returning.
    hoisted.impl = async (_p: unknown, context: { tools?: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[] }) => {
      const submit = context.tools?.find(t => t.name === 'submit_output');
      if (submit) {
        await submit.execute('call-1', VALID_DREAMER_OUTPUT);
      }
      return [];
    };

    const handle = await adapter.startRun(makeStartRun());
    const output = await adapter.fetchOutput(handle.runId);
    expect(output).not.toBeNull();
    expect(output?.payload).toEqual(VALID_DREAMER_OUTPUT);
  });

  it('shouldStopAfterTurn returns true after output is captured', async () => {
    const adapter = makeAdapter({ maxTurns: 5 });
    hoisted.impl = async (_p: unknown, context: { tools?: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[] }) => {
      const submit = context.tools?.find(t => t.name === 'submit_output');
      if (submit) {
        await submit.execute('call-1', VALID_DREAMER_OUTPUT);
      }
      return [];
    };

    await adapter.startRun(makeStartRun());
    const stopFn = hoisted.lastLoopConfig.shouldStopAfterTurn;
    expect(typeof stopFn).toBe('function');
    if (!stopFn) return;
    // After submit_output captured output, the next shouldStopAfterTurn call returns true.
    expect(stopFn()).toBe(true);
  });
});

describe('PRI-419 L2AgentLoopAdapter — maxTurns cap', () => {
  it('shouldStopAfterTurn returns false below maxTurns and true at/above, WITHOUT submit_output', async () => {
    // Verifies the turn-cap path INDEPENDENTLY of output capture: submit_output is NOT
    // called, so stopping is driven purely by turnCount reaching maxTurns. Fallback
    // extraction (assistant message contains JSON) lets startRun succeed.
    // The mocked runAgentLoop does NOT call shouldStopAfterTurn, so turnCount starts at 0.
    // With maxTurns=5: calls 1-4 (turns 1-4, < 5) → false; call 5 (turn 5, >= 5) → true.
    const adapter = makeAdapter({ maxTurns: 5 });
    hoisted.mockReturn = [
      { role: 'assistant', content: JSON.stringify(VALID_DREAMER_OUTPUT) },
    ];

    await adapter.startRun(makeStartRun());
    const stopFn = hoisted.lastLoopConfig.shouldStopAfterTurn;
    if (!stopFn) { expect.fail('shouldStopAfterTurn not wired'); return; }
    expect(stopFn()).toBe(false); // turn 1
    expect(stopFn()).toBe(false); // turn 2
    expect(stopFn()).toBe(false); // turn 3
    expect(stopFn()).toBe(false); // turn 4
    expect(stopFn()).toBe(true);  // turn 5 (>= maxTurns)
    expect(stopFn()).toBe(true);  // turn 6 (still >= maxTurns)
  });
});

describe('PRI-419 L2AgentLoopAdapter — fallback extraction', () => {
  it('extracts JSON from the last assistant text message when submit_output was not called', async () => {
    const adapter = makeAdapter();
    hoisted.mockReturn = [
      { role: 'assistant', content: 'Let me check the principles first.' },
      { role: 'assistant', content: `Here is my output:\n${JSON.stringify(VALID_DREAMER_OUTPUT)}` },
    ];

    const handle = await adapter.startRun(makeStartRun());
    const output = await adapter.fetchOutput(handle.runId);
    expect(output).not.toBeNull();
    expect(output?.payload).toEqual(VALID_DREAMER_OUTPUT);
  });

  it('fails loud (output_invalid) when no submit_output and no parseable JSON', async () => {
    const adapter = makeAdapter();
    hoisted.mockReturn = [
      { role: 'assistant', content: 'I could not produce an answer.' },
    ];
    await expect(adapter.startRun(makeStartRun())).rejects.toThrow(/no parseable JSON|submit_output was not called/);
  });
});

describe('PRI-419 L2AgentLoopAdapter — beforeToolCall whitelist', () => {
  it('blocks a tool not in the dreamer L2 whitelist', async () => {
    const adapter = makeAdapter();
    hoisted.impl = async (_p: unknown, context: { tools?: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[] }) => {
          const submit = context.tools?.find(t => t.name === 'submit_output');
          if (submit) await submit.execute('call-1', VALID_DREAMER_OUTPUT);
          return [];
        };
    await adapter.startRun(makeStartRun());
    const {beforeToolCall} = hoisted.lastLoopConfig;
    expect(typeof beforeToolCall).toBe('function');
    if (!beforeToolCall) return;
    const result = await beforeToolCall({ toolCall: { name: 'write_file' } });
    expect(result).toEqual({ block: true, reason: expect.stringContaining('write_file') });
  });

  it('allows a whitelisted tool', async () => {
    const adapter = makeAdapter();
    hoisted.impl = async (_p: unknown, context: { tools?: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[] }) => {
          const submit = context.tools?.find(t => t.name === 'submit_output');
          if (submit) await submit.execute('call-1', VALID_DREAMER_OUTPUT);
          return [];
        };
    await adapter.startRun(makeStartRun());
    const {beforeToolCall} = hoisted.lastLoopConfig;
    if (!beforeToolCall) return;
    const result = await beforeToolCall({ toolCall: { name: 'read_principles' } });
    expect(result).toBeUndefined();
  });
});

describe('PRI-419 L2AgentLoopAdapter — telemetry', () => {
  it('emits dreamer_l2_complete on success with turnCount, toolsInvoked, usedFallback', async () => {
    const adapter = makeAdapter();
    hoisted.impl = async (_p: unknown, context: { tools?: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[] }) => {
      const submit = context.tools?.find(t => t.name === 'submit_output');
      if (submit) await submit.execute('call-1', VALID_DREAMER_OUTPUT);
      return [];
    };

    await adapter.startRun(makeStartRun());
    const completeCalls = emitTelemetryMock.mock.calls.filter(c => c[0]?.eventType === 'dreamer_l2_complete');
    expect(completeCalls.length).toBe(1);
    const payload = completeCalls[0]?.[0]?.payload;
    expect(payload).toHaveProperty('turnCount');
    expect(payload).toHaveProperty('toolsInvoked');
    expect(payload.usedFallback).toBe(false);
    expect(payload.timedOut).toBe(false);
  });

  it('emits dreamer_l2_turn for each tool execution', async () => {
    const adapter = makeAdapter();
    hoisted.impl = async (_p: unknown, context: { tools?: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[] }) => {
      const readPrinciples = context.tools?.find(t => t.name === 'read_principles');
      const submit = context.tools?.find(t => t.name === 'submit_output');
      if (readPrinciples) await readPrinciples.execute('c1', {});
      if (submit) await submit.execute('c2', VALID_DREAMER_OUTPUT);
      return [];
    };

    await adapter.startRun(makeStartRun());
    const turnCalls = emitTelemetryMock.mock.calls.filter(c => c[0]?.eventType === 'dreamer_l2_turn' && c[0]?.payload?.toolName);
    expect(turnCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('PRI-419 L2AgentLoopAdapter — error paths', () => {
  it('throws runtime_unavailable when the API key env is missing', async () => {
    delete process.env.TEST_API_KEY;
    const adapter = makeAdapter();
    await expect(adapter.startRun(makeStartRun())).rejects.toThrow(/API key not found/);
  });

  it('kind() returns pi-ai-l2', async () => {
    const adapter = makeAdapter();
    expect(adapter.kind()).toBe('pi-ai-l2');
  });

  it('getCapabilities reports supportsToolUse=true', async () => {
    const adapter = makeAdapter();
    const caps = await adapter.getCapabilities();
    expect(caps.supportsToolUse).toBe(true);
  });
});

describe('PRI-419 L2AgentLoopAdapter — fallback edge cases (P2-3)', () => {
  it('returns null (fail loud) when the last assistant message has content: null', async () => {
    // content: null is neither string nor array; extraction must return null, and the
    // adapter must then fail loud (no parseable JSON) rather than crash.
    const adapter = makeAdapter();
    hoisted.mockReturn = [
      { role: 'assistant', content: null },
    ];
    await expect(adapter.startRun(makeStartRun())).rejects.toThrow(/no parseable JSON|submit_output was not called/);
  });

  it('returns null when the transcript has no assistant message at all', async () => {
    const adapter = makeAdapter();
    hoisted.mockReturn = [
      { role: 'user', content: 'hello' },
    ];
    await expect(adapter.startRun(makeStartRun())).rejects.toThrow(/no parseable JSON|submit_output was not called/);
  });
});

describe('PRI-419 L2AgentLoopAdapter — timeout/abort path (P3-1)', () => {
  it('reports timed_out when the wall-clock budget aborts the loop', async () => {
    // Use a short real totalBudgetMs so the adapter's setTimeout fires and aborts the
    // controller. The mock loop waits past the budget, then rejects (simulating an
    // abort-driven failure). The catch block must classify it as timed_out.
    const adapter = makeAdapter({ totalBudgetMs: 50 });
    hoisted.impl = async (...args: unknown[]) => {
      // Wait long enough for the budget timer to fire + abort. signal is the 5th arg.
      const signal = args[4] as AbortSignal | undefined;
      await new Promise(resolve => setTimeout(resolve, 120));
      if (signal?.aborted) {
        throw new Error('aborted by budget');
      }
      return [];
    };

    await expect(adapter.startRun(makeStartRun())).rejects.toThrow(/aborted by budget/);
    const completeCalls = emitTelemetryMock.mock.calls.filter(c => c[0]?.eventType === 'dreamer_l2_complete');
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0]?.[0]?.payload?.timedOut).toBe(true);
  }, 10_000);

  it('reports execution_failed (not timed_out) when the loop throws without abort', async () => {
    const adapter = makeAdapter({ totalBudgetMs: 60_000 });
    hoisted.impl = async () => {
      throw new Error('model error');
    };

    await expect(adapter.startRun(makeStartRun())).rejects.toThrow(/model error/);
    const completeCalls = emitTelemetryMock.mock.calls.filter(c => c[0]?.eventType === 'dreamer_l2_complete');
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0]?.[0]?.payload?.timedOut).toBe(false);
  });
});

describe('PRI-420 L2AgentLoopAdapter — empty-response auto-retry', () => {
  it('retries on empty response and succeeds on the second attempt', async () => {
    const adapter = makeAdapter({ maxEmptyRetries: 2, totalBudgetMs: 60_000 });
    let attempt = 0;
    hoisted.impl = async (_p: unknown, context: { tools?: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[] }) => {
      attempt += 1;
      if (attempt === 1) {
        // First attempt: empty response (no submit_output, no text).
        return [{ role: 'assistant', content: '' }];
      }
      // Second attempt: call submit_output.
      const submit = context.tools?.find(t => t.name === 'submit_output');
      if (submit) await submit.execute('call-1', VALID_DREAMER_OUTPUT);
      return [];
    };

    const handle = await adapter.startRun(makeStartRun());
    const output = await adapter.fetchOutput(handle.runId);
    expect(output).not.toBeNull();
    expect(output?.payload).toEqual(VALID_DREAMER_OUTPUT);

    // retryCount should be 1 in telemetry.
    const completeCalls = emitTelemetryMock.mock.calls.filter(c => c[0]?.eventType === 'dreamer_l2_complete');
    expect(completeCalls[0]?.[0]?.payload?.retryCount).toBe(1);
  });

  it('emits empty_response_retry telemetry per retry', async () => {
    const adapter = makeAdapter({ maxEmptyRetries: 2, totalBudgetMs: 60_000 });
    let attempt = 0;
    hoisted.impl = async (_p: unknown, context: { tools?: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[] }) => {
      attempt += 1;
      if (attempt <= 2) {
        return [{ role: 'assistant', content: '' }]; // empty
      }
      const submit = context.tools?.find(t => t.name === 'submit_output');
      if (submit) await submit.execute('call-1', VALID_DREAMER_OUTPUT);
      return [];
    };

    await adapter.startRun(makeStartRun());
    const retryEvents = emitTelemetryMock.mock.calls.filter(
      c => c[0]?.eventType === 'dreamer_l2_turn' && c[0]?.payload?.phase === 'empty_response_retry',
    );
    expect(retryEvents.length).toBe(2); // attempt 1 and attempt 2
  });

  it('does NOT retry when maxEmptyRetries is 0 (fails immediately to fallback)', async () => {
    const adapter = makeAdapter({ maxEmptyRetries: 0, l2FallbackToL1: false, totalBudgetMs: 60_000 });
    hoisted.mockReturn = [{ role: 'assistant', content: '' }];

    await expect(adapter.startRun(makeStartRun())).rejects.toThrow(/empty response on all attempts/);
    const completeCalls = emitTelemetryMock.mock.calls.filter(c => c[0]?.eventType === 'dreamer_l2_complete');
    expect(completeCalls[0]?.[0]?.payload?.retryCount).toBe(0);
  });
});

describe('PRI-420 L2AgentLoopAdapter — L2→L1 fallback', () => {
  it('falls back to L1 completeSimple when all L2 attempts produce empty responses', async () => {
    const adapter = makeAdapter({ maxEmptyRetries: 1, l2FallbackToL1: true, totalBudgetMs: 60_000 });
    hoisted.mockReturn = [{ role: 'assistant', content: '' }]; // always empty

    // Mock completeSimple to return a valid JSON response.
    mockComplete.mockResolvedValueOnce({
      content: JSON.stringify(VALID_DREAMER_OUTPUT),
    });

    const handle = await adapter.startRun(makeStartRun());
    const output = await adapter.fetchOutput(handle.runId);
    expect(output?.payload).toEqual(VALID_DREAMER_OUTPUT);

    // Fallback telemetry should fire.
    const fallbackEvents = emitTelemetryMock.mock.calls.filter(c => c[0]?.eventType === 'dreamer_l2_fallback_to_l1');
    expect(fallbackEvents.length).toBe(1);
    expect(fallbackEvents[0]?.[0]?.payload?.reason).toContain('empty response');
  });

  it('fails loud (R9) when both L2 and L1 fallback fail', async () => {
    const adapter = makeAdapter({ maxEmptyRetries: 1, l2FallbackToL1: true, totalBudgetMs: 60_000 });
    hoisted.mockReturn = [{ role: 'assistant', content: '' }]; // L2 empty
    mockComplete.mockResolvedValueOnce({ content: 'not json at all' }); // L1 no parseable JSON

    await expect(adapter.startRun(makeStartRun())).rejects.toThrow(/L1 fallback also failed/);
  });

  it('fails loud without L1 fallback when l2FallbackToL1 is false', async () => {
    const adapter = makeAdapter({ maxEmptyRetries: 1, l2FallbackToL1: false, totalBudgetMs: 60_000 });
    hoisted.mockReturn = [{ role: 'assistant', content: '' }];

    await expect(adapter.startRun(makeStartRun())).rejects.toThrow(/empty response on all attempts/);
    // No fallback event should fire.
    const fallbackEvents = emitTelemetryMock.mock.calls.filter(c => c[0]?.eventType === 'dreamer_l2_fallback_to_l1');
    expect(fallbackEvents.length).toBe(0);
  });
});

describe('PRI-419 L2AgentLoopAdapter — runs Map is bounded (P1-1)', () => {
  it('does not grow without bound across many runs', async () => {
    const adapter = makeAdapter();
    // Run more than MAX_RETAINED_RUNS (100) times; the Map must stay bounded.
    for (let i = 0; i < 105; i++) {
      hoisted.impl = async (_p: unknown, context: { tools?: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[] }) => {
        const submit = context.tools?.find(t => t.name === 'submit_output');
        if (submit) await submit.execute('call-1', VALID_DREAMER_OUTPUT);
        return [];
      };
      await adapter.startRun(makeStartRun());
    }
    // The internal runs Map is private; verify via fetchOutput that early runIds are evicted
    // (not retained) while recent ones are. We can't read the Map directly, but pollRun on an
    // early runId must report it as failed (evicted → unknown runId default).
    // Collect the first runId via telemetry and assert it is no longer fetchable.
    const firstComplete = emitTelemetryMock.mock.calls.find(c => c[0]?.eventType === 'dreamer_l2_complete');
    const firstRunId = firstComplete?.[0]?.payload?.runId as string | undefined;
    // The very first runId should have been evicted after 105 runs (>100 cap).
    if (firstRunId) {
      const output = await adapter.fetchOutput(firstRunId);
      // Either null (evicted) or still present if the cap is generous — assert null to prove eviction.
      expect(output).toBeNull();
    }
  }, 30_000);
});
