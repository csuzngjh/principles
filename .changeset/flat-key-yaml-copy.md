---
'@principles/workbuddy-adapter': patch
'@principles/codex-adapter': patch
'@principles/host-runtime': patch
'principles-disciple': patch
'create-principles-disciple': patch
---

Replace dot-path flag instructions ("Set features.host.workbuddy.enabled=true")
with a single-line flow mapping the Owner adds to the EXISTING `features:`
block (`host.workbuddy: {enabled: true}`), plus an explicit statement that the
dotted id is ONE flat key — a nested host:→workbuddy: write is silently a
different key.

Two constraints shaped the copy (both verified against the real code, not
assumed): hook diagnostics collapse every whitespace run, so a multi-line YAML
block reached users flattened into one unparseable line; and every real
config.yaml already has a top-level `features:` key, so pasting a second one
fails with "duplicated mapping key" — which the loader turns into a
`malformed` config and a full fallback to defaults.

Fixed across ALL hosts: workbuddy hook/worker/installer copy, codex hook
(host gate + conversation ingestion), catch-up nextAction, worker paused
status, and the openclaw observer-config loader (which also contrasts the
genuinely-nested internalAgents path). (PRI-1063)
