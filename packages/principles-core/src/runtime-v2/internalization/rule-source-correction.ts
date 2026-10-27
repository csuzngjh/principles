/**
 * rule-source-correction.ts — SPEC-PRI-1047 修复 B: 正式、定点、有界的一次
 * Owner source-correction 恢复。
 *
 * 与相邻预算的边界（一个候选各自独立、互不借用）：
 *   - binding revision（rule-binding-revision.ts）: 修订身份血缘预算，
 *     `reviseRuleBindingOnce`，run4/epoch3 已消耗——本操作不复用其额度；
 *   - runner attempt: 任务内重试（lastValidatorErrors 回喂），不开新 epoch；
 *   - Rule 审批/激活: 治理决策，本操作永不触碰。
 *
 * 语义：当 Artificer 因**源材料缺陷**（textualBasis 不锚定 / 审批依赖漏报）
 * 停在 needs_human_review 且 Scribe 工件因此不可用时，Owner 通过认证入口
 * 授权**一次**源修订：服务端核验候选链、绑定身份、当前工件摘要与停点，
 * 然后以单次 CAS 写原子完成「授权消费 + Scribe 新 epoch 重开」。新 Scribe
 * 成功后由 internalization-orchestrator 的定点分支 CAS 续接原 Artificer
 * （保留原 taskId/依赖，读 MAX(revision_epoch) 新工件），再走既有后继机制
 * 推进 Evaluator——不是普通 retry、撤回重绑或改库。
 *
 * 幂等/并发：cause = `rule-source-correction:<candidateId>:<bindingRevision>`；
 * 相同 cause 重放（双击/并发/崩溃重启换 requestId）→ revision_already_started，
 * 不产生第二次额度；任何已存在的 sourceCorrectionCauseId → 预算耗尽拒绝。
 * 失败核验零写入 = 零消费（EP-03）。
 */
import { createHash } from 'node:crypto';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { CandidateIdentityPort } from './candidate-identity.js';
import {
  resolveRuleBindingRevisionTarget,
} from './rule-binding-revision.js';
import { hydratePITaskRecord, mergePITaskMetadata, createPITaskDiagnosticJson, type SourceCorrectionReceiptV1 } from './pitask-metadata.js';

type Refused = { status: 'refused'; reason: string; nextAction: string };
const refuse = (reason: string, nextAction = 'Inspect the candidate chain, its binding and the Artificer stop point in Console.'): Refused => ({ status: 'refused', reason, nextAction });

/** Artificer 停点 reasonCode 中属于「源材料缺陷」的集合——确因本源材料而停才可修。 */
export const SOURCE_CORRECTION_STOP_REASON_CODES: readonly string[] = ['textual_basis_unanchored', 'approval_dependency_undeclared'];

function sha256Hex(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export interface ReviseRuleSourceOnceArgs {
  readonly stateManager: RuntimeStateManager;
  readonly ledger: CandidateIdentityPort;
  readonly candidateId: string;
  /** 授权必须锚定当前绑定 revision（撤回/失效/换绑 → 拒绝）。 */
  readonly expectedBindingRevision: number;
  /** 服务端独立解析目标；与调用方提名不匹配 → 拒绝（不接受任意 taskId 组合）。 */
  readonly expectedScribeTaskId?: string;
  readonly expectedArtificerTaskId?: string;
  /** 材料未变不重开（不空转调用模型）；摘要与当前 scribe 工件不符 → 拒绝。 */
  readonly expectedScribeArtifactDigest?: string;
  readonly reason: string;
  readonly actor: string;
  readonly requestId: string;
}

export type ReviseRuleSourceOnceResult =
  | { status: 'revision_started' | 'revision_already_started'; scribeTaskId: string; artificerTaskId: string; taskRevisionEpoch: number; causeId: string }
  | Refused;

/**
 * 定位 source-correction 目标：复用 binding revision 的链解析（唯一
 * dreamer→philosopher→scribe、code_tool_hook、前驱 succeeded），再沿依赖
 * 找到唯一以该 scribe 为依赖的 artificer。
 */
async function resolveRuleSourceCorrectionTarget(
  stateManager: RuntimeStateManager,
  candidateId: string,
): Promise<{ status: 'ready'; scribeTaskId: string; artificerTaskId: string } | Refused> {
  const target = await resolveRuleBindingRevisionTarget(stateManager, candidateId);
  if (target.status !== 'ready') return target;
  const tasks = await stateManager.listTasks();
  const artificers = tasks.filter((task) => task.taskKind === 'artificer'
    && (hydratePITaskRecord(task)?.dependencyTaskIds ?? []).includes(target.scribeTaskId));
  if (artificers.length !== 1) return refuse('artificer_lineage_not_unique');
  const [artificer] = artificers;
  if (!artificer) return refuse('artificer_missing');
  return { status: 'ready', scribeTaskId: target.scribeTaskId, artificerTaskId: artificer.taskId };
}

function leaseIsLive(task: { readonly leaseOwner?: string | null; readonly leaseExpiresAt?: string | null }): boolean {
  if (task.leaseOwner === null || task.leaseOwner === undefined) return false;
  return task.leaseExpiresAt ? new Date(task.leaseExpiresAt).getTime() > Date.now() : true;
}

export async function reviseRuleSourceOnce(args: ReviseRuleSourceOnceArgs): Promise<ReviseRuleSourceOnceResult> {
  const { stateManager, ledger, candidateId } = args;
  const target = await resolveRuleSourceCorrectionTarget(stateManager, candidateId);
  if (target.status !== 'ready') return target;
  if (args.expectedScribeTaskId !== undefined && target.scribeTaskId !== args.expectedScribeTaskId) return refuse('scribe_target_mismatch');
  if (args.expectedArtificerTaskId !== undefined && target.artificerTaskId !== args.expectedArtificerTaskId) return refuse('artificer_target_mismatch');

  // 绑定身份核验：resolved + owner_rule_binding + 指定 revision（授权锚定当前绑定）。
  // decisionId 是回执必填字段（读取侧校验非空）——缺失时拒绝（零消费），
  // 绝不写空串把 scribe 的 pi_metadata 变成不可 hydrate 的死元数据。
  const identity = await ledger.resolveForCandidate(candidateId);
  if (identity.status !== 'resolved') return refuse(identity.reason);
  if (identity.basis !== 'owner_rule_binding' || identity.bindingRevision !== args.expectedBindingRevision) return refuse('binding_revision_stale');
  const { decisionId } = identity;
  if (typeof decisionId !== 'string' || decisionId.trim() === '') return refuse('binding_decision_missing');

  // 同 cause 崩溃/双击/换 requestId 重放优先于**一切**后续状态、租约、停点与
  // 摘要判定（镜像 reviseRuleBindingOnce 的顺序约定）：重开已在途、已重开或
  // 下游已推进时，重放必须得到幂等结果，而不是 artificer_not_in_review /
  // task_in_flight / 摘要漂移误拒。
  const scribeTask = await stateManager.getTask(target.scribeTaskId);
  const scribePi = scribeTask ? hydratePITaskRecord(scribeTask) : null;
  if (!scribeTask || !scribePi) return refuse('scribe_missing');
  const causeId = `rule-source-correction:${candidateId}:${args.expectedBindingRevision}`;
  if (scribePi.sourceCorrectionCauseId === causeId || scribePi.revisionCauseId === causeId) {
    return { status: 'revision_already_started', scribeTaskId: scribeTask.taskId, artificerTaskId: target.artificerTaskId, taskRevisionEpoch: scribePi.revisionCount ?? 0, causeId };
  }
  // 一次源修订上限：该候选已消费过任何 source-correction 额度 → 拒绝（不因
  // 新 requestId/重绑/崩溃重启获得第二次额度）。
  if (scribePi.sourceCorrectionCauseId !== undefined) return refuse('source_correction_budget_exhausted');

  // Artificer 停点核验：确因本源材料而停（材料缺陷 reasonCode），活租约拒绝。
  const artificerTask = await stateManager.getTask(target.artificerTaskId);
  const artificerPi = artificerTask ? hydratePITaskRecord(artificerTask) : null;
  if (!artificerTask || !artificerPi) return refuse('artificer_missing');
  if (artificerTask.status !== 'needs_human_review') return refuse(`artificer_not_in_review_${artificerTask.status}`);
  const stopReasonCode = artificerPi.humanReviewContext?.reasonCode ?? '';
  if (!SOURCE_CORRECTION_STOP_REASON_CODES.includes(stopReasonCode)) {
    return refuse(`stop_reason_not_source_material:${stopReasonCode || 'none'}`);
  }
  if (leaseIsLive(artificerTask)) return refuse('artificer_lease_present');

  if (scribeTask.status !== 'succeeded' && scribeTask.status !== 'needs_human_review') return refuse(`task_in_flight_${scribeTask.status}`);
  if (leaseIsLive(scribeTask)) return refuse('task_lease_present');
  const artifacts = await stateManager.piArtifactStore.listBySourceTaskId(target.scribeTaskId);
  const [currentArtifact] = artifacts;
  if (!currentArtifact) return refuse('scribe_artifact_missing');
  const currentDigest = sha256Hex(currentArtifact.contentJson);
  if (args.expectedScribeArtifactDigest !== undefined && currentDigest !== args.expectedScribeArtifactDigest) return refuse('scribe_artifact_changed');

  const receipt: SourceCorrectionReceiptV1 = {
    version: 1,
    candidateId,
    scribeTaskId: scribeTask.taskId,
    artificerTaskId: target.artificerTaskId,
    sourceArtifactId: currentArtifact.artifactId,
    sourceArtifactDigest: currentDigest,
    bindingRevision: args.expectedBindingRevision,
    decisionId,
    expectedStopReasonCode: stopReasonCode,
    reason: args.reason,
    actor: args.actor,
    requestId: args.requestId,
    consumedAt: new Date().toISOString(),
    status: 'consumed',
  };
  const metadata = mergePITaskMetadata(scribePi, {
    runnerDecision: undefined,
    completionIntent: undefined,
    revisionCount: (scribePi.revisionCount ?? 0) + 1,
    revisionCauseId: causeId,
    sourceCorrectionCauseId: causeId,
    sourceCorrectionReceipt: receipt,
    revisionFeedback: `Owner authorized one source-correction revision for this candidate: the Artificer stopped with '${stopReasonCode}' because the previous draft's executionConditions textualBasis was not anchored in the Owner-attributed material. Re-issue the draft and copy each required fact's textualBasis as ONE CONTINUOUS original sentence from the Owner-attributed evidence (no citation labels, no added quotes, no ellipsis-omitted reconstruction). Preserve prior artifacts and the bound identity.`,
  });
  // 单次 CAS 写 = 授权消费 + Scribe 重开原子完成（失败零消费）。attemptCount
  // 归零但 maxAttempts 原值不动——新 epoch 沿用原配置上限，不追加预算。
  const reopened = await stateManager.updateTaskIfDiagnosticJsonUnchanged(scribeTask.taskId, scribeTask.diagnosticJson ?? null, {
    diagnosticJson: createPITaskDiagnosticJson(metadata),
    status: 'pending',
    attemptCount: 0,
    ...(scribeTask.leaseOwner || scribeTask.leaseExpiresAt ? { leaseOwner: null, leaseExpiresAt: null } : {}),
  }, {
    expectedStatus: scribeTask.status,
    expectedAttemptCount: scribeTask.attemptCount,
    expectedMaxAttempts: scribeTask.maxAttempts,
    expectedLeaseOwner: scribeTask.leaseOwner ?? null,
    expectedLeaseExpiresAt: scribeTask.leaseExpiresAt ?? null,
  });
  if (!reopened) {
    const concurrent = await stateManager.getTask(scribeTask.taskId);
    const concurrentPi = concurrent ? hydratePITaskRecord(concurrent) : null;
    if (concurrentPi && concurrentPi.sourceCorrectionCauseId === causeId) {
      return { status: 'revision_already_started', scribeTaskId: scribeTask.taskId, artificerTaskId: target.artificerTaskId, taskRevisionEpoch: concurrentPi.revisionCount ?? 0, causeId };
    }
    return refuse('source_correction_snapshot_stale');
  }
  const fresh = await stateManager.getTask(scribeTask.taskId);
  return {
    status: 'revision_started',
    scribeTaskId: scribeTask.taskId,
    artificerTaskId: target.artificerTaskId,
    taskRevisionEpoch: fresh ? hydratePITaskRecord(fresh)?.revisionCount ?? 0 : 0,
    causeId,
  };
}
