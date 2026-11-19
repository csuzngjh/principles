# SPEC-PD-SERVICE-HOST-001 — 配套技术设计与实施方案

- **版本**：v0.1
- **日期**：2026-11-19
- **状态**：Proposed / Owner decision required；本文件不授权运行时代码变更
- **上位规范**：[PD Service Host Architecture SPEC](./SPEC-PD-SERVICE-HOST-001.md)
- **设计目标**：复用现有任务与执行实现，把后台触发和生命周期从 Companion / OpenClaw Gateway 解耦；不新增第二套业务管道。

## 1. 技术决策摘要

| 决策 | V1 方案 | 原因 / 约束 |
|---|---|---|
| Service Host 形态 | 用户级 OS scheduler + 短生命周期 run-once coordinator | UI / 宿主独立；不增加常驻通用 Daemon |
| 触发范围 | 每个 PD 安装一个 scheduler registration | 避免每个 Workspace 创建重复系统任务 |
| Workspace 枚举 | 复用 canonical PD install manifest | 不按 cwd、宿主 home 或任意路径猜测 Workspace |
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

### 2.3 Worker Adapter 合同

Service Host 只认识稳定的 Worker Adapter 合同，不直接判断业务任务内容。建议接口具备：
- hostKind / adapterVersion；
- supports(workspaceDescriptor)；
- runOnce({ workspaceDir, activeRelease, signal, invocationId })；
- 返回结构化 cycle outcome、退出码、lastProgressAt 和 nextAction。

Adapter 内部继续调用现有 Worker Cycle；Service Host 不复制 Diagnostician、Internalization、Recovery 或候选选择逻辑。

## 3. Worker 复用与迁移映射

| 现有模块 | 当前职责 | Service Host 复用 / 调整 |
|---|---|---|
| codex-adapter workspace-worker.ts | Codex catch-up、reconcile、Diagnostician、downstream cycle | 保留业务实现；由 Codex Worker Adapter 调用单次 cycle |
| workbuddy-adapter workspace-worker.ts | WorkBuddy catch-up、reconcile、Diagnostician、downstream cycle | 保留业务实现；由 WorkBuddy Worker Adapter 调用单次 cycle |
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
- BehaviorExamplePackAssembler 的构造与 Workspace-scoped evidence assembly；
- OpenClaw hostKinds、tool catalog 和行为语义声明读取。

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

### 5.1 Manifest 与 Workspace 解析

- 复用当前 canonical install manifest 的读取与校验逻辑；Companion 中的 manifestCodexWorkspacesSource / manifestWorkbuddyWorkspacesSource 是迁移起点，不应复制一套解析器。
- Manifest read failure 必须与 valid empty manifest 区分；读失败时保留现有 worker / 不做 mass-stop，也不启动未知 Workspace。
- 每个 Workspace 必须通过 canonical path、目录存在性、安装授权和 active release 校验。
- 不允许通过当前工作目录、MCP 自由文本参数或环境变量猜测目标 Workspace。
- 如 manifest 当前结构不足以表达生命周期所有者，增加版本化可选字段 backgroundExecutionOwner，并提供旧 manifest 兼容读取；该字段用于防止双重所有者，不承载任务数据。

### 5.2 进程启动与环境隔离

- 调用 active release 中已安装的 CLI / Worker 入口，不从源码工作树或开发依赖目录启动生产任务。
- 每个子进程显式传入唯一 workspaceDir、hostKind、invocationId 和调用来源。
- 清理可能改变 Workspace 解析结果的父进程环境变量，再显式设置当前 Workspace；不得让父进程 workspace pointer 污染其他 Workspace。
- 不将 API Key、Token 或完整环境快照写入命令行、计划任务参数、日志或状态文件。
- 子进程使用当前登录用户的权限与既有凭据解析链。

### 5.3 超时、排空与退出

- run-once coordinator 对每个 Workspace 使用有界执行时间；单个超时不阻断其他 Workspace。
- 停止服务时先阻止启动下一个 Workspace，再向当前 Worker 发送现有 drain 协议（pd.worker.drain.v1）。
- Worker 正常 drain 后释放资源并退出；超过 drain deadline 才终止子进程。
- 若被强制终止，不能伪造任务失败或手工释放他人租约；由既有 Lease TTL / Recovery Sweep 处理。
- 现有 WorkspaceWorkerRegistry 的 stopEntry 直接 kill child，不满足最终 graceful shutdown 契约；迁移时必须补齐 drain 及进程树回收测试。

## 6. OS Scheduler Adapter

V1 使用用户级平台原语，不安装系统级服务：

| 平台 | 注册方式 | 启动条件 | 权限边界 |
|---|---|---|---|
| Windows | Task Scheduler user task | 用户登录 + 周期触发 | 当前用户，不提升权限 |
| macOS | LaunchAgent | 用户登录 + StartInterval | 当前用户，不使用 LaunchDaemon |
| Linux | systemd --user service + timer | 用户登录会话 + timer | 当前用户，不使用 root unit |

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

1. **先建立 Service Host 只读 status / dry-run**：读取 manifest、展示拟执行 Workspace，不启动 Worker。
2. **接入 Codex / WorkBuddy run-once**：使用 quiet/default-off gate；每个 Workspace owner marker 仍指向 legacy Companion。
3. **原子切换单一所有者**：先注册并验证 Service Host，再在同一受控迁移中切换 owner marker；确认 Service Host ready 后才停止 Companion Worker supervision。
4. **OpenClaw parity**：启用 openclaw worker --once，验证工具语义、证据装配、Diagnostician 与下游消费一致；切换后再停用 Gateway AutoConsumer。
5. **Companion observer-only**：删除 Worker Registry 的生命周期接线，保留状态展示。
6. **回滚**：先 disable Service Host trigger，再将 owner marker 原子切回 legacy owner，最后恢复旧启动路径；禁止两个 owner 同时长期工作。

如果 owner marker 写入失败、manifest 不可读或新 Worker health 无法证明，切换必须 fail closed，保留原所有者，不允许部分 Workspace 进入双重调度状态。

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

当前 PR 只提交文档与设计，不创建上述 package、不修改运行时代码、不注册 OS Scheduler。运行时实施必须先通过上位 SPEC 的 ADR-0020 Owner decision gate。

## 12. 现有文档对齐

- [PD Service Host Architecture SPEC](./SPEC-PD-SERVICE-HOST-001.md) 定义目标和验收。
- [Feedback Resilience Technical Design](./SPEC-PD-FEEDBACK-RESILIENCE-001-TECHNICAL-DESIGN.md) 的 §4.1 描述 Pain 可靠接收之后由谁继续推进；其服务生命周期细节以本技术设计为准。
- [Pain Ingress SPEC](./SPEC-PD-AGENT-PAIN-INGRESS-001.md) §9 描述当前实现事实和手动/自动执行路径，不得把未来 Service Host 写成当前已部署。
- [ADR-0020](../adr/0020-codex-cli-host-adapter.md) §11.1 仍有效；本文件是待 Owner 决策的提案，不构成 ADR amendment。
- [Post-MVP Conditional Roadmap](../plans/post-mvp-conditional-roadmap.md) §19 / §24.3 的 Hold 只有在 Owner 正式修改 ADR 后才能调整。
