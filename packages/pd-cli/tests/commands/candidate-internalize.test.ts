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
    // SPEC-PD-PIPELINE-SPINE-001 D4: the authority gate reads the admission
    // document (fail-closed on ok:false). Default = a readable document with
    // no processing history, matching a normally-intaked candidate.
    getAdmissionDocument: vi.fn().mockResolvedValue({ ok: true, document: null }),
  };

  function MockRuntimeStateManager(this: any) {
    return mockStateManager;
  }
  MockRuntimeStateManager.prototype = {};

  return { mockStateManager, MockRuntimeStateManager };
});

vi.mock('@principles/core/runtime', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    RuntimeStateManager: MockRuntimeStateManager,
    decideInternalizationRoute: vi.fn(),
    resolveOutputLanguage: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
    // SPEC-PD-PIPELINE-SPINE-001 D4: these wiring tests exercise the handler,
    // not the ledger — the gate sees a resolved derived identity, the state a
    // normally-intaked candidate has in production.
    PrincipleTreeLedgerAdapter: vi.fn().mockImplementation(function () {
      return {
        resolveCandidatePrincipleIdentity: () => ({
          status: 'resolved',
          candidateId: 'c1',
          principleId: '11111111-1111-4111-8111-111111111111',
          basis: 'derived_candidate',
          checkedAt: '2026-11-23T00:00:00.000Z',
        }),
      };
    }),
  };
});

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/test-workspace'),
}));

// PRI-1267: the admission write gate is a real service with its own tests;
// here it is mocked so each case can pin the internalize handler's wiring
// (refusal → structured output, zero tasks) without rebuilding the store.
vi.mock('../../src/services/admission-write-gate.js', () => ({
  enforceFullAdmissionForWrite: vi.fn().mockResolvedValue(null),
}));

import { decideInternalizationRoute } from '@principles/core/runtime';
import { enforceFullAdmissionForWrite } from '../../src/services/admission-write-gate.js';

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
    // PRI-1267: default = the write gate admits (individual tests override).
    (enforceFullAdmissionForWrite as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    mockStateManager.getCandidate.mockResolvedValue(null);
    // PRI-435: getTask must return different values based on taskId:
    // - candidate.taskId ('task-*') → diagnostician task with sourcePainId in diagnosticJson
    // - dreamer task ID ('dreamer-*') → null (no existing dreamer task)
    mockStateManager.getTask.mockImplementation((taskId: string) => {
      if (taskId.startsWith('task-')) {
        return Promise.resolve({
          taskId,
          taskKind: 'diagnostician',
          status: 'completed',
          diagnosticJson: JSON.stringify({ sourcePainId: 'pain-001' }),
        });
      }
      // Dreamer task lookup → null (no existing dreamer task)
      return Promise.resolve(null);
    });
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
    // PRI-435: getTask returns diagnostician task for 'task-*' (lineage resolution),
    // and existing dreamer task for 'dreamer-*' (idempotency check).
    mockStateManager.getTask.mockImplementation((taskId: string) => {
      if (taskId.startsWith('task-')) {
        return Promise.resolve({
          taskId,
          taskKind: 'diagnostician',
          status: 'completed',
          diagnosticJson: JSON.stringify({ sourcePainId: 'pain-001' }),
        });
      }
      return Promise.resolve({
        taskId: 'dreamer-cand-001-prompt',
        taskKind: 'dreamer',
        status: 'pending',
      });
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

    // PRI-1267 review round: the preview path re-evaluates WITHOUT persisting —
    // a dry-run must leave the persisted admission document untouched (cli-4).
    expect(enforceFullAdmissionForWrite).toHaveBeenCalledWith(
      mockStateManager,
      'cand-001',
      // PRI-1283 R2: the admission re-verification now also carries the
      // latest-consent source-material gate.
      expect.objectContaining({ persistReevaluation: false }),
    );

    consoleSpy.mockRestore();
  });

  it('PRI-1267 review: a REAL (non-dry-run) internalize keeps the persisting re-evaluation', async () => {
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
    });

    expect(enforceFullAdmissionForWrite).toHaveBeenCalledWith(
      mockStateManager,
      'cand-001',
      expect.objectContaining({ persistReevaluation: true }),
    );

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

  it('column fallback: sourceRecommendationJson empty but columns complete still creates task', async () => {    mockStateManager.getCandidate.mockResolvedValue({
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

  // ── PRI-1267: admission write gate at the internalize entry ──────────────

  it('PRI-1267: admission-refused candidate (needs_evidence 0.45<0.5) returns structured refusal, zero Dreamer tasks, non-zero exit', async () => {
    mockStateManager.getCandidate.mockResolvedValue(mockCandidate({ candidateId: 'cand-refused' }));
    (decideInternalizationRoute as ReturnType<typeof vi.fn>).mockReturnValue({
      ready: true,
      route: 'principle-ledger',
      missingFields: [],
      reason: 'Ready',
      nextAction: 'Proceed',
    });
    (enforceFullAdmissionForWrite as ReturnType<typeof vi.fn>).mockResolvedValue({
      decision: 'needs_evidence',
      reason: 'confidence_below_threshold:0.45<0.50',
      nextAction: 'provide_additional_evidence_or_manual_review',
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(handleCandidateInternalize({
      candidateId: 'cand-refused',
      workspace: '/tmp/test',
      json: true,
    })).rejects.toThrow();

    // cli-5-failure-no-mutation: no route decision, no seed, no dedup read, no task.
    expect(mockStateManager.createTask).not.toHaveBeenCalled();
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.status).toBe('refused');
    expect(output.admissionDecision).toBe('needs_evidence');
    expect(output.reason).toBe('confidence_below_threshold:0.45<0.50');
    expect(output.nextAction).toBe('provide_additional_evidence_or_manual_review');

    consoleSpy.mockRestore();
  });

  it('PRI-1267: admission refusal also blocks --dry-run (a refused candidate must not be promised a task)', async () => {
    mockStateManager.getCandidate.mockResolvedValue(mockCandidate({ candidateId: 'cand-refused-dry' }));
    (enforceFullAdmissionForWrite as ReturnType<typeof vi.fn>).mockResolvedValue({
      decision: 'needs_evidence',
      reason: 'input_evidence_empty',
      nextAction: 'collect_evidence_before_diagnosis',
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(handleCandidateInternalize({
      candidateId: 'cand-refused-dry',
      workspace: '/tmp/test',
      json: true,
      dryRun: true,
    })).rejects.toThrow();

    expect(mockStateManager.createTask).not.toHaveBeenCalled();
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.status).toBe('refused');
    expect(output.admissionDecision).toBe('needs_evidence');

    consoleSpy.mockRestore();
  });

  // ── PRI-1268: enqueue write failure = single structured JSON result ──────

  it('PRI-1268: createTask store failure emits ONE structured write_failed JSON with stable reason + nextAction, non-zero exit', async () => {
    mockStateManager.getCandidate.mockResolvedValue(mockCandidate({ candidateId: 'cand-wf' }));
    (decideInternalizationRoute as ReturnType<typeof vi.fn>).mockReturnValue({
      ready: true,
      route: 'principle-ledger',
      missingFields: [],
      reason: 'Ready',
      nextAction: 'Proceed',
    });
    mockStateManager.createTask.mockRejectedValue(new Error('SqliteError: attempt to write a readonly database'));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(handleCandidateInternalize({
      candidateId: 'cand-wf',
      workspace: '/tmp/test',
      json: true,
    })).rejects.toThrow();

    // cli-1-strict-json: exactly one machine-readable JSON object on stdout,
    // nothing else — the store error never reaches stdout as a bare stack.
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.status).toBe('write_failed');
    expect(output.reason).toMatch(/^internalize_task_write_failed:/);
    expect(output.reason).toContain('readonly');
    expect(output.nextAction).toContain('NOT created');

    consoleSpy.mockRestore();
  });

  it('PRI-1268 review: the admission GATE write failure is a structured write_failed too (no bare stack, no task)', async () => {
    // The gate itself persists its re-evaluation; an environmental store
    // failure inside the gate used to escape the structured result path
    // (bare SqliteError + empty --json stdout).
    mockStateManager.getCandidate.mockResolvedValue(mockCandidate({ candidateId: 'cand-gate-wf' }));
    (enforceFullAdmissionForWrite as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('SqliteError: attempt to write a readonly database'));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(handleCandidateInternalize({
      candidateId: 'cand-gate-wf',
      workspace: '/tmp/test',
      json: true,
    })).rejects.toThrow();

    // cli-1-strict-json: exactly one machine-readable JSON object; the raw
    // store error never reaches stdout.
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(output.status).toBe('write_failed');
    expect(output.reason).toMatch(/^internalize_admission_gate_write_failed:/);
    expect(output.reason).toContain('readonly');
    expect(output.nextAction).toContain('NO task was created');
    expect(mockStateManager.createTask).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
