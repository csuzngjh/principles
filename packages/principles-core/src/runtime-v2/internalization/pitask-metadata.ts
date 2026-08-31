/**
 * PITaskMetadata — Persistence & Hydration (PRI-65)
 *
 * Provides the core-owned serialization/hydration contract for PITaskRecord metadata.
 *
 * Problem: PITaskRecord extends TaskRecord with internalization fields
 * (dependencyTaskIds, channel, timeoutMs, inputArtifactRefs, outputArtifactRefs),
 * but SqliteTaskStore only persists base TaskRecord fields + diagnostic_json.
 * There is no second task store — PI metadata must travel inside diagnosticJson.
 *
 * Solution: Store PI metadata in diagnosticJson using a namespaced JSON envelope.
 * This module provides:
 *   - serializePITaskMetadata  (PITaskMetadata → JSON string for diagnosticJson)
 *   - parsePITaskMetadata      (JSON string → PITaskMetadata | null, fail closed)
 *   - hydratePITaskRecord      (TaskRecord from store → PITaskRecord | null, fail closed)
 *   - createPITaskDiagnosticJson (alias for serialize, explicit name for adapter use)
 *
 * Design principles:
 *   - All functions are pure / total — no exceptions thrown
 *   - Fail closed: invalid/missing data → null, not error
 *   - Optional fields (parentTaskId, correlationId) must be non-empty string if present
 *   - Namespaced key avoids collision with other diagnosticJson uses
 *
 * @see ADR-0003 Section 3.4
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 */

import type { TaskRecord } from '../task-status.js';
import type {
  PITaskRecord,
  InternalizationChannel,
  ArtifactRef,
} from './peer-runner-contracts.js';
import { isInternalizationChannel, isRunnerKind } from './peer-runner-contracts.js';

/** Namespace key used inside diagnosticJson to isolate PI metadata. */
export const PI_METADATA_KEY = 'pi_metadata' as const;

/**
 * Evaluator repair payload (PRI-509).
 *
 * Carries the evaluator's structured feedback when decision === 'needs_revision'
 * so the seeded artificer repair task can address each required change instead
 * of regenerating blind. The metadata layer treats this as opaque; the
 * ArtificerRunner.buildContext reads it and constructs a pre-formatted
 * repairFeedback string for the prompt builder.
 *
 * Lineage (rc-6):
 *   - sourceArtificerArtifactId: the prior artificer artifact that was rejected
 *   - sourceEvaluatorTaskId: the evaluator task that returned needs_revision
 *
 * Loop state freshness (rc-7, EP-05, ERR-015/018/019):
 *   - repairIteration is written at task creation time, never inferred at read.
 *   - Round 1 = first repair (after initial evaluator needs_revision).
 *   - Round 2 = second repair (after first repair's evaluator needs_revision).
 *   - Max 2 rounds; a 3rd needs_revision fails loud via needs_human_review (EP-03).
 */
export interface RepairPayload {
  readonly requiredChanges: readonly string[];
  readonly concerns: readonly string[];
  readonly previousScore: number;
  readonly repairIteration: number;
  readonly sourceArtificerArtifactId: string;
  readonly sourceEvaluatorTaskId: string;
}

/**
 * 人工裁决上下文 (PRI-629): 任务进入 needs_human_review 时与 status 同一次
 * task-row mutation 原子落库的"为什么找人"事实。classification (owner_decision
 * vs recovery) 由此派生;缺失 = legacy 任务,由 collectOwnerDecisionFacts 按
 * durable facts 推断,模糊 → recovery (fail closed)。
 */
export interface HumanReviewContext {
  /** 结构化原因码 (HumanReviewReasonCode;解析接受任意非空串以保持前向兼容) */
  readonly reasonCode: string;
  /** 产出待裁决 verdict 的 run */
  readonly sourceRunId: string;
  /** 该 run 的决策输出 artifact (evaluator/rollout 输出 artifact id) */
  readonly sourceArtifactId?: string;
  /** sourceArtifactId 内容的 sha256 hex — Owner decision 的 stale 防护输入 */
  readonly sourceArtifactHash?: string;
  /** 进入 needs_human_review 时的 revisionEpoch (= 当时 revisionCount) */
  readonly revisionEpoch: number;
  /**
   * PRI-634: 规范 reasonCode 之外的可诊断细节（面向 Owner 展示）。
   * 例：dispatch 被拒的具体 outcome.reason、候选解析被内容契约筛掉的产物清单。
   * 不参与 buildOwnerReviewKey —— 后者只绑定 7 个稳定事实，新增本字段不影响
   * 已有 pending resolution 的匹配。
   */
  readonly detail?: string;
  readonly createdAt: string;
}

/**
 * Owner 裁决动作 (PRI-629)。accept_current/reject_current 是 verdict override
 * (写 effectiveDecision,不改 runnerDecision);revise_once 授权一个额外
 * revision epoch (不开自动预算,repairIteration 不变)。
 */
export type OwnerResolutionAction = 'accept_current' | 'revise_once' | 'reject_current';

export type OwnerResolutionStatus = 'pending' | 'applied';

/**
 * task-scoped Owner authority log (PRI-629)。不是第二状态源: 它只记录 Owner
 * 对某个人工裁决事实快照 (reviewKey) 的决定;effective decision 的唯一解析点
 * 是 resolveEffectiveRunnerDecision (owner-review.ts)。append-only: 保留历史
 * resolution,不覆盖;同一 reviewKey 至多一条 (CAS 写入保证)。
 */
export interface OwnerResolutionRecord {
  readonly resolutionId: string;
  /** 绑定裁决事实快照的稳定 hash — POST 时服务端重读 durable facts 重算比对 */
  readonly reviewKey: string;
  readonly action: OwnerResolutionAction;
  readonly status: OwnerResolutionStatus;
  /** 服务端 auth context 推导的身份 (console token / operator_legacy) */
  readonly ownerId: string;
  readonly credentialId?: string;
  readonly decidedAt: string;
  readonly appliedAt?: string;
  readonly sourceRunId: string;
  readonly sourceArtifactId: string;
  readonly sourceArtifactHash: string;
  readonly revisionEpoch: number;
  /** 机器原始判定 — 永久保留 (INV-03 machine verdict immutability) */
  readonly machineDecision: RunnerDecision;
  /** 仅 verdict override 动作有;revise_once 无 (新 epoch 由新 verdict 产生) */
  readonly effectiveDecision?: RunnerDecision;
  /** 仅 revise_once: 被 reopen 的修订目标任务 */
  readonly targetTaskId?: string;
  /** 仅 revise_once: reopen 使用的 epoch-aware causeId */
  readonly targetRevisionCauseId?: string;
  /** 仅 revise_once: 有界、已消毒的短指导 (仅作 revision feedback) */
  readonly ownerInstruction?: string;
}

/**
 * PI-specific metadata stored inside TaskRecord.diagnosticJson.
 * All fields must be present except parentTaskId and correlationId (optional).
 */
export interface PITaskMetadata {
  dependencyTaskIds: string[];
  channel: InternalizationChannel;
  timeoutMs: number;
  inputArtifactRefs: ArtifactRef[];
  outputArtifactRefs: ArtifactRef[];
  parentTaskId?: string;
  correlationId?: string;
  rejectionCount?: number;
  /**
   * Prior adversarial replay failures to inject into a Round-2+ Artificer
   * prompt (RuleHost MVP, PRI-428). Set by runAdversarialLoop when a prior
   * Evaluator round returned needs_revision. Treated as opaque text by
   * the metadata layer; the ArtificerRunner forwards it to the prompt builder.
   */
  adversarialFeedback?: string;
  /**
   * Evaluator repair payload (PRI-509). Present only on artificer tasks seeded
   * by evaluator needs_revision. Carries the structured feedback
   * (requiredChanges/concerns/previousScore/repairIteration) so the artificer
   * can address each required change. Undefined on Round-1 artificer tasks.
   */
  repairPayload?: RepairPayload;
  /**
   * Runner 判定(evaluator / rollout_reviewer 的 LLM 决策),由 runner 在
   * succeedTask 收尾时写入。commitNextTaskProposal 依据它做单一迁移决策
   * (MVP_CORE_LOOP_CONTRACT INV-02: needs_revision 不得同时 seed 正常后继)。
   */
  runnerDecision?: RunnerDecision;
  /**
   * 该任务被 revision reopen 的次数(每次 reopen +1)。revision 有界性的
   * 一部分: 配合 rolloutRevisionPayload.revisionIteration / repairIteration
   * 构成 lineage 级 revision budget。
   */
  revisionCount?: number;
  /**
   * Rollout reviewer needs_revision 时注入到被 reopen 修订目标的反馈
   * (scribe / artificer 的 prompt 侧注入,由各 runner buildContext 消费)。
   */
  revisionFeedback?: string;
  /**
   * P0-4 revision identity: 触发本次 reopen 的稳定 cause 标识
   * (如 `repair-<repairTaskId>` / `rollout-<rolloutTaskId>-r<iteration>`)。
   * reopenTaskForRevision 对相同 causeId 的重放是真正 no-op。
   */
  revisionCauseId?: string;
  /**
   * Rollout reviewer needs_revision 的修订路由载荷: 记录修订目标 stage、
   * 迭代号与来源,保证 revision budget 可判定 (MVP_CORE_LOOP_CONTRACT INV-07)。
   */
  rolloutRevisionPayload?: RolloutRevisionPayload;
  /**
   * P0 (verdict drift): 一次 LLM verdict 的 durable completion intent。
   *
   * 与 runnerDecision 在同一次 metadata 写入中落库 (原子): intent 存在且
   * status='pending' ⇒ 该 verdict 的治理 transition 尚未完成。同一
   * execution epoch 内 crash/retry/restart 重跑时,run() 入口必须 RESUME
   * 该 intent (跳过 LLM,幂等重放 effects),禁止让新的 LLM 输出覆盖它
   * —— LLM 非确定性下,重问可能产生 approve/reject 漂移,与已发生的
   * side effect (activation / repair seed / validation) 形成治理矛盾。
   *
   * epoch 语义: revisionEpoch = 落库时的 revisionCount。真正的 revision
   * reopen 会递增 revisionCount 并清空本字段 (新 epoch 允许新 verdict);
   * epoch 不匹配的残留 intent 视为 stale,不得 resume。
   */
  completionIntent?: RunnerCompletionIntent;
  /**
   * PRI-629: 进入 needs_human_review 的结构化上下文 (与 status 原子同写)。
   * classification / capability / reviewKey 的权威输入;缺失 = legacy。
   */
  humanReviewContext?: HumanReviewContext;
  /**
   * PRI-629: task-scoped Owner 裁决 log (append-only,同一 reviewKey 至多一条)。
   * 不是状态源 — effective decision 由 resolveEffectiveRunnerDecision 唯一解析。
   */
  ownerResolutions?: readonly OwnerResolutionRecord[];
}

/** evaluator / rollout_reviewer 的合法 runner 决策值 */
export type RunnerDecision =
  | 'approved'
  | 'needs_revision'
  | 'rejected'
  | 'approve_rollout'
  | 'reject';

const RUNNER_DECISIONS: ReadonlySet<string> = new Set([
  'approved', 'needs_revision', 'rejected', 'approve_rollout', 'reject',
]);

/**
 * 一次 verdict completion 的 durable intent (P0 verdict drift 修复)。
 * effectPayload 语义按 decision 分派:
 *   - needs_revision (rollout): revisionIteration = 本次 completion 的修订轮号
 *     (record 时由已 APPLIED 的 rolloutRevisionPayload 计出并锁定,resume
 *     据此继续同一轮,消除"applied 载荷属于上一轮还是本轮"的歧义);
 *   - 其余 decision: 无 effect 载荷。
 */
export interface RunnerCompletionIntent {
  readonly decision: RunnerDecision;
  /** 产出该 verdict 的 run — resume 时从其 outputPayload 恢复已验证输出 */
  readonly sourceRunId: string;
  /** 落库时任务的 revisionCount — 同 epoch 才允许 resume */
  readonly revisionEpoch: number;
  readonly status: 'pending' | 'applied';
  readonly revisionIteration?: number;
  /**
   * P0-A (completion-intent 完整性): 该 completion 的效果类型。
   * - 'governance_transition' (缺省): 正常治理 transition (dispatch /
   *   revision routing / repair seed / validation),由 runner 的 effects 执行;
   * - 'needs_human_review': 终态人工裁决效果 (rollout budget exhausted 等)
   *   — crash resume 必须继续该效果 (重写 needs_human_review),禁止重问 LLM。
   */
  readonly effect?: 'governance_transition' | 'needs_human_review';
}

/** rollout needs_revision 的修订路由载荷 */
export interface RolloutRevisionPayload {
  readonly requiredChanges: readonly string[];
  readonly revisionIteration: number;
  readonly sourceRolloutTaskId: string;
  readonly sourceArtifactId: string;
  readonly targetTaskKind: 'scribe' | 'artificer';
  /**
   * B (最终复核) intent 状态机:
   * - 'pending': intent 已持久化,transition 尚未 materialize — crash/retry/
   *   restart 必须继续执行同一 iteration N,禁止自动 N+1;
   * - 'applied': reopen 已 materialize — 只有新的 needs_revision verdict 才
   *   能 N→N+1;budget 按 APPLIED 计数,不按 intent 写入次数计。
   * - undefined: 旧形状 (本状态机引入前) — 兼容视为 'applied'。
   */
  readonly status?: 'pending' | 'applied';
}

// ── Serialization ──────────────────────────────────────────────────────────────

/**
 * Serialize PITaskMetadata into a JSON string suitable for TaskRecord.diagnosticJson.
 * Uses a namespaced envelope: { "pi_metadata": { ... } }
 */
export function serializePITaskMetadata(metadata: PITaskMetadata): string {
  return JSON.stringify({
    [PI_METADATA_KEY]: {
      dependencyTaskIds: metadata.dependencyTaskIds,
      channel: metadata.channel,
      timeoutMs: metadata.timeoutMs,
      inputArtifactRefs: metadata.inputArtifactRefs,
      outputArtifactRefs: metadata.outputArtifactRefs,
      parentTaskId: metadata.parentTaskId,
      correlationId: metadata.correlationId,
      rejectionCount: metadata.rejectionCount,
      adversarialFeedback: metadata.adversarialFeedback,
      repairPayload: metadata.repairPayload,
      runnerDecision: metadata.runnerDecision,
      revisionCount: metadata.revisionCount,
      revisionFeedback: metadata.revisionFeedback,
      revisionCauseId: metadata.revisionCauseId,
      rolloutRevisionPayload: metadata.rolloutRevisionPayload,
      completionIntent: metadata.completionIntent,
      humanReviewContext: metadata.humanReviewContext,
      ownerResolutions: metadata.ownerResolutions,
    },
  });
}

/** Alias for serializePITaskMetadata — explicit name for adapter/consumer use. */
export const createPITaskDiagnosticJson = serializePITaskMetadata;

/**
 * 从已 hydrate 的 PITaskRecord 重建可写 PITaskMetadata,浅覆盖指定字段。
 *
 * 单一重建点 (DRY): evaluator/rollout 的 verdict 记录、修订路由记录、
 * orchestrator 的 revision reopen 共用同一字段搬运逻辑——此前 4 处手写
 * 逐字段 spread,新增字段时容易漏抄 (Phase 3.5 consolidation)。
 * 注意: overrides 中显式 undefined 会覆盖为 undefined (serialize 时省略键),
 * 用于"清除旧 verdict"语义。
 */
export function mergePITaskMetadata(base: PITaskRecord, overrides: Partial<PITaskMetadata>): PITaskMetadata {
  return {
    dependencyTaskIds: base.dependencyTaskIds,
    channel: base.channel,
    timeoutMs: base.timeoutMs,
    inputArtifactRefs: base.inputArtifactRefs,
    outputArtifactRefs: base.outputArtifactRefs,
    parentTaskId: base.parentTaskId,
    correlationId: base.correlationId,
    rejectionCount: base.rejectionCount,
    adversarialFeedback: base.adversarialFeedback,
    repairPayload: base.repairPayload,
    runnerDecision: base.runnerDecision,
    revisionCount: base.revisionCount,
    revisionFeedback: base.revisionFeedback,
    revisionCauseId: base.revisionCauseId,
    rolloutRevisionPayload: base.rolloutRevisionPayload,
    completionIntent: base.completionIntent,
    humanReviewContext: base.humanReviewContext,
    ownerResolutions: base.ownerResolutions,
    ...overrides,
  };
}

// ── ArtifactRef validation ─────────────────────────────────────────────────────

/**
 * Validates a value is a valid ArtifactRef { artifactType: string, ref: string }.
 * artifactType is accepted as any string — runtime validation of PIArtifactKind
 * is the caller's responsibility when creating the record.
 */
function isValidArtifactRef(value: unknown): value is ArtifactRef {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.artifactType === 'string' && r.artifactType.trim() !== '' &&
    typeof r.ref === 'string' && r.ref.trim() !== '';
}

/**
 * Validates a value is a valid RepairPayload (PRI-509).
 *
 * Trust boundary (rc-1, rc-2): repairPayload originates from evaluator LLM
 * output persisted into diagnosticJson. Treat as unknown and validate every
 * field before returning. No `as` casts that bypass validation.
 *
 * Validation rules:
 *   - requiredChanges: non-empty array of non-empty strings (rc-4)
 *   - concerns: array of non-empty strings (can be empty)
 *   - previousScore: finite number
 *   - repairIteration: positive integer, upper bound of 2 (rc-3 fail-closed
 *     at the trust boundary — the documented contract is "max 2 rounds"; a
 *     payload with repairIteration: 3 must be rejected here rather than
 *     relying on the runtime caller's priorRepairIteration >= 2 check)
 *   - sourceArtificerArtifactId: non-empty string
 *   - sourceEvaluatorTaskId: non-empty string
 */
function isValidRepairPayload(value: unknown): value is RepairPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  // rc-4: validate array elements are non-empty strings.
  if (!Array.isArray(p.requiredChanges) || p.requiredChanges.length === 0) return false;
  for (const c of p.requiredChanges) {
    if (typeof c !== 'string' || c.trim() === '') return false;
  }
  if (!Array.isArray(p.concerns)) return false;
  for (const c of p.concerns) {
    if (typeof c !== 'string' || c.trim() === '') return false;
  }
  if (typeof p.previousScore !== 'number' || !Number.isFinite(p.previousScore)) return false;
  // rc-3: enforce the documented max-2-rounds contract at the trust boundary.
  // repairIteration must be a positive integer in [1, 2]; reject 3+ here so
  // a malformed payload cannot bypass the runtime caller's max-iteration guard.
  if (typeof p.repairIteration !== 'number'
    || !Number.isInteger(p.repairIteration)
    || p.repairIteration < 1
    || p.repairIteration > 2) return false;
  if (typeof p.sourceArtificerArtifactId !== 'string' || p.sourceArtificerArtifactId.trim() === '') return false;
  if (typeof p.sourceEvaluatorTaskId !== 'string' || p.sourceEvaluatorTaskId.trim() === '') return false;
  return true;
}

const OWNER_RESOLUTION_ACTIONS: ReadonlySet<string> = new Set(['accept_current', 'revise_once', 'reject_current']);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Trust boundary (rc-1/rc-2): humanReviewContext 从 diagnosticJson (DB 行) 读回,
 * 按未知值逐字段校验。reasonCode 接受任意非空串 (前向兼容: 分类侧对未知码
 * fail closed 到 recovery),结构性损坏则整体 fail closed。
 */
function isValidHumanReviewContext(value: unknown): value is HumanReviewContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  if (!isNonEmptyString(c.reasonCode)) return false;
  if (!isNonEmptyString(c.sourceRunId)) return false;
  if (c.sourceArtifactId !== undefined && !isNonEmptyString(c.sourceArtifactId)) return false;
  if (c.sourceArtifactHash !== undefined && !isNonEmptyString(c.sourceArtifactHash)) return false;
  if (typeof c.revisionEpoch !== 'number' || !Number.isInteger(c.revisionEpoch) || c.revisionEpoch < 0) return false;
  if (!isNonEmptyString(c.createdAt)) return false;
  return true;
}

/**
 * Trust boundary (rc-1/rc-2/rc-4): ownerResolutions 是治理 authority log,
 * 每条记录逐字段严格校验;resolutionId / reviewKey 在数组内必须唯一 (重复 =
 * authority 腐坏,fail closed 整条 metadata,禁止静默取第一条)。
 */
function isValidOwnerResolutions(value: unknown): value is readonly OwnerResolutionRecord[] {
  if (!Array.isArray(value)) return false;
  const seenResolutionIds = new Set<string>();
  const seenReviewKeys = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
    const r = item as Record<string, unknown>;
    if (!isNonEmptyString(r.resolutionId) || !isNonEmptyString(r.reviewKey)) return false;
    if (typeof r.action !== 'string' || !OWNER_RESOLUTION_ACTIONS.has(r.action)) return false;
    if (r.status !== 'pending' && r.status !== 'applied') return false;
    if (!isNonEmptyString(r.ownerId)) return false;
    if (r.credentialId !== undefined && !isNonEmptyString(r.credentialId)) return false;
    if (!isNonEmptyString(r.decidedAt)) return false;
    if (r.appliedAt !== undefined && !isNonEmptyString(r.appliedAt)) return false;
    if (!isNonEmptyString(r.sourceRunId)) return false;
    if (!isNonEmptyString(r.sourceArtifactId)) return false;
    if (!isNonEmptyString(r.sourceArtifactHash)) return false;
    if (typeof r.revisionEpoch !== 'number' || !Number.isInteger(r.revisionEpoch) || r.revisionEpoch < 0) return false;
    if (typeof r.machineDecision !== 'string' || !RUNNER_DECISIONS.has(r.machineDecision)) return false;
    if (r.effectiveDecision !== undefined
      && (typeof r.effectiveDecision !== 'string' || !RUNNER_DECISIONS.has(r.effectiveDecision))) return false;
    if (r.targetTaskId !== undefined && !isNonEmptyString(r.targetTaskId)) return false;
    if (r.targetRevisionCauseId !== undefined && !isNonEmptyString(r.targetRevisionCauseId)) return false;
    if (r.ownerInstruction !== undefined && !isNonEmptyString(r.ownerInstruction)) return false;
    if (seenResolutionIds.has(r.resolutionId) || seenReviewKeys.has(r.reviewKey)) return false;
    seenResolutionIds.add(r.resolutionId);
    seenReviewKeys.add(r.reviewKey);
  }
  return true;
}

// ── Parsing ─────────────────────────────────────────────────────────────────────

/**
 * Parse a diagnosticJson string into PITaskMetadata.
 * Returns null on any parse/validation failure (fail closed).
 *
 * Validation rules:
 *   - Must be valid JSON
 *   - Must contain pi_metadata key with all required fields
 *   - channel must be a valid InternalizationChannel
 *   - parentTaskId / correlationId if present must be non-empty strings
 */
export function parsePITaskMetadata(diagnosticJson: string): PITaskMetadata | null {
  // Guard: must be non-empty string after trim
  const trimmed = diagnosticJson.trim();
  if (!trimmed) return null;

  let parsed: Record<string, unknown>;  
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rawMeta = parsed[PI_METADATA_KEY];
  if (!rawMeta || typeof rawMeta !== 'object' || rawMeta === null || Array.isArray(rawMeta)) return null;

  const m = rawMeta as Record<string, unknown>;

  // Required fields
  if (!Array.isArray(m.dependencyTaskIds)) return null;
  for (const id of m.dependencyTaskIds) {
    if (typeof id !== 'string') return null;
  }
  if (typeof m.channel !== 'string') return null;
  if (!isInternalizationChannel(m.channel)) return null;
  if (typeof m.timeoutMs !== 'number') return null;
  if (!Number.isFinite(m.timeoutMs) || m.timeoutMs <= 0) return null;
  if (!Array.isArray(m.inputArtifactRefs)) return null;
  if (!Array.isArray(m.outputArtifactRefs)) return null;

  // Validate each ArtifactRef element
  for (const ref of m.inputArtifactRefs) {
    if (!isValidArtifactRef(ref)) return null;
  }
  for (const ref of m.outputArtifactRefs) {
    if (!isValidArtifactRef(ref)) return null;
  }

  // Optional fields: if present, must be non-empty strings (null is not accepted)
  if (Object.hasOwn(m, 'parentTaskId') && m.parentTaskId !== undefined) {
    if (typeof m.parentTaskId !== 'string') return null;
    if (m.parentTaskId.trim() === '') return null;
  }
  if (Object.hasOwn(m, 'correlationId') && m.correlationId !== undefined) {
    if (typeof m.correlationId !== 'string') return null;
    if (m.correlationId.trim() === '') return null;
  }

  let rejectionCount = 0;
  if (Object.hasOwn(m, 'rejectionCount') && m.rejectionCount !== undefined) {
    if (typeof m.rejectionCount !== 'number' || !Number.isFinite(m.rejectionCount) || m.rejectionCount < 0) return null;
    rejectionCount = Math.floor(m.rejectionCount);
  }

  // adversarialFeedback (PRI-428): optional, non-empty string if present.
  if (Object.hasOwn(m, 'adversarialFeedback') && m.adversarialFeedback !== undefined) {
    if (typeof m.adversarialFeedback !== 'string') return null;
    if (m.adversarialFeedback.trim() === '') return null;
  }

  // repairPayload (PRI-509): optional, must pass full validation if present.
  // rc-3: if the key is present but the value is malformed, fail loud (return null)
  // rather than silently dropping the field — the caller will see a null metadata
  // and treat the task as non-PI, which surfaces the corruption.
  let repairPayload: RepairPayload | undefined;
  if (Object.hasOwn(m, 'repairPayload') && m.repairPayload !== undefined) {
    if (!isValidRepairPayload(m.repairPayload)) return null;
    ({ repairPayload } = m);
  }

  // runnerDecision (transition control, INV-02): optional literal union.
  if (Object.hasOwn(m, 'runnerDecision') && m.runnerDecision !== undefined) {
    if (typeof m.runnerDecision !== 'string' || !RUNNER_DECISIONS.has(m.runnerDecision)) return null;
  }

  // revisionCount: optional non-negative integer.
  if (Object.hasOwn(m, 'revisionCount') && m.revisionCount !== undefined) {
    if (typeof m.revisionCount !== 'number' || !Number.isInteger(m.revisionCount) || m.revisionCount < 0) return null;
  }

  // revisionFeedback / revisionCauseId: optional non-empty strings.
  if (Object.hasOwn(m, 'revisionFeedback') && m.revisionFeedback !== undefined) {
    if (typeof m.revisionFeedback !== 'string' || m.revisionFeedback.trim() === '') return null;
  }
  if (Object.hasOwn(m, 'revisionCauseId') && m.revisionCauseId !== undefined) {
    if (typeof m.revisionCauseId !== 'string' || m.revisionCauseId.trim() === '') return null;
  }

  // rolloutRevisionPayload: optional, full validation (rc-1/rc-4).
  let rolloutRevisionPayload: RolloutRevisionPayload | undefined;
  if (Object.hasOwn(m, 'rolloutRevisionPayload') && m.rolloutRevisionPayload !== undefined) {
    const p = m.rolloutRevisionPayload;
    if (typeof p !== 'object' || p === null || Array.isArray(p)) return null;
    const r = p as Record<string, unknown>;
    if (!Array.isArray(r.requiredChanges) || r.requiredChanges.length === 0) return null;
    for (const c of r.requiredChanges) {
      if (typeof c !== 'string' || c.trim() === '') return null;
    }
    if (typeof r.revisionIteration !== 'number' || !Number.isInteger(r.revisionIteration)
      || r.revisionIteration < 1 || r.revisionIteration > 2) return null;
    if (typeof r.sourceRolloutTaskId !== 'string' || r.sourceRolloutTaskId.trim() === '') return null;
    if (typeof r.sourceArtifactId !== 'string' || r.sourceArtifactId.trim() === '') return null;
    if (r.targetTaskKind !== 'scribe' && r.targetTaskKind !== 'artificer') return null;
    // B: 可选 intent 状态,缺失视为旧形状 (=applied)
    let intentStatus: 'pending' | 'applied' | undefined;
    if (r.status !== undefined && r.status !== 'pending' && r.status !== 'applied') return null;
    if (r.status === 'pending' || r.status === 'applied') intentStatus = r.status;
    rolloutRevisionPayload = {
      requiredChanges: r.requiredChanges as string[],
      revisionIteration: r.revisionIteration,
      sourceRolloutTaskId: r.sourceRolloutTaskId,
      sourceArtifactId: r.sourceArtifactId,
      targetTaskKind: r.targetTaskKind,
      status: intentStatus,
    };
  }

  // completionIntent: optional, full validation (rc-1/rc-4). Malformed intent
  // invalidates the whole metadata (fail-closed) — a corrupted authority
  // record must never silently degrade into "no intent, re-ask the LLM".
  let completionIntent: RunnerCompletionIntent | undefined;
  if (Object.hasOwn(m, 'completionIntent') && m.completionIntent !== undefined) {
    const p = m.completionIntent;
    if (typeof p !== 'object' || p === null || Array.isArray(p)) return null;
    const r = p as Record<string, unknown>;
    if (typeof r.decision !== 'string' || !RUNNER_DECISIONS.has(r.decision)) return null;
    if (typeof r.sourceRunId !== 'string' || r.sourceRunId.trim() === '') return null;
    if (typeof r.revisionEpoch !== 'number' || !Number.isInteger(r.revisionEpoch) || r.revisionEpoch < 0) return null;
    if (r.status !== 'pending' && r.status !== 'applied') return null;
    let revisionIteration: number | undefined;
    if (r.revisionIteration !== undefined) {
      if (typeof r.revisionIteration !== 'number' || !Number.isInteger(r.revisionIteration)
        || r.revisionIteration < 1 || r.revisionIteration > 2) return null;
      ({ revisionIteration } = r);
    }
    // P0-A: 可选效果类型,缺失 = governance_transition
    let effect: 'governance_transition' | 'needs_human_review' | undefined;
    if (r.effect !== undefined && r.effect !== 'governance_transition' && r.effect !== 'needs_human_review') return null;
    if (r.effect === 'needs_human_review') ({ effect } = r);
    completionIntent = {
      decision: r.decision as RunnerDecision,
      sourceRunId: r.sourceRunId,
      revisionEpoch: r.revisionEpoch,
      status: r.status,
      revisionIteration,
      ...(effect !== undefined ? { effect } : {}),
    };
  }

  // humanReviewContext (PRI-629): optional, full validation; malformed fails
  // the whole metadata (authority record corruption must surface, not degrade).
  let humanReviewContext: HumanReviewContext | undefined;
  if (Object.hasOwn(m, 'humanReviewContext') && m.humanReviewContext !== undefined) {
    if (!isValidHumanReviewContext(m.humanReviewContext)) return null;
    ({ humanReviewContext } = m);
  }

  // ownerResolutions (PRI-629): optional, full validation (rc-1/rc-4).
  let ownerResolutions: readonly OwnerResolutionRecord[] | undefined;
  if (Object.hasOwn(m, 'ownerResolutions') && m.ownerResolutions !== undefined) {
    if (!isValidOwnerResolutions(m.ownerResolutions)) return null;
    ({ ownerResolutions } = m);
  }

  return {
    dependencyTaskIds: m.dependencyTaskIds as string[],
    channel: m.channel,
    timeoutMs: m.timeoutMs,
    inputArtifactRefs: m.inputArtifactRefs as ArtifactRef[],
    outputArtifactRefs: m.outputArtifactRefs as ArtifactRef[],
    parentTaskId: typeof m.parentTaskId === 'string' ? m.parentTaskId : undefined,
    correlationId: typeof m.correlationId === 'string' ? m.correlationId : undefined,
    rejectionCount,
    adversarialFeedback: typeof m.adversarialFeedback === 'string' ? m.adversarialFeedback : undefined,
    repairPayload,
    runnerDecision: typeof m.runnerDecision === 'string' && RUNNER_DECISIONS.has(m.runnerDecision)
      ? m.runnerDecision as RunnerDecision
      : undefined,
    revisionCount: typeof m.revisionCount === 'number' ? m.revisionCount : undefined,
    revisionFeedback: typeof m.revisionFeedback === 'string' ? m.revisionFeedback : undefined,
    revisionCauseId: typeof m.revisionCauseId === 'string' ? m.revisionCauseId : undefined,
    rolloutRevisionPayload,
    completionIntent,
    humanReviewContext,
    ownerResolutions,
  };
}

// ── Hydration ───────────────────────────────────────────────────────────────────

/**
 * Hydrate a raw TaskRecord (as returned by SqliteTaskStore.getTask or listTasks)
 * into a PITaskRecord by reading and parsing its diagnosticJson.
 *
 * Fail-closed: returns null for any non-RunnerKind taskKind
 * even if diagnosticJson contains valid pi_metadata. This prevents the
 * InternalizationOrchestrator from treating a non-PI task as a PITaskRecord.
 *
 * Returns null if:
 *   - taskKind is not a valid RunnerKind (PeerRunnerKind or DiagnosticianStageKind)
 *   - diagnosticJson is missing or whitespace
 *   - diagnosticJson is not valid JSON
 *   - pi_metadata key is missing or invalid
 *   - Any required PI field fails validation
 *   - Optional field present but not a non-empty string
 */
export function hydratePITaskRecord(task: TaskRecord): PITaskRecord | null {
  // Guard: reject non-runner task kinds — lineage/kind invariant
  // Accept both PeerRunnerKind and DiagnosticianStageKind
  if (!isRunnerKind(task.taskKind)) return null;

  // Read diagnosticJson from the runtime object (not typed on TaskRecord)
  const raw = task as Record<string, unknown>;
  const {diagnosticJson} = raw;
  if (!diagnosticJson || typeof diagnosticJson !== 'string') return null;

  const meta = parsePITaskMetadata(diagnosticJson);
  if (!meta) return null;

  // Merge base TaskRecord with PI metadata → PITaskRecord
  // Cast through unknown to satisfy TypeScript's spread-overlap rules
  return {
    ...task,
    dependencyTaskIds: meta.dependencyTaskIds,
    channel: meta.channel,
    timeoutMs: meta.timeoutMs,
    inputArtifactRefs: meta.inputArtifactRefs,
    outputArtifactRefs: meta.outputArtifactRefs,
    parentTaskId: meta.parentTaskId,
    correlationId: meta.correlationId,
    rejectionCount: meta.rejectionCount ?? 0,
    adversarialFeedback: meta.adversarialFeedback,
    repairPayload: meta.repairPayload,
    runnerDecision: meta.runnerDecision,
    revisionCount: meta.revisionCount,
    revisionFeedback: meta.revisionFeedback,
    revisionCauseId: meta.revisionCauseId,
    rolloutRevisionPayload: meta.rolloutRevisionPayload,
    completionIntent: meta.completionIntent,
    humanReviewContext: meta.humanReviewContext,
    ownerResolutions: meta.ownerResolutions,
  } as unknown as PITaskRecord;
}
