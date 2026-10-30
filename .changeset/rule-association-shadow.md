---
'@principles/core': patch
---

Rule association shadow contracts + router source evidence (SPEC-RULE-ASSOCIATION-005).

- Diagnostician output gains an opt-in V2 shadow shape: a rule recommendation may
  carry `principleAssociation` (`linked` with `recommendation_ref` /
  `canonical_principle` target, or `unresolved` with a fixed reason), plus a
  `recommendationRef` on every recommendation. V1 generation and validation are
  unchanged — nothing is promoted, and each association is marked
  `authorizesGeneration: false`.
- The diag router now records system-owned invocation evidence (message,
  system prompt and predecessor artifact digests, never model output) and writes
  a `trustedContextReceipt` (`router-context-v1`) into the committed diagnostician
  content, re-verified at the write boundary before the commit proceeds. The
  receipt reports `canonicalPrinciples.status = 'unavailable'` because the router
  has no system-owned canonical Principle allowlist; source association therefore
  stays in shadow.
- Rollback: revert this change — no persisted schema, flag or migration is added,
  and the extra receipt key is additive on the V1 envelope.
