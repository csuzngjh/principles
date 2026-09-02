/**
 * PRI-634 PR-A — repair-replay-resolver unit regressions (SPEC §21/§26/§27/§30).
 *
 * Covers:
 *   - legacy actualDecision=<errorType> normalization (readers normalize, no migration)
 *   - current-shape entries keep real actualDecision only when a decision existed
 *   - deterministic artifact authority selection: completionIntent.sourceRunId
 *     → pi-art-<taskId>-<runId>; fallback exactly-one; zero/many fail loud
 *   - adversarialResult missing / corrupt → structured failure, never blind retry
 *   - bounded stratified selection: errorType × expectedDecision groups,
 *     mismatch preference, stable order, truncation flag
 *   - system sentinels partition separately from real trace failures;
 *     forbidden patterns surface as global violations
 */
import { describe, it, expect } from 'vitest';
import {
  resolveRepairReplayContext,
  selectBoundedReplayFailures,
  MAX_REPLAY_FAILURES_IN_REPAIR,
  type ReplayFailureEvidence,
} from '../repair-replay-resolver.js';
import { createPITaskDiagnosticJson } from '../pitask-metadata.js';
import type { TaskRecord } from '../../task-status.js';
import type { PIArtifactRecord } from '../pi-artifact.js';

function mkTask(diagnosticJson: string): TaskRecord {
  return {
    taskId: 'eval-t1',
    taskKind: 'evaluator',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    diagnosticJson,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as TaskRecord;
}

function intentTask(runId: string): TaskRecord {
  const base = JSON.parse(createPITaskDiagnosticJson({
    dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000,
    inputArtifactRefs: [], outputArtifactRefs: [],
  })) as Record<string, unknown>;
  // diagnosticJson nests the metadata under the PI envelope key.
  const envelopeKey = Object.keys(base).find((k) => k !== 'version');
  if (envelopeKey === undefined) throw new Error('unexpected diagnosticJson shape');
  const meta = base[envelopeKey] as Record<string, unknown>;
  meta.completionIntent = {
    decision: 'needs_revision',
    sourceRunId: runId,
    revisionEpoch: 0,
    status: 'applied',
  };
  return mkTask(JSON.stringify(base));
}

function mkArtifact(overrides: Partial<PIArtifactRecord>): PIArtifactRecord {
  return {
    artifactId: 'pi-art-eval-t1-run-1',
    artifactKind: 'principle',
    sourceTaskId: 'eval-t1',
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: '{}',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

function evaluatorArtifactWith(adversarialResult: unknown): PIArtifactRecord {
  return mkArtifact({
    contentJson: JSON.stringify({
      taskId: 'eval-t1',
      evaluation: { decision: 'needs_revision', summary: 's', score: 0.5, strengths: [], concerns: [], requiredChanges: ['x'] },
      adversarialResult,
    }),
  });
}

function depsWith(params: {
  task?: TaskRecord | null;
  artifacts?: PIArtifactRecord[];
  byId?: Record<string, PIArtifactRecord>;
}) {
  return {
    artifactStore: {
      getArtifactById: async (id: string) => params.byId?.[id] ?? params.artifacts?.find((a) => a.artifactId === id) ?? null,
      listBySourceTaskId: async (taskId: string) => (params.artifacts ?? []).filter((a) => a.sourceTaskId === taskId),
    },
    getTask: async (taskId: string) => (params.task === undefined ? intentTask('run-1') : params.task?.taskId === taskId ? params.task : null),
  };
}

describe('PRI-634 PR-A: resolveRepairReplayContext — artifact authority selection (SPEC §26)', () => {
  it('resolves via completionIntent.sourceRunId → pi-art-<taskId>-<runId> even when other artifacts exist', async () => {
    const authoritative = evaluatorArtifactWith({ passed: false, failedCases: [{ caseId: 'v2-unavailable', attackType: 'boundary', expectedDecision: 'allow', errorType: 'runtime_error', message: 'boom' }] });
    const decoy = mkArtifact({ artifactId: 'pi-art-eval-t1-run-0', contentJson: JSON.stringify({ evaluation: { decision: 'needs_revision' } }) });
    const resolution = await resolveRepairReplayContext({
      sourceEvaluatorTaskId: 'eval-t1',
      deps: depsWith({ task: intentTask('run-1'), artifacts: [decoy, authoritative], byId: { 'pi-art-eval-t1-run-1': authoritative } }),
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.context.sourceEvaluatorArtifactId).toBe('pi-art-eval-t1-run-1');
    expect(resolution.context.failedCaseCount).toBe(1);
  });

  it('falls back to exactly-one principle artifact when the intent is absent', async () => {
    const only = evaluatorArtifactWith({ passed: false, failedCases: [] });
    const task = mkTask(createPITaskDiagnosticJson({
      dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [],
    }));
    const resolution = await resolveRepairReplayContext({
      sourceEvaluatorTaskId: 'eval-t1',
      deps: depsWith({ task, artifacts: [only] }),
    });
    expect(resolution.ok).toBe(true);
  });

  it('P1 review 2026-09-02: intent-named artifact missing + exactly one other-run artifact → FAIL LOUD, never cross-run fallback', async () => {
    // The durable authority (completionIntent.sourceRunId) is KNOWN — a
    // different run's artifact must not be silently promoted into its place.
    const staleOtherRun = mkArtifact({ artifactId: 'pi-art-eval-t1-run-0', contentJson: evaluatorArtifactWith({ passed: true, failedCases: [] }).contentJson });
    const resolution = await resolveRepairReplayContext({
      sourceEvaluatorTaskId: 'eval-t1',
      deps: depsWith({ task: intentTask('run-1'), artifacts: [staleOtherRun], byId: {} }),
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe('artifact_missing');
    expect(resolution.detail).toContain('refusing cross-run fallback');
    expect(resolution.detail).toContain('pi-art-eval-t1-run-1');
  });

  it('fails loud (artifact_ambiguous) on multiple artifacts with no resolvable intent — never a positional pick', async () => {
    const a = evaluatorArtifactWith({ passed: false, failedCases: [] });
    const b = evaluatorArtifactWith({ passed: true, failedCases: [] });
    const task = mkTask(createPITaskDiagnosticJson({
      dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [],
    }));
    const resolution = await resolveRepairReplayContext({
      sourceEvaluatorTaskId: 'eval-t1',
      deps: depsWith({ task, artifacts: [a, b] }),
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe('artifact_ambiguous');
  });

  it('fails loud (artifact_missing) when zero principle artifacts exist', async () => {
    const resolution = await resolveRepairReplayContext({
      sourceEvaluatorTaskId: 'eval-t1',
      deps: depsWith({ task: intentTask('run-1'), artifacts: [] }),
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe('artifact_missing');
  });

  it('fails loud (task_missing) when the evaluator task does not exist', async () => {
    const resolution = await resolveRepairReplayContext({
      sourceEvaluatorTaskId: 'eval-t1',
      deps: depsWith({ task: null, artifacts: [] }),
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe('task_missing');
  });
});

describe('PRI-634 PR-A: adversarialResult validation (SPEC §27 — no blind retry)', () => {
  it('adversarial_result_missing when the artifact carries no adversarialResult', async () => {
    const artifact = evaluatorArtifactWith(undefined);
    // remove the key entirely
    const parsed = JSON.parse(artifact.contentJson) as Record<string, unknown>;
    delete parsed.adversarialResult;
    artifact.contentJson = JSON.stringify(parsed);
    const resolution = await resolveRepairReplayContext({
      sourceEvaluatorTaskId: 'eval-t1',
      deps: depsWith({ artifacts: [artifact], byId: { [artifact.artifactId]: artifact } }),
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe('adversarial_result_missing');
  });

  it('adversarial_result_invalid on malformed failedCases elements — never silently dropped', async () => {
    const artifact = evaluatorArtifactWith({ passed: false, failedCases: [{ caseId: 42 }] });
    const resolution = await resolveRepairReplayContext({
      sourceEvaluatorTaskId: 'eval-t1',
      deps: depsWith({ artifacts: [artifact], byId: { [artifact.artifactId]: artifact } }),
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe('adversarial_result_invalid');
  });

  it('unparseable contentJson → adversarial_result_invalid', async () => {
    const artifact = mkArtifact({ contentJson: '{not-json' });
    const resolution = await resolveRepairReplayContext({
      sourceEvaluatorTaskId: 'eval-t1',
      deps: depsWith({ artifacts: [artifact], byId: { [artifact.artifactId]: artifact } }),
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe('adversarial_result_invalid');
  });
});

describe('PRI-634 PR-A: legacy normalization + partitioning (SPEC §17/§18/§21)', () => {
  it('legacy actualDecision=<sandbox error enum> normalizes into errorType with actualDecision dropped', async () => {
    const artifact = evaluatorArtifactWith({
      passed: false,
      failedCases: [
        // pre-PR-A representation: actualDecision carried the errorType
        { caseId: 'v2-unavailable', attackType: 'boundary', actualDecision: 'runtime_error', expectedDecision: 'allow', rationale: 'runtime_error: paramsSummary.includes is not a function' },
        { caseId: 'v2-truncated', attackType: 'omission', actualDecision: 'timeout', expectedDecision: 'allow', rationale: 'timeout: Evaluation timed out' },
      ],
    });
    const resolution = await resolveRepairReplayContext({
      sourceEvaluatorTaskId: 'eval-t1',
      deps: depsWith({ artifacts: [artifact], byId: { [artifact.artifactId]: artifact } }),
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.context.traceFailures).toHaveLength(2);
    const [first, second] = resolution.context.traceFailures;
    expect(first?.errorType).toBe('runtime_error');
    expect(first?.actualDecision).toBeUndefined();
    expect(first?.message).toBe('runtime_error: paramsSummary.includes is not a function');
    expect(second?.errorType).toBe('timeout');
    expect(second?.actualDecision).toBeUndefined();
  });

  it('legacy actualDecision=<real decision> is kept as a real decision and errorType inferred as validation_failed', async () => {
    const artifact = evaluatorArtifactWith({
      passed: false,
      failedCases: [
        { caseId: 'v2-path-boundary', attackType: 'boundary', actualDecision: 'allow', expectedDecision: 'block', rationale: 'validation_failed: Expected block but got allow' },
      ],
    });
    const resolution = await resolveRepairReplayContext({
      sourceEvaluatorTaskId: 'eval-t1',
      deps: depsWith({ artifacts: [artifact], byId: { [artifact.artifactId]: artifact } }),
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    const [failure] = resolution.context.traceFailures;
    expect(failure?.errorType).toBe('validation_failed');
    expect(failure?.actualDecision).toBe('allow');
    expect(failure?.expectedDecision).toBe('block');
  });

  it('current-shape entries: real decision mismatch keeps actualDecision; sentinels and forbidden patterns partition disjointly', async () => {
    const artifact = evaluatorArtifactWith({
      passed: false,
      failedCases: [
        { caseId: 'v2-combination', attackType: 'inversion', expectedDecision: 'block', actualDecision: 'allow', errorType: 'validation_failed', message: 'Expected block but got allow', rationale: 'r' },
        { caseId: '__compile__', attackType: 'boundary', expectedDecision: 'unknown', errorType: 'syntax_error', message: 'Unexpected token', rationale: 'r' },
        { caseId: '__forbidden_pattern__', attackType: 'boundary', expectedDecision: 'block', errorType: 'forbidden_pattern', message: 'forbidden pattern detected in rule code: require', rationale: 'r' },
      ],
    });
    const resolution = await resolveRepairReplayContext({
      sourceEvaluatorTaskId: 'eval-t1',
      deps: depsWith({ artifacts: [artifact], byId: { [artifact.artifactId]: artifact } }),
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    const { context } = resolution;
    expect(context.ran).toBe(true);
    expect(context.passed).toBe(false);
    expect(context.failedCaseCount).toBe(3);
    expect(context.traceFailures).toHaveLength(1);
    expect(context.traceFailures[0]?.caseId).toBe('v2-combination');
    expect(context.traceFailures[0]?.actualDecision).toBe('allow');
    // P2 review 2026-09-02: forbidden patterns count ONLY as global
    // violations — never double-rendered as system failures too.
    expect(context.systemFailures).toHaveLength(1);
    expect(context.systemFailures[0]?.caseId).toBe('__compile__');
    expect(context.globalViolations).toEqual(['forbidden pattern detected in rule code: require']);
    expect(context.globalViolationCount).toBe(1);
    expect(context.truncated).toBe(false);
  });
});

describe('PRI-634 PR-A: bounded stratified selection (SPEC §30 + review P1/P2 2026-09-02)', () => {
  const mk = (spec: { caseId: string; errorType: string; expected: string; actual?: string }): ReplayFailureEvidence => ({
    caseId: spec.caseId,
    errorType: spec.errorType,
    expectedDecision: spec.expected,
    ...(spec.actual !== undefined ? { actualDecision: spec.actual } : {}),
  });

  it('keeps one representative per errorType × expectedDecision group; mismatches get explicit priority', () => {
    const traceFailures = [
      mk({ caseId: 'a1', errorType: 'runtime_error', expected: 'allow' }),
      mk({ caseId: 'a2', errorType: 'runtime_error', expected: 'allow' }),
      mk({ caseId: 'b1', errorType: 'validation_failed', expected: 'allow' }),
      mk({ caseId: 'b2', errorType: 'validation_failed', expected: 'allow', actual: 'block' }),
      mk({ caseId: 'c1', errorType: 'validation_failed', expected: 'block', actual: 'allow' }),
    ];
    const { selectedTrace, truncated } = selectBoundedReplayFailures({ traceFailures, systemFailures: [], globalViolations: [], capacity: 16 });
    // Mismatch representatives first (allow-axis b2, block-axis c1), then the
    // remaining group rep (runtime_error×allow → a1), then stable fill (a2, b1).
    expect(selectedTrace.map((f) => f.caseId)).toEqual(['b2', 'c1', 'a1', 'a2', 'b1']);
    expect(truncated).toBe(false);
  });

  it('P1 review: capacity 2 keeps BOTH the expected-allow and expected-block mismatch — runtime errors cannot evict them', () => {
    const traceFailures = [
      mk({ caseId: 'r1', errorType: 'runtime_error', expected: 'allow' }),
      mk({ caseId: 'r2', errorType: 'runtime_error', expected: 'allow' }),
      mk({ caseId: 'r3', errorType: 'runtime_error', expected: 'allow' }),
      mk({ caseId: 'm1', errorType: 'validation_failed', expected: 'allow', actual: 'block' }),
      mk({ caseId: 'm2', errorType: 'validation_failed', expected: 'block', actual: 'allow' }),
    ];
    const { selectedTrace, truncated } = selectBoundedReplayFailures({ traceFailures, systemFailures: [], globalViolations: [], capacity: 2 });
    // The exact reviewer counter-example: r1 must NOT claim a slot that
    // starves m2. Both behavioral mismatches survive; raw errors fill later.
    expect(selectedTrace.map((f) => f.caseId)).toEqual(['m1', 'm2']);
    expect(truncated).toBe(true);
  });

  it('P1 review: at capacity 3 the runtime-error group representative is added after both mismatches', () => {
    const traceFailures = [
      mk({ caseId: 'r1', errorType: 'runtime_error', expected: 'allow' }),
      mk({ caseId: 'm1', errorType: 'validation_failed', expected: 'allow', actual: 'block' }),
      mk({ caseId: 'm2', errorType: 'validation_failed', expected: 'block', actual: 'allow' }),
    ];
    const { selectedTrace, truncated } = selectBoundedReplayFailures({ traceFailures, systemFailures: [], globalViolations: [], capacity: 3 });
    expect(selectedTrace.map((f) => f.caseId)).toEqual(['m1', 'm2', 'r1']);
    expect(truncated).toBe(false);
  });

  it('system failures first, then the global-violation representative — one shared budget', () => {
    const systemFailures = [mk({ caseId: '__compile__', errorType: 'syntax_error', expected: 'unknown' })];
    const traceFailures: ReplayFailureEvidence[] = Array.from({ length: 20 }, (_, i) => mk({ caseId: `t${i}`, errorType: 'runtime_error', expected: 'allow' }));
    const globalViolations = ['forbidden pattern: require', 'forbidden pattern: eval'];
    const { selectedTrace, selectedSystem, selectedGlobalViolations, truncated } = selectBoundedReplayFailures({ traceFailures, systemFailures, globalViolations, capacity: 5 });
    expect(selectedSystem.map((f) => f.caseId)).toEqual(['__compile__']);
    // One representative for the whole violation group (P2: bounded, no duplicates).
    expect(selectedGlobalViolations).toEqual(['forbidden pattern: require']);
    expect(selectedTrace).toHaveLength(3); // 5 capacity − 1 system − 1 violation
    expect(truncated).toBe(true);
  });

  it('P2 review: global violations can never bypass the capacity bound (28 violations, tiny capacity)', () => {
    const globalViolations = Array.from({ length: 28 }, (_, i) => `forbidden pattern: p${i}`);
    const { selectedGlobalViolations, truncated } = selectBoundedReplayFailures({ traceFailures: [], systemFailures: [], globalViolations, capacity: 4 });
    expect(selectedGlobalViolations).toHaveLength(4);
    expect(truncated).toBe(true);
  });

  it('truncated=true when capacity omits durable failures; default cap is 16', () => {
    expect(MAX_REPLAY_FAILURES_IN_REPAIR).toBe(16);
    const traceFailures: ReplayFailureEvidence[] = Array.from({ length: 30 }, (_, i) => mk({ caseId: `t${i}`, errorType: i % 2 === 0 ? 'runtime_error' : 'validation_failed', expected: 'allow' }));
    const { selectedTrace, truncated } = selectBoundedReplayFailures({ traceFailures, systemFailures: [], globalViolations: [], capacity: MAX_REPLAY_FAILURES_IN_REPAIR });
    expect(selectedTrace).toHaveLength(16);
    expect(truncated).toBe(true);
  });
});
