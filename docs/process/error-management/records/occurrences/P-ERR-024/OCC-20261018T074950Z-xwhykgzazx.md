<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "occurrence",
  "occurrenceId": "OCC-20261018T074950Z-xwhykgzazx",
  "patternRecordId": "P-ERR-024",
  "displayId": "ERR-024",
  "originPattern": "EP-02",
  "observedAt": "2026-10-18",
  "source": "PRI-1015 / PR #2077 CodeRabbit review",
  "invariant": "Owner-stamp refusal must carry persisted Owner selection through the real repair consumer and reopen replacement before ADVANCE",
  "severity": "P1",
  "escaped": "CI",
  "caughtBy": "pr-review",
  "guard": "evaluator-approved-replay-failed-repair.test.ts: legacy V2 missing Owner provenance repairs from the current pack and blocks ADVANCE until replacement is reopened; host-runtime internalization-consumer-cycle-artificer-evidence.test.ts: repair seeder preserves the persisted Owner selection through real consumer preflight"
}
-->

2026-10-18 review found the strict Owner-provenance gate could reject a legacy V2 artifact without a complete recovery path: repair seeding did not inherit the persisted Owner evidence selection, and a helper-only pack fixture could not prove the production consumer assembled that selected evidence. The repair path now forwards the durable selection through real SQLite task seeding and consumer preflight, regenerates the artifact, and blocks ADVANCE until the replacement is reopened. Core repair-to-Evaluator-to-rollout tests and the host SQLite/assembler/cycle integration validate the path. This was caught in PR review before production release.
