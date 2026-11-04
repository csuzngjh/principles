# PD × WorkBuddy Amendment v0.1 — Adversarial Review v0.1

> **PD_WORKBUDDY_AMENDMENT_ADVERSARIAL_REVIEW_v0.1.md**
> 对 `PD_ADAPTIVE_ACTIVATION_SPEC_AMENDMENT_v0.1.md` 的独立反向审查

| 项 | 值 |
|:---|:---|
| 版本 | v0.1 |
| 审查日期 | 2026-11-04（GMT+8） |
| 审查对象 | `PD_ADAPTIVE_ACTIVATION_SPEC_AMENDMENT_v0.1.md`（1283 行）＋ 五份 v0.1/v0.2 审计材料 |
| 宿主基线 | WorkBuddy Desktop `5.9.2` / 引擎 `@genie/agent-cli 2.165.0`（SHA-256 `6fbfd77b…`） / PD 插件 `0.2.2` |
| 本轮性质 | 只读源码取证 + 静态调用链追踪 + 建议文本修订 |
| 未执行 | 未修改 SPEC v0.4、生产代码、宿主配置、生产数据库；未启用 async hook；未在真实会话测试阻断行为；未合并 PR / 部署 / 发布 |
| 最终裁定 | **READY_FOR_OWNER_REVIEW**（附条件，见 §7） |
| 交付 | 本报告 ＋ `PD_ADAPTIVE_ACTIVATION_SPEC_AMENDMENT_v0.2.md` |

## 0. 审查纪律与状态阶梯

本轮**不重复宽泛宿主能力调查**，只针对 v0.1 的 36 条建议做反向验证。三路取证：

| 路 | 范围 | 结论摘要 |
|:---|:---|:---|
| 取证 A | 引擎 2.165.0 `TaskCreateTool` / `TaskUpdateTool` / `SubagentStart/Stop` 完整调用链 | `TaskCreated` 是 **Agent 内部 todo 工具通知**，不是用户任务边界 |
| 取证 B | 引擎 `async:true` / `registerHookPid` / `SessionEnd` / `Pre/PostCompact` / `HookExtensionLoader` | 「cannot outlive the session」**无证据**；经典 PreCompact **不能阻断压缩**；物理残留 **≠** 重复注册 |
| 取证 C | PD `wrapper.cjs` / `pd-hook.ts` / `evidence-recorder` / `workspace-worker` / 测试 | PD **已有** detached worker + DB lease；`events_*.jsonl` 可作无 DB 的轻量 receipt；12 s 是**预算设定**而非阶段测量 |

**状态阶梯（本轮起强制使用，禁止混用）**：

```
PROPOSED → SPEC_REVISED → IMPLEMENTED → TESTED → RUNTIME_VERIFIED → ACCEPTED
```

- `PROPOSED`：仅在 Amendment 中提出，未进 SPEC。
- `SPEC_REVISED`：已进入 SPEC v0.5 文本，无实现。
- `IMPLEMENTED`：代码存在，未测试。
- `TESTED`：有自动化断言，未在当前宿主运行验证。
- `RUNTIME_VERIFIED`：当前安装版本的真实运行证据。
- `ACCEPTED`：Owner 明确批准。

**证据等级**：`OFFICIAL_DOC` / `SOURCE_CONFIRMED` / `RUNTIME_VERIFIED` / `STATIC_CONFIG` / `HISTORICAL_PROBE` / `INFERRED` / `NOT_RUN` / `UNKNOWN` / `NOT_FOUND`。`SOURCE_CONFIRMED` ≠ `RUNTIME_VERIFIED`；`NOT_RUN` ≠ `Supported`。

---

# 1. 本轮新增证据（推翻 v0.1 的关键事实）

| ID | 证据 | 来源 | 等级 |
|:---|:---|:---|:---|
| E2-01 | `TaskCreateTool`（`name=TASK_CREATE`）入参仅 `subject/description/activeForm/metadata/owner`；创建的对象 `status:"pending"` 落盘为 `<home>/tasks/<storageId>/<id>.json` | `ENGINE:L1916 @6039396,@6040410–6041165`；`L2090 @6627632` | `SOURCE_CONFIRMED` |
| E2-02 | `executeTaskCreatedHooks` payload 仅 `session_id`（会话级 `parentSessionId ?? t.id`）、`session`、`transcript_path`、`cwd`、`hook_event_name`、`task_id`、`task_subject`、可选 `task_description`/`teammate_name`/`team_name`/agent 信息；**无 prompt、无 generation_id、无 conversationRequestId、无 turn 标识** | `ENGINE:L2271 @7498928–7499149` | `SOURCE_CONFIRMED` |
| E2-03 | `taskId` = 目录内最大数字 `.json` 文件名 +1（`String(n)`），会话分区自增序号；任务 JSON 不记录任何请求标识，**无法反查触发它的用户请求** | `ENGINE:L2090 @6626925,@6627834` | `SOURCE_CONFIRMED` |
| E2-04 | `parentTaskId` / `parent_task_id` / `parentTask` / `subtask` / `subTask` 全文 **0 命中**；task 间只有扁平 `blocks`/`blockedBy` DAG；血缘字段（`parentSessionId`/`subagentRootSessionId`/`parentToolUseId`）属于 subagent session，不在 task 对象 | 全文检索；`L1916 @6046109`；`L27 @1054906` | `SOURCE_CONFIRMED / NOT_FOUND` |
| E2-05 | `TaskCompleted` 仅在**单个** todo 的 `status` 被置 `"completed"` 时派发；`deleted` 分支直接 return 无 hook；`pending`/`in_progress` 及字段更新不派发；`buildCompletionGuidance` 明确「Continue the remaining work」 | `ENGINE:L1916 @6047183–6049189` | `SOURCE_CONFIRMED` |
| E2-06 | `SubagentStart/Stop` 与 Task 事件是**两条独立调用链**，payload 无共享字段；`agent_id`=subagent session `storeId`，`agent_type`=speaker label；启动 subagent 的是 **`Agent` 工具**（不是 `TaskCreate`） | `ENGINE:L2271 @7491935,@7494500`；`L27 @1070388,@1070955`；`L1880 @6003500` | `SOURCE_CONFIRMED` |
| E2-07 | `teammate_name` ← `task.owner`（agent 名，可选），`team_name` ← `TeamManager.isInTeam()`（可选）；均与用户身份无关 | `ENGINE:L1916 @6041059,@6041102` | `SOURCE_CONFIRMED` |
| E2-08 | Task/Subagent 派发为 **best-effort**：`hasHooks` gate + `if(s)` + 两层 catch 吞异常；`TaskUpdated`/`TASK_UPDATED`/`executeTaskListHooks` 全文 0 命中 | `ENGINE:L2271 @7498957,@7499583`；全文检索 | `SOURCE_CONFIRMED / NOT_FOUND` |
| E2-09 | hook input 中任务字段是 **snake_case `task_id` / `task_subject`**（工具层才是 camelCase `taskId`）| `ENGINE:L2271 @7499149,@7499552` | `SOURCE_CONFIRMED` |
| E2-10 | `async:true` detach = 立即 `s({allowed:!0,exitCode:0})`、`clearTimeout`、新建 `asyncTimeout` 定时器（`.unref()`）、`if(B)return` 丢弃全部结果解析；`spawn` **无 `detached:true`** | `ENGINE:L572 @3579844–3580030,@3576513` | `SOURCE_CONFIRMED` |
| E2-11 | `registerHookPid`/`unregisterHookPid` 存于模块级 `py` Set；`killAllHooksSync()` **唯一调用点**是 `process.exit` 包装 `_exitWrapped`；**不在** `executeSessionEndHooks`、不在 `process.on("exit")`、不在 `beforeExit` | `ENGINE:L446 @2405352,@2406535`；`L458 @2415633` | `SOURCE_CONFIRMED` |
| E2-12 | 「cannot outlive the session」/`outlive` 与 hook 生命周期关联全文 **NOT_FOUND**；相反，detached 进程在自然事件循环排空 / 崩溃 / OS 强杀路径可能继续存活 | 全文检索 `@5631184` 为无关安全文案 | `NOT_FOUND / INFERRED` |
| E2-13 | `asyncTimeout` 缺省回退 hook timeout（默认 `6e4`=60000 ms），单位 ms，executor 路径无上限；控制**子进程存活**，不控制宿主等待；**不校验、不等待 worker 结果提交到 PD 侧存储** | `ENGINE:L572 @3576352,@3577899,@3579844` | `SOURCE_CONFIRMED / NOT_FOUND` |
| E2-14 | 经典 `executeClassicPreCompactHooks` 只在 `allowed && stdout && !suppressOutput` 时返回 stdout 作为**附加压缩指令**；`!allowed`/exit 2/`continue:false` 只 `return undefined`，**压缩照常继续**；只有 mods 层 `modsCompactSkip` 能真正跳过 | `ENGINE:L2271 @7493197`；`L2335 @7926914` | `SOURCE_CONFIRMED` |
| E2-15 | `PostCompact` 返回值**完全丢弃**，仅观察；`compact_summary` = `SummaryUtils.extractCompactSummaryFromText` 从 `<summary>` / `<conversation_history_summary>` 提取的**摘要文本**，非完整上下文，无长度/完整性保证，缺失时字段直接缺省（部分路径 `??n` 回退为压缩内容本身） | `ENGINE:L2271 @7495586`；`L2266 @7366939`；`L2335 @7928897` | `SOURCE_CONFIRMED` |
| E2-16 | `transcript_path` 压缩前后不变；PreCompact 可读压缩前完整 transcript；PostCompact 在 `replaceHistory` 之后、**显式 `flushHistory` 之前**触发，代码未保证能读到压缩后文件 | `ENGINE:L2270 @7485424`；`L2335 @7926914,@7928897` | `SOURCE_CONFIRMED / NOT_RUN` |
| E2-17 | `HookExtensionLoader.load` 只构造**单一路径** `join(pluginRoot,"hooks/hooks.json")`（或 manifest `hooks` 字段）；**不枚举**版本目录；`resolveInstalledPluginCache` 从 registry 按范围过滤后只选**一条** installPath | `ENGINE:L2506 @8220725,@8221408,@8323763` | `SOURCE_CONFIRMED` |
| E2-18 | `mergeHooks` 拼接的是**同一插件 root 内** manifest `hooks` + 默认 `hooks/hooks.json`（4 处调用全在 L2506），**不是多版本目录**；`.orphaned_at` 被宿主读取但语义是缓存 GC（≈14 天），不是 hook 加载黑名单 | `ENGINE:L2506 @8221524,@8321000,@8245061` | `SOURCE_CONFIRMED` |
| E2-19 | `configSha256`/`rootFingerprint`/`configSha`/`versionMismatch` 引擎全文 0 命中 → 无现成机制，需 PD 自行计算 | 全文检索 | `NOT_FOUND` |
| E2-20 | `SessionEnd` hooks **await**、best-effort（吞异常）；会话结束本身不 kill hook 子进程；只有 `process.exit` 包装会 `killAllHooksSync()` | `ENGINE:L2270 @7489374`；`L572 @3336240`；`L458 @2415633` | `SOURCE_CONFIRMED` |
| E2-21 | `wrapper.cjs:76-81` 降级分支**只写 stderr + `exit 1`**，不写任何 receipt/结构化文件；`:42-44` 注释明确不承诺 adapter 侧 flush | `packages/workbuddy-adapter/plugin/scripts/wrapper.cjs` | `CODE` |
| E2-22 | `pd-hook.ts` UPS 同步路径含 ≥3 次 `readFileSync(config)`、`state.db` 只读连接 + N 次 `getArtifactById`、`renderPrinciplesToDirectives`、以及 emitter 内**同步 `appendFileSync` + 同步 SQLite `BEGIN IMMEDIATE` 事务**；`observationKey` 幂等再引入 4–5 次独立只读连接 | `pd-hook.ts:250–504`；`active-principle-prompt.ts:70–131`；`intervention-evidence-ingress.ts:95–303`；`sqlite-intervention-evidence-store.ts:560–688` | `CODE` |
| E2-23 | `health()` 仅路径字符串校验、无 DB/文件锁，且**只在 `SessionStart` 调用**，UPS 不走 | `host-runtime/src/index.ts:210-230`；`pd-hook.ts:389-395` | `CODE` |
| E2-24 | 写连接 `busyTimeoutMs:0`（锁争用立即降级，不等待）；只读连接**未设** `busy_timeout`/pragma；无重试 | `intervention-evidence-ingress.ts:9-15,162`；`sqlite-connection.ts:123-133` | `CODE` |
| E2-25 | `events_<YYYY-MM-DD>.jsonl` 位于 `<workspaceDir>/.state/logs/`，`appendJsonLine` = `mkdirSync(recursive)+appendFileSync` 单行 JSON，**不碰 SQLite**、无应用层锁；已被 `pd-hook-production.test.ts:173-179` 当作 durable replay source | `pain-signal-observability.ts:59-83`；测试 | `CODE / TEST` |
| E2-26 | PD **已实现** detached 后台 worker：`pd-companion` spawn `node … worker --interval 120000`（IPC），`pd-cli/src/commands/workbuddy-worker.ts` daemon 循环，`workspace-worker.ts` cycle；`durable Runtime V2 task lease` 是 `tasks` 表字段（`lease_owner`/`lease_expires_at`/`status`，`LEASE_TTL_MS=300_000`）+ `runRecoverySweep()` | `pd-companion/src/main/main.ts:373-388,455-476,522`；`workbuddy-worker.ts:130-187`；`pain-signal-bridge.ts:959-985` | `CODE` |
| E2-27 | `principle_decision` / `principle_selector` / Deferred Refresh 契约（contextFingerprint / workingSetRevision / stale discard）在 `packages/` 代码中 **0 命中**，仅见 SPEC 文档 | 全包 Grep；`SPEC v0.4:1888-1903` | `NOT_FOUND(代码)` |
| E2-28 | `input-decoder.ts:52-58` `EVENT_KINDS` 仅 5 项，`TaskCreated`/`PostCompact` 等命中即抛 decode error；`SUBSCRIBED_EVENTS` 仅 4 个内部事件 | `input-decoder.ts`；`host-adapter.ts:34-39` | `CODE` |
| E2-29 | 无任何测试断言「降级时写 receipt」「receipt 写入不影响同步耗时」「真实 adapter 在 12 s 被 kill 时 journal 状态」；`pd-hook-production.test.ts` 经 `hook-runner.ts:110-140` **绕过 wrapper** 直接调 `pd-hook.js` | `plugin-skeleton.test.ts:170-230`；`pd-hook-production.test.ts`；`evidence-concurrency.test.ts` | `TEST / NOT_FOUND` |
| E2-30 | 12.021 s 是 `SELF_TIMEOUT_MS.UserPromptSubmit=12000` 的**预算设定** + wrapper 观测到的总耗时；**无任何阶段级计时/profiler/p95 数据**；「写连接锁等待 12 s」被 `busyTimeout=0` 静态反驳 | `wrapper.cjs:61`；运行时日志；E2-24 | `CODE / STATIC_CONFIG`，阶段归因为 `NOT_RUN` |
| E2-31 | 宿主 CLI 官方文档称 PreCompact exit 2 可阻止压缩，与 E2-14 源码矛盾 → 新增第 13 项「文档/源码差异」 | D1 `codebuddy.ai/docs/zh/cli/hooks` §5.2 vs `ENGINE:L2271 @7493197` | `OFFICIAL_DOC` vs `SOURCE_CONFIRMED` |

---

# 2. 八项对抗性审查

## R1 — Task 生命周期语义（结论：**v0.1 存在会导致错误激活的设计**）

### 逐问回答

1. **TaskCreated 创建的是什么？** — `TaskCreateTool` 创建的**会话级 todo / plan 项**（`tasksToTodos` 把它映射为 `content`/`activeForm`/`status`/`dependencies`），不是用户任务，也不是通用 Task 对象（E2-01）。
2. **是否存在 parentTaskId 或等价层级？** — **否**。`parentTaskId`/`subtask` 等 6 个关键词全文 0 命中；只有扁平 `blocks`/`blockedBy` 依赖 DAG；真正的血缘字段属于 subagent session（E2-04）。
3. **taskId 能否关联用户原始请求？** — **不能**。它是会话分区内自增序号字符串，任务 JSON 不记录 prompt / generation / request id，且同一会话多个用户请求共享同一 id 空间；一次用户请求可产生 0/1/N 个 `TaskCreated`（E2-02/E2-03）。
4. **TaskCompleted 是否意味整个用户任务结束？** — **否**。单个 todo 标 `completed` 即派发；`buildCompletionGuidance` 在仍有 pending/in_progress 时明确提示「Continue the remaining work」；`deleted` 甚至不派发（E2-05）。
5. **多 Agent 如何区分主/子？** — 靠 **session 血缘与 team 上下文**（`parentSessionId`/`subagentRootSessionId`/`parentToolUseId`/`isTeamLead`/`isTeamMember`/`teamContext`），不是 task 对象；`Agent` 工具（含 `prompt`/`subagent_type`/`run_in_background`）才是启动 subagent 的入口（E2-06）。
6. **teammateName/teamName 能否提供足够归属证据？** — **不能**。前者是 task 的 `owner`（agent 名），后者仅在 team 模式有值，均可选、均与用户身份无关（E2-07）。

### 重新裁定 v0.1 的映射

| v0.1 映射 | 二轮裁定 | 依据 |
|:---|:---|:---|
| `TaskCreated → NEW_TASK`（A-08/A-07/A-32/A-35 声称「确定性 NEW_TASK，跳过 `principle_decision`」） | **REJECT** | 无 prompt/turn 语义、无层级、无法反查用户请求；把内部 todo 创建当用户新任务会**在每一次 Agent 拆解计划时触发原则重选**，直接造成错误激活与成本爆炸 |
| `TaskCompleted → TASK_COMPLETED`（当作整个用户任务结束 / Working Set 失效归档） | **REJECT** | 只是单个 todo 完成；据此归档 Working Set 会在任务仍进行中丢失已激活原则 |
| `SubagentStart/Stop → 主子任务边界` | **ACCEPT_WITH_CHANGE** | 它们确实界定 **subagent 会话边界**，但无 `task_id`、无共享字段、不能推导用户任务边界；只能作为 `HOST_SUBAGENT_SCOPE_CHANGED` 作用域提示 |

### 新增 `HOST_TASK_GRAPH_CHANGED`

采用用户建议，但**严格限定为弱信号**：

- 语义 = 「同一会话内的 Agent 内部计划图（todo 项及其 `blocks`/`blockedBy` 依赖）发生变化」。
- 允许的用途：① 关联 / 去重（`(session_id, task_id)`）；② 记入 provenance；③ 作为**重校验提示**（Working Set 可能需重新验证）。
- **禁止**：产出 `TaskChangeType`（`NEW_TASK`/`GOAL_SHIFT`/`PHASE_SHIFT`/`UNCERTAIN`）、直接选取/替换原则、跳过 `principle_decision`、充当会话/轮次边界、充当用户身份或计费切分。
- 适用事件：`TaskCreated` / `TaskCompleted` / `SubagentStart` / `SubagentStop`（best-effort，E2-08）。
- 字段一律 **snake_case**（`task_id`/`task_subject`）；`generationId` 在这些 payload 中**不存在**，缺失即缺失，禁止伪造（E2-02/E2-09）。

### 四类边界的明确区分（写入 v0.2）

| 类别 | 当前可验证来源 | 可否驱动原则选择 |
|:---|:---|:---|
| 用户任务边界 | `UserPromptSubmit`（带 `prompt` + `generation_id`）；无宿主「新任务」确定性事件 | 语义判断仍归 `principle_decision`；不得由宿主事件直接判定 |
| Agent 内部任务边界 | `TaskCreated`/`TaskCompleted`（todo 项） | **否**，仅 `HOST_TASK_GRAPH_CHANGED` |
| 子代理边界 | `SubagentStart`/`SubagentStop`（session 血缘） | **否**，仅作用域提示 |
| 普通工具执行阶段 | `Pre/PostToolUse`/`PostToolUseFailure` | **否**，仅 evidence |

> **结论**：v0.1 的「determinism-first rule」（A-08、ADR-015）是本轮发现的**最严重设计缺陷**——它让宿主事件绕过 PD 的原则语义判断。v0.2 已删除。

## R2 — Async Hook 生命周期与安全性（结论：**删除未证明的保证**）

- A-04 原文「the adapter must verify … and **cannot outlive the session**」：E2-12 显示该语句全文 `NOT_FOUND`，且与 E2-10/E2-11 的源码行为相反 → **删除**。
- 真实语义：detach 立即返回 `allowed:true`；子进程由 `py` Set 跟踪，**只在 `process.exit()` 包装路径**被 `killAllHooksSync()` 统一 SIGTERM→SIGKILL；`executeSessionEndHooks` 不 kill；`process.on("exit")` / `beforeExit` / 崩溃 / OS 强杀路径无清理（E2-11/E2-20）。因此 **detached worker 可以在原 Session 结束后继续执行一段时间**。
- `asyncTimeout` 只控制子进程存活，且**不校验、不等待** worker 把结果写入 PD 侧存储（E2-13）→ 不能替代结果提交校验。
- `spawn` 无 `detached:true`（E2-10）→ 「detached」是逻辑语义，不是 OS 层脱离；v0.2 不得把 OS 保证写进契约。
- **关键更正（取证 C）**：PD **已有** detached 后台 worker（`pd workbuddy worker`，120 s 周期）+ DB task lease + `runRecoverySweep()`（E2-26）。因此**不需要**把未经隔离验证的宿主 async hook 当作首选载体；v0.1 声称「宿主异步是唯一非自建方案」是错误前提。Deferred Refresh 的**契约**（contextFingerprint / revision / stale discard）在代码中仍 `NOT_FOUND`（E2-27），故 Model-assisted 仍必须 OFF。

### v0.2 的新契约（§10.4 / §14.2，见 A-38）

1. 明确声明 detached worker **可以**在原 Session 结束后继续执行；不得假定宿主会随 Session 清理它。
2. worker **不得**直接注入当前用户回合，也不得写当前回合 prompt。
3. worker 结果必须绑定 `sessionId`（+ 可用时 `generationId`、`task_id`）+ `workingSetRevision` + `hostProfileId` + `contextFingerprint`；缺失字段保持缺失。
4. Session 结束后旧结果**不能**污染新 Session：通过 `sessionId` 隔离 + lease（E2-26）+ 版本栅栏 + 幂等键 + stale-result discard；`resolveHostProfile()` 报 `EXPIRED` 时丢弃。
5. `asyncTimeout` 不能替代结果提交校验：提交必须以「可复核的 journal 行 + revision check」为准。
6. 在真实隔离探针通过前，**host-native async refresh 与 Model-assisted Shadow/Live 一律 OFF**；Deferred Refresh 的候选载体是 PD 既有 worker，其契约实现与验证为 `DEFERRED_PENDING_EVIDENCE`。

## R3 — Delivery Integrity 状态机（结论：v0.1 **未形成**完整证据链）

v0.1 把 `degraded` 塞进 `injectionStatus`（A-22/A-26），与 `returned`/`confirmed`/`skipped`/`timeout`/`failed` 混在**一个维度**，导致：
- 无法表达「hook 正常完成但按策略不注入」（应为 execution=`completed` + payload=`none`）；
- `degraded` 既像执行状态又像交付状态；
- 宿主 kill 时 receipt 无法写入，v0.1 无任何兜底；
- receipt 写入本身可能引入**同步 SQLite 事务**，与 P0 性能问题叠加（E2-22）。

### 六个必答

1. **`degraded` 是否属于 Hook 执行状态？** — **是**。它描述「hook 如何结束」，不属于 Payload 状态。v0.2 中 `HookExecutionStatus = "completed" | "degraded" | "timeout" | "failed"`。
2. **空 Payload 返回后能否同时记录 Hook completed 和 Payload none？** — **能且必须支持**。例：flag OFF / 无可用原则 / `NONE_APPLICABLE` → `execution=completed, payload=none, selection=skipped`；这是与 `degraded` 完全不同的合法组合。
3. **`returned` 与 `confirmed` 如何严格区分？** — `returned` = adapter 把 payload 写到 stdout、宿主接受（adapter 侧证据）；`confirmed` = **独立请求级证据**（mock request body diff / 宿主请求日志）证明 payload 进入**当前**模型请求。只有 `RUNTIME_VERIFIED` 以上等级 + `evidenceReference` + `observedAt` + `independentlyVerified=true` 才能进入 `confirmed`。当前 2.165.0 环境无请求级证据（v0.1 审计已说明），故 WorkBuddy 的 `confirmed` **不得声明**，链条止于 `returned`。
4. **宿主 kill 导致无法写 Receipt 时如何记录？** — 采用 **open/closed/reconciled 三段 journal**：hook 入口先写一行 `open`（`payload=unknown`、无 execution 终态），正常退出写 `closed`；若被 kill，记录停留在 `open`，由既有后台 worker（E2-26）依据宿主日志/缺失的 closed 行做 reconciliation → `execution=timeout, payload=unknown`。**任何情况下 `open` 都不得被计为成功**。
5. **如何避免 Receipt 写入拖慢同步 Hook？** — 强制约束：单行 `O_APPEND` `appendFileSync` 到 `events_<date>.jsonl`（E2-25），**零 SQLite 操作、零幂等读、零 schema DDL**；目录在安装时预建，避免每次 `mkdirSync`；同步路径内最多 2 行（入口 + 终态）；`p99 ≤ 2 ms`、`max ≤ 5 ms` 且纳入 §17 探针。现有 `appendEventLogLine` 已具备该能力（E2-25）。把 `recordWorkbuddyPromptDeliveryEvidence` 的同步 SQLite 事务 + `observationKey` 多次只读连接**移出同步路径**，交给既有 worker 从 journal replay（最小改动面落在 `pd-hook.ts:90-123` 与 recorder 调用时机，E2-22）。
6. **如何保证异常情况下也不把没有注入的回合计为成功？** — **封闭世界默认**：receipt 初始 `payload=unknown`；只允许经显式正证据迁移到 `returned`/`confirmed`；`execution ∈ {degraded,timeout,failed}` ⇒ `payload ∉ {returned,confirmed}`；`confirmed` 必须 `execution=completed` 且 `independentlyVerified=true`；评测口径中**只有 `confirmed` 计为成功**，`returned` 仅为「已尝试交付」，`unknown` 不评分。宿主 kill 后的 `open` 行由 reconciliation 标 `timeout`，永不升级。

### 完整 TypeScript 与状态迁移

见 v0.2 §2「A-39 — §13.4 / §15.2 Delivery Integrity」。此处只列核心不变量：

```typescript
type HookExecutionStatus = "completed" | "degraded" | "timeout" | "failed";
type PayloadStatus = "none" | "prepared" | "returned" | "confirmed" | "unknown";
type SelectionStatus = "selected" | "skipped" | "unavailable";
type ReceiptState = "open" | "closed" | "reconciled";
```

不变量：
- `payload === "confirmed"` ⇒ `execution === "completed"` ∧ `evidence.independentlyVerified === true` ∧ `evidence.evidenceReference` 存在。
- `execution ∈ {"degraded","timeout","failed"}` ⇒ `payload ∉ {"returned","confirmed"}`。
- `selection === "unavailable"` ⇒ `payload ∈ {"unknown","none"}`。
- `receiptState === "open"` ⇒ 无 execution 终态 ∧ `payload === "unknown"`；不得计为成功。
- reconciliation 不得把 `unknown`/`none` 升级为 `returned`/`confirmed`（除非取得独立请求级证据）。

## R4 — 四层生命周期证据（结论：Boolean 不足，v0.1 的 `lifecycle{4×boolean}` **REJECT**）

v0.1 A-26 的 `installed/loaded/dispatched/contributed` 是四个 Boolean，问题：
- 无时间戳、无证据等级、无证据引用 → Receipt 会「凭空声明」自己无法证明的状态；
- hook 进程无法证明 `installed`/`loaded`（属 installer / 宿主 `HookExtensionLoader`），却由 hook 写 receipt；
- 遗漏了 **payload 已返回**、**模型请求已包含**、**模型理解/遵循** 三层；
- 由后一层反推前一层（看到 `contributed` 就填 `dispatched=true`）会制造假证据。

### v0.2 设计（A-40）

六个阶段，每阶段独立 `StageObservation`：`status`（`observed | not_observed | unverifiable`）、`evidenceGrade`、`timestamp`、`evidenceReference`、`assertedBy`。

| 阶段 | 唯一可断言者 | 证据 |
|:---|:---|:---|
| `plugin_installed` | installer | `installed_plugins.json` |
| `plugin_loaded` | 宿主 / reconciler | `HookExtensionLoader` 日志 |
| `hook_dispatched` | hook 入口 | 本次进程启动 + `open` journal 行 |
| `payload_returned` | encoder | stdout 单行输出记录 |
| `request_confirmed` | request probe / reconciler | 独立请求级证据 |
| `behavioral_effect` | Examiner | PD 不得断言，恒为 `unverifiable` |

规则：hook receipt **只能**断言 `hook_dispatched`、`payload_returned`；`request_confirmed` 仅在取得请求级证据后由 reconciler 追加；`plugin_installed`/`plugin_loaded` 由后台 reconciler 从宿主侧证据回填；**禁止**由后续阶段反推前序阶段，禁止 PD 自证 `behavioral_effect`。

## R5 — Compaction 语义（结论：v0.1 多处错误，需重写）

| 问题 | 二轮结论 | 证据 |
|:---|:---|:---|
| PreCompact 是否允许阻断压缩？ | **经典 PreCompact hook 不能**。`!allowed`/exit 2/`continue:false` 只影响是否采纳 stdout 作为附加压缩指令，压缩照常继续；只有 mods 层 `modsCompactSkip` 能跳过。**CLI 官方文档 D1 声称 exit 2 可阻止压缩 → 文档/源码矛盾，登记为第 13 项差异** | E2-14 / E2-31 |
| PD 是否只执行有界 Working Set 检查点？ | **是**。PreCompact 只允许：写一行 `open`/checkpoint journal、记录 `preCompactRevision` 栅栏；禁止选取原则、禁止修改 selected IDs、禁止写 prompt | 设计约束 + E2-14 |
| 是否禁止同步 PreCompact 中执行 LLM？ | **必须禁止**。PreCompact 在压缩路径上同步 `await` 调用（E2-16），任何外部推理都会直接增加压缩延迟；与 §3.3「同步 hook 不做外部模型推理」一致 | E2-16 + 设计约束 |
| `compact_summary` 是否具备完整上下文代表性？ | **否**。`SummaryUtils` 提取 `<summary>`/`<conversation_history_summary>` 摘要文本，无长度/完整性保证，缺失时字段缺省或回退为压缩内容本身 | E2-15 |
| PostCompact 的 `compact_summary` 能否当 fingerprint 输入？ | **否**。v0.1 A-08/A-10「recompute `contextFingerprint` from `compact_summary`」**REJECT** | E2-15 |
| 压缩前后 Working Set 一致性 | 用 `workingSetRevision` + `preCompactRevision` 栅栏：PreCompact 记录 revision 并写 checkpoint；PostCompact **只做失效信号**（`revalidationRequired=true`，不改 `selectedPrincipleIds`）；下一次 `BEFORE_MODEL_TURN` 从**实际当前上下文**重算 fingerprint 并重校验；不一致则 Native 兜底 | 设计约束 |

**v0.2 修正**：`PostCompact` 定位为「状态失效与重新校验信号」，**不是独立的原则选择授权**；`COMPACTION_RESUME` 保留但不得假定所有宿主支持；`sessionSource` 枚举删除 `"compact"`（当前源码 `NOT_FOUND`，E2-16 相关）；PreCompact 无 `hasHooks` gate、异常被吞（E2-16），故 PD 不得依赖 PreCompact 一定派发。

## R6 — Host Profile 与配置残留（结论：v0.1 把物理残留误判为生产重复注入）

### 四层区分（必须写入 v0.2）

| 层 | 当前事实 | 证据 |
|:---|:---|:---|
| ① 物理目录存在 | `0.1.0`/`0.2.0`/`0.2.2` 各自含完整 `hooks.json`，旧版有 `.orphaned_at` | 上一轮 `STATIC_CONFIG` |
| ② 宿主可发现 | **仅** `installed_plugins.json` 注册表经 `resolveInstalledPluginCache` 选出的**单一 installPath**（或 `--plugin-dir` / Enabled 插件的 installedPath）；`cleanupPluginCache()` 遍历目录**只用于 GC**，不加载 hook | E2-17/E2-18 |
| ③ 宿主实际加载 | `HookExtensionLoader.load` 只 `join(pluginRoot, "hooks/hooks.json")` 一个路径 | E2-17 |
| ④ 同一事件多个有效注册 | 真实路径是**同一 root 内** manifest `hooks` 字段 + 默认 `hooks/hooks.json` 被 `mergeHooks` concat；或多来源 `getHooks`（settings/插件/scoped registry）合并；**与多版本目录无关** | E2-18 |

→ **判定**：物理残留**不足以**认定为生产重复注入。v0.1 的 GAP-10（P1）、A-02「stale copies + mergeHooks → duplicate registration」、A-11 §8.3.1、A-18「stale version directories must not be discoverable」、A-31 Task 12、A-32「Only one hooks.json discoverable」、A-33 Stop 17、A-29「two plugin versions enabled」、A-34 OQ-16 全部需要改写或降级。

### 长期 Receipt 的身份字段（v0.2 A-42）

**删除** `enabledPluginRoot`（绝对路径）与 `HostRuntimeCapabilityProfile.enabledPluginRoot`；改用：

```typescript
interface HostPluginIdentity {
  pluginId: string;              // "principles-disciple@principles-disciple-market"
  pluginVersion: string;         // "0.2.2"
  profileId: string;
  configSha256: string;          // 已解析 hooks.json 内容哈希
  rootFingerprint: string;       // sha256(marketplaceId|pluginId|version|configSha256)
  discoverability: "registry_resolved" | "plugin_dir" | "unknown";
  loadedHookCount?: number;      // 来自宿主日志，非路径
}
```

原始绝对路径**仅保留在本地诊断材料**（Evidence Manifest / 本地日志），不进长期 Receipt。引擎无 `configSha256`/`rootFingerprint` 现成机制（E2-19），由 PD 计算并作为 profile 一致性锚点。

## R7 — 性能预算与 P0 修复顺序（结论：v0.1 混淆了 7 个维度）

### 七维分离（v0.2 §17 强制）

| 维度 | 当前已知值 | 性质 |
|:---|:---|:---|
| ① 同步路径实际耗时 | **未测量**；仅知本次总耗时 >12.021 s | `NOT_RUN`（阶段归因） |
| ② wrapper 自身 deadline | `SELF_TIMEOUT_MS.UserPromptSubmit = 12000` | `CODE / STATIC_CONFIG`（**预算设定，非测量**） |
| ③ `hooks.json` hard timeout | 15000 ms（运行时日志 `timeout=15000ms`） | `RUNTIME_VERIFIED` |
| ④ SessionStart 自身耗时 | 15.552 s（`code=0 elapsed=15552ms`） | `RUNTIME_VERIFIED` |
| ⑤ 整个 SessionStart hook chain | 16.736 s（含其它插件） | `RUNTIME_VERIFIED` |
| ⑥ SQLite 锁竞争 | 写连接 `busyTimeout=0` 不等待；只读连接未设 pragma；6 处连接开关；并发存在但**无 12 s 阻塞证据** | `CODE`，阻塞归因 `NOT_RUN` |
| ⑦ Receipt 写入耗时 | 同步 SQLite `BEGIN IMMEDIATE` 事务 + 4–5 次只读幂等读 + jsonl append；**无耗时测量** | `CODE`，数值 `NOT_RUN` |

明确：**动态读取 `hooks.json` 是正确性与配置漂移防护，不是性能优化**；把它写成性能修复属于 v0.1 的概念混淆（A-30/A-31/A-32 已修正）。`health()` 不是 12 s 来源（E2-23）；`busyTimeout=0` 静态反驳「写连接锁等待 12 s」（E2-24）。

### P0 修复顺序（用户指定，v0.2 全量采纳）

1. **识别导致 12 s 降级的具体阶段** — 在 `pd-hook.ts` 各阶段埋点（模块加载 / config 读 / DB open / activation reader / renderer / emitter / encode），产出阶段级 p50/p95/p99；不得从预算数值反推根因。
2. **优化同步关键路径** — 依据测量结果收敛（候选：合并 3 次 config 读、减少 DB 连接开关、避免写连接 `initSchema/migrateSchema` DDL 进入 UPS 路径）。
3. **把非必要证据写入移出同步路径** — emitter 收敛为单行 `appendEventLogLine`；`recordWorkbuddyPromptDeliveryEvidence` 的同步 SQLite 事务与 `observationKey` 幂等读交由既有 `pd workbuddy worker` 从 journal replay（E2-25/E2-26，最小改动面 `pd-hook.ts:90-123`）。
4. **动态解析实际 host timeout** — 从启用版 `hooks/hooks.json` 读 `timeout`（秒）×1000；删除 `HOST_TIMEOUT_MS`/`SELF_TIMEOUT_MS` 硬编码镜像或改为仅作 fallback；属性测试保证 soft < hard。
5. **保证 self-degradation 不阻断用户提交** — 降级必须 `exit 1`（非阻断），禁止 `continue:false`/`deny`/`exit 2`；wrapper 在 `fail()` 中追加一行 degraded journal（E2-21）。
6. **保证 degraded 状态可观测** — journal-only、无同步 DB、`open→closed` 可复核；reconciliation 兜底宿主 kill。

### 重新定义性能验收（统计解释，A-43）

**负载矩阵**：冷/热进程；空/满 Working Set；最小/最大候选池；Workspace Focus 有/无；Intent 开/关；`SessionStart`+`UserPromptSubmit` 并发；DB 锁争用；超长 transcript；receipt 写入争用；配置 timeout 5 s/15 s/30 s。

**样本量**：每格 ≥ 200 次真实 hook 调用；≥ 3 次独立运行、跨 ≥ 2 个会话/日期；记录 p50/p95/p99/max、dropped/kill 率、degraded 率。

**门禁**：
- `p99(PD 内部同步路径) ≤ softDeadlineMs − 安全余量`；`worst observed < hardTimeoutMs`。
- 同步路径 SQLite 事务数 = 0（emitter 改造后）；receipt 单行 append `p99 ≤ 2 ms`、`max ≤ 5 ms`。
- `execution ∈ {degraded, timeout, failed}` 观测 0 次且 **95% 置信上界 ≤ 1%**；`allowed:false`（阻断）观测 0 次。
- 无 `confirmed` 误报、无跨 session 结果污染。

**统计解释（强制写入 SPEC）**：在 N 次观测中「0 次失败」**不等于**总体失败率为 0；按 rule of three，95% 上界约 `3/N`（N=300 ⇒ ≈1%）。因此验收结论必须写成「在 N=… 样本下，失败率 95% 上界 ≤ …」，并保留上线后 telemetry + §21 Stop Condition 作为持续约束。v0.1 A-29「degraded 率为 0 即可放行」**REJECT**（改为 A-43）。

## R8 — Amendment 内部一致性审查

### 缺陷清单

| C-ID | 缺陷 | 涉及 A-ID |
|:---|:---|:---|
| C-01 | `degraded` 同时被当作 `injectionStatus` 值与执行状态；无状态机、无 `open/closed/reconciled` | A-22/A-25/A-26/A-28/A-32/A-33 |
| C-02 | `taskId`（camelCase）与引擎 `task_id`（snake_case）不符；`sessionSource` 含不存在的 `"compact"` | A-05/A-06/A-07/A-09/A-10/A-16/A-26/A-32/A-34 |
| C-03 | `HOST_TASK_CREATED`/`HOST_TASK_COMPLETED` 被称「deterministic task boundary」并跳过 `principle_decision`，与 R1 冲突 | A-07/A-08/A-32/A-35/A-37(新) |
| C-04 | 「cannot outlive the session」无证据；`async` 从 `SOURCE_CONFIRMED` 升格为「满足 non-blocking 要求 / preferred carrier」 | A-03/A-04/A-14/A-18/A-24/A-31/A-32/A-34/A-35 |
| C-05 | A-06 说 Task/Compaction 事件「0 live samples / NOT_RUN for runtime confirmation」，A-18/A-32 却直接「Use … as refresh triggers / recorded as verified refresh triggers」→ `NOT_RUN` 被升格为 Supported | A-06/A-18/A-32 |
| C-06 | 多版本 `hooks.json` 物理残留被直接认定为重复注入（R6 反驳） | A-02/A-11/A-18/A-29/A-31/A-32/A-33/A-34 |
| C-07 | `PreCompact` 阻断 / `PostCompact` 用 `compact_summary` 重算 fingerprint（R5 反驳） | A-08/A-10/A-12/A-23 |
| C-08 | 12 s 被当成「同步路径已测量」；动态读 hooks.json 被列为性能优化 | A-29/A-30/A-31/A-32 |
| C-09 | Feature Flags：`degraded receipts ON` 作为「唯一例外」，与其它 flag OFF 及 §0 Status 表述张力；async flag 与 A-14「preferred carrier」矛盾 | A-15/A-13/A-31 |
| C-10 | Shadow/Live 门禁不一致：A-31 Gate 0 要求 degraded=0、A-32 要求 async hook 已验证、A-14 要求 Gate 4 探针，三者互相牵连且 async 实际 OFF | A-14/A-31/A-32 |
| C-11 | ADR-015 声称「宿主确定性事件 MUST 优先于模型调用 / 不得重新推导」，与 R1 直接冲突；ADR-016 未覆盖状态阶梯 | A-35 |
| C-12 | 测试 T-07 断言「TaskCreated/SessionEnd/PostCompact 时 `principle_decision` 调用数为 0」→ 断言本身错误；T-08「两版 hooks.json 同时可发现」→ 场景不成立；T-03 未限定 journal-only | 测试汇总 |
| C-13 | **A-36 把尚未实现、尚未验证的内容标为 `PASS (amended)`** → 严重违反状态阶梯 | A-36 |
| C-14 | OQ-21 写「camelCase `taskId`」错误；OQ-06 结论未反映 PD 已有 worker | A-34 |
| C-15 | 官方 D1 的 PreCompact exit2 阻断说法与源码矛盾未登记（新增第 13 项差异） | A-19/Matrix |

### 状态阶梯纠正

v0.2 的 Self-audit 不再使用 `PASS`，改用 `PROPOSED | SPEC_REVISED | IMPLEMENTED | TESTED | RUNTIME_VERIFIED | ACCEPTED`，且每条标注当前状态与所需下一步证据。例：

| Check | Status (v0.2) | Required next evidence |
|:---|:---|:---|
| WorkBuddy injection channel is `user_message_system_reminder` | `SPEC_REVISED`（依据 `SOURCE_CONFIRMED`） | 当前版本请求级 `RUNTIME_VERIFIED` 探针 |
| `degraded` 状态机可观测 | `PROPOSED` | `IMPLEMENTED` + T-03/T-04 + 运行时 journal |
| Host profile binds engine SHA / plugin version / configSha256 | `PROPOSED` | `resolveHostProfile()` 实现 + T-01 |
| Task/Compaction 事件作为 refresh trigger 激活 | `DEFERRED_PENDING_EVIDENCE` | 隔离探针 P3/P4 |
| Host-native async refresh | `DEFERRED_PENDING_EVIDENCE`（保持 OFF） | 隔离探针 P6 + 生命周期验证 |

---

# 3. A-01 至 A-36 逐条重新裁定

> 裁定值：`ACCEPT` / `ACCEPT_WITH_CHANGE` / `REJECT` / `DEFERRED_PENDING_EVIDENCE`。`REJECT` 与 `DEFERRED` 均在「v0.2 修改」列给出替代条目。

| A-ID | v0.1 结论 | 二轮裁定 | 修订理由 | 证据 | v0.2 修改 |
|:---|:---|:---|:---|:---|:---|
| A-01 | Metadata 五元组 + engine SHA + Desktop 描述 | **ACCEPT_WITH_CHANGE** | 版本事实正确，但需标注 `status: PROPOSED / READY_FOR_OWNER_REVIEW`，并加入二轮审查基线；`Verified runtime scope` 改 `CONDITIONALLY_VERIFIED` | E2-…/上一轮 E-01…E-12 | 保留五元组，增 `Amendment review baseline` 行与状态列 |
| A-02 | §0.3 宿主发现重写 | **ACCEPT_WITH_CHANGE** | channel/timeout/two-path 结论正确；但「stale copies + mergeHooks → duplicate registration」被 R6 反驳；需补 Task 语义、PreCompact 更正、12 s 是预算非测量 | E2-14/E2-17/E2-18/E2-30；上一轮 R-08/R-09 | 删除重复注册断言，改为四层 discoverability；增三条事实更正 |
| A-03 | §3.1 架构图加 `Host-native async Hook` 节点 | **REJECT** | 宿主 async 未经运行时验证且 PD 已有 detached worker；把它画成架构节点会把未验证能力固化 | E2-10/E2-12/E2-26/E2-27 | 由 **A-38** 取代：节点改为 `PD existing detached worker (OFF)`，虚线标注 `PROBE_PENDING` |
| A-04 | §3.3「async 进程 cannot outlive the session」 | **REJECT** | 该保证全文 NOT_FOUND，且与源码相反 | E2-11/E2-12/E2-20 | 删除保证；由 **A-38** 写入「可在原 Session 结束后继续」+ 六条安全约束 |
| A-05 | §4.3 `AdaptiveContextSnapshot` 新字段 | **ACCEPT_WITH_CHANGE** | `taskId`→`hostTaskId`（源 `task_id`）；删除 `"compact"`；`compactSummary` 降为 evidence metadata；补「generationId 在 Task/PostCompact payload 中缺省」 | E2-02/E2-09/E2-15/E2-16 | 重写接口与 Rules |
| A-06 | §5.1 映射表 + 「verified refresh triggers」清单 | **ACCEPT_WITH_CHANGE** | Desktop/CLI 引擎与 `lite-wb` 更正正确；但把 0 live samples 事件列为可用 refresh trigger 属 `NOT_RUN`→Supported 升格 | E2-08/E2-28；上一轮 R-14 | 拆成 `RUNTIME_VERIFIED`（4 事件）与 `SOURCE_CONFIRMED / PROBE_PENDING`（其余，默认 OFF）；Task 事件标注为内部 todo 信号 |
| A-07 | §5.2 新增 `HOST_TASK_CREATED`/`HOST_TASK_COMPLETED`「deterministic boundary」 | **REJECT** | TaskCreated 是内部 todo 通知，不是边界 | E2-01…E2-05 | 由 **A-37** 取代：`HOST_TASK_GRAPH_CHANGED`、`HOST_SUBAGENT_SCOPE_CHANGED`、`HOST_SESSION_ENDED`、`HOST_POST_COMPACT`，全部 `semanticAuthority:false` |
| A-08 | §5.4 `determinism-first rule`：Task 事件跳过 `principle_decision` | **REJECT** | **本轮最严重缺陷**：会让宿主事件绕过 PD 原则语义判断，造成错误激活 | E2-01…E2-06 | 由 **A-37** 取代：删除 determinism-first；保留 `trigger 只能请求刷新、不能授权原则`；新增「no semantic bypass」四条硬约束 |
| A-09 | §5.5 checkpoint 与 `continue:false` 禁令 | **ACCEPT_WITH_CHANGE** | `continue:false` 禁令与 generationId 去重正确；但「host lifecycle events 优先于 turn 计数」错误；幂等元组需容忍缺失字段 | 上一轮 H-01；E2-02/E2-09 | 改为「turn 计数仍是主节奏，Task/Compaction 事件不产生 turn」；幂等键改为「必填项 + 可选项，缺失不伪造」 |
| A-10 | §8.2 Working Set 新字段 + PostCompact 重算 fingerprint | **ACCEPT_WITH_CHANGE** | 字段需按 A-05 修正；`compact_summary` 重算 fingerprint 被 R5 反驳 | E2-15 | 改为 `revalidationRequired` + revision 栅栏，下一次 `BEFORE_MODEL_TURN` 从实际上下文重算 |
| A-11 | §8.3.1 多版本 hooks.json 幂等 | **REJECT** | 物理残留 ≠ 重复注册；`mergeHooks` 拼接的是同 root 内不同配置来源 | E2-17/E2-18 | 由 **A-42** 取代：四层 discoverability + 同 root concat 检测 + `configSha256`/`rootFingerprint` |
| A-12 | §9.3 F3 生命周期列表 | **ACCEPT_WITH_CHANGE** | 列表方向正确，但「Deterministic task boundaries (TaskCreated/TaskCompleted)」错误，且缺 PreCompact 不可阻断 / 禁止 LLM / PostCompact 仅观察 | E2-01/E2-14/E2-15/E2-16 | 由 **A-41** 合并重写；Task 项改为「Agent internal plan-item signals」 |
| A-13 | §10.2 YAML 增加 `asyncRefresh` 配置 | **ACCEPT_WITH_CHANGE** | 版本绑定与动态解析正确；`asyncRefresh` 宿主配置应删除；需补 `configSha256`/`rootFingerprint`/`deferredWorker` 与状态列 | E2-17/E2-19/E2-26 | 重写 YAML：`asyncRefresh` → `deferredWorker: {carrier: pd_existing_worker, enabled:false}`；增指纹字段 |
| A-14 | §10.4 以宿主 async hook 为 preferred carrier | **REJECT** | 「satisfies non-blocking requirement」是 SOURCE_CONFIRMED→RUNTIME_VERIFIED 升格；且 PD 已有更合适载体 | E2-10/E2-12/E2-13/E2-26/E2-27 | 由 **A-38** 取代：载体=PD 既有 worker（契约待实现/验证），host async 列 `DEFERRED_PENDING_EVIDENCE` 且 OFF |
| A-15 | §11.2 新增 4 个 flag，`degraded receipts` 为 ON 例外 | **ACCEPT_WITH_CHANGE** | 删除「deterministic task boundaries」flag（R1）；`degraded` journal 不是 feature flag，改列「强制 observability」条款；async flag 保持 OFF | R1/R2/R8 | 由 **A-47** 统一 flag/gate 表；全部新能力 OFF，observability 单独成节 |
| A-16 | §12.2 `HostRuntimeCapabilityProfile` 接口 | **ACCEPT_WITH_CHANGE** | `enabledPluginRoot` 绝对路径需删；`identity.taskId` 改名；`asyncCapability` 重构；`refreshEvents` 加 `semanticAuthority:false`；`status` 用状态阶梯 | E2-02/E2-09/E2-12/E2-17/E2-19 | 重写接口（见 v0.2 §2 A-16′） |
| A-17 | §12.3 Verified Host Matrix WorkBuddy 行 | **ACCEPT_WITH_CHANGE** | 需按 R1/R5/R6 更正：Task 事件标注内部 todo、0 live samples；PreCompact 不阻断；重复注册断言删除；证据等级逐项标注 | E2-01…E2-18 | 重写矩阵行 + Evidence interpretation 三条 |
| A-18 | §12.4 WorkBuddy 执行规则 | **ACCEPT_WITH_CHANGE** | 删除「Task… 作为 refresh triggers（determinism-first）」、删除 async carrier 行、删除「stale version dirs must not be discoverable」；补 R1 分类、R5 压缩条款、R6 指纹 | R1/R2/R5/R6 | 重写整节 |
| A-19 | §12.5 新增规则 11–13 | **ACCEPT_WITH_CHANGE** | 11–13 正确，需补 14（源码出现事件名 ≠ 语义支持）、15（证据等级不得升格）、16（PROBE_PENDING 不得当 Supported） | R8/E2-31 | 追加 14–16 |
| A-20 | §13.2 Channel Matrix | **ACCEPT** | `user_message_system_reminder` + first/last 经源码与历史 P04 双重确认，无本轮反证 | 上一轮 S-16/S-17/H-02 | 原文保留 |
| A-21 | §13.3 Injection Content Rules | **ACCEPT_WITH_CHANGE** | 内容约束正确；补「truncation 记录必须 journal-only，不得新增同步 DB 操作」 | E2-22/E2-25 | 追加一条 |
| A-22 | §13.4 把 `degraded` 加入 `injectionStatus` | **REJECT** | 混淆执行状态与交付状态，无法表达 completed+none | R3 | 由 **A-39** 取代：三维状态机 + 六条不变量 |
| A-23 | §14.3 超时与失败语义表 | **ACCEPT_WITH_CHANGE** | two-path 结论正确；需补 PreCompact 不阻断、PostCompact 仅观察、七维耗时分离，并去掉把 12 s 当阶段测量的措辞 | E2-14/E2-30；上一轮 S-12/S-14 | 重写表后说明 |
| A-24 | §14.2 追加「host-native detached async hook」 | **REJECT** | 未验证能力不得写入执行前提 | E2-12/E2-26 | 由 **A-38** 取代 |
| A-25 | §14.5 Failure Matrix 追加行 | **ACCEPT_WITH_CHANGE** | 需改用状态机词汇；删除「duplicate/stale registration」误判行；补宿主 kill 无 receipt、Pre/PostCompact、journal-only 约束 | R3/R5/R6 | 重写追加行 |
| A-26 | §15.2 receipt `host`/`identity`/`delivery` + boolean `lifecycle` | **REJECT** | 单维 injectionStatus + boolean 生命周期无法形成证据链，且绝对路径入长期 receipt | R3/R4/R6 | 由 **A-39 + A-40 + A-42** 取代 |
| A-27 | §15.3 新增事件类型 | **ACCEPT_WITH_CHANGE** | 事件名需按 R1/R2/R6 改名并补充：`host_task_graph_changed`、`post_compact_invalidated`、`hook_config_source_concat_detected`、`receipt_reconciled`、`worker_result_stale_discarded` | R1/R2/R5/R6 | 重写事件联合类型 |
| A-28 | §15.5 WorkBuddy 证据条款 | **ACCEPT_WITH_CHANGE** | channel 结论正确；`confirmed` 仍需请求级证据；`degraded` 改为 journal 行；删除「a `degraded` receipt」措辞，改三维状态；补 lifecycle stage 规则 | R3/R4 | 重写 |
| A-29 | §17.3 性能探针 P0 化 | **ACCEPT_WITH_CHANGE** | P0 化正确；删除「two plugin versions enabled」场景；补阶段级 instrumentation；「degraded=0 放行」改统计验收 | R6/R7/E2-30 | 由 **A-43** 合并重写 |
| A-30 | §17.4 WorkBuddy 性能条 | **ACCEPT_WITH_CHANGE** | 动态解析是正确性不是性能优化；需列七维分离；SessionStart chain 单独记录 | R7/E2-30 | 重写 |
| A-31 | §19 Phase 0 / Gate 0 / Gate 2 | **ACCEPT_WITH_CHANGE** | 删除 Task 12（stale cleanup）与 Task 14 中「including async hook」的启用含义；按 R7 六步重排 P0；Gate 0 改统计门禁；async 保持 OFF | R2/R6/R7 | 重写 |
| A-32 | §20 验收补充项 | **ACCEPT_WITH_CHANGE** | 删除「deterministic host task boundary 不调用 principle_decision」与「host-native async hook verified」；改状态机、stage observation、统计门禁、no-bypass | R1/R2/R3/R4/R7 | 重写各分组 |
| A-33 | §21 Stop Conditions 追加 | **ACCEPT_WITH_CHANGE** | 15/16/17/18 需改用状态机词汇；17 的「多版本 discoverable」按 R6 改为「同 root 多配置来源 concat」 | R3/R6 | 重写 |
| A-34 | §22 OQ 状态表 | **ACCEPT_WITH_CHANGE** | OQ-06 结论改为「PD 已有 worker；host async OFF」；OQ-21 改 snake_case；新增 OQ-22…OQ-25（阶段归因、统计门禁、PostCompact、discoverability） | R1/R2/R6/R7 | 重写 |
| A-35 | §23 新增 ADR-015 / ADR-016 | **REJECT** | ADR-015「宿主确定性事件 MUST 优先、不得重新推导」与 R1 直接冲突；ADR-016 缺状态阶梯 | R1/R8 | 由 **A-45** 取代：ADR-015′（宿主事件不得绕过语义判断）、ADR-016′（分模式证据 + 状态阶梯）、ADR-017（交付证据封闭世界默认） |
| A-36 | §24/§25 把未实现项标 `PASS (amended)` | **REJECT** | 提案状态被标成 PASS，严重误导 | R8/C-13 | 由 **A-44** 取代：状态阶梯 Self-audit 表，全部条目标 `PROPOSED`/`SPEC_REVISED`/`DEFERRED_PENDING_EVIDENCE` |

**统计**：ACCEPT 1 / ACCEPT_WITH_CHANGE 23 / REJECT 12 / DEFERRED_PENDING_EVIDENCE 0（延后项以新增 A-48 承载）。

---

# 4. 新增条目 A-37 起

| A-ID | 主题 | 裁定 | 取代 / 补充 |
|:---|:---|:---|:---|
| A-37 | §5.2/§5.4 Task/Subagent 语义分类、`HOST_TASK_GRAPH_CHANGED`、no-semantic-bypass 四约束 | **ACCEPT** | 取代 A-07/A-08，补 A-06/A-18 |
| A-38 | §3.1/§10.4/§14.2 Deferred Refresh 载体与「worker 可超出 Session」六条安全契约 | **ACCEPT** | 取代 A-03/A-04/A-14/A-24 |
| A-39 | §13.4/§15.2 Delivery Integrity 三维状态机 + 迁移规则 + 六不变量 | **ACCEPT** | 取代 A-22 与 A-26 的 delivery 部分 |
| A-40 | §15.2 Lifecycle Stage Observations（6 阶段 × StageObservation） | **ACCEPT** | 取代 A-26 的 boolean lifecycle，补 A-28 |
| A-41 | §8.2/§9.3/§12.4 Compaction 契约（PreCompact 不阻断 / 禁 LLM / PostCompact 仅失效信号） | **ACCEPT** | 取代 A-12，补 A-08/A-10/A-23 |
| A-42 | §8.3.1/§12.2 Plugin Identity 指纹 + 四层 discoverability | **ACCEPT** | 取代 A-11，补 A-16/A-18/A-02 |
| A-43 | §17.3/§17.4/§20 七维耗时分离 + 统计性能验收 | **ACCEPT** | 合并 A-29/A-30 |
| A-44 | §24/§25 状态阶梯 Self-audit | **ACCEPT** | 取代 A-36 |
| A-45 | §23 ADR-015′/016′/017 | **ACCEPT** | 取代 A-35 |
| A-46 | §2.1 证据等级纪律 + `PROBE_PENDING` 状态 | **ACCEPT** | 新增，修复 C-04/C-05 |
| A-47 | §11/§19 Flag 与 Gate 一致性表 | **ACCEPT** | 取代 A-15 的 flag 表，修复 C-09/C-10 |
| A-48 | Task/Subagent/Compaction 事件作为 refresh trigger 的**激活**、host-native async refresh、当前版本 `confirmed` 声明 | **DEFERRED_PENDING_EVIDENCE** | 明确列出全部保持 OFF 的能力与所需探针 |

---

# 5. Gap 严重度重估（对 `PD_WORKBUDDY_INTEGRATION_GAP_AUDIT_v0.1.md` 的修正）

| Gap | v0.1 | v0.2 重估 | 理由 |
|:---|:---|:---|:---|
| GAP-01 注入静默丢失 | P0 | **P0 保持** | R7 进一步给出六步可实施修复与最小改动面 |
| GAP-02 delivery 状态 | P0 | **P0 保持并扩大** | v0.1 只加 `degraded` 不足；需三维状态机 + 宿主 kill 兜底 + 无同步 DB |
| GAP-03 wrapper 硬编码 deadline | P0 | **P0 保持** | 动态解析属**正确性**修复，不能当性能优化 |
| GAP-04 注入角色 UNKNOWN | P1 | **P1 保持** | 本轮无反证 |
| GAP-05 基线失效 | P1 | **P1 保持** | 本轮再次确认引擎 2.165.0 |
| GAP-06 `lite-wb` 概念 | P1 | **P1 保持** | 本轮无反证 |
| GAP-07 tool events NOT_RUN 过时 | P1 | **P1 保持** | 164/162 真实派发 |
| **GAP-08 Task 边界未用于 Task Change Detection** | P1 | **REJECT / 关闭** | R1：宿主没有确定性用户任务边界；该 Gap 的前提不成立。**替换为新缺陷 G2-01**：「v0.1 把内部 todo 事件当作确定性边界，会造成错误激活」（**P0，设计层**） |
| **GAP-09 未利用 async hook** | P1 | **降级 P3 / 重定义为「async 启用条件未验证」** | R2：host async 运行时 NOT_RUN，且 PD 已有 worker；「未利用」不是缺陷 |
| **GAP-10 多版本 hooks.json 重复注册** | P1 | **降级 P3** | R6：物理残留 ≠ 重复注册；真实 concat 路径为同 root 多配置来源，属低概率配置错误 |
| GAP-11 Profile 无实现 | P1 | **P1 保持** | 本轮 E2-28 再次确认 |
| GAP-12 生命周期字段缺失 | P1 | **P1 保持，语义收窄** | R1/R5：只能作为 provenance/失效信号，不能当边界 |
| 新增 **G2-02** | — | **P0** | Amendment v0.1 的 `determinism-first rule` 会让宿主事件绕过语义判断（本次审查对象自身的缺陷） |
| 新增 **G2-03** | — | **P1** | Receipt 写入含同步 SQLite 事务，可能加重已有 P0 性能问题；且降级路径完全无留痕 |
| 新增 **G2-04** | — | **P2** | A-36 把 PROPOSED 标成 PASS，状态机缺失 |

---

# 6. 保持 OFF / 等待真实探针的能力清单（A-48 摘要）

| 能力 | 状态 | 所需证据 |
|:---|:---|:---|
| WorkBuddy host-native `async:true` refresh | **OFF / DEFERRED** | 隔离探针：detach 立即返回、`asyncTimeout` 生效、Session 结束后进程行为、结果提交校验 |
| `TaskCreated`/`TaskCompleted`/`Subagent*`/`PreCompact`/`PostCompact` 作为 refresh trigger 激活 | **OFF / DEFERRED** | 隔离探针 P3/P4：真实派发、payload 形状、`compact_summary` 行为、并发语义 |
| Model-assisted Shadow / Live | **OFF** | R2 的 worker 契约实现 + Gate 0–5 全通过 |
| 当前 2.165.0 的 `confirmed` 声明 | **禁止声明** | 请求级证据（mock request diff / 宿主请求日志） |
| Desktop UI-only / standalone IDE runtime | **NOT_RUN** | 独立模式隔离探针 |
| 多宿主统一 timeout / channel / 事件映射 | **禁止** | 各宿主独立 profile |
| 同 root 多 hook 配置来源 concat 检测 | **PROPOSED** | 配置层测试 T-08′ |

---

# 7. 最终裁定

## 7.1 七个必答

1. **v0.1 是否存在可能导致错误激活的设计？** — **是，且是本轮最严重发现**。A-08/A-07/ADR-015 的「determinism-first rule」把 `TaskCreated` 映射为确定性 `NEW_TASK` 并跳过 `principle_decision`；但 `TaskCreated` 是 Agent 内部 todo 工具通知（E2-01…E2-05），一次用户请求可产生 N 个，且 payload 无 prompt/turn。若按 v0.1 实施，**每次 Agent 拆解计划都会触发原则重选**，产生大量错误激活与成本浪费。此外 A-08/A-10 把 `compact_summary` 当 fingerprint 输入（R5）也是错误激活来源。v0.2 已全部删除并加入 no-semantic-bypass 硬约束。

2. **TaskCreated 是否可以直接替代 Decision Model？** — **绝对不能**。它既不是用户任务边界，也不携带用户请求语义，无法关联原始请求，且是 best-effort 派发（E2-08）。它最多作为 `HOST_TASK_GRAPH_CHANGED` 弱信号用于 provenance / 重校验提示。

3. **Async Hook 是否已经具备启用条件？** — **否**。① 运行时 `NOT_RUN`；② 「cannot outlive the session」无证据且机制上相反（E2-11/E2-12）；③ `asyncTimeout` 不校验结果提交（E2-13）；④ PD 已有更合适的 detached worker + DB lease（E2-26），但 Deferred Refresh 契约仍 `NOT_FOUND`（E2-27）。host-native async refresh 保持 **OFF / DEFERRED_PENDING_EVIDENCE**。

4. **Delivery Integrity 是否形成了真正完整的证据链？** — v0.1 **没有**（单维 injectionStatus、boolean lifecycle、宿主 kill 无兜底、receipt 写同步 DB）。v0.2 **在契约层形成**：三维状态机（execution / payload / selection）+ evidence + open/closed/reconciled、六不变量、六阶段独立 StageObservation、封闭世界默认（未知不算成功）、journal-only 无同步 DB、后台 worker 对账。但**当前 2.165.0 环境链条止于 `returned`**，`confirmed` 明确不得声明——这正是「不凭空声明自己无法证明的状态」。

5. **P0 问题是否有明确、可实施的修复方案？** — **有**。六步顺序（§2 R7）+ 最小改动面收敛到 `pd-hook.ts:90-123` emitter（同步 SQLite → 单行 append，重证据交既有 worker replay）+ `wrapper.cjs:76-81` 追加一行 degraded journal + 动态解析 hooks.json + 属性测试 + 统计验收。静态证据充分（E2-21/E2-22/E2-25/E2-26），但**阶段级耗时归因仍需实测**，不得从 12 s 预算数值反推根因。

6. **哪些修改必须进入 v0.5？** — ① R1 的 Task/Subagent 语义分类与 `HOST_TASK_GRAPH_CHANGED` + no-semantic-bypass（A-37）；② 删除 A-08 determinism-first 与 ADR-015（A-45）；③ R2 的 outlive-session 契约与 PD worker 载体（A-38）；④ R3 三维状态机 + journal-only（A-39）；⑤ R4 六阶段 StageObservation（A-40）；⑥ R5 Compaction 契约（A-41）；⑦ R6 指纹替代绝对路径 + 四层 discoverability（A-42）；⑧ R7 七维分离 + 统计验收（A-43）；⑨ R8 状态阶梯 Self-audit（A-44）；⑩ 全部 flag/gate 一致性（A-47）；⑪ A-48 的 OFF 清单。**P0 修复顺序与「动态解析不是性能优化」必须写入 §17/§19**。

7. **哪些能力应继续保持 OFF，等待真实探针？** — 见 §6 清单：host async refresh、Task/Subagent/Compaction 刷新触发激活、Model-assisted Shadow/Live、`confirmed` 声明、Desktop/IDE 模式、跨宿主统一映射。

## 7.2 最终状态

> ## **READY_FOR_OWNER_REVIEW**
>
> - 不是 `NEEDS_AMENDMENT_REVISION`：v0.2 已完成全部修订，内部一致性缺陷 C-01…C-15 已逐项闭环，A-01…A-36 全部重新裁定。
> - 不是 `BLOCKED_BY_MISSING_EVIDENCE`：缺失证据的部分已从「设计为已支持」改为「明确 OFF + `DEFERRED_PENDING_EVIDENCE` + 探针清单」，不再阻塞修正案本身。
> - **但这是「修正案可提交 Owner 评审」的结论，不是「SPEC v0.5 可定稿 / 可上线」**：P0 同步路径阶段归因、隔离探针 P1/P3/P4/P6、`confirmed` 请求级证据、Model-assisted 门禁仍是实现期硬前置；12 s 自降级与零注入的 P0 问题**仍然开放**。
> - Owner 评审时应特别关注：① 是否接受「宿主事件不得绕过语义判断」这一相对 v0.1 的方向性反转；② 是否接受把 Deferred Refresh 载体从宿主 async hook 改回 PD 既有 worker；③ 是否接受用统计上界（而非「0 次失败」）作为性能门禁。

---

# 8. 本轮执行纪律核对

| 允许项 | 执行 |
|:---|:---|
| 阅读 PD 当前源码、宿主 2.165.0 源码、Amendment v0.1 与五份审计材料 | ✅ |
| 检查现有测试与接口定义 | ✅ |
| 静态调用链追踪 | ✅ |
| 在独立文档中修改建议文本 | ✅ 生成 2 份新文档 |
| 禁止项 | 是否触碰 |
| 修改 SPEC v0.4 原文 | ❌ 未 |
| 修改生产代码 | ❌ 未 |
| 修改 WorkBuddy 安装配置 | ❌ 未 |
| 修改生产数据库 | ❌ 未 |
| 在真实生产会话测试阻断行为 | ❌ 未 |
| 未经隔离验证启用 async hook | ❌ 未（保持 OFF） |
| 合并 PR / 部署 / 发布 | ❌ 未 |
| 打印 API Key / Token / Cookie | ❌ 未 |

---

**END OF PD_WORKBUDDY_AMENDMENT_ADVERSARIAL_REVIEW_v0.1.md**
