# SPEC-PD-SERVICE-HOST-001 — PD 独立服务宿主架构规范

- **版本**：v0.3
- **日期**：2026-11-20
- **状态**：Architecture Approved（ADR-0020 §11.6 dated amendment，Owner 2026-11-19）/ Implementation not started
- **v0.3 整改修订**：统一授权状态（§11.6 已批准架构，§11 治理 Gate 改写）、补齐 Workspace 发现与 Host Binding 契约（§7 FR-05、§9）、新增 Workspace 级所有权状态机（§8.4）、实施阶段改为 Phase 1–5 契约化描述（§11）。
- **v0.2 源码审计修订**：按 2026-11-19 最新源码事实审计修正；§3 表格维持「当前事实」，§3.1 记录两个 Adapter 的真实差异与被推翻的隐式假设。
- **范围**：PD 后台任务的生命周期所有权、触发、执行、恢复与可观测性
- **规范定位**：定义 PD Service Host 的产品与架构契约；具体模块拆分、进程和平台实现见配套 [技术设计](./SPEC-PD-SERVICE-HOST-001-TECHNICAL-DESIGN.md)。
- **不改变**：Pain 语义、诊断/内化业务规则、Owner 审批权、既有任务状态机、Workspace 数据归属。

> **关键结论**
>
> PD 已有可复用的领域服务、共享执行周期、持久化任务和 Durable Lease；缺少的是独立于 UI 与宿主进程的统一后台生命周期所有者。Service Host 补的是“谁负责持续触发并恢复已有工作”，不是重新实现业务管道。

## 1. 背景与问题

用户通过 MCP、CLI、宿主 Hook 或界面创建 Pain 后，PD 可以将诊断任务持久化为 Workspace 级 pending task。但“任务已经持久化”与“后台一定有人继续消费”是两件事。

当前后台执行生命周期分散在不同宿主：

- Codex / WorkBuddy：Companion 创建并监督长运行 CLI Worker。
- OpenClaw：Plugin 在 Gateway 内注册 AutoConsumer Service，并管理每个 Workspace 的 timer chain。
- Web Console：提供查询、审批和请求驱动的手动诊断入口，不是通用后台调度器。
- Shared Host Runtime：统一部分执行逻辑，但不拥有跨宿主的进程启动、周期触发和恢复生命周期。

因此，Companion 退出会停止它管理的 Codex / WorkBuddy Workers；OpenClaw Gateway 退出会停止其进程内 AutoConsumer。浏览器窗口关闭本身不是主要问题，真正的问题是后台生命周期所有权被放在 UI 容器或宿主进程里。

## 2. 设计目标与核心原则

### 2.0 决策状态术语（单一事实来源）

本仓库涉及 Service Host 的授权状态一律使用以下三层，不得混写：

| 层级 | 含义 | 当前状态 |
|---|---|---|
| Architecture Approved | 架构方案经 Owner 批准 | **已达成**：ADR-0020 §11.6（2026-11-19），范围限 PD-owned 用户级 OS scheduler + 有界 `pd service run-once` + 复用现有 Worker Cycle |
| Implementation | 在批准范围内正常开发、评审、测试 | 允许按本 SPEC 推进；架构批准不等于代码已实现，也不免除正常实现评审 |
| Production Cutover | 生产环境生命周期所有权交接 | **未达成**：须逐 Workspace 完成 §8.4 原子交接并通过 §11 Phase 5 验收 Gate |

其他文档引用 Service Host 状态时只能引用本表，不得另造一套授权表述。ADR-0020 §11.1 未被 §11.6 收窄的部分（系统级服务、通用常驻 Daemon、第二套任务系统等 Hold）**仍然有效**，本 SPEC 不删除这些限制。

### 2.1 Service Host 的定义

**PD Service Host 是 PD-owned 的后台执行与生命周期边界**，负责发现已授权 Workspace、触发已有 Worker Cycle、收集运行状态、处理故障并安排下一次执行。

它不等于：
- PD Core 的领域服务或 Runner；
- Companion 桌面应用；
- Web Console HTTP Server；
- OpenClaw Gateway；
- 通用 Agent 任务执行平台。

### 2.2 必须满足的原则

1. **UI 不拥有后台业务生命周期**：关闭浏览器、Console Server 或 Companion，不得停止已启用的后台消费。
2. **宿主不拥有 PD 核心消费生命周期**：关闭 OpenClaw Gateway、Codex 或 WorkBuddy，不得停止已经持久化且具备所需证据的 PD 任务处理。
3. **PD 服务层拥有调度责任**：一个 Workspace 在任一时刻只能有一个权威后台触发者。
4. **业务逻辑复用**：继续使用现有 Core、Host Runtime、Host Adapter、Worker Cycle、Task Store 和 Lease；不复制业务管道。
5. **持久化优先于进程存活**：进程崩溃不丢任务；下一次触发可从持久化状态恢复。
6. **Workspace 隔离**：每个 Workspace 独立读取配置、状态库、证据和授权；一个 Workspace 故障不能阻断其他 Workspace。
7. **Owner 治理边界不变**：Service Host 只能推进已授权的诊断/内化流程，不能批准原则、扩大数据读取授权或代替 Owner 决策。

### 2.3 V1 进程模型：OS 管理的用户级触发 + 有界单次执行

V1 不先建设一个新的常驻通用 Daemon。Service Host 是独立的 PD 服务层，但每次触发执行一个有界的 run-once 进程：

~~~text
用户登录 / OS 周期触发 / 显式唤醒
              │
              ▼
      pd service run-once
              │
       获取单实例运行锁
              │
       读取 PD 安装清单
              │
     逐 Workspace 执行一次
              │
  复用现有 host-specific worker cycle
              │
   写入既有状态 / 结构化运行记录
              │
              ▼
             退出
~~~

这样既能让后台工作独立于 UI 和宿主，又不为了“有一个服务进程”而引入新的常驻循环。若未来确有低于调度周期的实时唤醒、持续 IPC 或自适应常驻调度需求，再以独立 ADR 评估 Resident Service Host；不得在 V1 偷渡通用 Daemon 平台。

## 3. 当前实现事实（源码基线）

| 能力 | 当前实现 | 生命周期所有者 / 限制 |
|---|---|---|
| Pain 异步提交 | submitPainCapability 调用 PainToPrincipleService.recordPain(asyncMode=true)，将 diagnostician pending task 写入当前 Workspace 的 .pd/state.db | 写入不等于执行；提交入口不负责常驻消费 |
| Codex Worker | pd codex worker 支持 --once 与连续模式；执行 runCodexWorkspaceWorkerCycle | Companion 读取安装清单、创建并监督子进程；Companion before-quit 停止 Worker supervision |
| WorkBuddy Worker | pd workbuddy worker 支持 --once 与连续模式；执行 runWorkbuddyWorkspaceWorkerCycle | 当前同样由 Companion 监督 |
| OpenClaw AutoConsumer | Plugin 注册 InternalizationAutoConsumerService；每 Workspace 独立 timer chain；首轮延迟后按队列信号自适应调度 | 生命周期依赖 OpenClaw Gateway；自适应调度状态在 Gateway 进程内存，退出即丢 |
| Companion `pd.worker.drain.v1` IPC | 释放换版时向受监督 Worker 发 drain 信号 | **Companion 私有协议**：仅在连续模式 + `PD_COMPANION_WORKER_IPC=1` + spawn `ipc` stdio 时才注册监听；`--once` 模式不安装 drain 处理 |
| Shared execution | @principles/host-runtime 提供共享 runInternalizationConsumerCycle；Codex / WorkBuddy 有各自的 Workspace Cycle | 执行逻辑已有复用，生命周期仍分散 |
| Durable Task Lease | Runtime State Manager 在 Workspace .pd/state.db 中持久化任务与租约 | 解决任务并发领取/恢复，不负责启动进程或定时唤醒 |
| Web Console | Local HTTP Server 提供 backlog 查询和手动诊断路由；手动路由启动 CLI 子进程，HTTP 202 只表示子进程已启动 | 不负责常驻调度；Console 退出不应成为后台任务的停止条件 |
| Companion | 除 Console 窗口/通知外，当前还监督 Codex / WorkBuddy Workspace Workers | 当前不是纯 UI 壳；退出会停止它所拥有的 Workers |

### 3.1 审计记录：两个 Adapter 并不对称（2026-11-19）

源码审计推翻了「Codex 与 WorkBuddy Worker Cycle 结构相似则行为一致」的隐式假设。下列差异会影响 Service Host 的统一健康状态与 Worker 合同：

| 能力 | Codex Worker | WorkBuddy Worker | OpenClaw Consumer |
| --- | --- | --- | --- |
| 每 Workspace liveness 记录（`.state/*-liveness.json`） | 有（分阶段期限 + `lastCycleDriver`） | **无** | **无** |
| Post-processing 续跑步骤 | 有 | **无** | 不适用 |
| Diagnostician 候选领取 | `@principles/core` 公平轮询领取器 | 本地 `pickDiagnosticianCandidate`（无公平轮询，pending 可饿死 retry_wait） | `runPendingDiagnosticianOnce` |
| Host tool declaration 持久化 | 每 cycle 刷新 `.pd/host-tool-semantics/codex.json` | 每 cycle 刷新 | 每次 Gateway 启动持久化；Gateway 不在线时 worker 读持久化声明 |
| Drain 协议 | 仅 Companion IPC 连续模式 | 仅 Companion IPC 连续模式 | 无（timer chain） |

同时注意：install manifest 只记录 `hosts[]` + 平铺 `workspaces[]`，没有 per-Workspace host binding；且 `workspaces[]` 仅在 install / update / workbuddy-setup 路径写入，OpenClaw 运行时绑定（`mcp-binding.json`）不回写 manifest——安装后新绑定的 OpenClaw Workspace 对 manifest discovery 不可见。

源码入口：
- packages/principles-core/src/runtime/pain-submit-capability.ts
- packages/principles-core/src/runtime/pain-to-principle-service.ts
- packages/pd-companion/src/main/main.ts
- packages/pd-companion/src/lib/workspace-workers.ts
- packages/pd-cli/src/commands/codex-worker.ts
- packages/pd-cli/src/commands/workbuddy-worker.ts
- packages/codex-adapter/src/worker/workspace-worker.ts
- packages/workbuddy-adapter/src/worker/workspace-worker.ts
- packages/openclaw-plugin/src/service/internalization-auto-consumer-service.ts
- packages/host-runtime/src/internalization-consumer-cycle.ts
- packages/pd-console/src/server/routes/diagnostician.ts

## 4. 目标架构

~~~text
┌────────────────────── Interaction Layer ──────────────────────┐
│  PD Companion                 PD Web Console                   │
│  窗口 / 托盘 / 通知            查询 / 审批 / 人工操作             │
│  只读服务状态，不管理 Worker 生命周期                            │
└───────────────────────────┬───────────────────────────────────┘
                            │ status / explicit operator action
                            ▼
┌────────────────────── PD Service Host ────────────────────────┐
│  OS user-level scheduler                                       │
│      └── pd service run-once                                    │
│            ├── 单实例锁与安装清单解析                            │
│            ├── Workspace 授权 / 配置 / release 校验              │
│            ├── Worker Adapter Registry                          │
│            ├── bounded run / timeout / drain                    │
│            ├── recovery / status projection                     │
│            └── structured logs                                  │
└───────────────────────────┬───────────────────────────────────┘
                            │ invokes existing bounded cycles
             ┌──────────────┼───────────────────┐
             ▼              ▼                   ▼
       Codex Worker    WorkBuddy Worker    OpenClaw Worker
             │              │                   │
             └──────────────┼───────────────────┘
                            ▼
┌──────────────── Shared PD Execution Layer ────────────────────┐
│  @principles/core  +  @principles/host-runtime  + Host Adapters │
│  Diagnostician / Internalization / Recovery / Reconciliation   │
└───────────────────────────┬───────────────────────────────────┘
                            ▼
┌────────────────── Existing Workspace Data Plane ──────────────┐
│  <workspace>/.pd/state.db                                      │
│  <workspace>/.state/  + existing authorized trajectory stores  │
│  Existing task ids / leases / artifacts / ledgers / evidence   │
└────────────────────────────────────────────────────────────────┘

Host Integration Layer:
OpenClaw / Codex / WorkBuddy 负责 Hook、MCP、上下文和授权证据接入；
不负责 PD 后台消费的启动、停止与调度。
~~~

## 5. Pain 到后台处理的目标流程

1. 用户或宿主 Agent 通过 MCP / CLI / Hook 创建 Pain。
2. 现有 Core Capability 验证输入、身份、来源与授权。
3. 现有 PainToPrincipleService 将诊断任务持久化到该 Workspace 的 .pd/state.db，状态为 pending；提交回执不宣称诊断已完成。
4. Service Host 的下一次有效触发按 §9.1 的两类授权发现源找到该 Workspace。
5. Service Host 根据已安装的 Host Adapter 选择对应的单次 Worker Cycle。
6. Worker 使用现有候选选择、Diagnostician、Internalization、Recovery 和 Durable Lease 机制推进任务。
7. 任务状态、Run、Artifact、Ledger 和证据仍写入既有 Workspace 数据存储。
8. Companion / Web Console 读取持久化状态并呈现结果；打开 UI 不是处理任务的前置条件。

若某个任务缺少经授权的宿主轨迹或必要证据，Service Host 必须保留其真实等待/降级状态，不得通过扫描宿主私有目录、猜测最近会话或伪造证据来“完成”任务。

## 6. 范围与非目标

### 6.1 V1 范围

- 一个 PD 安装级的后台触发注册；按 §9 定义的两类授权发现源枚举所有已授权 Workspace。
- 用户级 OS 启动与周期触发；在当前登录用户权限和凭据上下文中执行。
- 一个 pd service run-once 入口；每个已启用 Workspace 执行一个有界周期。
- Codex / WorkBuddy 复用现有 --once Worker Cycle。
- OpenClaw 自动消费迁移到 PD-owned Worker Cycle；OpenClaw Plugin 保留宿主接入，不再拥有该消费 timer。
- 单实例触发锁、Workspace 隔离、失败记录、下次周期恢复。
- Companion 与 Console 的状态读取和显式运维入口。

### 6.2 非目标

- 不新增 Pain 表、全局任务队列、第二套 Task Store 或第二套 Lease。
- 不把 PD 变成通用 Agent 执行引擎、云端服务或远程任务平台。
- 不让 Service Host 启动、控制或替代 OpenClaw / Codex / WorkBuddy 本身。
- 不扫描宿主私有会话库，不绕过 sourceRef、Consent、Retention 或 Workspace containment。
- 不自动批准原则、不自动修改 Owner 目标、不绕过 feature flags。
- V1 不建设常驻通用 Daemon、通用 cron 平台或跨用户系统服务。
- 不因 Service Host 的引入改变 Pain / 行为偏差事件的规范语义；数据语义仍以 [行为偏差事件与相对评价规范](../concepts/PD_BEHAVIOR_DEVIATION_EVENT_AND_RELATIVE_EVALUATION.md) 为准。

## 7. 功能与架构要求

| ID | 要求 | 验收含义 |
|---|---|---|
| FR-01 | UI 生命周期隔离 | 关闭浏览器、Console Server 或 Companion 后，已启用的后台触发仍有效 |
| FR-02 | Host 生命周期隔离 | OpenClaw Gateway / Codex / WorkBuddy 退出后，Service Host 仍能处理已有且证据完整的任务 |
| FR-03 | Durable intake | Service Host 未运行时，Pain 仍按现有契约持久化；任务不因没有消费者而丢失 |
| FR-04 | Single lifecycle owner | 每个 Workspace 只有一个自动触发所有者；迁移期间禁止双重调度 |
| FR-05 | Authorized workspace discovery | 只从 §9 定义的两类授权发现源枚举 Workspace（canonical install manifest + 经校验的 per-host 绑定证据），不从 cwd、任意 MCP 参数或目录扫描推断；Host Binding（一个 Workspace 可接入多个 Host）与 `backgroundExecutions` 所有权记录（每个 Workspace 任一时刻唯一后台生命周期所有者，§8.4）是两个不同权威，不得混用（§8.4、§9） |
| FR-06 | Existing worker reuse | 使用现有 Worker Cycle、RuntimeStateManager、Lease、Recovery 和 Read Model |
| FR-07 | Workspace fault isolation | 一个 Workspace 配置损坏、凭据缺失或 Worker 崩溃，不阻断其他 Workspace |
| FR-08 | Process singleton | 同一用户安装的重叠触发必须被单实例锁收敛；锁失效不能误删有效运行 |
| FR-09 | Recovery | 进程崩溃后，下一次触发从 pending / retry_wait / expired lease 等持久化状态恢复 |
| FR-10 | Truthful health | 不能仅凭任务注册、PID 或心跳宣称健康；必须有真实周期完成与任务进展证据 |
| FR-11 | Owner pause and flags | Workspace feature flag、Diagnostician capability、Owner pause 仍是执行权威；关闭时保留任务并明确显示 paused |
| FR-12 | Safe shutdown | 停止新 Workspace 周期，向当前 Worker 请求 drain；超时才终止，后续由既有 Lease Recovery 恢复 |
| FR-13 | User-level security | 不需要管理员权限；不把凭据写入计划任务参数；进程只操作被授权 Workspace |
| FR-14 | UI observability | Companion / Console 可读取服务注册、最近周期、Workspace 状态、积压和降级原因 |
| FR-15 | Manual fallback | Service Host 不可用时，既有 pd diagnose run / Worker --once 手动路径仍可用 |

## 8. 生命周期契约

### 8.1 安装级生命周期

~~~text
uninstalled
   │ pd service install
   ▼
installed_disabled
   │ Owner / installer enables
   ▼
enabled
   │ OS login / scheduled trigger
   ▼
running ───────────────► completed ───► enabled
   │                         │
   ├── partial failure ──────┘
   ▼
degraded ── next valid trigger / repair ──► running

enabled / degraded ── pd service disable ──► disabled
installed_* ── pd service uninstall ───────► uninstalled
~~~

- disable 只停止未来自动触发，不删除 Workspace 数据和 pending task。
- uninstall 只撤销 Service Host 的 OS 注册和自身运行元数据；不删除 .pd/state.db、Ledger、Trajectory 或用户证据。
- status 区分“已安装”“已启用”“最近一次周期完成”“某 Workspace 有真实进展”。
- 手动 run-once 受相同授权、feature flag、Lease 和 Workspace 隔离约束。

### 8.2 单次执行生命周期

1. 校验用户级运行环境和 active release。
2. 获取安装级单实例锁；若已有有效运行，返回 already_running，不并行启动第二份。
3. 读取并验证 canonical install manifest；读取失败不得被解释为“零 Workspace”。
4. 对每个 Workspace 校验路径、配置、Host Adapter、feature flags 和运行权限。
5. 启动一个有界 Worker Cycle；一个 Workspace 的失败记录为局部失败，继续处理其他 Workspace。
6. 读取真实执行结果、任务状态和 liveness；记录 structured status。
7. 释放子进程、数据库句柄和单实例锁后退出。

### 8.3 Workspace 状态

至少区分：ready、running、paused、waiting_for_evidence、degraded、unavailable、completed。不能把“安装清单有登记”或“进程已启动”映射成 healthy。

### 8.4 Workspace 级后台生命周期所有权状态机

每个 Workspace 在任一时刻只能有一个自动后台生命周期所有者。所有权以**持久化、可验证的 owner marker** 为唯一权威：进程是否存活、启动顺序、固定延迟都不是所有权证明。原子交接只发生在 §11 Phase 4 / Phase 5；**Phase 2 只做 shadow 驱动（marker 保持 `legacy`，旧所有者仍是唯一自动生命周期所有者，不停止 Companion Worker supervision / OpenClaw AutoConsumer）**（Gate 0 决策，Owner 2026-11-21，PRI-1280）。

~~~text
LEGACY_OWNED
   │ 进入交接：记录交接意图；旧所有者仍为唯一合法消费者
   ▼
HANDOVER_PREPARING ── 交接中止 / 新所有者就绪验证失败 ──► LEGACY_OWNED
   │ ① 新所有者完成「不消费」就绪验证 → ② 旧所有者停止该 Workspace 消费注册
   │ ③ 验证已停止 → ④ CAS 写入 owner marker（generation+1，effectiveOwner=service_host）
   ▼
SERVICE_HOST_OWNED
   │ 回滚请求 / Service Host 失效不可恢复
   ▼
ROLLBACK_PENDING
   │ ① 新所有者触发已停止且验证 → ② CAS 写回 legacy → ③ 旧所有者重新注册并验证恢复
   ▼
LEGACY_OWNED
~~~

交接顺序（不可颠倒）：创建 `HANDOVER_PREPARING` 记录 → Service Host 以**不消费**模式完成就绪自检 → 验证就绪 → 旧所有者停止消费注册 → 验证已停止 → 单次 CAS 写 marker → 才授予 Service Host 执行权 → 写交接完成证据。即：就绪验证必须在旧所有者停止**之前**，marker 翻转必须在旧所有者停止**之后**；反之会产生双消费者或无所有者窗口中被遗漏的消费。

契约：

1. **权威位置与持久化事实**：owner marker 已固化为 install manifest 的按 Workspace 键控字段 `backgroundExecutions`（`@principles/install-layout`，canonical absolute workspaceDir → `BackgroundExecutionRecord`，schema 与 fail-closed 解析已落地）：`{state, effectiveOwner, generation, operationId, previousOwner, targetOwner, updatedAt}`。两值枚举（`legacy|service_host`）不足以表达在途迁移，故记录完整状态机事实；每个 Workspace 独立迁移互不覆盖，某 Workspace 无记录视为 `legacy_owned`。旧版单条 `backgroundExecution` 仅在 manifest 恰有一个 Workspace（身份唯一可确认）时迁移，歧义即 fail-closed，不猜归属。
2. **CAS / 单调代次**：每次状态迁移都必须对 manifest 做一次原子写（原子 rename），`generation` 严格 +1；写者先读后写，observed generation 过期即失去写入资格。`operationId` 为交接/回滚操作的幂等键——重放同一 operationId 必须是 no-op。
3. **HANDOVER_PREPARING 不授予任何新权利**：`effectiveOwner` 保持 `legacy`，旧所有者仍是唯一消费者；该状态只记录“正在交接”意图与所需证据。
4. **无双消费者**：marker 的 `effectiveOwner` 翻转为 `service_host` 之前，旧所有者必须已被验证停止该 Workspace 的消费注册（Companion 停止监督、Gateway 不再调度 timer）。停止与翻转之间存在无消费者窗口是安全的——任务持久化在 `.pd/state.db`；绝不允许双所有者并行。
5. **旧所有者检测（Supervisor 门禁已实现，2026-11-20）**：Companion Supervisor 在每次 manifest 同步时读取 `backgroundExecutions` 并构造按 Workspace 的阻塞集——`handover_preparing` / `rollback_pending` / `service_host_owned` 一律禁止旧 Worker 启动与崩溃重启（`WorkspaceWorkerRegistry`，spawn/restart 两入口均校验，manifest 读失败时阻塞集保持不清空——不可判定 ≠ 已清除）；已运行的 Worker 按 quiesce/drain/stop 协议停止（`pd.worker.drain.v1` + 超时 kill 兜底，entry 移除故进程重启不复活）；只有恢复到稳定 `legacy_owned`（或记录移除）才重新允许启动。**`effectiveOwner=legacy` 不等于可启动**——`handover_preparing` 期间 effectiveOwner 仍为 legacy 但旧 Worker 被冻结。**重启竞态修复（2026-11-20，含回归测试）**：阻塞同步时对无运行子进程的 entry 同时退役（`stopped=true` + 清空 drain/restart 两个挂起句柄），且 `spawnFor` 在最终拉起点三重再校验（`entry.stopped`、阻塞集、`entries.get(canonical) === entry` 身份）——已武装的崩溃重启定时器在过渡开始时取消，任何迟到/伪造的定时器回调都无法复活旧 Worker。OpenClaw Gateway 在 AutoConsumer 注册与 timer tick 前读取 marker，非 legacy 时不得为该 Workspace 调度（**已实现，2026-11-22，PRI-1282 Phase 4**：service-start 与每 tick 门禁 + post-cycle 复查 + quiesce 持久化确认 `pd.gateway-quiesce.v1`（绑定 operationId+generation，含 in-flight 有界等待与诚实 `in_flight_timeout`）+ 停摆槽位慢速 ownership watch——rollback 后无需重启 Gateway 即恢复消费）。
6. **崩溃中迁移（确定性恢复）**：进程在 PREPARING / ROLLBACK_PENDING 中途崩溃 → 下次运行依据持久化 `state` + `operationId` 确定性续跑或放弃：PREPARING 则按 `effectiveOwner=legacy` 继续并重新发起或中止交接；ROLLBACK_PENDING 则继续完成回滚序列；`SERVICE_HOST_OWNED`/`LEGACY_OWNED` 稳定态由现有持久化状态恢复。
7. **marker 写入失败**：不得部分生效；保留先前所有者与 generation，记录 degraded reason。
8. **回滚顺序**：停止该 Workspace 的 Service Host 触发 → 验证已停止 → CAS 写回 `legacy`（generation+1）→ 旧所有者重新注册消费 → 验证恢复。回滚期间同样禁止双执行。
9. **两层锁不混淆**：安装级 run-once 单实例锁防重复调度进程；Durable Lease 防同一任务被重复领取。owner marker 决定“谁有资格调度”，不替代任何一层锁。
10. **实现状态**：`backgroundExecutions` **schema 已落地**（manifest 解析 fail-closed：按 Workspace 键控 + 状态语义校验——非法的 state/effectiveOwner/previousOwner/targetOwner/operationId/generation 组合拒绝解析）；**Companion Supervisor 过渡态门禁已落地**（上述第 5 条，含回归测试）；**状态机迁移原语已落地（2026-11-22，PRI-1282 Phase 4，阶段归属修正）**——`@principles/install-layout` `transitionWorkspaceBackgroundExecution`：六类合法迁移（begin/abort/complete_handover、begin/complete/abort_rollback）、跨进程目录锁（O_EXCL + owner 元数据 + TTL 隔离回收）、锁内 generation fencing、operationId 幂等（同 op 重放 no-op / 异 op 拒绝 `operation_in_progress`）、原子 rename 落盘、未知顶层字段保留、legacy 单键同写迁移；`readWorkspaceBackgroundOwnership` 为 Gateway 门禁 / worker 门禁 / handover 命令共用的唯一只读投影；install.json 全量写者（installer / update 侧）已统一经同一物理锁（ERR-168）。Phase 5 **复用**该原语完成 Codex / WorkBuddy 交接，不得重复实现。

## 9. 数据、并发与恢复

- 业务任务的唯一持久权威仍是每个 Workspace 的 .pd/state.db；Pain 与诊断任务仍使用既有确定性 ID / input_ref 关系。
- Durable Lease 仍由现有 Runtime State Manager 管理；Service Host 不自造 task lease、queue 或任务状态机。
- 触发是 **at-least-once**：OS 可以重复触发，Worker 可以在崩溃后重跑；同一任务的并发执行由既有 Lease 收敛，后处理继续依赖现有幂等契约。不得宣传端到端 exactly-once。
- Service Host 的安装级运行锁只防止重复调度进程，不替代每个 task 的 Durable Lease。
- 一个 Worker 被终止后，未完成任务保持可恢复状态；Lease 到期后由现有 Recovery Sweep / 后续 Worker 周期接续。
- 运行状态优先复用现有 per-Workspace liveness、SystemLogger、Run 和 Task Read Model。若缺少安装级最近触发记录，可增加小型版本化 operational status 文件；它不得承载任务、Pain 或证据数据。

### 9.1 Workspace 发现与 Host Binding 权威

授权发现源只有两类，缺一不可相互推断：

| 发现源 | 权威内容 | 当前状态 |
|---|---|---|
| canonical install manifest（`workspaces[]` + `backgroundExecutions` 按 Workspace 所有权记录） | 安装期/绑定期登记的 Workspace 列表与各 Workspace 的后台执行所有权 | **部分存在**：`workspaces[]` 与 `backgroundExecutions` schema 均已落地（per-Workspace 独立所有权）；仍无 per-Workspace host binding 字段——Host 关联由第二类来源承担 |
| 经验证的 per-host 绑定证据（`collectHostWorkspaceClaims`：`default` / `host_declaration` / `payload_binding` 三类 claim） | 每个 Host 对每个 Workspace 的接入授权证明 | **已存在且本轮补齐**：Collector 现在同样读取 OpenClaw 自身持久化的 `<openclawHome>/extensions/principles-disciple/mcp-binding.json`（P0-1），只有经 `validateMcpBinding` 全量校验（host/schemaVersion/workspaceDir/runtimeDir/canonical serverEntry）的 binding 才形成 claim；launcher.cjs 与 `pd health` 已同步同一规则并有真实子进程 parity 测试 |

契约：

1. **注册**：bind 时把 Workspace 与 host 关联原子写入权威存储（manifest 单次原子写；或权威 claim 文件的单次原子写），不得拆成两个非原子写。
2. **解绑**：移除 host binding；Workspace 条目仅在无剩余 host binding 且无残留业务状态需求时移除。
3. **升级**：manifest 写路径必须保留未知顶层字段（向前兼容）；`parseInstallManifest` 已容忍未知可选字段，写入必须使用 `installManifestHostsForPersist`/`mergeInstallManifestWorkspaces` 的合并语义，不得重建式覆盖丢失绑定。
4. **卸载**：manifest 生命周期归安装器；Workspace 业务数据与绑定证据不被 Service Host 卸载删除。
5. **多 Host 同 Workspace**：允许；每个 host 的 claim 独立验证，`findForeignWorkspaceOwner` 语义处理跨宿主归属冲突，歧义拒绝绑定。
6. **Workspace 缺失/失效/路径变更**：运行时按 canonical path + realpath 身份 + `.pd/` 存在性校验；缺失→该 Workspace 记 unavailable/degraded，绝不推断替代目录；路径移动→视为新绑定，需重新登记。
7. **并发与幂等**：发现期读取每次都重新 canonicalize；写路径 read-modify-write 使用集合合并语义 + 原子 rename；重复注册幂等。
8. **未授权 fail-closed**：不在任一授权源的 Workspace 永不执行；绑定证据不可读→记 degraded，不得假设“无绑定”。
9. **不是授权凭据**：`internalization_auto_consumer` 等 feature flag 是执行启停开关，不是 Host 身份，也不是 Workspace 绑定或自动上报授权。

## 10. 安全与配置

1. Scheduler 以当前操作系统用户身份运行；V1 不安装系统级 Windows Service、LaunchDaemon 或 root systemd unit。
2. Windows 使用当前用户级 Task Scheduler；macOS 使用 LaunchAgent；Linux 使用 systemd --user timer。登录会话之外是否运行由平台支持矩阵明确声明，不隐式开启系统级权限。**审计记录（2026-11-19）**：三平台 V1 的统一真实保证只是「用户已登录会话期间可触发」——macOS LaunchAgent 只在交互式登录会话内存在，登录前/注销后不触发；Windows 不存凭据即仅登录时运行；Linux user timer 注销后运行需 `loginctl enable-linger`（V1 不默认开启）。重启后首次登录前与用户注销期间的行为是平台差异，不得写成统一支持。
3. 不在任务参数或命令行中传递 API Key / Token；复用现有安全凭据解析路径。
4. 每次 Worker 启动都显式绑定目标 Workspace，清理会影响 Workspace 解析的继承环境变量；不得让父进程的 workspace 指针覆盖 manifest 中的目标。Coordinator 与 Worker 子进程的环境隔离契约分层定义，见技术设计 §5.2；`PD_EXPERIMENT_ROOT` 等实验变量不得被生产运行的 coordinator 继承。
5. Workspace path 必须经过 canonicalization、manifest authorization 和 containment 校验；禁止按当前 cwd 或自由文本重定向数据归属。
6. 宿主轨迹读取继续服从来源身份、Consent、Retention、撤回和 sourceRef 规则。
7. Service Host 不能修改或绕过 host.codex、host.workbuddy、internalization_auto_consumer、Diagnostician capability 等既有开关。

## 11. 迁移策略与实施 Gate

### 治理状态（替代旧“必须先完成的治理 Gate”）

ADR-0020 §11.6 dated amendment（2026-11-19）已记录 Owner 对本 SPEC 窄范围架构的批准：PD-owned 用户级 OS scheduler + 有界 `pd service run-once` coordinator + 复用现有 Worker Cycle 作为统一后台生命周期所有者。因此不再存在“实现前须先过 §11.1 Owner Gate”这一前置；但 §11.6 是**架构批准而非实现完成或生产交接授权**：

- 范围外的 Hold 仍有效：不授权通用常驻 Daemon、系统级服务、第二套任务系统/队列/Pain 管道。
- 实现按正常开发评审流程进行；每个 Phase 有自己的进入依赖、验收条件与退出条件。
- Production Cutover 是独立 Gate（§2.0）：必须逐 Workspace 完成 §8.4 原子交接并通过 Phase 5 验收，在此之前现有 Companion / OpenClaw 生命周期仍是生产所有者。

### Phase 1 — 最小 Service Host（coordinator 骨架）

- **目标**：可运行的 `pd service run-once` coordinator，不接管任何生产 Workspace。
- **修改模块**：无（新增为主）。
- **复用模块**：install manifest 读取、`collectHostWorkspaceClaims`、`.pd/config.yaml` host flag、Durable Lease/Recovery（仅观察不调度）、SystemLogger、Task Read Model。
- **新增模块**：run-once coordinator、安装级单实例锁、小型版本化 operational status 文件、环境隔离层（技术设计 §5.2）。
- **依赖条件**：ADR-0020 §11.6（已达成）；manifest `workspaces[]` + claim 发现源契约（§9.1）落地。
- **风险**：误将 dry-run 状态当真实消费；manifest 读取失败被解释为“零 Workspace”。
- **验收条件**：`run-once --dry-run` 输出真实发现结果与逐 Workspace 判定；无写业务数据；单实例锁行为正确。
- **退出条件**：dry-run 在真实安装上可重复通过，且未改变任何 Workspace 消费所有权。

#### Phase 1 准入边界（硬约束）

**Phase 1 可以做**：读取真实 Install Manifest；读取经验证的 Host Workspace Claims（manifest + per-host 绑定证据双源）；多 Workspace 独立发现；输出逐 Workspace 发现结果、owner 状态与发现依据；执行 dry-run；生成只读 operational status；安装级单实例锁。

**Phase 1 不可以做**：接管生产 Workspace；启动真实 Worker 消费；修改现有消费者所有权；注册 OS Scheduler；关闭 Companion Worker；关闭 OpenClaw AutoConsumer；任何生产 Cutover。

**Phase 1 dry-run 必须证明**：

1. 所有发现的 Workspace 均有明确授权来源（manifest 或验证过的 claim），未授权目录不会被纳入；
2. manifest 读取失败不会被解释成"零 Workspace"（malformed ≠ empty）；
3. 同一 Workspace（canonical path 归一后）不会被重复枚举；
4. 多 Workspace 的 owner 状态（`backgroundExecutions`）互相独立、不覆盖；
5. 不写任何业务数据，不改变任何生产消费者。


### Phase 2 — Codex / WorkBuddy 接入

- **目标**：run-once 可对 Codex / WorkBuddy Workspace 驱动一个真实有界周期。
- **修改模块**：codex-adapter / workbuddy-adapter（仅补齐 Worker Adapter Contract 缺口，见技术设计 §2.3）。
- **复用模块**：现有 `--once` Worker Cycle、候选选择、Diagnostician、Internalization、Recovery、Durable Lease。
- **新增模块**：Service Host → Worker 的显式 workspaceDir 绑定与环境清理调用路径；`PD_INVOCATION_SOURCE=service_host`（或等价标识）。
- **依赖条件**：Phase 1 退出条件；WorkBuddy 补齐真实 liveness 证据（§3.1）；WorkBuddy `retry_wait` 公平性差距记录为独立后续项（不阻塞本 Phase，但阻塞 WorkBuddy parity 验收）。
- **风险**：父进程环境污染（`PD_EXPERIMENT_ROOT`/`PD_WORKSPACE_DIR` 等）重定向生产 Workspace；WorkBuddy 无 liveness 导致健康判断失真。
- **验收条件**：技术设计 §2.3 契约字段齐全；子进程环境按白名单构造；任务真实推进且状态可观测。
- **退出条件**：在 shadow 模式下对真实 Workspace 完成 ≥1 个真实周期且可回滚；旧所有者仍唯一。

#### Phase 2 准入边界（硬约束，Gate 0 决策 Owner 2026-11-21）

**Phase 2 可以做**：显式、手动、有界的 shadow Cycle（默认关闭，必须显式选择 shadow 模式并显式指定已授权 Workspace）；通过统一 Worker Adapter 合同调用现有 `pd <host> worker --once`；按白名单构造 Worker 子进程环境；为 WorkBuddy 补齐周期级 liveness；记录真实 `lastProgressAt`；扩展 operational status。

**Phase 2 不可以做**：注册 OS Scheduler（Phase 3）；修改 owner marker / 进入 §8.4 交接状态机（Phase 4/5）；停止 Companion Worker supervision；停止 OpenClaw AutoConsumer；Production Cutover；接入 OpenClaw Adapter（Phase 4）。

**Phase 2 shadow 语义**：shadow 调用真实 Worker Cycle，可能推进现有业务任务——它不是零副作用 dry-run；`--dry-run` 保持 Phase 1 只读行为，两者语义严格区分。与旧消费者并发时的正确性由既有 Durable Lease / fencing 收敛（同任务不重复领取）；若无法证明并发安全，不得对该真实 Workspace 执行 shadow。

### Phase 3 — 用户级 OS Scheduler 注册

- **目标**：OS 层定时触发 run-once；UI 解耦。
- **修改模块**：installer（注册/撤销用户级 trigger）、Companion/Console（只读 Service Host 状态）。
- **复用模块**：Phase 1–2 全部；现有凭据解析路径。
- **新增模块**：`pd service install|enable|disable|status|uninstall` 用户级命令面。
- **依赖条件**：Phase 2 退出条件；平台差异如实声明（§10.2 审计记录）。
- **风险**：跨用户/系统级误注册；凭据进入计划任务参数。
- **验收条件**：§10 全部条款；AC-08 重叠触发收敛。
- **退出条件**：登录周期触发在真实安装上稳定 ≥ 约定观察窗；禁用/卸载可逆。
- **实施状态（2026-11-22，PRI-1281）**：已实施——三平台 Scheduler Adapter（Windows Task Scheduler / macOS LaunchAgent / Linux systemd --user，统一 install/enable/disable/status/uninstall 契约）、managed 执行入口（裸 `pd service run-once --json` 按 §8.4 只消费 `effectiveOwner=service_host`）、统一只读状态契约 `pd.service-status.v1`、installer 桥接（显式同意注册 / 升级 refresh-if-registered / 卸载撤销）、Console 只读 `GET /api/service-host/status`。Windows 完成真实 Task Scheduler 生命周期验收（真实注册/启用/真实 OS 启动/禁用/卸载/幂等/零遗留；含权限拒绝不伪装未安装的真实验证——验收主机策略拒绝非提升注册，全生命周期经提升 PowerShell 桥执行并在测试中如实披露）。macOS / Linux 为伪造命令边界下的单元测试，真实平台验收 **NOT_VERIFIED**（运维矩阵与命令文档见 `docs/runbooks/PD_SERVICE_HOST_SCHEDULER.md`；真实安装验收报告见 `docs/reports/PD_SERVICE_HOST_PHASE3_ACCEPTANCE_20261122.md`）。

### Phase 4 — OpenClaw 解耦接入

- **目标**：OpenClaw Workspace 由 PD-owned Worker Cycle 驱动；OpenClaw Plugin 不再拥有消费 timer。
- **修改模块**：openclaw-plugin（拆出可复用能力；写回 manifest 绑定路径）；host-runtime 共享消费周期。
- **复用模块**：现有 AutoConsumer 业务周期逻辑、Trajectory registry、Tool Catalog/Semantics。
- **新增模块**：`pd openclaw worker --once`；OpenClaw → manifest/workspaceBindings 绑定写路径；adaptive 调度状态持久化方案或固定周期回退记录。
- **依赖条件**：Phase 3 退出条件；§9.1 第二类发现源或 manifest 写回落地。
- **风险**：双消费者并行（§8.4 禁止）；adaptive 调度状态丢失。
- **验收条件**：每个 Workspace 按 §8.4 完成交接；无双消费者证据。
- **退出条件**：OpenClaw Workspace 由 Service Host 独占驱动且可回滚。
- **实施状态（2026-11-22，PRI-1282）**：已实施——`principles-disciple/openclaw-worker` 子路径导出（有界 worker cycle + no-consume readiness + liveness + §8.4 所有权门禁；工具目录/语义/事件流与 Gateway 同一 SSoT，运行时 parity 测试钉住）；Gateway AutoConsumer marker 门禁 + quiesce 确认（§8.4 第 5 条更新）；`pd openclaw worker --once|--readiness` CLI（lazy 子路径导入，无常驻模式）；`pd service handover|rollback` §8.4/回滚编排（readiness→ack→单次 CAS→首周期→write-once 证据）；managed 派发集扩展 openclaw 而 shadow 保持 codex|workbuddy；**不实现 manifest workspaceBindings**（Host Binding 权威维持既有双源：manifest + `collectHostWorkspaceClaims`，交接时经既有注册路径原子并入 `workspaces[]`）；adaptive timer 决策=固定周期回退（量化对比与语义变化记录见 `docs/reports/PD_SERVICE_HOST_PHASE4_SCHEDULING_COMPARISON.md`）。平台门禁继承 Phase 3：无对应平台真实 Scheduler 触发证据前不做生产 marker 翻转；隔离环境 handover/回滚与代码级验证已完成。

### Phase 5 — 生产生命周期交接与旧所有权退役

- **目标**：Production Cutover（§2.0）：旧所有者退役，Service Host 成为唯一生产所有者。
- **修改模块**：Companion（停止 Worker supervision）、OpenClaw Plugin（停用 AutoConsumer timer）、installer/文档。
- **复用模块**：§8.4 owner marker 与交接协议。
- **新增模块**：owner marker 字段与原子读写路径（若 Phase 1–4 未提前落地）。
- **依赖条件**：Phase 1–4 全部退出条件；真实安装验收覆盖 UI 关闭、Companion/Gateway 退出、机器重启、Worker 崩溃、升级、禁用、卸载。
- **风险**：迁移中断双执行；旧所有者未完全退役。
- **验收条件**：AC-01～AC-13 全数通过；每个 Workspace marker 历史可审计。
- **退出条件**：旧生命周期代码路径移除或显式降级为 manual fallback（FR-15），且回滚路径验证通过。

## 12. 验收标准

| ID | 场景 | 通过条件 |
|---|---|---|
| AC-01 | 无 UI、无宿主 Gateway | 用户登录后，不打开 Companion / Console / OpenClaw Gateway；已有可处理 pending task 仍能被 Service Host 周期推进 |
| AC-02 | Pain 提交 | MCP 创建 Pain 后只报告已持久化 / pending；下一次后台周期真实领取并产生任务状态变化 |
| AC-03 | Companion 生命周期 | 退出、升级或重启 Companion 不停止、不重复启动后台触发者 |
| AC-04 | Console 生命周期 | Console Server / 浏览器退出不停止后台周期；手动路由 202 不被误判为诊断完成 |
| AC-05 | Host 生命周期 | OpenClaw Gateway 关闭后，已持久化且证据足够的 OpenClaw 相关任务仍可由 PD Worker 处理 |
| AC-06 | 进程恢复 | 强制结束单次 Worker；下一次触发能从既有 task / lease 状态恢复，不丢任务、不重复写入候选 |
| AC-07 | 多 Workspace 隔离 | 一个 Workspace 配置损坏或不可访问时，另一个 Workspace 仍能完成周期 |
| AC-08 | 重叠触发 | 同一安装同时收到两个 OS trigger，只允许一个 run-once coordinator；task lease 仍防止重复领取 |
| AC-09 | Owner pause | 自动执行关闭时保留 pending task，状态清晰显示 paused，不偷偷执行 |
| AC-10 | 卸载 / 回滚 | 撤销 OS trigger 不删除 Workspace 业务数据；可恢复到唯一的旧生命周期所有者 |
| AC-11 | 凭据与路径 | 命令参数无秘密；每个子进程显式绑定目标 Workspace；继承环境不能重定向 Workspace |
| AC-12 | 真实健康 | PID、注册记录或心跳不能单独证明健康；必须能观察到实际周期完成和业务进展 |
| AC-13 | 所有权交接 | 每个 Workspace 的 LEGACY_OWNED→SERVICE_HOST_OWNED 切换经 owner marker 原子完成；迁移中途崩溃不产生双消费者；回滚可恢复到唯一旧所有者 |

## 13. 文档权威与关联

- 本文件：Service Host 的架构与行为要求。
- [技术设计](./SPEC-PD-SERVICE-HOST-001-TECHNICAL-DESIGN.md)：包边界、执行流程、平台调度与迁移实现方案。
- [PD 架构总览](../architecture/PD_ARCHITECTURE_OVERVIEW.md)：全局架构入口；区分当前实现与目标架构。
- [ADR-0020](../adr/0020-codex-cli-host-adapter.md) §11.6：Owner 批准的架构决策（权威）；§11.1 未被收窄的限制仍有效。
- [Feedback Resilience SPEC](./SPEC-PD-FEEDBACK-RESILIENCE-001.md) 与 [技术设计](./SPEC-PD-FEEDBACK-RESILIENCE-001-TECHNICAL-DESIGN.md)：Pain 可靠接收、补证与后台恢复的具体业务要求。
- [Pain Ingress SPEC](./SPEC-PD-AGENT-PAIN-INGRESS-001.md)：Pain 持久化和诊断任务入口契约。
