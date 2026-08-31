/**
 * owner-review.ts — PRI-629 统一 Owner Decision 策略层（纯函数 + 窄事实读取）。
 *
 * 职责（单一深模块，Console/CLI/Runner 共用，禁止各自再推导）:
 *   - collectOwnerDecisionFacts   读取 durable facts（task/lineage/artifact）
 *   - deriveOwnerDecisionCapability  纯策略：该 NHR 任务是否 decision-capable、
 *                                    允许哪些 Owner 动作（INV-01 的唯一依据）
 *   - buildOwnerReviewKey         裁决事实快照的稳定 hash（stale 防护）
 *   - resolveEffectiveRunnerDecision  effective decision 的唯一解析点
 *   - classifyHumanReviewAttention   owner_decision vs recovery（fail closed）
 *
 * 不变式（SPEC PRI-629/630）:
 *   - machine verdict 永不被覆盖（runnerDecision 只读）
 *   - allowedActions.length === 0 ⇔ 不进 Owner Inbox、不阻止 Recover
 *   - 未知 reasonCode / 模糊 legacy 事实 → recovery（fail closed）
 *   - reviewKey 绑定 (taskId, epoch, run, artifact, hash, verdict, reason)
 */

import { createHash } from 'node:crypto';
import type { TaskRecord } from '../task-status.js';
import type { PITaskRecord } from './peer-runner-contracts.js';
import {
  hydratePITaskRecord,
  createPITaskDiagnosticJson,
  mergePITaskMetadata,
  type OwnerResolutionAction,
  type OwnerResolutionRecord,
  type RunnerDecision,
} from './pitask-metadata.js';

// ── Reason codes ──────────────────────────────────────────────────────────────

/**
 * needs_human_review 的结构化原因码（PRI-629）。写入侧由 runner 使用常量;
 * 解析侧接受任意非空串（前向兼容），分类侧只认 DECISION_CAPABLE 集合，
 * 其余一律 recovery。
 */
export const HUMAN_REVIEW_REASON = {
  /** Evaluator 修复预算耗尽（2 轮已用完）— Owner 可裁决 */
  evaluatorRepairBudgetExhausted: 'evaluator_repair_budget_exhausted',
  /** Rollout 修订预算耗尽 — Owner 可裁决 */
  rolloutRevisionBudgetExhausted: 'rollout_revision_budget_exhausted',
  // ── recovery-only ──
  evaluatorRepairSeedFailed: 'evaluator_repair_seed_failed',
  rolloutActivationCandidateUnresolved: 'rollout_activation_candidate_unresolved',
  rolloutDispatchNotWired: 'rollout_dispatch_not_wired',
  rolloutDispatchRefused: 'rollout_dispatch_refused',
  rolloutRevisionTargetUnresolved: 'rollout_revision_target_unresolved',
  rolloutRevisionRoutingNotWired: 'rollout_revision_routing_not_wired',
  rolloutRevisionReopenFailed: 'rollout_revision_reopen_failed',
  rolloutRevisionIterationMissing: 'rollout_revision_iteration_missing',
  workspaceDirtyStall: 'workspace_dirty_stall',
} as const;

export type HumanReviewReasonCode = typeof HUMAN_REVIEW_REASON[keyof typeof HUMAN_REVIEW_REASON];

/** decision-capable 原因集合 — 只有这些允许 Owner verdict override。 */
export const DECISION_CAPABLE_HUMAN_REVIEW_REASONS: ReadonlySet<string> = new Set([
  HUMAN_REVIEW_REASON.evaluatorRepairBudgetExhausted,
  HUMAN_REVIEW_REASON.rolloutRevisionBudgetExhausted,
]);

/** legacy（无 humanReviewContext）判定后使用的原因码，携带 _legacy 后缀以示证据来源。 */
export const LEGACY_EVALUATOR_BUDGET_EXHAUSTED = 'evaluator_repair_budget_exhausted_legacy';
export const LEGACY_ROLLOUT_BUDGET_EXHAUSTED = 'rollout_revision_budget_exhausted_legacy';

// ── Fact store (narrow read interface) ───────────────────────────────────────

/** 事实读取所需的最窄接口 — RuntimeStateManager 天然满足前两项。 */
export interface OwnerDecisionFactStore {
  getTask(taskId: string): Promise<TaskRecord | null>;
  listArtifactsBySourceTask(taskId: string): Promise<readonly DecisionArtifactRecord[]>;
}

export interface DecisionArtifactRecord {
  readonly artifactId: string;
  readonly artifactKind: string;
  readonly validationStatus: string;
  readonly contentJson: string;
  /** Review projection lineage fields; optional for legacy fact-store adapters. */
  readonly sourceTaskId?: string;
  readonly lineageArtifactIds?: readonly string[];
  readonly createdAt?: string;
}

/** 决策输出 artifact（evaluator/rollout 名下的 kind='principle' 评审输出）。 */
export interface DecisionArtifactFacts {
  readonly artifactId: string;
  readonly contentHash: string;
}

/** collectOwnerDecisionFacts 的产物 — capability 的全部输入。 */
export interface OwnerDecisionFacts {
  readonly task: PITaskRecord;
  /** 决策输出 artifact（pi-art-<taskId>-<runId>）；不存在 = null */
  readonly decisionArtifact: DecisionArtifactFacts | null;
  /** 决策 artifact 的确定性安全门（adversarial hard gate）失败 — accept 禁止 */
  readonly hardGateFailed: boolean;
  /** evaluator: 依赖链上 artificer 的 repairPayload.repairIteration（无 payload 的首轮 artificer = 0；无 artificer = null） */
  readonly dependencyRepairIteration: number | null;
  /** evaluator: 依赖 artificer 的 taskId（revise_once 的 reopen 目标；无 = null） */
  readonly dependencyArtificerTaskId: string | null;
  /** rollout: rolloutRevisionPayload 已 APPLIED 的修订轮数 */
  readonly rolloutRevisionAppliedCount: number | null;
  /** 依赖链可解析（evaluator: 依赖 artificer 任务存在；rollout: 依赖 evaluator 任务存在） */
  readonly lineageResolvable: boolean;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 对 artifact contentJson 计算 sha256 hex（reviewKey / stale 防护的事实输入）。 */
export function computeArtifactContentHash(contentJson: string): string {
  return sha256Hex(contentJson);
}

/** evaluator/rollout 输出 artifact 的确定性 id（与 runner 写入约定一致）。 */
export function decisionArtifactIdFor(taskId: string, runId: string): string {
  return `pi-art-${taskId}-${runId}`;
}

/**
 * 从 durable facts 还原裁决事实快照：
 *   1. humanReviewContext 存在 → 直接采用（它由 runner 在 NHR 落库时原子写入）;
 *   2. legacy → completionIntent.sourceRunId + 确定性 artifact id + 内容 hash。
 * 决策 artifact 必须真实存在且可读 — 缺失即 capability 失败（recovery）。
 */
/**
 * 硬确定性安全门判定（SPEC §20）：evaluator V2 输出携带 adversarialResult
 * 且 passed=false → 确定性对抗门失败，Owner 不得 accept（可 revise/reject）。
 * 此处只读 metadata 可达的事实；artifact 内容级判定在 apply 阶段由 runner
 * 的既有 deterministic gates 兜底（RuleHostWriter.canActivate / sandbox replay）。
 */

// ── Effective decision mapping (applied at resolution time) ──────────────────

/**
 * verdict override 的 effective decision 映射（SPEC §10/§14/§16）。
 * 注意 rollout accept → 'approve_rollout'（不是 'approved'）— 高风险部署
 * 审批由 ActivationDispatcher 在下游强制，Owner review 不穿透。
 */
export function effectiveDecisionFor(
  taskKind: string,
  action: OwnerResolutionAction,
): RunnerDecision | undefined {
  if (action === 'revise_once') return undefined;
  if (action === 'accept_current') {
    return taskKind === 'rollout_reviewer' ? 'approve_rollout' : 'approved';
  }
  return taskKind === 'rollout_reviewer' ? 'reject' : 'rejected';
}

// ── Runner-side resume helpers ────────────────────────────────────────────────

export interface OwnerOverrideResumePlan {
  readonly resolution: OwnerResolutionRecord;
  readonly overrideDecision: RunnerDecision;
}

/**
 * Runner 入口恢复门的第一优先级检查（SPEC §10）：
 * pending Owner Resolution → pending Completion Intent → normal LLM。
 * 当前 epoch 存在 verdict override resolution（pending 或 applied 均可 —
 * applied 但任务未 terminal 的 crash 窗口同样由此收敛）→ 返回 override 计划。
 */
export function planOwnerVerdictOverrideResume(piTask: PITaskRecord): OwnerOverrideResumePlan | null {
  const epoch = piTask.revisionCount ?? 0;
  const resolutions = piTask.ownerResolutions;
  if (!resolutions || resolutions.length === 0) return null;
  let latest: OwnerResolutionRecord | null = null;
  for (const r of resolutions) {
    if (r.revisionEpoch !== epoch) continue;
    if (r.action !== 'accept_current' && r.action !== 'reject_current') continue;
    if (!latest || r.decidedAt > latest.decidedAt) latest = r;
  }
  if (!latest) return null;
  // resolution 记录的 effectiveDecision 是 override authority;异常缺失 →
  // 无计划（fail closed，走既有 intent/LLM 路径）。
  if (latest.effectiveDecision === undefined) return null;
  return { resolution: latest, overrideDecision: latest.effectiveDecision };
}

/**
 * runner 侧 detail reason string → 规范化 humanReviewContext.reasonCode。
 * 保留 detail 原串在事件里（可观测），context 携带规范码（可分类）。
 */
export function canonicalHumanReviewReasonCode(detail: string): string {
  if (detail.startsWith('rollout_revision_budget_exhausted')) return HUMAN_REVIEW_REASON.rolloutRevisionBudgetExhausted;
  if (detail === 'rollout_dispatch_not_wired') return HUMAN_REVIEW_REASON.rolloutDispatchNotWired;
  if (detail.startsWith('rollout_dispatch_')) return HUMAN_REVIEW_REASON.rolloutDispatchRefused;
  if (detail === 'rollout_activation_candidate_unresolved') return HUMAN_REVIEW_REASON.rolloutActivationCandidateUnresolved;
  if (detail === 'rollout_revision_target_unresolved') return HUMAN_REVIEW_REASON.rolloutRevisionTargetUnresolved;
  if (detail === 'rollout_revision_routing_not_wired') return HUMAN_REVIEW_REASON.rolloutRevisionRoutingNotWired;
  if (detail.startsWith('rollout_revision_reopen_failed')) return HUMAN_REVIEW_REASON.rolloutRevisionReopenFailed;
  if (detail === 'rollout_revision_iteration_missing') return HUMAN_REVIEW_REASON.rolloutRevisionIterationMissing;
  if (detail === HUMAN_REVIEW_REASON.evaluatorRepairBudgetExhausted
    || detail === HUMAN_REVIEW_REASON.evaluatorRepairSeedFailed) return detail;
  // 未知 detail — 保留原串（分类侧 fail closed 到 recovery）
  return detail;
}

/**
 * 硬确定性安全门判定（SPEC §9.1/§20）：evaluator V2 输出携带
 * adversarialResult 且 passed=false → 确定性对抗门失败 → accept_current
 * 不允许（revise/reject 仍可用）。从决策 artifact contentJson 做有界解析。
 */
export function detectHardGateFailureFromArtifact(contentJson: string): boolean {
  try {
    const parsed: unknown = JSON.parse(contentJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
    // runtime-contract-exempt: ERR-001 object-guarded unknown property extraction; the value is typeof-checked immediately below
    const { adversarialResult } = parsed as { adversarialResult?: unknown };
    if (typeof adversarialResult !== 'object' || adversarialResult === null) return false;
    // runtime-contract-exempt: ERR-001 object-guarded unknown property extraction; the value is compared against false immediately
    const { passed } = adversarialResult as { passed?: unknown };
    // passed 显式为 false 才是门失败；缺失/true/其它值不判失败
    return passed === false;
  } catch {
    return false;
  }
}

export async function collectOwnerDecisionFacts(
  store: OwnerDecisionFactStore,
  taskId: string,
): Promise<OwnerDecisionFacts | null> {
  const raw = await store.getTask(taskId);
  if (!raw) return null;
  const piTask = hydratePITaskRecord(raw);
  if (!piTask) return null;
  if (piTask.taskKind !== 'evaluator' && piTask.taskKind !== 'rollout_reviewer') return null;

  // 决策来源 run：context 优先，legacy 回退 completionIntent。
  const context = piTask.humanReviewContext;
  const intent = piTask.completionIntent;
  const sourceRunId = context?.sourceRunId ?? intent?.sourceRunId ?? null;
  let decisionArtifact: DecisionArtifactFacts | null = null;
  let hardGateFailed = false;
  if (sourceRunId) {
    const expectedArtifactId = context?.sourceArtifactId
      ?? decisionArtifactIdFor(taskId, sourceRunId);
    const artifacts = await store.listArtifactsBySourceTask(taskId).catch(() => []);
    const artifact = artifacts.find((a) => a.artifactId === expectedArtifactId) ?? null;
    if (artifact) {
      decisionArtifact = {
        artifactId: artifact.artifactId,
        contentHash: computeArtifactContentHash(artifact.contentJson),
      };
      hardGateFailed = detectHardGateFailureFromArtifact(artifact.contentJson);
    }
  }

  // lineage 事实：evaluator 读依赖 artificer 的 repairPayload；rollout 读依赖 evaluator 存在性。
  let dependencyRepairIteration: number | null = null;
  let dependencyArtificerTaskId: string | null = null;
  let lineageResolvable = false;
  if (piTask.taskKind === 'evaluator') {
    for (const depId of piTask.dependencyTaskIds) {
      const dep = await store.getTask(depId).catch(() => null);
      if (!dep || dep.taskKind !== 'artificer') continue;
      const depPi = hydratePITaskRecord(dep);
      dependencyRepairIteration = depPi?.repairPayload?.repairIteration ?? 0;
      dependencyArtificerTaskId = dep.taskId;
      lineageResolvable = true;
      break;
    }
  } else {
    for (const depId of piTask.dependencyTaskIds) {
      const dep = await store.getTask(depId).catch(() => null);
      if (dep?.taskKind === 'evaluator') {
        lineageResolvable = true;
        break;
      }
    }
  }

  const rrp = piTask.rolloutRevisionPayload;
  const rolloutRevisionAppliedCount = piTask.taskKind === 'rollout_reviewer' && rrp
    ? (rrp.status === 'pending' ? rrp.revisionIteration - 1 : rrp.revisionIteration)
    : null;

  return {
    task: piTask,
    decisionArtifact,
    hardGateFailed,
    dependencyRepairIteration,
    dependencyArtificerTaskId,
    rolloutRevisionAppliedCount,
    lineageResolvable,
  };
}

// ── reviewKey ─────────────────────────────────────────────────────────────────

export interface ReviewKeyFacts {
  readonly taskId: string;
  readonly revisionEpoch: number;
  readonly sourceRunId: string;
  readonly sourceArtifactId: string;
  readonly sourceArtifactHash: string;
  readonly machineDecision: string;
  readonly humanReviewReason: string;
}

/**
 * Owner Decision Item 的稳定身份：裁决事实快照的 sha256。任何一个事实变化
 * （新一轮 run / 新 artifact / 新 epoch / 不同 verdict）都会产生新 key —
 * Owner 只能批准自己实际看到的那个版本（stale 防护，SPEC §6）。
 */
export function buildOwnerReviewKey(facts: ReviewKeyFacts): string {
  const canonical = [
    'owner-decision-v1',
    facts.taskId,
    String(facts.revisionEpoch),
    facts.sourceRunId,
    facts.sourceArtifactId,
    facts.sourceArtifactHash,
    facts.machineDecision,
    facts.humanReviewReason,
  ].join('\u0000');
  return `odk_${sha256Hex(canonical)}`;
}

// ── Effective decision resolver (SINGLE resolution point) ────────────────────

/**
 * effective decision 的唯一解析点（SPEC §8）：
 *   当前 revision epoch 存在合法、applied 的 Owner verdict override →
 *   effectiveDecision；否则 → runnerDecision（机器判定，永不改写）。
 *
 * Internalization transition / orchestrator / 任何消费方必须经由本函数；
 * Console / HTTP route / 各 runner 禁止自行计算。
 */
/** 当前 epoch 内最新一条 owner resolution（pending 或 applied），无则 null。 */
export function findOwnerResolutionForCurrentEpoch(piTask: PITaskRecord): OwnerResolutionRecord | null {
  const epoch = piTask.revisionCount ?? 0;
  const resolutions = piTask.ownerResolutions;
  if (!resolutions || resolutions.length === 0) return null;
  let latest: OwnerResolutionRecord | null = null;
  for (const r of resolutions) {
    if (r.revisionEpoch !== epoch) continue;
    if (!latest || r.decidedAt > latest.decidedAt) latest = r;
  }
  return latest;
}

/**
 * P0 评审修复: 当前 epoch 内是否有 **pending**（等待 runner 应用）的 resolution。
 * Recover guard 只拒 pending——applied resolution 表示裁决已被执行（即使下游
 * 治理转移因技术原因落在 recovery NHR），此时 Recover 是合法的技术重试出口
 * （resume 门会基于 applied override 确定性重放，不重问 LLM）。
 */
export function findPendingOwnerResolutionForCurrentEpoch(piTask: PITaskRecord): OwnerResolutionRecord | null {
  const epoch = piTask.revisionCount ?? 0;
  const resolutions = piTask.ownerResolutions;
  if (!resolutions) return null;
  let latest: OwnerResolutionRecord | null = null;
  for (const r of resolutions) {
    if (r.revisionEpoch !== epoch || r.status !== 'pending') continue;
    if (!latest || r.decidedAt > latest.decidedAt) latest = r;
  }
  return latest;
}

/** 当前 epoch 内最新 applied verdict override（accept/reject）— resolver 的输入。 */
export function findAppliedVerdictOverrideResolution(piTask: PITaskRecord): OwnerResolutionRecord | null {
  const epoch = piTask.revisionCount ?? 0;
  const resolutions = piTask.ownerResolutions;
  if (!resolutions) return null;
  let latest: OwnerResolutionRecord | null = null;
  for (const r of resolutions) {
    if (r.revisionEpoch !== epoch || r.status !== 'applied') continue;
    if (r.action !== 'accept_current' && r.action !== 'reject_current') continue;
    if (!latest || r.decidedAt > latest.decidedAt) latest = r;
  }
  return latest;
}

export function resolveEffectiveRunnerDecision(piTask: PITaskRecord): RunnerDecision | undefined {
  const override = findAppliedVerdictOverrideResolution(piTask);
  if (override?.effectiveDecision !== undefined) {
    return override.effectiveDecision;
  }
  return piTask.runnerDecision;
}


// ── Classification & capability ───────────────────────────────────────────────

export type HumanReviewAttention = 'owner_decision' | 'recovery';

export interface OwnerDecisionCapability {
  /** true ⇔ allowedActions.length > 0（INV-01 Actionability Truth） */
  readonly eligible: boolean;
  /** 规范化原因码（legacy 判定带 _legacy 后缀） */
  readonly reasonCode: string;
  readonly attention: HumanReviewAttention;
  readonly legacy: boolean;
  readonly reviewKey?: string;
  readonly allowedActions: readonly OwnerResolutionAction[];
  readonly blockers: readonly string[];
}

/**
 * 规范化人工裁决原因：
 *   - 有 humanReviewContext → 其 reasonCode（未知码 → attention=recovery，fail closed）;
 *   - legacy → 按 durable facts 推断（SPEC §23）：
 *       evaluator: needs_revision + dep artificer repairIteration>=2 + 同 epoch
 *                  pending intent → budget exhausted (legacy)
 *       rollout:   needs_revision + applied revision count>=2 → budget exhausted (legacy)
 *   - 事实不足/歧义 → recovery（不得猜）。
 */
export function classifyHumanReviewAttention(facts: OwnerDecisionFacts): {
  attention: HumanReviewAttention;
  reasonCode: string;
  legacy: boolean;
} {
  const { task } = facts;
  const context = task.humanReviewContext;
  if (context) {
    if (DECISION_CAPABLE_HUMAN_REVIEW_REASONS.has(context.reasonCode)) {
      return { attention: 'owner_decision', reasonCode: context.reasonCode, legacy: false };
    }
    return { attention: 'recovery', reasonCode: context.reasonCode, legacy: false };
  }

  // ── legacy inference（无 context 的历史任务）──
  if (task.runnerDecision !== 'needs_revision') {
    return { attention: 'recovery', reasonCode: 'legacy_unclassified', legacy: true };
  }
  if (task.taskKind === 'evaluator') {
    const intent = task.completionIntent;
    const epochOk = !intent || intent.revisionEpoch === (task.revisionCount ?? 0);
    if (facts.dependencyRepairIteration !== null
      && facts.dependencyRepairIteration >= 2
      && epochOk) {
      return { attention: 'owner_decision', reasonCode: LEGACY_EVALUATOR_BUDGET_EXHAUSTED, legacy: true };
    }
    return { attention: 'recovery', reasonCode: 'legacy_unclassified', legacy: true };
  }
  if (task.taskKind === 'rollout_reviewer') {
    if (facts.rolloutRevisionAppliedCount !== null && facts.rolloutRevisionAppliedCount >= 2) {
      return { attention: 'owner_decision', reasonCode: LEGACY_ROLLOUT_BUDGET_EXHAUSTED, legacy: true };
    }
    return { attention: 'recovery', reasonCode: 'legacy_unclassified', legacy: true };
  }
  return { attention: 'recovery', reasonCode: 'legacy_unclassified', legacy: true };
}

/**
 * 纯策略：从 facts 推导该 NHR 任务允许的 Owner 动作（SPEC §9）。
 * 只有 allowedActions.length > 0 才进入 Owner Inbox（INV-01）。
 *
 * Eligibility（accept_current 最严）：
 *   - decision-capable 原因（含 legacy 判定）
 *   - runnerDecision = needs_revision（机器建议继续修）
 *   - 决策输出 artifact 存在（reviewKey 需要 hash）
 *   - lineage 可解析
 *   - 无同 epoch 的已有 resolution（已裁决过 → 不再展示）
 *   - 硬确定性安全门未失败（adversarial/sandbox hard fail 时 accept 被禁，
 *     revise/reject 仍可用 — SPEC §9.1/§20）
 */
function infeasible(reason: string): OwnerDecisionCapability {
  return {
    eligible: false,
    reasonCode: 'not_applicable',
    attention: 'recovery',
    legacy: false,
    allowedActions: [],
    blockers: [reason],
  };
}

export function deriveOwnerDecisionCapability(facts: OwnerDecisionFacts): OwnerDecisionCapability {
  const { task } = facts;
  const blockers: string[] = [];

  if (task.status !== 'needs_human_review') {
    return infeasible('task_not_needs_human_review');
  }
  if (task.taskKind !== 'evaluator' && task.taskKind !== 'rollout_reviewer') {
    return infeasible('task_kind_not_decision_capable');
  }

  const classification = classifyHumanReviewAttention(facts);
  if (classification.attention !== 'owner_decision') {
    return {
      eligible: false,
      reasonCode: classification.reasonCode,
      attention: 'recovery',
      legacy: classification.legacy,
      allowedActions: [],
      blockers: [`reason_not_decision_capable:${classification.reasonCode}`],
    };
  }

  if (task.runnerDecision !== 'needs_revision') {
    blockers.push(`runner_decision_not_needs_revision:${task.runnerDecision ?? 'missing'}`);
  }
  if (!facts.decisionArtifact) {
    blockers.push('decision_artifact_missing');
  }
  if (!facts.lineageResolvable) {
    blockers.push('lineage_unresolvable');
  }
  if (findOwnerResolutionForCurrentEpoch(task)) {
    blockers.push('resolution_already_recorded_for_current_epoch');
  }

  if (blockers.length > 0) {
    return {
      eligible: false,
      reasonCode: classification.reasonCode,
      attention: 'recovery',
      legacy: classification.legacy,
      allowedActions: [],
      blockers,
    };
  }

  // facts 已由调用方 I/O 定位；eligible 分支保证 context/intent 至少其一
  // 携带 sourceRunId（两类 budget-exhausted 落库路径都先写 completionIntent）。
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const artifact = facts.decisionArtifact!;
  const sourceRunId = task.humanReviewContext?.sourceRunId
    ?? task.completionIntent?.sourceRunId
    ?? '';
  const reviewKey = buildOwnerReviewKey({
    taskId: task.taskId,
    revisionEpoch: task.revisionCount ?? 0,
    sourceRunId,
    sourceArtifactId: artifact.artifactId,
    sourceArtifactHash: artifact.contentHash,
    machineDecision: task.runnerDecision ?? 'needs_revision',
    humanReviewReason: classification.reasonCode,
  });

  const allowedActions: OwnerResolutionAction[] = ['revise_once', 'reject_current'];
  if (!facts.hardGateFailed) {
    allowedActions.unshift('accept_current');
  } else {
    blockers.push('deterministic_hard_gate_failed');
  }

  return {
    eligible: allowedActions.length > 0,
    reasonCode: classification.reasonCode,
    attention: 'owner_decision',
    legacy: classification.legacy,
    reviewKey,
    allowedActions,
    blockers,
  };
}



/** resolution 标 applied（幂等，单调 pending→applied；并发同值写安全）。 */
export interface MarkOwnerResolutionAppliedCtx {
  readonly updateDiagnosticJson: (taskId: string, json: string) => Promise<void>;
  readonly getTask: (taskId: string) => Promise<TaskRecord | null>;
  readonly taskId: string;
  readonly resolutionId: string;
  readonly appliedAt: string;
}

export async function markOwnerResolutionApplied(ctx: MarkOwnerResolutionAppliedCtx): Promise<void> {
  const { updateDiagnosticJson, getTask, taskId, resolutionId, appliedAt } = ctx;
  const raw = await getTask(taskId);
  if (!raw) return;
  const piTask = hydratePITaskRecord(raw);
  if (!piTask?.ownerResolutions) return;
  const target = piTask.ownerResolutions.find((r) => r.resolutionId === resolutionId);
  if (!target || target.status === 'applied') return;
  const updated = piTask.ownerResolutions.map((r) =>
    r.resolutionId === resolutionId ? { ...r, status: 'applied' as const, appliedAt } : r);
  await updateDiagnosticJson(taskId, createPITaskDiagnosticJson(
    mergePITaskMetadata(piTask, { ownerResolutions: updated }),
  ));
}
