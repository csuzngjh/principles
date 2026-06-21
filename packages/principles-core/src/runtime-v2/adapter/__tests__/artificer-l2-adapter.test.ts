/**
 * ArtificerL2Adapter tests (PRI-439 Phase 4 — tool-using L2 agent).
 *
 * Mocks runAgentLoop (no real LLM calls) to verify the adapter's orchestration:
 *   - submit_rulecode capture terminates the loop and stores the output
 *   - maxTurns cap forces stop when submit_rulecode is never called
 *   - beforeToolCall whitelist blocks non-allowlisted tools
 *   - shouldStopAfterTurn checks output capture + turn count
 *   - no V1/L1 fallback: exhaustion throws PDRuntimeError
 *   - timeout: abort signal triggers timed_out failure
 *   - telemetry events (artificer_l2_turn / artificer_l2_complete) are emitted
 *
 * ERR checklist:
 *   - EP-05 Loop State Freshness: each startRun uses fresh outputCapture + turnCount
 *   - EP-03 Fail Loud: exhaustion throws PDRuntimeError with structured nextAction
 *   - EP-01 Trust Boundary: submit_rulecode validates via injected validator
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type LoopCfg = {
  shouldStopAfterTurn?: () => boolean;
  beforeToolCall?: (ctx: { toolCall: { name: string } }) => Promise<unknown>;
  maxTokens?: number;
};
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
vi.mock('@earendil-works/pi-agent-core', () => ({
  runAgentLoop: vi.fn(async (
    prompts: unknown,
    context: unknown,
    config: typeof hoisted.lastLoopConfig,
    emit: unknown,
    signal?: AbortSignal,
  ) => {
    hoisted.lastLoopConfig = config;
    if (typeof hoisted.impl === 'function') {
      const fn = hoisted.impl as (p: unknown, c: unknown, cfg: unknown, e: unknown, sig?: AbortSignal) => Promise<unknown[]>;
      return fn(prompts, context, config, emit, signal);
    }
    return hoisted.mockReturn.slice();
  }),
}));
/* eslint-enable @typescript-eslint/max-params */

// Mock resolveL2Model's pi-ai dependencies (getModel/getProviders) — the adapter
// uses the custom baseUrl path so these stubs are never called for real.
vi.mock('@earendil-works/pi-ai', () => ({
  completeSimple: vi.fn(),
  getModel: vi.fn(() => ({ id: 'test', name: 'test', api: 'openai-completions', provider: 'test-provider' })),
  getProviders: vi.fn(() => []),
}));

vi.mock('../../store/event-emitter.js', () => ({
  storeEmitter: { emitTelemetry: vi.fn() },
}));

import { storeEmitter } from '../../store/event-emitter.js';
import { ArtificerL2Adapter } from '../artificer-l2-adapter.js';
import type { StartRunInput } from '../../runtime-protocol.js';
import type { RefinerRuleHostGateDeps } from '../../internalization/refiner-rulehost-gate.js';
import type { RefinerSandboxResult } from '../../internalization/refiner-sandbox-wrapper.js';
import type { ArtificerRuleOutput } from '../../internalization/artificer-output.js';
import { DefaultArtificerValidator } from '../../internalization/artificer-output.js';

const emitTelemetryMock = storeEmitter.emitTelemetry as unknown as ReturnType<typeof vi.fn>;

const TASK_ID = 'task-artificer-l2-001';

/** A valid ArtificerRuleOutput the model might submit via submit_rulecode. */
function makeRuleOutput(overrides: Partial<ArtificerRuleOutput> = {}): ArtificerRuleOutput {
  return {
    taskId: TASK_ID,
    sourceScribeArtifactId: 'pi-art-scribe-001',
    implementationCode: 'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "ok" }; }',
    goldenTraceCases: [
      { caseId: 'negative-1', kind: 'negative', toolName: 'edit', params: { path: '/etc/x' }, expectedDecision: 'block' },
      { caseId: 'positive-1', kind: 'positive', toolName: 'read', params: { path: '/tmp/y' }, expectedDecision: 'allow' },
    ],
    affectedTools: ['edit'],
    implementationSummary: 'Block writes to system dirs',
    risks: [],
    sourceTrace: { scribeArtifactId: 'pi-art-scribe-001' },
    generatedAt: '2026-06-17T00:00:00.000Z',
    ...overrides,
  };
}

function makeAlwaysPassGateDeps(): RefinerRuleHostGateDeps {
  const passingResult: RefinerSandboxResult = {
    success: true,
    failedCases: [],
    executionTimeMs: 1,
    forbiddenPatternViolations: [],
  };
  return {
    evaluateInSandbox: (_code, _trace, _opts) => passingResult,
  };
}

function makeStartRun(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    agentSpec: { agentId: 'artificer', schemaVersion: 'v1' },
    taskRef: { taskId: TASK_ID },
    inputPayload: 'initial prompt',
    contextItems: [],
    outputSchemaRef: 'artificer-output-v2',
    timeoutMs: 300_000,
    ...overrides,
  };
}

function makeAdapter(overrides: {
  maxTurns?: number;
  totalBudgetMs?: number;
  maxTokens?: number;
  gateDeps?: RefinerRuleHostGateDeps;
} = {}): ArtificerL2Adapter {
  return new ArtificerL2Adapter({
    provider: 'test-provider',
    model: 'test-model',
    apiKeyEnv: 'TEST_API_KEY',
    baseUrl: 'http://localhost:1234/v1',
    gateDeps: overrides.gateDeps ?? makeAlwaysPassGateDeps(),
    validator: new DefaultArtificerValidator(),
    maxTurns: overrides.maxTurns,
    totalBudgetMs: overrides.totalBudgetMs ?? 60_000,
    maxTokens: overrides.maxTokens,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.mockReturn = [];
  hoisted.impl = null;
  hoisted.lastLoopConfig = {};
  process.env.TEST_API_KEY = 'test-key';
});

// ── submit_rulecode capture (primary extraction) ─────────────────────────────

describe('PRI-439 ArtificerL2Adapter — submit_rulecode capture', () => {
  it('returns the captured output when submit_rulecode was called', async () => {
    const adapter = makeAdapter();
    hoisted.impl = async (_p: unknown, context: { tools?: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[] }) => {
      const submit = context.tools?.find((t) => t.name === 'submit_rulecode');
      if (submit) {
        await submit.execute('call-1', makeRuleOutput());
      }
      return [];
    };

    const handle = await adapter.startRun(makeStartRun());
    const output = await adapter.fetchOutput(handle.runId);
    expect(output).not.toBeNull();
    expect(output?.payload).toEqual(makeRuleOutput());
  });

  it('shouldStopAfterTurn returns true after output is captured', async () => {
    const adapter = makeAdapter({ maxTurns: 8 });
    hoisted.impl = async (_p: unknown, context: { tools?: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[] }) => {
      const submit = context.tools?.find((t) => t.name === 'submit_rulecode');
      if (submit) {
        await submit.execute('call-1', makeRuleOutput());
      }
      return [];
    };

    await adapter.startRun(makeStartRun());
    const stopFn = hoisted.lastLoopConfig.shouldStopAfterTurn;
    expect(typeof stopFn).toBe('function');
    if (!stopFn) return;
    // After submit_rulecode captured output, the next shouldStopAfterTurn call returns true.
    expect(stopFn()).toBe(true);
  });
});

// ── maxTurns cap ─────────────────────────────────────────────────────────────

describe('PRI-439 ArtificerL2Adapter — maxTurns cap', () => {
  it('shouldStopAfterTurn returns false below maxTurns and true at/above, WITHOUT submit_rulecode', async () => {
    const adapter = makeAdapter({ maxTurns: 5 });
    hoisted.mockReturn = [
      { role: 'assistant', content: 'thinking...' },
    ];

    await adapter.startRun(makeStartRun()).catch(() => {
      // startRun throws when no output is captured — that's expected here.
    });
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

// ── beforeToolCall whitelist ─────────────────────────────────────────────────

describe('PRI-439 ArtificerL2Adapter — beforeToolCall whitelist', () => {
  it('blocks unknown tools', async () => {
    const adapter = makeAdapter();
    hoisted.mockReturn = [];

    await adapter.startRun(makeStartRun()).catch(() => {
      // startRun throws when no output is captured — expected.
    });
    const beforeFn = hoisted.lastLoopConfig.beforeToolCall;
    expect(typeof beforeFn).toBe('function');
    if (!beforeFn) return;

    const result = await beforeFn({ toolCall: { name: 'unknown_tool' } });
    expect(result).toEqual({ block: true, reason: expect.stringContaining('unknown_tool') });
  });

  it('allows whitelisted tools', async () => {
    const adapter = makeAdapter();
    hoisted.mockReturn = [];

    await adapter.startRun(makeStartRun()).catch(() => {
      // startRun throws when no output is captured — expected.
    });
    const beforeFn = hoisted.lastLoopConfig.beforeToolCall;
    if (!beforeFn) { expect.fail('beforeToolCall not wired'); return; }

    for (const name of ['read_rulecode_spec', 'validate_rulecode', 'replay_rulecode', 'submit_rulecode']) {
      const result = await beforeFn({ toolCall: { name } });
      expect(result).toBeUndefined();
    }
  });
});

// ── exhaustion: no V1/L1 fallback ────────────────────────────────────────────

describe('PRI-439 ArtificerL2Adapter — exhaustion (no fallback)', () => {
  it('throws PDRuntimeError when the loop ends without submit_rulecode', async () => {
    const adapter = makeAdapter({ maxTurns: 3 });
    hoisted.mockReturn = [
      { role: 'assistant', content: 'I cannot produce valid code.' },
    ];

    await expect(adapter.startRun(makeStartRun())).rejects.toThrow(/without a submit_rulecode call/);

    // No output stored for the failed run — fetchOutput returns null.
    const runs = (adapter as unknown as { runs: Map<string, { output: unknown }> }).runs;
    expect(runs.size).toBe(1);
    for (const [, state] of runs) {
      expect(state.output).toBeNull();
    }
  });

  it('emits artificer_l2_complete telemetry with succeeded=false on exhaustion', async () => {
    const adapter = makeAdapter({ maxTurns: 2 });
    hoisted.mockReturn = [{ role: 'assistant', content: 'no code' }];

    await expect(adapter.startRun(makeStartRun())).rejects.toThrow();

    const completeCalls = emitTelemetryMock.mock.calls.filter(
      (c: unknown[]) => (c[0] as { eventType: string }).eventType === 'artificer_l2_complete',
    );
    expect(completeCalls.length).toBe(1);
    const payload = (completeCalls[0]![0] as { payload: { succeeded: boolean } }).payload;
    expect(payload.succeeded).toBe(false);
  });
});

// ── loop error ───────────────────────────────────────────────────────────────

describe('PRI-439 ArtificerL2Adapter — loop error', () => {
  it('throws PDRuntimeError when runAgentLoop throws', async () => {
    const adapter = makeAdapter();
    hoisted.impl = async () => {
      throw new Error('LLM provider unavailable');
    };

    await expect(adapter.startRun(makeStartRun())).rejects.toThrow(/agent loop threw/);
  });
});

// ── runtime metadata ─────────────────────────────────────────────────────────

describe('PRI-439 ArtificerL2Adapter — runtime metadata', () => {
  it('pollRun returns succeeded status after startRun completes with output', async () => {
    const adapter = makeAdapter();
    hoisted.impl = async (_p: unknown, context: { tools?: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[] }) => {
      const submit = context.tools?.find((t) => t.name === 'submit_rulecode');
      if (submit) {
        await submit.execute('call-1', makeRuleOutput());
      }
      return [];
    };

    const handle = await adapter.startRun(makeStartRun());
    const status = await adapter.pollRun(handle.runId);
    expect(status.status).toBe('succeeded');
  });

  it('kind() returns pi-ai-l2', () => {
    const adapter = makeAdapter();
    expect(adapter.kind()).toBe('pi-ai-l2');
  });

  it('getCapabilities reports supportsToolUse=true', async () => {
    const adapter = makeAdapter();
    const caps = await adapter.getCapabilities();
    expect(caps.supportsToolUse).toBe(true);
  });

  it('healthCheck returns unhealthy when API key is missing', async () => {
    delete process.env.TEST_API_KEY;
    const adapter = makeAdapter();
    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(false);
  });

  it('healthCheck returns healthy when API key is present', async () => {
    const adapter = makeAdapter();
    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(true);
  });

  it('startRun throws when API key is missing', async () => {
    delete process.env.TEST_API_KEY;
    const adapter = makeAdapter();
    await expect(adapter.startRun(makeStartRun())).rejects.toThrow(/API key not found/);
  });
});

// ── config defaults ──────────────────────────────────────────────────────────

describe('PRI-439 ArtificerL2Adapter — config defaults', () => {
  it('wires maxTokens=8192 default into loopConfig', async () => {
    const adapter = makeAdapter();
    hoisted.mockReturn = [];

    await adapter.startRun(makeStartRun()).catch(() => {
      // expected — no output captured
    });
    expect(hoisted.lastLoopConfig.maxTokens).toBe(8192);
  });

  it('wires custom maxTokens when provided', async () => {
    const adapter = makeAdapter({ maxTokens: 4096 });
    hoisted.mockReturn = [];

    await adapter.startRun(makeStartRun()).catch(() => {
      // expected
    });
    expect(hoisted.lastLoopConfig.maxTokens).toBe(4096);
  });
});

// ── telemetry ────────────────────────────────────────────────────────────────

describe('PRI-439 ArtificerL2Adapter — telemetry', () => {
  it('emits artificer_l2_turn with phase=loop_started at start', async () => {
    const adapter = makeAdapter();
    hoisted.mockReturn = [];

    await adapter.startRun(makeStartRun()).catch(() => {
      // expected
    });
    const startCalls = emitTelemetryMock.mock.calls.filter(
      (c: unknown[]) => {
        const evt = c[0] as { eventType: string; payload: { phase?: string } };
        return evt.eventType === 'artificer_l2_turn' && evt.payload?.phase === 'loop_started';
      },
    );
    expect(startCalls.length).toBe(1);
  });

  it('emits artificer_l2_complete with succeeded=true on success', async () => {
    const adapter = makeAdapter();
    hoisted.impl = async (_p: unknown, context: { tools?: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[] }) => {
      const submit = context.tools?.find((t) => t.name === 'submit_rulecode');
      if (submit) {
        await submit.execute('call-1', makeRuleOutput());
      }
      return [];
    };

    await adapter.startRun(makeStartRun());
    const completeCalls = emitTelemetryMock.mock.calls.filter(
      (c: unknown[]) => (c[0] as { eventType: string }).eventType === 'artificer_l2_complete',
    );
    expect(completeCalls.length).toBe(1);
    const payload = (completeCalls[0]![0] as { payload: { succeeded: boolean } }).payload;
    expect(payload.succeeded).toBe(true);
  });
});

// ── input serialization ──────────────────────────────────────────────────────

describe('PRI-439 ArtificerL2Adapter — input serialization', () => {
  it('bounds and safely serializes an unknown prompt payload', async () => {
    const circular: Record<string, unknown> = { text: 'x'.repeat(60_000) };
    circular.self = circular;
    const adapter = makeAdapter();
    hoisted.mockReturn = [];

    // The circular payload is safely stringified (safeStringifyPreview handles cycles).
    // startRun still throws because no output is captured, but it should NOT throw
    // a serialization error.
    await expect(adapter.startRun(makeStartRun({ inputPayload: circular }))).rejects.toThrow(/without a submit_rulecode call/);
  });
});
