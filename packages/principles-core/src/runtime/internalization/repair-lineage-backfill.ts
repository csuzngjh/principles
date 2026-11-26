/**
 * repair-lineage-backfill.ts — Repair 任务血缘校验 + 六项快照前提 CAS 回填的
 * 唯一写侧实现 (PRI-1300)。
 *
 * 三个生产消费方共享同一规则 (禁止各自演化):
 *   1. host-runtime Repair Seeder 复用路径;
 *   2. pd-cli RuleHost Repair Seeder 复用路径;
 *   3. orchestrator REOPEN_SOURCE_EVALUATOR 分支 (repair 完成后修改来源
 *      Evaluator 之前的身份前置验证 + 回填)。
 *
 * 本模块组合 (而非复制) 两个既有权威:
 *   - verifyRepairTaskIdentity (repair-task-identity.ts): 只读完整身份验证 —
 *     payload 存在 + 来源/iteration 一致 + taskId 互证 + 来源 Evaluator 真实
 *     + parent/correlation 一致 + channel 一致;
 *   - 六项快照前提 CAS (diagnosticJson + status/attemptCount/maxAttempts/
 *     leaseOwner/leaseExpiresAt/leaseGeneration): 缺失亲缘字段的安全补齐。
 *
 * fail-closed 边界与 verifyRepairTaskIdentity 相同: payload 身份不符一律拒绝,
 * 仅 parentTaskId/correlationId 缺失且来源已证明时经 CAS 补齐。CAS 落败 =
 * 并发修改, 返回结构化 concurrent_modification — 零部分写入 (单条条件 UPDATE
 * 要么整体应用要么整体不应用), 调用方安全重试。
 *
 * 本模块不写日志、不抛宿主包装错误: 结构化结果的 reason/detail 沿用
 * verifyRepairTaskIdentity 的既有词汇, 宿主层负责逐字映射为既有 throw 字符串
 * (evaluator_repair_seed_lineage_refused:... /
 *  evaluator_repair_seed_concurrent_modification:...) 或 orchestrator 决策。
 */

import type { TaskRecord } from '../task-status.js';
import type { TaskStoreUpdatePatch } from '../store/task/task-store.js';
import type { CorrelationLineageTaskStore } from './correlation-lineage.js';
import { verifyRepairTaskIdentity } from './repair-task-identity.js';
import { hydratePITaskRecord, mergePITaskMetadata, createPITaskDiagnosticJson, PI_METADATA_KEY } from './pitask-metadata.js';

/**
 * 血缘回填对任务存储的最窄需求 — 不得传入整个宿主对象:
 *   - getTask / listTasks: 权威血缘解析的只读取证面 (见
 *     CorrelationLineageTaskStore; listTasks 供 legacy adversarial round≥2
 *     链的唯一前置 Evaluator 推断, 非推测性暴露);
 *   - updateTaskIfDiagnosticJsonUnchanged: 回填唯一写路径 (单条条件 UPDATE,
 *     六项快照前提不满足则整体不应用)。
 * RuntimeStateManager 结构满足本接口 — 宿主注入既有实例即可。
 */
export interface RepairLineageBackfillStore extends CorrelationLineageTaskStore {
  updateTaskIfDiagnosticJsonUnchanged(
    taskId: string,
    expectedDiagnosticJson: string | null,
    patch: TaskStoreUpdatePatch,
    options?: {
      readonly expectedStatus?: string;
      readonly expectedAttemptCount?: number;
      readonly expectedMaxAttempts?: number;
      readonly expectedLeaseOwner?: string | null;
      readonly expectedLeaseExpiresAt?: string | null;
      readonly expectedLeaseGeneration?: number;
    },
  ): Promise<TaskRecord | null>;
}

export interface ValidateAndBackfillRepairLineageParams {
  /** 确定性 repair 任务 id (artificerRepairTaskId 派生) — 回填 CAS 的目标行。 */
  readonly repairTaskId: string;
  /** 复用/完成路径读到的 repair 任务行 — 身份验证与六项 CAS 前提的快照来源。 */
  readonly existing: TaskRecord;
  /** 请求侧来源 Evaluator (seeder 参数或 payload 自证值)。 */
  readonly sourceEvaluatorTaskId: string;
  /** 请求侧 iteration。 */
  readonly repairIteration: number;
}

/**
 * 结构化判别联合。失败 reason 词汇:
 *   - verifyRepairTaskIdentity 的全部 reason 原样透传
 *     (repair_identity_not_artificer / repair_payload_missing /
 *      repair_payload_source_mismatch / repair_payload_iteration_mismatch /
 *      repair_task_id_payload_mismatch / repair_source_evaluator_missing /
 *      repair_source_not_evaluator / repair_source_unreadable_metadata /
 *      repair_parent_conflicts_payload_source / repair_source_lineage_unprovable /
 *      repair_correlation_conflicts_authoritative / repair_channel_mismatch /
 *      repair_identity_unreadable_metadata);
 *   - 'repair_task_id_mismatch': params.repairTaskId 与 existing.taskId
 *     不一致 — 验证行与写目标不是同一行, fail fast 零写入;
 *   - 'invalid_task_metadata': 验证通过后 diagnosticJson 根文档不可解析
 *     或 merge 前提 hydrate 失败 (防御性分支);
 *   - 'concurrent_modification': 回填 CAS 落败 — 任务在读取后被并发触碰,
 *     零写入, 调用方安全重试。
 */
export type RepairLineageBackfillResult =
  | {
    readonly ok: true;
    /** true = 本次调用经 CAS 补齐了缺失的 parent/correlation; false = 血缘已完整, 零写入。 */
    readonly backfilled: boolean;
    /** 来源 Evaluator 的权威 correlationId (链经 canonical resolver 验证)。 */
    readonly authoritativeCorrelationId: string;
  }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

function fail(reason: string, detail: string): RepairLineageBackfillResult {
  return { ok: false, reason, detail };
}

function parseDiagnosticRoot(diagnosticJson: string | null): Record<string, unknown> | null {
  if (diagnosticJson === null || diagnosticJson.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(diagnosticJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 只替换 namespaced pi_metadata 信封, 保留 diagnosticJson 根上的宿主/Runner
 * 诊断键 (lastValidatorErrors / output_failure_details / validator_error_history
 * 等)。backfill 的授权范围是亲缘字段, 不得借整文档重建丢弃无关重试证据。
 */
function replacePIMetadataEnvelope(existingDiagnosticJson: string | null, metadata: Parameters<typeof createPITaskDiagnosticJson>[0]): string | null {
  const root = parseDiagnosticRoot(existingDiagnosticJson);
  const envelopeRoot = parseDiagnosticRoot(createPITaskDiagnosticJson(metadata));
  const piMetadata = envelopeRoot?.[PI_METADATA_KEY];
  if (root === null || piMetadata === undefined) return null;
  return JSON.stringify({ ...root, [PI_METADATA_KEY]: piMetadata });
}

/**
 * 校验 repair 任务完整身份; 仅在亲缘字段缺失且来源已证明时经六项快照前提
 * CAS 补齐。除该单条条件 UPDATE 外不写任何状态; 任何验证失败或 CAS 落败
 * 都是零写入的结构化拒绝。
 */
export async function validateAndBackfillRepairLineage(
  params: ValidateAndBackfillRepairLineageParams,
  store: RepairLineageBackfillStore,
): Promise<RepairLineageBackfillResult> {
  // 0. 验证快照与 CAS 目标必须是同一行 — 两个标识分别由调用方传入时
  //    不得静默把 A 行的验证结论写到 B 行。
  if (params.repairTaskId !== params.existing.taskId) {
    return fail(
      'repair_task_id_mismatch',
      `param=${params.repairTaskId};snapshot=${params.existing.taskId}`,
    );
  }
  // 1. 只读完整身份验证 (与三消费方同一规则 — 单一实现, 不复制)。
  const identity = await verifyRepairTaskIdentity(
    params.existing,
    params.sourceEvaluatorTaskId,
    params.repairIteration,
    store,
  );
  if (!identity.ok) {
    return fail(identity.reason, identity.detail);
  }
  // 2. merge 前提: hydrate repair metadata (验证通过即可 hydrate — 此分支为
  //    防御性守卫, detail 沿用宿主既有错误语义词汇)。
  const pi = hydratePITaskRecord(params.existing);
  if (!pi) {
    return fail('invalid_task_metadata', `repair task ${params.repairTaskId} diagnosticJson unreadable`);
  }
  // 3. 血缘已完整 — 零写入。
  if (!identity.needsLineageBackfill) {
    return {
      ok: true,
      backfilled: false,
      authoritativeCorrelationId: identity.authoritativeCorrelationId,
    };
  }
  // 4. 缺失亲缘字段按权威来源补齐 — merge 保持其余 metadata 字段, CAS 断言
  //    读取时的完整快照 (diagnosticJson + status/attemptCount/maxAttempts/
  //    leaseOwner/leaseExpiresAt/leaseGeneration 六项前提)。verify 已证明任何
  //    非空 parent/correlation 与权威值一致, 故 merge 覆盖不产生语义变更。
  const merged = mergePITaskMetadata(pi, {
    parentTaskId: params.sourceEvaluatorTaskId,
    correlationId: identity.authoritativeCorrelationId,
  });
  const nextDiagnosticJson = replacePIMetadataEnvelope(params.existing.diagnosticJson ?? null, merged);
  if (nextDiagnosticJson === null) {
    return fail('invalid_task_metadata', `repair task ${params.repairTaskId} diagnosticJson root unreadable`);
  }
  const casResult = await store.updateTaskIfDiagnosticJsonUnchanged(
    params.repairTaskId,
    params.existing.diagnosticJson ?? null,
    { diagnosticJson: nextDiagnosticJson },
    {
      expectedStatus: params.existing.status,
      expectedAttemptCount: params.existing.attemptCount,
      expectedMaxAttempts: params.existing.maxAttempts,
      expectedLeaseOwner: params.existing.leaseOwner ?? null,
      expectedLeaseExpiresAt: params.existing.leaseExpiresAt ?? null,
      expectedLeaseGeneration: params.existing.leaseGeneration ?? 0,
    },
  );
  if (casResult === null) {
    // 并发被触碰 — 单条条件 UPDATE 整体未应用, 零部分写入; 调用方安全重试。
    return fail('concurrent_modification', `task=${params.repairTaskId}`);
  }
  return {
    ok: true,
    backfilled: true,
    authoritativeCorrelationId: identity.authoritativeCorrelationId,
  };
}
