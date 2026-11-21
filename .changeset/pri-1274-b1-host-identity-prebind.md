---
'@principles/core': minor
'@principles/pd-mcp-server': minor
'@principles/codex-adapter': minor
---

PRI-1274 (B1): host identity prebind and structured-receipt fallback for `pd_submit_pain`

- New unified `HostSubmissionContext` (Core): normalizes host-injected MCP `tools/call` `_meta` (Codex native `threadId`/`sessionId` + optional `x-codex-turn-metadata.turn_id`; namespaced `pd.host-context.v1` for other hosts) with sentinel/shape validation and a fail-closed conflict rule against model-supplied `hostSession` claims.
- `pd_submit_pain` main path: a trusted `_meta` context pre-binds the submission session at the ORIGINAL Pain/Task write. Session binding no longer requires the target turn text (`codex_target_evidence_unavailable` coupling removed); a missing `submissionTurnId` never negates the session.
- New quiet flag `host_identity_minimal_metadata` (default off): the one-time Workspace-level minimal identity-metadata authorization, separate from `codex_conversation_ingestion` and `automatic_pain_submission`. Flag off keeps submissions legally unbound with `blocked_by_consent` (an explicit behavior change for Codex workspaces that previously bound via `_meta` without any authorization — enable the flag to retain prebinding).
- Codex PostToolUse fallback (B1): exact `pd_submit_pain` tool-name match decodes the structured receipt from the MCP envelope (`content[0].text` JSON) and restores the SAME original task via the existing expected-value CAS (`sessionIdHint` + `painIngress.verifiedHostSession` + versioned recovery disposition). `submit_unconfirmed` requires an exact-ID read-back; same-call replay is idempotent; different `toolCallId` is ambiguous; terminal/leased/foreign/conflicting tasks are never mutated; no transcript reads, no free-text recovery.
- `painIngress.verifiedHostSession` now validates `submissionTurnId` and `targetTurnId` independently (historical both-or-neither rows parse unchanged).
