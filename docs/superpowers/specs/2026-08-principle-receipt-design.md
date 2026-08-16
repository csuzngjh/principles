# 原则回执 (Principle Receipt) — 设计文档

- **日期**: 2026-08-15
- **状态**: Draft — 待 Owner 审阅
- **来源**: brainstorm 会话（方向已定：现场回执 + 沉淀闭环组合）
- **关联**: `docs/product/PRODUCT_IDENTITY.md` MVP 契约第 6 步（observable later behavior）；`docs/product/emotional-value.md`
- **技术验证**: 2026-08-15 三路调查——OpenClaw 宿主源码（安装版 2026.7.1-2，精确 commit `0790d9f`，release/2026.7.1 分支）、PD 仓库源码、`D:\.openclaw\workspace` 活数据（只读）。本文所有关键断言均有源码/数据证据。

---

## 1. 问题陈述

PD 价值主张六步中，第 6 步「Owner 能看到行为变化」目前几乎没有产品表面承载。三个结构性根因（均已源码验证）：

1. **注入通道隐身**：原则经 `prependSystemContext` 进入 system prompt（`openclaw-plugin/src/hooks/prompt.ts:585-588`），宿主 WebUI 只渲染 user/assistant/tool 角色、从不读 system prompt（宿主 `ui/src/pages/chat/chat-thread.ts:402-412`）。
2. **时刻错位**：批准发生在 T0 审批队列，行为改变发生在 T1 的另一会话，中间无任何连接。
3. **证据缺位**：唯一记录"本次运行注入了哪些原则"的事件 `runtime_v2_prompt_activations_injected` 只写 7 天保留期 JSONL（`event-log.ts:39`），pd-cli / console / Companion 均无读取方；Codex host-runtime 路径不发此事件。

## 2. 目标与非目标

**目标**：让第 6 步在两个时刻闭环——

- **现场**：拦截回执（硬规则）+ agent 自述行（软原则）；
- **事后**：生效履历（持久存储）+ console 展示 + `/pd-context` 按需查询。

**非目标**：

- 不做因果归因 / 统计（Attribution Pipeline 在 post-MVP 冻结清单）；
- 不新增激活通道；
- **不修改 OpenClaw / Codex 宿主源码**（第三方软件，不归 PD 所有）：本设计所有代码改动限于 PD 自有包（`openclaw-plugin` / `principles-core` / `pd-console` / `pd-cli`，P2 另含 PD 自有的 `codex-adapter` / `host-runtime`）以及 PD 自身的安装配置。任何需要宿主新能力才能实现的需求（如 requireApproval 的"暂停等批准"、折叠卡片直接显示拦截文案、WebUI 渲染变更）一律**放弃或降级设计**，不向宿主仓库提 PR；回执全部骑宿主**已文档化的插件合同通道**（`blockReason` 工具结果、`llm_output`、`before_message_write`、Codex `systemMessage`）；
- 本期（P0+P1）不做 Codex 路径、不做 Companion 通知（P2 预留设计）。

## 3. 已验证的技术事实（设计基础）

| # | 事实 | 证据 |
|---|---|---|
| F1 | gate 返回 `{block, blockReason}` 后，宿主把 `blockReason` 原文作为工具结果给模型（无包装），WebUI 工具卡片**展开后**显示全文、侧栏也可看；默认折叠态不显示、不标红 | 宿主 `agent-tools.before-tool-call.ts:1259-1273,1706`；`ui/src/pages/chat/components/chat-tool-cards.ts:334-476`；`TOOL_ERROR_STATUSES` 不含 "blocked"（`ui/src/lib/chat/tool-cards.ts:83`） |
| F2 | 现有拦截文案已指示 agent 向 Owner 解释并请求确认（"explain the reasoning to the owner"）——agent 转述是既定交互模式 | `gate-block-helper.ts:255-265` |
| F3 | prompt 钩子第二参数 `PluginHookAgentContext` 含 `sessionId/sessionKey/agentId/runId`；PD 侧 `handleBeforePromptBuild` 已在用 `ctx.sessionId` | 宿主 `attempt.ts:4107-4121`；PD `hooks/prompt.ts:206` |
| F4 | `llm_output` 钩子真实存在：每个模型循环尝试结束后发一次，payload 含 `assistantTexts: string[]` + `sessionId`，ctx 含会话身份；**观察型 void 钩子**；非内置插件需在 openclaw.json 配 `hooks.allowConversationAccess: true`，未授权时宿主静默拒绝（PD 已有健康告警与 `before_message_write` 降级模式） | 宿主 `hook-types.ts:356-412,1141-1145`；`registry.ts:2591-2601`；PD `index.ts:210,413-446` |
| F5 | PD 已注册 `llm_output`（轨迹采集）和 `before_message_write`（降级采集）处理器——自述行捕获可搭现有便车 | PD `index.ts:413-446,506-521`；`hooks/llm.ts:181+`；`hooks/trajectory-collector.ts:90-118` |
| F6 | state.db 为 better-sqlite3 同步访问（WAL + busy_timeout 5000），同步 gate 钩子里跑 SQL 是既有模式；新表经 `initSchema()` 的 `CREATE TABLE IF NOT EXISTS` 自安装，无需迁移框架 | `principles-core/src/runtime-v2/store/sqlite-connection.ts:14,72-156,217-573`；`rule-host.ts:296-308` |
| F7 | 原则元数据现状：`pi_artifacts` 无 title 列；可靠标题在 `principle_candidates.title`（按 artifact_id join，活库 68 行）；26/96 artifact 嵌有 `principleDraft.title`；`painReasonSummary` 仅 9/96 有；**`sourcePainId` 全库 0 次出现**；批准时间双源（`approvals.decided_at` / `activations.activated_at`）；旧 artifact 的 `principleId` 可能实际是 ruleId（降级要容忍） | 活库查询；`rule-host.ts:599-608`；`PrincipleTrajectoryModel.ts:195-204` |
| F8 | `requireApproval` 决策在 gate 中静默放行（钩子合同无"暂停等批准"能力）；自动纠正返回的 `_pdAutoCorrectWarning` 全仓库零消费者，且返回字段 `toolArgs` 不是宿主要读的 `params` | PD `gate.ts:159-178,283-292`；宿主 `hook-before-tool-call-result.ts:14-27`（合同字段为 `params/block/blockReason/requireApproval`） |
| F9 | console 数据模式 = 直读 readonly state.db（请求级开关连接），model/route/page 三件套模式成熟 | `ActivationsConsoleModel.ts:111-267`；`routes/activations.ts`；`server/index.ts:361,411` |
| F10 | feature flag 单点注册于 `DEFAULT_FEATURE_FLAGS`（`feature-flag-contract.ts:93-218`），snake_case，未注册 id 静默默认 false（typo = 静默关闭，需测试覆盖） | `feature-flag-contract.ts:8-19`；`pd-config-loader.ts:180-197` |
| F11 | 活数据现实：`rulehost_blocked/requireApproval/auto_correct_*` 历史发生 **0 次**；code_tool_hook 11 个激活全部已停用；8/11 有 160 次 `rulehost_unhealthy`；3 条 demo prompt 原则至今仍在注入（177 次注入事件含 sessionId 全字段） | `D:\.openclaw\workspace` 事件日志与 state.db 只读查询 |
| F12 | **TUI 场景（OpenClaw）**：终端聊天面真实存在——`openclaw tui`（别名 `chat`/`terminal`）；TUI 直接渲染工具结果文本（长文折叠为预览、可切换全量，`src/tui/components/tool-execution.ts`，chat-log.ts:359 接线），assistant 文本经 markdown 组件渲染，斜杠命令经共享命令注册表解析（`src/tui/commands.ts`，含插件命令）→ **拦截文案在 TUI 里比 WebUI 更直接可见** | 宿主 ref 0790d9f：`docs/cli/tui.md`；`src/tui/components/*` |
| F13 | **TUI 场景（Codex）**：hook `systemMessage` 在 TUI 渲染（`codex-rs/tui/src/history_cell/hook_cell.rs:460-481`，多行支持；有输出/非成功的 hook run 持久留在 transcript）；deny 必须带非空 `permissionDecisionReason` 否则 hook 报错（`hooks/src/engine/output_parser.rs:497`）；PD 编码器字段正确（companion 分支 `codex-adapter/src/codec/output-encoder.ts:4,30-31`，无协议漂移）；`additionalContext` 不渲染（纯模型上下文，与设计假设一致） | `D:\Code\codex`（codex-rs）；PD companion 分支 |

## 4. 「生效」口径（两级，Owner 已拍板）

| 级别 | 事件 | 用途 |
|---|---|---|
| **生效 (effect)** | `rule_blocked`（拦截成功）；`auto_correct_applied`（纠正**确证生效**后，见 §6-D2）；`self_reported`（agent 自述遵循，P1 起） | 计数、每日通知、"已生效 N 次" |
| **在场 (presence)** | `prompt_injected`（按 会话×原则 去重） | 仅进履历列表，灰色标注"注入了上下文" |

- **`requireApproval` 不入「生效」级**：宿主钩子合同无暂停能力，当前实现静默放行（F8），它没有改变行为，计入即夸大。仅保留既有审计事件。
- shadow 评估、`auto_correct_proposed`(未 applied) 不进履历（事件日志已有）。

## 5. 设计

### 5.1 P0 — 拦截文案增强（硬规则现场回执）

**改动点**：`gate-block-helper.ts` 的 `buildContextualBlockMessage` 文案模板 + 新的元数据读取器。

**元数据读取器**（新增，plugin 侧，同步 SQL，镜像 `PromptActivationReader` 的同步包异步风格）：

```text
输入: hostResult.ruleId + hostResult.principleId（gate.ts:130-157 已在握）
标题降级链: principle_candidates.title (join artifact_id)
          → pi_artifacts.content_json.principleDraft.title
          → content_json.text 前 40 字
          → ruleId 原样显示（容忍 principleId 实为 ruleId 的旧数据, F7）
日期: approvals.decided_at → 回退 activations.activated_at
来源纠正: painReasonSummary（存在时才显示，不承诺必有）
缓存: 进程内按 ruleId 缓存，短 TTL（≤5 分钟）+ 容量上限；激活变更靠 TTL 过期自然生效，不做失效钩子
```

**文案模板**（中文优先，模型与展开卡片的 Owner 双读者；给 agent 的转述指令保留并强化）：

```text
⛔ [PD 原则]「{标题}」拦截了 {toolName} {filePath}
   你 {批准日期} 批准{ · 来源：{painReasonSummary 摘要}}
   ── 请向 Owner 说明此操作被其批准的原则拦截，并给出替代方案后继续。
```

**体验预期（如实）**：折叠卡片不显示 `blockReason`（F1），主要可见面是 **agent 的转述**——文案自带转述指令保证这一点；展开卡片/侧栏是次要可见面。

**flag**: `principle_receipt_block_copy`（见 §10）。

### 5.2 P1-a — 软原则自述行（Owner 已拍板：纳入但延到 P1）

**注入侧**：`renderPrinciplesToDirectives`（`prompt-activation-reader-contract.ts:133-158`）footer 追加一条指令：

> 当本区块中某条指令实际改变了你本轮的做法时，在回复末尾以一行标注：
> `📌 应用了你的原则「{标题}」：{一句话说明做了什么不同}`。每条原则每个会话只标注一次。

**捕获侧**（不新建钩子注册，挂在 PD 现有处理器里，F5）：

```text
主: llm_output handler（hooks/llm.ts）→ 扫描 assistantTexts 中的 📌 标记行
降级: before_message_write（trajectory-collector 已在用同款降级模式）
标记行 → 解析原则标题 → 写入履历 self_reported(effect)
未授权 conversation access 的安装: 自述行照常注入，但捕获不发生（rc-9: 记录 skip 原因）
```

**配置边界**：`hooks.allowConversationAccess: true` 是 openclaw.json 中 **PD 插件条目自身的配置项**（安装配置，非宿主代码修改），由 PD 安装器/文档负责设置与提示；不设置时走上述降级。

**flag**: `principle_receipt_self_report`。

### 5.3 P1-b — 生效履历存储

**新表** `principle_applications`（加进 `SqliteConnection.initSchema()`，自安装，F6）：

```sql
CREATE TABLE IF NOT EXISTS principle_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principle_id TEXT NOT NULL,
  activation_id TEXT,
  rule_id TEXT,
  channel TEXT NOT NULL,            -- 'code_tool_hook' | 'prompt'
  level TEXT NOT NULL,              -- 'effect' | 'presence'
  kind TEXT NOT NULL,               -- 'rule_blocked' | 'auto_correct_applied' | 'self_reported' | 'prompt_injected'
  session_id TEXT,
  tool_name TEXT,
  file_path TEXT,
  digest TEXT,                      -- 一句话摘要（拦截原因/纠正字段/自述行原文截断）
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pa_presence_dedup
  ON principle_applications(principle_id, session_id) WHERE kind = 'prompt_injected';
CREATE INDEX IF NOT EXISTS idx_pa_principle_time ON principle_applications(principle_id, created_at DESC);
```

**写入点**：

| 写入点 | kind / level | 备注 |
|---|---|---|
| `gate.ts:140-148`（rulehost block 处，ruleId/principleId 在手） | `rule_blocked` / effect | **在源头写**，不经 `gate_block` 事件反查（活数据证明该事件不带 principleId） |
| `gate.ts` auto-correct applied 处 | `auto_correct_applied` / effect | **前置依赖 D2**（§6），修好前不写（诚实性） |
| `prompt.ts:515-535` 注入事件处 | `prompt_injected` / presence | `INSERT OR IGNORE` 走唯一索引去重；ctx.sessionId 已可用（F3）；sessionId 缺失时该行 `session_id` 存 NULL——SQLite 唯一索引视 NULL 为互异，天然不会跨会话误去重 |
| llm_output / before_message_write 标记行 | `self_reported` / effect | §5.2 |

**保留期**：90 天滚动清理（复用 event-log 7 天清理的调度模式）。

**flag**: `principle_receipt_ledger`。

### 5.4 P1-c — Console 展示

- **原则详情页**新增「生效履历」区块：头部 `你 {批准日期} 批准{ · 来源摘要} · 已生效 {N} 次 · 上次 {date}` + 时间线（effect 黑 / presence 灰，分列）。
- **Activation 页**新增两列：生效次数、上次生效时间（`GROUP BY principle_id`）。
- **PrincipleTrajectoryModel** 6 段生命周期的 `behavior` 段从"是否存在规则"改为履历摘要（`deploy` 段不动）。
- 新 model `ReceiptsConsoleModel` 照抄 `ActivationsConsoleModel` 三件套模式（F9）；ledger flag 关闭时显示降级态 + reason + nextAction。

### 5.5 P1-d — `/pd-context status` 扩展

- `SessionState`（`session-tracker.ts:51-86`）新增字段：`injectedPrincipleIds: string[]`、`receiptAutoCorrects: number`（`blockedAttempts` 已存在）——照 `injectedProbationIds` 的持久化模式（`:441-456`）。
- 命令输出追加「本会话回执」：注入了哪几条原则（标题）、拦截 N 次、自动纠正 N 次。`PluginCommandContext.sessionId` 是必填字段，与 session tracker 同进程直读。

### 5.6 P2 — 预留设计（本期不实现，防止漂移）

- **Companion 每日通知**（规则已由 Owner 定死）：当天有 effect 级事件才发；每日 ≤1 条；内容 = 今天 N 次生效 + 一个亮点（如某原则首次触发）；点击直达原则详情页履历区块。flag: `principle_receipt_daily_digest`。
- **Codex 补齐**（全部为 PD 自有包 `codex-adapter` / `host-runtime` 的改动，**不修改 Codex 本体**）：host-runtime 补发注入事件；回执走 Codex 已文档化的钩子输出 `systemMessage`（`[PD]` 前缀，operator 可见，`codex-adapter/src/codec/output-encoder.ts:135-139` 既有通道）。

## 6. 前置依赖修复（小、独立、先于对应功能合入；两处均为 **PD 自有代码**的修正，宿主零改动）

- **D1 — PD 侧 SDK 类型对齐**：PD 自带的类型声明文件 `packages/openclaw-plugin/src/openclaw-sdk.ts`（PD 仓库内文件，非宿主代码）已与宿主 2026.7.1 实际合同漂移——`PluginHookBeforeToolCallResult` 应为 `{params, block, blockReason, requireApproval}`（现用 `toolArgs/skipToolCall`）；`PluginHookLlmOutputEvent` 应为 `assistantTexts`（现用宿主不存在的 `output`）；`PluginHookBeforeMessageWriteResult` 缺 `block`。对齐为纯类型修正。
- **D2 — auto-correct 参数传播对齐**：改 **PD 的 `gate.ts`** 返回值以使用宿主**既有**合同字段 `params`（F8），并加一条"纠正确实落到工具调用"的验证测试。修好前 `auto_correct_applied` 不写入履历。

## 7. 诚实性边界（本设计的红线）

1. 只呈现事实（拦了什么、纠正了什么、agent 自述遵循、注入了什么），**因果判断留给 Owner**；不做归因统计。
2. `self_reported` 在所有表面明确标注为「agent 自述」，与确定性事件分列。
3. `requireApproval` 不计入生效（§4）；`auto_correct_applied` 仅在确证生效后记录（D2）。
4. 「来源纠正」只在 `painReasonSummary` 存在时显示（当前约 1/10 artifact 有），缺失时降级为只显示批准日期——**不编造来源**。
5. presence（注入）与 effect（生效）在一切计数、通知、文案中严格分列。

## 8. 情绪价值评审

- **主要交付**：安心感 + 掌控感 + 沉淀感；**降低**：无感（"不知道 PD 有没有用"）、不信任感（"它是不是在偷偷改我的 agent"）。
- 核心一句话：`你当时的一次纠正，已替你挡了 N 次` —— 沉淀感（纠正没浪费）+ 掌控感（详情页一键停用，可回滚）。
- 克制线：回执一行一次/原则/会话；通知每日 ≤1 条（P2）；presence 灰色分列；不新增渲染机制（全部骑宿主已有通道）。
- 注意力保护：履历默认折叠在详情页内，不进 focus 队列，不产生新的待办。

## 9. MVP 四问

1. **mvp-q-1-what-if-skip**：不做则价值主张第 6 步无任何产品表面承载，种子客户无法感知 PD 价值——MVP 核心缺口。
2. **mvp-q-2-how-observed**：聊天内 agent 转述/自述行（现场）、console 原则详情履历区块与 activation 计数列、`/pd-context status` 会话回执——三条可观察路径。
3. **mvp-q-3-how-disabled**：四个独立 feature flag（§10），任一部件可单独关闭；履历表数据保留，关 flag 只停写入与展示。
4. **mvp-q-4-emotional-value**：见 §8。

## 10. Feature Flags

注册于 `DEFAULT_FEATURE_FLAGS`（`feature-flag-contract.ts`），全部 `category: quiet, enabled: false`（ADR-0014 §2.5 惯例），经 `.pd/config.yaml` 的 `features:` 显式开启：

| flag id | 管辖 | since |
|---|---|---|
| `principle_receipt_block_copy` | P0 拦截文案增强 | 2026-08 |
| `principle_receipt_self_report` | P1-a 自述行（注入指令 + 捕获） | 2026-08 |
| `principle_receipt_ledger` | P1-b 履历存储 + P1-c console 展示 + P1-d /pd-context | 2026-08 |

`principle_receipt_daily_digest`（P2 通知）**本期不注册**——注册合同要求 loader 与测试同时行使才算注册，空注册违规；P2 实现时随功能一并注册。

注意 F10：未注册 id 静默 false，注册与调用点的 id 一致性必须有测试覆盖。

**开启路径（mvp-q-2 的前提）**：三个 flag 的开启由 PD 安装器（`create-principles-disciple`）写入 `.pd/config.yaml`，或随发布文档提供一条一键开启命令——保证种子客户开箱即有可观察表面，而不是依赖用户发现隐藏开关。

## 11. BDD 影响面（新增 `.feature`，落于 `docs/specs/features/receipt/`）

1. `receipt-block-copy.feature` — 有 candidate title 时拦截文案含标题与批准日期；title 缺失时走降级链；无 painReasonSummary 时不显示来源行。
2. `principle-application-ledger.feature` — block 写 effect 行（含 sessionId）；注入写 presence 行且同会话同原则只一行（重启后仍去重）；requireApproval 不写 effect 行；D2 修复前 auto_correct 不写行。
3. `receipt-self-report.feature` — 注入模板含自述指令（每原则每会话一次）；llm_output 标记行 → self_reported effect 行；未授权 conversation access 时捕获跳过且记录原因（rc-9）。
4. `console-receipt-history.feature` — 原则详情显示计数+时间线（effect/presence 分列）；activation 页显示计数列；ledger flag 关闭时降级态含 reason+nextAction。
5. `pd-context-receipt.feature` — `/pd-context status` 显示本会话注入原则与拦截/纠正计数。

## 12. 风险与开放问题

| 风险 | 应对 |
|---|---|
| 折叠卡片不显示 blockReason（F1） | agent 转述为主通道（文案自带指令）；如实向 Owner 说明 |
| 自述行是概率性的（漏报/多报） | 标注为 agent 自述；不作为任何自动决策输入 |
| `llm_output` 依赖 `allowConversationAccess` 安装配置 | 降级链 + 健康告警（既有模式）+ rc-9 记录 skip 原因 |
| 活数据现实（F11）：硬规则通道当前零事件、8/11 规则求值报错 | **预期管理**：初期回执以 prompt 通道为主；`rulehost_unhealthy` 与 code_tool_hook 通道停用是相邻议题，另开 issue，不混入本设计 |
| flag id typo 静默失效 | id 一致性测试（§10） |
| WebUI 折叠行为随宿主版本变化 | 不依赖：主通道是 agent 转述文本 |
| 用户在 TUI（终端界面）而非 WebUI 使用 | **已验证无风险（F12/F13）**：设计主通道（assistant 回复文本）是任何界面必渲染的内容；OpenClaw TUI 直接渲染工具结果文本（比 WebUI 更可见）；Codex TUI 确认渲染 `systemMessage`；斜杠命令在 TUI 可用 |
| 宿主（OpenClaw/Codex）演进导致插件合同变化——第三方软件，不受 PD 控制 | 只依赖已文档化的合同通道；宿主升级后跑 §11 全部 `.feature` 回归作为兼容闸门；合同变更导致的能力损失按"降级而非等宿主"处理 |

**开放问题（实现期解决）**：90 天清理的调度挂载点（跟随 event-log 清理机制）；`principle_candidates` join 的空值率在种子客户环境的实际表现。

## 13. 分期与验收

| 期 | 内容 | 验收标准 |
|---|---|---|
| 前置 | D1（SDK 对齐） | 类型修正 + 现有测试全绿 |
| P0 | 拦截文案增强 | §11-1 场景绿；真实触发一次拦截时 Owner 可在 agent 转述中看到原则署名 |
| P1 | D2 + 自述行 + 履历 + console + /pd-context | §11-2~5 场景绿；console 原则详情页出现非空履历（prompt 在场行 + 自述行）；`/pd-context status` 显示会话回执 |
| P2 | Companion 通知 + Codex 补齐 | 另行细化 |

**范围声明**：P0+P1 仅 OpenClaw 路径（Owner 已拍板）。
