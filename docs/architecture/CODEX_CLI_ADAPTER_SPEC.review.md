# CODEX_CLI_ADAPTER_SPEC v4 内容核实报告

> 核实日期：2026-08-11 | 核实人：WorkBuddy
> 核实依据：`D:\Code\codex`（HEAD = `2cc9dbb984`，2026-08-11）、`D:\Code\principles` 及本 worktree、OpenAI 官方文档 <https://developers.openai.com/codex/hooks>

## 总体结论

SPEC v4 的**大部分基础事实核实通过**（事件清单、feature flag、matcher 别名机制、schema 字段、超时、信任机制等约 30 项声明与源码逐行吻合，行号引用基本准确）。但 v4 最核心的两条"P0 修正"本身含有**新的严重事实错误**——`continue: false` 的语义被严重夸大，`permissionDecision: "ask"` 的描述自相矛盾，"fail-closed" 定性错误。此外有若干不准确项与内部不一致。

---

## 一、严重错误

### E1. `continue: false` "terminates the ENTIRE Codex session" —— 错误夸大

**文档位置**：§0 变更日志 P0-2（第 7 行）、§5.3.1（第 434 行）、§5.3.3（第 531 行）、§10 表 row 2、文末验证声明（第 1047 行）

**文档声称**："`continue: false` terminates the entire Codex session in UserPromptSubmit/PostToolUse/Stop/SessionStart (verified in each event handler)"。

**源码核实结果**：`continue: false` **从不终止会话**，最多中止当前 turn，且在 PostToolUse 中完全没有控制效果：

| 事件 | 实际行为 | 源码位置 |
|------|----------|----------|
| UserPromptSubmit | `should_stop=true` → `reject_pending_input()` → `run_turn` 返回 `Ok(None)`，**仅中止本 turn，会话存活**，用户可继续提交 | `hooks/src/events/user_prompt_submit.rs:183-193`；`core/src/session/turn.rs:609-631`。测试名 `continue_false_preserves_context_for_later_turns`（user_prompt_submit.rs:303）直接反证"终止会话" |
| SessionStart | `should_stop` → `run_pending_session_start_hooks` 返回 true → `run_turn` 返回 `Ok(None)`，中止首个 turn | `core/src/session/turn.rs:243-245` |
| Stop | `should_stop` → `break` 出 continuation 循环，结束 turn | `core/src/session/turn.rs:519-521` |
| PostToolUse | **`PostToolUseOutcome` 结构体根本没有 `should_stop` 字段**（post_tool_use.rs:40-45）；`continue:false` 仅把 hook run 标记为 Stopped 并向模型推 feedback，**对 turn 无任何控制效果** | `hooks/src/events/post_tool_use.rs:212-225` |
| PreToolUse / PermissionRequest | `continue:false` 被**直接拒绝**：`invalid_reason = "unsupported continue:false"` | `hooks/src/engine/output_parser.rs:356-367` |

**建议修正**：改为"`continue: false` 在 UserPromptSubmit/SessionStart 中止当前 turn（丢弃用户输入），在 Stop 结束 turn 循环，在 PostToolUse 仅标记 run 停止；在 PreToolUse/PermissionRequest 中属于非法输出会被整体拒绝。PD codec 不应主动设置该字段（缺省即为 true）"。"PD codec MUST hardcode `continue: true`"的建议可保留，但风险描述必须改正——真实风险是**用户 prompt 被静默丢弃/turn 中止**，不是"杀死整个 Codex 会话"。

### E2. `permissionDecision: "ask"` 的描述自相矛盾且与源码不符

**文档位置**：§5.3.1（第 448 行）

**文档声称**："ask → valid enum value; behavior: treated like allow (no block), **BUT if combined with updatedInput or updatedPermissions**, Codex generates invalid_reason and rejects the entire output"。

**源码核实结果**：`output_parser.rs:447-449`（`unsupported_pre_tool_use_hook_specific_output`）中 Ask 分支**无条件**返回 `invalid_reason`：

```rust
Some(PreToolUsePermissionDecisionWire::Ask) => {
    Some("PreToolUse hook returned unsupported permissionDecision:ask".to_string())
}
```

即：**只要出现 `permissionDecision: "ask"`（无论是否搭配其他字段），整个输出即被拒绝**。文档 §5.3.1 的"treated like allow (no block), BUT if combined with…"是错误的；且与本文档变更日志 P0-2（第 7 行）自己的正确表述"generates invalid_reason and rejects the entire output"自相矛盾。

**建议修正**：§5.3.1 改为"`permissionDecision: \"ask\"` → 合法枚举值，但 Codex **一律**生成 `invalid_reason` 并拒绝整个输出（output_parser.rs:447-449）。PD 不得使用"。

### E3. "fail-closed" 定性错误 —— 实际是 fail-open

**文档位置**：§5.3.1（第 448 行）、§10 表 row 4（第 905 行）

**文档声称**：invalid_reason 拒绝输出是"**fail-closed**"。

**源码核实结果**：PreToolUse 事件处理器中，`invalid_reason` 分支只设置 `HookRunStatus::Failed` + Error 条目，**不设置 `should_block`**（pre_tool_use.rs:235-240；对比 243 行 `should_block = true` 只在正常 block 分支）。输出被拒绝 = hook 的意图被丢弃 = **工具调用照常执行**。这是典型的 **fail-open**。

**影响**：对 PD 的 confirm-first gate 而言这是方向性误判——codec 产出非法输出时，危险命令会被**放行**而非拦下。

**建议修正**：将两处"fail-closed"改为"fail-open（输出被丢弃，工具调用继续执行）——因此 PD codec 的字段白名单与契约测试是 gate 正确性的关键防线"。

---

## 二、不准确

### I1. `suppressOutput` 行为描述错误

**位置**：§5.3.1（第 436 行）"if true, hides hook output from Codex UI (for debugging)"。

**核实**：该字段**尚未实现**。UserPromptSubmit 中显式忽略（`let _ = parsed.universal.suppress_output;`，user_prompt_submit.rs:181）；PreToolUse/PermissionRequest 中设置它会直接产生 `invalid_reason`（"unsupported suppressOutput"，output_parser.rs:362-363）；官方文档明确标注 "parsed but not supported yet"。同时 §5.3.1 称通用字段"apply to ALL hook outputs"具有误导性：PreToolUse/PermissionRequest 拒绝 `continue:false`/`stopReason`/`suppressOutput`，PostToolUse 拒绝 `suppressOutput`。

**建议**：改为"suppressOutput 已解析但未实现；在 PreToolUse/PermissionRequest 中设置会导致整个输出被拒绝。PD codec 不得序列化该字段"。

### I2. 版本钉扎 `>= 0.118` 与实际发布历史不符

**位置**：§8.1（第 858 行）"require >= 0.118 (hooks stabilized)"。

**核实**：git 历史显示 hooks Stable 化提交为 `23afa173f4` "Mark codex_hooks stable (#19012)"（2026-04-23），首个包含它的发布标签是 **`rust-v0.124.0`**（预发布 0.124.0-alpha.3）。0.118 无法对应"stabilized"。文档 §10 自评第 5 条已诚实标注此项未验证。

**建议**：改为 `>= 0.124.0`，并在 E2E（PRI-282）中实测最低可用版本。

### I3. `async: true` 在生产版本上的效果存疑

**位置**：§5.7 hooks.json 示例（第 648 行）及 v4 变更说明（第 688 行）"async eliminates blocking (P3-2)"。

**核实**：本地 HEAD 源码中 `async` **已被消费**（discovery.rs:500-504 生成 `runs_async`；:589-592 映射 `HookExecutionMode::Async`；SessionEnd 强制同步并告警）。但**官方文档**（代表当前 release 行为）明确写道："The `async` option is parsed, but asynchronous command hooks aren't supported yet." 即用户实际安装的发布版本上 `async: true` 很可能是 no-op。

**建议**：保留 `async: true` 无妨（向前兼容），但删除"eliminates blocking"的功效声明，标注"HEAD 支持、release 未支持，以钉扎版本实测为准"。

### I4. "16 OpenClaw slash commands" 计数错误

**位置**：§12.2 Hidden ticket B（第 1017 行）。

**核实**：文档实际列出 **19** 个命令，且与 `packages/openclaw-plugin/src/` 源码逐一对得上（grep 去重后恰为这 19 个）。数字 16 错误。

**建议**：改为 19。

### I5. §2.7 "silent degradation" 表述略过

**位置**：§2.7（第 173 行）。

**核实**：超时/出错时 hook 的功能效果确实被忽略（视同空输出，user_prompt_submit.rs:149-155），但会产生 `HookRunStatus::Failed` + Error 条目，在 `/hooks` UI 与 hook 事件中**可见**，并非完全 silent。

**建议**：改为"功能上降级为空输出，失败仅在 /hooks 界面可见，无阻塞性告警"。

---

## 三、内部不一致（轻微）

| # | 位置 | 问题 |
|---|------|------|
| C1 | §3 对照表 "Session identity" 行（第 192 行） | 称 Codex 每个 hook 都有 `session_id` + `turn_id`，与本文 §5.3.4（SessionStart 无 `turn_id`，P0-3 修正）矛盾 |
| C2 | §5.2 包结构（第 371 行） | `pre-tool-use.ts # matcher: "Bash" (ONLY Bash fires)` 注释是 v2 时代残留，与 v4 核心结论（PreToolUse 覆盖所有 function tools）及 §5.7 的 `"Bash\|apply_patch"` 矛盾 |
| C3 | §2.2 表 SessionStart 行 | "observe-only" 不够准确：SessionStart 支持 `additionalContext` 注入且 `continue:false` 可中止首个 turn |

---

## 四、核实通过的关键声明（抽样 30+ 项全部吻合）

- 11 个 hook 事件、9 个带 matcher（`hooks/src/lib.rs:19-48`）✓
- `hooks` flag Stable 默认 ON（`features/src/lib.rs:1062-1067`）；`codex_hooks` 废弃别名（`features/src/legacy.rs:49`）✓
- `plugin_hooks` 为 `Stage::Removed` no-op（`features/src/lib.rs:1234-1239`，文档引 1235-1238 略偏 1 行）✓
- `HookToolName::apply_patch()` 含 Write/Edit 别名（`hook_names.rs:34-38`）；`spawn_agent` 含 `Agent` 别名（:46-50）✓
- `apply_patch` 自有 `pre_tool_use_payload`（`apply_patch.rs:458-463`）✓
- `matcher_inputs()` 链式拼接（`common.rs:152-161`）；dispatcher `any()` 匹配与别名测试（`dispatcher.rs:48-66, 433`）✓
- PreToolUse 覆盖全部 function tools（registry.rs:125-134 默认实现 + :568 dispatch）及 MCP 工具（`handlers/mcp.rs:247`）✓
- `HookUniversalOutputWire` 四字段（`schema.rs:86-97`）；`deny_unknown_fields` 恰好 29 处 ✓
- `updatedMCPToolOutput`（`schema.rs:232-234`）✓
- SessionStart 输入无 `turn_id`/`agent_id`/`agent_type`（`schema.rs:483-497`）；PreToolUse 输入字段逐一对上（:271-294）✓
- 超时：默认 600s（`discovery.rs:649`），SessionEnd 默认 1s 上限 3s（`session_end.rs:20-23`）✓
- 信任机制：内容哈希、`/hooks` TUI、`--dangerously-bypass-hook-trust`、managed hooks 按策略信任（`discovery.rs:585-618, 692-706`；官方文档确认）✓
- 插件 hooks 无 flag 发现（`append_plugin_hook_sources`，`discovery.rs:219`）；插件 hooks 非 managed 需信任；`PLUGIN_ROOT`/`CLAUDE_PLUGIN_ROOT`/`PLUGIN_DATA`/`CLAUDE_PLUGIN_DATA` 环境变量（:240-245）✓
- hooks.json 字段 `commandWindows`（+`command_windows` 别名）/`timeout`/`async`/`statusMessage`/`additionalContextLimit`（`hook_config.rs:148-172`）✓；`additionalContextLimit` 对不能 emit context 的事件会被忽略并告警（discovery.rs:508-525）——SPEC 只在 UserPromptSubmit/SessionStart 上设置，正确 ✓
- 多 hook 并发执行（`dispatcher.rs:99` FuturesUnordered）✓
- exit code 2 阻止 PreToolUse（pre_tool_use.rs:274 及测试 :704）✓
- 多配置层全部加载不替换（官方文档确认）✓
- PD 侧：`runtime-protocol.ts:20` 已列 `codex-cli`；`runtime-v2/adapter/` 现有 openclaw-cli/pi-ai/test-double 三个 adapter；`workspace-resolver.ts`、`classifyToolCallOutcome`、`truncateInjectionToBudget`/`DEFAULT_PRINCIPLE_BUDGET` 均存在；19 个 slash 命令均存在；worktree 的 `post-mvp-conditional-roadmap.md` §18 存在 ✓

---

## 五、存疑（无法确认）

| # | 内容 | 原因 |
|---|------|------|
| U1 | PRI-278~282 的 Linear 状态与估算 | Linear 未连接，无法核实 |
| U2 | plugin.json 清单的确切 schema | SPEC §10 自评已标注未定义。源码侧 `core-plugins/src/agent_plugin_manifest.rs` 要求根 `plugin.json` 含 `$schema`（Agent Plugins URI）；另有测试引用 `.codex-plugin/` 清单目录。实现前需按 `codex_utils_plugins::AGENT_PLUGIN_SCHEMA_URI` 核对 |
| U3 | 项目级 `<repo>/.codex/hooks.json` "requires project trust" | app-server 存在项目信任机制（hooks_list 测试引用），未逐行确认其与 hooks 加载的耦合点；方向可信 |
| U4 | `pd health --host codex`、`pd pain list`、`--uninstall-codex` | 均为设计意图，pd-cli 现有命令中不存在（现有 `health.ts`、`pain-record.ts`、`pain-retry.ts` 等） |
| U5 | §3 对照表 OpenClaw 侧声明（如 `skipToolCall`、4 个 prompt 字段） | 属 PD/OpenClaw 内部 API，本次未逐项核实 |

---

## 六、评审意见

1. **v4 的"外部评审修正"质量高于 v3，但两条头条 P0 修正（E1/E2）本身未真正核对源码**，且使用了"verified in each event handler"这类过强的验证措辞。建议对 E1/E2/E3 出 v4.1 修正，并将验证措辞降级为实际核对过的范围。
2. E3 的 fail-open 定性对 PD 的 gate 设计有实际后果：codec 的字段白名单 + Codex 生成的 JSON Schema fixture 契约测试（P3-6）应从"建议"升级为"gate 正确性的必要防线"，建议在 §7 风险表中单列。
3. 版本钉扎（I2）与 `async` 功效（I3）应在 PRI-282 E2E 中以钉扎版本实测收口，避免以 HEAD 行为替代 release 行为。
4. 文档对官方文档的覆盖可补一条引用：<https://developers.openai.com/codex/hooks>（本次核实确认其与本地源码高度一致，差异主要在 async/suppressOutput 等"已解析未发布"字段）。
