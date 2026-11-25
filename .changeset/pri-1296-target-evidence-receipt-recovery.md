---
'@principles/core': patch
'@principles/codex-adapter': patch
'@principles/workbuddy-adapter': patch
'principles-disciple': patch
---

PRI-1296 — target-turn evidence admission during receipt recovery

Receipt recovery no longer treats a legacy boolean target-text probe or malformed persisted evidence as proof of evidence completeness. Core validates persisted entries and replaces invalid legacy evidence only from a validated exact-target read, rechecks source-material authorization immediately before the write, and persists identity, evidence, evidenceClass, and recovery disposition through the existing single CAS contract. OpenClaw receipt recovery joins before_prompt_build and after_tool_call only through the same host runId and the exact persisted user-turn identity; if that bounded correlation or original-message verification is unavailable, target-dependent tasks remain unbound rather than becoming session-only READY. WorkBuddy and OpenClaw worker cycles reconcile waiting target-evidence tasks before diagnostician candidate selection/execution, using the same host readers and consent-ledger authorization ports as their receipt fallbacks.
