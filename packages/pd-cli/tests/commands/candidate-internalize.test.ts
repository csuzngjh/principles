import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCandidateInternalize } from '../../src/commands/candidate.js';

const { mockStateManager, MockRuntimeStateManager } = vi.hoisted(() => {
  const mockStateManager = {
    initialize: vi.fn().mockResolvedValue(undefined),
    getCandidate: vi.fn(),
    getTask: vi.fn().mockResolvedValue(null),
    createTask: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    connection: {
      getDb: vi.fn(),
    },
  };

  function MockRuntimeStateManager(this: any) {
    return mockStateManager;
  }
  MockRuntimeStateManager.prototype = {};

  return { mockStateManager, MockRuntimeStateManager };
});

vi.mock('@principles/core/runtime-v2', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    RuntimeStateManager: MockRuntimeStateManager,
    decideInternalizationRoute: vi.fn(),
  };
});

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/test-workspace'),
}));

import { decideInternalizationRoute } from '@principles/core/runtime-v2';

const mockCandidate = (overrides: Partial<{
  candidateId: string;
  sourceRecommendationJson: string;
  description: string;
}> = {}) => ({
  candidateId: overrides.candidateId ?? 'cand-001',
  artifactId: 'art-001',
  taskId: 'task-001',
  sourceRunId: 'run-001',
  title: 'Test Candidate',
  description: overrides.description ?? 'Test description',
  confidence: 0.85,
  status: 'active',
  createdAt: new Date().toISOString(),
  sourceRecommendationJson: overrides.sourceRecommendationJson ?? JSON.stringify({
    kind: 'principle',
    description: 'Test principle',
    abstractedPrinciple: 'Always handle errors',
  }),
});

describe('handleCandidateInternalize (PRI-89)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStateManager.getCandidate.mockResolvedValue(null);
    mockStateManager.getTask.mockResolvedValue(null);
    mockStateManager.createTask.mockResolvedValue({
      taskId: 'dreamer-cand-001-prompt',
      taskKind: 'dreamer',
      status: 'pending',
    });
  });

  it('valid actionable candidate creates root dreamer PI task', async () => {
    mockStateManager.getCandidate.mockResolvedValue(mockCandidate());
    (decideInternalizationRoute as ReturnType<typeof vi.fn>).mockReturnValue({
      ready: true,
      route: 'principle-ledger',
      missingFields: [],
      reason: 'Principle recommendation ready for ledger write path.',
      nextAction: 'Proceed with principle-ledger intake.',
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleCandidateInternalize({
      candidateId: 'cand-001',
      workspace: '/tmp/test',
      json: true,
    });

    expect(mockStateManager.createTask).toHaveBeenCalledOnce();
    const createArg = (mockStateManager.createTask as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect((createArg[0] as Record<string, unknown>).taskKind).toBe('dreamer');
    expect((createArg[0] as Record<string, unknown>).status).toBe('pending');

    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.status).toBe('created');
    expect(output.candidateId).toBe('cand-001');
    expect(output.route).toBe('principle-ledger');
    expect(output.channel).toBe('prompt');
    expect(output.taskId).toBeDefined();

    consoleSpy.mockRestore();
  });

  it('repeated seed returns existing task, no duplicate', async () => {
    mockStateManager.getCandidate.mockResolvedValue(mockCandidate());
    (decideInternalizationRoute as ReturnType<typeof vi.fn>).mockReturnValue({
      ready: true,
      route: 'principle-ledger',
      missingFields: [],
      reason: 'Ready',
      nextAction: 'Proceed',
    });
    mockStateManager.getTask.mockResolvedValue({
      taskId: 'dreamer-cand-001-prompt',
      taskKind: 'dreamer',
      status: 'pending',
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleCandidateInternalize({
      candidateId: 'cand-001',
      workspace: '/tmp/test',
      json: true,
    });

    expect(mockStateManager.createTask).not.toHaveBeenCalled();
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.status).toBe('existing');

    consoleSpy.mockRestore();
  });

  it('--dry-run does not write database', async () => {
    mockStateManager.getCandidate.mockResolvedValue(mockCandidate());
    (decideInternalizationRoute as ReturnType<typeof vi.fn>).mockReturnValue({
      ready: true,
      route: 'principle-ledger',
      missingFields: [],
      reason: 'Ready',
      nextAction: 'Proceed',
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleCandidateInternalize({
      candidateId: 'cand-001',
      workspace: '/tmp/test',
      json: true,
      dryRun: true,
    });

    expect(mockStateManager.createTask).not.toHaveBeenCalled();
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.status).toBe('dry_run');

    consoleSpy.mockRestore();
  });

  it('defer/non-actionable route returns no_task_created', async () => {
    mockStateManager.getCandidate.mockResolvedValue(mockCandidate({
      sourceRecommendationJson: JSON.stringify({ kind: 'defer', description: 'Skip' }),
    }));
    (decideInternalizationRoute as ReturnType<typeof vi.fn>).mockReturnValue({
      ready: false,
      route: 'deferred',
      missingFields: [],
      reason: 'Recommendation explicitly deferred',
      nextAction: 'No action needed',
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleCandidateInternalize({
      candidateId: 'cand-001',
      workspace: '/tmp/test',
      json: true,
    });

    expect(mockStateManager.createTask).not.toHaveBeenCalled();
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.status).toBe('no_task_created');

    consoleSpy.mockRestore();
  });

  it('candidate not found returns structured error', async () => {
    mockStateManager.getCandidate.mockResolvedValue(null);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      handleCandidateInternalize({
        candidateId: 'nonexistent',
        workspace: '/tmp/test',
        json: true,
      })
    ).rejects.toThrow();

    expect(mockStateManager.createTask).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('recommendation kind maps to correct channel', async () => {
    mockStateManager.getCandidate.mockResolvedValue(mockCandidate({
      sourceRecommendationJson: JSON.stringify({ kind: 'rule', description: 'Test rule', triggerPattern: 'test', action: 'do-thing' }),
    }));
    (decideInternalizationRoute as ReturnType<typeof vi.fn>).mockReturnValue({
      ready: true,
      route: 'rule-candidate',
      missingFields: [],
      reason: 'Rule ready',
      nextAction: 'Proceed',
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleCandidateInternalize({
      candidateId: 'cand-001',
      workspace: '/tmp/test',
      json: true,
    });

    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.channel).toBe('code_tool_hook');

    consoleSpy.mockRestore();
  });

  it('column fallback: sourceRecommendationJson empty but columns complete still creates task', async () => {
    mockStateManager.getCandidate.mockResolvedValue({
      candidateId: 'cand-fb-001',
      artifactId: 'art-fb-001',
      taskId: 'task-fb-001',
      sourceRunId: 'run-fb-001',
      title: 'Fallback Candidate',
      description: 'Fallback desc',
      confidence: 0.7,
      status: 'active',
      createdAt: new Date().toISOString(),
      sourceRecommendationJson: undefined,
    });

    const mockPrepare = vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue({
        recommendation_kind: 'principle',
        trigger_pattern: null,
        action: null,
        abstracted_principle: 'Always validate inputs',
      }),
    });
    mockStateManager.connection.getDb.mockReturnValue({ prepare: mockPrepare });

    (decideInternalizationRoute as ReturnType<typeof vi.fn>).mockReturnValue({
      ready: true,
      route: 'principle-ledger',
      missingFields: [],
      reason: 'Principle ready (column fallback)',
      nextAction: 'Proceed',
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleCandidateInternalize({
      candidateId: 'cand-fb-001',
      workspace: '/tmp/test',
      json: true,
    });

    expect(mockStateManager.createTask).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.status).toBe('created');
    expect(output.candidateId).toBe('cand-fb-001');

    consoleSpy.mockRestore();
  });
});
