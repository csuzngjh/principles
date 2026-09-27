---
"@principles/core": patch
"@principles/host-runtime": patch
"principles-disciple": patch
---

Prompt principle injection now rotates deterministically under the fixed
2000-char budget instead of always packing the oldest prefix, so a live,
eligible, individually-fitting principle can no longer be permanently starved
by its position (PRI-904). The round key is derived from the host run/turn
identity that already rides the injection event (no new persisted cursor,
no randomness); non-fitting entries no longer terminate the scan; oversized
entries are reported separately; the injection event carries selectionPolicy,
eligibleCount, rotationStartIndex and bounded dropped/oversized activation id
lists so truncation is explainable. The legacy FIFO prefix behavior remains
the rollback baseline whenever no round key is available.
