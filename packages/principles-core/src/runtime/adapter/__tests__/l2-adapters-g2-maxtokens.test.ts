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
 * runAgentLoop is mocked (no LLM calls); pi-ai catalog stubs supply a model
 * ceiling of 32000 so the min() chain is assertable. No network, no keys.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type LoopCfg = { maxTokens?: number; model?: unknown };

const dreamerHoisted = vi.hoisted((): { lastLoopConfig: LoopCfg } => ({ lastLoopConfig: {} }));
const artificerHoisted = vi.hoisted((): { lastLoopConfig: LoopCfg; expecting: boolean } => ({ lastLoopConfig: {}, expecting: false }));

vi.mock('@earendil-works/pi-agent-core', () => ({
  runAgentLoop: vi.fn(async (_prompts: unknown, _context: unknown, config: LoopCfg) => {
    // Both adapters under test live in this file; route by presence of their
    // distinct config keys (dreamer carries beforeToolCall, artificer carries
    // maxNoToolCallNudges machinery) — simplest reliable discriminator is the
    // recorded target set by each describe's adapter construction.
    if (artificerHoisted.expecting) {
      artificerHoisted.lastLoopConfig = config;
    } else {
      dreamerHoisted.lastLoopConfig = config;
    }
    return [];
  }),
}));

vi.mock('@earendil-works/pi-ai', () => ({
  completeSimple: vi.fn(),
  getModel: vi.fn(() => ({ id: 'test', name: 'test', api: 'openai-completions', provider: 'test-provider', maxTokens: 32_000 })),
  getProviders: vi.fn(() => []),
}));

vi.mock('@earendil-works/pi-ai/compat', () => ({
  getModel: vi.fn(() => ({ id: 'test', name: 'test', api: 'openai-completions', provider: 'test-provider', maxTokens: 32_000 })),
  getProviders: vi.fn(() => []),
  completeSimple: vi.fn(),
  streamSimple: vi.fn(),
}));

vi.mock('../../store/event-emitter.js', () => ({
  storeEmitter: { emitTelemetry: vi.fn() },
}));

import { L2AgentLoopAdapter } from '../l2-agent-loop-adapter.js';
import { ArtificerL2Adapter } from '../artificer-l2-adapter.js';
import { DefaultArtificerValidator } from '../../internalization/artificer-output.js';
import type { StartRunInput } from '../../runtime-protocol.js';

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

beforeEach(() => {
  process.env[API_KEY_ENV] = 'offline-dummy-not-a-credential';
  dreamerHoisted.lastLoopConfig = {};
  artificerHoisted.lastLoopConfig = {};
  artificerHoisted.expecting = false;
});

describe('P2: Dreamer L2 honors StartRunInput.maxTokens on every loop turn', () => {
  it('a present budget reaches loopConfig.maxTokens (and the model metadata) verbatim', async () => {
    const adapter = new L2AgentLoopAdapter(
      { provider: 'test-provider', model: 'test', apiKeyEnv: API_KEY_ENV, baseUrl: 'https://unit.test/v1', maxTurns: 2, maxEmptyRetries: 0, l2FallbackToL1: false, totalBudgetMs: 10_000 },
      dreamerDeps,
    );
    artificerHoisted.expecting = false;
    try {
      await adapter.startRun(makeInput({ maxTokens: 1234 }));
    } catch { /* loop mock returns no output — the loopConfig is the assertion */ }
    expect(dreamerHoisted.lastLoopConfig.maxTokens).toBe(1234);
  });

  it('an absent budget keeps legacy behavior: no maxTokens key (pi-ai native defaulting)', async () => {
    const adapter = new L2AgentLoopAdapter(
      { provider: 'test-provider', model: 'test', apiKeyEnv: API_KEY_ENV, baseUrl: 'https://unit.test/v1', maxTurns: 2, maxEmptyRetries: 0, l2FallbackToL1: false, totalBudgetMs: 10_000 },
      dreamerDeps,
    );
    artificerHoisted.expecting = false;
    try {
      await adapter.startRun(makeInput());
    } catch { /* loop mock returns no output */ }
    expect('maxTokens' in dreamerHoisted.lastLoopConfig).toBe(false);
  });

  it('the model output ceiling caps an oversized budget (32000 over 99000)', async () => {
    const adapter = new L2AgentLoopAdapter(
      { provider: 'test-provider', model: 'test', apiKeyEnv: API_KEY_ENV, baseUrl: 'https://unit.test/v1', maxTurns: 2, maxEmptyRetries: 0, l2FallbackToL1: false, totalBudgetMs: 10_000 },
      dreamerDeps,
    );
    artificerHoisted.expecting = false;
    try {
      await adapter.startRun(makeInput({ maxTokens: 99_000 }));
    } catch { /* loop mock */ }
    expect(dreamerHoisted.lastLoopConfig.maxTokens).toBe(32_000);
  });

  it('invalid budgets fail loud as input_invalid before any loop runs', async () => {
    const adapter = new L2AgentLoopAdapter(
      { provider: 'test-provider', model: 'test', apiKeyEnv: API_KEY_ENV, baseUrl: 'https://unit.test/v1', maxTurns: 2, maxEmptyRetries: 0, l2FallbackToL1: false, totalBudgetMs: 10_000 },
      dreamerDeps,
    );
    artificerHoisted.expecting = false;
    await expect(adapter.startRun(makeInput({ maxTokens: 0 }))).rejects.toMatchObject({ category: 'input_invalid' });
    await expect(adapter.startRun(makeInput({ maxTokens: -5 }))).rejects.toMatchObject({ category: 'input_invalid' });
    await expect(adapter.startRun(makeInput({ maxTokens: 12.5 }))).rejects.toMatchObject({ category: 'input_invalid' });
  });
});

describe('P2: Artificer L2 honors StartRunInput.maxTokens (min with profile default)', () => {
  function makeArtificer(maxTokens: number | undefined) {
    artificerHoisted.expecting = true;
    return new ArtificerL2Adapter({
      provider: 'test-provider',
      model: 'test',
      apiKeyEnv: API_KEY_ENV,
      baseUrl: 'https://unit.test/v1',
      gateDeps: { evaluateInSandbox: () => ({ success: true, failedCases: [], executionTimeMs: 1, forbiddenPatternViolations: [] }) },
      validator: new DefaultArtificerValidator(),
      maxTurns: 2,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      totalBudgetMs: 10_000,
    });
  }

  it('per-request 777 wins over the profile default (8192)', async () => {
    try {
      await makeArtificer(8192).startRun(makeInput({ maxTokens: 777, agentSpec: { agentId: 'artificer', schemaVersion: 'v1' } }));
    } catch { /* loop mock */ }
    expect(artificerHoisted.lastLoopConfig.maxTokens).toBe(777);
  });

  it('profile default still applies when no per-request budget is passed (8192)', async () => {
    try {
      await makeArtificer(8192).startRun(makeInput({ agentSpec: { agentId: 'artificer', schemaVersion: 'v1' } }));
    } catch { /* loop mock */ }
    expect(artificerHoisted.lastLoopConfig.maxTokens).toBe(8192);
  });

  it('an oversized per-request budget is capped by the profile (4096 over 900000)', async () => {
    try {
      await makeArtificer(4096).startRun(makeInput({ maxTokens: 900_000, agentSpec: { agentId: 'artificer', schemaVersion: 'v1' } }));
    } catch { /* loop mock */ }
    expect(artificerHoisted.lastLoopConfig.maxTokens).toBe(4096);
  });

  it('invalid budgets fail loud as input_invalid', async () => {
    await expect(makeArtificer(4096).startRun(makeInput({ maxTokens: Number.NaN, agentSpec: { agentId: 'artificer', schemaVersion: 'v1' } })))
      .rejects.toMatchObject({ category: 'input_invalid' });
  });
});
