# Codex CLI Adapter SPEC & Multi-Platform Host Abstraction

> Status: SPEC v4.1 (supersedes v4, v3, v2, v1, and draft `CODEX_CLI_ADAPTER_DESIGN.md`) | Date: 2026-08-11 (verified against Codex source `codex-rs/` commit at HEAD) | Issues: PRI-278, PRI-279 (deferred to Post-MVP), PRI-280, PRI-281, PRI-282
>
> ⚠️ **RETIRED CONTENT NOTICE (2026-08-19)**: This spec predates PRI-286. The hardcoded confirm-first / PLAN.md gate it repeatedly references was REMOVED from PD on 2026-06-01 (PRI-286, PR #764); the sole authoritative gate is the dynamic RuleHost (owner-approved `code_tool_hook` activations), on both OpenClaw and Codex hosts. Read every "confirm-first gate" mention below as a historical mechanism, not a current capability. The Codex host abstraction itself (ADR-0020) remains current.
>
> **Changelog v4.1**: Corrected 3 serious errors introduced in v4 (found by second external review):
> - **E1**: v4 claimed `continue: false` "terminates the entire Codex session." **Wrong.** Source verification: PostToolUse `PostToolUseOutcome` has NO `should_stop` field (post_tool_use.rs:40-45) — `continue: false` only sets `status = Stopped` with no session/turn effect. UserPromptSubmit/SessionStart set `should_stop = true` which rejects the current input and stops the current turn, but the session survives (test `continue_false_preserves_context_for_later_turns`). PreToolUse/PermissionRequest reject `continue: false` as `unsupported` → `invalid_reason`.
> - **E2**: v4 §5.3.1 said `permissionDecision: "ask"` is "treated like `allow`, only rejected when combined with `updatedInput`." **Wrong.** `ask` UNCONDITIONALLY produces `invalid_reason` (output_parser.rs:445-447). No conditional.
> - **E3**: v4 labeled `ask`/`invalid_reason` as "fail-closed." **Wrong — it is fail-OPEN.** When `invalid_reason` is set, `should_block` stays `false` (pre_tool_use.rs:235-240), so `hook_runtime.rs:204` returns `Continue` — the dangerous tool call PROCEEDS. This is a critical safety concern for PD's confirm-first gate: a codec bug sending `ask` would silently let dangerous tools through.
> - Also fixed: `suppressOutput` not implemented in most events (explicitly `let _ =` ignored in UserPromptSubmit/SessionStart/Stop/Compact; generates `invalid_reason` in PreToolUse/PermissionRequest/PostToolUse); slash command count 16→19; version pinning ≥0.118→≥0.124; `async: true` efficacy hedged; timeout degradation visible in /hooks TUI (not silent).
> - Also fixed 3 internal inconsistencies (found by third external review): (1) §3 table "session_id + turn_id on every hook" contradicted §5.3.4 (SessionStart lacks `turn_id`) — corrected to note the exception; (2) §5.2 package layout had stale v2-era comment `# matcher: "Bash" (ONLY Bash fires)` — corrected to `matcher: "Bash|apply_patch"` per §2.6; (3) §3 "Failure visibility" said "Codex swallows timeout/errors silently" — contradicted by §2.7 which says `/hooks` TUI shows Failed status — corrected to align.
> - **ADR-0020 Accepted** (2026-08-11): ADR-0020 (`docs/adr/0020-codex-cli-host-adapter.md`) promoted from Proposed to Accepted. Added Decision §2.3: `HostInstaller` abstraction in `create-principles-disciple` with `HostTarget = 'openclaw' | 'codex'` — each host gets a concrete installer (`OpenClawHostInstaller`, `CodexHostInstaller`). `host.codex` feature flag registered in `DEFAULT_FEATURE_FLAGS` (quiet, default off, since 2026-08-11). Verified by `feature-flag-contract.test.ts` (63 tests pass) + `architecture-regression.test.ts` (516 tests pass) + core build + lint.
>
> **Changelog v4**: Corrected 3 P0 factual errors + 4 P1 architecture/scope conflicts found by external review (wesley's AI assistant, 2026-08-11):
> - **P0-1**: v3 claimed "`Write`/`Edit` matcher aliases only work in PermissionRequest, not PreToolUse." **Completely wrong** — `apply_patch` has its own `pre_tool_use_payload` (apply_patch.rs:459-463) using `HookToolName::apply_patch()` with aliases; dispatcher uses `any()` matching on canonical+aliases (dispatcher.rs:61-63); test `pre_tool_use_aliases_match_once_per_handler` (dispatcher.rs:432-475) proves it. Aliases work in ALL matcher-aware events.
> - **P0-2**: v3 missed **Universal Output fields** (`continue`, `stopReason`, `suppressOutput`, `systemMessage` — `HookUniversalOutputWire` in schema.rs:88-97). PD codec MUST hardcode `continue: true`. *(v4.1 correction: `continue: false` does NOT terminate the session — see E1 above.)* Also corrected `permissionDecision: "ask"` semantics. *(v4.1 correction: `ask` is unconditional, not conditional — see E2 above.)*
> - **P0-3**: SessionStart input **lacks `turn_id`** (verified from `SessionStartCommandInput` in schema.rs:486-497, unlike PreToolUse/PostToolUse/UserPromptSubmit). PD normalizer must set `turnId = undefined`.
> - **P1-1**: PRI-279 (Outbound CodexCliRuntimeAdapter) deferred to Post-MVP — does not pass `mvp-q-1-what-if-skip` (inbound hooks cover all three MVP-Core activation paths).
> - **P1-2**: OpenClaw shadow-mode refactor deferred to Post-MVP — eliminates the largest regression risk on the only production-stable activation path.
> - **P1-4**: §11 value-maximization strategies moved to `docs/plans/post-mvp-conditional-roadmap.md` §18.
> - **P2-1~5**: Added `deny_unknown_fields` constraint (§5.4), `additionalContextLimit` / `commandWindows` / `async` in hooks.json (§5.7), `updatedMCPToolOutput` awareness (§5.3.2).
> - **P3-1/2/3/6**: Adopted single `pd-hook.js` entry + event routing, `async: true` for PostToolUse, single matcher group `"Bash|apply_patch"`, Codex-generated JSON Schema fixtures for contract tests.
>
> **Changelog v3**: Corrected 5 critical errors from v2 found by source-code re-verification: (1) `plugin_hooks` is `Stage::Removed` (no-op), not "default OFF" — plugin-bundled hooks work without any flag; (2) PreToolUse **does fire for `apply_patch`** — `HookToolName::apply_patch()` exists in `hook_names.rs`, `function_hook_tool_name` generates `apply_patch` tool names, `hook_runtime.rs:214` explicitly handles it; (3) the "openai/codex#26733" reference was a hallucination — no such limitation exists; (4) `toolGatingScope` for Codex is `all-tools`, not `bash-only`; (5) the "file edit gating gap" (§5.3.6) does not exist — file edits CAN be gated via `matcher: "apply_patch"`.
>
> **Changelog v2**: Corrected 15 factual errors from v1 (hook count, field casing, #16430 status, PreToolUse tool coverage, PostToolUse decision shape, timeout field name, hook trust mechanism, apply_patch gap). Added design self-evaluation findings.
>
> This document is the authoritative SPEC for:
> 1. Making PD support OpenAI Codex CLI as a host platform (alongside OpenClaw).
> 2. A multi-platform **Host Abstraction Layer** that lets PD later adapt to Claude Code, OpenCode, Pi, and other agent hosts with minimal per-host code.
>
> Audience: PD maintainers, adapter implementers, installer authors.
> Product boundary still applies (see `docs/product/PRODUCT_IDENTITY.md`): PD owns owner-reviewed, reversible behavior internalization — not general task execution or general memory.

---

## 0. TL;DR

PD currently runs as an OpenClaw plugin (in-process function calls via `api.on('before_tool_call', ...)`). Codex CLI does **not** load JS plugins — it spawns standalone hook scripts that read JSON on stdin and write JSON on stdout with exit-code semantics. To support Codex (and later Claude Code, OpenCode, Pi), PD adds a **Host Abstraction Layer** with two orthogonal contracts:

- **`HostAdapter`** (inbound): host platform calls PD hooks. OpenClaw = in-process `api.on`; Codex = stdin/stdout JSON subprocess. The adapter normalizes both into a unified **HostEvent** stream.
- **`PDRuntimeAdapter`** (outbound): PD drives an external runtime to execute internalization tasks. Already exists (`runtime-protocol.ts`), already lists `codex-cli`.

The Codex adapter is delivered as a new package `packages/codex-adapter/` exposing four hook entrypoints (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`). The installer (`create-principles-disciple`) gains a `--codex` flag that registers PD hooks either as a **Codex plugin** (`hooks/hooks.json`, preferred — plugin-bundled hooks are always supported, no flag needed) or in **global `~/.codex/hooks.json`** (fallback).

**Critical Codex constraints (verified 2026-08-11 against `codex-rs/` source)**:
- PreToolUse fires for **all function tools** including `Bash`, `apply_patch` (file edits), `spawn_agent`, and MCP tools. The `HookToolName::apply_patch()` constructor in `hook_names.rs` and `function_hook_tool_name()` in `registry.rs` confirm this. File edits **can** be gated via `matcher: "apply_patch"`.
- Hooks are **enabled by default** (`[features].hooks = true`, `Stage::Stable`).
- `plugin_hooks` is a **Removed no-op** (`Stage::Removed` in `features/src/lib.rs:1235-1238`) — plugin-bundled hooks work without any flag. Old configs with `plugin_hooks = true` still parse but the flag does nothing.
- Non-managed hooks require **owner review + trust** via `/hooks` TUI before they execute (`HookTrustStatus` in `discovery.rs:696-706`).
- stdout output uses **camelCase**; stdin input uses **snake_case** (asymmetric — see §5.3).

---

## 1. Background & Goals

### 1.1 Goals

1. Enable PD's three MVP-Core activation paths (prompt injection, pain-signal capture, confirm-first gate) on Codex CLI.
2. Introduce a **Host Abstraction Layer** so adding a new agent host is a bounded, well-defined effort (one adapter implementation + manifest), not a re-architect.
3. Preserve the existing OpenClaw path with **zero behavioral regression**.
4. Keep the product boundary: no general task execution, no general memory, no autonomous value decisions.

### 1.2 Non-Goals

- Replacing or wrapping Codex's own agent loop.
- Supporting Codex Cloud / hosted mode (local-only for MVP).
- Auto-approving Codex permissions silently.
- Building a universal "agent plugin SDK" — the abstraction is PD-internal, not a public standard.
- Expanding MVP-Core scope. Codex adapter ships behind a feature flag (`host.codex`) registered in `.pd/config.yaml`.

### 1.3 MVP Questions (per `AGENTS.md`)

| ID | Question | Answer for Codex support |
|----|----------|--------------------------|
| `mvp-q-1-what-if-skip` | What if we skip? | Codex is a major OSS agent host. Without it, PD only serves OpenClaw users. Owners using Codex would not get pain-signal capture or principle injection. Will resurface within 30 days as soon as an owner tries Codex + PD. |
| `mvp-q-2-how-observed` | How observed? | `pd health --host codex` reports adapter + hooks registration + trust status; `pd pain list` shows pains captured from Codex sessions (`source: 'codex:post_tool_use'`); `pd context trace` shows injected additionalContext. |
| `mvp-q-3-how-disabled` | How disabled? | `host.codex.enabled: false` in `.pd/config.yaml` (default ON after install, OFF before install). Hook scripts short-circuit and emit `{}`. Installer `--uninstall-codex` removes hook entries. |
| `mvp-q-4-emotional-value` | Emotional value? | Reduces **失控感** (Codex mutates files via Bash/apply_patch without PD gates today) and **重复纠正感** (owner keeps correcting the same Codex behavior across sessions). Creates **掌控感** (confirm-first gate blocks risky Bash commands like `git push` AND file edits to protected paths) and **沉淀感** (principles persist across Codex sessions). |

---

## 2. Codex Plugin Development: Verified Best Practices

### 2.1 What "Codex plugin" means (verified 2026-08-11)

Codex CLI does **not** have a JS-plugin loader like OpenClaw. "Plugin" in the Codex ecosystem means one of:

1. **Hooks** — standalone executables registered in `hooks.json` that receive JSON on stdin and emit JSON on stdout. This is the primary extension surface PD uses.
2. **MCP servers** — Model Context Protocol servers registered in `~/.codex/config.toml` under `[mcp_servers.<name>]`. Codex calls them as tools. PD does **not** expose itself as an MCP server in MVP.
3. **Plugin bundles** — a packaged directory (`plugin.json` manifest + `hooks/hooks.json` + skills + MCP config). **Always supported** — the `PluginHooks` feature flag was removed (`Stage::Removed` in `features/src/lib.rs:1235-1238`); plugin-bundled hooks are discovered without any flag via `discovery.rs::append_plugin_hook_sources()`.
4. **AGENTS.md / prompt files** — static context files Codex reads on session start. Complementary, not a replacement for hooks.

### 2.2 Hook event surface (verified against `codex-rs/hooks/src/lib.rs:19`)

Codex defines **11** lifecycle hook events (`HOOK_EVENT_NAMES`):

| # | Event | Has matcher? | Can block? | PD subscribes? |
|---|-------|-------------|------------|----------------|
| 1 | `PreToolUse` | yes (tool_name regex) | yes (`decision: block` / `permissionDecision: deny` / exit 2) | **yes** (Bash-only gate) |
| 2 | `PermissionRequest` | yes (tool_name regex) | yes (`decision.behavior: allow\|deny`) | deferred (post-MVP) |
| 3 | `PostToolUse` | yes (tool_name regex) | yes (`decision: block` + reason) | **yes** (pain capture) |
| 4 | `PreCompact` | yes (trigger regex) | observe-only | deferred |
| 5 | `PostCompact` | yes (trigger regex) | observe-only | deferred |
| 6 | `SessionStart` | yes (source regex) | can stop turn (via `continue: false`, but session survives) | **yes** (state hydration) |
| 7 | `SessionEnd` | yes (reason regex) | observe-only | deferred |
| 8 | `UserPromptSubmit` | no | yes (`decision: block` + reason) | **yes** (prompt injection) |
| 9 | `SubagentStart` | yes (agent_type regex) | observe-only | deferred |
| 10 | `SubagentStop` | yes (agent_type regex) | yes (`decision: block`) | deferred |
| 11 | `Stop` | no | yes (`decision: block` + reason) | deferred |

`HOOK_EVENT_NAMES_WITH_MATCHERS` (9 events) — all except `UserPromptSubmit` and `Stop` have meaningful matchers.

### 2.3 Registration mechanism (verified against `discovery.rs`)

Codex discovers hooks from multiple **config layers** (all loaded, not replaced):

- `~/.codex/hooks.json` (user global)
- `~/.codex/config.toml` (user global, inline `[hooks]` tables)
- `<repo>/.codex/hooks.json` (project-local; **requires project trust**)
- `<repo>/.codex/config.toml` (project-local; requires trust)
- **Plugin-bundled** `hooks/hooks.json` (always supported — no flag needed; `plugin_hooks` is `Stage::Removed` no-op)

**Plugin-local vs global**: plugin-bundled hooks work without any feature flag. PD should prefer plugin packaging when available, with global `~/.codex/hooks.json` as fallback for owners who prefer simpler setups.

### 2.4 Feature flags (verified against `features/src/lib.rs`)

| Flag | Stage | Default | Purpose |
|------|-------|---------|---------|
| `hooks` | `Stable` | **ON** | Master switch for all hooks. Canonical key (`Feature::CodexHooks`). |
| `codex_hooks` | legacy alias | — | Deprecated alias for `hooks`; still parses, maps to `CodexHooks`. |
| `plugin_hooks` | `Removed` | no-op | **Removed compatibility flag** — plugin-bundled hooks always work. Old configs with `plugin_hooks = true` still parse but the flag does nothing (`features/src/lib.rs:1235-1238`). |

### 2.5 Hook trust mechanism (verified — CRITICAL, was missing from v1)

Non-managed hooks (user/project/plugin) **must be reviewed and trusted** before they execute:

- Codex records trust on the hook's **content hash**. Modified hooks re-enter "needs review" state.
- Owner uses `/hooks` TUI command to review, trust, or disable hooks.
- `--dangerously-bypass-hook-trust` CLI flag skips trust for one session (dev only).
- Managed hooks (system/MDM/cloud/`requirements.toml`) are trusted by policy.

**Impact on PD**: The installer must tell the owner to open `/hooks` and trust PD hooks after install. PD hooks will **not** execute until trusted.

### 2.6 PreToolUse tool coverage (re-verified v4 — CRITICAL correction from v3)

**PreToolUse fires for ALL function tools**, including `Bash`, `apply_patch` (file edits), `spawn_agent`, and MCP tools.

**Matcher aliases work in ALL matcher-aware events** (v4 correction — v3 incorrectly claimed aliases only worked in PermissionRequest):

- `core/src/tools/hook_names.rs:34-39` — `HookToolName::apply_patch()` constructor includes `Write`/`Edit` as `matcher_aliases`:
  ```rust
  pub(crate) fn apply_patch() -> Self {
      Self {
          name: "apply_patch".to_string(),
          matcher_aliases: vec!["Write".to_string(), "Edit".to_string()],
      }
  }
  ```
- `core/src/tools/handlers/apply_patch.rs:459-463` — `apply_patch` has its **own** `pre_tool_use_payload` that directly uses `HookToolName::apply_patch()` (with aliases), bypassing `function_hook_tool_name()`.
- `hooks/src/events/common.rs:152-161` — `matcher_inputs()` chains the canonical name **and** aliases together as `Vec<&str>`.
- `hooks/src/engine/dispatcher.rs:49-63` — PreToolUse is in the matcher-aware event list; uses `any()` matching: if ANY `matcher_input` matches, the handler runs.
- `hooks/src/engine/dispatcher.rs:432-475` — test `pre_tool_use_aliases_match_once_per_handler` explicitly proves `^Write$` and `^Edit$` matchers match `apply_patch` in PreToolUse path.

**v3 error root cause**: v3 traced `function_hook_tool_name()` for general function tools and saw it uses `HookToolName::new(...)` without aliases. But `apply_patch` has its own `pre_tool_use_payload` implementation that bypasses `function_hook_tool_name()` and directly uses `HookToolName::apply_patch()` with aliases.

**Matcher behavior** (v4 verified):
- `tool_name` serialized to hook stdin is the **canonical** name (e.g., `"apply_patch"`, `"Bash"`).
- `Write` and `Edit` are **matcher aliases** that match `apply_patch` tool calls in **ALL matcher-aware events** (PreToolUse, PermissionRequest, PostToolUse, etc.).
- `matcher: "Bash"`, `matcher: "apply_patch"`, `matcher: "Write"`, `matcher: "Edit"` — **all valid** in PreToolUse.
- Single matcher group `matcher: "Bash|apply_patch"` or `matcher: "Bash|Write|Edit"` — also valid.

**Impact on PD confirm-first gate**: The gate CAN block both shell commands (`Bash`) and file edits (`apply_patch`). PD can use a single matcher group `matcher: "Bash|apply_patch"` or separate groups — both work.

### 2.7 Execution model (verified)

- Hooks receive input as a single JSON object on **stdin** (snake_case fields).
- Hooks produce output as a single JSON object on **stdout** (**camelCase** fields — asymmetric with input!).
- Exit codes: `0` = success, `2` = block (where event supports blocking), other = error.
- Hooks run with session `cwd` as working directory.
- `timeout` field in `hooks.json` (in seconds; default 600s if omitted; `SessionEnd` capped at 3s, default 1s).
- If a hook times out, Codex proceeds as if the hook returned empty output — **degradation visible in `/hooks` TUI as Failed status** (v4.1 correction: not fully silent), so PD hooks MUST emit observability before timeout AND PD's `pd health --host codex` should check for Failed entries.
- Multiple matching hooks for the same event run **concurrently** — one hook cannot prevent another from starting.

---

## 3. Codex vs OpenClaw: Side-by-Side

| Dimension | OpenClaw | Codex CLI |
|-----------|----------|-----------|
| **Activation model** | Plugin manifest (`openclaw.plugin.json`) loaded by host | Codex plugin bundle (`hooks/hooks.json`) OR global `~/.codex/hooks.json` |
| **Invocation** | In-process: `api.on(event, handler)` direct function call | Subprocess: Codex spawns `node pd-hook.js <event>` per invocation |
| **I/O protocol** | TS objects passed by reference | stdin JSON (snake_case) in, stdout JSON (**camelCase**) out, exit code signals block/error |
| **Field casing** | camelCase everywhere | **Asymmetric**: input=snake_case, output=camelCase |
| **Prompt modification** | Full rewrite via `before_prompt_build` result | `UserPromptSubmit` can **only** append `additionalContext` |
| **Tool gating** | `before_tool_call` returns `skipToolCall: true` | `PreToolUse` returns `decision: "block"` + exit 0; fires for all function tools (Bash, apply_patch, MCP, etc.) |
| **File edit gating** | `before_tool_call` intercepts all tools | **Supported** via `matcher: "apply_patch"` — `HookToolName::apply_patch()` in `hook_names.rs` confirms PreToolUse fires for file edits |
| **Permission override** | N/A | `PermissionRequest` hook (deferred in MVP) |
| **Post-tool blocking** | Not supported (observe-only) | `PostToolUse` can `decision: "block"` (requires non-empty reason) |
| **Tool response shape** | `result: unknown` (often string) | `tool_response` is `serde_json::Value` (arbitrary JSON) |
| **Session identity** | `sessionId` + `agentId` from host context | `session_id` + `turn_id` on most hooks (⚠️ `SessionStart` lacks `turn_id` — see §5.3.4) |
| **Session lifecycle** | Plugin `setup()` / implicit | Explicit `SessionStart` with `source: startup\|resume\|clear\|compact` |
| **Subagent tracking** | `subagent.run` + `SubagentEnded` event | `SubagentStart` + `SubagentStop` hooks |
| **Context compaction** | `before_compaction` / `after_compaction` | `PreCompact` / `PostCompact` (matcher on `trigger: manual\|auto`) |
| **Timeout** | Configurable per hook | `timeout` sec per hook entry; default 600s; `SessionEnd` capped 3s |
| **Trust** | Implicit (plugin loaded = trusted) | **Explicit**: non-managed hooks need owner review + trust via `/hooks` TUI |
| **Feature flag** | N/A | `hooks` (default ON, `Stable`); `plugin_hooks` (`Removed` no-op — plugin hooks always work) |
| **Config location** | Per-workspace plugin install | Plugin bundle OR global `~/.codex/hooks.json` (both supported) |
| **Failure visibility** | PD logger + host logger | PD `SystemLogger` + Codex `/hooks` TUI shows Failed status (v4.1: timeout/errors visible, not silent) |

---

## 4. Host Abstraction Layer Design

### 4.1 Two orthogonal contracts (do not conflate)

```
┌─────────────────────────────────────────────────────────────────────┐
│  OUTBOUND: PD drives an external runtime to run internalization     │
│  tasks (diagnostician, dreamer, evaluator, etc.)                    │
│                                                                     │
│  Contract: PDRuntimeAdapter (ALREADY EXISTS in runtime-protocol.ts) │
│  Implementations: OpenClawCliRuntimeAdapter, PiAiRuntimeAdapter,    │
│                  TestDoubleRuntimeAdapter, CodexCliRuntimeAdapter    │
│                  (PRI-279)                                          │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  INBOUND: A host platform invokes PD hooks during the host's own    │
│  agent loop (prompt building, tool gating, pain capture)            │
│                                                                     │
│  Contract: HostAdapter (NEW, this SPEC)                             │
│  Implementations: OpenClawHostAdapter (refactor of existing hook    │
│                  registration), CodexHooksHostAdapter (PRI-280),   │
│                  ClaudeCodeHooksHostAdapter (future), etc.          │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 `HostAdapter` contract

```typescript
// packages/principles-core/src/host/host-adapter.ts (NEW)

import { Type, type Static } from '@sinclair/typebox';

export const HostKindSchema = Type.Union([
  Type.Literal('openclaw-plugin'),
  Type.Literal('codex-hooks'),
  Type.Literal('claude-code-hooks'),
  Type.Literal('opencode-hooks'),
  Type.Literal('pi-embedded'),
]);
export type HostKind = Static<typeof HostKindSchema>;

export const HostEventKindSchema = Type.Union([
  Type.Literal('session.start'),
  Type.Literal('session.end'),
  Type.Literal('prompt.submit'),
  Type.Literal('tool.pre'),
  Type.Literal('tool.post'),
  Type.Literal('compact.pre'),
  Type.Literal('compact.post'),
  Type.Literal('subagent.start'),
  Type.Literal('subagent.stop'),
]);
export type HostEventKind = Static<typeof HostEventKindSchema>;

export const HostEventSchema = Type.Object({
  kind: HostEventKindSchema,
  sessionId: Type.String(),
  turnId: Type.Optional(Type.String()),
  workspaceDir: Type.String(),
  agentId: Type.Optional(Type.String()),
  agentType: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  permissionMode: Type.Optional(Type.String()),
  transcriptPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  payload: Type.Unknown(),
  source: HostKindSchema,
});
export type HostEvent = Static<typeof HostEventSchema>;

export const HostEventResultSchema = Type.Object({
  proceed: Type.Boolean(),
  reason: Type.Optional(Type.String()),
  additionalContext: Type.Optional(Type.String()),
  nativeOverride: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type HostEventResult = Static<typeof HostEventResultSchema>;

export const HostCapabilitiesSchema = Type.Object({
  canBlockToolUse: Type.Boolean(),
  canBlockPostTool: Type.Boolean(),
  canRewritePrompt: Type.Boolean(),
  canAppendContext: Type.Boolean(),
  canOverridePermission: Type.Boolean(),
  providesTurnId: Type.Boolean(),
  providesSubagentEvents: Type.Boolean(),
  providesCompactEvents: Type.Boolean(),
  hookTimeoutMaxSec: Type.Integer(),
  invocationModel: Type.Union([
    Type.Literal('in-process'),
    Type.Literal('subprocess'),
  ]),
  // Install-time capabilities (NEW in v2, corrected v3)
  requiresHookTrust: Type.Boolean(),        // Codex yes, OpenClaw no
  supportsPluginBundling: Type.Boolean(),   // Codex yes (always, no flag), OpenClaw n/a
  toolGatingScope: Type.Union([             // What tools can PreToolUse intercept?
    Type.Literal('all-tools'),               // OpenClaw AND Codex (all function tools)
    Type.Literal('none'),                    // hosts without PreToolUse
  ]),
});
export type HostCapabilities = Static<typeof HostCapabilitiesSchema>;

export interface HostEventHandler {
  handle(event: HostEvent): Promise<HostEventResult | void>;
}

export interface HostAdapter {
  kind(): HostKind;
  capabilities(): HostCapabilities;
  on(eventKind: HostEventKind, handler: HostEventHandler): void;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  health(): Promise<{ healthy: boolean; degraded: boolean; warnings: string[] }>;
}
```

### 4.3 Why this shape (self-evaluation notes)

- **`toolGatingScope`** (corrected v3): Codex's PreToolUse fires for all function tools (Bash, apply_patch, MCP, etc.), so its value is `all-tools` — same as OpenClaw. The v2 `bash-only` value was based on a hallucinated issue reference. PD business logic can gate any function tool on both hosts.
- **`requiresHookTrust`**: installer checks this to know whether to prompt owner for `/hooks` trust. Codex = yes, OpenClaw = no.
- **`nativeOverride`**: constrained to `Record<string, unknown>` (v1 had `unknown` — too loose). Host adapter validates its own native shape.
- **`invocationModel`**: `subprocess` adapters must rehydrate state per call; `in-process` adapters may cache.

### 4.4 OpenClaw refactor: deferred to Post-MVP (v4 scope reduction)

**v4 change**: v3 planned to refactor OpenClaw into `OpenClawHostAdapter` with shadow mode in MVP. External review (P1-2) correctly identified this as high-risk: OpenClaw is PD's only stable production path, and introducing a new indirection layer + shadow comparison creates regression risk with no MVP benefit.

**v4 decision**: 
- MVP: `HostAdapter` interface defined in `@principles/core` (pure types only — no I/O). Only `codex-adapter` implements it. OpenClaw path stays **unchanged**.
- Post-MVP: Unify OpenClaw to also use `HostAdapter` (shadow mode → flip).
- This eliminates Phase 1 (shadow mode) from the implementation plan.

---

## 5. Codex Adapter SPEC

### 5.1 Scope (per Linear PRI-278–282)

| Issue | Scope | Deliverable |
|-------|-------|-------------|
| PRI-278 | ADR + hook surface mapping | This SPEC + ADR-0020 (Section 9) |
| PRI-279 | `CodexCliRuntimeAdapter` (outbound) | `packages/principles-core/src/runtime-v2/adapter/codex-cli-runtime-adapter.ts` |
| PRI-280 | Codex hook scripts (inbound + 4 scripts) | `packages/codex-adapter/` (new package) |
| PRI-281 | Installer `--codex` flag + hooks registration | Extension of `create-principles-disciple` |
| PRI-282 | E2E validation with real Codex session | Test plan + runbook |

### 5.2 Package layout

```
packages/
├── principles-core/                          # EXISTING
│   └── src/
│       ├── host/                             # NEW (Section 4)
│       │   ├── host-adapter.ts
│       │   ├── host-event-normalizer.ts
│       │   └── __tests__/host-adapter.test.ts
│       └── runtime-v2/adapter/
│           └── codex-cli-runtime-adapter.ts   # NEW (PRI-279, outbound)
│
├── codex-adapter/                            # NEW PACKAGE (PRI-280, inbound)
│   ├── package.json                          # @principles/codex-adapter
│   ├── plugin.json                           # Codex plugin manifest (for plugin-bundle install path)
│   ├── hooks/hooks.json                      # Plugin-bundled hooks (now supported)
│   ├── src/
│   │   ├── index.ts
│   │   ├── codex-hooks-host-adapter.ts
│   │   ├── hooks/
│   │   │   ├── pre-tool-use.ts               # matcher: "Bash|apply_patch" (single group; see §2.6)
│   │   │   ├── post-tool-use.ts              # matcher: ".*" (observe all)
│   │   │   ├── user-prompt-submit.ts
│   │   │   └── session-start.ts
│   │   ├── io/
│   │   │   ├── stdin.ts                       # readJsonSafe(): unknown (rc-1)
│   │   │   ├── stdout.ts                      # writeJsonSafe(): writes camelCase output
│   │   │   └── exit-codes.ts
│   │   ├── codec/
│   │   │   ├── codex-input-decoder.ts         # stdin snake_case → HostEvent
│   │   │   └── codex-output-encoder.ts        # HostEventResult → stdout camelCase
│   │   ├── workspace.ts
│   │   └── state-hydration.ts
│   └── tests/
│
├── openclaw-plugin/                          # EXISTING — v4: NO refactor in MVP; stays as-is
│   └── (src/host/openclaw-host-adapter.ts → Post-MVP)
│
└── create-principles-disciple/               # EXISTING — extend for --codex
    └── src/installer.ts
```

### 5.3 Data contracts (VERIFIED against `codex-rs/hooks/src/schema.rs` + `output_parser.rs`)

> **Critical casing rule**: stdin **input** fields are **snake_case** (`session_id`, `tool_name`). stdout **output** fields are **camelCase** (`hookSpecificOutput`, `permissionDecision`). This asymmetry is verified from Rust `#[serde(rename_all = "camelCase")]` on output structs and its **absence** on input structs.

#### 5.3.1 PreToolUse

**Input (stdin, snake_case)**:
```json
{
  "session_id": "string",
  "turn_id": "string",
  "agent_id": "string?",
  "agent_type": "string?",
  "transcript_path": "string | null",
  "cwd": "string",
  "hook_event_name": "PreToolUse",
  "model": "string",
  "permission_mode": "string",
  "tool_name": "string",
  "tool_input": {},
  "tool_use_id": "string"
}
```

**Output (stdout, camelCase)** — one of:
```json
{}
{ "decision": "block", "reason": "non-empty string required" }
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "string",
    "additionalContext": "string"
  }
}
```

**⚠️ Universal output fields** (v4.1 corrected — `HookUniversalOutputWire` in `schema.rs:88-97`):
```json
{
  "continue": true,            // ⚠️ MUST be true — see below for per-event behavior of `false`
  "stopReason": null,          // only used when continue=false (PD must never set this)
  "suppressOutput": false,     // ⚠️ NOT IMPLEMENTED in most events (v4.1 correction)
  "systemMessage": null        // optional system-level message injected to model context
}
```

**`continue: false` behavior per event** (v4.1 — corrected from v4's wrong "terminates session" claim):
- **PreToolUse / PermissionRequest**: `continue: false` is **unsupported** → generates `invalid_reason` → output rejected → **fail-OPEN** (tool proceeds). Verified in `output_parser.rs:355-364`.
- **PostToolUse**: `PostToolUseOutcome` has **NO `should_stop` field** (`post_tool_use.rs:40-45`) — `continue: false` only sets `status = Stopped` + records feedback message, but has **no effect on session or turn**. Test `continue_false_stops_with_reason` confirms `should_block: false`.
- **UserPromptSubmit / SessionStart**: `should_stop = true` → rejects current input + stops current turn, but **session survives** (test `continue_false_preserves_context_for_later_turns`). User can continue the session.
- **Stop / PreCompact / PostCompact**: `should_stop = true` → stops current turn.

**`suppressOutput` field** (v4.1 — NOT implemented as "hides output from UI"):
- **UserPromptSubmit / SessionStart / Stop / PreCompact / PostCompact**: explicitly ignored (`let _ = parsed.universal.suppress_output;`).
- **PreToolUse / PermissionRequest / PostToolUse**: generates `invalid_reason` → output rejected (fail-OPEN).
- PD codec must NOT set `suppressOutput: true`.

**`systemMessage` field**: injects a system-level message into model context. PD may use this for principle injection as an alternative to `additionalContext`.

**PD codec MUST hardcode `continue: true`** — even though `false` does not terminate the session, it causes disruptive behavior (turn abort, input rejection, or fail-open output rejection depending on event).

**Verified decisions** (v4.1 corrected — verified from `output_parser.rs:115-176`, `pre_tool_use.rs:193-292`, `hook_runtime.rs:194-212`):
- `{}` (empty JSON) → implicit default, no block
- `decision: "approve"` → explicit `PreToolUseDecisionWire::Approve` enum value, treated same as `{}` (no block) — **NOT** the "implicit default" (v3 wording was misleading)
- `decision: "block"` → blocks; **requires non-empty `reason`**
- `permissionDecision: "deny"` → blocks (use `permissionDecisionReason` for reason)
- `permissionDecision: "allow"` + `updatedInput` → **supported** (rewrites tool input; verified `output_parser.rs:156-164`)
- `permissionDecision: "ask"` → **v4.1 correction**: `ask` **UNCONDITIONALLY** generates `invalid_reason` (`output_parser.rs:445-447`) — NOT "treated like allow" as v4 claimed, and NOT conditional on `updatedInput`. When `invalid_reason` is set, `should_block` stays `false` (`pre_tool_use.rs:235-240`), so `hook_runtime.rs:204` returns `Continue` — the tool **PROCEEDS**. This is **fail-OPEN**, not fail-closed as v4 claimed. **⚠️ Critical safety note**: if PD's codec accidentally sends `ask` when trying to block a dangerous tool, the tool will SILENTLY proceed. PD codec MUST NEVER emit `ask`. PD codec test must assert `permissionDecision ∈ {undefined, "allow", "deny"}`.
- Exit code `2` → also blocks

**PD mapping**: `tool.pre` → confirm-first gate. **Single matcher group `matcher: "Bash|apply_patch"`** (v4 — both matchers valid in PreToolUse; aliases `Write`/`Edit` also work).
- When gate active for a Bash command pattern (e.g., `git push`, `rm -rf`), return `{ "decision": "block", "reason": "PD confirm-first gate active for Bash: <command>" }`.
- When gate active for a file edit pattern (e.g., editing files in `.git/`), return `{ "decision": "block", "reason": "PD confirm-first gate active for apply_patch: <path>" }`.

#### 5.3.2 PostToolUse

**Input (stdin, snake_case)**:
```json
{
  "session_id": "string",
  "turn_id": "string",
  "agent_id": "string?",
  "agent_type": "string?",
  "transcript_path": "string | null",
  "cwd": "string",
  "hook_event_name": "PostToolUse",
  "model": "string",
  "permission_mode": "string",
  "tool_name": "string",
  "tool_input": {},
  "tool_response": {},
  "tool_use_id": "string"
}
```

`tool_response` is `serde_json::Value` — **arbitrary JSON** (string, object, array, null). PD's classifier must handle `unknown` per rc-1.

**Output (stdout, camelCase)** — one of:
```json
{}
{ "decision": "block", "reason": "non-empty string required" }
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "string"
  }
}
```

**⚠️ `updatedMCPToolOutput` field exists** (v4 NEW — `PostToolUseHookSpecificOutputWire.updated_mcp_tool_output` in `schema.rs:232-234`): allows rewriting MCP tool output. PD codec must NOT accidentally serialize this field. PD MVP does not use it.

**Verified**: `decision` only supports `"block"` (not `"stop"` or `"feedback"` — those were v1 errors). Block **requires non-empty `reason`**.

**PD mapping**: `tool.post` → pain-signal capture. Matcher: `.*` (observe all tools including `apply_patch`).
- `tool_response` is arbitrary JSON; PD's `classifyToolCallOutcome` handles both string (OpenClaw) and object (Codex) shapes.
- PD does **not** block post-tool in MVP (returns `{}` after capturing pain signal).

#### 5.3.3 UserPromptSubmit

**Input (stdin, snake_case)**:
```json
{
  "session_id": "string",
  "turn_id": "string",
  "agent_id": "string?",
  "agent_type": "string?",
  "transcript_path": "string | null",
  "cwd": "string",
  "hook_event_name": "UserPromptSubmit",
  "model": "string",
  "permission_mode": "string",
  "prompt": "string"
}
```

**Output (stdout, camelCase)** — one of:
```json
{}
{ "decision": "block", "reason": "string" }
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "string"
  }
}
```

**PD mapping**: `prompt.submit` → principle + pain-signal injection via `additionalContext` only.
- OpenClaw's 4 prompt fields (`prependSystemContext`, `appendSystemContext`, `prependContext`, `appendContext`) collapse into a single `additionalContext` on Codex.
- `additionalContext` bounded via `truncateInjectionToBudget` (rc-8).
- **⚠️ PD codec MUST hardcode `continue: true`** (v4.1 corrected): setting `continue: false` in UserPromptSubmit would set `should_stop = true` → reject current input + stop current turn. Session survives (test `continue_false_preserves_context_for_later_turns`), but the user's prompt is discarded. Still disruptive, must be avoided.

#### 5.3.4 SessionStart

**Input (stdin, snake_case)**:
```json
{
  "session_id": "string",
  "transcript_path": "string | null",
  "cwd": "string",
  "hook_event_name": "SessionStart",
  "model": "string",
  "permission_mode": "string",
  "source": "startup | resume | clear | compact"
}
```

**⚠️ No `turn_id` field** (v4 NEW — verified from `SessionStartCommandInput` in `schema.rs:486-497`): unlike PreToolUse/PostToolUse/UserPromptSubmit, SessionStart does NOT include `turn_id`, `agent_id`, or `agent_type`. PD's HostEvent normalizer must set `turnId = undefined` for session.start events — do NOT assume it always exists (rc-3 fail-loud on missing field).

**Output (stdout, camelCase)**:
```json
{}
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "string"
  }
}
```

**PD mapping**: `session.start` → workspace binding + state hydration.
- Default `timeout: 600` gives room for one-time migrations.

#### 5.3.5 Events PD defers in MVP

`PermissionRequest`, `PreCompact`, `PostCompact`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `Stop` — not needed for the three MVP-Core activation paths.

#### 5.3.6 File edit gating (v4 — no quirk, no gap)

**v4 correction**: v3 claimed "Write/Edit matcher aliases only work in PermissionRequest, not PreToolUse." This was **completely wrong** (see §2.6 for full source evidence). The correct behavior:

- `matcher: "apply_patch"`, `matcher: "Write"`, `matcher: "Edit"` — **all valid and equivalent** in PreToolUse for file-edit tool calls.
- Single matcher group `matcher: "Bash|apply_patch"` covers both shell commands and file edits.
- No Codex quirk exists. No functional gap exists.

### 5.4 Hook script execution model

Each Codex hook invocation is a fresh `node` process:
1. Read stdin JSON (bounded; rc-8).
2. Validate with TypeBox guard (rc-1, rc-2, rc-5).
3. Resolve workspace from `cwd`.
4. Open `.pd/state.db` (fresh connection; rc-7).
5. Decode to `HostEvent`, dispatch to handler.
6. Encode `HostEventResult` → Codex stdout JSON (camelCase).
7. Write stdout **once** (rc-8: no debug prints to stdout).
8. Exit 0 (success), 2 (block), or 1 (error with structured log).

**⚠️ `deny_unknown_fields` hard constraint** (v4 NEW — verified: 29 occurrences of `#[serde(deny_unknown_fields)]` in `schema.rs`, covering ALL output wire structs): PD's stdout JSON must **strictly and only** contain fields defined in Codex's output schema. Any extra field (e.g., `pdVersion`, `debugInfo`, `timestamp`) will cause Codex's serde deserializer to **reject the entire output**, silently dropping the hook result. PD codec must use exact field whitelists, not `JSON.stringify(arbitraryObject)`.

### 5.5 Workspace resolution

Same algorithm as `packages/openclaw-plugin/src/utils/workspace-resolver.ts`, refactored into `@principles/core` as a pure function (no `fs` — pass `dirExists` callback).

### 5.6 State management

```
{workspace}/
├── .pd/
│   ├── config.yaml              # shared with OpenClaw
│   └── state.db                 # SQLite (shared schema)
└── .pd/.state/
    └── codex-sessions/           # Codex-specific session tracking
        └── {session_id}.json     # { startedAt, lastTurnId, source, frictionSnapshot }
```

### 5.7 Installer integration (PRI-281)

The installer gains `--codex` flag. Two installation paths:

**Path A: Plugin bundle (preferred — no flag needed)**
1. Install `@principles/codex-adapter` to `~/.codex/plugins/cache/principles-disciple/`
2. Plugin manifest (`plugin.json`) declares hooks via `hooks/hooks.json`
3. Enable plugin in `~/.codex/config.toml`
4. Owner trusts hooks via `/hooks` TUI (plugin-bundled hooks are non-managed → require trust)

**Path B: Global hooks.json (fallback)**
1. Merge PD hook entries into `~/.codex/hooks.json` (append, never overwrite)
2. Use sidecar marker file `~/.codex/.pd-hooks.marker` for precise uninstall
3. Owner trusts hooks via `/hooks` TUI

**hooks.json entry format** (v4 — verified against `config/src/hook_config.rs:147-171`; uses `timeout` not `timeout_sec`; supports `async`, `commandWindows`, `additionalContextLimit`):

```json
{
  "PreToolUse": [
    {
      "matcher": "Bash|apply_patch",
      "hooks": [
        {
          "type": "command",
          "command": "node ./node_modules/@principles/codex-adapter/dist/pd-hook.js",
          "commandWindows": "node ./node_modules/@principles/codex-adapter/dist/pd-hook.js",
          "timeout": 5,
          "statusMessage": "PD: checking tool call"
        }
      ]
    }
  ],
  "PostToolUse": [
    {
      "matcher": ".*",
      "hooks": [
        {
          "type": "command",
          "command": "node ./node_modules/@principles/codex-adapter/dist/pd-hook.js",
          "commandWindows": "node ./node_modules/@principles/codex-adapter/dist/pd-hook.js",
          "timeout": 5,
          "async": true,
          "statusMessage": "PD: capturing pain signal"
        }
      ]
    }
  ],
  "UserPromptSubmit": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "node ./node_modules/@principles/codex-adapter/dist/pd-hook.js",
          "commandWindows": "node ./node_modules/@principles/codex-adapter/dist/pd-hook.js",
          "timeout": 5,
          "additionalContextLimit": 10000,
          "statusMessage": "PD: injecting principles"
        }
      ]
    }
  ],
  "SessionStart": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "node ./node_modules/@principles/codex-adapter/dist/pd-hook.js",
          "commandWindows": "node ./node_modules/@principles/codex-adapter/dist/pd-hook.js",
          "timeout": 600,
          "additionalContextLimit": 10000,
          "statusMessage": "PD: hydrating state"
        }
      ]
    }
  ]
}
```

**v4 changes** (adopted from P3-1/P3-2/P3-3/P2-2/P2-3 review feedback):
- **Single hook script** (`pd-hook.js`) with internal event routing by `hook_event_name` — reduces cold start (one esbuild bundle) and shares initialization logic (P3-1).
- **Single matcher group** `"Bash|apply_patch"` — v4 correction: aliases work in PreToolUse, so separate groups are unnecessary (P3-3, follows from P0-1 fix).
- **`async: true`** on PostToolUse — PD only observes (returns `{}`), so async eliminates blocking (P3-2). **v4.1 caveat**: `async` is implemented in HEAD source but may not be effective in older release versions; verify in PRI-282 E2E against the pinned Codex release.
- **`additionalContextLimit: 10000`** — default 2500 tokens is too small for PD principle injection; set explicitly (P2-2).
- **`commandWindows`** on all hooks — cross-platform support (P2-3).

**Post-install steps** (CRITICAL — was missing from v1):
1. Print: "PD hooks registered. Open Codex and run `/hooks` to trust PD hooks before they execute."
2. Verify `hooks` feature is ON (default): `codex doctor` or check `~/.codex/config.toml` for `[features].hooks = false`.
3. If `hooks` is OFF: print instructions to set `[features].hooks = true` in `~/.codex/config.toml`.

### 5.8 Feature flag registration

```yaml
# {workspace}/.pd/config.yaml
host:
  codex:
    category: quiet        # MVP-Quiet: default OFF until PRI-282 E2E passes
    enabled: false
    since: 2026-08-11
    hooks:
      pre_tool_use_matcher: "Bash|apply_patch"   # v4: single group; Write/Edit aliases also valid
      post_tool_use_matcher: ".*"
      session_start_timeout_sec: 600
      tool_use_timeout_sec: 5
  openclaw:
    category: core
    enabled: true
    since: 2026-04-01
  # v4: abstraction_layer_v1 REMOVED — OpenClaw refactor (shadow mode) deferred to Post-MVP.
  # The HostAdapter interface is defined in @principles/core but only codex-adapter implements it.
  # OpenClaw path keeps its existing direct api.on() registration unchanged.
```

### 5.9 Runtime Contract Rules compliance

| Rule | How Codex adapter complies |
|------|----------------------------|
| `rc-1-treat-as-unknown` | All stdin input typed as `unknown`; TypeBox `Value.Check` before use. |
| `rc-2-no-as-bypass` | No `as` casts; use `typeof`, `Array.isArray`, `Value.Check`. |
| `rc-3-fail-loud-missing` | Missing required fields → exit 1 with structured log. |
| `rc-4-validate-array-elements` | `tool_input` / `tool_response` arrays element-wise validated. |
| `rc-5-object-hasown-not-in` | `Object.hasOwn(input, 'tool_name')`, never `in`. |
| `rc-6-lineage-consistency` | `session_id` + `turn_id` propagated together. |
| `rc-7-loop-state-freshness` | Subprocess: fresh SQLite per invocation, no stale state. |
| `rc-8-safe-serialization` | `additionalContext` bounded; stdout written once. |
| `rc-9-no-silent-fallback` | Flag-disabled, workspace-not-found, DB-failure paths emit `SystemLogger` with `reason` + `nextAction`. |

---

## 6. Implementation Plan

### 6.1 Sequencing (v4 — scope reduced)

```
Phase 0 (PRI-278, this SPEC + ADR):
  - SPEC reviewed and approved
  - ADR-0020 recorded
  - host.codex flag registered (default OFF)
  - No code changes

Phase 1 (PRI-280, Codex hook scripts — was Phase 2):
  - Create packages/codex-adapter/
  - Define HostAdapter interface in @principles/core (pure types, no I/O)
  - Implement single pd-hook.js entry + event router (P3-1)
  - Implement codec (snake_case→camelCase, deny_unknown_fields safe, continue=true hardcoded)
  - Unit tests with Codex generated JSON Schema fixtures (P3-6) — **v4.1: upgraded from suggestion to gate-critical**. Because invalid output is fail-OPEN (§7 risk table), codec whitelist tests + JSON Schema contract tests are the primary defense against silent gate bypass. MUST include: (a) `permissionDecision ∈ {undefined, "allow", "deny"}` assertion; (b) no extra fields beyond Codex schema; (c) `continue: true` hardcoded; (d) `suppressOutput: false` hardcoded.
  - OpenClaw path stays UNCHANGED (v4: no shadow mode)

Phase 2 (PRI-281, installer --codex — was Phase 4):
  - Plugin bundle path (preferred)
  - Global hooks.json merge path (fallback)
  - Post-install trust guidance
  - Windows commandWindows support (P2-3)
  - additionalContextLimit configured (P2-2)

Phase 3 (PRI-282, E2E validation — was Phase 5):
  - Real Codex CLI session
  - Pain signal captured from Bash + apply_patch
  - Principle injection visible in additionalContext
  - Confirm-first gate blocks `git push` (Bash) and `.git/config` edit (apply_patch)
  - Trust failure path verified (rc-9)
  - timeout / codec error paths verified

Phase 4 (Flag flip):
  - host.codex.enabled: true after E2E passes
```

**v4 scope reductions** (based on external review P1-1/P1-2):
- **OpenClaw shadow mode → deferred to Post-MVP**: OpenClaw path stays unchanged in MVP. `HostAdapter` interface defined but only `codex-adapter` implements it. This eliminates the largest regression risk.
- **PRI-279 (CodexCliRuntimeAdapter) → deferred to Post-MVP**: The three MVP-Core activation paths (prompt, code_tool_hook, defer_archive) are all **inbound** (Codex calls PD). The outbound direction (PD calls LLM for internalization) already has OpenClaw/pi-ai runners. PRI-279 does not pass `mvp-q-1-what-if-skip`.

### 6.2 BDD scenarios (corrected from v1)

```gherkin
# docs/specs/features/host/codex-adapter.feature (NEW)
Feature: Codex CLI adapter
  As an owner using Codex CLI
  I want PD to capture pain signals and inject principles
  So that my Codex agent stops repeating the same mistakes

  Scenario: PostToolUse captures a Bash tool error as a pain signal
    Given a workspace with .pd/state.db initialized
    And host.codex.enabled is true
    When Codex invokes the PostToolUse hook with tool_name "Bash" and tool_response containing an error
    Then a pain signal is recorded with source "codex:post_tool_use"
    And the pain signal includes session_id and turn_id
    And the hook outputs {} and exits 0

  Scenario: PreToolUse blocks a dangerous Bash command when confirm-first gate is active
    Given confirm-first gate is active for Bash command pattern "git push"
    When Codex invokes the PreToolUse hook with tool_name "Bash" and tool_input.command matching "git push"
    Then the hook outputs { "decision": "block", "reason": "PD confirm-first gate active for Bash: git push" }
    And exits 0

  Scenario: PreToolUse blocks a dangerous file edit via apply_patch when confirm-first gate is active
    Given confirm-first gate is active for apply_patch pattern ".git/*"
    When Codex invokes the PreToolUse hook with tool_name "apply_patch" and tool_input containing a patch to ".git/config"
    Then the hook outputs { "decision": "block", "reason": "PD confirm-first gate active for apply_patch: .git/config" }
    And exits 0

  Scenario: PreToolUse matcher "Write" matches apply_patch in PreToolUse path
    Given a PreToolUse hook registered with matcher "Write"
    When Codex invokes the PreToolUse hook with tool_name "apply_patch"
    Then the hook IS invoked because "Write" is a matcher alias for apply_patch in ALL matcher-aware events
    # v4 correction: v3 incorrectly claimed Write/Edit don't work in PreToolUse

  Scenario: UserPromptSubmit injects principles as additionalContext
    Given the workspace has 2 active principles
    When Codex invokes the UserPromptSubmit hook
    Then the hook outputs additionalContext containing both principle texts
    And the additionalContext is bounded to DEFAULT_PRINCIPLE_BUDGET chars

  Scenario: SessionStart hydrates confirm-first state on resume
    Given a prior session set confirm-first gate active
    When Codex invokes the SessionStart hook with source "resume"
    Then the confirm-first gate is hydrated as active
    And the hook outputs {} and exits 0

  Scenario: Hook degrades gracefully when host.codex is disabled
    Given host.codex.enabled is false
    When Codex invokes any PD hook
    Then the hook outputs {} and exits 0
    And a SystemLogger line records the skip with reason "host.codex disabled"

  Scenario: Hook output uses camelCase field names
    When Codex invokes the PreToolUse hook and PD decides to block
    Then the stdout JSON uses "hookSpecificOutput" (camelCase) not "hook_specific_output"
    And "permissionDecision" (camelCase) not "permission_decision"
```

---

## 7. Risk Analysis (updated with Codex-specific findings)

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Hook trust not completed by owner** | High | High | Installer prints explicit instructions; `pd health --host codex` checks trust status. |
| `hooks` flag disabled by owner | Low | High | Installer verifies `[features].hooks` is ON (default); prints fix instructions if OFF. |
| Global hooks.json conflicts | Medium | Medium | Merge strategy: append PD blocks, never remove; sidecar marker for uninstall. |
| timeout too short for principle selection | Low | High | Default 5s generous for SQLite; heavy logic in background worker. |
| Codex hook API changes | Medium | High | Pin min version; version check in SessionStart. |
| stdin/stdout casing asymmetry causes bugs | Medium | Medium | Codec tests with golden JSON fixtures covering both casings. |
| Multiple hooks run concurrently | Medium | Low | PD hooks are stateless per-invocation (fresh SQLite); concurrency safe. |
| Subprocess startup latency | Medium | Medium | Small bundle (esbuild single-file); `--no-warnings`. |
| Workspace ambiguity | Low | Medium | Walk up from `cwd`; nearest `.pd/`; error if two at same level. |
| Matcher alias confusion (`Write`/`Edit` vs `apply_patch`) | Low | Low | v4: no quirk exists — aliases work in ALL matcher-aware events (verified in §2.6). PD uses single `matcher: "Bash\|apply_patch"`. BDD scenario documents the correct behavior. |
| **Codec fail-OPEN on invalid output** (v4.1 NEW) | Medium | **Critical** | When PD's stdout JSON contains unsupported fields (`ask`, `suppressOutput: true` in PreToolUse, `continue: false`, extra fields), Codex generates `invalid_reason` and the tool PROCEEDS without blocking. PD's confirm-first gate silently fails. **Mitigation**: (1) codec whitelist test asserting `permissionDecision ∈ {undefined, "allow", "deny"}`; (2) codec test asserting no extra fields; (3) PRI-282 E2E must verify gate blocks on real Codex release; (4) JSON Schema fixture contract tests (P3-6) upgraded from suggestion to gate-critical. |

---

## 8. Open Questions

1. **Codex CLI version pinning**: require `>= 0.124` (v4.1 correction: hooks Stable commit #19012 on 2026-04-23 first released as `rust-v0.124.0`; v4's `>= 0.118` was wrong). Warn (don't block) if lower. Verify exact pinning in PRI-282 E2E against the pinned release.
2. **Multi-workspace hooks**: PD hooks resolve workspace per-invocation from `cwd`. No-conflict design.
3. **Hook script distribution**: `@principles/codex-adapter` published to npm; bundled single-file via esbuild.
4. **PermissionRequest hook (deferred)**: would let PD override Codex permission prompts. Crosses product boundary into "active permission broker." Post-MVP.
5. **Sub-agent tracking (deferred)**: MVP treats parent session as attribution unit.
6. **Codex sandbox vs PD write-back**: PD writes to `.pd/` directly (sandboxed tools cannot); artifacts for owner's repo go through Codex's `apply_patch`.
7. **plugin.json manifest schema** (v4.1 NEW — from third external review): Codex source (`core-plugins/src/agent_plugin_manifest.rs`) requires root `plugin.json` to contain a `$schema` field pointing to the Agent Plugins URI (`codex_utils_plugins::AGENT_PLUGIN_SCHEMA_URI`). Tests reference a `.codex-plugin/` manifest directory. Before implementing PRI-281's plugin-bundle install path, verify the exact `plugin.json` schema against `codex_utils_plugins::AGENT_PLUGIN_SCHEMA_URI` and add a Codex-generated JSON Schema fixture for contract testing.
8. **Official docs reference** (v4.1 NEW): OpenAI's official Codex hooks documentation at <https://developers.openai.com/codex/hooks> was cross-checked during verification and matches local source closely. Differences are mainly in `async`/`suppressOutput` "parsed but not supported yet" fields. SPEC should cite this as supplementary reference.

---

## 9. ADR-0020

> **Status**: Accepted (2026-08-11)
> **Full ADR**: [`docs/adr/0020-codex-cli-host-adapter.md`](../adr/0020-codex-cli-host-adapter.md)

**Title**: Codex CLI Host Adapter and Multi-Platform Host Abstraction Layer

**Context**: PD runs only on OpenClaw. Owners want Codex CLI support. Future hosts anticipated. Without abstraction, each host forks the hook registration code. v4.1 adds: existing `create-principles-disciple` installer/uninstaller is hardcoded to OpenClaw paths (`getOpenClawDir`, `getPluginExtDir`, `updateOpenClawConfig`, `cleanupOpenClawConfig`) — multi-host install/uninstall requires a `HostInstaller` abstraction.

**Decision**:
1. Introduce `HostAdapter` contract normalizing host events into unified `HostEvent` vocabulary.
2. Implement `CodexHooksHostAdapter` as new package `@principles/codex-adapter` with single `pd-hook.js` entry + event router. **Do NOT mix codex-adapter code into `packages/openclaw-plugin/`** — the two hosts have fundamentally different extension models.
3. **OpenClaw refactor deferred to Post-MVP** (v4): OpenClaw path keeps its existing direct `api.on()` registration unchanged. `HostAdapter` interface is defined in `@principles/core` (pure types, no I/O) but only `codex-adapter` implements it. This eliminates the largest regression risk on the only production-stable activation path.
4. Register `host.codex` feature flag (MVP-Quiet, default OFF, since 2026-08-11). The `abstraction_layer_v1` flag is **not registered** in MVP — OpenClaw shadow-mode refactor is deferred per ADR-0014.
5. Defer `PermissionRequest`, compact, subagent, stop hooks.
6. **Use single matcher group** `matcher: "Bash|apply_patch"` for PreToolUse (v4 — aliases `Write`/`Edit` work in ALL matcher-aware events, no quirk exists).
7. **Defer PRI-279 (Outbound CodexCliRuntimeAdapter) to Post-MVP**: The three MVP-Core activation paths (`prompt`, `code_tool_hook`, `defer_archive`) are all inbound (Codex calls PD). Outbound internalization already has OpenClaw/pi-ai runners. PRI-279 does not pass `mvp-q-1-what-if-skip`.
8. **Multi-host installer/uninstaller** (v4.1 NEW): Introduce `HostInstaller` abstraction in `create-principles-disciple` with `HostTarget = 'openclaw' | 'codex'`. Each host gets a concrete installer (`OpenClawHostInstaller`, `CodexHostInstaller`). Installer prompts owner to choose which hosts to install for; uninstaller detects and cleans each host's artifacts independently. See ADR-0020 §2.3 for the interface contract.

**Consequences**:
- New host = one adapter + one installer + registration + tests. Business logic shared.
- OpenClaw path stays unchanged in MVP — zero regression risk on production-stable path.
- Codex has **equivalent gate coverage** to OpenClaw for function tools (Bash, apply_patch, MCP tools all trigger PreToolUse).
- One `create-principles-disciple` invocation handles both hosts (owner chooses which), rather than two separate installers.
- Post-MVP debt: `OpenClawHostAdapter` refactor + `abstraction_layer_v1` flag + PRI-279 outbound adapter are tracked in `docs/plans/post-mvp-conditional-roadmap.md`.

**Alternatives**:
- A: Fork OpenClaw code for Codex. Rejected (DRY violation, N copies).
- B: Make Codex an MCP server. Rejected (changes PD role from passive observer to active tool).
- C: Wait for a "simpler" hook API. Rejected (current API is sufficient; no gap exists).
- D: Mix codex-adapter into `packages/openclaw-plugin/`. Rejected (different extension models create god-package; cannot ship OpenClaw without Codex).
- E: Refactor OpenClaw to use `HostAdapter` in MVP (shadow mode). Rejected for MVP (regression risk on production-stable path). Tracked for Post-MVP.
- F: Single global installer that auto-detects host. Rejected as default behavior (owner must explicitly choose; auto-detection only suggests defaults).

---

## 10. Self-Evaluation Summary

### What v3 got wrong (5 errors, all corrected in v4 — identified by external review)

| # | v3 Error | v4 Correction (verified against source) |
|---|----------|-----------------------------------------|
| 1 | "Write/Edit matcher aliases only work in PermissionRequest, not PreToolUse" | **Completely wrong.** `apply_patch` has its own `pre_tool_use_payload` (apply_patch.rs:459-463) that uses `HookToolName::apply_patch()` with aliases. `matcher_inputs()` (common.rs:152-161) chains canonical + aliases. Dispatcher (dispatcher.rs:61-63) uses `any()` matching. Test `pre_tool_use_aliases_match_once_per_handler` (dispatcher.rs:432-475) proves it. Aliases work in ALL matcher-aware events. |
| 2 | Missing universal output fields (`continue`, `stopReason`, `suppressOutput`, `systemMessage`) | Added to §5.3.1. `HookUniversalOutputWire` (schema.rs:88-97) applies to ALL hook outputs. **v4.1 correction**: `continue: false` does NOT terminate the session — see §5.3.1 for per-event behavior. `suppressOutput` is NOT implemented in most events. |
| 3 | `decision: "approve"` described as "implicit default" | Corrected: `approve` is an explicit `PreToolUseDecisionWire::Approve` enum value (schema.rs:265). The implicit default is `None` (field absent). Both result in no block. |
| 4 | `permissionDecision: "ask"` described as "not acted on (parsed but no effect)" | Corrected: `ask` is a valid enum value (`PreToolUsePermissionDecisionWire::Ask`, schema.rs:259). **v4.1 correction**: `ask` UNCONDITIONALLY generates `invalid_reason` (not conditional on `updatedInput`). The output is rejected and the tool PROCEEDS — this is **fail-OPEN**, not fail-closed. PD should NEVER use `"ask"`. |
| 5 | Missing `deny_unknown_fields` constraint | Added to §5.4. 29 occurrences in schema.rs. PD stdout JSON must NOT contain any extra fields. |

### What v1 got wrong (15 errors, all corrected in v2 — note: some v2 corrections were themselves wrong, fixed in v3)

| # | Error | v2 Correction | v3 Status |
|---|-------|---------------|-----------|
| 1 | "10 lifecycle events" | 11 events (missing SessionEnd) | ✅ Correct |
| 2 | "stdin/stdout are snake_case" | input=snake_case, output=camelCase (asymmetric) | ✅ Correct |
| 3 | "plugin-local hooks.json does NOT work (#16430)" | Plugin-bundled hooks supported | ✅ Correct (v3 adds: no flag needed) |
| 4 | Missing feature flag info | `hooks` (default ON); `plugin_hooks` (default OFF) | ❌ v3 fix: `plugin_hooks` is `Removed` no-op |
| 5 | PreToolUse matcher `Bash\|Write\|Edit` | PreToolUse only fires for `Bash` | ❌ v3 fix: fires for all function tools |
| 6 | Missing hook trust mechanism | Non-managed hooks require owner review + trust | ✅ Correct |
| 7 | PostToolUse supports `stop`/`feedback` | Only `block` (with required non-empty reason) | ✅ Correct |
| 8 | `timeout_sec` field in hooks.json | Actual field is `timeout` | ✅ Correct (serde renames) |
| 9 | `tool_response` is "structured JSON" | It's `serde_json::Value` (arbitrary JSON) | ✅ Correct |
| 10 | `transcript_path` is `Option<String>` | It's `NullableString` (can be null) | ✅ Correct |
| 11 | Missing `statusMessage` field | hooks.json supports optional `statusMessage` | ✅ Correct |
| 12 | Missing `apply_patch` tool gap | Codex file edits don't trigger PreToolUse | ❌ v3 fix: they DO trigger PreToolUse |
| 13 | Missing `CLAUDE_PLUGIN_ROOT` env | Codex injects `PLUGIN_ROOT`/`CLAUDE_PLUGIN_ROOT` | ✅ Correct |
| 14 | "PostToolUse is observe-only" | PostToolUse supports `decision: "block"` | ✅ Correct |
| 15 | "permissionDecision allow/ask rejected" | `allow` + `updatedInput` is supported; `ask` parsed but no effect | ❌ v4 fix: `ask` generates `invalid_reason` and rejects output (not "no effect") |

### Design improvements in v3

1. **`toolGatingScope` corrected** — Codex value is `all-tools` (was `bash-only`). Eliminates the false `bash-only` variant since no known host has this limitation.
2. **PreToolUse hooks.json now registers two matchers** — `Bash` and `apply_patch` — for full gate coverage. (v4: merged into single `Bash|apply_patch` group.)
3. **§5.3.6 rewritten** — no gap exists. (v4: no quirk exists either — `Write`/`Edit` aliases work in ALL matcher-aware events.)
4. **Installer simplified** — removed `plugin_hooks` flag requirement; only `hooks` flag check remains.
5. **BDD scenarios corrected** — removed the "PreToolUse does NOT fire for apply_patch" scenario; added positive file-edit-gating scenario. (v4: replaced "matcher-alias-quirk" scenario with "matcher-alias-works" scenario.)

### Design improvements carried from v2

1. **`requiresHookTrust` capability** — installer knows whether to prompt for trust.
2. ~~**Shadow mode** for OpenClaw refactor~~ — **v4: deferred to Post-MVP**. OpenClaw path stays unchanged in MVP; `HostAdapter` interface defined but only `codex-adapter` implements it.
3. **`nativeOverride` constrained** to `Record<string, unknown>` (was `unknown` — too loose).
4. **Plugin bundle install path** as preferred over global hooks.json.

### Remaining design concerns

1. **Subprocess latency**: each hook = fresh `node` process. If owners report slowness, may need persistent hook daemon (post-MVP). Partial mitigation: single `pd-hook.js` entry + esbuild bundle reduces cold start.
2. **Trust friction**: owner must manually trust hooks via `/hooks`. If they skip this, PD silently does nothing. Installer guidance is the only mitigation.
3. ~~**Matcher alias asymmetry**: `Write`/`Edit` matchers work for PermissionRequest but NOT for PreToolUse.~~ **v4: REMOVED** — this was a v3 error. Aliases work in ALL matcher-aware events (verified in §2.6).
4. **Cross-platform `command` field**: hooks.json supports `commandWindows` (camelCase) or `command_windows` (alias) for Windows-specific commands. PD should use this for cross-platform support (verified in `config/src/hook_config.rs:153`). v4: added to all hooks.json entries in §5.7.
5. **`additionalContextLimit` field**: hooks.json supports this to control token spilling (default 2,500 tokens). PD should use it for budget control (verified in `config/src/hook_config.rs:165-169`). v4: set to 10000 for UserPromptSubmit and SessionStart in §5.7.

### Design self-evaluation (v3)

**Strengths of the current design**:
1. The `HostAdapter` / `PDRuntimeAdapter` split cleanly separates inbound (host→PD) and outbound (PD→runtime) concerns. This is the right abstraction boundary.
2. ~~Shadow mode for OpenClaw refactor is a pragmatic way to eliminate regression risk without a big-bang cutover.~~ **v4: deferred to Post-MVP.** The MVP strength is now: OpenClaw path stays unchanged — zero regression risk on the only production-stable path. `HostAdapter` interface is defined but only `codex-adapter` implements it.
3. The `HostCapabilities` schema lets PD business logic adapt to host differences without `if/else` on `HostKind`.
4. Using stdin/stdout JSON for Codex hooks (rather than trying to load JS) respects Codex's extension model.

**Areas for improvement** (v4 updates):
1. **`HostEvent.payload` is `Type.Unknown()`** — this is intentionally loose, but each `HostAdapter` implementation should provide a typed `decodePayload()` method. The SPEC should mandate this.
2. **No explicit health-check contract for Codex hooks** — `pd health --host codex` is mentioned but not specified. Should define what "healthy" means (hooks registered? trusted? feature flag on?).
3. **Plugin manifest format (`plugin.json`) is unspecified** — the SPEC references it but doesn't define its schema. Need to verify Codex's actual plugin manifest format before implementation.
4. ~~**`commandWindows` not in hooks.json example**~~ **v4: RESOLVED** — all hooks.json entries in §5.7 now include `commandWindows`.
5. **Version pinning strategy is vague** — "require `>= 0.118`" is mentioned in §8 but not verified against actual Codex release history.

---

## 11. ChatGPT Model Value Maximization Strategy (moved to Post-MVP roadmap)

> **v4 change**: §11 content (7 value-maximization strategies, model matrix, product boundary guardrails) has been **moved** to `docs/plans/post-mvp-conditional-roadmap.md` §18 to avoid blurring MVP scope (external review P1-4). This section retains only a pointer.
>
> See: [`docs/plans/post-mvp-conditional-roadmap.md` §18](../plans/post-mvp-conditional-roadmap.md) — "Codex 价值最大化：7 条战略建议"
>
> All 7 strategies are **default Hold** with explicit restart conditions per ADR-0014. The strategies describe how to maximize value from GPT-5.6+ models once the MVP adapter is shipped — they are **not** required for MVP-Core activation paths (`prompt`, `code_tool_hook`, `defer_archive`) to function.

---

## 12. Effort Re-estimation (NEW in v3, revised v4)

> **Context**: Based on source-code verification (§10 v4 corrections) and the capability gap analysis (§3, §9), the original Linear tickets PRI-278~282 underestimated the MVP adaptation complexity. This section documents the re-estimation for transparent scope management.
>
> **v4 change**: PRI-279 deferred to Post-MVP (P1-1). OpenClaw shadow-mode refactor deferred to Post-MVP (P1-2). PRI-278 estimate reduced since no OpenClaw refactor needed in MVP. PRI-280 reduced since single `pd-hook.js` entry (P3-1) simplifies implementation.

### 12.1 Re-estimation summary (v4)

| Issue | Title | Original estimate | Revised estimate (v4) | Multiplier | Primary reason |
|--------|-------|-------------------|----------------------|------------|----------------|
| PRI-278 | Host adapter abstraction layer | 1x | **1.5x** | ×1.5 | v4 reduced: only define `HostAdapter` interface + `CodexHooksHostAdapter` impl; **no OpenClaw refactor in MVP** (P1-2). OpenClaw path keeps direct `api.on()`. |
| PRI-279 | CodexCliRuntimeAdapter | 1x | **DEFERRED to Post-MVP** | — | v4: does not pass `mvp-q-1-what-if-skip`. Three MVP-Core activation paths are all inbound. Tracked in `docs/plans/post-mvp-conditional-roadmap.md`. |
| PRI-280 | Codex hook scripts + codecs | 1x | **1.2-1.4x** | ×1.2~1.4 | v4 reduced: single `pd-hook.js` entry (P3-1) replaces 4 scripts. snake_case/camelCase codec; `deny_unknown_fields` whitelist; `continue: true` hardcoded; Codex JSON Schema fixtures (P3-6). |
| PRI-281 | Installer integration | 1x | **1.4x** | ×1.4 | Trust detection logic + `pd health --host codex` health check + re-trust on upgrade. `commandWindows` + `additionalContextLimit` config (P2-2/P2-3). |
| PRI-282 | E2E validation | 1x | **1.5x** | ×1.5 | Must cover trust failure, timeout, codec errors, `continue: false` rejection, `permissionDecision: "ask"` rejection. |

**Net v4 MVP scope reduction vs v3**: PRI-278 dropped from 2-3x to 1.5x (no shadow mode). PRI-279 removed from MVP entirely. PRI-280 dropped from 1.3-1.5x to 1.2-1.4x (single hook entry). **Total MVP effort reduced ~40% vs v3 estimate.**

### 12.2 Two hidden work items not in original tickets

These were discovered during source-code verification but are not explicitly scoped in PRI-278~282. Recommend splitting into separate tickets:

#### Hidden ticket A: Long-running service replacement

**Scope**: 4 OpenClaw services that cannot run on Codex (subprocess model):
- `EvolutionWorkerService` (MVP-Quiet, default OFF) — lowest priority
- `CorrectionObserverService` (MVP-Core, default ON) — **must replace**
- `InternalizationAutoConsumerService` (default ON for dogfood) — **must replace**
- `TrajectoryService` (registered via `api.registerService()`) — **must replace**

**Replacement strategies** (per service):
- (a) Cron / external scheduler
- (b) `pd-cli` manual trigger commands
- (c) `SessionStart` hook one-shot trigger (preferred for stateless operations)

**Estimated effort**: 1-1.5 weeks (per-service analysis + refactor + tests)

#### Hidden ticket B: Slash command migration to pd-cli

**Scope**: 18 OpenClaw slash commands that have no Codex equivalent (v4.1 correction: v4 said 16, but the list below actually contained 19 commands; `/pd-thinking` was retired 2026-08-20 as a write-only orphan, so 18 remain):
- `/pd-init`, `/pd-bootstrap`, `/pd-research`, `/pd-help`
- `/pd-status`, `/pd-pain`, `/pd-context`, `/pd-focus`
- `/pd-evolution-status`, `/pd-principle-rollback`, `/pd-rollback`
- `/pd-export`, `/pd-samples`, `/pd-workflow-debug`
- `/pd-promote-impl`, `/pd-disable-impl`, `/pd-archive-impl`, `/pd-rollback-impl`

**Replacement**: All commands must have `pd-cli` equivalents. Some already exist (`pd status`, `pd pain retry`); others need new CLI commands.

**Estimated effort**: 1-1.5 weeks (CLI command audit + gap-filling + tests)

### 12.3 MVP scope discipline

The 7 value-maximization strategies in §11.2 are **post-MVP** and must NOT inflate the current tickets. They are registered in `docs/plans/post-mvp-conditional-roadmap.md` §18 with explicit restart conditions per ADR-0014.

The MVP deliverable remains: **PD's three MVP-Core activation paths (`prompt`, `code_tool_hook`, `defer_archive`) work on Codex with equivalent coverage to OpenClaw.**

---

## 13. ERR entries considered

- **ERR-001** (treat parsed JSON as `unknown`): rc-1, rc-2 enforced.
- **ERR-005** (array element validation): rc-4 enforced.
- **ERR-007** (silent fallback on missing fields): rc-3 enforced.
- **ERR-009** (graceful degradation without reason): rc-9 enforced.
- **ERR-013** (`in` operator): rc-5 enforced.
- **ERR-015 / ERR-018** (stale loop state): rc-7 enforced by subprocess design.

---

*End of SPEC v4.1. v4.1 corrections verified 2026-08-11 against: `hooks/src/events/post_tool_use.rs:40-45` (`PostToolUseOutcome` has no `should_stop`), `hooks/src/events/pre_tool_use.rs:193-292` (`invalid_reason` → `should_block = false`), `hooks/src/events/user_prompt_submit.rs:303` (test `continue_false_preserves_context_for_later_turns`), `core/src/session/turn.rs:609-612` (`should_stop` → `reject_pending_input`, session survives), `core/src/hook_runtime.rs:194-212` (`!should_block` → `Continue`), `hooks/src/engine/output_parser.rs:445-447` (`ask` unconditional `invalid_reason`), `hooks/src/events/{user_prompt_submit,session_start,stop,compact}.rs` (`suppress_output` explicitly `let _ =` ignored), `hooks/src/engine/output_parser.rs:355-384` (`suppressOutput` → `invalid_reason` in PreToolUse/PermissionRequest/PostToolUse). Third external review (`CODEX_CLI_ADAPTER_SPEC.review.md`) findings E1/E2/E3, I1-I5, C1-C3 all verified and incorporated. All other v4 facts re-verified and remain accurate.*
