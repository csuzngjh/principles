# PRI-747 PD Repository Connectivity Audit — Phase 1

> 日期：2026-09-11
> 性质：**只读连接性审计**。无代码修改、无 PR、无 migration、无 flag 变更、未立新 Linear issue。
> 关联：Linear PRI-747（父单 PRI-744「PD Architecture Connectivity Audit：能力连接性治理系列」）；方法论 = AGENTS.md P2.1 Architecture Reality Audit（PR #1615 已落 main）。
> 审计问题：**Existing Capability but Disconnected** —— 已存在的模块/数据/契约/流程，因信息流断裂而未形成有效闭环。

---

## 附记（2026-09-12 收尾轮）

- **PR #1616（PRI-741）已合并**（2026-09-11T16:44:41Z，commit `4dce7d942`，收官时已是 origin/main tip）：**Finding 1 / Finding 2 随合并闭环**（生成端宿主语义接线 + OpenClaw 声明纠偏；F30 的注释修正亦属同 PR 范围）。其余 34 项发现不受该合并影响；全文行号仍以基线 `0ba58fc9c` 为准，引用以符号名为准。
- **主 checkout 异常已按无损口径处置**：审计收官后本地 main 曾被并发回拨至 `5d755be2e` 且 293 个文件滞留暂存区；经树哈希证明（index 树 == `0ba58fc9c^{tree}`，即暂存内容为已存在提交的树、非新工作）后，仅移动 ref（`reset --soft`，磁盘零字节变化）并 ff 回 `4dce7d942`。收官时 main == origin/main，tracked 区干净。
- 已观察到兄弟会话 **PRI-749（connectivity-fixes）** 与 PRI-750 的专用 worktree（均基于新 tip）——Top 3 建议的落地归属以 Owner 裁量为准，勿重复立项。

---

## 0. Baseline 与方法

```
commit: 0ba58fc9c (= origin/main, 2026-09-11)
        本地 main 自 e144d21f9 fast-forward 31 个 commit（含 PR #1615 P2.1 规则）。
```

方法：五路并行只读追踪（P0-1 RuleCode 管线 / P0-2 Pain→Learning / P0-3 Runtime Governance / P1-1 Console / P1-2 Host Adapter），每条链按 Producer → Storage → Consumer → Contract → 信息损失点取证；高影响结论经第二遍独立抽查复核（同一 file:line 人工复验）。搜索为负结果的条目（"NONE — searched X,Y,Z"）均列出实际搜索词。

**注意**：PR #1616（PRI-741 RuleCode semantic alignment）在审计时点仍为 **OPEN**，其修复内容不在本基线内；下述 F1 按 main 现状取证。

---

## 1. 已验证连通的骨干（先记录"什么是通的"）

以下链路经代码取证**闭环成立**，后续 SPEC 不得假设其缺失或重复建设：

- **Pain→Diagnosis→Principle 主链**：openclaw-plugin `hooks/pain.ts` / `hooks/after-tool-call-helpers.ts` → `pain_events`（trajectory.db）→ `PainSignalBridge`（内存载荷→state.db `tasks` kind=diagnostician）→ `SplitDiagnosticianRunner`（router→rootCause→distiller）→ `diagnostician-committer.ts` 同事务写 artifacts + `principle_candidates` → admission gate → `CandidateIntakeService.intake` → principle ledger + dreamer 种子任务。
- **内部化 job graph**：dreamer→philosopher→scribe→artificer→evaluator→rollout_reviewer（`internalization-job-graph.ts:28-34`），repair loop 反馈**已接通**（`adversarialFeedback`/`repairFeedback`/`priorValidatorErrors` → `artificer-prompt-builder.ts:43,59,67`）。
- **审批→激活→执行读取端**：`ActivationDispatcher.enqueueForApproval` → `approvals` 表 → CLI `runtime-activation.ts` + Console `ApprovalsConsoleModel` 完成 → `RuleHostWriter.activate`（可靠性门 + shadow-first）→ `activations` 表 → **执行读取端存在**：plugin `core/rule-host.ts` 与共享 `host-runtime/production-rulehost-gate.ts`（OpenClaw 与 Codex `pd-hook.ts:122` 两宿主都接了读取）；prompt 通道经 `runtime-v2-prompt-activation-reader.ts` ← `hooks/prompt.ts:582`。**激活不是终态写入。**
- **统一 resolver 深模块（核心层成立）**：`resolveAgentRuntimeBinding`/`checkAgentRuntimeReadiness`（core）被 CLI（`resolve-runtime-from-pd-config.ts:141`）、consumer cycle（`internalization-consumer-cycle.ts:378-389`）、Console readiness（`pd-config-store.ts:1671`）共同消费；CLI/Console 工具语义 parity 有 pin 测试（`cli-console-tool-semantics-parity.test.ts`）。
- **host_tool_semantics resolver 边**：`.pd/host-tool-semantics/<hostKind>.json` 持久声明 → `host-tool-semantic-resolver.ts` union 合并（冲突 fail-loud）→ CLI activation/run-once、Console Approvals/Activations model、evaluator replay gateDeps 全部收敛于 `resolveWorkspaceHostToolSemantics`，无旁路。
- **Feature flag SSoT 唯一**：`DEFAULT_FEATURE_FLAGS`（feature-flag-contract.ts:190-413），Record 形式为派生；lifecycle census 有机器校验（`feature-flag-lifecycle.ts:39`）。
- **其他闭环**：`dead_letter_pains`（写→`pd pain retry` 重放）、`pending_agent_drafts`（写→Console feedback-reports）、`principle_applications`（写→Console Receipts/CLI stats/telemetry milestone）、`activation_evidence_snapshots`、shadow 决策（event log → shadow summary → promote 证据）、`governance_observations`（写→admission+quarantine CLI）、`pain_events.host_kind`/`canonical_pain_id`/`runtime_task_id`（多读取端，观测用途，符合设计）。

---

## 2. Findings

> 每条按工单模板：Component / Current Flow / Expected Flow / Evidence / Producer / Consumer / Classification / Recommendation / Confidence。
> 分类口径：**Missing Capability**=能力真不存在；**Disconnected Capability**=能力两侧都在、中间断线；**Duplicated Capability**=同一事实/职责多处独立实现且有漂移风险；**Dead Data**=有 producer 无 consumer（或反之）的静止资产；**Open Loop**=应闭环的反馈链有去无回。

### P0-1 RuleCode Pipeline

#### Finding 1 — RuleCode 生成的宿主语义输入断线：evaluator 已接通，artificer 仍是"代码盲"

- **Component**: ArtificerRunner / RuleCode Generation inputs
- **Current Flow**: 三个生产构造点均不传任何宿主语义：`host-runtime/src/internalization-consumer-cycle.ts:547-552`、`pd-cli/src/commands/runtime-internalization-run-once.ts:596-600`、`pd-cli/src/services/rulehost-pipeline-runner.ts:414-419`；`ArtificerPromptBuilderInput` 无 host 字段（`artificer-prompt-builder.ts:31-84`），prompt 示例硬编码 `write_file`（:150-156），contract 停在 `artificer-output-v2.prompt.v4`（:253）。**同一 consumer-cycle 里相邻的 evaluator case 却拿到** `gateDeps: createProductionGateDeps({toolSemantics…})` + `hostToolCatalog`（`internalization-consumer-cycle.ts:576-590`，注释明言防"LLM 凭记忆判非标准工具名"）。
- **Expected Flow**: 生成期与校验期使用同一宿主事实（hostKind + real-name→canonicalKind 投影），生成出的代码引用真实工具名。
- **Evidence**: 上列 file:line；`RuleHostInput`（core runtime-v2）在执行期由 `production-rulehost-gate.ts:332` 构造——执行端契约存在，但生成端对宿主零感知。
- **Producer**: host registry / `.pd/host-tool-semantics/*.json`（已存在）。
- **Consumer**: ArtificerRunner（未接线）。
- **Classification**: **Disconnected Capability**
- **Recommendation**: **Connect existing capability** —— 修复已成型：PR **#1616**（PRI-741，prompt v5 + `ArtificerHostSemanticContext` + 四入口接线，36 文件 +1013/−130），审计时点 OPEN 未合并。合入即闭环。
- **Confidence**: High（本人二次抽查复核 `internalization-consumer-cycle.ts:547-590` 两 case 对照）。

#### Finding 2 — OpenClaw 幻影工具词表穿透激活可靠性门（信号与宿主现实断连）

- **Component**: openclaw-plugin tool vocabulary → activation reliability gate
- **Current Flow**: `constants/tools.ts:12-20` 声明宿主不存在的工具名（`write_file`/`edit_file`/`replace`/`insert`/`patch`、`bash`/`run_shell_command`/`execute`/`shell`/`cmd`）→ `OPENCLAW_TOOL_SEMANTIC_MAPPINGS`（`constants/tool-semantics.ts:45-50`）→ `hasHostTool(幻影名)=true` 使 `rule-host-writer.ts:277-295` 可靠性门被穿透；同一词表被当作合法目录教给 evaluator（`internalization-auto-consumer-service.ts:57-60`）并持久化为 `.pd/host-tool-semantics/openclaw.json`（:112-117）。
- **Expected Flow**: 声明 = 宿主 gate 实际可达的工具面（Codex 侧即为实证：仅 `Bash|apply_patch`）。
- **Evidence**: 上列 file:line；对照 `docs/audit/rulecode-semantic-alignment-phase0-verification.md` §2-§3。
- **Producer**: `constants/tools.ts`。
- **Consumer**: reliability gate、evaluator 目录、declaration 持久化。
- **Classification**: **Disconnected Capability**（激活就绪信号与宿主真实工具面断连）
- **Recommendation**: **Connect** —— 同属 PR #1616 的 OpenClaw declaration correction 范围；合并即修。
- **Confidence**: High。

#### Finding 3 — `painReasonSummary`：3+ 消费者、0 生产者

- **Component**: rule artifact 字段 painReasonSummary
- **Current Flow**: rule artifact 装配器 `evaluator-runner.ts:3063-3086`（`ruleContent`）从不写该字段；scribe/philosopher/dreamer prompt builder 亦无。消费端却在等它：审批 `triggerReason`（`rule-host-writer.ts:377-393`，恒落通用兜底文案）、receipt `sourceSummary`（`principle-receipt-metadata.ts:69-83,199`，恒缺席）、`gate-block-helper.ts:312`、evaluator 契约提及（`evaluator-prompt-builder.ts:180`）。仅合成 demo 会设置（`story-a-demo.ts:88,138`、`proven-channel-baseline.ts:123`）。
- **Expected Flow**: 诊断/评估阶段把 pain 摘要写入 rule artifact → 审批卡与 gate 阻断提示携带真实"为何有此规则"。
- **Evidence**: `rg painReasonSummary packages/*/src` 全量命中均为消费端/测试端；producer 搜索为空。
- **Producer**: **NONE**。
- **Consumer**: `rule-host-writer.ts`、`principle-receipt-metadata.ts`、`gate-block-helper.ts`。
- **Classification**: **Missing Capability**（inverted：消费槽已建、生产端缺失）
- **Recommendation**: **Create**（最小实现：evaluator 装配 `ruleContent` 时从候选/诊断证据派生写入；不新增子系统）。
- **Confidence**: High。

#### Finding 4 — 双运行时执行读取端并行且已漂移（资源预算只在共享路径）

- **Component**: plugin `core/rule-host.ts` vs host-runtime `production-rulehost-gate.ts`
- **Current Flow**: 两处各自实现同一 `activations JOIN pi_artifacts LEFT JOIN activation_control_states` 查询与 skip 语义，按 workspace 的 `runtimeGate` flag 二选一（`openclaw-plugin/src/index.ts:416-425`）。漂移实据：`MAX_ACTIVE_RULES`/`RULE_SOURCE_BYTES`/`RULE_BATCH_SOURCE_BYTES`/512KB artifact 上限/3s deadline 只存在于共享路径（`production-rulehost-gate.ts:220,230,292,341`），plugin 路径 grep 为空。
- **Expected Flow**: 单一 gate 实现，plugin 仅做宿主适配（或至少共享查询与预算常量）。
- **Evidence**: 上列 file:line。
- **Producer**: `activations` 表（共同）。
- **Consumer**: 两条执行路径（按 flag 分叉）。
- **Classification**: **Duplicated Capability**
- **Recommendation**: **Remove duplicate**（plugin 路径收敛到共享 gate；属架构收敛工作，立单处理，勿顺手改）。
- **Confidence**: Medium（宿主差异可能是有意分层；漂移事实为 High）。

### P0-2 Pain → Learning Pipeline

#### Finding 5 — 行为改变回执（`principle_applications`）不进入任何学习/晋升/退役决策：反馈止步于仪表盘

- **Component**: Behavior Change → Feedback 环
- **Current Flow**: effect 回执持续落库（`rule_blocked`/`auto_correct_applied`：`hooks/gate.ts:175,345,636`；`prompt_injected`：`hooks/prompt.ts:703`；`self_reported`：flag 默认关，`hooks/llm.ts:200`、`hooks/trajectory-collector.ts:134`），但消费者全是只读展示：`pd-cli principles-stats.ts:302-320`、Console `ReceiptsConsoleModel.ts:177,187,266`、telemetry EXISTS 探针（`milestone-readers.ts:174-175`）。`promotion-readiness-evaluator.ts:5-16,36-80` 只吃静态检查 + rulecode shadow summary；admission gate 与诊断链均不读回执。
- **Expected Flow**: 回执证据作为晋升/退役/再准入的一个输入（哪怕先做成只读报告的建议项）。
- **Evidence**: 上列 file:line；"promotion/retirement 消费 receipts"搜索为空。
- **Producer**: `principle-application-ledger.ts:75,146,216`。
- **Consumer**: 决策侧 **NONE**（仅展示侧）。
- **Classification**: **Open Loop**（P0-2 定义中 "Behavior Change → Feedback" 的字面断点）
- **Recommendation**: **Close feedback loop**（立单设计最小决策消费面；勿直接改晋升门）。
- **Confidence**: High（无读取端为代码实据；"应作为决策输入"为设计判断）。

#### Finding 6 — `pain_diagnoses`：flag 默认关的写入端 + 全仓零生产读取端

- **Component**: Pain Diagnosis Persistence（PRI-453 家族）
- **Current Flow**: 写入被 `pain_diagnosis_persistence` flag 门控且 **enabled:false**（`feature-flag-contract.ts:376`）；链路 `pain-signal-bridge.ts:652-690` → `runtime-state-manager.ts:546` → `sqlite-pain-diagnosis-store.ts:113`。唯一读取方法 `getDiagnosesByPainId`（:127）仅被测试调用。Console 证据链实际改用 `artifacts.content_json`+`tasks.diagnostic_json` 重derive（`EvidenceChainConsoleModel.ts:316-327`）。
- **Expected Flow**: 诊断→pain 归因历史有 Owner 可见消费面（证据链页是天然读取端）。
- **Evidence**: 上列 file:line；pd-cli/pd-console/openclaw-plugin/host-runtime 全量搜索无生产读取端。
- **Producer**: `persistPainDiagnosis`（flag 关闭时无写入）。
- **Consumer**: **NONE**（仅测试）。
- **Classification**: **Dead Data**（兼 Open Loop）
- **Recommendation**: **Connect**（让证据链页消费它）或 **Remove**（彻底退役该 store）；二选一需 Owner 决策，勿维持"开着也没人读"状态。
- **Confidence**: High。

#### Finding 7 — 异步诊断任务在宿主中立/OpenClaw 路径无消费者：pain 在 Codex 之外静默滞留

- **Component**: diagnostician task consumption
- **Current Flow**: `pd pain record` asyncMode 与 codex admission 都会入队 diagnostician 任务（`pain-signal-bridge.ts:408-423`、`governance-signal-admission.ts:21-23`）。消费端仅 Codex worker（`codex-adapter/src/worker/workspace-worker.ts:220`）与手工 `pd diagnose run`（`diagnose.ts:117`）；OpenClaw auto-consumer 的 kind 集合只含 dreamer…rollout_reviewer（`internalization-consumer-decision.ts:10,25-32`），不含 diagnostician。CLI 侧自己也在输出里披露此局限（`pain-record.ts:446-455,505-509`）。
- **Expected Flow**: 宿主中立循环消费 diagnostician 任务（任一宿主入队的 pain 都能被任一入口消化）。
- **Evidence**: 上列 file:line。
- **Producer**: pain ingress（多宿主）。
- **Consumer**: 仅 Codex worker + 手工 CLI。
- **Classification**: **Open Loop**（亦可视作宿主中立 Missing Capability）
- **Recommendation**: **Connect**（把 diagnostician kind 纳入 auto-consumer 决策集）。
- **Confidence**: High。

#### Finding 8 — 人工审批通过的 correction sample 死于 JSONL 导出：被采纳的人类信号无人消费

- **Component**: correction sample review 闭环
- **Current Flow**: 拒绝半环连通（rejected → 回灌 pain，`trajectory.ts:1522-1548`）；批准半环终止于 `exportCorrections`（`trajectory.ts:1563`，caller `commands/export.ts:37`）产出的 JSONL 文件——仓内无任何消费者（模型训练面已随 PRI-449 移除，`internalization-job-graph.ts:25-27`）。
- **Expected Flow**: approved 样本反哺诊断上下文/原则生成证据，或明示退役。
- **Evidence**: 上列 file:line；export 消费者搜索为空。
- **Producer**: `maybeCreateCorrectionSample`（:1838,1901）+ review 命令。
- **Consumer**: **NONE**（仓内）。
- **Classification**: **Open Loop**
- **Recommendation**: **Close feedback loop** 或明示 **Ignore**（若 Owner 认定导出面即终点，需写明）。
- **Confidence**: High。

#### Finding 9 — `evolution_tasks`/`evolution_events`：PRI-737 删除生产者后，读取端永久孤儿化

- **Component**: evolution CLI 读取链
- **Current Flow**: 写入方法 `recordEvolutionTask`/`recordEvolutionEvent`（`trajectory.ts:798,906`）在 PR #1613 删除 legacy worker 后全仓无调用者（legacy 队列在 SDK writer 里显式禁用，`pain-signal-observability.ts:16-17`）；读取端仍在服务：`pd evolution tasks list/show`（`evolution-tasks-list.ts:8`、`evolution-tasks-show.ts:10`）、quality-scorecard `data-extractor.ts:54` —— 永久消费冻结/空表。
- **Expected Flow**: 表与读取端随 worker 一起退役，或保留读取端并在空态显式说明。
- **Evidence**: 上列 file:line；`recordEvolutionTask(` 调用者搜索仅剩定义。
- **Producer**: **NONE**。
- **Consumer**: pd-cli 两条命令 + scorecard。
- **Classification**: **Open Loop**（reader 比 writer 活得久）
- **Recommendation**: **Remove**（随 PRI-737 的数据保留决策一并处置；`docs/architecture/PRI-737-evolution-worker-reality-audit.md:170` 已挂账）。
- **Confidence**: High。

#### Finding 10 — trajectory.db 五处只写/零读资产

- **Component**: `task_outcomes` / `trust_changes` / `exports_audit` / `sample_reviews` / `sessions.metadata_json`
- **Current Flow**: `recordTaskOutcome`（`trajectory.ts:782,785`）**无任何调用者**（定义即终点），表 DDL 在 3 处重复创建（:260、`pain-signal-observability.ts:192`、`runtime-init.ts:255`）；`trust_changes` 仅 legacy events.jsonl 导入写入（:1772）；`exports_audit` 每次导出写（:1600,1621,1955-1957）；`sample_reviews` 写入（:1472、`trajectory-store.ts:149`）无 SELECT；`sessions.metadata_json`（`pain-signal-observability.ts:382-396`，值恒 `{source:'pd-runtime-v2'}`）无读取。
- **Expected Flow**: 各表要么有消费者，要么不建/不写。
- **Evidence**: 上列 file:line；SELECT 读取端全仓搜索为空。
- **Producer**: 如上。
- **Consumer**: **NONE**。
- **Classification**: **Dead Data**
- **Recommendation**: **Remove**（DATA_CLEANUP_GUIDELINES 约束下的清理单；`sample_reviews` 若定性为 by-design 审计留痕则记录后保留）。
- **Confidence**: High。

#### Finding 11 — legacy 进化 reducer 内的死亡原则创建 API + 仅靠历史回放的原则图

- **Component**: `EvolutionReducerImpl.createPrincipleFromDiagnostician`（`evolution-reducer.ts:234,47-48`）
- **Current Flow**: 零调用者；reducer 自身 `onPainDetected`（:757-770）显式把创建权让给 diagnostician。原则图仅靠回放 legacy `candidate_created` 事件（:638-662）——而现行代码无任何 emitter。仍连通的部分：probation/active 读取（`hooks/prompt.ts:593-597`、`after-tool-call-helpers.ts:378-390`）与 `trackPrincipleValue`（:577-607 → ledger value metrics → Console）。
- **Expected Flow**: 死亡创建 API 移除；legacy 回放原则的存续定性（是否仍有 workspace 依赖）需确认。
- **Evidence**: 上列 file:line。
- **Producer**: **NONE**（创建 API）。
- **Consumer**: reducer 内部回放。
- **Classification**: **Dead Data**
- **Recommendation**: **Remove**（小步；与 Finding 9 同单处置）。
- **Confidence**: High（无调用者）；Medium（legacy 回放原则的现实存量）。

#### Finding 12 — CLI pain 录入路径缺 trajectory 轮次证据接线（与 plugin 路径不对称）

- **Component**: `pd pain record` → diagnosis context
- **Current Flow**: plugin 把 `trajectoryTurnReader` 接进诊断上下文（`hooks/pain.ts:106-122` → `pain-signal-runtime-factory.ts:568`）；`pain-record.ts:307-316` 构造 `PainToPrincipleService` 时未传——CLI 诊断只靠 state.db 历史（`SqliteContextAssembler` 依赖集，:564-569）。部分补偿：CLI 单独传绑定会话的 evidence 条目（`pain-record.ts:129,159`）。
- **Expected Flow**: 同一诊断能力在两个入口同深。
- **Evidence**: 上列 file:line。
- **Producer**: trajectory turns（已存在）。
- **Consumer**: CLI 诊断上下文（未接线）。
- **Classification**: **Disconnected Capability**
- **Recommendation**: **Connect**。
- **Confidence**: Medium（接线事实已验证；运行时 prompt 内容差异未实测）。

#### Finding 13 — trajectory "三轨"无收敛点（第二真相源风险已被注释自认）

- **Component**: trajectory 存储层
- **Current Flow**: ①`openclaw-plugin/src/core/trajectory.ts`（2054 行，16 表 DDL 事实所有者）；②`principles-core/src/trajectory-store.ts`（SDK 抽取，头注自述复制类型、"do NOT import from openclaw-plugin"）；③`runtime-v2/store/trajectory/*` locator（同名不同库）。DDL 在 `pain-signal-observability.ts:90` 注释自认"intentionally duplicated"。无收敛点。
- **Expected Flow**: 单一 schema 所有者（已挂账 PRI-730 SPEC，`PD-complexity-reduction-audit.md:17,42`）。
- **Evidence**: 上列 file:line。
- **Producer/Consumer**: 同库多路读写。
- **Classification**: **Duplicated Capability**
- **Recommendation**: **Ignore**（本轮；PRI-730 已在轨，勿重复立单）。
- **Confidence**: High。

### P0-3 Runtime Governance Pipeline

#### Finding 14 — Codex 宿主的 gate 决策流零持久化：执行反馈只到 stderr 为止

- **Component**: Codex RuleHost gate feedback
- **Current Flow**: `codex-adapter/src/pd-hook.ts:122` → `createProductionHostRuntime({hostKind:'codex'})` → `production-rulehost-gate.ts`（全文件零事件/回执写入，grep `record|EventLog|trajectory|telemetry|gate_block` 为空）→ 决策经 stdout 返回、warnings 转 stderr 文案（`pd-hook.ts:123`，"the hook failed open"）为止。对照：OpenClaw 共享路径对同一 gate 有完整记账（`hooks/gate.ts:536-604` 写 `rulehost_evaluated`/`rulehost_blocked`/回执）。
- **Expected Flow**: Codex 侧 gate 决策流同样落 event log/回执 → shadow summary、激活核算、推广证据能看到 Codex 流量。
- **Evidence**: 上列 file:line；`onBeforeToolResult`/`onAfterToolResult` 核算钩仅存在于 OpenClaw wrapper（`openclaw-host-runtime.ts:29-31,136,143`），不在 `createProductionHostRuntime` 契约内。
- **Producer**: `production-rulehost-gate.ts` 决策。
- **Consumer**: **NONE**（任何 PD store）。
- **Classification**: **Open Loop**
- **Recommendation**: **Close feedback loop**（把核算钩纳入共享 runtime 契约；注意与 Finding 4 的收敛方向一致）。
- **Confidence**: High（本人二次抽查复核 pd-hook.ts:110-130 与 gate 文件零写入）。

#### Finding 15 — 六个已注册 flag 无任何生产读取端（其中两个被安装器当作控制项呈现）

- **Component**: feature flags: `code_tool_hook`、`defer_archive`、`painEvidenceAdmission(+Default)`、`empathy_observer`、`gfi`、`internalization_core_grounding`、`evolution_worker`
- **Current Flow**: 全部在 `DEFAULT_FEATURE_FLAGS` 注册、Console 可 toggle 且返回成功（`pd-config-store.ts:1060`），但 `loadFeatureFlag*/isFeatureEnabled/flags.<name>` 生产读取为零（逐一名搜索；其余命中均为同名 activation **channel** 字面量或注释）。`code_tool_hook`/`defer_archive` 属 `category:'core'`，文档语义含操作员紧急停用（`pd-config-feature-flags.ts:84-93`），且安装器向 Owner 呈现（`create-principles-disciple/src/prompts.ts:196-197`）——实际 kill switch 是 `global_rulecode_pauses`（两宿主都认）。`painEvidenceAdmission` 的"回滚=重启用 Gate A"承诺已随 PRI-651-B1 无条件化失效（`gate-block-helper.ts:206-207` 等三处注释明言 Gate A fallback removed）。lifecycle census 多处陈旧（`feature-flag-lifecycle.ts:104-135` 仍列已删消费者）。
- **Expected Flow**: 注册 flag = 真实控制点；或注册表退役死 flag。
- **Evidence**: 上列 file:line；反例对照（确实被读的 flag 清单见附录 A）。
- **Producer**: flag registry + Console toggle。
- **Consumer**: **NONE**。
- **Classification**: **Dead Data**（附赠：误导性紧急停用/回滚叙事 + census 漂移）
- **Recommendation**: **Remove**（死 flag 退役走 flag SSoT 流程；census 同步修正）。
- **Confidence**: High。

#### Finding 16 — Surface registry 的运营覆盖路径不可达；与 feature flag 平行的第二控制分类学

- **Component**: `PLUGIN_SURFACE_REGISTRY` + `guardHook/guardService`
- **Current Flow**: `isSurfaceEnabled(surfaceId)` 无 overrides 参数（`surface-guard-policy.ts:161`），文档化的"操作员可紧急停用 `hook:before_tool_call`"路径（`plugin-surface-registry.ts:228-236` 注释）生产不可达：`checkSurfaceGuard()`（`openclaw-plugin/src/index.ts:230`）同样无覆盖源。同时 surface 分类与 flag 分类并行且口径不一（如 `service:correction-observer` surface=core/always-on，flag `correction_observer`=quiet/default-off；真权威是 flag）。
- **Expected Flow**: 覆盖源（config/env）接入 guard；或 surface registry 降级为纯分类、控制权归一 flag。
- **Evidence**: 上列 file:line。
- **Producer**: registry `enabledByDefault`（唯一生效杠杆）。
- **Consumer**: overrides **NONE**。
- **Classification**: **Disconnected Capability**
- **Recommendation**: **Connect**（补覆盖源）或 **Remove**（删文档化承诺，surface 只做分类）。
- **Confidence**: High（不可达）；Medium（原意解读）。

#### Finding 17 — 畸形 config 的失败语义在三个 loader 间分叉（同一输入三种行为）

- **Component**: `.pd/config.yaml` 加载层
- **Current Flow**: CLI fail-loud（`pd-config-loader.ts:110` → 执行路径拒跑，`resolve-runtime-from-pd-config.ts:115`）；plugin/host-runtime 的 `loadFeatureFlagFromConfig` fail-open 到注册默认值且只 `logger.warn`（`host-runtime/src/pd-config.ts:112-123`），hook 消费端只看 `.enabled` 不看 `source:'malformed'`（`gate.ts:172,341,633` 等）；Console 落默认+报错展示（`pd-config-store.ts:248`）。同一畸形输入下：`resolveObserverConfig` fail-closed（`core/pd-config-loader.ts:61-67`）vs gate 关键 flag fail-open（default-on 的 `principle_receipt_ledger` 继续执法；Owner 手动开的 default-off flag 静默回退 OFF），且无 event store 痕迹（违 rc-9 精神）。
- **Expected Flow**: 共享 loader + 单一文档化失败语义；gate 关键读取带 provenance。
- **Evidence**: 上列 file:line。
- **Producer**: 同一 config 文件。
- **Consumer**: 三套解释。
- **Classification**: **Duplicated Capability**（I/O 包装可接受，**回退解释分叉**不可接受）
- **Recommendation**: **Connect**（归一到 host-runtime loader 语义，或至少让 `source:'malformed'` 可观测）。
- **Confidence**: High（事实）；Medium（fail-open 是否既有产品决策）。

#### Finding 18 — legacy gate 抛异常路径无持久化（fail-open 无账）

- **Component**: OpenClaw legacy `before_tool_call` gate
- **Current Flow**: `gate.ts:425-427` `catch → logger.warn('allowing conservatively')`；此时 `rulehost_evaluated`（:132-147）未写，外层因无异常逃逸而记 `hook_execution` **success**。带内失败路径有 `evaluation_failed` 映射（:100-107），throw 路径绕过它；`recordRuleHostUnhealthy`（`event-log.ts:227`）在该路径不可达。
- **Expected Flow**: 抛异常也留 `evaluation_failed`/`unhealthy` 事件（fail-open 策略本身是有意设计，缺的是持久化）。
- **Evidence**: 上列 file:line。
- **Producer**: evaluateDetailed throw。
- **Consumer**: **NONE**。
- **Classification**: **Open Loop**（小）
- **Recommendation**: **Close feedback loop**。
- **Confidence**: High。

#### Finding 19 — 治理面零散死资产（合并一条）

- **Component**: `computeEffectiveFlags`（legacy 计算，`pd-config-feature-flags.ts:43` 注释自述已被替代，生产零调用）；`recordGateBypass`/`gate_bypass` 事件（`event-log.ts:146,281` 定义+脱敏项，零发射者）；`PD_HOST_CODEX_ENABLED` env（`codex-host-installer.ts:181` 写入，全仓零读取，Codex 实际读 config flag `host.codex`，`pd-hook.ts:94`）；`resolveObserverConfig` 自行重实现 profile 就绪检查（`core/pd-config-loader.ts:85-96`，未走 core `checkAgentRuntimeReadiness`，当前 parity 成立、漂移风险存在）；Console 三个 raw-YAML getter 绕过 effective resolver（`pd-config-store.ts:718-777,795-836,883-919`）。
- **Classification**: **Dead Data**（前三）/ **Duplicated Capability**（后二，Low）
- **Recommendation**: **Remove** / **Connect**。
- **Confidence**: High。

### P1-1 Console Architecture

#### Finding 20 — Signal Keywords 整页 UI 无后端（7 个 API 函数全是自声明 stub）

- **Component**: `SignalKeywordsPage`（`#/control-center/signal-keywords`，`App.tsx:195`）
- **Current Flow**: `ui/utils/signal-keywords-api.ts:38-160` 七个函数全部返回 `{success:false, reason:'endpoint_not_implemented'}`，目标端点仅存在于注释（:28）；server 路由搜索为空。stub 文案对用户诚实（rc-9 合规），但页面即空壳。
- **Expected Flow**: 端点落地或页面暂缓上线。
- **Producer**: **NONE**（server 侧）。
- **Consumer**: 页面 + 3 个 section 组件。
- **Classification**: **Missing Capability**（自声明的 Phase 2）
- **Recommendation**: **Create**（按注释中的 `/api/plugins/principles/signal-keywords` 立单）或暂缓页面入口。
- **Confidence**: High。

#### Finding 21 — UI 调用不存在的 `GET /api/v1/lifecycle/state`：诊断采集永久降级

- **Component**: Report Problem diagnostics collector
- **Current Flow**: `ReportProblemValidators.ts:337` 请求 `/api/v1/lifecycle/state`；server 仅实现 `/api/v1/lifecycle/principles/:id`（`routes/lifecycle.ts:29`）。UI 显式编码了 404 回退到 `/api/health` checks（:357-397），`recentEvents` 因此永久来自 health 探针。读模型其实已存在（`LifecycleConsoleModel.ts`），只差路由。
- **Expected Flow**: 暴露 lifecycle state 投影路由。
- **Producer**: `LifecycleConsoleModel`（已存在，未接线）。
- **Consumer**: `ReportProblemPage.tsx:717-725`。
- **Classification**: **Missing Capability**（接线路由缺失）
- **Recommendation**: **Create**（一条只读路由即可闭合）。
- **Confidence**: High。

#### Finding 22 — 五个已建成、UI 永不消费的 server 端点（其中失败任务详情直接影响 Owner 处置质量）

- **Component**: dead console API surface
- **Current Flow**: `GET /api/v1/failed-tasks/:id`（`failed-tasks.ts:536-560`，返回 task+runs+lastError+diagnostics）——UI 只调列表（`FailedTasksPage.tsx:241`）；`GET /api/v1/approvals` + `GET /api/v1/approvals/:id`（`approvals.ts:62,95`）——UI 只用 `/grouped|/approve|/reject|/edit`（`api.ts:487-510,818`，本人复核）；`GET /api/v1/intent-decisions/:id`（`intent-decisions.ts:399-424`）；`GET/PATCH /api/workspaces/:name`（`workspaces.ts:83,93`）。仅 BDD/e2e 测试消费部分端点。
- **Expected Flow**: UI 消费（尤其 FailedTasksPage 应在详情面板呈现已建好的诊断详情），或端点退役。
- **Producer**: 对应 ConsoleModel/Store（全部健在）。
- **Consumer**: **NONE**（UI 侧）。
- **Classification**: **Dead Data**
- **Recommendation**: **Connect**（`failed-tasks/:id` 优先——Owner 现在审失败任务时看不到为该页建的诊断详情）；其余端点评估后 Connect 或 Remove。
- **Confidence**: High。

#### Finding 23 — Console 只投影 trajectory.db 14+ 张表中的 2 张：Owner 不可见状态清单

- **Component**: Console × trajectory observability store
- **Current Flow**: Console server 全量 SQL 只触 `pain_events`+`gate_blocks`（`EvidenceChainConsoleModel.ts:195-211`）；correction-sample 审核队列、evolution 管道、trust 变化、principle events、exports audit、task outcomes 全部仅 CLI 可见（`pd samples list/review`、`pd evolution tasks *`、`pd quality-scorecard`、`pd trajectory/*`）。
- **Expected Flow**: 关键治理状态（至少 sample review 队列）有 Console 投影。
- **Producer**: `trajectory.ts` 16 表写入链（健在）。
- **Consumer**: Console **NONE**。
- **Classification**: **Missing Capability**（投影缺失，数据不缺）
- **Recommendation**: **Create**（按 Owner 使用频率挑 1-2 张表先投影，勿全量）。
- **Confidence**: High。

#### Finding 24 — `codexGovernance` health 块：每 5 分钟 shell 出一次 `pd health`，结果无人渲染

- **Component**: `GET /api/health` 的 codexGovernance 附加块
- **Current Flow**: `health.ts:25-43,64-89` 子进程计算并附挂；`grep codexGovernance src/ui` 零命中，UI 只消费 `checks/overall/versions/platform`。
- **Expected Flow**: UI 渲染或该块移除（当前是纯开销）。
- **Producer**: `CodexGovernanceHealthModel`。
- **Consumer**: **NONE**。
- **Classification**: **Dead Data**
- **Recommendation**: **Connect**（展示）或 **Remove**（停算）。
- **Confidence**: High。

#### Finding 25 — 恢复审计日志只写不读，且 CLI 恢复根本不写：同一动作两套审计口径

- **Component**: failed-task recovery audit
- **Current Flow**: Console 恢复追加 append-only JSONL（`failed-tasks.ts:508` → `recovery-actions-log.ts:98`）；`listRecoveryActions`（:151，已导出 barrel）在 pd-console/pd-cli 零调用。CLI `pd runtime recovery failed-tasks`（`index.ts:877-918`）做同样状态变更但**不写审计**。
- **Expected Flow**: 两个入口同一审计；审计日志有读取面（如 FailedTasksPage 详情）。
- **Producer**: Console 恢复路径。
- **Consumer**: **NONE**。
- **Classification**: **Open Loop**
- **Recommendation**: **Close feedback loop**（CLI 补审计 + 恢复历史投影）。
- **Confidence**: High。

#### Finding 26 — Owner 决策历史无投影：收件箱是前向-only 的

- **Component**: owner-decisions
- **Current Flow**: `POST …/resolve` 持久化 `ownerResolutions` 并翻任务状态（`owner-decisions.ts:259-265` → `owner-resolution-service.ts:220-290`）；读取端只查 `status='needs_human_review'`（`OwnerDecisionConsoleModel.ts:259,359`）。决议后条目消失，无 `/resolved`、无历史路由——Owner 无法复查自己的决策记录。
- **Expected Flow**: 决策历史可查（治理审计的基本面）。
- **Producer**: resolve 动作（持久化健在）。
- **Consumer**: **NONE**（历史维度）。
- **Classification**: **Open Loop**
- **Recommendation**: **Create**（历史查询路由 + 页面区块）。
- **Confidence**: Medium-High。

#### Finding 27 — "Owner 注意力"被独立推导 4 次，UI 每帧合并两个计数器

- **Component**: governance queue / approvals grouped / owner-decisions / governance experience
- **Current Flow**: 四个 server model 各自决定"什么需要 Owner"（`GovernanceConsoleModel.ts:24-33` 状态机、`ApprovalsGroupedConsoleModel`、`OwnerDecisionConsoleModel`、`GovernanceExperienceCollector`）；`NotificationProvider.tsx:53-67` 同时轮询 queue 与 owner-decisions 并在两个 total 间取值兜底；FocusPage 同屏渲染三个面（`FocusPage.tsx:1107-1123`）。
- **Expected Flow**: 单一"待 Owner 注意"投影，其余为派生视图。
- **Classification**: **Duplicated Capability**
- **Recommendation**: **Remove duplicate**（收敛计数语义；UI 兜底合并是最先可见的漂移点）。
- **Confidence**: High（重复实据）；危害性判断留给设计轮。

#### Finding 28 — 同一事实的多处独立解释：review 状态 ×3、health 双词表、receipt 双聚合

- **Component**: status/health/receipts 派生
- **Current Flow**: ①principles 审定状态在 server SQL（`principles.ts:74-123`）、`PrinciplesConsoleModel.ts:304-358`、UI `PrinciplesPage.tsx:54-58` 三处独立推导；②Console `HealthCheckModel`（healthy|degraded|error）与 CLI `pd health`（ready|not_ready、candidateLedgerConsistency）词表不相交，可出现 Console=healthy 而 CLI=degraded；③receipt 计数 Console 与 `pd principles stats` 双聚合，且 injection-fidelity 指标（截断/重复/字符数）只有 CLI 有——Console 投影缺失。
- **Classification**: **Duplicated Capability**（+injection-fidelity 为 **Missing Capability**）
- **Recommendation**: **Connect**（状态派生归一 server 单点；health 明确双词表的分工或归一；injection-fidelity 补 Console 投影）。
- **Confidence**: High。

#### Finding 29 — PRI-629 收件箱已真实接线，但三条旁路仍在

- **Component**: Owner decision 统一出口
- **Current Flow**: 收件箱渲染/决议链完整（`FocusPage.tsx:1014,1107-1123`、`OwnerDecisionCard.tsx:48`、侧栏 badge）。旁路：①Focus 页分组审批卡仍可绕过收件箱直接 approve/reject（`FocusPage.tsx:386-397`）；②CLI `pd activation approve`（`runtime-activation.ts:1197,1223-1284`）显式自述"不走 Console 闭环"；③CLI 恢复无收件箱/无 owner identity/无审计（见 Finding 25）。
- **Classification**: **Disconnected Capability**（统一化未完成）
- **Recommendation**: **Connect**（旁路要么并入收件箱、要么文档化为合法出口）。
- **Confidence**: High。

### P1-2 Host Adapter Boundary

#### Finding 30 — Codex 工具面两处独立声明 + 死证据指针

- **Component**: codex-adapter ↔ plugin bundle
- **Current Flow**: `CODEX_TOOL_SEMANTIC_MAPPINGS`（`codex-adapter/src/tool-semantics.ts:21-24`）与 hook matcher `"Bash|apply_patch"`（`plugins/principles-disciple/hooks/hooks.json:5`）独立手写，唯一纽带是一条测试（`codex-plugin-bundle.test.ts:154`）。漂移实据：`tool-semantics.ts:11-16` 注释把 matcher 位置指向**已退役**的 `codex-host-installer.ts:203`（该 installer `install()` 已 refuse，:247-268），实际 matcher 已迁至 plugin bundle。
- **Expected Flow**: matcher 从 mappings 生成或 CI 断言一致；注释指向真实位置。
- **Classification**: **Duplicated Capability**
- **Recommendation**: **Connect**（CI 一致性断言，最小修法）+ 修注释。
- **Confidence**: High。

#### Finding 31 — 宿主声明持久化被无关 flag 劫持：记录的 nextAction 承诺不成立

- **Component**: adapters → `.pd/host-tool-semantics/` registry 写入边
- **Current Flow**: OpenClaw 仅在 `internalization_auto_consumer` flag 检查通过后才保存声明（`internalization-auto-consumer-service.ts:92-103` 先 return，:112 才 save）；Codex 仅在 worker Step 7 保存（`workspace-worker.ts:261`），被同 flag 暂停的 early-return（:186-195）跳过；而所有 resolver 消费端不看该 flag 照常运行（`runtime-activation.ts:244`、`ApprovalsConsoleModel.ts:393`、`evaluator-runtime-context.ts:74`、`health.ts:59`），Codex 生产 hook 自身也只线程内使用不落盘（`pd-hook.ts:122`）。声明缺失时的 nextAction 指引"start each host once"（`host-tool-declaration.ts:148-149,178-179`）在 flag 关闭/暂停时并不成立 → `host_tool_declaration_missing` 拒绝。
- **Expected Flow**: 持久化挂在宿主启动边界（pd-hook session_start / plugin 注册），与内部化 flag 解耦。
- **Classification**: **Open Loop**（producer→registry 边被无关门控）
- **Recommendation**: **Connect**（移位到启动边界；小改动，杠杆高）。
- **Confidence**: High。

#### Finding 32 — pain 准入用漂移的工具词表影子做闸门：delete_file/move_file 失败永不进 pain

- **Component**: `after-tool-call-helpers.ts` Stage 6 pain admission
- **Current Flow**: 局部 `WRITE_TOOLS = ['write','edit','apply_patch','write_file','edit_file','replace']`（`after-tool-call-helpers.ts:389`，本人复核）决定哪些工具失败可成 pain；权威集 `constants/tools.ts:56-60`（8 写工具+delete_file+move_file）与 registry（canonicalKind='write'）早已有此事实。影子缺 `insert`/`patch`/`delete_file`/`move_file` → 失败即被 `not_a_write_tool_failure` 拒之门外（:424-438）——而 gate 照常路由这些名字、registry 也将它们归为 write。连带：`write_file`/`edit_file`/`replace` 本身是幻影名（Finding 2），影子集实际有效项比看上去更少。
- **Expected Flow**: `OPENCLAW_TOOL_SEMANTICS.resolve(toolName)==='write'`（或复用 tools.ts 集合）。
- **Producer**: registry/tools.ts（健在）。
- **Consumer**: 该决策点 **NONE**（import 区 :16-32 仅引入 `BASH_TOOL_NAMES`）。
- **Classification**: **Duplicated Capability**（漂移影子）→ 实害为 pain 信号缺失
- **Recommendation**: **Connect**（一行级替换，独立小 PR 可修）。
- **Confidence**: High。

#### Finding 33 — hostKind 词表 7+ 处独立枚举；声明注册表开集 vs 消费端闭对的错配

- **Component**: host identity vocabulary
- **Current Flow**: `('openclaw'|'codex')` 独立定义于 `pain-signal-bridge.ts:47`、`evidence-chain-contract.ts:97`（同文件 :1119-1121 与 :1290-1292 重复收窄两次）、`pd-console validators.ts:1772,2177`、`pain-list.ts:80-81`、`install-layout/index.ts:6`、`create-principles-disciple/installer.ts:171-180`（本地重实现合并而非 import `INSTALL_HOSTS`）、installer hostId 字面量。`host-tool-declaration.ts:31` 接受任意 `[a-z][a-z0-9_-]*` hostKind（开集），但所有下游收窄为闭对、其余降级 `'unknown'`——第三宿主能持久化合法声明却在 pain list/证据链/Console 显示 unknown。
- **Classification**: **Duplicated Capability**（开/闭错配兼 Open Loop）
- **Recommendation**: **Connect**（单一 `HostKind` 类型所有者 + installer 复用 `INSTALL_HOSTS`）。
- **Confidence**: High。

#### Finding 34 — gate 路由集与声明集无一致性校验；动作快照内双分类轨并行

- **Component**: OpenClaw gate routing vs declaration
- **Current Flow**: `gate.ts:35-41` 以集合成员资格决定路由；`tool-semantics.ts:45-50` 重声明同一集合为 mappings，含手抄 `HIGH_RISK_WRITE_TOOL_NAMES=['delete_file','move_file']`（:43，重复 `tools.ts:22-26` 的非 bash 部分）；两者无校验，路由变更即静默漂移。同时 gate 快照既算 legacy 布尔又算 `canonicalKind`（`gate.ts:35-37` vs :59,558-560），双轨并存可分歧。
- **Classification**: **Duplicated Capability**（过渡态双轨）
- **Recommendation**: **Connect**（单一派生：routing set → mappings，加启动断言；布尔轨按 PRI-634-F 意图退役）。
- **Confidence**: Medium-High。

#### Finding 35 — governance signal admission 硬编码 codex-only：能力不对称以字面量编码

- **Component**: `governance-signal-admission.ts`
- **Current Flow**: :699-700 拒绝一切 `hostKind !== 'codex'`（`unsupported_host_kind`）；`governance-observation-store.ts` 全部按 host_kind 键控（:209,217,255,265,359…）但能力单宿主。OpenClaw pain 走另一 funnel。当前为有意分期（Slice B 待接），但控制点是字面量而非注册表能力位。
- **Classification**: **Open Loop**
- **Recommendation**: **Ignore**（本阶段）/后继 Slice 落地时改为能力位。
- **Confidence**: High。

#### Finding 36 — 宿主适配面零散项（合并一条）

- **Component**: misc
- **Current Flow**: ①`codex-adapter/host-adapter.ts:45` `hostKind='subprocess'` 与治理 `GovernanceHostKind` 同名异义，注释提到的 `'inprocess'` 值全仓无实证（仅注释存活）；②openclaw installer 内插件 id `'principles-disciple'` 字面量重复 9 处（`openclaw-host-installer.ts:68,193,214,306,311,368,378,387`）；③OpenClaw `READ_ONLY_TOOL_NAMES`（`constants/tools.ts:7`）含 `todo_write`/`save_memory` 等写语义名——词表内在缺陷，未 gate 路由、registry 归 `'other'`，暂无消费实害。
- **Classification**: **Dead Data**（①注释事实）/ **Duplicated Capability**（②，Low）；③记为潜在词表缺陷
- **Recommendation**: **Remove**/改名（①）、**Connect**（②常量化）；③记录待办勿顺手改。
- **Confidence**: High（事实）/ Medium（③严重度）。

---

## 3. Classification statistics

```
Disconnected Capability: 5   (F1, F2, F12, F16, F29)
Missing Capability:      4   (F3, F20, F21, F23)
Duplicated Capability:   9   (F4, F13, F17, F27, F28, F30, F32, F33, F34)
Dead Data:               8   (F6, F10, F11, F15, F19, F22, F24, F36)
Open Loop:              10   (F5, F7, F8, F9, F14, F18, F25, F26, F31, F35)
─────────────────────────────
Total:                  36
```

（部分 finding 含复合分类，统计按主分类计。）

## 4. Top 3 recommended follow-ups

1. **合并 PR #1616（PRI-741），接通生成端宿主语义** —— 覆盖 F1+F2+（连带 F30/F32 的部分语境）。这是全仓最高杠杆的单点断连：校验端已接、生成端在盲写，修复已成型待合并；同时消除幻影词表穿透可靠性门的激活信号失真。
2. **补两条执行/学习反馈环** —— F14（Codex gate 决策流零持久化：共享 runtime 契约加核算钩）+ F5（`principle_applications` 回执进入晋升/退役决策输入）。这两条是产品论题"行为内化闭环"的字面断点；Codex 流量目前对激活核算与 shadow summary 完全不可见。
3. **一次性"已建成未消费"收割单** —— F22（`failed-tasks/:id` 详情接入 FailedTasksPage，其余四端点评估）、F25+ Finding 18（恢复审计两入口统一+可读）、F31（宿主声明持久化移到启动边界）、F32（pain 准入换用权威词表，一行级修复、恢复 delete_file/move_file 信号）。随后再排 F15（死 flag 退役）与 F9/F10（死表清理）走 DATA_CLEANUP_GUIDELINES。

## 5. Limitations

- 本审计验证**源码连接性**（writer/reader 经 grep+人工阅读双向取证），未连接任何 live workspace 数据库验证运行时存量。
- 行号基于 `0ba58fc9c`，合并后续 PR 会漂移；引用以符号名为准。
- 标注 Medium 的条目（F4 分层意图、F17 fail-open 政策性、F11 legacy 回放存量、F36-③严重度）含设计判断成分，已在条目内显式声明。
- 附带发现（环境层，非本审计对象）：本地 main 快进时被未跟踪文件 `docs/architecture/PRI-736-evolution-status-reality-audit.md` 阻塞——该文件旧本地副本与已入 main 的提交版内容不同，旧副本已备份至仓库外 `D:/pd-labs/backup-untracked-20260911/`，未删除。

## 附录 A：被读的 flag 反例清单（证明 F15 搜索方法有效）

`prompt`、`rulecode_context_v2`、`l2_dreamer`、`internalization_auto_consumer`、`internalization_full_chain`、`principle_receipt_ledger/block_copy/self_report`、`intent_engineering`、`diagnostician_async_cli`、`diagnostician_llm_degradation`、`artificer_output_retry`、progressive layers、`evaluator_artificer_repair_loop`、`signal_collector`、`correction_observer`、`abstraction_layer_v1`、`host.codex`、`codex_conversation_ingestion`、`story_a_approval_completion`、`new_user_onboarding`、`code_rule_capability`、`rulecode_safety_controls`、`rulecode_owner_live_decision`、`release_manager_*`、`governance_experience_v1`、`principle_governance_projection_v2`、`failed_tasks_observability`、`failed_task_recovery_console`、`feedback_channel`、`anonymous_product_telemetry`、`diagnostician_split_pipeline`、`diagnostician_core_grounding`、`pain_diagnosis_persistence`（读取其开关控制写入）。
