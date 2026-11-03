---
'@principles/workbuddy-adapter': minor
---

Gate 4-E/F (PRI-1071): the WorkBuddy plugin payload ships `.mcp.json` (stdio, `${CODEBUDDY_PLUGIN_ROOT}` placeholders — the proven built-in-plugin pattern) exposing the read-only `pd-recall` MCP server; payload version 0.2.1→0.2.2 with `defaultEnabled:false` preserved (install ≠ enable). The installer now writes the launcher binding into the materialized marketplace payload from the frozen governance workspace, skipping with a structured note when the installed PD runtime predates the MCP component.
