---
'principles-disciple': patch
'@principles/pd-cli': patch
'create-principles-disciple': patch
'@principles/pd-mcp-server': patch
---

Gate 4 (PRI-1071) third remediation round — context isolation, real rollback acceptance, and registration-conflict safety:

- OpenClaw: the host-wide `mcp-binding.json` is written only from an explicitly declared PD workspace (`PD_WORKSPACE_DIR` / `OPENCLAW_WORKSPACE` / `principles-disciple.json`). Without one, the stale binding is removed and `pd-recall` fails closed (`binding_missing`) instead of binding the `main` agent's workspace for every agent. Per-agent hooks keep their existing workspace resolution.
- WorkBuddy installer: unchanged transaction semantics, now proven by a real fault injection — a read-only `installed_plugins.json` fails the registration commit after the cache swap, and the previous cache/binding/settings/registry are restored byte-for-byte, after which the real launcher still completes initialize / tools/list / tools/call.
- All three hosts: a same-name MCP registration owned by another server stops the install/setup BEFORE any config, binding, or cache write; a PD-owned same-name entry is reused idempotently; different names coexist; malformed or unattributable configs fail closed. `pd health` reports `CONFIG_DRIFT` with `mcp_same_name_conflict` / `mcp_registration_unverifiable`.
- `pd-mcp-server` startup logs a workspace fingerprint (SHA-256 prefix, never the path) so operators and acceptance runs can prove which workspace a process bound.
