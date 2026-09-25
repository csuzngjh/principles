---
'create-principles-disciple': patch
'@principles/pd-console': patch
---

PRI-922: retire the previous.json ghost slot. The update-chain layout no longer
declares a second pointer, recoverUnfinishedTransaction takes only the journal
plus the active record, and the console recovery endpoint never reads
previous.json. Production install/upgrade/rollback/repair behavior is
unchanged (the slot had no writer since 2026-08-26); a fabricated
previous.json is now covered by regression tests proving it is not a
recovery input.
