/**
 * Characterization tests for handleBeforePromptBuild() pure-logic sections.
 *
 * PURPOSE:
 * These tests lock down current behavior of pure-logic sections before any SDK migration.
 * They verify the logic that WILL be extracted to @principles/core in Phase 1.
 * The tests themselves are NOT migrated — they stay in the plugin to protect the
 * existing handleBeforePromptBuild() while its internals are refactored.
 *
 * SCOPE (Phase 0 only):
 * - GFI >= 70 → HUMBLE_RECOVERY attitude
 * - GFI >= 40 → CONCILIATORY attitude
 * - GFI < 40 → EFFICIENT attitude
 * - Correction cue detection
 * - Minimal trigger skips project context
 * - Size guard never exceeds 9000 chars
 *
 * NOT IN SCOPE (Phase 1+):
 * - Empathy keyword matching (hybrid, needs I/O separation)
 * - Principle selection (hybrid, needs I/O separation)
 * - Routing guidance (hybrid, needs I/O separation)
 * - Any code migration to @principles/core
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resetPromptStateForTest } from '../../src/hooks/prompt.js';

const {
  mockDetectSync,
  mockListAssistantTurns,
  mockListUserTurnsForSession,
} = vi.hoisted(() => ({
  mockDetectSync: vi.fn(),
  mockListAssistantTurns: vi.fn().mockReturnValue([]),
  mockListUserTurnsForSession: vi.fn().mockReturnValue([]),
}));

// ─── Mock dependencies ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED = 'true';
  // Reset session GFI to default between tests
  sessionGfiValue = 20;
  resetPromptStateForTest();
});

afterEach(() => {
  process.env.PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED = '';
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
    }),
  },
}));

vi.mock('../../src/core/workspace-context.js', () => {
  const mockWctx = {
    workspaceDir: '/fake/workspace',
    stateDir: '/fake/state',
    resolve: (key: string) => `/fake/${key}`,
    trajectory: {
      recordSession: vi.fn(),
      recordUserTurn: vi.fn(),
      listAssistantTurns: mockListAssistantTurns,
      listUserTurnsForSession: mockListUserTurnsForSession,
    },
    config: { get: vi.fn() },
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

vi.mock('../../src/core/signal-collector-host.js', () => ({
  SignalCollectorHost: class {
    detectSync = mockDetectSync;
  },
  createSignalLlmClassifierFromConfig: vi.fn().mockReturnValue(null),
  isUserInteractionTrigger: (trigger: string | undefined) =>
    trigger === 'user' || trigger === 'api' || trigger === undefined,
}));

// ─── Mutable session mock ────────────────────────────────────────────────────
// getSession must be configurable per-test, so we use module-level refs.
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

function setSessionGfi(gfi: number) {
  sessionGfiValue = gfi;
}

vi.mock('../../src/core/path-resolver.js', () => ({
  PathResolver: { getExtensionRoot: vi.fn().mockReturnValue('/fake/extension') },
}));

vi.mock('../../src/core/principle-injection.js', () => ({
  selectPrinciplesForInjection: vi.fn().mockReturnValue({
    selected: [],
    wasTruncated: false,
    breakdown: { p0: 0, p1: 0, p2: 0 },
    totalChars: 0,
  }),
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
  prompt?: string;
  messages?: unknown[];
} = {}) {
  const {
    prompt = 'hello world',
    messages = [],
  } = overrides;
  return { prompt, messages };
}

function makeCtx(overrides: {
  workspaceDir?: string;
  trigger?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
} = {}) {
  const {
    workspaceDir = '/fake/workspace',
    trigger = 'heartbeat',
    sessionId = 'test-session-123',
    sessionKey = sessionId,
    runId = 'test-run-123',
  } = overrides;
  return {
    workspaceDir,
    runId,
    sessionKey,
    trigger,
    sessionId,
    api: {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      runtime: {},
      config: {},
    },
  } as unknown as Parameters<typeof import('../../src/hooks/prompt.js').handleBeforePromptBuild>[1];
}

describe('OpenClaw before_prompt_build current-turn contract', () => {
  it('collects the first user turn from event.prompt when history is empty', async () => {
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');

    await handleBeforePromptBuild(
      makeMinimalEvent({ prompt: '这是错误的：请保留当前排序', messages: [] }),
      makeCtx({ trigger: 'user', sessionId: 'first-turn', runId: 'run-first' }),
    );

    expect(mockDetectSync).toHaveBeenCalledWith(
      '这是错误的：请保留当前排序',
      'first-turn',
      'user',
      { referencesAssistantTurnId: null, turnIndex: 1 },
    );
  });

  it('does not replay an older history message as the current correction', async () => {
    mockListAssistantTurns.mockReturnValueOnce([{ id: 42 }]);
    mockListUserTurnsForSession.mockReturnValueOnce([{ turnIndex: 1 }]);
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');

    await handleBeforePromptBuild(
      makeMinimalEvent({
        prompt: '这是错误的：新的纠正',
        messages: [
          { role: 'user', content: '这是错误的：旧的纠正' },
          { role: 'assistant', content: '旧回复' },
        ],
      }),
      makeCtx({ trigger: 'user', sessionId: 'history-turn', runId: 'run-history' }),
    );

    expect(mockDetectSync).toHaveBeenCalledWith(
      '这是错误的：新的纠正',
      'history-turn',
      'user',
      { referencesAssistantTurnId: 42, turnIndex: 2 },
    );
  });

  it('deduplicates retries with the same runId but accepts a distinct runId', async () => {
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const event = makeMinimalEvent({ prompt: '不对，请重新处理', messages: [] });
    const firstRun = makeCtx({ trigger: 'user', sessionId: 'retry-turn', runId: 'run-retry-1' });

    await handleBeforePromptBuild(event, firstRun);
    await handleBeforePromptBuild(event, firstRun);
    await handleBeforePromptBuild(
      event,
      makeCtx({ trigger: 'user', sessionId: 'retry-turn', runId: 'run-retry-2' }),
    );

    expect(mockDetectSync).toHaveBeenCalledTimes(2);
  });

  it('does not consume a runId when signal collection fails, so the retry can succeed', async () => {
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const event = makeMinimalEvent({ prompt: '不对，请重试', messages: [] });
    const retry = makeCtx({ trigger: 'user', sessionId: 'failed-retry', runId: 'run-failed-once' });
    mockDetectSync.mockImplementationOnce(() => {
      throw new Error('transient trajectory failure');
    });

    await expect(handleBeforePromptBuild(event, retry)).rejects.toThrow('transient trajectory failure');
    await handleBeforePromptBuild(event, retry);
    await handleBeforePromptBuild(event, retry);

    expect(mockDetectSync).toHaveBeenCalledTimes(2);
  });

  it('accepts a reused protocol runId in a different logical session', async () => {
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const event = makeMinimalEvent({ prompt: '这次结果不符合要求', messages: [] });

    await handleBeforePromptBuild(
      event,
      makeCtx({ trigger: 'user', sessionId: 'session-a', sessionKey: 'agent:main:a', runId: 'reused-run' }),
    );
    await handleBeforePromptBuild(
      event,
      makeCtx({ trigger: 'user', sessionId: 'session-b', sessionKey: 'agent:main:b', runId: 'reused-run' }),
    );

    expect(mockDetectSync).toHaveBeenCalledTimes(2);
  });
});

// ─── Tests: Attitude Directive removed (PRI-291 MVP diet) ───────────────
// Attitude/personality prompt text was removed per PRI-291.
// GFI scoring (trackFriction) and empathy pain emission remain active.
// These tests verify that attitude text no longer appears in prompts.

describe('Attitude/personality directive — removed from prompt (PRI-291)', () => {
  // Ensure appendParts is non-empty so we can verify absence
  beforeEach(async () => {
    const { WorkspaceContext } = await import('../../src/core/workspace-context.js');
    (WorkspaceContext.fromHookContext as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      workspaceDir: '/fake/workspace',
      stateDir: '/fake/state',
      resolve: (key: string) => `/fake/${key}`,
      trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn() },
      config: { get: vi.fn() },
      evolutionReducer: {
        getActivePrinciples: vi.fn().mockReturnValue([
          { id: 'P0', text: 'Test principle for attitude tests' },
        ]),
        getProbationPrinciples: vi.fn().mockReturnValue([]),
      },
    });
  });

  it('GFI >= 70 does NOT inject HUMBLE_RECOVERY mode', async () => {
    setSessionGfi(75);
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    const combined = (result?.prependSystemContext ?? '') + (result?.appendSystemContext ?? '');
    expect(combined).not.toContain('HUMBLE_RECOVERY');
  });

  it('GFI >= 40 does NOT inject CONCILIATORY mode', async () => {
    setSessionGfi(50);
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    const combined = (result?.prependSystemContext ?? '') + (result?.appendSystemContext ?? '');
    expect(combined).not.toContain('CONCILIATORY');
  });

  it('GFI < 40 does NOT inject EFFICIENT mode', async () => {
    setSessionGfi(10);
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    const combined = (result?.prependSystemContext ?? '') + (result?.appendSystemContext ?? '');
    expect(combined).not.toContain('EFFICIENT');
  });

  it('no "Spicy Evolver" persona text appears in prompt', async () => {
    setSessionGfi(20);
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    const combined = (result?.prependSystemContext ?? '') + (result?.appendSystemContext ?? '');
    expect(combined).not.toContain('Spicy Evolver');
    expect(combined).not.toContain('despise entropy');
    expect(combined).not.toContain('evolve through pain');
  });
});

// ─── Tests: Correction Cue Detection ────────────────────────────────────────
describe('Minimal trigger skips project context', () => {
  async function getProjectContextContent(trigger: string, sessionId: string) {
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx({ trigger, sessionId }));
    return result?.appendSystemContext ?? '';
  }

  it('heartbeat trigger does not inject project_context', async () => {
    mockGetPendingDiagnosticianTasks.mockReturnValue([]);
    const content = await getProjectContextContent('heartbeat', 'hb-session');
    expect(content).not.toContain('<project_context>');
  });

  it('cron trigger does not inject project_context', async () => {
    mockGetPendingDiagnosticianTasks.mockReturnValue([]);
    const content = await getProjectContextContent('cron', 'cron-session');
    expect(content).not.toContain('<project_context>');
  });

  it('subagent session does not inject project_context', async () => {
    mockGetPendingDiagnosticianTasks.mockReturnValue([]);
    const content = await getProjectContextContent('user', 'session:subagent:123');
    expect(content).not.toContain('<project_context>');
  });

  it('regular user trigger DOES inject project_context when focus is configured', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-prompt-characterization-'));
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    const yaml = await import('js-yaml');
    fs.writeFileSync(
      path.join(workspaceDir, '.pd', 'config.yaml'),
      yaml.dump({
        version: 1,
        features: {},
        runtimeProfiles: { default: { type: 'openclaw' } },
        internalAgents: { defaultRuntime: 'default', agents: {} },
        contextInjection: { projectFocus: 'full' },
      }),
      'utf-8',
    );
    const { WorkspaceContext } = await import('../../src/core/workspace-context.js');
    (WorkspaceContext.fromHookContext as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      workspaceDir,
      stateDir: '/fake/state',
      resolve: (key: string) => {
        if (key === 'CURRENT_FOCUS') return path.join(workspaceDir, 'CURRENT_FOCUS.md');
        return path.join(workspaceDir, key);
      },
      trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn() },
      config: { get: vi.fn() },
      eventLog: { recordRuntimeV2ActivationsInjected: vi.fn() },
      evolutionReducer: {
        getActivePrinciples: vi.fn().mockReturnValue([]),
        getProbationPrinciples: vi.fn().mockReturnValue([]),
      },
    });

    // Mock currentFocus to return non-empty content
    const { safeReadCurrentFocus } = await import('../../src/core/focus-history.js');
    (safeReadCurrentFocus as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      content: 'CURRENT_FOCUS: Test project\nWorking on feature X',
      recovered: true,
      validationErrors: [],
    });
    (safeReadCurrentFocus as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      content: 'CURRENT_FOCUS: Test project\nWorking on feature X',
      recovered: true,
      validationErrors: [],
    });

    mockGetPendingDiagnosticianTasks.mockReturnValue([]);
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(
      makeMinimalEvent(),
      makeCtx({ workspaceDir, trigger: 'user', sessionId: 'regular-user-session' }),
    );
    const content = result?.appendSystemContext ?? '';

    // For non-minimal triggers (user), project_context IS injected
    // The <project_context> tag should appear in the output
    expect(content).toContain('<project_context>');
  });
});

// ─── Tests: Size Guard ─────────────────────────────────────────────────────

describe('Size guard: never exceeds 9000 chars', () => {
  it('returns result within MAX_INJECTION_SIZE with empty mocks', async () => {
    mockGetPendingDiagnosticianTasks.mockReturnValue([]);

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx());

    expect(result).toBeDefined();
    const totalSize =
      (result?.prependSystemContext?.length ?? 0) +
      (result?.prependContext?.length ?? 0) +
      (result?.appendSystemContext?.length ?? 0);
    expect(totalSize).toBeLessThanOrEqual(9000);
  });

  it('size guard strips content to stay under 9000 with large prependContext', async () => {
    mockGetPendingDiagnosticianTasks.mockReturnValue([]);

    const { WorkspaceContext } = await import('../../src/core/workspace-context.js');
    (WorkspaceContext.fromHookContext as ReturnType<typeof vi.fn>).mockReturnValue({
      workspaceDir: '/fake/workspace',
      stateDir: '/fake/state',
      resolve: (key: string) => `/fake/${key}`,
      trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn() },
      config: {
        get: vi.fn().mockReturnValue({
          thinkingOs: 'on',
          reflectionLog: 'off',
          projectFocus: 'on',
        }),
      },
      evolutionReducer: {
        getActivePrinciples: vi.fn().mockReturnValue([]),
        getProbationPrinciples: vi.fn().mockReturnValue([]),
      },
    });

    // Override focus-history to return large content
    const { safeReadCurrentFocus, autoCompressFocus } = await import('../../src/core/focus-history.js');
    (safeReadCurrentFocus as ReturnType<typeof vi.fn>).mockReturnValue({
      content: 'A'.repeat(5000),  // large content to trigger size guard
      recovered: true,
      validationErrors: [],
    });
    (autoCompressFocus as ReturnType<typeof vi.fn>).mockReturnValue({
      compressed: true,
      content: 'A'.repeat(4000),
      reason: 'size_limit',
    });

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const result = await handleBeforePromptBuild(makeMinimalEvent(), makeCtx({ trigger: 'user' }));

    expect(result).toBeDefined();
    const totalSize =
      (result?.prependSystemContext?.length ?? 0) +
      (result?.prependContext?.length ?? 0) +
      (result?.appendSystemContext?.length ?? 0);
    expect(totalSize).toBeLessThanOrEqual(9000);
  });

  it('size guard does not throw — returns defined result even with huge content', async () => {
    mockGetPendingDiagnosticianTasks.mockReturnValue([]);

    const { safeReadCurrentFocus, autoCompressFocus, getHistoryVersions } = await import('../../src/core/focus-history.js');
    (safeReadCurrentFocus as ReturnType<typeof vi.fn>).mockReturnValue({
      content: 'X'.repeat(10000),
      recovered: true,
      validationErrors: [],
    });
    (autoCompressFocus as ReturnType<typeof vi.fn>).mockReturnValue({
      compressed: false,
      content: 'X'.repeat(8000),
      reason: 'not_needed',
    });
    (getHistoryVersions as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');

    // Must NOT throw — size guard is fail-closed
    await expect(handleBeforePromptBuild(makeMinimalEvent(), makeCtx({ trigger: 'user' })))
      .resolves.toBeDefined();
  });

  it('continues the prompt build when trajectory observability throws (PRI-647)', async () => {
    const { WorkspaceContext } = await import('../../src/core/workspace-context.js');
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');
    const mockWctx = (WorkspaceContext.fromHookContext as ReturnType<typeof vi.fn>)();
    const recordSession = mockWctx.trajectory.recordSession as ReturnType<typeof vi.fn>;
    recordSession.mockImplementationOnce(() => {
      throw new Error('The database connection is not open');
    });

    const result = await handleBeforePromptBuild(
      makeMinimalEvent({ prompt: '继续，不要中断', messages: [] }),
      makeCtx({ trigger: 'user', sessionId: 'obs-fail-open', runId: 'run-obs-fail-open' }),
    );

    expect(result).toBeDefined();
    expect(mockDetectSync).toHaveBeenCalled();
  });
});
