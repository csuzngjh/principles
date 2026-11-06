/**
 * PRI-981 (SPEC-PD-IAER-001 FR-05 / T07) — ArtificerRunner defensive evidence
 * guard tests.
 *
 * Production evidence (SPEC §2.2): 385 Artificer L2 runs failed with
 * `behavior_example_pack_missing` and were classified `execution_failed` /
 * `max_attempts_exceeded`, burning retry attempts on an input defect no retry
 * can fix. These tests pin the corrected contract:
 *
 *   - a missing BehaviorExamplePack fails the attempt LOUD as a STRUCTURED
 *     `input_invalid` (PDRuntimeError) — a permanent category for the
 *     artificer runner (artificer-runner.ts permanentErrorCategories), so the
 *     base retry state machine marks the task failed directly:
 *       * errorCategory === 'input_invalid' (never execution_failed)
 *       * markTaskRetryWait is NEVER called, no `artificer_task_retried` event
 *       * task reaches the terminal failed state via markTaskFailed
 *       * failureReason keeps the stable `behavior_example_pack_missing`
 *         marker (historical audit + PRI-780 B2 compatibility)
 *       * structured details (reasonCode + nextAction) are persisted to the
 *         task diagnostic (rc-9: actionable diagnostics)
 *   - an injected but INVALID pack is rejected the same way pre-LLM
 *     (`behavior_example_pack_invalid` + validation errors, bounded)
 *   - a valid pack still passes the defensive validation and reaches the
 *     runtime (positive control — EP-09 negative/positive pairing).
 *
 * Fixture style mirrors artificer-runner-vslice.test.ts (mock stateManager +
 * runtime adapter; only the LLM boundary is doubled). Retry policy is set
 * permissive (`shouldRetry: () => true`) on purpose: with the pre-fix code the
 * missing-pack path WAS retried, so these tests fail on the old behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArtificerRunner } from '../internalization/artificer-runner.js';
import type { ArtificerRunnerDeps } from '../internalization/artificer-runner.js';
import type { PIArtifactStore, PIArtifactRecord } from '../internalization/pi-artifact.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import { DefaultArtificerValidator } from '../internalization/artificer-output.js';
import type { BehaviorExamplePack } from '../internalization/behavior-example-pack.js';
import { createPITaskDiagnosticJson } from '../internalization/pitask-metadata.js';
import type { TaskRecord } from '../task-status.js';

const SCRIBE_TASK_ID = 'scribe-001';
const ARTIFICER_TASK_ID = 'artificer-001';

const PHILOSOPHER_TASK_ID = 'philosopher-runner-001';
const PHILOSOPHER_ANALYSIS = 'The agent must read the target file before writing it. Blind edits cascade into silent corruption.';

function makePhilosopherTask(): TaskRecord {
  return {
    taskId: PHILOSOPHER_TASK_ID,
    taskKind: 'philosopher',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    resultRef: 'philosopher://run-001',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
    }),
  };
}

function makeScribeTask(): TaskRecord {
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
      dependencyTaskIds: [PHILOSOPHER_TASK_ID],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
    }),
  };
}

function makeArtificerTask(): TaskRecord {
  return {
    taskId: ARTIFICER_TASK_ID,
    taskKind: 'artificer',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [SCRIBE_TASK_ID],
      // PRI-982 (SPEC-PD-IAER-001 §4.2): these tests pin the RuleCode
      // sub-chain evidence contract, whose authoritative channel is
      // code_tool_hook. The prompt channel is pack-exempt (see
      // artificer-runner-channel-defense.test.ts).
      channel: 'code_tool_hook',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
    }),
  };
}

const V2_RULE_CONTEXT = {
  version: 2 as const,
  history: { status: 'available' as const, truncated: false, calls: [] },
  facts: { priorReadOfTarget: 'unknown' as const, readCount: 0, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: null },
};

const V2_TEST_PACK: BehaviorExamplePack = {
  sourceNegativeCase: {
    caseId: 'negative-1',
    kind: 'negative',
    toolName: 'write_file',
    params: { path: '/etc/passwd' },
    expectedDecision: 'block',
    ruleContext: V2_RULE_CONTEXT,
  },
  ownerDesiredOutcome: 'block writes outside the workspace',
  positiveCounterexamples: [{
    caseId: 'positive-1',
    kind: 'positive',
    toolName: 'write_file',
    params: { path: '/project/file.txt' },
    expectedDecision: 'allow',
    ruleContext: V2_RULE_CONTEXT,
  }],
  evidenceRefs: ['pain://1'],
  redactionNotes: [],
};

function makeArtificerOutput(): Record<string, unknown> {
  return {
    taskId: ARTIFICER_TASK_ID,
    sourceScribeArtifactId: 'pi-art-scribe-001-run-001',
    requiresContextVersion: 2,
    evidenceRefs: ['pain://1'],
    implementationCode: 'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "ok" }; }',
    goldenTraceCases: [
      { caseId: 'positive-1', kind: 'positive', toolName: 'write_file', params: { path: '/project/file.txt' }, expectedDecision: 'allow', ruleContext: V2_RULE_CONTEXT },
      { caseId: 'negative-1', kind: 'negative', toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block', ruleContext: V2_RULE_CONTEXT },
    ],
    affectedTools: ['write_file'],
    implementationSummary: 'Add input validation to all async operations',
    sourceTrace: { scribeArtifactId: 'pi-art-scribe-001-run-001' },
    risks: ['May add latency'],
    generatedAt: new Date().toISOString(),
  };
}

function makeScribeArtifact(): PIArtifactRecord {
  return {
    artifactId: 'pi-art-scribe-001-run-001',
    artifactKind: 'principle',
    sourceTaskId: SCRIBE_TASK_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify({
      taskId: SCRIBE_TASK_ID,
      sourcePhilosopherArtifactId: 'pi-art-philosopher-001',
      principleDraft: {
        title: 'Systematic Error Handling',
        statement: 'All async operations must include explicit error handling',
        rationale: 'Uncaught errors cascade into system instability',
        applicability: ['All async operations'],
        antiPatterns: ['Ignoring promise rejections'],
        confidence: 0.9,
      },
      sourceTrace: { philosopherArtifactId: 'pi-art-philosopher-001' },
      risks: [],
      intentContract: {
        ownerIntent: 'async operations must carry explicit error handling',
        targetBehavior: 'every async operation includes explicit error handling',
        forbiddenBehavior: 'ignoring promise rejections and async failures',
        evidenceSource: 'test fixture',
        validationExpectation: 'rule enforces the error-handling contract on async operations',
      },
      executionConditions: { version: 1, requiredFacts: [] },
      generatedAt: new Date().toISOString(),
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

interface Harness {
  deps: ArtificerRunnerDeps;
  stateManager: Record<string, ReturnType<typeof vi.fn>>;
  startRun: ReturnType<typeof vi.fn>;
  emittedEvents: { eventType: string; payload: Record<string, unknown> }[];
}

async function createHarness(depsOverrides: Partial<ArtificerRunnerDeps> = {}): Promise<Harness> {
  const artificerTask = makeArtificerTask();
  const scribeTask = makeScribeTask();

  void depsOverrides; // (placeholder to keep formatting stable)
  const stateManager = {
    acquireLease: vi.fn().mockResolvedValue(artificerTask),
    getTask: vi.fn().mockImplementation((id: string) => {
      if (id === ARTIFICER_TASK_ID) return Promise.resolve(artificerTask);
      if (id === SCRIBE_TASK_ID) return Promise.resolve(scribeTask);
      if (id === PHILOSOPHER_TASK_ID) return Promise.resolve(makePhilosopherTask());
      return Promise.resolve(null);
    }),
    getRunsByTask: vi.fn().mockResolvedValue([{
      runId: 'run-artificer-001',
      taskId: ARTIFICER_TASK_ID,
      runtimeKind: 'artificer',
      startedAt: new Date().toISOString(),
    }]),
    getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
      runs: [{ runId: 'run-artificer-001', taskId: ARTIFICER_TASK_ID, runtimeKind: 'artificer', startedAt: new Date().toISOString() }],
      degradedRuns: [],
    }),
    updateRunOutput: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
    markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
    markTaskFailed: vi.fn().mockResolvedValue(undefined),
    markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
    // Deliberately permissive: with the pre-fix code the missing-pack plain
    // Error was classified execution_failed and consumed this retry. The new
    // contract must never reach it for evidence defects.
    getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => true }),
  } as unknown as RuntimeStateManager;

  const runHandle: RunHandle = { runId: 'run-artificer-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
  const succeededStatus: RunStatus = { status: 'succeeded', runId: 'run-artificer-001' };

  const startRun = vi.fn().mockResolvedValue(runHandle);
  const runtimeAdapter = {
    startRun,
    pollRun: vi.fn().mockResolvedValue(succeededStatus),
    fetchOutput: vi.fn().mockResolvedValue({ payload: makeArtificerOutput() }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as PDRuntimeAdapter;

  const emittedEvents: { eventType: string; payload: Record<string, unknown> }[] = [];
  const eventEmitter = {
    emitTelemetry: vi.fn().mockImplementation((event: { eventType: unknown; payload: Record<string, unknown> }) => {
      emittedEvents.push({ eventType: String(event.eventType), payload: event.payload });
    }),
  } as unknown as StoreEventEmitter;

  const artifactStore: PIArtifactStore = new MemoryPIArtifactStore();
  await artifactStore.upsertArtifact(makeScribeArtifact());
  await artifactStore.upsertArtifact({
    artifactId: 'pi-art-philosopher-runner-001',
    artifactKind: 'principle',
    sourceTaskId: PHILOSOPHER_TASK_ID,
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: JSON.stringify({ taskId: PHILOSOPHER_TASK_ID, analysis: PHILOSOPHER_ANALYSIS }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  return {
    stateManager: stateManager as unknown as Record<string, ReturnType<typeof vi.fn>>,
    startRun,
    emittedEvents,
    deps: {
      stateManager,
      runtimeAdapter,
      eventEmitter,
      validator: new DefaultArtificerValidator(),
      artifactStore,
      ...depsOverrides,
    },
  };
}

function runArtificer(deps: ArtificerRunnerDeps): ReturnType<ArtificerRunner['run']> {
  const runner = new ArtificerRunner(deps, {
    owner: 'test',
    runtimeKind: 'artificer',
    pollIntervalMs: 10,
    timeoutMs: 1000,
  });
  return runner.run(ARTIFICER_TASK_ID);
}

function expectNoRetryPath(harness: Harness): void {
  const { stateManager, emittedEvents } = harness;
  expect(stateManager.markTaskRetryWait).not.toHaveBeenCalled();
  expect(emittedEvents.some((e) => e.eventType === 'artificer_task_retried')).toBe(false);
}

describe('ArtificerRunner defensive evidence guard (PRI-981 / SPEC-PD-IAER-001 FR-05, T07)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('missing BehaviorExamplePack → structured input_invalid, task failed, no retry, pre-LLM', async () => {
    const harness = await createHarness({ behaviorExamplePack: undefined });
    const { stateManager } = harness;

    const result = await runArtificer(harness.deps);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
    expect(result.errorCategory).not.toBe('execution_failed');
    expect(result.errorCategory).not.toBe('max_attempts_exceeded');
    expect(result.failureReason).toContain('behavior_example_pack_missing');

    // Terminal state via the permanent-category path — never the retry path.
    expect(stateManager.markTaskFailed).toHaveBeenCalledWith(
      ARTIFICER_TASK_ID,
      'input_invalid',
      expect.stringContaining('behavior_example_pack_missing'),
    );
    expectNoRetryPath(harness);

    // Pre-LLM proof: the runtime adapter was never invoked — no token spend.
    expect(harness.startRun).not.toHaveBeenCalled();
  });

  it('missing pack diagnostics carry a stable reasonCode and nextAction into the task record (rc-9)', async () => {
    const harness = await createHarness({ behaviorExamplePack: undefined });
    const { stateManager } = harness;

    await runArtificer(harness.deps);

    expect(stateManager.updateTask).toHaveBeenCalled();
    const [taskId, patch] = (stateManager.updateTask as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { diagnosticJson: string }];
    expect(taskId).toBe(ARTIFICER_TASK_ID);
    const diagnostic: unknown = JSON.parse(patch.diagnosticJson);
    expect(diagnostic).toBeTruthy();
    const details = (diagnostic as { output_failure_details?: Record<string, unknown> }).output_failure_details;
    expect(details).toBeTruthy();
    expect(details?.reasonCode).toBe('owner_behavior_examples_required');
    // PRI-980 review P2-2: the nextAction must name the REAL out-chain. The
    // task lands terminal-failed, and the recovery entry
    // (loadEvidenceTask) refuses non-NHR tasks — so "just attach evidence"
    // was not executable as stated.
    const nextAction = String(details?.nextAction);
    expect(nextAction).toContain('pd runtime recovery failed-tasks --confirm');
    expect(nextAction).toContain('pd runtime internalization evidence attach --confirm');
    expect(nextAction).toContain('pd runtime internalization evidence resume --confirm');
    // the misleading one-hop guidance is gone
    expect(nextAction).not.toContain('FR-06 recovery entry');
  });

  it('nextAction guidance is embedded in the failure reason for operator surfaces', async () => {
    const harness = await createHarness({ behaviorExamplePack: undefined });
    const result = await runArtificer(harness.deps);
    expect(result.failureReason).toContain('SPEC-PD-IAER-001');
  });

  it('injected INVALID BehaviorExamplePack → structured input_invalid pre-LLM, no retry', async () => {
    const invalidPack = {
      sourceNegativeCase: { caseId: 'neg-1', kind: 'wrong-kind', toolName: 'write_file', params: {}, expectedDecision: 'block' },
      ownerDesiredOutcome: '',
      positiveCounterexamples: [],
      evidenceRefs: [],
      redactionNotes: 'not-an-array',
    } as unknown as BehaviorExamplePack;

    const harness = await createHarness({ behaviorExamplePack: invalidPack });
    const { stateManager } = harness;

    const result = await runArtificer(harness.deps);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
    expect(result.failureReason).toContain('behavior_example_pack_invalid');

    expect(stateManager.markTaskFailed).toHaveBeenCalledWith(
      ARTIFICER_TASK_ID,
      'input_invalid',
      expect.stringContaining('behavior_example_pack_invalid'),
    );
    expectNoRetryPath(harness);
    expect(harness.startRun).not.toHaveBeenCalled();
  });

  it('invalid-pack diagnostics carry reasonCode owner_behavior_examples_invalid (rc-9)', async () => {
    const invalidPack = {
      sourceNegativeCase: { caseId: 'neg-1', kind: 'negative', toolName: 'write_file', params: {}, expectedDecision: 'block' },
      ownerDesiredOutcome: '',
      positiveCounterexamples: [],
      evidenceRefs: [],
      redactionNotes: [],
    } as unknown as BehaviorExamplePack;

    const harness = await createHarness({ behaviorExamplePack: invalidPack });
    const { stateManager } = harness;

    await runArtificer(harness.deps);

    expect(stateManager.updateTask).toHaveBeenCalled();
    const [, patch] = (stateManager.updateTask as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { diagnosticJson: string }];
    const diagnostic: unknown = JSON.parse(patch.diagnosticJson);
    const details = (diagnostic as { output_failure_details?: Record<string, unknown> }).output_failure_details;
    expect(details?.reasonCode).toBe('owner_behavior_examples_invalid');
    // PRI-980 review P2-2: same truthful out-chain as the missing-pack guard.
    const nextAction = String(details?.nextAction);
    expect(nextAction).toContain('pd runtime recovery failed-tasks --confirm');
    expect(nextAction).not.toContain('FR-06 recovery entry');
  });

  it('positive control: a valid pack passes the defensive guard and reaches the runtime', async () => {
    const harness = await createHarness({ behaviorExamplePack: V2_TEST_PACK });

    const result = await runArtificer(harness.deps);

    expect(result.status).toBe('succeeded');
    expect(harness.startRun).toHaveBeenCalledTimes(1);
    expect(harness.emittedEvents.some((e) => e.eventType === 'artificer_task_retried')).toBe(false);
  });
  it('unsupported required fact remains a pre-model capability stop even when its resolver says approved', async () => {
    const harness = await createHarness({ behaviorExamplePack: V2_TEST_PACK,
      trustedFacts: { resolveRequiredFact: () => ({ resolution: 'approved' }) },
    });
    const artifact = makeScribeArtifact();
    const content = JSON.parse(artifact.contentJson);
    content.executionConditions = { version: 1, requiredFacts: [{ factKind: 'unimplemented_fact', required: true,
      textualBasis: 'read the target file before writing it' }] };
    await harness.deps.artifactStore.upsertArtifact({ ...artifact, contentJson: JSON.stringify(content) });
    const result = await runArtificer(harness.deps);
    expect(result.status).toBe('failed');
    expect(harness.startRun).not.toHaveBeenCalled();
    const artifacts = await harness.deps.artifactStore.listBySourceTaskId(ARTIFICER_TASK_ID);
    expect(artifacts.some((entry) => entry.validationStatus === 'validated')).toBe(false);
    expectNoRetryPath(harness);
  });
});
