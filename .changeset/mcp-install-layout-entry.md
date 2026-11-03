---
'@principles/install-layout': patch
---

Gate 4 (PRI-1071): expose the canonical MCP server component path (`mcpServerDir` + `getMcpServerEntry`) so PD-owned binding writers derive `~/.pd/runtime/pd-mcp-server/dist/index.js` from the install-layout SSoT instead of repeating the segment list. The installer keeps a local twin until this version is on the registry (0.4.0 predates the export); the twin is removed in the follow-up release.
