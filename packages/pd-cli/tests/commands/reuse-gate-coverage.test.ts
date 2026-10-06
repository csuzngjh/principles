/**
 * R7 gate-bypass fix regression (adhoc-20261007).
 *
 * Wave-2 audit D-1 (artifacts/r7-data-pipeline/reuse/gate-audit.md) proved
 * that `pd candidate intake`, `pd candidate repair` and `pd candidate
 * internalization backfill --include-pending` constructed their
 * CandidateIntakeService WITHOUT the Reuse Review Gate hook
 * (reuseCheck='not_configured'), so semantic duplicates the automatic paths
 * park (`reuse_review_required`) went straight to CREATE through the manual
 * commands — a P0 gate bypass in shipped 2.2.0/2.2.1.
 *
 * This file locks the invariant at two levels:
 *   1. static source scan — the three manual paths construct through the
 *      shared gated assembly (createReuseGatedIntakeService), never bare;
 *   2. behavior — the hook is actually injected (wiring), a park surfaces
 *      review guidance without mutating anything, the disabled-capability
 *      rollback switch (T11) still injects nothing, and the recorded-reuse
 *      replay (INV-R07, intake step 2b) is unchanged.
 *
 * The unavailable→create degradation (SPEC v0.3.3 Rule 4) is enforced inside
 * CandidateIntakeService (core principle-reuse tests cover it); here the CLI
 * contract locked is that a degraded-create result flows through the normal
 * consumed path unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ── Static source scan helpers (admission-gate-coverage.test.ts style) ───────

const PD_CLI_SRC_DIR = path.resolve(__dirname, '..', '..', 'src');

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(PD_CLI_SRC_DIR, relativePath), 'utf-8');
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ── Behavioral harness (candidate-intake.test.ts style) ──────────────────────

const { WORKSPACE,
  mockStateManager,
  mockAdapter,
  mockService,
  mockCreateReuseRecommendationHook,
  mockLoadPdConfig,
  capturedServiceArgs,
  executedSql,
  telemetryEvents,
  MockRuntimeStateManager,
  MockCandidateIntakeService,
  MockPrincipleTreeLedgerAdapter,
  MockCandidateIntakeError,
} = vi.hoisted(() => {
  const WORKSPACE = 'C:/r7-gate-coverage-ws';
  const capturedServiceArgs: Array<Record<string, unknown>> = [];
  const executedSql: Array<{ sql: string; params: unknown[] }> = [];
  const telemetryEvents: Array<Record<string, unknown>> = [];

  const mockStateManager = {
    initialize: vi.fn().mockResolvedValue(undefined),
    getCandidate: vi.fn(),
    getArtifact: vi.fn(),
    getTask: vi.fn(),
    getRun: vi.fn(),
    createTask: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    connection: {
      getDb: () => ({
        prepare: (sql: string) => ({
          all: (...params: unknown[]) => {
            executedSql.push({ sql, params });
            if (sql.includes("status = 'consumed'")) return [];
            if (sql.includes("status = 'pending'")) return [{ candidate_id: 'cand-park' }];
            return [];
          },
          get: (...params: unknown[]) => {
            executedSql.push({ sql, params });
            return { consumed_at: '2026-10-07T00:00:00.000Z' };
          },
          run: (...params: unknown[]) => {
            executedSql.push({ sql, params });
            return { changes: 1 };
          },
        }),
      }),
    },
  };

  const mockAdapter = {
    writeProbationEntry: vi.fn(),
    existsForCandidate: vi.fn().mockReturnValue(null),
  };

  const mockService = {
    intake: vi.fn(),
  };

  class MockCandidateIntakeError extends Error {
    code: string;
    context?: Record<string, unknown>;
    constructor(message: string, code: string, context?: Record<string, unknown>) {
      super(message);
      this.name = 'CandidateIntakeError';
      this.code = code;
      this.context = context;
    }
  }

  function MockRuntimeStateManager(this: unknown) {
    return mockStateManager;
  }
  MockRuntimeStateManager.prototype = {};

  function MockCandidateIntakeService(this: unknown, args: Record<string, unknown>) {
    capturedServiceArgs.push(args);
    return mockService;
  }
  MockCandidateIntakeService.prototype = {};

  function MockPrincipleTreeLedgerAdapter(this: unknown) {
    return mockAdapter;
  }
  MockPrincipleTreeLedgerAdapter.prototype = {};

  const mockCreateReuseRecommendationHook = vi.fn();
  const mockLoadPdConfig = vi.fn();

  return {
    WORKSPACE,
    mockStateManager,
    mockAdapter,
    mockService,
    mockCreateReuseRecommendationHook,
    mockLoadPdConfig,
    capturedServiceArgs,
    executedSql,
    telemetryEvents,
    MockRuntimeStateManager,
    MockCandidateIntakeService,
    MockPrincipleTreeLedgerAdapter,
    MockCandidateIntakeError,
  };
});

vi.mock('@principles/core/runtime-v2', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CandidateIntakeService: MockCandidateIntakeService,
  CandidateIntakeError: MockCandidateIntakeError,
  RuntimeStateManager: MockRuntimeStateManager,
  PrincipleTreeLedgerAdapter: MockPrincipleTreeLedgerAdapter,
  createReuseRecommendationHook: mockCreateReuseRecommendationHook,
  evaluateCandidateAdmissionFromRecord: vi.fn((candidate: { recommendationKind: string; confidence: number | null }) => {
    // Mirror the real implementation for test purposes
    if (candidate.recommendationKind === 'defer') {
      return { decision: 'deferred', reason: 'recommendation_kind_defer_not_actionable', nextAction: 'review_defer_disposition_manually', evidenceStatus: 'unknown' };
    }
    if (candidate.confidence === null) {
      return { decision: 'needs_evidence', reason: 'confidence_missing_on_candidate_record', nextAction: 're_run_diagnosis_to_populate_confidence_or_manual_review', evidenceStatus: 'unknown' };
    }
    if (candidate.confidence !== undefined && candidate.confidence < 0.5) {
      return { decision: 'needs_evidence', reason: `confidence_below_threshold:${candidate.confidence.toFixed(2)}<0.5`, nextAction: 'provide_additional_evidence_or_manual_review', evidenceStatus: 'unknown' };
    }
    return { decision: 'admitted', reason: 'cli_partial_check_passed_confidence_and_kind', nextAction: 'none', evidenceStatus: 'unknown' };
  }),
}));

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue(WORKSPACE),
}));

vi.mock('../../src/services/pd-config-loader.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadPdConfig: mockLoadPdConfig,
}));

vi.mock('../../src/services/workspace-telemetry.js', () => ({
  createWorkspaceTelemetryEmitter: vi.fn(() => ({
    emitTelemetry: (event: Record<string, unknown>) => {
      telemetryEvents.push(event);
    },
  })),
}));

import {
  handleCandidateIntake,
  handleCandidateRepair,
  handleCandidateInternalizationBackfill,
} from '../../src/commands/candidate.js';

/** The shape the Reuse Review Gate returns for a semantic duplicate (park). */
function parkedIntakeResult(candidateId: string) {
  return {
    outcome: 'refused',
    reason: 'reuse_pending_owner',
    candidateId,
    rawRecommendationKind: 'principle',
    message: `Candidate ${candidateId} is a suspected duplicate of existing Principle existing-p1 (semantic reuse recommendation, confidence 0.9).`,
    reuseRecommendation: {
      status: 'recommended',
      recommendation: 'reuse',
      selectedPrincipleId: 'existing-p1',
      rationale: 'same experience',
      confidence: 0.9,
    },
  };
}

function pendingCandidate(candidateId: string) {
  return {
    candidateId,
    status: 'pending',
    artifactId: 'art-1',
    taskId: 'diag-task-cand',
    description: `candidate ${candidateId}`,
    rawRecommendationKind: 'principle',
    recommendationKind: 'principle',
    confidence: 0.7,
    sourceRecommendationJson: JSON.stringify({
      kind: 'principle',
      description: `candidate ${candidateId}`,
      triggerPattern: `trigger ${candidateId}`,
      action: `action ${candidateId}`,
      abstractedPrinciple: `abstracted ${candidateId}`,
    }),
  };
}

function diagnosticianTask(taskId: string) {
  return {
    taskId,
    taskKind: 'diagnostician',
    status: 'completed',
    diagnosticJson: JSON.stringify({ sourcePainId: `pain-${taskId}` }),
  };
}

/** Parse the single JSON object the command printed to stdout. */
function parseJsonOutput(consoleLogSpy: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  for (const call of [...consoleLogSpy.mock.calls].reverse()) {
    try {
      const parsed = JSON.parse(call[0] as string);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch { /* not json */ }
  }
  throw new Error('no JSON object was printed to stdout');
}

describe('R7 gate-bypass fix: static source scan', () => {
  it('candidate.ts constructs intake/repair/backfill services through the gated assembly', () => {
    const content = readSource(path.join('commands', 'candidate.ts'));
    expect(countOccurrences(content, 'createReuseGatedIntakeService({')).toBe(3);
  });

  it('candidate.ts has exactly one direct CandidateIntakeService construction left (the review Owner channel)', () => {
    const content = readSource(path.join('commands', 'candidate.ts'));
    expect(countOccurrences(content, 'new CandidateIntakeService')).toBe(1);
    // The remaining construction is the Owner decision channel, which injects
    // reuseDecision — not an ungated path.
    const idx = content.indexOf('new CandidateIntakeService');
    expect(content.slice(idx, idx + 400)).toContain('reuseDecision');
  });

  it('the gated assembly never supplies a hook without reuseStateDir (half-config guard)', () => {
    const content = readSource(path.join('services', 'reuse-gated-intake.ts'));
    expect(content).toContain('...(reuseRecommendation ? { reuseRecommendation, reuseStateDir: stateDir } : {})');
  });
});

describe('R7 gate-bypass fix: wiring (the P0 itself)', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedServiceArgs.length = 0;
    executedSql.length = 0;
    telemetryEvents.length = 0;
    mockStateManager.initialize.mockResolvedValue(undefined);
    mockStateManager.close.mockResolvedValue(undefined);
    mockStateManager.getCandidate.mockReset();
    mockStateManager.getArtifact.mockReset();
    mockStateManager.getTask.mockReset();
    mockStateManager.getTask.mockImplementation((taskId: string) =>
      taskId.startsWith('diag-task-') ? Promise.resolve(diagnosticianTask(taskId)) : Promise.resolve(null));
    mockStateManager.createTask.mockReset();
    mockStateManager.createTask.mockImplementation((input: { taskId: string }) => Promise.resolve({ taskId: input.taskId }));
    mockAdapter.existsForCandidate.mockReturnValue(null);
    mockAdapter.writeProbationEntry.mockReset();
    mockService.intake.mockReset();
    mockService.intake.mockResolvedValue({ outcome: 'ledger_entry', written: true, entry: { id: 'ledger-entry-1', title: 'T' } });
    // Default: capability enabled, factory returns a sentinel hook.
    mockLoadPdConfig.mockReturnValue({ ok: true, effective: { config: { reuseEvaluation: { enabled: true } } }, defaults: { config: {} } });
    mockCreateReuseRecommendationHook.mockReset();
    mockCreateReuseRecommendationHook.mockReturnValue(undefined);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('RG-1: pd candidate intake injects the hook + reuseStateDir (pre-fix: bare construction)', async () => {
    const sentinelHook = async () => ({ status: 'unavailable' as const, reason: 'test stub' });
    mockCreateReuseRecommendationHook.mockReturnValue(sentinelHook);
    mockStateManager.getCandidate.mockResolvedValue(pendingCandidate('cand-1'));

    await handleCandidateIntake({ candidateId: 'cand-1', json: true });

    // The factory was consulted with the workspace config assembly inputs.
    expect(mockLoadPdConfig).toHaveBeenCalledWith(WORKSPACE);
    expect(mockCreateReuseRecommendationHook).toHaveBeenCalledWith(expect.objectContaining({
      effectiveConfig: expect.anything(),
      workspaceDir: WORKSPACE,
      stateDir: path.join(WORKSPACE, '.state'),
    }));
    // The service received the hook itself and the state dir — this is what
    // the pre-fix code omitted (reuseCheck='not_configured').
    expect(capturedServiceArgs).toHaveLength(1);
    expect(capturedServiceArgs[0].reuseRecommendation).toBe(sentinelHook);
    expect(capturedServiceArgs[0].reuseStateDir).toBe(path.join(WORKSPACE, '.state'));
    // And the normal create flow still completes.
    expect(mockService.intake).toHaveBeenCalledWith('cand-1');
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('RG-2: pd candidate repair injects the hook + reuseStateDir', async () => {
    const sentinelHook = async () => ({ status: 'unavailable' as const, reason: 'test stub' });
    mockCreateReuseRecommendationHook.mockReturnValue(sentinelHook);
    mockStateManager.getCandidate.mockResolvedValue({ ...pendingCandidate('cand-1'), status: 'consumed' });

    await handleCandidateRepair({ candidateId: 'cand-1', json: true });

    expect(capturedServiceArgs).toHaveLength(1);
    expect(capturedServiceArgs[0].reuseRecommendation).toBe(sentinelHook);
    expect(capturedServiceArgs[0].reuseStateDir).toBe(path.join(WORKSPACE, '.state'));
    expect(mockService.intake).toHaveBeenCalledWith('cand-1');
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('RG-3: pd candidate internalization backfill injects the hook + reuseStateDir', async () => {
    const sentinelHook = async () => ({ status: 'unavailable' as const, reason: 'test stub' });
    mockCreateReuseRecommendationHook.mockReturnValue(sentinelHook);
    mockStateManager.getCandidate.mockResolvedValue(pendingCandidate('cand-park'));

    await handleCandidateInternalizationBackfill({ includePending: true, confirm: true, json: true });

    expect(capturedServiceArgs).toHaveLength(1);
    expect(capturedServiceArgs[0].reuseRecommendation).toBe(sentinelHook);
    expect(capturedServiceArgs[0].reuseStateDir).toBe(path.join(WORKSPACE, '.state'));
  });

  it('RG-4 (T11 rollback): capability disabled → hook factory returns undefined → NOTHING injected', async () => {
    mockCreateReuseRecommendationHook.mockReturnValue(undefined);
    mockStateManager.getCandidate.mockResolvedValue(pendingCandidate('cand-1'));

    await handleCandidateIntake({ candidateId: 'cand-1', json: true });

    expect(capturedServiceArgs).toHaveLength(1);
    expect(capturedServiceArgs[0]).not.toHaveProperty('reuseRecommendation');
    expect(capturedServiceArgs[0]).not.toHaveProperty('reuseStateDir');
    expect(mockService.intake).toHaveBeenCalledWith('cand-1');
  });

  it('RG-5: intake parks a suspected duplicate — review guidance, no mutation, no non-zero exit, telemetry', async () => {
    const sentinelHook = async () => ({ status: 'unavailable' as const, reason: 'test stub' });
    mockCreateReuseRecommendationHook.mockReturnValue(sentinelHook);
    mockStateManager.getCandidate.mockResolvedValue(pendingCandidate('cand-park'));
    mockService.intake.mockResolvedValue(parkedIntakeResult('cand-park'));

    await handleCandidateIntake({ candidateId: 'cand-park', json: true });

    const output = parseJsonOutput(consoleLogSpy);
    expect(output.status).toBe('review_required');
    expect(output.reason).toBe('reuse_review_required');
    expect(output.reusedPrincipleId).toBe('existing-p1');
    expect(output.nextAction).toContain('pd candidate review --candidate-id cand-park --decide reuse|create');
    // cli-5: the park path performs NO state mutation — no ledger write, no
    // candidate status UPDATE, no consumed marking.
    expect(mockAdapter.writeProbationEntry).not.toHaveBeenCalled();
    expect(executedSql.filter((entry) => entry.sql.startsWith('UPDATE principle_candidates'))).toHaveLength(0);
    // Park is the gate working, not a command failure (same posture as
    // diagnose / pain-retry / the bridge).
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    // The park observation reaches the durable telemetry sink.
    expect(telemetryEvents).toHaveLength(1);
    expect(telemetryEvents[0].eventType).toBe('reuse_gate_triggered');
    expect((telemetryEvents[0].payload as Record<string, unknown>).candidateId).toBe('cand-park');
  });

  it('RG-6: repair parks a suspected duplicate orphan — no ledger rebuild, review guidance', async () => {
    const sentinelHook = async () => ({ status: 'unavailable' as const, reason: 'test stub' });
    mockCreateReuseRecommendationHook.mockReturnValue(sentinelHook);
    mockStateManager.getCandidate.mockResolvedValue({ ...pendingCandidate('cand-park'), status: 'consumed' });
    mockService.intake.mockResolvedValue(parkedIntakeResult('cand-park'));

    await handleCandidateRepair({ candidateId: 'cand-park', json: true });

    const output = parseJsonOutput(consoleLogSpy);
    expect(output.status).toBe('review_required');
    expect(output.reason).toBe('reuse_review_required');
    expect(output.reusedPrincipleId).toBe('existing-p1');
    expect(output.nextAction).toContain('pd candidate review --candidate-id cand-park --decide reuse|create');
    // Restoring the entry would have recreated a near-duplicate Principle —
    // prove it did not happen.
    expect(mockAdapter.writeProbationEntry).not.toHaveBeenCalled();
    expect(executedSql.filter((entry) => entry.sql.startsWith('UPDATE principle_candidates'))).toHaveLength(0);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(telemetryEvents).toHaveLength(1);
    expect(telemetryEvents[0].eventType).toBe('reuse_gate_triggered');
  });

  it('RG-7: backfill --include-pending parks a gate-held candidate — deferred + review nextAction, no intake failure, no dreamer seed', async () => {
    const sentinelHook = async () => ({ status: 'unavailable' as const, reason: 'test stub' });
    mockCreateReuseRecommendationHook.mockReturnValue(sentinelHook);
    mockStateManager.getCandidate.mockResolvedValue(pendingCandidate('cand-park'));
    mockService.intake.mockResolvedValue(parkedIntakeResult('cand-park'));

    await handleCandidateInternalizationBackfill({ includePending: true, confirm: true, json: true });

    const output = parseJsonOutput(consoleLogSpy);
    expect(output.details.totalPending).toBe(1);
    expect(output.details.intakeFailed).toBe(0);
    expect(output.details.intakeSucceeded).toBe(0);
    expect(output.details.created).toBe(0);
    const result = (output.details.results as Array<Record<string, unknown>>)[0];
    expect(result.candidateId).toBe('cand-park');
    expect(result.status).toBe('deferred');
    expect(String(result.reason)).toContain('reuse_review_required');
    expect(String(result.reason)).toContain('existing-p1');
    expect(result.statusBefore).toBe('pending');
    expect(result.statusAfter).toBe('pending');
    expect(result.intakeDecision).toBe('skipped');
    expect(result.seedDecision).toBe('skipped');
    expect(String(result.nextAction)).toContain('pd candidate review --candidate-id cand-park --decide reuse|create');
    // No dreamer task for a parked candidate, and no status mutation.
    expect(mockStateManager.createTask).not.toHaveBeenCalled();
    expect(executedSql.filter((entry) => entry.sql.startsWith('UPDATE principle_candidates'))).toHaveLength(0);
    expect(telemetryEvents).toHaveLength(1);
    expect(telemetryEvents[0].eventType).toBe('reuse_gate_triggered');
  });

  it('RG-8 (INV-R07 replay): an already-decided reuse candidate reports the resolution, exit 0', async () => {
    mockStateManager.getCandidate.mockResolvedValue({ ...pendingCandidate('cand-decided'), status: 'consumed' });
    mockService.intake.mockResolvedValue({
      outcome: 'refused',
      reason: 'reuse_selected',
      candidateId: 'cand-decided',
      rawRecommendationKind: 'principle',
      message: 'already resolved',
      selectedPrincipleId: 'existing-p1',
      reuseEvidence: {
        painId: 'pain-1',
        candidateId: 'cand-decided',
        actor: { kind: 'owner', id: 'owner-1' },
        reason: 'same semantics',
        decidedAt: '2026-10-06T00:00:00.000Z',
      },
    });

    await handleCandidateIntake({ candidateId: 'cand-decided', json: true });

    const output = parseJsonOutput(consoleLogSpy);
    expect(output.status).toBe('reused');
    expect(output.selectedPrincipleId).toBe('existing-p1');
    expect(output.candidateStatus).toBe('already_consumed');
    expect(mockAdapter.writeProbationEntry).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('RG-9 (Rule 4 degraded create): a degraded-create intake result flows through the normal consumed path', async () => {
    const sentinelHook = async () => ({ status: 'unavailable' as const, reason: 'channel dead' });
    mockCreateReuseRecommendationHook.mockReturnValue(sentinelHook);
    mockStateManager.getCandidate.mockResolvedValue(pendingCandidate('cand-novel'));
    // What the service returns when the evaluation channel is dead: the write
    // proceeded under Rule 4 with the observable degradation attached.
    mockService.intake.mockResolvedValue({
      outcome: 'ledger_entry',
      written: true,
      entry: { id: 'ledger-novel', title: 'Novel' },
      reuseCheck: 'recommended_create',
      reuseRecommendation: { status: 'unavailable', reason: 'pi-ai request failed' },
    });

    await handleCandidateIntake({ candidateId: 'cand-novel', json: true });

    const output = parseJsonOutput(consoleLogSpy);
    expect(output.status).toBe('consumed');
    expect(output.ledgerEntryId).toBe('ledger-novel');
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    // Degradation is not a park: no telemetry park event, no review guidance.
    expect(telemetryEvents).toHaveLength(0);
  });
});
