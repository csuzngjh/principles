---
'create-principles-disciple': patch
---

PRI-1129: release payloads now ship `plugin/mcp/launcher.cjs` — the entry `openclaw.plugin.json` declares — and the build fails closed when a declared MCP entry is missing; `release-asset-smoke` asserts the extracted payload still contains it.

The installer now also guarantees the other half of the same user-visible path: OpenClaw sanitizes the MCP child's environment (`PD_WORKSPACE_DIR` / `HOME` are stripped), so `pd-recall` can only locate the governance workspace through `~/.openclaw/principles-disciple.json`. The installer writes that PD-owned declaration on first install, leaves a compatible one byte-identical (idempotent), and refuses before any runtime mutation when an existing declaration names a different workspace or cannot be trusted (no silent overwrite, no cross-workspace recall).

Correction to the earlier diagnosis: OpenClaw 2026.10.10 DOES materialize plugin-manifest `mcpServers`; it loads them lazily on the first agent turn. The real blockers were the missing payload entry and the unreachable workspace declaration.
