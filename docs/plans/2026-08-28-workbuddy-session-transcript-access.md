# WorkBuddy 会话记录存储与 PD 可读取性实证

> **日期**：2026-08-28
> **问题**：PD 需要收集宿主对话记录。WorkBuddy 怎么保存 session？PD 的代理读得到吗？
> **结论**：**读得到。地基成立，且数据质量高于预期。**
> **方法**：本机磁盘取证 + 引擎路径拼接逻辑取证 + 当前活跃会话实时解析
> **环境**：WorkBuddy 桌面版 5.3.14（build `825709d`）

---

## 1. 结论速览

| 问题 | 答案 |
|---|---|
| 对话存在哪 | `~/.workbuddy/projects/<encoded-cwd>/<sessionId>.jsonl` |
| 格式 | JSONL，明文，每行一个 JSON 对象 |
| PD 代理能否读 | **能**。宿主经 hook payload 的 `transcript_path` 主动提供路径 |
| 当前会话并发读 | **可行**。正在写入的文件实测读出 317 行，0 解析失败 |
| 会不会被清理 | **不会**。未发现任何清理/保留策略逻辑，2.5 个月前的数据仍在 |
| 数据完整度 | **高于 hook 事件**。含工具调用入参/出参、推理过程、消息角色 |

---

## 2. 存储位置

### 2.1 路径规则

```
~/.workbuddy/projects/
└── d-Code-principles/                      ← cwd 编码：D:\Code\principles → d-Code-principles
    ├── 4325648b-4898-44aa-9447-9524479b88da.jsonl    ← 主会话
    ├── 611dfad0-e4e5-4e69-81fd-06dfbae3102e.jsonl
    ├── 611dfad0-e4e5-4e69-81fd-06dfbae3102e/         ← 该会话的子代理
    │   └── subagents/
    │       ├── agent-1b7230ab.jsonl
    │       └── agent-272579d9.jsonl
    └── ...
```

### 2.2 引擎侧路径拼接（取证自 `codebuddy.js`）

```js
eA.startsWith("agent-")
  ? join(this.getStorageDir(), el, "subagents", `${eA}.jsonl`)   // 子代理
  : join(this.getStorageDir(), `${eA}.jsonl`)                     // 主会话
```

与磁盘实际结构**完全一致**。

### 2.3 本机实况

- 58 个 `.jsonl` 文件，合计 59 MB
- 时间跨度：Jun 17 – Aug 28（约 2.5 个月），**无清理**
- 当前活跃会话：`4325648b-4898-44aa-9447-9524479b88da.jsonl`（1.2 MB，实时写入中）

---

## 3. 记录格式

### 3.1 六种记录类型（实测当前会话：317 行，0 解析失败）

| type | 数量 | 关键字段 | PD 用途 |
|---|---:|---|---|
| `function_call` | 98 | `name`, `arguments`, `callId`, `cwd`, `sessionId`, `timestamp`, `parentId` | 工具调用入参 |
| `function_call_result` | 97 | `output`, `status`, `name`, `callId` | 工具调用出参 |
| `reasoning` | 52 | `content`, `rawContent` | **AI 推理过程**（见 §5.2） |
| `message` | 48 | `role`, `content`, `message`, `status` | user / assistant 对话 |
| `file-history-snapshot` | 21 | `snapshot`, `isSnapshotUpdate` | 文件变更历史 |
| `resend-fork-notice` | 1 | `editedUserItemId` | 会话 fork（编辑历史消息产生分支） |

所有记录均带 `id` / `parentId` / `sessionId` / `timestamp` / `cwd` —— **可排序、可追溯、有层级**。

### 3.2 `message.role` 分布（实测）

`user`: 4 / `assistant`: 45

### 3.3 工具调用配对完整性（实测）

```
function_call: 99    function_call_result: 98
matched by callId: 98      in-flight（正在执行）: 1
```

**`callId` 配对 100% 成功。** PD 可据此完整重建「调用 → 结果」链路，无需依赖 hook 事件。

实测工具名分布：`Bash`(52) `TaskUpdate`(13) `TaskCreate`(8) `Write`(6) `Edit`(5) `WebFetch`(4) `show_widget`(2) `Read`(2) `ToolSearch`(2) `present_files`(2) `Skill`(1) `PowerShell`(1)

---

## 4. PD 代理如何拿到路径：三条路

### 4.1 推荐：hook payload 的 `transcript_path`

宿主在构造 hook payload 时**主动注入**，PD 无需推导：

```js
// 取证自 codebuddy.js
let ep = {
  session_id: resolveHookSessionId(eA),
  session: eA,
  transcript_path: this.getHookTranscriptPath(eA),   // ← 宿主直接给
  cwd: PathUtils.getWorkDir(),
  hook_event_name: "U..."
};
```

`transcript_path` 在引擎中出现 35 处，是标准字段。

### 4.2 兜底：约定路径推导

`<home>/projects/<encoded-cwd>/<sessionId>.jsonl`
`session_id` 亦由 hook payload 提供，故只需处理 cwd 编码（盘符小写、路径分隔符转 `-`）。

### 4.3 最后手段：目录扫描

引擎内含 `getFilesByExtension(dir, ".jsonl")` 能力，可枚举全部会话。

---

## 5. 这对 PD 意味着什么

### 5.1 数据比 hook 事件更完整

hook 事件是**实时的点**（触发时刻的单个工具调用），而 jsonl 是**完整的历史轨迹**。PD 从 jsonl 能拿到：

- 未被 hook 覆盖的时段（例如 hook 尚未注册、或插件被临时禁用）
- 完整的上下文因果链（不只是孤立的工具调用）
- 可**离线/回溯**分析，不必只在触发时刻做判断

### 5.2 `reasoning` 字段直击 Pain Attribution

`reasoning` 记录 AI 的**推理过程**（`content` + `rawContent`），共 52 条。

这是当前攻关的 **Pain Attribution 问题最缺的证据类型**：要诊断「机械式误归因」，光看「做了什么」（function_call）不够，必须看「**为什么这么做**」（reasoning）。OpenClaw 侧的 pain 检测主要依赖 `tool_calls` 与 `pain_events`，拿不到推理链。

**建议**：PD 的 WorkBuddy 适配器应把 `reasoning` 作为一级证据采集，接入 `pain_events` 的证据链。这可能成为 PD 在 WorkBuddy 上相对 OpenClaw 的**能力代差**。

### 5.3 地基稳固性评估

| 维度 | 评估 |
|---|---|
| 可读性 | ✅ 明文 JSONL，用户权限即可读（hook 子进程为同用户权限） |
| 并发安全 | ✅ 正在写入的文件可完整读出，无锁冲突 |
| 持久性 | ✅ 无清理策略，长期保留 |
| 完整性 | ✅ callId 配对 100%，含推理过程 |
| 实时性 | ✅ append-only 实时写入，hook 触发时上一条已落盘 |
| **格式稳定性** | ⚠️ **未文档化的内部格式**，版本演进风险（见 §6.1） |

---

## 6. 风险与注意事项

### 6.1 格式未文档化 —— 需分级看待（2026-08-28 深入调查后修正）

`.jsonl` 的记录类型与字段名**均未在官方文档中出现**，属内部实现，Hooks 又处于 Beta。

**但全量跨期取证（24 个主会话，Jun 17–Aug 28）显示风险应分级，不宜一概而论**（详见 §8.1）：

| 分级 | 对象 | 处置 |
|---|---|---|
| **稳定** | `function_call_result`、`file-history-snapshot`、`ai-title` —— 全期仅 1 种字段变体 | 可放心依赖 |
| **可选字段** | `message.status` / `message.message` / `parentId`、`function_call.message` / `status`、`reasoning.status` —— 变体 span 全期共存，属**语义可选**而非版本演进 | 宽容解析，缺失降级 |
| **确有演进** | `message.logicalParentId`（08-24 后消失）、`ai-title`（08-11 新增） | 需版本感知 + 契约测试 |
| **未文档** | 全部字段 | 不得依赖官方承诺 |

**缓解**：
1. 在 adapter 内做**版本适配层**：按字段名做宽容解析（缺失字段降级，不崩）
2. 加**格式断言测试**：CI 中对样本 jsonl 做结构校验，版本升级后立即发现漂移
3. 优先走 §4.1 的 `transcript_path`，而非自行推导路径与格式
4. 把 §8.1 的变体清单固化为**基线契约**，出现新变体即告警

### 6.2 `InstructionsLoaded` 事件的 `transcript_path` 为空

取证发现该事件的 payload 构造为：

```js
let eA = { transcript_path: "", cwd: ec, hook_event_name: "InstructionsLoaded", file_path: eu.filePath, ... }
```

**该事件拿不到会话路径**，PD 若订阅此事件需自行推导。

### 6.3 会话可被 fork

存在 `resend-fork-notice` 记录类型，说明用户编辑历史消息会产生分支。**同一 sessionId 下可能出现分叉轨迹**，PD 做归因时需处理分支语义，不能简单按时间线性假设。

### 6.4 隐私与合规

对话记录**明文**存于用户 home，含完整工具 I/O（可能含敏感内容：文件内容、命令输出）。PD 若采集：

- 必须遵循 PD 既有的隐私契约
- `reasoning` 与 `function_call_result.output` 是高敏感字段，证据链入库前需评估脱敏
- 遥测导出（PRI-595~603）已有匿名化机制，应复用同一管道

---

## 7. 建议

1. **P0**：在 `packages/workbuddy-adapter/` 的 codec 中，以 `transcript_path` 为一等输入，实现 `TranscriptReader`（宽容解析 + callId 配对）。
2. **P1**：把 `reasoning` 接入 `pain_events` 证据链 —— 这是 Pain Attribution 的关键增量。
3. **P1**：加 jsonl 结构的契约测试，防版本漂移。
4. **P2**：评估 fork 分支对归因的影响，设计分支感知的轨迹重建。
5. **P2**：明确高敏感字段（`reasoning`、`output`）的脱敏策略，复用现有遥测匿名化管道。

---

# 8. 深入调查（第二轮，全量跨期取证）

> 方法：解析本机**全部** 24 个主会话 + 34 个子代理会话（Jun 17 – Aug 28），而非仅当前会话。
> 目的：把第一轮基于单会话的结论，升级为跨期统计结论。

## 8.1 格式稳定性：变体清单与时间跨度

| type | 变体数 | 各变体字段差异 | span | 判定 |
|---|---:|---|---|---|
| `function_call_result` | 1 | — | 06-17..08-28 | **稳定** |
| `file-history-snapshot` | 1 | — | 06-17..08-28 | **稳定** |
| `ai-title` | 1 | — | 08-11..08-27 | 新增类型，结构稳定 |
| `message` | 5 | ±`status`、±`message`、±`parentId`、`logicalParentId` | 均 06-17..08-28（`logicalParentId` 止于 08-24） | 4 个可选字段 + 1 个演进 |
| `function_call` | 3 | ±`message`、±`status`（各 1 条） | 06-17..08-28 | **可选字段** |
| `reasoning` | 2 | ±`status`（2 条） | 06-17..08-28 | **可选字段** |

**关键判读**：绝大多数变体的 span **都是 06-17..08-28 全期共存**，说明它们不是版本演进，而是**同一时期就存在的可选字段**。真正的时间相关信号只有两个：

- `message.logicalParentId`：22 条，**仅见于 08-24 之前**，之后消失 → 疑似被 `parentId` 统一替代
- `ai-title`：**08-11 起才出现** → 明确的新增能力

**修正结论**：格式风险比第一轮评估的**低**。核心记录类型（`function_call` / `function_call_result` / `reasoning` / `message` / `file-history-snapshot`）2.5 个月内结构与字段保持稳定。仍建议宽容解析 + 契约测试，但不必按"高风险易变"设计。

## 8.2 【最重要】压缩是「追加摘要」，不销毁历史

在会话 `575f93f7`（298 行）中定位到压缩点：

```
line 148  function_call
line 149  function_call_result
line 150  message role=user  compactType=emergency-auto  isSummary=True  contentLen=12882   ← 压缩摘要（12.8KB）
line 151  message role=user  isCompactInternal=True                       contentLen=189
line 152  reasoning
line 153  function_call        ← 会话继续
...
```

**line 0–149 的原始记录全部完整保留**。JSONL 是 append-only，压缩只在末尾**追加**一条摘要消息，不重写、不删除历史。

压缩标记（`providerData` 内，全库 22 条）：

| 字段 | 取值 |
|---|---|
| `compactType` | `emergency-auto`（上下文将满） / `pre-message-auto`（消息前） |
| `isCompacted` | true |
| `isSummary` | true / false |
| `isCompactInternal` | true |

### 这个事实改变了 PreCompact 方案的定位

第一轮我把 `PreCompact` 定位为「**证据抢救**」——担心压缩会销毁证据。**这个前提是错的，磁盘记录不会丢。**

正确定位是「**利用信息不对称做归因**」：

| | 模型视角 | PD 视角 |
|---|---|---|
| 压缩后 | 上下文被 12.8KB 摘要替代，**看不到**原始 149 行 | 磁盘 jsonl 完整，**看得到**全部原始记录 |
| 后果 | Agent 会"忘记"压缩前的错误模式，重蹈覆辙 | PD 记得 |

**PD 因此拥有对 Agent 的"上帝视角"**。这直击 PD 核心价值——消除「重复纠正感」：当 Agent 因上下文压缩而丢失教训时，PD 能指出「你在压缩前的第 N 轮犯过同样的错，当时的证据是……」。这是 OpenClaw 侧不具备的，也是 WorkBuddy 原生记忆（MEMORY.md，只记摘要）做不到的。

**建议调整**：`PreCompact` 的 hook 职责从「落盘抢救」改为「**打快照标记 + 记录压缩边界**」——在 jsonl 中留下 PD 自己的边界锚点，便于后续把「压缩前」与「压缩后」的行为做对比归因。

## 8.3 `providerData` 是元数据金矿

全库统计（含主会话与子代理）：

| 字段 | 命中 | PD 用途 |
|---|---:|---|
| `agent` | 7648 | 执行主体标识，区分主会话 / 子代理 / 具体 agent |
| `messageId` | 7507 | 消息唯一 ID |
| `model` / `requestModelId` / `requestModelName` | 7507 | **模型维度归因**：某痛点是否只在特定模型出现 |
| `conversationRequestId` | 7507 | 会话请求 ID |
| `traceId` | 7351 | 链路追踪，可跨系统关联 |
| `extra_fields` | 2526 | 扩展字段 |
| `argumentsDisplayText` | 2456 | 工具入参的可读展示文本 |
| `toolResult` | 2450 | 工具结果副本 |
| `rawUsage` / `usage` | 1946 | **token 用量**：可做成本归因 |
| `reasoning` | 1921 | providerData 内的另一份推理记录 |
| `skipRun` | 42 | 跳过执行的标记 |
| 压缩标记组 | 22 | 见 §8.2 |

**价值**：`model` 与 `usage` 让 PD 首次具备**模型维度**与**成本维度**的归因能力。Pain Attribution 可以回答「这个误归因是否与模型选择相关」「纠正一次的成本是多少 token」。

## 8.4 `ai-title`：AI 生成的会话标题

- 17 条，**08-11 起新增**，字段：`aiTitle` `cwd` `sessionId` `timestamp` `type`
- 内容形如「排查openclaw启动失败与插件损坏」「调查 PD Pain 归因全链路架构」

**价值**：跨会话主题聚类的现成标签。PD 可用它把不同 session 的同类痛点归并，识别「反复出现的问题族」——这正是「重复纠正感」的量化入口。

## 8.5 子代理记录与主会话同构

- 34 个子代理文件，2580 条记录
- 类型分布：`function_call`(910) / `function_call_result`(910) / `reasoning`(397) / `message`(363)
- **`function_call` 与 `function_call_result` 完美配对（910/910）**
- 子代理携带**自己的 `sessionId`**（不同于父会话目录名），可据此区分层级

**结论**：PD 可用**同一个 `TranscriptReader`** 处理主会话与子代理，通过「目录位置 + sessionId」区分层级，无需两套解析器。
