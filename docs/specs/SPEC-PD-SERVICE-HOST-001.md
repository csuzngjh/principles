# SPEC-PD-SERVICE-HOST-001 — PD 独立服务宿主架构规范

- **版本**：v0.2
- **日期**：2026-11-19
- **状态**：Proposed / Owner decision required（架构提案；不授权实现）
- **v0.2 源码审计修订**：按 2026-11-19 最新源码事实审计修正；§3 表格维持「当前事实」，新增 §3.1 记录两个 Adapter 的真实差异与被推翻的隐式假设。
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
4. Service Host 的下一次有效触发读取安装清单，找到该 Workspace。
5. Service Host 根据已安装的 Host Adapter 选择对应的单次 Worker Cycle。
6. Worker 使用现有候选选择、Diagnostician、Internalization、Recovery 和 Durable Lease 机制推进任务。
7. 任务状态、Run、Artifact、Ledger 和证据仍写入既有 Workspace 数据存储。
8. Companion / Web Console 读取持久化状态并呈现结果；打开 UI 不是处理任务的前置条件。

若某个任务缺少经授权的宿主轨迹或必要证据，Service Host 必须保留其真实等待/降级状态，不得通过扫描宿主私有目录、猜测最近会话或伪造证据来“完成”任务。

## 6. 范围与非目标

### 6.1 V1 范围

- 一个 PD 安装级的后台触发注册；从现有 canonical install manifest 枚举所有已授权 Workspace。
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
| FR-05 | Authorized workspace discovery | 只从 canonical PD install manifest 读取，不从 cwd、任意 MCP 参数或目录扫描推断 Workspace；manifest 无 per-Workspace host binding，Adapter 选择须再读 `.pd/config.yaml` host flag 与持久化 declaration；OpenClaw 运行时绑定不回写 manifest，发现完整性需补写路径或第二授权源（见 §3.1 / §11 Phase 2） |
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

## 9. 数据、并发与恢复

- 业务任务的唯一持久权威仍是每个 Workspace 的 .pd/state.db；Pain 与诊断任务仍使用既有确定性 ID / input_ref 关系。
- Durable Lease 仍由现有 Runtime State Manager 管理；Service Host 不自造 task lease、queue 或任务状态机。
- 触发是 **at-least-once**：OS 可以重复触发，Worker 可以在崩溃后重跑；同一任务的并发执行由既有 Lease 收敛，后处理继续依赖现有幂等契约。不得宣传端到端 exactly-once。
- Service Host 的安装级运行锁只防止重复调度进程，不替代每个 task 的 Durable Lease。
- 一个 Worker 被终止后，未完成任务保持可恢复状态；Lease 到期后由现有 Recovery Sweep / 后续 Worker 周期接续。
- 运行状态优先复用现有 per-Workspace liveness、SystemLogger、Run 和 Task Read Model。若缺少安装级最近触发记录，可增加小型版本化 operational status 文件；它不得承载任务、Pain 或证据数据。

## 10. 安全与配置

1. Scheduler 以当前操作系统用户身份运行；V1 不安装系统级 Windows Service、LaunchDaemon 或 root systemd unit。
2. Windows 使用当前用户级 Task Scheduler；macOS 使用 LaunchAgent；Linux 使用 systemd --user timer。登录会话之外是否运行由平台支持矩阵明确声明，不隐式开启系统级权限。**审计记录（2026-11-19）**：三平台 V1 的统一真实保证只是「用户已登录会话期间可触发」——macOS LaunchAgent 只在交互式登录会话内存在，登录前/注销后不触发；Windows 不存凭据即仅登录时运行；Linux user timer 注销后运行需 `loginctl enable-linger`（V1 不默认开启）。重启后首次登录前与用户注销期间的行为是平台差异，不得写成统一支持。
3. 不在任务参数或命令行中传递 API Key / Token；复用现有安全凭据解析路径。
4. 每次 Worker 启动都显式绑定目标 Workspace，清理会影响 Workspace 解析的继承环境变量；不得让父进程的 workspace 指针覆盖 manifest 中的目标。
5. Workspace path 必须经过 canonicalization、manifest authorization 和 containment 校验；禁止按当前 cwd 或自由文本重定向数据归属。
6. 宿主轨迹读取继续服从来源身份、Consent、Retention、撤回和 sourceRef 规则。
7. Service Host 不能修改或绕过 host.codex、host.workbuddy、internalization_auto_consumer、Diagnostician capability 等既有开关。

## 11. 迁移策略与实施 Gate

### Phase 0 — 文档与 Owner 决策（本 PR）

- 建立本 SPEC 与配套技术设计。
- 同步 ADR、Feedback Resilience、Pain Ingress、Companion README 和架构入口。
- **不修改运行时代码、不启用 OS scheduler、不改变现有 Worker 所有权。**

### Phase 1 — Service Host 最小执行器

- 建立独立的 run-once coordinator、安装清单读取、单实例锁和状态投影。
- 先复用 Codex / WorkBuddy 现有 --once 路径。
- 使用 quiet/default-off rollout gate；未启用时旧路径保持唯一所有者。

### Phase 2 — OpenClaw 生命周期迁移

- 将 OpenClaw Tool Catalog、Tool Semantics、Behavior Evidence Provider 等可复用能力从 Plugin 生命周期中拆出。
- 提供 pd openclaw worker --once，复用 @principles/host-runtime 的共享消费周期。
- OpenClaw Workspace 绑定路径同步写入 install manifest `workspaces[]`（或实现等价的第二授权发现源），否则安装后绑定的 Workspace 对 FR-05 discovery 不可见。
- 确认 Service Host 接管后，再停用 Gateway 内的 AutoConsumer timer；不允许双消费者长期并行。
- Adaptive 调度取舍：`nextConsumerDelay` 的输入是 Gateway 进程内 Map 状态；run-once 模型下要么把调度状态持久化进小型版本化 status 文件，要么接受固定周期带来的队列延迟回退并如实记录。

### Phase 3 — 安装与 UI 解耦

- Installer 注册/撤销用户级 OS trigger。
- Companion 只读取 Service Host 状态并提供操作入口；退出不停止后台执行。
- Console 只提供观察、审批和显式操作；HTTP Server 不成为后台服务父进程。

### Phase 4 — 生产验收与旧所有权退役

- 在真实安装候选上覆盖 UI 关闭、Companion 退出、Gateway 退出、机器重启、Worker 崩溃、升级、禁用和卸载。
- 只有全部 Gate 通过后，才移除旧 Companion Worker supervision 和 OpenClaw in-Gateway consumer lifecycle。

### 必须先完成的治理 Gate

ADR-0020 §11.1 仍是当前已接受的 Owner 决策，其中将 Companion-owned Workspace Worker 限定为窄例外，并明确保留其他 scheduler / daemon 范围的 Hold。本 SPEC 是架构提案，**不自动修改或覆盖该 ADR**。

任何运行时实现前，必须由 Owner 明确批准对 ADR-0020 §11.1 的 dated amendment，并同步更新 docs/plans/post-mvp-conditional-roadmap.md §19 / §24.3。若未批准，现有 Companion / OpenClaw 生命周期保持不变，不得以本 SPEC 为由先行增加新的后台调度行为。

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

## 13. 文档权威与关联

- 本文件：Service Host 的架构与行为要求。
- [技术设计](./SPEC-PD-SERVICE-HOST-001-TECHNICAL-DESIGN.md)：包边界、执行流程、平台调度与迁移实现方案。
- [PD 架构总览](../architecture/PD_ARCHITECTURE_OVERVIEW.md)：全局架构入口；区分当前实现与目标架构。
- [ADR-0020](../adr/0020-codex-cli-host-adapter.md) §11.1：当前已接受的生命周期决策；本 SPEC 不覆盖它。
- [Feedback Resilience SPEC](./SPEC-PD-FEEDBACK-RESILIENCE-001.md) 与 [技术设计](./SPEC-PD-FEEDBACK-RESILIENCE-001-TECHNICAL-DESIGN.md)：Pain 可靠接收、补证与后台恢复的具体业务要求。
- [Pain Ingress SPEC](./SPEC-PD-AGENT-PAIN-INGRESS-001.md)：Pain 持久化和诊断任务入口契约。
