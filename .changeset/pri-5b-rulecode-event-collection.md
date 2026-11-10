---
"@principles/host-runtime": minor
---

`@principles/host-runtime` now owns `collectRuleCodeEventEntries` (5B).

`pd-cli` and `pd-console` each carried a byte-identical copy of the rulecode
event-log collector. Both copies are removed and both hosts now read event log
candidates through this single implementation.

Minor: the package exports a new public name. Behavior is unchanged — the code
was moved verbatim, including directory priority, bad-line handling and
deduplication.
