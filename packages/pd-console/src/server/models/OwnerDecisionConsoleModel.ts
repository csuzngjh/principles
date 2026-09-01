/**
 * OwnerDecisionConsoleModel — PRI-629 统一 Owner Decision 读模型（投影）。
 *
 * SPEC §21: 不新建 authority table — 本模型是纯派生 read model，从既有
 * durable facts（tasks / pi_metadata / pi_artifacts / approvals / activations）
 * 经 core 的 collectOwnerDecisionFacts + deriveOwnerDecisionCapability 派生
 * OwnerDecisionItem。INV-01: 只有 allowedActions 非空的条目才进入列表。
 *
 * 策略全部在 @principles/core 的 owner-review.ts（单一深模块）；
 * 本模型只负责 workspace I/O 与条目包装（标题/摘要等展示字段）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SqliteConnection,
  SqlitePIArtifactStore,
  SqliteApprovalQueueStore,
  collectOwnerDecisionFacts,
  deriveOwnerDecisionCapability,
  buildOwnerDecisionReview,
} from '@principles/core/runtime-v2';
import type { OwnerDecisionReviewSnapshot, TaskRecord } from '@principles/core/runtime-v2';
import type { PIArtifactStore } from '@principles/core/runtime-v2';
import { ActivationsConsoleModel } from './ActivationsConsoleModel.js';

export type OwnerDecisionItemKind =
  | 'evaluator_review'
  | 'rollout_review'
  | 'activation_approval'
  | 'rulecode_decision';

export interface OwnerDecisionItem {
  readonly reviewKey: string;
  readonly kind: OwnerDecisionItemKind;
  readonly taskId: string;
  readonly principleId?: string;
  readonly title: string;
  readonly summary: string;
  readonly machineRecommendation?: string;
  readonly score?: number;
  readonly reasonCode: string;
  readonly legacy: boolean;
  readonly allowedActions: readonly string[];
  /** stale 防护事实快照 — POST /resolve 原样回传，服务端重读比对 */
  readonly expectedRevisionEpoch: number;
  readonly expectedSourceRunId: string;
  readonly expectedSourceArtifactId: string;
  readonly expectedSourceArtifactHash: string;
  readonly expectedEvidenceDigest?: string;
  readonly review?: OwnerDecisionReviewSnapshot;
  /** Visible recovery state: the decision is still required, but evidence is unsafe to act on. */
  readonly evidenceUnavailableReason?: string;
  readonly createdAt: string;
}

export interface OwnerDecisionListResult {
  readonly items: readonly OwnerDecisionItem[];
  readonly total: number;
  readonly generatedAt: string;
}

const GOVERNANCE_TASK_KINDS = new Set(['evaluator', 'rollout_reviewer']);

/** tasks.status 合法值（PDTaskStatus）运行时守卫。 */
const TASK_STATUSES = new Set(['pending', 'leased', 'succeeded', 'retry_wait', 'failed', 'needs_human_review']);
function isTaskStatus(v: unknown): v is TaskRecord['status'] {
  return typeof v === 'string' && TASK_STATUSES.has(v);
}

/** 行 → TaskRecord 的窄映射（tasks 表全部列；snake_case 键名转换）。 */
function rowToTaskRecord(row: Record<string, unknown>): TaskRecord | null {
  if (typeof row.task_id !== 'string' || typeof row.task_kind !== 'string' || typeof row.status !== 'string') {
    return null;
  }
  return {
    taskId: row.task_id,
    taskKind: row.task_kind,
    status: isTaskStatus(row.status) ? row.status : 'pending',
    attemptCount: typeof row.attempt_count === 'number' ? row.attempt_count : 0,
    maxAttempts: typeof row.max_attempts === 'number' ? row.max_attempts : 3,
    createdAt: typeof row.created_at === 'string' ? row.created_at : '',
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
    // lastError (PDErrorCategory 联合) 与 lease/input/result 列为事实收集器
    // 不需要的字段 — 不映射 (避免对未校验枚举的 as 断言)。
    ...(typeof row.diagnostic_json === 'string' ? { diagnosticJson: row.diagnostic_json } : {}),
  };
}

/** 同一 readonly 连接上的 task 行读取闭包（依赖链遍历用）。 */
/** DB 行守卫: 非空普通对象（列读取处再逐字段 typeof 校验）。 */
function isRecordRow(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function makeRowReader(db: { prepare: (sql: string) => { get: (id: string) => unknown } }) {
  const stmt = db.prepare('SELECT * FROM tasks WHERE task_id = ?');
  return (taskId: string): TaskRecord | null => {
    const row = stmt.get(taskId);
    if (!isRecordRow(row)) return null;
    return row ? rowToTaskRecord(row) : null;
  };
}

/** 行 → TaskRecord 的窄映射（tasks 表全部列；diagnostic_json 键名转换）。 */

interface TaskDecisionItemDependencies {
  readonly artifactStore: PIArtifactStore;
  readonly readTaskRow: (taskId: string) => TaskRecord | null;
}

/** 单任务 capability → 决策条目（不 eligible → null，INV-01）。 */
async function deriveTaskDecisionItem(
  task: TaskRecord,
  dependencies: TaskDecisionItemDependencies,
): Promise<OwnerDecisionItem | null> {
  if (!GOVERNANCE_TASK_KINDS.has(task.taskKind)) return null;
  const factStore = {
    getTask: async (taskId: string): Promise<TaskRecord | null> => {
      if (taskId === task.taskId) return task;
      try {
        return dependencies.readTaskRow(taskId);
      } catch {
        return null;
      }
    },
    listArtifactsBySourceTask: async (taskId: string) => {
      const list = await dependencies.artifactStore.listBySourceTaskId(taskId).catch(() => []);
      return list.map((a) => ({
        artifactId: a.artifactId,
        artifactKind: a.artifactKind,
        validationStatus: a.validationStatus,
        contentJson: a.contentJson,
        sourceTaskId: a.sourceTaskId,
        lineageArtifactIds: a.lineageArtifactIds,
        createdAt: a.createdAt,
      }));
    },
    getArtifactById: async (artifactId: string) => {
      const artifact = await dependencies.artifactStore.getArtifactById(artifactId).catch(() => null);
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
  const facts = await collectOwnerDecisionFacts(factStore, task.taskId);
  if (!facts) return null;
  const capability = deriveOwnerDecisionCapability(facts);
  const evidenceBlockers = capability.blockers.filter((blocker) =>
    blocker === 'decision_artifact_missing' || blocker === 'lineage_unresolvable');
  const kind: OwnerDecisionItemKind = task.taskKind === 'rollout_reviewer' ? 'rollout_review' : 'evaluator_review';
  if (!capability.eligible || !capability.reviewKey) {
    if (evidenceBlockers.length === 0) return null;
    return {
      reviewKey: `unavailable:${task.taskId}`,
      kind,
      taskId: task.taskId,
      title: task.taskKind === 'rollout_reviewer'
        ? 'Rollout 评审仍需要你的判断'
        : '自动改进仍需要你的判断',
      summary: '决策证据当前不完整，PD 已停止提供裁决动作以避免你批准错误版本。',
      reasonCode: capability.reasonCode,
      legacy: capability.legacy,
      allowedActions: [],
      expectedRevisionEpoch: facts.task.revisionCount ?? 0,
      expectedSourceRunId: facts.task.humanReviewContext?.sourceRunId
        ?? facts.task.completionIntent?.sourceRunId ?? '',
      expectedSourceArtifactId: '',
      expectedSourceArtifactHash: '',
      evidenceUnavailableReason: evidenceBlockers.join(','),
      createdAt: task.updatedAt,
    };
  }
  const review = await buildOwnerDecisionReview(factStore, task.taskId);
  if (!review) {
    return {
      reviewKey: `unavailable:${task.taskId}`,
      kind,
      taskId: task.taskId,
      title: '自动改进仍需要你的判断',
      summary: '决策证据无法安全读取，PD 已停止提供裁决动作。',
      reasonCode: capability.reasonCode,
      legacy: capability.legacy,
      allowedActions: [],
      expectedRevisionEpoch: facts.task.revisionCount ?? 0,
      expectedSourceRunId: facts.task.humanReviewContext?.sourceRunId
        ?? facts.task.completionIntent?.sourceRunId ?? '',
      expectedSourceArtifactId: facts.decisionArtifact?.artifactId ?? '',
      expectedSourceArtifactHash: facts.decisionArtifact?.contentHash ?? '',
      evidenceUnavailableReason: 'owner_review_evidence_unavailable',
      createdAt: task.updatedAt,
    };
  }

  const sourceRunId = facts.task.humanReviewContext?.sourceRunId
    ?? facts.task.completionIntent?.sourceRunId ?? '';
  const artifact = facts.decisionArtifact;
  const title = review.brief.kind === 'evaluator'
    ? review.brief.principle.title
      ?? review.brief.principle.statement
      ?? review.brief.implementation.summary
      ?? '自动改进需要你的判断'
    : review.brief.summary ?? 'Rollout 评审需要你的判断';
  const summary = review.brief.kind === 'evaluator'
    ? review.brief.implementation.summary
      ?? (review.brief.concerns.length > 0
        ? `仍有 ${String(review.brief.concerns.length)} 项自动评审异议。`
        : '查看当前实现、证据与动作后果。')
    : review.brief.summary ?? '查看 rollout 证据与动作后果。';
  return {
    reviewKey: capability.reviewKey,
    kind,
    taskId: task.taskId,
    title,
    summary,
    ...(review.brief.kind === 'evaluator' && review.brief.score !== undefined
      ? { score: review.brief.score }
      : {}),
    reasonCode: capability.reasonCode,
    legacy: capability.legacy,
    allowedActions: [...review.capability.finalOfferedActions],
    expectedRevisionEpoch: facts.task.revisionCount ?? 0,
    expectedSourceRunId: sourceRunId,
    expectedSourceArtifactId: artifact?.artifactId ?? '',
    expectedSourceArtifactHash: artifact?.contentHash ?? '',
    expectedEvidenceDigest: review.evidence.digest,
    review,
    createdAt: task.updatedAt,
  };
}

export class OwnerDecisionConsoleModel {
  constructor(private readonly workspaceDir: string) {}

  /**
   * 派生当前真实可执行的 Owner 决策列表（INV-01 / SPEC §27 badge 的唯一来源）。
   * N = items.length — 不是 candidate 数、不是 NHR 总数、不是 failed 数。
   */
  async listOwnerDecisionItems(): Promise<OwnerDecisionListResult> {
    const stateDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    if (!fs.existsSync(stateDbPath)) {
      return { items: [], total: 0, generatedAt: new Date().toISOString() };
    }
    const conn = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
    try {
      const db = conn.getDb();
      const artifactStore: PIArtifactStore = new SqlitePIArtifactStore(conn);
      const items: OwnerDecisionItem[] = [];

      // ── 1. needs_human_review 的 decision-capable 任务 (PRI-629 核心) ──
      let nhrRows: Record<string, unknown>[] = [];
      try {
        nhrRows = db.prepare(
          `SELECT * FROM tasks WHERE status = 'needs_human_review' AND task_kind IN ('evaluator', 'rollout_reviewer')`,
        ).all().filter(isRecordRow);
      } catch {
        nhrRows = []; // tasks 表缺失（旧库）→ 无决策项
      }
      for (const row of nhrRows) {
        const task = rowToTaskRecord(row);
        if (!task) continue;
        const item = await deriveTaskDecisionItem(
          task,
          {
            artifactStore,
            readTaskRow: makeRowReader(db),
          },
        );
        if (item) items.push(item);
      }

      // ── 2. 既有 approvals pending（高风险部署审批 — 独立门，动作走既有 API）──
      try {
        const approvals = await new SqliteApprovalQueueStore(conn).listPending();
        for (const approval of approvals) {
          items.push({
            reviewKey: `apr:${approval.approvalId}`,
            kind: 'activation_approval',
            taskId: approval.artifactId,
            title: `部署审批 · ${approval.channel}`,
            summary: `${approval.riskLevel} 风险通道 ${approval.channel} 的原则部署等待批准。`,
            reasonCode: 'activation_approval_pending',
            legacy: false,
            allowedActions: ['approve', 'reject'],
            expectedRevisionEpoch: 0,
            expectedSourceRunId: '',
            expectedSourceArtifactId: approval.artifactId,
            expectedSourceArtifactHash: '',
            createdAt: approval.requestedAt,
          });
        }
      } catch {
        // approvals 表缺失 → 跳过（恒空也是常态：低风险自动激活）
      }

      // ── 3. RuleCode shadow 待决（promote / reject — 独立 authority，动作走既有 API）──
      try {
        const shadowRows = db.prepare(
          `SELECT activation_id, artifact_id, channel, activated_at FROM activations
           WHERE action = 'code_tool_hook_shadow_activate'
             AND promoted_at IS NULL AND deactivated_at IS NULL`,
        ).all().filter(isRecordRow);
        const activationModel = new ActivationsConsoleModel(this.workspaceDir);
        for (const row of shadowRows) {
          const artifactId = typeof row.artifact_id === 'string' ? row.artifact_id : '';
          const activationId = typeof row.activation_id === 'string' ? row.activation_id : '';
          try {
            const review = await activationModel.getOwnerReview(activationId, true);
            if (review.readiness.status !== 'ready' && review.readiness.status !== 'evidence_insufficient') continue;
          } catch {
            continue;
          }
          items.push({
            reviewKey: `rulecode:${activationId}`,
            kind: 'rulecode_decision',
            taskId: activationId,
            title: 'RuleCode 影子规则待决',
            summary: '一条 code_tool_hook 规则处于影子激活期，等待拥有者裁决（提升 / 拒绝）。',
            reasonCode: 'rulecode_shadow_pending_promotion',
            legacy: false,
            allowedActions: ['promote', 'reject_after_shadow'],
            expectedRevisionEpoch: 0,
            expectedSourceRunId: '',
            expectedSourceArtifactId: artifactId,
            expectedSourceArtifactHash: '',
            createdAt: typeof row.activated_at === 'string' ? row.activated_at : '',
          });
        }
      } catch {
        // activations 表缺失 → 跳过
      }

      return { items, total: items.length, generatedAt: new Date().toISOString() };
    } finally {
      conn.close();
    }
  }

  /**
   * failed-tasks 列表分流字段: 该 NHR 任务是否 decision-capable
   * (decision-capable → 前往治理焦点；technical → Recover)。
   */
  async ownerDecisionRequiredTaskIds(): Promise<Set<string>> {
    const stateDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    if (!fs.existsSync(stateDbPath)) return new Set();
    const conn = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
    try {
      const db = conn.getDb();
      const artifactStore: PIArtifactStore = new SqlitePIArtifactStore(conn);
      const ids = new Set<string>();
      let rows: Record<string, unknown>[] = [];
      try {
        rows = db.prepare(
          `SELECT * FROM tasks WHERE status = 'needs_human_review' AND task_kind IN ('evaluator', 'rollout_reviewer')`,
        ).all().filter(isRecordRow);
      } catch {
        return ids;
      }
      for (const row of rows) {
        const task = rowToTaskRecord(row);
        if (!task) continue;
        const item = await deriveTaskDecisionItem(task, { artifactStore, readTaskRow: makeRowReader(db) });
        if (item) ids.add(task.taskId);
      }
      return ids;
    } finally {
      conn.close();
    }
  }

}
