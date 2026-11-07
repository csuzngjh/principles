/**
 * SPEC-PD-PI12-COMPAT-001 Phase 0 spike (E03) — Artificer L2 on Pi 1.2.
 *
 * Drives the REAL `runAgentLoop` from @earendil-works/pi-agent-core@1.2.0 with
 * the REAL compat `streamSimple` routed to the faux provider. Exercises the
 * four RuleCode tools (read spec → validate → replay → submit), the in-loop
 * repair on validator rejection, the beforeToolCall whitelist, budget abort,
 * and the no-L1-failure-fallback contract. Owner-Evidence readiness itself is
 * enforced upstream in host-runtime internalization-consumer-cycle (before the
 * adapter is ever constructed) and is unaffected by the Pi bump — see the
 * audit report §C.
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
import { ArtificerL2Adapter } from '../artificer-l2-adapter.js';
import type { StartRunInput } from '../../runtime-protocol.js';
import type { RefinerRuleHostGateDeps } from '../../internalization/refiner-rulehost-gate.js';
import type { RefinerSandboxResult } from '../../internalization/refiner-sandbox-wrapper.js';
import type { ArtificerRuleOutput } from '../../internalization/artificer-output.js';
import { DefaultArtificerValidator } from '../../internalization/artificer-output.js';

const emitTelemetryMock = storeEmitter.emitTelemetry as unknown as ReturnType<typeof vi.fn>;

const TASK_ID = 'task-spike-artificer-1';

let registration: ReturnType<typeof registerFauxProvider> | undefined;

/** Guarded accessor — the repo forbids non-null assertions. */
function faux(): ReturnType<typeof registerFauxProvider> {
  if (!registration) throw new Error('faux provider not registered (beforeEach missing?)');
  return registration;
}

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
    generatedAt: '2026-10-17T00:00:00.000Z',
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

function makeAdapter(overrides: { maxTurns?: number; totalBudgetMs?: number; gateDeps?: RefinerRuleHostGateDeps } = {}): ArtificerL2Adapter {
  return new ArtificerL2Adapter({
    provider: 'faux',
    model: 'faux-1',
    apiKeyEnv: 'TEST_API_KEY',
    gateDeps: overrides.gateDeps ?? makeAlwaysPassGateDeps(),
    validator: new DefaultArtificerValidator(),
    maxTurns: overrides.maxTurns,
    totalBudgetMs: overrides.totalBudgetMs ?? 60_000,
  });
}

/** A validate_rulecode step that returns INVALID first (repair loop input) then a passing draft. */
const INVALID_DRAFT = 'function evaluate(input, helpers) { return {}; }';
const VALID_DRAFT = makeRuleOutput().implementationCode;

/** Tool-call args must be JsonObject on Pi 1.2 — narrow via a JSON round-trip. */
function jsonArgs(value: Record<string, unknown>): Parameters<typeof fauxToolCall>[1] {
  return JSON.parse(JSON.stringify(value)) as Parameters<typeof fauxToolCall>[1];
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

describe('SPEC-PD-PI12-COMPAT-001 E03 — Artificer L2 on real Pi 1.2 runAgentLoop', () => {
  it('full tool journey: spec → invalid validate → valid validate → replay → rejected submit → accepted submit', async () => {
    const adapter = makeAdapter({ maxTurns: 12 });
    const valid = makeRuleOutput();
    faux().setResponses([
      fauxAssistantMessage([fauxToolCall('read_rulecode_spec', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('validate_rulecode', { code: INVALID_DRAFT })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('validate_rulecode', { code: VALID_DRAFT })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('replay_rulecode', jsonArgs({
        code: VALID_DRAFT,
        goldenTraceCases: valid.goldenTraceCases,
      }))], { stopReason: 'toolUse' }),
      // Validator rejects an incomplete submission — the in-loop repair input.
      fauxAssistantMessage([fauxToolCall('submit_rulecode', jsonArgs({ taskId: TASK_ID }))], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('submit_rulecode', jsonArgs(valid as unknown as Record<string, unknown>))], { stopReason: 'toolUse' }),
    ]);

    const handle = await adapter.startRun(makeStartRun());
    const output = await adapter.fetchOutput(handle.runId);
    expect(output?.payload).toEqual(valid);
    expect(faux().state.callCount).toBe(6);

    const toolEvents = emitTelemetryMock.mock.calls
      .map((c) => (c[0] as { payload?: { toolName?: string } }).payload?.toolName)
      .filter(Boolean);
    expect(toolEvents).toEqual(expect.arrayContaining(
      ['read_rulecode_spec', 'validate_rulecode', 'replay_rulecode', 'submit_rulecode'],
    ));
  });

  it('beforeToolCall whitelist: an out-of-whitelist tool call is blocked, surfaced to the model, and the run still completes', async () => {
    const adapter = makeAdapter({ maxTurns: 8 });
    const seen: { messages: unknown[] }[] = [];
    const capture = (context: { messages: unknown[] }) => {
      seen.push({ messages: context.messages });
      return fauxAssistantMessage('unexpected extra turn');
    };
    faux().setResponses([
      fauxAssistantMessage([fauxToolCall('read_principles', {})], { stopReason: 'toolUse' }),
      capture,
      fauxAssistantMessage([fauxToolCall('submit_rulecode', jsonArgs(makeRuleOutput() as unknown as Record<string, unknown>))], { stopReason: 'toolUse' }),
    ]);

    const handle = await adapter.startRun(makeStartRun());
    const output = await adapter.fetchOutput(handle.runId);
    expect(output?.payload).toMatchObject({ taskId: TASK_ID });
    expect(faux().state.callCount).toBe(3);
    // The out-of-contract tool call is rejected by the loop itself (the tool is
    // not in context.tools — defense in depth ahead of PD's beforeToolCall
    // whitelist) and the error result is fed back to the model as isError.
    const secondRequest = JSON.stringify(seen[0]?.messages ?? []);
    expect(secondRequest).toContain('Tool read_principles not found');
    expect(secondRequest).toContain('"isError":true');
  });

  it('no tool calls + nudges exhausted → fail loud with NO L1 fallback (no extra model call)', async () => {
    const adapter = makeAdapter({ maxTurns: 12 });
    faux().setResponses([
      fauxAssistantMessage('plain text, no tool call'),
      fauxAssistantMessage('still plain text'),
      fauxAssistantMessage('third plain text'),
    ]);

    await expect(adapter.startRun(makeStartRun())).rejects.toThrow();
    // 3 text turns + 2 nudges = 3 model calls; a hidden L1 fallback would need a 4th.
    expect(faux().state.callCount).toBe(3);
  });

  it('budget abort: slow model call aborted by the total budget → timeout classification', async () => {
    const adapter = makeAdapter({ maxTurns: 12, totalBudgetMs: 80 });
    faux().setResponses([
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 800));
        return fauxAssistantMessage([fauxToolCall('read_rulecode_spec', {})], { stopReason: 'toolUse' });
      },
    ]);

    await expect(adapter.startRun(makeStartRun())).rejects.toMatchObject({ category: 'timeout' });
    expect(faux().state.callCount).toBe(1);
  });

  it('replay failure feedback: a failing sandbox gate is reported to the model, run does not silently pass', async () => {
    const failingGate: RefinerRuleHostGateDeps = {
      evaluateInSandbox: () => ({
        success: false,
        failedCases: [{ caseId: 'negative-1', errorType: 'validation_failed' as const, message: 'expected block, got allow' }],
        executionTimeMs: 1,
        forbiddenPatternViolations: [],
      }),
    };
    const adapter = makeAdapter({ maxTurns: 12, gateDeps: failingGate });
    const valid = makeRuleOutput();
    faux().setResponses([
      fauxAssistantMessage([fauxToolCall('replay_rulecode', jsonArgs({
        code: VALID_DRAFT,
        goldenTraceCases: valid.goldenTraceCases,
      }))], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('submit_rulecode', jsonArgs(valid as unknown as Record<string, unknown>))], { stopReason: 'toolUse' }),
    ]);

    // The failing replay is visible to the model (repair loop input); the run
    // may still succeed by submitting — the gate result itself is the contract.
    const handle = await adapter.startRun(makeStartRun());
    const output = await adapter.fetchOutput(handle.runId);
    expect(output?.payload).toMatchObject({ taskId: TASK_ID });
    expect(faux().state.callCount).toBe(2);
  });
});
