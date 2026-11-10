# SPEC-PD-AGENT-PAIN-INGRESS-001 技术审查报告

- **被审查对象**：`docs/specs/SPEC-PD-AGENT-PAIN-INGRESS-001.md` **V0.6**
- **审查目标产物**：V0.7（本报告与 V0.7 SPEC、V0.7 技术方案同批产出）
- **审查日期**：2026-11-10
- **审查性质**：只读代码核验 + 文档评审 + 锚点式定义重审
- **未做**：未修改产品源码 / schema / 依赖 / 三宿主配置；未重启 Gateway；未 commit / push / PR；未改动任何真实 Pain 数据
- **结论**：**PARTIALLY_VERIFIED**（理由见 §6）

---

## 0. 结论卡

### 0.1 产品定义层（本轮核心）

| 等级 | 问题 | 后果 |
|---|---|---|
| **P0** | V0.6 把 **"实际负面影响 / 反复发生 / Owner 纠正 / 明确期望未满足"** 当作 Pain 的必要条件 | 与产品定义冲突：**任务成功完成但明显背离既有原则**的行为会被 Agent 判为"不是 Pain"，直接放过 |
| **P0** | V0.6 的触发条件是"**实际损失或明确冲突**" | 该触发方式把损失设为前提，与"相对锚点的背离"不兼容 |
| **P0** | V0.6 **没有锚点模型**：没有锚点类型、锚点来源、可追溯 id、引用等级 | 判断退化为 Agent 主观意见；无法区分"违反已批准原则"与"我觉得不好" |
| **P0** | V0.6 的提交内容模板是 **观察 / 期望 / 影响 / 为什么记录**，以"影响"为中心 | 无法表达"没有实际损失但有明确背离"，会诱导 Agent 编造影响 |
| **P1** | V0.6 用五个"是否值得记录"的数字阈值思想（影响范围/复发/可复用）描述严重度 | 与 Owner 裁定"默认中等、禁止 Agent 自评"冲突 |

### 0.2 合同与执行层

| 等级 | 问题 | 后果 |
|---|---|---|
| **P0** | V0.6 把 `diagnosis.mode` 写成**必填且必须精确** | MCP 进程无法证明宿主侧自动消费能力时可证性不足，只能撒谎或省略；V0.7 改为**可选、仅在可证实时出现** |
| **P0** | V0.6 §4.2 把**宿主原生写入确认**写成"必须启用" | 与 Owner 裁定 B 冲突：原生确认是推荐的安全措施，不是业务前置 |
| **P1** | V0.6 缺少授权交互的具体形态（askme / 普通对话 / 未回复 / 修改后再次确认 / 后台 Agent 禁止） | Agent 可能把"没反对"当同意，或由无人值守后台自行提交 |
| **P1** | V0.6 固定 `score = 80` → `severe` | 每条 Agent Pain 都是 Severe，严重度失去区分力 |
| **P1** | V0.6 §9.5 用 `MAX(updated_at)` 推断"最近有执行活动" | **新建 pending 任务会把 `updated_at` 设为当前时间**（`createTask` 同时写 `created_at`/`updated_at`），造成"刚提交=刚执行"的假阳性 |
| **P1** | V0.6 L2 只规定 202 语义，**未规定状态变更路由的来源校验** | 控制台已有 Bearer/loopback 保护，但**未发现 CSRF / Origin 校验**；该路由能触发真实模型调用 |
| **P1** | V0.6 T12 宣称"workspace 存在但不是 PD workspace → 明确失败" | 实际只做目录存在性与可写探测，**没有 PD workspace 指纹**；宣称能力超过实现 |
| **P2** | V0.6 技术方案新增 `cursorScope` | Task Store 只有分页 cursor；但**公平调度游标已存在**于 `RuntimeStateManager`（Codex worker 已在用）。`cursorScope` 的问题不是"没有游标"，而是**新增第二套游标**；V0.7 删除该参数并复用既有 authority |

### 0.3 v0.7 的处置

| 问题 | 处置 |
|---|---|
| 旧 Pain 定义 / 触发条件 | **删除**，改为锚点相对背离（SPEC §1.3） |
| 锚点模型 | 新增三类锚点 + 引用等级 + 冲突披露 + 低置信度先澄清（SPEC §1.4/§1.5） |
| 内容模板 | 改为六项（SPEC §5.3）；不新增五个参数，只新增**必填** `anchorType`/`anchorRef` |
| 严重度 | MCP 路径不写 `score` → `severityFromScore(undefined)=moderate`（SPEC §6） |
| `diagnosis.mode` | 可选、仅在可证实时出现（SPEC §7） |
| 原生确认 | 降级为推荐（SPEC §4.3） |
| L2b 活动信号 | 改用 `runs.started_at` / 租约变化，禁止用 `updated_at`（技术方案 §8.3.2） |
| L2 安全 | 要求同源校验；不把 loopback 当唯一防线（技术方案 §8.2.3） |
| T12 | 收敛为真实能力；`mode` 在 v1 实际省略（技术方案 §5.4.2） |
| `cursorScope` | **删除**；不新增第二套游标，复用既有 `reconciliation_cursor` 公平轮转（技术方案 §8.4.3） |

---

## 1. 调查基线

| 仓库 | 分支 | HEAD | 工作区 |
|---|---|---|---|
| `d:\Code\principles` | `main` | `4a6745d0c` | 存在未提交改动，**原样保留，未触碰** |
| `D:\Code\codex` | `main` | `c9b4267c37` | 干净 |
| `D:\Code\openclaw` | `main` | `63fbea0c0fc` | 干净 |
| `D:\Code\pi-mono` | `main` | `b2aabe029` | 干净 |

安装环境：OpenClaw `2026.10.5`、Codex `0.167.0`、PD `pd-mcp-server 0.3.2` / `pd-cli 1.168.1` / `host-runtime 3.1.0`（均落后于仓库）。工作区 `D:\.openclaw\workspace` 同时存在 `.state/`（原则账本、会话）与 `.pd/`（`state.db`、config）。

---

## 2. 逐项核验（V0.6 的 13 个关注点）

### 2.1 Pain 定义与触发条件

| 事实 | 证据 | 判定 |
|---|---|---|
| core 只要求 `reason` 是非空字符串，**没有**"必须有实际损失/必须重复"的校验 | `pain-ingress-payload.ts:285` | E1 |
| 准入决策由 `evaluatePainIngress` 依据 origin/correlation/provenance/evidence 计算，**不读取"损失"或"复发次数"** | `pain-ingress.ts:159-241` | E1 |
| "复发 / 实际影响"是**文档层与 Skill 层**的限制，不是代码限制 | 仓库文档 V0.6 §1；`plugins/principles-disciple/skills/pd-pain-signal/SKILL.md` | E1 |

**结论**：V0.6 的定义是**产品策略错误**，不是实现约束。修改不需要改 core 判定逻辑，但必须改 SPEC、Skill、Instructions（后两者属实现阶段）。

### 2.2 锚点可用性（是否存在可引用的锚点源）

| 锚点类型 | 真实落点 | 证据 | 等级 |
|---|---|---|---|
| 已建立原则 | `<workspace>/.state/principle_training_state.json`，原则含 `id` / `version` / `text` / `status` / `scope` / `priority` | `principle-tree-ledger.ts:69,145`；`types/principle-schema.ts`；E2 实测文件存在 | E1+E2 |
| 原则状态 | `candidate` / `active` / `archived` / `deprecated` / `probation` | `types/principle-enums.ts:5-16` | E1 |
| 原则是否真正生效 | `activations` / `activation_decisions` / `activation_control_states`（`state.db`） | `store/sqlite-connection.ts` 建表段 | E1 |
| Agent Instructions（OpenClaw） | `D:\.openclaw\workspace\AGENTS.md`、`PRINCIPLES.md`、`SOUL.md`、`.agents/skills/*/SKILL.md` | E2 实测 | E2 |
| Agent Instructions（Codex） | PD 插件技能目录 `plugins/principles-disciple/skills/pd-*/SKILL.md`；用户级 `~/.codex/skills/` | E2 | E2 |
| Agent Instructions（WorkBuddy） | `~/.workbuddy/skills/pd-*/SKILL.md` | E2 | E2 |

**结论**：三类锚点都**已经有真实载体**，不需要新建锚点库。缺口是"没有把锚点写进提交内容与诊断材料"。

### 2.3 授权模型

| 事实 | 证据 | 判定 |
|---|---|---|
| V0.6 §4.1 已要求"等待 Owner 明确同意"，方向正确 | SPEC V0.6 §4.1 | 成立 |
| V0.6 §4.2 第 1 条把"原生写入确认"写成强制 | SPEC V0.6 §4.2 | **需按裁定 B 降级** |
| V0.6 未规定 `askme` 类交互、未回复、修改后二次确认、后台 Agent 禁止 | SPEC V0.6 §4 | 缺口 |
| 代码层没有任何审批服务 / 审批 API / `ownerApproved` 字段 | `pd-mcp-server/src`（仅 recall/submit 能力）；全仓无审批表 | E1 |

**结论**：授权应在宿主对话内完成；这不是"缺少实现"，而是"缺少成文规范"。

### 2.4 提交参数与内容结构

| 事实 | 证据 | 判定 |
|---|---|---|
| 现有 Tool 只有 `recall`；写入 Tool 尚不存在 | `pd-mcp-server/src/server.ts:26,136-149` | 成立 |
| core 的 `reason` **无长度校验上限** | `pain-ingress-payload.ts:285` | E1 |
| 500 字符上限只存在于 CLI / Hook / Skill 前端 | `pain-record.ts:394`；`pd-record-pain/SKILL.md:27` | E1 |
| `reason` 进入 `diagnostic_json`（TEXT/JSON），无列级长度约束 | `pain-signal-bridge.ts:897-907`；`createTask` 写入 `diagnostic_json` | E1 |

**结论**：六项结构可以放进 `reason` 扩到 2000 字符，**无需改 schema**；锚点另加两个**必填**参数（`anchorType` / `anchorRef`），写入 `diagnostic_json.anchor`。

### 2.5 严重度与评分

| 事实 | 证据 | 判定 |
|---|---|---|
| `severityFromScore(undefined)` → `moderate` | `pain-signal-bridge.ts:268-273` | E1 |
| `>=70` → `severe`；`>=40` → `moderate`；其余 `mild` | 同上 | E1 |
| V0.6 / 既有 CLI 默认 `score = 80`，等于每条都 `severe` | V0.6 §6；`pain-record.ts:469` | **需按裁定 C 取消** |
| 现有枚举只有 mild/moderate/severe，无需扩展 | 同上 | E1 |

**结论**：MCP 路径**不写 `score`** 即可得到"默认中等"，零新增常量、零迁移；提级只能由人工操作完成。

### 2.6 回执与 `diagnosis.mode`

| 事实 | 证据 | 判定 |
|---|---|---|
| MCP 进程只知道 workspace 与静态宿主标记，**不知道 Companion / worker 是否在跑** | `workspace.ts:22,94-105`；无进程探测代码 | E1 |
| 因此"auto"在 MCP 侧**不可证明** | 同上 | E1 |
| V0.6 要求 `mode` 必填且精确 | SPEC V0.6 §10 合同第 6 条 | **与可证性冲突** |
| 回执应收敛为"已持久化事实" | `submitPainSignal` 只返回 `taskId` | E1 |

**结论**：按裁定 A，`mode` 保留为可选；**不可证明就省略字段**，不得用静态配置推断。

### 2.7 StateDir 与 `state.db`（含我上一轮的自我修正）

| 事实 | 证据 | 判定 |
|---|---|---|
| 原则账本 / 会话目录是 `<workspace>/.state` | `pd-cli/src/commands/pain-record.ts:393`；E2 实测 `D:\.openclaw\workspace\.state\principle_training_state.json` | E1+E2 |
| `state.db` 在 `<workspace>/.pd/state.db` | `store/sqlite-connection.ts:71,89`；E2 实测 | E1+E2 |

**纠正**：我上一轮说"V0.6 的 `stateDir = <workspace>/.state` 是事实错误"——**该说法不成立**。`.state` 是账本目录，`.pd` 是数据库目录，两者并存且用途不同。V0.7 文档必须把两者分开写，避免继续混用"StateDir"一词。

### 2.8 执行路径与可见性

| 事实 | 证据 | 判定 |
|---|---|---|
| 自动执行者只有 codex/workbuddy worker，按 `host.*` 门控，**跨宿主消费** | `codex-adapter/src/worker/workspace-worker.ts:220-245,269-272`；`workbuddy-adapter/...:153-156` | E1 |
| 控制台能看状态，不能执行 pending | `routes/evidence-chain.ts:22-34`；`routes/failed-tasks.ts:305-320` | E1 |
| 控制台无任何 `setInterval`，单 workspace | `pd-console/src/server/**`；`WorkspaceService.ts:11-24` | E1 |
| 健康投影 kind 列表不含 `diagnostician` | `sqlite-task-store.ts:444` | E1 |
| **`createTask` 同时写入 `created_at` 与 `updated_at`** | `sqlite-task-store.ts:65-86` | E1 |
| Task Store 的 cursor 只用于分页，不是公平调度 | `task-store.ts:19-24`；`sqlite-task-store.ts:261` | E1 |
| **但公平调度游标已存在**：Codex worker 用 `get/setDiagnosticianServiceCursor` 在 pending / retry_wait 间轮转，scope 为 `codex-worker-diagnostician-fair-share` | `codex-adapter/src/worker/workspace-worker.ts:209-245` | E1 |
| WorkBuddy worker 没有公平游标，只有 pending 优先 + 退避到期 | `workbuddy-adapter/src/worker/workspace-worker.ts:113-129` | E1 |

**结论**：L2b 若用 `MAX(updated_at)` 判"最近有执行活动"，**新建任务即假阳性**（同一时间戳）。必须改用 `runs.started_at` 或租约变化。

**关于 `cursorScope` 的更正**：不能说"仓库没有公平调度游标"。正确结论是"Task Store 的 cursor 只做分页，但 `RuntimeStateManager` 的 `reconciliation_cursor` 已是公平调度 authority，Codex 已在用"。因此 V0.7 删除 `cursorScope` 的理由是**不新增第二套调度状态**，而不是"重新造一个确定性选择"。

### 2.9 L2 的安全边界

| 事实 | 证据 | 判定 |
|---|---|---|
| Console 支持 Bearer token（`--token` / `PD_CONSOLE_TOKEN`），timing-safe 比较 | `config/AuthConfig.ts:20-58` | E1 |
| 无 token 时只允许 loopback 绑定 | `server/index.ts:166-168`；`bind-guard.ts:17-25` | E1 |
| **未发现 CSRF / Origin / Sec-Fetch-Site 校验** | 全目录检索无命中 | E1（缺失） |
| L2 会触发真实模型调用（`pd diagnose run`） | `pd-cli/src/commands/diagnose.ts:196-260` | E1 |

**结论**：控制台不是"无保护"，但"loopback + 无 token"模式下，任意网页都可向 `127.0.0.1` 发简单请求。L2 路由必须增加同源校验（Origin / Host / Content-Type），不得把"只在本地"当作安全证明。

### 2.10 L2 的 spawn 可靠性

| 事实 | 证据 | 判定 |
|---|---|---|
| 控制台已有 detached + unref 的长任务先例 | `routes/update.ts:105-133` | E1 |
| Node `spawn` 返回时子进程尚未保证 exec；失败通过异步 `error` 事件上报 | Node 语义（语言层事实） | E3 |
| `pd diagnose run` 在缺少 runtime 绑定时**主动失败并给出 nextAction** | `commands/diagnose.ts:234-260` | E1 |

**结论**：202 只能在"达到受理条件"后返回；实现应监听 `spawn`/`error`，把"起不来"与"已受理"分开。不得预先假设 CLI 一定成功。

### 2.11 L3 的前置条件

| 事实 | 证据 | 判定 |
|---|---|---|
| 插件 service 为 120s 周期 | `internalization-auto-consumer-service.ts:21` | E1 |
| timer 启动受 `internalization_auto_consumer` 门控 | 同上 `:152-168` | E1 |
| 诊断能力另有 `diagnostician.enabled` 与 runtime 绑定 | `resolveDiagnosticianCapability` | E1 |
| 插件内无 worker、无 `executePendingDiagnosis` 调用 | `openclaw-plugin/src` | E1 |

**结论**：`auto` 需三条件同时成立（新 flag + 能力 + 承载 timer 的 service 已启动）；任一不成立都不得声称 auto。

### 2.12 Agent Instructions 现状

| 事实 | 证据 | 判定 |
|---|---|---|
| 现有 `pd-pain-signal` Skill 要求 **Owner 主动发起**（"只有 Owner 明确要求时才登记"） | `plugins/principles-disciple/skills/pd-pain-signal/SKILL.md` | E1 |
| WorkBuddy 的 `pd-record-pain` Skill 要求固定前缀 `PD记录痛苦：` + 500 字上限 | `~/.workbuddy/skills/pd-record-pain/SKILL.md:12-30` | E2 |
| Codex 用户技能目录无 PD 技能，依赖 PD 插件目录分发 | `~/.codex/skills`（仅第三方技能）；`plugins/principles-disciple/skills/` | E2 |

**结论**：现有 Instructions 与 V0.7 的"Agent 主动识别锚点背离"**方向相反**。实现阶段必须更新同一份规范并分发到三宿主；本轮只写规范，不改文件。

### 2.13 测试可执行性

| 事实 | 证据 | 判定 |
|---|---|---|
| V0.6 T12 宣称的"识别非 PD workspace"无实现支撑 | `pd-mcp-server/src/workspace.ts:53-107` 只校验 env 与目录 | E1 |
| 授权行为无法用服务端单测证明 | 授权发生在宿主对话，不在 PD Server | E1（结构性） |
| L2/L2b 需要状态层证据，不能只看 UI | 见技术方案 §9.6 | E1 |

---

## 3. 仍然阻断"整体 READY"的事项

| # | 事项 | 为什么不能在本轮关闭 |
|---|---|---|
| 1 | 三宿主真实落库（T18/T21） | 需要重新安装运行时并做活体调用 |
| 2 | 授权行为真实验收（T05/T06/T23） | 需要 Instructions 落地 + Harness 行为证据 |
| 3 | L3 自动执行（T36–T38） | 需要 flag、service、能力三条件在真实环境验证 |
| 4 | 回执预算上限 | 需在实现时实测 MCP 响应体大小，本文档不写死未经证实的数值 |

**WorkBuddy MCP 会话身份不再阻断 V1**：V0.7 明确三宿主统一 Unbound，身份缺失不是缺陷。

---

## 4. V0.6 → V0.7 变更清单

| # | 文档 | 变更 |
|---|---|---|
| 1 | SPEC | 重写 §1：Pain = 锚点相对背离；删除五项必要条件与"损失触发" |
| 2 | SPEC | 新增锚点三类、引用等级、低置信度澄清、冲突披露 |
| 3 | SPEC | 内容模板改为六项；`reason` 1–2000；新增**必填** `anchorType`/`anchorRef` |
| 4 | SPEC | §4 授权：对话内 + askme + 未回复=拒绝 + 后台禁止 + 修改再确认 |
| 5 | SPEC | §4.3 原生确认降级为推荐 |
| 6 | SPEC | §6 取消 `score=80`；默认 moderate；提级仅人工 |
| 7 | SPEC | §7 `diagnosis.mode` 改为可选，仅在可证实时出现 |
| 8 | SPEC | §9.5 L2b 活动信号禁用 `updated_at` |
| 9 | SPEC | 新增 §9.3 约束 6/7/8/9（同源校验、活动信号、不得声称无进程、L3 不得假 auto） |
| 10 | SPEC | §12 编号统一为 T01–T23 + T31–T40 |
| 11 | REVIEW | 重写为针对 V0.6；记录 13 个关注点与 3 项误判修正 |
| 12 | TD | 新增锚点落点、JSON schema、Tool 描述、六段内容规范、severity 落点、StateDir 双路径、L2 安全与 spawn、L2b `runs` 依据、删除 `cursorScope` 并复用既有公平游标、三宿主 Instructions 清单、A/B/C 三类测试 |

---

## 5. 误判与修正记录（可追溯）

| # | 上一轮的说法 | 实际情况 | 处理 |
|---|---|---|---|
| 1 | "提交后没人处理" | 不准确：codex/workbuddy worker 会跨宿主消费 | V0.6 已在 P1-5 更正；V0.7 保留该更正 |
| 2 | "V0.6 把 StateDir 写成 `.state` 是事实错误" | **错误**：`.state` 是账本目录，`.pd` 是数据库目录，二者并存 | 本报告 §2.7 更正；V0.7 文档分列两路径 |
| 3 | 建议"删除 `diagnosis.mode`，只回 status" | Owner 裁定 **A**：保留但仅在可证实时出现 | 按裁定执行，差异记入 SPEC §7 |
| 4 | 建议"原生确认可选忽略" | Owner 裁定 **B**：推荐开启，非必要前置 | 按裁定执行（SPEC §4.3） |
| 5 | "仓库没有公平调度游标，`cursorScope` 是全新状态" | **不完整**：Codex worker 已用 `reconciliation_cursor` 做 pending/retry_wait 公平轮转 | 本报告 §2.8 更正；V0.7 删除 `cursorScope` 的理由改为"不新增第二套游标"，并复用既有 authority |

**关于"撤销上一轮 Owner 授权 P0"**：本仓库的 V0.6 REVIEW **不存在**这样一条 P0（V0.6 的 5 个 P0 分别为 Codex 绑定键、OpenClaw MCP 恒 Unbound、复用 `recordExplicitOwnerStatement` 伪造原话、Bound 无准入收益、空证据短路位置）。因此**不写"撤销"**，只做 Owner 裁定 **D** 要求的事：记录 V0.6 §4.2 第 1 条"必须启用原生写入确认"这一**条件性要求**在 V0.7 被改为"推荐"。

---

## 6. 证据构成与结论

| 等级 | 内容 |
|---|---|
| **E1** | §2 全部代码结论（均含文件+行号）；`severityFromScore` 阈值；`createTask` 同写 `created_at`/`updated_at`；AuthConfig/Bind-guard；`stateDir` 与 `state.db` 两个路径；`executePendingDiagnosis` 在 core |
| **E2** | `D:\.openclaw\workspace` 的 `.state` / `.pd` 实测；三宿主 Instructions 实际路径；WorkBuddy `pd-record-pain` Skill 内容；OpenClaw 安装产物复核 |
| **E3** | Node `spawn` 的异步错误语义（语言层，未做端到端复现） |
| **E4** | WorkBuddy MCP 会话身份（**V0.7 不再作为阻断项**） |

**结论：PARTIALLY_VERIFIED。**

- 产品定义与合同层：V0.8 已把 13 个关注点全部收敛，且每条都有代码事实支撑；
- 仍不能称 `READY_FOR_IMPLEMENTATION_REVIEW`（整体）的原因只有一件：**提交链路的三宿主真实落库 + 授权行为 + L3 自动执行尚未在真实宿主上取证**，这必须在实现并重新安装后完成。

文档范围结论：**READY_FOR_IMPLEMENTATION_REVIEW**（SPEC V0.8 / 本报告 / 技术方案三者自洽）。

---

## 7. Owner 追加裁定（v0.8）：当前代码事实 vs 目标行为

> **本轮只落文档，代码尚未修改。** 下面每一行的"当前代码事实"是实现前的真实行为，"目标行为"是实现阶段要达成的行为；不得把目标行为写成已完成。

| # | 裁定 | 当前代码事实 | 目标行为 | 落点 |
|---|---|---|---|---|
| 1 | `pd pain record` 默认严重度改为中等 | 两处默认 `80`：`pain-record.ts:469` 与 `pain-signal-observability.ts:221`（后者会让只改 CLI 的方案失效） | 两处一起移除；省略 `--score` 不写 `score` → `moderate`；`--score` 仅作人工提级 | SPEC §6.1/§6.4；TD §6.5 |
| 2 | WorkBuddy 用户级 Skill 由安装器分发、旧文件废弃 | 安装器只校验插件根 Skill；无旧 `pd-record-pain` 处置逻辑；仓库无该 Skill 源 | 安装器分发 `pd-pain-signal` 到插件根；旧文件按路径+name 识别并重命名废弃；用户改过的副本不覆盖、只告警 | SPEC §5.5；TD §7.4 |
| 3 | `diagnostician_async_cli` 保持默认关 | quiet、默认关；开启后提交即返回 | 不随 L3 交付翻转；等真实取证后再评估 | SPEC §6.4；TD §6.5 |

**为何单列**：这三项是 Owner 对上一轮"仍需确认"的直接裁定，改变了 V0.7 的一处行为边界（CLI 默认严重度）与一处交付边界（Skill 分发方）。若混入旧结论，读者会误以为已经实现。
