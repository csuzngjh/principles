# SPEC-PD-AGENT-PAIN-INGRESS-001 — 技术方案

| 字段 | 值 |
|---|---|
| 文档 | SPEC-PD-AGENT-PAIN-INGRESS-001 技术方案 |
| Version | **0.8** |
| 对应 SPEC | `SPEC-PD-AGENT-PAIN-INGRESS-001.md` **V0.8** |
| 对应审查 | `SPEC-PD-AGENT-PAIN-INGRESS-001-REVIEW.md`（审查对象 V0.6 + §8 post-review 七项） |
| 状态 | `READY_FOR_IMPLEMENTATION_REVIEW`（文档范围）；整体仍 `PARTIALLY_VERIFIED`；写类 MCP 工具受 **OG-4** 治理 Gate 约束（§5.1.1） |
| 日期 | 2026-11-10 |
| 本轮修订 | `v0.8 post-review corrections`：P1-1 `painType` 单一路径、P1-2 有效锚点、P1-3 超时身份回查、P1-4 四处默认 `score`、P1-5 OG-4 治理、P2-1 来源语义、P2-2 Observability 可见性。版本号仍为 **0.8**。 |
| 范围 | 只描述设计，不含已实现代码 |

---

# 0. 证据等级与阅读顺序

| 等级 | 含义 |
|---|---|
| **E1** | 本仓库源码 + 行号（可复核） |
| **E2** | 运行产物或已安装文件（不可由源码单独证明） |
| **E3** | 由源码结构推断，尚未端到端复现 |
| **E4** | 未证实 |

阅读顺序：先读 SPEC V0.8 的 §1（Pain 定义）与 §4（授权），再读本文件 §3（三道门）与 §5（Tool），最后读 §8（L2/L2b/L3）。本文件不重新定义产品语义；语义冲突时以 SPEC V0.8 为准。

---

# 1. 设计目标与非目标

## 1.1 目标

1. 让三个宿主里的 Agent 在**获得 Owner 对话授权**后，能提交一条**相对锚点的显著行为背离**。
2. 提交只产生一个可对账的持久事实：`state.db` 的 `tasks` 1 行（`task_kind='diagnostician'`、`status='pending'`）。
3. 默认严重度为**中等**，且 Agent 没有任何参数可以提级。
4. 回执只报告已持久化事实；证明不了 `diagnosis.mode` 就不返回该字段。
5. 给 Owner 三条真实可用的后续路径：Console 一键执行（L2）、Console 看见积压（L2b）、OpenClaw 自动执行（L3）。

## 1.2 非目标

- 不新建 Pain 表、锚点表、审批库、调度器、全局 Session Registry、Context Lease。
- 不改 `state.db` schema；不新增 `score` / `severity` / `approved` 列。
- 不做去重、限流、exactly-once 投递。
- 不把 Codex "Bound" 当作交付目标（附录 A）。
- 不改 CLI / Hook / Skill 的 500 字前端上限。
- 不新增第二套 `painType` 语义或第二条准入路径；只补一个中性默认值 `principle_deviation`（§6.3）。

---

# 2. 事实基线（先证据，后设计）

## 2.1 MCP 进程

| # | 事实 | 证据 | 等级 |
|---|---|---|---|
| F1 | MCP Server 只有一个工具 `pd_recall_principle_pains`，只读 | `packages/pd-mcp-server/src/server.ts:26-45,136-148` | E1 |
| F2 | 工具协议走 "JSON Schema first + zod strict 二次校验"，未知参数在 SDK 输入阶段即被拒绝 | `server.ts:37-57` | E1 |
| F3 | `workspaceDir` 是启动期配置（`PD_MCP_WORKSPACE_DIR`），**不是**模型可传参数；缺失/相对/不存在均 fail-closed | `packages/pd-mcp-server/src/workspace.ts:19-22,53-106` | E1 |
| F4 | `PD_MCP_HOST` 只允许 `codex` / `openclaw` / `workbuddy`，只是观测标记 | `workspace.ts:22,94-106` | E1 |
| F5 | 响应预算是 32768 UTF-8 字节；超预算当前返回 `response_budget_exceeded` 失败包 | `packages/pd-mcp-server/src/budget.ts:11-21`；`envelope.ts:75-83` | E1 |
| F6 | 有 10s 级 deadline 与并发准入限制；超时/饱和/关停都走结构化失败包 | `server.ts:112-180`；`deadline.ts` | E1 |
| F7 | 工具结果只用单个 text content block，不使用 `structuredContent` | `envelope.ts:28-41` | E1 |

## 2.2 提交与持久化

| # | 事实 | 证据 | 等级 |
|---|---|---|---|
| F8 | `PainToPrincipleService.recordPain` 在 `asyncMode` 下只创建 pending 任务并立即返回，不跑诊断 | `packages/principles-core/src/runtime/pain-to-principle-service.ts:188-236` | E1 |
| F9 | async 返回 `status:'submitted'`、`painId`、`taskId`；能力关闭时附 `nextAction` / `failureCategory:'capability_disabled'` | 同上 `:223-235` | E1 |
| F10 | 任务行由 `createTask` 写入，同时写 `created_at` 与 `updated_at` | `packages/principles-core/src/runtime/store/task/sqlite-task-store.ts:65-88` | E1 |
| F11 | `diagnostic_json` 是 TEXT/JSON 列；`buildDiagnosticJson` 写入 `sourcePainId`、`reasonSummary`、`source`、`severity`、provenance、evidence、`workspaceDir` 等 | `pain-signal-bridge.ts:405-455`；`:895-910` | E1 |
| F12 | `reason` 在 core 只要求非空字符串，无长度上限 | `pain-ingress-payload.ts:285` | E1 |
| F13 | `diagnostic_json` 中**没有** `painType`（builder 不写它） | `pain-signal-bridge.ts:405-455` | E1 |
| F14 | `state.db` 位于 `<workspace>/.pd/state.db` | `packages/principles-core/src/runtime/store/sqlite-connection.ts:71,89` | E1 |
| F15 | 原则账本目录 `stateDir = <workspace>/.state`，账本文件 `principle_training_state.json` | `packages/pd-cli/src/commands/pain-record.ts:393-394`；`principle-tree-ledger.ts:69,145` | E1 |
| F16 | 账本可由 `loadLedger(stateDir)` 读取，结构为 `HybridLedgerStore.tree.principles`（`Record<id, Principle>`） | `principle-tree-ledger.ts:482-483`；`runtime/types/ledger-store.ts:117-125,150-153` | E1 |

## 2.3 锚点源

| # | 事实 | 证据 | 等级 |
|---|---|---|---|
| F17 | 原则实体含 `id` / `version` / `text` / `triggerPattern` / `action` / `status` / `priority` / `scope` / `domain` / `evaluability` | `packages/principles-core/src/runtime/types/principle-schema.ts` | E1 |
| F18 | 原则状态枚举为 `candidate` / `active` / `archived` / `deprecated` / `probation` | `runtime/types/principle-enums.ts:5-16` | E1 |
| F19 | OpenClaw / Codex 共用仓库内 Skill：`plugins/principles-disciple/skills/pd-pain-signal/SKILL.md` | 文件存在；Codex 插件 `plugins/principles-disciple/.codex-plugin/plugin.json:19` 声明 `"skills": "./skills/"` | E1 |
| F20 | WorkBuddy 使用独立 Skill：`packages/workbuddy-adapter/plugin/skills/pd-pain-signal/SKILL.md` | 文件存在 | E1 |
| F21 | 安装环境另有用户级 `~/.workbuddy/skills/pd-record-pain/SKILL.md`，仓库内**没有**对应源文件 | E2（实测）；仓库检索无命中 | E2 |
| F22 | 现有两份 `pd-pain-signal` Skill 都要求"只有 Owner 明确要求时才登记"，与本 SPEC"Agent 主动准备候选、Owner 对话授权后提交"方向相反 | F19/F20 文件正文 | E1 |

## 2.4 严重度与 `painType`

| # | 事实 | 证据 | 等级 |
|---|---|---|---|
| F23 | `severityFromScore(undefined)` 返回 `moderate`；`>=70` 为 `severe`，`>=40` 为 `moderate`，其余 `mild` | `pain-signal-bridge.ts:264-273` | E1 |
| F24 | CLI 手动入口写死 `painType:'user_frustration'`，并在**两处**使用 `score: opts.score ?? 80`（`:125` 构造报告、`:469` 持久化） | `packages/pd-cli/src/commands/pain-record.ts:121-132,464-479` | E1 |
| F25 | `inferProvenance` 不读取 `painType`；`buildDiagnosticJson` 不写 `painType`（顶层无、`painIngress.v1` 也无）；它只出现在内存 `PainDetectedData` 与 Observability 的 `evolution.jsonl` | `pain-signal-bridge.ts:291-299,408-431`；`pain-ingress-payload.ts:355-360`；`pain-signal-observability.ts:253-267` | E1 |
| F26 | 观测写盘 `recordPainSignalObservability` 在 `:159/161`（`pain_events`）与 `:221`（events JSONL）使用 `?? 80`，并会把 `painType` 写入 `evolution.jsonl`；`pain_events.score` 为 `REAL NOT NULL` | `runtime/pain-signal-observability.ts:146-243` | E1 |
| F27 | CLI 在未绑定会话时 `recordObservability = false` | `pain-record.ts:427-430` | E1 |

## 2.5 Console 安全与执行

| # | 事实 | 证据 | 等级 |
|---|---|---|---|
| F28 | Console 支持 Bearer token（`--token` / `PD_CONSOLE_TOKEN`），timing-safe 比较；`--no-auth` 时直接放行 — **2026-11-13 已移除，见本节末注记** | `pd-console/src/server/config/AuthConfig.ts:20-58`（历史路径，文件已删除） | E1 |
| F29 | 未启用 token 时只允许 loopback 绑定 | `pd-console/src/server/index.ts:166-168`；`bind-guard.ts:17-25` | E1 |
| F30 | **未发现** CSRF / Origin / `Sec-Fetch-Site` 校验 | `pd-console/src/server/**` 全目录检索无命中 | E1（缺失） |
| F31 | 全局鉴权在路由分发前执行 | `pd-console/src/server/index.ts:405-407` | E1 |
| F32 | Console 已有 `detached + unref` 长任务先例 | `pd-console/src/server/routes/update.ts:105-133` | E1 |
| F33 | `pd diagnose run` 会先检查诊断能力与 runtime 绑定；缺失时主动失败并给 `nextAction` | `packages/pd-cli/src/commands/diagnose.ts:200-260` | E1 |
| F34 | `spawn` 返回只代表进程已创建；执行失败通过异步 `error` 事件上报 | Node 语义 | E3 |

> **2026-11-13 更新（ADR-0022 §7）**：控制台令牌认证已移除，F28 不再成立。F29 收紧为「任何情况下都只允许 loopback 绑定」；F30 的空白已被来源守卫补齐（`Host` / `Origin` / `Sec-Fetch-Site`，见 `pd-console/src/server/utils/request-guard.ts`）；F31 的「全局鉴权」改为该来源守卫。以上为历史事实记录，保留供追溯。

## 2.6 执行者、健康投影与游标

| # | 事实 | 证据 | 等级 |
|---|---|---|---|
| F35 | 自动执行者：Codex / WorkBuddy workspace worker，按 `host.*` 门控，**按 task_kind 跨宿主消费** | `packages/codex-adapter/src/worker/workspace-worker.ts:220-245,269-272,345-356`；`packages/workbuddy-adapter/src/worker/workspace-worker.ts:118-129,195-206` | E1 |
| F36 | core 提供 `executePendingDiagnosis({taskId})` | `pain-signal-bridge.ts:1048` | E1 |
| F37 | 插件 service 周期 120s，timer 启动受 `internalization_auto_consumer` 门控 | `packages/openclaw-plugin/src/service/internalization-auto-consumer-service.ts:21,152-168` | E1 |
| F38 | 健康投影 `aggregatePipelineHealth` 的 kind 白名单是 dreamer/philosopher/scribe/artificer/evaluator/rollout_reviewer | `sqlite-task-store.ts:422-475`（kind 列表在 `:444`） | E1 |
| F39 | **Codex worker 已有公平调度游标**：`getDiagnosticianServiceCursor` / `setDiagnosticianServiceCursor`，scope 为 `codex-worker-diagnostician-fair-share` | `codex-adapter/src/worker/workspace-worker.ts:209-245` | E1 |
| F40 | WorkBuddy worker 的选取逻辑更简单：pending 优先，再取退避已到期的 retry_wait；**没有**公平游标 | `workbuddy-adapter/src/worker/workspace-worker.ts:113-129` | E1 |
| F41 | `TaskStore` 的分页 cursor 只用于 `updated_at_asc/desc` 分页，不是调度公平性 | `runtime/store/task/task-store.ts:10-28`；`sqlite-task-store.ts:255-268` | E1 |
| F42 | `runs` 表有 `started_at` 且建了索引 | `runtime/store/sqlite-connection.ts:293-312` | E1 |
| F43 | `TaskStore.listTasks` 只支持 `updated_at_asc/desc` 排序，没有 `created_at` 排序 | `task-store.ts:10-28,97-98` | E1 |

> **对上一轮结论的更正（E1 优先于记忆）**：上一轮曾判断"仓库没有公平调度游标，`cursorScope` 是全新状态"。F39 证明该判断不完整：Codex worker 已经使用 `reconciliation_cursor` 做 pending / retry_wait 的公平轮转。因此 V0.7 的结论不是"没有游标所以删除"，而是"**不要新增第二套游标**：复用既有 authority；`cursorScope` 这个新参数仍然删除"。

## 2.7 特征开关

| # | 事实 | 证据 | 等级 |
|---|---|---|---|
| F44 | 新 flag 需要同时登记在 contract 与 lifecycle 两处 | `runtime/feature-flags/feature-flag-contract.ts:196,255`；`feature-flag-lifecycle.ts:56-103` | E1 |
| F45 | `diagnostician_async_cli` 已存在（quiet，默认关），作用是 pain-record 提交后立即返回 | `feature-flag-contract.ts:255`；`pain-record.ts:445-448` | E1 |
| F46 | 该 flag 的毕业条件是"后台 orchestrator 交付并验证" | `feature-flag-lifecycle.ts:94-101` | E1 |
| F47 | Console 的 flag 中文标签在 `enum-labels.ts` 维护，缺标签会显示原始 id | `pd-console/src/ui/utils/enum-labels.ts:97` | E1 |
| F48 | `PainIngressReport` 的准入决策只读取 origin / correlation / evidence / owner_manual，不读取 `painType` | `runtime/pain-ingress.ts:159-241` | E1 |
| F49 | **已存在** `StalledDiagnosticianTaskReadModel`：判定 pending + attempt=0 + **无 runs** + 超阈值，并给出 `pd diagnose run` 的 nextAction | `runtime/stalled-diagnostician-task-read-model.ts:23-86`；测试 `runtime/__tests__/stalled-diagnostician-task.test.ts:24-70` | E1 |
| F50 | 该读模型用 `getRunsByTask(taskId)` 判断"是否执行过"，**不是** `updated_at` | `stalled-diagnostician-task-read-model.ts:41-42,67-68` | E1 |
| F51 | `listTasks({taskKind, status})` 可用于按状态统计 | `task-store.ts:97-98`；`stalled-diagnostician-task-read-model.ts:63` | E1 |
| F52 | MCP 包有架构守卫 G4-2：只允许经由 `@principles/core/runtime/pain-recall-capability` 公开子路径导入 core，禁止私有读模型导入；并断言"恰好一个 Tool" | `pd-mcp-server/src/__tests__/architecture-guards.test.ts:5-14`；`server-contract.test.ts:71,82` | E1 |
| F53 | 安装器要求 WorkBuddy **插件根**下四份必需 Skill（含 `pd-pain-signal`），逐个校验 `skills/<name>/SKILL.md` 可读 | `packages/create-principles-disciple/src/installers/workbuddy-host-installer.ts:75,104,1204-1208` | E1 |
| F54 | 安装器测试断言**不**创建 `~/.workbuddy/skills` 第二份全局副本；仓库**没有**旧 `pd-record-pain` 识别/废弃逻辑 | `packages/create-principles-disciple/tests/workbuddy-skill-delivery.test.ts:412`；`workbuddy-host-installer.ts` 无 `legacy`/`deprecat` 处置命中 | E1 |

## 2.8 post-review 复核事实（F55–F65）

> 本节是 `v0.8 post-review corrections` 的证据基线。**每条均在当前分支源码上重新读取**，不使用上一轮评审结论。

| # | 事实 | 证据 | 等级 |
|---|---|---|---|
| F55 | `PainIngressReport.painType` 与 `PainToPrincipleInput.painType` 都**必填**，不存在"省略即合法"的类型 | `runtime/pain-ingress-payload.ts:113-124`；`runtime/pain-to-principle-service.ts:72-73` | E1 |
| F56 | 持久化重入校验的 legacy 归一分支在缺少类型时**硬编码** `painType: 'user_frustration'` | `pain-signal-bridge.ts:384-394`（`:389`） | E1 |
| F57 | `readTrustedPrinciples()` 只返回 `candidate` / `probation` / `active`；archived / deprecated 不进入 trusted 集合 | `runtime/adapter/principle-tree-ledger-adapter.ts:254-260` | E1 |
| F58 | 原则绑定只允许 `candidate` / `probation` / `active`；`active-principle-prompt` 无匹配时返回 `principle_not_currently_authorized` | `principle-tree-ledger-adapter.ts:95-102`；`packages/host-runtime/src/active-principle-prompt.ts:257-268` | E1 |
| F59 | 仓库**没有**按 `scope` 判定"当前场景是否适用"的函数；`priority` 只参与 prompt 打包排序，**没有**覆盖仲裁器 | `active-principle-prompt.ts:129-215`；`principle-schema.ts` 字段定义 | E1（缺失） |
| F60 | `runWithDeadline()` 超时返回 `{ok:false,timedOut:true}`，**不取消**底层 `fn()`；server 侧注册 orphan 并返回 `deadline_exceeded` | `packages/pd-mcp-server/src/deadline.ts:39-71`；`server.ts:186-218,274-288` | E1 |
| F61 | `painId` 由调用方（CLI）在调用 `recordPain` **之前**生成；`taskId = input.taskId ?? createDiagnosticianTaskId(painId)`，即 `diagnosis_<painId>` | `pd-cli/src/commands/pain-record.ts:394`；`pain-to-principle-service.ts:160-164`；`pain-signal-bridge.ts:264-266` | E1 |
| F62 | `parseOrigin()` 白名单含 6 个 `owner_manual` channel（`openclaw_command` / `cli_explicit_session` / `external_cli_unbound` / `codex_explicit_prefix` / `codex_explicit_agent` / `workbuddy_explicit_prefix`）与 `automatic_hook`；**不含** `mcp_agent_assisted` | `pain-ingress-payload.ts:37-50,147-161` | E1 |
| F63 | `PainProvenance` 是三个字符串值的枚举（`host_context_bound` / `owner_reported_no_host_trace` / `automatic_hook`），不是对象 | `runtime/admission-gate.ts:4-7`；`deriveProvenanceFromIngressFacts`：`pain-ingress-payload.ts:412-419` | E1 |
| F64 | `SPEC-PD-AGENT-CAPABILITY-API-001-v0.5.md` §10.2 规定写类 MCP 工具治理需 OG-4 单独授权；正文标注"设计位（未授权）""未启动"；仓库无授权记录，当前 MCP 只有只读 recall Tool | `docs/specs/SPEC-PD-AGENT-CAPABILITY-API-001-v0.5.md:332-335,396-400,436`；`pd-mcp-server/src/server.ts:147` | E1 |
| F65 | `recordObservability !== false` 才写 `pain_events` / events JSONL / `evolution.jsonl`；`false` 仅剩 `tasks` + `diagnostic_json`。Console 读 `trajectory.db`，无 `pain_events` 时看不到；Recall 降级为 `pain_event_only_in_state_db` | `pain-to-principle-service.ts:210,255`；`pain-signal-observability.ts:120-285`；`sqlite-context-assembler.ts:458-459`；`pain-recall-capability.ts:233-239` | E1 |

---

# 3. 总体架构：三道门 + 一条写入链

```text
Agent 观察到"相对锚点的显著背离"
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│ 门 1：锚点成立吗？                                          │
│  - 三类锚点之一：owner_expectation / established_principle  │
│    / agent_instruction                                      │
│  - anchorRef 可追溯（id@version / path#section / 出处）     │
│  - 引用等级不是 inference 单独支撑                           │
└─────────────────────────────────────────────────────────────┘
        │ 不成立 → 不提交；先向 Owner 澄清
        ▼
┌─────────────────────────────────────────────────────────────┐
│ 门 2：Owner 在本次宿主对话里明确授权了吗？                  │
│  - 先说明锚点 / 行为 / 背离 / 为什么值得记录                │
│  - 明确同意才算；未回复/不明确 = 拒绝                        │
│  - 只对本次提交有效；修改内容需再次确认                      │
│  - 后台 Agent 不得自行提交                                   │
└─────────────────────────────────────────────────────────────┘
        │ 未授权 → 不调用 Tool
        ▼
┌─────────────────────────────────────────────────────────────┐
│ 门 3：内容是否结构化到六项？                                │
│  - reason 里有：锚点 / 锚点来源+引用等级 / 观察到的行为 /   │
│    背离 / 上下文；"为什么值得记录"为辅助项，不作门槛        │
│  - 不含分数、严重度、会话 id、推测性类型                     │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
Handler：生成身份（在任何写入/deadline 之前）
  painId = mcp_<epoch_ms>_<8-hex>
  taskId = diagnosis_<painId>
        │
        ▼
MCP Tool `pd_submit_pain`
        │  core capability：校验 + 使用传入身份 + 提交
        ▼
PainToPrincipleService.recordPain({ painId, taskId, asyncMode: true })
        │  （capability 不重新生成、不覆盖这两个 ID）
        ▼
state.db tasks 1 行（pending, task_kind=diagnostician, input_ref=painId,
                    diagnostic_json.anchor = {type, ref}）
        │
        ├── 回执：submitted + painId + taskId + workspaceDir + diagnosis.status
        │
        └── 后续执行（三者互不替代）
              L2  Console 一键执行（人工）
              L2b Console 积压可见（只读）
              L3  OpenClaw 自动执行（flag + 能力 + service）
```

## 3.1 为什么不是"在 MCP Server 里直接写 SQLite"

- `state.db` 的 owner 是 `SqliteConnection` / `RuntimeStateManager`，不是 MCP Server（P4）。
- 诊断任务的创建已经由 `PainToPrincipleService` + `PainSignalBridge` 拥有；MCP 只应是**入口适配器**。
- 复用既有链路可以自动获得：provenance 归一化、painIngress 一致性校验、任务 ID 规则、能力关闭时的 nextAction。

## 3.2 为什么新增 core 子路径而不是复制逻辑

新增 `packages/principles-core/src/runtime/pain-submit-capability.ts`，对外通过 `@principles/core/runtime/pain-submit-capability` 暴露。它：

- 不 import MCP SDK（core 保持 SDK-free，沿用 `pain-recall-capability` 的边界）；
- 只接收已解析的 `workspaceDir`、Handler 预生成的 `painId` / `taskId` 与已校验的结构化输入；
- **必须使用传入的 `painId` / `taskId`，不得重新生成或覆盖**；若缺少则视为非法调用并失败关闭；
- 负责锚点校验、调用 `recordPain`、组装回执；
- 让三宿主共享同一份语义（P4/P6）。

只读回查优先复用既有 `RuntimeStateManager.getTask(taskId)` / TaskStore；**只有**在现有公开接口不足以完成有界回查时，才增加最小只读接口（不新增数据库、注册表、状态服务）。

`pd-mcp-server` 只负责：协议 schema → zod → **生成身份** → capability → 信封/预算 → 超时回查。

---

# 4. 变更文件清单（实现阶段使用；本文件不修改这些文件）

## 4.1 新增

| 文件 | 作用 |
|---|---|
| `packages/principles-core/src/runtime/pain-submit-capability.ts` | 提交能力：输入校验、锚点校验、调用 `recordPain`、回执 |
| `packages/principles-core/src/runtime/diagnostician-candidate.ts` | 从 Codex worker 抽出的公平选取函数（复用既有游标 authority） |
| `packages/pd-console/src/server/routes/diagnostician.ts` | L2 `POST /api/diagnostician/:taskId/run` + L2b `GET /api/diagnostician/backlog` |
| `packages/principles-core/src/runtime/__tests__/pain-submit-capability.test.ts` | 提交能力单测 |
| `packages/pd-mcp-server/src/__tests__/submit-tool.test.ts` | Tool schema / 回执 / 预算 / 超时读回 |
| `packages/pd-console/tests/server/routes/diagnostician.test.ts` | L2/L2b 路由测试 |

## 4.2 修改

| 文件 | 改动 |
|---|---|
| `packages/pd-mcp-server/src/server.ts` | 注册第二个 Tool；新增 `SUBMIT_TOOL_NAME`、submit schema/description；注入 `callSubmitCapability`；`readOnlyHint:false` |
| `packages/pd-mcp-server/src/envelope.ts` | 新增 submit 回执的信封/预算函数（不改 recall 的 `assembleResult` 语义） |
| `packages/pd-mcp-server/src/index.ts` | 导出新 Tool 常量（保持现有导出不破坏） |
| `packages/principles-core/src/runtime/pain-to-principle-service.ts` | `PainToPrincipleInput` 增加可选 `anchor` |
| `packages/principles-core/src/runtime/pain-signal-bridge.ts` | `PainDetectedData` 增加可选 `anchor`；`buildDiagnosticJson` 写入 `anchor` |
| `packages/principles-core/src/runtime/stalled-diagnostician-task-read-model.ts` | 扩展现有读模型：增加 `getBacklog()`（按状态计数、最老 pending、最近执行活动） |
| `packages/principles-core/src/runtime/store/run/run-store.ts` | 增加只读 `getLatestRunStartedAtForTaskKind(taskKind)` |
| `packages/principles-core/src/runtime/store/run/sqlite-run-store.ts` | 上述读取的 SQLite 实现（`MAX(started_at)`） |
| `packages/principles-core/src/runtime/store/run/memory-run-store.ts` | 内存实现（测试用）；保持接口完整 |
| `packages/principles-core/src/runtime/store/runtime-state-manager.ts` | 透传上述只读方法（若现有 façade 未暴露） |
| `packages/principles-core/src/runtime/feature-flags/feature-flag-contract.ts` | 登记 `openclaw_diagnostician_consumer`（quiet，默认开） |
| `packages/principles-core/src/runtime/feature-flags/feature-flag-lifecycle.ts` | 新 flag 的生命周期元数据 |
| `packages/pd-cli/src/commands/diagnose.ts` | 增加 `--preflight`（只解析能力与 runtime；不租约、不调用模型、不写状态） |
| `packages/pd-console/src/server/index.ts` | 挂载 `/api/diagnostician` 路由 |
| `packages/pd-console/src/ui/utils/enum-labels.ts` | 新 flag 的中文标签 |
| `packages/openclaw-plugin/src/service/internalization-auto-consumer-service.ts` | 复用同一 120s timer，增加 L3 一轮；三前提门控 |
| `packages/codex-adapter/src/worker/workspace-worker.ts` | 删除本地 `pickDiagnosticianCandidate`，改用 core 共享函数 |
| `plugins/principles-disciple/skills/pd-pain-signal/SKILL.md` | 改为锚点式提交规范（OpenClaw + Codex 共用） |
| `packages/workbuddy-adapter/plugin/skills/pd-pain-signal/SKILL.md` | 同上（WorkBuddy 独立副本） |
| `packages/pd-cli/src/commands/pain-record.ts` | 省略 `--score` 时不再用 `?? 80`（`:125`、`:469` 两处），改为写 `DEFAULT_PAIN_SCORE = 40`（落 `moderate`）；展示行 `:635` 同步；`--score` 的显式语义不变（裁定 1，§6.5） |
| `packages/principles-core/src/runtime/pain-signal-observability.ts` | 移除 `data.score ?? 80`（`:159/161`）与 `opts.data.score ?? 80`（`:221`）三处默认，改为同一 `DEFAULT_PAIN_SCORE`；`pain_events.score REAL NOT NULL`，因此不能"不写"（§6.4） |
| `packages/create-principles-disciple/src/installers/workbuddy-host-installer.ts` | 增加旧 `~/.workbuddy/skills/pd-record-pain` 的识别与废弃；不改写用户改过的副本（裁定 2，§7.4） |

## 4.3 只改测试

| 文件 | 原因 |
|---|---|
| `packages/pd-mcp-server/src/__tests__/**` | 现有测试假定"只有一个 Tool"（`server-contract.test.ts:71,82`）；新增后更新断言，不得删除 recall 覆盖 |
| `packages/pd-mcp-server/src/__tests__/architecture-guards.test.ts` | G4-2 目前只允许 `pain-recall-capability` 子路径；需把 `pain-submit-capability` 加入**公开 capability 白名单**（仍禁止私有读模型导入，不弱化方向约束） |
| `packages/principles-core/src/runtime/__tests__/stalled-diagnostician-task.test.ts` | 扩展 backlog / 假阳性 / 最近活动断言（保留原 7 个场景） |
| `packages/principles-core/src/runtime/feature-flags/__tests__/feature-flag-contract.test.ts` | flag 清单/默认值断言 |
| `packages/codex-adapter/tests/**` | 选取函数改为共享实现 |
| `packages/pd-cli/tests/commands/diagnose.test.ts` | 新增 `--preflight` 的解析/退出码/零变更断言（不改既有 run 覆盖） |
| `packages/pd-console/tests/server/routes/failed-tasks.test.ts` | 若路由分发测试枚举了路径，需要加新前缀（不改其业务断言） |

## 4.4 明确不修改

- `state.db` schema / migrations；
- `pains` 表（不存在）；
- 三宿主安装目录：`~/.pd/runtime/`、`~/.openclaw/extensions/principles-disciple/`、`<workspace>/.pd/`（唯一的例外是 §7.4 的旧 WorkBuddy Skill 废弃）；
- 用户级 `~/.workbuddy/skills/pd-record-pain/SKILL.md` 的**内容**（只识别并标记废弃，不重写；§7.4）；
- `--score` 的显式语义（只改"省略时的默认"，显式传值仍生效）；
- `diagnostician_async_cli` 的默认值（保持关，§6.5）；
- 真实 Pain 数据、真实 `state.db`。

---

# 5. MCP Tool 设计

## 5.1 身份与注解

| 项 | 值 |
|---|---|
| 工具名 | `pd_submit_pain` |
| 读/写 | 写 |
| `readOnlyHint` | `false` |
| `destructiveHint` | `false` |
| 幂等 | 否（v1 不去重） |
| 输入中的路径 | **禁止**；`workspaceDir` 只来自启动期绑定 |

> `readOnlyHint:false` 必须显式声明。现有 recall Tool 的 `true` 不能被继承或默认。

### 5.1.1 系统层治理合同：OG-4（写类 MCP 工具）

`pd_submit_pain` 与既有 recall Tool 的**安全结论不能互相沿用**：recall 是只读查询，`pd_submit_pain` 会创建持久任务行。

**两层授权必须分开记账，且不可互相替代**：

| 层 | 授权内容 | 由谁给出 | 当前状态 |
|---|---|---|---|
| **业务层** | Owner 同意"记录这一条具体 Pain" | 宿主对话中的 Owner（推荐用 askme；没有就用普通对话） | 每次提交都需重新取得；不落在 PD 数据里 |
| **系统层** | PD 允许**新增一个 MCP 写入能力**并交付 | Owner 按 `SPEC-PD-AGENT-CAPABILITY-API-001-v0.5.md` §10.2 的 **OG-4** 流程单独授权 | **已授权**（Owner 2026-11-13；r6 扩展为 Codex / OpenClaw / WorkBuddy 三宿主） |

**授权记录**：`docs/implementation-reports/PD-MCP-GATE3-OWNER-DECISION-CARD.md` §〇 r5 + r6。授权状态只能由 Owner 给出，本文件不自行宣布；r5 由「修改代码对全部的workbuddy开启」产生，**r6 由同日「三个宿主都打卡」把范围扩展为三宿主全部部署**。本节以下凡"WorkBuddy 单宿主""Codex / OpenClaw 仍 recall-only""`PD_MCP_HOST === 'workbuddy'`"等均为 r5 时点表述，一律以 r6 为准：三个宿主的生产 `tools/list` 均含 `pd_submit_pain`。

**代码事实（授权后）**：

- `SPEC-PD-AGENT-CAPABILITY-API-001-v0.5.md:332-335` 规定写类 MCP 工具的治理接入属于 OG-4 单独授权；同文 `:396-400` / `:436` 的"设计位（未授权）/ 未启动"是 v0.5 时点记录，不再代表现行状态。
- `pd-mcp-server/src/server.ts` 的 `enableSubmitTool` **默认仍为 `false`**；写工具自声明 `readOnlyHint:false`。
- 生产唯一 opt-in 点在 `pd-mcp-server/src/index.ts`：`PD_MCP_HOST === 'workbuddy'` 时显式传入 gate 与注入的 capability；`submit-assembly.ts` 复用 `host-runtime/pd-config` 把 Core 能力绑定到有效 `.pd/config.yaml`，config 无效则降级 recall-only，**不回落** `.state/workflows.yaml`（PRI-393）。**不引入 env var / feature flag**，T43 要求的"不得用开关绕过"继续成立。
- `packages/workbuddy-adapter/src/tool-semantics.ts` 已登记 `pd_submit_pain → write`，WorkBuddy PreToolUse matcher 为 `*`。带前缀的 MCP 工具名不猜测，仍按 `other` 保守处理（rule-context provider 据此挂起），待实机事件取证后补登记。
- Codex `Bash|apply_patch` matcher 对 MCP 工具名零命中，但 Codex 未开放该工具，不构成覆盖缺口。

**哪些既有安全证明仍适用**：`workspaceDir` 启动期绑定（F3）、JSON Schema + zod 严格校验（F2）、deadline/并发准入（F6）、单 text block 信封与预算（F5/F7）。这些覆盖**输入与传输**，不覆盖"是否允许新增写入能力"。

**哪些不再适用**：recall 的 `readOnlyHint:true`、以及"只读工具无需写入治理"的结论。

**实施门槛**：OG-4 是**生产交付 Gate**，不是开发启动 Gate，也不是"新增系统建设任务"。它只限制"把写类 MCP Tool 交到生产"，不限制开发与验证。

| OG-4 未授权时**允许** | OG-4 未授权时**禁止** |
|---|---|
| 在开发分支实现 Core Capability | 在生产 MCP Server 注册 `pd_submit_pain` |
| 实现 MCP Handler（schema / zod / 身份预生成 / 超时回查） | 把写类 Tool 分发到生产宿主 |
| 完成 origin / provenance / 准入 / 持久化逻辑 | 正式发布或部署该写入能力 |
| 编写并运行自动化测试（含 T01 之外的提交链路测试） | 用本地开关、宿主 matcher 或其他方式绕过 OG-4 |
| 在隔离非生产环境用测试数据做端到端集成验证 | 宣称已获 OG-4 授权 |
| 验证 MCP 协议、回执、超时、并发与异常处理 | — |

OG-4 获授权后才进入生产注册与交付：以 `readOnlyHint:false` 声明，并完成既有 PreToolUse matcher 与 tool-semantics 治理接入。原有 OG-4 安全边界不得删除或降级。OG-4 的授权状态只能由 Owner 给出——r5 已给出、r6 扩展为 Codex / OpenClaw / WorkBuddy 三宿主，下表"未授权时禁止"作为任何未授权新能力的通用约束保留。本文件不自行宣布已授权，仅同步 r5 / r6 记录。**follow-up**：本次全量开放未附观察期与停止条件，建议按 `docs/plans/2026-11-11-pain-submit-limited-rollout.md` §2/§3 补齐。

**不得为此新建**：独立审批服务、Owner 确认界面、审批 Token、审批库、三套宿主专用治理系统。现有机制不足的部分，列为实施前置问题（见 §16.4）。

## 5.2 Tool 描述（这是对 Agent 的行为指令，不是营销文案）

```text
记录一条"相对锚点的显著行为背离"（Pain）。

调用前必须完成三件事：
1) 先确定锚点：Owner 的明确期望、已建立的原则、或 Agent Instructions/Skill 的明确要求。
   原则必须给出 id 与 version；Instructions 必须给出路径与章节；Owner 期望必须给出处。
2) 先向 Owner 说明：①锚点及出处 ②你实际观察到的具体行为 ③行为与锚点之间的背离 ④必要时补充为什么值得关注或可能的影响。
3) 取得 Owner 在本次对话中的明确同意。未回复、回答不明确、或只说了"随便"都不算授权。
   授权只对本次提交有效；Owner 修改了内容时，提交前必须再次确认最终版本。
   后台/无人值守 Agent 不得自行提交。

第 2 步的 ④ 是辅助说明，不是提交条件：不要求证明未来任务一定会改变判断、
不要求证明会重复发生、不要求已产生实际损失、不要求证明长期复用价值。
无法证明上述任何一项，都不得成为拒绝记录这条 Pain 的理由——它们只帮助 Owner
判断注意力优先级，不属于 Pain 是否成立的条件，也不属于提交门槛。

Pain 是否成立只看三项：明确锚点 + 具体行为 + 相对锚点的显著背离。

不要提交：分数、严重度、优先级、会话 ID、审批令牌、推测的 painType、
或任何你无法给出出处的"锚点"。

如果无法确定锚点或无法说明具体行为，不要调用本工具；先向 Owner 澄清。
```

描述中不承诺"诊断会完成"，只承诺登记。

## 5.3 JSON Schema（协议层）

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["reason", "anchorType", "anchorRef"],
  "properties": {
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000,
      "description": "按六项顺序组织：锚点、锚点来源与引用等级、观察到的行为、背离、为什么值得记录、上下文。"
    },
    "anchorType": {
      "type": "string",
      "enum": ["owner_expectation", "established_principle", "agent_instruction"],
      "description": "锚点类型。无法归类时不要提交。"
    },
    "anchorRef": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300,
      "description": "原则：<id>@<version>；Instructions：<path>#<section>；Owner 期望：本次对话中的出处。"
    },
    "painType": {
      "type": "string",
      "enum": ["principle_deviation", "tool_failure", "subagent_error", "user_frustration"],
      "description": "可选。锚点式 Pain 默认是 principle_deviation；只有你能明确归类时才填写其他值，不要猜测。"
    }
  }
}
```

### 5.3.1 为什么 `anchorType` / `anchorRef` 是必填

- SPEC §1.3 的 D1 是"有锚点"；没有锚点的记录不构成 Pain。
- 若声明为可选，就会出现"提交成功但锚点为空"的持久事实，与 D1 矛盾。
- 必填让 Agent 在 schema 层就无法"先提交再说"；拿不出 `anchorRef` 时应回到对话澄清。

### 5.3.2 zod 二次校验（与 JSON Schema 锁步）

```ts
const submitInputSchema = z.strictObject({
  reason: z.string().min(1).max(2000),
  anchorType: z.enum(['owner_expectation', 'established_principle', 'agent_instruction']),
  anchorRef: z.string().min(1).max(300),
  painType: z.enum(['principle_deviation', 'tool_failure', 'subagent_error', 'user_frustration']).optional(),
});
```

## 5.4 回执与预算

### 5.4.1 成功回执（最保守形态）

```jsonc
{
  "status": "submitted",
  "painId": "mcp_<epoch_ms>_<8-hex>",
  "taskId": "diagnosis_mcp_<epoch_ms>_<8-hex>",
  "workspaceDir": "<absolute>",
  "diagnosis": { "status": "pending" }
}
```

- `taskId` 由既有 `createDiagnosticianTaskId(painId)` 确定性生成（`diagnosis_<painId>`，F61）。
- `painId` 由 **MCP Handler 在调用提交能力之前**生成，**不从 session / host 派生**；格式与 CLI 的 `manual_...` 并列（`mcp_<epoch_ms>_<8-hex>`）。
- 预生成的理由：超时后 Handler 必须握有已知 `taskId` 才能有界回查（§5.7）。这不是新身份层——CLI 已经在调用 `recordPain` 前生成 `painId`（F61），MCP 只是对齐同一顺序。
- `workspaceDir` 取自 F3 的启动绑定，不来自模型输入。

### 5.4.2 `mode` 的实际取值

| 情形 | v1 行为 |
|---|---|
| 能证明自动消费者当前可用 | `diagnosis: { status: "pending", mode: "auto" }` |
| 能证明自动消费者当前不可用 | `diagnosis: { status: "pending", mode: "manual" }` |
| 无法证明（**v1 的默认与全部实际情形**） | 只回 `diagnosis: { status: "pending" }` |

MCP 进程能看到的只有：workspace 绑定、`PD_MCP_HOST`、静态配置。它看不到 Companion worker 是否存活、OpenClaw service 是否已启动、Codex/WorkBuddy 是否有可用 runtime。因此**v1 不返回 `mode`**；代码里保留字段是为了将来有真实可证信号时不改合同。

禁止：

- 用 `PD_MCP_HOST` 推断 `mode`；
- 用 flag 默认值推断 `mode`；
- 把省略写成 `manual` 冒充诚实；
- 把 `auto` 解释为"诊断已完成"。

### 5.4.3 超预算

V0.6 的"超 32 KiB → `failed`"被推翻。V0.7 的顺序是：

1. 已持久化后，先序列化完整回执；
2. 超预算 → 序列化**最小回执**：
   ```jsonc
   { "status":"submitted", "painId":"...", "taskId":"...", "workspaceDir":"...", "diagnosis":{"status":"pending"} }
   ```
3. 最小回执仍超预算（极端情况，**必须由测试构造**：例如超长 `workspaceDir` 叠加被调低的预算上限）→ **不得据此宣称写入失败**。此时返回最小可传输结构，并在消息中如实说明"任务已写入（`taskId` 已知），但完整回执超出传输预算；请用 `pd task show <taskId>` 对账"。
   - 若连"已写入 + `taskId`"都无法在预算内表达，才允许 `isError:true` + `response_budget_exceeded`，且必须同时说明"写入状态未知，请对账"，不得写"未创建"。
   - 本节不接受"实际不可能"这种未经测试的保证；T14b 用真实预算路径构造该分支。

这里的"最小回执"与完整回执字段相同；差别只在**未来可能增加的观测字段**会被裁剪。裁剪不得删掉 `painId` / `taskId` / `workspaceDir` / `status`。

## 5.5 handler 流程

```text
1. shuttingDown? → shutting_down（无变更）
2. admissions.tryAcquire()? → 饱和时 saturated（无变更；未尝试写入；复用既有 AdmissionLimiter，不新增限流器）
3. zod 二次校验 → 失败则 invalid_input（无变更）
4. 组装修正输入：
   - anchor = { type: anchorType, ref: anchorRef }
   - painType 省略 → 归一为 principle_deviation（§6.3），不伪造 user_frustration
   - 不接受 score/severity/approved/sessionId/metadata
5. **生成身份（在任何写入之前）**：
   - painId = `mcp_<epoch_ms>_<8-hex>`（Handler 生成）
   - taskId = createDiagnosticianTaskId(painId)（确定性，F61）
6. 锚点有效性校验（§5.6）→ 失败则结构化拒绝，零写入
7. 调用 submitPainCapability({ workspaceDir, painId, taskId, input })
   - 内部走既有 evaluatePainIngress()（唯一准入）→ PainToPrincipleService.recordPain()
   - **capability 必须使用传入的 painId / taskId，不得重新生成或覆盖**；缺失即非法调用、失败关闭（§3.2）
   - asyncMode:true；recordObservability 见 §6.7（不再固定 false）
8. 正常返回 → 组装 submitted 回执（painId / taskId 来自第 5 步）
9. 写入中超时（runWithDeadline timedOut，F60）→ 用第 5 步已知 taskId 做有界回查（§5.7）
   - 命中 → 最小 submitted
   - 未命中 / 回查失败 → submit_unconfirmed（不称"未创建"、不自动重试）
10. 预算检查 → 完整 / 最小 / 如实说明
11. 记录一条结构化日志（工具名、durationMs、status、errorCode、响应字节数）
```

## 5.6 校验分层：哪些是服务器强制，哪些只能靠行为

| 约束 | 强制者 | 实现方式 |
|---|---|---|
| `reason` 非空、≤2000 | 服务器 | JSON Schema + zod |
| `anchorType` 合法、`anchorRef` 非空 | 服务器 | JSON Schema + zod |
| `established_principle` 的 `anchorRef` 形如 `id@version` | 服务器 | 正则 |
| 该原则在账本中**真实存在**且 version 匹配 | 服务器 | `loadLedger(stateDir).tree.principles`（F16） |
| 该原则**可用于当前违规依据**：仅 `active` / `probation`（且需在当前 activation candidates 中可解析）；`candidate` 拒绝作依据、只能作背景 | 服务器 | 复用 `readTrustedPrinciples()`（F57）、状态字段（F18）与 activation 解析（F58） |
| `agent_instruction` 的 `anchorRef` 形如 `path#section` | 服务器 | 正则 |
| `owner_expectation` 的 `anchorRef` 非空 | 服务器 | 长度 |
| 该原则**在当前场景适用**（scope 匹配） | **服务器只能部分判定** | 仓库无按 scope 判定的现成函数（F59）；见 §5.6.1 的最小保守规则 |
| 不被更高优先级的有效约束覆盖 | **服务器无法判定** | `priority` 只参与 prompt 打包排序，无仲裁器（F59）；只能由 Agent 披露冲突（§5.6.1） |
| 引用等级不是 `inference` | **Agent 行为** | 只能写进 Tool 描述/Skill；服务器读不到自由文本的语义 |
| 冲突锚点已披露 | **Agent 行为** | 同上 |
| 低置信度先澄清 | **Agent 行为** | 同上 |
| Owner 已授权 | **宿主对话 + 可选原生确认** | MCP 进程看不到聊天；不引入 `ownerApproved` 字段 |
| 后台 Agent 不提交 | **运行时形态** | 后台 Agent 通常没有交互通道；不新增注册表 |

### 5.6.1 有效锚点判定（post-review 修订）

`established_principle` 要成为**当前违规依据**，必须同时满足五条：

1. **真实存在**：能在 `loadLedger(stateDir).tree.principles` 中按 id 找到（F16）；
2. **版本匹配**：`anchorRef` 的 `@version` 与该条目的 `version` 一致；
3. **当前有效**：状态语义允许它约束当前行为（见下表）；
4. **当前场景适用**：`scope` / `domain` 与本次任务场景相符；
5. **不被更高优先级的有效约束覆盖**：存在冲突时，被覆盖的一方不能单独作为违规依据。

#### 逐状态语义（按代码，不按名称推断）

| 状态 | 是否进入 `readTrustedPrinciples()`（F57） | 能否作**当前违规依据** | 说明 |
|---|---|---|---|
| `active` | 是 | 可以，但必须同时能在当前 activation candidates 中解析（否则 `principle_not_currently_authorized`，F58），且需 scope 匹配、无更高优先级覆盖 | 已激活的正式原则 |
| `probation` | 是 | 可以，条件同 `active`，且必须披露"试用期" | 已进入 trusted 集合；不因 probation 而降级为背景，但冲突时优先级最低 |
| `candidate` | 是 | **不可以单独作为当前违规依据** | 仍是候选：可作诊断背景（"PD 正在形成这条原则"），不能声称"Agent 违反了已成立原则" |
| `archived` | 否 | **不可以** | 已归档，不再进入 trusted 集合；只能作历史背景 |
| `deprecated` | 否 | **不可以** | 已失效；只能作历史背景 |
| 不存在 / 版本不匹配 | — | **不可以** | `anchor_not_found` |
| 账本不可读 / 损坏 | — | **不可以**（失败关闭） | `anchor_unverifiable`，不得当作"原则不存在"（rc-9） |

**关键边界**：`warnings: non_active` **不是**"有效锚点判定"的替代品。能用 `warnings` 表达的前提是"锚点已经成立、只是状态偏弱"；archived / deprecated / candidate 的问题不是 warning，而是**锚点不成立**，必须拒绝并把 Agent 引回 `owner_expectation` 或 `agent_instruction`。

#### 当前代码能力边界（必须如实写明）

- 仓库**没有**按 `scope` 判定"当前场景是否适用"的函数（F59）。因此服务器只能校验前三项（存在 / 版本 / 状态），第 4 项由 Agent 在 `reason` 中披露并由 C 类验收抽查。
- 仓库**没有**约束优先级仲裁器；`priority` 只参与 prompt 打包排序（F59）。第 5 项只能由 Agent 显式披露冲突，服务器不声称能自动裁决。
- **最小保守规则**：当 Agent 无法说明 scope 适用性，或无法排除更高优先级冲突时，只能把该原则当作**诊断背景**，不得作为"当前违规依据"提交；此时应改用 `owner_expectation`（若 Owner 在本次对话中确实表达过）或 `agent_instruction`（若宿主 Instructions/Skill 有明确要求）。
- **不能保证的范围**：服务器无法自动发现"未被 Agent 披露的冲突"或"scope 语义不匹配"。这部分依赖 Skill 行为约束与 C 类验收，文档不把它伪装成服务器强制。

#### Owner 当前要求与历史原则冲突

- Owner 在**本次对话**重新提出的要求，一律按 `owner_expectation` 处理，`anchorRef` 指向本次对话出处；
- **不得**把 Owner 的新要求伪装成"某条已废弃原则仍然有效"；
- 若 Owner 的要求与某条 `active` 原则冲突，必须在 `reason` 中披露冲突双方；此时不能用该原则作为唯一依据。

### 5.6.2 为什么不在服务器侧校验 Instructions 文件是否存在

Instructions 的根目录是宿主特定的（仓库内 Skill、`~/.codex/AGENTS.md`、Workspace `AGENTS.md` 等），MCP 进程不保证能读到。强行校验会产生大量假阴性。这里只做**形状校验**，真实存在性由 C 类验收在三宿主上取证。

## 5.7 截止时间与"已写入但响应超时"

这是一个**写工具**，不能直接复用 recall 的"超时即失败"。前提是**身份必须在写入之前已知**（§5.5 第 5 步、F61）：

| 问题 | 答案 |
|---|---|
| 谁生成 `painId` | MCP Handler，在校验通过后、调用提交能力之前 |
| `taskId` 怎么得到 | 确定性派生 `diagnosis_<painId>`（F61），不依赖写入结果 |
| Core Capability 是否另生成身份 | **不生成**：只接收并使用 Handler 传入的 `painId` / `taskId`；缺失即失败关闭 |
| Handler 能否在开始写入前持有 | **能**；这是本修订的核心要求 |
| 超时后底层写入是否继续 | **会继续**：`runWithDeadline()` 只停止等待，不取消 `fn()`（F60） |
| 查到任务是否等于"本次提交成功" | **是**（本次 `painId` 唯一），但只证明**任务行已写入**；不证明诊断已执行 |
| 查不到能否确定"未创建" | **不能**。可能有未提交/未可见的写入，也可能回查自身失败 |
| 回查再次超时 | 视为"结果未知"，返回 `submit_unconfirmed`，不再无限重试 |
| 进程退出时是否有未完成写入 | 可能有；SQLite 写入由底层任务完成，进程被宿主杀死时状态未知 → `submit_unconfirmed` |

**超时处理流程**：

```text
写入中超时（timedOut）
  → 用已知 taskId 做一次有界回查：getTask(taskId)，上限 1s
     ├── 命中 → 返回最小 submitted（painId / taskId / workspaceDir / status:pending）
     ├── 未命中 → submit_unconfirmed（不得称"未创建"、不得返回普通 failed）
     └── 回查本身失败/再次超时 → submit_unconfirmed
  → 不自动重新提交（会制造第二条任务）
```

回查只复用既有只读能力：`RuntimeStateManager.getTask(taskId)` / TaskStore 查询（F61）；**不新增**数据库、任务注册表或状态服务。只有现有公开接口无法完成这次有界回查时，才允许增加一个最小只读接口。

**状态语义**：

| 状态 | 含义 | 对账方式 |
|---|---|---|
| `submitted` | 任务行已确认存在 | `pd task show <taskId>` |
| `submit_unconfirmed` | 写入结果未知 | `pd task show <taskId>` / `pd task list --kind diagnostician`；用预生成的 `painId` 在 `tasks.input_ref` 中查找 |

**禁止**：新增幂等库、Session Registry、对结果未知的提交自动重试、超时直接宣称失败、已成功却返回普通失败、无法确定时宣称一定成功、超时后自动重新提交、capability 重新生成或覆盖 Handler 传入的身份。

**并发与容量**：继续复用既有 `AdmissionLimiter`（§5.5 第 2 步）与既有 orphan 跟踪（F60）；不新增超时任务注册表。

---

# 6. 内容与字段映射

## 6.1 六项内容 → `reason`

| # | 内容 | 在 `reason` 中的形态 |
|---|---|---|
| 1 | 锚点 | 引用原文/明确出处；原则给 `id@version` |
| 2 | 锚点来源 + 引用等级 | `verbatim` / `paraphrase` / `recollection` / `inference` |
| 3 | 观察到的行为 | 具体动作、顺序、跳过、越界 |
| 4 | 背离 | 没做 / 做反了 / 做了但绕过 |
| 5 | 为什么值得记录（辅助） | 未来哪类任务会改变判断；用于帮助 Owner 判断注意力优先级，**不是准入门槛** |
| 6 | 上下文 | 任务类型、仓库/目录、可公开的环境事实 |

`reason` 不要求机器可解析；服务器只检查长度与非空。结构化的是 `anchorType` / `anchorRef`。**Pain 是否成立只看锚点 / 具体行为 / 显著背离三项**；第 5 项缺失不构成拒绝理由。

## 6.2 `anchor` 的持久化落点

```jsonc
// diagnostic_json
{
  "sourcePainId": "mcp_...",
  "reasonSummary": "……六项内容……",
  "source": "mcp_agent_assisted",
  "severity": "moderate",
  "anchor": {
    "type": "established_principle",
    "ref": "P-123@3"
  }
}
```

- **不新增列**：`diagnostic_json` 已经是 TEXT/JSON（F11）。
- `anchor` 只在 `anchorType` + `anchorRef` 都通过校验时写入。
- 引用等级、锚点原文、冲突披露都在 `reasonSummary` 中，不复制成结构化字段。
- 这样避免"六项内容 = 六个参数"的过度结构化，也避免把无法机器判定的语义伪装成枚举。

> 与 SPEC §11 的对账：两份文档统一为 `anchor: {type, ref}`，不含 `citation`；引用等级、锚点原文、冲突披露只存在于 `reasonSummary`。

## 6.3 `painType`：单一路径，不伪造分类

### 6.3.1 当前代码事实（实现前）

| 事实 | 证据 |
|---|---|
| `PainIngressReport.painType` 必填 | `pain-ingress-payload.ts:113-124`（F55） |
| `PainToPrincipleInput.painType` 必填 | `pain-to-principle-service.ts:72-73`（F55） |
| `evaluatePainIngress()` 是既有统一准入 | `pain-ingress.ts:159-240`（F48） |
| legacy 顶层字段路径**不构造** `painIngress.v1`，因此跳过 v1 payload 校验 | `pain-signal-bridge.ts:349-394` |
| legacy 归一在缺少类型时硬编码 `user_frustration` | `pain-signal-bridge.ts:389`（F56） |
| `painIngress.v1` **不含** `painType`（只有 version / origin / correlation / evidenceClass），`diagnostic_json` 顶层也不写它 | `pain-ingress-payload.ts:355-360`；`pain-signal-bridge.ts:408-431`（F25） |
| CLI 两处硬编码 `painType: 'user_frustration'` | `pain-record.ts:128`、`:466` |

### 6.3.2 V0.8 草案的错误

草案规定"省略 `painType` → 不构造 `painIngress.v1` → 走 legacy 顶层字段"，并称这样"不新增路径"。**该说法不成立**：

1. legacy 路径**绕过** `evaluatePainIngress()` 的统一准入与 v1 payload 校验，等于第二条准入路径；
2. 持久化重入校验在 legacy 分支会把缺失类型归一成 `user_frustration`（F56），制造假分类；
3. legacy 行缺少 `painIngress` 命名空间（origin / correlation / evidenceClass），重入校验只能走 legacy 归一，无法与 v1 行同等校验；且 `diagnostic_json` 本身不存 `painType`，所以"类型信息丢失"不是这里的论据。

### 6.3.3 目标行为

| 输入 | 行为 |
|---|---|
| MCP 带 `painType` | 原值透传；构造 `painIngress.v1`（v1 payload 不含 `painType`，它作为独立入参传给 `recordPain`）；走 `evaluatePainIngress()` |
| MCP 省略 `painType` | Handler 归一为中性默认 **`principle_deviation`**；**仍然**构造 `painIngress.v1`；**仍然**走 `evaluatePainIngress()` |
| CLI 手动报告 | **本轮不改**：`pd pain record` 继续保持既有 `user_frustration` 行为；CLI 产品语义不在本 SPEC 修订范围 |
| 任何情况 | MCP 只有一条准入路径；legacy 分支不再由本 Tool 触发 |

`principle_deviation` 是本 SPEC 的锚点式 Pain 的**语义默认**：Agent 提交的是"相对锚点的行为背离"，不是工具故障、不是子 Agent 错误、也不是 Owner 情绪。它不是"未知"的假类别，而是准确描述。

### 6.3.4 为什么必须扩展枚举而不是伪造

- 把锚点式背离写成 `user_frustration`，等于把 Agent 的观察冒充 Owner 情绪，违反 §7.5 的作者归属；
- 写成 `tool_failure` / `subagent_error` 会误导诊断器去查工具或子 Agent，而实际问题是原则背离；
- 新增一个中性值比"缺省 + 不写"更诚实：内存对象与 Observability 流始终有确定类型，下游无需猜测。

### 6.3.5 枚举扩展的影响面（实现时必须一起处理）

| 位置 | 影响 |
|---|---|
| `runtime/pain-ingress-payload.ts:117`（`PainIngressReport.painType`） | 联合类型加 `principle_deviation` |
| `runtime/pain-ingress-payload.ts:280-283`（`parsePainIngressReport` 白名单） | 枚举白名单同步，否则带新值的报告会被 `invalid_input` 拒绝 |
| `runtime/pain-signal-bridge.ts:92`（`PainDetectedData.painType`） | 同上 |
| `runtime/evolution-types.ts:63,118,143,264,311,340` | TypeBox 联合与映射；当前已含 `dispatch_error`，但不含 `principle_deviation`。**Observability 开启时会把 `painType` 写进 `evolution.jsonl`**，不同步会让下游 schema 拒绝新值 |
| `pd-cli/src/commands/pain-record.ts:128,466` | **本轮不改**：CLI 手动报告保持 `user_frustration`；不新增 CLI 参数、不改 CLI 产品语义 |
| `pain-signal-bridge.ts:389`（legacy 归一） | **本轮不改**既有 legacy 归一逻辑；只要求新 MCP 写入不产生 legacy-only 记录（§6.3.3） |
| 现有断言 `user_frustration` 的测试 | **无需改动**（CLI 行为不变）；只新增 MCP 路径缺省为 `principle_deviation` 的断言 |
| Parser / Validator（`parsePainIngressV1Payload`） | **无需改**：v1 payload 不含 `painType`，重入校验不会因新值失败 |
| 持久化消费者（`buildDiagnosticJson`、Admission、Read Model、Console 展示） | `diagnostic_json` 不含 `painType`，因此这些路径**不受影响**；只有 Observability 的 evolution 流需要同步 |

**类型与来源是两件事**：本节只处理 `painType`（Pain 的分类）。来源/作者归属由 §6.6 处理——那里新增一个 provenance 值 `agent_reported_owner_approved`，与本节无关，不得互相替代。

## 6.4 严重度

### 6.4.1 目标（不可协商）

- Agent **不得**自评严重度，也不得通过任何参数把自己提交的 Pain 提升到 `severe`；
- MCP 路径与 CLI 省略 score 的路径，最终都落 **`moderate`**；
- 显式人工传入的 `score` 仍按既有 `severityFromScore` 阈值计算；
- **不改** `severityFromScore` 的映射（`>=70 severe`、`>=40 moderate`、其余 mild）；
- **不加**第二套评分、不加新枚举、不加 Agent 可用的提级参数。

### 6.4.2 当前代码事实：四处功能默认 + 一处展示

| # | 位置 | 触发条件 | 后果 |
|---|---|---|---|
| 1 | `pain-record.ts:125` | `resolveIngressDecision()` 构造报告时 `opts.score ?? 80` | 送入准入的报告已是 80 |
| 2 | `pain-record.ts:469` | `recordPain({ score: opts.score ?? 80 })` | 持久化 severity 走 80 → `severe` |
| 3 | `pain-signal-observability.ts:159/161` | `recordTrajectoryPainEvent()` 中 `data.score ?? 80`，并由 `:161` 的本地 `severityFromScore(score)` 转成 severe | `pain_events.score` 写 80 |
| 4 | `pain-signal-observability.ts:221` | events JSONL 写入 `opts.data.score ?? 80` | 事件日志写 80 |
| 5（展示） | `pain-record.ts:635` | 终端展示 `opts.score ?? 80` | 展示与真实值不一致（修默认值时必须同步） |

**为什么不能"不写 score"**：

- `pain_events.score` 是 `REAL NOT NULL`，不写会失败；
- `pain-signal-observability.ts` 有**自己的** `severityFromScore(number)`，只接受 `number`，`undefined` 会落 `mild`（与 bridge 的 `severityFromScore(undefined)→moderate` 不同）。因此"省略即 moderate"在观测路径**不成立**。

### 6.4.3 目标实现

| 入口 | 省略时的行为 | 结果 |
|---|---|---|
| MCP `pd_submit_pain` | schema 无 `score`；`recordPain` 不传 score | bridge `severityFromScore(undefined)` → `moderate` |
| CLI `pd pain record` | 写 `DEFAULT_PAIN_SCORE = 40`（单一定义，四处引用） | `severityFromScore(40)` → `moderate` |
| Observability（两条写入） | 同样使用 `DEFAULT_PAIN_SCORE`，不再 `?? 80` | `pain_events` / JSONL 均为 40 → moderate |
| 显式 `--score` / 显式 API 传值 | 原值 | 按既有阈值 |

`DEFAULT_PAIN_SCORE = 40` 取 `moderate` 区间的**下限**，与"默认中等"一致，又不会侵入 `mild`。

### 6.4.4 验证要求

测试必须**读回真实写入记录**，不能只断言函数返回值：

1. `tasks.diagnostic_json.severity`（CLI 路径与 MCP 路径各一次）；
2. `trajectory.db` 的 `pain_events.score`；
3. events JSONL 中的 `score`；
4. `evolution.jsonl`（Observability 开启时）。

任意分支都不得重新出现 80 或 `severe`（显式传入 `--score 80` 的旧行为除外，必须单独断言未被破坏）。

## 6.5 CLI 手动入口与 `diagnostician_async_cli`

**当前代码事实**（实现前）：

- `pain-record.ts:125` 与 `:469` 两处 `opts.score ?? 80`，省略时落 `severe`（F24 已扩到两处）；
- `pain-signal-observability.ts:159/161/221` 三处 `?? 80`（F26 已扩到三处）；
- `recordPain` 在 `:210/:255` 默认启用观测，所以**只改 CLI 一处仍会被补回 80**，四处必须一起改；
- `diagnostician_async_cli` 是 quiet、默认关的 flag（F45）；开启后提交即返回（F46）。

**目标行为（已实现，PR #2507；`pain-record.ts` 已改用 `DEFAULT_PAIN_SCORE`；下表保留为设计与验收依据）**：

| 项 | 目标 | 理由 |
|---|---|---|
| 省略 `--score` | 写 `DEFAULT_PAIN_SCORE = 40` → `severityFromScore(40)` → `moderate`；**四处默认值一起改** | 与 MCP 入口同一把尺子，避免"同一个问题两个严重度" |
| 显式 `--score` | 保留，作为人工提级通道 | 产品与操作权限要求；见下方边界 |
| `painType` 默认（MCP） | MCP 路径省略时落 `principle_deviation`（§6.3）；**不得**回填 `user_frustration` | 类型 ≠ 严重度（F25） |
| `painType`（CLI） | **本轮不改**：`pd pain record` 保持既有 `user_frustration`；CLI 产品语义不在本次修订范围 | 冻结范围 |
| `diagnostician_async_cli` | 保持默认关，不随 L3 毕业翻转 | 改变手动提交体感（提交即返回），等真实取证后再评估 |

### 6.5.1 `--score` 的权限边界（必须如实写明）

`pd pain record --score` **无法区分操作者是人还是 Agent**：CLI 没有鉴权、没有身份声明、也没有服务端可验证的操作者凭据。因此：

- 产品规则：`--score` 是**人工提级通道**，Agent 不得使用；
- 技术事实：服务器**没有**也**不能**仅凭该参数证明操作者身份；
- 文档不得写"服务器已验明操作者身份""Agent 无法使用 `--score`"这类未经实现的保证；
- 真正防止 Agent 自评的手段是：MCP schema 不提供 `score`（§5.3）+ Skill 行为约束 + C 类验收抽查。

**记账口径**：`docs` 写目标，`code` 仍是 80。任何"已改为中等"的结论在实现并读回证据之前都不成立。

## 6.6 provenance / ingress：来源与作者归属

### 6.6.1 当前代码事实

| 事实 | 证据 |
|---|---|
| `PainProvenance` 是**三个字符串值的枚举**，不是对象 | `admission-gate.ts:4-7`（F63） |
| `PainIngressOriginV1` 是对象联合：`owner_manual` + 6 个 channel，或 `automatic_hook` + `source` | `pain-ingress-payload.ts:37-50` |
| `parseOrigin()` 白名单**不接受** `mcp_agent_assisted` | `pain-ingress-payload.ts:147-161`（F62） |
| `validateOriginCorrelationInvariant()`：`external_cli_unbound` 必须 unbound；其余显式 channel 必须 bound | `pain-ingress-payload.ts:328-344` |
| `deriveProvenanceFromIngressFacts()`：automatic_hook → automatic_hook；bound → host_context_bound；否则 owner_reported_no_host_trace | `pain-ingress-payload.ts:412-419` |
| `context-payload.ts` 的 `DiagnosisTargetSchema.provenance` 用 3 个 `Type.Literal` 锁死 | `context-payload.ts:171-175` |
| `isOwnerExplicitManual()` 只认 `owner_reported_no_host_trace` | `evidence-guards.ts:18-20` |
| `pd pain retry` 的白名单同样是 4 个字符串（含 legacy `openclaw_context_bound`） | `pd-cli/src/commands/pain-retry.ts:197` |

### 6.6.2 语义原则

- **Owner 同意提交 ≠ Owner 亲自报告**。授权（agent 有权提交）与事实作者（谁观察、谁陈述）是两个维度。
- Agent 的观察**不得**写进 `owner_statement` / `correctionEvidence`。
- Agent 观察**不得**归为 `user_frustration`（§6.3）。
- 不得因为 Owner 同意，就声称"Owner 亲自观察到问题"。
- 不得使用 Parser 不接受的 channel（例如直接写 `mcp_agent_assisted` 而不改白名单）。

### 6.6.3 目标取值（最小扩展）

| 字段 | 取值 | 理由 |
|---|---|---|
| `origin.kind` | `owner_manual` | 授权来自 Owner 对话；不是自动 hook |
| `origin.channel` | **新增** `mcp_agent_assisted` | 必须与"Owner 亲自在 CLI/宿主输入"区分；复用现有 channel 会伪造来源 |
| `correlation` | `unbound` + `missing_host_session` | MCP 没有可信 session 身份 |
| `evidence` | `unavailable` + `not_applicable_unbound` | 不伪造会话证据 |
| `provenance`（派生） | **新增** `agent_reported_owner_approved` | 现有三值没有一个能准确表达"Agent 观察、Owner 授权"；`owner_reported_no_host_trace` 会把作者说成 Owner |
| `hostKind` | `PD_MCP_HOST` 映射 | 仅观测 |
| `sessionId` / `agentId` | 不传 | 禁止 Agent 填写 |

### 6.6.4 影响面（最小扩展必须同步的位置）

| 位置 | 改动 |
|---|---|
| `pain-ingress-payload.ts:37-50` | `owner_manual` channel 联合加 `mcp_agent_assisted` |
| `pain-ingress-payload.ts:147-161`（`parseOrigin`） | 白名单加同名 channel；写时与重入共用 |
| `pain-ingress-payload.ts:328-344`（invariant） | `mcp_agent_assisted` 要求 `correlation.status === 'unbound'`（与 `external_cli_unbound` 同组） |
| `pain-ingress-payload.ts:412-419`（派生） | `mcp_agent_assisted` → `agent_reported_owner_approved` |
| `admission-gate.ts:4-7`（`PainProvenance`） | 联合加 `agent_reported_owner_approved` |
| `admission-gate.ts:15-21`（`normalizePainProvenance`） | 白名单加新值 |
| `evidence-guards.ts:18-20`（`isOwnerExplicitManual`） | 接受新值：豁免依据是 **Owner 已授权**，不是 Owner 亲自观察；注释必须写明这一点 |
| `context-payload.ts:171-175` | `Type.Literal` 加新值 |
| `pd-cli/src/commands/pain-retry.ts:197` | 白名单加新值 |
| `pain-ingress.ts:159-241`（`evaluatePainIngress`） | 必须在"通用 Unbound Owner Manual"分支**之前**识别 `mcp_agent_assisted` 并走统一提交路径（§6.6.5） |
| Console / Read Model 的来源展示 | 新增一个可读标签；不得把它显示成 "Owner reported" |
| 测试 | 断言旧三值行为不变；新增 MCP 路径的 provenance 断言 |

**不扩展**：不新增第二套 Origin/Provenance 模型、不新增 `originChannel` 表、不新增 `reportedBy` 字段。

**唯一方案**：`mcp_agent_assisted` + `agent_reported_owner_approved` 是本节确定的最终取值，不再保留"是否扩展 provenance"的待选项。其含义固定为"事实由 Agent 观察、提交经 Owner 授权"；**Owner 授权 ≠ Owner 是事实报告者**，因此不得写成 `owner_statement`，也不得在 `correctionEvidence.classification` 中使用 `owner_statement`（除非逐字引用 Owner 原话并显式标注）。

### 6.6.5 `evaluatePainIngress()` 的 MCP 专用处理（必须实施）

**当前行为**：`evaluatePainIngress()`（`pain-ingress.ts:159-241`）只区分"automatic_hook"与"owner_manual"两大类。若 `owner_manual` 且 `correlation.status === 'unbound'`，会落入通用外部 CLI 分支（`:231-240`），返回 `submit` 但同时给出"`Re-run with --session <id>`"的提示。MCP Agent Observation 不是 Owner 在 CLI 亲自提交，这条提示对 MCP 路径是错误的误导，且不能反映"Agent 观察 + Owner 授权"的来源。

**必须实现的变化**（缺一项即视为未完成）：

1. `evaluatePainIngress()` 识别 `origin.kind === 'owner_manual' && origin.channel === 'mcp_agent_assisted'`；
2. 该识别**必须在通用 Unbound Owner Manual 分支之前**（即在 `:231` 的通用 submit 之前）完成，避免落入 CLI 提示；
3. 走**现有统一提交路径**返回 `action: 'submit'`（复用 `buildLegacy` / `buildV1Payload`，不新增决策类型）；
4. **不返回** `--session` 重提提示；警告文案改为中性说明（例如"Agent 报告，Owner 已授权；无宿主轨迹证据"）；
5. **不伪造** Host Session、Trajectory Evidence、`owner_statement`，也不声称 Owner 亲自报告；
6. provenance 由**现有** `deriveProvenanceFromIngressFacts()` 派生为 `agent_reported_owner_approved`（§6.6.4），调用点不额外传值。

**输入组合（唯一合法组合）**：

| 字段 | 值 |
|---|---|
| `origin.kind` | `owner_manual` |
| `origin.channel` | `mcp_agent_assisted` |
| `correlation.status` | `unbound` |
| `correlation.reason` | `missing_host_session` |
| `evidence.status` | `unavailable` |
| `evidence.reason` | `not_applicable_unbound` |
| `provenance`（派生） | `agent_reported_owner_approved` |

**证据门槛**：`agent_reported_owner_approved` 必须能按 SPEC 满足"空输入证据门槛"的 **Owner 授权豁免**（`evidence-guards.ts` 的 `isOwnerExplicitManual()` 接受新值，依据是 Owner 已授权，而不是 Owner 亲自观察）。**不得**与 `owner_reported_no_host_trace` 混为一谈：后者表示"Owner 报告但没有宿主 trace"，前者表示"Agent 观察、Owner 授权提交"。

**对应测试 T44**（见 §10.2.3）：①MCP Agent 的 Unbound 报告可进入统一提交路径；②不出现用 CLI `--session` 重提的提示；③provenance 正确派生为 `agent_reported_owner_approved`；④Owner 授权的空证据准入符合 SPEC；⑤Console/Read Model 不显示为 Owner 亲自报告。

**边界**：本节只增加一个 channel 与其分支顺序，不新增 `PainDecision` 动作类型、不新增 provenance 模型、不新增 Session Registry / Context Lease。

## 6.7 Observability 与可见性

### 6.7.1 当前代码事实

`recordPain()` 的观测开关是 `input.recordObservability !== false`（`pain-to-principle-service.ts:210`、`:255`），即**默认开启**。

| 开关 | 写入内容 |
|---|---|
| `true`（默认） | ① `trajectory.db` 的 `sessions` + `pain_events`（`:128-175`）；② `logs/events_<date>.jsonl`（`:228-243`）；③ `evolution.jsonl`（`recordPainSignalObservability` 其余部分）；④ `tasks` + `diagnostic_json`（由 bridge 写） |
| `false` | 跳过 ①②③，**仅**写 `tasks` + `diagnostic_json` |

**关闭后的真实后果**（F65）：

- Console 的 Pain 视图读 `trajectory.db`（`sqlite-context-assembler.ts:458-459`）→ **看不到**该 Pain；
- Pain Recall 会走 state.db 回退路径，并给出 `pain_event_only_in_state_db` 警告（`pain-recall-capability.ts:233-239`）——能找到，但降级；
- 统计 / 历史回顾依赖 `pain_events` 的查询会**漏掉**该条；
- CLI 在无 bound session 时本来就传 `recordObservability:false`（`pain-record.ts:430`），因此 CLI 无 session 路径**已经**存在同一可见性缺口——这不是 MCP 独有的新问题。

### 6.7.2 目标行为

| 项 | 目标 |
|---|---|
| MCP 路径 | **不得**固定 `false`；使用默认 `true`，与 CLI 有 session 时一致 |
| 记录数量 | 每个 Pain 只写一份 `pain_events`（`canonical_pain_id` 唯一索引 + UPSERT，`pain-signal-observability.ts:146-205`），不制造重复 |
| 无 session 时 | 沿用既有 `sessionId ?? 'cli'` 兜底（`:128`、`:222`），并写入 `host_kind`；不新增 session 伪造 |
| 三宿主 | 同一套写入路径，不按宿主分叉 |
| 不新增 | 不新增 Pain 表、不重设 Observability、不降低 Console/Recall 的既有可见性要求 |

**判定依据**：只要 `tasks` + `diagnostic_json` 不足以让 Console 与 Recall 看到该 Pain，就**不能**用 `recordObservability:false` 换取"少写一行"。本设计选择保留既有三处观测写入。

---

# 7. StateDir、宿主差异与 Instructions

## 7.1 两个路径必须分开写

| 用途 | 路径 | 证据 |
|---|---|---|
| 原则账本、会话、`.pain_flag` 等 | `<workspace>/.state/` | F15；`D:\.openclaw\workspace\AGENTS.md:15-22`（E2） |
| SQLite 状态库 | `<workspace>/.pd/state.db` | F14 |

规则：

- capability 用 `stateDir = join(workspaceDir, '.state')` 构造账本适配器；
- `PainToPrincipleService` 同时接收 `workspaceDir` 与 `stateDir`；
- Console / worker / MCP 必须指向**同一个 workspace**，否则回执的 `workspaceDir` 与任务行所在库不一致；
- 回执只报 `workspaceDir`，不报 `stateDir`（避免把实现细节暴露给 Agent，也避免两个路径被混用）。

## 7.2 三宿主来源与绑定

| 宿主 | workspace 来源 | `hostKind` 映射 | 来源字段 | 可证事实 |
|---|---|---|---|---|
| OpenClaw | `PD_MCP_WORKSPACE_DIR`（launcher 注入） | `openclaw` | `origin.kind=owner_manual` + `channel=mcp_agent_assisted` | 绑定与 host 标记 |
| Codex | 同上 | `codex` | 同上 | 同上 |
| WorkBuddy | 同上 | `workbuddy` | 同上 | 同上 |

规则：

- 三宿主共用**同一个** Tool 描述、同一份 JSON Schema、同一条 Handler 路径；不按宿主分叉准入、不按宿主分叉评分。
- `PD_MCP_HOST` 只用于 `hostKind` 与日志，不用于 `mode`、不用于准入、不用于选择执行者（F11），也不用于更改来源语义。
- 三宿主的来源都是 `mcp_agent_assisted`（§6.6）：Agent 观察 + Owner 在宿主对话授权；**不得**因为宿主不同而把某一宿主标成 `owner_reported_no_host_trace` 或复用 CLI channel。
- 授权发生在**宿主对话**中：有 askme 优先用 askme；没有就用普通对话。回复不明确、拒绝或未回复 = 不提交；后台无人值守不得擅自提交；**不要求**打开 Companion 或 Web Console。
- 原生确认（宿主自带的审批/确认 UI）是**推荐**而非强制：有则用，没有不得因此阻塞或改走审批服务。

## 7.3 Instructions 清单与必须改写的内容

| 宿主 | 真实文件 | 现状 | V0.8 必须改成 |
|---|---|---|---|
| OpenClaw + Codex（共用） | `plugins/principles-disciple/skills/pd-pain-signal/SKILL.md` | 只有 Owner 明确要求才登记；`owner_statement`；500 字 | 锚点三源、六项内容、先问 Owner、未回复=拒绝、仅本次、后台禁止、默认中等、不写 score |
| WorkBuddy | `packages/workbuddy-adapter/plugin/skills/pd-pain-signal/SKILL.md` | 同上 | 同上，保持与本宿主既有交互方式一致 |
| 用户级 WorkBuddy（安装产物） | `~/.workbuddy/skills/pd-record-pain/SKILL.md` | 固定前缀 `PD记录痛苦：`、500 字、后台自动诊断说法 | 由安装器识别并**废弃**；不再作为 canonical Skill（§7.4） |

Codex 的分发路径是插件清单：`plugins/principles-disciple/.codex-plugin/plugin.json:19` 指向 `./skills/`，所以 Codex 读到的就是仓库内那份共用 Skill；不需要另建 `~/.codex/skills/pd-*`（E2 实测不存在）。

## 7.4 WorkBuddy Skill 分发与旧文件废弃（裁定 2，已实现）

> **实现状态**：旧文件识别/废弃逻辑已实现（`installers/legacy-workbuddy-skill.ts`，重命名为 `SKILL.md.deprecated-<label>`，用户改过的副本只告警不覆盖），插件根 `pd-pain-signal` 由安装器强制校验（T39）。下表保留为目标行为与验收依据。

| 问题 | 目标答案 | 依据 |
|---|---|---|
| 谁分发 | 安装器 `npx create-principles-disciple`（唯一写入方） | F53；AGENTS §1.1 |
| 分发到哪里 | WorkBuddy **插件根** `skills/pd-pain-signal/SKILL.md` | F53 的 `WORKBUDDY_REQUIRED_SKILLS` |
| canonical 源 | `packages/workbuddy-adapter/plugin/skills/pd-pain-signal/SKILL.md` | F20 |
| 被废弃的旧文件 | `~/.workbuddy/skills/pd-record-pain/SKILL.md` | F21 |
| 旧文件如何识别 | 路径 + frontmatter `name: pd-record-pain`；不按内容模糊匹配 | 目标 |
| 未改过的旧副本 | 重命名为 `SKILL.md.deprecated-<version>` 保留原件，不删除 | 目标 |
| 用户改过的副本 | 不覆盖、不删除；写 `deprecated_skill_modified` 告警并给人工处置指引 | 目标（Owner 追加裁定 2） |
| 执行时机 | 每次安装/升级一次，幂等；已废弃文件不再参与 Skill 发现 | 目标 |
| 不做什么 | 不在 `~/.workbuddy/skills/` 新建 `pd-pain-signal`——会违反"不创建第二份全局副本"（F54） | F54 |

**升级时对用户改过副本的处理顺序**：

1. 计算旧文件哈希；
2. 命中任一已发布旧版本 → 视为未改，可安全重命名；
3. 未命中 → 保留原文件，记 `deprecated_skill_modified`；
4. 该告警必须出现在**安装摘要**里，不能只写日志；
5. 不得因为告警而中止安装，也不得静默忽略。

---

# 8. 执行路径

## 8.1 分层事实（先把边界说清）

| 问题 | 事实 |
|---|---|
| 谁会执行 pending 诊断 | Codex/WorkBuddy worker（自动）、`pd diagnose run`（手动）、Console（L2）、OpenClaw service（L3） |
| worker 是否只处理本宿主的 Pain | **不是**；按 `task_kind` + 状态取任务（F35） |
| Console 现在能执行吗 | **不能**；它只能看状态（F28-F33 无执行路由） |
| 提交后一定有人执行吗 | **不一定**；这正是 L2/L2b/L3 要解决的问题 |
| 同一任务会并发执行吗 | 不会；`executePendingDiagnosis` 用租约，后到者 `lease_conflict` |

## 8.2 L2：Console 一键执行

### 8.2.1 路由

```text
POST /api/diagnostician/:taskId/run
Content-Type: application/json
Body: {}（可为空）
```

### 8.2.2 前置校验（全部在 spawn 之前）

| 顺序 | 校验 | 失败返回 |
|---|---|---|
| 1 | 同源校验（§8.2.3） | 403 `cross_origin_rejected` |
| 2 | `Content-Type: application/json` | 415 `unsupported_media_type` |
| 3 | `state.db` 存在 | 404 `workspace_state_missing` |
| 4 | 任务存在且 `task_kind='diagnostician'` | 404 `task_not_found` |
| 5 | 状态为 `pending`，或 `retry_wait` 且退避已到期 | 409 `not_runnable` |
| 6 | 已持有有效租约 | 409 `already_leased` |
| 7 | CLI 预检：`pd diagnose run --task-id <id> --workspace <ws> --preflight --json` | 409 `capability_disabled` / `runtime_unbound` / `config_malformed` + nextAction |
| 8 | 预检进程 3s 未退出 | 504 `preflight_timeout`（不 spawn） |

第 7 步为什么走子进程：runtime 解析的唯一生产入口在 `pd-cli/src/services/resolve-runtime-from-pd-config.ts:113-196`，Console 不能复制它（P4），也不能跨包 import CLI service。给既有 `diagnose run` 增加一个 **`--preflight` 开关**（只解析、不租约、不调用模型、不写状态），比在 Console 里重写解析逻辑更小、更诚实。

CLI 内部仍会在真正执行时再检查一次（防御纵深）；Console 的 202 不是最终执行结果。

### 8.2.3 同源校验

Console 已有 Bearer + loopback（F28/F29），但缺 CSRF/Origin（F30）。L2 必须补：

```text
if Origin header exists:
    u = URL(Origin)
    require u.host === Host header
else if Sec-Fetch-Site exists:
    require it is "same-origin" or "none"
else:
    allow（非浏览器客户端，例如 CLI/脚本）
```

再加 `Content-Type: application/json`：跨站表单无法在不触发 preflight 的情况下伪造该类型。

不新增 CSRF token、不新增签名、不引入代理信任（`X-Forwarded-*` 不参与判定）。Console 当前只支持 loopback；远程/反代场景不在本版范围。

### 8.2.4 spawn 与 202

- 入口解析复用 `packages/pd-console/src/server/utils/installed-layout.ts` 的 `pdCliDir`，拼 `dist/index.js`，并做"必须在 `pdCliDir` 内"的前缀校验（与 `utils/cli-smoke.ts:34-39` 同形）；不猜全局 `pd`。
- 用 `process.execPath` + argv 数组，不用 `node` 字符串命令（Windows PATH 不可靠），不经过 shell。
- `detached:true, stdio:'ignore', windowsHide:true`，沿用 F32 先例；**只有预检通过后才 spawn 真实执行**。
- 同时监听 `spawn` 与 `error`：
  - `error` → 500 `spawn_failed`，**零状态变更**；
  - `spawn` → 202；
  - 2s 内两者都没发生 → 500 `spawn_unconfirmed`（不声称已受理）。
- 202 响应：

```jsonc
{
  "state": "diagnosis_accepted",
  "taskId": "...",
  "workspaceDir": "...",
  "nextAction": "执行已启动；用 GET /api/diagnostician/backlog 观察 runs 记录。"
}
```

202 只表示"子进程已启动"，不表示诊断成功。

### 8.2.5 并发

- 不加锁文件、不加去重表；
- 连点两次 → 两个子进程 → `executePendingDiagnosis` 的租约决定只有一个真正执行；另一个返回 `lease_conflict` 并退出；
- 这是"执行恰好一次"，不是"spawn 恰好一次"；文档和 UI 都必须这样表述。

## 8.3 L2b：Console 积压可见

### 8.3.1 先连接既有能力，而不是新建投影

仓库**已经存在** `StalledDiagnosticianTaskReadModel`（F49）：它判定 `pending + attempt=0 + 无 runs + 超阈值`，并给出 `pd diagnose run` 的 nextAction；CLI `pd diagnose status` 已在使用。它的活动判据正是 `getRunsByTask`（F50），**没有** V0.6 的 `updated_at` 假阳性问题。

因此 L2b 的正确做法是：

- **扩展** `StalledDiagnosticianTaskReadModel`，新增 `getBacklog()`；
- **不改** `aggregatePipelineHealth`（F38，会把学习队列语义污染）；
- **不新增** `TaskStore.getDiagnosticianBacklog()`（既有读模型已是 owner）；
- 新增 `GET /api/diagnostician/backlog`，路由只做参数与形状转换。

### 8.3.2 活动信号

**禁止**用 `MAX(tasks.updated_at)` 作为"最近执行活动"：`createTask` 同时写 `created_at` 与 `updated_at`（F10），新建 pending 会被误判。

正确信号：`runs.started_at`（F42）。为避免在路由层写 SQL，在既有 `RunStore` 上增加一个只读方法：

```ts
getLatestRunStartedAtForTaskKind(taskKind: string): Promise<string | null>
```

SQL 形状：

```sql
SELECT MAX(r.started_at)
FROM runs r
JOIN tasks t ON t.task_id = r.task_id
WHERE t.task_kind = ?
```

- `observedRecentActivity = lastRunStartedAt != null && now - lastRunStartedAt < 30min`；
- 该值只回答"最近有没有可观察的执行活动"，**不回答**"worker 是否存活"。

### 8.3.3 返回结构

```jsonc
{
  "workspaceDir": "<abs>",
  "generatedAt": "<iso>",
  "pendingCount": 0,
  "retryWaitCount": 0,
  "leasedCount": 0,
  "staleLeaseCount": 0,
  "stalledCount": 0,
  "oldestPendingTaskId": null,
  "oldestPendingPainId": null,
  "oldestPendingCreatedAt": null,
  "oldestPendingAgeMs": null,
  "lastRunStartedAt": null,
  "observedRecentActivity": false,
  "health": "idle",
  "configuration": {
    "l3FlagEnabled": true,
    "capabilityAvailable": true,
    "runtimeBound": true
  }
}
```

- `stalledCount` 直接复用 `listStalledTasks(thresholdSeconds)` 的长度；
- 计数用 `listTasks({taskKind:'diagnostician', status})`（F51）；
- `staleLeaseCount` = `status='leased' AND lease_expires_at < now`；
- `oldestPendingCreatedAt` 取 pending 中最小 `created_at`；对应的 `task_id` 与 `input_ref` 分别填 `oldestPendingTaskId` / `oldestPendingPainId`。

`health` 取值：

| 值 | 判定 | 含义 |
|---|---|---|
| `idle` | 无 backlog | 没有待执行任务 |
| `running` | `leasedCount > 0` | 至少有一个任务持有租约 |
| `backlog` | 有 backlog 且 `observedRecentActivity` | 有积压，但最近有执行活动 |
| `stalled` | 有 backlog 且无最近活动 | **没有观察到执行活动**，不是"worker 已死" |

`configuration` 只报告配置事实，不声称服务在运行。措辞边界必须写进 UI 文案；`health='stalled'` 的文案是"未观察到执行活动"，不是"执行器已停止"。

## 8.4 L3：OpenClaw 自动执行

### 8.4.1 入口

```ts
runPendingDiagnosticianOnce({
  workspaceDir: string,
  owner?: string,
  limit?: number,   // 默认 1
  now?: string,
}): Promise<{ served: boolean; taskId?: string; reason: string }>
```

### 8.4.2 三前提

三者同时成立才执行：

1. `openclaw_diagnostician_consumer` flag 开启（默认开）；
2. `resolveDiagnosticianCapability` 可用；
3. 承载 timer 的 `internalization_auto_consumer` service 已启动（F37）。

任一不成立 → 返回 `skipped` + 结构化 reason（`flag_off` / `capability_disabled` / `service_not_running`），并写一条可观察日志；**不静默**。

### 8.4.3 选取任务：复用既有游标 authority，不新增 `cursorScope`

- V0.6 的 `cursorScope` 参数**删除**；
- 把 Codex worker 的 `pickDiagnosticianCandidate`（含 pending / retry_wait 公平轮转，F39）抽到 core：
  `packages/principles-core/src/runtime/diagnostician-candidate.ts`；
- scope 常量从 `codex-worker-diagnostician-fair-share` 改为 host-neutral 的 `diagnostician-fair-share`；
- Codex worker 与 L3 共用该函数；
- 不新增游标表、不新增字段、不新增参数；游标仍存在既有的 `reconciliation_cursor`。
- 游标 key 改名只影响一次轮转起点，不影响任务数据；回滚 = 改回旧 key。

WorkBuddy 的简化选取器（F40）**本版不动**，避免扩散；它已能保证 pending 不饿死。该重复列入 follow-up。

### 8.4.4 周期

复用 `internalization-auto-consumer-service` 的 120s tick（F37），每轮最多 1 条。

不挂同步 hook：诊断是分钟级调用，挂在对话轮次上会阻塞宿主。

## 8.5 L1（同步 hook 内执行）否决

| 方案 | 否决理由 |
|---|---|
| 在对话 hook 里同步跑诊断 | 分钟级调用阻塞宿主；超时后无法区分"没跑"与"跑了没返回"；与 10s MCP deadline 冲突 |
| MCP 内部直接跑诊断 | 违背"提交即返回"；MCP 进程生命周期由宿主控制，长任务会被杀 |
| 在 MCP 里 spawn CLI | 把执行责任塞进入口适配器；三宿主会各自复制；破坏 P4 |

---

# 9. 幂等、并发、失败

| 场景 | 行为 | 证据/约束 |
|---|---|---|
| 同一 Agent 重复提交 | v1 不去重；每次新 `painId` | SPEC §8 |
| 两次提交内容相同 | 两条独立任务；不与既有任务合并 | 同上 |
| `createTask` 主键冲突 | 回执 `failed` + `task_duplicate`，不静默 | F10 |
| 写入后进程崩溃 | 任务行仍在；下次启动可见 | SQLite |
| 写入成功但响应超时 | 用预生成 `taskId` 有界回查 → 命中即最小 `submitted` | §5.7、F60/F61 |
| 超时后回查未命中 | `submit_unconfirmed`；**不**称"未创建"、**不**自动重试 | §5.7 |
| 回查本身失败/再次超时 | `submit_unconfirmed`，给对账方法 | §5.7 |
| 后台写入迟到完成 | 回执仍是 `submit_unconfirmed`；对账时 `getTask` 命中即证明已写入 | §5.7 |
| 并发提交 | SQLite 既有并发控制；失败即 `failed` | F10 |
| 并发执行 | 租约；后到者 `lease_conflict`，不消耗 attempt | F36 |
| 账本不可读 | `anchor_unverifiable`，失败关闭 | F16 |
| 能力关闭 | 任务仍创建；回执 `submitted` + `nextAction` | F9 |
| 自动消费者不存在 | 任务停在 pending；L2b 显示 `stalled` | §8.3 |

---

# 10. 测试设计（A / B / C 三类）

## 10.1 A 类：开发前事实核验（不写产品代码）

目的：防止把"记忆中的架构"当成实现现实。

| 编号 | 核验 | 期望 | 证据 |
|---|---|---|---|
| A01 | `state.db` 路径 | `<ws>/.pd/state.db` | F14 |
| A02 | 账本路径 | `<ws>/.state/principle_training_state.json` | F15 |
| A03 | `createTask` 时间戳 | `created_at == updated_at` | F10 |
| A04 | `severityFromScore(undefined)` | bridge 为 `moderate`；observability 的**本地**版本只接受 `number`，`undefined` → `mild` | F23、F65 |
| A05 | `diagnostic_json` 是否含 `painType` | 目标为**是**（单一路径始终写 v1），当前 legacy 行可能不含 | F55、F13 |
| A06 | 既有公平游标 | `reconciliation_cursor`，Codex 已用 | F39 |
| A07 | Console 是否有 CSRF/Origin 校验 | 否 | F30 |
| A08 | `pd diagnose run` 缺 runtime | 失败 + nextAction | F33 |
| A09 | 三宿主 Instructions 路径 | 仓库内两份 + 用户级一份 | F19-F21 |
| A10 | `runs.started_at` 可用 | 是，且有索引 | F42 |
| A11 | 默认 `score=80` 的位置 | 功能默认四处 + 展示一处 | F24、F26 |
| A12 | `readTrustedPrinciples()` 返回哪些状态 | 仅 `candidate` / `probation` / `active` | F57 |
| A13 | `parseOrigin()` 是否接受 `mcp_agent_assisted` | 否（需扩展白名单） | F62 |
| A14 | OG-4 是否已授权 | 否；`pd_submit_pain` 尚不存在 | F64 |
| A15 | `getTask(taskId)` 命中能证明什么 | 证明任务行存在（本次 `painId` 唯一），不证明诊断执行 | F61、§5.7 |
| A16 | `pain_events.score` 是否可空 | `REAL NOT NULL`，不能"不写" | F26 |

## 10.2 B 类：开发阶段自动化

### 10.2.1 提交链路（对齐 SPEC T01–T23）

| SPEC | 测试落点 | 断言 |
|---|---|---|
| T01 | `packages/pd-mcp-server/src/__tests__/submit-tool.test.ts` | **前置：OG-4 已授权**（未授权时 `pd_submit_pain` 不进入生产注册，见 T43）；满足后 `tools/list` 同时包含 `pd_submit_pain` 与 `pd_recall_principle_pains` |
| T02 | 同上 | 缺 `reason` / 超 2000 / 非法 enum → 结构化错误，且 `getTask` 无新行 |
| T03 | `pain-submit-capability.test.ts` | `diagnostic_json.anchor == {type, ref}` |
| T04 | 同上 | 缺 `anchorType`/`anchorRef` → schema 拒绝，无新行 |
| T05 | 行为验收（C 类） | `inference` 单独支撑的提交不发生；服务器不伪称能判断 |
| T06 | 行为验收（C 类） | 冲突锚点双方都出现在 `reasonSummary` |
| T07 | 提交能力测试 + CLI 测试 + 观测测试 | MCP 不传 score；CLI 省略 `--score` 写 `DEFAULT_PAIN_SCORE = 40`；读回 `tasks.diagnostic_json.severity`、`pain_events.score`、events JSONL 三处均为 `moderate`（40），**任何一处都不得是 80/severe**；显式 `--score 80` 仍为 `severe` |
| T08 | 提交能力测试 | schema 不含 `score`/`severity`；多余字段被 `additionalProperties:false` 拒绝 |
| T09 | 提交能力测试 + 持久化读取 | 省略 `painType` → 写入 `principle_deviation`，且仍构造 `painIngress.v1`、仍走 `evaluatePainIngress()`；**不得**出现 `user_frustration`；带/不带 `painType` 的重入校验与准入结果一致 |
| T10 | 集成测试 | `tasks` 1 行，`task_kind='diagnostician'`，`status='pending'`，`input_ref=painId` |
| T11 | 回执测试 | 含 `painId` / `taskId` / `workspaceDir` / `status` |
| T12 | 回执测试 | 默认无 `mode`；伪造可证信号时才有 |
| T13 | 失败测试 | 失败 `isError:true` + 结构化 reason |
| T14 | 预算测试 | 构造超预算输入 → 仍 `submitted` + 最小字段 |
| T14b | 预算测试（极端） | 构造"最小回执仍超预算"路径 → 如实说明已写入/状态未知 + `taskId`；不得写"实际不可能" |
| T15 | 重复提交测试 | 两个不同 `painId`，两条任务 |
| T16 | 并发测试 | 无半写；失败者结构化 |
| T17 | 诊断材料测试 | 诊断 prompt 能读到 `anchor` 与六项 `reasonSummary` |
| T18 | 契约测试 | 三宿主共用同一 schema/回执（同一 server 实例参数化） |
| T19 | 提交能力测试 | `correlation.status='unbound'`，无 `sessionId` |
| T20 | 提交能力测试 | 无 `evidence`，`not_applicable_unbound` |
| T21 | 适配器测试 | codex/workbuddy worker 可消费 OpenClaw 提交的任务 |
| T22 | C 类 | 三宿主真实可读到 Instructions |
| T23 | C 类 | 未授权不提交；后台 Agent 不提交 |

### 10.2.2 执行链路与分发（对齐 SPEC T31–T40）

| SPEC | 测试落点 | 断言 |
|---|---|---|
| T31 | `diagnostician.test.ts` | pending → 202 后 `runs` 出现新行，状态离开 pending |
| T32 | 同上 | 403/415/404/409 各路径 `getTask` 不变 |
| T33 | 同上 | 两个并发请求只产生一个有效租约 |
| T34 | `diagnostician.test.ts` + `stalled-diagnostician-task.test.ts` | backlog 的数量/时长/最老 ID/stalledCount 与直接 SQL 一致 |
| T35 | `stalled-diagnostician-task.test.ts` | 新建 pending 后 `observedRecentActivity=false`；有 run 后才 true |
| T36 | OpenClaw service 测试 | 三前提成立 → 两轮 tick 内离开 pending |
| T37 | 同上 | 单轮最多 1 条 |
| T38 | 同上 | flag 关 → 停在 pending，日志 `flag_off`（`mode` 本就不返回） |
| T39 | `packages/create-principles-disciple/tests/workbuddy-skill-delivery.test.ts` | 插件根含 `pd-pain-signal`；旧用户级 `pd-record-pain` 被识别并重命名；改过的副本不被覆盖且出现在安装摘要 |
| T40 | `packages/pd-cli/tests/commands/pain-record-async.test.ts` | 未开 `diagnostician_async_cli` → 仍走等待诊断的既有路径；显式开启后才提交即返回 |

### 10.2.3 补充测试（V0.6 未覆盖）

| 编号 | 场景 | 断言 |
|---|---|---|
| X01 | 账本损坏 | `anchor_unverifiable`，不创建任务 |
| X02 | 原则不存在 | `anchor_not_found`，不创建任务 |
| X03 | 原则已归档 / 已废弃 / 仍是 candidate | **拒绝**（`anchor_not_currently_valid`），不得只给 warning 就当作有效依据（§5.6.1） |
| X04 | 超时读回命中 | 最小 `submitted`，不是 `failed` |
| X05 | 超时读回未命中 | `submit_unconfirmed`，不声称未创建 |
| X06 | 跨源 POST | 403，零变更 |
| X07 | 非 JSON Content-Type | 415，零变更 |
| X08 | spawn error | 500，零变更 |
| X09 | 健康投影未被污染 | `aggregatePipelineHealth` 结果不含 diagnostician |
| X10 | 游标 key 改名 | 轮转重置一次，任务数据不变 |

### 10.2.4 post-review 新增测试（T41–T45）

| SPEC | 场景 | 断言 |
|---|---|---|
| T41 | 超时身份与对账（10 例） | ①写入前失败；②写入成功；③写入后回执超预算；④写入中超时；⑤超时后回查命中；⑥超时后回查未命中；⑦回查本身失败；⑧后台写入迟到完成；⑨两次并发写入；⑩结果未知时不自动重提交。每例都断言 `painId` 在写入前已存在、`taskId` 确定性派生 |
| T42 | 有效锚点十例 | active+范围匹配（接受）、active+不适用（背景）、candidate（背景）、probation（接受但披露）、archived（拒绝）、deprecated（拒绝）、不存在（拒绝）、版本错误（拒绝）、Ledger 损坏（失败关闭）、Owner 当前要求与历史原则冲突（按 `owner_expectation` 且披露冲突） |
| T43 | OG-4 门槛 | OG-4 是**生产交付 Gate**，不是新增系统建设任务。OG-4 未授权 → 生产环境不注册写类 MCP Tool，`pd_submit_pain` 不得出现在生产 `tools/list`；授权后才注册并声明 `readOnlyHint:false`；不得自行宣称已获授权，不得用宿主 matcher 或本地开关补齐 |
| T44 | 来源归属（7 例） | ①MCP Agent 的 Unbound 报告**可进入统一提交路径**（`action: 'submit'`）；②**不出现** CLI `--session` 重提提示；③provenance 正确派生 `agent_reported_owner_approved`；④Owner 授权的空证据准入符合 SPEC；⑤Console / Read Model **不显示为 Owner 亲自报告**；另断言不写 `owner_statement`、不标 `user_frustration`、`origin.channel=mcp_agent_assisted`、`parseOrigin` 接受 |
| T45 | Observability A/B | A(true) 与 B(false) 各自写了哪些记录；B 下 Console 不可见、Recall 出现 `pain_event_only_in_state_db`；选定的 MCP 路径必须可见（`pain_events` 有行） |

## 10.3 C 类：开发后三宿主真实验收（10 个场景）

这些必须在真实安装产物上做，不能用单元测试替代。

| 编号 | 宿主 | 场景 | 通过标准 |
|---|---|---|---|
| C01 | OpenClaw | 真实对话中 Agent 发现背离，先问 Owner，Owner 同意后提交 | `state.db` 出现任务；`diagnostic_json.anchor` 正确；回执 `submitted` |
| C02 | Codex | 同上 | 同上；且 Codex 用的是仓库内共用 Skill |
| C03 | WorkBuddy | 同上 | 同上；且 WorkBuddy 用的是其独立 Skill 副本 |
| C04 | 三宿主 | Owner 拒绝 / 不回复 | 零任务；Agent 不调用 Tool |
| C05 | 三宿主 | Owner 修改内容后 | Agent 再次确认后才提交；`reason` 是最终版本 |
| C06 | OpenClaw | L3 flag 开 + 能力开 + service 运行 | 两个 120s tick 内任务离开 pending；`runs` 有行 |
| C07 | OpenClaw | L3 flag 关 | 任务停在 pending；backlog 最终显示 `stalled`；日志 `flag_off` |
| C08 | Console | 对 pending 任务点"执行" | 子进程真实启动；`runs.started_at` 更新；不是只看 202 |
| C09 | Console | 跨源 POST | 403；任务状态不变 |
| C10 | Console | 积压页 | 新建 pending 不显示"最近有活动"；有真实 run 后才显示 |

## 10.4 测试替身与红线

- 允许：内存 SQLite、临时 workspace、注入时钟。
- 禁止：
  - 用 mock 取代 `createTask` 来证明"落库"；
  - 用 UI 快照证明"执行了"；
  - 用 flag 默认值证明"自动消费者可用"；
  - 为了让测试通过而放宽 `anchorType` 必填或删除 `additionalProperties:false`。

---

# 11. 实施顺序

0. **OG-4 定位**：它是生产交付 Gate，不阻断开发启动（§5.1.1）。未授权时允许实现 Core Capability / MCP Handler / 准入与持久化逻辑、编写并运行测试、在隔离非生产环境做端到端验证；**禁止**生产注册、生产分发、正式发布，以及用本地开关或宿主 matcher 绕过。
1. **A 类核验**复跑一次（16 条），确认本文件事实仍成立。
2. core：`anchor` 字段 → `buildDiagnosticJson` → `pain-submit-capability`；`painType` 单一路径 + `principle_deviation`；四处 `DEFAULT_PAIN_SCORE`；来源 channel/provenance 扩展（§6.6），**含 `evaluatePainIngress()` 的 `mcp_agent_assisted` 分支（先于通用 Unbound 分支，§6.6.5）**。
3. MCP：schema + description + handler + **预生成 painId/taskId** + 预算/超时回查。
4. 单测：T01–T22（不含 T05 / T06 / T23 行为类）+ T41–T45。
5. Console L2：同源 + 预检 + spawn + 202/403/415/404/409；L2b：store 读取 + 路由。
6. L3：共享 picker + service 一轮 + flag + lifecycle。
7. Instructions：两份仓库内 Skill 改写 + 安装器旧 Skill 废弃（§7.4）。
8. CLI：`pain-record.ts` 四处默认值改 `DEFAULT_PAIN_SCORE = 40`；补 CLI 测试；`diagnostician_async_cli` 保持默认关。
9. B 类全量；C 类三宿主验收。
10. 重新安装后再跑一次 C 类（安装产物与仓库可能不同，AGENTS §1.1）；T39 必须在这一步验证。

---

# 12. Complexity Delta

## 12.1 提交链路

| 项 | 值 | 说明 |
|---|---|---|
| 新持久真源 | **NO** | 仍是 `tasks` + `diagnostic_json` |
| 新持久 schema/state | **NO** | 无新列、无新表 |
| 新子系统/服务/后台进程 | **NO** | 复用 `PainToPrincipleService` |
| 新公共抽象/接口 | **YES** | 新 Tool + `pain-submit-capability` 子路径；隐藏了校验/组包/回执复杂度 |
| 新运行时 flag | **NO** | — |
| 新跨包依赖 | **NO** | `pd-mcp-server → core` 已存在 |
| 新宿主特定行为 | **NO** | 一个 server，三宿主共用 |
| 新外部/网络能力 | **NO** | — |

> post-review 补充：`painType` 加一个中性值、来源加一个 channel / provenance 值、`DEFAULT_PAIN_SCORE` 加一个常量，都**不**新增持久真源、不新增表/列、不新增子系统；它们是对既有字符串联合与既有默认值的替换，属"最小字段扩展"，影响面见 §6.3.5 / §6.6.4。

## 12.2 执行链路

| 项 | 值 | 说明 |
|---|---|---|
| 新持久真源 | **NO** | 游标仍在 `reconciliation_cursor` |
| 新持久 schema/state | **NO** | 无新表/列 |
| 新子系统/服务/后台进程 | **NO** | 复用既有 120s service |
| 新公共抽象/接口 | **YES** | 2 个 Console 路由 + 1 个 CLI 预检开关 + 1 个只读 run 查询 + 现有读模型的 `getBacklog()` + 1 个共享 picker |
| 新运行时 flag | **YES** | `openclaw_diagnostician_consumer` |
| 新跨包依赖 | **NO** | — |
| 新宿主特定行为 | **YES** | OpenClaw service 接线 + WorkBuddy 安装期旧 Skill 处置（§7.4） |
| 新外部/网络能力 | **NO** | spawn 本地 CLI；模型调用是 CLI 既有能力 |

### 12.2.1 每个 YES 的必要性

- **新 Tool**：没有入口就无法提交；无法用 recall 复用（读写语义相反）。
- **Console 路由**：没有 L2，能力关闭或无 worker 时任务会永久 pending。
- **共享 picker**：避免第三个副本；游标 authority 已存在。
- **新 flag**：Owner 明确要求可独立关闭自动执行；不能复用 `internalization_auto_consumer`（语义不同，关掉会停学习流水线）。
- **安装器旧 Skill 处置**：不处置会让旧 Skill 继续被宿主发现并继续教 Agent 用旧格式；范围仅限一个已知路径，且是"重命名保留"而非删除，可逆。

---

# 13. 风险与回滚

| 风险 | 影响 | 缓解 | 回滚 |
|---|---|---|---|
| 账本读取失败导致合法锚点被拒 | Agent 无法提交 | 错误信息给 `pd principle list` 下一步；不把不可读当空 | 修复账本后重试 |
| `painType` 占位值泄漏到持久层 | 产生假类型 | X 测试锁定三条持久路径；代码审查 | 删除字段来源 |
| 同源校验误伤远程 Console | 远程无法执行 | Console 本版只支持 loopback；文档写明 | 关闭 L2 路由开关（若需要）或回退校验 |
| spawn 在 Windows 找不到 CLI | 202 后无执行 | 用 `process.execPath` + 绝对入口；`error` 事件 | 回到 CLI 手动执行 |
| L3 flag 默认开但能力关 | 空转 | 三前提门控 + 结构化日志 | 关 flag |
| 共享游标 key 改名 | 一次轮转重置 | 仅影响选择顺序 | 改回旧 key |
| 超时读回仍不确定 | 回执模糊 | `submit_unconfirmed` + 对账命令 | 人工查 `tasks` |
| Instructions 与 Tool 描述不一致 | Agent 行为分裂 | 两份 Skill 与描述同源改写；C 类验收 | 回退 Skill |
| 旧 Skill 识别误伤用户自定义内容 | 用户内容丢失 | 只认"路径 + frontmatter name"；哈希不匹配即保留并写安装摘要告警 | 从 `.deprecated-*` 恢复 |
| CLI 默认值改动影响既有脚本预期 | 严重度口径变化 | 只改"省略 `--score`"路径；四处一起改；显式传值不变；T07 双入口读回断言 | 回退该提交 |
| OG-4 未授权即上线写类 Tool | 治理违规 | §5.1.1 Gate + T43；未授权不注册进生产 `server.ts` | 从 `tools/list` 移除该 Tool |
| `painType` / provenance 扩展被下游漏接 | 解析失败或展示错误 | §6.3.5 / §6.6.4 逐一列出受影响文件；重入与写时共用 parser | 回退枚举值 + 迁移已写入行 |
| `recordObservability:false` 让 Pain 在 Console 消失 | Owner 看不到该 Pain | §6.7 选择保留默认 true；T45 对比 A/B | 改用默认 true，重建 `pain_events` 行 |
| 超时后误报"未创建" | Owner 对账混乱 | §5.7 只允许 `submitted` / `submit_unconfirmed`；T41 十例 | 以 `taskId` 对账修正回执 |

---

# 14. 交付验收："怎么证明真的跑了"

| 能力 | 不能作为证据 | 必须提供的证据 |
|---|---|---|
| MCP 提交 | `tools/list` 里有名字、按钮存在、flag 注册 | 真实宿主对话提交后：`state.db` 行 + `diagnostic_json.anchor` + 回执 `painId` 对账 |
| 默认中等 | 代码里写了 `moderate` | 真实提交后的 `tasks.diagnostic_json.severity='moderate'`、`pain_events.score=40`、events JSONL 三处一致，且本地回执不含 `score` |
| 授权 | Tool 有 description | C04/C05：拒绝/不回复=零任务；修改后再次确认；另需 OG-4 系统层授权记录（§5.1.1） |
| 有效锚点 | `warnings: non_active` 字样 | T42 十例：archived / deprecated / candidate 被拒绝，active 且 scope 匹配被接受；Owner 新要求走 `owner_expectation` |
| 超时对账 | 回执写着 `submitted` | T41 十例：`painId` 写入前已存在、`taskId` 确定性派生；未命中只返回 `submit_unconfirmed` |
| 来源归属 | `origin.kind=owner_manual` | T44：`channel=mcp_agent_assisted`、provenance 不显示成 Owner reported、`owner_statement` 为空 |
| 可见性 | `tasks` 有行 | T45：`pain_events` 有行；Console 能读到；Recall 不降级为 `pain_event_only_in_state_db` |
| L2 执行 | 202 响应、按钮变灰 | 子进程 PID/日志 + `runs.started_at` 新行 + 任务状态迁移 |
| L2b 积压 | UI 有数字 | 同一 workspace 直接 SQL 对账：数量、最老 `created_at`、`lastRunStartedAt` |
| L2b 不误报 | 页面显示"无活动" | 新建 pending 后仍为 `false`；真实 run 后才 `true` |
| L3 自动 | flag=on、service 代码存在 | 真实 pending 任务在两个 120s tick 内离开 pending，且有 `runs` 行 |
| 三宿主一致 | 三份文档写着一致 | C01–C03 三次真实提交的字段逐项相同 |

---

# 15. 结论与证据构成

| 等级 | 本文件中的内容 |
|---|---|
| E1 | F1–F65（除标注 E2/E3 的条目）；其中 F55–F65 为 post-review 复核事实（§2.8） |
| E2 | 安装环境 `.state` / `.pd` 并存；三宿主 Instructions 实际路径；用户级 WorkBuddy Skill |
| E3 | `spawn` 异步 error 语义 |
| E4 | 无（本文件不依赖未证实事实） |

**文档范围结论：`READY_FOR_IMPLEMENTATION_REVIEW`。**
**整体结论：`PARTIALLY_VERIFIED`**——提交链路与执行链路尚未在真实三宿主上落库取证；这只能在实现并重新安装后由 C 类验收完成。

---

# 16. 与 Owner 裁定的差异记录

## 16.1 A–D 执行口径

| 裁定 | 本文件的做法 | 与我上一轮建议的差异 |
|---|---|---|
| **A** `diagnosis.mode` 保留但可选 | §5.4.2：字段保留；v1 实际全部省略 | 我上一轮建议**删除字段**；按 Owner 改为**保留、可不返回** |
| **B** 原生确认推荐、非必要 | §5.2 描述 + SPEC §4.3：推荐开启，业务条件是对话授权 | 我上一轮倾向"可选忽略"；按 Owner 改为"推荐但非前置" |
| **C** 默认中等、取消固定 80 | §6.4：MCP 不写 `score`；提级仅人工。v0.8 起 CLI 手动入口同口径（§6.5） | 与建议一致；v0.7 时范围只到 Agent 提交，v0.8 Owner 追加裁定把 CLI 也统一 |
| **D** 不伪造"撤销上一轮 P0" | §16.2：只记录 V0.6 §4.2 条件性要求被降级 | 与建议一致 |

## 16.2 关于"撤销上一轮授权 P0"

本仓库的 V0.6 REVIEW **不存在**"Owner 授权 P0"这条记录。V0.6 的 P0 是另外五项（Codex 绑定键、OpenClaw MCP 恒 Unbound、复用 `recordExplicitOwnerStatement` 伪造原话、Bound 无准入收益、空证据短路位置）。因此本文件**不写"撤销"**，只准确记录：

> V0.6 §4.2 第 1 条把"宿主原生写入确认必须启用"作为**条件性要求**；V0.7 按 Owner 裁定 B 改为**推荐、非必要前置**。

不虚构 P0、不虚构草稿、不虚构历史决定。

## 16.3 三项追加裁定：当前代码事实 vs 目标行为

> **记账口径**：下表"当前代码事实"是改文档时的真实实现（历史）；"目标行为"是 Owner 已拍板、且已在阶段 1–4 落地的行为。真实环境验收状态见 §10 T01–T45。

| # | 裁定 | 当前代码事实 | 目标行为 | 文档落点 |
|---|---|---|---|---|
| 1 | `pd pain record` 默认严重度 | 功能默认四处：`pain-record.ts:125/469`、`pain-signal-observability.ts:159/161/221`，均 `?? 80` → `severe`（F24、F26） | 四处一起改为 `DEFAULT_PAIN_SCORE = 40` → `moderate`；`--score` 仅作人工提级通道且无法验明操作者身份 | SPEC §6.1/§6.4；本文件 §4.2/§4.4/§6.4/§6.5/§10 T07 |
| 2 | WorkBuddy 用户级 Skill | 安装器只校验插件根 Skill（F53），无旧文件处置（F54）；仓库无旧 Skill 源（F21） | 安装器统一分发 `pd-pain-signal` 到插件根；识别并废弃旧 `pd-record-pain`；用户改过的副本不覆盖、只告警 | SPEC §5.5；本文件 §7.3/§7.4/§10 T39/§11 |
| 3 | `diagnostician_async_cli` | quiet、默认关（F45）；开启后提交即返回（F46） | **保持默认关**，不随 L3 交付翻转；等真实取证后再评估 | SPEC §6.4/§10/T40；本文件 §4.4/§6.5/§10 T40 |

**为什么三项都只写目标、不写"已完成"**：本轮权限只到文档；任何"已改为中等 / 已分发 / 已保持"的完成态结论，都必须等实现后由 T07 / T39 / T40 的真实读回证明。

## 16.4 实施前置（外部前提，非设计待定项）

1. **OG-4 系统层授权**（§5.1.1）：这是**生产交付 Gate**，不是开发启动 Gate，也不属本轮实施范围。未授权时允许开发、实现、测试与非生产环境的端到端验证；**禁止**生产注册 `pd_submit_pain`、生产分发、正式发布，以及用本地开关/宿主 matcher 绕过。授权后才注册并声明 `readOnlyHint:false`，完成既有 matcher 与 tool-semantics 接入。不得自行宣称已获授权。**本节不新增审批系统，也不改宿主治理架构。**

已确定、不再作为待选项：provenance 新增 `agent_reported_owner_approved`（§6.6.4），配合 `origin.channel = mcp_agent_assisted`；不保留"复用 `owner_reported_no_host_trace`"作为备选。

## 16.5 post-review 七项修订对照

> 详细代码事实与证据见 `SPEC-PD-AGENT-PAIN-INGRESS-001-REVIEW.md` §8。本节只记录落点。

| # | 问题 | TD 落点 |
|---|---|---|
| P1-1 | `painType` 缺省走 legacy 导致准入分叉 | §6.3、§5.5、§10 T09 |
| P1-2 | archived/deprecated 可作锚点 | §5.6、§5.6.1、§10 X03/T42 |
| P1-3 | 超时后无已知身份回查 | §5.5、§5.7、§9、§10 T14b/T41 |
| P1-4 | 四处默认 `score=80` | §6.4、§6.5、§10 A11/T07 |
| P1-5 | 写类 MCP 缺 OG-4 合同 | §5.1.1、§11 第 0 步、§16.4 |
| P2-1 | Agent Observation 来源语义 | §6.6、§7.2、§10 T44 |
| P2-2 | `recordObservability:false` 的产品影响 | §6.7、§10 T45 |

---

# 附录 A：Codex "Bound" 不作为目标

- 本版不引入全局 Session Registry、Context Lease、临时上下文数据库或跨进程同步。
- Codex 的 `correlation=unbound` 是**可接受**的诚实状态；它只影响证据关联，不影响提交与执行。
- 不允许为了"三宿主都显示 Bound"而伪造 sessionId 或新增状态库。

# 附录 B：本版明确不做

| 不做 | 原因 |
|---|---|
| 去重 / 限流 / exactly-once | 不在 v1；租约已保证执行不并发 |
| 数字评分 / 自动提级 | Owner 裁定 C |
| 新增 `pains` 表 / 审批库 / 调度器 | P4/P7 |
| 修改 `aggregatePipelineHealth` | 会污染学习队列语义 |
| 新增 `cursorScope` | 既有 `reconciliation_cursor` 已是 authority |
| MCP 内直接跑诊断 | 违背提交即返回；长任务会被宿主杀 |
| 远程 Console / 反代信任 | 本版只支持 loopback |
| 三宿主逐次 MCP Approval 作为验收前提 | Owner 裁定 B |

---

# 修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| 0.8 finalization | 2026-11-10 | 四项修订，版本号仍为 0.8：§5.2 Tool Description 取消"未来任务会改变判断"前置，改为替代表达 + 四项"不要求"；§5.1.1/§11.0/§16.4 OG-4 改为"未授权允许开发与测试 / 禁止生产注册与交付"；新增 §6.6.5 `evaluatePainIngress()` MCP 专用分支（先于通用 Unbound 分支、统一 submit、无 `--session` 提示、provenance 走既有派生）并更新 §6.6.4 影响面与 T44（5 项断言）；SPEC §2 Origin 表达统一为 `origin.kind` + `origin.channel` |
| 0.8 post-review corrections | 2026-11-10 | 七项定点修订，版本号仍为 0.8：§5.1.1 OG-4 治理合同；§5.5 身份预生成；§5.6/§5.6.1 有效锚点；§5.7 `submit_unconfirmed` 与有界回查；§6.3 `painType` 单一路径 + `principle_deviation`；§6.4/§6.5 四处 `DEFAULT_PAIN_SCORE=40` 与 `--score` 权限边界；§6.6 来源 channel/provenance 扩展；§6.7 Observability 可见性；§7.2 三宿主来源；§9 失败与幂等；§10 A11–A16 / T14b / T41–T45；§16.4 两项待确认 |
| 0.8 | 2026-11-10 | Owner 追加裁定 1–3：CLI 省略 `--score` 改落 moderate（已于阶段 1–4 落地，§6.5）；WorkBuddy Skill 由安装器分发并废弃旧 `pd-record-pain`（§7.4，已实现）；`diagnostician_async_cli` 保持默认关；新增 F53–F54、T39–T40；三项待确认清零 |
| 0.7 | 2026-11-10 | 按 Owner A–D 裁定重写；锚点三源与六项内容；`anchor` 落 `diagnostic_json`；默认中等；`mode` 可选且 v1 省略；授权模型；L2 同源+预检+spawn；L2b 扩展既有 `StalledDiagnosticianTaskReadModel` 并用 `runs.started_at`；L3 复用既有游标 authority 并删除 `cursorScope`；三宿主 Instructions 清单；A/B/C 测试矩阵；Complexity Delta 分链路；仍需确认 3 项 |
| 0.6 | 2026-11-09 | 初版技术方案（被本版替代） |
