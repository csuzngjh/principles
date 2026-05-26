/**
 * pd runtime internalization queue CLI unit tests.
 *
 * Tests the queue command handler: delegation to InternalizationQueueReadModel,
 * JSON/text output formatting, and exit code behavior.
 * The read model is mocked — its contract is tested in principles-core.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetSnapshot, mockClose } = vi.hoisted(() => ({
  mockGetSnapshot: vi.fn(),
  mockClose: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

vi.mock('@principles/core/runtime-v2', () => ({
  createInternalizationQueueReadModel: vi.fn().mockResolvedValue({
    readModel: { getSnapshot: mockGetSnapshot, close: mockClose },
    close: mockClose,
  }),
}));

vi.mock('../../src/services/feature-flag-loader.js', () => ({
  loadEffectiveFeatureFlags: vi.fn().mockReturnValue({
    flags: {
      prompt: { id: 'prompt', enabled: true, category: 'core' },
      code_tool_hook: { id: 'code_tool_hook', enabled: true, category: 'core' },
      defer_archive: { id: 'defer_archive', enabled: true, category: 'core' },
    },
    source: 'defaults',
    configPath: '/fake/workspace/.pd/feature-flags.yaml',
    warnings: [],
  }),
}));

import { handleRuntimeInternalizationQueue } from '../../src/commands/runtime-internalization-queue.js';

const WS = '/fake/workspace';

function emptySnapshot() {
  return {
    pendingCount: 0,
    retryWaitCount: 0,
    countsByTaskKind: {},
    countsByChannel: {},
    invalidMetadataCount: 0,
    sampleInvalidTaskIds: [],
    blockedSummary: { count: 0, samples: [] },
    dependencyFailedSummary: { count: 0, samples: [] },
    retryWaitPendingSummary: { count: 0, samples: [] },
    leaseConflictSummary: { count: 0, samples: [] },
    unresolvableSummary: { count: 0, samples: [] },
    readyTasks: [],
    noReadyTasks: { reason: 'no_candidates', inspectedCount: 0 },
    suppressedTasks: [],
  };
}

describe('handleRuntimeInternalizationQueue', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  // ── Empty queue ─────────────────────────────────────────────────────────────

  it('empty queue returns no_candidates reason in JSON', async () => {
    mockGetSnapshot.mockResolvedValue(emptySnapshot());

    await handleRuntimeInternalizationQueue({ workspace: WS, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.noReadyTasks.reason).toBe('no_candidates');
    expect(output.pendingCount).toBe(0);
    expect(output.readyTasks).toEqual([]);
  });

  it('empty queue text output is human-readable', async () => {
    mockGetSnapshot.mockResolvedValue(emptySnapshot());

    await handleRuntimeInternalizationQueue({ workspace: WS, json: false });

    const text = consoleLogSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(text).toContain('no_ready_tasks');
    expect(text).toContain('no_candidates');
  });

  // ── Invalid metadata ────────────────────────────────────────────────────────

  it('invalid metadata is counted and sampled in JSON', async () => {
    mockGetSnapshot.mockResolvedValue({
      ...emptySnapshot(),
      invalidMetadataCount: 2,
      sampleInvalidTaskIds: ['task_bad_1', 'task_bad_2'],
      noReadyTasks: { reason: 'all_hydration_failed', inspectedCount: 2 },
    });

    await handleRuntimeInternalizationQueue({ workspace: WS, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.invalidMetadataCount).toBe(2);
    expect(output.sampleInvalidTaskIds).toEqual(['task_bad_1', 'task_bad_2']);
    expect(output.noReadyTasks.reason).toBe('all_hydration_failed');
  });

  it('invalid metadata appears in text output', async () => {
    mockGetSnapshot.mockResolvedValue({
      ...emptySnapshot(),
      invalidMetadataCount: 3,
      sampleInvalidTaskIds: ['task_bad_1'],
    });

    await handleRuntimeInternalizationQueue({ workspace: WS, json: false });

    const text = consoleLogSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(text).toContain('invalid_metadata');
    expect(text).toContain('task_bad_1');
  });

  // ── Blocked dependency ─────────────────────────────────────────────────────

  it('blocked task surfaces blockedBy task IDs in JSON', async () => {
    mockGetSnapshot.mockResolvedValue({
      ...emptySnapshot(),
      pendingCount: 1,
      blockedSummary: {
        count: 1,
        samples: [{ taskId: 'task_001', taskKind: 'dreamer', blockedBy: ['task_000'] }],
      },
      noReadyTasks: { reason: 'all_blocked', inspectedCount: 1 },
    });

    await handleRuntimeInternalizationQueue({ workspace: WS, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.blockedSummary.count).toBe(1);
    expect(output.blockedSummary.samples[0].blockedBy).toContain('task_000');
  });

  it('blocked task text output shows blockedBy', async () => {
    mockGetSnapshot.mockResolvedValue({
      ...emptySnapshot(),
      blockedSummary: {
        count: 1,
        samples: [{ taskId: 'task_001', taskKind: 'dreamer', blockedBy: ['task_000'] }],
      },
      noReadyTasks: { reason: 'all_blocked', inspectedCount: 1 },
    });

    await handleRuntimeInternalizationQueue({ workspace: WS, json: false });

    const text = consoleLogSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(text).toContain('blocked');
    expect(text).toContain('task_000');
  });

  // ── Dependency failed ───────────────────────────────────────────────────────

  it('dependency_failed surfaces failedDependencies in JSON', async () => {
    mockGetSnapshot.mockResolvedValue({
      ...emptySnapshot(),
      dependencyFailedSummary: {
        count: 1,
        samples: [{ taskId: 'task_002', taskKind: 'philosopher', failedDependencies: ['task_001'] }],
      },
      noReadyTasks: { reason: 'all_dependency_failed', inspectedCount: 1 },
    });

    await handleRuntimeInternalizationQueue({ workspace: WS, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.dependencyFailedSummary.count).toBe(1);
    expect(output.dependencyFailedSummary.samples[0].failedDependencies).toContain('task_001');
  });

  it('dependency_failed text output shows failed deps', async () => {
    mockGetSnapshot.mockResolvedValue({
      ...emptySnapshot(),
      dependencyFailedSummary: {
        count: 1,
        samples: [{ taskId: 'task_002', taskKind: 'philosopher', failedDependencies: ['task_001'] }],
      },
      noReadyTasks: { reason: 'all_dependency_failed', inspectedCount: 1 },
    });

    await handleRuntimeInternalizationQueue({ workspace: WS, json: false });

    const text = consoleLogSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(text).toContain('dependency_failed');
    expect(text).toContain('task_001');
  });

  // ── Ready tasks ─────────────────────────────────────────────────────────────

  it('ready task appears in readyTasks array', async () => {
    mockGetSnapshot.mockResolvedValue({
      ...emptySnapshot(),
      pendingCount: 1,
      readyTasks: [{ taskId: 'task_003', taskKind: 'scribe', channel: 'prompt' }],
      noReadyTasks: null,
    });

    await handleRuntimeInternalizationQueue({ workspace: WS, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.readyTasks).toContainEqual({ taskId: 'task_003', taskKind: 'scribe', channel: 'prompt' });
  });

  it('ready task text output shows ready count', async () => {
    mockGetSnapshot.mockResolvedValue({
      ...emptySnapshot(),
      readyTasks: [{ taskId: 'task_003', taskKind: 'scribe', channel: 'prompt' }],
      noReadyTasks: null,
    });

    await handleRuntimeInternalizationQueue({ workspace: WS, json: false });

    const text = consoleLogSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(text).toContain('ready:');
  });

  // ── Counts by kind / channel ──────────────────────────────────────────────

  it('countsByTaskKind and countsByChannel are included in JSON', async () => {
    mockGetSnapshot.mockResolvedValue({
      ...emptySnapshot(),
      pendingCount: 2,
      retryWaitCount: 1,
      countsByTaskKind: { dreamer: 2, scribe: 1 },
      countsByChannel: { prompt: 3 },
    });

    await handleRuntimeInternalizationQueue({ workspace: WS, json: true });

    const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(output.countsByTaskKind.dreamer).toBe(2);
    expect(output.countsByTaskKind.scribe).toBe(1);
    expect(output.countsByChannel.prompt).toBe(3);
  });
});
