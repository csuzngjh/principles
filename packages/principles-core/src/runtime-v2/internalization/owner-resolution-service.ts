/**
 * owner-resolution-service.ts — PRI-629 Owner 裁决的应用层（Console/CLI 共用）。
 *
 * 职责: 校验 reviewKey（stale 防护）→ CAS 写入 OwnerResolutionRecord →
 * 按动作分派:
 *   - accept_current / reject_current (verdict override): 写 pending resolution
 *     并把任务原子翻回 pending（保留 runnerDecision/completionIntent — 与
 *     owner-retry 的 authority reset 相反）;实际效果由 runner 的入口恢复门
 *     在 LLM 之前应用（SPEC §10: pending Owner Resolution 优先于 pending
 *     Completion Intent 优先于 normal LLM invocation）。
 *   - revise_once: 解析修订目标 → 以 resolution-scoped causeId reopen
 *     （幂等）→ 标 applied。不开自动预算,repairIteration 不变（SPEC §11）。
 *
 * 并发语义（SPEC §7）: same reviewKey + same action → idempotent success;
 * same reviewKey + different action → already_resolved;全部经
 * updateTaskIfDiagnosticJsonUnchanged 单 SQL conditional mutation。
 */

import { createHash } from 'node:crypto';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { TaskRecord } from '../task-status.js';
import {
  hydratePITaskRecord,
  createPITaskDiagnosticJson,
  mergePITaskMetadata,
  type OwnerResolutionAction,
  type OwnerResolutionRecord,
  type RunnerDecision,
} from './pitask-metadata.js';
import {
  collectOwnerDecisionFacts,
  deriveOwnerDecisionCapability,
  effectiveDecisionFor,
  findOwnerResolutionForCurrentEpoch,
  type OwnerDecisionFactStore,
} from './owner-review.js';
import {
  buildOwnerDecisionReview,
  type OwnerDecisionReviewStore,
} from './owner-decision-review.js';
import { reopenTaskForRevision, resolveRolloutRevisionTarget } from './revision-reopen.js';

const CAS_ATTEMPTS = 3;
const OWNER_INSTRUCTION_MAX_CHARS = 500;

export interface OwnerResolutionRequest {
  readonly action: OwnerResolutionAction;
  readonly reviewKey: string;
  readonly expectedRevisionEpoch: number;
  readonly expectedSourceRunId: string;
  readonly expectedSourceArtifactId: string;
  readonly expectedSourceArtifactHash: string;
  /** Required by the Console v1.2 route; optional only for pre-v1.2 internal callers. */
  readonly expectedEvidenceDigest?: string;
  readonly acknowledgement?: {
    readonly kind: 'partial_evidence';
    readonly acknowledged: true;
    readonly note?: string;
  };
  readonly ownerInstruction?: string | null;
}

export interface OwnerIdentityContext {
  readonly ownerId: string;
  readonly credentialId?: string;
}

export type OwnerResolutionOutcome =
  | {
      status: 'resolved';
      resolutionId: string;
      reviewKey: string;
      action: OwnerResolutionAction;
      applied: boolean;
      effectiveDecision?: RunnerDecision;
      targetTaskId?: string;
      /** verdict override 动作: 任务已翻回 pending,由 runner 入口恢复门应用 */
      runnerWillApply: boolean;
    }
  | { status: 'not_found' }
  | { status: 'metadata_invalid' }
  | { status: 'not_decision_capable'; blockers: readonly string[] }
  | { status: 'stale_owner_decision' }
  | { status: 'evidence_acknowledgement_required' }
  | { status: 'already_resolved'; existingAction: OwnerResolutionAction }
  | { status: 'cas_conflict' }
  | { status: 'revise_target_unresolved' }
  | { status: 'revise_reopen_failed'; reason: string };

export interface OwnerResolutionApplyDeps {
  readonly stateManager: RuntimeStateManager;
  readonly now?: () => string;
  /** 注入以便测试替换；生产为 revision-reopen.ts 的核心实现 */
  readonly reopenTaskForRevision?: typeof reopenTaskForRevision;
}

/** RuntimeStateManager → OwnerDecisionFactStore 的窄适配（pi artifacts 经专用 store）。 */
export function factStoreFromStateManager(stateManager: RuntimeStateManager): OwnerDecisionFactStore {
  return {
    getTask: (taskId) => stateManager.getTask(taskId),
    listArtifactsBySourceTask: async (taskId) => {
      const artifacts = await stateManager.piArtifactStore.listBySourceTaskId(taskId);
      return artifacts.map((a) => ({
        artifactId: a.artifactId,
        artifactKind: a.artifactKind,
        validationStatus: a.validationStatus,
        contentJson: a.contentJson,
        sourceTaskId: a.sourceTaskId,
        lineageArtifactIds: a.lineageArtifactIds,
        createdAt: a.createdAt,
      }));
    },
  };
}

export function reviewStoreFromStateManager(stateManager: RuntimeStateManager): OwnerDecisionReviewStore {
  return {
    ...factStoreFromStateManager(stateManager),
    getArtifactById: async (artifactId) => {
      const artifact = await stateManager.piArtifactStore.getArtifactById(artifactId);
      return artifact ? {
        artifactId: artifact.artifactId,
        artifactKind: artifact.artifactKind,
        validationStatus: artifact.validationStatus,
        contentJson: artifact.contentJson,
        sourceTaskId: artifact.sourceTaskId,
        lineageArtifactIds: artifact.lineageArtifactIds,
        createdAt: artifact.createdAt,
      } : null;
    },
  };
}

/** revise_once 可选短指导的有界消毒（SPEC §13）— 仅作 revision feedback，非命令。 */
export function sanitizeOwnerInstruction(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  // 控制字符替换为空格；截断到有界长度；空串 → undefined。
  // eslint-disable-next-line no-control-regex -- 剥离控制字符正是本函数的目的（消毒不可信输入）
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, OWNER_INSTRUCTION_MAX_CHARS);
}

/** reviewKey → 确定性 resolutionId（同 reviewKey 重放天然同 id）。 */
function resolutionIdFor(reviewKey: string): string {
  return `ores_${createHash('sha256').update(reviewKey, 'utf8').digest('hex').slice(0, 20)}`;
}

function resolvedOutcome(
  record: OwnerResolutionRecord,
  applied: boolean,
  _now: () => string,
): OwnerResolutionOutcome {
  return {
    status: 'resolved',
    resolutionId: record.resolutionId,
    reviewKey: record.reviewKey,
    action: record.action,
    applied,
    ...(record.effectiveDecision !== undefined ? { effectiveDecision: record.effectiveDecision } : {}),
    ...(record.targetTaskId !== undefined ? { targetTaskId: record.targetTaskId } : {}),
    runnerWillApply: record.action !== 'revise_once' && !applied,
  };
}

async function resolveReviseTarget(
  deps: OwnerResolutionApplyDeps,
  piTask: NonNullable<ReturnType<typeof hydratePITaskRecord>>,
): Promise<{ taskId: string } | null> {
  if (!piTask) return null;
  if (piTask.taskKind === 'evaluator') {
    // 最新 repair Artificer = 当前依赖链上的 artificer（budget 耗尽的那轮）
    for (const depId of piTask.dependencyTaskIds) {
      const dep = await deps.stateManager.getTask(depId);
      if (dep?.taskKind === 'artificer') return { taskId: dep.taskId };
    }
    return null;
  }
  const target = await resolveRolloutRevisionTarget(
    (id) => deps.stateManager.getTask(id),
    piTask.taskId,
    piTask.channel ?? 'prompt',
  );
  return target ? { taskId: target.taskId } : null;
}

/**
 * revise_once 的驱动/恢复：reopen（causeId 幂等）→ 标 applied。
 * reopen 失败 → 回滚 pending 记录（恢复上一个 diagnosticJson），Owner 可重试。
 */
async function rollbackPendingResolution(
  stateManager: RuntimeStateManager,
  taskId: string,
  resolutionId: string,
): Promise<void> {
  const raw = await stateManager.getTask(taskId);
  const piTask = raw ? hydratePITaskRecord(raw) : null;
  if (!piTask?.ownerResolutions) return;
  const filtered = piTask.ownerResolutions.filter((r) => r.resolutionId !== resolutionId);
  if (filtered.length === piTask.ownerResolutions.length) return;
  await stateManager.updateTaskIfDiagnosticJsonUnchanged(
    taskId, raw?.diagnosticJson ?? null,
    {
      diagnosticJson: createPITaskDiagnosticJson(mergePITaskMetadata(piTask, { ownerResolutions: filtered })),
    },
  );
}

interface DriveReviseOnceArgs {
  readonly deps: OwnerResolutionApplyDeps;
  readonly reopen: typeof reopenTaskForRevision;
  readonly taskId: string;
  readonly taskWithRecord: TaskRecord;
  readonly record: OwnerResolutionRecord;
  readonly now: () => string;
}

async function driveReviseOnce(args: DriveReviseOnceArgs): Promise<OwnerResolutionOutcome> {
  const { deps, taskId, record, now, reopen } = args;
  const { stateManager } = deps;
  const {targetTaskId} = record;
  const causeId = record.targetRevisionCauseId ?? `owner-res-${record.resolutionId}`;
  if (!targetTaskId) {
    return { status: 'revise_target_unresolved' };
  }

  const reopenOutcome = await reopen(stateManager, targetTaskId, {
    revisionCauseId: causeId,
    revisionFeedback: record.ownerInstruction,
    reason: 'owner_revise_once',
  });
  if (!reopenOutcome.ok) {
    await rollbackPendingResolution(stateManager, taskId, record.resolutionId);
    return { status: 'revise_reopen_failed', reason: reopenOutcome.reason };
  }

  // reopen 已 materialize → 标 applied（CAS;失败由重放收敛）
  const fresh = await stateManager.getTask(taskId);
  const freshPi = fresh ? hydratePITaskRecord(fresh) : null;
  if (freshPi?.ownerResolutions) {
    const updatedRecords = freshPi.ownerResolutions.map((r) =>
      r.resolutionId === record.resolutionId
        ? { ...r, status: 'applied' as const, appliedAt: now() }
        : r);
    const nextMeta = mergePITaskMetadata(freshPi, { ownerResolutions: updatedRecords });
    const updated = await stateManager.updateTaskIfDiagnosticJsonUnchanged(
      taskId, fresh?.diagnosticJson ?? null, { diagnosticJson: createPITaskDiagnosticJson(nextMeta) },
    );
    if (updated) {
      return {
        status: 'resolved',
        resolutionId: record.resolutionId,
        reviewKey: record.reviewKey,
        action: record.action,
        applied: true,
        targetTaskId,
        runnerWillApply: false,
      };
    }
  }
  // applied 标记写失败 — reopen 幂等,重放会补标记
  return {
    status: 'resolved',
    resolutionId: record.resolutionId,
    reviewKey: record.reviewKey,
    action: record.action,
    applied: false,
    targetTaskId,
    runnerWillApply: false,
  };
}


/**
 * 应用一次 Owner 裁决。全程幂等、crash-safe：
 *   - verdict override: authority 记录（pending）与 status 翻转在同一次 CAS
 *     mutation 中落库；crash 后重放 = idempotent success；实际效果由 runner
 *     恢复门执行（不重新调用 LLM，SPEC §30）。
 *   - revise_once: pending 记录 → reopen（causeId 幂等）→ applied；任一步
 *     crash 后重放收敛到同一结果。
 */
export interface ApplyOwnerResolutionArgs {
  readonly taskId: string;
  readonly request: OwnerResolutionRequest;
  readonly identity: OwnerIdentityContext;
}

export async function applyOwnerResolution(
  deps: OwnerResolutionApplyDeps,
  args: ApplyOwnerResolutionArgs,
): Promise<OwnerResolutionOutcome> {
  const { taskId, request, identity } = args;
  const now = deps.now ?? (() => new Date().toISOString());
  const reopen = deps.reopenTaskForRevision ?? reopenTaskForRevision;
  const { stateManager } = deps;

  // 1) Fresh durable facts + capability（不信任请求体中的任何事实断言）。
  const facts = await collectOwnerDecisionFacts(factStoreFromStateManager(stateManager), taskId);
  if (!facts) {
    const raw = await stateManager.getTask(taskId);
    if (!raw) return { status: 'not_found' };
    return { status: 'metadata_invalid' };
  }
  const capability = deriveOwnerDecisionCapability(facts);
  const review = request.expectedEvidenceDigest !== undefined
    ? await buildOwnerDecisionReview(reviewStoreFromStateManager(stateManager), taskId)
    : null;
  const existingForEpoch = findOwnerResolutionForCurrentEpoch(facts.task);
  if (!capability.eligible && !existingForEpoch) {
    return { status: 'not_decision_capable', blockers: capability.blockers };
  }
  // P1 评审修复 (SPEC §9): 服务端强制 allowedActions——UI 隐藏不够,直接调
  // API 也不得提交 allowedActions 之外的动作 (治理状态完整性)。幂等重放
  // (已存在同 reviewKey resolution) 不受此限——重复同一动作仍返回 resolved。
  if (!existingForEpoch && !capability.allowedActions.includes(request.action)) {
    return {
      status: 'not_decision_capable',
      blockers: [`action_not_permitted:${request.action}`],
    };
  }
  if (!existingForEpoch && request.expectedEvidenceDigest !== undefined) {
    if (!review || review.evidence.digest !== request.expectedEvidenceDigest) {
      return { status: 'stale_owner_decision' };
    }
    if (!review.capability.finalOfferedActions.includes(request.action)) {
      return {
        status: 'not_decision_capable',
        blockers: [`action_not_permitted_by_evidence:${request.action}`],
      };
    }
    if (request.action === 'accept_current'
      && review.capability.acceptRequirement.kind === 'acknowledge_partial_evidence'
      && request.acknowledgement?.kind !== 'partial_evidence') {
      return { status: 'evidence_acknowledgement_required' };
    }
  }

  // 2) Stale 防护 (SPEC §6/§28): 服务端重读 durable facts,逐字段比对请求的
  //    expected* 断言 + 重算 reviewKey。任一变化 → 409 stale — Owner 只能
  //    批准自己实际看到的那个版本。已存在同 reviewKey resolution 的
  //    idempotent 重放放行到 CAS 段处理。
  if (!existingForEpoch || existingForEpoch.reviewKey !== request.reviewKey) {
    const artifact = facts.decisionArtifact;
    const freshRunId = facts.task.humanReviewContext?.sourceRunId
      ?? facts.task.completionIntent?.sourceRunId ?? '';
    const stale = capability.reviewKey !== request.reviewKey
      || (facts.task.revisionCount ?? 0) !== request.expectedRevisionEpoch
      || freshRunId !== request.expectedSourceRunId
      || artifact?.artifactId !== request.expectedSourceArtifactId
      || artifact?.contentHash !== request.expectedSourceArtifactHash;
    if (stale) {
      return { status: 'stale_owner_decision' };
    }
  }

  // 3) CAS 段
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const raw = await stateManager.getTask(taskId);
    if (!raw) return { status: 'not_found' };
    const piTask = hydratePITaskRecord(raw);
    if (!piTask) return { status: 'metadata_invalid' };

    const existing = findOwnerResolutionForCurrentEpoch(piTask);
    if (existing) {
      if (existing.reviewKey !== request.reviewKey) {
        // 同 epoch 已被另一个事实快照的裁决占用 — 冲突。
        return { status: 'already_resolved', existingAction: existing.action };
      }
      if (existing.action !== request.action) {
        return { status: 'already_resolved', existingAction: existing.action };
      }
      if (request.expectedEvidenceDigest !== undefined
        && existing.evidenceDigest !== request.expectedEvidenceDigest) {
        return { status: 'stale_owner_decision' };
      }
      // same reviewKey + same action — idempotent
      if (existing.status === 'applied') {
        return resolvedOutcome(existing, true, now);
      }
      // pending 同动作:
      if (request.action === 'revise_once') {
        return await driveReviseOnce({ deps, reopen, taskId, taskWithRecord: raw, record: existing, now });
      }
      // verdict override pending — 任务应已翻回 pending,等 runner 恢复门应用
      return resolvedOutcome(existing, false, now);
    }

    if (piTask.status !== 'needs_human_review') {
      return { status: 'not_decision_capable', blockers: [`task_status_${piTask.status}`] };
    }

    // 首次写入
    const reviewKey = capability.reviewKey ?? request.reviewKey;
    let record: OwnerResolutionRecord = {
      resolutionId: resolutionIdFor(reviewKey),
      reviewKey,
      action: request.action,
      status: 'pending',
      ownerId: identity.ownerId,
      ...(identity.credentialId !== undefined ? { credentialId: identity.credentialId } : {}),
      decidedAt: now(),
      sourceRunId: request.expectedSourceRunId,
      sourceArtifactId: request.expectedSourceArtifactId,
      sourceArtifactHash: request.expectedSourceArtifactHash,
      revisionEpoch: piTask.revisionCount ?? 0,
      machineDecision: piTask.runnerDecision ?? 'needs_revision',
      ...(request.action !== 'revise_once'
        ? { effectiveDecision: effectiveDecisionFor(piTask.taskKind, request.action) }
        : {}),
      ...(request.action === 'revise_once'
        ? { ownerInstruction: sanitizeOwnerInstruction(request.ownerInstruction) }
        : {}),
      ...(request.expectedEvidenceDigest !== undefined && review
        ? {
            evidenceDigest: request.expectedEvidenceDigest,
            evidenceManifest: review.evidence.manifest,
            ...(request.acknowledgement !== undefined
              ? { evidenceAcknowledgement: request.acknowledgement }
              : {}),
          }
        : {}),
    };

    if (request.action === 'revise_once') {
      const target = await resolveReviseTarget(deps, piTask);
      if (!target) {
        return { status: 'revise_target_unresolved' };
      }
      record = { ...record, targetTaskId: target.taskId, targetRevisionCauseId: `owner-res-${record.resolutionId}` };
      const nextMeta = mergePITaskMetadata(piTask, {
        ownerResolutions: [...(piTask.ownerResolutions ?? []), record],
      });
      const updated = await stateManager.updateTaskIfDiagnosticJsonUnchanged(
        taskId, raw.diagnosticJson ?? null, { diagnosticJson: createPITaskDiagnosticJson(nextMeta) },
      );
      if (!updated) continue; // CAS 冲突 → 重读重试
      return await driveReviseOnce({ deps, reopen, taskId, taskWithRecord: updated, record, now });
    }

    // verdict override: resolution + status 翻转同一 mutation
    const nextMeta = mergePITaskMetadata(piTask, {
      ownerResolutions: [...(piTask.ownerResolutions ?? []), record],
    });
    const updated = await stateManager.updateTaskIfDiagnosticJsonUnchanged(
      taskId, raw.diagnosticJson ?? null,
      {
        status: 'pending',
        attemptCount: 0,
        diagnosticJson: createPITaskDiagnosticJson(nextMeta),
      },
    );
    if (!updated) continue;
    return resolvedOutcome(record, false, now);
  }
  return { status: 'cas_conflict' };
}
