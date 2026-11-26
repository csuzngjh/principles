/**
 * Internalization consumer governance wiring (host-neutral, PRI-624).
 *
 * Ported verbatim from openclaw-plugin `auto-consumer-governance-wiring.ts`
 * (P0-D/E/F 生产接线) so the OpenClaw auto-consumer and the Companion
 * workspace worker share ONE wiring implementation instead of copying it:
 *   - evaluator: isRepairLoopEnabled + seedArtificerRepairTask (bounded repair)
 *   - rollout_reviewer: dispatchActivation (approve_rollout → ActivationDispatcher;
 *     PRI-811 Phase B: 一律入 approvals.pending，Owner 批准后才激活) +
 *     reopenRevisionTarget (needs_revision → reopen scribe/artificer, 禁止入 approval)
 *
 * Everything is assembled from @principles/core stores/dispatchers; the only
 * host knowledge is a structural logger. Idempotency (INV-08): dispatcher
 * dedupes by `${artifactId}::${channel}`; reopen idempotency is owned by
 * orchestrator.reopenTaskForRevision.
 */
import {
  ActivationDispatcher,
  PromptWriter,
  DeferArchiveWriter,
  RuleHostWriter,
  SqliteConnection,
  SqliteActivationStateStore,
  SqliteApprovalQueueStore,
  SqlitePIArtifactStore,
  PrincipleTreeLedgerAdapter,
  createProductionGateDeps,
  createPITaskDiagnosticJson,
  mergePITaskMetadata,
  hydratePITaskRecord,
  artificerRepairTaskId,
  verifyRepairTaskIdentity,
  type RepairIdentityVerification,
  computeFeatureFlagsFromConfig,
  isFeatureEnabled,
  type PIArtifactSnapshot,
  type RolloutAutoDispatchInput,
  type RolloutAutoDispatchOutcome,
  type RolloutRevisionRoutingInput,
  type ActivationDecision,
  type SeedArtificerRepairParams,
  type RuntimeStateManager,
  type ToolSemanticRegistry,
} from '@principles/core/runtime';
// PRI-1293 Phase 3: InternalizationOrchestrator.resolveAuthoritativeCorrelationId
// 静态只读包装 — 跨包访问唯一血缘权威的授权通道 (core 内部模块不进 barrel)。
import { InternalizationOrchestrator } from '@principles/core/runtime';
import { loadPdConfigForPlugin } from './pd-config.js';

/** Structural logger port — PluginLogger satisfies this without adaptation. */
export interface ConsumerGovernanceLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

function normalizeDecision(decision: ActivationDecision): RolloutAutoDispatchOutcome {
  if (decision.decision === 'activated') {
    return { decision: decision.decision, activationId: decision.activationId };
  }
  if (decision.decision === 'already_activated') {
    return { decision: decision.decision, reason: 'idempotent_redispatch' };
  }
  if (decision.decision === 'queued_for_approval') {
    return { decision: decision.decision, reason: decision.approvalId };
  }
  // refused / would_* 家族
  const reason = 'reason' in decision && typeof decision.reason === 'string' ? decision.reason : decision.decision;
  return { decision: decision.decision, reason };
}

function makeFlagProbe(workspaceDir: string): (flagId: string) => boolean {
  const configResult = loadPdConfigForPlugin(workspaceDir);
  if (!configResult.ok) return () => false;
  const flags = computeFeatureFlagsFromConfig(configResult.effective);
  return (flagId: string) => isFeatureEnabled(flags, flagId);
}


/** rollout → ActivationDispatcher 的生产接线 (per dispatch 打开短连接, 与 Console 模式一致) */
export async function dispatchRolloutActivation(
  workspaceDir: string,
  input: RolloutAutoDispatchInput,
  options: { logger?: ConsumerGovernanceLogger; toolSemantics?: ToolSemanticRegistry } = {},
): Promise<RolloutAutoDispatchOutcome> {
  const connection = new SqliteConnection(workspaceDir);
  try {
    const piArtifactStore = new SqlitePIArtifactStore(connection);
    const artifactReadModel = {
      getArtifactById: async (id: string): Promise<PIArtifactSnapshot | null> => {
        const rec = await piArtifactStore.getArtifactById(id);
        if (!rec) return null;
        return {
          artifactId: rec.artifactId,
          artifactKind: rec.artifactKind,
          sourceTaskId: rec.sourceTaskId,
          sourcePrincipleId: rec.sourcePrincipleId,
          sourceRuleId: rec.sourceRuleId,
          lineageArtifactIds: rec.lineageArtifactIds,
          validationStatus: rec.validationStatus,
          contentJson: rec.contentJson,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
        };
      },
    };
    const activationStateStore = new SqliteActivationStateStore(connection);
    const approvalQueueStore = new SqliteApprovalQueueStore(connection);

    const flagProbe = makeFlagProbe(workspaceDir);

    // I3 upgrade (Owner review of PR #1856, P1): the production dispatch path
    // verifies ledger membership BEFORE the approval record and the activation
    // commit. The ledger SSOT lives in <workspace>/.state (same dir the intake
    // used to mint the principle UUID); candidate lineage reuses the artifact
    // read model plus raw diagnostic_json reads.
    const ledgerIdentity = {
      getCandidateKind: (candidateId: string): unknown => {
      const row: unknown = connection.getDb().prepare('SELECT recommendation_kind FROM principle_candidates WHERE candidate_id = ?').get(candidateId);
      return row !== null && typeof row === 'object' && Object.hasOwn(row, 'recommendation_kind') ? Reflect.get(row, 'recommendation_kind') : undefined;
    },
    ledger: new PrincipleTreeLedgerAdapter({ stateDir: `${workspaceDir}/.state` }),
      getArtifactById: artifactReadModel.getArtifactById,
      getTaskDiagnosticJson: (taskId: string): string | null => {
        try {
          const row = connection
            .getDb()
            .prepare('SELECT diagnostic_json FROM tasks WHERE task_id = ?')
            .get(taskId) as { diagnostic_json?: string | null } | undefined;
          return row?.diagnostic_json ?? null;
        } catch {
          return null;
        }
      },
    };

    const dispatcher = new ActivationDispatcher(
      artifactReadModel,
      activationStateStore,
      {
        writers: [
          new PromptWriter(),
          // PRI-634-F: toolSemantics (host-declared) + the workspace root flow
          // into the activation writer — reliability validation + replay with
          // production-identical path normalization.
          new RuleHostWriter({
            gateDeps: createProductionGateDeps(options.toolSemantics ? { toolSemantics: options.toolSemantics } : {}),
            featureFlagProbe: flagProbe,
            ...(options.toolSemantics ? { toolSemantics: options.toolSemantics } : {}),
            projectDir: workspaceDir,
          }),
          new DeferArchiveWriter(),
        ],
        approvalQueueStore,
        ledgerIdentity,
      },
    );

    const decision: ActivationDecision = await dispatcher.dispatch({
      artifactId: input.artifactId,
      channel: input.channel as never, // InternalizationChannel union; rollout 链的 channel 已由任务元数据校验
      // 'auto_activate' = rollout reviewer 推荐激活。PRI-811 Phase B 起
      // dispatcher 对一切推荐只入 approval 队列，不直接激活。
      rolloutDecision: 'auto_activate',
      actor: { kind: 'system', source: 'rollout_reviewer' },
      now: new Date().toISOString(),
      confirm: true,
      confidence: input.confidence,
    });

    const outcome = normalizeDecision(decision);
    options.logger?.info?.(`[PD:Consumer] rollout dispatch: artifact=${input.artifactId} channel=${input.channel} → ${outcome.decision}${outcome.activationId ? ` (${outcome.activationId})` : ''}${outcome.reason ? ` reason=${outcome.reason}` : ''}`);
    return outcome;
  } finally {
    try { connection.close(); } catch { /* best-effort */ }
  }
}

/** flag 探针: config 异常 → 全 false (fail-closed, 不 throw) */
/** evaluator repair deps (PRI-509 机制的生产接线; flag 语义保留为运行时开关) */
export function createEvaluatorRepairDeps(
  workspaceDir: string,
  stateManager: RuntimeStateManager,
  logger?: ConsumerGovernanceLogger,
): {
  isRepairLoopEnabled: () => boolean;
  seedArtificerRepairTask: (params: SeedArtificerRepairParams) => Promise<string>;
} {
  return {
    isRepairLoopEnabled: () => {
      // flag evaluator_artificer_repair_loop (registry 默认已改为 ON — 见
      // feature-flag-contract.ts;此处读取 config 以保留运行时可关闭能力)
      const configResult = loadPdConfigForPlugin(workspaceDir);
      if (!configResult.ok) return false;
      const flags = computeFeatureFlagsFromConfig(configResult.effective);
      return isFeatureEnabled(flags, 'evaluator_artificer_repair_loop');
    },
    seedArtificerRepairTask: async (params) => {
      // P0-4: 确定性 revision identity — evaluatorTaskId + iteration 唯一定位
      // 一个逻辑 repair 任务; 重放 (consumer 重复周期 / crash 恢复) reuse 而非再建。
      // PRI-718: id 约定收敛到 pitask-metadata 的单一 owner。
      const repairTaskId = artificerRepairTaskId(
        params.repairPayload.sourceEvaluatorTaskId,
        params.repairPayload.repairIteration,
      );
      const existing = await stateManager.getTask(repairTaskId);
      if (existing) {
        // PRI-718 (revise ≠ resume): a TERMINAL repair round is finished
        // corrective work, not a vehicle for new corrective work. Returning
        // it here made the evaluator re-run against a superseded artifact
        // forever (EP002-R2: same-artifact score oscillation, one LLM call
        // per cycle, no new repair). New work requires a new revision epoch
        // (Owner revise_once) — surface as a seed failure so the evaluator
        // degrades to needs_human_review instead of looping.
        if (existing.status === 'succeeded' || existing.status === 'failed' || existing.status === 'needs_human_review') {
          throw new Error(
            `repair task ${repairTaskId} already reached terminal status ${existing.status}; refusing to reuse it as new corrective work (PRI-718 revise-ne-resume)`,
          );
        }
        // PRI-1293 R7 (P1-1): 复用前完整身份验证 — 共享 core 唯一实现
        // (verifyRepairTaskIdentity), 与 pd-cli seeder / orchestrator 完成
        // 路径同一规则: payload 存在+来源/iteration 一致+taskId 互证+来源
        // evaluator 真实+parent/correlation 一致+channel 一致。缺失亲缘字段
        // 可 CAS 回填, payload 身份不符一律 fail-closed。
        const identity: RepairIdentityVerification = await verifyRepairTaskIdentity(
          existing,
          params.repairPayload.sourceEvaluatorTaskId,
          params.repairPayload.repairIteration,
          stateManager,
        );
        if (!identity.ok) {
          throw new Error(`evaluator_repair_seed_lineage_refused:${identity.reason}:${identity.detail}`);
        }
        const existingPi = hydratePITaskRecord(existing);
        if (!existingPi) {
          throw new Error(`evaluator_repair_seed_lineage_refused:invalid_task_metadata:repair task ${repairTaskId} diagnosticJson unreadable`);
        }
        if (identity.needsLineageBackfill) {
          // 旧任务缺亲缘字段 — 按权威来源补齐 ( merge 保持其余 28 字段 ),
          // CAS 断言读取时的完整状态; 并发被触碰则放弃并结构化抛出, 下一轮
          // seed 重试 (播种幂等, 重试安全)。
          const merged = mergePITaskMetadata(existingPi, {
            parentTaskId: params.repairPayload.sourceEvaluatorTaskId,
            correlationId: identity.authoritativeCorrelationId,
          });
          const casResult = await stateManager.updateTaskIfDiagnosticJsonUnchanged(
            repairTaskId,
            existing.diagnosticJson ?? null,
            { diagnosticJson: createPITaskDiagnosticJson(merged) },
            {
              expectedStatus: existing.status,
              expectedAttemptCount: existing.attemptCount,
              expectedMaxAttempts: existing.maxAttempts,
              expectedLeaseOwner: existing.leaseOwner ?? null,
              expectedLeaseExpiresAt: existing.leaseExpiresAt ?? null,
              expectedLeaseGeneration: existing.leaseGeneration ?? 0,
            },
          );
          if (casResult === null) {
            throw new Error(
              `evaluator_repair_seed_concurrent_modification: repair task ${repairTaskId} changed during lineage backfill — seed NOT applied, safe to retry`,
            );
          }
          logger?.info?.(`[PD:Consumer] repair task ${repairTaskId} lineage backfilled (parentTaskId + correlationId ${identity.authoritativeCorrelationId}) before reuse`);
        }
        logger?.info?.(`[PD:Consumer] repair task ${repairTaskId} already exists (in-flight ${existing.status}); reusing (idempotent seed)`);
        return repairTaskId;
      }
      // PRI-1293 Phase 3 (§5.2): repair 任务创建前从来源 evaluator 恢复权威
      // 血缘 — 校验失败结构化抛出 (流入 evaluator 的 repair_task_seed_failed →
      // seed_failed 路径), 绝不创建无血缘后继; 成功则把验证过的 correlationId
      // 与 parentTaskId=sourceEvaluatorTaskId 写入 repair metadata (既有
      // createPITaskDiagnosticJson 机制), 使 repair 链可回溯根 dreamer、
      // 下一轮 evaluator 经 mergePITaskMetadata 天然继承同一 id。不信任
      // runner 调用方传入的任何 candidateId (SeedArtificerRepairParams 本就
      // 无此字段)。
      const sourceEvaluatorTask = await stateManager.getTask(params.repairPayload.sourceEvaluatorTaskId);
      if (!sourceEvaluatorTask) {
        throw new Error(
          `evaluator_repair_seed_lineage_refused: source evaluator task ${params.repairPayload.sourceEvaluatorTaskId} not found`,
        );
      }
      const lineage = await InternalizationOrchestrator.resolveAuthoritativeCorrelationId(
        sourceEvaluatorTask,
        (taskId: string) => stateManager.getTask(taskId),
      );
      if (!lineage.ok) {
        throw new Error(`evaluator_repair_seed_lineage_refused:${lineage.reason}:${lineage.detail}`);
      }
      await stateManager.createTask({
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
        }),
      });
      logger?.info?.(`[PD:Consumer] seeded artificer repair task ${repairTaskId} (iteration ${params.repairPayload.repairIteration}, correlationId ${lineage.correlationId}${lineage.recoveredFromLegacyRoot ? ', recovered from legacy root' : ''})`);
      return repairTaskId;
    },
  };
}

/** rollout reviewer 治理 deps: dispatch + revision reopen */
export function createRolloutGovernanceDeps(
  workspaceDir: string,
  orchestrator: InternalizationOrchestrator,
  options: { logger?: ConsumerGovernanceLogger; toolSemantics?: ToolSemanticRegistry } = {},
): {
  dispatchActivation: (input: RolloutAutoDispatchInput) => Promise<RolloutAutoDispatchOutcome>;
  reopenRevisionTarget: (input: RolloutRevisionRoutingInput) => Promise<{ ok: boolean; reason: string; reopenedTaskId?: string }>;
} {
  return {
    dispatchActivation: (input) => dispatchRolloutActivation(workspaceDir, input, options),
    reopenRevisionTarget: async (input) => {
      const result = await orchestrator.reopenTaskForRevision(input.targetTaskId, {
        revisionFeedback: input.revisionFeedback,
        reason: `rollout_revision_iteration_${input.revisionIteration}`,
        revisionCauseId: `rollout-${input.sourceRolloutTaskId}-r${input.revisionIteration}`,
      });
      return result.ok
        ? { ok: true, reason: result.reason, reopenedTaskId: input.targetTaskId }
        : { ok: false, reason: result.reason };
    },
  };
}
