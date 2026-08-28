# Codex G1 Contract Probe Report — Governance Closure Slice 0

- **Status:** G1 = GO (evidence complete; statements below are executable via
  `packages/codex-adapter/tests/g1-contract-fixtures.test.ts`)
- **Date:** 2026-08-28
- **SPEC:** `docs/superpowers/specs/2026-08-28-codex-governance-closure-spec.md` §3 (G1), rev 2 (merged as PR #1437)
- **Fixtures:** `packages/codex-adapter/tests/fixtures/g1-contract/` (see its README for provenance and sanitization)

## 1. Tested environment

| Item | Value |
| --- | --- |
| Codex CLI (current) | `codex-cli 0.150.1` (npm global install) |
| Codex CLI (minimum) | `@openai/codex 0.148.0` via `npx` |
| Codex Desktop archive cross-check | `0.150.0-alpha.12.2` (vscode originator), `0.149.0-alpha.4` |
| OS | Windows 10.0.26200 x64 |
| Node | v26.7.0 |
| Source cross-check | official `openai/codex` checkout at `D:\Code\codex` (post-0.150 `codex-rs`) |
| Hook configuration | user-layer `~/.codex/hooks.json` command hooks, run with `codex exec --dangerously-bypass-hook-trust` (probe-only; file removed after capture) |

Both versions were probed on-device with the same probe harness. Payload
field sets are identical across 0.148.0 and 0.150.1 for every shared event
(pinned by test).

## 2. TURN_COMPLETE selection

**`Stop` is the turn-complete event.** Proof (all on-device):

1. `Stop` fires once per completed turn — after the final assistant message
   of the turn, including turns that contained tool calls (tool sub-steps do
   not fire Stop; verified in runs with one `echo` tool call → exactly one
   Stop).
2. The `Stop` payload carries `last_assistant_message`, and at hook-invocation
   time the rollout file **already contains the matching final assistant
   record**: the probe compared sha256 of the payload message against the
   `response_item` `message` `role:assistant` `phase:final_answer` record in
   the file — identical, with matching `turn_id` linkage, on both 0.148.0 and
   0.150.1.
3. Flush ordering is structural, not racy: the hook's `transcript_path` is
   resolved through `Session::hook_transcript_path()`, which first
   materializes/persists the rollout (`ensure_rollout_materialized`) and only
   then spawns the hook subprocess (source: `codex-rs/core/src/hook_runtime.rs`
   `run_turn_stop_hooks`; `codex-rs/rollout/src/recorder.rs` `persist`).
4. `SessionEnd` is **not** a turn-complete substitute: it fires at thread
   teardown (in `codex exec`, after the final `task_complete` record is
   appended), its payload has no `turn_id`/`model`/assistant fields, and its
   hook budget is 1 s default / 3 s hard cap (source:
   `codex-rs/hooks/src/events/session_end.rs`). It remains useful purely as a
   lifecycle-close marker, exactly as SPEC §8 assumes.
5. `Stop` also delivers `stop_hook_active` (continuation-loop guard) and, for
   thread-spawned subagents, a `SubagentStop` variant.

The implementation must register only `Stop` for turn completion; registering
both `Stop` and `SessionEnd` for the same purpose is unnecessary (SPEC §8).

## 3. Event contract (installed reality)

Events observed firing on-device in `codex exec` mode, payload field sets
frozen in fixtures:

| Event | Required fields (all required; nullable marked) | Notes |
| --- | --- | --- |
| `SessionStart` | session_id, transcript_path?, cwd, hook_event_name, model, permission_mode, source | `source` distinguishes `startup` vs `resume` (resume proven on-device) |
| `UserPromptSubmit` | session_id, turn_id, transcript_path?, cwd, hook_event_name, model, permission_mode, prompt | prompt = the exact visible user text |
| `PreToolUse` | session_id, turn_id, transcript_path?, cwd, hook_event_name, model, permission_mode, tool_name, tool_input, tool_use_id | |
| `PostToolUse` | …same as PreToolUse… + tool_response | |
| `Stop` | session_id, turn_id, transcript_path?, cwd, hook_event_name, model, permission_mode, stop_hook_active, last_assistant_message? | |
| `SubagentStop` | session_id, turn_id, transcript_path?, agent_transcript_path?, cwd, hook_event_name, model, permission_mode, stop_hook_active, agent_id, agent_type, last_assistant_message? | session_id/transcript_path are the PARENT's; agent_* are the subagent's (proven on-device) |
| `SessionEnd` | session_id, transcript_path?, cwd, hook_event_name, reason | reason observed as `"other"` |

Additional events exist (`PreCompact`, `PostCompact`, `PermissionRequest`,
`SubagentStart`, `Interrupt` since 0.150.0) but are not needed for the SPEC's
MVP path; `PostCompact`/`PreCompact` matter only because compaction rewrites
the logical history (see §6).

Official JSON schemas (generated, `additionalProperties: false`) live in the
Codex source at `codex-rs/hooks/schema/generated/*.command.input.schema.json`.

## 4. Identity contract

All fields below are durable logical identifiers (uuid-v7-shaped), verified
against real runs:

- **root session**: payload `session_id` == `session_meta.session_id` for root
  rollouts == ThreadId.
- **turn**: payload `turn_id` == `turn_context.payload.turn_id` in the
  transcript == the `turn_id` inside message metadata
  (`internal_chat_message_metadata_passthrough`) of every record produced in
  that turn.
- **message/item**: `response_item.payload.id` (`msg_*`, `ctc_*`, `ctco_*`,
  `fc_*`, `fco_*`, `amsg_*`) — globally unique, safe Logical Observation Key
  component.
- **tool (two id spaces)**: the hook's `tool_use_id` (e.g. `exec-<uuid>` for
  the shell tool, reported as `tool_name: "Bash"`) is a different id space
  from the transcript's model-level `call_id` (`call_*`). The bridge is the
  `event_msg` `item_completed` record wrapping a `CommandExecution` whose
  `item.id` equals the hook `tool_use_id` and whose `turn_id` matches. Live ↔
  transcript tool correlation must use this bridge (or turn + position), not
  `call_id == tool_use_id` equality. This is a decoder requirement discovered
  by the probe and pinned by fixture test.
- **rollout identity**: the physical transcript file identity. The rollout
  file name embeds its own uuid. **Collision trap**: for subagent rollouts,
  `session_meta.session_id` inside the file is the PARENT thread id, not the
  agent id — deriving rollout identity from `session_meta.session_id` alone
  would merge parent and child rollouts. Rollout identity must come from the
  file's own uuid (and, in live hooks, from `agent_id` on `SubagentStop`).
- **fork**: new session id; `session_meta.forked_from_id` records the parent;
  ordinals continue the parent's logical sequence (observed fork starting at
  ordinal 20) while the inherited records are NOT copied into the fork file.
- **subagent**: `thread_source: "subagent"`; `source.subagent.thread_spawn`
  carries `parent_thread_id`, `depth`, `agent_path`, `agent_nickname`;
  ordinals restart at 0 in the child rollout.
- **resume/restart**: same session id and same rollout file; the new turn is
  appended; `SessionStart.source = "resume"`.
- **ordinal**: per-rollout physical record position. Because fork continues
  and subagents restart ordinals, ordinal is a valid Transcript Record Key
  component only within one rollout identity, never a logical identity.

Line numbers, array ordinals across files, PIDs, and random trace ids are
never needed as identity — the payload supplies durable ids for every level.

## 5. Path security boundary (observed)

- `transcript_path` is always an absolute path under
  `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`.
- Real files checked on-device: regular files, not symlinks/junctions,
  `realpath == path`, no `..` segments, contained under the sessions root.
- `CODEX_HOME` is configurable (env var), so hard-coded `~/.codex` containment
  is insufficient — the resolver must honor `CODEX_HOME` (SPEC §9 confirmed).
- TOCTOU posture: the path is resolved by the host process before the hook
  spawns, and the rollout writer persists before hook start; the decoder must
  still open the canonical file and re-check containment + type + size
  post-open (SPEC §9 rules stand as written).
- Null `transcript_path` occurs (e.g. non-local thread store) — decoder must
  treat it as `transcript_unavailable`, which the existing adapter already
  tolerates.

No fallback (scanning `~/.codex/sessions` for latest file, guessing) was
needed or used at any point; the authenticated hook payload is a sufficient
and safe source.

## 6. Transcript format contract

Append-oriented JSONL; every line `{timestamp, ordinal, type, payload}`.
Record types observed in real files: `session_meta`, `turn_context`,
`response_item` (`message` role user|assistant|developer,
`reasoning`, `custom_tool_call`/`_output`, `function_call`/`_output`,
`agent_message`), `event_msg` (`task_started`, `item_completed`,
`token_count`, `task_complete`, `thread_settings_applied`), `world_state`,
`compacted`, `inter_agent_communication_metadata`.

Privacy-relevant facts (drive the §11/§12 data policy):

- hidden reasoning is stored as `response_item:reasoning` with
  `encrypted_content` — PD must skip these records entirely;
- `session_meta.base_instructions` holds the host system prompt — skip;
- `world_state` holds AGENTS.md/environment snapshots — skip;
- user-role records are not all human input: host-injected context
  (environment, recommended plugins, skills listings) arrives as
  `role:"user"` with `content_item_kinds[0] != "user.text"`; only
  `content_item_kinds[0] == "user.text"` records are genuine visible user
  turns (correction detection must filter on this, or use the live
  `UserPromptSubmit` prompt as the authoritative user text);
- assistant messages carry `phase`: `commentary` (progress updates) vs
  `final_answer` (the turn's final visible message). `last_assistant_message`
  corresponds to `final_answer`;
- compaction appends a `compacted` record whose `replacement_history` becomes
  the logical history going forward (original records remain in-file before
  it); a replay decoder must treat pre/post-compaction windows correctly —
  the checkpoint must not silently re-import replaced records as new turns;
- incomplete tail is a real distinguishable state (file growth mid-line); the
  malformed/incomplete-tail fixtures pin the distinction.

## 7. Hook runtime budget

- Default command-hook timeout: **600 s** (10 min), minimum 1 s (source:
  `codex-rs/hooks/src/engine/discovery.rs` `normalize_command_hook`); PD's
  plugin declares 5–30 s.
- `SessionEnd`: 1 s default, **3 s hard cap** — never do transcript work there.
- Async hooks: at most 8 concurrent (source: `command_runner.rs`
  `MAX_CONCURRENT_ASYNC_HOOKS`); SessionEnd cancels unfinished background
  hooks at teardown.
- Measured on-device (probe hook, Node 26, Windows): hook subprocess internal
  work (decode JSON + optional tail read + hash + append log) = **2–13 ms**
  per invocation across all events; process spawn overhead aside, the
  SPEC §8 hook budget (≤256 records / 1 MiB, 250 ms stdout margin) has ample
  headroom for the planned decode/normalize/admit/enqueue path.
- Sync `Stop`/`PostToolUse` hooks block the turn loop while running — the
  "no LLM in hook" invariant (SPEC §2.3/§12) remains mandatory.

## 8. Hook configuration discovery (side findings)

- Hooks are configured per layer: user `~/.codex/config.toml` `[hooks.<Event>]`
  tables or `$CODEX_HOME/hooks.json`; project `.codex/config.toml` requires
  project trust; plugins provide `hooks/hooks.json` with `${PLUGIN_ROOT}`
  substitution (the installed PD plugin uses exactly this channel — its four
  hooks ran live during the probe).
- Hook trust: untrusted hooks do not run; trust hashes live in
  `[hooks.state]`; `--dangerously-bypass-hook-trust` bypasses for one
  invocation (probe use only). `codex_hooks` feature flag is deprecated in
  favor of `[features].hooks` (0.150.x).
- Windows hook commands execute via `cmd.exe /C` with the command line
  wrapped in an extra quote pair; commands must therefore use a bare
  executable resolvable on PATH (like the PD plugin's `node ...`) — absolute
  quoted paths with spaces fail to spawn (observed on-device). This is a
  distribution constraint for the Marketplace plugin, already satisfied by
  the current plugin layout.

## 9. Version support decision

- Minimum supported for ingestion: **0.148.0** — first release with
  `SessionEnd` (changelog: "Add SessionEnd hooks for thread teardown",
  PR #33895/#33896); `Stop` has existed since lifecycle hooks shipped
  (0.114.0 beta). On-device fixture evidence captured at 0.148.0 and 0.150.1
  with identical field sets.
- The adapter's existing four-event baseline remains 0.147.0 as declared in
  decoder messages; no consumed field changed between 0.147.0-era payloads
  and 0.150.1 for those events (field-set parity across 0.148.0/0.150.1
  pinned by test; 0.147.0 compatibility retained by the existing decoder
  tests).

## 10. G1 verdict

**GO.** Every SPEC §3 G1 item has on-device evidence and executable fixture
coverage:

1. turn-complete event = `Stop` (§2 above);
2. `Stop` vs `SessionEnd` roles resolved — `Stop` is the reliable event,
   `SessionEnd` is teardown-only with a 1–3 s budget;
3. `transcript_path` non-null in every probed scenario, canonical, and
   already flushed (final assistant record present and hash-identical to
   `last_assistant_message`) when `Stop` runs;
4. durable identity fields for root session, rollout, fork/subagent, turn,
   message, and tool call — plus two documented traps (subagent
   `session_meta.session_id` = parent id; hook `tool_use_id` ≠ transcript
   `call_id`, joined via `item_completed`);
5. timeout/stdout/unknown-field/concurrency behavior pinned (600 s default,
   1–3 s SessionEnd, 8-async cap, `additionalProperties: false` schemas);
6. rotation/compaction/restart/fork/subagent/archive behaviors evidenced
   (`compacted` record from a real archive; resume/fork/subagent probed
   live; no rotation observed — files are append-only per session);
7. canonical session roots verified for the default Windows home; `CODEX_HOME`
   configurability requires a resolver, not a hard-coded path.

Known limitations (recorded, none gate):

- `Interrupt` (0.150.0+) and `PermissionRequest`/`PreCompact`/`PostCompact`
  payloads were not frozen — not needed for the MVP path; compaction is
  handled at the transcript level;
- `codex exec` prints hook status lines only in TTY mode (JSON mode omits
  them) — cosmetic, affects debugging not contracts;
- macOS/Linux roots not probed on-device (no such host available); root
  resolution logic is OS-generic and the Windows root is fixture-backed.
