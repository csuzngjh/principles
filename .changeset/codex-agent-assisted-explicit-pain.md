---
'@principles/core': patch
'@principles/host-runtime': minor
'@principles/codex-adapter': minor
'@principles/pd-cli': minor
---

Codex agent-assisted explicit pain registration (no prefix).

When the Owner's current message explicitly asks to create a pain signal and provides the feedback, the agent can now complete the registration itself instead of demanding a `PD记录痛苦：` resend:

- The Codex hook publishes the CURRENT turn's host-verified identity (ids/paths only, never prompt text) to `<workspace>/.state/pd_current_turn_context.json` on every UserPromptSubmit and withdraws it on Stop/SessionStart — after the turn ends the entry fails closed.
- New `pd pain explicit --statement "<Owner 原文>" [--workspace] [--json]` registers through the SAME admission chain as the prefix entry (governance admission marker, explicit 5/hour bucket, diagnostician task ensure, idempotent same-turn convergence). The command takes no lineage flags — lineage comes exclusively from the host-written turn context and is re-validated at registration time.
- Provenance is auditable: agent-assisted registrations carry `channel: codex_explicit_agent` and an "agent-assisted, no prefix" pain reason, distinct from the hook-read `codex_explicit_prefix` channel (additive literal in the shared PainCorrectionEvidence schema; prefix behavior byte-identical).
- The `pd-pain-signal` skill now mandates agent-assisted registration for explicit no-prefix requests (verbatim Owner words only, receipt-idempotency check first, honest failure reporting); the "ask the Owner to resubmit" absolute rule is retired, and `pd pain record` remains the post-hoc operator recovery path.
