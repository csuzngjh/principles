---
"create-principles-disciple": patch
---

WorkBuddy host install no longer deadlocks on an unverifiable same-name `pd-recall` entry (PRI-1249)

A `~/.workbuddy/mcp.json` entry whose ownership cannot be proven (typically a dead absolute `mcp/launcher.cjs` left by an older registration) used to abort the whole WorkBuddy host install at the Gate 4 MCP conflict check. Because `writeWorkbuddyMcpBinding()` runs later in the same method, an already-installed host could then never be re-bound to the new shared runtime: the launcher failed closed with `binding_version_mismatch` and every official remedy re-hit the same gate.

- Only a proven foreign entry (`conflict`) still stops the install. `unverifiable` proceeds, keeps the user's file byte-identical (PD has no writer for it), re-pins `mcp-binding.json` to the installed `@principles/pd-mcp-server` version, and reports the state as a host warning that the installer now prints.
- `mcp-registration-conflict.test.ts` now applies the documented `WORKBUDDY_CONFIG_DIR` isolation recipe. Without it, `resolveWorkbuddyPaths()` preferred the desktop host's ambient config root over the test's sandbox home, so sandboxed installs wrote the real `~/.workbuddy/mcp.json` — the origin of the stale entry.
