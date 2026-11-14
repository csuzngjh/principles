/**
 * PD-BEHAVIOR-FIDELITY-001 Gate 2 — semantic-fidelity regression suite.
 *
 * Live failure this file is built around (E2E Round 3, 2026-11-13):
 *   pain_host_93dea665… → candidate 408fe3a1 → scribe artifact
 *   pi-art-scribe-408fe3a1-…-prompt_1 → rollout_reviewer-408fe3a1 →
 *   principle 1b9b7b4d (approved + activated).
 *
 * Facts taken verbatim from the R3 workspace state.db (`pi_artifacts`):
 *   - the Scribe's statement ended with "低风险、可逆的小变更可简化此流程。"
 *     — an exemption traceable to the Philosopher's RISK NOTE, never to the
 *     Owner's text ("不对，你刚才没有任何实测依据就修改了参数。");
 *   - the Scribe DID disclose it in ownerRequirementGaps;
 *   - the Reviewer READ both, wrote in its own summary that the exemption
 *     "可能在执行中被 agent 过宽解释而绕过证据门禁", and still returned
 *     decision=approve_rollout with requiredChanges=[].
 *
 * Gate 2 splits the work: the Reviewer's prompt must dispose of each gap
 * (an implemented exemption is not approvable; a disclosure-only gap does not
 * block), while the validator only rejects self-contradictions —
 * approve_rollout with requiredChanges, and needs_revision without any. The
 * strict R3 candidate (ae5d9b57 / principle eb45c848) must stay approvable, and
 * a faithful artifact that merely discloses a non-applied narrowing must stay
 * approvable too — a deterministic "non-empty gaps forbids approval" rule was
 * measured in Gate 4 to over-block exactly that case.
 */
import { describe, it, expect, vi } from 'vitest';
import { DefaultRolloutReviewerValidator } from '../rollout-reviewer-output.js';
import { RolloutReviewerRunner } from '../rollout-reviewer-runner.js';
import {
  buildScribeProtocolInstruction,
  SCRIBE_PROMPT_CONTRACT_VERSION,
} from '../scribe-prompt-builder.js';
import { ROLLOUT_REVIEWER_PRINCIPLE_SEMANTIC_INSTRUCTION } from '../rollout-reviewer-prompt-builder.js';
import { MemoryPIArtifactStore } from '../pi-artifact-store.js';
import { MemoryTaskStore } from '../../store/task/memory-task-store.js';
import { createPITaskDiagnosticJson, type PITaskMetadata } from '../pitask-metadata.js';
import type { TaskRecord } from '../../task-status.js';
import { fencedStateManager as fenced } from '../../__tests__/fixtures/fenced-state-manager.js';

/** R3 宽松谱系（candidate 408fe3a1）的 Scribe 产物原文 —— 逐字取自 R3 state.db。 */
const R3_LOOSE_SCRIBE_ARTIFACT = JSON.stringify({
  executionConditions: {
    requiredFacts: [{ factKind: 'observable_evidence_available', required: true, textualBasis: '不对，你刚才没有任何实测依据就修改了参数。' }],
    version: 1,
  },
  generatedAt: '2026-11-13T15:04:43.373Z',
  intentContract: {
    evidenceSource: 'Owner 纠正原话：“不对，你刚才没有任何实测依据就修改了参数。”',
    forbiddenBehavior: '在上下文中不存在可引用的测量数据、日志或状态验证输出的情况下，仅凭推断或“尽快帮助”的偏好直接执行有后果的参数或状态修改',
    ownerIntent: '防止 AI 在没有任何实测依据的情况下直接修改系统参数，任何有后果的变更必须先建立可观察证据。',
    targetBehavior: '在执行参数或状态修改类工具调用前，检查上下文中是否已有可引用的实测依据；若缺失，先进行测量或取证并向 Owner 说明，再执行变更；变更后对比实际结果与预期并持久化决策依据',
    validationExpectation: '评估者应检查工具调用轨迹：每次有后果的变更前必须存在被引用的可观察证据或一次先行的测量/取证动作；变更后应有结果对比与记录。',
  },
  ownerRequirementGaps: [
    'Owner 表达的是“参数修改必须有实测依据”，主要针对写/变更操作；本原则对低风险、可逆、只读类操作允许简化流程，属对原文的适用性收窄，已通过 risks 与 applicability 声明',
  ],
  principleDraft: {
    antiPatterns: ['在没有任何实测依据的情况下直接修改参数或系统状态'],
    applicability: ['执行参数修改、配置变更或其他有后果的状态修改类工具调用之前'],
    confidence: 0.85,
    rationale: '根因是在“尽快帮助”的偏好下跳过了证据门槛。',
    statement: '执行任何有后果的参数、配置或状态修改前，必须先引用可观察证据（测量数据、日志或验证输出）；证据缺失时先取证并向 Owner 说明，不得凭推断变更状态；变更后对比实际结果与预期并持久化依据。低风险、可逆的小变更可简化此流程。',
    title: '证据先于变更：以可观察证据为门禁的有后果修改',
  },
  risks: ['取证本身有成本，对低风险、可逆的小变更应允许简化流程，否则规则会被绕过或失效'],
  sourcePhilosopherArtifactId: 'pi-art-philosopher-408fe3a1-8761-4a67-8b3d-b7f9ded308c7-prompt-run_philosopher-408fe3a1-8761-4a67-8b3d-b7f9ded308c7-prompt_1',
  sourceTrace: {
    dreamerArtifactId: 'pi-art-dreamer-408fe3a1-8761-4a67-8b3d-b7f9ded308c7-prompt-run_dreamer-408fe3a1-8761-4a67-8b3d-b7f9ded308c7-prompt_1',
    philosopherArtifactId: 'pi-art-philosopher-408fe3a1-8761-4a67-8b3d-b7f9ded308c7-prompt-run_philosopher-408fe3a1-8761-4a67-8b3d-b7f9ded308c7-prompt_1',
  },
  taskId: 'scribe-408fe3a1-8761-4a67-8b3d-b7f9ded308c7-prompt',
});

/** R3 严格谱系（candidate ae5d9b57 / principle eb45c848）的 Scribe 产物原文。 */
const R3_STRICT_SCRIBE_ARTIFACT = JSON.stringify({
  executionConditions: {
    requiredFacts: [{ factKind: 'design_approval', required: true, textualBasis: '以后改配置参数前，先说明依据和影响，等我确认后再动手。' }],
    version: 1,
  },
  generatedAt: '2026-11-13T15:29:31.690Z',
  intentContract: {
    evidenceSource: 'Owner 纠正文本（sessionId=065d318b-8f1e-43db-82b6-a76a53cb5ba3，turnIndex=2）',
    forbiddenBehavior: '在缺少数据依据且未获确认的情况下，依据自身推断直接落地有后果的配置参数变更',
    ownerIntent: '防止代理在无数据支撑时未经确认直接落地有后果的配置参数改动；Owner 明确要求改配置前先说明依据和影响、等确认后再动手。',
    targetBehavior: '在执行任何配置参数等有后果变更前，代理先输出变更依据与预期影响说明，请求 Owner 确认；确认前只采取可逆或暂缓路径，不直接落地。',
    validationExpectation: '评估者应要求看到：变更前的依据与影响说明记录、Owner 确认记录，或证据不足以确认时代理仅执行可逆/暂缓动作。',
  },
  principleDraft: {
    antiPatterns: ['在无数据依据时依据自身推断直接落地激进配置改动'],
    applicability: ['配置参数变更', '有后果的写操作'],
    confidence: 0.85,
    rationale: '根因是 Owner 的确认要求未被转化为不可绕过的执行门禁。',
    statement: '对配置参数等有后果的变更，执行前必须先陈述数据依据与预期影响并获 Owner 确认；无法确认时只允许可逆或暂缓路径，不得直接落地。',
    title: '确认门禁优先：有后果变更先陈述依据、经确认后落地，默认可逆',
  },
  risks: ['确认门禁可能在紧急修复场景引入延迟，需定义明确的豁免条件'],
  sourcePhilosopherArtifactId: 'pi-art-philosopher-ae5d9b57-f0bd-40f1-b050-2c952f8482b2-prompt-run_philosopher-ae5d9b57-f0bd-40f1-b050-2c952f8482b2-prompt_2',
  sourceTrace: {
    philosopherArtifactId: 'pi-art-philosopher-ae5d9b57-f0bd-40f1-b050-2c952f8482b2-prompt-run_philosopher-ae5d9b57-f0bd-40f1-b050-2c952f8482b2-prompt_2',
  },
  taskId: 'scribe-ae5d9b57-f0bd-40f1-b050-2c952f8482b2-prompt',
});

const SCRIBE_ARTIFACT_ID = 'pi-art-scribe-408fe3a1-8761-4a67-8b3d-b7f9ded308c7-prompt-run_scribe-408fe3a1-8761-4a67-8b3d-b7f9ded308c7-prompt_1';
const ROLLOUT_TASK_ID = 'rollout_reviewer-408fe3a1-8761-4a67-8b3d-b7f9ded308c7-prompt';
const SCRIBE_TASK_ID = 'scribe-408fe3a1-8761-4a67-8b3d-b7f9ded308c7-prompt';
const RUN_ID = 'run-fidelity-1';

/** R3 真实 Reviewer 判定的等价形状：看见了缺口，仍然 approve 且无 requiredChanges。 */
function r3ReviewerOutput(overrides: { decision?: string; requiredChanges?: string[]; gapsAcknowledged?: boolean } = {}) {
  const decision = overrides.decision ?? 'approve_rollout';
  return {
    taskId: ROLLOUT_TASK_ID,
    sourceScribeArtifactId: SCRIBE_ARTIFACT_ID,
    review: {
      decision,
      summary: overrides.gapsAcknowledged === false
        ? '该原则忠实反映诊断证据，可安全上线。'
        : 'statement 末句「低风险、可逆的小变更可简化此流程」为对 Owner 原文意图的收窄，虽已通过 ownerRequirementGaps 和 risks 声明，但「低风险、可逆」缺少判定标准，可能在执行中被 agent 过宽解释而绕过证据门禁；鉴于这是收窄而非扩张（不会误伤合法行为），判定可安全上线并持续观察。',
      confidence: 0.87,
      requiredChanges: overrides.requiredChanges ?? [],
      rolloutRisks: ['「低风险、可逆的小变更」缺少可操作判定标准，可能被过宽解释以绕过证据门禁'],
      safetyChecks: ['上线初期观察 agent 是否以「低风险可逆」为由跳过证据门禁'],
    },
    sourceTrace: { scribeArtifactId: SCRIBE_ARTIFACT_ID },
    risks: ['「低风险、可逆」判定标准缺失可能导致门禁被规避'],
    generatedAt: '2026-11-13T15:10:00.000Z',
  };
}

describe('DefaultRolloutReviewerValidator — principle_semantic fidelity gate', () => {
  const validator = new DefaultRolloutReviewerValidator();
  const opts = {
    expectedSourceArtifactId: SCRIBE_ARTIFACT_ID,
    reviewMode: 'principle_semantic' as const,
  };

  it('strict R3 candidate (no gap, no requiredChanges) stays approvable — no blanket block', async () => {
    const result = await validator.validate(r3ReviewerOutput() as never, ROLLOUT_TASK_ID, opts);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  // Gate-4 regression: a faithful principle MAY carry ownerRequirementGaps
  // (e.g. "the narrowing was NOT applied", "rule-code gate is a pipeline
  // proposal, not an Owner requirement"). A deterministic "non-empty gaps
  // forbids approval" rule was measured to over-block exactly that artifact,
  // so gap semantics stay with the Reviewer and only self-contradictions are
  // enforced here. The runner-level test below proves the artifact path: a
  // gap-declaring scribe artifact + clean approve still dispatches.

  it('approve_rollout with non-empty requiredChanges is a self-contradiction', async () => {
    const result = await validator.validate(
      r3ReviewerOutput({ requiredChanges: ['从 statement 中删除「低风险、可逆的小变更可简化此流程」'] }) as never,
      ROLLOUT_TASK_ID,
      opts,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('contradicts a non-empty review.requiredChanges');
  });

  it('needs_revision without requiredChanges is not actionable', async () => {
    const result = await validator.validate(
      r3ReviewerOutput({ decision: 'needs_revision', requiredChanges: [] }) as never,
      ROLLOUT_TASK_ID,
      opts,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('requires at least one concrete review.requiredChanges');
  });

  it('needs_revision that names the fix is valid', async () => {
    const result = await validator.validate(
      r3ReviewerOutput({
        decision: 'needs_revision',
        requiredChanges: ['删除 statement 末句未经 Owner 授权的豁免，或由 Owner 显式决定是否接受该收窄'],
      }) as never,
      ROLLOUT_TASK_ID,
      opts,
    );
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('code_chain contract is unchanged (gap gate is principle_semantic only)', async () => {
    const codeOutput = {
      taskId: 'rollout-code-1',
      sourceEvaluatorArtifactId: 'pi-art-eval-1',
      review: {
        decision: 'approve_rollout', summary: 's', confidence: 0.9,
        requiredChanges: ['still fine on the code contract'], rolloutRisks: [], safetyChecks: [],
      },
      sourceTrace: { evaluatorArtifactId: 'pi-art-eval-1' },
      risks: [],
      generatedAt: '2026-11-13T00:00:00.000Z',
    };
    const result = await validator.validate(codeOutput as never, 'rollout-code-1', {
      expectedSourceArtifactId: 'pi-art-eval-1',
      reviewMode: 'code_chain',
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });
});

// ── prompt contract: the two generation surfaces carry the fidelity rules ─────

describe('fidelity prompt contracts', () => {
  it('Scribe prompt is v10 and carries the STATEMENT FIDELITY block', () => {
    expect(SCRIBE_PROMPT_CONTRACT_VERSION).toBe('scribe-output-v1.prompt.v10');
    const instruction = buildScribeProtocolInstruction();
    expect(instruction).toContain('STATEMENT FIDELITY');
    expect(instruction).toContain('Exception must be Owner-grounded');
    // The exact R3 failure shape: a risk note must not become a statement exemption.
    expect(instruction).toContain('is NOT authorization');
    expect(instruction).toContain('Preserve mandatory Owner actions');
    expect(instruction).toContain('A disclosed gap must not silently reappear');
    expect(instruction).toContain('Read-only is not a write exemption');
  });

  it('principle semantic reviewer prompt carries the gap-disposition rule', () => {
    // The implemented-exemption case is the R3 failure and must be named.
    expect(ROLLOUT_REVIEWER_PRINCIPLE_SEMANTIC_INSTRUCTION).toContain('implemented exemption');
    expect(ROLLOUT_REVIEWER_PRINCIPLE_SEMANTIC_INSTRUCTION).toContain('is NOT approvable');
    // …while a disclosure-only gap must stay approvable (measured Gate-4 over-block).
    expect(ROLLOUT_REVIEWER_PRINCIPLE_SEMANTIC_INSTRUCTION).toContain('was NOT applied');
    expect(ROLLOUT_REVIEWER_PRINCIPLE_SEMANTIC_INSTRUCTION).toContain('does not block approval');
    expect(ROLLOUT_REVIEWER_PRINCIPLE_SEMANTIC_INSTRUCTION).toContain('decision, summary and requiredChanges MUST agree');
    expect(ROLLOUT_REVIEWER_PRINCIPLE_SEMANTIC_INSTRUCTION).toContain('needs_revision MUST carry at least one concrete requiredChange');
    // Review follow-up: CONSTRAINTS must not tell the model that
    // requiredChanges "can be empty" unconditionally. `needs_revision` + `[]`
    // is an output_invalid PERMANENT category (no retry), so the constraint has
    // to be decision-dependent or it kills the candidate outright.
    expect(ROLLOUT_REVIEWER_PRINCIPLE_SEMANTIC_INSTRUCTION).toContain('whose contents follow the decision');
    expect(ROLLOUT_REVIEWER_PRINCIPLE_SEMANTIC_INSTRUCTION).toContain('approve_rollout or reject → empty array');
    expect(ROLLOUT_REVIEWER_PRINCIPLE_SEMANTIC_INSTRUCTION).toContain('needs_revision → at least one concrete semantic fix');
  });
});

// ── production wiring: a self-contradicting approve never dispatches ──────────

function meta(overrides: Partial<PITaskMetadata> = {}): PITaskMetadata {
  return {
    dependencyTaskIds: [SCRIBE_TASK_ID],
    channel: 'prompt',
    timeoutMs: 300_000,
    inputArtifactRefs: [],
    outputArtifactRefs: [],
    ...overrides,
  };
}

function task(taskId: string, taskKind: string, opts: { status: TaskRecord['status']; m: PITaskMetadata }): TaskRecord {
  return {
    taskId, taskKind, status: opts.status, attemptCount: 0, maxAttempts: 3,
    createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z',
    diagnosticJson: createPITaskDiagnosticJson(opts.m),
  };
}

describe('RolloutReviewerRunner — self-contradicting approve never dispatches', () => {
  function harness(scribeArtifactJson: string, reviewerOutput: unknown = r3ReviewerOutput()) {
    const artifacts = new MemoryPIArtifactStore();
    void artifacts.upsertArtifact({
      artifactId: SCRIBE_ARTIFACT_ID, artifactKind: 'principle', sourceTaskId: SCRIBE_TASK_ID,
      lineageArtifactIds: [], validationStatus: 'pending', contentJson: scribeArtifactJson,
      createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z',
    });
    const store = new MemoryTaskStore();
    void store.createTask({ ...task(ROLLOUT_TASK_ID, 'rollout_reviewer', { status: 'pending', m: meta() }) });
    void store.createTask({ ...task(SCRIBE_TASK_ID, 'scribe', { status: 'succeeded', m: meta({ dependencyTaskIds: [] }) }) });
    const runs = new Map([
      [RUN_ID, { runId: RUN_ID, taskId: ROLLOUT_TASK_ID, runtimeKind: 'rollout_reviewer', outputPayload: '{}' }],
    ]);
    const dispatchActivation = vi.fn().mockResolvedValue({ decision: 'activated', activationId: 'act-1', reason: null });
    const stateManager = fenced({
      piArtifactStore: artifacts,
      async acquireLease() { return store.getTask(ROLLOUT_TASK_ID); },
      async getTask(id: string) { return store.getTask(id); },
      async listTasks() { return [] as TaskRecord[]; },
      async getRunsByTask(id: string) { return [...runs.values()].filter((r) => r.taskId === id); },
      async updateTask(id: string, patch: Parameters<MemoryTaskStore['updateTask']>[1]) { return store.updateTask(id, patch); },
      async updateTaskDiagnosticJson(id: string, json: string) { await store.updateTask(id, { diagnosticJson: json }); },
      async updateRunOutput() { /* no-op in memory harness */ },
      async markTaskSucceeded(id: string, resultRef: string) { await store.updateTask(id, { status: 'succeeded', resultRef }); },
      async markTaskFailed(id: string, lastError: TaskRecord['lastError']) { await store.updateTask(id, { status: 'failed' as const, lastError }); },
      getRetryPolicy: () => ({ shouldRetry: () => false }),
    });
    const runtimeAdapter = {
      startRun: vi.fn().mockResolvedValue({ runId: RUN_ID }),
      pollRun: vi.fn().mockResolvedValue({ status: 'succeeded' }),
      fetchOutput: vi.fn().mockResolvedValue({ payload: reviewerOutput }),
      cancelRun: vi.fn(),
    };
    const eventEmitter = { emitTelemetry: vi.fn() };
    const runner = new RolloutReviewerRunner(
      {
        stateManager: stateManager,
        runtimeAdapter: runtimeAdapter as never,
        eventEmitter: eventEmitter as never,
        artifactStore: artifacts,
        validator: new DefaultRolloutReviewerValidator(),
        dispatchActivation,
        reopenRevisionTarget: vi.fn().mockResolvedValue({ ok: true, reason: 'reopened' }),
      },
      { owner: 'test', runtimeKind: 'rollout_reviewer' },
    );
    return { runner, dispatchActivation, artifacts, stateManager, eventEmitter };
  }

  it('approve_rollout with requiredChanges (the R3 self-contradiction) → task fails, no dispatch', async () => {
    const h = harness(
      R3_LOOSE_SCRIBE_ARTIFACT,
      r3ReviewerOutput({ requiredChanges: ['移除 statement 末句未经 Owner 授权的豁免'] }),
    );
    const result = await h.runner.run(ROLLOUT_TASK_ID);
    expect(result.status).toBe('failed');
    expect(String(result.failureReason)).toContain('contradicts a non-empty review.requiredChanges');
    expect(h.dispatchActivation).not.toHaveBeenCalled();
    expect((await h.artifacts.getArtifactById(SCRIBE_ARTIFACT_ID))?.validationStatus).toBe('pending');
    const events = h.eventEmitter.emitTelemetry.mock.calls.map((c) => (c[0] as { eventType: string }).eventType);
    expect(events).toContain('rollout_reviewer_output_invalid');
  });

  it('strict artifact + clean approve output → unchanged happy path (dispatch happens)', async () => {
    const h = harness(R3_STRICT_SCRIBE_ARTIFACT);
    const result = await h.runner.run(ROLLOUT_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(h.dispatchActivation).toHaveBeenCalledTimes(1);
    expect((await h.artifacts.getArtifactById(SCRIBE_ARTIFACT_ID))?.validationStatus).toBe('validated');
  });

  it('R3 loose artifact (declares ownerRequirementGaps) + clean approve → succeeds and dispatches', async () => {
    // This is the behavior the old validator-level test claimed but could not
    // prove: it passed a reviewer output built from the same gap-free fixture
    // and the validator never sees the artifact. Here the gap-declaring scribe
    // artifact is the real runner input, so re-introducing a deterministic
    // "non-empty gaps forbids approval" gate would fail this test.
    const h = harness(R3_LOOSE_SCRIBE_ARTIFACT, r3ReviewerOutput());
    const result = await h.runner.run(ROLLOUT_TASK_ID);
    expect(result.status).toBe('succeeded');
    expect(h.dispatchActivation).toHaveBeenCalledTimes(1);
    expect((await h.artifacts.getArtifactById(SCRIBE_ARTIFACT_ID))?.validationStatus).toBe('validated');
  });
});
