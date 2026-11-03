---
'@principles/pd-cli': minor
---

Gate 4 (PRI-1071): `pd health --host <codex|openclaw|workbuddy>` now reports read-only MCP lifecycle diagnostics for the shared `pd-recall` server — installed payload/entry presence, installed version vs Runtime Pin (Codex) or binding pin (OpenClaw/WorkBuddy), PD-owned `mcp-binding.json` schema/host/workspace/canonical-entry/symlink checks, host MCP config registration, and restart-required state. Unknown layers report `unverified` with a reason + next action; the command never spawns the server or executes a business Tool.
