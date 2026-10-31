---
'@principles/workbuddy-adapter': patch
'@principles/codex-adapter': patch
'@principles/host-runtime': patch
'principles-disciple': patch
'create-principles-disciple': patch
---

Replace dot-path flag instructions ("Set features.host.workbuddy.enabled=true")
with paste-ready flat-key YAML snippets plus an explicit warning that the
dotted flag id is ONE flat key — a nested host:→workbuddy: write is silently
a different key. Fixed across ALL hosts: workbuddy hook/worker/installer
copy, codex hook (host gate + conversation ingestion), catch-up nextAction,
worker paused status, and the openclaw observer-config loader (which also
contrasts the genuinely-nested internalAgents path). (PRI-1063)
