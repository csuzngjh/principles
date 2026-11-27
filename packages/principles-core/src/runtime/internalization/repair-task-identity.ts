/**
 * repair-task-identity.ts — Repair 任务身份完整验证的单一实现 (PRI-1293 R7 P1-1)。
 *
 * 三个生产消费方必须共享同一规则 (禁止各自演化):
 *   1. host-runtime Repair Seeder 复用前验证;
 *   2. pd-cli RuleHost Repair Seeder 复用前验证;
 *   3. orchestrator REOPEN_SOURCE_EVALUATOR 分支在修改来源 Evaluator 之前验证。
 *
 * 确定性任务 id (artificerRepairTaskId) 不证明 diagnosticJson 内 repairPayload
 * 与本次请求一致 — 复用/完成路径都必须重新验证持久化 payload 的完整身份:
 *   payload 存在 + 来源/iteration 与请求一致 + taskId 与 payload 身份互证 +
 *   来源 Evaluator 真实存在且类型正确 + parentTaskId 指向来源 +
 *   correlationId 与权威来源一致 + channel 一致。
 *
 * fail-closed 边界: 缺失 repairPayload、payload 来源/iteration 不一致、taskId
 * 互证失败, 一律拒绝 — 不得回填伪造修复身份。仅 parentTaskId/correlationId
 * 缺失且来源已证明时可安全补齐 (调用方经既有 CAS 执行, 本模块只读)。
 */

import type { TaskRecord } from '../task-status.js';
import { hydratePITaskRecord } from './pitask-metadata.js';
import { artificerRepairTaskId } from './pitask-metadata.js';
import { planLegacyLineageResolution, type CorrelationLineageTaskStore } from './correlation-lineage.js';

export type RepairIdentityVerification =
  | {
    readonly ok: true;
    /** 来源 Evaluator 的权威 correlationId (链经 canonical resolver 验证)。 */
    readonly authoritativeCorrelationId: string;
    /** repair 的 parentTaskId/correlationId 缺失但来源已证明 — 调用方应 CAS 补齐。 */
    readonly needsLineageBackfill: boolean;
    /** repair 任务 hydrate 后的 channel (供调用方一致性断言记录)。 */
    readonly channel: string;
  }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

function fail(reason: string, detail: string): RepairIdentityVerification {
  return { ok: false, reason, detail };
}

/**
 * 只读验证 repair 任务身份。不写任何状态 — 回填由调用方经全快照 CAS 执行。
 *
 * @param existing 复用/完成路径读到的 repair 任务行
 * @param expectedSourceEvaluatorTaskId 请求侧来源 Evaluator (seeder 参数或
 *   payload 自证值)
 * @param expectedRepairIteration 请求侧 iteration
 */
// eslint-disable-next-line @typescript-eslint/max-params -- stateManager 是服务端口而非请求参数, 折入请求对象会让纯数据类型携带依赖。
export async function verifyRepairTaskIdentity(
  existing: TaskRecord,
  expectedSourceEvaluatorTaskId: string,
  expectedRepairIteration: number,
  stateManager: CorrelationLineageTaskStore,
): Promise<RepairIdentityVerification> {
  // 1. 类型
  if (existing.taskKind !== 'artificer') {
    return fail('repair_identity_not_artificer', `task=${existing.taskId};kind=${existing.taskKind}`);
  }
  // 2. 可 hydrate
  const pi = hydratePITaskRecord(existing);
  if (!pi) {
    return fail('repair_identity_unreadable_metadata', `task=${existing.taskId}`);
  }
  // 3. repairPayload 必须存在 — 缺失不得猜测来源
  const payload = pi.repairPayload;
  if (!payload) {
    return fail('repair_payload_missing', `task=${existing.taskId}`);
  }
  // PRI-1299 OD-8: durable role is part of repair identity. Missing role on a
  // payload-valid legacy row is backfillable; a wrong explicit role is conflict.
  if (pi.repairTaskRole !== undefined && pi.repairTaskRole !== 'repair_artificer') {
    return fail('repair_role_mismatch', `task=${existing.taskId};role=${pi.repairTaskRole}`);
  }
  // 4/5. payload 来源与 iteration 必须与请求一致
  if (payload.sourceEvaluatorTaskId !== expectedSourceEvaluatorTaskId) {
    return fail(
      'repair_payload_source_mismatch',
      `task=${existing.taskId};payload_source=${payload.sourceEvaluatorTaskId};expected=${expectedSourceEvaluatorTaskId}`,
    );
  }
  if (payload.repairIteration !== expectedRepairIteration) {
    return fail(
      'repair_payload_iteration_mismatch',
      `task=${existing.taskId};payload_iteration=${String(payload.repairIteration)};expected=${String(expectedRepairIteration)}`,
    );
  }
  // 6. taskId 与 payload 身份互证
  const derivedId = artificerRepairTaskId(payload.sourceEvaluatorTaskId, payload.repairIteration);
  if (derivedId !== existing.taskId) {
    return fail(
      'repair_task_id_payload_mismatch',
      `task=${existing.taskId};derived=${derivedId}`,
    );
  }
  // 7. 来源 Evaluator 真实存在且类型正确
  const srcRaw = await stateManager.getTask(payload.sourceEvaluatorTaskId);
  if (!srcRaw) {
    return fail('repair_source_evaluator_missing', `source=${payload.sourceEvaluatorTaskId}`);
  }
  if (srcRaw.taskKind !== 'evaluator') {
    return fail('repair_source_not_evaluator', `source=${payload.sourceEvaluatorTaskId};kind=${srcRaw.taskKind}`);
  }
  const srcPi = hydratePITaskRecord(srcRaw);
  if (!srcPi) {
    return fail('repair_source_unreadable_metadata', `source=${payload.sourceEvaluatorTaskId}`);
  }
  // 8. parentTaskId 一致性 (缺失 = 可回填, 冲突 = 拒绝)
  const existingParent = typeof pi.parentTaskId === 'string' && pi.parentTaskId.trim() !== '' ? pi.parentTaskId.trim() : null;
  if (existingParent !== null && existingParent !== payload.sourceEvaluatorTaskId) {
    return fail(
      'repair_parent_conflicts_payload_source',
      `task=${existing.taskId};parent=${existingParent};source=${payload.sourceEvaluatorTaskId}`,
    );
  }
  // 9. correlationId 与来源权威 id 一致 (缺失 = 可回填, 冲突 = 拒绝)
  // PRI-1293 R7 (P1-1+P2-1 统一): 与 reopen 路径同一判定语义 — 只读
  // planner 走与回填版相同的推理路径 (已知生产者结构 + 唯一 typed
  // predecessor + canonical overlay 终验), 不写库; 可证明的历史链在此
  // 恢复, 不可证明的一致拒绝。调用方随后经全快照 CAS 执行实际回填。
  const lineage = await planLegacyLineageResolution(srcRaw, stateManager);
  if (!lineage.ok) {
    return fail('repair_source_lineage_unprovable', `source=${payload.sourceEvaluatorTaskId};${lineage.reason}:${lineage.detail}`);
  }
  const existingCorrelation = typeof pi.correlationId === 'string' && pi.correlationId.trim() !== '' ? pi.correlationId.trim() : null;
  if (existingCorrelation !== null && existingCorrelation !== lineage.correlationId) {
    return fail(
      'repair_correlation_conflicts_authoritative',
      `task=${existing.taskId};correlationId=${existingCorrelation};authoritative=${lineage.correlationId}`,
    );
  }
  // 10. channel 一致
  if (pi.channel !== srcPi.channel) {
    return fail(
      'repair_channel_mismatch',
      `task=${existing.taskId};channel=${pi.channel};source_channel=${srcPi.channel}`,
    );
  }
  return {
    ok: true,
    authoritativeCorrelationId: lineage.correlationId,
    needsLineageBackfill: existingParent === null || existingCorrelation === null || pi.repairTaskRole === undefined,
    channel: pi.channel,
  };
}
