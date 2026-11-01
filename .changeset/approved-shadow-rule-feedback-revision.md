---
"@principles/core": patch
"@principles/host-runtime": patch
"create-principles-disciple": patch
"principles-disciple": patch
---

Add an authenticated, bounded feedback revision for approved shadow RuleCode while preserving its artifacts, approvals and existing correction budgets. Provide system-owned recovery control semantics shared by production and replay, with a versioned input contract that rejects new artifacts on older Codex and WorkBuddy gates, so revised rules can preserve official recovery access without inventing command-prefix exemptions. Evaluation now also requires design-approval rules to keep the registered CLI recovery controls reachable.

RuleCode activation identity is now versioned by the immutable artifact (`act_code_<ruleId>_<sha256(artifactId)>`, matching the prompt channel), so a revised artifact can no longer collide with the version it replaces; approving it retires the superseded shadow in the same transaction, with its own control state and an immutable supersede decision.
