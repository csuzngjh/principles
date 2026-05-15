# Internalization Pipeline 设计（内化流水线）

> **状态**: Active
> **最后更新**: 2026-05-15
> **关联 ADR**: ADR-0001（服务边界）, ADR-0003（Peer Agent 状态机）, ADR-0005（Nocturnal 合并）, ADR-0006（混合激活）
> **关联文档**: `PD_ARCHITECTURE_OVERVIEW.md`, `ACTIVATION_CHANNELS.md`, `GLOSSARY.md`

本文档定义 PD 系统从**痛苦信号**到**已激活实现**的**完整端到端流水线**。它是 ADR-0003 / ADR-0005 / ADR-0006 决议在工程层的具象化。

---

## 1. 流水线总览

PD 的内化流水线是一条**单向**、**事件驱动**、**状态可追溯**的处理链。从输入到输出共有 4 个主要阶段：

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                       │
│  ┌─────────┐   ┌──────────────┐   ┌──────────────┐   ┌─────────┐    │
│  │ Pain    │   │ Pain         │   │ Internaliz-  │   │ Acti-   │    │
│  │ Capture │ → │ Pipeline     │ → │ ation        │ → │ vation  │    │
│  │         │   │ (Diagnos)    │   │ Pipeline     │   │ Pipeline│    │
│  └─────────┘   └──────────────┘   └──────────────┘   └─────────┘    │
│                                                                       │
│  PainSignal     LedgerPrincipleEntry  PIArtifact         实际生效    │
│                 (status=probation)    (validated)                     │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
        Stage 0           Stage 1            Stage 2          Stage 3
```

**关键特征**：

- **单向**：数据流从左到右单向传递，每阶段产出**不可变工件**
- **事件驱动**：每阶段完成后通过 SQLite TaskStore 入队下一阶段，不直接调用
- **状态可追溯**：每个 painId 都可通过 `PainChainReadModel` 查询完整证据链
- **可中断恢复**：任意阶段崩溃后，下次唤起 IdleTrigger 自动从断点继续

本文档**重点**讨论 Stage 1（痛苦诊断）和 Stage 2（内化蒸馏）。Stage 3（激活）详见 [`ACTIVATION_CHANNELS.md`](./ACTIVATION_CHANNELS.md)。

---

## 2. Stage 1: Pain Pipeline（痛苦诊断）

### 2.1 目的

把代理的**结构化失败事件**（PainSignal）转化为**可摄入的原则候选**（LedgerPrincipleEntry, status=probation）。

### 2.2 数据流

```
[Tool Failure / User Frustration / Subagent Error]
         │
         │  Plugin Hook（after_tool_call / llm_output / subagent_ended）
         ▼
   PainSignalAdapter.recordPain()
         │
         ▼
   ┌─────────────────────────┐
   │  state.db: pain_signals │
   │  ledger.json: pain_flag │
   └──────────┬──────────────┘
              │
              ▼
   PainBridge.onPainDetected(painId)
              │
              │  幂等检查：createDiagnosticianTaskId(painId)
              ▼
   ┌──────────────────────────┐
   │  state.db: tasks         │
   │  taskKind=diagnostician  │
   │  status=pending          │
   └──────────┬───────────────┘
              │
              │  IdleTrigger 唤起 / 立即调度
              ▼
   DiagnosticianRunner.run(taskId)
   ├─ acquireLease
   ├─ buildContext (ContextAssembler)
   ├─ invokeRuntime (PDRuntimeAdapter)
   ├─ pollUntilTerminal
   ├─ fetchOutput → DiagnosticianOutputV1
   ├─ validate (DiagnosticianValidator)
   └─ commit (DiagnosticianCommitter)
              │
              ▼
   ┌─────────────────────────────────┐
   │  state.db: artifacts            │
   │  artifactKind=diagnosis_report  │
   │                                 │
   │  state.db: candidates           │
   │  status=pending                 │
   └──────────┬──────────────────────┘
              │
              ▼
   CandidateIntakeService.intake(candidateId)
   ├─ existsForCandidate?  → noop（幂等）
   ├─ load candidate + artifact
   ├─ build LedgerPrincipleEntry
   └─ writeProbationEntry
              │
              ▼
   ┌─────────────────────────────────┐
   │  ledger.json:                   │
   │  principle.status = probation   │
   └─────────────────────────────────┘
```

### 2.3 各组件契约

| 组件 | 包 | 输入 | 输出 | 失败语义 |
|------|----|----|----|---------|
| `PainSignalAdapter` | core | 平台事件 | PainSignal | 失败 → 静默丢弃（next opportunity） |
| `PainBridge` | core | PainSignal | 异步 ack | 幂等：同 painId 第二次进入返回缓存结果 |
| `DiagnosticianRunner` | core | taskId | RunnerResult | 重试机制详见 retry-policy |
| `DiagnosticianValidator` | core | RawOutput | 校验通过/失败 | 失败 → output_invalid，可重试 |
| `DiagnosticianCommitter` | core | output | commitId | 失败 → artifact_commit_failed，重试 |
| `CandidateIntakeService` | core | candidateId | LedgerPrincipleEntry | 失败 → 抛 CandidateIntakeError，候选保持 pending |

### 2.4 关键不变量

1. **幂等性**：同一个 `painId` 的处理是幂等的
   - `createDiagnosticianTaskId(painId)` 是确定性映射
   - `PainBridge.onPainDetected` 检查 task 状态：`succeeded` 直接返回缓存，`leased` 返回 skipped
2. **不丢失**：PainSignal 一旦写入 SQLite，必须可被 Diagnostician 处理
   - 如果 Plugin 崩溃，下次启动时 RecoverySweep 扫描 `pending` task 重启
3. **可追溯**：每条 PainSignal 都能通过 PainChainReadModel 反查到 candidate / ledger entry
4. **不静默吞没错误**：任何失败必须留下 `PDRuntimeError` 记录

### 2.5 性能预算

| 步骤 | 预算 |
|------|------|
| Pain 捕获到 SQLite 写入 | < 50 ms（Hook 同步路径） |
| Pain → Task 入队 | < 100 ms |
| Diagnostician 完整运行 | 默认 5 分钟，可配置 |
| Candidate Intake | < 1 秒 |

### 2.6 当前实现状态

| 组件 | 实现状态 |
|------|---------|
| PainSignalAdapter | ✅ 完整 |
| PainBridge | ✅ 完整 |
| DiagnosticianRunner | ✅ 完整 |
| DiagnosticianValidator (DefaultValidator) | ✅ 完整 |
| DiagnosticianCommitter (Sqlite) | ✅ 完整 |
| CandidateIntakeService | ✅ 完整 |

---

## 3. Stage 2: Internalization Pipeline（内化流水线）

### 3.1 目的

把 **probation 候选原则**通过 7 个 Peer Runner 串联**蒸馏**为 5 类可激活的实现工件（PIArtifact）。

### 3.2 关键架构变更（基于 ADR-0005）

合并后的 Internalization Pipeline 取代了原有的 nocturnal-trinity 链：

```
旧（已废弃）：                       新（canonical）：
nocturnal-service.runReflection()    InternalizationOrchestrator.wakeOnce()
  ├ TargetSelector                     ├ findCandidates(pending tasks)
  ├ TrajectoryExtractor                ├ resolveDependencies
  ├ Trinity (D/P/S)                    ├ acquireLease
  ├ Arbiter                            └ → DreamerRunner / ... / TrainerRunner
  ├ Executability
  ├ Artificer
  └ Persist
```

**新链路**：触发与执行分离。
- **触发**：`openclaw-plugin/service/idle-trigger.ts` 决定何时唤起
- **执行**：`@principles/core` 的 InternalizationOrchestrator + 7 个 Runner

### 3.3 流水线启动条件（断点 ① 解决方案）

**问题**：Probation 候选写入 Ledger 后，谁负责把它转换为 `dreamer` 任务入队？

**当前现状**：无自动桥接，需手动 `pd-cli wake-once`。

**新设计**：引入 `IntakeToInternalizationBridge`（核心新组件）

```
┌──────────────────────────────────────────────────────────────────┐
│  CandidateIntakeService.intake() succeeds                          │
│  → 触发 ledger 写入 + emit telemetry event                          │
└──────────────────────┬───────────────────────────────────────────┘
                       │
                       ▼
            IntakeToInternalizationBridge.onProbationCreated()
                       │
                       │  1. 检查路由策略 (RoutingPolicy)
                       │  2. 决定首选 channel (prompt/skill/code/training/archive)
                       │  3. 创建 dreamer 任务（task graph 起点）
                       ▼
            ┌─────────────────────────────────────┐
            │  state.db: tasks                    │
            │  taskKind=dreamer                   │
            │  channel=<route>                    │
            │  status=pending                     │
            │  metadata.parentLedgerEntryId=...   │
            └─────────────────────────────────────┘
```

#### 3.3.1 IntakeToInternalizationBridge 契约

位置：`@principles/core/runtime-v2/internalization/intake-to-internalization-bridge.ts`（新建）

```typescript
interface IntakeToInternalizationBridge {
  /**
   * 当 CandidateIntakeService 写入新的 probation 条目时触发。
   * 决定路由策略并入队首个内化任务（dreamer）。
   *
   * 幂等：同一个 ledgerEntryId 重复触发返回缓存的 dreamerTaskId
   */
  onProbationCreated(input: ProbationCreatedInput): Promise<BridgeResult>;
}

interface ProbationCreatedInput {
  ledgerEntryId: string;
  principleId: string;
  sourceCandidateId: string;
  sourceArtifactId: string;
  /** 来源路径，用于路由策略判断 */
  sourcePainId?: string;
  /** 来自 Diagnostician 的 recommendation kind */
  recommendationKind: 'principle' | 'rule' | 'implementation' | 'prompt' | 'defer';
}

type BridgeResult =
  | { decision: 'task_created'; dreamerTaskId: string; channel: InternalizationChannel }
  | { decision: 'skipped'; reason: 'route_says_defer' | 'principle_already_in_pipeline' }
  | { decision: 'task_exists'; existingTaskId: string };
```

#### 3.3.2 路由决策（RoutingPolicy）

`RoutingPolicy` 已存在于 `core/runtime-v2/internalization/routing-policy.ts`。本桥接器直接调用：

```typescript
const route = recommendLifecycleRoute({
  principle,
  evidence: lifecycleEvidence,
});

// route.recommended → 'L1_PROMPT' | 'L2_CODE_HOOK' | 'L3_MODEL_TRAINING'
//                   | 'KEEP' | 'ARCHIVE' | 'DEPRECATE'

const channel = mapRouteToChannel(route.recommended);
```

#### 3.3.3 路由 → 通道映射

| RoutingPolicy 输出 | 内化通道 | 备注 |
|-------------------|---------|------|
| `L1_PROMPT` | `prompt` | 默认起点 |
| `L1_SKILL`（新增） | `skill` | 适合流程性原则 |
| `L2_CODE_HOOK` | `code_tool_hook` | 高风险，必须人工审批 |
| `L3_MODEL_TRAINING` | `model_training` | 极高风险 |
| `ARCHIVE` / `DEPRECATE` | `defer_archive` | 跳过流水线，直接归档 |
| `KEEP` | （无入队） | 保持现状，不产生新任务 |

**默认行为**：当 RoutingPolicy 未给出推荐时，默认使用 `prompt` 通道（最低风险）。

### 3.4 7 个 Peer Runner 的 Job Graph

详见 ADR-0003 的 ALLOWED_EDGES。本节给出**实际数据流视图**：

```
                  ┌───────────────────┐
                  │ Dreamer           │
                  │ (生成候选纠正方案) │
                  │ → DreamerOutput   │
                  └─────────┬─────────┘
                            │
                            ▼
                  ┌───────────────────┐
                  │ Philosopher       │
                  │ (评估并精炼候选)   │
                  │ → PhilosopherOutput│
                  └─────────┬─────────┘
                            │
                            ▼
                  ┌───────────────────┐
                  │ Scribe            │
                  │ (产出原则草稿)     │
                  │ → ScribeOutput    │
                  └─────────┬─────────┘
                            │
                            ▼
                  ┌───────────────────┐
                  │ Artificer         │
                  │ (生成实现计划)     │
                  │ → ArtificerOutput │
                  └─────────┬─────────┘
                            │
                            ▼
                  ┌───────────────────┐
                  │ Evaluator         │
                  │ (打分与决策)       │
                  │ → EvaluatorOutput │
                  └─────────┬─────────┘
                            │
                            ▼
                  ┌───────────────────┐
                  │ RolloutReviewer   │
                  │ (发布决策)         │
                  │ → RolloutReviewerOutput
                  └─────────┬─────────┘
                            │
                            ▼
              ┌─────────────┴─────────────┐
              │                           │
        ┌─────▼──────┐           ┌────────▼─────────┐
        │ ActivationDispatcher   │ Trainer (仅 L3)  │
        │ (Stage 3)  │           │ (生成训练数据)    │
        └────────────┘           └──────────────────┘
```

### 3.5 Runner 的统一行为契约

每个 Peer Runner 必须实现以下生命周期，无例外（已在 DiagnosticianRunner / DreamerRunner / 其他 Runner 中固定）：

```typescript
interface PeerRunner<TOutput> {
  run(taskId: string): Promise<RunnerResult<TOutput>>;
}

// 统一执行序列：
// 1. acquireLease(taskId)      → TaskRecord (leased)
// 2. resolveStoreRunId         → runId
// 3. buildContext              → ContextPayload + contextHash
// 4. invokeRuntime             → RunHandle (via PDRuntimeAdapter)
// 5. pollUntilTerminal         → RunStatus
// 6. fetchAndParseOutput       → TOutput
// 7. validate                  → ValidationResult
// 8. (write PIArtifact)        → artifactId
// 9. markTaskSucceeded         → resultRef
// 10. (optional) propose next  → 下游 task 入队
```

**严格禁止**：
- Runner 直接调用其他 Runner（必须通过 TaskStore 入队）
- Runner 直接读 ledger / 写 ledger（除非通过 ChannelWriter）
- Runner 直接调用 LLM SDK（必须通过 PDRuntimeAdapter）
- Runner 内部使用 setInterval / cron（属于 IdleTrigger 职责）

### 3.6 数据契约：Runner 之间通过 PIArtifact 传递

每个 Runner 的输出**必须**写入 `PIArtifactStore`，作为下游 Runner 的输入。

```typescript
interface PIArtifact {
  artifactId: string;
  artifactKind: 'principle' | 'rule' | 'training_data' | 'skill' | 'patch';
  sourceTaskId: string;
  sourcePrincipleId?: string;
  sourceRuleId?: string;
  lineageRefs: LineageRef[];
  validationStatus: 'pending' | 'validated' | 'rejected';
  contentJson: string;  // 序列化的 Runner 输出
  createdAt: string;
  updatedAt: string;
}
```

**幂等键**：`(sourceTaskId, artifactKind)` —— 同一任务重跑覆盖同一 artifact。

**血缘**：每个 Runner 在写入 artifact 时记录 `lineageRefs`，指向上游所有 dependency artifacts。

### 3.7 Runner 输出 Schema 概览

| Runner | OutputSchemaRef | 关键字段 | PIArtifact kind |
|--------|----------------|---------|-----------------|
| Dreamer | `dreamer-output-v1` | `candidates[]` (badDecision, betterDecision, confidence) | `principle` |
| Philosopher | `philosopher-output-v1` | `principleCandidates[]` (refinedText, evidence) | `principle` |
| Scribe | `scribe-output-v1` | `principleDrafts[]` (title, text, scope) | `principle` |
| Artificer | `artificer-output-v1` | `implementationPlans[]` (channel, code/template, expectedDecision) | `rule` |
| Evaluator | `evaluator-output-v1` | `evaluations[]` (score, decision, evidence) | `rule` |
| RolloutReviewer | `rollout-reviewer-output-v1` | `reviews[]` (decision: auto_activate/require_approval/reject) | `rule` |
| Trainer | `trainer-output-v1` | `ruleCandidate` (proposedDecision, confidence, trainingData) | `training_data` |

### 3.8 状态机视图

```
[Probation Ledger Entry]
        │
        ▼ IntakeToInternalizationBridge
[dreamer task: pending]
        │
        ▼ IdleTrigger.wakeOnce → acquireLease
[dreamer task: leased]
        │
        ▼ DreamerRunner 执行
[dreamer task: succeeded] + [PIArtifact: kind=principle, status=pending]
        │
        ▼ proposeNextTask → philosopher 入队
[philosopher task: pending] (depends on dreamer task)
        │
        ▼ ... (重复 5 次直到 RolloutReviewer)
[rollout_reviewer task: succeeded] + [PIArtifact: validated]
        │
        ▼ ActivationDispatcher.dispatch()  ← Stage 3 入口
```

每个 Runner 失败的状态转移（详见 ADR-0003）：
- 临时失败 → `retry_wait` → 下次唤起重试
- 永久失败 → `failed` → 不再重试，需人工干预
- 超过最大重试次数 → `failed` (with `max_attempts_exceeded`)

---

## 4. 触发器与编排（IdleTrigger + Orchestrator）

### 4.1 IdleTrigger（plugin 层，新建）

位置：`packages/openclaw-plugin/src/service/idle-trigger.ts`

职责：
- 监听 OpenClaw 的 heartbeat / 工作区空闲信号
- 决定何时调用 `InternalizationOrchestrator.wakeOnce()`
- 暴露状态查询给 pd-console

**严格不允许**：
- 实现 LLM 调用
- 直接读写 PIArtifact / Ledger
- 实现任何 Runner 逻辑

```typescript
interface IdleTrigger {
  start(orchestrator: InternalizationOrchestrator): void;
  stop(): Promise<void>;
  status(): IdleTriggerStatus;
}

interface IdleTriggerStatus {
  enabled: boolean;
  lastWakeAt: string | null;
  lastResult: 'leased' | 'no_ready_tasks' | 'error' | null;
  nextScheduledAt: string | null;
  /** 累计唤起次数 */
  totalWakeCount: number;
  /** 累计成功 lease 次数 */
  totalLeasedCount: number;
}
```

### 4.2 触发策略

可配置的触发条件（在 `{workspace}/.pd/config/idle-trigger.yaml`）：

```yaml
idle_trigger:
  enabled: true
  policies:
    - kind: heartbeat_idle      # 默认：心跳空闲超过 N 秒
      idle_threshold_seconds: 300
    - kind: scheduled            # 定时唤起
      cron: "0 */15 * * * *"     # 每 15 分钟
    - kind: queue_pressure       # 队列积压触发
      pending_threshold: 10
  max_concurrent_runs: 3
```

### 4.3 InternalizationOrchestrator（core 层，已存在）

位置：`@principles/core/runtime-v2/internalization/internalization-orchestrator.ts`

职责：
- `wakeOnce(taskKind?)` —— 找到一个可执行任务并 acquireLease
- `proposeNextTask(taskId)` —— 为已成功的任务建议下一阶段
- `commitNextTaskProposal(taskId)` —— 实际入队下一阶段任务

详见 ADR-0003 §3。

---

## 5. 数据存储

### 5.1 主要表/文件

| 数据类型 | 物理位置 | 说明 |
|---------|---------|------|
| TaskRecord / PITaskRecord | `state.db: tasks` | 任务队列 |
| RunRecord | `state.db: runs` | 执行记录 |
| PIArtifact | `state.db: pi_artifacts` | Runner 产物 |
| CandidateRecord | `state.db: candidates` | Diagnostician 候选 |
| ArtifactRecord | `state.db: artifacts` | Diagnostician 工件 |
| Ledger | `.state/principle_training_state.json` | 原则树主账本 |
| TelemetryEvent | `state.db: events` | 跨流水线事件流 |

### 5.2 Ledger 字段（probation 入口后的字段流转）

```
intake 写入 →  status=probation, sourceRef=candidate://..., artifactRef=artifact://...

Dreamer 执行 → 不修改 Ledger，写入 PIArtifact

...

ActivationDispatcher (channel=prompt) →
  status=active, activatedAt=<now>, activatedBy=<actor>

ActivationDispatcher (channel=defer_archive) →
  status=archived, archivedReason=<route_recommendation>

ActivationDispatcher (channel=code_tool_hook) →
  status=active + 写入 implementation 文件

ActivationDispatcher (channel=skill) →
  status=active + 写入 skill 文件

ActivationDispatcher (channel=model_training) →
  status=active + 写入 training-exports
```

### 5.3 跨阶段血缘视图

```
PainSignal(painId)
    │ 1:1
    ▼
TaskRecord(taskKind=diagnostician)
    │ 1:N
    ▼
RunRecord
    │ 1:1
    ▼
ArtifactRecord(diagnosis_report)
    │ 1:N
    ▼
CandidateRecord
    │ 1:1
    ▼
LedgerPrincipleEntry(probation)
    │ 1:1
    ▼
TaskRecord(taskKind=dreamer)  ← IntakeToInternalizationBridge 创建
    │ 1:N (Job Graph)
    ▼
TaskRecord(taskKind=philosopher) → ... → TaskRecord(rollout_reviewer)
    │ 每个 task 1:1
    ▼
PIArtifact(各 kind)
    │
    ▼ ActivationDispatcher
ApprovalRecord（可选） → 实际激活
```

---

## 6. 关键不变量与约束

### 6.1 一致性

1. **PIArtifact 写入与 Task 状态变更必须原子**：Runner 在 succeed 前必须先成功写 PIArtifact
2. **Ledger 写入必须原子**：通过 `atomicWriteFileSync`
3. **审批结果与激活必须原子**：approve 后必须保证 ChannelWriter 被调用，失败需重试

### 6.2 幂等性

| 操作 | 幂等键 |
|------|-------|
| Pain → Diagnostician task | `painId → taskId(deterministic)` |
| Candidate → Ledger entry | `existsForCandidate(candidateId)` |
| Probation → Dreamer task | `(ledgerEntryId, channel)` |
| 任何 Runner 输出 → PIArtifact | `(sourceTaskId, artifactKind)` |
| Validated → Activation | `(artifactId, channel)` |

### 6.3 可恢复性

- 任意阶段崩溃，下次启动时 `RecoverySweep` 扫描 `pending` / `leased` task 自动恢复
- `lease_expired` 视为可恢复，重置为 `pending`
- 每个 Runner 必须支持从中断点重启（不依赖内存状态）

### 6.4 可观测性

每个阶段必须发出至少 3 个 telemetry event：

| 阶段 | 事件 |
|------|------|
| Diagnostician | `diagnostician_task_leased` / `diagnostician_run_started` / `diagnostician_task_succeeded` 或 `_failed` |
| Bridge | `probation_to_internalization_bridged` / `bridge_skipped` |
| 每个 Peer Runner | `<runner>_task_leased` / `<runner>_run_started` / `<runner>_task_succeeded` 或 `_failed` |
| Activation | 详见 ADR-0006 |

### 6.5 性能预算

| 阶段 | 预算 | 触发降级 |
|------|------|---------|
| 单个 Pain → Probation | < 6 分钟 (P95) | > 10 分钟报警 |
| Probation → Validated PIArtifact (整链) | < 30 分钟 (P95) | > 1 小时报警 |
| 任意单个 Runner 调用 | < 5 分钟（默认 timeout） | timeout → retry_wait |
| Hook 同步路径（pain capture） | < 50ms | 超出阻塞工具调用 |

---

## 7. 错误处理与降级

### 7.1 错误分类（详见 `ERROR_ARCHITECTURE.md`）

| 错误类别 | 重试策略 | 降级策略 |
|---------|---------|---------|
| `runtime_unavailable` | 指数退避 | 等待下次 IdleTrigger |
| `output_invalid` | 最多 3 次重试，注入修复提示 | 失败后 mark failed，等人审 |
| `lease_conflict` | 不重试（其他 Runner 在执行） | 跳过此次 |
| `timeout` | 重试 1 次（超时翻倍） | 失败后 mark failed |
| `storage_unavailable` | 永久错误 | 立即停止流水线，告警 |
| `workspace_invalid` | 永久错误 | 立即停止 |

### 7.2 部分失败的处理

**场景 A**：Diagnostician 成功但 CandidateIntake 失败
- 候选保持 `pending`
- 下次 IdleTrigger 重新尝试 intake

**场景 B**：Dreamer 成功但 Philosopher 失败
- Philosopher task 进入 `retry_wait`
- 已生成的 PIArtifact 保留，下次重试可复用

**场景 C**：RolloutReviewer 成功但 ActivationDispatcher 失败
- 进入 ApprovalQueue（如果是高风险通道）
- 写入审批 pending 记录，等待人工

### 7.3 反馈环（Rejection Feedback Loop）

详见 ADR-0006 §2.6。当人工 reject 一个 PIArtifact 时：

```
RejectionFeedback 写入
        │
        ▼
（可选）创建新的 Dreamer task
        │
        │ 注入 correctionHints 到 prompt context
        ▼
Dreamer 在新一轮中知道"上次为何被拒"
```

---

## 8. 与 Activation Pipeline 的衔接（断点 ② 解决方案）

详见 [`ACTIVATION_CHANNELS.md`](./ACTIVATION_CHANNELS.md)。本节只给出衔接点：

```
RolloutReviewerRunner.succeed() {
  ...
  await activationDispatcher.dispatch({
    artifactId,
    channel: piTask.channel,
    rolloutDecision: output.review.decision,
    actor: { kind: 'system', source: 'rollout_reviewer' },
  });
  ...
}
```

`ActivationDispatcher` 是流水线的**唯一出口**。所有"激活"操作必须经过它。

---

## 9. 配置与可调参数

### 9.1 流水线配置

位置：`{workspace}/.pd/config/internalization.yaml`（新建）

```yaml
internalization:
  default_runner_timeout_ms: 300000
  default_max_attempts: 3

  # IdleTrigger（参见 §4.2）
  idle_trigger:
    enabled: true

  # Job graph 灰度
  enabled_channels:
    - prompt
    - skill
    - code_tool_hook
    - model_training
    - defer_archive

  # 每通道并发上限
  max_concurrent_per_channel:
    prompt: 5
    skill: 3
    code_tool_hook: 2
    model_training: 1

  # Bridge 行为
  bridge:
    auto_create_dreamer_task: true
    skip_if_already_in_pipeline: true
```

### 9.2 路由策略可覆盖

`RoutingPolicy` 默认基于 lifecycle evidence 推荐路由，可通过 config 强制覆盖：

```yaml
routing_policy:
  overrides:
    - principle_id_pattern: "^P_security_.*"
      force_channel: code_tool_hook  # 安全相关原则强制走代码内化
    - principle_id_pattern: "^P_style_.*"
      force_channel: prompt          # 风格相关只走 prompt
```

---

## 10. 测试要求

### 10.1 单元测试覆盖

每个 Runner / Bridge / Service 必须有单元测试：
- happy path
- 各种 PDErrorCategory 的处理
- 幂等性（重复输入返回相同输出）
- 输入校验失败

### 10.2 集成测试

至少 3 条端到端集成测试场景：

1. **Pain → Probation → Activated（prompt 通道）**：完整自动链
2. **Pain → Probation → Approval Required（code_tool_hook）**：高风险审批分支
3. **Pain → Rejected by Validator → Retry**：错误恢复路径

### 10.3 架构守护测试

- Runner 之间不得相互直接 import
- Core 模块不得 import openclaw-plugin
- 任何 LLM 调用必须经过 PDRuntimeAdapter

### 10.4 性能基线

定期跑性能基线测试：
- 100 个并发 Pain Signal 的吞吐量
- 单个 Pain → Activated 的端到端延迟分布

---

## 11. 当前实现状态对照表

| 组件 | 状态 | 待办 |
|------|------|------|
| **Stage 1 (Pain)** | | |
| PainSignalAdapter | ✅ | |
| PainBridge | ✅ | |
| DiagnosticianRunner | ✅ | |
| CandidateIntakeService | ✅ | |
| **Stage 2 (Internalization)** | | |
| IntakeToInternalizationBridge | ❌ | **新建（断点 ①）** |
| RoutingPolicy | ✅ | 可能需要扩展 channel mapping |
| InternalizationOrchestrator | ✅ | |
| DreamerRunner | ✅ | |
| PhilosopherRunner | ✅ | |
| ScribeRunner | ✅ | |
| ArtificerRunner | ✅ | |
| EvaluatorRunner | ✅ | |
| RolloutReviewerRunner | ✅ | 增加 ActivationDispatcher 调用 |
| TrainerRunner | ✅ | 仅 model_training 通道 |
| **触发** | | |
| IdleTrigger | ❌ | **新建（替代旧 nocturnal-service）** |
| **Stage 3 (Activation)** | | |
| ActivationDispatcher + ChannelWriters | ❌ | 见 ADR-0006，待建 |
| **数据迁移** | | |
| Nocturnal → PIArtifact 迁移 | ❌ | 见 ADR-0005 |

---

## 12. 实施优先级

按 ADR-0005 / ADR-0006 给出的阶段：

### 优先级 P0（解锁端到端流水线）
- [ ] `IntakeToInternalizationBridge` 实现 → 解决断点 ①
- [ ] `IdleTrigger` 实现 → 替代 nocturnal-service 触发部分
- [ ] `ActivationDispatcher` 框架 + prompt/archive 两个 ChannelWriter → 解决断点 ②（最低风险通道）

### 优先级 P1（高风险通道）
- [ ] `SkillFileWriter`
- [ ] `RuleHostWriter` + shadow mode
- [ ] `ApprovalQueue`
- [ ] pd-console 审批 UI

### 优先级 P2（清理与合并）
- [ ] 删除 `nocturnal-service.ts`、`nocturnal-trinity.ts` 等冗余代码
- [ ] 删除 RuleImplementationArtifact 旧概念引用
- [ ] 数据迁移脚本

### 优先级 P3（最高风险通道）
- [ ] `TrainingExporter` + 二次确认
- [ ] 与外部模型训练系统集成

---

## 13. 与其他文档的关系

| 文档 | 关系 |
|------|------|
| [`PD_ARCHITECTURE_OVERVIEW.md`](./PD_ARCHITECTURE_OVERVIEW.md) | 上层视图；本文档展开 §4.1-4.2 的细节 |
| [`ACTIVATION_CHANNELS.md`](./ACTIVATION_CHANNELS.md) | 下游：本文档结束于 ActivationDispatcher.dispatch() |
| [`COMPONENTS.md`](./COMPONENTS.md) | 各组件契约的扁平索引 |
| [`DATA_ARCHITECTURE.md`](./DATA_ARCHITECTURE.md) | 表/文件存储细节 |
| [`ERROR_ARCHITECTURE.md`](./ERROR_ARCHITECTURE.md) | 错误处理详细规范 |
| ADR-0001 / 0003 / 0005 / 0006 | 决策依据 |

---

## 14. 变更追踪

本文档代表流水线的**目标状态**。任何对流水线的设计变更必须：

1. 提交 ADR 修改本文档列表的某条决策
2. 同步修订本文档相应章节
3. 更新 `当前实现状态对照表`（§11）
4. 更新 `GLOSSARY.md` 如有新词

