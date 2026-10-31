/**
 * Tests for prompt.ts injection size guard (fail-closed)
 *
 * M8 (PRI-410) removed legacy diagnostician task injection; the skipped
 * regression blocks for that retired behavior were deleted in PRI-887.
 *
 * Covers:
 * 1. Size guard: injection stays under MAX_INJECTION_SIZE (9000)
 * 2. Fail-closed: never returns injection over limit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─── Mock dependencies ───────────────────────────────────────────────────────

const mockGetPendingDiagnosticianTasks = vi.fn<(stateDir: string) => unknown[]>();

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPendingDiagnosticianTasks.mockReturnValue([]);
  // Enable legacy diagnostician injection — tests verify the compact block format
  process.env.PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED = 'true';
});

afterEach(() => {
  process.env.PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED = '';
});

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
    trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn() },
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

vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn().mockReturnValue({ currentGfi: 20 }),
  resetFriction: vi.fn(),
  trackFriction: vi.fn(),
  decayGfi: vi.fn(),
  getGfiDecayElapsed: vi.fn().mockReturnValue(0),
}));

vi.mock('../../src/core/path-resolver.js', () => ({
  PathResolver: { getExtensionRoot: vi.fn().mockReturnValue('/fake/extension') },
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

function fakeTask(overrides: Partial<{
  id: string; prompt: string; createdAt: string; status: string;
}> = {}): { id: string; task: { prompt: string; createdAt: string; status: 'pending' } } {
  return {
    id: overrides.id ?? 'test-task-1',
    task: {
      prompt: overrides.prompt ?? 'Diagnose pain signal: source=tool_failure score=75 reason=Command failed',
      createdAt: overrides.createdAt ?? '2026-04-21T10:00:00.000Z',
      status: 'pending',
    },
  };
}

function makeMinimalEvent(): Parameters<typeof import('../../src/hooks/prompt.js').handleBeforePromptBuild>[0] {
  return {
    prompt: 'hello world',
    messages: [],
    trigger: 'heartbeat',
    sessionId: 'test-session-123',
  } as unknown as Parameters<typeof import('../../src/hooks/prompt.js').handleBeforePromptBuild>[0];
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Size guard: fail-closed', () => {
  it('never returns a combined injection that exceeds MAX_INJECTION_SIZE (9000)', async () => {
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');

    // One large pending task to trigger diagnostician priority mode
    const largePrompt = 'Pain signal: ' + 'x'.repeat(5000);
    mockGetPendingDiagnosticianTasks.mockReturnValueOnce([fakeTask({ prompt: largePrompt })]);

    const ctx = {
      workspaceDir: '/fake/workspace',
      trigger: 'heartbeat',
      sessionId: 'test-session-123',
      api: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        runtime: {},
        config: {},
      },
    } as unknown as Parameters<typeof handleBeforePromptBuild>[1];

    const result = await handleBeforePromptBuild(makeMinimalEvent(), ctx);

    const totalSize =
      (result?.prependSystemContext?.length ?? 0) +
      (result?.prependContext?.length ?? 0) +
      (result?.appendSystemContext?.length ?? 0);

    expect(totalSize).toBeLessThanOrEqual(9000);
  });

  it('strips project_context and thinking_os when inDiagMode and over limit', async () => {
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');

    // A long reason string in the task so prependContext itself is large
    const longReason = 'x'.repeat(500);
    mockGetPendingDiagnosticianTasks.mockReturnValueOnce([
      fakeTask({ prompt: `Pain signal: reason=${longReason} source=tool_failure score=85` }),
    ]);

    const ctx = {
      workspaceDir: '/fake/workspace',
      trigger: 'heartbeat',
      sessionId: 'test-session-123',
      api: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        runtime: {},
        config: {},
      },
    } as unknown as Parameters<typeof handleBeforePromptBuild>[1];

    const result = await handleBeforePromptBuild(makeMinimalEvent(), ctx);

    // The size guard must never throw — result must be defined
    expect(result).toBeDefined();
    const combined =
      (result?.prependSystemContext?.length ?? 0) +
      (result?.prependContext?.length ?? 0) +
      (result?.appendSystemContext?.length ?? 0);

    // Must stay within MAX_INJECTION_SIZE (9000)
    expect(combined).toBeLessThanOrEqual(9000);
  });
});


// ─── PRI-1065: the ceiling follows the model-aware principle budget ─────────

describe('Size guard: total ceiling derives from the applied principle budget (PRI-1065)', () => {
  function sharedPrompt(
    additionalContext: string,
    budget: number,
  ): Parameters<typeof import('../../src/hooks/prompt.js').handleBeforePromptBuild>[2] {
    return {
      additionalContext,
      principleIds: ['p-1'],
      activationIds: ['a-1'],
      artifactIds: ['art-1'],
      warnings: [],
      budget,
      truncated: false,
    };
  }

  function ctx() {
    return {
      workspaceDir: '/fake/workspace',
      trigger: 'heartbeat',
      sessionId: 'test-session-123',
      api: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        runtime: {},
        config: {},
      },
    } as unknown as Parameters<typeof import('../../src/hooks/prompt.js').handleBeforePromptBuild>[1];
  }

  // Identical payload in both arms — ONLY the applied principle budget (and
  // therefore the total ceiling) differs, so the assertion isolates the
  // reconciliation this ticket introduces rather than ambient block sizes.
  const DIRECTIVES = 'd'.repeat(12_000);

  it('a 1M-window budget keeps background blocks that the legacy 9000 ceiling strips', async () => {
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');

    const wide = await handleBeforePromptBuild(makeMinimalEvent(), ctx(), sharedPrompt(DIRECTIVES, 15_625));
    expect(wide).toBeDefined();
    expect(wide?.appendSystemContext ?? '').not.toContain('[WARNING: Context sections stripped');

    const legacy = await handleBeforePromptBuild(makeMinimalEvent(), ctx(), sharedPrompt(DIRECTIVES, 2_000));
    expect(legacy).toBeDefined();
    expect(legacy?.appendSystemContext ?? '').toContain('[WARNING: Context sections stripped');

    // The ceiling is principle budget + background allowance, not a constant:
    // 15625 + 7000 = 22625 keeps the payload, 2000 + 7000 = 9000 does not.
    const wideTotal =
      (wide?.prependSystemContext?.length ?? 0) +
      (wide?.prependContext?.length ?? 0) +
      (wide?.appendSystemContext?.length ?? 0);
    expect(wideTotal).toBeLessThanOrEqual(22_625);
    expect(wideTotal).toBeGreaterThan(9000);
  });
});
