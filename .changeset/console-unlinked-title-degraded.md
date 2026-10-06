---
"principles-disciple": patch
"create-principles-disciple": patch
---

Console approval cards no longer render the internal `unlinked:<artifactId>`
machine id as the card title when the pinned draft artifact has left the
artifact store (PRI-940). Real case: a pending approval pinned to a scribe
revision that a later run superseded showed `unlinked:pi-art-scribe-…` as the
card title, and the Owner could not tell what the card was about. The grouped
model now reports `artifactUnavailable` for such cards; the UI replaces the
machine id with the localized untitled copy and shows a visible note
explaining that the draft original is gone (likely superseded), that
rejecting is a safe choice, and where the raw artifact ID remains reachable
(full-chain view). Approve/edit/reject behavior and the `unlinked:` grouping
key are unchanged.
