---
'principles-disciple': minor
---

Gate 4-D/F (PRI-1071): the OpenClaw plugin now ships the read-only `pd-recall` MCP server via its manifest `mcpServers` entry and writes the PD-owned launcher binding (`mcp-binding.json`) beside its payload during the startup health check — from the SAME resolved workspace the hooks use, idempotently, degrading to a structured warning when the installed PD runtime predates the MCP component. Hook/CLI/governance behavior is unchanged; the MCP server is fail-closed (refuses to start without a valid binding) and its unavailability never blocks other PD functions.
