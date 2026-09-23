---
'@principles/core': patch
'@principles/pd-cli': patch
---

Principle Ledger write boundary (Phase 1 / PR1): candidate-origin writes to the Principle Ledger now require a validated `recommendation_kind === 'principle'`. Unknown, missing, or malformed kinds are refused fail-closed and reported as an explicit disposition instead of silently collapsing into a principle; candidate persistence, kind routing, and defer handling are unchanged.
