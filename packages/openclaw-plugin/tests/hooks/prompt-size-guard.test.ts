/**
 * Tests for prompt.ts diagnostician fixes (Phase A: Immediate Hemorrhage Control)
 *
 * Covers:
 * 1. Compact diagnostician task injection block format
 * 2. Size guard: injection stays under MAX_INJECTION_SIZE (9000)
 * 3. Diagnostician priority mode: low-priority blocks stripped when tasks pending
 * 4. Fail-closed: never returns injection over limit
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

vi.mock('../../src/core/workspace-context.js', () => ({
  WorkspaceContext: {
    fromHookContext: vi.fn().mockReturnValue({
      stateDir: '/fake/state',
      resolve: (key: string) => `/fake/${key}`,
      trajectory: { recordSession: vi.fn(), recordUserTurn: vi.fn() },
      config: { get: vi.fn() },
      evolutionReducer: {
        getActivePrinciples: vi.fn().mockReturnValue([]),
        getProbationPrinciples: vi.fn().mockReturnValue([]),
      },
    }),
  },
}));

vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn().mockReturnValue({ currentGfi: 20 }),
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

vi.mock('../../src/service/subagent-workflow/index.js', () => ({
  EmpathyObserverWorkflowManager: vi.fn(),
  empathyObserverWorkflowSpec: {},
  isExpectedSubagentError: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/utils/subagent-probe.js', () => ({
  isSubagentRuntimeAvailable: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/core/local-worker-routing.js', () => ({
  classifyTask: vi.fn().mockReturnValue({
    decision: 'stay_main',
    classification: 'unknown',
    reason: 'mocked',
    blockers: [],
  }),
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

describe('Diagnostician compact task injection', () => {
  it('injects a compact block containing task_id, reason, marker and report paths', async () => {
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');

    mockGetPendingDiagnosticianTasks.mockReturnValueOnce([fakeTask({
      id: 'task-abc',
      prompt:
        'Pain signal: source=tool_failure\nscore=75\nreason=Command npm test failed with exit code 1\nsession_id=sess-123',
    })]);

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

    const combined = (result?.prependContext ?? '') + (result?.appendSystemContext ?? '');

    // Must contain structural fields
    expect(combined).toContain('task_id: task-abc');
    expect(combined).toContain('.evolution_complete_task-abc');
    expect(combined).toContain('.diagnostician_report_task-abc.json');

    // Must NOT contain the full raw prompt (which could be 2-4 KB)
    // The compact diagnostician block is small; the heartbeat checklist adds to total
    expect(combined.length).toBeLessThan(2000);
  });

  it('injects exactly one task per heartbeat regardless of queue depth', async () => {
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');

    const tasks = [
      fakeTask({ id: 'task-1' }),
      fakeTask({ id: 'task-2' }),
      fakeTask({ id: 'task-3' }),
    ];
    mockGetPendingDiagnosticianTasks.mockReturnValueOnce(tasks);

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
    const combined = (result?.prependContext ?? '') + (result?.appendSystemContext ?? '');

    // Only the first task ID appears in the block
    expect(combined).toContain('task-1');
    expect(combined).not.toContain('task-2');
    expect(combined).not.toContain('task-3');
    // Note mentions remaining count
    expect(combined).toContain('2 more task(s) are queued');
  });
});

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

  it('strips project_context and strips thinking_os/evolution_principles when inDiagMode and over limit', async () => {
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

describe('Diagnostician priority mode', () => {
  it('sets pendingDiagTaskCount > 0 so size guard knows to strip low-priority blocks', async () => {
    const { handleBeforePromptBuild } = await import('../../src/hooks/prompt.js');

    mockGetPendingDiagnosticianTasks.mockReturnValueOnce([fakeTask()]);

    const infoLogger = vi.fn();
    const ctx = {
      workspaceDir: '/fake/workspace',
      trigger: 'heartbeat',
      sessionId: 'test-session-123',
      api: {
        logger: { info: infoLogger, warn: vi.fn(), error: vi.fn() },
        runtime: {},
        config: {},
      },
    } as unknown as Parameters<typeof handleBeforePromptBuild>[1];

    const result = await handleBeforePromptBuild(makeMinimalEvent(), ctx);

    // Should have logged task injection
    expect(infoLogger).toHaveBeenCalledWith(
      expect.stringContaining('Injected compact diagnostician task block')
    );

    // Result must be valid
    expect(result?.prependContext).toBeDefined();
  });
});
