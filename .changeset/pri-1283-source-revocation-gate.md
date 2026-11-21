---
"@principles/core": minor
"@principles/host-runtime": minor
"@principles/pd-cli": minor
"@principles/pd-console": minor
"@principles/pd-mcp-server": minor
---

PRI-1283 R2/R3 (SPEC-PD-FEEDBACK-RESILIENCE-001 TECH §2.2): sourceRef
revocation safety gate and persisted excerpt cleanup.

R2 — unified latest-consent read gate over the conversation-ingestion consent
ledger v3 (the single authority): a new `SourceMaterialAuthorizationPort`
(core) with the ledger-backed implementation
`createConsentLedgerSourceMaterialAuthorization` (host-runtime), consulted
PER CALL (no cache) at every consumption entry point — diagnosis context
assembly (evidence entries, correction evidence, promoted evidence window,
governance turn reader, payload sourceRefs), all three split-pipeline model
invocation boundaries (`source_authorization_revoked` blocks the run), the
shared admission re-verification (`evaluateAndPersistAdmissionForWrite` /
internalization orchestrator / consumer cycle), `pd pain recall`, the Console
evidence-chain read model, and the MCP submit assembly (target-turn evidence
and session-verification probes refuse on blocked consent). Unwired ports
fail CLOSED for governance-sourced material; `owner_reported:` / `candidate:`
/ openclaw inline evidence is not consent-governed and unaffected.
`ensureGovernanceContinuation` / `reconcileGovernanceContinuation` now AND the
caller flag with a live ledger read instead of trusting the flag alone.

R3 — `runSourceRevocationSweep` (host-runtime): idempotent, visible,
retryable purge of persisted excerpts for every host whose recorded consent
decision is not granted — governance_observations text/tool facts NULLed and
retention-class expired (the store's no-regain guard makes re-granting NOT
resurrect old excerpts), admission marker payloads redacted, pain_events
text/reason NULLed (the Pain row and its identity survive), task
diagnostic_json evidence entries removed with a truthful
`painIngress.evidenceClass` (`source_revoked` added to the v1 reason enum)
and a non-sensitive `sourceRevocation` audit block, pain_diagnoses and
diagnostician artifacts evidence filtered via row CAS. Wired into
`pd codex setup --decline` / `pd workbuddy setup --decline` (immediate sweep)
and exposed as `pd consent sweep-revoked [--apply] [--json]` (default dry
run); audit trail at `.state/source-revocation-sweep.jsonl` carries metadata
only. Ledger-missing workspaces are not swept (not a revocation) while R2
gates keep blocking; an unreadable ledger fails the sweep loudly.
