# PD Service Host Phase 4 — Source Audit (Stage 0)

- **日期**：2026-11-22
- **工单**：PRI-1282（Phase 4 — OpenClaw Worker 解耦、Gateway AutoConsumer 迁移与 Parity）
- **基线**：`0102002b955570eb608f644b87c509ff3a9a1b01`（PR #2743 merge commit = origin/main）
- **性质**：只读源码审计。所有结论均有 `file:line` 证据；行号对应该基线。
- **审计方式**：三个并行只读探查 + 关键文件人工复核 + `npm run error:context` 路由（Pass 1）。

---

## 0. Error Context 路由结果（Pass 1，计划模式）

- **EP-02 HIGH**：生产入口必须真实消费变更机制；跨包消费者必须验证；禁止只用 helper 测试。其中 **ERR-168**（whole-object load→modify→save 与锁定单写者并存时，通用 save 路径必须以锁时当前值保留该子段）直接命中本阶段 manifest CAS 与 installer 写路径的共存问题。
- **EP-03 HIGH**：rc-9（所有拒绝/降级带结构化 reason + nextAction）；ERR-182（状态行每个子句来自自己的 witness 字段，且必须测 disagreeing 组合）。
- **EP-04 MEDIUM**：cli-1/cli-2/cli-7（真实 Commander 注册测试、exit 后终止控制流、--json 单文档）。
- **EP-12 MEDIUM**：宿主管理路径写入须引用宿主规则；PD 数据在 discovery 根之外。

## 1. Git 基线与环境

- `origin/main` HEAD = `0102002b9`（PR #2743，PRI-1281 Phase 3）✅；Phase 1/2/3 均已合并。
- 本阶段 worktree：`D:\Code\_worktrees\principles\PRI-1282-openclaw-worker`，分支 `ai/PRI-1282-openclaw-worker`，writer=zcode，lease/git lock 已持有。
- 环境事故记录：创建 worktree 时 git-12 共享元数据被一个 **stale 锁**阻塞（pid 89420 `worktree-remove`，07:02Z 创建；`tasklist` 证实进程已死，锁龄 ~1h45m）。按 Owner 端到端执行指令，以确定性证据（pid 不存在）移除该 stale 锁后创建成功。PRI-1058 worktree 本体未受影响、未触碰。
- Phase 3 遗留事实保留：Windows 真实安装态 Scheduler 注册 + ≥1h 观察窗待补；macOS/Linux 真机 NOT_VERIFIED（`docs/reports/PD_SERVICE_HOST_PHASE3_ACCEPTANCE_20261122.md`）。

## 2. OpenClaw Plugin — 现状（A 区）

### 2.1 AutoConsumer 的注册与启动

| 事实 | 证据 |
|---|---|
| Gateway service 注册（surface-guarded，`core` 类默认启用） | `packages/openclaw-plugin/src/index.ts:946-947`；`principles-core/src/runtime/feature-flags/plugin-surface-registry.ts:126-133` |
| 每 Workspace 首个 prompt 经 hook 初始化启动 | `index.ts:602-622`（`persistOpenClawToolDeclaration` → flag 门 → `start()`） |
| `start(ctx)`：workspaceDir 必需 → 实验隔离守卫 → 持久化 declaration → 幂等检查 → `internalization_auto_consumer` flag 门 → 重置 adaptive 计数 → 首轮 setTimeout 30s（unref） | `service/internalization-auto-consumer-service.ts:180-357`（INITIAL_DELAY=30_000 在 :36） |
| `stop(ctx)`：**只**置 `stopped`、`clearTimeout`、删 Map 项；**不等待 in-flight cycle** | 同文件 `:359-377`；in-flight `runCycle()` 继续跑完（入口 `:273` 检查 `state.stopped`；`scheduleNext` `:241` 直接 return） |

### 2.2 Workspace 纳入消费的数据流

事件驱动、lazy、无 Gateway 配置清单：每个 hook 事件经 `resolveHookWorkspaceDir`（fallback 链：`ctx.workspaceDir` → `resolveAgentWorkspaceDir('main')` → `PD_WORKSPACE_DIR` → `OPENCLAW_WORKSPACE` → `~/.openclaw/principles-disciple.json`，`utils/workspace-resolver.ts:321-442`）解析 workspace → 首个 prompt 触发 init → flag 开启则启动 timer chain。每周期自行打开 `<ws>/.pd/state.db`（`host-runtime/src/internalization-consumer-cycle.ts:445`）。`mcp-binding.json` 与消费无关（它是 pd-recall MCP 绑定，`index.ts:180-231`）。

### 2.3 消费周期调用链

```
timer tick (runCycle, service:272)
 → runConsumerCycle (service:109)
   → runInternalizationConsumerCycle(workspaceDir, ports)  [host-runtime:354]
     ports: emitEvent=SystemLogger.log (service:118)
            hostToolCatalog={readOnly: READ_ONLY_TOOL_NAMES,
                             write: LOW_RISK+HIGH_RISK+AGENT} (service:119-122)
            toolSemantics=OPENCLAW_TOOL_SEMANTICS (service:125)
            hostKinds=['openclaw'] (service:127)
            behaviorEvidence=lazy BehaviorExamplePackAssembler facade
              (= 共享装配器 + TrajectoryRegistry.get(ws) + OPENCLAW_TOOL_SEMANTICS,
                 service:135-147; facade core/behavior-example-pack-assembler.ts:12-16)
     内部：flag 门(385) → config(401/413) → state handle(445) → orchestrator(453)
           → queue snapshot(458) → computeConsumerDecision(484) → wakeOnce 各 kind
           → runner.run(1099)（lease 在 runner 内获取）→ finally: recovery sweep + 对账(1157-1167)
 → onOutcome (service:152)
 → runPendingDiagnosticianOnce({workspaceDir})  [host-runtime/diagnostician-auto-run.ts:91]
   （自身检查 openclaw_diagnostician_consumer flag + capability + automatic_hook consent）
 → buildSignals → nextConsumerDelay (service:305) → SystemLogger SCHEDULE 事件 → scheduleNext
```

### 2.4 Gateway 进程内存态 vs 已持久化事实

| 仅存于 Gateway 内存 | 已持久化 |
|---|---|
| `workspaceStates` Map（consecutiveEmptyCycles/Failures/lastCycleDurationMs/lastDecision，service:44-54；每次 start 重置 :235-238） | `<ws>/.pd/host-tool-semantics/openclaw.json`（declaration v2，每次 Gateway 启动刷新，service:86-107 → host-runtime saveHostToolDeclaration 原子写） |
| timer chain（setTimeout 句柄，unref） | `<ws>/.pd/state.db`（task/run/lease/artifact/对账 cursor） |
| `startedWorkspaces` Set（index.ts:71） | `<ws>/.state/trajectory.db`（+blobs/exports） |
| `TrajectoryRegistry.instances` / `WorkspaceContext.instances` 单例 Map | `<ws>/memory/logs/SYSTEM_*.log`、`.pd/config.yaml`、`.pd/telemetry/critical-events.jsonl` |

### 2.5 重启行为与 owner marker 门禁（关键缺口）

- 重启后 **无任何持久化 workspace 枚举**：timer 只在 (a) Gateway service `start(ctx)`、(b) 每 workspace 首个 prompt 重新武装。declaration 每次启动重写；但 **plugin 从不回读 declaration**（`loadHostToolDeclarations` 在 plugin 内零调用点）。
- **owner marker / backgroundExecutions 门禁在 OpenClaw 侧确认未实现**：`rg "backgroundExecution|owner.marker|ownerMarker"` 在 `openclaw-plugin/src` 与 `host-runtime/src` 零命中。`start()` 只查 workspaceDir、实验隔离、幂等、flag——注册与 tick 前均不读所有权记录（SPEC §8.4 第 5 条标注的缺口属实）。
- 单 workspace 停止不影响其他 workspace（`workspaceStates` 按 workspaceDir 键控，stop 带 ctx 时只删对应项，service:359-368）。

### 2.6 插件包身份与既有消费面

- 包名 `principles-disciple` 4.2.1；exports：`.` / `./rulehost-evidence` / `./governance-audit`（package.json:8-21）。运行时依赖仅 typebox/better-sqlite3/commander/js-yaml/micromatch；`@principles/core`、`@principles/host-runtime` 是 devDependencies（Gateway bundle 由 esbuild 内联）。
- **pd-cli 已静态依赖 `principles-disciple: ^4.2.1`**（pd-cli/package.json:33），既有消费点：`runtime-init.ts:27`（静态）、`runtime-internalization-run-rulehost.ts:588`（**lazy** `import('principles-disciple/rulehost-evidence')`，理由：避免每次 pd 启动加载插件包）。→ Service Host 侧经插件包 subpath 消费**不新增依赖边**。
- `rulehost-evidence.ts:1-8` 导出 `BehaviorExamplePackAssembler`（OpenClaw facade）+ `TrajectoryRegistry as RuleHostEvidenceRegistry`。

## 3. Host Runtime / Core — 可复用能力（B 区）

| 能力 | 位置 | 复用判定 |
|---|---|---|
| 共享消费周期 | `host-runtime/src/internalization-consumer-cycle.ts:354-367`（ports 形态 :95-145） | 直接复用；host 特定输入只有 catalog/semantics/hostKinds/behaviorEvidence/owner/logLabel/emitEvent |
| L3 诊断 | `host-runtime/src/diagnostician-auto-run.ts:91-199` | 直接复用（自身带 flag/capability/consent 检查） |
| 证据装配器（真身） | `host-runtime/src/behavior-example-pack-assembler.ts`（接口 BehaviorExampleDataSource :48-54） | 复用；插件的 facade 只是 5 行 |
| **host-neutral 证据端口** | `host-runtime/src/workspace-behavior-evidence.ts:52-74` `createWorkspaceBehaviorEvidencePort(ws, semantics?)`：只读打开 trajectory.db（fileMustExist），semantics 未传时经 `resolveWorkspaceHostToolSemantics` 从 declaration 解析；**Codex worker 已在生产使用**（codex-adapter workspace-worker.ts:575-588） | **OpenClaw worker 的证据 seam**——无需 Gateway、无需 TrajectoryRegistry 写连接 |
| declaration 读/校验 | `host-tool-declaration.ts:98-150`（version>2 拒绝、v1 带警告兼容、mappings 校验、256KB 上限）+ `host-tool-semantic-resolver.ts:104-125`（merge 多宿主 declaration，冲突 fail-loud） | 复用为 declaration 校验门 |
| adaptive 调度策略（纯函数） | `host-runtime/src/adaptive-consumer-schedule.ts:154-227`（无 timer/无状态，头注 :8-12） | 仅用于对照测量，不迁移 |
| owner pause / flags / capability / consent 分工 | 共享周期自查 `internalization_auto_consumer`/capability/config（cycle:385-441）；**宿主级 pause 是调用方职责**（codex 查 `host.codex` :295-315，workbuddy 查 `host.workbuddy`；**不存在 `host.openclaw` flag**——OpenClaw 的 pause 权威即 `internalization_auto_consumer`） | worker 不发明新 flag（SPEC §10.7） |
| Trajectory retention | **插件 hook 路径**已按 workspace 调度（`index.ts:631-634` `scheduleTrajectoryRetentionForWorkspace`）；消费路径不跑 retention | worker **不加** retention（handover 后 hook 仍在 → retention 仍在；加了反而重复） |

**Codex/WorkBuddy worker 的既有 CLI-subprocess 模式**（`codex-adapter/src/worker/workspace-worker.ts:278+`、`workbuddy-adapter/src/worker/workspace-worker.ts:257+`）：eligibility→liveness 文件（原子写、阶段期限）→`PD_INVOCATION_SOURCE` 归因→flag/capability 门→recovery sweep→诊断 bridge（`getEnvVar: process.env` 凭据链）→declaration 持久化（**worker 自己每周期刷新**，失败降级）→共享周期 ports。这是 OpenClaw worker 的结构模板。

## 4. pd-cli / Service Host（Phase 1–3，C 区）

- **目录**：`packages/pd-cli/src/services/service-host/`（24 文件：run-once/shadow-run/managed-run/workspace-dispatch/worker-adapter[-codex|-workbuddy]/worker-env/worker-process/locking/status/scheduler/*）。
- **派发**：`dispatchWorkspaceAdapters`（workspace-dispatch.ts:63-105）按 hostKinds 串行有界派发；adapter 是普通 `Record<WorkerHostKind, WorkerAdapter>`（managed-run.ts:629-632 构造）。子进程命令 = `node <active-release-entry> <hostKind> worker --once --json --workspace <dir>`（worker-adapter.ts:484-490）；`resolveActiveReleaseCliEntry` 只认安装入口（:210-229）。
- **`WORKER_HOST_KINDS = ['codex','workbuddy']`**（worker-adapter.ts:39-40）同时被 shadow（:458 hostFilter 校验）与 managed（:425 全量）使用——**本阶段必须拆分**：shadow 保持 codex|workbuddy，managed 扩展 openclaw，否则 Phase 2 shadow 会意外执行 OpenClaw（指令 §8.5 明确风险）。
- **worker 结果合同 `pd.worker-adapter.v1`**（worker-adapter.ts:37,95-125）：outcomes = `cycle_completed | cycle_completed_without_business_progress | paused | degraded | failed | timeout | cancelled | unavailable`；fail-closed JSON 解析守卫 :544-568；liveness 关联校验 :671-675。
- **managed 准入**（managed-run.ts:373-425）：仅 manifest 注册集 + `owner.state==='service_host_owned' && effectiveOwner==='service_host'` 才执行；conflict/legacy/过渡态全部 skip 且带 nextAction。**OpenClaw workspace 通常不在 manifest.workspaces[]**（安装后运行时绑定不回写）→ handover-begin 必须以既有 `mergeInstallManifestWorkspaces` 注册该 workspace（既有注册路径，非新权威）。
- **环境白名单**（worker-env.ts）：POINTER_ENV_VARS（PD_EXPERIMENT_ROOT/PD_WORKSPACE_DIR/OPENCLAW_*/HOME/USERPROFILE/CODEX_HOME/WORKBUDDY_CONFIG_DIR 等）一律剥离；凭据名模式 + workspace config `apiKeyEnv` 放行；`PD_INVOCATION_SOURCE='service_host'` 钉入。
- **scheduler 调用面**：`schedulerInvocationArgs` → `<cliEntry> service run-once --json --trigger scheduler --pd-home <home>`（scheduler/contract.ts:124-133），默认 120s（下限 60s）。

## 5. Installer / Manifest（D 区）

- `backgroundExecutions` schema **已落地**（install-layout/src/index.ts:82-90,270-374）：4 状态语义组合校验、按 canonical workspaceDir 键控、legacy 单键迁移（歧义 fail-closed）；`setInstallManifestBackgroundExecution`（:383-394）单键纯函数写辅助（**当前无生产调用方**）。
- **CAS/状态机迁移逻辑确认未实现**（index.ts:48-55 doc 注明 Phase 5）；`generation` 只被解析/投影，从不 compare-and-swap。
- **manifest 写路径现状**：installer `writeInstallManifest` 用普通 `writeFileSync`（create-principles-disciple/src/installer.ts:383-397）；update 侧 `mergeIntoInstallJson` 同为普通写。→ **CAS 必须自带跨进程互斥 + 原子 rename**，且按 ERR-168 要求处理与 installer whole-object 写的并存（见 §8 风险 R-3）。
- **发现权威**：`collectHostWorkspaceClaims`（mcp-binding-contract.ts:553-606）三类 claim（default/host_declaration/payload_binding，含 OpenClaw `mcp-binding.json` 全量校验）+ `findForeignWorkspaceOwner`（realpath 身份、跨宿主歧义拒绝）已可用——**满足 PRI-1282 "优先复用 per-host binding claim" 的要求，不新增 workspaceBindings 第二权威**。
- **Host Binding ≠ Lifecycle Owner**：两者已分离（claims 表达接入授权；backgroundExecutions 表达唯一后台生命周期所有者）。

## 6. 生命周期缺陷清单（本阶段要修的）

| # | 缺陷 | 影响 |
|---|---|---|
| D-1 | Gateway 注册/tick 前不读 owner marker | 交接后 Gateway 重启会复活消费 → 双消费者 |
| D-2 | `stop()` 不等待 in-flight cycle、无可审计停止证据 | 无法证明"旧消费者已停止"→ CAS 翻转前提不可验证 |
| D-3 | adaptive 调度状态（空周期/失败计数）纯内存 | 迁移后语义丢失（Stage 5 决策：V1 固定周期 + 真实测量记录） |
| D-4 | OpenClaw 无独立 worker 入口（`pd openclaw worker` 不存在，program.ts 无注册，WORKER_HOST_KINDS 无 openclaw） | Gateway 是 OpenClaw workspace 后台消费的必要运行条件 |
| D-5 | OpenClaw worker 无 liveness 记录（TD §2.3 明确 Adapter 合同落地前必须补齐） | FR-10 健康判定失真 |
| D-6 | CAS/generation fencing 缺失 | §8.4 原子交接无法执行（阶段归属冲突见设计文档） |

## 7. 可直接复用 / 需抽离 / 最小新增

**直接复用（零改动）**：runInternalizationConsumerCycle、runPendingDiagnosticianOnce、createWorkspaceBehaviorEvidencePort、host-tool-declaration 读写校验、resolveWorkspaceHostToolSemantics、collectHostWorkspaceClaims/findForeignWorkspaceOwner、backgroundExecutions schema、worker-adapter.v1 合同与 once-CLI adapter、worker-env/worker-process、dispatchWorkspaceAdapters、service 锁/status/scheduler 全套、Companion Supervisor 过渡态门禁（已实现，本阶段不动）。

**需抽离/暴露（模块移动或新 subpath，无新包）**：
1. 插件工具常量（catalog 名称表）需可被 worker 进程消费 → 新增 `principles-disciple` subpath 导出（SSoT 不动，guard 不动）；
2. 插件 SystemLogger 事件流（worker 复用同一模块 → 交接后 SYSTEM 日志连续）。

**最小新增（均有明确单一归属）**：
1. `packages/openclaw-plugin/src/openclaw-worker.ts`（+ exports map `./openclaw-worker`）：`runOpenclawWorkspaceWorkerCycle` —— OpenClaw 版 worker cycle（模板=codex workspace-worker：liveness/归因/门禁/declaration/ports）；pd-cli `commands/openclaw-worker.ts` 命令面（lazy import，run-rulehost 模式）。
2. `packages/install-layout/src/background-execution-transition.ts`：owner state CAS/transition 原语（阶段归属修正：Phase 4 最小实现、Phase 5 复用）+ workspace 所有权只读 reader（Gateway 门禁/worker 门禁/handover 命令三方共用）。
3. `packages/pd-cli/src/services/service-host/worker-adapter-openclaw.ts`：openclaw host config（liveness 文件名/证据提取）+ managed hostKinds 扩展（shadow 不扩）。
4. Gateway 侧：marker 门禁（start + 每 tick）+ quiesce 协议（in-flight 追踪 + 持久化 ack 文件 `<ws>/.pd/gateway-quiesce-ack.json`，schema `pd.gateway-quiesce.v1`）。
5. `pd service handover|rollback --workspace <dir>` 命令：§8.4/回滚编排（readiness 探针 = 经 active-release 入口 spawn `openclaw worker --readiness`）。
6. worker `--readiness` 模式（no-consume 就绪自检：验证 declaration/config/凭据解析/adapter，不消费）。

## 8. 本阶段实施风险

| # | 风险 | 缓解 |
|---|---|---|
| R-1 | 双消费者（交接窗口/手动 worker/Gateway 重启） | worker 侧 marker 门禁（manual 直跑也拒绝 legacy workspace）+ Gateway start/tick 门禁 + managed/shadow 准入矩阵不变 |
| R-2 | CAS 并发（两个 handover、installer 同时写） | 跨进程文件锁（O_EXCL + holder 元数据 + TTL，模式=pd-worktree-mutation.lock/2）+ 锁内 generation fencing + 原子 rename |
| R-3 | installer whole-object 写覆盖 backgroundExecutions（ERR-168） | 审计 installer 写路径；merge 语义保留该子段；回归测试走真实 load-modify-save 调用路径 |
| R-4 | 固定周期替代 adaptive timer 的延迟退化 | Stage 5 用真实 nextConsumerDelay 策略对照测量（纯函数可离线重放）+ 如实记录语义变化 |
| R-5 | declaration 版本斜差（worker 与 Gateway 版本不一致时 worker 刷新 declaration） | declaration 为代码常量事实（codex worker 同型）；发布布局单一 release；设计文档记录 |
| R-6 | CI/发布面（新 exports map 条目、changeset 双包规则） | principles-disciple minor + pd-cli 依赖对齐；install-layout 变更带自身 changeset |

## 9. 现有测试覆盖（与本阶段相关）

- service-host：`pd-cli/tests/services/service-host/`（run-once/shadow-run/managed-run/worker-adapter/worker-env/worker-process/lock/status/scheduler/workspace-discovery×2/owner-projection/progress/shadow-real-cli）+ `tests/commands/service-command.test.ts`（真实 Commander 注册）。
- install-layout：`src/index.test.ts`（manifest 解析/backgroundExecutions 组合校验/单键写）、`tests/mcp-binding-contract.test.ts`。
- companion：`tests/lib/workspace-workers*.test.ts`（过渡态阻塞 + 重启竞态回归）。
- openclaw-plugin：`tests/service/auto-consumer-evidence-port.test.ts` 等存在，但 **marker 门禁/quiesce 无任何测试**（本阶段新增）。
- **无 `pd openclaw worker` 命令与测试**（确认不存在）。

## 10. 结论

现状与 SPEC/TD 的差距与两份文档的自述完全一致：业务执行层（共享周期/诊断/证据装配/lease/recovery）**全部已 host-neutral 且可复用**；缺口集中在 (a) OpenClaw 侧所有权门禁与 quiesce、(b) 独立 worker 入口 + liveness、(c) CAS 原语的阶段归属修正与实现、(d) manifest 注册面（OpenClaw workspace 不可见于 managed 发现）。所有缺口都有最小实现路径，无需新包、无需第二套业务判断。

→ 进入 Stage 1（设计校准）：见 `docs/reports/PD_SERVICE_HOST_PHASE4_TECHNICAL_DESIGN_DELTA.md`。
