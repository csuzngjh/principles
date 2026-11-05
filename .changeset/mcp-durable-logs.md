---
"@principles/pd-mcp-server": minor
"@principles/pd-cli": minor
"principles-disciple": patch
"create-principles-disciple": patch
"@principles/workbuddy-adapter": patch
---

PD MCP now writes durable, sanitized JSONL evidence by default to `~/.pd/logs/mcp`
(one file per process, 2 MiB/file, 64 MiB/directory, 14 days). Set `PD_MCP_LOG=0`
to disable it with zero writes.

Events: `launcher_start`, `startup`, `initialize`, `tools_list`, `tool_call`,
`shutdown` and `startup_failure` (a pre-handshake exit now leaves PD-side
evidence). Logging failures are swallowed: tool results, stdout protocol purity,
the 32 KiB budget and the 10 s deadline are unchanged.

New export command: `pd mcp logs export [--days 7] [--out <zip|dir>]` bundles the
recent logs plus a README/manifest into one zip ≤20 MiB for offline analysis.
