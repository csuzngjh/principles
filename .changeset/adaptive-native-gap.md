---
"@principles/core": patch
"@principles/host-runtime": patch
"@principles/codex-adapter": patch
"@principles/workbuddy-adapter": patch
"principles-disciple": patch
"create-principles-disciple": patch
---

Score only authorized principles missing from the current Native prompt. Codex and WorkBuddy use the shared scorer. OpenClaw can use it when its host supplies the current admitted message and ID. Each host has an independent opt-in; legacy OpenClaw mappings keep precedence.
