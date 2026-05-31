# Codex CLI Adapter Design

> Status: Draft | Date: 2026-05-31 | Author: AI Assistant | Issue: PRI-278–282

## 1. Overview

This document specifies how Principles Disciple (PD) adapts to [OpenAI Codex CLI](https://github.com/openai/codex) as a new runtime target. Codex CLI is an open-source, locally-running AI coding agent that supports a hook system for lifecycle event interception. PD will use these hooks to capture pain signals, inject principles, and gate tool calls — the same core PD loop already implemented for OpenClaw.

### 1.1 Goals

- Enable PD's core behavior internalization loop on Codex CLI
- Reuse existing `PDRuntimeAdapter` interface and `@principles/core` logic
- Provide a seamless installation experience via `create-principles-disciple`
- Maintain PD's product boundary: owner-reviewed, reversible behavior changes only

### 1.2 Non-Goals

- General task execution or memory management for Codex
- Replacing or wrapping Codex's own agent loop
- Supporting Codex Cloud / hosted mode (local-only for MVP)

## 2. Codex CLI Hook System

### 2.1 Architecture

Codex CLI provides 10 lifecycle hook events that external scripts can subscribe to:

| Event | Trigger | Can Block? | Key Capability |
|-------|---------|-----------|----------------|
| `SessionStart` | New session begins | No | Initialize state, inject context |
| `PreToolUse` | Before a tool executes | Yes (deny/ask) | Gate risky operations |
| `PermissionRequest` | Permission prompt shown | Yes (allow/deny/ask) | Override permission decisions |
| `PostToolUse` | After a tool executes | Yes (stop) | Capture errors, pain signals |
| `UserPromptSubmit` | User submits a prompt | Yes (block) | Inject additional context |
| `PreCompact` | Before context compaction | No | Save critical context |
| `PostCompact` | After context compaction | No | Restore context markers |
| `SubagentStart` | Sub-agent spawned | No | Track sub-agent lifecycle |
| `SubagentStop` | Sub-agent completes | No | Collect sub-agent results |
| `Stop` | Session ends | No | Final cleanup, telemetry |

### 2.2 Registration Mechanism

Hooks are registered in a global configuration file at `~/.codex/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/pd-codex-hook.js pre-tool-use"
          }
        ]
      }
    ]
  }
}
```

**Important limitation**: As of Codex CLI v0.1.x, plugin-local `hooks.json` is not supported ([openai/codex#16430](https://github.com/openai/codex/issues/16430)). All hooks must be registered in the global `~/.codex/hooks.json`. This means the PD installer must merge hooks into the existing global config rather than providing a per-project file.

### 2.3 Execution Model

- Hooks receive input as a single JSON object on **stdin**
- Hooks produce output as a single JSON object on **stdout**
- Exit codes: `0` = success, `2` = block (where applicable), other = error
- Hooks have a **60-second timeout** per execution
- If a hook times out, Codex proceeds as if the hook was not registered

## 3. Data Contracts

All contracts below are verified against Codex CLI source code (`codex-rs/hooks/src/`).

### 3.1 PreToolUse

**Input (stdin)**:
```json
{
  "session_id": "string",
  "turn_id": "string",
  "tool_name": "string",
  "tool_input": {}
}
```

**Output (stdout)** — one of:
```json
{"decision": "approve"}
{"decision": "block", "reason": "string"}
```

Exit code `2` also blocks the tool call.

### 3.2 PostToolUse

**Input (stdin)**:
```json
{
  "session_id": "string",
  "turn_id": "string",
  "tool_name": "string",
  "tool_input": {},
  "tool_output": "string"
}
```

**Output (stdout)** — one of:
```json
{}
{"decision": "block", "reason": "string"}
{"decision": "stop", "reason": "string"}
{"decision": "feedback", "message": "string"}
```

### 3.3 UserPromptSubmit

**Input (stdin)**:
```json
{
  "session_id": "string",
  "prompt": "string"
}
```

**Output (stdout)** — one of:
```json
{}
{"decision": "block", "reason": "string"}
{"additionalContext": "string"}
```

**Key difference from OpenClaw**: `UserPromptSubmit` can only provide `additionalContext`, not rewrite the prompt itself. PD must inject principles as supplementary context rather than prompt modification.

### 3.4 SessionStart

**Input (stdin)**:
```json
{
  "session_id": "string",
  "source": "string"
}
```

**Output (stdout)**:
```json
{}
```

No blocking capability. Used for initialization only.

## 4. PD ↔ Codex Mapping

### 4.1 Hook-to-PD Mapping

| PD Function | Codex Hook | OpenClaw Equivalent |
|-------------|-----------|-------------------|
| Principle injection | `UserPromptSubmit` | `before_prompt_build` |
| Tool call gating | `PreToolUse` | `before_tool_call` |
| Pain signal capture | `PostToolUse` | `after_tool_call` |
| Session initialization | `SessionStart` | Plugin `setup()` |
| Context preservation | `PreCompact` / `PostCompact` | N/A (new) |

### 4.2 Key Differences from OpenClaw

| Aspect | OpenClaw | Codex CLI |
|--------|----------|-----------|
| Prompt modification | Full rewrite possible | `additionalContext` only |
| Tool gating | `approve` / `block` | `approve` / `block` / `ask` |
| Permission override | N/A | `PermissionRequest` hook |
| Post-tool blocking | Not supported | `block` / `stop` / `feedback` |
| Session tracking | Plugin state | `session_id` + `turn_id` |
| Hook registration | Plugin manifest | Global `~/.codex/hooks.json` |
| Hook protocol | Direct function call | stdin/stdout JSON + exit codes |
| Timeout | Configurable | 60s hard limit |

### 4.3 PDRuntimeAdapter Implementation

The existing `PDRuntimeAdapter` interface in `@principles/core` already defines `codex-cli` as a valid `RuntimeKind`. The adapter implementation will:

1. **`kind()`** → returns `'codex-cli'`
2. **`getCapabilities()`** → returns capabilities reflecting Codex's constraints (e.g., `supportsStructuredJsonOutput: true`, `supportsToolUse: true`)
3. **`startRun()`** → creates a Codex session context, initializes PD state for the session
4. **`pollRun()`** → reads session state from the PD state directory
5. **`appendContext()`** → queues additional context for the next `UserPromptSubmit` hook invocation

## 5. Architecture Design

### 5.1 Package Structure

```
packages/
├── principles-core/          # Existing: PDRuntimeAdapter, types, pure logic
│   └── src/runtime-v2/adapter/
│       └── codex-cli-runtime-adapter.ts   # NEW: Codex adapter implementation
├── openclaw-plugin/          # Existing: OpenClaw integration
├── pd-cli/                   # Existing: CLI tool
└── codex-hooks/              # NEW: Hook scripts for Codex CLI
    ├── package.json          # @principles/codex-hooks
    ├── src/
    │   ├── index.ts          # Hook entry point (dispatches by event type)
    │   ├── pre-tool-use.ts   # PreToolUse handler
    │   ├── post-tool-use.ts  # PostToolUse handler
    │   ├── user-prompt-submit.ts  # UserPromptSubmit handler
    │   ├── session-start.ts  # SessionStart handler
    │   └── lib/
    │       ├── stdin.ts      # stdin JSON reader
    │       ├── stdout.ts     # stdout JSON writer
    │       └── state.ts      # PD state directory access
    └── tsconfig.json
```

### 5.2 Hook Script Architecture

Each Codex hook invocation is a separate process. The hook script:

1. Reads JSON input from stdin
2. Loads PD state from `{workspace}/.principles/` (SQLite)
3. Delegates to `@principles/core` logic for the relevant operation
4. Writes JSON output to stdout
5. Exits with appropriate code (0, 2, or error)

```
Codex CLI → fork → node pd-codex-hook.js <event>
                         ↓
                    read stdin (JSON)
                         ↓
                    load PD state (SQLite)
                         ↓
                    delegate to @principles/core
                         ↓
                    write stdout (JSON)
                         ↓
                    exit 0 | 2 | 1
```

### 5.3 State Management

PD state for Codex sessions is stored in the same per-workspace structure:

```
{workspace}/
├── .principles/
│   ├── principles.db          # SQLite (shared with OpenClaw)
│   ├── .state/                # Runtime state
│   │   └── codex-sessions/    # NEW: Codex session tracking
│   │       └── {session_id}.json
│   └── ...
```

The `codex-sessions/` directory tracks:
- Active session IDs and their start times
- Pending context injections for the next `UserPromptSubmit`
- Turn-level pain signal aggregation

### 5.4 Installer Integration

The `create-principles-disciple` installer will be extended to support Codex:

```
? Which runtime are you installing for?
  ❯ OpenClaw
    Codex CLI
    Both
```

For Codex CLI installation:
1. Build and bundle `@principles/codex-hooks` into the installer's `core/` directory
2. Merge hook entries into `~/.codex/hooks.json` (preserving existing hooks)
3. Initialize `.principles/` state directory in the workspace
4. Seed core principles

### 5.5 Principle Injection Strategy

Since Codex's `UserPromptSubmit` only supports `additionalContext` (not prompt rewriting), PD will:

1. **Format principles as structured context comments**:
   ```
   <!-- PD Principles Active -->
   - P-01: Never commit directly to main (enforced)
   - P-05: Validate all external inputs (enforced)
   <!-- End PD Principles -->
   ```

2. **Include pain signal context** when relevant:
   ```
   <!-- PD Pain Signal -->
   Recent pattern: 3x "committed to main" violations in last session
   <!-- End PD Pain Signal -->
   ```

3. **Use `PreCompact` to preserve principle markers** so they survive context compaction.

## 6. Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Global hooks.json conflict with other tools | Medium | Medium | Merge strategy: append PD hooks, never remove existing entries |
| 60s hook timeout insufficient for complex queries | Low | High | Keep hook logic minimal; delegate heavy work to background |
| Codex hook API changes in future versions | Medium | High | Pin Codex CLI version; add API version check in SessionStart |
| stdin/stdout protocol fragility | Low | Medium | Strict JSON schema validation; fail-safe defaults |
| Plugin-local hooks.json not available | High | Low | Document global registration; provide install/uninstall scripts |

## 7. Implementation Phases

### Phase 1: Core Adapter (PRI-278)
- Implement `CodexCliRuntimeAdapter` in `@principles/core`
- Add Codex-specific capability definitions
- Unit tests with test-double runtime

### Phase 2: Hook Scripts (PRI-279)
- Create `@principles/codex-hooks` package
- Implement `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart` handlers
- stdin/stdout protocol layer with schema validation

### Phase 3: Installer Integration (PRI-280)
- Extend `create-principles-disciple` for Codex CLI
- Implement `~/.codex/hooks.json` merge logic
- Add Codex-specific installation flow

### Phase 4: Principle Injection (PRI-281)
- Implement `additionalContext`-based principle injection
- `PreCompact`/`PostCompact` context preservation
- Integration tests with mock Codex sessions

### Phase 5: E2E Validation (PRI-282)
- Live test against real Codex CLI
- Pain signal capture → principle internalization loop
- Documentation and getting-started guide

## 8. Open Questions

1. **Codex CLI version pinning**: Should PD require a minimum Codex CLI version? How to detect and communicate incompatibility?
2. **Multi-workspace hooks**: Global `hooks.json` means all workspaces share the same hooks. How to disambiguate which workspace a session belongs to?
3. **Hook script distribution**: Should `@principles/codex-hooks` be published to npm, or bundled into the installer only?
4. **PermissionRequest hook**: Should PD override Codex's permission prompts? What's the UX for owner review?
5. **Sub-agent tracking**: Should PD track sub-agent sessions separately, or treat them as part of the parent session?

---

*This design is informed by direct source code analysis of Codex CLI v0.1.x (`codex-rs/hooks/src/`). All data contracts are verified against `schema.rs`, `events/*.rs`, and `engine/output_parser.rs`.*
