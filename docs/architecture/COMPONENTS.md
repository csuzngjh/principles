# PD 组件目录（Components Catalog）

> **状态**: Active
> **最后更新**: 2026-05-15
> **定位**: PD 系统**所有架构组件**的扁平索引。每个组件有清晰的 owner、契约、不变量。
> **关联**: `PD_ARCHITECTURE_OVERVIEW.md`（层级视图）, `GLOSSARY.md`（术语）

本文档以**表格形式**列出 PD 的所有组件。每个组件至少要回答：
- 它在哪一层、哪个包
- 输入和输出是什么
- 谁是 owner、状态如何
- 不变量与禁止行为
- 当前实现状态

新增/修改组件必须**先更新本目录**，再写代码。

---

## 1. 组件分类

PD 系统有 5 类组件：

| 类型 | 标识 | 定义 |
|-----|------|------|
| Service | 🔵 Service | 长期存在的业务逻辑封装，有内部状态 |
| Runner | 🟢 Runner | Internalization Pipeline 中的 Peer Runner |
| Store | 🟡 Store | 持久化存储抽象（CRUD） |
| ReadModel | 🟣 ReadModel | 只读视图聚合 |
| Adapter | 🔴 Adapter | 外部系统/平台桥接 |
| Bridge | 🟠 Bridge | 跨阶段衔接（事件 → 任务 / 工件 → 激活） |
| Hook | ⚫ Hook | 平台事件回调 |
| Writer | 🟤 Writer | 通道激活写入器 |
| Schema | 📋 Schema | 数据契约（TypeBox） |
| Util | 🔧 Util | 纯工具函数（无状态） |

---

## 2. Layer 1: Foundation（基础层）

### 2.1 Schema 与契约

| 组件 | 类型 | 包 | 定义位置 | 输入 | 输出 | Owner | 状态 |
|------|-----|----|----|----|----|-------|------|
| `PainSignalSchema` | 📋 Schema | core | `pain-signal.ts` | n/a（schema） | TypeBox schema | core | ✅ |
| `TelemetryEventSchema` | 📋 Schema | core | `telemetry-event.ts` | n/a | TypeBox schema | core | ✅ |
| `AgentSpecSchema` | 📋 Schema | core | `runtime-v2/agent-spec.ts` | n/a | TypeBox schema | core | ✅ |
| `RuntimeProtocolSchemas` | 📋 Schema | core | `runtime-v2/runtime-protocol.ts` | n/a | RunHandle/Status/Input | core | ✅ |
| `TaskRecord` schema | 📋 Schema | core | `runtime-v2/task-status.ts` | n/a | TaskRecord type | core | ✅ |
| `PITaskRecord` schema | 📋 Schema | core | `runtime-v2/internalization/peer-runner-contracts.ts` | n/a | PITaskRecord type | core | ✅ |
| `PIArtifact` schema | 📋 Schema | core | `runtime-v2/internalization/pi-artifact.ts` | n/a | PIArtifact type | core | ✅ |
| `DiagnosticianOutputV1Schema` | 📋 Schema | core | `runtime-v2/diagnostician-output.ts` | n/a | TypeBox schema | core | ✅ |
| `*RunnerOutputV1Schema`（7 个） | 📋 Schema | core | `runtime-v2/internalization/*-output.ts` | n/a | TypeBox schemas | core | ✅ |
| `PDErrorCategory` | 📋 Schema | core | `runtime-v2/error-categories.ts` | n/a | enum + map | core | ✅ |
| `LedgerPrincipleEntry` schema | 📋 Schema | core | `runtime-v2/candidate-intake.ts` | n/a | type | core | ✅ |
| `CorrectionProposal` schema | 📋 Schema | core | `runtime-v2/internalization/correction-proposal.ts` | n/a | TypeBox schema | core | ✅ |
| `GoldenTrace` schema | 📋 Schema | core | `runtime-v2/internalization/golden-trace.ts` | n/a | TypeBox schema | core | ✅ |
| `ApprovalRecord` type | 📋 Schema | core | `runtime-v2/activation/activation-types.ts` | n/a | TS contract（TypeBox schema 待补） | core | ⚠️ 部分 |

### 2.2 Stores

| 组件 | 类型 | 包 | 文件 | 持久化 | 操作 | 不变量 | 状态 |
|------|-----|----|----|----|----|------|------|
| `TaskStore` (Sqlite/Memory) | 🟡 Store | core | `runtime-v2/store/task/` | state.db | CRUD + listByStatus | 状态机转移须经 IdempotentTransitions | ✅ |
| `RunStore` (Sqlite/Memory) | 🟡 Store | core | `runtime-v2/store/run/` | state.db | CRUD + listByTask | 1 Task : N Runs | ✅ |
| `CommitStore` (Sqlite/Memory) | 🟡 Store | core | `runtime-v2/store/commit/` | state.db | CRUD | append-only | ✅ |
| `CandidateStore` (Sqlite/Memory) | 🟡 Store | core | `runtime-v2/store/candidate/` | state.db | CRUD + listByTask | candidate.status 状态机 | ✅ |
| `ArtifactStore` (Sqlite/Memory) | 🟡 Store | core | `runtime-v2/store/artifact/` | state.db | CRUD | artifact 不可变 | ✅ |
| `PIArtifactStore` | 🟡 Store | core | `runtime-v2/internalization/pi-artifact-store.ts` | state.db | upsert + listBySourceTaskId | (sourceTaskId, artifactKind) 幂等 | ✅ |
| `TrajectoryLocator` | 🟡 Store | core | `runtime-v2/store/trajectory/` | state.db | locate by 多种维度 | read-only 后 hydrate | ✅ |
| `HistoryQuery` | 🟡 Store | core | `runtime-v2/store/history/` | state.db | bounded query + 分页 | 不允许无 bound 的 scan | ✅ |
| `ContextAssembler` | 🟡 Store | core | `runtime-v2/store/context/` | state.db | assemble(taskId) | output 可序列化 | ✅ |
| `LedgerStore`（基于 JSON） | 🟡 Store | core | `principle-tree-ledger.ts` | `principle_training_state.json` | mutateLedger 包装 | atomic write only | ✅ |
| `PainFlagWriter` | 🟡 Store | core | `pain-recorder.ts` | state.db + ledger | recordPainSignal | 幂等键 painId | ✅ |
| `EvolutionScorecard` | 🟡 Store | plugin | `core/evolution-engine.ts` | `.state/evolution-scorecard.json` | atomic write | 仅增不减 | ✅ |
| `ApprovalStore` | 🟡 Store | core | `runtime-v2/activation/sqlite-approval-store.ts` / `memory-approval-store.ts` | state.db / memory | CRUD | (artifactId, channel) 确定性 approvalId | ✅ |
| `RejectionFeedbackStore` | 🟡 Store | core | `runtime-v2/activation/rejection-feedback-store.ts` | state.db | append-only | 不可修改 | ❌ 待建 |
| `RuntimeStateManager` | 🟡 Store（聚合） | core | `runtime-v2/store/runtime-state-manager.ts` | state.db | task / run / candidate / artifact 统一入口 | LeaseManager 包装 | ✅ |
| `LeaseManager` | 🟡 Store（辅助） | core | `runtime-v2/store/lifecycle/lease-manager.ts` | state.db | acquireLease / releaseLease | TTL 强制 | ✅ |
| `RecoverySweep` | 🟡 Store（辅助） | core | `runtime-v2/store/lifecycle/recovery-sweep.ts` | state.db | sweep expired leases | 幂等 | ✅ |
| `RetryPolicy` | 🟡 Store（辅助） | core | `runtime-v2/store/lifecycle/retry-policy.ts` | n/a | shouldRetry(task) | 永久错误集合固定 | ✅ |
| `StoreEventEmitter` | 🟡 Store（辅助） | core | `runtime-v2/store/event-emitter.ts` | state.db: events | emitTelemetry | 异步可丢失允许 | ✅ |

### 2.3 Read Models

| 组件 | 类型 | 包 | 文件 | 输入 | 输出 | 副作用 | 状态 |
|------|-----|----|----|----|----|------|------|
| `PainChainReadModel` | 🟣 ReadModel | core | `runtime-v2/pain-chain-read-model.ts` | painId | 完整链 trace | 无 | ✅ |
| `InternalizationQueueReadModel` | 🟣 ReadModel | core | `runtime-v2/internalization-queue-read-model.ts` | n/a | 队列健康快照 | 无 | ✅ |
| `PruningReadModel` | 🟣 ReadModel | core | `runtime-v2/pruning-read-model.ts` | n/a | PruningSignal[] | 无 | ✅ |
| `OperatorHealthReadModel` | 🟣 ReadModel | core | `runtime-v2/operator-health-read-model.ts` | n/a | 整体健康 | 无 | ✅ |
| `LifecycleReadModel` | 🟣 ReadModel | core | `runtime-v2/internalization/lifecycle-read-model.ts` | principleId | 生命周期 evidence | 无 | ✅ |
| `SchemaConformanceReadModel` | 🟣 ReadModel | core | `runtime-v2/schema-conformance-read-model.ts` | n/a | schema 一致性报告 | 无 | ✅ |
| `InternalizationChainIntegrityReadModel` | 🟣 ReadModel | core | `runtime-v2/internalization-chain-integrity-read-model.ts` | n/a | 断链检测 | 无 | ✅ |
| `EventLogReadModel` | 🟣 ReadModel | console | `pd-console/server/models/EventLogReadModel.ts` | filter | events[] | 无 | ✅ |
| `ApprovalQueueReadModel` | 🟣 ReadModel | core | `runtime-v2/activation/approval-queue.ts` + store list APIs | filter | ApprovalRecord[] | 无 | ⚠️ 基础版 |
| `ActivationStatusReadModel` | 🟣 ReadModel | core | `runtime-v2/activation/*activation-state-store.ts` | idempotencyKey | 激活状态 | 无 | ✅ |
| `GfiWorkspaceReadModel` | 🟣 ReadModel | core | `runtime-v2/gfi/gfi-read-model.ts` | n/a | GFI 快照 | 无 | ✅ |

### 2.4 Util / Pure Functions

| 组件 | 类型 | 包 | 文件 | 用途 | 状态 |
|------|-----|----|----|----|------|
| `atomicWriteFileSync` | 🔧 Util | core | `io.ts` | 原子文件写入 | ✅ |
| `resolvePainFlagPath` | 🔧 Util | core | `pain-flag-resolver.ts` | 路径解析 | ✅ |
| `validateRuleImplementationCandidate` | 🔧 Util | core | `runtime-v2/internalization/rule-code-validator.ts` | 代码安全校验 | ✅ |
| `checkForbiddenPatterns` | 🔧 Util | core | `runtime-v2/internalization/rule-code-validator.ts` | 禁用模式检测 | ✅ |
| `mergeDecisions` | 🔧 Util | core | `runtime-v2/internalization/rule-host-evaluator.ts` | RuleHost 决策合并 | ✅ |
| `createRuleHostHelpers` | 🔧 Util | core | `runtime-v2/internalization/rule-host-helpers.ts` | RuleHost 沙箱辅助 | ✅ |
| `recommendLifecycleRoute` | 🔧 Util | core | `runtime-v2/internalization/routing-policy.ts` | 路由决策 | ✅ |
| `decideInternalizationRoute` | 🔧 Util | core | `runtime-v2/internalization/internalization-route.ts` | recommendation kind → route | ✅ |
| `assessDeprecatedReadiness` | 🔧 Util | core | `runtime-v2/internalization/deprecated-readiness.ts` | 评估归档准备度 | ✅ |
| `computeRuleMetrics` | 🔧 Util | core | `runtime-v2/internalization/lifecycle-metrics.ts` | 规则覆盖率计算 | ✅ |
| `replayGoldenTrace` | 🔧 Util | core | `runtime-v2/golden-trace-replay-validator.ts` | GoldenTrace 回放 | ✅ |
| `validateProposedParams` | 🔧 Util | core | `runtime-v2/internalization/correction-proposal.ts` | 校正参数校验 | ✅ |

---

## 3. Layer 2: Domain Services & Runners（领域服务层）

### 3.1 Pain Pipeline 组件

| 组件 | 类型 | 包 | 文件 | 输入 | 输出 | Owner | 状态 |
|------|-----|----|----|----|----|------|------|
| `PainSignalBridge` | 🟠 Bridge | core | `runtime-v2/pain-signal-bridge.ts` | PainDetectedData | PainSignalBridgeResult | core | ✅ |
| `PainToPrincipleService` | 🔵 Service | core | `runtime-v2/pain-to-principle-service.ts` | PainToPrincipleInput | Output | core | ✅ |
| `DiagnosticianRunner` | 🟢 Runner | core | `runtime-v2/runner/diagnostician-runner.ts` | taskId | RunnerResult | core | ✅ |
| `DiagnosticianValidator` | 🔵 Service | core | `runtime-v2/runner/default-validator.ts` | RawOutput | ValidationResult | core | ✅ |
| `DiagnosticianCommitter` | 🔵 Service | core | `runtime-v2/store/commit/diagnostician-committer.ts` | output | CommitResult | core | ✅ |
| `CandidateIntakeService` | 🔵 Service | core | `runtime-v2/candidate-intake-service.ts` | candidateId | LedgerPrincipleEntry | core | ✅ |
| `DiagnosticianPromptBuilder` | 🔵 Service | core | `runtime-v2/diagnostician-prompt-builder.ts` | ContextPayload | prompt | core | ✅ |
| `RecordPainSignalObservability` | 🔵 Service | core | `runtime-v2/pain-signal-observability.ts` | PainSignalData | warnings | core | ✅ |

### 3.2 Internalization Pipeline 组件

#### 3.2.1 编排与桥接

| 组件 | 类型 | 包 | 文件 | 输入 | 输出 | 状态 |
|------|-----|----|----|----|----|------|
| `InternalizationOrchestrator` | 🔵 Service | core | `runtime-v2/internalization/internalization-orchestrator.ts` | taskKind? | WakeOnceResult | ✅ |
| `IntakeToInternalizationBridge` | 🟠 Bridge | core | `runtime-v2/internalization/intake-to-internalization-bridge.ts` | ProbationCreatedInput | BridgeResult | ✅ 已落地 |
| `IdleTrigger` | 🔵 Service | core | `runtime-v2/idle-trigger/`（历史策略） | idle config | wakeOnce 决策 | ⚠️ Deprecated；ADR-0012 要求停止扩建并随 idle/night 入口删除 |
| `InternalizationStateMachine` | 🔧 Util | core | `runtime-v2/internalization/internalization-state-machine.ts` | task / dependencies | gate decision | ✅ |
| `InternalizationJobGraph` | 🔧 Util | core | `runtime-v2/internalization/internalization-job-graph.ts` | n/a | ALLOWED_EDGES | ✅ |
| `InternalizationIntegrityRemediation` | 🔵 Service | core | `runtime-v2/internalization-integrity-remediation.ts` | broken link | remediation | ✅ |

#### 3.2.2 7 个 Peer Runner

| Runner | 类型 | 包 | 文件 | 输入工件 | 输出工件 | 状态 |
|--------|-----|----|----|---------|---------|------|
| `DreamerRunner` | 🟢 Runner | core | `runtime-v2/internalization/dreamer-runner.ts` | LedgerPrincipleEntry | PIArtifact(principle) | ✅ MVP-Core |
| `PhilosopherRunner` | 🟡 Runner | core | `runtime-v2/internalization/philosopher-runner.ts` | DreamerOutput | PIArtifact(principle) | ✅ MVP-Quiet (default off) |
| `ScribeRunner` | 🟢 Runner | core | `runtime-v2/internalization/scribe-runner.ts` | PhilosopherOutput | PIArtifact(principle) | ✅ MVP-Core |
| `ArtificerRunner` | 🟢 Runner | core | `runtime-v2/internalization/artificer-runner.ts` | ScribeOutput | PIArtifact(rule) | ✅ MVP-Core |
| `EvaluatorRunner` | 🟡 Runner | core | `runtime-v2/internalization/evaluator-runner.ts` | ArtificerOutput | PIArtifact(rule) | ✅ MVP-Quiet (default off; MVP-Core for RuleHost per ADR-0014 amendment) |
| `RolloutReviewerRunner` | 🟡 Runner | core | `runtime-v2/internalization/rollout-reviewer-runner.ts` | EvaluatorOutput | PIArtifact(rule) + 触发 ActivationDispatcher | ✅ MVP-Quiet (default off) |
| `TrainerRunner` | 🟢 Runner | core | `runtime-v2/internalization/trainer-runner.ts` | RolloutReviewerOutput | PIArtifact(training_data) | Deferred |

#### 3.2.3 Runner 输出 Validator（每 Runner 一个）

| Validator | 类型 | 包 | 文件 | 输入 | 输出 | 状态 |
|-----------|-----|----|----|----|----|------|
| `DefaultDiagnosticianValidator` | 🔵 Service | core | `runtime-v2/runner/default-validator.ts` | DiagnosticianOutputV1 | ValidationResult | ✅ |
| `DefaultDreamerValidator` | 🔵 Service | core | `runtime-v2/internalization/dreamer-output.ts` | DreamerOutput | ValidationResult | ✅ |
| `DefaultPhilosopherValidator` | 🔵 Service | core | `runtime-v2/internalization/philosopher-output.ts` | PhilosopherOutput | ValidationResult | ✅ |
| `DefaultScribeValidator` | 🔵 Service | core | `runtime-v2/internalization/scribe-output.ts` | ScribeOutput | ValidationResult | ✅ |
| `DefaultArtificerValidator` | 🔵 Service | core | `runtime-v2/internalization/artificer-output.ts` | ArtificerOutput | ValidationResult | ✅ |
| `DefaultEvaluatorValidator` | 🔵 Service | core | `runtime-v2/internalization/evaluator-output.ts` | EvaluatorOutput | ValidationResult | ✅ |
| `DefaultRolloutReviewerValidator` | 🔵 Service | core | `runtime-v2/internalization/rollout-reviewer-output.ts` | RolloutReviewerOutput | ValidationResult | ✅ |
| `DefaultTrainerValidator` | 🔵 Service | core | `runtime-v2/internalization/trainer-output.ts` | TrainerOutput | ValidationResult | ✅ |

#### 3.2.4 Prompt Builders

| 组件 | 包 | 文件 | 状态 |
|------|----|----|------|
| `DiagnosticianPromptBuilder` | core | `runtime-v2/diagnostician-prompt-builder.ts` | ✅ |
| `DreamerPromptBuilder` | core | `runtime-v2/internalization/dreamer-prompt-builder.ts` | ✅ |
| `PhilosopherPromptBuilder` | core | `runtime-v2/internalization/philosopher-prompt-builder.ts` | ✅ |
| `ScribePromptBuilder` | core | `runtime-v2/internalization/scribe-prompt-builder.ts` | ✅ |
| `ArtificerPromptBuilder` | core | `runtime-v2/internalization/artificer-prompt-builder.ts` | ✅ |
| `EvaluatorPromptBuilder` | core | `runtime-v2/internalization/evaluator-prompt-builder.ts` | ✅ |
| `RolloutReviewerPromptBuilder` | core | `runtime-v2/internalization/rollout-reviewer-prompt-builder.ts` | ✅ |
| `TrainerPromptBuilder` | core | `runtime-v2/internalization/trainer-prompt-builder.ts` | ✅ |

### 3.3 Activation Pipeline 组件

| 组件 | 类型 | 包 | 文件 | 输入 | 输出 | 状态 |
|------|-----|----|----|----|----|------|
| `ActivationDispatcher` | 🔵 Service | core | `runtime-v2/activation/activation-dispatcher.ts` | DispatchInput | DispatchResult | ✅ 基础版 |
| `ApprovalQueue` | 🔵 Service | core | `runtime-v2/activation/approval-queue.ts` | enqueue/approve/reject | ApprovalRecord | ✅ 基础版（4 状态） |
| `PromptWriter` | 🟤 Writer | core | `runtime-v2/activation/low-risk-writers.ts` | PIArtifact | ActivationOutcome | ✅ 基础版 |
| `DeferArchiveWriter` | 🟤 Writer | core | `runtime-v2/activation/low-risk-writers.ts` | PIArtifact | ActivationOutcome | ✅ 基础版 |
| `SkillFileWriter` | 🟤 Writer | core | `runtime-v2/activation/writers/skill-file-writer.ts` | PIArtifact | ActivationOutcome | Deferred / MVP stretch |
| `RuleHostWriter` | 🟤 Writer | core | `runtime-v2/activation/writers/rule-host-writer.ts` | PIArtifact | ActivationOutcome | ✅ 基础版（PRI-146 / 174 / 185） |
| `TrainingExporter` | 🟤 Writer | core | `runtime-v2/activation/writers/training-exporter.ts` | PIArtifact | ActivationOutcome | Deferred / MVP-Gone |
| `RejectionFeedbackService` | 🔵 Service | core | `runtime-v2/activation/rejection-feedback-service.ts` | reject input | feedbackId | ❌ 待建 |

### 3.4 Pruning Pipeline 组件

| 组件 | 类型 | 包 | 文件 | 输入 | 输出 | 状态 |
|------|-----|----|----|----|----|------|
| `PruningReadModel` | 🟣 ReadModel | core | `runtime-v2/pruning-read-model.ts` | n/a | PruningSignal[] | ✅ |
| `PruningReviewLog` | 🟡 Store | core | `runtime-v2/pruning-review-log.ts` | review record | append-only | ✅ |
| `PruningMask` | 🔧 Util | core | `runtime-v2/pruning-mask.ts` | ledger + reviews | maskedSet | ✅ |
| `PruningAction`（未来） | 🔵 Service | core | TBD | review approved | ledger mutation | ❌ 未规划 |

### 3.5 Runtime Adapters

| 组件 | 类型 | 包 | 文件 | 状态 |
|------|-----|----|----|------|
| `PDRuntimeAdapter` interface | 📋 Schema | core | `runtime-v2/runtime-protocol.ts` | ✅ |
| `OpenClawCliRuntimeAdapter` | 🔴 Adapter | core | `runtime-v2/adapter/openclaw-cli-runtime-adapter.ts` | ✅ |
| `PiAiRuntimeAdapter` | 🔴 Adapter | core | `runtime-v2/adapter/pi-ai-runtime-adapter.ts` | ✅ |
| `TestDoubleRuntimeAdapter` | 🔴 Adapter | core | `runtime-v2/adapter/test-double-runtime-adapter.ts` | ✅ |
| `PrincipleTreeLedgerAdapter` | 🔴 Adapter | core | `runtime-v2/adapter/principle-tree-ledger-adapter.ts` | ✅ |
| `RuntimeSelector` | 🔵 Service | core | `runtime-v2/runtime-selector.ts` | ✅ |
| `ClaudeCodeRuntimeAdapter` | 🔴 Adapter | core | `runtime-v2/adapter/claude-code-runtime-adapter.ts` | ❌ 待建（ADR-0008）|
| `CodexCliRuntimeAdapter` | 🔴 Adapter | core | `runtime-v2/adapter/codex-cli-runtime-adapter.ts` | ❌ 待建（ADR-0008）|
| `GeminiCliRuntimeAdapter` | 🔴 Adapter | core | `runtime-v2/adapter/gemini-cli-runtime-adapter.ts` | ❌ 待建（ADR-0008）|
| `OpenCodeRuntimeAdapter` | 🔴 Adapter | core | `runtime-v2/adapter/opencode-runtime-adapter.ts` | ❌ 待建（ADR-0008）|
| `HermesRuntimeAdapter` | 🔴 Adapter | core | `runtime-v2/adapter/hermes-runtime-adapter.ts` | ❌ 待建（ADR-0008）|

### 3.8 BALM — Built-in Agent Lifecycle Manager（ADR-0008）

> 统一管理 PD 内置代理的身份、提示词、工具、工作流、后端路由和版本。

| 组件 | 类型 | 包 | 文件 | 输入 | 输出 | 状态 |
|------|-----|----|----|----|----|------|
| `BuiltInAgentRegistry` | 🔵 Service | core | `runtime-v2/agents/agent-registry.ts` | agentId | AgentManifest | ❌ 待建 |
| `AgentManifest` schema | 📋 Schema | core | `runtime-v2/agents/agent-manifest.ts` | n/a | TypeBox schema | ❌ 待建 |
| `AgentRuntimeResolver` | 🔵 Service | core | `runtime-v2/agents/agent-runtime-resolver.ts` | agentId + caps | PDRuntimeAdapter | ❌ 待建 |
| `AgentLoader` | 🔵 Service | core | `runtime-v2/agents/agent-loader.ts` | agentId + runtimeKind | AgentBundle | ❌ 待建 |
| `AgentVersioning` | 🔵 Service | core | `runtime-v2/agents/agent-versioning.ts` | agentId + samples | EvalResult | ❌ 待建 |
| `diagnostician.agent.yaml` | 📋 Schema | core | `runtime-v2/agents/definitions/diagnostician.agent.yaml` | n/a | AgentManifest | ❌ 待建 |
| `dreamer.agent.yaml` | 📋 Schema | core | `runtime-v2/agents/definitions/dreamer.agent.yaml` | n/a | AgentManifest | ❌ 待建 |
| `philosopher.agent.yaml` | 📋 Schema | core | `runtime-v2/agents/definitions/philosopher.agent.yaml` | n/a | AgentManifest | ❌ 待建 |
| `scribe.agent.yaml` | 📋 Schema | core | `runtime-v2/agents/definitions/scribe.agent.yaml` | n/a | AgentManifest | ❌ 待建 |
| `artificer.agent.yaml` | 📋 Schema | core | `runtime-v2/agents/definitions/artificer.agent.yaml` | n/a | AgentManifest | ❌ 待建 |
| `evaluator.agent.yaml` | 📋 Schema | core | `runtime-v2/agents/definitions/evaluator.agent.yaml` | n/a | AgentManifest | ❌ 待建 |
| `rollout-reviewer.agent.yaml` | 📋 Schema | core | `runtime-v2/agents/definitions/rollout-reviewer.agent.yaml` | n/a | AgentManifest | ❌ 待建 |
| `trainer.agent.yaml` | 📋 Schema | core | `runtime-v2/agents/definitions/trainer.agent.yaml` | n/a | AgentManifest | ❌ 待建 |

**不变量**：
- `BALM-1`：所有内置代理必须有 manifest，禁止匿名 Peer Runner
- `BALM-2`：Peer Runner 不得直接 import Adapter 实现，必须通过 BALM 解析
- `BALM-3`：Agent prompt 必须从 manifest 加载，不得硬编码

### 3.9 LRAS — Long-Running Agent Session（ADR-0009）

> 代理持续工作直到完成的会话模型。10 分钟起步，有检查点、自校验工具、错误日志回灌。

| 组件 | 类型 | 包 | 文件 | 输入 | 输出 | 状态 |
|------|-----|----|----|----|----|------|
| `AgentSession` | 🔵 Service | core | `runtime-v2/session/agent-session.ts` | taskId + agentBundle | SessionResult | ❌ 待建 |
| `SessionCheckpoint` | 🟡 Store | core | `runtime-v2/session/session-checkpoint.ts` | sessionId + scratchpad | checkpointId | ❌ 待建 |
| `SessionStateMachine` | 🔧 Util | core | `runtime-v2/session/session-state-machine.ts` | state + event | nextState | ❌ 待建 |
| `SelfValidationTools` | 🔵 Service | core | `runtime-v2/session/self-validation-tools.ts` | output + schema | ValidationResult | ❌ 待建 |
| `LogBackflow` | 🔵 Service | core | `runtime-v2/session/log-backflow.ts` | workspaceDir + lookback | logLines[] | ❌ 待建 |

**PD 元工具（pd-cli 暴露给代理）**：

| 工具 | pd-cli 命令 | 作用 | 状态 |
|-----|-----------|------|------|
| `pd_validate_output` | `pd validate-output` | 在线校验输出是否符合 schema | ❌ 待建 |
| `pd_fetch_recent_logs` | `pd logs recent` | 拉取最近 N 条 error/warn 日志 | ❌ 待建 |
| `pd_fetch_pain_history` | `pd pain history` | 拉取 painId 的历史诊断 | ❌ 待建 |
| `pd_fetch_principle_ledger` | `pd ledger read` | 只读访问账本 | ❌ 待建 |
| `pd_check_schema_drift` | `pd schema check` | 验证当前 schema 版本 | ❌ 待建 |

**不变量**：
- `LRAS-1`：每个 LRAS session 至少有 1 个 checkpoint
- `LRAS-2`：self-validation tools 不得有副作用（只读）
- `LRAS-3`：Log backflow 必须脱敏（应用 log-sanitizer）

### 3.10 GAP — Goal-Aligned Pain + Goals（ADR-0010）

> 目标驱动的痛苦信号源。Mission/Objective 数据模型 + GAP 信号生成器 + 决策卫生门控。

| 组件 | 类型 | 包 | 文件 | 输入 | 输出 | 状态 |
|------|-----|----|----|----|----|------|
| `ObjectiveStore` | 🟡 Store | core | `runtime-v2/goals/objective-store.ts` | Objective | CRUD | ❌ 待建 |
| `KeyResultStore` | 🟡 Store | core | `runtime-v2/goals/key-result-store.ts` | KeyResult | CRUD | ❌ 待建 |
| `MissionStore` | 🟡 Store | core | `runtime-v2/goals/mission-store.ts` | Mission | CRUD | ❌ 待建 |
| `GAPSignalGenerator` | 🔵 Service | core | `runtime-v2/goals/gap-signal-generator.ts` | workspaceDir | GAPSignal[] | ❌ 待建 |
| `AlignmentEvaluator` | 🔧 Util | core | `runtime-v2/goals/alignment-evaluator.ts` | mission + objective | alignmentScore | ❌ 待建 |
| `DecisionHygieneGate` | 🔵 Service | core | `runtime-v2/decision-hygiene/decision-hygiene-gate.ts` | DecisionContext | HygieneRequirement | ❌ 待建 |
| `ThinkingModels` | 🔧 Util | core | `runtime-v2/decision-hygiene/thinking-models.ts` | n/a | framework list | ❌ 待建 |

**GAP 信号三层架构**：

| 层 | 信号类型 | 触发 Diagnostician | 说明 |
|----|---------|------------------|------|
| Layer 1（主信号）| `mission_failed` / `mission_stalled` / `okr_drift` / `decision_skipped` / `rework_loop` | ✅ 独立触发 | 目标层事件 |
| Layer 2（强信号）| `explicit_user_complaint` / `user_correction` | ✅ 独立触发 | 用户反馈 |
| Layer 3（辅助）| `tool_failure` / `empathy_inferred` | ❌ 仅作为证据 | 不独立触发 |

**DecisionHygieneGate 触发规则**：

| 条件 | 触发类型 |
|------|---------|
| 估计影响 = high / critical | 强制（hard gate）|
| 涉及不可逆变更（删数据、改 schema、生产部署）| 强制 |
| 同一 mission 已 rework 过 3 次 | 强制 |
| 偏离当前 OKR > 20% | 强制 |
| 其他情况 | 提醒（soft reminder）|

**不变量**：
- `GAP-1`：Layer 3 信号不得独立触发 Diagnostician（GAP Generator 强制）
- `HYGIENE-1`：high/critical 影响的决策必须经过 DecisionHygieneGate

### 3.11 MissionScheduler — 三层任务调度（ADR-0011）

> 替代 polling 模型，按 Objective → Mission → Run 三层优先级调度代理工作。

| 组件 | 类型 | 包 | 文件 | 输入 | 输出 | 状态 |
|------|-----|----|----|----|----|------|
| `MissionScheduler` | 🔵 Service | core | `runtime-v2/scheduler/mission-scheduler.ts` | n/a | ScheduleDecision[] | ❌ 待建 |
| `PriorityCalculator` | 🔧 Util | core | `runtime-v2/scheduler/priority-calculator.ts` | mission + objective | priority score | ❌ 待建 |
| `DependencyResolver` | 🔧 Util | core | `runtime-v2/scheduler/dependency-resolver.ts` | taskId | resolved deps | ❌ 待建 |

**三层任务模型**：

| 层 | 实体 | 生命周期 | 关联 |
|----|------|---------|------|
| L1 | `Objective` | 数月（季度目标）| 由人类设置 |
| L2 | `Mission` | 数小时到数天 | 可选关联 Objective |
| L3 | `Run`（现有 TaskRecord）| 数分钟到数十分钟 | 关联 Mission |

**不变量**：
- `SCHED-1`：MissionScheduler 调度决策必须可解释（reason 字段非空）
- `SCHED-2`：调度入口必须由 PD 自有 config/SDK/operator 或 host-agnostic scheduler 驱动；不得依赖 OpenClaw idle/night 事件

### 3.6 GFI（Global Friction Index）

| 组件 | 类型 | 包 | 文件 | 状态 |
|------|-----|----|----|------|
| `GfiKernel`（pure functions） | 🔧 Util | core | `runtime-v2/gfi/gfi-kernel.ts` | ✅ |
| `GfiPolicy` | 📋 Schema | core | `runtime-v2/gfi/gfi-types.ts` | ✅ |
| `GfiReadModel` | 🟣 ReadModel | core | `runtime-v2/gfi/gfi-read-model.ts` | ✅ |
| `GfiSessionAdapter` | 🔴 Adapter | plugin | `core/session-tracker.ts` | ✅ |

### 3.7 Prompt Builder Primitives

| 组件 | 类型 | 包 | 文件 | 状态 |
|------|-----|----|----|------|
| `buildAttitudeDirective` | 🔧 Util | core | `prompt-builder/attitude-directive.ts` | ✅ |
| `detectCorrectionCue` | 🔧 Util | core | `prompt-builder/correction-cue.ts` | ✅ |
| `truncateInjectionToBudget` | 🔧 Util | core | `prompt-builder/size-guard.ts` | ✅ |
| `matchEmpathyKeywords` | 🔧 Util | core | `prompt-builder/empathy-keyword-matching.ts` | ✅ |
| `compressFocusContent` | 🔧 Util | core | `prompt-builder/focus-compression.ts` | ✅ |
| `extractMessageContent` | 🔧 Util | core | `prompt-builder/message-extraction.ts` | ✅ |

---

## 4. Layer 3: Host Integration（宿主集成层）

### 4.1 OpenClaw Hooks

| Hook | 包 | 文件 | 触发时机 | 主要工作 | 状态 |
|------|----|----|---------|---------|------|
| `before_prompt_build` | plugin | `hooks/prompt.ts` | 每次构建 prompt | 注入 active 原则 + thinking OS | ✅ |
| `before_tool_call` | plugin | `hooks/gate.ts` | 工具执行前 | RuleHost 评估 + Progressive gate | ✅ |
| `after_tool_call` | plugin | `hooks/pain.ts` | 工具执行后 | 痛苦信号检测 + 触发 PainBridge | ✅ |
| `llm_output` | plugin | `hooks/llm.ts` | LLM 响应后 | 检测 user empathy 信号 | ✅ |
| `subagent_ended` | plugin | `hooks/subagent.ts` | 子代理结束 | 完成 shadow observation | ✅ |
| `subagent_spawning` | plugin | `hooks/subagent.ts` | 子代理生成前 | 路由分类 + 拦截 | ✅ |
| `before_reset` / `before_compaction` / `after_compaction` | plugin | `hooks/lifecycle.ts` | 上下文压缩 | 工作记忆保存与恢复 | ✅ |
| `trajectory_collector` | plugin | `hooks/trajectory-collector.ts` | 各种点 | 轨迹采集 | ✅ |
| `lifecycle_routing` | plugin | `hooks/lifecycle-routing.ts` | 各种点 | 生命周期路由 | ✅ |
| `message_sanitize` | plugin | `hooks/message-sanitize.ts` | 消息接收 | PII 脱敏 | ⚠️ 设计文档建议删除 |

### 4.2 Plugin Services（合并后保留）

| 组件 | 类型 | 包 | 文件 | 职责 | 状态 |
|------|-----|----|----|----|------|
| `EvolutionWorkerService` | 🔵 Service | plugin | `service/evolution-worker.ts` | legacy 进化队列调度 | ⚠️ 退役切换目标；不得增加职责 |
| `IdleTrigger` | 🔵 Service | core | `runtime-v2/idle-trigger/`（历史策略） | 空闲检测策略 + wakeOnce 决策 | ⚠️ 退役目标；不再建设 plugin 宿主适配 |
| `TrajectoryService` | 🔵 Service | plugin | `service/trajectory-service.ts` | 轨迹存储 | ✅ |
| `PDTaskService` | 🔵 Service | plugin | `core/pd-task-service.ts` | 后台任务调度 | ⚠️ 部分实现 |
| `KeywordOptimizationService` | 🔵 Service | plugin | `service/keyword-optimization-service.ts` | empathy 关键词优化 | ✅ |
| `MonitoringQueryService` | 🔵 Service | plugin | `service/monitoring-query-service.ts` | 监控查询 | ✅ |
| `RuntimeSummaryService` | 🔵 Service | plugin | `service/runtime-summary-service.ts` | 运行时摘要 | ✅ |
| `WorkflowWatchdog` | 🔵 Service | plugin | `service/workflow-watchdog.ts` | 工作流看门狗 | ✅ |
| `EventLogAuditor` | 🔵 Service | plugin | `service/event-log-auditor.ts` | 事件日志审计 | ✅ |
| `StartupReconciler` | 🔵 Service | plugin | `service/startup-reconciler.ts` | 启动一致性校验 | ✅ |

### 4.3 Plugin Services（计划删除/迁移，参见 ADR-0005 与 ADR-0012）

> ADR-0012 更新：不再建立或保留 plugin-owned `IdleTrigger` / sleep/night scheduler。Plugin 仅保留 event/runtime adapter；Nocturnal 执行与调度组件按 caller cutover 后删除。

| 组件 | 包 | 文件 | 处理方式 |
|------|----|----|---------|
| `NocturnalService` | plugin | `service/nocturnal-service.ts` | 删除；触发部分不再迁入 IdleTrigger |
| `NocturnalRuntime` | plugin | `service/nocturnal-runtime.ts` | 删除 |
| `NocturnalConfig` | plugin | `service/nocturnal-config.ts` | 部分迁入 internalization config |
| `NocturnalTargetSelector` | plugin | `service/nocturnal-target-selector.ts` | 删除（被 InternalizationQueueReadModel 替代） |
| `SleepCycle` | plugin | `service/sleep-cycle.ts` | 删除 idle/night 调度职责；不作为 Runtime V2 入口 |
| `TrinityRuntimeAdapter` | plugin | `core/nocturnal-trinity.ts` | 删除（被 PDRuntimeAdapter 替代） |
| `nocturnal-trinity` | plugin | `core/nocturnal-trinity.ts` | 删除 |
| `nocturnal-arbiter` | plugin | `core/nocturnal-arbiter.ts` | 删除 |
| `nocturnal-artificer` | plugin | `core/nocturnal-artificer.ts` | 删除 |
| `nocturnal-executability` | plugin | `core/nocturnal-executability.ts` | 部分迁入 core |
| `nocturnal-trajectory-extractor` | plugin | `core/nocturnal-trajectory-extractor.ts` | 部分迁入 core 的 ContextAssembler |

### 4.4 Plugin Commands（命令实现）

| 命令 | 文件 | 状态 |
|------|----|------|
| `/pd-init` | `commands/strategy.ts` | ✅ |
| `/pd-bootstrap` | `commands/capabilities.ts` | ✅ |
| `/pd-research` | `commands/capabilities.ts` | ✅ |
| `/pd-status` / `/pd-evolution-status` | `commands/evolution-status.ts` | ✅ |
| `/pd-reflect` | `commands/pd-reflect.ts` | ✅ |
| `/pd-promote-impl` / `/pd-disable-impl` / `/pd-archive-impl` / `/pd-rollback-impl` | `commands/promote-impl.ts` 等 | ✅ |
| `/pd-principle-rollback` | `commands/principle-rollback.ts` | ✅ |
| `/pd-rollback` | `commands/rollback.ts` | ✅ |
| `/pd-pain` | `commands/pain.ts` | ✅ |
| `/pd-context` | `commands/context.ts` | ✅ |
| `/pd-focus` | `commands/focus.ts` | ✅ |
| `/pd-export` | `commands/export.ts` | ✅ |
| `/pd-samples` | `commands/samples.ts` | ✅ |
| `/pd-thinking-os` | `commands/thinking-os.ts` | ❌ 已退役 (2026-08-20, write-only orphan, no reader/promoter) |
| `/pd-manage-okr` | `commands/strategy.ts` | ✅ |
| `/pd-workflow-debug` | `commands/workflow-debug.ts` | ✅ |
| `/pd-nocturnal-*` | `commands/nocturnal-*.ts` | ⚠️ 待重命名为 `/pd-internalization-*` |

---

## 5. Layer 4: Surface（表面层）

### 5.1 pd-cli 命令（for AI Agent）

| 命令 | 文件 | 输入 | 输出 | 状态 |
|------|----|----|----|------|
| `pd diagnose` | `pd-cli/commands/diagnose.ts` | painId | DiagnoseRunResult | ✅ |
| `pd run` | `pd-cli/commands/run.ts` | taskId | RunResult | ✅ |
| `pd status` | `pd-cli/commands/health.ts` | n/a | health snapshot | ✅ |
| `pd context build` | `pd-cli/commands/context.ts` | filter | ContextPayload | ✅ |
| `pd history query` | `pd-cli/commands/history.ts` | filter | history[] | ✅ |
| `pd trajectory locate` | `pd-cli/commands/trajectory.ts` | hint | candidates | ✅ |
| `pd pain record` | `pd-cli/commands/pain-record.ts` | PainSignalInput | painId | ✅ |
| `pd task list / show` | `pd-cli/commands/task.ts` | filter | TaskRecord[] | ✅ |
| `pd flow status` | `pd-cli/commands/flow.ts` | n/a | pipeline status | ✅ |
| `pd trace show` | `pd-cli/commands/trace.ts` | painId | PainChainTrace | ✅ |
| `pd runtime *` | `pd-cli/commands/runtime*.ts` | 多种 | 多种 | ✅ |
| `pd runtime internalization-queue` | `pd-cli/commands/runtime-internalization-queue.ts` | n/a | queue snapshot | ✅ |
| `pd runtime internalization-wake-once` | `pd-cli/commands/runtime-internalization-wake-once.ts` | taskKind? | WakeOnceResult | ✅ |
| `pd runtime internalization-run-once` | `pd-cli/commands/runtime-internalization-run-once.ts` | taskId | RunnerResult | ✅ |
| `pd activation list` | `pd-cli/commands/activation.ts` | filter | ApprovalRecord[]（read only）| ❌ 待建 |
| `pd activation status` | `pd-cli/commands/activation.ts` | artifactId | activation status | ❌ 待建 |
| `pd legacy-import` | `pd-cli/commands/legacy-import.ts` | nocturnal artifacts | imported count | ✅ |
| `pd legacy-cleanup` | `pd-cli/commands/legacy-cleanup.ts` | n/a | cleaned count | ✅ |
| `pd central-sync` | `pd-cli/commands/central-sync.ts` | n/a | sync result | ❌ MVP-Gone (PRI-455: CLI command + service deleted; cross-workspace sync not in MVP scope) |
| `pd samples list / review` | `pd-cli/commands/samples-*.ts` | filter | samples | ✅ |
| `pd remediation output` | `pd-cli/commands/remediation-output.ts` | n/a | remediation list | ✅ |
| `pd evolution-tasks list / show` | `pd-cli/commands/evolution-tasks-*.ts` | n/a | evolution tasks | ✅ |
| `pd runtime-canary` | `pd-cli/commands/runtime-canary.ts` | n/a | canary report | ✅ |
| `pd runtime-uat` | `pd-cli/commands/runtime-uat.ts` | n/a | UAT result | ✅ |

### 5.2 pd-console 路由（for Human）

| 路由 | 文件 | 用途 | 状态 |
|------|----|----|------|
| `/dashboard` | `pd-console/ui/pages/Dashboard.tsx` | 总览 | ✅ |
| `/health` | `pd-console/ui/pages/Health.tsx` | 健康监控 | ✅ |
| `/pipeline` | `pd-console/ui/pages/Pipeline.tsx` | 流水线状态 | ✅ |
| `/events` | `pd-console/ui/pages/EventLog.tsx` | 事件日志 | ✅ |
| `/principles` | `pd-console/ui/pages/Principles.tsx` | 原则列表 | ⚠️ 部分 |
| `/approvals` | `pd-console/src/ui/pages/TasksPage.tsx` | 审批队列（基础版） | ✅ 基础版 |
| `/approvals/{id}` | TBD | 审批详情 | ❌ 待建 |
| `/approvals/history` | `pd-console/ui/pages/ApprovalHistory.tsx` | 审批历史 | ❌ 待建 |
| `/pruning` | `pd-console/ui/pages/Pruning.tsx` | 修剪信号 | ⚠️ 部分 |

### 5.3 pd-console 模型（read-only）

| 模型 | 文件 | 用途 | 状态 |
|------|----|----|------|
| `EventLogReadModel` | `pd-console/server/models/EventLogReadModel.ts` | 事件聚合 | ✅ |
| `GateConsoleModel` | `pd-console/server/models/GateConsoleModel.ts` | gate 状态 | ✅ |
| `FeedbackConsoleModel` | `pd-console/server/models/FeedbackConsoleModel.ts` | 反馈 | ✅ |
| `ApprovalConsoleModel` | TBD | 审批数据 | ❌ 待建 |

---

## 6. 跨层组件的依赖矩阵

```
                    Schema  Util   Store  ReadModel  Service  Runner  Adapter  Bridge  Hook  Writer  Surface
Schema                ●
Util                         ●
Store                  ●     ●      ●
ReadModel              ●     ●      ●        ●
Service                ●     ●      ●        ●         ●
Runner                 ●     ●      ●        ●         ●        ●
Adapter                ●     ●      ●                  ●                ●
Bridge                 ●     ●      ●                  ●                         ●
Hook                   ●     ●      ●        ●         ●                                  ●
Writer                 ●     ●      ●                  ●                                          ●
Surface                ●     ●      ●        ●         ●                ●                                ●

● = 可依赖
```

**强约束（架构守护测试）**：

1. Schema/Util 不允许依赖任何上层组件
2. Store 不允许依赖 Service / Runner / Bridge / Hook
3. Runner 必须通过 Store 入队，不允许直接调用其他 Runner
4. Hook 不允许包含业务逻辑，只允许调用 Service/Bridge
5. Writer 必须通过 ActivationDispatcher 调用，不允许直接被 Runner 调用
6. Adapter 不允许依赖 Hook / Surface / Bridge

---

## 7. 不变量与责任清单

### 7.1 全局不变量（适用于所有组件）

| ID | 不变量 | 强制方式 |
|----|------|---------|
| INV-1 | 不允许 core 依赖 plugin / cli / console | architecture-regression test |
| INV-2 | 不允许 plugin 依赖 cli / console | architecture-regression test |
| INV-3 | 不允许 cli / console 之间相互依赖 | architecture-regression test |
| INV-4 | 不允许在 core 中使用 setInterval / cron | architecture-regression test |
| INV-5 | 不允许直接调用 LLM API（除 Adapter 外） | architecture-regression test |
| INV-6 | Schema 改动必须 backward compatible | manual review + 集成测试 |
| INV-7 | Store 写入必须原子或事务 | implementation requirement |
| INV-8 | Runner 必须通过 PDRuntimeAdapter | architecture-regression test |
| INV-9 | Activation 必须通过 ActivationDispatcher | architecture-regression test |

### 7.2 组件级 Owner 责任

每个组件的 Owner 负责：

1. **维护契约**：组件接口稳定，破坏性变更走 ADR
2. **维护文档**：本目录中本组件相关行的准确性
3. **维护测试**：单元测试 + 集成测试
4. **响应 issue**：与该组件相关的 bug

Owner 标记规则：
- **core**：默认 Owner 是 core 维护组（具体到模块的 Owner 在 `OWNERSHIP.md` 列出）
- **plugin / cli / console**：相应包的维护者

---

## 8. 索引

### 按字母顺序

`ActivationDispatcher` §3.3 ✅
`ApprovalQueue` §3.3 ✅
`ArtificerRunner` §3.2.2 ✅
`atomicWriteFileSync` §2.4 ✅
`CandidateIntakeService` §3.1 ✅
`ChannelWriter` §3.3
`ContextAssembler` §2.2 ✅
`DiagnosticianRunner` §3.1 ✅
`DiagnosticianValidator` §3.1 ✅
`DreamerRunner` §3.2.2 ✅
`EvaluatorRunner` §3.2.2 ✅
`EvolutionWorkerService` §4.2 ⚠️
`IdleTrigger` §4.2 ⚠️ Deprecated / retirement target (ADR-0012)
`InternalizationOrchestrator` §3.2.1 ✅
`IntakeToInternalizationBridge` §3.2.1 ✅
`LeaseManager` §2.2 ✅
`LedgerArchiveWriter` §3.3 ✅（`DeferArchiveWriter`）
`LedgerPromptWriter` §3.3 ✅（`PromptWriter`）
`LedgerStore` §2.2 ✅
`OpenClawCliRuntimeAdapter` §3.5 ✅
`PainSignalBridge` §3.1 ✅
`PainToPrincipleService` §3.1 ✅
`PDRuntimeAdapter` §3.5 ✅
`PhilosopherRunner` §3.2.2 ✅
`PIArtifactStore` §2.2 ✅
`PiAiRuntimeAdapter` §3.5 ✅
`PrincipleTreeLedgerAdapter` §3.5 ✅
`PromptBuilder` 各个 §3.2.4
`PruningReadModel` §3.4 ✅
`RecoverySweep` §2.2 ✅
`RolloutReviewerRunner` §3.2.2 ✅
`RuleHostWriter` §3.3 ✅
`RuntimeStateManager` §2.2 ✅
`ScribeRunner` §3.2.2 ✅
`SkillFileWriter` §3.3 Deferred / stretch
`TrainerRunner` §3.2.2 ✅
`TrainingExporter` §3.3 Deferred / MVP-Gone

### 按状态

| 状态 | 数量 |
|------|----|
| ✅ 完整实现 | ~90 |
| ⚠️ 部分实现/需重构 | ~10 |
| ❌ 待建 | ~10 |

---

## 9. 关联文档

- [`PD_ARCHITECTURE_OVERVIEW.md`](./PD_ARCHITECTURE_OVERVIEW.md) — 层级视图
- [`GLOSSARY.md`](./GLOSSARY.md) — 术语
- [`INTERNALIZATION_PIPELINE.md`](./INTERNALIZATION_PIPELINE.md) — 数据流
- [`ACTIVATION_CHANNELS.md`](./ACTIVATION_CHANNELS.md) — 通道详细
- [`DATA_ARCHITECTURE.md`](./DATA_ARCHITECTURE.md) — 数据存储
- [`ERROR_ARCHITECTURE.md`](./ERROR_ARCHITECTURE.md) — 错误处理
