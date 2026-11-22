---
"create-principles-disciple": patch
"@principles/workbuddy-adapter": patch
---

WorkBuddy installs are usable out of the box (Owner-requested, 2026-11-22).

`@principles/workbuddy-adapter`: the shipped plugin manifest now declares
`defaultEnabled: true` instead of `false`. The installer's existing rule is
unchanged — an explicit boolean already in `settings.json` always wins — so an
Owner who disabled PD stays disabled, while a fresh install no longer needs a
manual trip to the plugin manager. Enabling the plugin also loads its bundled
`.mcp.json`, which is the only path that makes the pd-recall MCP server
available without a separate trust decision (verified against the engine: the
`mcp-approvals.json` trust store is consulted only for USER-level
`~/.workbuddy/mcp.json` entries, never for plugin-declared servers).

`create-principles-disciple`: install/update now removes a LEGACY user-level
`pd-recall` entry from `<config>/mcp.json` when — and only when — the existing
read-only classifier proves PD ownership from the launcher bytes. Such an entry
is a different MCP origin: it would demand a manual trust gesture AND duplicate
the plugin's own server in the MCP list, so an upgraded machine would still
look broken. A byte-identical backup (`mcp.json.pd-legacy-<ts>.bak`) is written
first, every other key/format is preserved, and a cleanup failure is reported
as an install warning — never as an install failure. An unprovable or foreign
same-name entry is still left untouched (Gate 4 conflict semantics unchanged).
