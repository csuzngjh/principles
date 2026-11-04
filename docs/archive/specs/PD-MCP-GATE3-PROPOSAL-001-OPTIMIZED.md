# PD-MCP-GATE3-PROPOSAL-001（优化版）

## PD Application Capability 共享架构提案

  --------------------------------------------------------------------------------------------
  项目                                内容
  ----------------------------------- --------------------------------------------------------
  阶段                                Gate 3 --- Architecture Proposal（设计交付，非实施）

  上游 SPEC                           `SPEC-PD-AGENT-CAPABILITY-API-001.md` v0.4-draft

  前置审计                            `PD-MCP-ARCHITECTURE-DELTA-AUDIT-20261031`

  前置实验                            `PD-MCP-GATE2-001`（原报告：72 次运行）

  前置验证                            `PD-MCP-HOOK-INTEGRATION-VERIFICATION-001`

  原提案源码基线                      `origin/main@796000a101fd93e5b74c9301e2cd41dfbb150313`

  实施授权                            **NOT GRANTED**

  建议裁定                            **READY_FOR_OWNER_DECISION（有明确实施前置条件）**
  --------------------------------------------------------------------------------------------

> **审查范围声明：**本优化版基于 Owner 提供的原始 594
> 行提案进行文档级评审。本次没有重新 checkout
> 仓库，也没有重跑源码审计、Gate 2 或 Hook
> 实验。原提案记录的路径、行号、基线和实验结果作为其报告证据保留，不代表本次独立复验。无法从文档确认的事项标为
> `NOT_VERIFIED` 或 `OWNER_DECISION_REQUIRED`。

------------------------------------------------------------------------

## 1. Executive Decision

### 1.1 核心建议

推荐**方案 C：将 `recallPains()` 迁入现有 Core Read Model seam，不新建
`pd-application`**。但需要修正原提案的职责划分：

1.  `pain-recall-read-model.ts`：权威数据读取、只读快照、关联和结果计算。
2.  `pain-recall-capability.ts`：OD-A 投影、披露断言、协议无关的
    Capability 结果契约。
3.  只有真正执行受控 IO 的 Read Model 文件登记到
    `io-seam-registry.json`；若 Capability Facade 不执行文件
    IO，不应仅为组织方便登记为 IO seam。
4.  MCP Adapter 只调用受限 Capability 出口，不直接依赖完整
    `recallPains()`。
5.  CLI 保持既有行为，但必须明确：如果 Agent 可以执行完整 CLI 命令，CLI
    就是绕过 MCP OD-A 的另一条读取路径。OD-A 因而不能被称为全局 Agent
    数据披露边界，除非另行改造所有 Agent-facing 入口。
6.  Hook 不承担 Capability 授权或字段安全。PostToolUse
    仍可提供治理观测；Hook 缺失不影响业务安全，但可能降低观测完整性。
7.  首期 MCP Server
    与启动用户同权限，不是沙箱。应用层只读不等于进程只读；stdio 不等于
    OS 网络隔离。

### 1.2 Owner 必须明确的关键事项

  ----------------------------------------------------------------------------------
  决策                                推荐
  ----------------------------------- ----------------------------------------------
  Capability 落点                     Core Read Model + 独立 Capability Facade

  新建 `pd-application`               首期不建

  OD-A 范围                           首期明确为 MCP 响应披露策略，不宣称全局 Agent
                                      数据安全

  MCP 原始数据访问                    MCP Adapter 只允许依赖受限 Capability
                                      子路径，并由架构守卫检查

  Hook                                首期不增加 MCP PreToolUse matcher；保留
                                      PostToolUse 观测

  进程安全                            只有 Owner 接受"同启动用户权限、无 OS
                                      级隔离"后，才进入 Gate 4

  CLI 兼容                            命令、参数、输出、退出码保持不变，属于硬约束

  阶段边界                            Gate 3 Implementation 只做能力抽取与 CLI
                                      迁移；MCP Server 属于 Gate 4
  ----------------------------------------------------------------------------------

### 1.3 裁定

`READY_FOR_OWNER_DECISION` 只代表提案具备裁决条件。**D-04（OD-A
适用范围）和 D-06（进程风险接受）未决前，不得启动 Gate 3 Implementation
或 Gate 4。**

------------------------------------------------------------------------

## 2. 问题定义与实验依据

### 2.1 真实问题

原提案报告称：

-   `recallPains()` 位于
    `packages/pd-cli/src/services/pain-recall.ts`，约 896 行；
-   该文件没有本地 `pd-cli`
    依赖，但其物理位置和包导出方式使外部消费者只能依赖未声明的深导入；
-   Gate 2 MCP 原型通过 `pd-cli/dist/services/pain-recall.js`
    调用该实现；
-   生产主干尚无正式 MCP Server；
-   OD-A 字段披露规则仍在 Gate 2 冻结材料和原型中，尚未进入生产包。

以上是原提案在 `796000a10` 基线上的审计结论，本次未独立复验。

### 2.2 Gate 2 结果及解释边界

  指标                         Arm A：Skill + CLI      Arm B：MCP
  -------------------------- -------------------- ---------------
  任务成功率                       77.8%（28/36）   100%（36/36）
  字段准确率                                  74%            100%
  中位工具调用                                 14               1
  中位端到端耗时                          约 109s          约 14s
  输入 token                           10,978,368       1,567,463
  工作区副作用                              18/36            0/36
  敏感泄露 / false-success                    N/A           0 / 0

这些数字支持的结论是：**在本次预注册任务、样本和执行环境中，MCP
交付取得明显增量。**它们不能证明 MCP
对所有任务、宿主或业务能力都具有相同增益。

**统计口径必须澄清：**Hook 验证报告称 PostToolUse `.*` 会记录 MCP
`tool_calls` 证据。Gate 2 的"0/36 工作区副作用"应明确是否排除了 Hook
治理遥测写入。建议区分： -
业务数据副作用：被查询业务数据源的非预期写入； -
治理遥测副作用：PostToolUse 证据记录等预期写入。

若原实验没有区分两类，引用 `0/36`
时必须注明统计范围，不能将其解释为整个宿主调用链完全没有持久写入。

------------------------------------------------------------------------

## 3. 当前架构 Reality Map

### 3.1 现状分层

  ----------------------------------------------------------------------------------------------------------------------------------------
  层                      职责                                           原提案记录的实例
  ----------------------- ---------------------------------------------- -----------------------------------------------------------------
  Core / Read Model       权威数据读取、关联关系、底层一致性和只读原语   `PainChainReadModel`、ledger、trajectory、`RuntimeStateManager`

  Application Use Case    面向业务目标的读取编排                         `recallPains()`，物理上位于 `pd-cli`

  Host Lifecycle          宿主事件、Hook、RuleHost、Pain Admission       `host-runtime` 与各宿主 Adapter

  CLI Adapter             命令解析、参数、文本/JSON 呈现、退出码         `pd pain recall`

  MCP Adapter             Tool 注册、Schema、Transport、Result 映射      生产主干尚不存在；仅有隔离原型
  ----------------------------------------------------------------------------------------------------------------------------------------

### 3.2 需要收敛的事实表述

1.  原提案称当前包依赖 DAG 无环，Core 没有反向依赖
    `pd-cli`。这是支持迁移的重要证据。
2.  `pain-recall.ts` 据称只依赖 Node 内建模块和 Core 子路径，不依赖 CLI
    命令层。这支持"物理位置可迁移"，但不自动证明文件内所有职责都属于
    Core。
3.  WAL
    暂存快照使用系统临时目录。因此应称为"对业务工作区和业务数据源严格只读、但可能执行受控临时文件
    IO"，不宜称为无任何副作用的纯函数。
4.  Core Read Model seam 的既有成员能证明该 seam
    允许某类受控文件读取；不能单独证明 OD-A 投影和 MCP Envelope
    也应登记为 IO seam。
5.  `PainChainReadModel` 与 `recallPains()` 的遍历方向、bootstrap
    契约据称不同。迁移不得将二者强行合并或改变既有 bootstrap 行为。

------------------------------------------------------------------------

## 4. 目标架构与职责边界

### 4.1 目标关系

``` mermaid
flowchart TD
    HUMAN[Human / Agent] --> CLI[CLI Adapter]
    HUMAN --> MCP[MCP Adapter]
    CLI --> READ[Shared Pain Recall Read Model]
    MCP --> CAP[Restricted Capability Facade]
    CAP --> READ
    READ --> CORE[Core authoritative read primitives]
    CORE --> DATA[(Ledger / Trajectory / State)]
    MCP -. host tool lifecycle .-> HOOK[Host Hook Adapter]
    HOOK -. optional telemetry .-> EVIDENCE[Governance Evidence]
```

CLI 与 MCP 是并列交付 Adapter，共享业务读取和计算。由于 CLI
兼容约束，首期 CLI 继续调用完整 Read Model，MCP 只调用受限 Capability
Facade。**并列 Adapter 不意味着字段集合必须相同。**

### 4.2 职责唯一归属

  -------------------------------------------------------------------------------------
  责任                             唯一归属                说明
  -------------------------------- ----------------------- ----------------------------
  权威事实、身份键解析、关联关系   Core                    Adapter 不自行推断

  ledger / trajectory / state 读取 Read Model              复用既有 Core 原语

  查询编排、排序、可用性、截断     Read Model / Use Case   维持既有业务语义

  OD-A 字段投影与披露断言          Capability Facade       MCP 受限输出的唯一代码权威

  Capability 状态和业务错误码      Capability Contract     不依赖 MCP SDK

  MCP Tool Schema / Annotation /   MCP Adapter             不实现业务读取
  Transport                                                

  CLI 参数、输出和退出码           CLI Adapter             保持既有 CLI 合同

  PreToolUse / PostToolUse         Host Hook Adapter       不成为 Capability 运行前提
  生命周期                                                 

  MCP Server 文件/网络权限         OS / Runtime            应用层不能替代操作系统权限
  -------------------------------------------------------------------------------------

### 4.3 术语边界

-   **Read-only Capability**：业务用例不向业务数据源执行写操作。
-   **Process-level read-only**：OS
    限制进程不能写入指定范围；当前方案没有证明这一点。
-   **OD-A disclosure profile**：MCP
    响应只构造获准字段；它不是调用者身份认证，也不是全局数据访问控制。
-   **Host Hook
    governance**：宿主事件上的治理评估或证据记录；不是业务对象授权，也不是
    MCP Server 沙箱。

------------------------------------------------------------------------

## 5. Application Capability 的推荐实现边界

### 5.1 Read Model 与 Capability Facade 分开

建议逻辑结构：

``` text
packages/principles-core/src/runtime-v2/
  pain-recall-read-model.ts
  capabilities/
    pain-recall-capability.ts
```

具体目录遵循 Core 现有规范；此处是逻辑示意。

**`pain-recall-read-model.ts`** - 承载原 `recallPains()`
的权威读取、快照、关联和排序逻辑； - 保持现有输入/输出业务语义； -
保留只读矩阵证明的行为； - 仅此文件在确实需要时登记到
`io-seam-registry.json`。

**`pain-recall-capability.ts`** - 负责 OD-A `od-a-v1` 投影； - 负责
`pd.capability.v1` 协议无关业务 Envelope； -
负责允许字段构造、键路径断言和敏感哨兵检查； - 若不执行文件 IO，不登记为
IO seam； - 不暴露 MCP SDK 类型，不构造 MCP `content` 或 `isError`。

### 5.2 测试钩子不得成为公共 API

原 `painRecallSnapshotTestHooks`
是测试机制。迁移时不得因文件移动而将其纳入新的稳定公共导出面。

-   通过测试专用入口、依赖注入或现有测试约定保留测试能力；
-   对生产导出执行 API surface 断言；
-   测试钩子不得进入 MCP Tool Schema 或生产 Capability Contract。

### 5.3 输入与授权上下文

首期工具输入沿用原提案记录： - `principleId`：必填字符串，长度
1..200； - `limit`：整数 1..10，默认 3； - 不接受
`workspaceDir`、数据库路径、`hostKind`、`sessionId`、`turnId`、SQL、排序字段或自由文本上下文。

工作区由 MCP Server 启动配置绑定，不由 Tool 参数提供。能力层只接收
Adapter 已解析的工作区上下文。

**授权表述必须收敛：** - `principleId` 精确命中 ledger
是身份解析/对象存在性，不等于细粒度 ACL； -
首期工具白名单是"能力暴露范围"，不等于完整调用者身份认证； - stdio MCP
Server
没有天然的终端用户身份凭据。启动用户、启动配置和工作区绑定构成本地部署信任边界，不是远程身份认证； -
未来如需多用户、多工作区或跨租户授权，必须另立身份与授权设计。

------------------------------------------------------------------------

## 6. OD-A 披露策略：范围、位置与绕过路径

### 6.1 冻结内容

原提案称 OD-A 白名单由 Gate 2 预注册 JSON 与 `project.mjs`
双源恢复。字段内容必须继续以冻结工件为唯一依据，不得扩大范围。

原提案记录的 ALLOW 字段类别包括： -
`schemaVersion`、`capability`、`status`； -
`data.principle.requestedId`、`identityStatus`； -
`data.query.limit`、`contextUsedForRanking`、`truncated`； - association
的 `type`、`confidence`； - availability 三态； - summary
计数和截断信息； - sources 三源状态； - unresolved association 的稳定
`reason`； - provenance、warnings、error、nextAction
中冻结允许的子字段。

DENY 类别包括 canonical ID、正文、pain
ID、发生时间、来源、host、score、severity、诊断正文/内部
ID、纠错证据、lineage 和 unresolved association 内部 ID 等。

**上述类别摘要不能替代冻结
JSON。**实施时必须逐字段核对原始白名单及哈希；若冻结材料不可访问，标记
`BLOCKED`，不得从摘要重建白名单。

### 6.2 必须由 Owner 决定 OD-A 的适用范围

原提案设计： - CLI 返回完整 `pd.pain-recall.v1`； - MCP 只返回 OD-A
受限投影。

但原提案同时记录 CLI Skill 是 Agent 使用入口。只要 Agent 仍能通过 Bash
执行完整 CLI 命令，就可能绕过 MCP 的受限输出。

**推荐首期定义：OD-A 是 MCP Tool 的响应披露策略，不是全局 Agent
数据保密边界。**

在该定义下： - MCP 不返回 DENY 字段； - CLI 保持既有兼容输出； -
文档不得声称 OD-A 阻止 Agent 经 CLI 获取相同字段； - 若 Owner 希望 OD-A
覆盖所有 Agent-facing 入口，必须另立变更，重新设计 CLI
可信调用边界和兼容策略。

不得使用"CLI 是人类入口、MCP 是 Agent 入口"作为未经验证的安全假设。

### 6.3 投影位置与防绕过

推荐 OD-A 投影位于 Core 包内的 Capability Facade，作为 MCP
受限输出的单一代码权威。必须同时满足：

1.  MCP Adapter 只依赖受限 Capability 子路径；
2.  MCP Adapter 不直接导入完整 Read Model 或完整 `PainRecallResult`；
3.  通过 lint / architecture regression test 检查依赖边界；
4.  投影契约测试逐项验证 DENY 字段不出现在响应、错误和日志；
5.  明确这是防误接线和回归的代码治理边界，不是抵御恶意本地代码或被攻陷进程的
    OS 安全边界。

------------------------------------------------------------------------

## 7. CLI 与 MCP 方案比较

  -----------------------------------------------------------------------------------------
  方案                    裁定                     理由
  ----------------------- ------------------------ ----------------------------------------
  A. MCP spawn CLI 子进程 否决                     stdout / exit code 是 CLI
                                                   合同，不是稳定库 API；增加进程和解析耦合

  B. MCP 深导入 `pd-cli`  否决                     依赖未声明的包内部路径；继续把 CLI
  Service                                          包当业务库

  C. CLI / MCP            否决                     产生双真相，业务语义会漂移
  各自实现业务逻辑                                 

  D. 抽取到现有 Core Read **推荐（附职责拆分）**   复用既有 Core 原语和受控 IO seam，不新增
  Model seam                                       package

  E. 新建                 暂缓                     当前仅一个已验证用例；新包增加发布、CI
  `pd-application`                                 和维护面
  -----------------------------------------------------------------------------------------

### 7.1 对 `pd-cli` 方案的论据修正

原提案称 `pd-cli`
是"唯一会造成未来依赖环的位置"，此表述过强。是否形成实际循环依赖取决于未来
Adapter 的包归属和依赖方向；当前审计只证明现有 DAG 无环。

更准确的判断： - `pd-cli` 窄出口技术上可以形成可用 API； - 但会让 MCP
依赖承担命令行产品职责的包，增加包语义负债； - 未来 Host Adapter
需要反向消费能力时，需重新审查依赖方向； -
因此不推荐，但不能把"必然循环依赖"作为已证事实。

### 7.2 `pd-application` 升格条件

只有出现以下情况之一，并经 Owner 单独批准，才重新评估独立 Application
Package： - 多个跨 Core 与 Host Runtime 的业务用例需要共同应用层； -
Core 发布/运行时边界不再适合承载用例编排； - 多个独立交付 Adapter
需要稳定应用层契约，而 Core 不应承担该依赖； -
应用授权、审计或多工作区路由形成独立子系统。

不得仅因为 MCP 工具数量增加就自动新建 package。

------------------------------------------------------------------------

## 8. Capability Contract 与错误分层

### 8.1 分层合同

  -------------------------------------------------------------------------------
  层                                  合同
  ----------------------------------- -------------------------------------------
  Read Model                          既有 `pd.pain-recall.v1` 完整业务结果

  Capability Facade                   OD-A 受限投影、业务状态、`pd.capability.v1`

  MCP Adapter                         MCP Tool Schema、`content`、可选
                                      `structuredContent`、`isError`、Transport

  CLI Adapter                         既有 CLI JSON / 文本输出和退出码
  -------------------------------------------------------------------------------

MCP SDK 类型不得进入 Core。Core 不构造 MCP `content` block，也不直接决定
MCP SDK 的 `isError`。

### 8.2 状态映射

  ---------------------------------------------------------------------------------------------------------------
  Read Model 状态         Capability 状态      `error.code`                        性质
  ----------------------- -------------------- ----------------------------------- ------------------------------
  `ok` / `no_matches` /   同名                 无                                  当前可达
  `partial`                                                                        

  `principle_not_found`   `not_found`          `principle_not_found`               当前可达

  `pain_not_found`        `not_found`          `pain_not_found`                    实施前复核 `statusDetail`

  `source_missing` /      `unavailable`        原因码                              当前可达
  `source_unreadable`                                                              

  输入违反 Schema /       `invalid_input`      `invalid_input`                     当前可达
  业务约束                                                                         

  `ambiguous_principle`   首期不列为可达状态   ---                                 原提案称当前实现不生产；标记
                                                                                   reserved 或从 v1 移除

  Adapter 超时 /          Adapter 处理         `tool_execution_failed`（若保留）   Adapter 侧错误
  Transport 失败                                                                   

  `denied` /              首期不启用           ---                                 预留，不纳入首期可达合同
  `unconfirmed`                                                                    
  ---------------------------------------------------------------------------------------------------------------

### 8.3 `isError` 责任

-   `isError` 是 MCP 协议层语义，由 MCP Adapter 按 SDK 合同设置。
-   Capability Facade 可以返回稳定业务错误码，但不依赖 MCP SDK。
-   `disclosure_guard_rejected` 是披露断言失败，由 Adapter 映射为 MCP
    Tool Error。
-   `tool_execution_failed` 属于 Adapter 捕获的执行/超时错误；若需统一
    Envelope，由协议无关错误构造器生成错误体，再由 Adapter 映射。
-   业务错误与 JSON-RPC / Transport 错误必须区分。

### 8.4 输出限制仍待冻结

原提案建议： - 单次最多 10 条； - 结构化响应不超过 32 KiB； - 只读调用
10 秒截止； - 截断必须显式返回 `truncated`。

原文仍将其标记为待 Gate 1 冻结值，故不能描述成已批准合同。Owner 应在
D-03 批准数值，或授权 P1 在实施前冻结。

`structuredContent` 在目标宿主验证前暂不启用，维持 Gate 2 已验证的单
text content block。

------------------------------------------------------------------------

## 9. Hook 协作模型

### 9.1 安全与观测分离

首期只读 MCP 工具： - 不要求 PreToolUse matcher 覆盖 MCP； - 不依赖
RuleHost 完成业务授权或字段披露； - 业务安全由 Capability Facade、Read
Model 和只读证明承担； - PostToolUse `.*` 可以继续记录 `tool_calls`
观测证据。

### 9.2 Hook 缺失的真实影响

  能力                   Hook 缺失/失效后的影响
  ---------------------- ------------------------
  Capability 输入校验    不应受影响
  工作区绑定             不应受影响
  OD-A 字段披露          不应受影响
  Read Model 只读保证    不应受影响
  PostToolUse 治理观测   可能缺失或不完整
  Pain Admission         仍由既有准入逻辑决定

正确表述：**Hook 不是业务安全前置依赖；Hook
仍可能是治理观测的数据来源。**

### 9.3 首期范围

  ----------------------------------------------------------------------------------
  工具类型                PreToolUse              PostToolUse
  ----------------------- ----------------------- ----------------------------------
  Bash / apply_patch      保持现有治理            保持现有证据机制

  首期只读 MCP Recall     不新增 matcher          保留 `.*` 观测并验证记录语义

  未来 MCP 写类工具       另行设计；Hook          单独评估写类证据准入
                          不能作为唯一安全边界    

  第三方 MCP 工具         PD 不默认背书           仅处理宿主实际提供且已授权的事件
  ----------------------------------------------------------------------------------

Codex 0.166.0 的 deny-only / fail-open
结论仅是该版本实测事实，不得成为跨版本、跨宿主的强制安全合同。

------------------------------------------------------------------------

## 10. MCP Server 进程安全与剩余风险

### 10.1 威胁模型

首期候选形态是本地 stdio
Server、普通用户权限、单工作区绑定。这意味着： - Server
与启动用户处于相同 OS 权限级别； - Server
原则上可访问该用户本来可访问的文件和资源； - Capability
按绑定工作区派生业务路径，不等于 OS 阻止 Server 访问其他路径； -
业务用例只读不等于整个 Server 进程只读； - stdio
只描述传输方式，不自动禁止进程建立网络连接； - `readOnlyHint` 是 Host
提示，不是实际行为证明或安全边界。

### 10.2 首期准入要求

  --------------------------------------------------------------------------
  要求                       验收方式                保障性质
  -------------------------- ----------------------- -----------------------
  普通用户权限、不提权       运行时进程身份检查      OS 可验证

  工作区来自启动配置，Tool   Schema 负例 +           应用层约束
  参数不可覆盖               启动配置测试            

  业务路径由绑定根派生       路径测试 +              应用层约束
                             越界符号链接测试        

  Read Model 不写业务数据源  既有只读矩阵            业务行为保证

  MCP Adapter 仅依赖受限     架构守卫                代码治理约束
  Capability API                                     

  不传递不必要敏感环境变量   检查 Server             启动环境约束
                             实际继承环境            

  固定 SDK 与 lockfile       依赖锁定和供应链审查    依赖治理

  应用能力不主动使用网络     依赖与源码审计          不是 OS 网络隔离

  stderr、退出、挂起可控     进程集成测试            运行可靠性

  Annotation 与真实行为一致  只读矩阵 + lying-tool   行为一致性检查
                             反例                    
  --------------------------------------------------------------------------

### 10.3 Owner 必须接受的残余风险

首期普通用户进程方案不提供： - 工作区之外的 OS 文件访问隔离； -
进程级禁止写入； - OS 级网络出站阻断； - 对被攻陷
Server、恶意依赖或同用户恶意进程的隔离。

"依赖图没有网络依赖"不能证明进程不能联网；"代码只从工作区根派生路径"不能证明进程无法读取其他路径。

如果产品要求这些保证，Gate 4 前必须增加并验证 OS
级隔离、低权限身份、容器或等效机制。否则须将首期风险明确记录为 Owner
接受的本地信任模型。

**环境变量特别要求：**不得假设 Host 的 `--env`
参数天然构成环境变量白名单。实施前检查 Server 实际继承环境；若 Host
无法清理环境，应使用受控启动器或调整部署方案。

------------------------------------------------------------------------

## 11. 架构方案与最终推荐

  --------------------------------------------------------------------------
  维度              A：pd-cli 窄出口  B：独立              C：Core Read
                                      pd-application       Model +
                                                           Capability Facade
  ----------------- ----------------- -------------------- -----------------
  新 package        无                有                   无

  复用 Core 原语    间接              直接                 直接

  MCP 依赖          pd-cli            pd-application       core

  CLI 兼容          可保持            可保持               可保持

  OD-A 归属         需额外决定        清晰                 Facade 单一权威

  发布维护面        pd-cli            新增完整包生命周期   复用 Core
                    继续承担库职责                         发布流程

  当前复杂度        初始改动最低      最高                 中低
  --------------------------------------------------------------------------

**推荐 C，附带条件：** 1. 仅真正需要受控 IO 的 Read Model 文件登记 IO
seam； 2. Capability Facade 与 Read Model 分开； 3. MCP Adapter
只依赖受限 Capability 子路径； 4. 原始 Read Model 不作为 MCP Adapter
的允许依赖； 5. Owner 明确 OD-A 为 MCP-only，或另行设计全 Agent-facing
策略； 6. Core 专用子路径导出不扩大冻结 barrel； 7. 测试钩子不成为公共
API。

### `pd-application` 升格条件

只有出现跨 Core/Host Runtime 的多个业务用例、Core
发布/运行时边界不再适合、多个 Adapter
需要独立稳定应用层，或授权/审计/多工作区形成独立子系统时，才重新评估独立
package。

------------------------------------------------------------------------

## 12. Gate 3 Implementation 候选范围

本节是未来实施清单，不构成当前授权。

1.  将 `packages/pd-cli/src/services/pain-recall.ts` 迁移到 Core 合适的
    Read Model 路径；
2.  按 Core 现有规范调整内部导入；
3.  仅将真正执行受控 IO 的 Read Model 登记到 `io-seam-registry.json`；
4.  新建独立 Capability Facade，迁入 OD-A 投影、披露断言和
    `pd.capability.v1`；
5.  增加专用子路径导出，不修改冻结 barrel，除非另获批准；
6.  `pd-cli` 命令外壳改为从 Core 调用 Read Model；
7.  只读矩阵和业务测试迁至 Core；CLI 参数、输出、退出码、Skill 测试留在
    `pd-cli`；
8.  测试钩子通过测试专用机制保留；
9.  完成 changeset、依赖版本、安装包联动和发布顺序审查。

### 单 PR 条件

P2 + P3 单 PR 的目的是避免双真相期，可保留，但必须满足： -
开始前重新确认 `pain-recall.ts` 无并发修改； - Read Model
移动、Capability Facade、新导出和 CLI 接线同一变更集完成； -
不留下旧实现副本； - 只读、CLI 兼容、依赖、构建测试通过； - Core
与依赖包版本/changeset 关系已核实； - 单次 revert 可恢复原路径。

若无法可靠完成，不得为遵守"单
PR"而降低验证质量，应暂停并重新提交拆分方案。

------------------------------------------------------------------------

## 13. CLI 向后兼容硬约束

实施验收必须保证： - 命令名 `pd pain recall` 不变； -
参数名称、默认值和严格解析行为不变； -
`--principle-id`、`--pain-id`、`--context`、`--limit`、`--workspace`、`--json`
行为不变； - 默认 `limit=3`； - `pd.pain-recall.v1` JSON 结构不变； -
退出码和错误语义不变； - Skill 使用方式不变； - 既有 CLI
回归测试继续通过。

新增验证： - 同一合成工作区迁移前后 CLI JSON 黄金快照逐字节等价； - CLI
启动宿主无关测试继续通过； - CLI 不因 Capability Facade 而意外返回
`pd.capability.v1` Envelope。

**若 Owner 决定 OD-A 覆盖 Agent-facing
CLI，这将是对兼容约束的单独变更，不能隐式纳入本次抽取。**

------------------------------------------------------------------------

## 14. 测试与验收矩阵

### A. Read Model / Core

-   输入边界、精确身份解析、无标题/相似度回退；
-   ledger / trajectory / state 三源可用性；
-   WAL 快照、竞态和 ABA；
-   业务数据源只读、缺库不建库、临时文件清理；
-   确定性排序、截断和部分可用状态；
-   错误码稳定性。

### B. Capability Facade

-   OD-A ALLOW 字段逐项存在；
-   DENY 字段逐项缺省；
-   键路径越界断言；
-   敏感哨兵扫描；
-   错误、warning、nextAction 和日志无 DENY 字段；
-   profile 变更有版本记录；
-   测试钩子不进入生产导出。

### C. CLI Adapter

-   命令树、help、参数严格解析；
-   JSON Schema 黄金快照；
-   退出码和错误映射；
-   既有回归；
-   迁移前后字节级输出等价。

### D. MCP Adapter（Gate 4）

-   官方 MCP Client 的 stdio wire 级发现与调用；
-   Tool Schema、Annotation 与真实行为一致；
-   客户端不能提交或覆盖工作区；
-   MCP Adapter 不直接导入完整 Read Model；
-   `pd.capability.v1` 到 MCP Result 的映射；
-   超时、异常退出、重启、挂起、stderr；
-   按目标 Host 版本重验审批与 Hook 行为。

### E. Cross-Adapter Parity

同一合成工作区、同一查询： - CLI 与 MCP
的业务事实、计数、关联和可用性一致； - MCP 允许字段是 Read Model
结果的受限投影； - 不要求两个 Adapter 字段集合相同； -
不把"业务事实一致"误写成"所有字段逐字节相同"。

### F. Security / Process

-   DENY 字段在响应、错误、日志中无泄露；
-   工作区路径注入、越界符号链接；
-   MCP Adapter 不能误导入完整 Read Model；
-   Hook 缺失时 Capability 业务安全仍成立；
-   PostToolUse 缺失时观测缺口被准确记录；
-   Server 实际进程权限、环境变量和网络行为；
-   按当前 OS 权限如实验证工作区外访问能力；
-   lying-tool 反例证明 Annotation 不是安全边界。

### G. Host Integration

-   Codex：按目标版本重新验证审批、Annotation、deny 通道和 PostToolUse；
-   WorkBuddy：实机合成验证作为 Gate 4 前置，或由 Owner
    明确延期并接受限制；
-   其他宿主：逐一提供安装、发现、调用、卸载和治理证据。

------------------------------------------------------------------------

## 15. 复杂度、价值与风险

### 15.1 复杂度增量

  -----------------------------------------------------------------------
  项目                                推荐方案预期
  ----------------------------------- -----------------------------------
  新 package（Gate 3）                0

  新 package（Gate 4）                1 个 MCP Adapter

  新 SDK 依赖                         仅 Gate 4 Adapter

  新 schema / 数据迁移                0

  新 feature flag                     0

  新 Core 子路径                      至少 1 个；是否拆分为 Read Model /
                                      Capability 出口以实际 API 设计为准

  新 OD-A 权威策略                    1 个版本化 profile

  Hook 生产改动                       首期 0

  CLI 行为变化                        目标为 0
  -----------------------------------------------------------------------

原提案"1--2
天工程量级"属于初步估算，不是经工时数据验证的事实，不应作为批准方案的主要依据。

### 15.2 价值判断

即使 MCP 项目暂停，迁移 `recallPains()` 仍可能消除 `pd-cli`
内部深导入、改善业务能力归属，并为受限 Capability Facade 提供稳定边界。

但若 Core 迁移引入不必要的发布、构建或运行时风险，方案 A
仍可作为备选。不能仅凭未来可能有 5/10/20
个能力，就提前支付尚未发生的抽象成本。

### 15.3 风险登记

  -------------------------------------------------------------------------------------
  风险                           等级                    缓解 / 决策
  ------------------------------ ----------------------- ------------------------------
  Core 发布与插件版本协调        中                      changeset、依赖版本和
                                                         installer 联动验收

  MCP Server                     高                      Owner 明确接受；否则 Gate 4
  同用户权限，可访问更广泛资源                           前增加 OS 隔离

  CLI 可绕过 MCP-only OD-A       高（取决于策略目标）    明确 OD-A 范围；不得宣称全局
                                                         Agent 保护

  OD-A 与结果字段演进漂移        中                      键路径断言、字段快照、DENY
                                                         哨兵

  PostToolUse 缺失导致证据不完整 中                      观测完整性与业务安全分开验收

  Host 版本改变审批 / fail-open  中                      按目标版本重验；Hook
  行为                                                   不作为安全底线

  测试钩子进入公共 API           中                      测试专用导出和 API surface
                                                         守卫

  WorkBuddy 实机验证未完成       中                      Gate 4 前置或 Owner 明确延期

  `ambiguous_principle`          低                      从首期可达状态移除或标记
  不可达却进入公开合同                                   reserved
  -------------------------------------------------------------------------------------

------------------------------------------------------------------------

## 16. 迁移路线与 Gate 边界

  -----------------------------------------------------------------------------------
  阶段                      内容                              授权
  ------------------------- --------------------------------- -----------------------
  Gate 3 Proposal           本文：架构调查、方案比较、Owner   当前完成
                            裁决                              

  P1：SPEC v0.5             更新 Capability、OD-A             OG-1
                            范围、错误契约、Hook              
                            边界、进程风险、输出限制          

  Gate 3                    Core Read Model 抽取 + Capability OG-2，单独授权
  Implementation（P2+P3）   Facade + CLI 迁移                 

  Gate 4（P4）              MCP Adapter、单只读               OG-3，单独授权
                            Tool、进程安全和真实宿主验证      

  Optional Hook             未来写类 MCP 工具的宿主治理映射   OG-4，单独授权
  Adaptation（P5）                                            

  Gate 5（P6）              Codex / WorkBuddy /               OG-5
                            其他宿主分别验收                  
  -----------------------------------------------------------------------------------

### 16.1 Gate 3 Implementation 停止条件

任一条件触发即停止： - Read Model 只读矩阵失败； - CLI
输出或退出码发生非授权变化； - Core 依赖出现反向边或循环； - OD-A DENY
字段进入受限响应； - MCP 受限 Capability 无法阻止误导入完整 Read
Model； - 迁移需要新增 schema、feature flag 或未批准依赖； -
发布/安装联动无法证明可回滚。

### 16.2 Gate 4 停止条件

-   Server 工作区绑定可被 Tool 参数覆盖；
-   Server 进程权限或环境变量超出 Owner 已接受范围；
-   OD-A 发生泄露；
-   实际只读行为与 `readOnlyHint` 不一致；
-   Host 审批行为与预期不符；
-   Server 异常退出影响宿主或 CLI；
-   必需宿主前置验证未完成且 Owner 未明确接受延期。

------------------------------------------------------------------------

## 17. 回滚策略

**Gate 3 Implementation：** - Read Model 移动、Capability Facade、Core
导出和 CLI 接线应在同一可回滚变更集中完成； - 单次 revert 恢复原
`pd-cli` 服务路径和导入； - 无数据库迁移、无数据回填、无用户配置残留； -
不留下第二份活动实现。

**Gate 4：** - MCP Adapter 独立发布和安装； - 停止或卸载 Server 不影响
CLI、Hook、RuleHost； - 不得自动回退到宽权限 CLI 或未经批准的工具路径。

**Hook Adaptation：** - 未来如启用，独立 PR； - matcher / Tool Semantics
条目可独立 revert； - 不影响 Capability 层业务安全。

------------------------------------------------------------------------

## 18. Owner Decision Card（修订版）

### D-01｜Application Capability 职责与分层

**问题：**是否批准 Read Model 与 Capability Facade 分离？ - 推荐：Read
Model 负责读取/编排；Facade 负责 OD-A 投影和协议无关业务合同。 -
不推荐：把所有逻辑统称 Read Model 并全部登记为 IO seam。 -
验收：职责图、依赖图和测试边界清晰。 - Owner 决策：是。

### D-02｜代码归属与 package 方案

**问题：**是否选择方案 C？ - 推荐：Core Read Model + Capability
Facade，不新建 `pd-application`。 - 备选：`pd-cli` 窄出口，仅在 Core
发布/运行时边界不适合时考虑。 - 暂缓：独立 `pd-application`。 -
验收：无循环依赖、专用子路径、无非授权 barrel 扩张、可单次回滚。 - Owner
决策：是。

### D-03｜Capability Contract 与输出限制

**问题：**是否批准 `pd.capability.v1`
状态映射，以及条数、响应大小和超时上限？ -
推荐：保留已验证业务语义；不可达状态标记 reserved。 - 必须明确：≤10
条、≤32 KiB、10s 是待冻结建议值还是正式合同。 - `structuredContent`
待目标宿主验证。 - Owner 决策：是。

### D-04｜OD-A 适用范围与实施位置（关键决策）

**问题 A：OD-A 保护范围是什么？** - 推荐首期：MCP Tool
响应披露策略，不宣称覆盖 CLI 或所有 Agent-facing 入口。 - 若要求全
Agent-facing 保护：重新设计 CLI 访问边界和兼容策略；不能只依赖 Adapter
身份。

**问题 B：投影放在哪里？** - 推荐：Core 内独立 Capability Facade，作为
MCP 受限输出唯一代码权威。 - MCP Adapter 不得直接依赖完整 Read
Model，并由架构守卫验证。

**Owner 决策：是。未决前不得实施。**

### D-05｜Hook 职责与首期范围

**问题：**是否批准首期不新增 MCP PreToolUse matcher？ -
推荐：是；只读业务安全由 Capability / Read Model 保证。 - PostToolUse
保留为治理观测；观测缺失不等于业务安全失效。 -
未来写类工具另行授权；Hook 不是唯一安全边界。 - Owner 决策：是。

### D-06｜MCP Server 进程安全风险接受

**问题：**是否接受首期 Server 与启动用户同权限、无 OS
级文件/网络隔离？ - 推荐：仅在明确接受"Server
可访问启动用户本来可访问的资源"后进入 Gate 4。 - 若不接受，Gate 4
前必须增加并验证 OS 级隔离。 - stdio、依赖图审计和应用层路径派生不能替代
OS 沙箱。 - Owner 决策：是，属于风险接受。

### D-07｜CLI 向后兼容

CLI 既有命令、参数、JSON、退出码、错误语义和 Skill
合同保持不变，属于实施硬约束，不是可随意放宽的选项。若 OD-A 要覆盖
Agent-facing CLI，另立变更，不得隐式修改本次迁移。

### D-08｜阶段范围与后续授权

-   OG-1：SPEC v0.5 编辑与评审；
-   OG-2：Gate 3 Implementation（Core + CLI），单独授权；
-   OG-3：Gate 4 MCP Adapter，单独授权；
-   OG-4：未来写类工具 Hook 适配，单独授权；
-   OG-5：逐宿主 Gate 5 验收。
-   WorkBuddy 实机验证须明确为 Gate 4 前置，或延期并接受范围限制。
-   Owner 决策：是。

------------------------------------------------------------------------

## 19. 最终裁定

**建议：`READY_FOR_OWNER_DECISION`**

理由： - Core Read Model 方案有既有包结构和依赖方向作为依据； -
首期不新建 `pd-application` 可控制复杂度； - CLI / MCP 并列 Adapter
的方向成立； - Hook 不承担业务安全的边界明确； - OD-A、Envelope、CLI
兼容和进程风险已显式化； - Gate 3 与 Gate 4 授权边界可分离。

**实施前置，不得跳过：** 1. Owner 明确 OD-A 是 MCP-only 还是覆盖所有
Agent-facing 入口； 2. Owner 明确接受或拒绝 MCP Server
与启动用户同权限、无 OS 级隔离的风险； 3. Owner 批准 Core Read Model +
Capability Facade 的职责拆分； 4. SPEC v0.5
完成并冻结状态、错误和输出上限； 5. Gate 3 Implementation 另行取得 OG-2
授权。

本提案不授权抽取生产代码、新建 package、安装 MCP SDK、实现 MCP
Server、修改 Hook / CLI / Core / Schema、创建
PR、合并、部署或自动进入后续 Gate。

**Owner 保留最终架构裁决权与全部实施授权权。**

------------------------------------------------------------------------

## 附录 A：原提案关键证据定位

以下索引沿用原提案记录；实施前必须在目标基线上重新确认：

  ---------------------------------------------------------------------------------------------------------
  主题                                原提案记录的定位
  ----------------------------------- ---------------------------------------------------------------------
  `recallPains()` 导入与实现          `packages/pd-cli/src/services/pain-recall.ts:59-65,150-180,490-877`

  WAL 快照                            `pain-recall.ts:368-486`

  测试钩子                            `pain-recall.ts:269-283`

  CLI 外壳                            `packages/pd-cli/src/commands/pain-recall.ts:33-54,84-174`

  Core seam                           `packages/principles-core/io-seam-registry.json:40-50`

  Core 专用子路径先例                 `packages/principles-core/package.json` 中
                                      `./runtime-v2/tool-semantic-registry`

  barrel 守卫                         `runtime-v2-barrel-surface.json`；`4ac6831f2` / `5ac3a8863`

  Hook matcher                        `plugins/principles-disciple/hooks/hooks.json:5,18`

  PostToolUse 证据                    `production-pain-evidence.ts:523,621`

  Tool Semantics                      `tool-semantic-registry.ts:82-181`；Codex `tool-semantics.ts:24-27`

  OD-A 原型                           `.tmp/pd-mcp-gate2/proto/project.mjs:12-16,23-37,39-43,67-141`

  Gate 2 预注册                       `PD-MCP-GATE2-PREREGISTRATION-20261031.json`

  Hook 实验                           `PD-MCP-HOOK-INTEGRATION-VERIFICATION-001.md` 与
                                      `%TEMP%\\pd-hook-verify-001`
  ---------------------------------------------------------------------------------------------------------
