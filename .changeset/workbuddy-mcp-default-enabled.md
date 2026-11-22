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

`create-principles-disciple`: after a successful install/update commit, a
LEGACY user-level `pd-recall` entry in `<config>/mcp.json` is removed when —
and only when — the read-only classifier proves PD ownership from the launcher
bytes AND the plugin-side replacement is usable (the plugin ended enabled,
its installed payload declares `pd-recall`, and the launcher binding was
written). Such an entry is a different MCP origin: it would demand a manual
trust gesture AND duplicate the plugin's own server in the MCP list, so an
upgraded machine would still look broken. The cleanup runs post-commit so a
rolled-back install leaves `mcp.json` byte-identical; a permission-preserving
byte backup (`mcp.json.pd-legacy-<ts>.bak`) is written first, and the
replacement is guarded by the snapshot bytes so a concurrent host save is
refused rather than overwritten. Every other key and server entry is kept —
the file is rewritten in canonical JSON form. When the substitute is not
proven (e.g. the Owner's explicit disable was preserved), the legacy entry
stays and the install reports why instead of enabling the plugin behind the
Owner's back. A cleanup failure is a warning, never an install failure, and an
unprovable or foreign same-name entry is still left untouched (Gate 4
conflict semantics unchanged).
