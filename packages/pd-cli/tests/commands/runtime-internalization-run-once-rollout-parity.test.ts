/**
 * PRI-708 — run-once rollout revision routing: cross entry point equivalence.
 *
 * Owner acceptance (P0 A/B/C): the SAME durable state must produce the SAME
 * governance decision whether it travels the production consumer-cycle
 * assembly or the run-once CLI entry. Only the LLM boundary is scripted
 * (PRI-661 parity-test pattern) — the evaluator stage, the rollout reviewer
 * runner, validators, stores and the reopen path are all REAL code against
 * REAL SQLite. No runner.run() mocks, no fabricated verdict objects.
 *
 *   P0 A (routing correctness):  needs_revision → reopen scribe/artificer,
 *                                identical targetTaskKind / revisionIteration
 *                                / revisionCauseId / payload on both entries.
 *   P0 B (durable recovery):     crash-window resume via the run-once entry —
 *                                same intent → same effect, LLM not re-asked,
 *                                no duplicate reopen (causeId materialize).
 *   P0 C (exhaustion safety):    appliedCount ≥ 2 → rollout_revision_budget_
 *                                exhausted NHR, decision-capable (eligible /
 *                                allowedActions non-empty) — wiring must not
 *                                bypass the revision budget.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RuntimeStateManager,
  InternalizationOrchestrator,
  RolloutReviewerRunner,
  DefaultRolloutReviewerValidator,
  storeEmitter,
  hydratePITaskRecord,
  createPITaskDiagnosticJson,
  mergePITaskMetadata,
  reopenTaskForRevision,
  collectOwnerDecisionFacts,
  deriveOwnerDecisionCapability,
  factStoreFromStateManager,
  type PITaskMetadata,
  type PDRuntimeAdapter,
} from '@principles/core/runtime-v2';
import { createRolloutGovernanceDeps, saveHostToolDeclaration } from '@principles/host-runtime';
import { handleRuntimeInternalizationRunOnce } from '../../src/commands/runtime-internalization-run-once.js';

// ── LLM boundary (the ONLY scripted seam) ────────────────────────────────────
// resolveRuntimeAdapterFromConfig is the CLI's adapter seam; mocking it keeps
// the handler, orchestrator, runners, validators and SQLite stores real while
// making the reviewer/evaluator verdicts deterministic.

const scriptedPayloads: Record<string, unknown> = {};
const llmCalls: Record<string, number> = {};

vi.mock('../../src/services/runtime-adapter-resolver.js', () => ({
  resolveRuntimeAdapterFromConfig: (input: { runnerKind: string }) => scriptedAdapterFor(input.runnerKind),
}));

function scriptedAdapterFor(runnerKind: string): PDRuntimeAdapter {
  return {
    kind: () => 'test-double',
    startRun: async () => {
      llmCalls[runnerKind] = (llmCalls[runnerKind] ?? 0) + 1;
      return {
        runId: `run-${runnerKind}-${llmCalls[runnerKind]}`,
        runtimeKind: 'test-double',
        startedAt: new Date().toISOString(),
      };
    },
    pollRun: async (runId: string) => ({ status: 'succeeded' as const, runId }),
    fetchOutput: async (runId: string) => ({ runId, payload: scriptedPayloads[runnerKind] }),
    cancelRun: async () => undefined,
  } as unknown as PDRuntimeAdapter;
}

// ── fixture: deterministic lineage + evaluation payload ─────────────────────

const SCRIBE_ID = 'scribe-parity-1';
const ARTIFICER_ID = 'artificer-parity-1';
const EVAL_ID = 'evaluator-parity-1';
const ROLL_ID_SEED = 'rollout-parity-craft'; // only used by crafted (T3/T4) workspaces
const SCRIBE_ART = 'pi-art-scribe-parity-1';
const ARTIFICER_ART = 'pi-art-artificer-parity-1';
const EVAL_ART = 'pi-art-eval-parity-1';

function evaluationApprovedPayload(): Record<string, unknown> {
  return {
    taskId: EVAL_ID,
    sourceArtificerArtifactId: ARTIFICER_ART,
    evaluation: {
      decision: 'approved',
      summary: 'parity fixture evaluation',
      score: 0.85,
      strengths: ['well structured'],
      concerns: [],
      requiredChanges: [],
    },
    sourceTrace: { artificerArtifactId: ARTIFICER_ART },
    risks: [],
    generatedAt: new Date().toISOString(),
  };
}

function rolloutNeedsRevisionPayload(taskId: string, evaluatorArtifactId: string): Record<string, unknown> {
  return {
    taskId,
    sourceEvaluatorArtifactId: evaluatorArtifactId,
    review: {
      decision: 'needs_revision',
      summary: 'parity fixture review',
      confidence: 0.7,
      requiredChanges: ['Fix the principle wording to cover the observed failure'],
      rolloutRisks: ['wording drift'],
      safetyChecks: [],
    },
    sourceTrace: { evaluatorArtifactId },
    risks: [],
    generatedAt: new Date().toISOString(),
  };
}

async function seedWorkspace(workspaceDir: string): Promise<RuntimeStateManager> {
  saveHostToolDeclaration(workspaceDir, {
    version: 1,
    hostKind: 'openclaw',
    mappings: [{ rawToolName: 'Write', canonicalKind: 'write' }],
    declaredAt: new Date().toISOString(),
  });
  const sm = new RuntimeStateManager({ workspaceDir });
  await sm.initialize();
  await sm.piArtifactStore.upsertArtifact({
    artifactId: SCRIBE_ART, artifactKind: 'principle', sourceTaskId: SCRIBE_ID,
    lineageArtifactIds: [], validationStatus: 'validated',
    contentJson: JSON.stringify({ principleDraft: { title: 'parity-p', statement: '原则正文' } }),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await sm.piArtifactStore.upsertArtifact({
    artifactId: ARTIFICER_ART, artifactKind: 'rule', sourceTaskId: ARTIFICER_ID,
    lineageArtifactIds: [SCRIBE_ART], validationStatus: 'validated',
    contentJson: JSON.stringify({
      implementationPlan: { summary: 'parity plan', targetSurface: 'src/*.ts', changes: [], tests: [], rolloutNotes: [], confidence: 0.8 },
      sourceTrace: { scribeArtifactId: SCRIBE_ART },
    }),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const chain: readonly [string, string, string[], 'succeeded' | 'pending'][] = [
    [SCRIBE_ID, 'scribe', [], 'succeeded'],
    [ARTIFICER_ID, 'artificer', [SCRIBE_ID], 'succeeded'],
    [EVAL_ID, 'evaluator', [ARTIFICER_ID], 'pending'],
  ];
  for (const [id, kind, deps, status] of chain) {
    // 先 pending 建 task → lease → succeeded（lease 门只接受 pending/retry_wait）
    await sm.createTask({
      taskId: id, taskKind: kind, status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: deps, channel: 'prompt', timeoutMs: 300_000,
        inputArtifactRefs: [], outputArtifactRefs: [], correlationId: 'parity',
      }),
    });
    if (status === 'succeeded') {
      await sm.acquireLease({ taskId: id, owner: 'parity-seed', runtimeKind: 'test-double' });
      await sm.markTaskSucceeded(id);
    }
  }
  return sm;
}

/** Real evaluator stage through the REAL run-once handler → real evaluator artifact + real rollout successor task. */
async function driveEvaluatorLeg(workspaceDir: string): Promise<{ rolloutTaskId: string; evaluatorArtifactId: string }> {
  scriptedPayloads['evaluator'] = evaluationApprovedPayload();
  await handleRuntimeInternalizationRunOnce({
    workspace: workspaceDir, runner: 'evaluator', runtime: 'test-double', allowTestDouble: true, json: true,
  });
  const out = JSON.parse(consoleLogSpy.mock.calls.at(-1)![0] as string) as Record<string, unknown>;
  expect(out.decision).toBe('would_lease');
  expect(out.enqueueDecision).toBe('successor_created');
  expect(out.successorKind).toBe('rollout_reviewer');
  return {
    rolloutTaskId: (out.successorTaskIds as string[])[0],
    evaluatorArtifactId: out.artifactId as string,
  };
}

interface GovernanceOutcome {
  rollout: {
    status: string;
    runnerDecision: string | undefined;
    payloadRevisionIteration: number | undefined;
    payloadStatus: string | undefined;
    payloadTargetKind: string | undefined;
    payloadRequiredChanges: readonly string[] | undefined;
    intentStatus: string | undefined;
    humanReviewContext: PITaskMetadata['humanReviewContext'];
  };
  scribe: {
    status: string;
    attemptCount: number;
    revisionCount: number;
    revisionCauseId: string | undefined;
    revisionFeedback: string | undefined;
  };
}

async function readGovernanceOutcome(sm: RuntimeStateManager, rolloutTaskId: string): Promise<GovernanceOutcome> {
  const rolloutRaw = await sm.getTask(rolloutTaskId);
  expect(rolloutRaw).not.toBeNull();
  const rollout = hydratePITaskRecord(rolloutRaw!)!;
  const scribeRaw = await sm.getTask(SCRIBE_ID);
  const scribe = scribeRaw ? hydratePITaskRecord(scribeRaw) : null;
  return {
    rollout: {
      status: rolloutRaw!.status,
      runnerDecision: rollout.runnerDecision,
      payloadRevisionIteration: rollout.rolloutRevisionPayload?.revisionIteration,
      payloadStatus: rollout.rolloutRevisionPayload?.status,
      payloadTargetKind: rollout.rolloutRevisionPayload?.targetTaskKind,
      payloadRequiredChanges: rollout.rolloutRevisionPayload?.requiredChanges,
      intentStatus: rollout.completionIntent?.status,
      humanReviewContext: rollout.humanReviewContext,
    },
    scribe: {
      status: scribeRaw!.status,
      attemptCount: scribeRaw!.attemptCount,
      revisionCount: scribe?.revisionCount ?? 0,
      revisionCauseId: scribe?.revisionCauseId,
      revisionFeedback: scribe?.revisionFeedback,
    },
  };
}

let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const key of Object.keys(scriptedPayloads)) delete scriptedPayloads[key];
  for (const key of Object.keys(llmCalls)) delete llmCalls[key];
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  vi.restoreAllMocks();
  process.exitCode = 0;
});

// ═══ P0 A — cross entry point equivalence (core AC) ══════════════════════════

describe('PRI-708 P0-A cross entry point equivalence', () => {
  const dirs: string[] = [];
  const states: RuntimeStateManager[] = [];

  function makeWorkspace(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const sm of states.splice(0)) await sm.close().catch(() => undefined);
    for (const dir of dirs.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
    }
  });

  it('run-once entry: real evaluator→rollout chain, needs_revision reopens the scribe via canonical routing', async () => {
    const ws = makeWorkspace('pd-pri708-runonce-');
    const sm = await seedWorkspace(ws);
    states.push(sm);

    const { rolloutTaskId, evaluatorArtifactId } = await driveEvaluatorLeg(ws);
    scriptedPayloads['rollout_reviewer'] = rolloutNeedsRevisionPayload(rolloutTaskId, evaluatorArtifactId);

    await handleRuntimeInternalizationRunOnce({
      workspace: ws, runner: 'rollout_reviewer', runtime: 'test-double', allowTestDouble: true, json: true,
    });
    const out = JSON.parse(consoleLogSpy.mock.calls.at(-1)![0] as string) as Record<string, unknown>;
    expect(out.decision).toBe('would_lease');
    expect((out.runnerResult as Record<string, unknown>).status).toBe('succeeded');

    const outcome = await readGovernanceOutcome(sm, rolloutTaskId);
    // rollout 侧: governance transition 完成 — 无 NHR、payload applied、intent applied
    expect(outcome.rollout.status).toBe('succeeded');
    expect(outcome.rollout.runnerDecision).toBe('needs_revision');
    expect(outcome.rollout.humanReviewContext).toBeUndefined();
    expect(outcome.rollout.payloadRevisionIteration).toBe(1);
    expect(outcome.rollout.payloadStatus).toBe('applied');
    expect(outcome.rollout.payloadTargetKind).toBe('scribe');
    expect(outcome.rollout.payloadRequiredChanges).toEqual(['Fix the principle wording to cover the observed failure']);
    expect(outcome.rollout.intentStatus).toBe('applied');
    // scribe 侧: 被 reopen（prompt channel → scribe 走到底），反馈携带 requiredChanges
    expect(outcome.scribe.status).toBe('pending');
    expect(outcome.scribe.attemptCount).toBe(0);
    expect(outcome.scribe.revisionCount).toBe(1);
    expect(outcome.scribe.revisionCauseId).toBe(`rollout-${rolloutTaskId}-r1`);
    expect(outcome.scribe.revisionFeedback).toContain('Fix the principle wording');
  });

  it('production consumer-cycle assembly on the SAME durable input produces the IDENTICAL governance outcome', async () => {
    const ws = makeWorkspace('pd-pri708-prodcycle-');
    const sm = await seedWorkspace(ws);
    states.push(sm);

    const { rolloutTaskId, evaluatorArtifactId } = await driveEvaluatorLeg(ws);
    scriptedPayloads['rollout_reviewer'] = rolloutNeedsRevisionPayload(rolloutTaskId, evaluatorArtifactId);

    // internalization-consumer-cycle.ts:536-543 的精确装配公式（同工厂 + 同
    // options 形；cycle 的 orchestrator 同为 dryRun: true）。
    const orchestrator = new InternalizationOrchestrator(
      { stateManager: sm },
      { owner: 'parity-production', runtimeKind: 'test-double', dryRun: true },
    );
    const wake = await orchestrator.wakeOnce('rollout_reviewer');
    expect(wake.decision).toBe('would_lease');
    const runner = new RolloutReviewerRunner(
      {
        stateManager: sm,
        runtimeAdapter: scriptedAdapterFor('rollout_reviewer'),
        eventEmitter: storeEmitter,
        artifactStore: sm.piArtifactStore,
        validator: new DefaultRolloutReviewerValidator(),
        ...createRolloutGovernanceDeps(ws, orchestrator, {}),
      },
      { owner: 'parity-production', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 15_000 },
    );
    const result = await runner.run(wake.taskId);
    expect(result.status).toBe('succeeded');
    await orchestrator.commitNextTaskProposal(wake.taskId);

    const outcome = await readGovernanceOutcome(sm, rolloutTaskId);
    expect(outcome.rollout.status).toBe('succeeded');
    expect(outcome.rollout.runnerDecision).toBe('needs_revision');
    expect(outcome.rollout.humanReviewContext).toBeUndefined();
    expect(outcome.rollout.payloadRevisionIteration).toBe(1);
    expect(outcome.rollout.payloadStatus).toBe('applied');
    expect(outcome.rollout.payloadTargetKind).toBe('scribe');
    expect(outcome.rollout.payloadRequiredChanges).toEqual(['Fix the principle wording to cover the observed failure']);
    expect(outcome.rollout.intentStatus).toBe('applied');
    expect(outcome.scribe.status).toBe('pending');
    expect(outcome.scribe.attemptCount).toBe(0);
    expect(outcome.scribe.revisionCount).toBe(1);
    expect(outcome.scribe.revisionCauseId).toBe(`rollout-${rolloutTaskId}-r1`);
    expect(outcome.scribe.revisionFeedback).toContain('Fix the principle wording');
  });

  it('EQUIVALENCE: both entries yield byte-identical governance fields for the same durable input', async () => {
    const wsA = makeWorkspace('pd-pri708-eq-a-');
    const smA = await seedWorkspace(wsA);
    states.push(smA);
    const wsB = makeWorkspace('pd-pri708-eq-b-');
    const smB = await seedWorkspace(wsB);
    states.push(smB);

    // 腿 A: run-once（真实 CLI handler）
    const legA = await driveEvaluatorLeg(wsA);
    scriptedPayloads['rollout_reviewer'] = rolloutNeedsRevisionPayload(legA.rolloutTaskId, legA.evaluatorArtifactId);
    await handleRuntimeInternalizationRunOnce({
      workspace: wsA, runner: 'rollout_reviewer', runtime: 'test-double', allowTestDouble: true, json: true,
    });

    // 腿 B: production consumer-cycle 装配公式
    const legB = await driveEvaluatorLeg(wsB);
    scriptedPayloads['rollout_reviewer'] = rolloutNeedsRevisionPayload(legB.rolloutTaskId, legB.evaluatorArtifactId);
    const orchestrator = new InternalizationOrchestrator(
      { stateManager: smB },
      { owner: 'parity-production', runtimeKind: 'test-double', dryRun: true },
    );
    const wake = await orchestrator.wakeOnce('rollout_reviewer');
    const runner = new RolloutReviewerRunner(
      {
        stateManager: smB,
        runtimeAdapter: scriptedAdapterFor('rollout_reviewer'),
        eventEmitter: storeEmitter,
        artifactStore: smB.piArtifactStore,
        validator: new DefaultRolloutReviewerValidator(),
        ...createRolloutGovernanceDeps(wsB, orchestrator, {}),
      },
      { owner: 'parity-production', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 15_000 },
    );
    expect((await runner.run(wake.taskId)).status).toBe('succeeded');
    await orchestrator.commitNextTaskProposal(wake.taskId);

    const outA = await readGovernanceOutcome(smA, legA.rolloutTaskId);
    const outB = await readGovernanceOutcome(smB, legB.rolloutTaskId);
    // rollout 的 causeId 内嵌各自 workspace 的 taskId — 归一后必须逐字段一致
    expect(outA.scribe.revisionCauseId).toBe(`rollout-${legA.rolloutTaskId}-r1`);
    expect(outB.scribe.revisionCauseId).toBe(`rollout-${legB.rolloutTaskId}-r1`);
    const normalized = (o: GovernanceOutcome, rolloutTaskId: string): GovernanceOutcome => ({
      ...o,
      scribe: { ...o.scribe, revisionCauseId: o.scribe.revisionCauseId?.replace(rolloutTaskId, '<rolloutTaskId>') },
    });
    expect(normalized(outA, legA.rolloutTaskId)).toEqual(normalized(outB, legB.rolloutTaskId));
  });
});

// ═══ P0 B — durable recovery (crash window resume) ═══════════════════════════

describe('PRI-708 P0-B durable recovery through the run-once entry', () => {
  let ws: string;
  let sm: RuntimeStateManager;

  beforeEach(async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri708-recovery-'));
    sm = await seedWorkspace(ws);
    // craft 链的 evaluator 无 evaluator leg 驱动 — 真实 lease→succeed 收尾,
    // 使 rollout 任务的依赖满足（wakeOnce 才会投放）
    await sm.acquireLease({ taskId: EVAL_ID, owner: 'parity-seed', runtimeKind: 'test-double' });
    await sm.markTaskSucceeded(EVAL_ID);
    // craft 后 rollout 任务不需要 evaluator artifact（resume 不走 buildContext）
    await sm.piArtifactStore.upsertArtifact({
      artifactId: EVAL_ART, artifactKind: 'principle', sourceTaskId: EVAL_ID,
      lineageArtifactIds: [ARTIFICER_ART], validationStatus: 'pending',
      contentJson: JSON.stringify({ evaluation: { decision: 'approved', score: 0.9, strengths: [], concerns: [], requiredChanges: [] } }),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    await sm.close().catch(() => undefined);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* temp */ }
  });

  /** craft crash window: verdict+intent durable（pending），effects 未 materialize */
  async function craftPendingIntent(): Promise<string> {
    await sm.createTask({
      taskId: ROLL_ID_SEED, taskKind: 'rollout_reviewer', status: 'pending', attemptCount: 1, maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [EVAL_ID], channel: 'prompt', timeoutMs: 300_000,
        inputArtifactRefs: [{ artifactType: 'principle', ref: EVAL_ART }], outputArtifactRefs: [], correlationId: 'parity-recovery',
      }),
    });
    await sm.acquireLease({ taskId: ROLL_ID_SEED, owner: 'craft', runtimeKind: 'test-double' });
    const runs = await sm.getRunsByTask(ROLL_ID_SEED);
    const runId = runs.at(-1)!.runId;
    await sm.updateRunOutput(runId, JSON.stringify(rolloutNeedsRevisionPayload(ROLL_ID_SEED, EVAL_ART)));
    await sm.releaseLease(ROLL_ID_SEED, 'craft');
    const raw = await sm.getTask(ROLL_ID_SEED);
    const pi = hydratePITaskRecord(raw!)!;
    await sm.updateTaskDiagnosticJson(ROLL_ID_SEED, createPITaskDiagnosticJson(mergePITaskMetadata(pi, {
      runnerDecision: 'needs_revision',
      completionIntent: {
        decision: 'needs_revision', sourceRunId: runId, revisionEpoch: 0, status: 'pending', revisionIteration: 1,
      } as PITaskMetadata['completionIntent'],
    })));
    return runId;
  }

  it('crash-before-reopen window: resume applies the SAME effect (reopen) without re-asking the LLM', async () => {
    await craftPendingIntent();

    await handleRuntimeInternalizationRunOnce({
      workspace: ws, runner: 'rollout_reviewer', runtime: 'test-double', allowTestDouble: true, json: true,
    });

    // resume = intent 是 recovery authority — LLM 不得被重新调用
    expect(llmCalls['rollout_reviewer'] ?? 0).toBe(0);
    const outcome = await readGovernanceOutcome(sm, ROLL_ID_SEED);
    expect(outcome.rollout.status).toBe('succeeded');
    expect(outcome.rollout.humanReviewContext).toBeUndefined();
    expect(outcome.rollout.payloadStatus).toBe('applied');
    expect(outcome.rollout.intentStatus).toBe('applied');
    expect(outcome.scribe.status).toBe('pending');
    expect(outcome.scribe.revisionCount).toBe(1);
    expect(outcome.scribe.revisionCauseId).toBe(`rollout-${ROLL_ID_SEED}-r1`);
  });

  it('crash-after-reopen window: causeId materialize check — no duplicate reopen on resume', async () => {
    await craftPendingIntent();
    // reopen 已 materialize、intent 未标 applied 的窗口: 先真实 reopen
    await reopenTaskForRevision(sm, SCRIBE_ID, {
      revisionFeedback: 'pre-crash reopen', reason: 'rollout_revision_iteration_1',
      revisionCauseId: `rollout-${ROLL_ID_SEED}-r1`,
    });

    await handleRuntimeInternalizationRunOnce({
      workspace: ws, runner: 'rollout_reviewer', runtime: 'test-double', allowTestDouble: true, json: true,
    });

    expect(llmCalls['rollout_reviewer'] ?? 0).toBe(0);
    const outcome = await readGovernanceOutcome(sm, ROLL_ID_SEED);
    expect(outcome.rollout.status).toBe('succeeded');
    expect(outcome.rollout.intentStatus).toBe('applied');
    // 不得二次 reopen — revisionCount 仍是 1，原反馈不被覆写
    expect(outcome.scribe.status).toBe('pending');
    expect(outcome.scribe.revisionCount).toBe(1);
    expect(outcome.scribe.revisionFeedback).toBe('pre-crash reopen');
  });
});

// ═══ P0 C — exhaustion safety (decision-capable NHR) ═════════════════════════

describe('PRI-708 P0-C exhaustion safety through the run-once entry', () => {
  let ws: string;
  let sm: RuntimeStateManager;

  beforeEach(async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri708-budget-'));
    sm = await seedWorkspace(ws);
    // 同 P0-B: evaluator 真实收尾,rollout 依赖满足
    await sm.acquireLease({ taskId: EVAL_ID, owner: 'parity-seed', runtimeKind: 'test-double' });
    await sm.markTaskSucceeded(EVAL_ID);
    await sm.piArtifactStore.upsertArtifact({
      artifactId: EVAL_ART, artifactKind: 'principle', sourceTaskId: EVAL_ID,
      lineageArtifactIds: [ARTIFICER_ART], validationStatus: 'pending',
      contentJson: JSON.stringify({ evaluation: { decision: 'approved', score: 0.9, strengths: [], concerns: [], requiredChanges: [] } }),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await sm.createTask({
      taskId: ROLL_ID_SEED, taskKind: 'rollout_reviewer', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [EVAL_ID], channel: 'prompt', timeoutMs: 300_000,
        inputArtifactRefs: [{ artifactType: 'principle', ref: EVAL_ART }], outputArtifactRefs: [], correlationId: 'parity-budget',
        // 预算证据: 两轮修订已 applied
        rolloutRevisionPayload: {
          requiredChanges: ['前两轮'], revisionIteration: 2, sourceRolloutTaskId: ROLL_ID_SEED,
          sourceArtifactId: EVAL_ART, targetTaskKind: 'scribe', status: 'applied',
        },
        revisionCount: 1,
      }),
    });
  });

  afterEach(async () => {
    await sm.close().catch(() => undefined);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* temp */ }
  });

  it('budget exhausted (appliedCount>=2): rollout_revision_budget_exhausted NHR — decision-capable, NOT recovery', async () => {
    scriptedPayloads['rollout_reviewer'] = rolloutNeedsRevisionPayload(ROLL_ID_SEED, EVAL_ART);
    await handleRuntimeInternalizationRunOnce({
      workspace: ws, runner: 'rollout_reviewer', runtime: 'test-double', allowTestDouble: true, json: true,
    });

    // 预算不被新接线绕过: scribe 未被 reopen
    const outcome = await readGovernanceOutcome(sm, ROLL_ID_SEED);
    expect(outcome.scribe.revisionCount).toBe(0);
    expect(outcome.scribe.status).toBe('succeeded');
    // 任务落 NHR，reasonCode 规范化为 decision-capable 集合成员
    const raw = await sm.getTask(ROLL_ID_SEED);
    expect(raw!.status).toBe('needs_human_review');
    const pi = hydratePITaskRecord(raw!)!;
    expect(pi.humanReviewContext?.reasonCode).toBe('rollout_revision_budget_exhausted');

    // Owner 裁决能力: eligible=true、allowedActions 非空（生产同一 capability 函数）
    const facts = await collectOwnerDecisionFacts(factStoreFromStateManager(sm), ROLL_ID_SEED);
    expect(facts).not.toBeNull();
    const capability = deriveOwnerDecisionCapability(facts!);
    expect(capability.eligible).toBe(true);
    expect(capability.attention).toBe('owner_decision');
    expect(capability.allowedActions.length).toBeGreaterThan(0);
    expect(capability.allowedActions).toContain('accept_current');
  });
});
