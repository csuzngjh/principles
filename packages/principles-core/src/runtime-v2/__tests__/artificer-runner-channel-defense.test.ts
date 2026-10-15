/**
 * PRI-982 (SPEC-PD-IAER-001 FR-05 / §4.2 / T08) — ArtificerRunner
 * channel-aware evidence defense.
 *
 * Production evidence (orchestrator-verified): prompt-channel artificer tasks
 * routed to L2 all failed (54 misrouted runs) while the same channel's legal
 * non-L2 pipeline has 40 successes. A1's missing-pack throw fires for EVERY
 * artificer task — including legal prompt-channel ones — which contradicts
 * SPEC §4.2 ("任务不需要代码规则时，按其合法的管道职责执行"). Contract pinned
 * here (channel authority = `pi_metadata.channel`, written deterministically
 * by the intake bridge — never guessed):
 *
 *   - `prompt` channel, pack ABSENT  → proceeds on the legal non-L2 pipeline
 *     (no input_invalid, runtime adapter invoked, task succeeds; the v2
 *     Owner-echo contract does not apply — there are no Owner labels to
 *     protect; downstream assessArtificerCodeBearing + RuleHost activation
 *     gates still enforce C-03/C-05);
 *   - `code_tool_hook` channel, pack ABSENT → A1's structured
 *     PDRuntimeError('input_invalid') with the stable
 *     `behavior_example_pack_missing` marker (unchanged);
 *   - any other/unknown channel (e.g. `defer_archive`) → conservative
 *     fail-closed treatment identical to code_tool_hook (never guess);
 *   - pack PRESENT (any channel) → the v2 Owner-echo contract still applies —
 *     injected Owner evidence is protected everywhere.
 *
 * Fixture style mirrors artificer-runner-evidence-guard.test.ts (mock
 * stateManager + runtime adapter; only the LLM boundary is doubled).
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
import type { InternalizationChannel } from '../internalization/peer-runner-contracts.js';
import type { TaskRecord } from '../task-status.js';

const SCRIBE_TASK_ID = 'scribe-001';
const ARTIFICER_TASK_ID = 'artificer-001';

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
      dependencyTaskIds: [],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
    }),
  };
}

function makeArtificerTask(channel: InternalizationChannel): TaskRecord {
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
      channel,
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

/** Rule-shaped output with the model's OWN cases (no Owner labels to echo). */
function makeSelfLabelledOutput(): Record<string, unknown> {
  return {
    taskId: ARTIFICER_TASK_ID,
    sourceScribeArtifactId: 'pi-art-scribe-001-run-001',
    requiresContextVersion: 2,
    evidenceRefs: ['scribe:pi-art-scribe-001-run-001'],
    implementationCode: 'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "ok" }; }',
    goldenTraceCases: [
      { caseId: 'model-negative-1', kind: 'negative', toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block', ruleContext: V2_RULE_CONTEXT },
      { caseId: 'model-positive-1', kind: 'positive', toolName: 'write_file', params: { path: '/project/file.txt' }, expectedDecision: 'allow', ruleContext: V2_RULE_CONTEXT },
    ],
    affectedTools: ['write_file'],
    implementationSummary: 'Allow writes inside the project tree',
    sourceTrace: { scribeArtifactId: 'pi-art-scribe-001-run-001' },
    risks: [],
    generatedAt: new Date().toISOString(),
  };
}

/** Owner-echo violating output: rewrites the Owner-labelled negative case. */
function makeEchoViolatingOutput(): Record<string, unknown> {
  const output = makeSelfLabelledOutput();
  output.goldenTraceCases = [
    {
      caseId: 'negative-1',
      kind: 'negative',
      toolName: 'write_file',
      params: { path: '/TOTALLY-REWRITTEN' },
      expectedDecision: 'block',
      ruleContext: V2_RULE_CONTEXT,
    },
    { caseId: 'positive-1', kind: 'positive', toolName: 'write_file', params: { path: '/project/file.txt' }, expectedDecision: 'allow', ruleContext: V2_RULE_CONTEXT },
  ];
  return output;
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

async function createHarness(channel: InternalizationChannel, depsOverrides: Partial<ArtificerRunnerDeps> = {}): Promise<Harness> {
  const artificerTask = makeArtificerTask(channel);
  const scribeTask = makeScribeTask();

  const stateManager = {
    acquireLease: vi.fn().mockResolvedValue(artificerTask),
    getTask: vi.fn().mockImplementation((id: string) => {
      if (id === ARTIFICER_TASK_ID) return Promise.resolve(artificerTask);
      if (id === SCRIBE_TASK_ID) return Promise.resolve(scribeTask);
      return Promise.resolve(null);
    }),
    getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
      runs: [{ runId: 'run-artificer-001', taskId: ARTIFICER_TASK_ID, runtimeKind: 'artificer', startedAt: new Date().toISOString() }],
      degradedRuns: [],
    }),
    updateRunOutput: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(undefined),
    markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
    markTaskFailed: vi.fn().mockResolvedValue(undefined),
    markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
    getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => true }),
  } as unknown as RuntimeStateManager;

  const runHandle: RunHandle = { runId: 'run-artificer-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
  const succeededStatus: RunStatus = { status: 'succeeded', runId: 'run-artificer-001' };

  const startRun = vi.fn().mockResolvedValue(runHandle);
  const runtimeAdapter = {
    startRun,
    pollRun: vi.fn().mockResolvedValue(succeededStatus),
    fetchOutput: vi.fn().mockResolvedValue({ payload: makeSelfLabelledOutput() }),
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

describe('ArtificerRunner channel-aware evidence defense (PRI-982 / SPEC-PD-IAER-001 §4.2, T08)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('prompt channel + missing pack → legal non-L2 pipeline proceeds, task succeeds, no input_invalid', async () => {
    const harness = await createHarness('prompt', { behaviorExamplePack: undefined });

    const result = await runArtificer(harness.deps);

    expect(result.status).toBe('succeeded');
    // The runtime adapter WAS invoked — the prompt build did not throw.
    expect(harness.startRun).toHaveBeenCalledTimes(1);
    expect(harness.stateManager.markTaskFailed).not.toHaveBeenCalled();
    expect(harness.stateManager.markTaskRetryWait).not.toHaveBeenCalled();
    expect(harness.emittedEvents.some((e) => e.eventType === 'artificer_output_invalid')).toBe(false);
    // No Owner-labelled evidence block in the prompt (pack absent → v2
    // context instruction omitted; the serialized input carries no pack).
    const promptPayload = String(harness.startRun.mock.calls[0]?.[0]?.inputPayload ?? '');
    expect(promptPayload).not.toContain('behaviorExamplePack');
  });

  it('code_tool_hook channel + missing pack → structured input_invalid with stable marker (A1 contract preserved)', async () => {
    const harness = await createHarness('code_tool_hook', { behaviorExamplePack: undefined });

    const result = await runArtificer(harness.deps);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
    expect(result.failureReason).toContain('behavior_example_pack_missing');
    // Pre-LLM: the runtime adapter was never invoked.
    expect(harness.startRun).not.toHaveBeenCalled();
    // No retry consumption for an input defect (A1 invariant).
    expect(harness.stateManager.markTaskRetryWait).not.toHaveBeenCalled();
  });

  it('unknown channel (defer_archive) + missing pack → conservative fail-closed (never guess)', async () => {
    const harness = await createHarness('defer_archive', { behaviorExamplePack: undefined });

    const result = await runArtificer(harness.deps);

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('input_invalid');
    expect(result.failureReason).toContain('behavior_example_pack_missing');
    expect(harness.startRun).not.toHaveBeenCalled();
  });

  it('prompt channel + injected pack → the v2 Owner-echo contract still applies (rewritten case rejected)', async () => {
    const harness = await createHarness('prompt', { behaviorExamplePack: V2_TEST_PACK });
    harness.deps.runtimeAdapter.fetchOutput = vi.fn().mockResolvedValue({ payload: makeEchoViolatingOutput() });

    const result = await runArtificer(harness.deps);

    // Injected Owner evidence is protected on every channel.
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('output_invalid');
    expect(harness.stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });
});
