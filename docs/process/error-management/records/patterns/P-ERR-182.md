<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-182",
  "displayId": "ERR-182",
  "title": "Two-gate status derived from one boolean: install summary reported keyword Pain ON while the Owner had explicitly disabled it",
  "status": "active",
  "category": "Documentation & Spec Drift",
  "ep": "EP-03",
  "createdAt": "2026-10-31",
  "source": "PR 2252 code review (agent), covered by the PR own opt-out test case"
}
-->

The install summary described two independent governance gates (host governance, keyword Pain detection) with one sentence derived from a single boolean: `hostExplicitOff`. Whenever the two gates disagreed — the Owner had written `workbuddy_live_keyword_pain.enabled: false` while leaving the host gate enabled — the summary printed "... governance and four-term keyword Pain detection are ON" while keyword Pain was in fact OFF. The flag the Owner had written was never named.

This is a partial-state-as-whole-state error: a summary derived from N inputs but computed from 1 of them. It is especially damaging here because the change's stated purpose was to stop the install from claiming a healthy state the system was not in — the fix reproduced the defect class it was meant to remove, one field over.

Must check: when a status line describes multiple gates/checks, derive each clause from its own witness field and test the states where they DISAGREE (each on/off combination), not only the all-on and all-off cases. A summary function should be extracted as a pure function so the disagreeing combinations are cheap to pin.
