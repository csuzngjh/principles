# SPEC-PD-SERVICE-HOST-001 — 配套技术设计与实施方案

- **版本**：v0.3
- **日期**：2026-11-20
- **状态**：Architecture Approved（ADR-0020 §11.6）/ Implementation not started；本文件不授权超出 §11.6 范围的运行时行为
- **v0.3 整改修订**：补齐 Workspace Binding 契约（§5.1）、Worker Adapter 最小合同与能力矩阵（§2.3）、环境隔离分层契约（§5.2）、所有权交接协议与最小实现要求（§9）；删除已过时的“实现前须先过 §11.1 Owner Gate”表述。
- **v0.2 源码审计修订**：本节按 2026-11-19 源码事实审计修正；标注〔新增能力〕的字段/接口当前并不存在，不得以现有能力名义引用。
- **上位规范**：[PD Service Host Architecture SPEC](./SPEC-PD-SERVICE-HOST-001.md)
- **设计目标**：复用现有任务与执行实现，把后台触发和生命周期从 Companion / OpenClaw Gateway 解耦；不新增第二套业务管道。

## 1. 技术决策摘要

| 决策 | V1 方案 | 原因 / 约束 |
|---|---|---|
| Service Host 形态 | 用户级 OS scheduler + 短生命周期 run-once coordinator | UI / 宿主独立；不增加常驻通用 Daemon |
| 触发范围 | 每个 PD 安装一个 scheduler registration | 避免每个 Workspace 创建重复系统任务 |
| Workspace 枚举 | canonical PD install manifest + 经验证的 per-host 绑定证据（`collectHostWorkspaceClaims`）两类授权源 | 不按 cwd、宿主 home 或任意路径猜测 Workspace；详见 §5.1 |
| Worker 执行 | 每个 Workspace 调用既有有界 Worker Cycle | 复用 Codex / WorkBuddy / Host Runtime |
| OpenClaw | 增加 PD-owned one-shot worker；Plugin 只保留宿主集成 | Gateway 不再拥有自动消费 timer |
| 任务存储 | 每 Workspace 现有 .pd/state.db | 不新增 Pain 表、全局队列或第二个 Task Store |
| 并发控制 | 安装级 run lock + 现有 task Durable Lease | 两种锁职责不同，不互相替代 |
| UI | Companion / Console 读取状态与发起显式运维操作 | UI 不是服务父进程 |
| 回滚 | manifest / scheduler owner marker 原子切换 | 同一 Workspace 不允许两个自动触发者同时生效 |

## 2. 包与依赖边界

### 2.1 建议的包边界

建议新增私有包：

~~~text
packages/pd-service-host/
  src/
    coordinator/
      run-once.ts
      workspace-discovery.ts
      workspace-executor.ts
      worker-adapter-registry.ts
    lifecycle/
      scheduler-contract.ts
      windows-task-scheduler.ts
      macos-launch-agent.ts
      linux-systemd-user.ts
      service-install.ts
      service-status.ts
    locking/
      service-run-lock.ts
    status/
      service-run-record.ts
      health-projection.ts
    index.ts
~~~

包名建议为 @principles/service-host（私有，不作为公开 SDK）。

### 2.2 依赖方向

~~~text
@principles/core
      ▲
      │
@principles/host-runtime  +  codex-adapter / workbuddy-adapter
      ▲
      │
@principles/service-host
      ▲
      │
@principles/pd-cli  ─────────────── create-principles-disciple installer
      ▲
      │
pd-companion / pd-console 只通过 CLI / status contract 读取状态
~~~

约束：
- service-host 不依赖 pd-companion、pd-console、openclaw-plugin 或 Electron。
- service-host 不反向依赖 pd-cli；CLI 只负责参数解析和调用 Service Host API。
- core 不增加 timer、OS scheduler、HTTP Server 或宿主 API。
- host adapter 负责提供 host-specific evidence / tool semantics / capability，不拥有 Service Host 生命周期。
- 若现有包依赖守护测试不允许该图，先更新架构约束与测试，再增加依赖；不得通过绕过守护测试实现。

### 2.3 Worker Adapter 最小合同

Service Host 只认识稳定的 Worker Adapter 合同，不直接判断业务任务内容。最小合同字段：

| 字段 | 含义 | 当前状态 |
|---|---|---|
| `hostKind` | 宿主标识（codex / workbuddy / openclaw） | 〔新增能力：现有 Cycle Result 不带宿主标识〕 |
| `adapterVersion` | Adapter 合同版本 | 〔新增能力〕 |
| `supports(workspaceDescriptor)` | 声明能否服务该 Workspace | 〔新增能力；判别依据见 §5.1 绑定证据〕 |
| `executeOnce({ workspaceDir, activeRelease, signal, invocationId })` | 执行一个有界周期 | 〔新增能力：现有入口是 `pd <host> worker --once` CLI，不是库级合同〕 |
| `cycleOutcome` | 结构化周期结果 | 已存在（`reason` / `nextAction` / `report`） |
| `lastProgressAt` | 最近一次真实进展时间 | 〔新增能力；Codex 近似源见下，WorkBuddy/OpenClaw 无〕 |
| `reason` / `nextAction` | 结果归因与下一步 | 已存在 |
| cancellation / timeout | 有界周期终止语义 | 〔部分新增能力：run-once Worker 子进程本身 bounded、正常路径自然退出；Service Host 侧超时用 SIGTERM（worker 侧 run-once 信号处理需补）或依赖既有 Lease Recovery；`pd.worker.drain.v1` 是 Companion 私有 IPC 协议、不是可复用的通用 drain（§5.3）〕 |
| health / liveness | 周期级健康与活跃判定 | 〔新增能力：Codex 有 `.state/codex-worker-liveness.json` 近似源；WorkBuddy/OpenClaw 无等价记录，Adapter 合同落地前必须补齐〕 |

源码事实（2026-11-19 审计）：`CodexWorkerCycleResult` / `WorkbuddyWorkerCycleResult` 只有 `workspaceDir` / `mode` / `reason` / `nextAction` / `report`；`hostKind`、`adapterVersion`、`lastProgressAt` 是新增字段，不得写成已存在。`lastProgressAt` 的现有近似数据源是 Codex 的 `.state/codex-worker-liveness.json`（`lastCycleCompletedAt` / `lastCycleStartedAt` / `runningStage`），但 **WorkBuddy Worker 当前不写任何 liveness 文件**，OpenClaw 也没有等价记录；三个宿主的进展可观测性当前不对称，Adapter 合同落地前必须先补齐 WorkBuddy / OpenClaw 的周期证据。

**共享能力 vs 宿主专属能力**：

| 类别 | 内容 | 归属 |
|---|---|---|
| 共享（不得重复建设） | 有界周期执行、候选选择、Diagnostician、Internalization、Recovery、Durable Lease、Task/Run Read Model、feature flag/Owner pause 裁决 | core + host-runtime |
| 宿主专属 | 宿主工具语义、宿主轨迹/证据访问、宿主声明、宿主 liveness 证据文件 | host adapter |

**接入前缺口（逐 Host）**：

- **Codex**：可复用程度最高；liveness 已存在。缺口：无 hostKind/adapterVersion/lastProgressAt 输出字段；`PD_INVOCATION_SOURCE` 只有 `companion`/`manual` 两值，Service Host 驱动会被 stall 归因误报（§5.2）。
- **WorkBuddy**：**必须**补齐 liveness 证据文件（否则 FR-10 无法判定）；建议复用 core `pickDiagnosticianCandidate` 的 fair-share round-robin 替换本地实现。`retry_wait` 饿死风险（本地实现 pending 优先）评估结果：不阻塞 Phase 2 最小接入，但记录为独立后续项并阻塞 WorkBuddy parity 验收——不扩大本轮范围。
- **OpenClaw**：需先完成 §4 解耦（tool semantics / trajectory registry / 常量集）与 `pd openclaw worker --once` 新入口，再谈接入。

Adapter 内部继续调用现有 Worker Cycle；Service Host 不复制 Diagnostician、Internalization、Recovery 或候选选择逻辑。

## 3. Worker 复用与迁移映射

| 现有模块 | 当前职责 | Service Host 复用 / 调整 |
|---|---|---|
| codex-adapter workspace-worker.ts | Codex catch-up、reconcile、Diagnostician、downstream cycle、post-processing 续跑、`.state/codex-worker-liveness.json` 周期证据 | 保留业务实现；由 Codex Worker Adapter 调用单次 cycle |
| workbuddy-adapter workspace-worker.ts | WorkBuddy catch-up、reconcile、Diagnostician、downstream cycle | 保留业务实现；由 WorkBuddy Worker Adapter 调用单次 cycle。**与 Codex 不等价**：无 liveness 文件、无 post-processing 续跑、候选领取用本地 `pickDiagnosticianCandidate`（无 core fair-share round-robin，pending 可饿死 retry_wait）、无 `lastCycleDriver` 归因 |
| host-runtime internalization-consumer-cycle.ts | 共享 host-neutral consumer cycle | 继续作为共享执行实现，不复制 |
| principles-core RuntimeStateManager | Workspace Task / Run / Lease / Artifact 状态 | 继续作为唯一任务状态权威 |
| pd-cli codex-worker.ts / workbuddy-worker.ts | 单次与连续 Worker CLI | 保留 --once；连续模式在迁移窗口内兼容，Service Host 不启动长期 while loop |
| pd-companion WorkspaceWorkerRegistry | 当前子进程监督、manifest sync、restart / drain | 迁移可复用纯 manifest / release / 状态判定逻辑；生命周期最终移出 Companion |
| OpenClaw InternalizationAutoConsumerService | Gateway 内 timer、tool catalog、SystemLogger、shared cycle | 拆出 host capability provider；增加 openclaw worker --once；Service Host 接管调度后停用 timer |

## 4. OpenClaw 解耦方案

这是跨宿主统一中最重要的技术工作。不能只把 timer 搬走，却继续在 Service Host 中依赖 OpenClaw Gateway 的运行时对象。

### 4.1 保留在 Plugin 的职责

- Hook 注册和宿主事件捕获；
- Pain / correction / tool evidence 的授权采集；
- OpenClaw host-tool declaration 的事实登记；
- Gateway API 与 PluginLogger 的适配；
- 用户可见的宿主接入错误和授权提示。

### 4.2 拆出给可独立运行的 Adapter

将以下能力从 Plugin 生命周期中抽离，形成 Service Host 可调用的静态 / 本地能力提供者：
- READ_ONLY_TOOL_NAMES、LOW_RISK_WRITE_TOOL_NAMES、HIGH_RISK_TOOL_NAMES、AGENT_TOOL_NAMES；
- OPENCLAW_TOOL_SEMANTICS 与 semantic mappings；
- Workspace-scoped evidence assembly；
- OpenClaw hostKinds、tool catalog 和行为语义声明读取。

源码事实（2026-11-19 审计）：真正需要迁移的耦合点比表面清单更窄：

- Plugin 的 `BehaviorExamplePackAssembler` 只是 5 行 facade，真实装配器已在 `@principles/host-runtime`（`behavior-example-pack-assembler.ts`）；它要的是 `BehaviorExampleDataSource` 接口 + tool semantics。真正的 Gateway 外缺口是 `TrajectoryRegistry` / `TrajectoryDatabase`（plugin 内部类）和上述常量集。
- `principles-disciple/rulehost-evidence` 已导出 `BehaviorExamplePackAssembler` 与 `TrajectoryRegistry`（别名 `RuleHostEvidenceRegistry`），`pd runtime internalization run-rulehost` 今天就在 lazy-import 这个子路径。最小方案可以复用同一 lazy-import 形态；彻底方案是把 `TrajectoryDatabase` 与常量集提取到独立 adapter 包。两条路都必须过依赖图审查。
- `scripts/check-tool-semantics-authority.mjs` 的 `DECLARATION_FILES` SSoT 把 `packages/openclaw-plugin/src/constants/tools.ts` / `tool-semantics.ts` 钉为唯一权威；常量迁移必须同步更新该守卫，否则 dependency / authority guard 会红。
- `persistOpenClawToolDeclaration` 本身只用 host-runtime 的 `saveHostToolDeclaration` + 常量 mappings，可直接搬进 worker cycle（与 codex / workbuddy worker 的写法一致）。

可新建 packages/openclaw-adapter，或在依赖守护测试允许时先提取到 host-runtime 的 host capability package。最终选择必须通过依赖图审查；不得让 service-host 依赖 openclaw-plugin。

### 4.3 新增单次 Worker 入口

增加 pd openclaw worker --once：
1. 读取已绑定 Workspace 与 .pd/config.yaml。
2. 读取已持久化且获准的 OpenClaw tool declaration。
3. 构造 host capability provider；缺失或版本不兼容时返回明确 degraded / waiting 状态。
4. 调用现有 runInternalizationConsumerCycle 和 runPendingDiagnosticianOnce。
5. 写入既有 SystemLogger / Runtime State / Run 记录。
6. 关闭所有 Store / SQLite 句柄后退出。

OpenClaw Gateway 不运行时，不得回退到扫描 Gateway 私有内存或会话目录。没有所需证据时，任务保持待补证 / waiting 状态。

**源码审计缺口（必须在实施时解决，当前方案未覆盖）**：

- **Workspace 发现**：install manifest 的 `workspaces[]` 只在 installer / update / workbuddy-setup 路径写入；OpenClaw 运行时绑定（`ensureMcpBinding` / `syncMcpBindingFromExplicitWorkspace`）只写 `mcp-binding.json`，**不回写 install manifest**。安装后新绑定的 OpenClaw Workspace 对 manifest discovery 不可见——Service Host 若只读 manifest，会漏掉这些 Workspace。必须选其一：(a) 绑定路径同步合并 manifest workspaces；(b) Service Host 增加第二个授权注册源；(c) 明确声明 V1 只覆盖 install 时登记的 Workspace 并把缺口记入验收。
- **宿主归属判别**：manifest 是 `hosts[]` + `workspaces[]` 两个平铺数组，没有 per-Workspace host binding；现有 `internalization_auto_consumer` flag 不是宿主归属证据（codex workspace 也用它）。`supports(workspaceDescriptor)` 需要真实判别器：`.pd/config.yaml` 的 `host.*` flag、`host-tool-semantics/<host>.json` 持久化声明、或新增 manifest per-workspace binding 字段。
- **Adaptive 调度不可直接保留**：`nextConsumerDelay` 已在 host-runtime 共享，但其输入（consecutiveEmptyCycles / consecutiveFailures / lastCycleDurationMs）是 Gateway 进程内 Map 状态，run-once 退出即丢。固定 OS 周期无法复现 backlog 驱动的更短延迟与失败退避；要么把调度状态持久化进 SPEC §9 允许的小型版本化 operational status 文件，要么在 SPEC 明确记录 V1 的队列延迟回退并接受。

## 5. Service Host 单次执行流程

~~~text
OS trigger
   │
   ▼
pd service run-once
   │
   ├─ validate active release / user profile
   ├─ acquire per-install process lock
   ├─ read canonical install manifest
   ├─ validate manifest and Workspace paths
   ├─ resolve enabled host adapters per Workspace
   │
   ├─ for each Workspace (bounded concurrency; V1 default 1)
   │      ├─ resolve explicit workspaceDir
   │      ├─ build sanitized child environment
   │      ├─ run adapter once with bounded timeout
   │      ├─ collect cycle result / status / progress
   │      └─ continue even if this Workspace fails
   │
   ├─ persist service run summary
   ├─ close all child handles / stores
   └─ release process lock
~~~

### 5.1 Manifest、Workspace 解析与 Host Binding 契约

**读取与校验**：

- 复用当前 canonical install manifest 的读取与校验逻辑；Companion 中的 manifestCodexWorkspacesSource / manifestWorkbuddyWorkspacesSource 是迁移起点，不应复制一套解析器。
- Manifest read failure 必须与 valid empty manifest 区分；读失败时保留现有 worker / 不做 mass-stop，也不启动未知 Workspace。
- 每个 Workspace 必须通过 canonical path、目录存在性、安装授权和 active release 校验。
- 不允许通过当前工作目录、MCP 自由文本参数或环境变量猜测目标 Workspace。

**两类授权发现源**（对应 SPEC §9.1）：

1. canonical install manifest：安装期/绑期登记的 Workspace 与 host 关联。当前 `workspaces[]` 只在 installer / update / workbuddy-setup 写入；OpenClaw 运行时绑定（`ensureMcpBinding` / `syncMcpBindingFromExplicitWorkspace`）只写 `mcp-binding.json`，**不回写 manifest**，安装后绑定的 OpenClaw Workspace 对 manifest discovery 不可见。
2. 经验证的 per-host 绑定证据：`collectHostWorkspaceClaims`（install-layout/mcp-binding-contract.ts）已枚举 `default` 目录 + `host_declaration` + `payload_binding` 三类 claim，配合 `findForeignWorkspaceOwner` 做跨宿主归属裁决——作为已存在的第二授权源复用，不新建 Workspace Registry。

**Host Binding 契约**（Host Binding ≠ backgroundExecutionOwner；一个 Workspace 可有多个 host 接入，但生命周期所有者唯一）：

| 语义 | 契约 |
|---|---|
| 注册（bind） | 单次原子写入权威存储；manifest 路径用合并语义，claim 路径写宿主 declaration/binding 文件 |
| 解绑（unbind） | 只移除该 host 的 binding；Workspace 条目在无剩余绑定且无业务状态需求时才移除 |
| 升级 | 写路径必须保留未知顶层字段；`parseInstallManifest` 对未识别字段宽容，新增版本化可选字段向后兼容；写方必须经 `installManifestHostsForPersist` / `mergeInstallManifestWorkspaces` 合并，不得整表重写丢 `unknownHosts` 或新增字段 |
| 卸载 | manifest 生命周期归安装器；Service Host uninstall 不删除 Workspace 数据与绑定证据 |
| 多 Host 同 Workspace | 允许；每条 claim 独立验证；归属歧义由 `findForeignWorkspaceOwner` 拒绝 |
| 失效 | 路径缺失→unavailable/degraded，不推断替代目录；路径移动→视为新绑定需重新登记（realpath 身份校验） |
| 幂等 | 注册/解绑可重入；read-modify-write 集合合并 + 原子 rename |
| fail-closed | 不在任一授权源的 Workspace 永不执行；证据不可读→degraded 而非“无绑定” |

**Manifest 结构演进**：`backgroundExecutions`（canonical absolute workspaceDir → `BackgroundExecutionRecord`）**schema 已实现**——每 Workspace 独立所有权记录、逐状态语义校验（SPEC §8.4 状态机的非法组合在解析期即拒绝）、旧版单条 `backgroundExecution` 仅在 Workspace 身份唯一可确认时迁移、歧义 fail-closed；写方辅助 `setInstallManifestBackgroundExecution` 保证一次只改一个 Workspace 的键。**CAS 写路径与状态机迁移逻辑未实现**（SPEC §8.4 第 10 项）。per-Workspace `workspaceBindings`（canonical workspaceDir → `{hosts[], boundVia, boundAt}`）仍为**设计提案，未实现**；Host 关联当前由第二类授权源（经验证的 per-host 绑定证据）承担。

**宿主归属判别**：manifest 目前是 `hosts[]` + `workspaces[]` 平铺数组，无 per-Workspace host binding；Companion 的 `readManifestWorkspacesForHost` 对每个已启用 host 返回同一份列表，靠 `.pd/config.yaml` 的 `host.*` flag 在 Workspace 内部 pause 掉不该跑的 Worker。`internalization_auto_consumer` flag 不是宿主归属证据（codex workspace 也用它），也不是绑定/授权凭据。`supports(workspaceDescriptor)` 的判别输入：manifest `workspaceBindings`（落地后）+ `.pd/config.yaml` `host.*` flag + 持久化 host declaration/payload binding claim。

### 5.2 进程启动与环境隔离

**实现状态**：本节约定为目标契约；当前代码中 `PD_INVOCATION_SOURCE` 取值仅 `companion`/`manual`、无 Service Host 值，Coordinator 身份解析与子进程环境白名单构造**均未实现**——属 Phase 1/2 验收条件（SPEC §11），不得当作现有能力引用。

- 调用 active release 中已安装的 CLI / Worker 入口，不从源码工作树或开发依赖目录启动生产任务。
- **Coordinator 层（pd service run-once 自身）**：必须使用显式的生产安装身份——PD home / install root 由注册时解析出的绝对路径决定，不得被继承的 `PD_EXPERIMENT_ROOT`（重定向整个 PD home → 解析到另一份 manifest 与 runtime，最严重）、`HOME` / `USERPROFILE`、`OPENCLAW_STATE_DIR` / `OPENCLAW_HOME`、`WORKBUDDY_CONFIG_DIR`、`CODEX_HOME` 污染。实验环境与生产 Workspace 之间不得互相访问。
- **Worker 子进程层**：每个子进程显式传入唯一 workspaceDir、hostKind、invocationId 和调用来源；按白名单构造环境，而非继承后修补。allowlist 之外必须剔除或显式固定的变量：`PD_EXPERIMENT_ROOT`、`OPENCLAW_STATE_DIR` / `OPENCLAW_HOME`、`WORKBUDDY_CONFIG_DIR`、`PD_WORKSPACE_DIR`（显式 --workspace 在场时不生效，但仍触发 discovery 与告警噪音）、`HOME` / `USERPROFILE`、`PD_COMPANION_WORKER_IPC`、`PD_INVOCATION_SOURCE`（现有取值只有 `companion` / `manual`，Service Host 需要自己的取值，否则 `pd codex worker --status` 的 stall 归因会把 service 驱动的周期误报为手动）。凭据变量（LLM API key 等）按现有 `getEnvVar` 链保留——它们是 worker 的凭据解析路径，不是 workspace 指针。
- 不将 API Key、Token 或完整环境快照写入命令行、计划任务参数、日志、状态文件或任务数据。
- 子进程使用当前登录用户的权限与既有凭据解析链；scheduler 注册在目标用户上下文完成，运行时不得再从环境变量重新解析身份。

### 5.3 超时、排空与退出

- run-once coordinator 对每个 Workspace 使用有界执行时间；单个超时不阻断其他 Workspace。
- 源码事实：`pd.worker.drain.v1` 真实存在，但当前是 **Companion 私有 IPC 协议**——worker 仅在连续模式 + `PD_COMPANION_WORKER_IPC=1` + spawn stdio 含 `ipc` 通道时注册 drain/SIGINT/SIGTERM 监听并回 `pd.worker.drain-ready.v1`；`--once` 模式不安装任何 drain 处理。把它写成可直接复用的通用 drain 协议不准确。run-once 模型下 Worker 子进程本就 bounded，正常路径是自然退出；Service Host 的超时终止用 SIGTERM（worker 侧对 run-once 需补信号处理或直接依赖 Lease Recovery），不需要复制 Companion 的 IPC drain——除非 Service Host 也改为长驻监督子进程，而那是被明确排除的形态。
- 若被强制终止，不能伪造任务失败或手工释放他人租约；由既有 Lease TTL / Recovery Sweep 处理。
- 现有 WorkspaceWorkerRegistry 的 stopEntry 直接 kill child，不满足最终 graceful shutdown 契约；迁移时必须补齐 drain 及进程树回收测试（该项源码核实为真，但仅影响 Companion 监督路径）。
- 既有并发与 fencing 事实：`DefaultLeaseManager`（acquireLease / acquireLeaseDetailed 返回 runId + fencing、`releaseLease(fence)` / `renewLease` / `forceExpire`）+ `LeaseFence`（leaseGeneration）+ `DefaultRecoverySweep`（recoverAll / detectExpiredLeases / recoverTask）已在 `packages/principles-core/src/runtime/store/` 落地并被 worker cycle 每轮调用；SPEC / TD 中「是否需要 generation / fencing」的开放问题答案是**已存在**，Service Host 不得再实现第二套。

## 6. OS Scheduler Adapter

V1 使用用户级平台原语，不安装系统级服务：

| 平台 | 注册方式 | 启动条件 | 权限边界 |
|---|---|---|---|
| Windows | Task Scheduler user task | 用户登录 + 周期触发 | 当前用户，不提升权限；不存凭据时等同「仅用户登录时运行」 |
| macOS | LaunchAgent | 用户登录 + StartInterval | 当前用户，不使用 LaunchDaemon；**只在交互式登录会话内存在**，登录前 / 注销后完全不触发 |
| Linux | systemd --user service + timer | 用户登录会话 + timer | 当前用户，不使用 root unit；user manager 默认随最后会话退出而停，**注销后继续运行需 `loginctl enable-linger`**（V1 不默认开启） |

平台差异（源码审计补充，必须写进 SPEC 而不是宣称跨平台同保证）：三个平台在 V1 的共同真实保证只是「用户已登录会话期间可触发」。macOS LaunchAgent 完全没有登录前触发能力（要 LaunchDaemon，已被排除）；Windows 不存凭据即「仅登录时」；Linux 是唯一可注销后运行的平台，但 linger 需要额外配置。重启后首次登录前、用户注销期间的行为必须如实记录为平台差异，不得写成统一支持。

建议命令面：
- pd service install：注册当前用户级触发；幂等。
- pd service enable / disable：启用或停止未来自动触发。
- pd service status --json：读取 OS 注册状态、最近运行和 Workspace 状态。
- pd service run-once --json：立即执行一次有界周期，供 OS Scheduler 和人工诊断使用。
- pd service uninstall：撤销触发注册；不删除 Workspace 业务数据。

V1 建议默认周期先与当前 CLI Worker 的既有默认 cadence 对齐，再以真实安装压测确定最终值。不要在 SPEC 中把 120 秒写成已验证的性能 SLA。OpenClaw 当前 adaptive timer 的行为迁移需在 parity 测试中单独核验；若 V1 固定周期不满足队列延迟预算，应先调整调度契约，而不是偷偷恢复 Gateway timer。

## 7. 状态与可观测性

### 7.1 运行级状态

至少记录：
- serviceRunId / invocationId；
- triggerSource（login / scheduled / manual）；
- startedAt / completedAt / duration；
- manifest read verdict；
- active release identity；
- Workspace 数量、成功数、paused 数、degraded 数；
- 每个 Workspace 的 adapter、cycle outcome、lastProgressAt、reason 和 nextAction。

### 7.2 健康判定

- registered 只表示 OS 触发已注册。
- process_started 只表示单次进程启动。
- cycle_completed 表示 Worker Cycle 返回了可解析结果。
- business_progress 必须由任务状态 / Run / Artifact / liveness 的真实变化证明。
- backlog 非零且没有近期有效执行活动时，不得显示 healthy。
- 复用现有 per-Workspace liveness 和 Task / Run Read Model；安装级 status 文件只记录调度元数据，不存储 Pain 或任务 payload。

## 8. Companion / Console 的变化

### 8.1 Companion

迁移完成后：
- 保留窗口、托盘、通知、Console 启动和服务状态入口。
- 不再创建 WorkspaceWorkerRegistry，不再 spawn Codex / WorkBuddy Worker，不再拥有 Worker restart ladder。
- Companion 退出只关闭它自己的窗口与 Console 子进程，不停止 OS scheduler。
- Tray 展示来自 Service Host status contract 的实际执行状态，而不是本地子进程 Map。

### 8.2 Web Console

- 保留 backlog、Run、审批、审计和手动执行入口。
- Console HTTP Server 的启动/关闭不得创建或销毁 Service Host。
- 现有 POST /api/diagnostician/:taskId/run 保留为显式手动操作；202 仍只表示 child process started。
- 后续可以增加 Service Host status / enable / disable API，但必须调用相同的服务控制契约，不复制调度逻辑。

## 9. 迁移与回滚

按 SPEC §8.4 状态机执行（LEGACY_OWNED → HANDOVER_PREPARING → SERVICE_HOST_OWNED / ROLLBACK）：

1. **只读 dry-run（Phase 1）**：读取 manifest 与 claim，展示拟执行 Workspace，不启动 Worker；owner marker 全为 `legacy`。
2. **Codex / WorkBuddy shadow（Phase 2）**：quiet/default-off gate 下真实驱动单周期；marker 仍 `legacy`，旧所有者唯一。
3. **逐 Workspace 原子交接（Phase 2/4/5）**：按 SPEC §8.4 不可颠倒的顺序——创建 `HANDOVER_PREPARING` 记录（`effectiveOwner` 仍 `legacy`，但**不授予启动权**：Supervisor 过渡态门禁已实现——`handover_preparing`/`rollback_pending`/`service_host_owned` 阻塞旧 Worker 的启动与崩溃重启，运行中的 Worker 经 quiesce/drain/stop 停止，进程重启不复活；`rollback_pending` 同样不得提前恢复旧 Worker）→ Service Host 以**不消费**模式完成就绪自检 → 验证就绪 → 旧所有者停止该 Workspace 消费注册 → 验证已停止 → 单次 CAS 原子写 marker（generation+1，`effectiveOwner=service_host`）→ 才授予执行权 → 写交接完成证据。就绪验证必须在旧所有者停止之前，marker 翻转必须在旧所有者停止之后；停止与翻转间的无消费者窗口安全（任务持久化），绝不允许双消费者并行。崩溃恢复只能依据持久化 `state`+`operationId`+`generation` 判定方向，不得以进程存在性推断所有权。
4. **OpenClaw parity（Phase 4）**：验证工具语义、证据装配、Diagnostician 与下游消费一致后，按同一交接协议停用 Gateway AutoConsumer。
5. **Companion observer-only（Phase 5）**：删除 Worker Registry 生命周期接线，保留状态展示。
6. **ROLLBACK**：停止该 Workspace 的 Service Host 触发 → 原子写回 `legacy` → 旧所有者重新注册。禁止双执行。

**最小实现要求（当前代码中不存在，不得声称为已具备）**：

- manifest 按 Workspace 键控的 `backgroundExecutions` 记录（**schema 已落地**）+ 单次原子 CAS 写路径（generation+1，未实现）；
- Companion 清单复析与 Gateway 注册/tick 前的 marker 读取点；
- “旧所有者已停止”的可验证信号与“Service Host ready”的就绪探针；
- marker 读写失败、manifest 不可读、健康证据不足时的 fail-closed 分支（保留原所有者，不进入双调度）。

进程存在性、PID、启动顺序或固定延迟**不是**所有权证明。

## 10. 测试矩阵

| 类别 | 必测场景 |
|---|---|
| Unit | manifest verdict、path containment、adapter selection、single-instance lock、status projection、owner marker transition |
| Process | CLI 子进程参数、环境清理、active release 解析、超时、drain、进程树退出 |
| Scheduler | install / enable / disable / status / uninstall 幂等性；用户登录与周期触发 |
| Concurrency | 两个 OS trigger 重叠；多个 Workspace；一个 Workspace 锁冲突不影响其他 Workspace |
| Recovery | 进程强杀、机器重启、Lease 过期、后处理恢复、下一周期重试 |
| Host parity | Codex / WorkBuddy / OpenClaw 各自的工具语义、证据读取和 Worker Cycle |
| UI isolation | 关闭浏览器、Console Server、Companion 后，周期继续 |
| Host isolation | OpenClaw Gateway 退出后，已持久化且证据足够的任务继续 |
| Governance | Owner pause、feature flag off、Diagnostician capability disabled、consent revoked |
| Security | 无凭据出现在参数/日志；Workspace pointer 不串线；不扫描未授权宿主目录 |

## 11. 实施顺序与文件映射

| 顺序 | 位置 | 变更意图 |
|---|---|---|
| 1 | 新 packages/pd-service-host | 实现 run-once coordinator、scheduler adapter、lock、status |
| 2 | packages/pd-cli | 增加 pd service 命令；复用既有 --once Worker CLI |
| 3 | packages/create-principles-disciple | 注册/撤销用户级 scheduler；升级时做 owner handover |
| 4 | packages/openclaw-plugin + 新 OpenClaw Adapter seam | 将 Gateway timer 与可独立执行能力分开 |
| 5 | packages/pd-companion | 移除 Worker supervision 接线，保留 status / notification |
| 6 | packages/pd-console | 增加服务状态查询与显式操作；不拥有生命周期 |
| 7 | docs / architecture tests | 同步架构边界、依赖规则、生命周期与回滚测试 |

当前 PR 只提交文档与设计，不创建上述 package、不修改运行时代码、不注册 OS Scheduler。架构已获 ADR-0020 §11.6 批准（见上位 SPEC §2.0/§11）；运行时实现按正常开发评审流程推进，超出 §11.6 范围的能力仍需单独决策。

## 12. 现有文档对齐

- [PD Service Host Architecture SPEC](./SPEC-PD-SERVICE-HOST-001.md) 定义目标和验收。
- [Feedback Resilience Technical Design](./SPEC-PD-FEEDBACK-RESILIENCE-001-TECHNICAL-DESIGN.md) 的 §4.1 描述 Pain 可靠接收之后由谁继续推进；其服务生命周期细节以本技术设计为准。
- [Pain Ingress SPEC](./SPEC-PD-AGENT-PAIN-INGRESS-001.md) §9 描述当前实现事实和手动/自动执行路径，不得把未来 Service Host 写成当前已部署。
- [ADR-0020](../adr/0020-codex-cli-host-adapter.md) §11.6 是本设计的架构授权来源；§11.1 未被收窄的限制仍有效。
- [Post-MVP Conditional Roadmap](../plans/post-mvp-conditional-roadmap.md) §19 / §24.3 已记录 §11.6 范围收窄；其余 Hold 不变。
