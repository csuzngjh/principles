> **官方文档快照 · Hooks Reference**

> **来源**：https://www.workbuddy.ai/docs/cli/hooks
> **抓取日期**：2026-10-12（文档站构建 commit `4a4c8c2c72d`，文档 lastUpdated 2026-09-17）
> **版本**：CodeBuddy Code v1.16.0 及以上，Hooks 为 Beta 功能，API 与运行时行为可能演进
> **性质**：官方文档快照，由 SSG HTML 自动转换为 Markdown，可能有少量格式损耗；内容以官方站为准。
> **注意**：canonical 指向 codebuddy.ai（CodeBuddy CLI 文档），WorkBuddy 桌面版与其共用引擎（取证时（桌面版 5.3.14）引擎文件为 `cli/dist/codebuddy.js`；本机 2026-10-11 已升级桌面版 5.8.1，引擎文件变为 `cli/dist/codebuddy-lite-wb.mjs`——复核时先 `ls` 引擎目录，勿照搬旧路径）；中文站 workbuddy.cn/docs/ide/Features/Hooks 是旧版（7 事件、仅 command 类型），勿混用。

---

# Hooks Reference

> **Version requirement:** This guide targets the Hooks implementation shipped with CodeBuddy Code v1.16.0 and later. **Feature status:** Hooks are currently in **Beta**; APIs and runtime behavior may evolve.

Hooks let you inject custom scripts or commands into every stage of a CodeBuddy Code session so you can automate validation, bootstrap environments, run compliance checks, and more.

---

## Feature Overview

- Full support for the hook event family (27+ events), covering tool lifecycle (`PreToolUse` / `PostToolUse` / `PostToolUseFailure`), session and sub-agent (`SessionStart` / `SessionEnd` / `Stop` / `SubagentStart` / `SubagentStop` / `StopFailure`), user interaction (`UserPromptSubmit` / `Notification` / `PermissionRequest` / `PermissionDenied` / `Elicitation` / `ElicitationResult`), context (`PreCompact` / `PostCompact` / `InstructionsLoaded` / `ConfigChange`), task and team (`TaskCreated` / `TaskCompleted` / `TeammateIdle`), file and environment (`FileChanged` / `CwdChanged` / `WorktreeCreate` / `WorktreeRemove`), and bootstrap/maintenance (`Setup`). For the full event list, see the [event table in the plugin reference](https://www.workbuddy.ai/docs/cli/plugins-reference#_3-hooks).
- Declare hooks directly in the frontmatter of a custom Agent / Skill, with scope bound to the subagent lifecycle (see [the section at the end of this document](#agent-skill-frontmatter-hooks)).
- Regex-based matchers to route execution by tool name or event context.
- Automatic injection of `session_id`, transcript paths, working directory, and other context.
- Dual signaling via exit codes and JSON payloads for clear decision semantics.
- `/hooks` CLI panel for reviewing and approving any configuration changes before they take effect, ensuring safety.
- Individual hook processes time out after 60 seconds so one slow script will not block the rest.

---

## Configuration

CodeBuddy Code stores hook configuration inside your settings files:

| Scope | Path | Notes |
| --- | --- | --- |
| User | `~/.codebuddy/settings.json` | Applies to every project |
| Project | `<project-root>/.codebuddy/settings.json` | Shared with the whole repo |
| Project local | `<project-root>/.codebuddy/settings.local.json` | Local-only overrides (not committed) |
| Enterprise policy | Distributed policy bundle | Managed centrally by your org |

**Merge behavior:** Hooks from different scopes are **merged**, not overwritten. All matching hooks for the same event run in parallel.

## Structure

Hooks are grouped by matcher, and each matcher may contain multiple hook definitions:

```json
{
  "hooks": {
    "EventName": [
      {
        "matcher": "ToolPattern",
        "hooks": [
          {
            "type": "command",
            "command": "your-command-here"
          }
        ]
      }
    ]
  }
}
```

**Key fields:**

- **matcher** – Regex pattern for tool names, case-sensitive (only for `PreToolUse` and `PostToolUse`).
  - Simple string match: `Write` matches any tool name containing "Write" (e.g., `Write`, `NotebookWrite`).
  - Exact match: Use `^Write$` to match only the Write tool.
  - Multiple tools: `Edit|Write` or `Web.*`.
  - Match all tools: Any of the following are equivalent:
    - Use `*`
    - Use empty string `""`
    - Omit the `matcher` field
- **hooks** – Array executed when the matcher hits.
  - **type** – Execution mode. Use `"command"` for shell commands, or `"prompt"` for LLM-based evaluation.
  - **command** – (type = `command`) Shell command to run. `$CODEBUDDY_PROJECT_DIR` is available. Executed using the user's default shell (`$SHELL`) on macOS/Linux, and **Git Bash is enforced on Windows** (cmd.exe and PowerShell are not supported), so commands must be compatible with bash syntax.
  - **prompt** – (type = `prompt`) Prompt text sent to the LLM for evaluation (only supports `Stop`, `UserPromptSubmit`, and `PreToolUse` events).
  - **timeout** – Optional timeout in seconds for the specific hook.

For events that do not use matchers (`UserPromptSubmit`, `Stop`, `SubagentStop`, etc.) you can omit the field entirely:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 /path/to/prompt-validator.py"
          }
        ]
      }
    ]
  }
}
```

## Project-Scoped Hook Scripts

Use the `CODEBUDDY_PROJECT_DIR` environment variable (available while CodeBuddy builds the hook command) to reference scripts stored in the repo:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CODEBUDDY_PROJECT_DIR\"/.codebuddy/hooks/check-style.sh"
          }
        ]
      }
    ]
  }
}
```

> **Tip**: If your hook script is a Python file, explicitly use `python3` to invoke it instead of directly executing the `.py` file. This is because even if the script includes a shebang line (`#!/usr/bin/env python3`), Git Bash on Windows may not correctly recognize it:
>
> ```json
> "command": "python3 \"$CODEBUDDY_PROJECT_DIR\"/.codebuddy/hooks/my_hook.py"
> ```

## Plugin Hooks

Plugins can ship hooks that merge seamlessly with user or project settings. When you enable a plugin, its hooks are merged automatically.

**How plugin hooks work:**

- Defined inside `hooks/hooks.json` within the plugin bundle, or via a custom path referenced from the `hooks` field.
- Activated hooks merge with user and project hooks.
- Multiple hook sources can all respond to the same event.
- `${CODEBUDDY_PLUGIN_ROOT}` points to the plugin directory for script references.

Example:

```json
{
  "description": "Automatic code formatting",
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "${CODEBUDDY_PLUGIN_ROOT}/scripts/format.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

## Prompt-Based Hooks

Besides shell commands (`type: "command"`), CodeBuddy Code also supports prompt-based hooks (`type: "prompt"`) that use an LLM to evaluate whether to allow or block an action.

> **Supported events**: Currently only `Stop`, `UserPromptSubmit`, and `PreToolUse` events are supported.

> **Session-level shortcut**: The built-in slash command [`/goal`](https://www.workbuddy.ai/docs/cli/goal) is a ready-to-use wrapper around prompt-based Stop hooks — simply type `/goal <condition>` to have CodeBuddy keep working until the condition is met, without writing hook configuration manually. If your evaluation logic can be expressed as a condition string, prefer `/goal`; only fall back to writing your own prompt hook when you need more complex prompt orchestration or cross-event coordination.

### How Prompt Hooks Work

Instead of running a bash command, the hook:

1. Sends the hook input plus your prompt to a fast small model (bound to the `lite` slot, mapped per model provider).
2. Receives a structured JSON decision.
3. Lets CodeBuddy Code enforce that decision.

### Supported Events

| Event | Use Case |
| --- | --- |
| `Stop` | Intelligently decide whether CodeBuddy should continue working |
| `UserPromptSubmit` | Use LLM to assist in validating user prompts |
| `PreToolUse` | Make context-aware permission decisions |

### Comparison with Command Hooks

| Feature | Command Hooks | Prompt Hooks |
| --- | --- | --- |
| **Execution** | Runs bash scripts | Queries LLM |
| **Decision logic** | You implement in code | LLM evaluates context |
| **Setup complexity** | Requires script files | Just configure a prompt |
| **Context awareness** | Limited by script logic | Natural language understanding |
| **Performance** | Fast (local execution) | Slower (API call) |
| **Best for** | Deterministic rules | Context-aware decisions |

### Configuration

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Evaluate if CodeBuddy should stop: $ARGUMENTS. Check if all tasks are complete."
          }
        ]
      }
    ]
  }
}
```

**Fields:**

- **type** – Must be `"prompt"`.
- **prompt** – Text sent to the LLM. Use `$ARGUMENTS` as a placeholder for the hook input JSON, which will be directly replaced. When `$ARGUMENTS` is not present, the input JSON is appended in the format `\n\nARGUMENTS:\n{JSON}`.
- **timeout** – Optional timeout in seconds (default: 30s).
- **continueOnBlock** – (Optional) Whether to let the Agent continue working instead of stopping when the prompt hook returns `ok: false`. When set to `true`, the behavior is similar to `/goal`: the `reason` is injected into conversation history, and the Agent continues looping until the condition is met. Only meaningful for `Stop`/`SubagentStop` events. Defaults to `false` (Agent stops).

### Response Schema

The LLM must return JSON:

```jsonc
{
  "ok": true | false,
  "reason": "Explanation for the decision",  // Required when ok is false
  "impossible": false                          // Optional, only effective for Stop events
}
```

**Response fields:**

- `ok`: `true` to allow the operation, `false` to block it
- `reason`: Required when `ok` is `false`, explanation shown to CodeBuddy
- `impossible`: Optional boolean, only meaningful for `Stop` hooks. `{ok: false, impossible: true}` indicates that the evaluator has determined "this goal is fundamentally impossible to achieve within the current session" (contradictory conditions, unavailable resources, or the model has exhausted all reasonable attempts). CodeBuddy will stop looping and the UI displays a "cannot be achieved" terminal state. A plain `{ok: false}` still means "not yet achieved, keep working".

**`reason` injection into history semantics**: When a `Stop` hook returns `{ok: false}`, the `reason` text is not simply "shown to CodeBuddy" — it is injected as an internal user message with `isMeta=true` into the conversation history, so that the main model sees the evaluator's perspective in the next turn and can precisely address the outstanding gaps. This is the core mechanism that allows prompt-based Stop hooks to drive multi-turn iterative convergence (the `/goal` command relies on this pipeline under the hood).

### Example: Smart Stop Hook

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "You are evaluating whether CodeBuddy should stop working. Context: $ARGUMENTS\n\nAnalyze the conversation and determine if:\n1. All user-requested tasks are complete\n2. Any errors need to be addressed\n3. Follow-up work is needed\n\nRespond with JSON: {\"ok\": true} to allow stopping, or {\"ok\": false, \"reason\": \"your explanation\"} to continue working.",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

### Example: Persistent Stop Hook (continueOnBlock)

By setting `continueOnBlock: true`, a prompt Stop hook can drive the Agent to continue working when the condition is not met, similar to `/goal`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Check if all tests pass and code is properly formatted. Context: $ARGUMENTS\n\nIf tests pass and code is clean, return {\"ok\": true}.\nIf not, return {\"ok\": false, \"reason\": \"describe what still needs to be fixed\"}.",
            "continueOnBlock": true,
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

When `continueOnBlock` is `true`:

- `ok: true` → Agent stops normally
- `ok: false` → `reason` is injected into conversation history, Agent continues working until the condition is met
- `ok: false, impossible: true` → Agent stops, displaying "goal cannot be achieved"

When `continueOnBlock` is `false` (default):

- `ok: false` → Agent stops, does not continue looping

### Example: UserPromptSubmit Validation

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Evaluate if this user prompt is safe and appropriate. Input: $ARGUMENTS\n\nCheck if:\n- The prompt contains sensitive information (passwords, secrets)\n- The request is clear and actionable\n- Any security concerns exist\n\nReturn: {\"ok\": true} to allow, or {\"ok\": false, \"reason\": \"explanation\"} to block."
          }
        ]
      }
    ]
  }
}
```

### Example: PreToolUse Permission Decision

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Evaluate if this bash command should be allowed. Input: $ARGUMENTS\n\nCheck if:\n- The command is safe and non-destructive\n- It doesn't access sensitive files or directories\n- It aligns with the user's stated goals\n\nReturn: {\"ok\": true} to allow, or {\"ok\": false, \"reason\": \"explanation\"} to deny."
          }
        ]
      }
    ]
  }
}
```

### Best Practices

- **Be specific in your prompts**: Clearly describe what you want the LLM to evaluate
- **Include decision criteria**: List the factors the LLM should consider
- **Test your prompts**: Verify the LLM makes correct decisions for your use cases
- **Set appropriate timeouts**: Default is 30 seconds, adjust if needed
- **Use for complex decisions**: Command hooks are better suited for simple, deterministic rules

## Hook Events

### Event Matrix

| Event | Trigger | Matcher support | Typical use cases |
| --- | --- | --- | --- |
| `PreToolUse` | Before a tool executes | Yes (tool name) | Command validation, approvals, logging |
| `PostToolUse` | After a tool succeeds | Yes | Auto-formatting, context enrichment, compress/replace tool results |
| `Notification` | Permission prompts or 60s idle reminders | Partial | Desktop alerts, IM pings |
| `UserPromptSubmit` | User message submitted *(internal commands excluded)* | No | Content review, context injection |
| `Stop` | Main agent reply finishes | No | Force continuation, add reminders |
| `SubagentStop` | Sub-agent (Task tool) completes | No | Extend or annotate sub-tasks |
| `PreCompact` | Before context compaction | Yes (`manual` / `auto`) | Preserve key info, avoid lossy compression |
| `PostCompact` | After context compaction completes successfully | No | Record compaction summaries, synchronize external state |
| `SessionStart` | Session creation or resume | Yes (`startup` / `resume` / `clear` / `compact`) | Env bootstrap, variable injection |
| `SessionEnd` | Session terminated | Yes (`clear` / `logout` / `prompt_input_exit` / `other`) | Cleanup, log persistence |

### PreToolUse

Runs after CodeBuddy builds tool arguments but before executing the tool.

**Common matchers:**

- `Task` – Sub-agent tasks
- `Bash` – Shell commands
- `Glob` – File globbing
- `Grep` – Content search
- `Read` – File reads
- `Edit` – File edits
- `Write` – File writes
- `WebFetch`, `WebSearch` – Web operations

### PostToolUse

Runs immediately after a tool succeeds. Uses the same matcher values as `PreToolUse`.

### Notification

Runs when CodeBuddy emits a notification. Matchers filter by notification type.

**Supported matchers (partial):**

- `permission_prompt` – Permission requests from CodeBuddy Code
- `idle_prompt` – When CodeBuddy is waiting for user input (after idle > 60 seconds)
- `auth_success` – Auth success notification
- `elicitation_dialog` – When CodeBuddy Code needs MCP tool–elicited input (not yet supported)

Example:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/permission-alert.sh"
          }
        ]
      },
      {
        "matcher": "idle_prompt",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/idle-notification.sh"
          }
        ]
      }
    ]
  }
}
```

### UserPromptSubmit

Runs after the user submits a prompt but before CodeBuddy processes it. Useful for injecting context, validating, or blocking certain prompts.

### Stop

Runs when the primary CodeBuddy agent finishes responding (skipped if the user manually interrupts).

> **Session-level shortcut**: The built-in slash command [`/goal`](https://www.workbuddy.ai/docs/cli/goal) is a wrapper around session-scoped prompt-based Stop hooks — `/goal <condition>` is all it takes to register a Stop hook that keeps CodeBuddy working until the condition is met, automatically handling three-state evaluation (achieved / not yet achieved, keep working / impossible to achieve), turn counting, token statistics, and `/resume` auto-recovery. When you need a session-level "keep working until X" behavior, prefer `/goal` instead of writing hook configuration manually.

### SubagentStop

Runs when a CodeBuddy sub-agent (Task tool) finishes.

### PreCompact

Runs before CodeBuddy compacts conversation context.

**Matchers:**

- `manual` – Triggered via `/compact`
- `auto` – Triggered automatically when the context window fills up

### PostCompact

Runs after CodeBuddy Code successfully completes context compaction. This event is observational only and cannot block or modify the compaction result.

### SessionStart

Runs when CodeBuddy starts a new session or resumes an existing one.

**Matchers:**

- `startup` – Fresh start
- `resume` – Triggered by `--resume`, `--continue`, or `/resume`
- `clear` – Triggered by `/clear`
- `compact` – Triggered by auto/manual compaction

### SessionEnd

Runs when a session closes—use it to free resources or persist logs.

**`reason` field values:**

- `clear` – Session cleared via `/clear`
- `logout` – User signed out
- `prompt_input_exit` – User exited while the prompt input box was visible
- `other` – Any other exit reason (including normal exit)

## Hook Input

Each hook receives JSON over stdin containing session metadata plus event-specific fields:

```jsonc
{
  // Common fields
  "session_id": "string",
  "transcript_path": "string",  // Path to the conversation JSON
  "cwd": "string",              // Working directory when the hook runs
  "permission_mode": "string",  // "default", "plan", "acceptEdits", or "bypassPermissions"
  "generation_id": "string",    // Optional; equals the session Request ID when conversationRequestId is available and is shared across events in the same turn, such as UserPromptSubmit and Stop; omitted when unavailable and never replaced with messageId or traceId

  // Event-specific properties
  "hook_event_name": "string"
  // ...
}
```

### PreToolUse Input

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.codebuddy/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Write",
  "tool_input": {
    "file_path": "/path/to/file.txt",
    "content": "file content"
  }
}
```

### PostToolUse Input

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.codebuddy/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "PostToolUse",
  "tool_name": "Write",
  "tool_input": {
    "file_path": "/path/to/file.txt",
    "content": "file content"
  },
  "tool_response": {
    "filePath": "/path/to/file.txt",
    "success": true
  }
}
```

### Notification Input

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.codebuddy/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "Notification",
  "message": "CodeBuddy needs your permission to use Bash",
  "notification_type": "permission_prompt"
}
```

### UserPromptSubmit Input

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.codebuddy/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "UserPromptSubmit",
  "generation_id": "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  "prompt": "Write a function to calculate the factorial of a number"
}
```

### Stop & SubagentStop Input

`stop_hook_active` becomes `true` when CodeBuddy Code has already continued due to a stop hook result.

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/xxx/.codebuddy/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "generation_id": "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  "stop_hook_active": true
}
```

### PreCompact Input

For manual triggers, `custom_instructions` comes from the `/compact` command. Auto triggers leave it empty.

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/xxx/.codebuddy/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "permission_mode": "default",
  "hook_event_name": "PreCompact",
  "trigger": "manual",
  "custom_instructions": ""
}
```

### PostCompact Input

`compact_summary` is the summary or engineering compaction content produced by this compaction operation.

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/xxx/.codebuddy/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "permission_mode": "default",
  "hook_event_name": "PostCompact",
  "trigger": "manual",
  "compact_summary": "本次压缩生成的摘要"
}
```

### SessionStart Input

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/xxx/.codebuddy/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "permission_mode": "default",
  "hook_event_name": "SessionStart",
  "source": "startup"
}
```

### SessionEnd Input

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/xxx/.codebuddy/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "SessionEnd",
  "reason": "other"
}
```

## Hook Output

Hooks communicate back to CodeBuddy Code in two ways.

### Basic Mode: Exit Codes

Use exit status, stdout, and stderr to convey results:

- **Exit code 0** – Success. Stdout appears in transcript mode (Ctrl+R), except for `UserPromptSubmit` and `SessionStart`, where stdout is appended to the context.
- **Exit code 2** – Blocking error. Message source priority: stdout (JSON `reason`/`stopReason` field or plain text) > stderr. **Stderr is only a fallback** – it is only passed to CodeBuddy when stdout has no output. Therefore, debug logs can safely be written to stderr without polluting the feedback message to the Agent.
- **Other exit codes** – Non-blocking errors. Stderr is shown to the user and execution proceeds.

#### Exit Code 2 Behavior

> **Note:** "message" in the table below refers to the message retrieved from stdout or stderr based on priority (see fallback explanation above).

| Event | Effect |
| --- | --- |
| PreToolUse | Blocks the tool call and surfaces message to Agent |
| PostToolUse | Surfaces message to Agent (tool already ran, used for context injection); can use `updatedToolOutput` to replace tool results |
| Notification | N/A – message shown to the user |
| UserPromptSubmit | Blocks the prompt, clears it, message shown to user only |
| Stop | Blocks the stop action, surfaces message to Agent and continues conversation |
| SubagentStop | Blocks the sub-agent stop, surfaces message to sub-agent and continues execution |
| PreCompact | Blocks compaction, message shown to user only |
| SessionStart | N/A – message shown to the user |
| SessionEnd | N/A – message shown to the user |

### Advanced Mode: JSON Output

Write structured JSON to stdout for granular control.

#### Common JSON Fields

All hook types may include these optional fields:

```jsonc
{
  "continue": true,        // Whether CodeBuddy proceeds after the hook (default true)
  "stopReason": "string",  // Message shown to CodeBuddy when continue is false
  "reason": "string",      // Alias for stopReason, both are equivalent

  "suppressOutput": true,  // Hide stdout in transcript mode (default false)
  "systemMessage": "string" // Optional warning shown to user only (not passed to Agent)
}
```

**Message field notes:**

- `stopReason` / `reason`: Message passed to CodeBuddy Agent explaining why the operation was blocked
- `systemMessage`: Warning shown to user only, not passed to Agent

#### PreToolUse Decision Control

PreToolUse hooks can control whether the tool call proceeds.

```jsonc
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "deny" | "ask",
    "permissionDecisionReason": "Reason shown in permission dialog",
    "modifiedInput": {
      "field_to_modify": "new value"
    }
  }
}
```

- `"allow"` – Bypass the permission system and execute the tool directly
- `"deny"` – Block the tool call, `permissionDecisionReason` is passed to Agent
- `"ask"` – Force the UI to prompt the user, `permissionDecisionReason` is shown in the confirmation dialog
- `modifiedInput` – Mutate tool arguments before execution (partial field override)

#### PostToolUse Context Injection & Result Replacement

PostToolUse fires **after** the tool has executed, so it cannot truly "block" the operation. Instead, it can:

1. **Append** additional context to the Agent (`additionalContext`);
2. **Replace** the tool result that will be sent to the Agent (`updatedToolOutput`).

**Append context** (original tool result is preserved, with an additional note appended):

```jsonc
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Additional information for CodeBuddy, e.g., code review results"
  }
}
```

**Replace tool result** (the return value entirely replaces the original tool output before sending to the Agent):

```jsonc
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "updatedToolOutput": "Compressed tool output"
  }
}
```

- `updatedToolOutput` works for **all tools** (both built-in and MCP tools).
- Typical use case: compress verbose tool output (e.g., oversized command logs, very long file contents) to save context tokens — this kind of "compression" hook relies on the replacement capability.
- Difference from `additionalContext`: `additionalContext` **appends** (the result only gets longer), while `updatedToolOutput` **replaces** (the result can get shorter).
- Both can be returned simultaneously: `updatedToolOutput` replaces first, then `additionalContext` is appended to the replaced content.
- For MCP tools, if the returned `updatedToolOutput` is an array, it is used as-is as the MCP content array; otherwise it is wrapped as a single text block.

> **Note:** The `decision: "block"` field is deprecated. Since the tool has already executed, blocking has no effect.

#### UserPromptSubmit Decision Control

```jsonc
{
  "continue": false, // Set to false to block prompt processing
  "reason": "Block reason (shown to user only)",
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "Additional context injected to CodeBuddy"
  }
}
```

> **Note:** The `decision: "block"` field is deprecated. Use `continue: false` instead.

#### Stop / SubagentStop Decision Control

```jsonc
{
  "continue": false, // Set to false to prevent stopping, Agent continues working
  "reason": "Tell the Agent why it needs to continue working"
}
```

> **Note:** The `decision: "block"` field is deprecated. Use `continue: false` instead.

#### SessionStart Decision Control

```jsonc
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "My additional context here"
  }
}
```

## Using MCP Tools

Hooks integrate seamlessly with MCP (Model Context Protocol) tools.

### MCP Tool Naming

MCP tool names follow the pattern `mcp__<server>__<tool>`, for example:

- `mcp__memory__create_entities` – `create_entities` on the Memory server
- `mcp__filesystem__read_file` – `read_file` on the Filesystem server
- `mcp__github__search_repositories` – GitHub search tool

### Configuring Hooks for MCP Tools

Target an individual tool or an entire MCP server:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__memory__.*",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Memory operation initiated' >> ~/mcp-operations.log"
          }
        ]
      },
      {
        "matcher": "mcp__.*__write.*",
        "hooks": [
          {
            "type": "command",
            "command": "python3 /home/user/scripts/validate-mcp-write.py"
          }
        ]
      }
    ]
  }
}
```

## Security Notes

### Disclaimer

**Use at your own risk.** Hooks run arbitrary shell commands on your machine. By enabling them you acknowledge:

- You are solely responsible for the commands you configure.
- Hooks can read, modify, or delete anything your user can access.
- Malicious or buggy hooks can cause data loss or system damage.
- Tencent Cloud offers no warranty and is not liable for any damages.
- Always test hooks in a safe environment before rolling them into production.

### Best Practices

1. **Validate and sanitize input** – Never trust incoming data blindly.
2. **Quote shell variables** – Use `"$VAR"`, not `$VAR`.
3. **Prevent path traversal** – Guard against `..` in file paths.
4. **Use absolute paths** – Especially for scripts (or `"$CODEBUDDY_PROJECT_DIR"`).
5. **Skip sensitive files** – Avoid touching `.env`, `.git/`, secrets, etc.

### Configuration Safety

Editing the settings file does **not** hot-load hooks. CodeBuddy Code:

1. Captures a snapshot at startup.
2. Uses that snapshot for the whole session.
3. Warns if the file changes externally.
4. Requires review in the `/hooks` panel before changes apply.

## Execution Details

- **Timeout** – 60 seconds by default; override per hook.
- **Parallelism** – All matching hooks run in parallel.
- **Deduplication** – Identical commands are coalesced.
- **Execution Shell**:
  - **macOS/Linux**: Uses the user's default shell (`$SHELL` environment variable, typically bash or zsh), falls back to `/bin/sh`.
  - **Windows**: **Git Bash is enforced** (cmd.exe and PowerShell are not supported). If Git Bash is not found, an error will prompt you to install [Git for Windows](https://git-scm.com/download/win). The `CODEBUDDY_CODE_GIT_BASH_PATH` environment variable can be used to specify the bash.exe path.
  - The default shell can be overridden via the `CODEBUDDY_CODE_SHELL` environment variable (only POSIX shells are supported: bash, zsh, sh).
- **Environment** – Runs inside the current working directory with CodeBuddy's environment.
  - `CODEBUDDY_PROJECT_DIR` exposes the absolute project root.
- **Input** – JSON over stdin.
- **Output** –
  - PreToolUse / PostToolUse / Stop / SubagentStop: progress visible in transcript mode (Ctrl+R).
  - Notification / SessionEnd: logged only when `--debug` is enabled.
  - UserPromptSubmit / SessionStart: stdout is appended to the conversation context.

## Debugging

### Basic Troubleshooting

If hooks are not firing:

1. **Check configuration** – Run `/hooks` to confirm registration.
2. **Validate JSON** – Ensure the settings file parses.
3. **Test commands** – Execute the script manually first.
4. **Verify permissions** – Scripts must be executable.
5. **Inspect logs** – Launch `codebuddy --debug` for hook traces.

**Common mistakes:**

- Unescaped quotes – Use `\"` inside JSON strings.
- Incorrect matcher – Tool names are case-sensitive.
- Command not found – Provide full paths.

### Advanced Debugging

For tricky issues:

1. **Trace execution** – `codebuddy --debug` shows hook scheduling and output.
2. **Validate schemas** – Use external tools to simulate hook input/output.
3. **Check env vars** – Confirm CodeBuddy exposes the expected environment.
4. **Test edge cases** – Try unusual paths or payloads.
5. **Monitor resources** – Ensure hooks are not exhausting CPU/RAM.
6. **Emit structured logs** – Add logging inside your scripts.

### Debug Output Example

**Note: This feature is not yet supported.**

`codebuddy --debug` prints hook execution like:

```text
[DEBUG] Executing hooks for PostToolUse:Write
[DEBUG] Getting matching hook commands for PostToolUse with query: Write
[DEBUG] Found 1 hook matchers in settings
[DEBUG] Matched 1 hooks for query "Write"
[DEBUG] Found 1 hook commands to execute
[DEBUG] Executing hook command: <Your command> with timeout 60000ms
[DEBUG] Hook command completed with status 0: <Your stdout>
```

Progress messages appear in transcript mode (Ctrl+R), showing:

- Which hook is running
- The command being executed
- Success/failure status
- Output or error messages

## Agent / Skill Frontmatter Hooks

In addition to configuring hooks globally in `~/.codebuddy/settings.json`, you can declare a `hooks` field directly in the YAML frontmatter of a custom Agent's `.md` file or a Skill's `SKILL.md`. This way, hooks are distributed together with the Agent / Skill as an "atomic unit"; the scope automatically opens and closes with the subagent lifecycle, and does not pollute the main session.

### Field Format

The `hooks` field has exactly the same structure as in `settings.json` — grouped by event name, each event containing several `{matcher?, hooks[]}` configurations. The hook `type` supports four kinds: `command` / `prompt` / `agent` / `http`:

```yaml
---
name: my-reviewer
description: Code reviewer with pre-tool-use guard
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: ./guard.sh
          once: true
  SubagentStop:
    - hooks:
        - type: command
          command: echo "reviewer finished"
        - type: http
          url: https://example.com/notify
          method: POST
---
```

### Lifecycle and Scope

- **Scope restriction**: Skills only support frontmatter hooks when `context: fork` (the injection path lacks a clear lifecycle boundary, so it is not wired in); custom Agents always support them.
- **Auto register/cleanup**: When a subagent starts, frontmatter hooks are registered into `ScopedHookRegistry`, and are automatically deregistered when the subagent exits. Hooks only take effect for that subagent's own tool calls / lifecycle events.
- **`Stop` → `SubagentStop` rewrite**: Writing a `Stop` event in the frontmatter is automatically rewritten as `SubagentStop` — the main session's `Stop` is not triggered when the subagent completes; writing `Stop` is intended to express "the subagent itself ends" semantics.
- **Merged with global hooks**: Under the same event, frontmatter hooks **stack** (do not override) with `settings.json` / plugin `hooks/hooks.json`, and all are triggered in parallel.

### Safety Gate (`allowUntrustedFrontmatterHooks`)

Frontmatter hooks can silently trigger shell commands, so **frontmatter hooks from non-builtin sources are not registered by default**:

| Source | Registered by default |
| --- | --- |
| Product-builtin Agent / Skill | ✅ Auto-allowed |
| `.codebuddy/agents/*.md` (user/project local Agent) | ❌ Denied by default |
| `.codebuddy/skills/SKILL.md` (user/project local Skill) | ❌ Denied by default |
| Agent / Skill distributed via plugin marketplace | ❌ Denied by default |
| Plugin `hooks/hooks.json` (not frontmatter) | ✅ Not subject to the gate |

To enable, set the following in `~/.codebuddy/settings.json`:

```json
{
  "allowUntrustedFrontmatterHooks": true
}
```

When blocked by the gate, the CLI emits a warning:

```
[AgentTask] Frontmatter hooks from skill 'xxx' skipped
(source not admin-trusted; enable `allowUntrustedFrontmatterHooks` in settings to allow)
```

### Fault Tolerance and Diagnostics

- **Silently drop invalid definitions**: When a single hook does not match the schema, only that entry is skipped without affecting the rest of hooks parsing; the warning includes `event 'YYY' invalid: <detailed reason>` for easy debugging.
- **Unknown event names**: Skipped with a warning (`unknown event 'XXX'`); does not invalidate the entire frontmatter.
- **Completely broken YAML**: The log emits `Malformed YAML frontmatter in '<path>'`.
- **Runtime debugging**: Launch with `CODEBUDDY_DEBUG=1` to see registration logs like `[ScopedHookRegistry] registered N hook config(s) for scope '<sessionId>' (...)`, confirming hooks are in place.

> For a complete example of using frontmatter hooks in a Skill, see [Skills documentation – Configuring Hooks in a Skill](https://www.workbuddy.ai/docs/cli/skills#configuring-hooks-in-a-skill).

---

With this guide you should have a complete understanding of how hooks work inside CodeBuddy Code and how to configure them safely. For a hands-on walkthrough, continue with the [Hooks Getting Started Guide](https://www.workbuddy.ai/docs/cli/hooks-guide).
