---
"@principles/install-layout": patch
"@principles/pd-mcp-server": patch
"@principles/workbuddy-adapter": patch
"principles-disciple": patch
---

Experiment isolation hardening for the real OpenClaw host E2E:

- the MCP launcher refuses an experiment (`PD_EXPERIMENT_ROOT`) whose `PD_MCP_LOG_DIR` is missing or outside the root, and refuses a binding whose workspace is outside the root;
- the experiment launcher pins `PD_MCP_LOG_DIR`, validates the OpenClaw profile's per-agent workspaces, and materializes a canonical `.pd/install.json` runtime layout under the experiment root (removing the `pd_cli_entry_missing` root cause);
- the launcher's path canonicalization now handles not-yet-created directories (8.3 vs long path forms) instead of misclassifying them as outside the root.
