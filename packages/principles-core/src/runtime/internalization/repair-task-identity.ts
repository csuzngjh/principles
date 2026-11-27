/**
 * repair-task-identity.ts — Repair 任务身份完整验证的单一实现 (PRI-1293 R7 P1-1)。
 *
 * 生产消费方必须共享同一规则 (禁止各自演化):
 *   1. host-runtime Repair Seeder 复用前验证;
 *   2. pd-cli RuleHost Repair Seeder 复用前验证;
 *   3. orchestrator REOPEN_SOURCE_EVALUATOR 分支在修改来源 Evaluator 之前验证;
 *   4. evaluator/owner 消费 repair dependency 或推断 repair round 之前验证。
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
import { artificerRepairTaskId, hydratePITaskRecord } from './pitask-metadata.js';
import type { RepairPayload } from './pitask-metadata.js';
import type { PITaskRecord } from './peer-runner-contracts.js';
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
  let srcRaw: TaskRecord | null;
  try {
    srcRaw = await stateManager.getTask(payload.sourceEvaluatorTaskId);
  } catch (error) {
    return fail(
      'repair_identity_store_read_failed',
      `source=${payload.sourceEvaluatorTaskId};error=${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
  let lineage: Awaited<ReturnType<typeof planLegacyLineageResolution>>;
  try {
    lineage = await planLegacyLineageResolution(srcRaw, stateManager);
  } catch (error) {
    return fail(
      'repair_source_lineage_unprovable',
      `source=${payload.sourceEvaluatorTaskId};store_read_failed:${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

export type VerifiedRepairIdentity = Extract<RepairIdentityVerification, { readonly ok: true }>;

export type EvaluatorArtificerDependencyCandidate =
  | { readonly class: 'ordinary'; readonly task: TaskRecord; readonly piTask: PITaskRecord }
  | {
      readonly class: 'legal_repair' | 'legacy_repair';
      readonly task: TaskRecord;
      readonly piTask: PITaskRecord;
      readonly payload: RepairPayload;
      readonly identity: VerifiedRepairIdentity;
    }
  | {
      readonly class: 'role_only';
      readonly task: TaskRecord;
      readonly piTask: PITaskRecord;
      readonly reason: 'repair_role_payload_missing';
      readonly detail: string;
    }
  | {
      readonly class: 'malformed';
      readonly dependencyTaskId: string;
      readonly task?: TaskRecord;
      readonly reason: string;
      readonly detail: string;
    }
  | {
      readonly class: 'unprovable';
      readonly dependencyTaskId: string;
      readonly task?: TaskRecord;
      readonly piTask?: PITaskRecord;
      readonly reason: string;
      readonly detail: string;
    };

export interface EvaluatorArtificerDependencyScan {
  readonly evaluatorTaskId: string;
  readonly evaluatorMetadataMalformed: boolean;
  readonly candidates: readonly EvaluatorArtificerDependencyCandidate[];
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read-only complete scan of every artificer dependency. Unlike singular input
 * selection, this scan does not stop at the first ordinary or corrupt row: the
 * orchestrator must see all repair-round evidence before reopen can destructively
 * replace the evaluator dependency set.
 */
export async function scanEvaluatorArtificerDependencyIdentity(input: {
  readonly evaluatorTask: TaskRecord;
  readonly store: CorrelationLineageTaskStore;
}): Promise<EvaluatorArtificerDependencyScan> {
  const { evaluatorTask, store } = input;
  const evaluatorPi = hydratePITaskRecord(evaluatorTask);
  if (!evaluatorPi) {
    return { evaluatorTaskId: evaluatorTask.taskId, evaluatorMetadataMalformed: true, candidates: [] };
  }

  const candidates: EvaluatorArtificerDependencyCandidate[] = [];
  const seenDependencyIds = new Set<string>();
  for (const depId of evaluatorPi.dependencyTaskIds) {
    if (seenDependencyIds.has(depId)) continue;
    seenDependencyIds.add(depId);

    let dep: TaskRecord | null;
    try {
      dep = await store.getTask(depId);
    } catch (error) {
      candidates.push({
        class: 'unprovable',
        dependencyTaskId: depId,
        reason: 'evaluator_artificer_dependency_read_failed',
        detail: `evaluator=${evaluatorTask.taskId};dependency=${depId};error=${errorDetail(error)}`,
      });
      continue;
    }
    if (!dep || dep.taskKind !== 'artificer') {
      if (depId.startsWith(`artificer-repair-${evaluatorTask.taskId}-r`)) {
        candidates.push({
          class: 'unprovable',
          dependencyTaskId: depId,
          task: dep ?? undefined,
          reason: 'repair_dependency_missing_or_wrong_kind',
          detail: `evaluator=${evaluatorTask.taskId};dependency=${depId};kind=${dep?.taskKind ?? 'missing'}`,
        });
      }
      continue;
    }

    const depPi = hydratePITaskRecord(dep);
    if (!depPi) {
      candidates.push({
        class: 'malformed',
        dependencyTaskId: depId,
        task: dep,
        reason: 'evaluator_artificer_dependency_metadata_malformed',
        detail: `evaluator=${evaluatorTask.taskId};dependency=${dep.taskId}`,
      });
      continue;
    }
    if (depPi.repairTaskRole !== undefined && depPi.repairTaskRole !== 'repair_artificer') {
      candidates.push({
        class: 'unprovable',
        dependencyTaskId: depId,
        task: dep,
        piTask: depPi,
        reason: 'repair_role_mismatch',
        detail: `evaluator=${evaluatorTask.taskId};dependency=${dep.taskId};role=${depPi.repairTaskRole}`,
      });
      continue;
    }
    if (depPi.repairTaskRole === 'repair_artificer' && !depPi.repairPayload) {
      candidates.push({
        class: 'role_only',
        task: dep,
        piTask: depPi,
        reason: 'repair_role_payload_missing',
        detail: `evaluator=${evaluatorTask.taskId};dependency=${dep.taskId}`,
      });
      continue;
    }
    if (!depPi.repairPayload) {
      const reservedRepairIteration = depId === artificerRepairTaskId(evaluatorTask.taskId, 1) ? 1
        : depId === artificerRepairTaskId(evaluatorTask.taskId, 2) ? 2
          : null;
      if (reservedRepairIteration !== null) {
        candidates.push({
          class: 'malformed',
          dependencyTaskId: depId,
          task: dep,
          reason: 'repair_payload_missing',
          detail: `evaluator=${evaluatorTask.taskId};dependency=${dep.taskId};reserved_iteration=${reservedRepairIteration}`,
        });
        continue;
      }
      candidates.push({ class: 'ordinary', task: dep, piTask: depPi });
      continue;
    }

    let identity: RepairIdentityVerification;
    try {
      identity = await verifyRepairTaskIdentity(dep, evaluatorTask.taskId, depPi.repairPayload.repairIteration, store);
    } catch (error) {
      candidates.push({
        class: 'unprovable',
        dependencyTaskId: depId,
        task: dep,
        piTask: depPi,
        reason: 'repair_identity_store_read_failed',
        detail: `evaluator=${evaluatorTask.taskId};dependency=${dep.taskId};error=${errorDetail(error)}`,
      });
      continue;
    }
    if (!identity.ok) {
      candidates.push({
        class: 'unprovable',
        dependencyTaskId: depId,
        task: dep,
        piTask: depPi,
        reason: identity.reason,
        detail: `evaluator=${evaluatorTask.taskId};dependency=${dep.taskId};${identity.detail}`,
      });
      continue;
    }
    candidates.push({
      class: identity.needsLineageBackfill ? 'legacy_repair' : 'legal_repair',
      task: dep,
      piTask: depPi,
      payload: depPi.repairPayload,
      identity,
    });
  }

  return { evaluatorTaskId: evaluatorTask.taskId, evaluatorMetadataMalformed: false, candidates };
}

export type EvaluatorArtificerDependencyResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'ordinary'; readonly task: TaskRecord; readonly piTask: PITaskRecord }
  | {
      readonly kind: 'repair';
      readonly task: TaskRecord;
      readonly piTask: PITaskRecord;
      readonly payload: RepairPayload;
      readonly identity: VerifiedRepairIdentity;
      /** payload-valid row whose durable role/parent/correlation is absent but backfillable. */
      readonly legacyRepair: boolean;
    }
  | { readonly kind: 'invalid'; readonly reason: string; readonly detail: string };

function invalidDependency(reason: string, detail: string): EvaluatorArtificerDependencyResolution {
  return { kind: 'invalid', reason, detail };
}

function invalidCandidateDetail(candidate: Extract<EvaluatorArtificerDependencyCandidate, { readonly class: 'role_only' | 'malformed' | 'unprovable' }>): string {
  return candidate.detail;
}

/**
 * Singular adapter for consumers answering "which artifact/input is the evaluator
 * currently bound to?". For that question multiple artificer rows are genuinely
 * ambiguous; stale-round evidence scanning uses scanEvaluatorArtificerDependencyIdentity
 * directly instead.
 */
export async function resolveEvaluatorArtificerDependencyIdentity(input: {
  readonly evaluatorTask: TaskRecord;
  readonly store: CorrelationLineageTaskStore;
}): Promise<EvaluatorArtificerDependencyResolution> {
  const scan = await scanEvaluatorArtificerDependencyIdentity(input);
  if (scan.evaluatorMetadataMalformed) {
    return invalidDependency('evaluator_metadata_unreadable', `evaluator=${scan.evaluatorTaskId}`);
  }
  const invalid = scan.candidates.find((candidate): candidate is Extract<EvaluatorArtificerDependencyCandidate, { readonly class: 'role_only' | 'malformed' | 'unprovable' }> =>
    candidate.class === 'role_only' || candidate.class === 'malformed' || candidate.class === 'unprovable');
  if (invalid) {
    return invalidDependency(invalid.reason, invalidCandidateDetail(invalid));
  }
  if (scan.candidates.length === 0) return { kind: 'none' };
  if (scan.candidates.length > 1) {
    return invalidDependency('evaluator_ambiguous_artificer_dependencies', `evaluator=${scan.evaluatorTaskId};count=${scan.candidates.length}`);
  }
  const [candidate] = scan.candidates;
  if (!candidate) return invalidDependency('evaluator_artificer_dependency_unresolved', `evaluator=${scan.evaluatorTaskId}`);
  if (candidate.class === 'ordinary') {
    return { kind: 'ordinary', task: candidate.task, piTask: candidate.piTask };
  }
  if (candidate.class === 'legal_repair' || candidate.class === 'legacy_repair') {
    return {
      kind: 'repair',
      task: candidate.task,
      piTask: candidate.piTask,
      payload: candidate.payload,
      identity: candidate.identity,
      legacyRepair: candidate.class === 'legacy_repair',
    };
  }
  return invalidDependency('evaluator_artificer_dependency_unresolved', `evaluator=${scan.evaluatorTaskId}`);
}

export type StaleRepairTransitionPlan =
  | { readonly kind: 'clear' }
  | { readonly kind: 'superseded' }
  | { readonly kind: 'invalid'; readonly reason: string; readonly detail: string };

/** Pure stale-round adjudication over the complete scan. Ordinary rows are input-chain evidence, not repair-round evidence. */
export function planStaleRepairTransitionFromDependencyScan(input: {
  readonly scan: EvaluatorArtificerDependencyScan;
  readonly completingRepairTaskId: string;
  readonly completingRepairIteration: number;
}): StaleRepairTransitionPlan {
  const { scan } = input;
  if (scan.evaluatorMetadataMalformed) {
    return { kind: 'invalid', reason: 'evaluator_metadata_unreadable', detail: `evaluator=${scan.evaluatorTaskId}` };
  }
  const invalid = scan.candidates.find((candidate) => candidate.class === 'role_only' || candidate.class === 'malformed' || candidate.class === 'unprovable');
  if (invalid && (invalid.class === 'role_only' || invalid.class === 'malformed' || invalid.class === 'unprovable')) {
    return { kind: 'invalid', reason: invalid.reason, detail: invalid.detail };
  }
  const provenRepairs = scan.candidates.filter((candidate): candidate is Extract<EvaluatorArtificerDependencyCandidate, { readonly class: 'legal_repair' | 'legacy_repair' }> =>
    candidate.class === 'legal_repair' || candidate.class === 'legacy_repair');
  if (provenRepairs.length > 1) {
    return {
      kind: 'invalid',
      reason: 'evaluator_ambiguous_repair_dependencies',
      detail: `evaluator=${scan.evaluatorTaskId};repairCount=${provenRepairs.length}`,
    };
  }
  const [repair] = provenRepairs;
  if (repair
    && repair.task.taskId !== input.completingRepairTaskId
    && repair.payload.repairIteration > input.completingRepairIteration) {
    return { kind: 'superseded' };
  }
  return { kind: 'clear' };
}