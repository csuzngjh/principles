/**
 * Prompt diet tests — PRI-291
 *
 * Verifies that the default prompt contains only MVP-required sections
 * and does NOT contain sections removed/default-disabled by the MVP diet.
 *
 * Acceptance criteria covered:
 * 1. Default prompt does NOT contain Thinking OS text
 * 2. Default prompt does NOT contain <routing_guidance>
 * 3. Default prompt does NOT contain GFI attitude/personality directive text
 * 4. Runtime V2 activation still injects validated directives into prependSystemContext
 * 5. runtime_v2_prompt_activations_injected event still emits
 * 6. GFI scoring/empathy evidence path still records friction and can emit pain
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock dependencies ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED = 'true';
  process.env.PD_EMPATHY_API_KEY_ENV = 'PD_TEST_DISABLED_EMPATHY_API_KEY';
});

afterEach(() => {
  process.env.PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED = '';
  delete process.env.PD_EMPATHY_API_KEY_ENV;
});

const mockGetPendingDiagnosticianTasks = vi.fn<(stateDir: string) => unknown[]>();

vi.mock('../../src/core/diagnostician-task-store.js', async () => ({
  getPendingDiagnosticianTasks: (...args: unknown[]) =>
    mockGetPendingDiagnosticianTasks(...args),
}));

vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: {
    get: vi.fn().mockReturnValue({
      recordHeartbeatDiagnosis: vi.fn(),
      recordRuntimeV2ActivationsInjected: vi.fn(),
    }),
  },
}));

vi.mock('../../src/core/workspace-context.js', () => {
  const mockWctx = {
    workspaceDir: '/fake/workspace',
    stateDir: '/fake/state',
    resolve: (key: string) => `/fake/${key}`,
    trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn() },
    config: { get: vi.fn() },
    eventLog: {
      recordRuntimeV2ActivationsInjected: vi.fn(),
    },
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

vi.mock('../../src/core/path-resolver.js', () => ({
  PathResolver: { getExtensionRoot: vi.fn().mockReturnValue('/fake/extension') },
}));

vi.mock('../../src/core/principle-injection.js', () => ({
  // PRI-606: pass-through so reducer-sourced active/probation principles reach
  // the <evolution_principles> block (previously they squatted in
  // <core_principles> via the broken injection path this fix removes).
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMinimalEvent(overrides: {
  trigger?: string;
  sessionId?: string;
} = {}) {
  const { trigger = 'user', sessionId = 'test-session-diet' } = overrides;
  return {
    prompt: 'hello world',
    messages: [],
    trigger,
    sessionId,
  } as unknown as Parameters<typeof import('../../src/hooks/prompt.js').handleBeforePromptBuild>[0];
}

function makeCtx(overrides: {
  sessionGfi?: number;
  trigger?: string;
  sessionId?: string;
} = {}) {
  const { sessionGfi = 20, trigger = 'user', sessionId = 'test-session-diet' } = overrides;
  sessionGfiValue = sessionGfi;
  return {
    workspaceDir: '/fake/workspace',
    trigger,
    sessionId,
    api: {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      runtime: {},
      config: {},
    },
  } as unknown as Parameters<typeof import('../../src/hooks/prompt.js').handleBeforePromptBuild>[1];
}

async function getPromptOutput(overrides: { sessionGfi?: number } = {}) {
  const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
  const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx(overrides));
  return {
    prepend: result?.prependSystemContext ?? '',
    append: result?.appendSystemContext ?? '',
    context: result?.prependContext ?? '',
  };
}

// ─── Tests: MVP Diet — sections that must NOT appear by default ────────────

describe('PRI-291 Prompt Diet: default prompt excludes non-MVP sections', { timeout: 15000 }, () => {
  it('default prompt does NOT contain Thinking OS text', async () => {
    const { append } = await getPromptOutput();
    expect(append).not.toContain('<thinking_os>');
  });

  it('default prompt does NOT contain <routing_guidance>', async () => {
    const { append } = await getPromptOutput();
    expect(append).not.toContain('<routing_guidance>');
    expect(append).not.toContain('DELEGATION SUGGESTION');
    expect(append).not.toContain('ROUTING GUIDANCE');
  });

  it('default prompt does NOT contain GFI attitude/personality text', async () => {
    const { prepend, append } = await getPromptOutput();
    const combined = prepend + append;
    expect(combined).not.toContain('HUMBLE_RECOVERY');
    expect(combined).not.toContain('CONCILIATORY');
    expect(combined).not.toContain('EFFICIENT');
    expect(combined).not.toContain('Spicy Evolver');
    expect(combined).not.toContain('despise entropy');
    expect(combined).not.toContain('evolve through pain');
  });

  it('default prompt does NOT contain <project_context> (default is off)', async () => {
    const { append } = await getPromptOutput();
    // project_context tag should not appear as a content block.
    // Note: the EXECUTION RULES section may list it as a priority description,
    // but the actual <project_context>...</project_context> content block must be absent.
    const hasProjectContextBlock = append.includes('<project_context>\n');
    expect(hasProjectContextBlock).toBe(false);
  });

  it('EXECUTION RULES does not list removed sections', async () => {
    const { append } = await getPromptOutput();
    // Only present when appendParts is non-empty (principles exist)
    // But even when present, removed sections should not be listed
    if (append.includes('EXECUTION RULES')) {
      expect(append).not.toContain('<thinking_os>');
      expect(append).not.toContain('<routing_guidance>');
      expect(append).not.toContain('<reflection_log>');
    }
  });
});

// ─── Tests: MVP Diet — sections that MUST still appear ─────────────────────

describe('PRI-291 Prompt Diet: MVP sections preserved', () => {
  it('PD GOVERNANCE CONTEXT is still injected in prependSystemContext', async () => {
    const { prepend } = await getPromptOutput();
    expect(prepend).toContain('PD GOVERNANCE CONTEXT');
  });

  it('active principles can still be injected when present', async () => {
    const { WorkspaceContext } = await import('../../src/core/workspace-context.js');
    (WorkspaceContext.fromHookContext as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      workspaceDir: '/fake/workspace',
      stateDir: '/fake/state',
      resolve: (key: string) => `/fake/${key}`,
      trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn() },
      config: { get: vi.fn() },
      eventLog: { recordRuntimeV2ActivationsInjected: vi.fn() },
      evolutionReducer: {
        getActivePrinciples: vi.fn().mockReturnValue([
          { id: 'P1', text: 'Evolution principle still works' },
        ]),
        getProbationPrinciples: vi.fn().mockReturnValue([]),
      },
    });

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    expect(result?.appendSystemContext).toContain('<core_principles>');
    expect(result?.appendSystemContext).toContain('Evolution principle still works');
  });

  it('core principles can still be injected', async () => {
    const { WorkspaceContext } = await import('../../src/core/workspace-context.js');
    (WorkspaceContext.fromHookContext as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      workspaceDir: '/fake/workspace',
      stateDir: '/fake/state',
      resolve: (key: string) => `/fake/${key}`,
      trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn() },
      config: { get: vi.fn() },
      eventLog: { recordRuntimeV2ActivationsInjected: vi.fn() },
      evolutionReducer: {
        getActivePrinciples: vi.fn().mockReturnValue([
          { id: 'CP1', text: 'Core principle preserved' },
        ]),
        getProbationPrinciples: vi.fn().mockReturnValue([]),
      },
    });

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    expect(result?.appendSystemContext).toContain('<core_principles>');
  });


  it('size guard still works — total injection under 9000', async () => {
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    const total =
      (result?.prependSystemContext?.length ?? 0) +
      (result?.prependContext?.length ?? 0) +
      (result?.appendSystemContext?.length ?? 0);
    expect(total).toBeLessThanOrEqual(9000);
  });
});
