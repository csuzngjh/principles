# G1 Contract Fixtures — Codex Governance Closure Slice 0

These fixtures are the frozen G1 evidence required by
`docs/superpowers/specs/2026-08-28-codex-governance-closure-spec.md` §3 (G1) and
`docs/architecture/CODEX_G1_CONTRACT_PROBE_REPORT.md`. They are derived from
**real on-device Codex runs**, not hand-written ideal payloads.

## Provenance

- Current version: `codex-cli 0.150.1` (npm global install, Windows 10.0.26200 x64)
- Minimum version: `@openai/codex 0.148.0` (via `npx`)
- Probe method: user-layer `~/.codex/hooks.json` command hooks (temporary,
  removed after the probe) started with `codex exec
  --dangerously-bypass-hook-trust`; each hook subprocess recorded the exact
  stdin payload and, for `Stop`/`SubagentStop`/`SessionEnd`, a transcript
  flush snapshot (size, line count, last-record type, final assistant message
  hash).
- `manifest.json` records runs, versions, and the full sanitization list.

## Contents

### `hook-payloads/v0.150.1/` and `hook-payloads/v0.148.0/`

One real payload per event (`01`–`07`; `06-subagent-stop.json` exists for
0.150.1 only). Field sets are identical across both versions for every shared
event.

### `transcripts/`

| File | Source run | What it proves |
| --- | --- | --- |
| `normal-tool-final-turn.jsonl` | A (+ later resume C) | Ordinary turn: user `user.text` message, commentary + `final_answer` assistant messages, `custom_tool_call`/`_output` pair, `event_msg:item_completed` bridge, turn linkage. Run C resumed this same rollout, so the file also carries the appended second turn — that append is the resume evidence |
| `fork.jsonl` | B (fork of A) | New session id + `forked_from_id`; ordinals continue from the parent, inherited records are not copied |
| `subagent-parent.jsonl` / `subagent-child.jsonl` | D | Subagent rollout: `thread_source: "subagent"`, `source.subagent.thread_spawn` lineage, ordinals restart at 0, `session_meta.session_id` equals the **parent** thread id while the filename uuid is the agent id |
| `min-version-0.148.0.jsonl` | E | Minimum-version transcript structure |
| `compacted-marker.jsonl` | real desktop archive | `compacted` record shape with `replacement_history` (all message texts replaced) |
| `malformed-line.jsonl` | mutation of A | Permanently invalid middle line (documented transformation) |
| `incomplete-tail.jsonl` | mutation of A | Final line cut mid-JSON, no trailing newline (retryable tail) |

## Tool identity: two id spaces joined by one bridge

The live hook's `tool_use_id` (for the shell tool: `exec-<uuid>`, reported as
`tool_name: "Bash"`) is **not** the transcript's model-level
`custom_tool_call.call_id` (`call_<opaque>`). Both live in the same rollout:

- `response_item` `custom_tool_call` / `custom_tool_call_output` join each
  other through `call_id` (model id space);
- `event_msg` `item_completed` wraps a `CommandExecution` whose `item.id`
  equals the hook's `tool_use_id` (execution id space) and carries the same
  `turn_id`.

Any live-hook ↔ transcript tool correlation must go through the
`item_completed` bridge (or turn + position), never by assuming
`call_id == tool_use_id`.

## Sanitization

All fixtures were produced by a generator that removed or replaced every
class of content the SPEC excludes from governance observation:

- username path segments (`<user>`), probe workspace path (`D:\ws\probe`);
- `session_meta.base_instructions` (host system prompt), `git`,
  `context_window`;
- `world_state`, `inter_agent_communication_metadata` records;
- `response_item:reasoning` records (hidden reasoning — Codex stores reasoning
  encrypted; the encrypted blobs are not fixtures);
- developer/system-role messages; host-injected user-role context (anything
  whose `content_item_kinds[0]` is not `user.text`);
- `turn_context.collaboration_mode` (contains developer instructions);
- encrypted blobs (`gAAAAAB…`) found inside tool arguments;
- oversized tool outputs truncated; `token_count` records dropped.

The fixture sessions themselves used synthetic probe prompts
(`FIXTURE-A-DONE` etc.), so no real Owner conversation is present.

## Consumer contract

`tests/g1-contract-fixtures.test.ts` validates the frozen invariants
(payload field sets, Stop↔transcript final-message agreement, fork/subagent
lineage, malformed/incomplete-tail distinguishability). Slice A's decoder
tests must build on these same fixtures; changing a fixture requires
re-running the on-device probe and recording it in the G1 report.
