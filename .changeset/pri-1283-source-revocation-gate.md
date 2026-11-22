---
"@principles/core": minor
"@principles/host-runtime": minor
"@principles/pd-cli": minor
"@principles/pd-mcp-server": minor
"@principles/codex-adapter": patch
"@principles/workbuddy-adapter": patch
"create-principles-disciple": patch
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
resurrect old excerpts), admission marker payloads redacted (including the
independent `reason` column and pending-review termination), pain_events
text/reason NULLed for automatic pains (the Pain row and its identity
survive), task diagnostic_json evidence entries removed with a truthful
`painIngress.evidenceClass` (`source_revoked` added to the v1 reason enum)
and a non-sensitive `sourceRevocation` audit block, pain_diagnoses,
diagnostician artifacts, runs.output_payload and pi_artifacts evidence
filtered via row CAS. Wired into `pd codex setup --decline` / `pd workbuddy
setup --decline` (immediate sweep) and exposed as `pd consent sweep-revoked
[--apply] [--json]` (default dry run — truly read-only connections, no schema
init, no WAL/journal writes); audit trail at
`.state/source-revocation-sweep.jsonl` carries metadata only. Ledger-missing
workspaces are not swept (not a revocation) while R2 gates keep blocking; an
unreadable ledger fails the sweep loudly.

Review round 2 hardening (directives A–F): pending Stage-2 reviews of a
revoked host are terminated `abandoned('source_revoked')` by both the sweep
and the claim path (claim-time consent re-validation; pre-classifier claim
verification blocks new model requests after a revocation; in-flight results
are fenced by the decision+claimToken CAS); explicit Owner statements
(`PD记录痛苦：` / `pd pain explicit` / WorkBuddy explicit intake) are
classified by their own provenance and survive the revocation on every read
path (sweep / recall / context assembler / console) and in the intake
re-verification (a historical `admitted` verdict is re-verified against the
latest source authorization before internalization may reuse it); dry runs
are read-only per table with counted-from-write purges and reported audit
failures; the core barrel surface carries only cross-package production
consumers (9 admitted symbols).

Review round 3 (owner_manual classification ruling): an explicit Owner
statement is owner_manual only when its text is credibly Owner-authored —
a direct Owner channel (`codex_explicit_prefix` / `workbuddy_explicit_prefix`
/ `cli_owner_statement` / `openclaw_manual_pain`), or an agent-assisted
`codex_explicit_agent` submission carrying a bound Owner confirmation record
(`ownerConfirmation.kind = owner_verbatim_turn_match` written by the
registration path after verifying the statement VERBATIM against the current
turn's host transcript, fingerprint-bound to the persisted text). A
self-declared `owner_statement` classification or a forged/mismatched
confirmation never exempts: unverified agent submissions persist as
Agent-derived and are governed by the consent ledger on every entry point
(sweep / recall / context assembler / console / admission), consistent under
one shared `isOwnerManualCorrectionEvidence` judgment.

Round 4 hardening (review threads #14/#19/#20/#21): the console evidence-chain redaction now judges STRUCTURED correction evidence via `isOwnerManualCorrectionEvidence` instead of the spoofable summary reason marker; verbatim confirmation additionally requires an authorized source-material ledger for that host; the admission validator accepts legacy unconfirmed `codex_explicit_agent` payloads (empty evidence array tolerated) as Agent-derived so task reconciliation cannot starve on them; and the sweep task probe also matches rows carrying `correctionEvidence` so statement-only governed tasks are evaluated, with the evidenceClass rewrite made rerun-idempotent.
