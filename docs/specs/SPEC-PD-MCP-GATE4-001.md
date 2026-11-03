# SPEC-PD-MCP-GATE4-001

## PD MCP 产品化、三宿主接入与生命周期管理

| 属性 | 内容 |
|---|---|
| SPEC ID | SPEC-PD-MCP-GATE4-001 |
| 版本 | v1.2 |
| 状态 | ACCEPTED — Owner 授权实施（2026-11-02） |
| 项目 | Principles Disciple |
| 阶段 | Gate 4 |
| 前置阶段 | Gate 3 — DONE |
| 风险策略 | 方案 A：个人受控试点，同用户 OS 权限（D-06：OWNER_CONFIRMED，2026-11-02） |
| 实施授权 | OG-3：AUTHORIZED（2026-11-02，Owner 对话指令；范围=Gate 4-A～4-F 隔离环境内完整实施；不含发布/推送/合并/部署/修改 Owner 日常宿主配置。历史状态"等待授权"截至 2026-11-02；权威记录见 PD-MCP-GATE3-OWNER-DECISION-CARD §〇 r4；实施工单 PRI-1071） |
| 上位规范 | SPEC-PD-AGENT-CAPABILITY-API-001 v0.5 |
| 前版 | SPEC-PD-MCP-GATE4-001 v1.1 |

---

# 0. 一页摘要

## 0.1 产品目标

将 PD MCP 建设为 Principles Disciple 的正式产品能力，使 Codex、OpenClaw、WorkBuddy 能够通过标准 MCP 协议访问 PD 的受限只读能力。

用户最终体验：

1. 用户安装或启用 PD 插件。
2. PD 插件自动提供 MCP Server 接入。
3. 宿主能够发现 PD MCP Tool。
4. Agent 可以按需调用原则相关历史经验。
5. 返回内容经过 PD Capability 和 OD-A 披露规则约束。
6. 插件更新后，MCP Server 随插件版本同步更新。
7. MCP 故障不会影响 PD 其他功能。
8. 用户能够诊断、修复和恢复 MCP 接入。

核心目标不是增加一个 MCP Demo，而是形成真正可以长期使用、更新和维护的产品能力。

## 0.2 本次架构方向

采用：

**一套共享 MCP Server 实现 + 三个宿主插件接入 + 一套统一业务 Capability。**

三个宿主优先使用各自已经支持的插件内置 MCP 配置，不优先向用户级 MCP 配置写入额外注册项。

宿主分别启动自己的 MCP Server 子进程，但三者共享同一份业务实现和数据披露合同。

## 0.3 已确定的 Owner 决策

以下决策不再要求重新确认：

- 采用方案 A，个人受控试点。
- 接受 MCP Server 与启动用户相同的 OS 权限。
- 首期只提供只读 Pain Recall Tool。
- 使用 Gate 3 Capability 作为唯一业务读取入口。
- OD-A v1 是 MCP 输出披露规则。
- 不修改 CLI 既有输出合同。
- 不扩大 Hook 治理范围。
- 不建设远程 MCP 服务。
- 不建设 OS 级沙箱作为本次前置条件。

D-06 已在 Owner 对话中明确选择方案 A，但仓库权威 Decision Card 尚需同步。不得将仓库尚未更新的状态伪装成已经完成记录。

## 0.4 尚需的唯一实施授权（历史记录，已于 2026-11-02 关闭）

> 本节记录 Gate 4 实施前的授权状态，保留为历史。OG-3 已于 2026-11-02 由 Owner 授权（见文件头"实施授权"与 Decision Card §〇 r4）；以下边界在授权后仍然有效。

OG-3（历史待决）：是否允许在隔离环境中实施 Gate 4。

该授权不包括：

- 修改 Owner 日常使用的宿主配置。
- 发布正式版本。
- 推送远端分支。
- 合并 PR。
- 部署生产环境。

这些边界不需要通过扩大 OG-3 来默认取得。

---

# 1. 现状与事实基线

## 1.1 Gate 3 已有能力

Gate 3 已完成：

- Pain Recall Read Model。
- `recallPrinciplePainsCapability`。
- `pd_recall_principle_pains` 能力身份。
- `pd.capability.v1` 响应合同。
- OD-A v1 字段白名单。
- Capability 输出结构自检。
- CLI 与 Core Read Model 接线。
- Core 公共子路径和架构守卫。

Gate 4 必须复用这些能力，不得重新实现查询、排序、关联、置信度或披露逻辑。

## 1.2 责任边界

| 约束 | 所属层级 |
|---|---|
| 默认返回 3 条，最多 10 条 | Gate 3 Core Capability |
| 32 KiB 响应上限 | Gate 4 MCP Adapter |
| 10 秒调用截止 | Gate 4 MCP Adapter |
| OD-A v1 数据披露 | Gate 3 Capability |
| MCP 协议和宿主连接 | Gate 4 |
| 插件生命周期 | 各宿主插件管理机制及 PD 发布流程 |

Gate 4 不得将传输层约束迁移到 Core。

## 1.3 三宿主当前事实

| 宿主 | 已经确认的能力 | 尚未证明的事项 |
|---|---|---|
| Codex | Plugin Manifest Schema 支持 `mcpServers`，支持路径或内联配置；Codex CLI 支持 MCP | PD 自身插件内置 MCP 的真实加载、调用和更新 |
| OpenClaw | 2026.10.5 有标准 MCP Client，真实 stdio Server 探测成功；插件机制支持 `mcpServers` | PD 插件内置 MCP 的真实 E2E |
| WorkBuddy | 已有内置插件使用 `.mcp.json` 成功配置 stdio MCP | PD 插件的注册、调用、审批和生命周期 E2E |

**必须区分宿主支持 MCP 与 PD 已经完成 MCP 接入。**

目前没有证据证明三个宿主已经完成 PD MCP 生产接入。

## 1.4 复核环境快照

本次评审使用的主要环境记录：

- Windows 11。
- Node.js 26.7.0。
- npm 11.19.0。
- Codex CLI 0.166.0。
- OpenClaw 2026.10.5。
- PD 2.8.0。
- Core 1.298.1。

WorkBuddy 的版本记录存在差异：已有报告记录 `37.10.3-43`，本机可执行文件元数据显示 `5.9.2.0`。Gate 4-A 必须确定 Desktop 实际运行版本，不能混用不同版本字段。

仓库复核基线：

- `origin/main`：`20c4ed9ffa39929cce040d290137df88100ccf80`
- 当时本地 HEAD：`b98e7e3`，落后一个提交。

以上均为复核快照，不是未来实施时的自动有效基线。

## 1.5 已确认的其他重要事实

1. Codex 当前 PD Plugin 没有声明 `mcpServers`，但 Codex 平台支持该字段。
2. OpenClaw 标准 MCP Client 已经通过真实 `comfyui` Server 探测。
3. WorkBuddy 内置插件已经证明 `.mcp.json` stdio 模式可用。
4. PD 当前没有独立生产 MCP Server。
5. PD 当前没有 MCP SDK 直接依赖于 Core。
6. `~/.pd/install.json`、版本目录、active pointer 和 transactions 已存在，可作为生命周期设计的复用基础。
7. 三个 PD 工作区均有相应状态数据库。

## 1.6 证据等级

本 SPEC 使用以下状态：

- `CONFIRMED`：源码或真实运行已经证明。
- `NOT_VERIFIED`：仍需目标环境实际验证。
- `BLOCKED`：缺少前置条件或授权。
- `SUPPORTED`：PD 自身已经完成全部真实宿主验收。

平台存在某项能力，不等于 PD 已经完成该能力的产品化。

---

# 2. 目标、非目标与成功定义

## 2.1 目标

G4-01：建立一个正式、独立的 PD MCP Server。

G4-02：只提供一个只读 Tool：

`pd_recall_principle_pains`

G4-03：Server 只通过 Gate 3 Capability 公共子路径访问业务数据。

G4-04：完成 Codex、OpenClaw、WorkBuddy 三宿主标准 MCP 接入。

G4-05：形成统一的插件版本、MCP Server 版本和 Core 兼容关系。

G4-06：提供可诊断、可修复、可更新、可卸载、可回滚的产品能力。

G4-07：MCP 的故障不得破坏 Hook、CLI、RuleHost、RuleCode 或 PD 主安装。

G4-08：完成三个宿主的真实运行验收。

## 2.2 非目标

首期明确不做：

- 写类 MCP Tool。
- Pain 创建、修改、删除。
- Principle 激活、停用或修改。
- RuleCode / RuleHost 管理。
- Raw 历史数据。
- 完整对话读取。
- 向量检索。
- 自动注入历史经验。
- 远程 HTTP/SSE MCP Server。
- 多租户 SaaS。
- 新数据库或迁移。
- 新建 `pd-application`。
- 大规模 Hook 治理改造。
- OS 沙箱或容器化。
- 为每个宿主重新实现一套业务查询逻辑。

本次是产品化，不是扩大 PD 的业务能力范围。

## 2.3 成功定义

Gate 4 完成必须同时满足：

1. 一个正式 MCP Server。
2. 一个只读 Tool。
3. 三个宿主均有明确的真实运行结果。
4. 所有返回遵循 Gate 3 Capability 和 OD-A。
5. MCP 不会暴露敏感字段。
6. 安装、更新、诊断、修复、卸载可恢复。
7. 宿主插件更新后 MCP Server 版本正确同步。
8. 不覆盖用户其他插件和 MCP 配置。
9. 不影响现有 PD 功能。
10. 通过完整的 CI、自动化测试和真实宿主 E2E。

不能以代码编译成功、配置文件存在或 MCP Server 单独启动成功代替产品验收。

---

# 3. 总体架构

## 3.1 目标架构

```text
                   PD Shared MCP Server
                           |
                 pd_recall_principle_pains
                           |
                 MCP Adapter / OD-A Output
                           |
              Gate 3 Capability Facade
                           |
                  Pain Recall Read Model
                           |
                       PD Data

        +------------------+------------------+
        |                  |                  |
      Codex             OpenClaw          WorkBuddy
        |                  |                  |
   Plugin Manifest    Plugin Manifest      .mcp.json
   mcpServers         mcpServers            stdio
        |                  |                  |
        +------------------+------------------+
```

三个宿主拥有独立的 MCP Server 子进程，但使用同一个 Server 实现。

## 3.2 统一 Server

新增独立 MCP Server 包。

候选：

`@principles/pd-mcp-server`

目录候选：

`packages/pd-mcp-server/`

正式名称由实施负责人根据现有 monorepo 规则确定。

强制依赖方向：

```text
PD MCP Server
      |
      +---- @principles/core/runtime-v2/pain-recall-capability
```

禁止：

- 直接依赖 Read Model 私有模块。
- 通过 CLI 子进程执行业务查询。
- 复制 Core 查询逻辑。
- 将 MCP SDK 引入 Core。
- 通过宿主 API 重新实现 OD-A。

## 3.3 宿主插件内置 MCP：首选方案

Gate 4 优先使用宿主已经支持的插件内置 MCP 配置。

| 宿主 | 首选接入形式 |
|---|---|
| Codex | Plugin Manifest `mcpServers`，引用内置 `.mcp.json` 或内联配置 |
| OpenClaw | Plugin Manifest `mcpServers` |
| WorkBuddy | 插件目录中的 `.mcp.json` |

这样可以：

- 将 MCP Server 与 PD 插件版本绑定。
- 避免额外维护多个用户级 MCP JSON。
- 利用宿主现有插件更新机制。
- 降低安装器对用户配置的侵入。
- 保持三个宿主的业务实现一致。

当前 PD 插件还没有完成上述接入，必须通过真实插件安装和调用验证。

## 3.4 兼容性后备方案

如果某个宿主的插件内置方式无法满足实际运行要求，可以考虑 PD 管理的稳定 Launcher 和独立注册方式。

但必须满足：

1. 仍然使用标准 MCP 协议。
2. 不复制业务实现。
3. 不形成第二套长期维护系统。
4. 明确配置所有权。
5. 完成安装、更新、修复和回滚测试。

不得未经说明切换为 Native Tool Bridge。

如果某个宿主最终无法使用标准 MCP，必须如实标记 `BLOCKED`，然后再向 Owner 说明实际影响。

## 3.5 启动期工作区绑定

Core Capability 要求 `workspaceDir`。

该字段：

- 必须由可信的宿主插件或 PD Launcher 提供。
- 不得出现在 Agent 可控的 Tool 参数中。
- Server 启动后不可变。
- 不得依赖 `process.cwd()`、`HOME` 或模型提供的路径作为回退。
- 无法确认工作区时必须 fail-closed。

允许使用一个范围严格受限的启动期解析器，读取 PD 安装清单和工作区元数据。

该解析器只负责确认工作区归属，不得读取业务数据库或重建查询逻辑。

**业务数据读取仍然只能通过 Gate 3 Capability。**

这一区分允许启动期安装元数据校验，而不破坏 Capability-only 业务依赖边界。

---

# 4. MCP Tool 合同

## 4.1 唯一 Tool

名称：

`pd_recall_principle_pains`

用途：

根据 Principle 身份读取关联的历史 Pain 经验。

## 4.2 输入合同

| 参数 | 要求 |
|---|---|
| `principleId` | 必填字符串，长度 1–200 |
| `limit` | 可选整数，1–10，默认 3 |
| 其他字段 | 一律拒绝 |

禁止 Agent 指定：

- 工作区路径。
- 数据库路径。
- SQL。
- Host / Session / Turn ID。
- Pain ID。
- 自定义排序或检索逻辑。

Server 必须自行进行严格校验，不能依赖宿主一定正确验证输入。

## 4.3 Capability 调用

唯一业务调用：

`recallPrinciplePainsCapability`

公共子路径：

`@principles/core/runtime-v2/pain-recall-capability`

不得绕过 Facade。

## 4.4 数据披露

严格遵守 OD-A v1。

禁止返回：

- 原始 Pain 文本。
- 证据正文。
- 内部数据库路径。
- Session / Turn ID。
- 未授权的关联身份信息。
- 内部诊断对象。
- 内部异常堆栈。

MCP 只能保持或收紧披露范围，不能扩大。

OD-A 仅约束本次 MCP Tool 响应，不得宣称它构成全局 Agent 数据边界。

CLI 仍保持原有完整输出合同。

## 4.5 只读属性

Tool 必须声明：

`readOnlyHint: true`

该声明只是宿主工具提示，不是 OS 安全边界。

真正的只读保证来自：

1. Gate 3 Capability。
2. Server 不提供写操作。
3. 严格输入 Schema。
4. 业务数据只读测试。
5. 调用前后数据库和工作区状态对比。

不得声明虚假的只读属性以绕过宿主审批。

## 4.6 响应大小

单次 MCP Tool Result 使用一个 text content block。

其中 JSON 文本 UTF-8 编码大小：

- 最大 32768 bytes。
- 32768 bytes 允许。
- 32769 bytes 超限。

不启用 `structuredContent`。

超限时：

- 不允许静默截断。
- 不允许删除白名单字段后伪装成功。
- 返回有界失败信封。
- 外层状态为 `unavailable`。
- 错误码为 `response_budget_exceeded`。

错误信封自身必须小于 32768 bytes。

32 KiB 属于 Gate 4 Adapter，不属于 Core Capability。

## 4.7 调用截止时间

单次调用最多 10 秒。

从 MCP Tool handler 开始处理请求时计时，包含：

- 输入校验。
- Capability 调用。
- 输出投影。
- JSON 序列化。

不包含 Server 进程启动和客户端排队。

当前 Gate 3 Capability 没有公开 `AbortSignal` 输入。

因此：

- 不得宣称底层操作一定可以取消。
- 可以停止等待并抑制迟到结果。
- 超时后不得再次发送成功结果。
- 必须限制仍在运行的超时任务数量。
- 必须验证资源最终释放。

`Promise.race` 不等于底层取消。

## 4.8 错误映射

本节服从 Gate 3 v0.5 §10.1。

`isError=true` 只有两类：

1. 披露断言失败。
2. Adapter 执行失败。

具体映射：

| 场景 | 返回内容 | isError |
|---|---|---|
| ok | 原始 Capability envelope | false |
| no_matches | 原始 Capability envelope | false |
| partial | 原始 Capability envelope | false |
| not_found | 原始 Capability envelope | false |
| 普通 unavailable | 原始 Capability envelope | false |
| 普通 invalid_input | 原始 Capability envelope | false |
| disclosure_assertion_failed | 原始失败信封，不返回违规数据 | true |
| response_budget_exceeded | unavailable + response_budget_exceeded | true |
| 非预期异常 | tool_execution_failed | true |
| 10 秒超时 | tool_execution_failed | true |
| Server 正在关闭 | tool_execution_failed | true |

特别说明：

`response_budget_exceeded` 不创造第三种 isError 分类，而是归属于 Adapter 执行失败。

这样与 Gate 3 v0.5 保持一致，不需要修改上位 SPEC。

Tool 参数违反 MCP Schema 时，在协议输入校验阶段拒绝，不调用 Capability。

任何异常都不得将 Node 堆栈、绝对路径、数据库细节或环境变量值暴露给 Agent。

---

# 5. 进程安全与运行边界

## 5.1 D-06：方案 A

Owner 已选择方案 A。

含义：

MCP Server 作为宿主子进程运行，拥有与启动用户相同的 OS 权限。

这意味着：

- 它原则上可以访问该用户有权限访问的文件。
- 宿主 Sandbox 不自动限制 MCP Server。
- stdio 不代表网络隔离。
- readOnlyHint 不限制进程本身的文件和网络权限。
- PD 业务只读能力不等于 OS 进程沙箱。

不宣称已经实现 OS 级隔离。

## 5.2 进程所有权

MCP Server 由宿主启动和管理。

PD 不建设常驻后台 daemon。

PD 不得：

- 强制杀死宿主管理的正常 MCP 子进程。
- 假设配置更新后当前会话立即切换版本。
- 通过后台服务模拟 stdio。
- 让一个宿主的退出影响另一个宿主。

三个宿主可以各自启动独立 Server 实例。

## 5.3 stdout / stderr

stdout 只能输出 MCP 协议消息。

所有日志、调试和诊断写入 stderr 或 PD 既有日志设施。

禁止：

- banner。
- 进度条。
- console.log。
- 非协议文本。

## 5.4 环境变量

审计实际继承的环境变量。

- 只传递运行所需变量。
- 不记录变量值。
- 不无意注入无关 API Key 或云端 Token。
- 不得为了形式上的白名单破坏 PATH、HOME、证书和 Node 运行环境。
- 不宣称环境变量审计构成进程隔离。

首期 MCP 不主动联网，但方案 A 不提供 OS 网络阻断保证。

## 5.5 启动和关闭

启动：

1. 解析固定工作区。
2. 校验 Server/Core 版本。
3. 初始化 Capability。
4. 注册唯一 Tool。
5. MCP initialize。
6. 等待请求。

关闭：

1. 停止接收新请求。
2. 处理进行中请求。
3. 抑制迟到结果。
4. 释放资源。
5. 关闭 stdio。
6. 正常退出。

---

# 6. 三宿主接入

## 6.1 共通要求

- 一个 MCP Server 实现。
- 一个 Tool 合同。
- 一个 Capability。
- 一个 OD-A v1。
- 每个宿主单独验收。
- 不允许静默回退到 CLI 或 Hook。
- 不允许以 Plugin 测试代替 MCP E2E。

三个宿主首期均以标准 MCP stdio 为目标。

## 6.2 Codex

目标版本复核：

Codex CLI 0.166.0。

已确认：

- Plugin Manifest Schema 支持 `mcpServers`。
- 支持路径或内联配置。
- 插件加载器支持内置 MCP 配置。
- PD 当前插件尚未声明该能力。

优先方案：

在 PD Codex Plugin 内置 MCP Server 配置。

实施要求：

1. 使用 Codex Plugin Manifest 支持的 `mcpServers`。
2. 核验 `.mcp.json` 路径和实际启动。
3. 将 MCP Server 与 PD Plugin 版本绑定。
4. 保持现有 Marketplace Plugin 机制。
5. 不复活已经退休的旧 Codex Hook Installer。
6. 不将用户级 `codex mcp add` 作为默认唯一接入方式。

`codex mcp add` 没有独立的 `--cwd` 和审批参数。若兼容路径必须使用该命令，应由实施负责人处理配置表达和持久化问题，不要求 Owner 决策。

Marketplace Plugin 的安装与更新由 Codex 插件机制负责，不能声称由 PD Installer 完全控制。

审批：

- `readOnlyHint:true` 必须真实。
- 目标版本必须验证审批行为。
- 禁止使用危险 bypass 作为生产验收方式。

## 6.3 OpenClaw

目标版本：

OpenClaw 2026.10.5。

已通过真实环境证明：

- 存在标准 MCP Client。
- 支持 stdio Server。
- 已成功探测现有 MCP Server。
- 插件体系支持 `mcpServers`。

优先方案：

PD OpenClaw Plugin 内置 MCP 配置。

不将 `contracts.tools` 作为标准 MCP Client 的前置条件。

该字段主要涉及 Native Tool Plugin 的声明和作者校验，不是标准 MCP Client 能力的必要条件。

首期不实现 Native Tool Bridge。

真实验收：

- 插件启用。
- MCP Server 启动。
- initialize。
- tools/list。
- tools/call。
- 错误与超时。
- 宿主重启。
- 插件更新。
- 卸载和恢复。

## 6.4 WorkBuddy

优先方案：

PD WorkBuddy Plugin 内置 `.mcp.json`。

已有内置插件证明：

- stdio transport 可用。
- command、args、cwd、env 可以通过插件 MCP 配置表达。

但尚未证明 PD MCP 自身能够完成真实接入。

必须：

1. 确认 WorkBuddy Desktop 实际版本。
2. 确认 PD Plugin 实际配置作用域。
3. 完成工具发现和真实调用。
4. 验证审批和关闭行为。
5. 验证插件更新、修复和卸载。

保持：

- `defaultEnabled:false`。
- 显式启用。
- install ≠ enable。
- 不把 `mcpServers` 写入不支持的 Agent frontmatter。

## 6.5 宿主支持状态

每个宿主维护以下状态：

- `NOT_IMPLEMENTED`
- `IMPLEMENTED_NOT_RUNTIME_VERIFIED`
- `RUNTIME_VERIFIED`
- `SUPPORTED`
- `BLOCKED`
- `DEPRECATED`

只有完成真实安装、启动、工具发现、调用、错误、超时、重启、更新、卸载和非回归测试后才能标记 `SUPPORTED`。

Native Tool Bridge 不计入标准 MCP 支持数。

---

# 7. 安装、更新与生命周期

## 7.1 设计原则

优先复用现有 PD 和宿主插件管理体系。

**插件内置 MCP 是首选交付方式。**

各宿主自己的插件管理器负责插件的安装、更新和移除。

PD 发布流程负责保证三个宿主插件所携带的 MCP Server 与 Core 版本兼容。

不允许：

- 插件内有一份 MCP Server，PD Installer 又安装另一份互不关联的副本。
- 用户手工维护多份配置。
- PD Installer 擅自覆盖 Marketplace Plugin。
- 宿主插件版本和 MCP Server 版本无法追踪。

## 7.2 安装器职责

PD Installer 负责：

- 检查 PD 安装状态。
- 识别兼容版本。
- 检查 MCP 相关插件状态。
- 提供健康检查和诊断。
- 识别版本不匹配。
- 给出可执行恢复建议。
- 管理 PD 自身拥有的启动和安装资产。

宿主插件管理器负责：

- 插件安装。
- 插件更新。
- 插件启用和禁用。
- 插件内 MCP 配置加载。
- MCP 子进程启动和关闭。

不得混淆两者的责任。

## 7.3 当前 CLI 事实

当前并不存在：

- `pd status`
- `pd update`

当前存在：

- `pd health`
- `pd diagnose`
- `create-principles-disciple status`
- `create-principles-disciple repair-update-chain`

PD 更新通过现有 release manager 自动更新机制，不是一个已存在的 `pd update` 命令。

实施负责人应优先复用已有入口。

只有现有入口无法表达 MCP 生命周期时，才新增最小的 `pd mcp` 命令，不得建设平行管理体系。

## 7.4 `--host all` 语义

必须区分安装和卸载：

- 当前安装语义：OpenClaw + Codex。
- WorkBuddy：显式 opt-in。
- 当前卸载语义：还会识别已经登记过的 WorkBuddy 安装。

Gate 4 不得擅自统一或改变上述行为。

## 7.5 配置所有权

无论最终是否需要单独的宿主配置，必须明确：

- 哪个配置由 PD 创建。
- 哪个配置由宿主管理。
- 如何识别 PD 自己的配置。
- 用户手工修改后如何处理。
- 卸载时如何保留其他配置。

不得全量重写宿主配置。

同名冲突时停止，不覆盖用户配置。

配置损坏时先备份，不清空重建。

## 7.6 更新

优先使用插件自身版本更新机制。

每个插件版本必须记录：

- PD 插件版本。
- MCP Server 版本。
- Core 兼容版本。
- MCP SDK 包族和精确版本。
- Capability 协议版本。
- OD-A profile。
- 已验收宿主版本。

如果某个宿主需要独立稳定 Launcher：

1. Server 版本目录不可变。
2. 更新先写入 staging。
3. 校验包完整性。
4. 验证启动和握手。
5. 成功后切换 active version。
6. 保留上一可用版本。
7. 不强制终止宿主持有的旧进程。
8. 提示用户重启宿主。

## 7.7 修复

只修复 PD 明确拥有的对象。

可修复：

- PD MCP 包缺失。
- 版本指针损坏。
- PD 自有配置项漂移。
- 可安全恢复的 PD 备份。

不可自动修复：

- 用户创建的同名 MCP Server。
- 无法确认归属的配置。
- 无法无损合并的用户修改。
- 宿主自身损坏。

修复前先诊断，修复后重新执行握手和工具发现。

## 7.8 健康检查

优先复用 `pd health` 和 `pd diagnose`。

健康检查默认只读。

至少检查：

- PD 插件版本。
- MCP Server 版本。
- Core 兼容性。
- SDK 版本。
- 宿主是否安装和启用。
- MCP 配置是否有效。
- Server 能否启动。
- 工具是否能被发现。
- 是否需要重启宿主。
- 最近失败阶段和脱敏错误类别。

状态包括：

`HEALTHY`、`NOT_INSTALLED`、`HOST_NOT_FOUND`、`CONFIG_MISSING`、`CONFIG_DRIFT`、`VERSION_MISMATCH`、`SERVER_START_FAILED`、`HANDSHAKE_FAILED`、`TOOL_DISCOVERY_FAILED`、`CAPABILITY_UNAVAILABLE`、`RESTART_REQUIRED`、`HOST_RUNTIME_NOT_VERIFIED`。

## 7.9 卸载与回滚

卸载：

- 只移除 PD 自己拥有的插件或配置。
- 不删除用户其他 MCP。
- 不影响 Hook、CLI、RuleHost、RuleCode。
- 不删除 PD 业务数据。
- 不删除仍被其他宿主使用的共享资产。

回滚：

- 恢复上一可用版本。
- 不覆盖用户无关配置。
- 保留失败诊断。
- 重新执行握手和工具发现。
- 不可恢复时标记 `BLOCKED`。

---

# 8. Hook、CLI 和既有治理系统

## 8.1 Hook 当前事实

当前 PD Hook：

- PreToolUse matcher 为 `Bash|apply_patch`，不匹配 MCP Tool。
- 当前没有 PD MCP 专用 tool-semantics 映射。
- PostToolUse matcher 为 `.*`，因此 MCP 调用能够进入通用 PostToolUse 观测路径。
- 现有 admission 逻辑可以构造通用 tool-failure candidate。

因此准确表述是：

**PD 目前没有 MCP 专用的 PreToolUse 拦截和治理语义，但存在通用 PostToolUse 观测路径。**

不能声称完全没有观测，也不能声称已经完成 MCP 专项治理。

首期不修改 Hook。

## 8.2 首期接受条件

1. 只有一个只读 Tool。
2. 数据披露由 Capability 保证。
3. 不提供写类 Tool。
4. MCP 调用不计入已经完成的 PD Hook 专项治理覆盖。
5. 不改变现有 Hook matcher。

未来新增写类 Tool 或扩大 MCP 治理覆盖，需要单独提出 OG-4。

## 8.3 CLI

- CLI 既有命令、输出、JSON、退出码保持不变。
- MCP 不得通过 CLI 子进程实现查询。
- CLI 和 MCP 可以共享底层 Read Model，但不是同一个 Capability 入口。
- MCP 使用 Capability Facade。
- CLI 继续使用原有 Read Model 路径。

## 8.4 RuleHost / RuleCode

Gate 4 不修改：

- RuleHost。
- RuleCode。
- 原则激活和执行。
- 既有回滚机制。
- 既有治理链路。

MCP 不可用不得阻断 PD 其他功能。

---

# 9. SDK 与发布管理

## 9.1 SDK 选型

评审时观察到：

| 包族 | 版本快照 |
|---|---|
| `@modelcontextprotocol/sdk` | 1.32.2 |
| `@modelcontextprotocol/server` | 2.4.0 |
| `@modelcontextprotocol/client` | 2.4.0 |

Gate 2 使用过 1.32.2，但这不代表生产必须继续使用该版本。

Gate 4-A 必须比较：

- SDK 包族。
- Server API。
- stdio 启动入口。
- Node 26 兼容性。
- 依赖体积。
- 正式发布和打包能力。

最终技术选择由实施负责人决定。

## 9.2 依赖边界

- SDK 只属于 MCP Server 相关包。
- Core 不得直接依赖或运行时导入 MCP SDK。
- 不使用 `latest`。
- 生产依赖必须精确锁版。
- 不得在启动时动态下载依赖。
- 必须新增适当的架构守卫，不能把尚未存在的守卫描述为已有能力。

## 9.3 版本发布

发布清单至少记录：

- PD release。
- Core version。
- MCP Server version。
- SDK package family/version。
- Node runtime。
- `pd.capability.v1`。
- `od-a-v1`。
- 各宿主插件版本。
- 精确验收宿主版本。

不允许仅凭 semver 范围推断运行兼容。

---

# 10. 日志与诊断

日志不得记录：

- Pain 原始文本。
- 证据正文。
- API Key。
- 环境变量值。
- 完整数据库路径。
- 完整 Tool Result。
- 内部异常堆栈。

日志可以记录：

- 时间。
- Server 版本。
- 宿主标识。
- 请求阶段。
- 耗时。
- 结果类别。
- 错误类别。

用户发生故障时，必须能够判断：

1. 插件是否安装。
2. MCP 是否启动。
3. 工具是否发现。
4. 调用失败发生在哪个阶段。
5. 是否需要重启。
6. 是否可以安全修复。

错误提示必须包含下一步行动建议。

---

# 11. 测试与验收

## 11.1 Server 测试

覆盖：

- MCP initialize。
- tools/list。
- tools/call。
- 输入校验。
- Capability 调用。
- OD-A 字段约束。
- `isError` 映射。
- 32 KiB 边界。
- 10 秒 deadline。
- 超时和迟到结果。
- stdout 纯协议。
- stderr 脱敏。
- 并发和关闭。

## 11.2 宿主插件测试

每个宿主必须真实验证：

- 插件安装和启用。
- 插件内 MCP 配置加载。
- Server 启动。
- 工具发现。
- 真实调用。
- 错误和超时。
- 宿主重启。
- 插件更新。
- 插件卸载。
- 配置保留。

## 11.3 生命周期测试

覆盖：

| 场景 | 预期 |
|---|---|
| 首次安装 | 只有一个 PD MCP 注册 |
| 重复安装 | 不重复、不破坏配置 |
| 用户已有其他 MCP | 完整保留 |
| 同名冲突 | 明确报告，不覆盖 |
| 配置损坏 | 备份并停止 |
| 更新成功 | 新版本正确生效 |
| 更新失败 | 恢复上一版本 |
| Repair | 只修复 PD 所有资产 |
| Uninstall | 不影响其他 PD 能力 |
| 多宿主 | 各自独立，不互相影响 |
| 并发更新 | 不发生版本和配置损坏 |

## 11.4 最低量化门槛

| 验收项 | 门槛 |
|---|---|
| Server 启动和握手 | 每宿主 20/20 |
| 工具发现 | 每宿主 20/20 |
| 真实 Tool 调用 | 每宿主 10/10 |
| 单次调用时延 | 不超过 10 秒 |
| 响应边界 | 32768/32769 bytes 均通过 |
| 正常关闭 | 至少 10 次循环 |
| 重复安装 | 至少 3 次幂等 |
| 更新回滚 | 成功覆盖故障注入 |
| 配置保护 | 无关字段零变化 |
| 非回归 | 现有 PD 功能全绿 |

真实验收必须使用目标宿主和正式打包产物，不能用 Mock 替代。

## 11.5 最终支持判定

每个宿主分别出具：

- PASS
- FAIL
- NOT_VERIFIED
- BLOCKED

没有真实 PD MCP E2E 证据的宿主不得标记 `SUPPORTED`。

---

# 12. 分阶段实施

## Gate 4-A：现实核验和接入方案冻结

授权：只读调查和隔离探针。

工作：

1. 重新检查最新 main。
2. 复核 Gate 3 Capability。
3. 验证三个宿主的插件级 MCP 配置。
4. 解决 WorkBuddy 版本识别问题。
5. 验证插件内置 MCP 与 PD 版本绑定方式。
6. 冻结 SDK 包族和精确版本。
7. 冻结 workspace binding。
8. 更新 D-06 权威决策记录。
9. 输出现实核验报告。

退出条件：

关键技术事实均有证据；未验证项目明确标注；不存在影响实施的重大架构歧义。

Gate 4-A 不要求 OG-3。

## Gate 4-B：生产 MCP Server

仅在 OG-3 获批后实施。

交付：

- 独立 MCP Server。
- 唯一只读 Tool。
- Capability 接线。
- OD-A。
- 32 KiB。
- 10 秒 deadline。
- 错误映射。
- SDK 依赖和架构守卫。
- 正式打包。

## Gate 4-C：Codex 产品纵切

交付：

- 插件内 MCP 接入。
- Server 启动。
- 工具发现。
- 真实调用。
- 安装和更新兼容。
- 审批验证。
- 故障恢复。

## Gate 4-D：OpenClaw 接入

交付：

- Plugin Manifest MCP 接入。
- 标准 MCP Client 连接。
- 真实调用。
- 生命周期验证。
- 原有 Plugin/Hook 非回归。

## Gate 4-E：WorkBuddy 接入

交付：

- 插件 `.mcp.json`。
- 保留显式启用。
- 真实 Desktop E2E。
- 更新、恢复和卸载验证。

## Gate 4-F：全量收口

交付：

- 三宿主支持矩阵。
- 版本兼容矩阵。
- 生命周期故障注入报告。
- 主操作系统完整 E2E。
- 安装文档。
- 诊断手册。
- 最终验收报告。

Gate 4 只有在全部已承诺宿主达到支持条件后才能宣布完整交付。

---

# 13. 风险与停止条件

## 13.1 已接受风险

方案 A：MCP Server 与启动用户同 OS 权限。

残余风险：

- 文件访问权限。
- 进程继承环境变量。
- 网络访问能力。
- 宿主 Sandbox 不自动约束 MCP 子进程。

该风险不再作为本次 Owner 待决事项，但必须在产品文档中明确说明。

## 13.2 其他风险

| 风险 | 控制措施 |
|---|---|
| 数据越界 | Capability + OD-A |
| 工作区错绑 | 固定可信启动绑定 |
| 宿主配置损坏 | 所有权识别、备份、局部修改 |
| 插件更新失败 | 保留上一版本 |
| MCP 超时 | deadline + 迟到结果抑制 |
| Hook 覆盖不足 | 首期只读、不扩展写能力 |
| 插件版本漂移 | 发布兼容矩阵 |
| 宿主版本变化 | 精确版本验收 |

## 13.3 停止条件

以下任一发生，停止对应阶段：

1. MCP 无法只通过 Gate 3 Capability 读取业务数据。
2. OD-A 发生无法解释的数据泄露。
3. 超过 32 KiB 时只能静默截断。
4. 超时结果可能被报告为成功。
5. MCP stdout 混入非协议信息。
6. 无法确认宿主配置归属。
7. 更新失败无法恢复。
8. 宿主审批必须使用危险 bypass。
9. 真实宿主运行行为与设计不符。
10. MCP 影响 Hook、CLI、RuleHost、RuleCode 或主安装。
11. 必须扩大首期业务范围才能完成基本产品目标。

不得降低验收标准以获得 PASS。

---

# 14. Owner 决策边界

## 14.1 已经确定

- 方案 A。
- 个人受控试点。
- 同用户 OS 权限。
- 一个只读 Tool。
- 三个目标宿主。
- 共享 Capability。
- OD-A v1。
- 不改 CLI。
- 不扩展 Hook。
- 不建设远程服务。

## 14.2 唯一当前待决事项：OG-3（历史记录，已于 2026-11-02 关闭）

> 本节记录 Gate 4 实施前的待决事项，保留为历史。Owner 已于 2026-11-02 授权 OG-3（见文件头与 Decision Card §〇 r4）。

Owner 只需要决定：

是否允许实施负责人在隔离环境中完成 Gate 4 的代码、测试、打包及真实宿主测试？

具体范围见配套 Owner Decision Card。

## 14.3 技术决策全部委托实施负责人

以下事项不要求 Owner 逐项确认：

- SDK 1.x 或 2.x。
- 包名和目录。
- 插件 Manifest 字段组织。
- `.mcp.json` 具体内容。
- Launcher 具体实现。
- workspace resolver 实现。
- 版本目录和回滚机制。
- 错误处理代码。
- 测试框架。
- CI 和发布依赖。
- 任务拆分和修复顺序。

实施负责人必须对技术选择负责，并在最终报告中解释重要架构决策。

## 14.4 未来需要升级给 Owner 的情况

只有出现以下变化才需要重新裁决：

- 必须增加写类 MCP Tool。
- 必须扩大 Hook 治理范围。
- 必须改变 OD-A 披露范围。
- 某个宿主无法实现标准 MCP，需要改变产品承诺。
- 必须引入远程服务或持续费用。
- 必须改变已经接受的进程权限风险。

---

# 15. 交付清单

1. 正式 MCP Server 包。
2. 唯一只读 Tool。
3. Gate 3 Capability 接线。
4. OD-A 输出验证。
5. SDK 精确锁版。
6. Codex 插件接入。
7. OpenClaw 插件接入。
8. WorkBuddy 插件接入。
9. 版本兼容和发布清单。
10. 生命周期和恢复机制。
11. 健康检查和诊断。
12. 三宿主 E2E 报告。
13. 自动化测试和架构守卫。
14. 用户安装和故障排查文档。
15. 最终支持矩阵。

---

# 16. v1.2 修订记录

相对 v1.1：

1. 修正 Codex 插件 Manifest 支持 MCP 的事实。
2. 修正 OpenClaw 已支持标准 MCP Client 的事实。
3. 补充 WorkBuddy 插件级 `.mcp.json` 接入路径。
4. 将三宿主插件内置 MCP 设为首选架构。
5. 明确共享 Server 实现和宿主独立进程。
6. 明确宿主插件管理器与 PD Installer 的职责。
7. 修复 `isError` 映射与 Gate 3 v0.5 的合同冲突。
8. 明确 `response_budget_exceeded` 属于 Adapter 执行失败。
9. 修正 `pd status`、`pd update` 不存在的事实。
10. 修正 `--host all` 安装和卸载语义差异。
11. 修正 Hook 通用 PostToolUse 观测事实。
12. 明确启动期工作区校验和业务数据读取的依赖边界。
13. 补充 SDK v2 分包选型。
14. 将 D-06 和 OG-3 分开记录。
15. 将 Owner 决策缩减为一个明确的实施授权。

# 17. 最终状态声明

本 SPEC v1.2 是 Gate 4 的正式修订候选版本。

它冻结产品范围、数据合同、宿主接入方向、生命周期原则和验收标准。

它不代表代码实施已经开始。

当前状态（2026-11-03 更新）：

- Gate 3：DONE。
- D-06：OWNER_CONFIRMED（Decision Card §〇 r4），待权威记录同步。
- Gate 4-A：DONE（REALITY_CHECK 已交付）。
- OG-3：AUTHORIZED（2026-11-02，见文件头）。
- Gate 4-B～4-F：AUTHORIZED，已在隔离环境内实施（实施工单 PRI-1071）。

历史状态（截至 2026-11-02 授权前，保留为历史）：

- Gate 4-A：可执行只读核验。
- OG-3：NOT_AUTHORIZED。
- Gate 4-B～4-F：BLOCKED_BY_OG3。

**本 SPEC 不自动授予生产配置写入、正式发布、推送、合并或部署权限。**