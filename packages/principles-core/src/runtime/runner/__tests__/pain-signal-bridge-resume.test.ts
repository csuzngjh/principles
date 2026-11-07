/**
 * SPEC-CODEX-PAIN-CLOSURE-001 CR-05 — diagnosis post-processing continuation
 * (resumeSucceededDiagnosisPostProcessing) tests.
 *
 * These pin the A09/A18/A19 behaviors at the bridge boundary:
 *  - a succeeded diagnosis with stuck pending candidates (the original
 *    incident: three candidates parked before intake) is continued WITHOUT
 *    re-running the diagnosis LLM;
 *  - an intake exception records a bounded processing failure and the resume
 *    round finishes the candidate with no duplicate Ledger write;
 *  - an exhausted processing budget is a saved terminal state — the resume
 *    reports it instead of looping.
 */
import { describe, expect, it } from 'vitest';
import { PainSignalBridge } from '../../pain-signal-bridge.js';
import type { CandidateIntakeService, ReuseRecommendationOutcome } from '../../candidate-intake-service.js';
import type { LedgerAdapter, LedgerPrincipleEntry } from '../../candidate-intake.js';
import type { RuntimeStateManager, CandidateRecord } from '../../store/runtime-state-manager.js';
import type { RunnerResult } from '../../runner/runner-result.js';
import type { DiagnosticianOutputV1 } from '../../diagnostician-output.js';
import type { CandidateAdmissionDocument } from '../../store/candidate/admission-document.js';

const TASK_ID = 'diagnosis_pain_cr05';
const PAIN_ID = 'pain_cr05';

function makeOutput(): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: 'diag-cr05',
    summary: 'summary',
    rootCause: 'root cause',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'trace-1', note: 'note' }],
    recommendations: [{ kind: 'principle', description: 'Candidate principle' }],
    confidence: 0.9,
  };
}

function makeCandidate(id: string): CandidateRecord {
  return {
    candidateId: id,
    artifactId: `artifact-${id}`,
    taskId: TASK_ID,
    sourceRunId: `run-${id}`,
    title: 'T',
    description: 'D',
    confidence: 0.9,
    sourceRecommendationJson: '{}',
    recommendationKind: 'principle',
    rawRecommendationKind: 'principle',
    status: 'pending',
    createdAt: '2026-10-13T05:00:00.000Z',
  };
}

function makeDiagnosticJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sourcePainId: PAIN_ID,
    reasonSummary: 'reason',
    source: 'manual',
    severity: 'moderate',
    sessionIdHint: null,
    agentIdHint: null,
    provenance: 'owner_reported_no_host_trace',
    provenanceReason: 'r',
    evidence: [],
    workspaceDir: null,
    ...overrides,
  });
}

interface Harness {
  bridge: PainSignalBridge;
  runnerCalls: string[];
  intakeCalls: string[];
  ledgerWritten: string[];
  admissions: Map<string, CandidateAdmissionDocument | null>;
  processingUpdates: string[];
  taskRecord: { taskId: string; status: string; inputRef: string; diagnosticJson: string };
}

function makeHarness(overrides: {
  outputPayload?: string;
  diagnosticJson?: string;
  intakeImpl?: (candidateId: string) => Promise<never>;
  processingState?: string;
  existingLedger?: string[];
} = {}): Harness {
  const runnerCalls: string[] = [];
  const intakeCalls: string[] = [];
  const ledgerWritten: string[] = overrides.existingLedger ?? [];
  const admissions = new Map<string, CandidateAdmissionDocument | null>();
  const processingUpdates: string[] = [];
  const taskRecord = {
    taskId: TASK_ID,
    status: 'succeeded',
    inputRef: PAIN_ID,
    diagnosticJson: overrides.diagnosticJson ?? makeDiagnosticJson(),
  };

  const stateManager = {
    getTask: async () => taskRecord,
    createTask: async () => { return; },
    updateTask: async () => { return; },
    getCandidatesByTaskId: async () => [makeCandidate('c-cr05')],
    getRunsByTask: async () => [{ runId: 'run-1', taskId: TASK_ID, status: 'succeeded', outputPayload: overrides.outputPayload ?? JSON.stringify(makeOutput()) }],
    getRun: async (runId: string) => runId === 'run-c-cr05'
      ? { runId, taskId: TASK_ID, executionStatus: 'succeeded', outputPayload: overrides.outputPayload ?? JSON.stringify(makeOutput()) }
      : null,
    getArtifact: async (artifactId: string) => artifactId === 'artifact-c-cr05'
      ? { artifactId, runId: 'run-c-cr05', taskId: TASK_ID }
      : null,
    updateCandidateStatus: async () => { return; },
    getAdmissionDocument: async (candidateId: string) => ({ ok: true, document: admissions.get(candidateId) ?? null }),
    appendAdmissionEvaluation: async (candidateId: string, evaluation: { decision: string; materialFingerprint: string; policyVersion: string; evaluationId: string }) => {
      const existing = admissions.get(candidateId) ?? null;
      const evaluations = existing?.evaluations ?? [];
      const reused = evaluations.find((e) => e.materialFingerprint === evaluation.materialFingerprint && e.policyVersion === evaluation.policyVersion);
      if (reused) {
        const reusedDocument: CandidateAdmissionDocument = { ...(existing as CandidateAdmissionDocument), currentEvaluationId: reused.evaluationId };
        admissions.set(candidateId, reusedDocument);
        return { status: 'reused' as const, document: reusedDocument };
      }
      const document: CandidateAdmissionDocument = {
        schemaVersion: 1,
        evaluations: [...evaluations, evaluation as never],
        currentEvaluationId: evaluation.evaluationId,
        processing: existing?.processing,
      };
      admissions.set(candidateId, document);
      return { status: 'appended' as const, document };
    },
    updateAdmissionProcessing: async (candidateId: string, processing: { state: string }) => {
      processingUpdates.push(`${candidateId}:${processing.state}`);
      const existing = admissions.get(candidateId) ?? null;
      admissions.set(candidateId, {
        schemaVersion: 1,
        evaluations: existing?.evaluations ?? [],
        currentEvaluationId: existing?.currentEvaluationId ?? null,
        processing: processing as never,
      });
      return true;
    },
  } as unknown as RuntimeStateManager;

  const runner = {
    run: async (taskId: string): Promise<RunnerResult> => {
      runnerCalls.push(taskId);
      return { status: 'succeeded', taskId, attemptCount: 1, output: makeOutput() };
    },
  };

  const intakeService: CandidateIntakeService = {
    intake: async (candidateId: string) => {
      intakeCalls.push(candidateId);
      if (overrides.intakeImpl !== undefined) return overrides.intakeImpl(candidateId);
      if (!ledgerWritten.includes(candidateId)) ledgerWritten.push(candidateId);
      return { outcome: 'ledger_entry' as const, written: true, entry: { id: `ledger-${candidateId}` } };
    },
  } as unknown as CandidateIntakeService;

  const ledgerAdapter: LedgerAdapter = {
    existsForCandidate: (candidateId: string) => (ledgerWritten.includes(candidateId)
      ? { id: `ledger-${candidateId}` } as LedgerPrincipleEntry
      : null),
  } as unknown as LedgerAdapter;

  if (overrides.processingState !== undefined) {
    admissions.set('c-cr05', {
      schemaVersion: 1,
      evaluations: [],
      currentEvaluationId: null,
      processing: { state: overrides.processingState as 'exhausted', attempts: 3 },
    });
  }

  const bridge = new PainSignalBridge({
    stateManager,
    runner,
    intakeService,
    ledgerAdapter,
    autoIntakeEnabled: true,
  });

  return { bridge, runnerCalls, intakeCalls, ledgerWritten, admissions, processingUpdates, taskRecord };
}

describe('CR-05 resumeSucceededDiagnosisPostProcessing', () => {
  it('continues a succeeded diagnosis with stuck pending candidates WITHOUT re-running the diagnosis LLM (A09)', async () => {
    const h = makeHarness();
    const result = await h.bridge.resumeSucceededDiagnosisPostProcessing({ taskId: TASK_ID });
    expect(result.status).toBe('resumed');
    // Negative control: the runner must NEVER be invoked by the resume path.
    expect(h.runnerCalls).toEqual([]);
    expect(h.intakeCalls).toEqual(['c-cr05']);
    expect(h.ledgerWritten).toContain('c-cr05');
    expect(h.admissions.get('c-cr05')?.currentEvaluationId).toBeTruthy();
    expect(h.processingUpdates).toContain('c-cr05:complete');
  });

  it('is idempotent: a second resume neither re-runs the LLM nor duplicates the ledger write (A09/A18)', async () => {
    const h = makeHarness();
    await h.bridge.resumeSucceededDiagnosisPostProcessing({ taskId: TASK_ID });
    const second = await h.bridge.resumeSucceededDiagnosisPostProcessing({ taskId: TASK_ID });
    // Second round: the candidate is now processing-complete → not applicable.
    expect(second.status).toBe('not_applicable');
    expect(h.runnerCalls).toEqual([]);
    expect(h.intakeCalls).toEqual(['c-cr05']);
    expect(h.ledgerWritten).toEqual(['c-cr05']);
  });

  it('records a bounded processing failure on an intake exception, then the resume round finishes it (A18)', async () => {
    // Round 1: intake throws.
    const failing = makeHarness({
      intakeImpl: (async () => {
        throw new Error('intake temporarily unavailable');
      }),
    });
    const first = await failing.bridge.resumeSucceededDiagnosisPostProcessing({ taskId: TASK_ID });
    expect(first.status).toBe('resumed');
    expect(failing.processingUpdates).toContain('c-cr05:in_progress');
    const afterFailure = failing.admissions.get('c-cr05');
    expect(afterFailure?.processing?.attempts).toBe(1);
    expect(afterFailure?.processing?.state).toBe('in_progress');

    // Round 2 (infrastructure recovered): re-use the same harness state — the
    // processing domain is in_progress so the candidate stays eligible.
    const recovered = makeHarness({
      diagnosticJson: failing.taskRecord.diagnosticJson,
    });
    // seed the recovered harness with the post-failure document
    recovered.admissions.set('c-cr05', afterFailure as CandidateAdmissionDocument);
    const second = await recovered.bridge.resumeSucceededDiagnosisPostProcessing({ taskId: TASK_ID });
    expect(second.status).toBe('resumed');
    expect(recovered.intakeCalls).toEqual(['c-cr05']);
    expect(recovered.ledgerWritten).toEqual(['c-cr05']);
    expect(recovered.processingUpdates).toContain('c-cr05:complete');
  });

  it('an exhausted budget is a saved terminal state: resume reports instead of looping (A19)', async () => {
    const h = makeHarness({ processingState: 'exhausted' });
    const result = await h.bridge.resumeSucceededDiagnosisPostProcessing({ taskId: TASK_ID });
    expect(result.status).toBe('not_applicable');
    expect(h.intakeCalls).toEqual([]);
    expect(h.runnerCalls).toEqual([]);
    expect(result.skipped).toEqual([{ candidateId: 'c-cr05', reason: 'processing_exhausted' }]);
  });

  it('refuses non-succeeded tasks (not_applicable, no side effects)', async () => {
    const h = makeHarness();
    h.taskRecord.status = 'pending';
    const result = await h.bridge.resumeSucceededDiagnosisPostProcessing({ taskId: TASK_ID });
    expect(result.status).toBe('not_applicable');
    expect(h.intakeCalls).toEqual([]);
  });
});

void ({} as ReuseRecommendationOutcome | undefined);
