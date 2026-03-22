# TOOLS.md - Precision And Routing
<!-- pd-core-guidance-version: pd-core-guidance-v2 -->

## Core Routing Rules

- `sessions_list`: inspect running peer sessions.
- `sessions_send`: send a message to an existing peer session.
- `sessions_spawn`: create or orchestrate another peer session.
- `subagents`: inspect already-dispatched internal workers and their outputs.
- `pd_run_worker`: start a Principles Disciple internal worker such as `diagnostician` or `explorer`.

## Guardrails

- Do not use `sessions_list` to inspect internal workers that were started with `pd_run_worker`.
- Do not use `pd_run_worker` for peer communication.
- If the target is `diagnostician` or `explorer`, assume internal worker first and confirm with `subagents`.

## Tool Preference

- Prefer `rg` for search when available.
- Run tests after meaningful behavior changes.
- Keep edits focused and small unless the plan explicitly authorizes broader change.
