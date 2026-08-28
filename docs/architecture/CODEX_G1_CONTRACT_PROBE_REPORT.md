# Codex G1 Contract Probe Report — Governance Closure Slice 0

- **Status:** G1 = GO (after the review-round-1 evidence completion; see the
  evidence map in §10 for exactly which statements are on-device evidence,
  which are source-backed contract, and which are executable tests)
- **Date:** 2026-08-28 (rev 2: evidence-completion fixes after Owner review of PR #1440)
- **SPEC:** `docs/superpowers/specs/2026-08-28-codex-governance-closure-spec.md` §3 (G1), rev 2 (merged as PR #1437)
- **Fixtures:** `packages/codex-adapter/tests/fixtures/g1-contract/` (see its README for provenance and sanitization)
- **Executable evidence:** `tests/g1-contract-fixtures.test.ts` (28 tests, on-device fixtures) + `tests/g1-host-runtime-contract.test.ts` (10 tests, runtime contract)

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

**`Stop` is the turn-complete event.** Evidence class: on-device probe +
source cross-check.

1. `Stop` fires once per completed turn — after the final assistant message
   of the turn, including turns that contained tool calls (tool sub-steps do
   not fire Stop; verified in runs with one `echo` tool call → exactly one
   Stop) — **on-device**.
2. The `Stop` payload carries `last_assistant_message`, and at hook-invocation
   time the rollout file **already contains the matching final assistant
   record**: the probe compared sha256 of the payload message against the
   `response_item` `message` `role:assistant` `phase:final_answer` record in
   the file — identical, with matching `turn_id` linkage, on both 0.148.0 and
   0.150.1 — **on-device, executable** (`g1-contract-fixtures.test.ts`).
3. Flush ordering is structural, not racy: the hook's `transcript_path` is
   resolved through `Session::hook_transcript_path()`, which first
   materializes/persists the rollout (`ensure_rollout_materialized`) and only
   then spawns the hook subprocess (source: `codex-rs/core/src/hook_runtime.rs`
   `run_turn_stop_hooks`; `codex-rs/rollout/src/recorder.rs` `persist`) —
   **source-backed**, consistent with the on-device snapshot ordering.
4. `SessionEnd` is **not** a turn-complete substitute: it fires at thread
   teardown (in `codex exec`, after the final `task_complete` record is
   appended), its payload has no `turn_id`/`model`/assistant fields, and its
   hook budget is 1 s default / 3 s hard cap (source:
   `codex-rs/hooks/src/events/session_end.rs`; budget pinned in
   `hook-runtime-contract.json` + executed by the runtime-contract test) —
   **on-device payload evidence + source-backed budget**.
5. `Stop` also delivers `stop_hook_active` (continuation-loop guard) and, for
   thread-spawned subagents, a `SubagentStop` variant — **on-device**.

The implementation must register only `Stop` for turn completion; registering
both `Stop` and `SessionEnd` for the same purpose is unnecessary (SPEC §8).

## 3. Event contract (installed reality)

Evidence class: **on-device** (payloads frozen as fixtures; field sets pinned
by test). Events observed firing in `codex exec` mode:

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
MVP path. Official generated JSON schemas (input side
`additionalProperties: false`) live in the Codex source at
`codex-rs/hooks/schema/generated/`.

## 4. Identity contract

Evidence class: **on-device**, with the two traps pinned as executable tests.

- **root session**: payload `session_id` == `session_meta.session_id` for root
  rollouts == ThreadId.
- **turn**: payload `turn_id` == `turn_context.payload.turn_id` in the
  transcript == the `turn_id` inside message metadata of every record
  produced in that turn.
- **message/item**: `response_item.payload.id` (`msg_*`, `ctc_*`, `ctco_*`,
  `fc_*`, `fco_*`, `amsg_*`) — globally unique, safe Logical Observation Key
  component.
- **tool (two id spaces)**: the hook's `tool_use_id` (e.g. `exec-<uuid>` for
  the shell tool, reported as `tool_name: "Bash"`) is a different id space
  from the transcript's model-level `call_id` (`call_*`). The bridge is the
  `event_msg` `item_completed` record wrapping a `CommandExecution` whose
  `item.id` equals the hook `tool_use_id` and whose `turn_id` matches. Pinned
  by test (`hook tool_use_id joins the transcript through the item_completed
  bridge`).
- **rollout identity**: the physical transcript file identity. The rollout
  file name embeds its own uuid. **Collision trap**: for subagent rollouts,
  `session_meta.session_id` inside the file is the PARENT thread id, not the
  agent id — deriving rollout identity from `session_meta.session_id` alone
  would merge parent and child rollouts. Pinned by test.
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

## 5. Hook runtime contract (SPEC G1 item 5)

Evidence class: **source-backed, executed** (`hook-runtime-contract.json` +
`g1-host-runtime-contract.test.ts`), with the empty-stdout case proven
on-device by the probe hook itself.

- **Timeout**: command hooks default 600 s (floor 1 s); `SessionEnd` defaults
  to 1 s and is hard-capped at 3 s with clamping
  (`codex-rs/hooks/src/engine/discovery.rs` `normalize_command_hook`,
  `codex-rs/hooks/src/events/session_end.rs`). Executed: the PD plugin's
  declared hooks all carry timeouts inside the budget and declare no
  `SessionEnd` hook at all (deferred per SPEC §2/§8).
- **Stdout schema**: every hook output wire struct is
  `#[serde(deny_unknown_fields)]`
  (`codex-rs/hooks/src/schema.rs`), and a non-JSON-looking or unknown-field
  stdout makes Codex fail the whole hook run for sync control handlers
  (`codex-rs/hooks/src/engine/output_parser.rs` + `events/stop.rs`
  `parse_completed`). Empty stdout is a legal no-op (`Completed`), proven
  on-device by the probe hook. Executed: the PD encoder's outputs (allow and
  deny forms, all four registered events) are validated field-by-field
  against the frozen official output schemas, and the PD-side whitelist
  (`codexOutputFieldsAreWhitelisted`) is proven to reject unknown fields
  before Codex would fail the run. Deny on non-`PreToolUse` events is
  rejected by the encoder itself (those schemas carry no
  `permissionDecision`).
- **Unknown-field behavior, input side**: every hook input schema sets
  `additionalProperties: false` — Codex never sends unknown top-level input
  fields on the versions under contract.
- **Concurrent invocation**: sync hooks run inline and block the turn loop;
  async hooks are capped at 8 concurrent
  (`codex-rs/hooks/src/engine/command_runner.rs`
  `MAX_CONCURRENT_ASYNC_HOOKS`) and unfinished async hooks are cancelled at
  teardown. PD runs sync hooks only (executed: the plugin declares no
  `async` handler), which is also the SPEC §12 precondition for in-hook
  admission + durable enqueue.
- **Trust/discovery side facts** (recorded in the probe, §8 below):
  untrusted hooks do not run; the Windows `cmd.exe /C` quoting constraint
  requires PATH-resolved executables — satisfied by the plugin's current
  `node …` form (observed live).

## 6. Transcript format and lifetime (SPEC G1 item 6)

Evidence class: **on-device** for record shapes and failure modes; **source-backed
+ executed** for rotation/lifetime.

Record types observed in real files: `session_meta`, `turn_context`,
`response_item` (`message` role user|assistant|developer, `reasoning`,
`custom_tool_call`/`_output`, `function_call`/`_output`, `agent_message`),
`event_msg` (`task_started`, `item_completed`, `token_count`, `task_complete`,
`thread_settings_applied`), `world_state`, `compacted`,
`inter_agent_communication_metadata`.

Privacy-relevant facts (drive the §11/§12 data policy):

- hidden reasoning is stored as `response_item:reasoning` with
  `encrypted_content` — the decoder must identify these records in order to
  skip them before any persistence;
- `session_meta.base_instructions` holds the host system prompt — skipped;
- `world_state` holds AGENTS.md/environment snapshots — skipped;
- user-role records are not all human input: host-injected context
  (environment, recommended plugins, skills listings) arrives as
  `role:"user"` with `content_item_kinds[0] != "user.text"`; only
  `content_item_kinds[0] == "user.text"` records are genuine visible user
  turns;
- assistant messages carry `phase`: `commentary` vs `final_answer`;
  `last_assistant_message` corresponds to `final_answer`;
- compaction appends a `compacted` record whose `replacement_history` becomes
  the logical history going forward; the fixture pins the shape
  (`compacted-marker.jsonl`) and a checkpoint must not re-import replaced
  records as new turns;
- rollback appends a `ThreadRolledBack` marker (`num_turns`) that truncates
  effective logical history while physical records remain
  (`codex-rs/core/src/thread_rollout_truncation.rs`) — recorded in the
  runtime contract for the Slice A decoder.

**Rotation/archive — source-pinned fact**: there is **no rotation mechanism**
in `codex-rs/rollout` — one rollout file per rollout identity, opened
append-only for the file's lifetime; closed rollouts stay in place under
`sessions/YYYY/MM/DD` (the Desktop app's `archived_sessions` directory is a
user-facing archive copy, not a writer mechanism). The only "history
rewrites" are appended marker records (`compacted`, `ThreadRolledBack`).
Consequence: checkpoint/tail handling never tracks file replacement — only
growth, marker interpretation, and incomplete-tail retry. Pinned in
`hook-runtime-contract.json` and executed by the runtime-contract test.

**Incomplete tail vs malformed record**: real distinguishable states, pinned
by the `malformed-line.jsonl` / `incomplete-tail.jsonl` fixtures and tests.

## 7. Path security boundary

Evidence class: **on-device (Windows)** + **source-backed resolution rules
(all OSes)**.

- `transcript_path` is always an absolute path under
  `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`.
- Real files checked on-device: regular files, not symlinks/junctions,
  `realpath == path`, no `..` segments, contained under the sessions root.
- **Root resolution (all three OSes)**, source-pinned from
  `codex-rs/utils/home-dir/src/lib.rs` `find_codex_home`: `CODEX_HOME` env,
  when set and non-empty, must already exist and be a directory (fatal error
  otherwise) and is canonicalized; when unset, the home comes from the
  `dirs` crate `home_dir()` — Windows `%USERPROFILE%`, macOS `$HOME`, Linux
  `$HOME` (passwd fallback) — plus `.codex`, and the default branch does not
  verify existence. There is a single OS-generic implementation with no
  per-OS branching beyond `home_dir()`. Executed: the frozen per-OS roots and
  layout rules are pinned in `hook-runtime-contract.json` and asserted by
  test, including the Windows on-device shape.
- The decoder must still honor `CODEX_HOME` (never hard-code `~/.codex`),
  open the canonical file, and re-check containment + type + size post-open
  (SPEC §9 rules stand as written).
- Null `transcript_path` occurs (e.g. non-local thread store) — decoder must
  treat it as `transcript_unavailable`.

No fallback (scanning `~/.codex/sessions` for latest file, guessing) was
needed or used at any point; the authenticated hook payload is a sufficient
and safe source.

**macOS/Linux on-device probes remain a recorded follow-up** (see §10): the
resolution *rules* above are source-pinned and OS-generic, which is what item
7's "canonical session roots" contract is executed against; on-device
fixtures for those platforms gate *release support* for them, not Slice 0.

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
  wrapped in an extra quote pair; commands must use a bare executable
  resolvable on PATH (like the PD plugin's `node ...`) — absolute quoted
  paths with spaces fail to spawn (observed on-device).

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
- **Drift-detection boundary (stated precisely):** the frozen fixtures and
  contract tests make the *repository's* contract executable — they fail
  loudly when a fixture or contract statement is edited without re-capture.
  They cannot automatically detect a future upstream Codex change (a new
  Codex version does not re-run these tests). Upstream drift detection is the
  Slice A supported-version guard plus re-running this probe when adopting a
  new Codex version (fixtures must then be regenerated and this report
  updated).

## 10. G1 verdict and evidence map

**GO**, with the evidence classified per SPEC §3 G1 item:

| # | SPEC G1 item | Evidence class | Where |
| --- | --- | --- | --- |
| 1 | exact event after each completed assistant turn | on-device | probe runs; §2 |
| 2 | `Stop` vs `SessionEnd` vs other released events | on-device + source | §2; budget executed in runtime-contract test |
| 3 | `transcript_path` non-null + flushed before hook | on-device, executable | sha256 match tests (both versions) |
| 4 | stable identity fields (root/rollout/fork/turn/message/tool) | on-device, executable | fixture tests incl. both traps |
| 5 | timeout, stdout schema, unknown-field, concurrency | source-backed, executed + on-device empty-stdout | §5; `hook-runtime-contract.json`; 10 runtime-contract tests |
| 6 | rotation/compaction/restart/fork/subagent/archive | on-device (shapes) + source-backed (lifetime) | §6; `compacted` fixture; append-only pinned |
| 7 | canonical session roots, default + configured home, Win/macOS/Linux | source-backed rules, executed; Windows shapes on-device | §7; `hook-runtime-contract.json` sessionRoots |

Completion-criterion statement: every item above is backed by checked
fixtures from the minimum (0.148.0) and current (0.150.1) supported Codex
versions, or — for the Codex-internal runtime behavior and non-Windows roots
that an on-device probe cannot exercise from this machine — by source-backed
contract fixtures from the official checkout, each executed by a test. The
selected turn-complete event (`Stop`) and minimum version (0.148.0) are
recorded for the ADR amendment at G0.

Known follow-ups (recorded, not G1-blocking under the classification above):

- macOS/Linux on-device probe fixtures are required before those platforms
  are *release-supported* for ingestion; tracked as a Slice D/R1 rollout
  prerequisite, not as silent scope dropping.
- `Interrupt` (0.150.0+) and `PermissionRequest`/`PreCompact`/`PostCompact`
  payloads are not frozen — not needed for the MVP path.
- `codex exec --json` mode omits hook status lines (TTY-only) — cosmetic.
