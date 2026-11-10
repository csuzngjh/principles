# SPEC-PD-AGENT-PAIN-INGRESS-001 — 技术方案

| 字段 | 值 |
|---|---|
| 文档 | SPEC-PD-AGENT-PAIN-INGRESS-001 技术方案 |
| Version | **0.8** |
| 对应 SPEC | `SPEC-PD-AGENT-PAIN-INGRESS-001.md` **V0.8** |
| 对应审查 | `SPEC-PD-AGENT-PAIN-INGRESS-001-REVIEW.md`（审查对象 V0.6） |
| 状态 | `READY_FOR_IMPLEMENTATION_REVIEW`（文档范围）；整体仍 `PARTIALLY_VERIFIED` |
| 日期 | 2026-11-10 |
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
- 不在本版扩展 `painType` 枚举。

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
| F24 | CLI 手动入口写死 `painType:'user_frustration'` 且 `score: opts.score ?? 80` | `packages/pd-cli/src/commands/pain-record.ts:464-479`（`score` 在 `:469`） | E1 |
| F25 | `inferProvenance` 不读取 `painType`；`buildDiagnosticJson` 也不写 `painType` | `pain-signal-bridge.ts:291-299,405-455` | E1 |
| F26 | 观测写盘 `recordPainSignalObservability` 默认 `score = 80`，并会把 `painType` 写入 `evolution.jsonl` | `runtime/pain-signal-observability.ts:216-245` | E1 |
| F27 | CLI 在未绑定会话时 `recordObservability = false` | `pain-record.ts:427-430` | E1 |

## 2.5 Console 安全与执行

| # | 事实 | 证据 | 等级 |
|---|---|---|---|
| F28 | Console 支持 Bearer token（`--token` / `PD_CONSOLE_TOKEN`），timing-safe 比较；`--no-auth` 时直接放行 | `pd-console/src/server/config/AuthConfig.ts:20-58` | E1 |
| F29 | 未启用 token 时只允许 loopback 绑定 | `pd-console/src/server/index.ts:166-168`；`bind-guard.ts:17-25` | E1 |
| F30 | **未发现** CSRF / Origin / `Sec-Fetch-Site` 校验 | `pd-console/src/server/**` 全目录检索无命中 | E1（缺失） |
| F31 | 全局鉴权在路由分发前执行 | `pd-console/src/server/index.ts:405-407` | E1 |
| F32 | Console 已有 `detached + unref` 长任务先例 | `pd-console/src/server/routes/update.ts:105-133` | E1 |
| F33 | `pd diagnose run` 会先检查诊断能力与 runtime 绑定；缺失时主动失败并给 `nextAction` | `packages/pd-cli/src/commands/diagnose.ts:200-260` | E1 |
| F34 | `spawn` 返回只代表进程已创建；执行失败通过异步 `error` 事件上报 | Node 语义 | E3 |

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
│    背离 / 为什么值得记录 / 上下文                            │
│  - 不含分数、严重度、会话 id、推测性类型                     │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
MCP Tool `pd_submit_pain`
        │  core capability：校验 + 组装 + 提交
        ▼
PainToPrincipleService.recordPain({ asyncMode: true })
        │
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
- 只接收已解析的 `workspaceDir` 与已校验的结构化输入；
- 负责锚点校验、构造 `painId`、调用 `recordPain`、组装回执；
- 让三宿主共享同一份语义（P4/P6）。

`pd-mcp-server` 只负责：协议 schema → zod → capability → 信封/预算。

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
| `packages/pd-cli/src/commands/pain-record.ts` | 省略 `--score` 时不再写 `score = 80`，改为一律不写 `score`（落 `moderate`）；`--score` 的显式语义不变（裁定 1） |
| `packages/principles-core/src/runtime/pain-signal-observability.ts` | 移除 `score ?? 80` 默认（`:221`）；改为不写 `score` 并由 `severityFromScore(undefined)` 落 `moderate`。只改 CLI 一处无效：`recordPain` 会在 `:210/:255` 重新补 80（F26） |
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

## 5.2 Tool 描述（这是对 Agent 的行为指令，不是营销文案）

```text
记录一条"相对锚点的显著行为背离"（Pain）。

调用前必须完成三件事：
1) 先确定锚点：Owner 的明确期望、已建立的原则、或 Agent Instructions/Skill 的明确要求。
   原则必须给出 id 与 version；Instructions 必须给出路径与章节；Owner 期望必须给出处。
2) 先向 Owner 说明：锚点是什么、你实际做了什么、背离在哪一步、为什么未来任务会因此改变判断。
3) 取得 Owner 在本次对话中的明确同意。未回复、回答不明确、或只说了"随便"都不算授权。
   授权只对本次提交有效；Owner 修改了内容时，提交前必须再次确认最终版本。
   后台/无人值守 Agent 不得自行提交。

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
      "enum": ["tool_failure", "subagent_error", "user_frustration"],
      "description": "可选。只有你能明确归类时才填写；不要猜测。"
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
  painType: z.enum(['tool_failure', 'subagent_error', 'user_frustration']).optional(),
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

- `taskId` 由既有 `createDiagnosticianTaskId(painId)` 生成（`diagnosis_<painId>`）。
- `painId` 由 capability 生成，**不从 session / host 派生**；格式与 CLI 的 `manual_...` 并列。
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
3. 最小回执仍超预算（实际不可能，<1 KiB）→ `isError:true` + `response_budget_exceeded`，并在消息中说明"任务已创建，请用 `pd task show <taskId>` 对账"。

这里的"最小回执"与完整回执字段相同；差别只在**未来可能增加的观测字段**会被裁剪。裁剪不得删掉 `painId` / `taskId` / `workspaceDir` / `status`。

## 5.5 handler 流程

```text
1. shuttingDown? → shutting_down（无变更）
2. admissions.tryAcquire()? → 饱和时 saturated（无变更；未尝试写入）
3. zod 二次校验 → 失败则 invalid_input（无变更）
4. 组装修正输入：
   - anchor = { type: anchorType, ref: anchorRef }
   - 不接受 score/severity/approved/sessionId/metadata
5. 调用 submitPainCapability({ workspaceDir, input })
   - 生成 painId
   - 锚点校验（见 §5.6）
   - 构造 recordPain 入参（asyncMode:true, recordObservability:false）
6. 得到 { painId, taskId } 后组装回执
7. 预算检查 → 完整 / 最小 / 失败
8. 记录一条结构化日志（工具名、durationMs、status、errorCode、响应字节数）
```

## 5.6 校验分层：哪些是服务器强制，哪些只能靠行为

| 约束 | 强制者 | 实现方式 |
|---|---|---|
| `reason` 非空、≤2000 | 服务器 | JSON Schema + zod |
| `anchorType` 合法、`anchorRef` 非空 | 服务器 | JSON Schema + zod |
| `established_principle` 的 `anchorRef` 形如 `id@version` | 服务器 | 正则 |
| 该原则在账本中**真实存在**且 version 匹配 | 服务器 | `loadLedger(stateDir).tree.principles` |
| `agent_instruction` 的 `anchorRef` 形如 `path#section` | 服务器 | 正则 |
| `owner_expectation` 的 `anchorRef` 非空 | 服务器 | 长度 |
| 引用等级不是 `inference` | **Agent 行为** | 只能写进 Tool 描述/Skill；服务器读不到自由文本的语义 |
| 冲突锚点已披露 | **Agent 行为** | 同上 |
| 低置信度先澄清 | **Agent 行为** | 同上 |
| Owner 已授权 | **宿主对话 + 可选原生确认** | MCP 进程看不到聊天；不引入 `ownerApproved` 字段 |
| 后台 Agent 不提交 | **运行时形态** | 后台 Agent 通常没有交互通道；不新增注册表 |

### 5.6.1 账本读取失败时

- 账本不存在：视为"没有可验证的原则"，`anchorRef` 以 `established_principle` 提交 → 拒绝，`anchor_not_found`，附 nextAction "先用 `pd principle list` 确认 id/version"。
- 账本存在但不可读/损坏：**失败关闭**，`anchor_unverifiable`，不得当作"原则不存在"（rc-9）。
- 状态为 `archived` / `deprecated`：允许提交，但在回执的 `warnings` 中注明"锚点原则当前非 active"；不得静默当作 active。

### 5.6.2 为什么不在服务器侧校验 Instructions 文件是否存在

Instructions 的根目录是宿主特定的（仓库内 Skill、`~/.codex/AGENTS.md`、Workspace `AGENTS.md` 等），MCP 进程不保证能读到。强行校验会产生大量假阴性。这里只做**形状校验**，真实存在性由 C 类验收在三宿主上取证。

## 5.7 截止时间与"已写入但响应超时"

这是一个**写工具**，不能直接复用 recall 的"超时即失败"：

- `runWithDeadline` 超时后，写入可能仍在 SQLite 中完成；如果直接返回 `tool_execution_failed`，回执就与持久事实矛盾。
- 因此 submit 路径的超时处理是：超时 → 用 `taskId`（`diagnosis_<painId>`）做一次**有界读回**（`getTask`，≤1s）。
  - 读到 → 返回最小 `submitted`；
  - 读不到 → `isError:true` + `submit_unconfirmed`，消息明确"未能确认是否写入，请用 `pd task list --kind diagnostician` 对账"，不得声称"未创建"。
- 读回本身也失败 → `submit_unconfirmed`（同上）。

---

# 6. 内容与字段映射

## 6.1 六项内容 → `reason`

| # | 内容 | 在 `reason` 中的形态 |
|---|---|---|
| 1 | 锚点 | 引用原文/明确出处；原则给 `id@version` |
| 2 | 锚点来源 + 引用等级 | `verbatim` / `paraphrase` / `recollection` / `inference` |
| 3 | 观察到的行为 | 具体动作、顺序、跳过、越界 |
| 4 | 背离 | 没做 / 做反了 / 做了但绕过 |
| 5 | 为什么值得记录 | 未来哪类任务会改变判断 |
| 6 | 上下文 | 任务类型、仓库/目录、可公开的环境事实 |

`reason` 不要求机器可解析；服务器只检查长度与非空。结构化的是 `anchorType` / `anchorRef`。

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

## 6.3 `painType`

### 6.3.1 提供时

- 传给 `recordPain({ painType })`；
- 构造 `painIngress.v1` 并持久化，`painIngress.painType` 与输入一致；
- 回执不显示 `painType`（回执只回答"是否登记"）。

### 6.3.2 省略时（默认）

- **不构造 `painIngress.v1`**（其 schema 要求 `painType`），只走 legacy 顶层字段；
- `diagnostic_json` 中不出现 `painType`；
- `recordObservability:false`，因此不会写 `evolution.jsonl`（F26/F27）；
- 内存中的 `painType` 占位值只用于满足既有类型，**任何持久化路径都不写它**；
- 增加一条测试：省略 `painType` 时，`diagnostic_json` / observability / 回执三处都不含 `painType`。

### 6.3.3 为什么不扩展枚举

新增 `unspecified` 会改变 `painIngress.v1` 的既有合同与下游解析（F48 之外的消费者），并把"未知"变成一个可被统计的假类别。v1 用"缺省 + 不写"表达未知，比新增枚举更诚实。

## 6.4 严重度

- MCP 路径**不传 `score`**；
- `buildDiagnosticJson` 调 `severityFromScore(undefined)` → `moderate`（F23）；
- 不新增 severity 常量、不改阈值；
- 提级只能由获得授权的人工操作（Console/CLI 显式调整）完成；
- `painType` 的值不影响 severity（F25）。

## 6.5 CLI 手动入口与 `diagnostician_async_cli`

**当前代码事实**（实现前）：

- `pain-record.ts:469` 写 `score: opts.score ?? 80`，省略时落 `severe`（F24）；
- `pain-signal-observability.ts:221` 还有第二处 `score ?? 80`（F26）；`recordPain` 在 `:210/:255` 默认启用观测，所以**只改 CLI 一处仍会被补回 80**，两处必须一起改；
- `diagnostician_async_cli` 是 quiet、默认关的 flag（F45）；开启后提交即返回（F46）。

**目标行为（本轮只落文档，代码未改）**：

| 项 | 目标 | 理由 |
|---|---|---|
| 省略 `--score` | 不写 `score` → `severityFromScore(undefined)` → `moderate` | 与 MCP 入口同一把尺子，避免"同一个问题两个严重度" |
| 显式 `--score` | 保留，作为人工提级通道 | 提级只能由获得授权的人做 |
| `painType:'user_frustration'` 默认 | 不再作为"严重"的依据；它只影响 legacy 顶层字段 | 类型 ≠ 严重度（F25） |
| `diagnostician_async_cli` | 保持默认关，不随 L3 毕业翻转 | 改变手动提交体感（提交即返回），等真实取证后再评估 |

**记账口径**：`docs` 写目标，`code` 仍是 80。任何"已改为中等"的结论在实现并读回证据之前都不成立。

## 6.6 provenance / ingress

| 字段 | MCP 路径取值 | 理由 |
|---|---|---|
| `provenance.origin` | `owner_manual` + `channel: mcp_agent_assisted` | 授权来自 Owner 对话，不是系统自动产生 |
| `provenance.correlation` | `unbound` + `reason: missing_host_session` | MCP 没有可信 session 身份 |
| `provenance.evidence` | `unavailable` + `reason: not_applicable_unbound` | 不伪造会话证据 |
| `hostKind` | 由 `PD_MCP_HOST` 映射（codex/openclaw/workbuddy） | 仅观测，不参与身份/准入 |
| `sessionId` | 不传 | 禁止 Agent 填写 |
| `evidence` | 不传 | 不伪造 |

准入结果由 `evaluatePainIngress` 计算；MCP 路径的 `submit` 与 warning 是固定输入下的确定结果。

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

## 7.2 三宿主绑定

| 宿主 | workspace 来源 | 可证事实 |
|---|---|---|
| OpenClaw | `PD_MCP_WORKSPACE_DIR`（launcher 注入） | 绑定与 host 标记 |
| Codex | 同上 | 同上 |
| WorkBuddy | 同上 | 同上 |

`PD_MCP_HOST` 只用于 `hostKind` 与日志，不用于 `mode`、不用于准入、不用于选择执行者。

## 7.3 Instructions 清单与必须改写的内容

| 宿主 | 真实文件 | 现状 | V0.8 必须改成 |
|---|---|---|---|
| OpenClaw + Codex（共用） | `plugins/principles-disciple/skills/pd-pain-signal/SKILL.md` | 只有 Owner 明确要求才登记；`owner_statement`；500 字 | 锚点三源、六项内容、先问 Owner、未回复=拒绝、仅本次、后台禁止、默认中等、不写 score |
| WorkBuddy | `packages/workbuddy-adapter/plugin/skills/pd-pain-signal/SKILL.md` | 同上 | 同上，保持与本宿主既有交互方式一致 |
| 用户级 WorkBuddy（安装产物） | `~/.workbuddy/skills/pd-record-pain/SKILL.md` | 固定前缀 `PD记录痛苦：`、500 字、后台自动诊断说法 | 由安装器识别并**废弃**；不再作为 canonical Skill（§7.4） |

Codex 的分发路径是插件清单：`plugins/principles-disciple/.codex-plugin/plugin.json:19` 指向 `./skills/`，所以 Codex 读到的就是仓库内那份共用 Skill；不需要另建 `~/.codex/skills/pd-*`（E2 实测不存在）。

## 7.4 WorkBuddy Skill 分发与旧文件废弃（裁定 2，目标行为）

> **当前代码事实**：安装器只做插件根必需 Skill 校验（F53），**没有**旧文件识别/废弃逻辑；仓库也**没有**旧 Skill 的文本源（F21）。下表全部是目标行为，代码未实现，本轮只落文档。

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
| 写入成功但响应超时 | 有界读回 → 最小 `submitted` / `submit_unconfirmed` | §5.7 |
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
| A04 | `severityFromScore(undefined)` | `moderate` | F23 |
| A05 | `diagnostic_json` 是否含 `painType` | 否 | F13 |
| A06 | 既有公平游标 | `reconciliation_cursor`，Codex 已用 | F39 |
| A07 | Console 是否有 CSRF/Origin 校验 | 否 | F30 |
| A08 | `pd diagnose run` 缺 runtime | 失败 + nextAction | F33 |
| A09 | 三宿主 Instructions 路径 | 仓库内两份 + 用户级一份 | F19-F21 |
| A10 | `runs.started_at` 可用 | 是，且有索引 | F42 |

## 10.2 B 类：开发阶段自动化

### 10.2.1 提交链路（对齐 SPEC T01–T23）

| SPEC | 测试落点 | 断言 |
|---|---|---|
| T01 | `packages/pd-mcp-server/src/__tests__/submit-tool.test.ts` | `tools/list` 同时包含 `pd_submit_pain` 与 `pd_recall_principle_pains` |
| T02 | 同上 | 缺 `reason` / 超 2000 / 非法 enum → 结构化错误，且 `getTask` 无新行 |
| T03 | `pain-submit-capability.test.ts` | `diagnostic_json.anchor == {type, ref}` |
| T04 | 同上 | 缺 `anchorType`/`anchorRef` → schema 拒绝，无新行 |
| T05 | 行为验收（C 类） | `inference` 单独支撑的提交不发生；服务器不伪称能判断 |
| T06 | 行为验收（C 类） | 冲突锚点双方都出现在 `reasonSummary` |
| T07 | 提交能力测试 + CLI 测试 | MCP 不写 `score`、CLI 省略 `--score` 时也不写；两者最终 `severity='moderate'`，事件日志无 80；显式 `--score` 仍生效 |
| T08 | 提交能力测试 | schema 不含 `score`/`severity`；多余字段被 `additionalProperties:false` 拒绝 |
| T09 | 提交能力测试 | 省略 `painType`：`diagnostic_json`、observability、回执均无该字段 |
| T10 | 集成测试 | `tasks` 1 行，`task_kind='diagnostician'`，`status='pending'`，`input_ref=painId` |
| T11 | 回执测试 | 含 `painId` / `taskId` / `workspaceDir` / `status` |
| T12 | 回执测试 | 默认无 `mode`；伪造可证信号时才有 |
| T13 | 失败测试 | 失败 `isError:true` + 结构化 reason |
| T14 | 预算测试 | 构造超预算输入 → 仍 `submitted` + 最小字段 |
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
| X03 | 原则已归档 | 可提交，但 `warnings` 注明非 active |
| X04 | 超时读回命中 | 最小 `submitted`，不是 `failed` |
| X05 | 超时读回未命中 | `submit_unconfirmed`，不声称未创建 |
| X06 | 跨源 POST | 403，零变更 |
| X07 | 非 JSON Content-Type | 415，零变更 |
| X08 | spawn error | 500，零变更 |
| X09 | 健康投影未被污染 | `aggregatePipelineHealth` 结果不含 diagnostician |
| X10 | 游标 key 改名 | 轮转重置一次，任务数据不变 |

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

1. **A 类核验**复跑一次（10 条），确认本文件事实仍成立。
2. core：`anchor` 字段 → `buildDiagnosticJson` → `pain-submit-capability`。
3. MCP：schema + description + handler + 预算/超时读回。
4. 单测：T01–T22（不含 T05 / T06 / T23 行为类）。
5. Console L2：同源 + 预检 + spawn + 202/403/415/404/409；L2b：store 读取 + 路由。
6. L3：共享 picker + service 一轮 + flag + lifecycle。
7. Instructions：两份仓库内 Skill 改写 + 安装器旧 Skill 废弃（§7.4）。
8. CLI：`pain-record.ts` 省略 `--score` 不再写 80；补 CLI 测试；`diagnostician_async_cli` 保持默认关。
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
| CLI 默认值改动影响既有脚本预期 | 严重度口径变化 | 只改"省略 `--score`"路径；显式传值不变；T07 双入口断言 | 回退该提交 |

---

# 14. 交付验收："怎么证明真的跑了"

| 能力 | 不能作为证据 | 必须提供的证据 |
|---|---|---|
| MCP 提交 | `tools/list` 里有名字、按钮存在、flag 注册 | 真实宿主对话提交后：`state.db` 行 + `diagnostic_json.anchor` + 回执 `painId` 对账 |
| 默认中等 | 代码里写了 `moderate` | 真实提交后的 `diagnostic_json.severity='moderate'`，且无 `score` |
| 授权 | Tool 有 description | C04/C05：拒绝/不回复=零任务；修改后再次确认 |
| L2 执行 | 202 响应、按钮变灰 | 子进程 PID/日志 + `runs.started_at` 新行 + 任务状态迁移 |
| L2b 积压 | UI 有数字 | 同一 workspace 直接 SQL 对账：数量、最老 `created_at`、`lastRunStartedAt` |
| L2b 不误报 | 页面显示"无活动" | 新建 pending 后仍为 `false`；真实 run 后才 `true` |
| L3 自动 | flag=on、service 代码存在 | 真实 pending 任务在两个 120s tick 内离开 pending，且有 `runs` 行 |
| 三宿主一致 | 三份文档写着一致 | C01–C03 三次真实提交的字段逐项相同 |

---

# 15. 结论与证据构成

| 等级 | 本文件中的内容 |
|---|---|
| E1 | F1–F54（除标注 E2/E3 的条目） |
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

> **记账口径**：下表"当前代码事实"是改文档时的真实实现；"目标行为"是 Owner 已拍板、但**代码尚未修改**的行为。本轮只改 `docs/specs/` 下三份文档，不碰产品源码、安装器、宿主配置。

| # | 裁定 | 当前代码事实 | 目标行为 | 文档落点 |
|---|---|---|---|---|
| 1 | `pd pain record` 默认严重度 | `pain-record.ts:469` 写 `score: opts.score ?? 80` → `severe`（F24）；`pain-signal-observability.ts:221` 另有 `?? 80`（F26） | 两处默认一起移除：省略 `--score` 不写 `score` → `moderate`；`--score` 仅作人工提级通道 | SPEC §6.1/§6.4；本文件 §4.2/§4.4/§6.5/§10 T07 |
| 2 | WorkBuddy 用户级 Skill | 安装器只校验插件根 Skill（F53），无旧文件处置（F54）；仓库无旧 Skill 源（F21） | 安装器统一分发 `pd-pain-signal` 到插件根；识别并废弃旧 `pd-record-pain`；用户改过的副本不覆盖、只告警 | SPEC §5.5；本文件 §7.3/§7.4/§10 T39/§11 |
| 3 | `diagnostician_async_cli` | quiet、默认关（F45）；开启后提交即返回（F46） | **保持默认关**，不随 L3 交付翻转；等真实取证后再评估 | SPEC §6.4/§10/T40；本文件 §4.4/§6.5/§10 T40 |

**为什么三项都只写目标、不写"已完成"**：本轮权限只到文档；任何"已改为中等 / 已分发 / 已保持"的完成态结论，都必须等实现后由 T07 / T39 / T40 的真实读回证明。

## 16.4 仍待确认

无。此前三项待确认已由 Owner 全部裁定，见 §16.3。

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
| 0.8 | 2026-11-10 | Owner 追加裁定 1–3：CLI 省略 `--score` 改落 moderate（代码未改，§6.5）；WorkBuddy Skill 由安装器分发并废弃旧 `pd-record-pain`（§7.4，目标行为）；`diagnostician_async_cli` 保持默认关；新增 F53–F54、T39–T40；三项待确认清零 |
| 0.7 | 2026-11-10 | 按 Owner A–D 裁定重写；锚点三源与六项内容；`anchor` 落 `diagnostic_json`；默认中等；`mode` 可选且 v1 省略；授权模型；L2 同源+预检+spawn；L2b 扩展既有 `StalledDiagnosticianTaskReadModel` 并用 `runs.started_at`；L3 复用既有游标 authority 并删除 `cursorScope`；三宿主 Instructions 清单；A/B/C 测试矩阵；Complexity Delta 分链路；仍需确认 3 项 |
| 0.6 | 2026-11-09 | 初版技术方案（被本版替代） |
