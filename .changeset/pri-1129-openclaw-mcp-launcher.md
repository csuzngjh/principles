---
'create-principles-disciple': patch
---

PRI-1129: release payloads now ship `plugin/mcp/launcher.cjs` — the entry `openclaw.plugin.json` declares — and the build fails closed when a declared MCP entry is missing; `release-asset-smoke` asserts the extracted payload still contains it. This fixes the PD-side defect only: OpenClaw 2026.10.10 does not materialize plugin manifest `mcpServers`, so `pd_recall` remains unavailable there until the host supports it or an Owner-approved workaround lands.
