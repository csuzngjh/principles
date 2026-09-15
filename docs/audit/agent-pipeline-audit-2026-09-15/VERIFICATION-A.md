# VERIFICATION-A — 管道审计报告逐项核实（§0/§1/§2/§7）

- 日期：2026-09-15
- 被核实对象：`docs/audit/agent-pipeline-audit-2026-09-15/REPORT.md`（以下称「报告」）
- 核实基线：报告声明其证据锚定 **`70d824c4`**。本次核实未切换工作区分支，全部使用 `git show 70d824c4:<path>` 读取该提交内容（本地对象可得，无需降级）。
- 核实范围：报告 §0、§0.1、§0.2、§1.3 登记表（R-01..R-18）、§2（F1..F10／边载体表／入口清单／§2.4 Schema 注册表／§6.1 状态机／§6.4 表速查）、§7。
- 判定口径：CONFIRMED＝代码事实与报告一致；REFUTED＝不一致（给出正确事实＋本次核实者行号）；DRIFT＝结论成立但行号/引用不符；UNVERIFIABLE＝环境所限。
- 本文档只读核实，未修改任何既有文件。
- 本文件中的「NEW-*」均为**核实员补充，非报告既有内容**。

---

## 1. 摘要统计

### 1.1 判定计数

| 判区 | CONFIRMED | DRIFT | REFUTED | UNVERIFIABLE | 小计 |
|---|---|---|---|---|---|
| A-1（§0 名单／roster／§0.1／§0.2） | 17 | 0 | 0 | 0 | 17 |
| A-2（R-01..R-18） | 18 | 0 | 0 | 0 | 18 |
| A-3（F1..F10） | 10 | 0 | 0 | 0 | 10 |
| A-3（「每条边的数据载体」表，16 数据行全查） | 16 | 0 | 0 | 0 | 16 |
| A-3（11 个入口清单） | 11 | 0 | 0 | 0 | 11 |
| A-3（§2.4 输出 Schema 注册表，12 行全量比对） | 10 | 2 | 0 | 0 | 12 |
| A-3（§6.1 状态机转移表，全量比对） | 6 | 0 | 0 | 0 | 6 |
| A-3（§6.4 表速查行号，全量比对 20 张表） | 20 | 0 | 0 | 0 | 20 |
| A-4（§7 OPEN PR 状态表） | 0 | 0 | 5 | 0 | 5 |
| **合计** | **108** | **2** | **5** | **0** | **115** |

另：交叉引用编号悬空 1 项（记入漂移表 D-4）、行号精度备注 1 项（D-1，非漂移），均不重复计入上表行数。

### 1.2 最重要的 5 条 REFUTED

全部集中在 A-4（§7.1 在途 PR 表）——报告把 5 个**已合并**的 PR 描述为「OPEN 在途」，并建议「合入前先以本报告现状为基线评审其覆盖面」：

| # | 报告陈述 | 事实（GitHub 匿名 API，2026-09-15 核实） |
|---|---|---|
| R-A41 | `#1698` 属「在途 OPEN PR」 | `state=closed`，`merged_at=2026-09-15T01:13:21Z`（= +0800 09:13） |
| R-A42 | `#1693` 属「在途 OPEN PR」 | `state=closed`，`merged_at=2026-09-15T01:25:20Z`（09:25） |
| R-A43 | `#1694` 属「在途 OPEN PR」 | `state=closed`，`merged_at=2026-09-15T01:42:24Z`（09:42） |
| R-A44 | `#1703` 属「在途 OPEN PR」 | `state=closed`，`merged_at=2026-09-15T03:40:25Z`（11:40） |
| R-A45 | `#1700` 属「在途 OPEN PR」 | `state=closed`，`merged_at=2026-09-15T03:29:31Z`（11:29） |

关键推论：报告提交（`3e5722b4`，2026-09-15 11:13 +0800）时，#1698/#1693/#1694/#1700/#1703 的合并提交**已是该提交的祖先**（本地已验：`git merge-base --is-ancestor 285d1c81 3e5722b4` → YES，`be615da1`/`4c9e1b21` 同）。即：报告正文称「不含这些 PR 的改动」，而报告所在提交实际**已经包含**它们。

### 1.3 最重要的 5 条 NEW（核实员补充）

| # | 补充发现 | 建议严重度 |
|---|---|---|
| NEW-1 | 入口清单遗漏一条真实生产入口：Codex hook 会话摄取（`codex_conversation_ingestion`）→ admission → 异步建诊断任务 | P2 |
| NEW-2 | §2 F10「flag/gate 拦截点全景」漏 `signal_collector`（默认 OFF，gate Stage2 LLM 分类）与 `codex_conversation_ingestion`（默认 OFF，gate Codex 摄取） | P2 |
| NEW-3 | R-03 描述的两份 schema 漂移，**在报告所在分支上已被 #1693 修复**（`artificer-output-typebox.ts` 现含 `evidenceRefs`）；报告未标注基线时效 | P2 |
| NEW-4 | `wakeOnce` 可捡状态集合的枚举不完整：`isRunnerKind` 含 3 个 `diag_*` 子任务 kind，`wake-once` CLI 无 kind 过滤时会把它们纳入候选 | P3 |
| NEW-5 | §6.4 表速查遗漏 trajectory.db 侧 6 张 governance 权威表（admissions / rate limits / rollouts / observations / checkpoints / promotion tails） | P3 |

---

## 2. 逐项判定表

### 2.1 A-1 — §0 审计范围与方法（17 项）

| 编号 | 判定 | 核实者证据 | 备注 |
|---|---|---|---|
| A-1-01 | CONFIRMED | `pd-config-types.ts:115-126` 为 `INTERNAL_AGENT_NAMES` 数组加 `] as const;`；10 个成员与报告 §0 表集合完全一致 | 报告表内**排序**不同（signalCollector 排第 1）；集合一致，不影响准确性 |
| A-1-02 | CONFIRMED | 同上，`signalCollector` 在列；Stage2 LLM 路径 `signal-collector-host.ts:253-300`、`llm-stage.ts` | — |
| A-1-03 | CONFIRMED | `diagnostician` 在列；三阶段实现 `split-diagnostician-runner.ts:96-262`（A→B→C） | 与 §3.0 命名纠偏一致 |
| A-1-04 | CONFIRMED | `dreamer` 在列；`dreamer-runner.ts:214-242` | — |
| A-1-05 | CONFIRMED | `philosopher` 在列；`philosopher-runner.ts:227` | — |
| A-1-06 | CONFIRMED | `scribe` 在列；`scribe-runner.ts:242` | — |
| A-1-07 | CONFIRMED | `artificer` 在列；`artificer-runner.ts:947` 且 L2 路径 `internalization-consumer-cycle.ts:456-479` | — |
| A-1-08 | CONFIRMED | `evaluator` 在列；`evaluator-runner.ts:880` | — |
| A-1-09 | CONFIRMED | `rolloutReviewer` 在列；`rollout-reviewer-runner.ts:460` | — |
| A-1-10 | CONFIRMED | `correctionObserver` 在列；生产调度注册 `correction-observer-service.ts:290-298`（`scheduler.register({agentId:'correction-observer'})`） | — |
| A-1-11 | CONFIRMED | `empathyObserver` 在列；**全仓 `new EmpathyObserver` 仅测试**（`observer/__tests__/empathy-observer.test.ts:26,48,65,80,99`、`empathy-observer.real-e2e.test.ts:62`），生产源码零实例化 → 「死类」断言成立 | 另核：`empathyObserver` 在 config 层仅有 defaults/types/tests 出现，无生产读取者 |
| A-1-12 | CONFIRMED | `system-prompt-merge.ts:1-26`：`mergeSystemPromptLayers` 空行连接、trim 后空层丢弃、全空返回 undefined | 报告 :1-26 精确（文件共 26 行） |
| A-1-13 | CONFIRMED | `pi-ai-runtime-adapter.ts:588` 为 `mergeSystemPromptLayers(input.systemPrompt, this.config.systemPrompt)`；:584-587 为 PRI-633 注释块（报告写 585-591，覆盖 584-592 区间） | — |
| A-1-14 | CONFIRMED | `l2-agent-loop-adapter.ts:351` 三层 merge（base＋toolInstruction＋config），:353 为无工具协议的 L1 变体 | **补注**：另有第二个 L2 适配器 `artificer-l2-adapter.ts:243-247` 同样三层 merge，报告 §0.1/§7.1 只提 `l2-agent-loop` |
| A-1-15 | CONFIRMED | `feature-flag-contract.ts:330` `artifact_summary_redundancy`：`category: 'quiet', enabled: false, since: '2026-07-26'` | — |
| A-1-16 | CONFIRMED | `feature-flag-contract.ts:341` `context_manifest_budget`：`quiet / false / 2026-07-26` | — |
| A-1-17 | CONFIRMED | `feature-flag-contract.ts:347` `progressive_evaluator`：`quiet / false / 2026-07-26` | 报告 §0.2 引 :325-347 精确（325-329 为 Layer 0 注释） |

### 2.2 A-2 — §1.3 综合发现登记表 R-01..R-18（18 项，P1 六条从严）

| 编号 | 判定 | 核实者证据（本次独立读取） | 备注 |
|---|---|---|---|
| R-01 | CONFIRMED | `philosopher-output.ts:24,42` 字段名确为 `sourceDreamerArtifactId`；`scribe-prompt-builder.ts:78` 确写 `"dreamerArtifactId": "<from philosopher artifact if available, or omit>"`；`artificer-runner.ts:274-276`（无 `sourceTrace`）与 `:279-281`（无 `dreamerArtifactId`）两条分支**直接 `return undefined` 无 `emitEvent`**；仅 :267-269、:284、:292 等分支发事件 → 「省略时静默」成立 | P1 从严：命名断链与静默段均逐行命中。静默段的精确行为是「`resolveDreamerContext` 返回 undefined 且不发事件」 |
| R-02 | CONFIRMED | `artificer-prompt-builder.ts:168-186` OUTPUT FORMAT 示例的确只含 taskId/sourceScribeArtifactId/implementationSummary/sourceTrace/risks/implementationCode/goldenTraceCases(无 ruleContext)/affectedTools/generatedAt；而 `:264-265` 要求 `requiresContextVersion: 2` 且 case 级 `ruleContext` 必填、`:269` 要求 `evidenceRefs` 逐字复制；`artificer-output.ts:305-311`（v2 声明时 ruleContext 必填）、`:388-394`（v2 声明时 evidenceRefs 必填）→ 逐字模仿示例必被拒 | P1 从严。「CONTEXT MODE block above」方位错误亦成立：`V2_CONTEXT_INSTRUCTION`（:261-271）在 `ARTIFICER_PROTOCOL_INSTRUCTION`（:153-253，含 OUTPUT FORMAT）**之后**拼接（:357-361） |
| R-03 | CONFIRMED（基线成立） | `70d824c4:artificer-output-typebox.ts` **`evidenceRefs` 零命中**，`:63-75` 的 `ArtificerRuleOutputTypebox` 确实无该字段；`:59-61` 注释宣称与 @sinclair 版 field-for-field 一致，而 `artificer-output.ts:105` 有 `evidenceRefs`（v2 必填）→ 注释为假 | **重要时效注**：所在交付分支已含 #1693，该文件现有 `evidenceRefs`（`afa95651`）。详见 NEW-3 与建议修正 S-6 |
| R-04 | CONFIRMED | `split-diagnostician-runner.ts:188-198` 仅 `JSON.parse` 并 `cacheUsable=false` 兜底；`:199-206` `output: parsedOutput as DiagnosticianOutputV1` —— 无 schema 校验、`as` 断言（违 rc-1/rc-2）；失败分支反而 fail-safe | P1 从严：行号 190-206 精确（:190 为 `if (outputPayload !== ...)`) |
| R-05 | CONFIRMED | 无生产实例化（同 A-1-11）；`feature-flag-contract.ts:251` `empathy_observer` `category:'gone'`, `enabled:false`；`ControlCenterPage.tsx:878-894` 仍以 `agents.find(a => a.name === 'empathyObserver' && a.enabled)` 为门渲染 `<EmpathyObserverCostHint>`；`pd-config-defaults.ts:70` `empathyObserver: false` 键仍存在 | 「Owner 打开后零运行时效果」成立：未找到任何读取该绑定键进行运行时判定的生产代码 |
| R-06 | CONFIRMED | 三 flag 全 `enabled:false`（见 A-1-15..17）；`context-manifests.ts:46-69` DREAMER_MANIFEST tier0=2 路径 + tier1=5 路径 = **7 条**，全部为 `pain.summary.*`/`diagnosis.summary.*`；`base-peer-runner.ts:1108-1123` 在输出顶层已有 `summary` 键时**跳过**写 envelope `summary`（只留 `predecessorSummary`）；`summary-field-reader.ts:33-36` 要求 `contentJson.summary` 为 record；而 `diagnostician-output.ts:54` 顶层 `summary` 是 **string** → `pain.summary.*`/`diagnosis.summary.*` 全 absent → `resolve-injection.ts:109-114` `tier1_all_absent` → 恒回退全量注入，`budgetTokens: 1500` 从未生效 | P1 从严：**7 条路径数与全部回退的因果链逐环命中**，报告此条判定扎实 |
| R-07 | CONFIRMED | `pain-signal-bridge.ts:489-498` 非 succeeded/未过期 leased 时 `updateTask({status:'pending', attemptCount:0, ...})`（:494 attemptCount:0）；`:540-557` 注释明言 "Unlike `onPainDetected` this NEVER resets task state"，`:593-601` failed/needs_human_review 直接 skip | — |
| R-08 | CONFIRMED | `pain-signal-runtime-factory.ts:621-624`（rootCause）与 `:625-628`（distiller）均传 `effectiveConfig: opts.effectiveConfig`；`:629-632`（`new DiagRouterRunner`）**无** `effectiveConfig`（只有 owner/runtimeKind/outputLanguage）→ router 侧降级开关失效 | P1 从严：三处并列对照，差异为一行级 |
| R-09 | CONFIRMED | `progressive-evaluator.ts:26` `IMPLEMENTATION_FIDELITY_THRESHOLD = 0.7`；`:166-179` 读 `stage1Output.implementationFidelity.score`；全仓 `implementationFidelity` 仅出现在 tests 与设计文档，`evaluator-output.ts:122-172` 的 V1/V2 接口无该字段，`evaluator-prompt-builder.ts` 亦无该字段 → undetermined 恒非空 | P1 从严 |
| R-10 | CONFIRMED | `correction-observer.ts:119` 指令「If a term appears in trajectory but the user message doesn't actually express frustration」；`keyword-optimization-service.ts:120-124` 构造 payload 时 `userMessage: ''`（:123）并注明 rawText 因隐私不入库 | — |
| R-11 | CONFIRMED | `diag-router-runner.ts:446-519` 的 `postFetchTransform` 仅覆盖 rootCause(:464)、evidence(:476)、confidence(:488)、intentTension(:507/516)；**无 `abstractedPrinciple`**；候选落库取 LLM 输出列 `diagnostician-committer.ts:207 rec.abstractedPrinciple ?? null` | 报告写作「字段枚举 rootCause/evidence/confidence/intentTension」准确 |
| R-12 | CONFIRMED | `signal-collector/types.ts:23-35` 定义 PendingTerm/PendingTermStore；全仓 PendingTerm* 生产引用仅在 pd-console UI（`signal-keywords-api.ts`、`signal-keywords-validators.ts:85-98`、`signal-keywords-types.ts:39-52`）→ **无生产写入者**；`signal-keywords-api.ts:38-66,97-107,116-150` 全部 `success:false, reason:'endpoint_not_implemented'` stub；`keyword-optimization-service.ts:31 applyResult` 只落 keyword store | — |
| R-13 | CONFIRMED | `rollout-reviewer-output.ts:102-103` `requiredChanges` 只校验「是字符串数组」，**无** needs_revision⇒非空约束；对照 `evaluator-output.ts:470-474` 有该约束；`rollout-reviewer-prompt-builder.ts:60` 明示 "requiredChanges MUST be an array of strings (**can be empty**)"；`activation-dispatcher.ts:265-268` + `approval-queue.ts:17-22` `decideAutoPromotion` 仅凭 channel+confidence，:131-132 confidence 来自 rollout 自报 | 报告证据列写作 `rollout-reviewer-output.ts:102-107,60`，其中 `,60` 属文件内无效行号 → 见漂移表 D-2 |
| R-14 | CONFIRMED | `internalization-route.ts:43-48` `KIND_ROUTE_MAP`（未导出）、`:52-150` `decideInternalizationRoute`（principle 查 abstractedPrinciple :82、rule 查 triggerPattern+action :101-106）；唯一生产消费者为 `pd-cli/commands/candidate.ts:331,980,1069,1219`；`pain-signal-bridge.ts:761-768` 自动路径 `const ready = !!channel`（:768）；`intake-to-internalization-bridge.ts:34-40` 第二份 `CANDIDATE_KIND_TO_ROUTE`（导出）、`:66-81` 只检查 `input.ready` 与通道 | — |
| R-15 | CONFIRMED | `intake-to-internalization-bridge.ts:42-47` `'implementation-candidate': 'skill'`；`:28-32` MVP_ENABLED_CHANNELS 无 `skill`；`:79-81` 命中 → `not_internalizable`；`pain-signal-bridge.ts:791-801` 发 `candidate_not_internalizable` 遥测（非静默） | — |
| R-16 | CONFIRMED | `dreamer-prompt-builder.ts:84` 「For each identified root cause, generate 1-5 ...」（每根因）、`:97` 「candidates MUST have 1-5 items」（总数）；`dreamer-output.ts:4` 文档注释「generates 2-3 diverse candidate corrections」、`:140-142` validator 总数 1-5 | 三处口径确实不一致 |
| R-17 | CONFIRMED | `split-diagnostician-runner.ts:81` `perStageTimeoutMs = deps.perStageTimeoutMs ?? 600_000`；`:290-296` 写入子任务 `diagnosticJson`（`createPITaskDiagnosticJson({ timeoutMs: this.perStageTimeoutMs })`）；`:293` 是唯一使用点（从不进 runner options）；`pain-signal-runtime-factory.ts:640` 传 `runtimeConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS`；`base-peer-runner.ts:108-114` 默认 `timeoutMs: 300_000`，而 :1177 实际 startRun 用 `this.resolvedOptions.timeoutMs` | 三阶段子任务 metadata 与 runner 死线确为两套值 |
| R-18 | CONFIRMED | `rootcause-prompt-builder.ts:252-253` 承诺「evidence 为空数组 → MUST 输出 confidence < 0.3 且 ambiguityNotes 含 Insufficient evidence」；`diag-rootcause-output.ts:220` confidence 仅 `Number(0..1)`，全文件无「evidence 空 ⇒ confidence<0.3」交叉校验；`admission-gate.ts:25` 阈值 0.5，`:61-77` 只查 confidence 阈值与 evidenceCount 数量 | 承诺无机器执行成立 |

### 2.3 A-3 — §2 编排层（F1..F10／边载体／入口／注册表／状态机／表速查）

#### 2.3.1 F1..F10 逐条回源（10 项）

| 编号 | 判定 | 核实者证据 | 备注 |
|---|---|---|---|
| F1 | CONFIRMED | `agent-scheduler.ts:6-9` `AgentTypeMap` 含 `'empathy-observer'`；生产只注册 `'correction-observer'`（`correction-observer-service.ts:290-295`）；`output-schema-registry.ts:47` 仍占位；`pd-config-types.ts:124` 在名单；`pd-config-defaults.ts:70` false；`feature-flag-contract.ts:251` gone | 「三重残留」表述与事实相符 |
| F2 | CONFIRMED | 两个入口的相反语义见 R-07；`:436-452` capabilityDisabled 分支注释「keeps its exact durable state (including retry budget)」 | — |
| F3 | CONFIRMED | 双实现见 R-14；`candidate.ts` 四处消费点核实存在 | — |
| F4 | CONFIRMED | 见 R-15；消费侧 `internalization-consumer-cycle.ts:336-340` `enabledChannels: new Set(['prompt','code_tool_hook','defer_archive'])`；`internalization-queue-read-model.ts:343` 默认值同为三者 | 注意路径：read-model 在 `runtime-v2/` 根，非 `internalization/` 子目录（报告省略目录，行号正确） |
| F5 | CONFIRMED | `internalization-task-guards.ts:129-130` `case 'failed': return false;`；`recovery-sweep-service.ts:103-111` 裸 `updateTask({status:'pending',...})`；`store/lifecycle/recovery-sweep.ts:101-128` 裸 SQL 写 needs_human_review/retry_wait/failed，均不经 `canTransitionTo` | 报告 F5 引 `internalization-task-guards.ts:129-130` 精确 |
| F6 | CONFIRMED | `internalization-consumer-cycle.ts:736-755` finally 中 `:744 safeRunRecoverySweep` + `:750 runReconciliationBudget`；`runtime-internalization-run-once.ts` 全文（796 行）无 `runRecoverySweep`/`reconcile` 调用（rg 零命中） | 报告写 428-796，文件确为 796 行 |
| F7 | CONFIRMED | `queue-actionability.ts:28-35` MVP_CORE_TASK_KINDS；`internalization-consumer-decision.ts:25-32` FULL_CHAIN_CONSUMER_RUNNER_KINDS；`pain-signal-runtime-factory.ts:331-338` AGENT_NAME_FOR_TASK_KIND；`runtime-internalization-run-once.ts:59` SUPPORTED_RUNNERS | 四处内容同相、无编译期联动，成立 |
| F8 | CONFIRMED | 见 R-12 | — |
| F9 | CONFIRMED | `peer-runner-contracts.ts:39-45` PeerRunnerKind 6 值、`:53-56` diag_* 3 值、`:63` RunnerKind 并集；`internalization-orchestrator.ts:964-986` `findCandidates` 只取 pending/retry_wait 并 `filter(isRunnerKind)`；`runtime-v2/cli/diagnose.ts:149-150` StalledDiagnosticianTaskReadModel 消费点 | — |
| F10 | CONFIRMED（含精度备注） | 表内 11 项的 **category/enabled 逐项与 `feature-flag-contract.ts` 比对全部相符**：`internalAgents.agents.diagnostician.enabled` → 唯一 kill switch，经 `resolveDiagnosticianCapability`（`diagnostician-capability.ts:51-68`）在 `factory:764-767` 消费；`internalization_auto_consumer` quiet/true（:196）→ `internalization-consumer-cycle.ts:263-277` + `internalization-auto-consumer-service.ts:130-146`；`internalization_full_chain` core/true（:208）→ cycle:352-355；`code_rule_capability` core/true（:285）→ cycle:455-460；`l2_dreamer` quiet/false（:277）→ cycle:450,480；`evaluator_artificer_repair_loop` quiet/true（:312）→ `internalization-consumer-governance.ts:154-161`；`pain_diagnosis_persistence` quiet/false（:391）→ factory:788-792 + `pain-signal-bridge.ts:717`；`failed_tasks_observability` quiet/true（:301）→ `failed-tasks.ts:357-368`；`failed_task_recovery_console` quiet/true（:381）→ `failed-tasks.ts:480-488`；`host.codex` core/true（:352）→ `workspace-worker.ts:145-146`；通道三开关 core/true（:189-193，`pd-config-feature-flags.ts:37,115-122`）；`abstraction_layer_v1` quiet/false（:353）→ `openclaw-plugin/src/index.ts:141-157`（门函数）与 **:479**（`after_tool_call` 内调用；另 :376/:421 两个 hook 同门） | 报告给的区间 `468-479` **确实覆盖 :479 的调用行**，故不算漂移；仅提示 :468-469 本身是 workspaceDir 解析失败分支，精确锚点应为 :479。详见 D-1 精度备注。另见 NEW-2（漏两个 flag） |

#### 2.3.2 「每条边的数据载体」表（报告 §2 边表 16 数据行，全量核对）

| # | 边 | 判定 | 核实者证据 |
|---|---|---|---|
| E1 | hook → 信号采集 | CONFIRMED | `signal-collector-host.ts:199-209` 构造 `TrajectoryUserTurnInput`（rawText/correctionDetected/correctionCue/referencesAssistantTurnId 齐全） |
| E2 | 信号 STRONG → pain | CONFIRMED | `signal-collector-host.ts:501-506` `deriveProductionCorrectionPainIdentity` →`pain_host_`；`:516-527` painType=user_frustration/source=user_correction/score=strongPainScore；`production-pain-evidence.ts:229-245` 哈希派生 `pain_host_<sha256>` |
| E3 | hook → trajectory.db | CONFIRMED | `production-pain-evidence.ts:248-252` REQUIRED_COLUMNS（sessions/tool_calls/pain_events，含 canonical_pain_id/runtime_task_id/host_kind）；`:406-419` 三个 INSERT |
| E4 | ingress → recordPain | CONFIRMED | `pain-ingress.ts:58-72` LegacyPainSubmission 字段逐项一致；`:125-150` buildLegacy |
| E5 | recordPain → bridge | CONFIRMED | `pain-to-principle-service.ts:156-170` 构造 PainDetectedData（含 painIngress） |
| E6 | recordPain 异常 → 死信 | CONFIRMED | `hooks/pain.ts:260-294` catch → SqliteDeadLetterStore.insertDeadLetter；`sqlite-connection.ts:657-667` DDL（pain_id/pain_data/retry_count/retried_at） |
| E7 | bridge → 诊断父任务 | CONFIRMED | `pain-signal-bridge.ts:178-180` taskId 约定；`:311-329` buildDiagnosticJson 字段集合与报告逐项一致；`:499-510` createTask（taskKind='diagnostician'） |
| E8 | Split → 子任务 | CONFIRMED | `split-diagnostician-runner.ts:124-171` 三个 stage id 与依赖（A 无依赖、B 依赖 A、C 依赖 A+B）；`:274-320` ensureSubTask |
| E9 | 每阶段 LLM 调用 | CONFIRMED | `base-peer-runner.ts:1170-1177` startRun（outputSchemaRef 由 resultRefPrefix/expectedTaskKind 决定）；`sqlite-connection.ts:259-279` runs DDL；`output-schema-registry.ts:37-50` |
| E10 | diag_router → 候选 | CONFIRMED | `diag-router-runner.ts:307-335` committer 在同一 commit 内写；`sqlite-connection.ts:310-376` artifacts/commits/principle_candidates DDL（含 recommendation_kind/trigger_pattern/action/abstracted_principle）。报告「同一事务」由 `diagnostician-committer.ts:136-216 db.transaction(() => {...})` 佐证 |
| E11 | onDiagnosisComplete → 内化 | CONFIRMED | `pain-signal-bridge.ts:745-816`（:745 autoIntake、:756 intake、:761-768 路由、:774-782 seed、:813-815 置 consumed）；`intake-to-internalization-bridge.ts:106-140`（inputArtifactRefs candidate:// + artifact://、taskId=`dreamer-{candidateId}-{channel}`） |
| E12 | 诊断归因（flag 开时） | CONFIRMED | `pain-signal-bridge.ts:655-699` persistPainDiagnosis + recordPainDiagnosis；`sqlite-connection.ts:678-691` pain_diagnoses DDL（category CHECK 四值） |
| E13 | 内化链每跳 | CONFIRMED | `sqlite-connection.ts:224-243` tasks、`:259-279` runs、`:379-393` pi_artifacts（含 `idx_pi_artifacts_idempotency ON (source_task_id, artifact_kind)` 唯一索引） |
| E14 | 后继播种 | CONFIRMED | `internalization-orchestrator.ts:579-588` successor id = `{kind}-{correlationId}-{channel}`；`:673-698` successorMetadata + createTask。correlationId 来自 `intake-to-internalization-bridge.ts:132` |
| E15 | 崩溃窗口对账游标 | CONFIRMED | `sqlite-connection.ts:452-457` reconciliation_cursor DDL（scope PK）；`internalization-consumer-cycle.ts:196-240` 游标读写与 wrap-around |
| E16 | rollout verdict → 治理 | CONFIRMED | `activation-dispatcher.ts:255-273` 分流（低风险/require_approval→enqueueForApproval）、`:290-347` 审批后激活；`sqlite-connection.ts:395-449` approvals/activations DDL |


#### 2.3.3 入口清单（报告 §2 的 11 行，逐条确认引用点存在且语义正确）

| # | 入口 | 判定 | 核实者证据 | 语义复核 |
|---|---|---|---|---|
| 1 | OpenClaw `after_tool_call`（共享 host-runtime 路径） | CONFIRMED | `openclaw-plugin/src/index.ts:458` `api.on('after_tool_call', guardHook(...))`，:479 `runtimeGateFor(workspaceDir)`，:494 `sharedHostRuntime.dispatchAfterToolCall`；`host-runtime/openclaw-host-runtime.ts:167-170`；`host-runtime/src/index.ts:242-248` 默认挂 `createProductionPainEvidenceHandler`；`production-pain-evidence.ts:308-451` handler | 「runtime_task_id=NULL」（:419 传 null）与「不直接建诊断任务」均成立 |
| 2 | OpenClaw legacy hook 路径 | CONFIRMED | `index.ts:480-486`（gate 关 → `handleAfterToolCall`）、`:489-493`（pain/skill:pain 工具）；`hooks/pain.ts:316-414 handleAfterToolCall`、`:130-296 emitPainDetectedEvent`、`:228-243 recordPain` | 引用精确 |
| 3 | signalCollector STRONG | CONFIRMED | `hooks/prompt.ts:406-412` `detectSync(...)`；`signal-collector-host.ts:180-243`、`:485-534 routeStrong`（:510 emitPainDetectedEvent） | — |
| 4 | CLI `pd pain record` / `pd pain retry` | CONFIRMED | `pain-record.ts:354`（`diagnostician_async_cli` flag）；`pain-retry.ts:602-627`（dead letter 重放走 `bridge.onPainDetected`，:627） | 报告写 pain-retry.ts:600-627，:600 为注释首行，可接受 |
| 5 | 异步提交（`diagnostician_async_cli`） | CONFIRMED | `pain-to-principle-service.ts:174-188`（asyncMode → `bridge.submitPainSignal`）；`pain-signal-bridge.ts:408-423`（只 createTask pending，不跑 LLM） | — |
| 6 | Codex worker 循环 | CONFIRMED | `codex-adapter/src/worker/workspace-worker.ts:145-146`（host.codex gate）、`:220`（executePendingDiagnosis）、`:270-281`（runInternalizationConsumerCycle） | — |
| 7 | OpenClaw InternalizationAutoConsumer | CONFIRMED | `openclaw-plugin/src/index.ts:353-361`（`shouldStartInternalizationAutoConsumer` gate + start）；`service/internalization-auto-consumer-service.ts:105-191`（start/定时链） | 「只推进 6 peer runner，不碰诊断任务」成立（cycle 用 FULL_CHAIN_CONSUMER_RUNNER_KINDS，不含 diagnostician） |
| 8 | CLI `pd runtime internalization run-once` | CONFIRMED | `pd-cli/src/index.ts:759-771`（command 定义 + handler）；`commands/runtime-internalization-run-once.ts:428` handler、`:542 wakeOnce`、`:730-747 commitNextTaskProposal` | 「绕过 actionability/queue 快照」成立：全文无 readModel/classifyTaskActionability |
| 9 | Console `POST /api/v1/failed-tasks/:id/recover` | CONFIRMED | `server/index.ts:385-388` 路由注册（报告写 387 行，即 `handleFailedTasksRoute` 调用行）；`routes/failed-tasks.ts:463-557` recover 分支；`:265-275` decision-capable 409 | — |
| 10 | CLI 恢复族 | CONFIRMED | `pd-cli/src/index.ts:910-919`（recovery sweep）、`:921-937`（failed-tasks）、`:748-757`（internalization retry）、`:795-804`（enqueue-successors）、`:784-793`（integrity-repair） | 报告写 `910-919、921-937、748-757、795-804、784-793`，逐一对上 |
| 11 | Console 治理焦点 Owner Decision | CONFIRMED | `server/index.ts:514-518` 注册 `/api/v1/governance/owner-decisions`；`routes/owner-decisions.ts:203 handleOwnerDecisionsRoute`、`:261 applyOwnerResolution`；`pitask-metadata.ts:145-192` OwnerResolutionRecord/revise_once 语义 | 报告写「模型 OwnerDecisionConsoleModel」，`owner-decisions.ts:20,29` 确认 |

**关键事实复核**：
- 「Console 无任何推进管道端点」CONFIRMED：`server/index.ts:356-470` 全部 `/api/*` 路由中无 run-once/wake/lease mutation；rg `wakeOnce|runOnce|Orchestrator|runRecoverySweep` 在 `packages/pd-console/src/server` **零命中**；失败页 nextAction `failed-tasks.ts:551` 确引导回 CLI。
- 「`wakeOnce` 只扫 pending 和 retry_wait」CONFIRMED：`internalization-orchestrator.ts:969-973` 两次 listTasks（pending / retry_wait），`:979 filter(isRunnerKind)`；`:960-962`、`:796-802` 注释自证。leased 唯一出路为 recovery sweep（`internalization-consumer-cycle.ts:743-745` / CLI）。**但状态集合枚举不完整 → NEW-4**

#### 2.3.4 §2.4 输出 Schema 注册表（12 行与 `output-schema-registry.ts:37-50` 全量比对）

| # | outputSchemaRef | 判定 | 核实者证据 |
|---|---|---|---|
| S1 | `diagnostician-output-v1` | CONFIRMED | 注册表 :38；schema `diagnostician-output.ts:51-66`（violatedPrinciples/recommendations(kind,abstractedPrinciple,triggerPattern,action)/diagnosisId/rootCause/evidence/confidence/summary）；产方 `diag-router-runner.ts:259`；消费方 bridge + committer |
| S2 | `diag-rootcause-output-v1` | CONFIRMED | 注册表 :39；schema `diag-rootcause-output.ts:209-232`（causalChain/rootCauseCategory 均在） |
| S3 | `diag-distiller-output-v1` | CONFIRMED | 注册表 :40；schema `diag-distiller-output.ts:40-61`（abstractedPrinciple/rationale/confidence） |
| S4 | `dreamer-output-v1` | CONFIRMED | 注册表 :41；schema `dreamer-output.ts:70-81`（badDecision/betterDecision/rationale/confidence/riskLevel/strategicPerspective 六字段齐全） |
| S5 | `philosopher-output-v1` | CONFIRMED | 注册表 :42；schema `philosopher-output.ts:40-47`（thesis/principleCandidate{title,rationale,scope,confidence}/risks） |
| S6 | `scribe-output-v1` | CONFIRMED | 注册表 :43；schema `scribe-output.ts:50-66`（principleDraft{statement,applicability,antiPatterns,confidence,title}） |
| S7 | `artificer-rule-output-v2` | **DRIFT** | 注册表 :44 与产方 `artificer-runner.ts:947` 对上；但报告「Schema 概要」写 `ruleCode/submit_rulecode 语义` —— schema 实际字段是 `implementationCode`（`artificer-output.ts:81`），`submit_rulecode` 是 L2 工具名（`artificer-output-typebox.ts:59`），二者非同一概念 |
| S8 | `evaluator-output-v1` | CONFIRMED | 注册表 :45；schema `evaluator-output.ts:217-224`（evaluation{decision,score,requiredChanges…}）；adversarialResult 在 V2 接口 :167（可选）；transition-decision :91-108 |
| S9 | `rollout-reviewer-output-v1` | **DRIFT** | 注册表 :46 与产方 `rollout-reviewer-runner.ts:460` 对上；报告「主要消费方…仲裁（:110-124）；dispatchActivation」正确（`internalization-transition-decision.ts:110-124`），但「Schema 概要」列的 **`rolloutDecision` 字段不在 `RolloutReviewerOutputV1` 内**（`rollout-reviewer-output.ts:20-27,31-42` 无此字段）；它是 `activation-types.ts:38` 的 Dispatcher 入参 |
| S10 | `empathy-observer-output-v1` | CONFIRMED | 注册表 :47；`empathy-observer.ts:12-21`（damageDetected/severity/confidence/reason）；无生产产出方（同 R-05） |
| S11 | `correction-observer-output-v1` | CONFIRMED | 注册表 :48；`correction-observer.ts:30-41`（updated/updates{action,reasoning,weight?}/fpTerms/summary）；消费 `correction-observer-service.ts:303-304 applyResult` |
| S12 | `signal-classification-output-v1` | CONFIRMED | 注册表 :49；`signal-collector/types.ts:113-119`（is_feedback/type/confidence/reason）；产方 `signal-collector-host.ts:639`；消费 `resolveLlmClassificationPayload`（`llm-stage.ts:70-85`）→ `detectAsyncAndRoute`（`signal-collector-host.ts:253-300`） |

#### 2.3.5 §6.1 状态机转移表（与 `internalization-task-guards.ts:111-134` 全量比对）

| 报告行 | 判定 | 核实者证据（`internalization-task-guards.ts`） |
|---|---|---|
| `pending → leased` | CONFIRMED | :113-114 |
| `leased → succeeded / retry_wait / failed / pending / needs_human_review` | CONFIRMED | :115-122（五出边逐一对上） |
| `retry_wait → pending` | CONFIRMED | :123-124 |
| `succeeded → pending` | CONFIRMED | :125-126（注释 :103-105 限定 revision reopen） |
| `needs_human_review → pending` | CONFIRMED | :127-128 |
| `failed →（无出边）` | CONFIRMED | :129-130 `case 'failed': return false;` |

附带核实（报告 6.1 的 guard 辅助项）：`canAcquireLease` :55-57 仅 pending/retry_wait ✔；`isRetryWaitBackoffElapsed` :30-36、`canRetryNow` :38-40 ✔；依赖门 fail-closed `internalization-state-machine.ts:176-188`（缺记录/非 succeeded → blockedBy）✔；`DEFAULT_RETRY_WAIT_STALE_TTL_MS` :196 = 24h ✔，唯一消费者 `internalization-chain-integrity-read-model.ts:461-472`（CLI 只读面）✔；三振出局 `DEFAULT_UNRESOLVABLE_THRESHOLD` :172-177 ✔；artifact 拒绝反馈 `internalization-state-machine.ts:259-310`（scribe/artificer→corrective，其余→escalate）✔。

#### 2.3.6 §6.4 持久化表速查（20 张表行号全量比对）

全部在 `packages/principles-core/src/runtime-v2/store/sqlite-connection.ts`：

| 表 | 报告行 | 实测 `CREATE TABLE IF NOT EXISTS` 行 | 判定 |
|---|---|---|---|
| tasks | 224 | 224 | CONFIRMED |
| runs | 259 | 259 | CONFIRMED |
| artifacts | 310 | 310 | CONFIRMED |
| commits | 326 | 326 | CONFIRMED |
| principle_candidates | 350 | 350 | CONFIRMED |
| pi_artifacts | 379 | 379 | CONFIRMED |
| approvals | 395 | 395 | CONFIRMED |
| activations | 439 | 439 | CONFIRMED |
| reconciliation_cursor | 452 | 452 | CONFIRMED |
| principle_applications | 463 | 463 | CONFIRMED |
| activation_decisions | 502 | 502 | CONFIRMED |
| activation_control_states | 545 | 545 | CONFIRMED |
| activation_evidence_snapshots | 552 | 552 | CONFIRMED |
| global_rulecode_pauses | 568 | 568 | CONFIRMED |
| intent_decisions | 594 | 594 | CONFIRMED |
| intent_doc_versions | 626 | 626 | CONFIRMED |
| schema_version | 642 | 642 | CONFIRMED |
| dead_letter_pains | 657 | 657 | CONFIRMED |
| pain_diagnoses | 678 | 678 | CONFIRMED |
| pending_agent_drafts | 706 | 706 | CONFIRMED |

trajectory.db 侧 `sessions`/`tool_calls`/`pain_events` 引用 `production-pain-evidence.ts:248-252` CONFIRMED（REQUIRED_COLUMNS）。**遗漏项见 NEW-5**。

### 2.4 A-4 — §7 OPEN PR 状态表（GitHub 匿名 API）

核实命令：`curl -s https://api.github.com/repos/csuzngjh/principles/pulls/<n>`（未使用任何凭据）。

| 编号 | 判定 | 报告陈述 | 实测（title / state / merged_at） | 备注 |
|---|---|---|---|---|
| A-4-01 | **REFUTED** | #1698 OPEN 在途 | title `PRI-720: Channel-aware DAG — 原则是原则，规则是规则（含 Owner 全链覆盖开关）`；`state=closed`；`merged_at=2026-09-15T01:13:21Z` | 标题语义与报告「#1698（PRI-720 Channel-aware DAG…）」一致；状态不符 |
| A-4-02 | **REFUTED** | #1693 OPEN 在途 | title `fix(internalization): PRI-795 Artificer L2 abort ownership + timeout contract`；`state=closed`；`merged_at=2026-09-15T01:25:20Z` | 同上 |
| A-4-03 | **REFUTED** | #1694 OPEN 在途 | title `PRI-783: pd pain record --session 空证据降级收下（替代硬拒）+ nextAction 修正 + 测试假绿修复`；`state=closed`；`merged_at=2026-09-15T01:42:24Z` | 同上 |
| A-4-04 | **REFUTED** | #1703 OPEN 在途 | title `fix(governance): instance-agnostic timestamp contract; deterministic lease order; honest decision-card copy`；`state=closed`；`merged_at=2026-09-15T03:40:25Z` | 同上 |
| A-4-05 | **REFUTED** | #1700 OPEN 在途 | title `docs(error-handbook): 记录 ERR-130 + ERR-068 依赖升级复发；压缩超限 Recurrence 字段`；`state=closed`；`merged_at=2026-09-15T03:29:31Z` | 同上 |

补充核实：
- 当前真实 OPEN PR 为 **4** 个（#1709/#1708/#1707/#1706），报告未提；其中 #1707 即本报告自身的交付 PR（docs(audit)）。
- #1698 的「Owner 已 REQUEST CHANGES 3 P1」表述：API 中该 PR 的正式 review 只有 1 条 `COMMENTED`（2026-09-15T01:02:06Z，标题「Targeted re-review — PASS（代码层面无剩余 blocker）」），P1 相关表述出现在 **issue comment**（2026-09-15T00:02:36Z「复评结论：当前不建议合并…3 个 P1 契约问题」）。语义可接受但「REQUEST CHANGES」不是 GitHub 评审状态字面值。

---

## 3. 行号漂移修正表

| ID | 报告引用 | 事实 | 建议修正 |
|---|---|---|---|
| D-1（非漂移，精度备注） | §2 F10 表：`abstraction_layer_v1` 位置 `openclaw-plugin/src/index.ts:468-479（runtimeGateFor）` | 该区间**已覆盖**真正的调用行 **:479**（`const runtimeGate = runtimeGateFor(workspaceDir);`），故判定为 CONFIRMED；`:468-469` 是 workspaceDir 解析失败的日志+return；`runtimeGateFor` 定义在 `:216`，flag 判定在 `:141-157`；同门另用于 :376 / :421 | 建议把锚点收敛为 `index.ts:479`（附定义 :216、flag :141-157），以免读者误以为 :468 即调用点 |
| D-2 | §1.3 R-13 证据：`rollout-reviewer-output.ts:102-107,60` | 该文件只有 61 行之外的内容都无关 `60` 行；实际的「requiredChanges can be empty」明示在 **`rollout-reviewer-prompt-builder.ts:60`**（非 `rollout-reviewer-output.ts`） | 证据串改为 `rollout-reviewer-output.ts:102-107` vs `rollout-reviewer-prompt-builder.ts:60` |
| D-3 | §2.4 S7/S9 两行的「Schema 概要」列 | S7 写 `ruleCode/submit_rulecode`，实际字段为 `implementationCode`（`artificer-output.ts:81`）；S9 写 `rolloutDecision`，该字段不在 `RolloutReviewerOutputV1`（`rollout-reviewer-output.ts:20-27`）而属 `activation-types.ts:38` | 见 §5 建议修正 S-4/S-5 |
| D-4 | §0.2 交叉引用「§4 F-C1」 | 报告内 **不存在** F-C1 编号（全文 rg `F-C1` 仅此一处引用；§4 只出现「卡 N」编号体系） | 改为指向实际章节（`上下文 manifest 层死链见 §4 dreamer 卡`） |
| D-5 | §1.2 家族四 / §2.4 概要列引 `diagnostician-output.ts` | 无行号错误，但注册表 :38 行的产方是 `diag_router`（`diag-router-runner.ts:259`）——报告 S1 行写「diagnostician Stage C (diag_router)」正确 | 无（确认无误，记录备查） |

未发现其他行号漂移：A-1 全部锚点、R-01..R-18 全部锚点、F1..F9 锚点、边表 16 行锚点、入口 11 行锚点、§6.1/§6.4 全部锚点均与 `70d824c4` 实测一致。

---

## 4. 完整性补记（NEW 项清单）

以下均为**核实员补充，非报告既有内容**。每项给出 `file:line`、建议严重度与一句说明。

### 4.1 管辖面（§1/§2）中未被 R-01..R-28 / F1-F10 覆盖的断裂、双源、死表面

| ID | 严重度 | 发现 | 证据 | 为什么算漏记 |
|---|---|---|---|---|
| NEW-1 | **P2** | **入口清单遗漏一条真实生产入口**：Codex hook 的会话摄取路径。`codex-adapter/src/pd-hook.ts:97-124,156,166-167,178-180` 在 `turn_complete` / `before_prompt_build` / `after_tool_call` 上调用 `runConversationIngestion` → `runGovernanceAdmission`（`ingestion/admission.ts:130-160`）→ `admitGovernanceSignals` + `ensureGovernanceContinuation`（`governance-signal-admission.ts:997-1027`）→ `ensureGovernanceDiagnosticianTask`（:853-935）→ `PainToPrincipleService.recordPain(asyncMode)`（:905-916）建 pending 诊断任务。该路径**完全独立于**报告入口 6（worker 循环），由 `codex_conversation_ingestion` flag 控制（默认 `enabled:false`，`feature-flag-contract.ts:417`） | 「关键事实」称「Console 没有任何推进管道端点」正确，但入口表完整性义务要求纳入 hook 内 admission 这一主生产入口；报告 §2.1 数据流图亦无此边 |
| NEW-2 | **P2** | **F10「flag/gate 拦截点全景」漏两个默认关闭的管道级 flag** | `signal_collector`（`feature-flag-contract.ts:195`，`quiet/enabled:false`）gate 的是 Stage2 LLM 分类器：`signal-collector-host.ts:587-606 createSignalLlmClassifierFromConfig` 在 `!cfg.enabled` 时返回 null → 走纯关键词降级；`codex_conversation_ingestion`（:417，`quiet/enabled:false`）gate 整个 Codex 摄取（`pd-hook.ts:156,166-168,178-180`） | F10 声称「管道视角拦截点全景」，这两者在 `feature-flag-contract.ts` 中默认 OFF 且改变管道行为，属应列项。（F10 已列的 11 项 category/enabled 本身全部正确） |
| NEW-3 | **P2** | **R-03 的 schema 漂移属已修复状态，报告未标注时效** | `70d824c4:tools/artificer-output-typebox.ts` 无 `evidenceRefs`（漂移成立）；但本交付分支（含 #1693）该文件 :78-80 已有 `// model omit evidenceRefs on EVERY submit ...` 注释与 `evidenceRefs: Type.Optional(...)`。修复提交 `afa95651`（PRI-795 r3） | 报告 §7.1 说 #1693「合并后需复查」，但未指出 R-03 正是 #1693 已修项；照报告现状施工会重复劳动 |
| NEW-4 | **P3** | **`wakeOnce` 可捡状态集合的枚举不完整** | §2「关键事实」与 F9 说「只扫 pending 和 retry_wait」正确；但未说明过滤维度是 `isRunnerKind`（`internalization-orchestrator.ts:965,979`），而 `RunnerKind = PeerRunnerKind ∪ DiagnosticianStageKind`（`peer-runner-contracts.ts:39-63`），即 `diag_rootcause`/`diag_distiller`/`diag_router` **也在可捡集合内**。因此 `pd runtime internalization wake-once`（`runtime-internalization-wake-once.ts:60-67`，**无 kind 参数**）与 `InternalizationOrchestrator.wakeOnce()` 无参调用会把这些诊断子任务纳入候选。auto-consumer 侧不触发，仅因它按 `kind` 逐一传参（`internalization-consumer-cycle.ts:419`） | 「诊断任务不会被 auto-consumer 捡起」成立，但「诊断子任务对无参 wakeOnce 可见」这一相反事实未被记录，属枚举不完整 |
| NEW-5 | **P3** | **§6.4 表速查遗漏 trajectory.db 侧的 governance 权威表** | `host-runtime/src/governance-signal-admission.ts:341-357` `governance_signal_admissions`（`UNIQUE(logical_observation_key)`、`diagnostician_task_id` 幂等链接）、`:360-367` `governance_correction_rate_limits`；`host-runtime/src/governance-observation-store.ts:207` `governance_rollouts`、`:219` `governance_observations`、`:254` `governance_transcript_checkpoints`、`:267` `governance_pending_promotion_tails`。db 路径 = `.state/trajectory.db`（`governance-signal-admission.ts:381-382`） | §6.4 自称「持久化表速查（state.db，除注明外）」；但 `governance_signal_admissions.diagnostician_task_id` 是「一个 pain → 恰好一个诊断任务」的**唯一幂等权威**（`ensureGovernanceDiagnosticianTask:860-864` 以该列判重），对管道关键，应注明 |
| NEW-6 | **P3** | **`validateTaskTransition` 无生产调用者** | 定义 `internalization-state-machine.ts:223-245`（包装 `canTransitionTo` 并附人类可读原因），仅经 `index.ts:867` / `internalization/index.ts:172` 导出；全仓无生产调用（rg 零命中；F5 已指出裸 UPDATE 分裂，但未指出这个包装函数是死表面） | F5 记录了「guard 与真实写入路径不一致」，未记录「guard 的对外包装层本身零消费者」，属同一断面的另一半 |
| NEW-7 | **P3** | **`artifactKind='rule'` 存在非内化链生产产出方** | `pi_artifacts` 的 `rule` 类工件除 `evaluator-runner.ts:3262` 外，还有 `proven-channel-baseline.ts:110`（`runProvenChannelBaseline`，CLI `pd runtime synthetic proven-channel`，`pd-cli/src/index.ts:65,436`）与 `story-a-demo.ts:124`（`pd runtime synthetic story-a`，`index.ts:514`）。两者写 `validationStatus:'validated'` 但 sourceTaskId 为合成的 `task-synth-240` / `task-demo-<runId>` | §2「内化链每跳」把 `pi_artifacts` 描述为内化链独占载体；合成基线路径会向同表写非链工件（P3 卫生面） |

### 4.2 已主动排查、未发现断裂的面（记录以免误读为「只找到问题」）

- 注册表 `outputSchemaRegistry` 的 fail-loud 语义（`output-schema-registry.ts:62-65`）被 `pi-ai-runtime-adapter.ts:620-634` 与 `openclaw-cli-runtime-adapter.ts:870` 双消费者按 rc-3 正确实现（未知 ref 抛 `output_invalid`，缺 ref 走默认）。
- `mergeSystemPromptLayers` 的三个调用点（`pi-ai:588`、`l2:351/353`、`artificer-l2:243-247`）语义均与 §0.1 描述一致（底层 + 工具协议 + 追加层）。
- §6.4 全部 20 张 state.db 表行号零漂移。
- §6.1 状态机表与 `canTransitionTo` 实现逐边一致（6/6）。
- 「每条边的数据载体」16 行全部回源成功，未发现载体错配。
- 11 个入口的目标引用点全部存在，执行路径描述无事实错误（仅完整性问题见 NEW-1）。

---

## 5. 建议修正清单（报告原文 → 建议改后文）

> 说明：本核实只主张事实层修正；是否改报告由审计长裁决。所有「原文」为报告实际字符串（截取辨识段）。

| ID | 章节 | 原文 | 建议改后文 | 理由 |
|---|---|---|---|---|
| S-1 | §7.1 标题与表首 | `## 7.1 在途 OPEN PR 与本报告发现的交叉（基于 70d824c4，未含这些 PR）` + 「合入前先以本报告 §2 F3/F4 现状为基线评审其覆盖面」 | `## 7.1 已合并 PR 与本报告发现的交叉（基线 70d824c4）`，并删除/改写「在途」「合入前」措辞；各 PR 增注实际 `merged_at`（+0800） | 5 个 PR 全部已 `merged`（§2.4 A-4-01..05）；报告提交 `3e5722b4` 已含其合并提交，正文「不含这些 PR 的改动」与仓库事实不符 |
| S-2 | §7.1 #1698 行 | `#1698（PRI-720 Channel-aware DAG，Owner 已 REQUEST CHANGES 3 P1）` | `#1698（PRI-720 Channel-aware DAG；曾在 issue 评论中被判定「不建议合并」并指出 3 个 P1；后续 review 结论为 PASS，已于 09:13 合并）` | GitHub 正式 review 状态仅 1 条 `COMMENTED`（PASS）；P1 表述出自 issue comment，非 `REQUEST_CHANGES` 评审状态 |
| S-3 | §2 F10 表 | `abstraction_layer_v1（默认 OFF）｜openclaw-plugin/src/index.ts:468-479（runtimeGateFor）` | `openclaw-plugin/src/index.ts:479（runtimeGateFor；定义 :216，flag 判定 :141-157；另 :376/:421 同门）` | 区间已覆盖 :479（故非漂移）；仅建议把锚点收敛到调用行，避免 :468 被误读为调用点 |
| S-4 | §2.4 注册表 `artificer-rule-output-v2` 行「Schema 概要」 | `RuleCode 工件（ruleCode/submit_rulecode 语义，L2 循环产物）` | `ArtificerRuleOutput（implementationCode/goldenTraceCases/affectedTools/sourceTrace/generatedAt[＋可选 requiresContextVersion、evidenceRefs(v2 必填)]）；L2 循环经 submit_rulecode 工具提交` | 该 schema 无 `ruleCode` 字段名；`submit_rulecode` 是工具名而非 schema 字段 |
| S-5 | §2.4 注册表 `rollout-reviewer-output-v1` 行「Schema 概要」 | `review{decision∈approve_rollout/needs_revision/reject…}, rolloutDecision` | `review{decision,summary,confidence,requiredChanges,rolloutRisks,safetyChecks}, sourceTrace` | `RolloutReviewerOutputV1` 无 `rolloutDecision` 字段；该字段属 `activation-types.ts:38` 的 DispatchActivationInput |
| S-6 | §0 头部「审计对象」与 §7.1 | `main @ 70d824c4（PR #1692 合并后；不含 OPEN PR #1698/#1693/#1694/#1703/#1700 的改动）` | 若报告确实基于 `70d824c4` 内容取证：保留基线声明并注明「该基线早于 #1698/#1693/#1694/#1700/#1703 的合并」；**若报告实际基于提交时 main（`3e5722b4` 附近）读取代码**，则基线须改写，并重核 R-03/R-14/R-15（#1698 触及 `intake-to-internalization-bridge.ts`、#1693 触及 `artificer-output-typebox.ts`） | 已证 `285d1c81`/`be615da1`/`4c9e1b21` 是报告提交的祖先；R-03 所述漂移在该状态下已不成立（NEW-3） |
| S-7 | §0.2 | `且 §4 F-C1 证明即使打开 flag，manifest 路径也存在结构性死链` | 改为指向实际章节（如「见 §4 dreamer 卡」），或补上该编号的定义 | 报告全文无 `F-C1` 编号（rg 零命中），交叉引用悬空 |
| S-8 | §1.3 R-13 证据列 | `rollout-reviewer-output.ts:102-107,60 vs evaluator-output.ts:470-474` | `rollout-reviewer-output.ts:102-107 vs evaluator-output.ts:470-474；rollout-reviewer-prompt-builder.ts:60（「can be empty」明示）` | `,60` 不属于 `rollout-reviewer-output.ts` 的该语义位置，实为 prompt-builder 行 |
| S-9 | §2 F10 表（增补） | —（表末行为 11 项） | 增补 `signal_collector`（quiet/`false`，`signal-collector-host.ts:599-606`：LLM 分类器降级为纯关键词）与 `codex_conversation_ingestion`（quiet/`false`，`pd-hook.ts:156/166-168`：Codex 摄取整体关闭） | NEW-2 |
| S-10 | §2 入口清单（增补） | —（11 行） | 增补第 12 行：Codex hook 会话摄取 → governance admission → `ensureGovernanceDiagnosticianTask` → 异步建诊断任务（`pd-hook.ts:178-180` → `admission.ts:130-160` → `governance-signal-admission.ts:853-935`） | NEW-1 |
| S-11 | §2 「关键事实：`wakeOnce` 只扫 pending 和 retry_wait」 | 该句 | 补一句：过滤维度为 `isRunnerKind`，因此 `diag_rootcause/diag_distiller/diag_router` 子任务同样落入选域；无参 `wakeOnce`（`pd runtime internalization wake-once`）不受 peer-kind 限定 | NEW-4 |
| S-12 | §6.4 表速查 | 20 张表 | 增补 trajectory.db 侧 `governance_signal_admissions` / `governance_correction_rate_limits`（`governance-signal-admission.ts:341-367`）与 `governance_rollouts` / `governance_observations` / `governance_transcript_checkpoints` / `governance_pending_promotion_tails`（`governance-observation-store.ts:207,219,254,267`） | NEW-5 |

---

## 6. 核实方法与可复现性声明

- 行号一律取自 `git show 70d824c4:<path>`，未切换工作区分支，未修改任何既有文件。
- 判定依据仅限：源码文本、SQLite DDL 语句、GitHub 匿名 REST API 响应。
- 本次未执行：运行时取证（`~/.pd/` 状态库）、LLM 实测、CI 执行。凡未执行者均未在本文中声称已执行。
- 未使用任何密钥；GitHub 访问为匿名 GET。
- 本文档为核实产出，**不修改** `REPORT.md`；所有更正建议列于 §5 供审计长裁决。
