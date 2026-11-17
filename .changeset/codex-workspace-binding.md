---
"@principles/install-layout": patch
"@principles/pd-cli": patch
"create-principles-disciple": patch
"principles-disciple": patch
"@principles/workbuddy-adapter": patch
---

Fix two Codex MCP binding defects:

- PRI-1247: Codex install/update/repair now defaults to Codex's own workspace instead of the OpenClaw-oriented detection result (an explicit `--workspace` still wins). A binding that points at another PD host's owned default workspace is treated as a cross-host misbinding by the launcher, the installer health check and `pd health`; `pd mcp probe` now reports the workspace the binding actually serves and refuses an explicit target the binding does not serve.
- PRI-1248: the launcher binding is also written to the host-persistent PLUGIN_DATA location, which the launcher and health checks read first. A same-version cache rebuild, a version upgrade through the supported update chain, or a cold start no longer loses the binding; the payload-local copy remains as the legacy fallback (PRI-1183 repair path preserved).
