---
"@principles/core": patch
"@principles/host-runtime": patch
"principles-disciple": patch
"create-principles-disciple": patch
---

Prompt principle injection now rotates deterministically under the fixed
2000-char budget instead of always packing the oldest prefix, so a live,
eligible, individually-fitting principle can no longer be permanently starved
by its position (PRI-904). The rotation round is the session-local user-turn
ordinal already persisted in the trajectory database — an existing fact, read
through the registered trajectory-store seam — so consecutive rounds advance
by exactly one and N rounds cover all N eligible positions: a bounded
opportunity window with no new persisted scheduling state, no randomness and
no clock. Non-fitting entries no longer terminate the scan; oversized entries
are reported separately; the injection event carries selectionPolicy,
eligibleCount, rotationStartIndex, the round ordinal that produced the
selection, and schema-bounded dropped/oversized activation id lists (max 16)
so truncation is explainable and traceable. The legacy FIFO prefix behavior
remains the rollback baseline whenever no round ordinal is available.
