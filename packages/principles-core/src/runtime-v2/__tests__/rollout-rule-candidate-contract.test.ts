/**
 * PRI-634 — rollout activation 候选解析的内容契约回归测试（code_tool_hook 渠道）。
 *
 * 复现 PRI-634 取证场景：血缘上存在一个 kind='rule' + validated 的伪候选
 * （artificer 原始产物被数据修复改标），内容是 artificer schema
 * （goldenTraceCases，无 goldenTrace / ruleHostGateDecision / implementationCode）。
 *
 * 修复前：resolver 只按 kind+validated 过滤 → 伪候选被 dispatch →
 *         RuleHostWriter.canActivate 以 no_golden_trace 拒绝 →
 *         Owner 只看到 rollout_dispatch_refused，无从判断根因。
 * 修复后：resolver 在候选解析阶段就按内容契约筛掉伪候选 → 不 dispatch →
 *         needs_human_review + humanReviewContext.detail 说明缺口字段。
 *
 * 同时锁定两个反向用例，证明该修复不是"一刀切拒所有"：
 *   - 合法 evaluator assemble 产物仍然正常 dispatch；
 *   - dispatch 被拒时 outcome.reason 透传到 detail。
 */
import { describe, it, expect, vi } from 'vitest';
import { RolloutReviewerRunner } from '../internalization/rollout-reviewer-runner.js';
import type { RolloutReviewerRunnerDeps, RolloutAutoDispatchOutcome } from '../internalization/rollout-reviewer-runner.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle } from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { RolloutReviewerOutputV1 } from '../internalization/rollout-reviewer-output.js';
import { DefaultRolloutReviewerValidator } from '../internalization/rollout-reviewer-output.js';
import { createPITaskDiagnosticJson } from '../internalization/pitask-metadata.js';
import type { InternalizationChannel } from '../internalization/peer-runner-contracts.js';
import { buildGoldenTraceFromArtificer } from '../golden-trace.js';
import type { TaskRecord } from '../task-status.js';

const ROLLOUT_ID = 'rollout-pri634';
const EVAL_ID = 'evaluator-pri634';
const ARTIFICER_REPAIR_ID = 'artificer-repair-pri634-r2';

/** 伪候选 (PRI-634 实测形态): artificer 产物被改标 rule + validated */
const PSEUDO_CANDIDATE_ID = 'pi-art-artificer-pseudo-candidate';
/** 合法候选: evaluator assemble 产物 */
const VALID_CANDIDATE_ID = 'pi-rule-evaluator-valid';

function makeTask(spec: { taskId: string; taskKind: string; deps?: string[]; status?: string; channel?: InternalizationChannel }): TaskRecord {
  const { taskId, taskKind } = spec;
  const deps = spec.deps ?? [];
  return {
    taskId, taskKind, status: (spec.status ?? 'succeeded') as TaskRecord['status'],
    attemptCount: 0, maxAttempts: 3,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: deps,
      channel: spec.channel ?? 'code_tool_hook',
      timeoutMs: 300_000,
      inputArtifactRefs: [], outputArtifactRefs: [],
    }),
  };
}

function makeOutput(decision: 'approve_rollout'): RolloutReviewerOutputV1 {
  return {
    taskId: ROLLOUT_ID,
    sourceEvaluatorArtifactId: 'pi-art-eval-pri634',
    review: {
      decision, summary: 'PRI-634', confidence: 0.9,
      requiredChanges: [], rolloutRisks: [], safetyChecks: [],
    },
    sourceTrace: { evaluatorArtifactId: 'pi-art-eval-pri634' },
    risks: [],
    generatedAt: new Date().toISOString(),
  };
}

function validGoldenTrace() {
  const built = buildGoldenTraceFromArtificer({
    cases: [
      { caseId: 'p1', kind: 'positive', toolName: 'edit', params: { path: 'a.ts' }, expectedDecision: 'allow' },
      { caseId: 'n1', kind: 'negative', toolName: 'bash', params: { command: 'rm -rf /' }, expectedDecision: 'block' },
    ],
    sourceArtifactId: 'pi-art-artificer-pri634',
  });
  if (!built.ok) throw new Error(`fixture trace build failed: ${built.reason}`);
  return built.trace;
}

function pseudoCandidateContentJson(): string {
  return JSON.stringify({
    goldenTraceCases: validGoldenTrace().cases,
    affectedTools: ['edit'],
    sourceArtifactId: 'pi-art-artificer-pri634',
  });
}

function validCandidateContentJson(): string {
  const trace = validGoldenTrace();
  return JSON.stringify({
    implementationCode: 'export function evaluate() { return { decision: "allow" }; }',
    goldenTrace: trace,
    goldenTraceCases: trace.cases,
    affectedTools: ['edit'],
    ruleHostGateDecision: 'accepted_shadow',
    sourceArtificerArtifactId: 'pi-art-artificer-pri634',
  });
}

async function makeDeps(opts: {
  ruleContentJson: string;
  ruleArtifactId: string;
  dispatchOutcome?: RolloutAutoDispatchOutcome;
}): Promise<{ deps: RolloutReviewerRunnerDeps; stateManager: Record<string, unknown>; dispatch: ReturnType<typeof vi.fn> }> {
  const rolloutTask = makeTask({ taskId: ROLLOUT_ID, taskKind: 'rollout_reviewer', deps: [EVAL_ID], status: 'pending' });
  const tasks = new Map<string, TaskRecord>([
    [ROLLOUT_ID, rolloutTask],
    [EVAL_ID, makeTask({ taskId: EVAL_ID, taskKind: 'evaluator', deps: [ARTIFICER_REPAIR_ID] })],
    [ARTIFICER_REPAIR_ID, makeTask({ taskId: ARTIFICER_REPAIR_ID, taskKind: 'artificer', deps: [] })],
  ]);

  const artifactStore = new MemoryPIArtifactStore();
  // runner 的 evaluator dep 解析要求 evaluator 名下至少有一个 artifact
  // (真实形态: kind='principle' 的评审输出, 恒 pending —— 见 P0-1 注释)。
  // kind 与被测的 rule 不同,不会干扰候选解析。
  await artifactStore.upsertArtifact({
    artifactId: 'pi-art-eval-pri634',
    artifactKind: 'principle',
    sourceTaskId: EVAL_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify({ evaluation: { decision: 'approved', score: 0.9 } }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await artifactStore.upsertArtifact({
    artifactId: opts.ruleArtifactId,
    artifactKind: 'rule',
    sourceTaskId: ARTIFICER_REPAIR_ID,
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: opts.ruleContentJson,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const stateManager = {
    acquireLease: vi.fn().mockResolvedValue(rolloutTask),
    getTask: vi.fn().mockImplementation((id: string) => Promise.resolve(tasks.get(id) ?? null)),
    getRunsByTask: vi.fn().mockResolvedValue([{ runId: 'run-pri634', taskId: ROLLOUT_ID, runtimeKind: 'rollout_reviewer', startedAt: new Date().toISOString() }]),
    getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({ runs: [{ runId: 'run-pri634', taskId: ROLLOUT_ID, runtimeKind: 'rollout_reviewer', startedAt: new Date().toISOString() }], degradedRuns: [] }),
    updateRunOutput: vi.fn().mockResolvedValue(undefined),
    markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
    markTaskFailed: vi.fn().mockResolvedValue(undefined),
    markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockImplementation(async (id: string, patch: { status?: string }) => {
      // 忠实 store 语义 (read-back invariant): markNeedsHumanReviewOrThrow 依赖
      // updateTask 的效果能被后续 getTask 读到。
      const t = tasks.get(id);
      if (t && typeof patch.status === 'string') {
        (t as Record<string, unknown>).status = patch.status;
      }
      return undefined;
    }),
    updateTaskDiagnosticJson: vi.fn().mockResolvedValue(undefined),
    getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
  } as unknown as Record<string, unknown>;

  const runHandle: RunHandle = { runId: 'run-pri634', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
  const runtimeAdapter = {
    startRun: vi.fn().mockResolvedValue(runHandle),
    pollRun: vi.fn().mockResolvedValue({ status: 'succeeded', runId: 'run-pri634' }),
    fetchOutput: vi.fn().mockResolvedValue({ runId: 'run-pri634', payload: makeOutput('approve_rollout') }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as PDRuntimeAdapter;

  const dispatch = vi.fn().mockResolvedValue(
    opts.dispatchOutcome ?? { decision: 'queued_for_approval', activationId: 'act-pri634' },
  );

  const deps: RolloutReviewerRunnerDeps = {
    stateManager: stateManager as unknown as RuntimeStateManager,
    runtimeAdapter,
    eventEmitter: { emitTelemetry: vi.fn() } as unknown as StoreEventEmitter,
    validator: new DefaultRolloutReviewerValidator(),
    artifactStore,
    dispatchActivation: dispatch,
  };
  return { deps, stateManager, dispatch };
}

function makeRunner(deps: RolloutReviewerRunnerDeps): RolloutReviewerRunner {
  return new RolloutReviewerRunner(deps, { owner: 'pri634-test', runtimeKind: 'test-double', pollIntervalMs: 5, timeoutMs: 5_000 });
}

type ReviewContext = { reasonCode?: string; detail?: string };

function readHumanReviewContext(stateManager: Record<string, unknown>): ReviewContext | null {
  const calls = (stateManager.updateTask as ReturnType<typeof vi.fn>).mock.calls as unknown as [string, { status?: string; diagnosticJson?: string }][];
  for (const [id, patch] of calls) {
    if (id !== ROLLOUT_ID || patch?.status !== 'needs_human_review' || typeof patch.diagnosticJson !== 'string') continue;
    try {
      const parsed = JSON.parse(patch.diagnosticJson) as { pi_metadata?: { humanReviewContext?: ReviewContext } };
      const ctx = parsed.pi_metadata?.humanReviewContext;
      if (ctx) return ctx;
    } catch { /* 非目标写入,继续找 */ }
  }
  return null;
}

function emittedEvents(deps: RolloutReviewerRunnerDeps): { eventType: string; payload: Record<string, unknown> }[] {
  const emitter = deps.eventEmitter as unknown as { emitTelemetry: { mock: { calls: { eventType: string; payload: Record<string, unknown> }[][] } } };
  return emitter.emitTelemetry.mock.calls.map((c) => c[0]).filter((e) => e !== undefined);
}

describe('PRI-634: rollout activation 候选内容契约', () => {
  it('伪候选 (artificer schema 改标 rule+validated) → 不 dispatch,转 needs_human_review 且 detail 说明缺口字段', async () => {
    const { deps, stateManager, dispatch } = await makeDeps({
      ruleContentJson: pseudoCandidateContentJson(),
      ruleArtifactId: PSEUDO_CANDIDATE_ID,
    });
    const result = await makeRunner(deps).run(ROLLOUT_ID);

    expect(result.status).toBe('succeeded');
    // 核心断言: 修复前这里会被调用 (伪候選被放行到 writer 才炸)
    expect(dispatch).not.toHaveBeenCalled();
    expect(stateManager.markTaskSucceeded).not.toHaveBeenCalled();

    const ctx = readHumanReviewContext(stateManager);
    expect(ctx?.reasonCode).toBe('rollout_activation_candidate_unresolved');
    expect(ctx?.detail).toContain(PSEUDO_CANDIDATE_ID);
    expect(ctx?.detail).toContain('goldenTrace');
    expect(ctx?.detail).toContain('ruleHostGateDecision:accepted_shadow');

    const unresolved = emittedEvents(deps).find((e) => e.eventType === 'rollout_activation_candidate_unresolved');
    expect(unresolved).toBeDefined();
    expect(unresolved?.payload.reason).toBe('no_content_valid_candidate_in_lineage');
  });

  it('合法 evaluator assemble 产物 → 正常 dispatch (修复不是一刀切拒所有)', async () => {
    const { deps, stateManager, dispatch } = await makeDeps({
      ruleContentJson: validCandidateContentJson(),
      ruleArtifactId: VALID_CANDIDATE_ID,
    });
    const result = await makeRunner(deps).run(ROLLOUT_ID);

    expect(result.status).toBe('succeeded');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ artifactId: VALID_CANDIDATE_ID, channel: 'code_tool_hook' });
    // 治理 transition 完成 → 正常终态,不进 needs_human_review
    expect(stateManager.markTaskSucceeded).toHaveBeenCalled();
    expect(readHumanReviewContext(stateManager)).toBeNull();
  });

  it('dispatch 被拒 → outcome.reason 透传到 humanReviewContext.detail (PRI-634 根因 C)', async () => {
    const { deps, stateManager } = await makeDeps({
      ruleContentJson: validCandidateContentJson(),
      ruleArtifactId: VALID_CANDIDATE_ID,
      dispatchOutcome: { decision: 'refused', reason: 'no_golden_trace' },
    });
    const result = await makeRunner(deps).run(ROLLOUT_ID);

    expect(result.status).toBe('succeeded');
    const ctx = readHumanReviewContext(stateManager);
    // 修复前 detail 缺失:Owner 只看到规范化 reasonCode,拿不到 no_golden_trace
    expect(ctx?.reasonCode).toBe('rollout_dispatch_refused');
    expect(ctx?.detail).toBe('no_golden_trace');
    expect(stateManager.markTaskSucceeded).not.toHaveBeenCalled();
  });
});
