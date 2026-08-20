---
title: 斜杠命令参考
description: Principles Disciple 所有可用斜杠命令的完整参考,含用法、参数、示例和工作流。
---

# 斜杠命令参考

PD 通过 OpenClaw 斜杠命令与你交互。本文档列出所有可用的命令,并给出通俗易懂的用法说明。

::: tip 阅读建议
第一次使用?先看[用户指南](./user-guide)了解 PD 的核心概念,然后回到本页查阅具体命令。
:::

## 命令速查表

所有命令都以 `/pd-` 开头(短别名以 `/pd` + 单字母开头),不会与 OpenClaw 内置命令冲突。

| 命令 | 简写 | 类别 | 一句话用途 |
|------|------|------|-----------|
| [`/pd-init`](#pd-init) | `/pdi` | 设置 | 初始化工作区,引导建立项目焦点 |
| [`/pd-bootstrap`](#pd-bootstrap) | `/pdb` | 设置 | 扫描本地工具链(rg/sg/fd 等) |
| [`/pd-research`](#pd-research) | `/pdr` | 设置 | 让 Agent 调研工具升级方案 |
| [`/pd-help`](#pd-help) | `/pdh` | 设置 | 在会话中查看命令列表 |
| [`/pd-status`](#pd-status) | — | 监控 | 查看 GFI 疲劳指数和心智模式 |
| [`/pd-pain`](#pd-pain) | — | 监控 | 手动报告一个痛觉信号 |
| [`/pd-evolution-status`](#pd-evolution-status) | — | 监控 | 查看原则演化闭环状态 |
| [`/pd-context`](#pd-context) | — | 配置 | 控制上下文注入(思维模型/项目焦点) |
| [`/pd-focus`](#pd-focus) | — | 配置 | 管理 CURRENT_FOCUS.md(压缩/回滚) |
| [`/pd-rollback`](#pd-rollback) | — | 回滚 | 回滚一次误判的情绪事件惩罚 |
| [`/pd-principle-rollback`](#pd-principle-rollback) | — | 回滚 | 回滚一条原则并加黑名单 |
| [`/pd-export`](#pd-export) | — | 数据 | 导出分析数据或纠错样本 |
| [`/pd-samples`](#pd-samples) | — | 数据 | 查看和审核纠错样本 |

::: warning 关于实现生命周期命令
`/pd-promote-impl`、`/pd-disable-impl`、`/pd-archive-impl`、`/pd-rollback-impl` 这四个命令的 replay 生成路径已在 PRI-230 退役,目前处于半废弃状态。新的实现晋升工作流请使用 `pd candidate internalize` 和 `pd runtime activation promote` CLI 命令。本页不再文档化这四个命令。
:::

---

## 设置类命令

### `/pd-init`

**简写**:`/pdi`

初始化一个新工作区。命令本身只输出一段指导文本,真正的初始化工作由 Agent 根据指导完成——它会深度访谈你,建立项目的战略焦点。

**用法**

```
/pd-init
```

**会发生什么**

1. 命令告诉 Agent 去读取 `OKR/` 目录下的现有上下文
2. Agent 会采访你:项目愿景是什么?当前最重要的 1-3 件事是什么?
3. Agent 生成 `CURRENT_FOCUS.md`(当前焦点)和 `USER_CONTEXT.md`(用户偏好)

**什么时候用**

- 第一次在一个新工作区使用 PD 时
- 项目方向发生重大调整,需要重新对齐时

::: tip
`/pd-init` 不会直接生成 `PRINCIPLES.md` 或 `THINKING_OS.md`——这些文件由 PD 后台服务在首次需要时自动创建。
:::

---

### `/pd-bootstrap`

**简写**:`/pdb`

扫描你的本地环境,检测哪些开发工具已安装(rg、sg、fd、qmd、ast-grep、shellcheck),并把结果写入 `.state/SYSTEM_CAPABILITIES.json`。

**用法**

```
/pd-bootstrap
```

**输出示例**

```
🔍 Environment perception complete.
**Detected tools:** `rg`, `fd`, `ast-grep`
**Platform:** win32
Capabilities saved to `.state/SYSTEM_CAPABILITIES.json`.
```

**什么时候用**

- 安装 PD 后第一次使用
- 新装了工具(比如刚装了 ast-grep)想让 PD 感知到

---

### `/pd-research`

**简写**:`/pdr`

让 Agent 用 web search 调研某一类工具的最新方案,并输出一份"工具升级提案"。纯文本输出,无副作用。

**用法**

```
/pd-research [类别]
```

**参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `类别` | 否 | 要调研的工具类别,默认是 "modern high-performance CLI tools for coding and architecture" |

**示例**

```
/pd-research
/pd-research fast code search tools
```

**什么时候用**

- 想了解某类工具(如代码搜索、文档生成)的最新进展
- `/pd-bootstrap` 显示缺少某工具,想找替代方案时

---

### `/pd-help`

**简写**:`/pdh`

在会话中快速查看所有 PD 命令。由于 OpenClaw 的 `/help` 不会自动列出插件命令,PD 提供了自己的帮助命令。

**用法**

```
/pd-help
```

::: tip
记不住命令?随时输入 `/pdh` 就能看到所有命令的速查表。
:::

---

## 监控类命令

### `/pd-status`

查看 PD 的系统健康度。这是你最常用的命令之一。

**用法**

```
/pd-status [子命令]
```

**子命令**

| 子命令 | 说明 |
|--------|------|
| (无) | 显示 GFI 疲劳指数、心智模式、痛觉词典统计 |
| `empathy [--today\|--week\|--session]` | 查看情绪事件统计(默认今天) |
| `reset` | 清零当前会话的 GFI 阻力值 |
| `data` | 查看轨迹数据库统计(轮次、工具调用、痛觉事件等) |

**输出示例(默认)**

```
📊 Principles Disciple - 系统健康度监控
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💊 当前疲劳指数 (GFI): [██████░░░░░░░░░] 35/100
🧠 当前心智模式: 🤝 安抚模式 (CONCILIATORY)
   ↳ 状态诊断: 遇到阻力 🟡

🧠 痛苦进化词典: 已吸收 12 条规则
   ↳ 累计帮您拦截了 47 次无效操作
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**GFI 是什么?**

GFI(Global Friction Index)是当前会话的"疲劳指数"。Agent 每次犯错、被纠正、被拦截都会累积 GFI。GFI 越高,Agent 越容易进入"安抚模式"——它会变得更谨慎、更慢、更倾向于道歉。

- `0-20`:运转良好 🟢
- `21-50`:轻微受挫 🟢
- `51-80`:遇到阻力 🟡(建议反思上下文是否混乱)
- `81-100`:极度疲劳 🔴(建议 `/pd-status reset` 或开新会话)

::: tip 什么时候用 `reset`
当 Agent 因为积累了太多"情绪包袱"而变得过度谨慎、反复道歉时,`/pd-status reset` 可以清零 GFI,让 Agent 重新轻装上阵。这不是"删除记忆",只是重置疲劳累积。
:::

---

### `/pd-pain`

手动向 PD 报告一个痛觉信号。通常 PD 会自动检测痛觉(工具失败、用户纠正等),但有时你想明确记录一个问题,就用这个命令。

**用法**

```
/pd-pain <描述你遇到的问题>
```

**参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `描述` | 是 | 用自然语言描述遇到的问题 |

**示例**

```
/pd-pain Agent 编辑文件前没有先读取内容,导致覆盖了已有逻辑
```

**输出示例**

```
✅ Pain 已记录 (context-bound)

📋 Pain ID: manual_1751500000000_a1b2c3d4
📝 Reason: Agent 编辑文件前没有先读取内容,导致覆盖了已有逻辑
🔗 Provenance: openclaw_context_bound
📌 Session: sess_xxx

系统将基于当前会话上下文进行诊断。
```

**和自动检测的区别**

- 自动检测:PD 的 hook 在工具调用后自动判断是否是痛觉(工具失败、被拦截等)
- `/pd-pain`:你主动记录一个"软性"问题(比如 Agent 的判断方向错了,但没报错)

::: warning
`/pd-pain` 必须在 OpenClaw 聊天会话中使用——它依赖当前会话的上下文(context-bound provenance)。在非会话环境下会报 "Session ID not available"。
:::

---

### `/pd-evolution-status`

查看原则演化闭环的完整状态:控制面(GFI/门禁)、演化面(队列/任务)、原则统计、工作流漏斗。

**用法**

```
/pd-evolution-status
```

**输出内容**

- **Control Plane**:当前 GFI、GFI 来源、最近门禁拦截/绕过次数
- **Evolution**:演化队列状态(pending/in_progress/completed)、当前演化任务
- **Principles**:原则统计(candidate/probation/active/archived 数量)
- **Workflow Funnel**:工作流各阶段通过率

**什么时候用**

- 想知道有多少原则候选在排队等审核
- 想确认演化任务是否在正常推进
- 排查"为什么原则没被激活"时

---

## 配置类命令

### `/pd-context`

控制 PD 向 Agent 注入哪些上下文。这是调整 PD"存在感"的主要入口。

**用法**

```
/pd-context [子命令]
```

**子命令**

| 子命令 | 说明 |
|--------|------|
| `status` | 查看当前注入状态(默认) |
| `thinking on\|off` | 开关思维模型注入 |
| `focus full\|summary\|off` | 设置项目上下文模式 |
| `minimal` | 预设:仅核心原则(最安静) |
| `standard` | 预设:核心原则,不含思维模型 |
| `full` | 预设:核心原则 + 思维模型 + 项目上下文(最完整) |
| `help` | 显示帮助 |

**示例**

```
/pd-context status
/pd-context thinking on
/pd-context focus summary
/pd-context full
```

**三种预设的区别**

| 预设 | 核心原则 | 思维模型 | 项目上下文 | 适合场景 |
|------|---------|---------|-----------|---------|
| `minimal` | ✅ | ❌ | ❌ | 只想要最小干扰,让 Agent 自由工作 |
| `standard` | ✅ | ❌ | ❌ | 日常使用(与 minimal 相同) |
| `full` | ✅ | ✅ | ✅(summary) | 复杂任务,需要 Agent 理解全局 |

::: tip 核心原则始终注入
无论哪个预设,**核心原则(always-on)都会注入**,不可关闭。可配置的只是思维模型和项目上下文这些"增强层"。
:::

**配置存哪里?**

配置写入 `.pd/config.yaml`(ADR-0016 统一配置文件),下次对话时生效。

---

### `/pd-focus`

管理 `CURRENT_FOCUS.md` 文件——这个文件记录了当前项目的焦点、当前任务、下一步。随着工作推进,这个文件会越来越长,`/pd-focus` 帮你压缩和回滚。

**用法**

```
/pd-focus [子命令]
```

**子命令**

| 子命令 | 简写 | 说明 |
|--------|------|------|
| `status` | — | 查看当前状态和历史版本 |
| `history` | `hist` | 查看历史版本列表 |
| `compress` | `cp` | 手动压缩(归档里程碑,清理已完成项) |
| `rollback <序号>` | `rb <序号>` | 回滚到指定历史版本 |
| `help` | — | 显示帮助 |

**示例**

```
/pd-focus status
/pd-focus compress
/pd-focus rollback 3
```

**什么时候用 `compress`**

- `CURRENT_FOCUS.md` 超过 40 行时
- 完成了一个里程碑,想清掉已完成项保留未完成项
- 想把里程碑归档到 `memory/` 日记里

::: tip 自动压缩
PD 也会在后台自动压缩 `CURRENT_FOCUS.md`。`/pd-focus compress` 是手动触发,适合你想立即清理时使用。
:::

---

## 回滚类命令

PD 的核心承诺是"可回滚"。以下命令让你撤销 PD 的决策。

### `/pd-rollback`

回滚一次情绪事件(empathy event)的惩罚。当 PD 误判了一次"用户不满",导致 GFI 错误上升时,用这个命令撤销。

**用法**

```
/pd-rollback <event-id>
/pd-rollback last
```

**参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `event-id` | 是 | 要回滚的事件 ID(或用 `last` 回滚最近一次) |

**示例**

```
/pd-rollback last
/pd-rollback evt_20260701_001
```

**`last` vs `<event-id>`**

- `last`:回滚当前会话最近一次情绪事件(最常用)
- `<event-id>`:回滚指定事件(从 `/pd-status empathy` 输出中获取 ID)

**回滚后会发生什么**

1. 该事件的惩罚分数从 GFI 中扣除
2. 事件标记为"已回滚"
3. Agent 的疲劳度相应降低

::: warning
`/pd-rollback` 必须在聊天会话中使用(依赖 sessionId)。回滚的是"情绪惩罚",不是"原则"——要回滚原则用 `/pd-principle-rollback`。
:::

---

### `/pd-principle-rollback`

回滚一条原则,并将其模式加入黑名单(防止被重新提议)。

**用法**

```
/pd-principle-rollback <principle-id> [reason]
```

**参数**

| 参数 | 必填 | 说明 |
|------|------|------|
| `principle-id` | 是 | 原则 ID(如 `P_001`,从 `/pd-evolution-status` 或 `PRINCIPLES.md` 获取) |
| `reason` | 否 | 回滚原因(默认 "manual rollback") |

**示例**

```
/pd-principle-rollback P_003
/pd-principle-rollback P_003 这条原则太严格,影响了正常开发
```

**和 `/pd-rollback` 的区别**

| 命令 | 回滚对象 | 影响 |
|------|---------|------|
| `/pd-rollback` | 一次情绪事件 | GFI 降低,不影响原则 |
| `/pd-principle-rollback` | 一条原则 | 原则失效 + 模式黑名单,防止重新提议 |

---

## 数据类命令

### `/pd-export`

导出 PD 收集的数据,用于分析或备份。

**用法**

```
/pd-export analytics
/pd-export corrections [--redacted]
```

**子命令**

| 子命令 | 说明 |
|--------|------|
| `analytics` | 导出分析快照(聚合统计) |
| `corrections [--redacted]` | 导出纠错样本(已审核通过的) |

**`--redacted` 是什么**

`--redacted` 标志会脱敏处理(移除敏感信息),适合分享或上报。不加则导出原始数据。

**示例**

```
/pd-export analytics
/pd-export corrections --redacted
```

**输出示例**

```
已导出纠错样本到 .state/exports/corrections_20260701.json,模式 redacted,共 15 条。
```

---

### `/pd-samples`

查看和审核纠错样本(correction samples)。纠错样本是 PD 从 Agent 的错误中提取的"训练数据"。

**用法**

```
/pd-samples
/pd-samples review approve <sample-id> [note]
/pd-samples review reject <sample-id> [note]
```

**子命令**

| 子命令 | 说明 |
|--------|------|
| (无) | 列出所有待审核样本 |
| `review approve <id> [note]` | 批准一个样本 |
| `review reject <id> [note]` | 拒绝一个样本 |

**示例**

```
/pd-samples
/pd-samples review approve s_001 质量不错
/pd-samples review reject s_002 这个不算错误
```

**reject 会触发什么**

拒绝一个样本不只是"不通过"——它会触发一个 `correction_rejected` 痛觉事件,让 PD 重新诊断。这是 PD 的"反向学习"机制:你拒绝了一个错误的纠正样本,PD 就知道自己的判断有问题。

::: tip 审核流程
1. `/pd-samples` 查看待审列表
2. 根据样本质量决定 `approve` 或 `reject`
3. 批准的样本进入训练数据;拒绝的样本触发重新诊断
:::

---

## 常见工作流

### 工作流 1:初次使用 PD

```
1. /pdi              # 初始化工作区,建立项目焦点
2. /pdb              # 扫描本地工具
3. /pd-status        # 确认 PD 正常运行
4. /pd-context full  # 开启完整上下文(可选,适合复杂项目)
```

### 工作流 2:Agent 犯错后纠正

```
1. /pd-pain Agent 没有先读文件就编辑,覆盖了我的代码
2. /pd-status        # 查看 GFI 是否上升
3. (等待 PD 后台诊断,或用 /pd-evolution-status 查看队列)
```

### 工作流 3:Agent 疲劳过度

当 Agent 反复道歉、过度谨慎时:

```
1. /pd-status        # 查看 GFI,确认是否过高
2. /pd-status reset  # 清零 GFI
3. (继续工作,Agent 会恢复高效模式)
```

### 工作流 4:回滚误判

PD 误判了一次"用户不满",GFI 错误上升:

```
1. /pd-status empathy --session  # 查看当前会话的情绪事件
2. /pd-rollback last             # 回滚最近一次误判
3. /pd-status                    # 确认 GFI 已降低
```

### 工作流 5:审核纠错样本

```
1. /pd-samples                    # 查看待审样本
2. /pd-samples review approve s_001  # 批准好的样本
3. /pd-samples review reject s_002   # 拒绝错误的样本(触发重新诊断)
4. /pd-export corrections --redacted  # 导出脱敏数据(可选)
```

### 工作流 6:原则治理

```
1. /pd-evolution-status           # 查看有哪些候选原则
2. (在控制台审核原则候选)
3. /pd-principle-rollback P_003   # 回滚不合适的已激活原则
```

---

## 常见问题

### 命令没反应?

- 确认 PD 插件已安装:`/pd-help` 有响应说明插件加载成功
- 确认在工作区内:PD 命令需要工作区上下文
- 检查日志:`~/.openclaw/workspace/memory/logs/SYSTEM_*.log`

### `/pd-pain` 报 "Session ID not available"?

`/pd-pain` 必须在 OpenClaw 聊天会话中使用,不能在 CLI 或非会话环境调用。

### 命令输出是英文,怎么切中文?

编辑工作区的 `.pd/config.yaml`,设置 `language: zh`。或在插件配置中设置。

### GFI 一直降不下来?

- 用 `/pd-status reset` 清零当前会话 GFI
- 检查是否有持续触发痛觉的工具失败(修复根本问题)
- 考虑 `/clear` 开新会话

### 如何查看所有已激活的原则?

- 运行 `/pd-evolution-status` 查看统计
- 直接阅读 `~/.openclaw/workspace/.principles/PRINCIPLES.md`

---

## 相关文档

- [用户指南](./user-guide) — PD 核心概念和工作流
- [快速开始](./getting-started) — 安装和首次配置
- [PD CLI 命令](./development) — 会话外的 `pd` 命令行工具
