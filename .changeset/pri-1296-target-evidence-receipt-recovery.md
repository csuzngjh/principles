---
'@principles/core': patch
'@principles/codex-adapter': patch
'@principles/workbuddy-adapter': patch
'principles-disciple': patch
---

PRI-1296 — target-turn evidence admission during receipt recovery

Receipt recovery no longer treats a legacy boolean target-text probe as proof of evidence completeness. Core now requires structured exact target-turn entries, validates them, rechecks source-material authorization immediately before the write, and persists identity, evidence, evidenceClass, and recovery disposition through the existing single CAS contract. WorkBuddy and OpenClaw worker cycles reconcile waiting target-evidence tasks before diagnostician candidate selection/execution, using the same host readers and consent-ledger authorization ports as their receipt fallbacks.
