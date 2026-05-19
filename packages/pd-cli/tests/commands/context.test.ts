import { describe, it, expect, vi, beforeEach } from 'vitest';

const { MockSqliteConnection, MockSqliteTaskStore, MockSqliteRunStore } = vi.hoisted(() => {
  class MockSqliteConnection {
    close = vi.fn();
  }
  class MockSqliteTaskStore {}
  class MockSqliteRunStore {}
  return { MockSqliteConnection, MockSqliteTaskStore, MockSqliteRunStore };
}, { validateType: true });

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/fake-workspace'),
}));

const contextAssemblerInstance = {
  assemble: vi.fn().mockResolvedValue({
    contextId: 'ctx-001',
    contextHash: 'abc123def4567890',
    workspaceDir: '/tmp/fake-workspace',
    sourceRefs: ['pain-001'],
    conversationWindow: [],
    ambiguityNotes: [],
    diagnosisTarget: { taskId: 'diag-001' },
    fullTrace: [
      { taskId: 'source-task-001', sourcePainId: 'pain-001', runs: [] },
    ],
  }),
};

vi.mock('@principles/core', () => {
  return {
    SqliteConnection: vi.fn().mockImplementation(function () {
      return new MockSqliteConnection();
    }),
    SqliteTaskStore: vi.fn().mockImplementation(function () {
      return new MockSqliteTaskStore();
    }),
    SqliteRunStore: vi.fn().mockImplementation(function () {
      return new MockSqliteRunStore();
    }),
    SqliteHistoryQuery: vi.fn().mockImplementation(function () { return {}; }),
    SqliteContextAssembler: vi.fn().mockImplementation(function () {
      return contextAssemblerInstance;
    }),
    SqliteTrajectoryLocator: vi.fn().mockImplementation(function () { return {}; }),
    SqliteSourceTraceLocator: vi.fn().mockImplementation(function () { return {}; }),
  };
});

import { handleContextBuild } from '../../src/commands/context.js';

describe('pd context build', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contextAssemblerInstance.assemble.mockResolvedValue({
      contextId: 'ctx-001',
      contextHash: 'abc123def4567890',
      workspaceDir: '/tmp/fake-workspace',
      sourceRefs: ['pain-001'],
      conversationWindow: [],
      ambiguityNotes: [],
      diagnosisTarget: { taskId: 'diag-001' },
      fullTrace: [
        { taskId: 'source-task-001', sourcePainId: 'pain-001', runs: [] },
      ],
    });
  });

  it('PRI-189: wires SourceTraceLocator into SqliteContextAssembler', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleContextBuild('diag-001', { json: true, workspace: '/tmp/fake-workspace' });

    const { SqliteTrajectoryLocator, SqliteSourceTraceLocator, SqliteContextAssembler } =
      await import('@principles/core');

    expect(SqliteTrajectoryLocator).toHaveBeenCalledTimes(1);
    expect(SqliteSourceTraceLocator).toHaveBeenCalledTimes(1);
    expect(SqliteContextAssembler).toHaveBeenCalledTimes(1);

    const assemblerCall = vi.mocked(SqliteContextAssembler).mock.calls[0];
    const optionsArg = assemblerCall[3];
    expect(optionsArg).toBeDefined();
    expect(optionsArg).toHaveProperty('sourceTraceLocator');

    consoleSpy.mockRestore();
  });

  it('PRI-189: context build --json outputs source-aligned fullTrace', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleContextBuild('diag-001', { json: true, workspace: '/tmp/fake-workspace' });

    const logOutput = consoleSpy.mock.calls[0][0];
    const parsed = JSON.parse(logOutput);
    expect(parsed.fullTrace).toBeDefined();
    expect(parsed.fullTrace.length).toBeGreaterThan(0);
    expect(parsed.fullTrace[0].sourcePainId).toBe('pain-001');

    consoleSpy.mockRestore();
  });

  it('PRI-189: context build human-readable output includes sourceRefs', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleContextBuild('diag-001', { json: false, workspace: '/tmp/fake-workspace' });

    const allOutput = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(allOutput).toContain('pain-001');

    consoleSpy.mockRestore();
  });
});
