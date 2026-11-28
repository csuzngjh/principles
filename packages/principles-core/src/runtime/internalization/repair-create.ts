/**
 * repair-create.ts — Repair task creation 的唯一权威 (PRI-1299 Phase 1 / OD-1).
 *
 * 两个生产入口 (host-runtime consumer governance、pd-cli RuleHost runner)
 * 必须只做参数装配与错误映射; repair identity、reuse adjudication、lineage
 * proof、insert 和 UNIQUE-race re-arbitration 全部收敛到本模块。
 *
 * RepairSuccessorIdentity = (sourceEvaluatorTaskId, taskKind='artificer',
 * channel, repairIteration)。channel 是 mandatory consistency dimension:
 * mismatch fail closed,不得成为创建第二行 repair 的理由。R1/R2 拥有不同
 * repairIteration,因此合法共存;同一 identity 的复用必须先验证完整 payload。
 */

import type { TaskRecord } from '../task-status.js';
import { canonicalStringify } from './artifact-content-hash.js';
import type { OwnerEvidenceSelection } from './evidence-readiness.js';
import type { InternalizationChannel, PipelineTopologyMode, ArtifactRef } from './peer-runner-contracts.js';
import { resolveAuthoritativeCorrelationId } from './correlation-lineage.js';
import type { RepairLineageBackfillStore } from './repair-lineage-backfill.js';
import { validateAndBackfillRepairLineage } from './repair-lineage-backfill.js';
import { verifyRepairTaskIdentity } from './repair-task-identity.js';
import {
  artificerRepairTaskId,
  createPITaskDiagnosticJson,
  hydratePITaskRecord,
  isValidRepairPayload,
  type RepairPayload,
} from './pitask-metadata.js';

/** RepairCreationAuthority 对任务存储的最窄写侧需求。 */
export interface RepairCreationAuthorityStore extends RepairLineageBackfillStore {
  createTask(record: Omit<TaskRecord, 'createdAt' | 'updatedAt'>): Promise<TaskRecord>;
  withWriteTransaction<T>(fn: () => Promise<T>): Promise<T>;
}

/** 与 SeedArtificerRepairParams 同构,但保持 authority 输入自包含。 */
export interface RepairCreationRequest {
  readonly repairPayload: RepairPayload;
  readonly inheritedDependencyTaskIds: readonly string[];
  readonly inheritedChannel: InternalizationChannel;
  readonly inheritedPipelineMode?: PipelineTopologyMode;
  readonly inheritedTimeoutMs: number;
  readonly inheritedInputArtifactRefs: readonly ArtifactRef[];
  readonly ownerEvidenceSelection?: OwnerEvidenceSelection;
}

export type RepairCreationResult =
  | { readonly outcome: 'created'; readonly task: TaskRecord }
  | {
      readonly outcome: 'adopted_existing';
      readonly task: TaskRecord;
      readonly backfilled: boolean;
    }
  | { readonly outcome: 'conflict'; readonly reason: string; readonly detail: string; readonly task?: TaskRecord; readonly failureStage?: 'creation' | 'adoption' }
  | { readonly outcome: 'fail_closed'; readonly reason: string; readonly detail: string; readonly task?: TaskRecord; readonly failureStage?: 'creation' | 'adoption' };

export type RepairCreationFailureResult = Exclude<
  RepairCreationResult,
  { readonly outcome: 'created' } | { readonly outcome: 'adopted_existing' }
>;

/**
 * Backward-compatible host error text for a failed creation/adoption outcome.
 * host-runtime and pd-cli intentionally preserve their legacy throw-based
 * seeder contract; keeping this pure mapping beside the authority prevents
 * drift while leaving recovery classification unchanged.
 */
export function repairSeedErrorMessage(result: RepairCreationFailureResult): string {
  if (result.reason === 'concurrent_modification') {
    return `evaluator_repair_seed_concurrent_modification: repair task ${result.task?.taskId ?? 'unknown'} changed during lineage backfill — seed NOT applied, safe to retry`;
  }
  if (result.reason === 'terminal_repair_task') return result.detail;
  if (result.failureStage !== 'adoption' && result.reason === 'repair_source_evaluator_missing') {
    return `evaluator_repair_seed_lineage_refused: ${result.detail}`;
  }
  if (result.failureStage !== 'adoption' && result.reason === 'repair_source_lineage_unprovable') {
    return `evaluator_repair_seed_lineage_refused:${result.detail}`;
  }
  return `evaluator_repair_seed_lineage_refused:${result.reason}:${result.detail}`;
}

// eslint-disable-next-line @typescript-eslint/max-params -- optional provenance discriminator keeps legacy error mapping local without widening the request object.
function fail(reason: string, detail: string, task?: TaskRecord, failureStage?: 'creation' | 'adoption'): RepairCreationResult {
  return task === undefined
    ? { outcome: 'fail_closed', reason, detail, ...(failureStage !== undefined ? { failureStage } : {}) }
    : { outcome: 'fail_closed', reason, detail, task, ...(failureStage !== undefined ? { failureStage } : {}) };
}

// eslint-disable-next-line @typescript-eslint/max-params -- optional provenance discriminator keeps legacy error mapping local without widening the request object.
function conflict(reason: string, detail: string, task?: TaskRecord, failureStage?: 'creation' | 'adoption'): RepairCreationResult {
  return task === undefined
    ? { outcome: 'conflict', reason, detail, ...(failureStage !== undefined ? { failureStage } : {}) }
    : { outcome: 'conflict', reason, detail, task, ...(failureStage !== undefined ? { failureStage } : {}) };
}

function isTerminalRepairTask(task: TaskRecord): boolean {
  return task.status === 'succeeded' || task.status === 'failed' || task.status === 'needs_human_review';
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint') || message.includes('PRIMARY KEY') || message.includes('already exists');
}

function samePayload(existing: RepairPayload | undefined, requested: RepairPayload): boolean | 'unbounded' {
  if (existing === undefined) return false;
  const left = canonicalStringify(existing);
  const right = canonicalStringify(requested);
  if (left.truncated || right.truncated) return 'unbounded';
  return left.text === right.text;
}

/**
 * 复用已有 deterministic-id repair。任何 payload/channel/lineage 不符都
 * fail closed;只有 identity 与 payload 完全一致的在途任务可以 adopted。
 */
async function adoptExistingRepairTask(input: {
  readonly store: RepairCreationAuthorityStore;
  readonly existing: TaskRecord;
  readonly params: RepairCreationRequest;
  readonly repairTaskId: string;
}): Promise<RepairCreationResult> {
  const { store, existing, params, repairTaskId } = input;
  if (isTerminalRepairTask(existing)) {
    return conflict(
      'terminal_repair_task',
      `repair task ${repairTaskId} already reached terminal status ${existing.status}; refusing to reuse it as new corrective work (PRI-718 revise-ne-resume)`,
      existing,
      'adoption',
    );
  }

  const identity = await verifyRepairTaskIdentity(
    existing,
    params.repairPayload.sourceEvaluatorTaskId,
    params.repairPayload.repairIteration,
    store,
  );
  if (!identity.ok) {
    return fail(identity.reason, identity.detail, existing, 'adoption');
  }

  const pi = hydratePITaskRecord(existing);
  if (!pi) {
    return fail('repair_identity_unreadable_metadata', `task=${repairTaskId}`, existing, 'adoption');
  }
  if (pi.channel !== params.inheritedChannel) {
    return fail(
      'repair_channel_mismatch',
      `task=${repairTaskId};channel=${pi.channel};requested_channel=${params.inheritedChannel}`,
      existing,
      'adoption',
    );
  }
  const payloadMatch = samePayload(pi.repairPayload, params.repairPayload);
  if (payloadMatch === 'unbounded') {
    return fail('repair_payload_unbounded', `task=${repairTaskId};payload exceeds canonical comparison budget`, existing, 'adoption');
  }
  if (!payloadMatch) {
    return conflict('repair_payload_mismatch', `task=${repairTaskId};persisted repair payload differs from requested payload`, existing, 'adoption');
  }

  if (!identity.needsLineageBackfill) {
    return { outcome: 'adopted_existing', task: existing, backfilled: false };
  }
  const lineage = await validateAndBackfillRepairLineage(
    {
      repairTaskId,
      existing,
      sourceEvaluatorTaskId: params.repairPayload.sourceEvaluatorTaskId,
      repairIteration: params.repairPayload.repairIteration,
    },
    store,
  );
  if (!lineage.ok) {
    if (lineage.reason === 'concurrent_modification') {
      return conflict('concurrent_modification', lineage.detail, existing, 'adoption');
    }
    return fail(lineage.reason, lineage.detail, existing, 'adoption');
  }

  const adopted = lineage.backfilled ? await store.getTask(repairTaskId) : existing;
  if (adopted === null) {
    return fail('repair_task_disappeared_after_backfill', `task=${repairTaskId}`, undefined, 'adoption');
  }
  return {
    outcome: 'adopted_existing',
    task: adopted,
    backfilled: lineage.backfilled,
  };
}

async function proveRepairLineage(
  store: RepairCreationAuthorityStore,
  params: RepairCreationRequest,
): Promise<{ readonly ok: true; readonly correlationId: string } | { readonly ok: false; readonly reason: string; readonly detail: string }> {
  const sourceTask = await store.getTask(params.repairPayload.sourceEvaluatorTaskId);
  if (sourceTask === null) {
    return { ok: false, reason: 'repair_source_evaluator_missing', detail: `source evaluator task ${params.repairPayload.sourceEvaluatorTaskId} not found` };
  }
  if (sourceTask.taskKind !== 'evaluator') {
    return { ok: false, reason: 'repair_source_not_evaluator', detail: `source=${params.repairPayload.sourceEvaluatorTaskId};kind=${sourceTask.taskKind}` };
  }
  const sourcePi = hydratePITaskRecord(sourceTask);
  if (!sourcePi) {
    return { ok: false, reason: 'repair_source_unreadable_metadata', detail: `source=${params.repairPayload.sourceEvaluatorTaskId}` };
  }
  if (sourcePi.channel !== params.inheritedChannel) {
    return {
      ok: false,
      reason: 'repair_channel_mismatch',
      detail: `source=${params.repairPayload.sourceEvaluatorTaskId};source_channel=${sourcePi.channel};requested_channel=${params.inheritedChannel}`,
    };
  }
  const lineage = await resolveAuthoritativeCorrelationId(
    sourceTask,
    (taskId: string) => store.getTask(taskId),
  );
  if (!lineage.ok) {
    return { ok: false, reason: lineage.reason, detail: lineage.detail };
  }
  return { ok: true, correlationId: lineage.correlationId };
}

/**
 * Create or adopt the unique repair task for one RepairSuccessorIdentity.
 *
 * 所有 read-check-write 都在 store 的 write transaction 内执行;SQLite
 * BEGIN IMMEDIATE 将跨连接 seeding serialize。UNIQUE race 必须重新仲裁为
 * adopted/conflict/fail_closed,不得冒泡成 generic seed failure。
 */
export async function createRepairTask(
  store: RepairCreationAuthorityStore,
  params: RepairCreationRequest,
): Promise<RepairCreationResult> {
  return store.withWriteTransaction(async () => {
    if (!isValidRepairPayload(params.repairPayload)) {
      return fail('malformed_repair_payload', 'repairPayload failed structural validation');
    }
    const repairTaskId = artificerRepairTaskId(
      params.repairPayload.sourceEvaluatorTaskId,
      params.repairPayload.repairIteration,
    );

    const existing = await store.getTask(repairTaskId);
    if (existing !== null) {
      return adoptExistingRepairTask({ store, existing, params, repairTaskId });
    }

    const lineage = await proveRepairLineage(store, params);
    if (!lineage.ok) {
      return fail(lineage.reason, lineage.detail);
    }

    try {
      const task = await store.createTask({
        taskId: repairTaskId,
        taskKind: 'artificer',
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 3,
        diagnosticJson: createPITaskDiagnosticJson({
          dependencyTaskIds: [...params.inheritedDependencyTaskIds],
          channel: params.inheritedChannel,
          pipelineMode: params.inheritedPipelineMode,
          timeoutMs: params.inheritedTimeoutMs,
          inputArtifactRefs: [...params.inheritedInputArtifactRefs],
          outputArtifactRefs: [],
          parentTaskId: params.repairPayload.sourceEvaluatorTaskId,
          correlationId: lineage.correlationId,
          ...(params.ownerEvidenceSelection !== undefined
            ? { ownerEvidenceSelection: params.ownerEvidenceSelection }
            : {}),
          repairPayload: params.repairPayload,
          repairTaskRole: 'repair_artificer',
        }),
      });
      return { outcome: 'created', task };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await store.getTask(repairTaskId);
      if (raced === null) {
        return fail('unique_violation_without_verified_repair', `task=${repairTaskId};insert collided but no repair row is visible`);
      }
      return adoptExistingRepairTask({ store, existing: raced, params, repairTaskId });
    }
  });
}
