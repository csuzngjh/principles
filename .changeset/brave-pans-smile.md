---
'@principles/pd-mcp-server': minor
---

Gate 4-B: add the production PD MCP Server package (SPEC-PD-MCP-GATE4-001 v1.2, PRI-1071).

- One shared MCP server implementation for the Codex / OpenClaw / WorkBuddy host plugins; each host spawns its own process around this module.
- Single read-only tool `pd_recall_principle_pains` with an honest `readOnlyHint: true`; business data flows exclusively through the Gate 3 Capability public subpath `@principles/core/runtime-v2/pain-recall-capability` (OD-A v1 disclosure).
- Strict input contract at the protocol layer (principleId 1..200 required, limit 1..10 default 3, every other property rejected); capability re-validates field-by-field.
- Single text content block, no structuredContent; 32 KiB UTF-8 response budget (32768 passes, 32769 → `unavailable` + `response_budget_exceeded`, isError, never silently truncated); 10 s deadline with late-result suppression, bounded orphan tracking and verified resource release (no underlying-cancellation claim).
- isError mapping per SPEC §4.8 (disclosure assertion failure and Adapter execution failures only); sanitized stderr-only JSON logging; stdout carries MCP protocol messages only; fail-closed startup workspace binding via `PD_MCP_WORKSPACE_DIR` (no cwd/HOME fallback), exit 1 before initialize when the binding is invalid.
- SDK frozen to `@modelcontextprotocol/server@2.4.0` (exact pin; interop matrix with v1-family host clients 4/4); architecture guard tests pin: Core has no MCP SDK dependency, capability-subpath-only business access, no CLI subprocess queries, pd-cli independence, exact version pins.
