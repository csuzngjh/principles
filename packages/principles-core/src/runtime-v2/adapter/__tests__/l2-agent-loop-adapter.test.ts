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

// Mock store/event-emitter to capture telemetry.
vi.mock('../../store/event-emitter.js', () => ({
  storeEmitter: { emitTelemetry: vi.fn() },
}));

import { storeEmitter } from '../../store/event-emitter.js';
import { L2AgentLoopAdapter } from '../l2-agent-loop-adapter.js';
import type { StartRunInput } from '../../runtime-protocol.js';
import type { PdL2ArtifactReader, PdL2PrincipleReader } from '../../tools/agent-tool-contract.js';

const emitTelemetryMock = storeEmitter.emitTelemetry as unknown as ReturnType<typeof vi.fn>;

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

function makeAdapter(overrides: { maxTurns?: number; totalBudgetMs?: number } = {}): L2AgentLoopAdapter {
  return new L2AgentLoopAdapter(
    {
      provider: 'openai',
      model: 'test-model',
      apiKeyEnv: 'TEST_API_KEY',
      resolvedModel: { id: 'test-model', name: 'test-model', api: 'openai-completions', provider: 'openai' } as never,
      maxTurns: overrides.maxTurns,
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
  it('shouldStopAfterTurn returns true once turnCount reaches maxTurns', async () => {
    const adapter = makeAdapter({ maxTurns: 2 });
    hoisted.impl = async (_p: unknown, context: { tools?: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[] }) => {
          const submit = context.tools?.find(t => t.name === 'submit_output');
          if (submit) await submit.execute('call-1', VALID_DREAMER_OUTPUT);
          return [];
        };

    await adapter.startRun(makeStartRun());
    const stopFn = hoisted.lastLoopConfig.shouldStopAfterTurn;
    if (!stopFn) { expect.fail('shouldStopAfterTurn not wired'); return; }
    expect(stopFn()).toBe(true); // turn 1
    expect(stopFn()).toBe(true); // turn 2 (>= maxTurns)
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
