/**
 * PRI-606 regression tests — CORE_PRINCIPLES (T-01..T-10) injection.
 *
 * BUG (PRI-606): the only injection channel read evolutionReducer.getActivePrinciples(),
 * which rebuilds state purely from memory/evolution.jsonl events. A fresh install has
 * zero principle events, so <core_principles> was ALWAYS empty and the canonical
 * T-01..T-10 axioms never reached the agent's system context.
 *
 * FIX: prompt.ts injects the axioms directly from the @principles/core registry
 * (formatCorePrinciplesList). These tests pin the production path:
 * they call the real handleBeforePromptBuild entry point with an EMPTY reducer
 * (fresh-install simulation) and assert the final appendSystemContext output.
 *
 * EP-02 (Error Experience Handbook): component exists with isolated tests but the
 * production path never called it — these tests exercise the production entry point.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Mock dependencies (same pattern as prompt-golden.test.ts) ───────────────

const ORIGINAL_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED = process.env.PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED = 'true';
  sessionGfiValue = 20;
});

afterEach(() => {
  if (ORIGINAL_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED === undefined) {
    delete process.env.PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED;
  } else {
    process.env.PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED = ORIGINAL_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED;
  }
});

vi.mock('../../src/core/diagnostician-task-store.js', async () => ({
  getPendingDiagnosticianTasks: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: {
    get: vi.fn().mockReturnValue({
      recordHeartbeatDiagnosis: vi.fn(),
      recordRuntimeV2ActivationsInjected: vi.fn(),
      recordPainSignal: vi.fn(),
    }),
  },
}));

// Mutable session mock
let sessionGfiValue = 20;
vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn().mockImplementation(() => ({ currentGfi: sessionGfiValue })),
  resetFriction: vi.fn(),
  trackFriction: vi.fn(),
  setInjectedProbationIds: vi.fn(),
  clearInjectedProbationIds: vi.fn(),
  decayGfi: vi.fn(),
  getGfiDecayElapsed: vi.fn().mockReturnValue(0),
}));

vi.mock('../../src/core/path-resolver.js', () => {
  const MockPathResolver = vi.fn().mockImplementation(() => ({}));
  MockPathResolver.getExtensionRoot = vi.fn().mockReturnValue('/fake/extension');
  return { PathResolver: MockPathResolver, __esModule: true };
});

vi.mock('../../src/core/workspace-context.js', () => {
  const mockWctx = {
    workspaceDir: '/fake/workspace',
    stateDir: '/fake/state',
    resolve: (key: string) => `/fake/${key}`,
    trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn(), listAssistantTurns: vi.fn().mockReturnValue([]), recordPainEvent: vi.fn() },
    config: { get: vi.fn() },
    eventLog: {
      recordPainSignal: vi.fn(),
      recordRuntimeV2ActivationsInjected: vi.fn(),
      recordHeartbeatDiagnosis: vi.fn(),
    },
    // KEY: reducer returns EMPTY — simulates a fresh install where
    // memory/evolution.jsonl has no principle events (the PRI-606 scene).
    evolutionReducer: {
      getActivePrinciples: vi.fn().mockReturnValue([]),
      getProbationPrinciples: vi.fn().mockReturnValue([]),
    },
  };
  return {
    WorkspaceContext: {
      fromHookContext: vi.fn().mockReturnValue(mockWctx),
      fromHookContextExplicit: vi.fn().mockReturnValue(mockWctx),
    },
  };
});

vi.mock('../../src/core/principle-injection.js', () => ({
  selectPrinciplesForInjection: vi.fn().mockImplementation((principles: unknown[]) => ({
    selected: principles,
    wasTruncated: false,
    breakdown: { p0: 0, p1: 0, p2: 0 },
    totalChars: 0,
  })),
  DEFAULT_PRINCIPLE_BUDGET: 3000,
}));

vi.mock('../../src/core/empathy-keyword-matcher.js', () => ({
  matchEmpathyKeywords: vi.fn().mockReturnValue({ score: 0, matched: null, severity: 'none', matchedTerms: [] }),
  loadKeywordStore: vi.fn().mockReturnValue({ terms: {}, stats: { totalHits: 0 } }),
  saveKeywordStore: vi.fn(),
  shouldTriggerOptimization: vi.fn().mockReturnValue(false),
  getKeywordStoreSummary: vi.fn().mockReturnValue({ totalTerms: 0, highFalsePositiveTerms: [] }),
}));

vi.mock('../../src/core/empathy-types.js', () => ({
  severityToPenalty: vi.fn().mockReturnValue(5),
  DEFAULT_EMPATHY_KEYWORD_CONFIG: {},
}));

vi.mock('../../src/core/correction-cue-learner.js', () => ({
  CorrectionCueLearner: {
    get: vi.fn().mockReturnValue({
      match: vi.fn().mockReturnValue({ matched: null, matchedTerms: [], confidence: 0 }),
      recordHits: vi.fn(),
      recordTruePositive: vi.fn(),
      flush: vi.fn(),
    }),
  },
}));

vi.mock('../../src/core/focus-history.js', () => ({
  extractSummary: vi.fn().mockReturnValue(''),
  getHistoryVersions: vi.fn().mockResolvedValue([]),
  parseWorkingMemorySection: vi.fn().mockReturnValue(null),
  workingMemoryToInjection: vi.fn().mockReturnValue(''),
  autoCompressFocus: vi.fn().mockReturnValue({ compressed: false, reason: 'not_needed' }),
  safeReadCurrentFocus: vi.fn().mockReturnValue({ content: '', recovered: false, validationErrors: [] }),
}));

vi.mock('../../src/core/pain-diagnostic-gate.js', () => ({
  evaluatePainDiagnosticGate: vi.fn().mockReturnValue({ shouldDiagnose: false, detail: 'test-mock' }),
}));

vi.mock('../../src/hooks/pain.js', () => ({
  emitPainDetectedEvent: vi.fn().mockResolvedValue(undefined),
  buildTrajectoryEvidence: vi.fn().mockReturnValue({}),
}));

vi.mock('../../src/hooks/message-sanitize.js', () => ({
  sanitizeForEvidence: vi.fn().mockReturnValue(''),
}));

vi.mock('../../src/core/runtime-v2-prompt-activation-reader.js', () => ({
  PromptActivationReader: vi.fn().mockImplementation(() => ({
    readActivatedPrinciples: vi.fn().mockResolvedValue({
      principles: [],
      warnings: [],
    }),
  })),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(overrides: {
  prompt?: string;
  messages?: unknown[];
  trigger?: string;
  sessionId?: string;
} = {}) {
  return {
    prompt: overrides.prompt ?? 'hello world',
    messages: overrides.messages ?? [],
    trigger: overrides.trigger ?? 'heartbeat',
    sessionId: overrides.sessionId ?? 'test-session-123',
  } as unknown as Parameters<typeof import('../../src/hooks/prompt.js').handleBeforePromptBuild>[0];
}

function makeCtx(): unknown {
  return {
    workspaceDir: '/fake/workspace',
    trigger: 'heartbeat',
    sessionId: 'test-session-123',
    api: {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runtime: {},
      config: {},
    },
  };
}

async function getAppendSystemContext(): Promise<string> {
  const { handleBeforePromptBuild, resetPromptStateForTest } = await import('../../src/hooks/prompt.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri606-'));
  try {
    resetPromptStateForTest(tmpDir);
    const result = await handleBeforePromptBuild(
      makeEvent({ trigger: 'heartbeat' }),
      makeCtx() as Parameters<typeof handleBeforePromptBuild>[1],
    );
    return (result?.appendSystemContext as string | undefined) ?? '';
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PRI-606: core principles injection (production path, empty reducer)', () => {
  it('injects all T-01..T-10 axiom ids even when evolution reducer is empty', async () => {
    const append = await getAppendSystemContext();
    for (let i = 1; i <= 10; i++) {
      expect(append, `missing T-${String(i).padStart(2, '0')} in appendSystemContext`).toContain(
        `T-${String(i).padStart(2, '0')}`,
      );
    }
  });

  it('injects canonical registry statements, not just id shells', async () => {
    const append = await getAppendSystemContext();
    // Default language resolves to zh-CN (DEFAULT_OUTPUT_LANGUAGE); the EN branch
    // is covered by core's core-axiom-block.test.ts unit tests.
    // Registry T-01 statementZh — verbatim from core-principle-registry.ts
    expect(append).toContain('在做出变更前，先理解其结构');
    // Registry T-08 statementZh
    expect(append).toContain('将失败和摩擦视为线索');
  });

  it('wraps the axioms in the highest-priority <core_principles> block', async () => {
    const append = await getAppendSystemContext();
    expect(append).toContain('<core_principles>');
  });

  it('falls back to the default language when config reports an invalid value', async () => {
    const { WorkspaceContext } = await import('../../src/core/workspace-context.js');
    (WorkspaceContext.fromHookContext as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      workspaceDir: '/fake/workspace',
      stateDir: '/fake/state',
      resolve: (key: string) => `/fake/${key}`,
      trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn(), listAssistantTurns: vi.fn().mockReturnValue([]), recordPainEvent: vi.fn() },
      config: { get: vi.fn().mockReturnValue('fr') }, // invalid → resolveOutputLanguage degrades with warning
      eventLog: {
        recordPainSignal: vi.fn(),
        recordRuntimeV2ActivationsInjected: vi.fn(),
        recordHeartbeatDiagnosis: vi.fn(),
      },
      evolutionReducer: {
        getActivePrinciples: vi.fn().mockReturnValue([]),
        getProbationPrinciples: vi.fn().mockReturnValue([]),
      },
    });
    const { handleBeforePromptBuild, resetPromptStateForTest } = await import('../../src/hooks/prompt.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri606-'));
    try {
      resetPromptStateForTest(tmpDir);
      const result = await handleBeforePromptBuild(
        makeEvent({ trigger: 'heartbeat' }),
        makeCtx() as Parameters<typeof handleBeforePromptBuild>[1],
      );
      const append = (result?.appendSystemContext as string | undefined) ?? '';
      // Degraded language must NOT break injection — T-01 still lands (rc-9).
      expect(append).toContain('<core_principles>');
      expect(append).toContain('T-01');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('still injects when config service itself throws (guard covers lazy init)', async () => {
    const { WorkspaceContext } = await import('../../src/core/workspace-context.js');
    (WorkspaceContext.fromHookContext as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      workspaceDir: '/fake/workspace',
      stateDir: '/fake/state',
      resolve: (key: string) => `/fake/${key}`,
      trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn(), listAssistantTurns: vi.fn().mockReturnValue([]), recordPainEvent: vi.fn() },
      config: { get: vi.fn().mockImplementation(() => { throw new Error('config store corrupted'); }) },
      eventLog: {
        recordPainSignal: vi.fn(),
        recordRuntimeV2ActivationsInjected: vi.fn(),
        recordHeartbeatDiagnosis: vi.fn(),
      },
      evolutionReducer: {
        getActivePrinciples: vi.fn().mockReturnValue([]),
        getProbationPrinciples: vi.fn().mockReturnValue([]),
      },
    });
    const { handleBeforePromptBuild, resetPromptStateForTest } = await import('../../src/hooks/prompt.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri606-'));
    try {
      resetPromptStateForTest(tmpDir);
      const result = await handleBeforePromptBuild(
        makeEvent({ trigger: 'heartbeat' }),
        makeCtx() as Parameters<typeof handleBeforePromptBuild>[1],
      );
      // The hook must survive; core principles degrade gracefully (empty, warned).
      const append = (result?.appendSystemContext as string | undefined) ?? '';
      expect(append).not.toContain('<core_principles>');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
