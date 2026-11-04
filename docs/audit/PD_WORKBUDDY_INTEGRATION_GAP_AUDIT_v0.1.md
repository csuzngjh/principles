# PD × WorkBuddy Integration Gap Audit v0.1

> **PD_WORKBUDDY_INTEGRATION_GAP_AUDIT_v0.1.md** — PD 当前 WorkBuddy 集成缺陷与风险清单
> 基线：2026-11-04 / WorkBuddy Desktop 5.9.2 / 引擎 2.165.0 / PD 插件 0.2.2 / SPEC v0.4（SHA-256 `c022cd66…`）
> 配套：`PD_WORKBUDDY_HOST_AUDIT_v0.1.md` §5、§6；`PD_WORKBUDDY_CAPABILITY_MATRIX_v0.2.md`

## 0. 四类优先风险判定（用户指定优先级）

| 风险类别 | 本轮是否实证 | 结论 | 关联 Gap |
|:---|:---|:---|:---|
| **用户提交阻断** | **实证未发生，但存在条件性风险** | 本次会话 PD UPS hook 以 `exit 1` 降级，宿主按非阻断放行，会话正常继续；真实阻断记录 0 条。但 `wrapper.cjs` 把 self-deadline 硬编码为 12 s / 25 s，不读取实际生效的 `hooks.json` timeout，一旦宿主把 UPS 收紧到 <12 s，PD 会先被宿主 kill（`exitCode:-1, allowed:false`）→ 按源码 `UserPromptSubmit` 会**阻断并清除提示词** | **GAP-03 (P0)**、GAP-11 (P1) |
| **原则注入丢失** | **已实证发生（本次会话）** | `14:52:48.651` `code=1 elapsed=12113ms`，`[PD] status=degraded entry_deadline_exceeded:12021ms_budget_12000ms`；本次会话 `runtime_v2_prompt_activations_injected` 真实记录 **0 条**。用户只看到一条宿主界面警告，PD 侧无 `degraded` delivery 状态 | **GAP-01 (P0)**、**GAP-02 (P0)** |
| **跨 Session 污染** | **未实证，存在结构性风险** | PD 用 `sessionId` + `observationKey` 做幂等，`evidence-concurrency.test.ts` 覆盖并发；但：① 三版 `hooks.json` 物理并存 + 宿主 `mergeHooks` 拼接 → 可能同会话双重注册/重复刷新；② `SessionStart` 无 `cwd`，PD 用**全局治理目录** `~/.workbuddy/pd-workspace` 兜底；③ 无 `SessionEnd` / `PostCompact` 生命周期终点，Working Set 只能靠 24 h TTL 过期；④ 无运行时 `HostRuntimeCapabilityProfile` 校验版本/模式变更 | GAP-09 (P1)、GAP-10 (P1)、GAP-12 (P1) |
| **错误激活** | **未实证，存在设计性风险** | 宿主已提供确定性 `TaskCreated`/`TaskCompleted`/`SessionEnd`/`PreCompact`/`PostCompact` 边界，PD 完全未接入；v0.4 仍以 turn 计数 + fingerprint + LLM Decision Model 为主，且明确禁止把 tool/compaction 事件当设计输入 → 用模型推断去重复宿主已确定给出的信号，增加误判与不必要模型调用 | GAP-06 (P1)、GAP-07 (P1)、GAP-08 (P1) |

> **判定纪律**：文档措辞、命名、注释类问题一律不高于 P2；只有「已实证的生产失效」「可能阻断提交」「结构性隔离风险」「会造成错误激活」才进入 P0/P1。

## 1. Gap 汇总矩阵

| ID | 严重度 | SPEC 章节 | 一句话问题 | 改代码 | 改 SPEC |
|:---|:---|:---|:---|:---|:---|
| GAP-01 | **P0** | §12.4, §14.1, §14.5, §17, §20G, §21 | 生产会话已因 12 s 自降级发生**原则注入静默丢失** | ✅ | ✅ |
| GAP-02 | **P0** | §13.4, §15.2, §15.4, §15.5, §20H | adapter 只有 `submitted/attempted`，无 `degraded`，无法区分「空返回」与「注入成功」 | ✅ | ✅ |
| GAP-03 | **P0** | §12.2, §14.3, §14.4, §17.4, §21(12) | wrapper 硬编码 12 s/25 s，不感知实际生效 timeout，配置漂移时可导致宿主 kill → 阻断提交 | ✅ | ✅ |
| GAP-04 | **P1** | §0.3, §12.3, §12.4, §13.2, §13.3, §15.5, §22 OQ-15 | 注入角色 SPEC 标 `UNKNOWN`，实际为 **user 消息内 hook system-reminder** | ✅（注释/契约） | ✅ |
| GAP-05 | **P1** | Metadata, §2.1, §12.1, §12.3, §19 Phase 0, §20F | Host evidence baseline 仍是引擎 2.161.0 / 5.8.1 / PD 0.2.0，当前为 2.165.0 / 5.9.2 / 0.2.2；按 §12.1「版本变更 profile 失效」规则，所有 VERIFIED-E3 应重新冻结 | ✅ | ✅ |
| GAP-06 | **P1** | §0.3, §5.1, §12.3, §12.4, §20F | 「`lite-wb` CLI」被当作独立 runtime mode；实际是 Desktop 承载 CLI 引擎子进程，`lite-wb` 只是引擎文件名 | ❌ | ✅ |
| GAP-07 | **P1** | §5.4, §5.5, §12.3, §12.4, §17.5, §25.2 | 把 WorkBuddy tool/compaction 事件写成 `NOT_RUN` 且「不得作为设计输入」；当前实测 PreToolUse 164 / PostToolUse 162 次派发，源码有 PreCompact/PostCompact 真实派发点 | ✅ | ✅ |
| GAP-08 | **P1** | §5.4, §5.6, §5.8, §6, §17.5 | 宿主 `TaskCreated`/`TaskCompleted`/`SessionEnd` 可直接产出确定性任务边界，SPEC 未绑定，仍主要依赖 LLM Decision Model | ✅ | ✅ |
| GAP-09 | **P1** | §10.4, §14.2, §3.1, §3.3, §19 Phase 4 | 宿主原生提供 `async:true` + `asyncTimeout` detached hook，SPEC 仍写「不要假设宿主支持后台执行」「无安全 worker 则 Shadow/Live 保持 OFF」 | ✅ | ✅ |
| GAP-10 | **P1** | §8.3, §8.5, §12.5, §14.5, §20D | 三版 `hooks.json` 物理并存 + `mergeHooks` 数组拼接（非覆盖）→ 多版本同时注册会重复注入/重复刷新；§8.3 只覆盖 DB 层 revision 并发 | ✅ | ✅ |
| GAP-11 | **P1** | §12.2, §10.2, §20F | `HostRuntimeCapabilityProfile` 只有 SPEC 里的 TypeScript 接口，**无运行时实现**；installer 只管插件自身版本，不绑定宿主/引擎版本 | ✅ | ✅ |
| GAP-12 | **P1** | §4.3, §5.3, §8, §9.2, §9.3(F3) | 只注册 5 事件 / 4 内部事件，缺 `SessionEnd` 生命周期终点、`PreCompact`+`PostCompact` 检查点、`generationId` 轮内关联、`taskId` 任务边界 | ✅ | ✅ |
| GAP-13 | P2 | §5.5, §14.5 | `PreToolUse` 使用 `continue:false` 会导致用户 prompt 被重新提交、UPS 再次派发 → 重复刷新；SPEC 只泛泛要求「幂等」 | ✅ | ✅ |
| GAP-14 | P2 | §13.3, §7.2, §7.4, §20G | `additionalContextLimit: 10000`（Codex canonical）在当前 WorkBuddy 引擎零命中；注入进 user 消息、宿主侧无长度闸门 | ✅ | ✅ |
| GAP-15 | P2 | §2.1, §12.5, §25.1 | 未建立「CLI / IDE / Desktop 官方文档 ≠ 源码 ≠ 运行时」的分模式证据规则；三者在事件数、配置覆盖、exit 2 消息来源、SessionStart 去重上直接矛盾 | ❌ | ✅ |
| GAP-16 | P2 | §15.2, §15.3, §19 Phase 3, §20H | adapter 无法区分「插件已安装 / 已加载 / 已派发 / 已注入」四层；未启用时 hook 根本不触发、无任何 PD 日志 | ✅ | ✅ |
| GAP-17 | P2 | §12.2, §14.4, §17.3 | 本次 `SessionStart` 实测 15.552 s、整链 16.736 s（30 s budget 过半），SPEC 预算模型只覆盖 UPS 同步路径 | ❌ | ✅ |
| GAP-18 | P2 | §19 Gate 3, §20F, §20G, §20H | 测试缺口：无真实宿主派发自动化断言、无当前版本注入进入模型请求的运行时确认、无版本绑定、无 cache↔canonical 一致性守卫、Desktop/IDE 未覆盖 | ✅ | ✅ |
| GAP-19 | P2 | §10.2, §12.5, §19 Phase 0 | 官方写 `~/.codebuddy/settings.json`，实际 `~/.workbuddy/settings.json` 且**无顶层 `hooks` 键**；PD 不能靠用户级配置覆盖 hook，只能改插件 hooks.json（且需 `/hooks` 审查 / 重启才生效） | ❌ | ✅ |
| GAP-20 | P3 | §12.4（代码注释） | `host-adapter.ts:17-20` 注释称 `PostToolUseFailure` 未注册，与 `hooks.json:27` 已注册矛盾（过时注释） | ✅ | ❌ |
| GAP-21 | P3 | §2.1, §25.1 | `HOST_CONTRACT_BASELINE = 'WorkBuddy Desktop 5.8.1 / engine 2.161.0'` 把 headless CLI + mock model 取证命名为 Desktop，属措辞层外推 | ✅ | ❌ |
| GAP-22 | P3 | Metadata, §2.1, §19 Phase 0 | SPEC 引用的「PD Host Event Capability Matrix v0.1 — Live Runtime Verification」独立文件与私有 `docs/reports/workbuddy-host-adapter-20261012/` 原始探针证据在仓库内 **NOT_FOUND**，证据链不可复核 | ❌ | ✅ |

**分布**：P0 = 3、P1 = 9、P2 = 7、P3 = 3，共 22 项。

## 2. P0 详情

### GAP-01 — 生产会话已发生原则注入静默丢失

| 字段 | 内容 |
|:---|:---|
| 严重度 | **P0** |
| SPEC 章节 | §12.4（WorkBuddy 执行规则）、§14.1（同步 Hook 策略）、§14.5（Failure Matrix）、§17.3（性能探针）、§20G、§21 |
| 当前设计 | SPEC 假设 hook 会在 soft deadline 前完成「读 Working Set → Native → 打包 → 渲染 → 编码 → 回执」，并把「无安全 worker 则 Model-assisted 关闭」作为护栏；§17.3 把「PD Hook Performance Probe」列为**尚未执行**的 Phase 2 任务 |
| 实际宿主能力 / 事实 | 宿主给 UPS 15 s（`timeout=15000ms`）；PD wrapper 自己设 12 s self-deadline。本次会话 14:52:36.544 spawn、14:52:48.651 以 `code=1 elapsed=12113ms` 退出，PD 报 `status=degraded reason=workbuddy_wrapper:entry_deadline_exceeded:12021ms_budget_12000ms`；宿主按 exit 1 非阻断放行；本次会话 `runtime_v2_prompt_activations_injected` 真实记录 **0** 条 |
| 证据 | `logs/2026-11-04/principles__97f0a2a3eefec09106aaa9b4220263bb.log:L2403`（spawn）、`14:52:48.651`（abnormal exit + degraded 诊断）、`runtime_v2_prompt_activations_injected` 过滤工具回显后计数 0 — `RUNTIME_VERIFIED`；`plugin/scripts/wrapper.cjs:55,61,113-143` — `SOURCE_CONFIRMED` |
| 影响 | **当前每一次超过 12 s 的用户提交都不会收到任何原则**。用户无感知（只有一条界面 warning），Examiner 无法归因，§15 的证据链第一环节就断了。SPEC 却把性能探针列为未来任务，事实是生产环境已经在降级 |
| 建议修复 | ① 立即测量并拆解 PD 同步路径（DB 读 / activation reader / renderer / receipt）耗时，找出 12 s 来源，目标把 p99 压到 host timeout 的 30% 以内；② 同步路径改为「先返回可用缓存/Native 的最小内容，慢工作（receipt、evidence 落盘）移出关键路径或异步化」；③ 在 profile 中记录实测 p50/p95/p99 与 degraded 率；④ 把「静默降级导致注入丢失」写入 §21 Stop Conditions 与 §20 验收 |
| 改代码 | ✅ |
| 改 SPEC | ✅ |

### GAP-02 — delivery 状态无法表达 degraded

| 字段 | 内容 |
|:---|:---|
| 严重度 | **P0** |
| SPEC 章节 | §13.4（Delivery Status）、§15.2（Receipt Contract）、§15.4（Evidence Semantics）、§15.5、§20H |
| 当前设计 | SPEC 定义 `returned / confirmed / skipped / timeout / failed / unknown` 六态，并明确 `returned ≠ confirmed` |
| 实际实现 | `workbuddy-evidence-recorder.ts:37-44` 声明 `maxConfirmation:'submitted'`、`stdout submission is the proof boundary`；`:147` payload 固定 `confirmation:'submitted', outcome:'attempted'`，注释 `submitted ≠ delivered`。**没有 `degraded` 态，也没有把 wrapper 的 self-deadline 降级映射到 delivery**。`pd-hook.ts:6-24` 的 degraded 路径只写 stderr + exit 1 |
| 证据 | `packages/workbuddy-adapter/src/workbuddy-evidence-recorder.ts:37-44,147`；`src/pd-hook.ts:6-24,59-61` — `CODE`；本次会话日志 — `RUNTIME_VERIFIED` |
| 影响 | 本次会话「0 注入」在 PD 证据面**不可见**。§15.4「不要从 returned / 无异常 / fail-open 推断 confirmed」的纪律是对的，但实现连 `failed/skipped` 都没落地，Examiner 无法统计注入成功率，Gate 5「无 prompt blockage / delivery statuses are honest」无法验证 |
| 建议修复 | ① 在 `AdaptiveActivationReceipt.delivery.injectionStatus` 联合类型中新增 `degraded`（与 `timeout`/`failed` 并列），并在 receipt 中新增 `degradationReason` / `selfDeadlineMs` / `hostTimeoutMs`；② wrapper 降级时必须写一条结构化 receipt（可在 SIGTERM 前用非阻塞写）；③ 新增 `injection_degraded` 事件；④ §15.4 增加「degraded 不是 skipped，也不得计为 unknown 之外的成功」 |
| 改代码 | ✅ |
| 改 SPEC | ✅ |

### GAP-03 — wrapper 硬编码 deadline 不感知实际生效配置

| 字段 | 内容 |
|:---|:---|
| 严重度 | **P0** |
| SPEC 章节 | §12.2（timing 字段）、§14.3、§14.4（Soft Deadline Resolution）、§17.4、§21(12) |
| 当前设计 | §14.4 明确要求「使用实际安装的 host/plugin 版本，不要猜测 canonical 值」「`softDeadlineMs` 必须低于所有硬限制」「不要设置全局 hook timeout」；`ResolvedExecutionBudget.source` 有 `installed_config` |
| 实际实现 | `wrapper.cjs:55` `HOST_TIMEOUT_MS = { UserPromptSubmit: 15000, default: 30000 }`、`:61` `SELF_TIMEOUT_MS = { UserPromptSubmit: 12000, default: 25000 }` 均为**源码常量**，运行时不读取插件自己的 `hooks/hooks.json`。`plugin-skeleton.test.ts:156` 只做静态 mirror 断言，且只针对 canonical 15 s |
| 证据 | `packages/workbuddy-adapter/plugin/scripts/wrapper.cjs:55,61` — `SOURCE_CONFIRMED`；0.2.0 `hooks.json`（全 30 s，SHA `d9a2a29c…`）与 0.2.2（15 s，SHA `556d546a…`）— `STATIC_CONFIG`；`ENGINE:L576 @3598100` `timeout×1000` 与 `L572 @3579307` 超时 kill — `SOURCE_CONFIRMED`；`L2270 @7486690` UPS `!allowed` 抛 `HookBlockedError` — `SOURCE_CONFIRMED` |
| 影响 | ① 在 0.2.0（30 s）环境里 PD 12 s 就降级，白白牺牲可用预算（**已发生**）；② 若宿主/插件把 UPS 收紧到 <12 s，PD 的 12 s 降级来不及执行，宿主先 kill → `allowed:false` → **阻断并清除用户提示词**；③ 与 §14.4「source=installed_config」的设计直接违背 |
| 建议修复 | ① wrapper 启动时读取 `${CODEBUDDY_PLUGIN_ROOT}/hooks/hooks.json` 的当前事件 `timeout`，用 `min(hostTimeout, configuredTimeout)` 计算 hard limit，再按实测 p99 推导 soft deadline（带安全余量）；② 用环境变量提供 override 但必须 clamp 在 hard limit 之下；③ 把 `resolvedExecutionBudget` 写进 receipt；④ 测试改为「给定任意 hooks.json timeout，self-deadline 恒 < hard limit」的属性测试，而非静态数值 mirror |
| 改代码 | ✅ |
| 改 SPEC | ✅ |

## 3. P1 详情

### GAP-04 — 注入消息角色标为 UNKNOWN
- **SPEC**：§0.3 / §12.3 / §13.2 写「Injection occurred; role/channel UNKNOWN」，§22 OQ-15 列为待查，§13.3 因此要求「不假设消息角色或优先级」。
- **实际**：`ENGINE:L116 @1387419–@1389139` `injectHookContexts` 把 `additionalContext` 包成 ``<system-reminder data-role="hook">`` 并 `addSystemReminder(..., "last")` 追加到 `t.input`；`L97 @1309781` 的守卫构造 `role:"user"` 且 `isUserMessage(t)` 限制；历史 P04 `model-request-injection-shapes.json:5-22` 给出 `role:"user"`、注入块位于 `<user_query>` 之前 — `SOURCE_CONFIRMED + HISTORICAL_PROBE`。
- **影响**：策略「内容自包含、不假设 system 优先级」结论正确但理由过时；更重要的是**未识别出注入在 user 消息内**这一结构性事实：它与 `<user_query>` 并列，模型可能把它当作用户自身内容；且 Codex 的 `developer`、OpenClaw 的 `system` 都不能类比。SPEC §13.2 的 channel 枚举里也没有对应值。
- **修复**：channel 改为 `user_message_system_reminder`；§13.3 增加「注入文本不得写成用户指令口吻、不得包含可执行内容、必须可与 `<user_query>` 明确区分」；§15.5 改为「已判定为 user 消息内的 hook system-reminder，但 `confirmed` 仍需请求级证据」；关闭 OQ-15（降级为「当前版本请求级证据待补」）。改代码（注释/契约常量）+ 改 SPEC。

### GAP-05 — Host evidence baseline 版本失效
- **SPEC**：metadata `Host probe baseline commit 5c3371c3…` / `observed HEAD 2f2bdf10…`；§0.3 引用 WorkBuddy 5.9.2 `lite-wb` CLI 3/3；历史探针 README 明确引擎 `2.161.0` / Desktop `5.8.1`；`hook-runtime-contract.json` 记录引擎 SHA-256 `fd9d20c75264…`。
- **实际**：当前 `cli/package.json` = `2.165.0`、`node <engine> --version` = `2.165.0`、引擎 SHA-256 = `6fbfd77bae7e…`、Desktop `5.9.2`、PD `0.2.2`。**引擎二进制已变**，且宿主历史上有静默升级记录（工作记忆 §坑：2026-10-11 从 5.3.14 → 5.8.1）。
- **影响**：§12.1「版本/模式/adapter/事件契约变更使 profile 失效直到复验」是 SPEC 自己的硬规则，因此基于 2.161.0 的 `VERIFIED-E3` 结论（3/3 派发、30 s timeout、tool events NOT_RUN、channel UNKNOWN）在当前 profile 下**已 EXPIRED**；§19 Phase 0「冻结 Host Matrix 证据」与 §20F 验收无法按现有证据通过。
- **修复**：profile 增加 `engineVersion` / `engineSha256` / `pdPluginVersion` / `runtimeMode` / `profileVerifiedAt`；以当前基线重新冻结；把「宿主静默升级 → profile 自动 EXPIRED」写为运行时检查（见 GAP-11）。改代码 + 改 SPEC。

### GAP-06 — `lite-wb CLI` 不是运行模式
- **SPEC**：§0.3「WorkBuddy `5.9.2`, `lite-wb` CLI」、§5.1 映射表、§12.3 把 `WorkBuddy lite-wb CLI` 与 `WorkBuddy Desktop/IDE` 并列为两个 profile、§20F 两条独立验收项。
- **实际**：`lite-wb` 是引擎入口文件 `codebuddy-lite-wb.mjs` 的名字（引擎内 `"lite-wb"` 计数 27）；当前为 Desktop（Electron，8 个 `WorkBuddy.exe`），Hook 引擎在 pid 95164 的 CLI 子进程内；`app.asar` 内 5117 文本文件对 hook 关键词命中全部为 0 — `RUNTIME_VERIFIED + SOURCE_CONFIRMED`。
- **影响**：profile 命名错位会让「Desktop NOT_RUN / isolation unproven」的边界看似成立，但实际 Desktop 已在运行并派发 hook；同时也掩盖了「Desktop 主进程不含 hook 实现」这一真实架构事实。
- **修复**：profile 改为 `workbuddy-desktop/5.9.2/cli-engine-2.165.0` 与 `workbuddy-cli/standalone` 两类；「Desktop/IDE UI 能力（/hooks review panel、交互 TUI）未验证」与「Desktop 的 hook 引擎已验证」分开陈述。只改 SPEC（不改代码）。

### GAP-07 — tool/compaction 事件被错误标为 NOT_RUN 并禁止使用
- **SPEC**：§12.3「WorkBuddy tool events were NOT_RUN because the mock response was rejected by that build」、§12.4「Only depend on UserPromptSubmit and SessionStart where necessary; do not use unverified tool/compaction events as design inputs」、§25.2「不宣称 WorkBuddy tool/compaction events 支持或不支持」。
- **实际**：本次会话 `PreToolUse` **164** 次、`PostToolUse` **162** 次真实派发（`timeout=30000ms`）；源码有 `PreCompact`（`L99/L2271/L2332`）、`PostCompact`（`L2332 @7915731`）、`PostToolUseFailure`（`L576`）派发点；历史 P02/P03 冻结契约已完整验证工具事件 exit code 矩阵 — `RUNTIME_VERIFIED + SOURCE_CONFIRMED + HISTORICAL_PROBE`。
- **影响**：把已验证能力锁在门外，直接导致 §5 只能用 turn 计数 + LLM 判断，是 GAP-08 的根因，也违背 §17.5 的成本优化顺序。
- **修复**：把该表述限定为「Host Matrix v0.1 那次特定探针的 NOT_RUN」，不得外推为当前环境能力；§12.4 改为「WorkBuddy profile 使用已验证的 Tool/Compaction/生命周期事件作为刷新触发，注入仍只在 UPS」。改代码（注册事件）+ 改 SPEC。

### GAP-08 — 宿主确定性 Task 边界未用于 Task Change Detection
- **SPEC**：§5.4 有 `HOST_TASK_BOUNDARY` 但只写「A host provides a verified task boundary → Enqueue Decision Model」；§5.5 以 `maxUserTurnsWithoutReview=4` / `maxContextDeltaChars` / `minReviewIntervalMs` 为主节奏；§5.6–5.8 全部围绕 `principle_decision` 五分类。
- **实际**：`TaskCreated`（`L1916 @6040660`）、`TaskCompleted`（`@6048230`）、`SessionEnd`、`SubagentStart/Stop` 有真实派发点，payload 含 `taskId` / `subject` / `agent_id`，可直接产出确定性 `NEW_TASK` / 任务边界 — `SOURCE_CONFIRMED`。
- **影响**：用模型调用去判断宿主已经确定性给出的边界 → 不必要的模型调用、延迟、成本，以及可避免的误判（错误激活风险）。
- **修复**：§5.4 增加 `HOST_TASK_CREATED` / `HOST_TASK_COMPLETED` / `HOST_SESSION_END` / `HOST_POST_COMPACT` 触发类型，并规定「确定性事件直接映射 decision，跳过 `principle_decision`；只有同任务内的 GOAL_SHIFT/PHASE_SHIFT 才进入模型」；§5.5 的 turn 计数降级为无宿主事件时的兜底。改代码 + 改 SPEC。

### GAP-09 — 未利用宿主原生 async hook
- **SPEC**：§10.4「Do not assume a host supports background execution merely because it supports prompt hooks. If no safe deferred execution mechanism is proven, keep model-assisted modes OFF and use Native」；§14.2「If a safe worker cannot be demonstrated using existing PD infrastructure, Shadow and Live remain OFF」；§3.1 架构图中 deferred refresh 是一条虚线，无宿主载体。
- **实际**：`ENGINE:L572 @3579844–@3580030` `async:true` hook 会 detach，带 `asyncTimeout`，宿主立即返回 `allowed:true, exitCode:0`，日志 `async hook detached pid=…`；仍是独立子进程、SIGTERM→SIGKILL 管理 — `SOURCE_CONFIRMED`。
- **影响**：SPEC 把「宿主是否有后台机制」列为未决前提，实际上宿主已有；不利用它会迫使 PD 自建 worker（违背 §1.2「不引入新独立子系统」与 Reuse First），或让 Shadow/Live 一直 OFF。
- **修复**：§10.4 / §14.2 增加 WorkBuddy 专属条款：Deferred Refresh 由 `async:true` command hook 承载；**明确约束「async hook 不提供当前回合注入，结果只在后续 UPS 生效」**；保留其它宿主各自验证；§3.1 架构图补一条「宿主 async hook → deferred worker」实线。改代码（新增 async hook 脚本）+ 改 SPEC。`async` 运行时行为本轮 `NOT_RUN`，需在隔离探针补验。

### GAP-10 — 多版本 hooks.json 并存 + 拼接合并 → 重复注入
- **SPEC**：§8.3 只规定 DB 层 transaction / revision check / optimistic lock / deterministic upsert；§12.5「Reverify profiles after host, adapter, or installed plugin version changes」；§14.5 有 `Storage conflict` 行但无配置层冲突。
- **实际**：`~/.workbuddy/plugins/cache/principles-disciple-market/principles-disciple/` 下 `0.1.0` / `0.2.0` / `0.2.2` 三目录各含完整 `hooks.json`，旧版仅标 `.orphaned_at` 未删除，引擎中**未找到**显式删除旧 hooks.json 的代码；`ENGINE:L2506 @8220394` `mergeHooks` 是 `t[n]=[...t[n]||[],...s]` **数组拼接而非覆盖** — `STATIC_CONFIG + SOURCE_CONFIRMED`。本次只加载 0.2.2（日志 0.2.2 命中 292 次，旧版 0 次）。
- **影响**：若安装/更新过程中两版同时注册，UPS 会被执行两次 → 双重注入、双重刷新、重复 evidence；不同版本的 timeout 还会产生一个先超时阻断整组 hook 的隐患（任一 `!allowed` → 整体 `allowed=false`）。
- **修复**：① 安装器在启用新版本前显式验证 `installed_plugins.json` 只有一个 PD `installPath`，并把旧版本目录移出可发现路径；② adapter 在 hook 入口校验 `${CODEBUDDY_PLUGIN_ROOT}` 版本与 governance profile 一致，不一致即中性退出并记 receipt；③ SPEC §8.3 增加「Hook 配置层幂等」小节、§14.5 增加 `Duplicate hook registration` 行、§20D 增加验收项。改代码 + 改 SPEC。

### GAP-11 — Host Runtime Capability Profile 无运行时实现
- **SPEC**：§12.2 定义完整 `HostRuntimeCapabilityProfile` 接口（`hostVersion` / `pdAdapterVersion` / `installedPluginVersion` / timing / failureSemantics / injection / evidenceReferences / status），§10.2 `hostProfiles.requireExactVersionMatch: true`，§19 Gate 0 要求「Exact profile exists」。
- **实际**：全仓 `packages/*.ts` 中未找到 `HostRuntimeCapabilityProfile` 的运行时实现；installer (`workbuddy-host-installer.ts`) 只校验 **PD 插件自身** manifest version 与 `installed_plugins.json v2` 版本；`mcp/launcher.cjs:270-284` 的 `runtime_pin_mismatch` 针对 MCP 包与 runtime pins，不是宿主版本；引擎全文不读取 PD 的 `runtime-version.json` pins，也无 `0.2.2` / `genieVersion` 字面量 — `CODE + SOURCE_CONFIRMED`。
- **影响**：§12.1 的「版本变更 profile 失效」硬门禁在代码层无法执行；GAP-05 的基线失效不会被自动发现；§20F「每个 profile 记录精确版本」无法验证。
- **修复**：实现 `resolveHostProfile()`：从 `install-manifest.json` / `cli/package.json` / `installed_plugins.json` / `hooks.json` 读取 5 元组并与冻结 profile 比对，不匹配即 `status=EXPIRED` + Native-only + 写 receipt；把它作为 UPS 同步路径第 1 步（SPEC §14.1 已有该步骤，只需落地）。改代码 + 改 SPEC。

### GAP-12 — Session Working Set 缺生命周期终点与身份维度
- **SPEC**：§4.3 `AdaptiveContextSnapshot` 只有 `workspaceId` / `sessionId`；§8.2 `SessionWorkingSet` 只有 `sessionId`；§9.3(F3) 评估的事件列表是「prompt build / compaction / session resume / session end / focus update」但仍是通用措辞。
- **实际**：宿主提供 `generation_id`（同一轮 UPS/Stop 共享）、`taskId`、`agent_id`、`source`(startup/resume/clear)、`reason`、`compact_summary`；`SessionEnd` 不保证派发；`PostCompact` 仅观察 — `SOURCE_CONFIRMED / OFFICIAL_DOC`；PD `input-decoder.ts` 未解析上述生命周期字段（除 `generation_id`→turnId、`source`）。
- **影响**：无法建立可靠的「会话开始 → 任务边界 → 压缩 → 会话结束」Working Set 生命周期；只能靠 24 h TTL，长会话中易出现跨任务原则残留（错误激活）与过期状态复活；`SessionStart` resume 时无法区分「恢复」与「新建」。
- **修复**：`SessionWorkingSet` 增补 `generationId?` / `taskId?` / `sessionSource` / `hostEventId?` / `profileId`；新增 `onSessionEnd`（尽力清理）与 `onPostCompact`（重校验 + 新 fingerprint）；明确 `SessionEnd` 非保证派发、TTL 为兜底。改代码 + 改 SPEC。

## 4. P2 详情（摘要式）

| ID | 当前设计 vs 实际 | 影响 | 建议修复 | 代码 / SPEC |
|:---|:---|:---|:---|:---|
| GAP-13 | SPEC §5.5 只泛泛要求「不把重复/回放回调计为新 turn」；历史 P02 契约明确 `PreToolUse` 使用 `continue:false` 会导致**用户 prompt 被重新提交、UPS 再次派发** | 重复刷新、重复注入、成本翻倍 | 在 WorkBuddy adapter 规则中显式禁用 `continue:false`（`hook-runtime-contract.json:114` 已列 `forbiddenForV1`），并在 §5.5 增列宿主特定成因 | ✅ / ✅ |
| GAP-14 | Codex canonical 有 `additionalContextLimit: 10000`；当前 WorkBuddy 引擎该字段零命中；注入落在 user 消息 | 宿主无长度保护，长原则会挤占用户上下文、可能触发压缩 | §13.3 增加「PD 自行按 Prompt Capacity Budget 截断并记 `truncated`」；`additionalContextLimit` 不得作为 WorkBuddy 依赖 | ✅ / ✅ |
| GAP-15 | 三份官方文档与源码在 12 个议题上直接矛盾（见 Matrix §6）；SPEC §2.1 的证据标签只有 VERIFIED-CODE / VERIFIED-E3 / SOURCE-CONFIRMED / PROPOSED / NOT_RUN / INFERRED / OWNER-GATED，无「分模式证据」维度 | 容易把 IDE 文档的 7 事件 / 覆盖语义 / exit2 规则错误套到当前环境 | §2.1 增 `MODE-SCOPED` 规则与「文档差异必须分别登记」；§12.5 增「不同来源描述不同模式，不互相覆盖」 | ❌ / ✅ |
| GAP-16 | adapter 不写安装日志；插件未启用时 hook 不触发、无 PD 日志；`runtime_v2_prompt_activations_injected` 只在成功注入时写 | 无法区分 installed / loaded / dispatched / injected；本次 degraded 时四层都不可见 | 新增 `plugin_lifecycle` 事件（installer 写）+ `hook_dispatched`（入口写）+ `injection_degraded`（wrapper 写）；§15.3 事件集补充 | ✅ / ✅ |
| GAP-17 | SPEC 预算模型只围绕 UPS 同步路径；本次 `SessionStart` 15.552 s / 整链 16.736 s，占 30 s 的 55% | SessionStart 链上任一插件变慢就会挤占 PD 预算，且 PD 自己无法观测整链 | §12.2 timing 增 `sessionStartChainMeasuredMs`；§17.3 探针增列 SessionStart 整链测量；§14.4 明确「并行 hook 链耗时不属于单一 PD 预算，但必须纳入 soft deadline 余量」 | ❌ / ✅ |
| GAP-18 | 现有测试：静态数值守卫、stdout 断言、fake engine、条件性真实引擎注册隔离；`model-request-injection-shapes.json` 只是 fixture | 无真实宿主派发 / 当前版本注入进入模型请求 / 版本绑定 / cache↔canonical 一致性 / Desktop-IDE 分模式的自动化回归；Gate 3 难以证明 | 按 Host Audit §4.4 重建隔离 lab，把 P1/P3/P4/P6 转成 CI 可执行断言（带引擎版本 + SHA 断言）；新增 wrapper deadline 属性测试 | ✅ / ✅ |
| GAP-19 | 官方文档写 `~/.codebuddy/settings.json`；实际 `~/.workbuddy/settings.json` 且**无顶层 `hooks` 键**；hooks 配置只在插件 `hooks/hooks.json` | PD 无法通过用户级 settings 覆盖 hook timeout；改插件配置后需 `/hooks` 审查或重启才生效（启动快照） | §10.2 / §12.5 增「WorkBuddy hook 配置的唯一权威路径是启用插件版本目录内 `hooks/hooks.json`，且会话内修改不生效」；安装器承担版本切换与一致性校验 | ❌ / ✅ |

## 5. P3 详情（文档/注释层，不投入优先工程资源）

| ID | 问题 | 证据 | 处理 |
|:---|:---|:---|:---|
| GAP-20 | `src/host-adapter.ts:17-20` 注释称 `PostToolUseFailure`「NOT registered in the shipped hooks.json」，但 `plugin/hooks/hooks.json:27-38` 已注册，`input-decoder.ts:38` 与 `plugin-skeleton.test.ts:48` 亦确认 | `CODE` 内部冲突 | 更新注释即可，不影响行为 |
| GAP-21 | `src/codec/input-decoder.ts:5,44` `HOST_CONTRACT_BASELINE = 'WorkBuddy Desktop 5.8.1 / engine 2.161.0 (Phase 0 probe contract, 2026-10-12)'`；而 `fixtures/host-contract/README.md:3,12` 明确探针是 headless `codebuddy-lite-wb.mjs` + mock model，Desktop UI 事实 UNKNOWN | `CODE` 命名 + `DOC` | 常量重命名并标注基线类型，避免措辞层外推 |
| GAP-22 | SPEC metadata / §2.1 / §19 Phase 0 引用的「PD Host Event Capability Matrix v0.1 — Live Runtime Verification」独立文件在 `docs/audit/` 及全仓 NOT_FOUND（`docs/audit/pri-807-phase0/HOST_CAPABILITY_MATRIX.md` 是历史快照，且被 `SPEC-PD-AGENT-CAPABILITY-API-001-v0.2.md:110` 明确标注「不能直接复制旧矩阵作为现状」）；`scripts/dev/workbuddy-probe/README.md:55-58` 指向的私有 `docs/reports/workbuddy-host-adapter-20261012/agents/probe-fg0phy/` 原始证据亦 NOT_FOUND | `NOT_FOUND / DOC` | SPEC 必须给出可复核的证据路径或把结论标为「转载，原始证据不可复核」；本轮报告已在 Evidence Manifest 中逐条补齐当前环境证据 |

## 6. 修复顺序建议

| 阶段 | 必须完成 | 对应 Gate |
|:---|:---|:---|
| **立即（定稿前）** | GAP-01 / 02 / 03（P0）；GAP-04 / 05 / 06 / 07（P1 事实层与契约） | §19 Gate 0 / Gate 2 / Gate 3 |
| **定稿前** | GAP-08 / 09 / 10 / 11 / 12（P1 架构层） | §19 Gate 0 / Gate 3 / Gate 4 |
| **实现阶段** | GAP-13 / 14 / 16 / 18 / 19（P2 工程与测试） | §19 Gate 3 / Gate 4 |
| **后续** | GAP-15 / 17（P2 文档与预算）；GAP-20 / 21 / 22（P3） | 文档维护 |

**不建议投入**：为 WorkBuddy 重建独立注入/治理/模型运行时子系统；接入 `Notification` / `PermissionRequest` / `Worktree*` / `Elicitation*`；为三宿主形式统一而强推同一 timeout / channel / 事件映射；在当前生产会话内重跑阻断类探针。

---

**END OF PD_WORKBUDDY_INTEGRATION_GAP_AUDIT_v0.1.md**
