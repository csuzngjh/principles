/**
 * SPEC-PD-PI12-COMPAT-001 Phase 0 spike (E02) — Dreamer L2 on Pi 1.2.
 *
 * Unlike l2-agent-loop-adapter.test.ts (which mocks runAgentLoop), this file
 * drives the REAL `runAgentLoop` from @earendil-works/pi-agent-core@1.2.0 with
 * the REAL compat `streamSimple` routed to the registered faux provider —
 * zero network, zero paid calls. Only the catalog lookups (getModel /
 * getProviders) are stubbed so `resolveL2Model` adopts the faux model through
 * its provider-membership path; everything else is the production code path.
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
import { registerFauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/compat';
import { L2AgentLoopAdapter } from '../l2-agent-loop-adapter.js';
import type { StartRunInput } from '../../runtime-protocol.js';
import type { PdL2ArtifactReader, PdL2PrincipleReader } from '../../tools/agent-tool-contract.js';

const emitTelemetryMock = storeEmitter.emitTelemetry as unknown as ReturnType<typeof vi.fn>;

const artifactReader: PdL2ArtifactReader = {
  getArtifactById: async () => null,
  listBySourceTaskId: async () => [],
};
const principleReader: PdL2PrincipleReader = {
  listActivePrinciples: async () => [],
};

const VALID_DREAMER_OUTPUT = {
  valid: true,
  taskId: 'task-spike-dreamer-1',
  candidates: [
    { candidateIndex: 0, badDecision: 'x', betterDecision: 'y', rationale: 'r', confidence: 0.5, riskLevel: 'low', strategicPerspective: 's' },
  ],
  contextRefs: ['ref-1'],
  generatedAt: '2026-10-17T00:00:00.000Z',
};

interface SeenRequest {
  messages: { role: string; text?: string; toolsAdded?: string[] }[];
}
type Registration = ReturnType<typeof registerFauxProvider>;

let registration: Registration | undefined;

/** Guarded accessor — the repo forbids non-null assertions. */
function faux(): Registration {
  if (!registration) throw new Error('faux provider not registered (beforeEach missing?)');
  return registration;
}

function makeStartRun(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    agentSpec: { agentId: 'dreamer', schemaVersion: 'v1' },
    taskRef: { taskId: 'task-spike-dreamer-1' },
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
      provider: 'faux',
      model: 'faux-1',
      apiKeyEnv: 'TEST_API_KEY',
      maxTurns: overrides.maxTurns,
      maxEmptyRetries: overrides.maxEmptyRetries,
      l2FallbackToL1: overrides.l2FallbackToL1,
      totalBudgetMs: overrides.totalBudgetMs ?? 60_000,
    },
    { artifactReader, principleReader },
  );
}

/** Capture the request transcript the model actually saw (roles + text + declared tools). */
function capture(seen: SeenRequest[]) {
  return (context: { messages: unknown[] }) => {
    seen.push({
      messages: context.messages.map((m) => {
        const msg = m as { role: string; content?: unknown; toolsAdded?: { name: string }[] };
        let text: string | undefined;
        if (typeof msg.content === 'string') text = msg.content;
        else if (Array.isArray(msg.content)) {
          const textBlock = msg.content.find((b) => (b as { type?: string })?.type === 'text') as { text?: string } | undefined;
          text = textBlock?.text;
        }
        return { role: msg.role, text, toolsAdded: msg.toolsAdded?.map((t) => t.name) };
      }),
    });
    return fauxAssistantMessage([fauxToolCall('read_principles', {})], { stopReason: 'toolUse' });
  };
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

describe('SPEC-PD-PI12-COMPAT-001 E02 — Dreamer L2 on real Pi 1.2 runAgentLoop', () => {
  it('tool call → submit_output terminates the loop; request transcript is the Pi 1.2 shape', async () => {
    const seen: SeenRequest[] = [];
    const adapter = makeAdapter({ maxTurns: 5 });
    faux().setResponses([
      capture(seen),
      fauxAssistantMessage([fauxToolCall('submit_output', VALID_DREAMER_OUTPUT)], { stopReason: 'toolUse' }),
    ]);

    const handle = await adapter.startRun(makeStartRun({ systemPrompt: 'BASE ROLE LAYER' }));
    const output = await adapter.fetchOutput(handle.runId);
    expect(output?.payload).toEqual(VALID_DREAMER_OUTPUT);
    // submit_output captured → finishTurn ended the loop: exactly 2 model calls, no 3rd.
    expect(faux().state.callCount).toBe(2);

    // First request transcript (Pi 1.2): [system(prompt + tool declarations), user] — exactly once each.
    expect(seen.length).toBeGreaterThan(0);
    const first = seen[0] as SeenRequest;
    expect(first.messages.map((m) => m.role)).toEqual(['system', 'user']);
    const sys = first.messages[0] as SeenRequest['messages'][number];
    expect(sys.text).toContain('BASE ROLE LAYER');
    expect(sys.text).toContain('--- Tool protocol (L2 mode) ---');
    expect(sys.toolsAdded).toEqual(
      expect.arrayContaining(['read_principles', 'read_artifact', 'submit_output']),
    );
    const userMsg = first.messages[1] as SeenRequest['messages'][number];
    expect(userMsg.text).toBe('{"prompt":"generate candidates"}');
  });

  it('a mixed tool batch does not end the loop early — both tools run, submit follows', async () => {
    const adapter = makeAdapter({ maxTurns: 5 });
    faux().setResponses([
      fauxAssistantMessage(
        [fauxToolCall('read_principles', {}), fauxToolCall('read_artifact', { artifactId: 'a-1' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxToolCall('submit_output', VALID_DREAMER_OUTPUT)], { stopReason: 'toolUse' }),
    ]);

    const handle = await adapter.startRun(makeStartRun());
    const output = await adapter.fetchOutput(handle.runId);
    expect(output?.payload).toEqual(VALID_DREAMER_OUTPUT);
    expect(faux().state.callCount).toBe(2);
    const toolEvents = emitTelemetryMock.mock.calls
      .map((c) => (c[0] as { payload?: { toolName?: string } }).payload?.toolName)
      .filter(Boolean);
    expect(toolEvents).toEqual(expect.arrayContaining(['read_principles', 'read_artifact']));
  });

  it('turn cap: repeated tool turns stop at maxTurns with no unbounded model calls', async () => {
    const adapter = makeAdapter({ maxTurns: 3, maxEmptyRetries: 0, l2FallbackToL1: false });
    const seen: SeenRequest[] = [];
    faux().setResponses([capture(seen), capture(seen), capture(seen), capture(seen), capture(seen)]);

    await expect(adapter.startRun(makeStartRun())).rejects.toMatchObject({ category: 'output_invalid' });
    // finishTurn ends the loop on turn 3 — the 4th/5th scripted responses stay unconsumed.
    expect(faux().state.callCount).toBe(3);
  });

  it('budget abort: a slow model call is aborted by the total budget and fails loud', async () => {
    const adapter = makeAdapter({ maxTurns: 5, totalBudgetMs: 80, maxEmptyRetries: 0, l2FallbackToL1: false });
    faux().setResponses([
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 800));
        return fauxAssistantMessage([fauxToolCall('submit_output', VALID_DREAMER_OUTPUT)], { stopReason: 'toolUse' });
      },
    ]);

    // 0.85-parity semantics: the aborted turn yields no submit_output and no
    // parseable text, so the (fallback-disabled) dreamer fails loud as
    // output_invalid — the strict abort classification lives in Artificer
    // (PRI-795). The contract here: bounded calls + loud failure, never a
    // silent success.
    await expect(adapter.startRun(makeStartRun())).rejects.toMatchObject({ category: 'output_invalid' });
    expect(faux().state.callCount).toBe(1);
  });

  it('L2 empty → L1 fallback still works end-to-end on Pi 1.2 (single completeSimple)', async () => {
    const adapter = makeAdapter({ maxTurns: 5, maxEmptyRetries: 2, l2FallbackToL1: true });
    faux().setResponses([
      fauxAssistantMessage('no tool call, plain text'),
      fauxAssistantMessage('still no tool call'),
      fauxAssistantMessage('third empty attempt'),
      fauxAssistantMessage(JSON.stringify(VALID_DREAMER_OUTPUT)),
    ]);

    const handle = await adapter.startRun(makeStartRun());
    const output = await adapter.fetchOutput(handle.runId);
    expect(output?.payload).toEqual(VALID_DREAMER_OUTPUT);
    // 3 empty L2 attempts + exactly 1 L1 completeSimple call.
    expect(faux().state.callCount).toBe(4);
    const events = emitTelemetryMock.mock.calls.map((c) => (c[0] as { eventType?: string }).eventType);
    expect(events).toContain('dreamer_l2_fallback_to_l1');
  });
});
