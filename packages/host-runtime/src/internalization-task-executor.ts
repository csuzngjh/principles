/**
 * PRI-1301 / PRI-1293 Phase 2B — 共享单步 Runner 执行器 (SPEC-PD-PIPELINE-SPINE-001 §3.5)
 * (PRI-1301: 从 internalization-consumer-cycle.ts 独立成模块 — 纯移动,
 * 执行器本体逐字等价; 周期调度/选择/lease/恢复/reconciliation 留在 cycle)。
 *
 * `executeSelectedInternalizationTask` 是六种 Peer Runner 构造+执行的唯一权威
 * 实现。收编对象：consumer cycle 分支 + pd-cli
 * `runtime-internalization-run-once` 的 6 分支手搓构造。`rulehost-pipeline-
 * runner` 是显式同步对抗算子 (非租约编排)，按 SPEC §3.5.2 白名单保留独立构造。
 *
 * 职责边界 (统一 Runner 执行，不统一所有宿主行为)：
 *   只负责 — kind→Runner 映射、按判别联合的类型化依赖装配、执行指定 taskId、
 *   返回原始执行结果。
 *   不进入 — 任务发现/选择/wake/lease (orchestrator)、Runtime Profile 解析、
 *   Adapter/L2 路由 (各入口自建 adapter 传入)、Owner Evidence Preflight
 *   (auto consumer)、repair 任务创建 (两个 governance deps 工厂)、后继提交、
 *   周期调度、Workspace Telemetry 归属 (eventEmitter 由入口选择)。
 *
 * Scribe/Artificer/Evaluator 的 ledgerIdentity 从 (workspaceDir, stateManager)
 * 以同一装配导出 — 此前 consumer 与 run-once 各自内联同一段闭包 (重复实现)。
 * 两个入口的有意差异 (§2.5) 由输入类型表达：artificer 的 evidence pack /
 * trustedFacts 仅由具备 preflight 能力的入口传入；evaluator 的 repair deps /
 * gateDeps / hostToolCatalog / hostSemanticContext 必需显式提供，不存在缺省
 * 掩盖 (类型层面不可缺失)。
 */
import {
  DreamerRunner,
  PhilosopherRunner,
  ScribeRunner,
  ArtificerRunner,
  EvaluatorRunner,
  RolloutReviewerRunner,
  DefaultDreamerValidator,
  DefaultPhilosopherValidator,
  DefaultScribeValidator,
  DefaultArtificerValidator,
  DefaultEvaluatorValidator,
  DefaultRolloutReviewerValidator,
  PrincipleTreeLedgerAdapter,
  type PDRuntimeAdapter,
  type RuntimeStateManager,
  type TelemetryEvent,
  type PIArtifactStore,
  type EffectivePdConfig,
  type OutputLanguage,
  type RefinerRuleHostGateDeps,
  type RolloutAutoDispatchInput,
  type RolloutAutoDispatchOutcome,
  type RolloutRevisionRoutingInput,
  type SeedArtificerRepairParams,
  type BehaviorExamplePack,
  type ArtificerTrustedFactsPort,
  type ArtificerHostSemanticContext,
  type DreamerRunnerResult,
  type PhilosopherRunnerResult,
  type ScribeRunnerResult,
  type ArtificerRunnerResult,
  type EvaluatorRunnerResult,
  type RolloutReviewerRunnerResult,
} from '@principles/core/runtime';
// ConsumerHostToolCatalog 的权威所有者是 consumer cycle (host 端口目录类型 —
// evaluator 输入联合引用它)。type-only import, 运行期无循环依赖。
import type { ConsumerHostToolCatalog } from './internalization-consumer-cycle.js';

/**
 * Runner 遥测窄端口 — 与 core `PeerRunnerTelemetryEmitter` 结构等价
 * (该类型不在 core 冻结 barrel 上，此处按结构声明，零新增导出)。
 * StoreEventEmitter 与 WorkspaceTelemetryEmitter 均满足。
 */
export interface SelectedTaskTelemetryEmitter {
  readonly emitTelemetry: (event: TelemetryEvent) => unknown;
}

/** 全部 kind 共享的调用方依赖。 */
export interface SelectedInternalizationTaskBaseDeps {
  /** 要执行的已**选中**任务 — 执行租约由 Runner 在 run() 内自行获取, 调用方不在本层租约。 */
  readonly taskId: string;
  readonly stateManager: RuntimeStateManager;
  /** 入口自建的 runtime adapter (含 L2 / test-double 路由决策)。 */
  readonly runtimeAdapter: PDRuntimeAdapter;
  /** 入口选择的遥测口 (consumer evaluator 用 workspace-scoped emitter)。 */
  readonly eventEmitter: SelectedTaskTelemetryEmitter;
  readonly artifactStore: PIArtifactStore;
  /** Workspace 根 — ledgerIdentity 装配的唯一事实来源。 */
  readonly workspaceDir: string;
}

/** Runner 构造/执行选项 — 原样转发 (各入口既有语义保持)。 */
export interface SelectedInternalizationTaskRunnerOptions {
  readonly owner: string;
  readonly runtimeKind: string;
  readonly timeoutMs: number;
  readonly effectiveConfig?: EffectivePdConfig;
  readonly outputLanguage?: OutputLanguage;
  readonly pollIntervalMs?: number;
}

/** Evaluator repair 轮的宿主接线 (来自既有 governance deps 工厂，不造第三套)。 */
export interface SelectedEvaluatorRepairDeps {
  readonly isRepairLoopEnabled: () => boolean;
  readonly seedArtificerRepairTask: (params: SeedArtificerRepairParams) => Promise<string>;
}

/** rollout 治理接线 (来自 createRolloutGovernanceDeps)。 */
export interface SelectedRolloutGovernanceDeps {
  readonly dispatchActivation: (input: RolloutAutoDispatchInput) => Promise<RolloutAutoDispatchOutcome>;
  readonly reopenRevisionTarget: (input: RolloutRevisionRoutingInput) => Promise<{ ok: boolean; reason: string; reopenedTaskId?: string }>;
}

/**
 * 按 taskKind 收窄的判别联合输入 — 必需依赖在类型层面不可缺失；
 * optional 仅限两个入口现状真实可选的字段 (artificer 的 evidence pack /
 * trustedFacts / hostSemanticContext、evaluator 的宿主目录与语义投影)。
 */
export type ExecuteSelectedInternalizationTaskInput =
  | ({ readonly taskKind: 'dreamer' } & SelectedInternalizationTaskBaseDeps & { readonly runnerOptions: SelectedInternalizationTaskRunnerOptions })
  | ({ readonly taskKind: 'philosopher' } & SelectedInternalizationTaskBaseDeps & { readonly runnerOptions: SelectedInternalizationTaskRunnerOptions })
  | ({ readonly taskKind: 'scribe' } & SelectedInternalizationTaskBaseDeps & { readonly runnerOptions: SelectedInternalizationTaskRunnerOptions })
  | ({
      readonly taskKind: 'artificer';
      /** 仅 preflight 通过的入口传入 (consumer evidence ready)；run-once 无此能力则缺省。 */
      readonly behaviorExamplePack?: BehaviorExamplePack;
      /** 仅 consumer 传入 — 与 intent preflight 同源的 trusted-facts 端口。 */
      readonly trustedFacts?: ArtificerTrustedFactsPort;
      readonly hostSemanticContext?: ArtificerHostSemanticContext;
    } & SelectedInternalizationTaskBaseDeps & { readonly runnerOptions: SelectedInternalizationTaskRunnerOptions })
  | ({
      readonly taskKind: 'evaluator';
      /** repair 轮宿主接线 — 缺失即是装配错误，不允许缺省掩盖。 */
      readonly repairDeps: SelectedEvaluatorRepairDeps;
      /** 对抗重放 gate — 两个入口都必须显式提供各自权威解析结果。 */
      readonly gateDeps: RefinerRuleHostGateDeps;
      readonly hostToolCatalog?: ConsumerHostToolCatalog;
      readonly hostSemanticContext?: ArtificerHostSemanticContext;
    } & SelectedInternalizationTaskBaseDeps & { readonly runnerOptions: SelectedInternalizationTaskRunnerOptions })
  | ({
      readonly taskKind: 'rollout_reviewer';
      readonly governanceDeps: SelectedRolloutGovernanceDeps;
    } & SelectedInternalizationTaskBaseDeps & { readonly runnerOptions: SelectedInternalizationTaskRunnerOptions });

export type SelectedInternalizationTaskRunResult =
  | DreamerRunnerResult
  | PhilosopherRunnerResult
  | ScribeRunnerResult
  | ArtificerRunnerResult
  | EvaluatorRunnerResult
  | RolloutReviewerRunnerResult;

/**
 * Scribe/Artificer/Evaluator 共用的 ledger 身份装配 — 与两个入口此前内联的
 * 闭包逐字等价 (每次调用新开 PrincipleTreeLedgerAdapter 读盘，无跨周期缓存)。
 */
function buildWorkspaceLedgerIdentity(
  workspaceDir: string,
  stateManager: RuntimeStateManager,
): {
  resolveForCandidate: (candidateId: string) => Promise<ReturnType<PrincipleTreeLedgerAdapter['resolveCandidatePrincipleIdentity']>>;
  isAvailable: () => boolean;
  listForCandidate: (candidateId: string) => ReturnType<PrincipleTreeLedgerAdapter['listForCandidate']>;
  hasPrinciple: (principleId: string) => boolean;
} {
  const ledger = (): PrincipleTreeLedgerAdapter => new PrincipleTreeLedgerAdapter({ stateDir: `${workspaceDir}/.state` });
  return {
    resolveForCandidate: async (candidateId: string) => {
      const candidate = await stateManager.getCandidate(candidateId);
      return ledger().resolveCandidatePrincipleIdentity(candidateId, candidate?.rawRecommendationKind);
    },
    // PRI-915: availability first — an unreadable ledger must not read as an
    // unresolved chain.
    isAvailable: (): boolean => ledger().isAvailable(),
    listForCandidate: (candidateId: string) => ledger().listForCandidate(candidateId),
    hasPrinciple: (principleId: string) => ledger().hasPrinciple(principleId),
  };
}

/**
 * Execute ONE selected internalization task with the kind-selected runner.
 * Constructs the runner from the typed input and returns the raw run result.
 *
 * Lease ownership contract (CodeRabbit review fix): the caller is responsible
 * for SELECTING the task (e.g. a dry-run `wakeOnce` `would_lease` candidate);
 * the runner itself acquires the execution lease inside `run()` — callers must
 * NOT lease at this layer. The doc previously demanded an already-leased task,
 * which would lead new callers to acquire the lease at the wrong layer.
 *
 * Runner crashes propagate to the caller (each entry keeps its own crash
 * semantics: consumer rethrows without state writes; run-once logs + rethrows).
 */
export async function executeSelectedInternalizationTask(
  input: ExecuteSelectedInternalizationTaskInput,
): Promise<SelectedInternalizationTaskRunResult> {
  const { taskId, stateManager, runtimeAdapter, eventEmitter, artifactStore, workspaceDir } = input;
  const {runnerOptions} = input;
  // Evaluator 的身份装配含 hasPrinciple (PRI-911A writer boundary)；
  // Scribe 另需 listForCandidate (chain stamping)；Artificer 只读解析。
  // 一次装配、按 kind 结构化满足各自 deps 形状。
  const ledgerIdentity = buildWorkspaceLedgerIdentity(workspaceDir, stateManager);
  switch (input.taskKind) {
    case 'dreamer':
      return new DreamerRunner(
        { stateManager, runtimeAdapter, eventEmitter, artifactStore, validator: new DefaultDreamerValidator() },
        runnerOptions,
      ).run(taskId);
    case 'philosopher':
      return new PhilosopherRunner(
        { stateManager, runtimeAdapter, eventEmitter, artifactStore, validator: new DefaultPhilosopherValidator() },
        runnerOptions,
      ).run(taskId);
    case 'scribe':
      return new ScribeRunner(
        {
          stateManager, runtimeAdapter, eventEmitter, artifactStore,
          validator: new DefaultScribeValidator({ requireRuleCodeContracts: true }),
          // I2 — CHAIN STAMPING (Owner review of PR #1856, P1): 完整三元身份
          // (resolveForCandidate / isAvailable / listForCandidate)。
          ledgerIdentity,
        },
        runnerOptions,
      ).run(taskId);
    case 'artificer':
      return new ArtificerRunner(
        {
          stateManager, runtimeAdapter, eventEmitter, artifactStore,
          validator: new DefaultArtificerValidator(),
          ledgerIdentity,
          ...(input.behaviorExamplePack !== undefined ? { behaviorExamplePack: input.behaviorExamplePack } : {}),
          ...(input.trustedFacts !== undefined ? { trustedFacts: input.trustedFacts } : {}),
        },
        {
          ...runnerOptions,
          ...(input.hostSemanticContext !== undefined ? { hostSemanticContext: input.hostSemanticContext } : {}),
        },
      ).run(taskId);
    case 'evaluator': {
      const evaluatorLedgerIdentity = {
        resolveForCandidate: ledgerIdentity.resolveForCandidate,
        isAvailable: ledgerIdentity.isAvailable,
        hasPrinciple: ledgerIdentity.hasPrinciple,
      };
      return new EvaluatorRunner(
        {
          stateManager,
          runtimeAdapter,
          eventEmitter,
          artifactStore,
          validator: new DefaultEvaluatorValidator(),
          ledgerIdentity: evaluatorLedgerIdentity,
          isRepairLoopEnabled: input.repairDeps.isRepairLoopEnabled,
          seedArtificerRepairTask: input.repairDeps.seedArtificerRepairTask,
        },
        {
          ...runnerOptions,
          gateDeps: input.gateDeps,
          ...(input.hostToolCatalog !== undefined
            ? { hostToolCatalog: { readOnlyTools: [...input.hostToolCatalog.readOnlyTools], writeTools: [...input.hostToolCatalog.writeTools] } }
            : {}),
          ...(input.hostSemanticContext !== undefined ? { hostSemanticContext: input.hostSemanticContext } : {}),
        },
      ).run(taskId);
    }
    case 'rollout_reviewer':
      return new RolloutReviewerRunner(
        {
          stateManager, runtimeAdapter, eventEmitter, artifactStore,
          validator: new DefaultRolloutReviewerValidator(),
          dispatchActivation: input.governanceDeps.dispatchActivation,
          reopenRevisionTarget: input.governanceDeps.reopenRevisionTarget,
        },
        runnerOptions,
      ).run(taskId);
  }
}
