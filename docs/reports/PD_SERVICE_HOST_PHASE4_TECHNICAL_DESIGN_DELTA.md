# PD Service Host Phase 4 — Technical Design Delta（Stage 1）

- **日期**：2026-11-22；工单 PRI-1282；基线 `0102002b9`
- **输入**：Stage 0 审计（`PD_SERVICE_HOST_PHASE4_SOURCE_AUDIT.md`）、SPEC v0.3、TD、Owner 执行指令（2026-11-22）
- **地位**：本文件是 Phase 4 的实施设计增量；与 SPEC/TD 冲突处以"§1 阶段归属修正"为准，并同步回改 SPEC/TD（本 PR 内完成）。

---

## 1. 阶段归属冲突的关闭（CAS）

**冲突**：SPEC §8.4 第 10 条把 owner marker CAS 写路径列为 Phase 5；TD §9 与 PRI-1282 要求 Phase 4 完成 OpenClaw 交接——没有 CAS 无法安全交接。

**裁决（Owner 执行指令 §3.1）**：
- **Phase 4**：实现**最小、可复用**的 Owner State CAS / Transition 原语（`@principles/install-layout` 内），并用它完成 OpenClaw 逐 Workspace 交接。
- **Phase 5**：**复用同一原语**完成 Codex / WorkBuddy 交接与 Companion Worker Registry 退役；禁止重复实现。
- SPEC §8.4 第 10 条、§11 Phase 4/5 条目与 TD §9 措辞同步修正（"CAS 写路径未实现属 Phase 5"→"原语已随 Phase 4 落地，Phase 5 复用于 Codex/WorkBuddy"）。不发明第二套状态机：状态集、字段、语义完全沿用 SPEC §8.4（`legacy_owned | handover_preparing | service_host_owned | rollback_pending` + `{state, effectiveOwner, generation, operationId, previousOwner, targetOwner, updatedAt}`）。

## 2. Owner State CAS / Transition 原语（install-layout 新模块）

新文件 `packages/install-layout/src/background-execution-transition.ts`（install-layout 是 manifest SSoT、零依赖包，是唯一合理归属；pd-cli / handover 命令 / Phase 5 全部消费它）。

### 2.1 跨进程互斥（CAS 的物理层）

`<pdHome>/install.json.cas.lock/`（**目录锁**，`fs.mkdirSync(..., {recursive:false})` = O_EXCL 原子创建，与 git-12 `pd-worktree-mutation.lock` 同型）：
- 锁目录内 `owner-<token>.json`：`{schema:'pd.background-execution-cas-lock/1', pid, host, operation, workspaceDir, createdAt, token}`。
- 已存在 → 报错并输出持有者信息（operation/pid/host/age）；**TTL（默认 30s）后视为 stale 可安全移除**——CAS 临界区是毫秒级文件操作，TTL 只覆盖崩溃残留；移除前必须重读 owner json 确认 token 与年龄（防 ABA）。此语义**不同于** git-12 的"永不自动删"：那里的操作是分钟级 worktree 变更，这里是亚秒级且 manifest 本身有 generation fencing 兜底（stale 锁误删最坏结果是并发 CAS，仍会被 generation 校验拒绝）。
- 临界区内**绝不**执行 spawn/build/test。

### 2.2 逻辑 CAS（generation fencing）

`transitionWorkspaceBackgroundExecution({pdHome, workspaceDir, from: {state, generation?}, to, operationId, platform?})`：
1. 取锁（§2.1）；
2. 读 manifest（fail-closed：malformed ≠ empty）；
3. 校验前置：目标 workspace 在 `workspaces[]`（handover-begin 负责 merge 注册）；当前记录匹配 `from.state` 与 observed `generation`（不匹配 → `stale_generation` / `unexpected_state` 拒绝，旧 generation 无权写入）；
4. **operationId 幂等**：`to.state` 已是该 operationId 的目标终态/中间态 → no-op 返回当前事实（重放安全）；
5. `setInstallManifestBackgroundExecution`（既有单键写辅助）写新记录：`generation+1`、updatedAt；
6. **原子落盘**：序列化（保留未知顶层字段——read-modify-write 全量对象经 parse 后重写，`unknownHosts` 等经既有 persist 辅助保留）→ temp 文件 + `renameSync`；
7. 释放锁；
8. 返回 `{ok, record, previous}`；任何失败保留先前 manifest（rename 前抛错=未写；rename 后校验失败=已在盘，返回实际状态供审计）。

**并发保证**：两个并发 transition 只有一个能同时持锁；锁内 generation 校验使后进者因 observed generation 过期被拒——两个都声称成功的窗口不存在。测试用真实双进程验证（见测试矩阵）。

### 2.3 所有权只读 reader（三方共用）

`readWorkspaceBackgroundOwnership({pdHome}, workspaceDir)` →
`{status:'legacy_owned', source:'no_record'|'record', record?}` | `{status:'handover_preparing'|'service_host_owned'|'rollback_pending', record}` | `{status:'manifest_unreadable', reason, nextAction}`。
消费者：Gateway 门禁（§6）、openclaw worker 门禁（§4）、handover/rollback 命令、managed-run（沿用既有 owner-projection——投影逻辑不改，仅 handover 命令直接用本 reader 读单 workspace）。

### 2.4 与 installer 写路径的共存（ERR-168）

审计确认 installer/update 用普通 `writeFileSync` 全量写。共存规则：**installer 的读-改-写本来就重读当前文件再合并**（`mergeIntoInstallJson` merge 语义）；残余风险=installer 读后、写前有 CAS 落盘 → installer 覆盖丢 marker。缓解：(a) installer 写路径改经同一把 CAS 锁（最小改动：写 manifest 前 acquire/release）；(b) 回归测试走真实 load-modify-save 调用路径断言 backgroundExecutions 子段在并发 installer 写后存活。**(a)(b) 都做**（改动小、风险不对称）。

## 3. Host Binding 权威（不新增第二权威）

- 发现权威 = 既有双源：manifest + `collectHostWorkspaceClaims`（已含 OpenClaw `mcp-binding.json` 全量校验）。**不实现 manifest `workspaceBindings`**（PRI-1282 允许的条件不成立：现有 claim 发现已满足）。
- OpenClaw workspace 进入 manifest 注册集的**唯一新写点**：handover-begin 在写 `handover_preparing` 的同一临界区内经 `mergeInstallManifestWorkspaces` 注册（安装器的既有注册路径，原子单次写）。理由：managed 准入域=manifest 注册集（Phase 3 既有语义）；未注册的 OpenClaw workspace 不可被 scheduler 执行，也就不可交接。
- Host Binding（接入授权）与 backgroundExecutions（生命周期所有者）保持两个权威，互不推断。

## 4. OpenClaw Worker（Stage 3 设计）

### 4.1 代码归属

| 件 | 位置 | 理由 |
|---|---|---|
| `runOpenclawWorkspaceWorkerCycle` + liveness 读写 + status 计算 | `packages/openclaw-plugin/src/openclaw-worker.ts`（新），exports map 新条目 `./openclaw-worker` | codex/workbuddy 的 cycle 都在各自 adapter 包；OpenClaw 的 adapter 包就是 `principles-disciple`。tsc 直接产出 `dist/openclaw-worker.js`（build=纯 tsc，审计证实），无新包（ERR-196 规避） |
| CLI 命令 `pd openclaw worker` | `packages/pd-cli/src/commands/openclaw-worker.ts` + program.ts 注册 | 镜像 codex-worker.ts；**lazy import** `principles-disciple/openclaw-worker`（run-rulehost 先例：避免每次 pd 启动加载插件包） |
| service-host host config | `packages/pd-cli/src/services/service-host/worker-adapter-openclaw.ts` | liveness 文件名 `openclaw-worker-liveness.json` + 证据提取 |

**工具语义 SSoT**：常量定义不动（`openclaw-plugin/src/constants/tools.ts`、`tool-semantics.ts`；`check-tool-semantics-authority.mjs` DECLARATION_FILES 不变）。worker **从插件包 import 同一定义**——禁止在 worker 维护第二份列表（指令 §4.2）。pd-cli→principles-disciple 依赖边已存在（package.json:33），无新边；service-host 协调层（managed-run/worker-adapter）**不** import 插件代码——只 spawn `openclaw worker` 子进程（与 codex/workbuddy 同型）。

### 4.2 周期流程（实现映射指令 §5.2 的 22 步）

```
1-4   参数解析/canonical workspace 校验/discovery 确认/foreign owner → CLI 层（--workspace 必须 canonical absolute；非授权 discovery → refuse）
5-6   owner marker 门禁 → readWorkspaceBackgroundOwnership：
        非 service_host_owned → refuse（legacy_owned 也拒绝：防手动直跑造成双消费者）
        manifest_unreadable → refuse（fail-closed）
7     读 .pd/config.yaml（共享周期内部再查 flag；malformed → paused/degraded）
8-9   declaration：saveHostToolDeclaration(OPENCLAW_TOOL_SEMANTIC_MAPPINGS)（worker 每周期刷新，codex 同型，
        TD §4.2 "可直接搬进 worker cycle" 明示）→ load+校验（version≤2、hostKind、mappings）；失败 → degraded（rc-9）
10-12 host capability：compiled constants（lazy import 自插件包）构 catalog/semantics/hostKinds；
        behaviorEvidence = createWorkspaceBehaviorEvidencePort(workspaceDir, OPENCLAW_TOOL_SEMANTICS)
        （host-neutral 只读 trajectory 端口，codex 生产同型；传 compiled registry 保证与 Gateway 端口 parity，
        避免多宿主 merge 语义差异）
13-15 pause/flags/capability/consent：共享周期自查 internalization_auto_consumer/capability；
        L3 自查 openclaw_diagnostician_consumer + automatic_hook consent（runPendingDiagnosticianOnce 内建）
16-17 runInternalizationConsumerCycle(ports{owner:'service-host-worker', logLabel:'OpenClawWorker',
        emitEvent=SystemLogger.log（插件同模块→交接后 SYSTEM 日志流连续）, hostToolCatalog, toolSemantics,
        hostKinds:['openclaw'], behaviorEvidence}) → runPendingDiagnosticianOnce
18-20 SystemLogger/Runtime State/Run 记录（周期内建）+ liveness 文件（.state/openclaw-worker-liveness.json，
        阶段期限+lastCycleDriver+PD_INVOCATION_SOURCE/PD_INVOCATION_ID 归因，codex 同型）
      → finally: dispose 证据端口只读连接（端口内部 per-assemble 事务，无注册表单例）
21-22 唯一 JSON stdout（--json）→ 进程退出
```

**不做**：trajectory retention（插件 hook 路径已调度，handover 后仍在；加了=重复）；catch-up/reconcile 拉取宿主转录（OpenClaw 轨迹由 hook 实时写入 trajectory.db，无离线 catch-up 概念——与 Gateway 周期 parity）；`host.openclaw` 新 flag（不存在，不发明）。

### 4.3 结果合同

复用 `pd.worker-adapter.v1`：worker `--once --json` stdout 输出 codex/workbuddy 同型的 `{mode:'ready'|'paused'|'degraded', reason?, nextAction?, report:{...}}` 文档；managed/shadow 侧的 outcome 映射零改动。语义区分（指令 §5.4）：
- `ready`+report.cycle.ran → 真完成业务周期；
- `ready`+ran=false → 正常无可处理任务（→ cycle_completed_without_business_progress）；
- `paused`（flag/owner pause）、`degraded`（declaration/config/凭据/证据缺失）→ truthful waiting；
- 非 0 退出/unparseable → failed。
**不**把进程启动成功当业务成功（进度证据走 liveness + task-state diff，既有 progress-evidence 通道）。

### 4.4 readiness 模式（no-consume 自检）

`pd openclaw worker --readiness --json --workspace <dir>`：执行步骤 1-13 + capability 探测（凭据解析检查、declaration 校验、adapter import），**不进入** 16-17。输出 `{mode:'ready'|'degraded'|..., checks:{declaration, config, credentials, evidencePort, ownership}}`。供 handover 第 8-13 步（经 active-release 入口 spawn 执行——同时证明安装态接线）。

## 5. Adaptive Timer 迁移决策（Stage 5）

**决策：V1 固定 OS 周期（默认 120s，scheduler 既有默认），不持久化 Gateway 内存 timer 状态，不新增 Timer Service/Queue/常驻循环。**
- 依据：PRI-1282 明示两条路二选一；持久化 3 个计数器需要跨进程一致的新状态文件 + 与固定触发共存的双轨语义，复杂度不成比例（P7/P8）。
**义务（量化记录，不虚构）**：
1. 离线对照：真实 `nextConsumerDelay` 纯函数重放事件迹（正常 backlog/大 backlog/连续空/限流/连续失败），对比固定 120s 的 Queue Wait P50/P95、Worst Trigger Delay、Retry Interval、Failure Recovery Time；
2. 在线实测：真实 worker 周期跑场景 1-10（指令 §7.1），测 Duplicate/Lost Task Count（task-state diff 证据）；
3. 报告如实记录语义变化（backlog 15s 短延迟→固定 120s 上界；failure 退避 300-600s→固定周期重试），若不满足既有业务延迟要求，提出**最小 operational status 扩展**建议（如 scheduler interval 调优），不偷渡 Gateway timer。

## 6. Gateway AutoConsumer 生命周期迁移（Stage 4 设计）

### 6.1 Owner marker 门禁（三个读取点，全部 fail-closed）

`InternalizationAutoConsumerService`：
1. **start() 早期**（workspaceDir/实验隔离之后、declaration 持久化可之前）：`readWorkspaceBackgroundOwnership` → 非 `legacy_owned` → 记 SystemLogger `INTERNALIZATION_CONSUMER_OWNERSHIP_BLOCKED` + 写 quiesce ack（见 6.2，state 匹配时）+ return。`manifest_unreadable` → 同样拒绝（fail-closed：不可判定 ≠ legacy）。
2. **每次 timer tick 前**（runCycle 入口）：同上重读；阻断态 → 停止该 workspace 链（不再 scheduleNext）+ 写 ack。
3. **scheduleNext 前**：同 2（双保险，覆盖 tick 内状态翻转）。
只影响目标 workspace 的消费链；CorrectionObserver/Trajectory/PDTask 服务与全部 hook **不动**（指令 §6.1）。
manifest 读取用 `resolvePdHome()`（host-runtime 已 re-export；与插件自身实验隔离守卫同源）。跨模式双消费者已由实验隔离守卫关闭（实验态 Gateway 拒绝生产 workspace，审计 §2.5）。

### 6.2 Quiesce 协议（可审计的"旧消费者已停止"）

`WorkspaceConsumerState` 增加 `inFlight: Promise<void> | null`（runCycle 执行期非空）。阻断态被观察到时：
1. `state.quiescing = true`（停新 tick）；
2. 等待 in-flight cycle（**有界** `QUIESCE_WAIT_MS`，默认 10min——覆盖最长周期+失败上限的余量；超时 → ack 记 `outcome:'in_flight_timeout'`，**不伪造取消**，handover 据此 fail-closed 中止）；
3. in-flight=0 后写 ack：`<workspace>/.pd/gateway-quiesce-ack.json`，schema `pd.gateway-quiesce.v1`：`{schemaVersion, workspaceDir, state, operationId, generation, inFlightCycles:0, completedAt, outcome:'quiesced'|'in_flight_timeout', writer:{hostKind:'openclaw', pid, startedVia}}`（原子 temp+rename）。
4. ack 绑定 marker 的 operationId+generation → 重放/过期 ack 可检测。

**证据规则**（指令 §6.2）：clearTimeout/PID 不存在/进程退出/固定延迟/stop() 返回均不构成停止证明；唯 ack 文件（含 operationId/generation/in-flight=0）或"start 拒绝路径写 ack"构成。**Gateway 全程未运行**的 handover → 无 ack 写者 → handover 命令 fail-closed BLOCKED（nextAction：启动 Gateway 令其确认，或在其运行时重试）。重启安全：start 门禁在任何新进程消费前读 marker（§6.1.1），且拒绝时同样写 ack（fresh 进程的"我不会消费"证明）。

### 6.3 stop() 语义

Gateway 生命周期 stop() 保持现状（清 timer）；quiesce 协议服务于交接，不改变 stop 合同。多 workspace 独立（既有行为，审计 §2.5）。

## 7. Handover / Rollback 命令（Stage 6/7）

新 CLI：`pd service handover --workspace <canonical-dir> [--json]`、`pd service rollback --workspace <canonical-dir> [--json]`（真实 Commander 注册测试，cli-1/2/6/7）。

### 7.1 Handover 序列（指令 §8.1 的 24 步 → 实现分组）

| 步 | 动作 | 实现 |
|---|---|---|
| 1-6 | 读 marker/验证 generation/operationId/workspace 身份/Host Binding | reader（§2.3）+ `findForeignWorkspaceOwner`（openclaw claim 必须在场且无外宿主冲突） |
| 7 | 写 HANDOVER_PREPARING | transition 原语（同一临界区内 merge 注册 workspaces[] + 写记录；operationId=uuid；effectiveOwner 保持 legacy） |
| 8-13 | Service Host no-consume readiness + active release/adapter/declaration/配置凭据/环境验证 | spawn 经 `resolveActiveReleaseCliEntry` 的 `openclaw worker --readiness --json`；非 ready → 中止（CAS 回写 legacy_owned 恢复，或保留 preparing 等待重试——选择**中止回写**，理由：准备态是短窗口，不可无限悬挂；崩溃恢复见 7.3） |
| 14-16 | Gateway 停目标 workspace 消费 + 等 in-flight + 验证 ack | 等待 ack 文件出现（轮询，deadline=QUIESCE_ACK_WAIT_MS 默认 15min：覆盖 idle 120s tick 间隔+周期+余量）；ack outcome 非 quiesced → 中止回写 |
| 17 | 验证旧消费者不再具备执行资格 | ack（含 state/operationId/generation 绑定）+ tick 门禁语义 |
| 18-19 | CAS generation+1 + effectiveOwner=service_host | transition 原语 |
| 20 | Service Host 获得执行权 | marker 即权威（无额外国旗） |
| 21 | 交接完成证据 | handover 报告写入 `<pdHome>/service/handover/<workspace-key>/<operationId>.json`（operationId 键控、追加只读），内容=全步骤事实与产物路径 |
| 22-23 | 真实 Worker Cycle + Task/Run/Artifact 验证 | spawn `openclaw worker --once --json`；progress-evidence 断言 task 状态真实变化（或如实记 no_work——空 workspace 合法，但不能伪造进展） |
| 24 | 确认 Gateway 不再 tick | worker 周期内再读 marker=service_host_owned + ack 仍在；SystemLogger 无新 SCHEDULE 事件（报告记录） |

### 7.2 Rollback 序列（指令 §九）

1-3 停 Service Host 新周期（对 openclaw：确认无 in-flight worker 子进程——由 worker 进程自身有界+marker 门禁保证；rollback 命令等待活跃 invocation 完成）→ 4-6 写 ROLLBACK_PENDING + CAS 回 legacy（generation+1）→ 7-8 Gateway 重读 marker 重新注册（**插件无需主动拉起**：hook 初始化/下一个 prompt 路径在 legacy_owned 下自然重新武装 timer；rollback 命令验证方式=ack/`INTERNALIZATION_CONSUMER_STARTED` 或 freshness 检查，如环境不可达如实 NOT_VERIFIED）→ 9-13 验证恢复/无双执行/回滚完成证据（同 §7.1 21 格式）。**回滚失败保留 fail-closed 状态**（ROLLBACK_PENDING 不自动清）。

### 7.3 崩溃恢复矩阵（指令 §8.3 的 9 个注入点）

恢复权威=持久化 `state + operationId + generation`（handover 命令重跑或 `pd service handover --resume`）：
- PREPARING 写入前崩溃 → 无记录，视为 legacy，重跑即新交接；
- PREPARING 后/readiness 期间/quiesce 等待期间崩溃 → 重跑同 workspace：读到 preparing → 幂等续跑（operationId 已在记录中，复用）；若决定放弃 → `--abort` 走回写；
- ack 写入后/CAS 前崩溃 → 重跑：见 preparing+ack 已在 → 直接进入 CAS 步；
- CAS 后崩溃 → 重跑：已 service_host_owned 且 operationId 匹配 → 续走 worker cycle 验证；
- 首次消费期间/completion evidence 写入期间崩溃 → worker 有界+lease recovery 收敛；重跑补齐 evidence（operationId 键控幂等）。
**禁止**以进程存在性推断所有权（全部走 marker）。

## 8. Managed/Shadow 集成

- `MANAGED_WORKER_HOST_KINDS = ['codex','workbuddy','openclaw']`（managed-run.ts:425 与 :161 的声明过滤改用此常量）；**shadow 保持 `WORKER_HOST_KINDS=['codex','workbuddy']`**（shadow-run.ts:458/183/77 不动语义，仅改名引用以显式区分）。`--host openclaw` 于 shadow → 既有 invalid-host 拒绝路径（指令 §8.5 防误执行）。
- openclaw adapter 的 `supports()`：走既有 claimingHosts/declaredHostKinds 证据（openclaw claim 或 openclaw.json declaration 任一在场即支持）。
- worker-env：openclaw 不需要 CODEX_HOME/WORKBUDDY_CONFIG_DIR 钉入（worker 不读宿主配置目录）；OPENCLAW_* 已在 POINTER 剥离集。凭据链=既有 getEnvVar 模式。

## 9. 测试矩阵（Stage 8，对应指令 §八）

| 类 | 内容 |
|---|---|
| Unit | transition 原语（状态/组合/generation fencing/operationId 幂等/锁 stale/原子性）；reader 三态+fail-closed；worker cycle 门禁（marker/declaration/config/凭据缺失→degraded/paused truthfully）；liveness 读写；quiesce 状态机（in-flight 追踪/超时 outcome）；ack 文件 schema |
| Integration | CLI→worker（真实 Commander+真实 dist 子进程）；worker→host-runtime（真实 state.db）；worker→trajectory（只读端口，真实 sqlite）；Gateway 门禁（真实 manifest 文件）；handover 命令端到端（隔离 pdHome+workspace）；scheduler→run-once 既有回归 |
| Concurrency | 双进程 CAS 竞争（恰一个成功）；双 handover 并发；旧 generation 写入被拒；Gateway tick 与 handover 并发（注入延迟）；worker crash + lease recovery |
| Fault injection | marker 损坏/manifest 不可读/identity 不匹配/declaration 缺失与版本不兼容/凭据缺失/provider 不可用/ack 缺失/超时/CAS 冲突/SQLite 异常/资源未释放（句柄泄漏断言） |
| Regression | codex/workbuddy adapter 全套既有测试；shadow-run（确认 openclaw 不可选）；managed-run 准入矩阵；scheduler/console status；OpenClaw plugin hooks（既有 plugin 测试套件）；**parity**：worker ports 与 Gateway runConsumerCycle ports 逐字段断言（catalog/semantics/hostKinds/emitEvent 目标/owner 差异=归因）+ 声明映射一致 |

## 10. 真实安装验收（Stage 9）

- stamped release（npm pack 或本地 staged 安装）→ `resolveActiveReleaseCliEntry` 真实解析；
- 场景 A（Gateway 不运行独立消费）/B（shadow parity 对比）/C（隔离环境完整 handover）/D（强杀 worker 恢复）/E（rollback）/F（多 workspace 单迁移）；
- 平台门禁保留：Windows Scheduler 生产翻转需真实触发证据；macOS/Linux 无真机 → 代码+隔离 handover 完成即可，生产翻转保留 BLOCKED/NOT_VERIFIED（指令 §11.3）。

## 11. Complexity Delta（预告）

新持久化真相源：无（marker=manifest 既有字段；ack/handover evidence=过程证据文件，非所有权权威）。新子系统：无（无 daemon/queue/timer service）。新公共抽象：`principles-disciple/openclaw-worker` subpath、install-layout transition 原语、两个 CLI 命令（handover/rollback）、worker --readiness 模式。新跨包依赖：无（全部复用既有边）。回滚：marker CAS 回 legacy + 插件版本回退（declaration/门禁随发布走）。
