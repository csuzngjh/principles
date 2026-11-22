# PD Service Host Scheduler — 运维手册（Phase 3, PRI-1281）

> 权威：SPEC-PD-SERVICE-HOST-001 v0.3 §8.1/§10/§11 Phase 3；ADR-0020 §11.6。
> 本文是操作面文档：命令、平台矩阵、生命周期与安全边界、状态读取。
> 实施位置：`packages/pd-cli/src/services/service-host/scheduler/`（不抽独立包 — TD §11 修正）。

## 1. 命令面

```text
pd service install    [--interval-ms <ms>] [--pd-home <dir>] [--json]
pd service enable     [--pd-home <dir>] [--json]
pd service disable    [--pd-home <dir>] [--json]
pd service status     [--pd-home <dir>] [--json]
pd service uninstall  [--pd-home <dir>] [--json]

pd service run-once   [--json] [--trigger manual|scheduler] [--pd-home <dir>]   # managed（OS 调度器入口）
pd service run-once   --dry-run [--json]                                        # Phase 1 只读发现
pd service run-once   --shadow --workspace <dir> [--host …] [--timeout-ms <ms>] # Phase 2 人工 shadow
```

- 全部生命周期操作**幂等**；`install` 默认创建 **installed_disabled**（不自动启用）。
- `enable` 从不创建注册（未注册时 fail-closed）；`disable` 只停未来触发，保留注册与全部数据；`uninstall` 只撤销本安装的注册（Workspace 数据 / `.pd/state.db` / Ledger / Trajectory / 证据一律不动）。
- `--pd-home` 是**可信注入**（调度器注册、安装器与自动化使用）；身份绝不由 `HOME`/`USERPROFILE`/`PD_EXPERIMENT_ROOT` 推断。
- 间隔默认 **120,000 ms**（对齐现有 Codex/WorkBuddy worker 节奏），下限 **60,000 ms**（Windows Task Scheduler 重复间隔真实下限 PT1M，实测 HRESULT 0x80041318）。120s 是默认值，不是性能 SLA。

## 2. 平台支持矩阵（如实声明）

| 平台 | 机制 | 触发条件 | 权限边界 | 注销后 | 验证状态 |
|---|---|---|---|---|---|
| Windows | 当前用户 Task Scheduler 任务（LogonTrigger + 周期 TimeTrigger，InteractiveToken，RunLevel LeastPrivilege） | 用户已登录（不存凭据=仅登录时运行） | 当前用户，无提权，无 SYSTEM，无 Windows Service，无机器级任务 | 不触发 | **真实验收通过**（真实注册/启用/真实 OS 启动/禁用/卸载/幂等/零遗留；含非提升被拒不伪装未安装的真实验证） |
| macOS | 用户 LaunchAgent（`~/Library/LaunchAgents/com.principles-disciple.service-host.<key>.plist`，RunAtLoad + StartInterval） | 交互式登录会话内 | 当前用户 gui/<uid> 域；无 LaunchDaemon；无 root | 不触发（无登录前/注销后触发能力） | **NOT_VERIFIED**（真实 Darwin 主机缺失；状态机级单元测试覆盖 install/enable/disable/uninstall 全迁移序列） |
| Linux | systemd --user oneshot service + timer（`~/.config/systemd/user/pd-service-host-<key>.*`） | 用户会话（user manager 存活期间） | 用户级 unit；无 root unit；**不启用 linger** | 默认不运行（注销后需 `loginctl enable-linger`，V1 不默认开启、不代配置） | **NOT_VERIFIED**（真实 Linux 主机缺失；双 unit 独立见证+状态机级单元测试覆盖） |

三平台 V1 统一真实保证只有一条：**用户已登录会话期间可触发**。重启后首次登录前、注销期间的行为是平台差异，不宣称统一支持（SPEC §10.2 审计结论）。

## 3. 注册身份与安全边界

- 调度器是**安装级对象**（非每 Workspace 一个）；注册身份由 canonical pdHome 派生（sha256 前 10 hex），同一用户多安装互不覆盖。
- 注册命令行钉定**绝对路径**：`<node> <active-release pd-cli>/dist/index.js service run-once --json --trigger scheduler --pd-home <pdHome>`。不依赖 PATH、不依赖 cwd、不携带任何 API Key/Token/凭据。
- 同名但内容不引用本安装入口的注册视为**外部任务**：fail-closed 拒绝（不覆盖、不删除）。**三平台统一按结构化解析判定归属**：Windows 解码任务 XML `<Command>`/`<Arguments>`（CommandLineToArgvW 语义）比对 cliEntry + 参数向量；macOS 解析 plist `ProgramArguments`；Linux 解析 unit `ExecStart=`（含 `$`/`%` 转义还原与 `Unit=` 指针核对）。无法解析的注册一律按外来处理。
- macOS 生命周期序列：install=写 plist 并**钉 disabled 状态**（不 bootstrap）；enable=归属验证→`launchctl enable`→`bootstrap`→verifyLoaded；disable=`launchctl disable`（持久禁用）→`bootout`→verifyUnloaded；uninstall=完整撤销+删 plist。install 同时预建 `<pdHome>/service` 日志目录，目录创建失败则不写任何文件。
- Linux 生命周期：install 同写 `.service`+`.timer` 并以 `systemctl --user cat` **双侧证**两个 unit 被 manager 可见（含 `Unit=` 指针核对）；status 中 enabled 与 active 独立取证、独立失败分类（OS 查询失败≠未注册）。uninstall=disable 结果核对→not-enabled/not-active 复核→删 unit→daemon-reload→cat 复核为零。
- 重叠触发由 Phase 1 安装级单实例锁收敛（第二个 coordinator 返回 `already_running`，退出码 0）；任务级并发仍由既有 Durable Lease 保护。触发语义 **at-least-once**。
- Windows 任务策略 `MultipleInstancesPolicy=IgnoreNew`、`ExecutionTimeLimit=PT8H`（自身有界预算之外的兜底）。
- managed 执行严格只消费 `effectiveOwner=service_host` 且 `service_host_owned` 且发现判定 authorized 的 Workspace；`legacy_owned` 跳过（保留旧所有者）；`handover_preparing`/`rollback_pending` 禁止消费；manifest/marker 不可读 → 整次运行 fail-closed（不是"零 Workspace"）。

## 4. 安装器与升级

- 安装器**不自行实现**调度器逻辑：通过桥接调用刚安装的 CLI（`service … --json --pd-home <trusted>`；子进程环境剥离 `PD_EXPERIMENT_ROOT`/`PD_WORKSPACE_DIR`）。
- 注册/启用需**显式同意**：`--register-service-host`（注册为 disabled）/ `--enable-service-host`（注册并启用）。无旗标时安装器绝不创建注册。
- 升级（同一条 install 提交路径）只做 **refresh-if-registered**：已注册才幂等刷新（入口路径稳定于 `<pdHome>/runtime`）；**刷新保留现场调度配置**——从实时 `pd.service-status.v1` 读回 intervalMs 与 enabled（各平台适配器以 OS 见证解析，非“重装默认”）；状态文档不可读 → fail-closed（不猜默认值）；刷新失败保留最后有效注册并告警（ERR-197：提交后失败是告警，不是安装失败）。
- 卸载：仅当共享 Runtime 将被移除时，先于 Runtime 移除撤销调度器注册；host-scoped 卸载（其他 Host 仍用共享 Runtime）**保留**注册。撤销失败 → 告警 + 手工移除指引（`schtasks /Delete` / `launchctl bootout` + 删 plist / `systemctl --user disable --now` + 删 unit）。

## 5. 状态契约与读取（Companion / Console / CLI 同源）

统一只读契约：`pd service status --json`（`pd.service-status.v1`）。每个子句来自**自己的见证**：

| 字段 | 见证来源 |
|---|---|
| registered / enabled / **osActive** / triggerInterval / OS lastRun | OS 调度器本体（Task Scheduler / launchctl / systemctl；enabled 与 osActive 独立见证，任一查询失败 → `null`+degradedReasons，绝不由另一字段推断） |
| lastRun（outcome/mode/triggerSource/triggerSourceCredibility） | `<pdHome>/service/run-once-status.json`（版本化运行状态；`triggerSourceCredibility:"self-declared"`——triggerSource 是运行方自报字段，非 OS 见证，审计时降级采信；refusal 同样落盘 outcome:`refused`） |
| lastProgressAt | 跨运行进展存储（`service/shadow-progress.json`）+ 最近 managed 执行 |
| Workspace owner 状态 | 现场只读发现（manifest + 已验证 claims） |

- registered ≠ enabled ≠ running ≠ completed ≠ business_progress；状态读取失败记 degraded（`degradedReasons`），权限拒绝**绝不**显示为未安装。
- **Console**：`GET /api/service-host/status`（只读，转调同一 CLI 实现；无任何生命周期写面）。
- **Companion**：读取同一契约（`pd service status --json` / 状态文档）；不拥有调度器生命周期、不建第二套定时器、不接管 Worker。Companion 内嵌 UI 面板为后续项（本阶段交付契约与 Console 路由）。
- 状态查询不启动 Worker、不写业务数据。

## 6. 故障排查速查

| 症状 | 判定 | 处置 |
|---|---|---|
| `scheduler_query_failed:AccessDenied` | OS 拒绝读取/注册（非"未安装"） | 确认当前用户与任务存储权限；加固主机上非提升注册会被策略拒绝，需在允许的用户上下文操作 |
| `scheduler_task_name_conflict_foreign_task` | 同名任务非本安装所有 | 手工检查（`Export-ScheduledTask`）；PD 不覆盖外部任务 |
| `no_service_host_owned_workspaces` | 合法空执行 | 无需处置；所有权交接在 Phase 4/5（SPEC §8.4） |
| `install_manifest_*` / `active_release_*` 拒绝 | 可信前缀 fail-closed | 修复安装（`npx create-principles-disciple`）后再触发 |
| `already_running`（退出码 0） | 重叠触发被单实例锁收敛 | 正常行为，无需处置 |
| `service_host_cli_unparsable_json` / `service_host_cli_no_json:*` / `service_host_cli_schema_violation:*` | 桥接/Console 侧 stdout 契约失败：恰好一个 JSON 文档、post-parse schema 校验；多文档/混入日志/截断/空输出/非法字段各自分类 | 检查安装的 pd-cli dist 是否损坏或被替换；重新安装；**绝不**按“未注册”处理 |
| `service_host_cli_refused:<reason>` | CLI 结构化拒绝（exit≠0 但 JSON 合法）透传 | 按 `<reason>` 对照上表处置 |
| `systemd_manager_cannot_see_unit` 类拒绝 | `systemctl --user cat` 双侧证失败（unit 写了但 manager 不可见） | 检查 user manager 会话与 unit 目录权限 |
