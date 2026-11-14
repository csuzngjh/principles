/**
 * SIA v1.2 · PRI-1216 — the Philosopher receives the SAME Stage A basis.
 *
 * TECH §6.2: `diagnosisArtifact` is added to the Philosopher context. The
 * diagnosis is reachable only through the dreamer's dependency set (a
 * peer-runner task may not declare a diagnostician dependency — the job graph
 * validation rejects that edge), so no seeding entry point needs to change.
 *
 * When the diagnostic stage is unreachable the Philosopher still runs — with
 * the pre-SIA prompt shape and an observable `philosopher_diagnosis_unavailable`
 * event (rc-9), never with invented strategic content.
 */
import { describe, expect, it, vi } from 'vitest';
import { PhilosopherRunner } from '../philosopher-runner.js';
import type { PhilosopherRunnerDeps } from '../philosopher-runner.js';
import { DefaultPhilosopherValidator } from '../philosopher-output.js';
import type { PIArtifactRecord } from '../pi-artifact.js';
import { MemoryPIArtifactStore } from '../pi-artifact-store.js';
import { fencedStateManager as fenced } from '../../__tests__/fixtures/fenced-state-manager.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../../runtime-protocol.js';
import type { StoreEventEmitter } from '../../store/event-emitter.js';
import type { TaskRecord } from '../../task-status.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';

const DREAMER_TASK_ID = 'dreamer-sia-001';
const PHILOSOPHER_TASK_ID = 'philosopher-sia-001';
const DIAG_TASK_ID = 'diag-router-sia-001';
const NOW = '2026-11-14T00:00:00.000Z';

const DREAMER_ARTIFACT_ID = 'pi-art-dreamer-sia-001';
const DIAG_ARTIFACT_ID = 'pi-art-diag-sia-001';

function artifact(id: string, taskId: string, content: unknown): PIArtifactRecord {
  return {
    artifactId: id,
    artifactKind: 'principle',
    sourceTaskId: taskId,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify(content),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const DREAMER_CONTENT = {
  valid: true,
  taskId: DREAMER_TASK_ID,
  candidates: [{
    candidateIndex: 0,
    badDecision: 'Ignored the recorded intent',
    betterDecision: 'Check the intent before writing',
    rationale: 'Prevents drift',
    confidence: 0.85,
    riskLevel: 'low',
    strategicPerspective: 'The candidate serves the "why" section of the owner intent.',
  }],
  contextRefs: [],
  generatedAt: NOW,
  intentTension: {
    source: 'action_drift',
    evidenceStrength: 'strong',
    relatedIntentFields: ['why'],
    evidence: ['diag#ev1'],
    explanation: 'the action drifted from the recorded owner intent',
    intentDocHash: 'sha256:stage-a-hash',
  },
  intentSnapshot: {
    contentHash: 'sha256:stage-a-hash',
    capturedAt: NOW,
    sections: [{ key: 'why', text: 'protect owner intent' }],
  },
};

const DIAG_CONTENT = {
  taskId: DIAG_TASK_ID,
  rootCause: 'bypassed the intent',
  summary: 'drift',
  violatedPrinciples: [],
  evidence: [{ sourceRef: 'diag#ev1', note: 'bypass' }],
  recommendations: [],
  confidence: 0.8,
  intentTension: DREAMER_CONTENT.intentTension,
  intentSnapshot: DREAMER_CONTENT.intentSnapshot,
};

function task(spec: { taskId: string; taskKind: string; status: TaskRecord['status']; deps: string[] }): TaskRecord {
  return {
    taskId: spec.taskId,
    taskKind: spec.taskKind,
    status: spec.status,
    attemptCount: 1,
    maxAttempts: 3,
    createdAt: NOW,
    updatedAt: NOW,
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: spec.deps,
      channel: 'prompt',
      timeoutMs: 1000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
    }),
  };
}

function philosopherOutput() {
  return {
    taskId: PHILOSOPHER_TASK_ID,
    sourceDreamerArtifactId: DREAMER_ARTIFACT_ID,
    thesis: 'Intent must be checked',
    principleCandidate: { title: 'Check intent', rationale: 'drift', scope: 'writes', confidence: 0.9 },
    risks: [],
    generatedAt: NOW,
  };
}

async function runPhilosopher(options: { withDiagnosis: boolean }) {
  const artifactStore = new MemoryPIArtifactStore();
  await artifactStore.upsertArtifact(artifact(DREAMER_ARTIFACT_ID, DREAMER_TASK_ID, DREAMER_CONTENT));
  if (options.withDiagnosis) {
    await artifactStore.upsertArtifact(artifact(DIAG_ARTIFACT_ID, DIAG_TASK_ID, DIAG_CONTENT));
  }
  const philosopherTask = task({ taskId: PHILOSOPHER_TASK_ID, taskKind: 'philosopher', status: 'pending', deps: [DREAMER_TASK_ID] });
  const dreamerTask = task({ taskId: DREAMER_TASK_ID, taskKind: 'dreamer', status: 'succeeded', deps: [DIAG_TASK_ID] });
  const diagTask = task({ taskId: DIAG_TASK_ID, taskKind: 'diag_router', status: 'succeeded', deps: [] });

  const stateManager = fenced({
    acquireLease: vi.fn().mockResolvedValue(philosopherTask),
    getTask: vi.fn().mockImplementation((id: string) => {
      if (id === PHILOSOPHER_TASK_ID) return Promise.resolve(philosopherTask);
      if (id === DREAMER_TASK_ID) return Promise.resolve(dreamerTask);
      if (id === DIAG_TASK_ID && options.withDiagnosis) return Promise.resolve(diagTask);
      return Promise.resolve(null);
    }),
    getRunsByTask: vi.fn().mockResolvedValue([{ runId: 'run-1', taskId: PHILOSOPHER_TASK_ID, runtimeKind: 'philosopher', startedAt: NOW }]),
    getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
      runs: [{ runId: 'run-1', taskId: PHILOSOPHER_TASK_ID, runtimeKind: 'philosopher', startedAt: NOW }],
      degradedRuns: [],
    }),
    updateRunOutput: vi.fn().mockResolvedValue(undefined),
    markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
    markTaskFailed: vi.fn().mockResolvedValue(undefined),
    markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
    getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
  });

  const runHandle: RunHandle = { runId: 'run-1', runtimeKind: 'test-double', startedAt: NOW };
  const succeededStatus: RunStatus = { status: 'succeeded', runId: 'run-1' };
  const runtimeAdapter = {
    startRun: vi.fn().mockResolvedValue(runHandle),
    pollRun: vi.fn().mockResolvedValue(succeededStatus),
    fetchOutput: vi.fn().mockResolvedValue({ payload: philosopherOutput() }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as PDRuntimeAdapter;
  const eventEmitter = { emitTelemetry: vi.fn() } as unknown as StoreEventEmitter;

  const deps: PhilosopherRunnerDeps = { stateManager, runtimeAdapter, eventEmitter, validator: new DefaultPhilosopherValidator(), artifactStore };
  const runner = new PhilosopherRunner(deps, { owner: 'test', runtimeKind: 'philosopher', pollIntervalMs: 10, timeoutMs: 1000 });
  const result = await runner.run(PHILOSOPHER_TASK_ID);

  const startCalls = (runtimeAdapter as unknown as { startRun: { mock: { calls: unknown[][] } } }).startRun.mock.calls;
  const startArgs = startCalls[0]?.[0] as { inputPayload: string; systemPrompt: string } | undefined;
  const telemetry = (eventEmitter as unknown as { emitTelemetry: { mock: { calls: unknown[][] } } }).emitTelemetry.mock.calls
    .map((call) => call[0] as { eventType: string; payload: Record<string, unknown> });
  return { result, startArgs, telemetry, artifactStore };
}

describe('PhilosopherRunner — Stage A diagnosis context (SIA v1.2)', () => {
  it('carries the diagnosis artifact into the prompt and the payload', async () => {
    const { result, startArgs } = await runPhilosopher({ withDiagnosis: true });
    expect(result.status).toBe('succeeded');
    expect(startArgs?.systemPrompt).toContain('DUAL ANCHOR REVIEW');
    const payload = JSON.parse(startArgs?.inputPayload ?? '{}') as Record<string, unknown>;
    const diagnosis = payload.diagnosisArtifact as Record<string, unknown> | undefined;
    expect(diagnosis?.rootCause).toBe('bypassed the intent');
    expect((diagnosis?.intentTension as Record<string, unknown> | undefined)?.source).toBe('action_drift');
    expect((diagnosis?.intentSnapshot as Record<string, unknown> | undefined)?.contentHash).toBe('sha256:stage-a-hash');
  });

  it('degrades observably when no diagnostic stage is reachable', async () => {
    const { result, startArgs, telemetry } = await runPhilosopher({ withDiagnosis: false });
    expect(result.status).toBe('succeeded');
    expect(startArgs?.systemPrompt).not.toContain('DUAL ANCHOR REVIEW');
    const payload = JSON.parse(startArgs?.inputPayload ?? '{}') as Record<string, unknown>;
    expect(Object.hasOwn(payload, 'diagnosisArtifact')).toBe(false);
    const unavailable = telemetry.filter((event) => event.eventType === 'philosopher_diagnosis_unavailable');
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]?.payload.reason).toBe('no_diagnostic_stage_among_dreamer_dependencies');
  });
});
