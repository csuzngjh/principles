---
"principles-disciple": patch
"create-principles-disciple": patch
---

Console approval cards no longer render the internal `unlinked:<artifactId>`
machine id as the card title on the second path that still produced it
(PRI-941). PRI-940 closed the case where the pinned draft artifact has left the
artifact store; an artifact row that still exists can degrade the same way — its
content yields no extractable description and its lineage resolves to nothing,
so the grouping key becomes `unlinked:<artifactId>` while `artifactUnavailable`
stays unset, and that machine id was used as the Owner-visible title. The UI
title rule now refuses any title shaped like the synthesized grouping key, and a
card whose title actually degraded states both reasons ("lineage cannot be
resolved to a principle, and no readable title could be extracted from its
stored content") instead of going blank without explanation — a candidate that
does have a readable title gets no warning. `artifactUnavailable` keeps its
original meaning: the PRI-940 wire contract still asserts that an existing
artifact carries no such flag. Approve/edit/reject behavior, the `unlinked:`
grouping key and the ledger itself are unchanged.
