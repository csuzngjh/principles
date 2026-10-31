<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-183",
  "displayId": "ERR-183",
  "title": "Preflight inserted after a side effect it was meant to precede: refusing the install left the Owner OpenClaw gateway stopped with no restart",
  "status": "active",
  "category": "Architecture Boundary Violations",
  "ep": "EP-02",
  "createdAt": "2026-10-31",
  "source": "PR 2251 code review (agent), ordering pinned by source-position test"
}
-->

A hard preflight was inserted to refuse an install before any work is done ("a refusal that costs 0ms instead of 7 minutes"), but it was placed AFTER the OpenClaw gateway block, which may call `stopOpenClawGateway()`. With `--host all`, a live gateway and a running WorkBuddy, the real sequence was: gateway stopped -> preflight refuses -> return via the refusal builder, bypassing the `restartedGateway` restart that only runs at the end of the flow. The Owner's gateway stayed down, and the comment claiming "BEFORE any mutation ... nothing needs recovering" was false.

The defect class: a guard's value is its POSITION in the effect ordering, not its existence. A guard placed after any effect inherits that effect's recovery obligations — and refusal paths return early, so cleanup registered later never runs.

Must check: when adding a preflight, list every side effect that textually precedes the insertion point (process stops, backups, temp dirs, journal rows) and either move the guard before them or make the refusal path unwind them. Pin the ordering with a test: for a property that is invisible at runtime without an expensive fixture, source-position assertion of the guard call vs the side-effect call is legitimate and cheap.
