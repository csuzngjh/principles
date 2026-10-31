---
'@principles/workbuddy-adapter': patch
'@principles/host-runtime': patch
'create-principles-disciple': patch
---

Replace dot-path flag instructions ("Set features.host.workbuddy.enabled=true")
with paste-ready flat-key YAML snippets plus an explicit warning that the
dotted flag id is ONE flat key — a nested host:→workbuddy: write is silently
a different key. Hook skip diagnostics, worker paused statuses, and the
installer's disable nextAction are updated. (PRI-1063)
