/**
 * Auto-consumer governance wiring (P0-D/E/F 生产接线)。
 *
 * 审计背景 (ISSUE-005/006): PRI-509 repair loop "intentionally NOT wired" 于
 * auto-consumer; rollout_reviewer succeedTask 不 dispatch;修复后:
 *   - evaluator: 注入 isRepairLoopEnabled + seedArtificerRepairTask (bounded repair)
 *   - rollout_reviewer: 注入 dispatchActivation (approve_rollout → ActivationDispatcher,
 *     低风险 auto_activate / 高风险 approvals.pending) + reopenRevisionTarget
 *     (needs_revision → reopen scribe/artificer, 禁止入 approval)
 *
 * 本模块是 plugin I/O 边界: 组装 core 的 ActivationDispatcher + stores。
 * 幂等性 (INV-08): dispatcher 以 `${artifactId}::${channel}` idempotency key
 * 去重; reopen 幂等由 orchestrator.reopenTaskForRevision 保证。
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
  createProductionGateDeps,
  createPITaskDiagnosticJson,
  computeFeatureFlagsFromConfig,
  isFeatureEnabled,
  type PIArtifactSnapshot,
  type RolloutAutoDispatchInput,
  type RolloutAutoDispatchOutcome,
  type RolloutRevisionRoutingInput,
  type ActivationDecision,
  type SeedArtificerRepairParams,
} from '@principles/core/runtime-v2';
import type { RuntimeStateManager } from '@principles/core/runtime-v2';
import type { InternalizationOrchestrator } from '@principles/core/runtime-v2';
import type { PluginLogger } from '../openclaw-sdk.js';
import { loadPdConfigForPlugin } from '../core/pd-config-loader.js';

/** rollout → ActivationDispatcher 的生产接线 (per dispatch 打开短连接, 与 Console 模式一致) */
export async function dispatchRolloutActivation(
  workspaceDir: string,
  input: RolloutAutoDispatchInput,
  logger?: PluginLogger,
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

    const dispatcher = new ActivationDispatcher(
      artifactReadModel,
      activationStateStore,
      {
        writers: [
          new PromptWriter(),
          new RuleHostWriter({ gateDeps: createProductionGateDeps(), featureFlagProbe: flagProbe }),
          new DeferArchiveWriter(),
        ],
        approvalQueueStore,
      },
    );

    const decision: ActivationDecision = await dispatcher.dispatch({
      artifactId: input.artifactId,
      channel: input.channel as never, // InternalizationChannel union; rollout 链的 channel 已由任务元数据校验
      rolloutDecision: 'auto_activate',
      actor: { kind: 'system', source: 'rollout_reviewer' },
      now: new Date().toISOString(),
      confirm: true,
      confidence: input.confidence,
    });

    const outcome = normalizeDecision(decision);
    logger?.info?.(`[PD:AutoConsumer] rollout dispatch: artifact=${input.artifactId} channel=${input.channel} → ${outcome.decision}${outcome.activationId ? ` (${outcome.activationId})` : ''}${outcome.reason ? ` reason=${outcome.reason}` : ''}`);
    return outcome;
  } finally {
    try { connection.close(); } catch { /* best-effort */ }
  }
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

/** flag 探针: config 异常 → 全 false (fail-closed, 不 throw) */
function makeFlagProbe(workspaceDir: string): (flagId: string) => boolean {
  const configResult = loadPdConfigForPlugin(workspaceDir);
  if (!configResult.ok) return () => false;
  const flags = computeFeatureFlagsFromConfig(configResult.effective);
  return (flagId: string) => isFeatureEnabled(flags, flagId);
}

/** evaluator repair deps (PRI-509 机制的生产接线; flag 语义保留为运行时开关) */
export function createEvaluatorRepairDeps(
  workspaceDir: string,
  stateManager: RuntimeStateManager,
  logger?: PluginLogger,
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
      const repairTaskId = `artificer-repair-${params.repairPayload.sourceEvaluatorTaskId}-r${params.repairPayload.repairIteration}`;
      const existing = await stateManager.getTask(repairTaskId);
      if (existing) {
        logger?.info?.(`[PD:AutoConsumer] repair task ${repairTaskId} already exists; reusing (idempotent seed)`);
        return repairTaskId;
      }
      await stateManager.createTask({
        taskId: repairTaskId,
        taskKind: 'artificer',
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 3,
        diagnosticJson: createPITaskDiagnosticJson({
          dependencyTaskIds: [...params.inheritedDependencyTaskIds],
          channel: params.inheritedChannel as never,
          timeoutMs: params.inheritedTimeoutMs,
          inputArtifactRefs: [...params.inheritedInputArtifactRefs],
          outputArtifactRefs: [],
          repairPayload: params.repairPayload,
        }),
      });
      logger?.info?.(`[PD:AutoConsumer] seeded artificer repair task ${repairTaskId} (iteration ${params.repairPayload.repairIteration})`);
      return repairTaskId;
    },
  };
}

/** rollout reviewer 治理 deps: dispatch + revision reopen */
export function createRolloutGovernanceDeps(
  workspaceDir: string,
  orchestrator: InternalizationOrchestrator,
  logger?: PluginLogger,
): {
  dispatchActivation: (input: RolloutAutoDispatchInput) => Promise<RolloutAutoDispatchOutcome>;
  reopenRevisionTarget: (input: RolloutRevisionRoutingInput) => Promise<{ ok: boolean; reason: string; reopenedTaskId?: string }>;
} {
  return {
    dispatchActivation: (input) => dispatchRolloutActivation(workspaceDir, input, logger),
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
