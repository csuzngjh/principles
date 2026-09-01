/**
 * EvaluatorRunner V2 vertical-slice tests — adversarial sandbox replay
 * (RuleHost MVP Activation, PRI-426, PRD Decision 11d).
 *
 * These tests pin the single-round adversarial replay contract that runs
 * inside EvaluatorRunner.succeedTask after the principle artifact is written.
 * They DO NOT exercise the multi-round orchestrator loop (Phase 7 / PRI-428).
 *
 * Scope of PRI-426:
 *   - V2 output (codeReview + adversarialCases) flows through succeedTask.
 *   - Passive review failing (any of 3 dimensions) → no adversarial replay.
 *   - Passive review passing + adversarialCases present → single
 *     evaluateRefinerRuleHostGate replay via injected gateDeps.
 *   - PRI-423 contract: the merged trace sent to the gate MUST contain ≥1
 *     positive case drawn from the Artificer golden trace. adversarialCases
 *     alone are all negative and would fail replay validation.
 *   - adversarialResult is populated; decision already reflects needs_revision
 *     when the LLM followed the passive-review short-circuit instruction.
 *
 * What is NOT in scope here (covered elsewhere):
 *   - rule artifact assembly (Phase 6 / PRI-427)
 *   - multi-round Artificer retry loop (Phase 7 / PRI-428)
 *
 * ERR considerations:
 *   - ERR-001 / ERR-005: V2 fields are detected via isEvaluatorOutputV2 after
 *     validate(); never `as`-cast.
 *   - ERR-069: every output-emitting path must emit a validated object.
 *     adversarialResult is built only from sandbox-returned failedCases with
 *     known fields; degraded paths must populate a reason, not silently skip.
 *   - ERR-018: gateDeps injection is the trust boundary — a throwing sandbox
 *     must degrade, not crash the runner.
 */
import { describe, it, expect, vi } from 'vitest';
import { EvaluatorRunner } from '../internalization/evaluator-runner.js';
import type { EvaluatorRunnerDeps } from '../internalization/evaluator-runner.js';
import type { PIArtifactStore, PIArtifactRecord } from '../internalization/pi-artifact.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { EvaluatorOutputV1, EvaluatorOutputV2 } from '../internalization/evaluator-output.js';
import { DefaultEvaluatorValidator } from '../internalization/evaluator-output.js';
import { createPITaskDiagnosticJson } from '../internalization/pitask-metadata.js';
import type { TaskRecord } from '../task-status.js';
import type { RefinerRuleHostGateDeps, RefinerRuleHostGateResult } from '../internalization/refiner-rulehost-gate.js';
import type { GoldenTrace } from '../golden-trace.js';
// PRI-427: rule artifact assembly — verify the produced artifact satisfies
// the downstream RuleHostWriter.canActivate field contract.
import { RuleHostWriter } from '../activation/writers/rule-host-writer.js';
import type { PIArtifactSnapshot } from '../activation/activation-types.js';

const ARTIFICER_TASK_ID = 'artificer-001';
const SCRIBE_TASK_ID = 'scribe-001';
const EVALUATOR_TASK_ID = 'evaluator-001';

// ── Task / artifact fixtures ──────────────────────────────────────────────────

function makeArtificerTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: ARTIFICER_TASK_ID,
    taskKind: 'artificer',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    resultRef: 'artificer://run-001',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-artificer-001-run-001' }],
    }),
    ...overrides,
  };
}

function makeEvaluatorTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: EVALUATOR_TASK_ID,
    taskKind: 'evaluator',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [ARTIFICER_TASK_ID],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-artificer-001-run-001' }],
      outputArtifactRefs: [],
    }),
    ...overrides,
  };
}

function makeScribeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: SCRIBE_TASK_ID,
    taskKind: 'scribe',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    resultRef: 'scribe://run-001',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-scribe-001' }],
    }),
    ...overrides,
  };
}

function makeScribeArtifact(): PIArtifactRecord {
  return {
    artifactId: 'pi-art-scribe-001',
    artifactKind: 'principle',
    sourceTaskId: SCRIBE_TASK_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify({
      principleDraft: {
        title: 'Always validate async input',
        statement: 'Every async function must validate its input before processing.',
      },
      generatedAt: new Date().toISOString(),
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * V1 artificer artifact (no implementationCode). Used as the "no golden trace
 * cases" degradation fixture.
 */
function makeV1ArtificerArtifact(): PIArtifactRecord {
  return {
    artifactId: 'pi-art-artificer-001-run-001',
    artifactKind: 'principle',
    sourceTaskId: ARTIFICER_TASK_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify({
      taskId: ARTIFICER_TASK_ID,
      sourceScribeArtifactId: 'pi-art-scribe-001',
      implementationPlan: {
        summary: 'Add input validation to all async operations',
        targetSurface: 'src/async-ops/*.ts',
        changes: ['Add try-catch to asyncOp1'],
        tests: ['Unit test for asyncOp1 error handling'],
        rolloutNotes: ['Deploy behind feature flag'],
        confidence: 0.85,
      },
      sourceTrace: { scribeArtifactId: 'pi-art-scribe-001' },
      risks: [],
      generatedAt: new Date().toISOString(),
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * V2 artificer artifact: implementationCode + goldenTraceCases (1 pos + 1 neg).
 * The positive case is what PRI-426 merges into the adversarial trace.
 */
function makeV2ArtificerArtifact(): PIArtifactRecord {
  return {
    artifactId: 'pi-art-artificer-001-run-001',
    artifactKind: 'principle',
    sourceTaskId: ARTIFICER_TASK_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify({
      taskId: ARTIFICER_TASK_ID,
      sourceScribeArtifactId: 'pi-art-scribe-001',
      implementationPlan: {
        summary: 'Add input validation to all async operations',
        targetSurface: 'src/async-ops/*.ts',
        changes: ['Add try-catch to asyncOp1'],
        tests: ['Unit test for asyncOp1 error handling'],
        rolloutNotes: ['Deploy behind feature flag'],
        confidence: 0.85,
      },
      // V2 fields:
      implementationCode: 'function evaluate(input, helpers) { return { decision: "allow", matched: true, reason: "ok" }; }',
      goldenTraceCases: [
        {
          caseId: 'artificer-positive-1',
          kind: 'positive',
          toolName: 'write_file',
          params: { path: '/safe/path.txt' },
          expectedDecision: 'allow',
        },
        {
          caseId: 'artificer-negative-1',
          kind: 'negative',
          toolName: 'write_file',
          params: { path: '/etc/passwd' },
          expectedDecision: 'block',
        },
      ],
      affectedTools: ['write_file'],
      sourceTrace: { scribeArtifactId: 'pi-art-scribe-001' },
      risks: [],
      generatedAt: new Date().toISOString(),
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeRuleContextV2ArtificerArtifact(): PIArtifactRecord {
  const artifact = makeV2ArtificerArtifact();
  const parsed = JSON.parse(artifact.contentJson) as Record<string, unknown>;
  const cases = parsed.goldenTraceCases;
  if (!Array.isArray(cases)) throw new Error('fixture goldenTraceCases must be an array');
  const ruleContext = {
    version: 2,
    history: { status: 'available', truncated: false, calls: [] },
    facts: {
      priorReadOfTarget: 'no',
      readCount: 0,
      writeCount: 0,
      uniqueWritePathCount: 0,
      sameActionBlockCount: null,
    },
  };
  for (const traceCase of cases) {
    if (typeof traceCase !== 'object' || traceCase === null || Array.isArray(traceCase)) {
      throw new Error('fixture case must be an object');
    }
    traceCase.ruleContext = ruleContext;
  }
  parsed.requiresContextVersion = 2;
  // PRI-490: v2 artifacts must carry evidenceRefs preserved from
  // BehaviorExamplePack. The fixture includes them so downstream tests
  // can verify the evaluator preserves them into the assembled rule artifact.
  parsed.evidenceRefs = ['pain:1', 'tool_call:abc'];
  return { ...artifact, contentJson: JSON.stringify(parsed) };
}

// ── Evaluator V2 output fixtures ──────────────────────────────────────────────

function makePassingCodeReview() {
  return {
    intentConsistency: { aligned: true, explanation: 'Code matches principle intent.' },
    scopePrecision: { verdict: 'precise' as const, explanation: 'Matcher is exact.' },
    traceCoverage: { sufficient: true, gaps: [], explanation: 'Covers both cases.' },
  };
}

function makeAdversarialCases() {
  // 3 attack types: boundary / omission / inversion — all negative expectation.
  return [
    {
      caseId: 'adv-boundary-1',
      attackType: 'boundary' as const,
      toolName: 'write_file',
      params: { path: '/safe/../etc/passwd' },
      expectedDecision: 'block' as const,
      rationale: 'Path traversal at the boundary of the matcher.',
    },
    {
      caseId: 'adv-omission-1',
      attackType: 'omission' as const,
      toolName: 'write_file',
      params: { path: '' },
      expectedDecision: 'block' as const,
      rationale: 'Empty path the matcher may have skipped.',
    },
    {
      caseId: 'adv-inversion-1',
      attackType: 'inversion' as const,
      toolName: 'write_file',
      params: { path: '/safe/path.txt' },
      expectedDecision: 'block' as const,
      rationale: 'Inverted positive case to check false-negative.',
    },
  ];
}

function makeEvaluatorV2Output(overrides: Partial<EvaluatorOutputV2> = {}): EvaluatorOutputV2 {
  return {
    taskId: EVALUATOR_TASK_ID,
    sourceArtificerArtifactId: 'pi-art-artificer-001-run-001',
    evaluation: {
      decision: 'approved',
      summary: 'Code review passed and adversarial replay passed.',
      score: 0.9,
      strengths: ['Clear matcher', 'Good coverage'],
      concerns: [],
      requiredChanges: [],
    },
    sourceTrace: {
      artificerArtifactId: 'pi-art-artificer-001-run-001',
      scribeArtifactId: 'pi-art-scribe-001',
    },
    risks: [],
    generatedAt: new Date().toISOString(),
    codeReview: makePassingCodeReview(),
    adversarialCases: makeAdversarialCases(),
    ...overrides,
  };
}

// ── Mock deps factory ──────────────────────────────────────────────────────────

interface CreateMockDepsOptions {
  readonly artifactStore?: PIArtifactStore;
  readonly output?: EvaluatorOutputV1;
}

function createMockDeps(options: CreateMockDepsOptions = {}): EvaluatorRunnerDeps {
  const artifactStore = options.artifactStore ?? new MemoryPIArtifactStore();
  const evaluatorTask = makeEvaluatorTask();
  const artificerTask = makeArtificerTask();
  const scribeTask = makeScribeTask();

  const stateManager = {
    acquireLease: vi.fn().mockResolvedValue(evaluatorTask),
    getTask: vi.fn().mockImplementation((id: string) => {
      if (id === EVALUATOR_TASK_ID) return Promise.resolve(evaluatorTask);
      if (id === ARTIFICER_TASK_ID) return Promise.resolve(artificerTask);
      if (id === SCRIBE_TASK_ID) return Promise.resolve(scribeTask);
      return Promise.resolve(null);
    }),
    getRunsByTask: vi.fn().mockResolvedValue([{
      runId: 'run-evaluator-001',
      taskId: EVALUATOR_TASK_ID,
      runtimeKind: 'evaluator',
      startedAt: new Date().toISOString(),
    }]),
    getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
      runs: [{ runId: 'run-evaluator-001', taskId: EVALUATOR_TASK_ID, runtimeKind: 'evaluator', startedAt: new Date().toISOString() }],
      degradedRuns: [],
    }),
    updateRunOutput: vi.fn().mockResolvedValue(undefined),
    markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
      updateTaskDiagnosticJson: vi.fn().mockResolvedValue(undefined), // P0-3: runner verdict 前置写入
    markTaskFailed: vi.fn().mockResolvedValue(undefined),
    markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
    getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
  } as unknown as RuntimeStateManager;

  const runHandle: RunHandle = { runId: 'run-evaluator-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
  const succeededStatus: RunStatus = { status: 'succeeded', runId: 'run-evaluator-001' };

  const runtimeAdapter = {
    startRun: vi.fn().mockResolvedValue(runHandle),
    pollRun: vi.fn().mockResolvedValue(succeededStatus),
    fetchOutput: vi.fn().mockResolvedValue({
      payload: options.output ?? makeEvaluatorV2Output(),
    }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as PDRuntimeAdapter;

  const eventEmitter = {
    emitTelemetry: vi.fn(),
  } as unknown as StoreEventEmitter;

  const validator = new DefaultEvaluatorValidator();

  const deps: EvaluatorRunnerDeps = {
    stateManager,
    runtimeAdapter,
    eventEmitter,
    validator,
    artifactStore,
  };
  return deps;
}

/** Build a runner, wiring gateDeps through the constructor options (PRI-426). */
function makeRunner(deps: EvaluatorRunnerDeps, gateDeps?: RefinerRuleHostGateDeps): EvaluatorRunner {
  return new EvaluatorRunner(deps, {
    owner: 'test',
    runtimeKind: 'evaluator',
    pollIntervalMs: 10,
    timeoutMs: 1000,
    gateDeps,
  });
}

// ── Helpers for inspecting the trace the gate received ────────────────────────

function makeRecordingGate(
  capture: { trace?: GoldenTrace; code?: string },
  result: RefinerRuleHostGateResult,
): RefinerRuleHostGateDeps {
  return {
    evaluateInSandbox: (code, goldenTrace) => {
      capture.code = code;
      capture.trace = goldenTrace;
      return result.sandboxResult;
    },
  };
}

function sandboxResultSuccess() {
  return { success: true, failedCases: [], executionTimeMs: 5, forbiddenPatternViolations: [] };
}

function sandboxResultValidationFailed(caseIds: readonly string[]) {
  return {
    success: false,
    failedCases: caseIds.map((caseId) => ({
      caseId,
      errorType: 'validation_failed' as const,
      message: `case ${caseId} produced the wrong decision`,
    })),
    executionTimeMs: 5,
    forbiddenPatternViolations: [],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EvaluatorRunner V2 — adversarial sandbox replay (PRI-426)', () => {
  it('V1 output (no codeReview) does not invoke adversarial replay', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeV1ArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());

    const gateSpy = vi.fn(() => sandboxResultSuccess());
    const gateDeps: RefinerRuleHostGateDeps = { evaluateInSandbox: gateSpy };
    const deps = createMockDeps({ artifactStore: store });

    // V1 output: no codeReview, no adversarialCases
    const v1Output: EvaluatorOutputV1 = {
      taskId: EVALUATOR_TASK_ID,
      sourceArtificerArtifactId: 'pi-art-artificer-001-run-001',
      evaluation: {
        decision: 'approved',
        summary: 'V1 plan approved.',
        score: 0.8,
        strengths: [],
        concerns: [],
        requiredChanges: [],
      },
      sourceTrace: {
        artificerArtifactId: 'pi-art-artificer-001-run-001',
        scribeArtifactId: 'pi-art-scribe-001',
      },
      risks: [],
      generatedAt: new Date().toISOString(),
    };
    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({ payload: v1Output });

    const runner = makeRunner(deps, gateDeps);
    const result = await runner.run(EVALUATOR_TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(gateSpy).not.toHaveBeenCalled();
  });

  it('V2 output with failing passive review (intentConsistency) runs DIAGNOSTIC adversarial replay, verdict stays needs_revision', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeV2ArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());

    const gateSpy = vi.fn(() => sandboxResultSuccess());
    const gateDeps: RefinerRuleHostGateDeps = { evaluateInSandbox: gateSpy };

    // Passive review fails on intentConsistency — LLM short-circuits and emits
    // decision=needs_revision (per prompt instruction). PRI-634 R4 changes the
    // contract: for code-bearing artifacts, the adversarial replay STILL runs
    // as a DIAGNOSTIC check — the result is recorded as evidence while the
    // verdict stays needs_revision (no override, no rule assembly).
    const output = makeEvaluatorV2Output({
      evaluation: {
        decision: 'needs_revision',
        summary: 'intent mismatch',
        score: 0.4,
        strengths: [],
        concerns: ['code does not match principle'],
        requiredChanges: ['Rewrite matcher'],
      },
      codeReview: {
        intentConsistency: { aligned: false, explanation: 'Matcher allows unsafe paths.' },
        scopePrecision: { verdict: 'precise', explanation: 'ok' },
        traceCoverage: { sufficient: true, gaps: [], explanation: 'ok' },
      },
    });
    const deps = createMockDeps({ artifactStore: store, output });

    const runner = makeRunner(deps, gateDeps);
    const result = await runner.run(EVALUATOR_TASK_ID);

    // R4 (P1-1): diagnostic replay MUST run for code-bearing + needs_revision
    expect(result.status).toBe('succeeded');
    expect(gateSpy).toHaveBeenCalled(); // P1-1: the gate actually runs
    // Verdict stays needs_revision (no override — R4 diagnostic contract):
    // the runner completed with needs_revision (not forced to approved).
    expect((deps.stateManager.markTaskSucceeded as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    // The artifact carries adversarialResult populated by the diagnostic replay
    // (canonical envelope, P1-3). No rule artifact is assembled because the
    // verdict is not approved.
    const artifacts = await store.listBySourceTaskId(EVALUATOR_TASK_ID);
    const principle = artifacts.find((a) => a.artifactKind === 'principle');
    expect(principle).toBeDefined();
    if (!principle) return;
    const parsed = JSON.parse(principle.contentJson) as {
      evaluation?: { decision?: string };
      adversarialResult?: { passed?: boolean };
    };
    expect(parsed.evaluation?.decision).toBe('needs_revision');
    // diagnostic replay ran and populated adversarialResult
    expect(parsed.adversarialResult).toBeDefined();
    // no rule artifact assembled (verdict is not approved)
    const rules = artifacts.filter((a) => a.artifactKind === 'rule');
    expect(rules).toHaveLength(0);
  });

  it('V2 output: passive review passes + adversarial sandbox PASSES → adversarialResult.passed=true', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeV2ArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());

    const capture: { trace?: GoldenTrace; code?: string } = {};
    const gateDeps = makeRecordingGate(capture, {
      decision: 'accepted_shadow',
      applicationMode: 'shadow',
      sandboxResult: sandboxResultSuccess(),
      reasons: [],
    });
    const deps = createMockDeps({ artifactStore: store });

    const runner = makeRunner(deps, gateDeps);
    const result = await runner.run(EVALUATOR_TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(result.output).toBeDefined();
    const v2 = result.output as EvaluatorOutputV2;
    expect(v2.adversarialResult).toBeDefined();
    expect(v2.adversarialResult?.passed).toBe(true);
    expect(v2.adversarialResult?.failedCases).toHaveLength(0);
    const persistedOutputs = (deps.stateManager.updateRunOutput as ReturnType<typeof vi.fn>).mock.calls;
    expect(persistedOutputs).toHaveLength(2);
    expect(JSON.parse(persistedOutputs[1]?.[1] as string)).toMatchObject({
      adversarialResult: { passed: true, failedCases: [] },
    });
  });

  it('adversarial replay telemetry uses the actual runtime runId', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeV1ArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());
    const deps = createMockDeps({ artifactStore: store });

    await makeRunner(deps, makeRecordingGate({}, {
      decision: 'accepted_shadow',
      applicationMode: 'shadow',
      sandboxResult: sandboxResultSuccess(),
      reasons: [],
    })).run(EVALUATOR_TASK_ID);

    const skipped = (deps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0] as { eventType: string; payload: Record<string, unknown> })
      .find((event) => event.eventType === 'evaluator_adversarial_replay_skipped');
    expect(skipped?.payload.runId).toBe('run-evaluator-001');
  });

  it('PRI-423 contract: merged trace sent to gate contains ≥1 positive case from Artificer', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeV2ArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());

    const capture: { trace?: GoldenTrace; code?: string } = {};
    const gateDeps = makeRecordingGate(capture, {
      decision: 'accepted_shadow',
      applicationMode: 'shadow',
      sandboxResult: sandboxResultSuccess(),
      reasons: [],
    });
    const deps = createMockDeps({ artifactStore: store });

    const runner = makeRunner(deps, gateDeps);
    await runner.run(EVALUATOR_TASK_ID);

    expect(capture.trace).toBeDefined();
    // capture.trace is narrowed to GoldenTrace by the assertion above.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const { cases } = capture.trace!;
    // PRI-423: adversarial cases are all negative. Without merging the Artificer
    // positive case, the gate would receive 0 positives and the trace would
    // fail validateGoldenTrace(). The runner must merge in the positive case.
    const positives = cases.filter((c) => c.kind === 'positive');
    expect(positives.length).toBeGreaterThanOrEqual(1);
    // All adversarial cases preserved as negative. PRI-485 Phase 6: the runner
    // now auto-generates 5 v2 adversarial cases (unavailable/truncation/alias/
    // path/combination) and prepends them to the LLM-supplied 3 adversarial
    // cases, so the merged trace carries 8 negative cases total.
    const negatives = cases.filter((c) => c.kind === 'negative');
    expect(negatives.length).toBe(8);
    // PRI-485: the 5 v2 caseIds must be present in the merged trace.
    const v2CaseIds = ['v2-unavailable', 'v2-truncated', 'v2-alias', 'v2-path-boundary', 'v2-combination'];
    for (const id of v2CaseIds) {
      expect(negatives.find((c) => c.caseId === id), `v2 case ${id} missing`).toBeDefined();
    }
    // PRI-485: each v2 case must carry a ruleContext for the sandbox.
    for (const id of v2CaseIds) {
      const v2Case = negatives.find((c) => c.caseId === id);
      expect(v2Case?.ruleContext, `v2 case ${id} missing ruleContext`).toBeDefined();
    }
  });

  it('PRI-485 Phase 6: v2 cases skipped when artificer is V1 (no affectedTools/goldenTraceCases)', async () => {
    // V1 artificer has no implementationCode → runAdversarialReplay degrades
    // before v2 case generation. Existing behavior unchanged.
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeV1ArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());

    const capture: { trace?: GoldenTrace; code?: string } = {};
    const gateDeps = makeRecordingGate(capture, {
      decision: 'accepted_shadow',
      applicationMode: 'shadow',
      sandboxResult: sandboxResultSuccess(),
      reasons: [],
    });
    const deps = createMockDeps({ artifactStore: store });

    const runner = makeRunner(deps, gateDeps);
    await runner.run(EVALUATOR_TASK_ID);

    // V1 artificer → no implementationCode → replay skipped → no trace captured.
    expect(capture.trace).toBeUndefined();
  });

  it('PRI-485 Phase 6: v2 cases skipped when canonicalKind is non-write (read tool)', async () => {
    // CodeRabbit PR #1102: the 5 v2 templates are write-path semantics.
    // Generating them for a read/search/execute tool produces mismatched
    // negative cases. The runner must skip v2 generation and emit telemetry.
    const store = new MemoryPIArtifactStore();
    // Override the artificer artifact to use a read tool.
    const readToolArtifact: PIArtifactRecord = {
      ...makeV2ArtificerArtifact(),
      contentJson: JSON.stringify({
        ...JSON.parse(makeV2ArtificerArtifact().contentJson),
        goldenTraceCases: [
          { caseId: 'pos-1', kind: 'positive', toolName: 'read_file', params: { path: '/safe/read.txt' }, expectedDecision: 'allow' },
          { caseId: 'neg-1', kind: 'negative', toolName: 'read_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
        ],
        affectedTools: ['read_file'],
      }),
    };
    await store.upsertArtifact(readToolArtifact);
    await store.upsertArtifact(makeScribeArtifact());

    const capture: { trace?: GoldenTrace; code?: string } = {};
    const gateDeps = makeRecordingGate(capture, {
      decision: 'accepted_shadow',
      applicationMode: 'shadow',
      sandboxResult: sandboxResultSuccess(),
      reasons: [],
    });
    const deps = createMockDeps({ artifactStore: store });

    const runner = makeRunner(deps, gateDeps);
    await runner.run(EVALUATOR_TASK_ID);

    // Trace captured (LLM cases still run), but v2 caseIds must be absent.
    expect(capture.trace).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const negatives = capture.trace!.cases.filter((c) => c.kind === 'negative');
    // Only the 3 LLM-supplied adversarial cases — no v2 cases.
    expect(negatives.length).toBe(3);
    const v2CaseIds = ['v2-unavailable', 'v2-truncated', 'v2-alias', 'v2-path-boundary', 'v2-combination'];
    for (const id of v2CaseIds) {
      expect(negatives.find((c) => c.caseId === id), `v2 case ${id} should be absent for non-write tool`).toBeUndefined();
    }
    // Telemetry emitted for the skip (rc-9).
    const skipEvent = (deps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => call[0] as { eventType: string; payload: Record<string, unknown> })
      .find((event) => event.eventType === 'evaluator_v2_adversarial_cases_skipped');
    expect(skipEvent?.payload.reason).toBe('non_write_canonical_kind_for_v2_adversarial_cases');
    expect(skipEvent?.payload.canonicalKind).toBe('read');
  });

  it('V2 output: adversarial sandbox FAILS (validation_failed) → adversarialResult.passed=false + failedCases', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeV2ArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());

    const failingCaseIds = ['adv-boundary-1', 'adv-inversion-1'];
    const gateDeps = makeRecordingGate({}, {
      decision: 'rejected_validation_failed',
      applicationMode: 'shadow',
      sandboxResult: sandboxResultValidationFailed(failingCaseIds),
      reasons: ['2 cases failed validation'],
    });
    const deps = createMockDeps({ artifactStore: store });

    const runner = makeRunner(deps, gateDeps);
    const result = await runner.run(EVALUATOR_TASK_ID);

    expect(result.status).toBe('succeeded');
    const v2 = result.output as EvaluatorOutputV2;
    expect(v2.adversarialResult).toBeDefined();
    expect(v2.adversarialResult?.passed).toBe(false);
    expect(v2.adversarialResult?.failedCases.length).toBe(2);
    const failedIds = v2.adversarialResult?.failedCases.map((c) => c.caseId);
    expect(failedIds).toEqual(expect.arrayContaining(failingCaseIds));
  });

  it('V2 output: sandbox adapter THROWS → degrade with passed=false, runner does not crash (ERR-018)', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeV2ArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());

    const gateDeps: RefinerRuleHostGateDeps = {
      evaluateInSandbox: () => {
        throw new Error('sandbox VM crashed');
      },
    };
    const deps = createMockDeps({ artifactStore: store });

    const runner = makeRunner(deps, gateDeps);
    const result = await runner.run(EVALUATOR_TASK_ID);

    expect(result.status).toBe('succeeded');
    const v2 = result.output as EvaluatorOutputV2;
    expect(v2.adversarialResult).toBeDefined();
    expect(v2.adversarialResult?.passed).toBe(false);
  });

  it('V2 output but Artificer artifact has no goldenTraceCases → degrade: skip replay with telemetry', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeV1ArtificerArtifact()); // V1 artificer, no golden trace
    await store.upsertArtifact(makeScribeArtifact());

    const gateSpy = vi.fn(() => sandboxResultSuccess());
    const gateDeps: RefinerRuleHostGateDeps = { evaluateInSandbox: gateSpy };

    // Mismatched: evaluator emits V2 (codeReview + adversarialCases) but the
    // artificer artifact in store is V1 (no goldenTraceCases). The runner must
    // degrade gracefully — no positive case to merge → skip replay + emit
    // telemetry with a reason, not crash.
    const deps = createMockDeps({ artifactStore: store });

    const runner = makeRunner(deps, gateDeps);
    const result = await runner.run(EVALUATOR_TASK_ID);

    expect(result.status).toBe('succeeded');
    expect(gateSpy).not.toHaveBeenCalled();

    const events = (deps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as { eventType: string; payload: Record<string, unknown> },
    );
    const degraded = events.find((e) => e.eventType === 'evaluator_adversarial_replay_skipped');
    expect(degraded).toBeDefined();
    expect(typeof degraded?.payload?.reason).toBe('string');
  });

  it('emits evaluator_adversarial_replay telemetry with gate decision on each replay', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeV2ArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());

    const gateDeps = makeRecordingGate({}, {
      decision: 'accepted_shadow',
      applicationMode: 'shadow',
      sandboxResult: sandboxResultSuccess(),
      reasons: [],
    });
    const deps = createMockDeps({ artifactStore: store });

    const runner = makeRunner(deps, gateDeps);
    await runner.run(EVALUATOR_TASK_ID);

    const events = (deps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as { eventType: string; payload: Record<string, unknown> },
    );
    const replayEvent = events.find((e) => e.eventType === 'evaluator_adversarial_replay');
    expect(replayEvent).toBeDefined();
    expect(replayEvent?.payload?.gateDecision).toBe('accepted_shadow');
  });
});

// ── PRI-427: rule artifact assembly tests ────────────────────────────────────

/**
 * Convert a PIArtifactRecord into the snapshot shape RuleHostWriter.canActivate
 * reads. We don't activate (that needs the full ActivationContext); we only
 * verify the artifact PASSES the canActivate field checks up to the gate.
 */
function toSnapshot(record: PIArtifactRecord): PIArtifactSnapshot {
  return {
    artifactId: record.artifactId,
    artifactKind: record.artifactKind,
    sourceTaskId: record.sourceTaskId,
    sourceRuleId: record.sourceRuleId,
    lineageArtifactIds: record.lineageArtifactIds,
    validationStatus: record.validationStatus,
    contentJson: record.contentJson,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

describe('EvaluatorRunner V2 — rule artifact assembly (PRI-427)', () => {
  it('adversarialResult.passed=true → writes rule artifact with artifactKind=rule + validated', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeV2ArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());

    const gateDeps = makeRecordingGate({}, {
      decision: 'accepted_shadow',
      applicationMode: 'shadow',
      sandboxResult: sandboxResultSuccess(),
      reasons: [],
    });
    const deps = createMockDeps({ artifactStore: store });

    const runner = makeRunner(deps, gateDeps);
    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('succeeded');

    // Evaluator task produces: 1 principle artifact + 1 rule artifact.
    const artifacts = await store.listBySourceTaskId(EVALUATOR_TASK_ID);
    const ruleArtifacts = artifacts.filter((a) => a.artifactKind === 'rule');
    expect(ruleArtifacts.length).toBe(1);
    // length asserted above.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const ruleArtifact = ruleArtifacts[0]!;
    expect(ruleArtifact.validationStatus).toBe('validated');
  });


  it('approved V2 output without principle lineage does not produce a rule artifact', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeV2ArtificerArtifact());
    const gateDeps = makeRecordingGate({}, {
      decision: 'accepted_shadow',
      applicationMode: 'shadow',
      sandboxResult: sandboxResultSuccess(),
      reasons: [],
    });
    const deps = createMockDeps({ artifactStore: store });
    const runner = makeRunner(deps, gateDeps);
    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('succeeded');

    const artifacts = await store.listBySourceTaskId(EVALUATOR_TASK_ID);
    expect(artifacts.filter((artifact) => artifact.artifactKind === 'rule')).toHaveLength(0);
  });
  it('rule artifact contentJson carries implementationCode + goldenTrace + ruleHostGateDecision + affectedTools', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeV2ArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());

    const gateDeps = makeRecordingGate({}, {
      decision: 'accepted_shadow',
      applicationMode: 'shadow',
      sandboxResult: sandboxResultSuccess(),
      reasons: [],
    });
    const deps = createMockDeps({ artifactStore: store });

    const runner = makeRunner(deps, gateDeps);
    await runner.run(EVALUATOR_TASK_ID);

    const artifacts = await store.listBySourceTaskId(EVALUATOR_TASK_ID);
    const ruleArtifact = artifacts.find((a) => a.artifactKind === 'rule');
    expect(ruleArtifact).toBeDefined();
    // ruleArtifact is asserted defined above.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const parsed = JSON.parse(ruleArtifact!.contentJson) as Record<string, unknown>;

    expect(typeof parsed.implementationCode).toBe('string');
    expect((parsed.implementationCode as string).length).toBeGreaterThan(0);
    expect(parsed.goldenTrace).toBeDefined();
    expect(typeof (parsed.goldenTrace as { traceId: string }).traceId).toBe('string');
    expect(Array.isArray((parsed.goldenTrace as { cases: unknown[] }).cases)).toBe(true);
    expect((parsed.goldenTrace as { cases: unknown[] }).cases.length).toBeGreaterThan(0);
    expect(parsed.ruleHostGateDecision).toBe('accepted_shadow');
    expect(Array.isArray(parsed.affectedTools)).toBe(true);
  });

  it('preserves requiresContextVersion in the assembled rule artifact', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeRuleContextV2ArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());
    const gateDeps = makeRecordingGate({}, {
      decision: 'accepted_shadow',
      applicationMode: 'shadow',
      sandboxResult: sandboxResultSuccess(),
      reasons: [],
    });
    const runner = makeRunner(createMockDeps({ artifactStore: store }), gateDeps);

    await runner.run(EVALUATOR_TASK_ID);

    const artifacts = await store.listBySourceTaskId(EVALUATOR_TASK_ID);
    const ruleArtifact = artifacts.find((artifact) => artifact.artifactKind === 'rule');
    expect(ruleArtifact).toBeDefined();
    const parsed: unknown = JSON.parse(ruleArtifact?.contentJson ?? 'null');
    expect(parsed).toEqual(expect.objectContaining({ requiresContextVersion: 2 }));
  });

  // PRI-490: the evaluator must preserve evidenceRefs from the Artificer
  // artifact into the assembled rule artifact. This is a stated acceptance
  // criterion: "Evaluator assembled rule artifact contains
  // requiresContextVersion: 2 and evidenceRefs".
  it('preserves evidenceRefs in the assembled rule artifact (PRI-490)', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeRuleContextV2ArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());
    const gateDeps = makeRecordingGate({}, {
      decision: 'accepted_shadow',
      applicationMode: 'shadow',
      sandboxResult: sandboxResultSuccess(),
      reasons: [],
    });
    const runner = makeRunner(createMockDeps({ artifactStore: store }), gateDeps);

    await runner.run(EVALUATOR_TASK_ID);

    const artifacts = await store.listBySourceTaskId(EVALUATOR_TASK_ID);
    const ruleArtifact = artifacts.find((artifact) => artifact.artifactKind === 'rule');
    expect(ruleArtifact).toBeDefined();
    const parsed = JSON.parse(ruleArtifact?.contentJson ?? 'null') as Record<string, unknown>;
    expect(parsed.requiresContextVersion).toBe(2);
    expect(Array.isArray(parsed.evidenceRefs)).toBe(true);
    expect(parsed.evidenceRefs).toEqual(['pain:1', 'tool_call:abc']);
  });

  it('rule artifact goldenTrace is the Artificer full trace (pos+neg), NOT the adversarial-only trace', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeV2ArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());

    const gateDeps = makeRecordingGate({}, {
      decision: 'accepted_shadow',
      applicationMode: 'shadow',
      sandboxResult: sandboxResultSuccess(),
      reasons: [],
    });
    const deps = createMockDeps({ artifactStore: store });

    const runner = makeRunner(deps, gateDeps);
    await runner.run(EVALUATOR_TASK_ID);

    const artifacts = await store.listBySourceTaskId(EVALUATOR_TASK_ID);
    const ruleArtifact = artifacts.find((a) => a.artifactKind === 'rule');
    expect(ruleArtifact).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const parsed = JSON.parse(ruleArtifact!.contentJson) as { goldenTrace: { cases: { kind: string; caseId: string }[] } };

    // The Artificer fixture has exactly: 1 positive + 1 negative case. The
    // rule artifact must carry BOTH (the production trace for enforcement),
    // not the adversarial replay trace (which had 3 negative cases).
    const positives = parsed.goldenTrace.cases.filter((c) => c.kind === 'positive');
    const negatives = parsed.goldenTrace.cases.filter((c) => c.kind === 'negative');
    expect(positives.length).toBe(1);
    expect(negatives.length).toBe(1);
    // Should NOT contain adversarial caseIds.
    const caseIds = parsed.goldenTrace.cases.map((c) => c.caseId);
    expect(caseIds).not.toContain('adv-boundary-1');
  });

  it('adversarialResult.passed=false → does NOT write rule artifact (principle artifact only)', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeV2ArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());

    const failingCaseIds = ['adv-boundary-1'];
    const gateDeps = makeRecordingGate({}, {
      decision: 'rejected_validation_failed',
      applicationMode: 'shadow',
      sandboxResult: sandboxResultValidationFailed(failingCaseIds),
      reasons: ['validation failed'],
    });
    const deps = createMockDeps({ artifactStore: store });

    const runner = makeRunner(deps, gateDeps);
    const result = await runner.run(EVALUATOR_TASK_ID);
    expect(result.status).toBe('succeeded');

    const artifacts = await store.listBySourceTaskId(EVALUATOR_TASK_ID);
    const ruleArtifacts = artifacts.filter((a) => a.artifactKind === 'rule');
    expect(ruleArtifacts.length).toBe(0);
    // Principle artifact is still present (prompt-channel fallback).
    const principleArtifacts = artifacts.filter((a) => a.artifactKind === 'principle');
    expect(principleArtifacts.length).toBe(1);
  });

  it('V1 output (no codeReview) → no rule artifact written', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeV1ArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());

    const gateDeps: RefinerRuleHostGateDeps = { evaluateInSandbox: vi.fn(() => sandboxResultSuccess()) };
    const deps = createMockDeps({ artifactStore: store });

    const v1Output: EvaluatorOutputV1 = {
      taskId: EVALUATOR_TASK_ID,
      sourceArtificerArtifactId: 'pi-art-artificer-001-run-001',
      evaluation: {
        decision: 'approved',
        summary: 'V1 plan approved.',
        score: 0.8,
        strengths: [],
        concerns: [],
        requiredChanges: [],
      },
      sourceTrace: {
        artificerArtifactId: 'pi-art-artificer-001-run-001',
        scribeArtifactId: 'pi-art-scribe-001',
      },
      risks: [],
      generatedAt: new Date().toISOString(),
    };
    (deps.runtimeAdapter as unknown as Record<string, unknown>).fetchOutput = vi.fn().mockResolvedValue({ payload: v1Output });

    const runner = makeRunner(deps, gateDeps);
    await runner.run(EVALUATOR_TASK_ID);

    const artifacts = await store.listBySourceTaskId(EVALUATOR_TASK_ID);
    const ruleArtifacts = artifacts.filter((a) => a.artifactKind === 'rule');
    expect(ruleArtifacts.length).toBe(0);
  });

  it('rule artifact write failure does NOT crash the runner; principle artifact remains (degradation)', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeV2ArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());

    // Wrap the store: allow principle artifact upsert + the adversarial re-
    // persist, but make the SECOND upsert for artifactKind='rule' throw.
    const realStore = store;
    let _upsertCallCount = 0;
    const failingStore = {
      ...realStore,
      upsertArtifact: vi.fn(async (record: PIArtifactRecord) => {
        _upsertCallCount += 1;
        // The rule artifact is written AFTER the principle artifact + the
        // adversarial re-persist. It carries artifactKind='rule'.
        if (record.artifactKind === 'rule') {
          throw new Error('simulated rule artifact write failure');
        }
        return realStore.upsertArtifact(record);
      }),
      getArtifactById: realStore.getArtifactById.bind(realStore),
      listBySourceTaskId: realStore.listBySourceTaskId.bind(realStore),
      updateValidationStatus: realStore.updateValidationStatus.bind(realStore),
      createArtifact: realStore.createArtifact.bind(realStore),
      listLineage: realStore.listLineage.bind(realStore),
    } as unknown as MemoryPIArtifactStore;

    const gateDeps = makeRecordingGate({}, {
      decision: 'accepted_shadow',
      applicationMode: 'shadow',
      sandboxResult: sandboxResultSuccess(),
      reasons: [],
    });
    const deps = createMockDeps({ artifactStore: failingStore });

    const runner = makeRunner(deps, gateDeps);
    const result = await runner.run(EVALUATOR_TASK_ID);

    // PRD Decision 5 degradation: assembly failure → principle artifact still
    // written, prompt channel usable. Runner does NOT crash.
    expect(result.status).toBe('succeeded');

    const artifacts = await realStore.listBySourceTaskId(EVALUATOR_TASK_ID);
    const principleArtifacts = artifacts.filter((a) => a.artifactKind === 'principle');
    expect(principleArtifacts.length).toBe(1);
    const ruleArtifacts = artifacts.filter((a) => a.artifactKind === 'rule');
    expect(ruleArtifacts.length).toBe(0);

    // Telemetry must record the assembly failure with a reason.
    const events = (deps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as { eventType: string; payload: Record<string, unknown> },
    );
    const asmFail = events.find((e) => e.eventType === 'evaluator_rule_assembly_failed');
    expect(asmFail).toBeDefined();
    expect(typeof asmFail?.payload?.reason).toBe('string');
  });

  it('produced rule artifact passes RuleHostWriter.canActivate field checks', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeV2ArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());

    const gateDeps = makeRecordingGate({}, {
      decision: 'accepted_shadow',
      applicationMode: 'shadow',
      sandboxResult: sandboxResultSuccess(),
      reasons: [],
    });
    const deps = createMockDeps({ artifactStore: store });

    const runner = makeRunner(deps, gateDeps);
    await runner.run(EVALUATOR_TASK_ID);

    const artifacts = await store.listBySourceTaskId(EVALUATOR_TASK_ID);
    const ruleArtifact = artifacts.find((a) => a.artifactKind === 'rule');
    expect(ruleArtifact).toBeDefined();
    // ruleArtifact is asserted defined above.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const ruleArtifactRecord = ruleArtifact!;

    // RuleHostWriter.canActivate re-runs the gate; reuse the same gateDeps so
    // the gate decision is consistent. The artifact must pass the kind/
    // validationStatus/implementationCode/goldenTrace/ruleHostGateDecision
    // checks AND the gate's own replay.
    const writer = new RuleHostWriter({ gateDeps });
    const snapshot = toSnapshot(ruleArtifactRecord);
    const canActivateResult = await writer.canActivate(snapshot);
    // canActivate returns { ok: true, riskLevel } when all field checks pass
    // AND the gate re-replay accepts.
    expect(canActivateResult.ok).toBe(true);
  });

  it('emits evaluator_rule_assembled telemetry on successful rule artifact write', async () => {
    const store = new MemoryPIArtifactStore();
    await store.upsertArtifact(makeV2ArtificerArtifact());
    await store.upsertArtifact(makeScribeArtifact());

    const gateDeps = makeRecordingGate({}, {
      decision: 'accepted_shadow',
      applicationMode: 'shadow',
      sandboxResult: sandboxResultSuccess(),
      reasons: [],
    });
    const deps = createMockDeps({ artifactStore: store });

    const runner = makeRunner(deps, gateDeps);
    await runner.run(EVALUATOR_TASK_ID);

    const events = (deps.eventEmitter.emitTelemetry as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as { eventType: string; payload: Record<string, unknown> },
    );
    const assembled = events.find((e) => e.eventType === 'evaluator_rule_assembled');
    expect(assembled).toBeDefined();
    expect(typeof assembled?.payload?.artifactId).toBe('string');
  });
});
