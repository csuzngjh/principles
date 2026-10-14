# WorkBuddy host-contract fixtures (Phase 0 probe evidence)

Origin: SPEC `docs/specs/workbuddy-host-adapter-spec.md` v0.3.0 §7.1 probes P01–P06, executed 2026-10-12 against the real WorkBuddy Desktop 5.8.1 install on this machine (engine `codebuddy-lite-wb.mjs` `--version` 2.161.0, SHA-256 `fd9d20c75264d20caf8878edc9cf374b333081113595486628d0bd8b8ca374ad`).

## How the evidence was captured (reproducible)

1. Full isolation: `WORKBUDDY_CONFIG_DIR` + `CODEBUDDY_CONFIG_DIR` both pointed at a scratch dir (`D:/Code/_worktrees/wb-probe-lab/iso-home`). Both vars are required — with only `WORKBUDDY_CONFIG_DIR`, transcripts/projects still resolve under `~/.codebuddy/`.
2. The standalone engine lacks the desktop account token. A custom model declared in `<iso>/models.json` (OpenAI-compatible `/chat/completions`, SSE) bypasses the account gate, so a **local mock model server** (`D:/Code/_worktrees/wb-probe-lab/mock-server.mjs`, port 39471) drove the real agent loop. Every model request body was logged (`mock-req-log.jsonl`) — this is the P04 injection evidence.
3. A probe plugin (`pd-probe`) with a `hooks/hooks.json` covering SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PostToolUseFailure was installed from a local marketplace into the isolated config. Its command hook (`node scripts/hook-log.cjs <eventArg>`) logs the exact stdin payload and then behaves according to a scenario file (`scenario.txt`, per-event `eventarg=scenario` lines).
4. Probe scripts live in `scripts/dev/workbuddy-probe/` in this repository; raw (unsanitized) evidence, hashes and host facts are archived in the private docs under `docs/reports/workbuddy-host-adapter-20261012/agents/probe-fg0phy/`.

Evidence boundary (do not overstate): the model was a local mock, so *model decisions* were scripted; the hook pipeline, tool execution, payload construction, permission/deny enforcement and context assembly are genuine engine behavior. Desktop-UI-only facts (the `/hooks` review panel) are UNKNOWN headlessly. Resume/compact injection persistence is UNKNOWN (probe feeder used `--no-session-persistence`).

## Files

| File | What it is | Probe |
| --- | --- | --- |
| `hook-runtime-contract.json` | Frozen runtime contract: per-event × per-scenario exit-code/output effects, payload field lists, ID availability, injection-channel conclusions, failure-routing conclusion (OD-02) | P02/P03/P04 |
| `manifest-facts.json` | Plugin manifest + registration facts: layout, marketplace commands, enabledPlugins format, cache layout, activation timing | P01 |
| `events/session-start-startup.json` | Real SessionStart stdin payload | P03 |
| `events/user-prompt-submit.json` | Real UserPromptSubmit stdin payload (2nd prompt of a stream-json session) | P01b/P03 |
| `events/pre-tool-use-read.json` | PreToolUse payload (Read) incl. `call_id`/`tool_use_id` | P03 |
| `events/post-tool-use-read-success.json` | PostToolUse with string `tool_response` (success) | P03 |
| `events/post-tool-use-read-iserror.json` | PostToolUse with `{is_error:true, tool_error_code:"1001"}` — failure WITHOUT PostToolUseFailure | P03 |
| `events/pre-tool-use-bash.json` / `events/post-tool-use-bash-exit7.json` | Bash tool pair; PostToolUse `tool_response` is an object with `exitCode:7` | P03 |
| `events/pre-tool-use-write.json` / `events/post-tool-use-failure-write-notread.json` | Thrown-error Write (existing-unread file) → PostToolUseFailure with `error`/`tool_error_code`/`tool_error_name`/`is_interrupt` | P03 (OD-02) |
| `events/pre-tool-use-write-denied.json` | PreToolUse of a Write that a sibling scenario denied (file never written) | P02/P03 |
| `events/model-request-injection-shapes.json` | Exact model-request message shapes proving hook outputs reach model-visible context (additionalContext / raw stdout / deny reason / tool-hint) | P04 |

## Key frozen conclusions (summary)

- **Blocking semantics**: PreToolUse deny / exit 2 (stdout or stderr message) / continue:false / stdout-closed-exit2 / timeout ALL block the tool; exit 0/1/3/bad-JSON do not. UserPromptSubmit exit-2-family blocks (clears) the prompt before the model. PostToolUse anything is non-blocking (tool already ran). SessionStart anything is non-blocking for the session.
- **Failure routing (OD-02)**: `is_error` tool responses (file-not-found, non-zero bash, read-directory) fire **PostToolUse**; only *thrown* tool errors fire **PostToolUseFailure**; unknown tool names and schema-invalid arguments fire nothing. → PD after_tool_call evidence covers common failures without adding PostToolUseFailure; add it only for the thrown class if ever needed.
- **Injection (P04)**: `hookSpecificOutput.additionalContext` on UserPromptSubmit lands verbatim in the same turn's user message as `<system-reminder data-role="hook">` before `<user_query>`; PostToolUse additionalContext becomes a `tool-hint` reminder on the tool message; PreToolUse deny reason reaches the model as `Error: <reason>` tool message. Raw stdout also injects (even with exit 2/3) — the adapter must keep stdout clean and use structured JSON only.
- **IDs**: `session_id` always; `generation_id` per turn (turnId); `call_id`==`tool_use_id` per tool call (from model tool_call id); no host-side dedup of repeated identical ids.
- **Runtime**: command hooks run under Git Bash; `node` resolves from PATH; real `.cjs` wrappers work with spaces+Chinese in plugin root and cwd; better-sqlite3 N-API prebuilds load under node 22 and 26; the host's own bundled better-sqlite3 is not requirable from outside — PD must ship its own runtime.
