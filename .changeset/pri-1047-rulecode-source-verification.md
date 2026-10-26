---
"@principles/core": patch
"@principles/host-runtime": patch
"@principles/pd-cli": patch
"@principles/pd-console": patch
---

Unify the RuleCode textual-basis anchoring check (continuous verbatim span) across the scribe success boundary and the artificer intent preflight, feed scribe validator rejections back into the next model attempt with cross-epoch freshness, and add one bounded authenticated source-correction recovery per rule candidate that CAS-reopens the original needs_human_review artificer on the new scribe epoch. Leases now count attempts per revision epoch while run ordinals stay globally sequential, so reopened epochs actually receive their original maxAttempts. The authenticated Console gains a source-correct-once entry whose receipt binds the Owner actor, binding revision, artifact digest and stop reason.
