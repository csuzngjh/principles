---
'create-principles-disciple': patch
---

PRI-922: retire the previous.json ghost slot. The update-chain layout no longer
declares a second pointer, recoverUnfinishedTransaction takes only the journal
plus the active record, and the console recovery endpoint (bundled via this
package) never reads previous.json. Production install/upgrade/rollback/repair
behavior is unchanged for normal installation layouts, where the file has had
no writer since 2026-08-26 and therefore never exists; on a machine with a
leftover or hand-crafted previous.json, recovery decisions now deliberately
ignore it (a fabricated record could previously sway them — closed by
regression tests proving previous.json is not a recovery input).
