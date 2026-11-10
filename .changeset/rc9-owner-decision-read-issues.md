---
"create-principles-disciple": patch
---

Owner decision inbox (Console) now counts and attributes entries it skips or fails to read, instead of dropping them silently.

- Public result type change: the `GET /api/governance/owner-decisions` data payload (`OwnerDecisionListResult`) gains a **required** `readIssues` array. Consumers of this payload must handle the new field; an empty array means nothing was skipped.
- Shadow RuleCode entries previously swallowed by `catch { continue; }` are now aggregated per reason (`owner_review_read_failed`, `readiness_not_actionable`, `shadow_scan_unavailable`) with a bounded sample of activation ids (max 5) and a short detail (max 200 chars), so "nothing pending" and "cannot read" are no longer indistinguishable on the page.
- No change to inbox item selection when every read succeeds: `readIssues` stays empty.
