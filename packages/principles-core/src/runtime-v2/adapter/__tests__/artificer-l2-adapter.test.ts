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
  timeoutMs?: number;
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

// streamSimple is imported from @earendil-works/pi-ai/compat by artificer-l2-adapter
// and passed to the mocked runAgentLoop. Use the real implementation so other
// compat exports (getProviders/getModel/completeSimple) used by resolveL2Model
// remain intact — runAgentLoop is mocked, so streamSimple is never invoked.


vi.mock('../../store/event-emitter.js', () => ({
  storeEmitter: { emitTelemetry: vi.fn() },
}));

import { storeEmitter } from '../../store/event-emitter.js';
import { ArtificerL2Adapter } from '../artificer-l2-adapter.js';
import { PDRuntimeError } from '../../error-categories.js';
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
  systemPrompt?: string;
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
    systemPrompt: overrides.systemPrompt,
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
    const {runs} = (adapter as unknown as { runs: Map<string, { output: unknown }> });
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
    const [firstCall] = completeCalls;
    if (!firstCall) throw new Error('expected artificer_l2_complete call');
    const {payload} = (firstCall[0] as { payload: { succeeded: boolean } });
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

  // PRI-758/EP002-R3: LLM-call failures arrive as message_end with
  // stopReason 'error'/'aborted' — the loop ends without calling
  // shouldStopAfterTurn, so the adapter must surface them loudly itself.
  it('surfaces LLM stream stopReason=error as the failure reason', async () => {
    const adapter = makeAdapter();
    // eslint-disable-next-line @typescript-eslint/max-params -- mirrors the 5-param runAgentLoop signature
    hoisted.impl = async (_p: unknown, _c: unknown, _cfg: unknown, emit: (e: unknown) => Promise<void>) => {
      await emit({ type: 'message_end', message: { stopReason: 'error', errorMessage: 'boom from provider' } });
      return [];
    };

    await expect(adapter.startRun(makeStartRun())).rejects.toThrow(/stopReason=error.*boom from provider/);
  });
});

// ── no-tool-call nudge continuation (EP002-R3) ───────────────────────────────

describe('PRI-758/EP002-R3 ArtificerL2Adapter — getFollowUpMessages nudge', () => {
  interface FollowUpMessage { role: string; content: string }

  function makeGetFollowUp(): (cfg: { getFollowUpMessages?: () => Promise<FollowUpMessage[]> }) => Promise<FollowUpMessage[]> {
    return async (cfg) => {
      if (typeof cfg.getFollowUpMessages !== 'function') throw new Error('getFollowUpMessages missing from loopConfig');
      return cfg.getFollowUpMessages();
    };
  }

  it('returns bounded nudges (≤2) while no output is captured', async () => {
    const adapter = makeAdapter();
    const getFollowUp = makeGetFollowUp();
    hoisted.impl = async (_p: unknown, _c: unknown, cfg: { getFollowUpMessages?: () => Promise<FollowUpMessage[]> }) => {
      const first = await getFollowUp(cfg);
      const second = await getFollowUp(cfg);
      const third = await getFollowUp(cfg);
      expect(first).toHaveLength(1);
      expect(first[0]?.role).toBe('user');
      expect(first[0]?.content).toMatch(/submit_rulecode/);
      expect(second).toHaveLength(1);
      expect(third).toHaveLength(0);
      return [];
    };

    await expect(adapter.startRun(makeStartRun())).rejects.toThrow(/agent loop ended without a submit_rulecode call/);
  });

  it('stops nudging once output has been captured', async () => {
    const adapter = makeAdapter();
    const getFollowUp = makeGetFollowUp();
    hoisted.impl = async (_p: unknown, context: { tools?: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[] }, cfg: { getFollowUpMessages?: () => Promise<FollowUpMessage[]> }) => {
      const submit = context.tools?.find((t) => t.name === 'submit_rulecode');
      if (submit) {
        await submit.execute('call-1', makeRuleOutput());
      }
      const followUp = await getFollowUp(cfg);
      expect(followUp).toHaveLength(0);
      return [];
    };

    const handle = await adapter.startRun(makeStartRun());
    const output = await adapter.fetchOutput(handle.runId);
    expect(output?.payload).toEqual(makeRuleOutput());
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
    const [firstCall] = completeCalls;
    if (!firstCall) throw new Error('expected artificer_l2_complete call');
    const {payload} = (firstCall[0] as { payload: { succeeded: boolean } });
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

// ── PRI-633 — layered systemPrompt placement ─────────────────────────────────

describe('PRI-633 — layered systemPrompt placement', () => {
  it('agentContext.systemPrompt = base → tool protocol → profile append; user message carries only task data', async () => {
    let captured: { systemPrompt?: string; messages: { role: string; content: unknown }[]; tools?: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[] } | undefined;
    hoisted.impl = async (_p: unknown, context: unknown) => {
      captured = context as { systemPrompt?: string; messages: { role: string; content: unknown }[]; tools?: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[] };
      const submit = captured.tools?.find((t) => t.name === 'submit_rulecode');
      if (submit) await submit.execute('call-1', makeRuleOutput());
      return [];
    };
    const adapter = makeAdapter({ systemPrompt: 'PROFILE APPEND LAYER' });
    await adapter.startRun(makeStartRun({ systemPrompt: 'BASE ROLE LAYER' }));

    const sp = captured?.systemPrompt ?? '';
    expect(sp).toContain('BASE ROLE LAYER');
    expect(sp).toContain('--- Tool protocol (Artificer L2 mode, PRI-439) ---');
    expect(sp).toContain('PROFILE APPEND LAYER');
    expect(sp.indexOf('BASE ROLE LAYER')).toBeLessThan(sp.indexOf('--- Tool protocol'));
    expect(sp.indexOf('--- Tool protocol')).toBeLessThan(sp.indexOf('PROFILE APPEND LAYER'));
    // The user message no longer carries the tool protocol (PRI-633).
    const first = captured?.messages[0];
    expect(first?.role).toBe('user');
    expect(first?.content).toBe('initial prompt');
  });
});

// ── PRI-795 — abort ownership & timeout contract ─────────────────────────────

describe('PRI-795 ArtificerL2Adapter — abort ownership & timeout contract', () => {
  /** Start-run promise → thrown PDRuntimeError (null when it resolves). */
  async function captureError(adapter: ArtificerL2Adapter): Promise<PDRuntimeError | null> {
    try {
      await adapter.startRun(makeStartRun());
      return null;
    } catch (err) {
      expect(err).toBeInstanceOf(PDRuntimeError);
      return err as PDRuntimeError;
    }
  }

  function completePayload(): Record<string, unknown> | undefined {
    const call = emitTelemetryMock.mock.calls.find(
      (c: unknown[]) => (c[0] as { eventType: string }).eventType === 'artificer_l2_complete',
    );
    return call ? (call[0] as { payload: Record<string, unknown> }).payload : undefined;
  }

  it('Case 1: PD budget timeout → category timeout, failureKind=pd_budget_timeout, abortOwner=pd_budget (NOT output_invalid)', async () => {
    const adapter = makeAdapter({ totalBudgetMs: 60 });
    // Mirror the REAL failure path (EP002-R3 live evidence): the budget timer
    // aborts OUR signal → pi-ai marks stopReason=aborted → the agent loop
    // returns SILENTLY (no throw). The old code misclassified this as
    // output_invalid because `timedOut = budgetTimedOut` lived only in the
    // catch block, which never ran.
    // eslint-disable-next-line @typescript-eslint/max-params -- mirrors the 5-param runAgentLoop signature
    hoisted.impl = async (_p: unknown, _c: unknown, _cfg: unknown, emit: (e: unknown) => Promise<void>, signal?: AbortSignal) => {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) { resolve(); return; }
        signal?.addEventListener('abort', () => resolve(), { once: true });
        setTimeout(resolve, 5_000); // safety valve
      });
      await emit({ type: 'message_end', message: { stopReason: 'aborted', errorMessage: 'Request was aborted' } });
      return [];
    };

    const err = await captureError(adapter);
    if (!err) throw new Error('expected startRun to reject');
    expect(err.category).toBe('timeout');
    expect(err.message).toContain('failureKind=pd_budget_timeout');
    expect(err.message).toContain('abortOwner=pd_budget');
    expect(err.message).toContain('stopReason=aborted');

    const payload = completePayload();
    expect(payload?.abortOwner).toBe('pd_budget');
    expect(payload?.failureKind).toBe('pd_budget_timeout');
    expect(typeof payload?.budgetMs).toBe('number');
    expect(typeof payload?.elapsedMs).toBe('number');
    expect((payload?.elapsedMs as number) >= 60).toBe(true);
  });

  it('Case 2: provider timeout (stopReason=error, timeout-like message) → execution_failed, failureKind=provider_timeout', async () => {
    const adapter = makeAdapter();
    // eslint-disable-next-line @typescript-eslint/max-params -- mirrors the 5-param runAgentLoop signature
    hoisted.impl = async (_p: unknown, _c: unknown, _cfg: unknown, emit: (e: unknown) => Promise<void>) => {
      await emit({ type: 'message_end', message: { stopReason: 'error', errorMessage: 'Request timed out' } });
      return [];
    };

    const err = await captureError(adapter);
    if (!err) throw new Error('expected startRun to reject');
    expect(err.category).toBe('execution_failed');
    expect(err.message).toContain('failureKind=provider_timeout');
    expect(completePayload()?.failureKind).toBe('provider_timeout');
  });

  it('provider error without timeout wording → failureKind=provider_error', async () => {
    const adapter = makeAdapter();
    // eslint-disable-next-line @typescript-eslint/max-params -- mirrors the 5-param runAgentLoop signature
    hoisted.impl = async (_p: unknown, _c: unknown, _cfg: unknown, emit: (e: unknown) => Promise<void>) => {
      await emit({ type: 'message_end', message: { stopReason: 'error', errorMessage: 'boom from provider' } });
      return [];
    };

    const err = await captureError(adapter);
    if (!err) throw new Error('expected startRun to reject');
    expect(err.category).toBe('execution_failed');
    expect(err.message).toContain('failureKind=provider_error');
  });

  it('Case 3: manual cancelRun → category cancelled, failureKind=cancelled, abortOwner=cancelled', async () => {
    const adapter = makeAdapter({ totalBudgetMs: 30_000 });
    // cancelRun is invoked while the loop is in flight (state registered at
    // startRun entry, before the loop starts) — mirrors BasePeerRunner's
    // cancel path timing.
    hoisted.impl = async () => {
      const [runId] = [...(adapter as unknown as { runs: Map<string, unknown> }).runs.keys()];
      if (!runId) throw new Error('run not registered before loop start');
      await adapter.cancelRun(runId);
      return []; // silent return, like the real aborted path
    };

    const err = await captureError(adapter);
    if (!err) throw new Error('expected startRun to reject');
    expect(err.category).toBe('cancelled');
    expect(err.message).toContain('failureKind=cancelled');
    expect(err.message).toContain('abortOwner=cancelled');

    const payload = completePayload();
    expect(payload?.abortOwner).toBe('cancelled');
    expect(payload?.failureKind).toBe('cancelled');
  });

  it('abort by neither budget nor cancel → failureKind=stream_aborted with UNKNOWN owner, never output_invalid', async () => {
    const adapter = makeAdapter({ totalBudgetMs: 30_000 });
    hoisted.impl = async () => {
      // Abort the controller WITHOUT setting either ownership flag —
      // simulates an aborter outside the adapter contract.
      const [controller] = [...(adapter as unknown as { abortControllers: Map<string, AbortController> }).abortControllers.values()];
      controller?.abort();
      return []; // silent return, like the real aborted path
    };

    const err = await captureError(adapter);
    if (!err) throw new Error('expected startRun to reject');
    expect(err.category).toBe('execution_failed');
    expect(err.message).toContain('failureKind=stream_aborted');
    expect(err.message).toContain('UNKNOWN owner');
  });

  it('Case 4: normal completion → success with evidence payload (abortOwner=none, token usage from transcript)', async () => {
    const adapter = makeAdapter();
    hoisted.impl = async (_p: unknown, context: { tools?: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[] }) => {
      const submit = context.tools?.find((t) => t.name === 'submit_rulecode');
      if (submit) {
        await submit.execute('call-1', makeRuleOutput());
      }
      // Transcript carrying pi-ai usage on the final assistant message.
      return [
        { role: 'assistant', content: [], usage: { input: 100, output: 50, totalTokens: 150 }, stopReason: 'toolUse' },
      ];
    };

    const handle = await adapter.startRun(makeStartRun());
    const output = await adapter.fetchOutput(handle.runId);
    expect(output?.payload).toEqual(makeRuleOutput());

    const payload = completePayload();
    expect(payload?.succeeded).toBe(true);
    expect(payload?.abortOwner).toBe('none');
    expect(payload?.stopReason).toBe('toolUse');
    expect(payload?.tokenUsage).toEqual({ status: 'ok', inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    expect(typeof payload?.elapsedMs).toBe('number');
    expect(payload?.model).toMatchObject({ provider: 'test-provider', model: 'test-model' });
  });

  it('marks token usage unavailable when the transcript carries none — never fabricated', async () => {
    const adapter = makeAdapter();
    hoisted.impl = async () => [];
    await captureError(adapter);
    expect(completePayload()?.tokenUsage).toEqual({ status: 'unavailable' });
  });

  it('timeout contract: loopConfig.timeoutMs equals the total budget (explicit SDK ceiling, no silent 600s default)', async () => {
    const adapter = makeAdapter({ totalBudgetMs: 120_000 });
    hoisted.mockReturn = [];
    await captureError(adapter);
    expect(hoisted.lastLoopConfig.timeoutMs).toBe(120_000);
  });

  it('loop_started telemetry carries the model config + requestTimeoutMs for diagnosis', async () => {
    const adapter = makeAdapter();
    hoisted.mockReturn = [];
    await captureError(adapter);
    const startCall = emitTelemetryMock.mock.calls.find(
      (c: unknown[]) => {
        const evt = c[0] as { eventType: string; payload: { phase?: string } };
        return evt.eventType === 'artificer_l2_turn' && evt.payload?.phase === 'loop_started';
      },
    );
    const {payload} = (startCall?.[0] as { payload: Record<string, unknown> });
    expect(payload.requestTimeoutMs).toBe(60_000);
    expect(payload.provider).toBe('test-provider');
    expect(payload.model).toBe('test-model');
    expect(payload.reasoning).toBe('unavailable');
  });
});
