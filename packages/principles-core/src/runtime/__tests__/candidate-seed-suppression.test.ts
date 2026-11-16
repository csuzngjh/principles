/**
 * Phase 7.2 B2.5 — Dreamer seed suppression for reuse-resolved / reuse-parked
 * candidates (LEDGER_WRITE_SAFETY_SPEC §3.4 downstream contract).
 *
 * Two layers:
 *   - the pure guard (evaluateDreamerSeedSuppression) over its two persistent
 *     facts: ledger identity basis (only 'principle_reuse' suppresses — an
 *     Owner reuse decision, an INV-R07 replay, or a B1 exact-duplicate
 *     resolution; a candidate's OWN new principle 'derived_candidate' and rule
 *     bindings never do) and the admission processing park;
 *   - the PainSignalBridge seed loop through the REAL onDiagnosisComplete:
 *     suppressed candidates are consumed and reported, but NO Dreamer task is
 *     created; genuine new principles keep seeding (negative control).
 */
import { describe, it, expect } from 'vitest';

import { evaluateDreamerSeedSuppression } from '../candidate-seed-suppression.js';
import { PainSignalBridge } from '../pain-signal-bridge.js';
import type { RuntimeStateManager, CandidateRecord } from '../store/runtime-state-manager.js';
import type { CandidateIntakeService } from '../candidate-intake-service.js';
import type { LedgerAdapter } from '../candidate-intake.js';
import type { DiagnosticianOutputV2 } from '../diagnostician-output.js';
import type { RunnerResult } from '../runner/runner-result.js';

const PAIN_ID = 'pain-b25-001';
const TASK_ID = 'diagnosis_pain-b25-001';
const RUN_ID = 'run-b25-1';

describe('Phase 7.2 B2.5 — evaluateDreamerSeedSuppression (pure guard)', () => {
  const resolved = (basis: string, principleId = 'p-target') =>
    ({ status: 'resolved', candidateId: 'c1', principleId, basis, checkedAt: '2026-11-16T00:00:00.000Z' }) as never;

  it('identity basis principle_reuse (Owner reuse decision / INV-R07 replay / B1 dedup) suppresses', () => {
    expect(evaluateDreamerSeedSuppression({ identity: resolved('principle_reuse'), processing: undefined }))
      .toEqual({ suppress: true, reason: 'reuse_resolved_to_existing_principle', principleId: 'p-target' });
  });

  it('identity basis derived_candidate (the candidate\'s OWN new principle) does NOT suppress', () => {
    expect(evaluateDreamerSeedSuppression({ identity: resolved('derived_candidate'), processing: undefined }))
      .toEqual({ suppress: false });
  });

  it('identity basis owner_rule_binding does NOT suppress (rule chains keep their own lifecycle)', () => {
    expect(evaluateDreamerSeedSuppression({ identity: resolved('owner_rule_binding'), processing: undefined }))
      .toEqual({ suppress: false });
  });

  it('any unresolved identity does NOT suppress', () => {
    for (const reason of ['missing', 'ambiguous', 'conflicting_authorities', 'target_ineligible', 'binding_revoked']) {
      expect(evaluateDreamerSeedSuppression({
        identity: { status: 'unresolved', reason, nextAction: 'none' } as never,
        processing: undefined,
      })).toEqual({ suppress: false });
    }
  });

  it('Owner P1: the PARK outranks a recorded reuse resolution (combined state answers reuse_park_pending_owner)', () => {
    expect(evaluateDreamerSeedSuppression({
      identity: resolved('principle_reuse', 'p-target'),
      processing: { state: 'awaiting_owner', blockedReason: 'reuse_pending_owner' },
    })).toEqual({ suppress: true, reason: 'reuse_park_pending_owner' });
  });

  it('a persisted reuse park (awaiting_owner / reuse_pending_owner) suppresses — even with an unresolved identity', () => {
    expect(evaluateDreamerSeedSuppression({
      identity: { status: 'unresolved', reason: 'missing', nextAction: 'none' } as never,
      processing: { state: 'awaiting_owner', blockedReason: 'reuse_pending_owner' },
    })).toEqual({ suppress: true, reason: 'reuse_park_pending_owner' });
  });

  it('other processing states do NOT suppress', () => {
    for (const processing of [
      { state: 'complete', completedAt: '2026-11-16T00:00:00.000Z' },
      { state: 'in_progress', attempts: 1 },
      { state: 'not_started', attempts: 0 },
      undefined,
    ]) {
      expect(evaluateDreamerSeedSuppression({
        identity: { status: 'unresolved', reason: 'missing', nextAction: 'none' } as never,
        processing,
      })).toEqual({ suppress: false });
    }
  });

  it('a non-reuse blockedReason does NOT suppress', () => {
    expect(evaluateDreamerSeedSuppression({
      identity: { status: 'unresolved', reason: 'missing', nextAction: 'none' } as never,
      processing: { state: 'awaiting_owner', blockedReason: 'needs_evidence:lacks owner statement' },
    })).toEqual({ suppress: false });
  });
});

// ── Bridge integration ───────────────────────────────────────────────────────

function makeCandidate(id: string, kind: CandidateRecord['recommendationKind']): CandidateRecord {
  return {
    candidateId: id,
    taskId: TASK_ID,
    artifactId: `artifact-${id}`,
    sourceRunId: `run-${id}`,
    title: `Candidate ${id}`,
    description: `Description for ${id}`,
    confidence: 0.85,
    sourceRecommendationJson: '{}',
    recommendationKind: kind,
    status: 'pending',
    createdAt: '2026-06-24T00:00:00.000Z',
    rawRecommendationKind: kind,
  };
}

function makeOutput(): DiagnosticianOutputV2 {
  return {
    schemaVersion: 'diagnostician-output-v2',
    valid: true,
    diagnosisId: 'diag-b25',
    summary: 'Valid diagnosis with sufficient evidence',
    rootCause: 'Identified root cause',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'session-trace-1', note: 'Owner confirmed behavior' }],
    recommendations: [{ kind: 'principle', description: 'Valid principle from evidence', abstractedPrinciple: 'Valid principle from evidence', recommendationRef: 'principle-1' }],
    confidence: 0.85,
  };
}

interface BridgeHarness {
  bridge: PainSignalBridge;
  createTaskCalls: Record<string, unknown>[];
  updateCandidateStatusCalls: { candidateId: string; patch: Record<string, unknown> }[];
  telemetryEvents: Record<string, unknown>[];
  /** Recorded admission-processing writes (park/complete transitions). */
  observeProcessingWrites: (sink: unknown[]) => void;
}

/**
 * Real bridge over mocked stores. `identityByCandidate` /
 * `processingByCandidate` drive the two persistent suppression facts;
 * `intakeByCandidate` drives the intake disposition.
 */
function makeHarness(args: {
  candidates: CandidateRecord[];
  intakeByCandidate: Record<string, unknown>;
  identityByCandidate: Record<string, unknown>;
  processingByCandidate: Record<string, unknown>;
}): BridgeHarness {
  const createTaskCalls: Record<string, unknown>[] = [];
  const updateCandidateStatusCalls: { candidateId: string; patch: Record<string, unknown> }[] = [];
  const telemetryEvents: Record<string, unknown>[] = [];
  let processingWritesSink: unknown[] | null = null;

  const stateManager = {
    getTask: async () => null,
    createTask: async (input: Record<string, unknown>) => {
      createTaskCalls.push(input);
      return { taskId: input.taskId };
    },
    updateTask: async () => undefined,
    getCandidatesByTaskId: async () => args.candidates,
    getRunsByTask: async () => [{ runId: RUN_ID, taskId: TASK_ID, status: 'succeeded' }],
    getRun: async (runId: string) => {
      const candidate = args.candidates.find((item) => item.sourceRunId === runId);
      return candidate ? { runId, taskId: candidate.taskId, executionStatus: 'succeeded', outputPayload: JSON.stringify(makeOutput()) } : null;
    },
    getArtifact: async (artifactId: string) => {
      const candidate = args.candidates.find((item) => item.artifactId === artifactId);
      return candidate ? { artifactId, runId: candidate.sourceRunId, taskId: candidate.taskId } : null;
    },
    updateCandidateStatus: async (candidateId: string, patch: Record<string, unknown>) => {
      updateCandidateStatusCalls.push({ candidateId, patch });
    },
    getAdmissionDocument: async (candidateId: string) => ({
      ok: true,
      document: args.processingByCandidate[candidateId] === undefined
        ? null
        : { schemaVersion: 1, evaluations: [], currentEvaluationId: null, processing: args.processingByCandidate[candidateId] },
    }),
    appendAdmissionEvaluation: async () => ({ status: 'appended', document: { schemaVersion: 1, evaluations: [], currentEvaluationId: null } }),
    updateAdmissionProcessing: async (candidateId: string, processing: Record<string, unknown>) => {
      if (processingWritesSink) processingWritesSink.push({ candidateId, ...processing });
      return true;
    },
  } as unknown as RuntimeStateManager;

  const intakeService = {
    intake: async (candidateId: string) => args.intakeByCandidate[candidateId],
  } as unknown as CandidateIntakeService;

  const ledgerAdapter = {
    existsForCandidate: () => null,
    resolveCandidatePrincipleIdentity: (candidateId: string, _kind: unknown) =>
      args.identityByCandidate[candidateId] ?? { status: 'unresolved', reason: 'missing', nextAction: 'none' },
  } as unknown as LedgerAdapter;

  const runner = {
    run: async (): Promise<RunnerResult> => ({ status: 'succeeded', taskId: TASK_ID, attemptCount: 1, output: makeOutput() }),
  };

  const bridge = new PainSignalBridge({
    stateManager,
    runner,
    intakeService,
    ledgerAdapter,
    autoIntakeEnabled: true,
    eventEmitter: {
      emitTelemetry: (event: Record<string, unknown>) => {
        telemetryEvents.push(event);
      },
    },
  });
  return {
    bridge,
    createTaskCalls,
    updateCandidateStatusCalls,
    telemetryEvents,
    observeProcessingWrites: (sink: unknown[]) => {
      processingWritesSink = sink;
    },
  };
}

const resolvedReuse = (principleId: string) => ({
  status: 'resolved',
  candidateId: 'c-resolved',
  principleId,
  basis: 'principle_reuse',
  checkedAt: '2026-11-16T00:00:00.000Z',
});

describe('Phase 7.2 B2.5 — bridge seed loop suppression', () => {
  it('a reuse_selected replay candidate is consumed but gets NO Dreamer task', async () => {
    const harness = makeHarness({
      candidates: [makeCandidate('c-resolved', 'principle')],
      intakeByCandidate: {
        'c-resolved': {
          outcome: 'refused',
          reason: 'reuse_selected',
          candidateId: 'c-resolved',
          rawRecommendationKind: 'principle',
          message: 'INV-R07 replay: already resolved',
          selectedPrincipleId: 'p-existing',
        },
      },
      identityByCandidate: { 'c-resolved': resolvedReuse('p-existing') },
      processingByCandidate: {},
    });

    const result = await harness.bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: makeOutput(),
      painId: PAIN_ID,
      provenance: 'host_context_bound',
      inputEvidenceCount: 1,
    });

    expect(harness.createTaskCalls).toHaveLength(0);
    expect(harness.updateCandidateStatusCalls).toMatchObject([
      { candidateId: 'c-resolved', patch: { status: 'consumed' } },
    ]);
    const outcome = result.candidateOutcomes?.[0];
    expect(outcome?.reason).toContain('dreamer_seed_suppressed');
    expect(outcome?.reason).toContain('p-existing');
  });

  it('a B1 exact-duplicate ledger_entry resolution (written:false) gets NO Dreamer task', async () => {
    const harness = makeHarness({
      candidates: [makeCandidate('c-resolved', 'principle')],
      intakeByCandidate: {
        'c-resolved': {
          outcome: 'ledger_entry',
          written: false,
          deduplicatedAgainst: 'p-existing',
          entry: { id: 'p-existing', status: 'probation', createdAt: '2026-11-16T00:00:00.000Z' },
        },
      },
      identityByCandidate: { 'c-resolved': resolvedReuse('p-existing') },
      processingByCandidate: {},
    });

    await harness.bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: makeOutput(),
      painId: PAIN_ID,
      provenance: 'host_context_bound',
      inputEvidenceCount: 1,
    });

    expect(harness.createTaskCalls).toHaveLength(0);
    expect(harness.updateCandidateStatusCalls).toMatchObject([
      { candidateId: 'c-resolved', patch: { status: 'consumed' } },
    ]);
  });

  it('a CONSUMED candidate with a persisted reuse park gets NO Dreamer task — and the park SURVIVES the round (19aa989d shape)', async () => {
    const harness = makeHarness({
      candidates: [makeCandidate('c-anomaly', 'principle')],
      intakeByCandidate: {
        'c-anomaly': {
          outcome: 'ledger_entry',
          written: true,
          entry: { id: 'ledger-c-anomaly', status: 'probation', createdAt: '2026-11-16T00:00:00.000Z' },
        },
      },
      identityByCandidate: {},
      processingByCandidate: {
        'c-anomaly': { state: 'awaiting_owner', attempts: 0, blockedReason: 'reuse_pending_owner' },
      },
    });
    const processingWrites: unknown[] = [];
    harness.observeProcessingWrites(processingWrites);

    const result = await harness.bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: makeOutput(),
      painId: PAIN_ID,
      provenance: 'host_context_bound',
      inputEvidenceCount: 1,
    });

    expect(harness.createTaskCalls).toHaveLength(0);
    // CodeRabbit fix contract: a park-pending candidate is NOT consumed and
    // its processing is NOT overwritten to complete — only the Owner release
    // channel (with its audit) may lift awaiting_owner.
    expect(harness.updateCandidateStatusCalls).toHaveLength(0);
    expect(processingWrites.some((write) => (write as { state?: string }).state === 'complete')).toBe(false);
    const outcome = result.candidateOutcomes?.[0];
    expect(outcome?.reason).toContain('dreamer_seed_suppressed');
    expect(outcome?.nextAction).toContain('pd candidate review');
    // The batch is NOT reported as an intake failure (no ledger entry was
    // expected for a park-pending candidate).
    expect(result.status).not.toBe('failed');
  });

  it('Owner P1 combined state: principle_reuse evidence + persisted park — NOT consumed, park NOT cleared, NO Dreamer', async () => {
    // The exact combination the Owner's P1 finding describes: the ledger
    // already records a reuse resolution (evidence on the existing
    // principle), AND the candidate still carries an unreleased Owner park.
    // The automatic bridge path must NOT let the evidence replay resolve the
    // candidate past the park: no consumption, no processing completion, no
    // independent Dreamer — the park stands until the Owner releases it.
    const harness = makeHarness({
      candidates: [makeCandidate('c-combined', 'principle')],
      intakeByCandidate: {
        // Even if some path hand-fed the 2b replay result, the seed loop's
        // own guard must answer PARK; with the service fix the intake below
        // never even runs (park replay at step 1b) — model the belt-and-
        // braces shape where a caller passed the replay result anyway.
        'c-combined': {
          outcome: 'refused',
          reason: 'reuse_selected',
          candidateId: 'c-combined',
          rawRecommendationKind: 'principle',
          message: 'INV-R07 replay',
          selectedPrincipleId: 'p-existing',
        },
      },
      identityByCandidate: { 'c-combined': resolvedReuse('p-existing') },
      processingByCandidate: {
        'c-combined': { state: 'awaiting_owner', attempts: 0, blockedReason: 'reuse_pending_owner' },
      },
    });
    const processingWrites: unknown[] = [];
    harness.observeProcessingWrites(processingWrites);

    const result = await harness.bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: makeOutput(),
      painId: PAIN_ID,
      provenance: 'host_context_bound',
      inputEvidenceCount: 1,
    });

    expect(harness.createTaskCalls).toHaveLength(0);
    expect(harness.updateCandidateStatusCalls).toHaveLength(0); // NOT consumed
    expect(processingWrites.some((w) => (w as { state?: string }).state === 'complete')).toBe(false); // park intact
    const outcome = result.candidateOutcomes?.[0];
    expect(outcome?.reason).toContain('dreamer_seed_suppressed');
    expect(outcome?.reason).toContain('reuse park'); // park semantics, not "resolved"
    expect(outcome?.nextAction).toContain('pd candidate review');
    expect(result.status).not.toBe('failed');
  });

  it('negative control: a genuine new principle still seeds exactly one Dreamer task', async () => {
    const harness = makeHarness({
      candidates: [makeCandidate('c-fresh', 'principle')],
      intakeByCandidate: {
        'c-fresh': {
          outcome: 'ledger_entry',
          written: true,
          entry: { id: 'ledger-c-fresh', status: 'probation', createdAt: '2026-11-16T00:00:00.000Z' },
        },
      },
      identityByCandidate: {
        'c-fresh': {
          status: 'resolved',
          candidateId: 'c-fresh',
          principleId: 'ledger-c-fresh',
          basis: 'derived_candidate',
          checkedAt: '2026-11-16T00:00:00.000Z',
        },
      },
      processingByCandidate: {},
    });

    const result = await harness.bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: makeOutput(),
      painId: PAIN_ID,
      provenance: 'host_context_bound',
      inputEvidenceCount: 1,
    });

    expect(harness.createTaskCalls).toHaveLength(1);
    expect(result.candidateOutcomes?.[0]?.seededTaskId).toBeTruthy();
  });
});
