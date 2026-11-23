/**
 * D4 zero-seed tests for the automatic seeding entry —
 * SPEC-PD-PIPELINE-SPINE-001 v0.9 §3.4.2 注 3 (PRI-1291 Phase 1A red-first).
 *
 * Verified defect (origin/main): the PainSignalBridge seed path routes and
 * resolves identity from the NORMALIZED `candidate.recommendationKind`
 * (fail-open view — an invalid persisted kind folds to 'principle'), so a
 * candidate whose RAW persisted `rawRecommendationKind` is invalid or missing
 * can still be seeded into a Dreamer chain after Intake already refused it
 * for exactly that reason.
 *
 * Contract after the fix: the seed gate validates the RAW persisted kind
 * first (`validateRecommendationKind(candidate.rawRecommendationKind)`);
 * null → ZERO Dreamer tasks + a structured telemetry event (never a silent
 * pass). Legal `rule` / `prompt` raw kinds keep seeding unchanged.
 *
 * Fixtures deliberately set raw ≠ normalized (the existing
 * candidate-seed-suppression.test.ts fixtures use equal values and therefore
 * never exercised this defect).
 */
import { describe, it, expect } from 'vitest';

import { PainSignalBridge } from '../pain-signal-bridge.js';
import type { RuntimeStateManager, CandidateRecord } from '../store/runtime-state-manager.js';
import type { CandidateIntakeService } from '../candidate-intake-service.js';
import type { LedgerAdapter } from '../candidate-intake.js';
import type { DiagnosticianOutputV2 } from '../diagnostician-output.js';
import type { RunnerResult } from '../runner/runner-result.js';

const PAIN_ID = 'pain-d4-001';
const TASK_ID = 'diagnosis_pain-d4-001';
const RUN_ID = 'run-d4-1';

/** raw is the PERSISTED column value; normalized is the fail-open read view. */
function makeSplitCandidate(id: string, raw: string | null, normalized: string): CandidateRecord {
  return {
    candidateId: id,
    taskId: TASK_ID,
    artifactId: `artifact-${id}`,
    sourceRunId: `run-${id}`,
    title: `Candidate ${id}`,
    description: `Description for ${id}`,
    confidence: 0.85,
    sourceRecommendationJson: '{}',
    recommendationKind: normalized as CandidateRecord['recommendationKind'],
    status: 'pending',
    createdAt: '2026-11-23T00:00:00.000Z',
    ...(raw !== null ? { rawRecommendationKind: raw } : {}),
  } as CandidateRecord;
}

function makeOutput(): DiagnosticianOutputV2 {
  return {
    schemaVersion: 'diagnostician-output-v2',
    valid: true,
    diagnosisId: 'diag-d4',
    summary: 'Valid diagnosis with sufficient evidence',
    rootCause: 'Identified root cause',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'session-trace-1', note: 'Owner confirmed behavior' }],
    recommendations: [{ kind: 'principle', description: 'Valid principle from evidence', abstractedPrinciple: 'Valid principle from evidence', recommendationRef: 'principle-1' }],
    confidence: 0.85,
  };
}

interface Harness {
  bridge: PainSignalBridge;
  createTaskCalls: Record<string, unknown>[];
  telemetryEvents: Record<string, unknown>[];
}

function makeHarness(candidates: CandidateRecord[]): Harness {
  const createTaskCalls: Record<string, unknown>[] = [];
  const telemetryEvents: Record<string, unknown>[] = [];

  const stateManager = {
    getTask: async () => null,
    createTask: async (input: Record<string, unknown>) => {
      createTaskCalls.push(input);
      return { taskId: input.taskId };
    },
    updateTask: async () => undefined,
    getCandidatesByTaskId: async () => candidates,
    getRunsByTask: async () => [{ runId: RUN_ID, taskId: TASK_ID, status: 'succeeded' }],
    getRun: async (runId: string) => {
      const candidate = candidates.find((item) => item.sourceRunId === runId);
      return candidate ? { runId, taskId: candidate.taskId, executionStatus: 'succeeded', outputPayload: JSON.stringify(makeOutput()) } : null;
    },
    getArtifact: async (artifactId: string) => {
      const candidate = candidates.find((item) => item.artifactId === artifactId);
      return candidate ? { artifactId, runId: candidate.sourceRunId, taskId: candidate.taskId } : null;
    },
    updateCandidateStatus: async () => undefined,
    getAdmissionDocument: async () => ({ ok: true, document: null }),
    appendAdmissionEvaluation: async () => ({ status: 'appended', document: { schemaVersion: 1, evaluations: [], currentEvaluationId: null } }),
    updateAdmissionProcessing: async () => true,
  } as unknown as RuntimeStateManager;

  // Intake mirrors the production disposition for an invalid raw kind: the
  // ledger write boundary REFUSES (non-exception) — the exact window the
  // seed loop must not undo by folding the kind to 'principle'.
  const intakeService = {
    intake: async (candidateId: string) => ({
      outcome: 'refused',
      reason: 'candidate_kind_invalid',
      candidateId,
      rawRecommendationKind: 'wizardry',
      message: 'recommendation_kind is not a valid kind',
    }),
  } as unknown as CandidateIntakeService;

  const ledgerAdapter = {
    existsForCandidate: () => null,
    resolveCandidatePrincipleIdentity: () => ({ status: 'unresolved', reason: 'missing', nextAction: 'none' }),
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
  return { bridge, createTaskCalls, telemetryEvents };
}

describe('D4 — automatic seed entry refuses invalid RAW kinds with zero Dreamer tasks', () => {
  it('raw kind invalid (normalized folds to principle): ZERO dreamer tasks + structured telemetry', async () => {
    const harness = makeHarness([makeSplitCandidate('c-invalid', 'wizardry', 'principle')]);
    await harness.bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: makeOutput(),
      painId: PAIN_ID,
      provenance: 'host_context_bound',
      inputEvidenceCount: 1,
    });
    expect(harness.createTaskCalls).toHaveLength(0);
    const seedRefusalEvents = harness.telemetryEvents.filter(
      (event) => String(event.eventType).includes('seed') && String(JSON.stringify(event.payload)).includes('candidate_kind_invalid'),
    );
    expect(seedRefusalEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('raw kind missing entirely: ZERO dreamer tasks', async () => {
    const harness = makeHarness([makeSplitCandidate('c-missing', null, 'principle')]);
    await harness.bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: makeOutput(),
      painId: PAIN_ID,
      provenance: 'host_context_bound',
      inputEvidenceCount: 1,
    });
    expect(harness.createTaskCalls).toHaveLength(0);
  });

  it('legal raw rule kind keeps seeding (route unchanged, negative control)', async () => {
    const harness = makeHarness([makeSplitCandidate('c-rule', 'rule', 'rule')]);
    await harness.bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: makeOutput(),
      painId: PAIN_ID,
      provenance: 'host_context_bound',
      inputEvidenceCount: 1,
    });
    expect(harness.createTaskCalls).toHaveLength(1);
    expect(String(harness.createTaskCalls[0].taskId)).toContain('c-rule');
  });

  it('legal raw prompt kind keeps seeding (route unchanged, negative control)', async () => {
    const harness = makeHarness([makeSplitCandidate('c-prompt', 'prompt', 'prompt')]);
    await harness.bridge.onDiagnosisComplete({
      taskId: TASK_ID,
      diagnosticianOutput: makeOutput(),
      painId: PAIN_ID,
      provenance: 'host_context_bound',
      inputEvidenceCount: 1,
    });
    expect(harness.createTaskCalls).toHaveLength(1);
    expect(String(harness.createTaskCalls[0].taskId)).toContain('c-prompt');
  });
});
