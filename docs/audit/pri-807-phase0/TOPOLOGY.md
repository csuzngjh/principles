# PRI-807 Phase 0 — Worker A：Topology / Channel DAG 审计

- **审计对象**：`packages/**` 当前 main 的编排拓扑（只读）
- **基线**：见 §2
- **方法**：逐符号回源；producer 与 consumer 两端均打开确认（禁止仅凭 grep 下结论）
- **判定词**：CONFIRMED / FIXED / DRIFTED / PARTIAL / NEW / UNVERIFIABLE

---

## 1. Scope

### 查了什么

- 编排 SSOT 常量的当前定义与全部消费方：`INTERNAL_AGENT_NAMES`、`DIAGNOSTICIAN_EDGES`、`CHANNEL_EDGES`、`ALLOWED_EDGES`、`resolveChannelEdges`、`pipelineMode`。
- task seed / resume / reopen 三条生命周期入口，以及 successor creation 的全部生产调用点。
- legacy 缺失 `pipelineMode` 字段的解释路径（AC12）。
- bypass 搜索：runner 侧手工 successor、switch/case 自造 successor、recovery/reopen 绕过 `CHANNEL_EDGES`。
- §5 carry-forward 项 R-14 / R-15 / R-25 的 current-main 裁决。

### 不查什么（Out of Scope 细则见 §9）

- 提示词文本质量、schema↔prompt 自相矛盾（属审查族其他条目）。
- 各 runner 内部业务语义（评分算法、RuleCode 验证细节）。
- `~/.pd/runtime/`、`~/.openclaw/extensions/**`、`<workspace>/.pd/` 的已安装运行时状态。
- 任何修复方案或 SPEC 设计。

---

## 2. Baseline

```
checkout SHA : 191ae1af588a68950af1de5a3b9265771a7b3e8d
commit time  : 2026-09-15 10:56:42 +0800
subject      : Merge pull request #1705 from csuzngjh/ai/PRI-785-runbook-allow-events
```

### Drift Warning

任务书指定基线为 `cdec05d4bc4252151c7f9f118bdad90f25067594`。**该 SHA 在本 checkout 中不存在**：

- `git cat-file -t cdec05d4b` → `fatal: could not get object info`
- `git fetch origin cdec05d4bc4252151c7f9f118bdad90f25067594` → `remote error: upload-pack: not our ref`
- `git ls-remote origin | grep cdec05d4` → 0 命中（280 个 ref 已枚举）

`cdec05d4b..HEAD` 与 `HEAD..cdec05d4b` 均无法计算（对象缺失，非祖先关系）。
**无法给出"缺哪些提交 / 多哪些提交"的清单**，因此无法量化 Drift 影响面。

可确证的是：本 checkout 的 HEAD 是 CNB 镜像 `main` 的最新提交（`git log` 第 1 条即 `#1705`），
且其工作树**已包含** PRI-720 channel-aware DAG（merge `285d1c814`，PR #1698）与
PRI-795（merge `be615da11`）——即任务书所引的 `#1698 通道重构后` 语境已落地。

> **结论仅对实际 checkout SHA `191ae1af` 负责。** 若 Owner 的 `cdec05d4b` 领先于本 checkout，
> 本报告未覆盖其增量；反过之若落后，则本报告包含其后的 PRI-720/PRI-795 变动。
> 历史事实种子采取替代来源：`origin/ai/audit-agent-pipeline-report:docs/audit/agent-pipeline-audit-2026-09-15/REPORT.md`
> （基线 `70d824c4`，即 PRI-720 之前的 main）。该文件在**本 checkout 的 main 上不存在**，
> 从远端分支读取，仅作历史对照，不作 current-main 证据。

---

## 3. Current Authorities（现行代码 SSOT）

审计发现编排拓扑事实分散在 **6 个权威点**，其中只有 1 个是真正的边集 SSOT。

| # | 权威点 | 符号 | 位置 | 拥有什么事实 | 是否被运行时强制 |
|---|---|---|---|---|---|
| A1 | **边集 SSOT** | `ALLOWED_EDGES` / `PRINCIPLE_SEMANTIC_EDGES` / `CHANNEL_EDGES` / `resolveChannelEdges` | `packages/principles-core/src/runtime-v2/internalization/internalization-job-graph.ts:35,52,63,84` | channel × pipelineMode → 合法边集；这是**唯一的**边集定义 | ✅ 经 `getAllowedSuccessors` 参与 successor 选择（**不是**经 `validateEdge`，见 §7 G-01） |
| A2 | **诊断链边集** | `DIAGNOSTICIAN_EDGES` / `getDiagSuccessors` | 同文件 `:101,151` | diag_rootcause→distiller→router | ✅ 经 `orchestrator.proposeNextTask` 分支消费（`internalization-orchestrator.ts:355-374`） |
| A3 | **迁移仲裁** | `decideInternalizationTransition` | `internalization-transition-decision.ts:73` | verdict → ADVANCE / REVISION_REQUIRED / TERMINAL_REJECT / HUMAN_REVIEW_REQUIRED / REOPEN_SOURCE_EVALUATOR / BLOCKED_MISSING_VERDICT | ✅ 唯一漏斗 `commitNextTaskProposal` 内调用（`internalization-orchestrator.ts:438`） |
| A4 | **后继播种漏斗** | `InternalizationOrchestrator.commitNextTaskProposal` | `internalization-orchestrator.ts:413` | 全链唯一 `createTask` 后继出口 | ✅ 3 个生产调用点收敛于此（见 §4.2） |
| A5 | **channel 路由映射** | `CANDIDATE_KIND_TO_ROUTE` + `ROUTE_CHANNEL_MAP` + `MVP_ENABLED_CHANNELS` | `intake-to-internalization-bridge.ts:114,122,108` | recommendationKind → route → channel；MVP 通道准入 | ✅ 经 `computeBridgeDecision` |
| A6 | **channel 准入 demotion** | `hasRuleMechanicalEvidence` + `computeBridgeDecision` demotion 分支 | 同文件 `:104,167-169` | rule 候选缺机械证据 → 降级 prompt（C6） | ✅ 单点收敛，所有入口共用 |
| （旁路权威） | **诊断阶段 taskKind** | `diagnostician` | `pain-signal-bridge.ts:411,425` 等 | 非 `RunnerKind`，不在任何边集内 | N/A（故意游离） |

**关键结构事实（NEW）**：`INTERNAL_AGENT_NAMES`（`pd-config-types.ts:115-126`，10 项）
**不是**拓扑权威。它与 `PeerRunnerKind`（6 项，`peer-runner-contracts.ts:54-60`）是两套独立清单，
交集为 `{dreamer, philosopher, scribe, artificer, evaluator, rollout_reviewer}`，
差集为 `{diagnostician, correctionObserver, empathyObserver, signalCollector}`（有 agent 绑定、无图节点）。
两清单之间**无编译期联动**（`INTERNAL_AGENT_NAMES` 无 `satisfies`/constraint 约束到 `PeerRunnerKind`）。

---

## 4. Contract Map

### 4.1 A1 — Current topology map（仅画代码可证的边）

#### 4.1.1 上游：Pain → 候选（非 peer-runner 图）

```
Pain 信号
  └─(A6 无涉)─→ 诊断父任务 taskKind='diagnostician'  [不在 RunnerKind 内]
        └─ SplitDiagnosticianRunner.ensureSubTask（split-diagnostician-runner.ts:283）
              ├─ diag_rootcause ──┐
              ├─ diag_distiller ──┤ DIAGNOSTICIAN_EDGES (A2)
              └─ diag_router ─────┘   [terminal，无后继 → proposeNextTask 返回 null]
        └─ 完成回调：PainSignalBridge.onDiagnosisComplete（pain-signal-bridge.ts:712）
              ├─ evaluateCandidateAdmissions（admission-gate.ts）
              ├─ intakeService.intake → ledger
              └─ dreamer 种子（见 4.1.2）
```

`diag_*` 与 `peer-runner` 之间的跨管线边在 `validateInternalizationGraph` 中被判为非法
（`internalization-state-machine.ts:441-444`，`edgeValid = false`）——但该函数**无生产调用方**（§7 G-01）。

#### 4.1.2 中游：候选 → dreamer seed（4 条入口，1 个权威决策）

```
候选（recommendationKind ∈ {principle, rule, implementation, prompt, defer}）
  └─ CANDIDATE_KIND_TO_ROUTE (A5) → route
        └─ ROUTE_CHANNEL_MAP (A5) → channel
              ├─ principle-ledger          → prompt
              ├─ rule-candidate            → code_tool_hook ─(A6 无机械证据)→ prompt  ← demotion
              ├─ implementation-candidate  → skill          ← MVP_DISABLED（见 §5 R-15）
              └─ prompt-injection-candidate→ prompt
        └─ computeBridgeDecision（intake-to-internalization-bridge.ts:130）
              ├─ not_internalizable：route 无 channel / channel ∉ MVP_ENABLED_CHANNELS / !ready / deferred
              └─ seeded：taskId = `dreamer-${candidateId}-${effectiveChannel}`
```

seed 入口（全部经 `buildDreamerSeedFromCandidate`，故 A5+A6 一致）：

| 入口 | 位置 | pipelineMode 来源 |
|---|---|---|
| 自动：PainSignalBridge.onDiagnosisComplete | `pain-signal-bridge.ts:779-790` | `fullPipelinePromptSeeds ? 'full_chain' : undefined` → 落库为 `standard` |
| CLI：`pd candidate internalize` | `commands/candidate.ts:361` | `resolvePromptFullPipelineSeedMode` |
| CLI：`pd candidate backfill` | `commands/candidate.ts:998,1089` | 同上 |
| CLI：`pd diagnose --intake` | `commands/diagnose.ts:617` | 同上（另有 `:604` 硬跳过 `implementation`） |

`resolvePromptFullPipelineSeedMode`（`pd-config-loader.ts:258`）：`prompt_full_pipeline` flag ON → `'full_chain'`，否则 `undefined`。
`buildDreamerTaskSeed`（`intake-to-internalization-bridge.ts:235`）**总是**写出 `standard` 或 `full_chain`，
故"字段缺失"**只可能**来自 pre-PRI-720 历史记录——AC12 语义成立。

#### 4.1.3 下游：dreamer 之后的 peer-runner 边（A1 边集的真实消费面）

`resolveChannelEdges(channel, pipelineMode)`（`internalization-job-graph.ts:84`）：

```
pipelineMode === 'standard' 且 channel ∈ {prompt, defer_archive}:
    dreamer → philosopher → scribe → rollout_reviewer          (PRINCIPLE_SEMANTIC_EDGES, 3 边)
    ✗ artificer / evaluator 永不创建

pipelineMode === 'standard' 且 channel ∈ {code_tool_hook, skill}:
    dreamer → philosopher → scribe → artificer → evaluator → rollout_reviewer  (ALLOWED_EDGES, 5 边)

pipelineMode === 'full_chain' 或 字段缺失 或 channel 缺失:
    ALLOWED_EDGES（5 边，全图）
```

`rollout_reviewer` **在任何模式下都是终节点**（无出边）；其 `approve_rollout` 的语义出口是
activation dispatch，不是图边（`internalization-transition-decision.ts:116-119`）。

#### 4.1.4 rollout_reviewer 的语义分叉（DRIFTED vs 设计图）

`resolveRolloutReviewMode`（`rollout-reviewer-runner.ts:168-187`，非边而是**契约模式**）：

```
pipelineMode === 'full_chain'                        → code_chain
channel ∉ {prompt, defer_archive}                    → code_chain
channel ∈ {prompt, defer_archive} 且 dep 无 evaluator 且 dep 有 scribe → principle_semantic
否则（legacy prompt 链带 evaluator dep）              → code_chain   ← AC12 保护
```

**关键结构性事实**：该判定**不读** `pipelineMode: 'standard'`，而是**从依赖结构反推**
（"无 evaluator dep + 有 scribe dep"）。这是第二条独立于 `CHANNEL_EDGES` 的拓扑推断路径（§7 G-02）。

### 4.2 A2 — 边权威表

| edge | authority symbol | producer | consumer | runtime guard | test coverage |
|---|---|---|---|---|---|
| `diagnostician` → `diag_rootcause` | `SplitDiagnosticianRunner.ensureSubTask`（硬编码，非边集） | `split-diagnostician-runner.ts:283` | diag runner dispatch | ✗ 无 `validateEdge` 检查 | `__tests__/*diagnostician*` |
| `diag_rootcause → diag_distiller` | `DIAGNOSTICIAN_EDGES` | `internalization-job-graph.ts:101` | `getDiagSuccessors` → `orchestrator.proposeNextTask:356` | ✅ 该分支消费 | `internalization-state-machine.test.ts:538+` |
| `diag_distiller → diag_router` | 同上 | 同上 | 同上 | ✅ | 同上 |
| `diag_router` → ∅（终节点） | `getDiagSuccessors` 返回 `[]` | `internalization-job-graph.ts:151` | `proposeNextTask:357-360` 返回 null | ✅ | 同上 |
| 候选 → `dreamer` | `computeBridgeDecision`（A5/A6） | `intake-to-internalization-bridge.ts:130` | `buildDreamerTaskSeed` 4 入口 | ✅ `MVP_ENABLED_CHANNELS` | `intake-bridge-channel-admission.test.ts` |
| `dreamer → philosopher` | `CHANNEL_EDGES`/`ALLOWED_EDGES` | `internalization-job-graph.ts:35,52,63` | `getAllowedSuccessors` → `createNextTaskProposal` | ✅ | `c2-live-runner-chain.test.ts:439-500` |
| `philosopher → scribe` | 同上 | 同上 | 同上 | ✅ | 同上 |
| `scribe → artificer` | 同上（**仅** full_chain / code_tool_hook / skill） | 同上 | 同上 | ✅ | 同上 |
| `artificer → evaluator` | 同上（同上条件） | 同上 | 同上 | ✅ | 同上 |
| `evaluator → rollout_reviewer` | 同上（同上条件） | 同上 | 同上 | ✅ | 同上 |
| `scribe → rollout_reviewer` | 同上（**仅** prompt / defer_archive + standard） | 同上 | 同上 | ✅ | 同上 |
| `artificer-repair → reopen evaluator` | `buildRepairRevisionCauseId` + `resolveEffectiveRunnerDecision` | `internalization-transition-decision.ts:86-88` | `commitNextTaskProposal:REOPEN_SOURCE_EVALUATOR` | ✅ causeId materialize 前置检查 | `internalization/__tests__/a-liveness-reconciliation.test.ts` |
| `rollout needs_revision → scribe/artificer reopen` | `resolveRolloutRevisionTarget` | `revision-reopen.ts:131` | `rollout-reviewer-runner.ts:952` | ✅ causeId 检查 `:984-985` | `rollout-reviewer-principle-semantic.test.ts` |
| `succeeded successor 级联 reopen` | `cascade-${taskId}-rcN-${succId}` | `internalization-orchestrator.ts:600` | 同函数 `:606` | ✅ causeId 前置 `:605` | `internalization/__tests__/a-liveness-reconciliation.test.ts` |
| `rollout approve_rollout → activation` | `dispatchActivation`（**非图边**） | `internalization-consumer-governance.ts:73` | `ActivationDispatcher.dispatch` | ⚠ 由 runner 注入检查（未注入 → NHR） | `rollout-reviewer` 测试 |

### 4.3 A3 — Bypass search

#### (a) runner 侧手工 nextTask 式 successor 指定

**未发现。** 6 个 peer runner 文件（`dreamer/philosopher/scribe/artificer/evaluator/rollout-reviewer-runner.ts`）
对 `createTask` 的 grep 结果为**零命中**。`architecture-regression.test.ts` 有逐文件护栏
（`CORE_NO_FORBIDDEN_IMPORTS` 断言各 runner 源文本 `not.toContain('createTask')`，见 `:1767, 2107, 2198, 2266`）。

#### (b) switch/case 自造 successor

`internalization-orchestrator.ts:355-374`（`proposeNextTask`）按 `isDiagnosticianStageKind` 分支：
诊断链走 `getDiagSuccessors`，peer 链走 `createNextTaskProposal`。**两条腿都来自 SSOT**，无自造。
`internalization-consumer-cycle.ts:594+` 的 `switch (taskKind)` 只**构造 runner**，不构造 successor。

#### (c) recovery / reopen 是否绕过 `CHANNEL_EDGES`

**不绕过，但存在绕过 `validateEdge` 的独立 createTask 出口（NEW）。**

全仓 `createTask` 生产调用点共 17 处（已排除 store 层实现 `runtime-state-manager.ts` / `task-store.ts`）。
按"是否创建 **peer-runner** 任务"归类：

| 类别 | 出口 | 位置 | 是否经 A4 漏斗 | 边集合法性 |
|---|---|---|---|---|
| peer-runner（后继） | `commitNextTaskProposal` | `internalization-orchestrator.ts:687` | ✅ 是（权威） | `resolveChannelEdges` 决定 |
| peer-runner（repair） | `seedArtificerRepairTask`（生产接线） | `internalization-consumer-governance.ts:187` | ✗ **否** | 硬编码 `taskKind:'artificer'`，依赖 `evaluator → artificer` 的**隐式**合法性 |
| peer-runner（repair） | `seedArtificerRepairTask`（CLI 版） | `rulehost-pipeline-runner.ts:729` | ✗ **否** | 同上 |
| peer-runner（对抗） | `runAdversarialLoop` artificer / evaluator | `adversarial-loop.ts:89, 218` | ✗ **否** | 硬编码 artificer→evaluator；仅 CLI `run-rulehost` 使用 |
| peer-runner（管线） | `createInternalizationTask` | `rulehost-pipeline-runner.ts:620` | ✗ **否** | 依赖调用方传入的 dependencyTaskIds |
| peer-runner（seed） | `intake-to-internalization-bridge.ts:365` `seedIntakeTask`；`candidate.ts:436/1039/1142`；`diagnose.ts:624`；`pain-signal-bridge.ts:797` | 6 处 | ✗ **否**（但全部经 A5/A6 `computeBridgeDecision`） | ✅ 经 `MVP_ENABLED_CHANNELS` |
| 非 peer（诊断） | `pain-signal-bridge.ts:422/449/511`；`split-diagnostician-runner.ts:283` | 4 处 | ✗ **否** | `diagnostician`/`diag_*` 不在边集内（结构性豁免） |
| 非 peer（基准） | `synthetic-baseline-runner.ts:306` | 1 处 | ✗ **否** | CLI 合成基准，非管道 |

即：**创建 peer-runner 任务的出口共 5 个**（1 个权威 + 4 个绕过边集：repair×2、对抗×1、rulehost 管线×1），
另有 6 个 seed 出口（经 A5/A6 收敛）与 5 个非 peer 出口。

`reopenTaskForRevision`（`revision-reopen.ts`）**不创建任务**，只改状态，故不构成边。

**判定**：A4 是**后继（successor）**的唯一漏斗，但**不是新任务创建的唯一漏斗**。
repair 任务与对抗循环任务的创建完全在 A4 之外、`CHANNEL_EDGES` 校验之外（§6 NEW-01）。

#### (d) 老 task 缺 `pipelineMode` 字段的重解释路径

`resolveChannelEdges`（`internalization-job-graph.ts:88-90`）：

```ts
if (pipelineMode !== 'standard') { return ALLOWED_EDGES; }
```

即**缺失即全图**。三个消费点一致：`createNextTaskProposal` 传 `currentTask.pipelineMode`
（`internalization-state-machine.ts:361`），继承给后继（`:382`）——链一旦 seed 为 `standard`，
后继**不会**在 flag 翻转时改道。

`isValidPITaskRecord`（`peer-runner-contracts.ts:318-320`）对缺失/`undefined` 的 `pipelineMode` 放行，
但对**存在且非法**的值拒绝（`isPipelineTopologyMode`）。→ **AC12 CONFIRMED**。

#### (e) seed/resume 路径能否造出 DAG 之外的合法任务

- **seed**：所有 dreamer seed 经 A5/A6，且 MVP 通道仅 3 个。**不能**。
- **resume**：`wakeOnce`（`internalization-orchestrator.ts:207`）用 `isRunnerKind` 过滤，
  命中 `pending`/`retry_wait` 的任意 taskKind。**它不校验该任务的入边是否合法**——
  即一条历史脏数据（例如 `skill` channel 的 dreamer 任务，或 `prompt` channel 却带 artificer 依赖的链）
  会被正常 lease 并执行。**通过 resume 可以继续运行一条违反当前 `CHANNEL_EDGES` 的链**（§6 NEW-02）。

### 4.4 A4 — Is `CHANNEL_EDGES` really the SSOT?

**判定：PARTIAL**

**证据链**

*支持 YES 的部分*

1. `CHANNEL_EDGES` 是 peer-runner 边集的**唯一定义**：`ALLOWED_EDGES`、`PRINCIPLE_SEMANTIC_EDGES`
   只在该文件内声明，全仓 grep 无第二份（`internalization-job-graph.ts:35,52,63`）。
2. 所有**后继播种**收敛于 `createNextTaskProposal` → `getAllowedSuccessors` → `resolveChannelEdges`
   （`internalization-state-machine.ts:365`），消费点唯一（`internalization-orchestrator.ts:383`）。
3. `pipelineMode` 语义（standard / full_chain / 缺失）在 3 处文档注释与 1 处 type 定义
   （`peer-runner-contracts.ts:33-48`）中一致，且被 `c2-live-runner-chain.test.ts:439-500` 逐项覆盖。

*否定"完整 SSOT"的部分*

4. **`validateEdge` / `validateInternalizationGraph` 零生产调用方。** 全仓 grep：
   仅 `internalization-state-machine.ts` 内部使用，且 `validateInternalizationGraph` 的调用点
   **只有测试**。→ 边集的"运行时不变量"事实上**不存在**；`CHANNEL_EDGES` 只在**正向选择**时被读，
   从不在**反向校验**时被读（§6 NEW-03）。
5. **4 个创建 peer-runner 任务的出口绕过边集**（见 4.3c）：repair（2 处）、对抗循环（1 处）、
   rulehost 管线（1 处）。它们的 taskKind 硬编码，不查询 `CHANNEL_EDGES`。
6. **第二条拓扑推断路径**：`resolveRolloutReviewMode` 从 dep 结构反推契约模式，
   不读 `pipelineMode: 'standard'`。若一条链的依赖被改写（如 `replaceArtificerDependencyWith`），
   评审模式可能与其 `CHANNEL_EDGES` 通道语义不一致。
7. **`skill` channel 在 `CHANNEL_EDGES` 有定义**（= `ALLOWED_EDGES`）却在
   `MVP_ENABLED_CHANNELS` 中**不存在**——边集与准入集**范围不一致**，
   同一 channel 一个"允许"一个"禁止"（`internalization-job-graph.ts:69` vs `intake-to-internalization-bridge.ts:108`）。

**结论**：`CHANNEL_EDGES` 是**后继选择**的 SSOT（YES），但**不是编排拓扑的 SSOT**（NO）。
它不覆盖任务创建的全集，不被运行时校验，且与准入集存在范围分裂。

---

## 5. Confirmed / Fixed / Drifted

### 5.1 R-14（P2）：route→ready 双实现 + kind→channel 映射表两份

**判定：CONFIRMED**

| 断言 | current-main 证据 | 结论 |
|---|---|---|
| 纯决策函数（含 `missingFields`）只被 CLI 手动路径消费 | `decideInternalizationRoute`（`internalization-route.ts:52`）的生产调用点：`commands/candidate.ts:336,988,1079,1229`（4 处）— 全在 CLI；`commands/diagnose.ts` 不调用它 | ✅ CONFIRMED |
| 自动路径 `ready = !!channel` 短路 | `pain-signal-bridge.ts:778`：`const ready = !!channel;` 紧邻注释自认"`ready` reflects only whether the route maps to a channel" | ✅ CONFIRMED |
| kind→channel 映射表两份 | `KIND_ROUTE_MAP`（`internalization-route.ts:43-48`，模块私有）与 `CANDIDATE_KIND_TO_ROUTE`（`intake-to-internalization-bridge.ts:114`，导出）；内容等价（5 项相同），**无编译期联动** | ✅ CONFIRMED |

**补充（NEW，R-14 未覆盖）**：两份表并非唯一的分裂面——
`pain-signal-bridge.ts:772-778` 与 `diagnose.ts:608-611` 各自**重复**了
`CANDIDATE_KIND_TO_ROUTE[route] → ROUTE_CHANNEL_MAP` 的两跳查找代码，共 3 份等价逻辑。

**补充（NEW）**：`ready` 语义在第三处被再次重复/加严：
`diagnose.ts:611` 用 `ready = !!channel && MVP_ENABLED_CHANNELS.has(channel)`，
与 `pain-signal-bridge.ts:778` 的 `ready = !!channel` **不同**。
因此同一 `implementation` 候选在 `pd diagnose` 路径下 `ready=false`（走 route 层拦截），
在 auto 路径下 `ready=true`（走 `computeBridgeDecision` 的 MVP 拦截）——**拒绝理由文本不同但结果同为 not_internalizable**。
这是 3 份 `ready` 判定实现。

`computeBridgeDecision` 的 demotion 前置（`:167-173`）确实使 A6 在两条路径上收敛，
R-14 的"两路径命运不同"在 **channel 结果**上已被 PRI-720 C6 收敛（PARTIAL 收敛），
但**判定实现仍是多份**。

### 5.2 R-15（P3，待复审）：implementation → skill → 必然 not_internalizable

**判定：CONFIRMED（部分环节已演化，但结论方向不变）**

- `ROUTE_CHANNEL_MAP['implementation-candidate'] = 'skill'`（`intake-to-internalization-bridge.ts:125`）✅
- `MVP_ENABLED_CHANNELS = {prompt, code_tool_hook, defer_archive}`（`:108-112`），**不含 `skill`** ✅
- → `computeBridgeDecision` 在 `:151-153` 返回 `not_internalizable`，reason 明确含 `MVP-disabled` ✅
- **可见性**：`pain-signal-bridge.ts:823-825` 记入 `notInternalizable` + 发 `candidate_not_internalizable` telemetry（`rc-9` 成立，非静默）✅

**#1698 后的演化（当前 main 已含 PRI-720）**：
`implementation` 候选的生产可见性**已减少**——`commands/diagnose.ts:604` 显式 `continue` 跳过
`kind === 'implementation'` 的 seed 循环（该行是 PRI-720 同期引入）。但 `pain-signal-bridge.ts`
**没有**同等跳过，故自动路径仍会产出 `not_internalizable`。

**新增证据**：`skill` channel **仍在 `CHANNEL_EDGES` 中有效**（`internalization-job-graph.ts:69`），
且 `AUTO_PROMOTABLE_CHANNELS = ['skill']`（`activation/activation-types.ts:17`）、
`activation` 风险表中 `skill` = `medium`（`commands/runtime-activation.ts:289`）。
即 `skill` 是"图与治理都承认、但准入集禁止"的**半退役通道**——这是 R-15 的根因面，且比 R-15 描述更宽
（不只 implementation 路由此，`skill` 的整条治理面都处于"代码在、入口封"的状态）。

**判定归因**：R-15 是**产品边界决策**而非缺陷（原报告亦如此定性）。Worker A 只登记事实，不裁决。

### 5.3 R-25（P2）：管道入口 / gate 全景遗漏

**判定：PARTIAL**

**断言 (1)：`codex_conversation_ingestion` 未入入口清单**

- 在 `REPORT.md §2` 的 11 个入口清单中**确实未出现**（入口 6 只标了 `host.codex`）。
- current-main 证据：该 flag 是 Codex 摄取路径的**独立前置门**，
  且**不受** `internalization_auto_consumer` 控制：
  `workspace-worker.ts:164`（catch-up）在 consumer flag 检查**之前**执行，
  源码注释明写"gated by the ingestion flag, NOT by the consumer flag"。
  `pd-hook.ts:156` 同样双门。→ 断言成立：**入口清单缺一个独立门**。
- **但**：`docs/architecture/PRI-751-feature-flag-reality-matrix.md:71` **已收录**该 flag 及其消费者。
  → 所以"遗漏"只存在于 `REPORT.md §2` 该入口清单，不是全仓文档缺失。

**断言 (2)：`signal_collector` / `codex_conversation_ingestion` 两 flag 未入 gate 全景表**

- `PRI-751` matrix `:71` 收 `codex_conversation_ingestion`，`:73` 收 `signal_collector`。
- `REPORT.md §2` 无独立 "gate 全景表"章节。→ **PARTIAL**：取决于"gate 全景表"指哪份文档。
  若指 `REPORT.md §2`，两项确实缺席；若指 `PRI-751` matrix，两项均在。

**判定理由**：R-25 描述的是一个**特定文档面的省略**，在 current main 上该省略**部分存在**
（`REPORT.md` 入口清单仍缺），但**另一份权威文档已覆盖**。属文档选面问题，非代码事实变更。

### 5.4 #1707 §2 关键结论的 current-main 裁决

`REPORT.md` 基线 `70d824c4`（PRI-720 之前）。

| #1707 §2 关键结论 | current-main 裁决 | 证据 |
|---|---|---|
| "后继播种唯一漏斗 = `commitNextTaskProposal`" | **CONFIRMED** | 3 个调用点（`internalization-consumer-cycle.ts:721`、`runtime-internalization-run-once.ts:735`、`runtime-internalization-enqueue-successors.ts:478`）全部指向它 |
| "`validateEdge` 已无 channel 特例" | **DRIFTED** | PRI-720 重新引入 channel 特例，但搬到 `resolveChannelEdges`（`internalization-job-graph.ts:84`）；`validateEdge` 变成薄委托（`:130`） |
| "任务图（权威）：`ALLOWED_EDGES` 线性链" | **DRIFTED** | 已变为 `CHANNEL_EDGES` 的 channel 分片；`ALLOWED_EDGES` 退化为 full_chain/legacy 分支 |
| "稳定后继 ID：`{kind}-{correlationId}-{channel}`" | **CONFIRMED** | `internalization-orchestrator.ts:571-588` |
| "`wakeOnce` 只扫 pending 与 retry_wait" | **CONFIRMED** | `internalization-orchestrator.ts:207`（`wakeOnce`）→ `:965-985`（`findCandidates`） |
| "`leased` 任务对入口 7/8 不可见，唯一出路 recovery sweep" | **CONFIRMED** | `internalization-consumer-cycle.ts:736-745` 的 `safeRunRecoverySweep`（finally 恒执行） |
| "Console 无任何推进管道端点" | **CONFIRMED** | 未发现新增 route |
| "A: succeeded-transition reconciliation 每周期 bounded budget=5" | **CONFIRMED** | `internalization-consumer-cycle.ts:194` `RECONCILIATION_BUDGET = 5` |
| "诊断父任务 taskKind=`diagnostician` 不属于 RunnerKind，wakeOnce 永远不捡" | **CONFIRMED** | `peer-runner-contracts.ts:54-78`（`RunnerKind` 联合无 `diagnostician`）；`isRunnerKind` 过滤 |
| "run-once 不做 recovery sweep/reconciliation" | **CONFIRMED** | `runtime-internalization-run-once.ts` 无 `runRecoverySweep` / `reconcileSucceededTransitions` 调用 |

---

## 6. NEW Findings

### NEW-01 — repair / 对抗循环任务创建完全绕过边集与漏斗

- **Severity：P2**（不构成 Owner gate 绕过，但使 `CHANNEL_EDGES` 的"SSOT"地位在事实上被削弱）
- **Claim**：`artificer` repair 任务与 `runAdversarialLoop` 的 artificer/evaluator 任务
  经独立 `createTask` 出口创建，不查询 `CHANNEL_EDGES`，不校验 `evaluator → artificer` 边。
- **Evidence**：
  - `internalization-consumer-governance.ts:187`（生产 consumer 接线）
  - `rulehost-pipeline-runner.ts:729`（CLI 接线）
  - `adversarial-loop.ts:89`（artificer）、`:218`（evaluator）
  - 对照：权威漏斗 `internalization-orchestrator.ts:687` 经 `createNextTaskProposal`
- **Why it matters**：边集被读作 SSOT 时，读者会假设"所有任务都在图内"。
  实际上 repair 任务的合法性由 `EvaluatorRunner` 的**内部逻辑**（`artificerRepairTaskId` 确定性 ID）
  保证，而非由图保证。若未来 channel 语义变化（例如 prompt 链禁 artificer），
  该出口不会随之收紧。
- **Affected stage**：evaluator needs_revision → artificer repair 环；CLI `run-rulehost` 对抗循环
- **Current protection**：无编译期或运行时守卫。`evaluator-repair-loop.test.ts` 覆盖行为不覆盖图合法性。

### NEW-02 — `wakeOnce` 不校验入边合法性，可继续执行违反当前边集的历史链

- **Severity：P2**
- **Claim**：`wakeOnce` 以 `pending`/`retry_wait` 状态 + `isRunnerKind` 过滤候选，
  **不检查**该任务的 `channel` / `pipelineMode` 与当前 `CHANNEL_EDGES` 的一致性。
- **Evidence**：`internalization-orchestrator.ts:207` `wakeOnce` → `:965-985` `findCandidates` 过滤逻辑；
  `validateInternalizationTaskReady`（`internalization-state-machine.ts:146`）只校验
  状态可 lease 与依赖已 succeeded，不校验边。
- **Why it matters**：AC12（"不中途重解释 legacy 链"）在**正向**被正确实现，
  但在**恢复**侧成为无条件的：一条按当前契约本不该存在的链（例如 pre-PRI-720 的
  `prompt` channel 全链）会被正常推进到 rollout，且 `resolveRolloutReviewMode` 会因其有 evaluator dep
  回落到 `code_chain`。这是**有意的 AC12 行为**，但意味着"当前 DAG"与"在跑 DAG"可长期分叉，
  而没有任何 reconciler 或读数报告该分叉。
- **Affected stage**：恢复 / 推进（wakeOnce）
- **Current protection**：`internalization-chain-integrity-read-model.ts` 读模型存在，
  但其检查项是 lineage 断裂（parentTaskId/artifactId），**不含**边集一致性。

### NEW-03 — `validateEdge` / `validateInternalizationGraph` 无生产调用方（图谱不变量未强制）

- **Severity：P2**（严重度不升级为 P1：无证据表明该缺失已导致数据损坏或 gate 绕过）
- **Claim**：`validateEdge` 仅被 `validateInternalizationGraph` 调用；
  `validateInternalizationGraph` 的调用方**仅有测试**。故"所有边 ∈ 当前合法边集"这一不变量
  在运行时**从不被检查**。
- **Evidence**：
  - 全仓 `grep -rn "validateInternalizationGraph"` → 唯一非测试命中是定义处
    `internalization-state-machine.ts:398`
  - `architecture-regression.test.ts:1637` 只断言 `index.ts` 的**字符串导出**，不校验调用
  - `validateEdge` 生产消费：零（`internalization-job-graph.ts:130` 定义；`internalization-state-machine.ts:440` 使用；无外部）
- **Why it matters**：`CHANNEL_EDGES` 的权威性目前**只靠正向选择**（`getAllowedSuccessors`）
  与测试文件维持。任何绕过 A4 的 createTask 出口（NEW-01）或 resume 路径（NEW-02）
  产生的不合法边**不会**被任何生产代码发现。这是 `docs/architecture/PD_CORE_VALUE_PIPELINE_CONTRACT.md`
  与 `check:pipeline-contract` guard 设计时必须回答的缺口。
- **Affected stage**：全链（图不变量层）
- **Current protection**：仅测试（`internalization-state-machine.test.ts:538+`）

### NEW-04 — `skill` channel：图内有效、准入集禁止、治理面仍活跃

- **Severity：P3**（latent debt；R-15 的根因面）
- **Claim**：`skill` 在 4 个面处于不一致状态：
  1. `CHANNEL_EDGES.skill = ALLOWED_EDGES`（图内有效，`internalization-job-graph.ts:69`）
  2. `MVP_ENABLED_CHANNELS` **不含** `skill`（准入禁止，`intake-to-internalization-bridge.ts:108`）
  3. `AUTO_PROMOTABLE_CHANNELS = ['skill']`（自动晋升面承认，`activation-types.ts:17`）
  4. `runtime-activation.ts:289` 风险分级 `skill → medium`（治理面承认）
- **Evidence**：上述 4 处
- **Why it matters**：任何以 `CHANNEL_EDGES` 推断"可达 channel"的 guard 会把 `skill`
  读作可达，而实际 100% 不可达。契约文档需显式区分"拓扑可达"与"准入可达"。
- **Affected stage**：seed 准入 / 契约 guard 设计
- **Current protection**：`computeBridgeDecision` 的 MVP 检查是唯一实际拦截点。

### NEW-05 — `ready` 判定存在 3 份实现（R-14 的扩散面）

- **Severity：P2**
- **Claim**：`ready` 语义在 3 处独立实现且**不一致**：
  - `internalization-route.ts:52` `decideInternalizationRoute`：含 `missingFields` 语义检查
  - `pain-signal-bridge.ts:778`：`const ready = !!channel;`
  - `commands/diagnose.ts:611`：`const ready = !!channel && MVP_ENABLED_CHANNELS.has(channel);`
- **Evidence**：上述 3 行
- **Why it matters**：`ready` 是 `computeBridgeDecision` 的**输入**，其语义由调用方决定。
  三份实现的存在意味着"candidate 是否 ready"没有单一答案；只有 `computeBridgeDecision` 的
  demotion 前置（`:167`）使最终 channel 结果收敛。
- **Affected stage**：seed 准入
- **Current protection**：`intake-bridge-channel-admission.test.ts` 覆盖 bridge 层，不覆盖上游 3 份 `ready`

### NEW-06 — 诊断子任务与 peer-runner 之间无跨管线边守卫

- **Severity：P3**
- **Claim**：`diagnostician` 父任务**不在** `RunnerKind` 内（`peer-runner-contracts.ts:54-78`），
  其子任务经 `SplitDiagnosticianRunner.ensureSubTask` 直接创建。
  跨管线边（diag_* → peer-runner）在 `validateInternalizationGraph:441-444` 中被判非法，
  但该函数无生产调用（NEW-03），故该禁令**无运行时效力**。
- **Evidence**：`split-diagnostician-runner.ts:283`；`internalization-state-machine.ts:441-444`
- **Why it matters**：若 seed 逻辑把 `diag_router` 作为 dreamer 的 `dependencyTaskIds`（当前**未**发生），
  依赖门会因 `dep.status === 'succeeded'` 放行，边合法性无人检查。
- **Affected stage**：诊断 → 内化交界
- **Current protection**：`intake-to-internalization-bridge.ts:224-228` 确实把 `sourceTaskId`
  （= diagnostician taskId）写入 `dependencyTaskIds`——**但那是父任务**（`diagnostician`），
  也不是 `RunnerKind`。该边**不在任何边集内**，属结构性豁免。

---

## 7. Protection Gaps

| Gap | 保护现状 | 缺口 |
|---|---|---|
| G-01 边集不变量 | `validateEdge` / `validateInternalizationGraph` 存在但零生产调用 | 运行时无人检查"所有边 ∈ 当前 `CHANNEL_EDGES`"。仅测试保护 |
| G-02 拓扑模式判定 | `resolveRolloutReviewMode` 从依赖结构反推，不读 `pipelineMode: 'standard'` | 两条独立路径推断同一事实（`CHANNEL_EDGES` vs dep 结构）；无交叉校验 |
| G-03 任务创建出口 | 后继唯一（A4）；**peer-runner 任务创建 5 个出口（4 个绕过边集）** | 无 guard 覆盖 repair/对抗/rulehost 出口的图合法性 |
| G-04 `ready` 语义 | `computeBridgeDecision` 是最终收敛点 | 3 份上游 `ready` 实现无一致性测试 |
| G-05 channel 可达性 | `MVP_ENABLED_CHANNELS` 是实际拦截 | `CHANNEL_EDGES` 含 `skill`，与准入集范围不一致；无 guard 断言两者关系 |
| G-06 在跑 DAG vs 当前 DAG | `internalization-chain-integrity-read-model.ts` 只查 lineage 断裂 | 无读模型 / reconciler 报告"边集 vs `pipelineMode`"分叉 |
| G-07 测试覆盖面 | `c2-live-runner-chain.test.ts:439-500` 逐项覆盖 `resolveChannelEdges` 的三态分支 | 覆盖的是**纯函数**；无端到端测试断言"生产 createTask 出口的边全部来自 SSOT" |

---

## 8. Suggested Contract Invariants

> 仅列出应被 `PD_CORE_VALUE_PIPELINE_CONTRACT.md` 与 `check:pipeline-contract` 断言的
> **不变量**。不含修复方案。

- **INV-T1**：任一 peer-runner 任务的 `(taskKind, dependencyTaskKind)` 二元组，
  必须属于 `resolveChannelEdges(task.channel, task.pipelineMode)` 的闭包。
- **INV-T2**：`pipelineMode` 字段在新写入的记录上**必须存在**且 ∈ `PIPELINE_TOPOLOGY_MODES`；
  缺失仅允许出现于记录 `createdAt` 早于 PRI-720 生效点的行。
- **INV-T3**：一条链内所有任务的 `pipelineMode` 相等（`pipelineMode` 是链属性，非跳属性）。
- **INV-T4**：`task.channel` ∈ `MVP_ENABLED_CHANNELS` 是任务可被 `wakeOnce` lease 的必要条件
  （或：`CHANNEL_EDGES` 的键集与 `MVP_ENABLED_CHANNELS` 的关系须被显式声明为
  "拓扑可达 ⊋ 准入可达"）。
- **INV-T5**：任何创建 peer-runner 任务的代码路径，其 `taskKind` 必须可由边集推导，
  不得硬编码（当前 4 个出口违反）。
- **INV-T6**：`diagnostician`/`diag_*` 与 peer-runner 之间不存在依赖边；
  跨管线依赖须被显式豁免并登记。
- **INV-T7**：`rollout_reviewer` 在所有 `channel × pipelineMode` 组合下**无出边**；
  其正向语义出口（activation dispatch / revision reopen）不构成图边。
- **INV-T8**：`ready` 语义在任一 seed 入口上只能有一个求值点（当前 3 份）。

---

## 9. Out of Scope

明确不做（本 Worker 范围外）：

1. 不修任何代码，不改 `packages/**`、不改 config、不改 Linear。
2. 不做架构设计、不提修复方案、不评优先级排序以外的工程判断。
3. 不评估提示词质量、不评估 schema↔prompt 一致性（属审查族其他 Worker）。
4. 不启动 `~/.pd/runtime/` 或 workspace 的运行时验证（零密钥 + 只读纪律）。
5. 不重做 #1707 / #1710 的全量事实审计；仅对 §5 carry-forward 项与 §2 关键结论回源。
6. 不裁决 R-15 的产品边界问题（属 Owner 决策）。
7. 不评估 `docs/architecture/PD_CORE_VALUE_PIPELINE_CONTRACT.md` 的文档结构（该文件当前**尚不存在**，
   全仓 `find` 无命中——契约文档为本 Phase 的**产出目标**，非既有输入）。

---

## 附：证据索引（关键行号汇总）

| 事实 | file:line |
|---|---|
| `ALLOWED_EDGES`（5 边线性图） | `packages/principles-core/src/runtime-v2/internalization/internalization-job-graph.ts:35-41` |
| `PRINCIPLE_SEMANTIC_EDGES`（3 边） | 同文件 `:52-56` |
| `CHANNEL_EDGES`（4 channel） | 同文件 `:63-70` |
| `resolveChannelEdges` | 同文件 `:84-94` |
| `DIAGNOSTICIAN_EDGES` | 同文件 `:101-104` |
| `validateEdge` | 同文件 `:130-136` |
| `getAllowedSuccessors` | 同文件 `:244-256` |
| `getDiagSuccessors` 消费 | `internalization-orchestrator.ts:355-374` |
| `commitNextTaskProposal`（唯一后继漏斗） | `internalization-orchestrator.ts:413` |
| 唯一 createTask（后继） | `internalization-orchestrator.ts:687` |
| `createNextTaskProposal` | `internalization-state-machine.ts:338-383` |
| `validateInternalizationGraph`（无生产调用） | `internalization-state-machine.ts:398` |
| `decideInternalizationTransition` | `internalization-transition-decision.ts:73` |
| `MVP_ENABLED_CHANNELS` | `intake-to-internalization-bridge.ts:108-112` |
| `ROUTE_CHANNEL_MAP` | 同文件 `:122-127` |
| C6 demotion | 同文件 `:167-173` |
| seed 写 `pipelineMode` | 同文件 `:255-261` |
| `ready = !!channel`（auto 路径） | `pain-signal-bridge.ts:778` |
| `ready = !!channel && MVP...`（CLI） | `commands/diagnose.ts:611` |
| `KIND_ROUTE_MAP`（私有第二份） | `internalization-route.ts:43-48` |
| `INTERNAL_AGENT_NAMES`（10 项） | `config/pd-config-types.ts:115-126` |
| `PeerRunnerKind`（6 项） | `internalization/peer-runner-contracts.ts:54-60` |
| `resolveRolloutReviewMode` | `rollout-reviewer-runner.ts:168-187` |
| repair seed（绕过漏斗） | `internalization-consumer-governance.ts:187` |
| repair seed（CLI） | `rulehost-pipeline-runner.ts:729` |
| 对抗循环 createTask | `adversarial-loop.ts:89, 218` |
| `reopenTaskForRevision` | `revision-reopen.ts:56` |
| `resolveRolloutRevisionTarget` | `revision-reopen.ts:131` |
| 消费周期 reconciliation budget | `internalization-consumer-cycle.ts:194` |
| `wakeOnce` | `internalization-orchestrator.ts:207` |
| Codex ingestion 独立门（catch-up 在 consumer flag 之前） | `codex-adapter/src/worker/workspace-worker.ts:164` |
| 三态边集测试 | `internalization/__tests__/c2-live-runner-chain.test.ts:439-500` |
