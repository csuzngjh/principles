---
"principles-disciple": patch
"create-principles-disciple": patch
---

Console approval cards no longer render the internal `unlinked:<artifactId>`
machine id as the card title on the second path that still produced it
(PRI-941). PRI-940 closed the case where the pinned draft artifact has left the
artifact store; a readable artifact can degrade the same way — its content holds
no extractable description and its lineage resolves to nothing, so the grouping
key becomes `unlinked:<artifactId>` while `artifactUnavailable` stays unset, and
that machine id was used as the Owner-visible title. The same happens to every
unmapped group when the principle ledger cannot be read. The UI title rule now
refuses any title shaped like the synthesized grouping key, and a card whose
title actually degraded states its reason ("readable, but lineage cannot be
resolved to a principle") instead of going blank without explanation — a
candidate that does have a readable title gets no warning. `artifactUnavailable`
keeping its original meaning is deliberate: the wire contract from PRI-940 still
asserts that a readable artifact carries no such flag. Approve/edit/reject
behavior, the `unlinked:` grouping key and the ledger itself are unchanged.
