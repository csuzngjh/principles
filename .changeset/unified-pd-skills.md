---
"principles-disciple": patch
"@principles/pd-cli": patch
"create-principles-disciple": patch
"@principles/workbuddy-adapter": patch
---

Unify PD host skills around four consistent capabilities, clarify Owner governance and evidence boundaries, and align the published skill bundles and Codex recovery guidance.

Review-round additions: `pd run list/show` gain an optional `--workspace` (governance-workspace reads independent of cwd); Codex skills route every shipped script through `pd-locate.cjs --exec` — one authoritative locator that resolves the plugin root once, fails loud on marketplace ambiguity or a missing script instead of silently falling back to an older version; WorkBuddy near-miss explicit-statement prefixes get an actionable format notice; `pd-review` startup text no longer presents CLI approval as an agent fallback.