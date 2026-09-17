# PRI-813 — Codex RuleHost shadow evidence 断链 · Reality Audit（2026-09-16）

> 本文件是一次**只读调查**的产出。未修改任何生产代码、未新建 subsystem、未运行 Codex（不消耗 Owner Plus 额度）、未触碰 Linear。
> 唯一写入 = 本文件。
>
> 目标：不证明 PRI-813 正确，而是基于**当前** `D:\Code\principles` 与 `D:\Code\codex` 的真实源码，
> 精确回答「Codex 已经拥有什么、PD 已经拥有什么、哪一根线没接上」。

---

## 1. Executive Verdict

**PRI-813 的结论（Codex 上 promote 结构性不可达）成立，但其归因（"Codex 宿主缺少 shadow evidence 通道"）是错的。**

- Codex 当前宿主**已经**提供 PD 所需的 tool lifecycle 能力（PreToolUse / PostToolUse / 稳定 `tool_use_id` / `tool_input` / `tool_response` / 阻断 / 输入改写 / Windows 支持），并且 PD **已经在接收并使用**这些事件（Marketplace 插件注册 5 个 hook → `before_tool_call` / `after_tool_call` → shared host-runtime）。
- 真正的断点**全部在 PD 侧**，共 3 条（§6 E1–E3），且其中 2 条**同样打在 OpenClaw shared 路径上**——所以它不是"Codex 宿主能力缺口"，而是"shared host-runtime 从未接线 shadow producer + promotion 契约只认 OpenClaw"。
- 复核中**另外发现 1 条真实的宿主级 payload 缺口**（§6 E4）：Codex `PostToolUse` 的 payload 在 Bash/apply_patch 上只携带输出文本，**不含 exit code / error / duration / success**，导致 PD 的 failure 推导恒为 `false`，Codex 上 pain 准入结构性死亡。这条与 PRI-813 **不同族**（pain evidence 而非 shadow evidence），可能需要 Codex upstream 或显式 UNSUPPORTED，应单独立单。

**Phase 6 四选一：Verdict C — Disconnected Capability。**
**推荐动作（§8）：REFRAME AS RECONNECTION**（工单重定义为 PD shared-path 重连），并把 E4 拆为独立新单。

---

## 2. Versions / Baseline

### 2.1 环境

| 项 | 值 |
|---|---|
| OS | Windows（win32），Owner 生产环境 |
| PD 代码工作区 | `D:\Code\principles` |
| Codex 代码工作区 | `D:\Code\codex` |
| PD 生产工作区（状态库） | `D:\.openclaw\workspace`（`.state/logs`、`.pd/`） |
| Shell | Git Bash（PATH 缺 coreutils，需显式补 `PortableGit\...\mingw64\bin`） |

### 2.2 PD（`D:\Code\principles`）

| 项 | 值 |
|---|---|
| branch | `main` |
| HEAD | `ff645bfe91c743163a9cda619064632263b0f275` |
| HEAD 时间 | 2026-09-15 22:24:40 +0800（`Merge pull request #1706 ... PRI-796-worktree-governance-v2`） |
| dirty state | 1 项：`?? .tmp-probe/`（未跟踪，本次未触碰） |
| package version | `1.76.1` |

**PD 的 Codex 相关 pin（3 层，彼此不同）**

| Pin | 值 | 出处 |
|---|---|---|
| Codex hook payload 契约 | `0.147.0` | `packages/codex-adapter/src/codec/input-decoder.ts:9` |
| Codex 摄入最低支持版本 | `0.148.0` | `packages/codex-adapter/src/ingestion/codex-version.ts:16` |
| Codex 摄入已验证版本 | `0.150.1` | `packages/codex-adapter/src/ingestion/codex-version.ts:17` |
| Codex 插件运行时 pin | codexAdapter `0.1.0` / hostRuntime `0.1.0` / core `1.252.0` | `plugins/principles-disciple/runtime-version.json` |

### 2.3 Codex（`D:\Code\codex`）

| 项 | 值 |
|---|---|
| branch | `main` |
| HEAD | `4701aa4b4239c70063ab6f2fcb835324f9c109f4` |
| HEAD 时间 | 2026-09-16 12:09:50 +0000（`Avoid redundant model catalog lookups in reused Guardian reviewers (#45933)`） |
| dirty state | 0 |
| remote | `origin https://github.com/openai/codex.git` |
| package 版本 | `codex-cli/package.json` = `0.0.0-dev`；`codex-rs/Cargo.toml` workspace version = `0.0.0`（未发布的 main 线，无语义化 release tag） |
| `git describe` | `voice-cygwin-108b38cf67cbb731-231-g4701aa4b42`（非语义化 tag） |

**⚠️ 版本约束（诚实声明）**

1. `git fetch origin main` **在本机沙箱内失败（SIGTERM，无网络）**，因此"本地 clone 相对 upstream 落后多少"**未能确认**。
2. 复核采用的最强可辩护事实：本地 clone HEAD 时间戳（2026-09-16）**晚于** PD 已验证的 `0.150.1`，且 hooks 能力在源码中已是 `Stage::Stable`。
3. hooks **不是新能力**：`codex-rs/hooks/Cargo.toml` 首次提交 `2026-02-10`（`d735df1f50 Extract hooks into dedicated crate (#11311)`），最近改动 `2026-09-10`。因此"Codex 才刚刚有 hook"不成立。

---

## 3. Codex Actual Hook Architecture

### 3.1 事件全集（12 个）

`codex-rs/hooks/src/lib.rs:23-36`

```
PreToolUse, PermissionRequest, PostToolUse,
PreCompact, PostCompact, SessionStart, SessionEnd,
UserPromptSubmit, SubagentStart, SubagentStop, Stop, Interrupt
```

其中 9 个支持 matcher（`lib.rs:43-53`）。

### 3.2 引擎是否默认启用？——是，且无平台门禁

`codex-rs/features/src/lib.rs:1188-1193`

```rust
FeatureSpec { id: Feature::CodexHooks, key: "hooks", stage: Stage::Stable, default_enabled: true }
```

→ **Stable + default on**。不需要额外开 flag，也不存在整体 platform gate。

### 3.3 Producer：谁在什么时候触发

统一 producer 在 `codex-rs/core/src/hook_runtime.rs`，由 **tool dispatch** 调用。

#### A. PreToolUse

- 调用点：`codex-rs/core/src/tools/registry.rs:597-649` → `run_pre_tool_use_hooks`（`core/src/hook_runtime.rs:186-244`）
- 触发时机：tool handler 执行**之前**，条件是 `tool.pre_tool_use_payload(&invocation)` 为 `Some`
- 实现 `pre_tool_use_payload` 的 tool：`handlers/unified_exec/exec_command.rs:522`（Bash/exec）、`handlers/unified_exec/write_stdin.rs:129`、`handlers/apply_patch.rs:458`、`tools/code_mode/wait_handler.rs:205`、`handlers/mcp.rs:419`
- **稳定 tool identity**：`tool_use_id = invocation.call_id`（`registry.rs:601`）
- **能否阻止执行**：能，三种方式 → `PreToolUseHookResult::Blocked`
  - `exit 2` + stderr 文本（`hooks/src/events/pre_tool_use.rs:261-277`）
  - stdout `{"decision":"block","reason":...}`（`:241-248`）
  - stdout `hookSpecificOutput.permissionDecision = "deny"`（`:357-385`，测试锁定）
  - 阻断后 `registry.rs:607-621` 直接 `return Err(RespondToModel(...))`，并 `notify_tool_finish(... ToolCallOutcome::Blocked)`
- **能否改写输入**：能。`updatedInput` → `registry.rs:622-627` `tool.with_updated_hook_input(...)`；多 handler 按**完成顺序**取最后一个（`pre_tool_use.rs:153-167`）
- **context 是否进入下一步模型行为**：能，但仅 `additionalContext`（`events/common.rs:37-51` → `record_additional_contexts`），有 token 上限与 spill（`additionalContextLimit`，`engine/discovery.rs:539-556`）
- **CLI / Desktop / app-server 一致性**：一致。producer 位于 `core`（`Session::hooks()`），CLI / TUI / `codex exec`（`exec/tests/suite/hooks.rs`）/ app-server 共用同一路径。app-server 另有 `HookStartedNotification` / `HookCompletedNotification`（`app-server-protocol/src/protocol/v2/hook.rs:145-158`）对外暴露 hook run 汇总

#### B. PostToolUse

- 调用点：`codex-rs/core/src/tools/registry.rs:704-727` → `run_post_tool_use_hooks`（`core/src/hook_runtime.rs:283-321`）
- `hook_runtime.rs:283` 的 doc 明写：**"Runs matching `PostToolUse` hooks after a tool has produced a successful output."**

**这是本次审计最关键的一行语义。**

### 3.4 Payload 逐字段（= 真实契约）

generated schema（`codex-rs/hooks/schema/generated/*.command.input.schema.json`）为权威；Rust 序列化在 `events/pre_tool_use.rs:175-191`、`events/post_tool_use.rs:150-167`。

**PreToolUse 输入**

```json
{ "session_id", "turn_id", "agent_id?", "agent_type?", "transcript_path": string|null,
  "cwd", "hook_event_name": "PreToolUse", "model", "permission_mode",
  "tool_name", "tool_input", "tool_use_id" }
```

**PostToolUse 输入** = 同上 + `"tool_response"`（`hook_event_name` 变为 `PostToolUse`）

| 询问项 | Codex 结论 |
|---|---|
| call identity | ✅ `tool_use_id`（Pre/Post 都有） |
| tool name | ✅ `tool_name`（canonical；别名只用于 matcher） |
| arguments | ✅ `tool_input`（Bash → `{"command": ...}`；MCP → 解析后 JSON） |
| result | ✅ `tool_response`，**类型 tool-specific**（见 §3.5，Bash 只是一段文本） |
| success/failure 布尔 | ❌ **payload 无此字段** |
| exit code | ❌ **payload 无此字段** |
| duration | ❌ **payload 无此字段** |
| turn identity | ✅ `turn_id` |
| session identity | ✅ `session_id`（= `ThreadId`） |

### 3.5 终态语义（§C 专项）——PostToolUse **不等于**「该 tool call 已有最终结果」

`codex-rs/core/src/tools/registry.rs:692-727`（决定性）：

```rust
let success = match &result { Ok(result) => result.result.success_for_logging(), Err(_) => false };
...
let post_tool_use_payload = if success {
    result.as_ref().ok().and_then(|r| r.post_tool_use_payload.clone())
} else { None };
let post_tool_use_outcome = if let Some(p) = post_tool_use_payload { Some(run_post_tool_use_hooks(...).await) } else { None };
```

即 **`success == false` ⇒ 完全不调用 PostToolUse**。

各 tool 的 `success_for_logging()` 实现（决定实际覆盖面）：

| Tool 输出类型 | `success_for_logging()` | 位置 |
|---|---|---|
| `ExecCommandToolOutput`（Bash/exec） | **恒 `true`** | `core/src/tools/context.rs:399-401` |
| `ApplyPatchToolOutput` | **恒 `true`** | `core/src/tools/context.rs:312-314` |
| `AbortedToolOutput` | **恒 `false`** | `core/src/tools/context.rs:345-347` |
| `FunctionToolOutput` | `self.success.unwrap_or(true)`（可 false） | `core/src/tools/context.rs:284-286` |
| `JsonToolOutput` | `self.success.unwrap_or(true)` | `tools/src/tool_output.rs:146-148` |
| `CallToolResult`（MCP） | `self.success()` | `tools/src/tool_output.rs:190-192` |

**终态覆盖矩阵**

| 终态 | 有可靠 evidence？ | 说明 |
|---|---|---|
| **success** | ✅ | PostToolUse 触发，带 tool_use_id / tool_input / tool_response |
| **failure（tool 返回 `Err`）** | ❌ | `success=false` → PostToolUse **完全不触发** |
| **failure（命令非零退出）** | ⚠️ 触发但**不可判定** | Bash 恒 `success=true` 故 PostToolUse 会跑，但 `tool_response` 只有文本、**无 exit code**，接收方无法区分成功/失败 |
| **denied / blocked（PreToolUse）** | ❌ | `registry.rs:607-621` 提前 `return Err`，无 PostToolUse |
| **cancelled / aborted** | ❌ | `AbortedToolOutput` → `success=false` → 无 PostToolUse |
| **interrupted** | ❌（tool 级） | 只有 **turn 级** `Interrupt` 事件（`hook_runtime.rs:495-535`），**不携带任何 tool identity** |
| **timeout** | ❌ | 走 `Err` 路径 → 无 PostToolUse |
| **process crash** | ❌ | 同上 |

**parallel tool calls**：PostToolUse 按 invocation 逐个 dispatch；`notify_tool_finish_if_unclaimed` 用 `AtomicBool` 保证**每个 tool call 只产生一次终态通知**（`registry.rs:789-800`）；异步 hook 并发上限 `MAX_CONCURRENT_ASYNC_HOOKS = 8`（`engine/command_runner.rs:46`）。

**Codex 内部有完整终态词汇，但外部进程拿不到**：

`codex-rs/ext/extension-api/src/contributors/tool_lifecycle.rs:22-40`

```rust
pub enum ToolCallOutcome { Completed { success: bool }, Blocked, Failed { handler_executed: bool }, Aborted }
```

经 `core/src/tools/lifecycle.rs:81-133`（`notify_tool_finish` / `notify_tool_aborted`）投递给 `tool_lifecycle_contributors()`。**但这是进程内 Rust extension 注册点**（`ext/extension-api` trait），`pd-hook.cjs` 作为**外部子进程无法注册**。故该通道对 PD **不可用**；它只证明"Codex 内部知道终态"，不证明"外部可见"。

### 3.6 Windows 支持（§D 专项）—— 真实支持

| 检查项 | 结论 | 证据 |
|---|---|---|
| hooks 引擎启用 | ✅（Stable, default on），**无平台分支** | `features/src/lib.rs:1188-1193` |
| repo/user hooks 加载位置 | ✅ `<config folder>/hooks.json` + config.toml `hooks` 段 + plugin `hooks/hooks.json` | `engine/discovery.rs:118-165`；`load_hooks_json`（`discovery.rs:339-343`）；`config/src/state.rs:239-243 hooks_config_folder` |
| `commandWindows` 是否真实生效 | ✅ 生效，且对**所有来源**（不止 managed）——`append_matcher_groups` 是通用路径 | `config/src/hook_config.rs:164-184`（`rename="commandWindows"`, `alias="command_windows"`）；`engine/discovery.rs:503-517`：`let command = if cfg!(windows) { command_windows.unwrap_or(command) } else { command };` |
| 是否存在 cfg/platform gating | 仅有**正确的**平台分化（shell 选择、进程树），**无禁用性门禁** | `engine/command_runner.rs:233-248`（Windows `JobObject::spawn_contained` 进程树收容）、`:397-433 build_command`（Windows `raw_arg` 引号）、`:435-440`（Windows 默认 `COMSPEC` → `cmd.exe /C`） |
| CLI / app-server / Desktop 差异 | producer 在 core 共享；app-server 有 hook RPC（`hooks_list`）与通知；**不存在按前端的差异门禁** | `app-server/tests/suite/v2/hooks_list.rs`、`app-server-protocol/.../v2/hook.rs:145-158` |
| 信任/审查门禁 | ⚠️ 存在 `HookTrustStatus { Managed, Untrusted, Trusted, Modified }`，project 级 hooks 需 trust | `app-server-protocol/.../v2/hook.rs:61-65`；`tui/src/startup_hooks_review.rs`、`tui/tests/suite/directory_trust.rs` |

**Windows 小结**：`commandWindows` 与 JobObject 收容都是**为 Windows 显式实现**的（非 macOS/Linux 行为外推）。这一层不存在"Codex 不支持 Windows hook"的事实基础。

---

## 4. PD Current Codex Path（真实链）

### 4.1 注册面：PD 如何把 hook 装进 Codex

| 路径 | 现状 |
|---|---|
| 全局 `~/.codex/hooks.json`（`CodexHostInstaller`） | **已退役**：`install()` 永不写注册，只返回结构化拒绝（`packages/create-principles-disciple/src/installers/codex-host-installer.ts:247-268`） |
| **Marketplace 插件（唯一支持路径）** | `plugins/principles-disciple/.codex-plugin/plugin.json` + `plugins/principles-disciple/hooks/hooks.json` |

`plugins/principles-disciple/hooks/hooks.json` 实际注册 **5 个事件**：

| 事件 | matcher | command | timeout | 备注 |
|---|---|---|---|---|
| `PreToolUse` | `Bash\|apply_patch` | `node "${PLUGIN_ROOT}/hooks/pd-hook.cjs"` | 5s | statusMessage "PD: checking tool call" |
| `PostToolUse` | `.*` | 同上 | 5s | "PD: capturing pain signal" |
| `UserPromptSubmit` | — | 同上 | 5s | `additionalContextLimit: 10000` |
| `SessionStart` | — | 同上 | 30s | |
| `Stop` | — | 同上 | 5s | turn_complete |

> ⚠️ 该文件**没有 `commandWindows`**。在 Windows 上 Codex 会用 `cmd.exe /C "node \"<abs>\""`（`command_runner.rs:435-440` + `:409-410`）。是否可用取决于 `node` 是否在 Codex 进程 PATH 上——**本次未能确认**（见 §7 残留未知）。

### 4.2 事件映射

`packages/codex-adapter/src/codec/input-decoder.ts:11-24`

| Codex 事件 | PD `HostEventKind` | 备注 |
|---|---|---|
| `PreToolUse` | `before_tool_call` | |
| `PostToolUse` | `after_tool_call` | |
| `UserPromptSubmit` | `before_prompt_build` | |
| `SessionStart` | `session_start` | |
| `Stop` | `turn_complete` | |
| `SessionEnd` | （常量存在，**未映射**） | `input-decoder.ts:16` |
| `PermissionRequest` / `Interrupt` / `PreCompact` / `PostCompact` / `SubagentStart` / `SubagentStop` | **PD 未订阅** | `host-adapter.ts:31-41` |

`input-decoder.ts:81-89`：`tool_use_id` → `context.toolCallId`（required）、`tool_input` → `context.toolInput` + `rawPayload.toolInput.params`、`tool_response`（仅 after）→ `context.toolOutput`。

PD 的 host event 词汇表只有 6 个：`HOST_EVENT_KINDS = [before_tool_call, after_tool_call, before_prompt_build, session_start, turn_complete, session_end]`（`packages/principles-core/src/host/host-adapter.ts:46-53`）。

### 4.3 逐跳连接状态

| # | 跳 | 状态 | 证据 / 说明 |
|---|---|---|---|
| 1 | Codex PreToolUse → hook 子进程 | **CONNECTED** | `registry.rs:597`；插件已注册 |
| 2 | hook 子进程 → `pd-hook.cjs` → `decodeCodexInput` | **CONNECTED** | `pd-hook.ts:126-138`、`input-decoder.ts:73-106` |
| 3 | decode → `HostEvent` | **CONNECTED** | `host-adapter.ts:53-55` |
| 4 | `HostEvent` → `createProductionHostRuntime({hostKind:'codex'})` | **CONNECTED** | `pd-hook.ts:186-193` |
| 5 | runtime `beforeToolCall` = shared production gate | **CONNECTED** | `packages/host-runtime/src/index.ts:236-241, 249` |
| 6 | gate 读 state.db activations | **CONNECTED** | `production-rulehost-gate.ts:209-220` |
| 7 | gate 评估 live 规则 | **CONNECTED** | `production-rulehost-gate.ts:349-389` |
| 8 | **gate 评估 shadow 激活** | **DISCONNECTED** | `production-rulehost-gate.ts:259-261`：`if (!row \|\| row.action !== 'code_tool_hook_live_activate') continue;` —— **无 warning、不评估、不报告** |
| 9 | **`rulehost_evaluated` 落盘端口** | **DISCONNECTED** | `HostEventEmitter`（`principles-core/src/host/host-adapter.ts:181-184`）**只有 2 个方法**，接口层无 rulehost 通道；`codexEventEmitter`（`pd-hook.ts:25-52`）也只实现这 2 个 |
| 10 | shadow summary 聚合 | **CONNECTED（对 OpenClaw）** | `rulecode-shadow-summary.ts:15-45`，过滤 `entry.type==='rulehost_evaluated' && entry.data.activationMode==='shadow'` |
| 11 | promotion evidence snapshot | **CONNECTED（但对 Codex 不可达）** | `pd-cli/src/commands/runtime-activation.ts:115` `readShadowSummaryForActivation` → `:604-612` `buildPromotionEvidenceSnapshot` |
| 12 | promotion host 契约 | **DISCONNECTED（by design）** | `runtime-activation.ts:598` 硬编码 `OPENCLAW_HOST_LIVENESS_CONTRACT`；`ActivationsConsoleModel.ts:477,533` 同 |
| 13 | 契约校验器 | **DISCONNECTED（by design）** | `openclaw-promotion-checks.ts:37-46`：`if (value.version !== 'openclaw-legacy@1' \|\| value.supportsShadowEvidence !== true ...) return null;` —— **只接受这一个字面量** |

### 4.4 PD 侧事件产物：Codex 路径只写 2 类事件

`pd-hook.ts:25-52` 的 `codexEventEmitter` 只实现：

1. `recordRuntimeV2ActivationsInjected` → `runtime_v2_prompt_activations_injected`
2. `recordToolCall` → `tool_call`

对照 `hook_execution` / `rulehost_evaluated` / `rule_enforced` / `rulehost_blocked` / `rulehost_requireApproval` / `rulehost_auto_correct_*` / `rulehost_unhealthy` / `rulehost_skipped` —— **唯一生产者都是 OpenClaw 插件**：

- `recordHookExecution` 调用点全部在 `packages/openclaw-plugin/src/index.ts`（`:384,391,426,432,440,447,484,493,497,504,510,547,552`）
- `recordRuleHostEvaluated` 调用点全部在 `packages/openclaw-plugin/src/hooks/gate.ts`（`:117` shadow、`:134` legacy live、`:584` shared live）

### 4.5 真实 shadow producer 的位置（关键定位）

```
packages/openclaw-plugin/src/core/rule-host.ts:196-254   RuleHost.evaluateDetailed()
   ├─ :199  liveImpls  = activeImpls.filter(activationMode === 'live')
   ├─ :200  shadowImpls = activeImpls.filter(activationMode === 'shadow')
   ├─ :202-215  逐个 impl.evaluate(input) → shadowDecisions.push({...result, activationId})
   └─ :246  返回 { liveDecision, liveDecisionActivationId, shadowDecisions, skippedActivations, ... }

packages/openclaw-plugin/src/hooks/gate.ts:114-129   逐 shadow 决策写 rulehost_evaluated(activationMode:'shadow')
```

`evaluateDetailed` 位于 **openclaw-plugin**，**不在共享 core / host-runtime**。`host-runtime` 的 `createProductionRuleHostGate` 只有 live 分支，**没有任何 shadow 等价物**。

### 4.6 真实运行时证据（零 Codex 额度）

`D:\.openclaw\workspace` 的事件日志（`.state/logs/events_*.jsonl` + `.pd/logs/events_*.jsonl`）实际统计：

| 事件类型 | 条数 |
|---|---|
| `hook_execution` | 22 254 |
| `tool_call` | 6 201 |
| `runtime_v2_prompt_activations_injected` | 4 963 |
| `rulehost_evaluated` | 3 934（**3 795 `live` + 139 `shadow`**） |
| `pain_signal` | 11 |
| `governance_action` | 2 |

**关键结论**

1. shadow evidence 在 OpenClaw 宿主上**确实在产生**（139 条），证明 §4.5 的 producer 链是活的。
2. 该工作区的 `hook_execution` 事件名是 `llm_output` / `before_prompt_build` —— **`llm_output` 是 OpenClaw 独有 hook 名**（Codex 无此事件），`tool_call` 的 `toolName` 是 `exec`（OpenClaw 名；Codex 是 `Bash`）。故该工作区是 **OpenClaw 宿主**。
3. 跨全部工作区 grep `codex:pre_tool_use` / `codex:post_tool_use` / `"source":"codex` → **0 命中**。即**本机不存在任何 Codex 运行时证据**。

---

## 5. Capability Matrix

| Capability | OpenClaw | Codex current source | PD Codex adapter | Gap |
|---|---|---|---|---|
| pre-tool interception | ✅ in-process `before_tool_call` hook（`openclaw-plugin/src/hooks/gate.ts:28`） | ✅ `PreToolUse`（`hooks/src/events/pre_tool_use.rs:23-36`；producer `core/src/tools/registry.rs:597`） | ✅ 映射 `PreToolUse`→`before_tool_call`（`input-decoder.ts:19`）；deny 经 `codec/output-encoder.ts` 回写 | **无** |
| post-tool evidence | ✅ `after_tool_call` | ⚠️ `PostToolUse`，但**仅 `success_for_logging()==true` 才触发**（`registry.rs:704-711`） | ✅ 映射 `PostToolUse`→`after_tool_call` | **PARTIAL：无 failure/abort 覆盖** |
| tool identity | ✅ toolName + sessionId | ✅ `tool_use_id` = `invocation.call_id`（`registry.rs:601`） | ✅ required（`input-decoder.ts:86`）→ `context.toolCallId` | **无** |
| arguments | ✅ `params` | ✅ `tool_input` | ✅ → `context.toolInput` / `rawPayload.toolInput.params` | **无** |
| result | ✅ tool result | ⚠️ `tool_response`，Bash/apply_patch 是**裸 String**（`context.rs:428-436`、`:327-329`） | ✅ → `context.toolOutput` | **PARTIAL：无 exitCode/error/success/duration** |
| block / correction | ✅ deny + requireApproval + auto_correct | ⚠️ block（exit 2 / deny）+ `updatedInput` 改写；**无 requireApproval / auto_correct 对应** | ⚠️ 仅 deny | **PARTIAL** |
| failure evidence | ✅ `outcome.failure`（由 exitCode/error 推导） | ❌ payload **不可表达** | ❌ `normalizeOutcome` 恒得 `failure:false` | **DISCONNECTED** |
| cancellation evidence | ✅（turn 级） | ❌ tool 级；`AbortedToolOutput`→`success=false`→无 PostToolUse；仅 turn 级 `Interrupt`（无 tool identity） | ❌ 未订阅 `Interrupt` | **UNSUPPORTED** |
| shadow RuleHost evaluation | ✅ `rule-host.ts:200-215` | N/A（PD 侧能力） | ❌ shared gate 只处理 live（`production-rulehost-gate.ts:259-261`） | **DISCONNECTED** |
| `rulehost_evaluated` | ✅ `gate.ts:117`(shadow) / `:134`(live) / `:584`(shared) | N/A | ❌ 无 producer、**接口无发射端口**（`host-adapter.ts:181-184`） | **DISCONNECTED** |
| exact activation identity | ⚠️ legacy 有 `activationId`；shared 路径**缺**（`gate.ts:587`） | N/A | ⚠️ metadata 仅 deny 时带 `ruleId`/`principleId`（`production-rulehost-gate.ts:387`），allow 时连 `ruleId` 都无（`:389`） | **PARTIAL** |
| promotion evidence | ✅ 唯一被承认的宿主 | ❌ 无 `CODEX_HOST_LIVENESS_CONTRACT`（全仓 0 命中） | ❌ `hostContract` 硬编码 OpenClaw；校验器只收 `'openclaw-legacy@1'` | **DISCONNECTED（by design）** |

---

## 6. Exact Broken Edge

只列**真正断开**的边。共 4 条，按"是否 PRI-813 本体"分组。

### E1 —（PRI-813 本体）shared gate 没有 shadow producer

- **Existing producer**：`packages/openclaw-plugin/src/core/rule-host.ts:196-254`（`RuleHost.evaluateDetailed` → `shadowDecisions`）
- **Existing consumer**：`packages/principles-core/src/runtime-v2/activation/rulecode-shadow-summary.ts:15-45`
- **Broken edge**：`packages/host-runtime/src/production-rulehost-gate.ts:259-261`
  ```ts
  if (!row || row.action !== 'code_tool_hook_live_activate') continue;   // 无 addWarning
  ```
  shadow 激活既不被评估、也不被报告。shared gate **没有** `evaluateDetailed` 的等价物。
- **影响面**：**Codex（全量） + OpenClaw shared 路径**。OpenClaw legacy 仍正常（§4.6 的 139 条由 legacy 产生）。
- **性质**：这是 **PD shared-path 缺口**，**不是 Codex 宿主能力缺口**。

### E2 —（PRI-813 本体）发射端口在接口层就没有 rulehost 通道

- `packages/principles-core/src/host/host-adapter.ts:181-184`
  ```ts
  export interface HostEventEmitter {
    recordRuntimeV2ActivationsInjected(data: ...): void;
    recordToolCall(sessionId: string | undefined, data: ...): void;
  }
  ```
- `packages/codex-adapter/src/pd-hook.ts:25-52` 的 `codexEventEmitter` 只实现这两个方法。
- **Broken edge**：即使 E1 修好（gate 产出 shadow 决策），**也没有任何端口把它们落盘**。必须在接口层扩通道。

### E3 —（PRI-813 本体）promotion 契约只承认 OpenClaw，与 evidence 无关

- `packages/pd-cli/src/commands/runtime-activation.ts:598` → `hostContract: OPENCLAW_HOST_LIVENESS_CONTRACT`
- `packages/pd-console/src/server/models/ActivationsConsoleModel.ts:477, 533-534` → 同源硬编码
- `packages/host-runtime/src/host-liveness-contract.ts:4-20` 是**唯一**契约常量（`version: 'openclaw-legacy@1'`, `supportsShadowEvidence: true`）
- `packages/principles-core/src/runtime-v2/activation/openclaw-promotion-checks.ts:42-46`
  ```ts
  if (value.version !== 'openclaw-legacy@1' || value.supportsShadowEvidence !== true || ...) return null;
  ```
- **Broken edge**：**自证双断链**。即使 E1+E2 全部修好、Codex 真的产出 shadow evidence，promotion 仍会因契约字面量不匹配而不可达。
- **性质**：PD **设计层面**决定 promotion 只服务 OpenClaw，与 Codex 宿主能力完全无关。

### E4 —（**PRI-813 之外**的新发现）Codex PostToolUse payload 无法表达 failure

- **Host 事实**：`core/src/tools/context.rs:428-436`
  ```rust
  fn post_tool_use_response(&self, ...) -> Option<JsonValue> {
      if self.process_id.is_some() || self.hook_command.is_none() { return None; }
      Some(JsonValue::String(self.truncated_output_with_policy(self.model_output_policy())))
  }
  ```
  Bash 的 `tool_response` 是**裸字符串**；`exit_code` 字段存在于 `ExecCommandToolOutput`（`context.rs:379`）但**不进入 hook payload**。apply_patch 同理（`context.rs:327-329`）。
- **PD 事实**：`packages/host-runtime/src/production-pain-evidence.ts:71-89`
  ```ts
  const exitCode = typeof resultExit === 'number' ? resultExit : typeof detailsExit === 'number' ? detailsExit : 0;
  failure: error !== undefined || exitCode !== 0,
  ```
  在 Codex 上 envelope 是字符串 ⇒ `exitCode = 0`、`error = undefined` ⇒ **`failure` 恒为 `false`**。
- **后果**：`production-pain-evidence.ts:382`
  ```ts
  const admitted = outcome.failure && WRITE_TOOLS.has(toolName) && trigger.shouldCreateDiagnosticTask;
  ```
  ⇒ **Codex 上 pain 准入结构性死亡**。
- **性质**：**这是真正的宿主级 payload 缺口**（Codex 侧需补 exit code / success，或 PD 显式声明 UNSUPPORTED 并给出可观察 nextAction）。但它属于 **pain evidence**，不属于 **shadow evidence** —— 因此**不应**塞进 PRI-813。

---

## 7. Runtime Probe

**结论：`NOT NEEDED — static evidence sufficient`**

判定依据（对应任务书 Phase 4 的四个允许条件）：

| 允许条件 | 本次判定 |
|---|---|
| Windows 实际 hook wiring 无法从源码确认 | ❌ 可从源码确认：`commandWindows` 生效路径（`discovery.rs:503-517`）、Windows shell 选择（`command_runner.rs:435-440`）、Windows 进程树收容（`:233-248`） |
| `hooks.json` 与 internal hook runtime 行为有差异 | ❌ 无差异：两者汇入同一 `discover_handlers` → `ConfiguredHandler`（`engine/discovery.rs:94-165`） |
| app-server / CLI 实际触发存在不确定性 | ❌ 不需探针即可判定：producer 在 `core`，三前端共用；且断点判定**不依赖**触发与否 |
| payload 的真实 identity 无法静态确认 | ❌ 已静态确认：generated schema（`hooks/schema/generated/*.command.input.schema.json`）+ Rust 序列化（`pre_tool_use.rs:175-191` / `post_tool_use.rs:150-167`）+ `ToolOutput` 实现（`context.rs:428-436`）三者互相印证 |

**并且**：推论链的关键一步（`failure` 恒 false）由 **PD 侧 `normalizeOutcome` 的纯函数语义**即可闭合，不需要真实 Codex 调用。

**已用到的真实运行时证据（零 Codex token）**：§4.6 的 `D:\.openclaw\workspace` 事件日志统计（3 934 条 `rulehost_evaluated`，含 139 条 shadow；0 条 Codex 来源）。

**未运行任何 Codex 调用**，Owner Plus 额度零消耗。

**残留未知（1 项，不阻塞结论）**

- Codex 插件 hook 在本机 Windows 上是否真的被 spawn，**未验证**。理由：`plugins/principles-disciple/hooks/hooks.json` 未提供 `commandWindows`，命令依赖 `node` 在 Codex 进程 PATH 上；本机 `cmd /c where node` 探针被宿主沙箱拒绝（无法创建子进程），无法可靠判定。
- 最低成本验证方式（**留给后续**，且不需要跑业务任务）：在 Codex 中做一次单次 `SessionStart` 触发后，检查 `D:\.openclaw\workspace\.state\logs\events_*.jsonl` 是否出现 `"source":"codex:session_start"` 行——**1 次调用即可**。此项不影响 §6 任何结论。

---

## 8. PRI-813 Recommendation

### Phase 6 四选一：**Verdict C — Disconnected Capability**

明确排除其余三项：

| 选项 | 排除理由 |
|---|---|
| A — 原判断仍成立（宿主缺能力） | ❌ 宿主提供 Pre/PostToolUse + 稳定 identity + 阻断 + 改写 + Windows；且 PD **已经在接收**。缺的不是宿主能力。 |
| B — 部分成立、缩小范围 | ⚠️ 方向对但不精确：真实缺口是"PD shared-path 未接线 shadow producer + promotion 契约只认 OpenClaw"，**不是**Codex 宿主子集能力的缺失。 |
| C — Disconnected Capability | ✅ **两者都已存在**：producer（`rule-host.ts:196-254`）+ consumer（`rulecode-shadow-summary.ts:15-45`）都在，缺的是 shared gate 到它们的**连接**，以及发射端口。 |
| D — 已过期 | ❌ promote 在 Codex 上确实结构性不可达（E1+E3 双重），不能关闭。 |

### 工单动作：**REFRAME AS RECONNECTION**

把 PRI-813 从「Codex 宿主 shadow evidence 断链」改写为：

> **shared host-runtime 未接线 shadow evidence 产出与 rulehost 发射端口；promotion 契约硬编码 OpenClaw。**
> 影响 Codex（全量）与 OpenClaw shared 路径；OpenClaw legacy 不受影响。

**并**：把 §6 E4（Codex PostToolUse payload 无 exit code → pain 准入死亡）**拆为独立新单**。它是本次审计中**唯一**真正的宿主级缺口，且与 PRI-813 的证据族不同（pain vs shadow）。

### 三条结论性事实（可直接进 Linear）

1. **Codex 宿主不是瓶颈**：`PreToolUse`/`PostToolUse`、稳定 `tool_use_id`、`tool_input`、`tool_response`、阻断、输入改写、Windows（`commandWindows` + JobObject）全部存在且为 Stable/default-on。
2. **真正断点 100% 在 PD 侧**（E1/E2/E3），且 E1 的"静默 `continue`"与 E3 的"只认 `'openclaw-legacy@1'`"是**同一根线两端**。
3. **PRI-813 的原始表述会误导实施**：按原表述去"给 Codex 补 shadow evidence 通道"，会去动 Codex 或新建宿主能力——而 AGENTS.md P2.1（Connection Before Creation）要求的动作是**在 shared 路径上重连既有能力**。

---

## 9. Minimum Next Action

> **本任务不实施。** 以下是给后续实施单的**最小改动范围**描述（不含设计细节，仅边界）。

### 9.1 PRI-813（重定义为 reconnection）——最小范围

1. **`packages/host-runtime/src/production-rulehost-gate.ts`**
   在现有的 activations 读取与 live 分支**旁边**，为 `activationMode === 'shadow'` 的激活复用同一 `RuleHostInput` 构造与同一 `implementationRuntime` 做 shadow 评估（不新建第二套证据系统、不新建第二套评估器）；对无法评估/被跳过的情形补 `addWarning`（回应既有 NEW-E3）。
2. **`packages/principles-core/src/host/host-adapter.ts`**
   在 `HostEventEmitter` 上**增加**一个 rulehost 记录方法（与既有 `recordRuleHostEvaluated` 的字段语义对齐），保持既有 2 个方法不变（不破坏 OpenClaw 路径）。
3. **`packages/codex-adapter/src/pd-hook.ts`**
   在 `codexEventEmitter` 中实现该新方法（复用 core 的 event-log writer，与现有 `recordRuntimeV2ActivationsInjected` 同一路径）。
4. **promotion 契约**
   二选一，**不必两者都做**：(a) 新增 Codex 对应的 host liveness 契约常量并把 `runtime-activation.ts:598` / `ActivationsConsoleModel.ts:477` 的硬编码改为按宿主解析；或 (b) 若本迭代判断 Codex 不应具备 promotion 资格，则在产品面**显式标 UNSUPPORTED** 并给出可观察 nextAction（对应 PRI-813 自己的 Done 条款）。
   注意：`openclaw-promotion-checks.ts:42` 的字面量校验是**唯一的**准入收口，改动必须在这里，不得绕过。
5. **host parity regression**
   按 PRI-813 自身 Done 条款补机械对照（OpenClaw vs Codex 的支持矩阵），并覆盖"shadow 被跳过必须有结构化 warning"（INV-E5）。

**不做**：不改 Codex 源码；不绕过 promotion gate；不伪造 `rulehost_evaluated`；不为 Codex 新建第二套证据系统或第二个 promotion algorithm。

### 9.2 新单（E4）——最小范围

- 先决定归属：**Codex upstream 补 payload**（`success_for_logging`/`exit_code` 进入 `post_tool_use_response`）**或** PD 显式 UNSUPPORTED。
- 若走 PD 侧：改动点唯一在 `packages/host-runtime/src/production-pain-evidence.ts:71-89`（failure 推导）与 `:382`（准入条件），**不得**在 Codex 的 `tool_response` 文本上做正则猜测式 exit code 复原（会制造伪证据，违反 "不伪造 evidence"）。
- 无论哪条路径，按 INV-E6 在产品面/能力矩阵显式登记后果。

---

## 附录 A — 本报告用到的关键 file:line 索引

### Codex（`D:\Code\codex`）

| 主题 | 位置 |
|---|---|
| 12 个 hook 事件 | `codex-rs/hooks/src/lib.rs:23-36` |
| hooks feature = Stable/default-on | `codex-rs/features/src/lib.rs:1188-1193` |
| PreToolUse request 结构 | `codex-rs/hooks/src/events/pre_tool_use.rs:23-36` |
| PreToolUse deny/block/updatedInput | `codex-rs/hooks/src/events/pre_tool_use.rs:241-277, 153-167` |
| PreToolUse payload 序列化 | `codex-rs/hooks/src/events/pre_tool_use.rs:175-191` |
| PostToolUse request 结构 | `codex-rs/hooks/src/events/post_tool_use.rs:23-37` |
| PostToolUse payload 序列化 | `codex-rs/hooks/src/events/post_tool_use.rs:150-167` |
| PostToolUse 输入 schema | `codex-rs/hooks/schema/generated/post-tool-use.command.input.schema.json` |
| PreToolUse 输入 schema | `codex-rs/hooks/schema/generated/pre-tool-use.command.input.schema.json` |
| producer（Pre） | `codex-rs/core/src/hook_runtime.rs:186-244` |
| producer（Post，"successful output"） | `codex-rs/core/src/hook_runtime.rs:283-321` |
| 调用点 + block 早退 | `codex-rs/core/src/tools/registry.rs:597-649` |
| **PostToolUse success 门禁** | `codex-rs/core/src/tools/registry.rs:692-727` |
| Bash 恒 success | `codex-rs/core/src/tools/context.rs:399-401` |
| Bash response = 裸 String | `codex-rs/core/src/tools/context.rs:428-436` |
| apply_patch 恒 success / 裸 String | `codex-rs/core/src/tools/context.rs:312-314, 327-329` |
| Aborted 恒 false | `codex-rs/core/src/tools/context.rs:345-347` |
| 内部终态枚举（外部不可用） | `codex-rs/ext/extension-api/src/contributors/tool_lifecycle.rs:22-40` |
| 内部终态投递 | `codex-rs/core/src/tools/lifecycle.rs:81-133` |
| `commandWindows` 配置 | `codex-rs/config/src/hook_config.rs:164-184` |
| `commandWindows` 生效 | `codex-rs/hooks/src/engine/discovery.rs:503-517` |
| hooks.json 发现 | `codex-rs/hooks/src/engine/discovery.rs:339-343`；`codex-rs/config/src/state.rs:239-243` |
| Windows 进程树收容 | `codex-rs/hooks/src/engine/command_runner.rs:233-248` |
| Windows shell / 引号 | `codex-rs/hooks/src/engine/command_runner.rs:397-433, 435-440` |
| app-server hook 通知 | `codex-rs/app-server-protocol/src/protocol/v2/hook.rs:145-158` |
| Codex CLI 版本 | `codex-cli/package.json` = `0.0.0-dev`；`codex-rs/Cargo.toml:155-156` |

### PD（`D:\Code\principles`）

| 主题 | 位置 |
|---|---|
| 订阅事件 | `packages/codex-adapter/src/host-adapter.ts:31-41` |
| 事件映射 | `packages/codex-adapter/src/codec/input-decoder.ts:11-24` |
| identity/input/response 绑定 | `packages/codex-adapter/src/codec/input-decoder.ts:81-89` |
| Codex hook payload 契约版本 | `packages/codex-adapter/src/codec/input-decoder.ts:9` |
| Codex 版本契约 | `packages/codex-adapter/src/ingestion/codex-version.ts:16-17` |
| codexEventEmitter（2 方法） | `packages/codex-adapter/src/pd-hook.ts:25-52` |
| Codex host runtime 装配 | `packages/codex-adapter/src/pd-hook.ts:186-193` |
| Codex 工具语义（仅 2 个） | `packages/codex-adapter/src/tool-semantics.ts:21-24` |
| HostEventEmitter 接口 | `packages/principles-core/src/host/host-adapter.ts:181-184` |
| HOST_EVENT_KINDS | `packages/principles-core/src/host/host-adapter.ts:46-53` |
| runtime 路由装配 | `packages/host-runtime/src/index.ts:236-249` |
| **shared gate live-only（静默 skip）** | `packages/host-runtime/src/production-rulehost-gate.ts:259-261` |
| gate deny/allow metadata | `packages/host-runtime/src/production-rulehost-gate.ts:387, 389` |
| shadow evaluator（插件私有） | `packages/openclaw-plugin/src/core/rule-host.ts:196-254` |
| shadow 落盘（唯一 producer） | `packages/openclaw-plugin/src/hooks/gate.ts:114-129` |
| legacy live 落盘 | `packages/openclaw-plugin/src/hooks/gate.ts:131-147` |
| shared live 落盘（缺 activationId） | `packages/openclaw-plugin/src/hooks/gate.ts:582-588` |
| `hook_execution` 唯一 producer | `packages/openclaw-plugin/src/index.ts:384-552` |
| shadow summary 消费 | `packages/principles-core/src/runtime-v2/activation/rulecode-shadow-summary.ts:15-45` |
| promotion snapshot 读 shadow | `packages/pd-cli/src/commands/runtime-activation.ts:115, 604-612` |
| promotion hostContract 硬编码 | `packages/pd-cli/src/commands/runtime-activation.ts:598` |
| Console 同源硬编码 | `packages/pd-console/src/server/models/ActivationsConsoleModel.ts:477, 533-534` |
| 契约校验器（只认一个字面量） | `packages/principles-core/src/runtime-v2/activation/openclaw-promotion-checks.ts:37-46` |
| 唯一契约常量 | `packages/host-runtime/src/host-liveness-contract.ts:4-20` |
| failure 推导 | `packages/host-runtime/src/production-pain-evidence.ts:71-89` |
| pain 准入条件 | `packages/host-runtime/src/production-pain-evidence.ts:382` |
| 插件 hook 注册 | `plugins/principles-disciple/hooks/hooks.json` |
| 插件 manifest | `plugins/principles-disciple/.codex-plugin/plugin.json` |
| 插件运行时 pin | `plugins/principles-disciple/runtime-version.json` |
| 全局 installer 已退役 | `packages/create-principles-disciple/src/installers/codex-host-installer.ts:247-268` |
| 前序审计（R-22 原文） | `docs/audit/pri-807-phase0/HOST_CAPABILITY_MATRIX.md:203-218, 316-332, 387-391` |

## 附录 B — 本次复核对前序审计的确认 / 修正

| 前序结论 | 本次复核 | 说明 |
|---|---|---|
| R-22 证据 1：`recordRuleHostEvaluated` 生产点唯一 | ✅ **确认** | 生产调用点全部在 `openclaw-plugin/src/hooks/gate.ts:117,134,584`；其余命中均为测试/seed |
| R-22 证据 2：`HostEventEmitter` 只有 2 方法 | ✅ **确认** | 接口定义在 `principles-core/src/host/host-adapter.ts:181-184`（前序审计写作 `host-adapter.ts:181-184` 未标包名，含义一致） |
| R-22 证据 3：shared gate 不产 shadow 决策 | ✅ **确认** | `production-rulehost-gate.ts:259-261` 逐字核对一致 |
| NEW-E2：shared 路径 live 事件缺 `activationId` | ✅ **确认** | `gate.ts:587` 仅 `ruleId, activationMode:'live'`；对照 `gate.ts:142` legacy 有 `activationId` |
| NEW-E3：shadow 在 shared gate 被静默跳过 | ✅ **确认** | `production-rulehost-gate.ts:259-261` 无 `addWarning` |
| §4.4 promotion 双重断链 | ✅ **确认（加强）** | `openclaw-promotion-checks.ts:42-46` 只接受 `'openclaw-legacy@1'` 字面量 —— 这一条独立于 evidence 存在 |
| 隐含前提："Codex 宿主能力不足" | ❌ **修正** | Codex 提供完整 tool lifecycle；缺口在 PD shared 路径。见 §1、§6 分组 |

---

*审计执行时间：2026-09-16。所有结论均可由附录 A 的 file:line 复现。*
