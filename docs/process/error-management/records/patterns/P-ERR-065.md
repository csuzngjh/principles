<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-065",
  "displayId": "ERR-065",
  "title": "SQLite INSERT guesses column names instead of reading schema — trust-boundary recurrence (ERR-001/ERR-005/ERR-013)",
  "status": "archived",
  "category": null,
  "ep": "EP-01",
  "createdAt": "2026-06-14",
  "source": "PRI-394 / PR #926"
}
-->

**Recurrence**: 2026-08-21 RuleCode Owner Live Decision formal SPEC review (no Linear issue): the initial feature-flag design said flag-off restored the existing Console presentation but did not state that every promotion entry point, especially CLI, must refuse promotion. That left room for the stricter Owner decision authority to disappear while the legacy unchecked mutation remained available. The same review also found that local no-auth Console had been allowed to write `reject-after-shadow`, incorrectly granting governance authority to a break-glass operator. Fixed before implementation by making feature-off refuse promotion across Console and CLI, requiring both paths to use one application service, and restricting unauthenticated authority to inspect/deactivate/global-pause only. Regression requirement: disabled, unavailable, validated-deny, and authenticated-allow must be exercised at every promotion entry point; no-auth tests must prove governance writes are refused. 2026-08-25 PR #1409 (PRI-586): READ-side sibling — `featureFlags?.enabled === true` gating made the still-loading state indistinguishable from flag-off, so FocusPage fired the legacy `/governance/queue` request before flipping to experience mode (wasted call + legacy-panel flash). Fixed by gating the data load on flags-resolved; loading ≠ disabled extends the same three-state rule to read paths.
