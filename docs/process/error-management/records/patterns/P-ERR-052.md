<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-052",
  "displayId": "ERR-052",
  "title": "Cherry-pick from stacked feature branch cross-contaminates unrelated PR",
  "status": "active",
  "category": "Process & Workflow",
  "ep": "EP-10",
  "createdAt": "2026-06-03",
  "source": "PRI-299 / PR #800"
}
-->

**Recurrence**: 2026-06-18 PR #971 — the notification-sound branch was based on a stacked history and its PR diff included already-merged RuleHost work plus unrelated website assets. Fixed by rebuilding the branch from current `main` and replaying only the seven notification commits. The review guard was strengthened in practice by comparing both `git log origin/main..source-branch` and `gh pr diff --name-only` before resolving conflicts.
