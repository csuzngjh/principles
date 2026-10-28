---
"create-principles-disciple": patch
"@principles/workbuddy-adapter": patch
---

WorkBuddy plugin hook wrapper now arms a self-deadline strictly below the hooks.json host timeout and kills a hung adapter child itself, degrading non-blocking (exit 1 + bounded stderr, P02) instead of leaving the outcome to the host's undefined hook-timeout semantics. Rationale (2026-10-28 incident follow-up): the adapter entry's own fail-open exits can never run when the host kills the wrapper mid-flight, so the "UserPromptSubmit failure never blocks" guarantee was unenforceable on the timeout path. Budgets: UserPromptSubmit 12s under a narrowed 15s host timeout (prompt loss is the costliest channel), every other event 25s under the unchanged 30s; a guard test locks every wrapper budget below its hooks.json timeout, and a real-process test proves the kill/degrade path end-to-end (EP-04). Bumps the WorkBuddy plugin manifest 0.2.0 → 0.2.1 (bump-on-content-change convention, #2108) and records the timeout-path semantics in SPEC §4.4.
