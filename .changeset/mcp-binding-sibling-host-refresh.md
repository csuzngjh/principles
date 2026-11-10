---
"create-principles-disciple": patch
---

Refresh already-installed sibling host bindings when the shared runtime is replaced. `install()`/update previously ran only the target host's installers, so a default `--host openclaw` update replaced `~/.pd/runtime` (new MCP server) while WorkBuddy's marketplace and engine-cache `mcp-binding.json` stayed pinned to the previous version; WorkBuddy's launcher then failed closed with `binding_version_mismatch:0.2.1!=0.3.2`. OpenClaw self-heals at plugin registration (`ensureMcpBinding`), WorkBuddy has no such runtime path. The install transaction now snapshots the hosts already recorded in `~/.pd/install.json`, and before writing the manifest re-runs each uncovered host's own host installer (best-effort: failures are logged with reason + next action and never roll back a successful host). Codex's binding is unchanged by design: it is generated only by the manual `$pd-control setup` step after a plugin payload update.
