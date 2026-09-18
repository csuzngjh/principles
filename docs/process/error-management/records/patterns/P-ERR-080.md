<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-080",
  "displayId": "ERR-080",
  "title": "Control applied to the RAW input form instead of the CANONICAL/transformed form — size bound applied pre-escape (escaped output exceeds budget), or path-prefix check applied to the raw param path instead of normalizedPath (traversal bypasses the match)",
  "status": "active",
  "category": "Security & Safety",
  "ep": "EP-08",
  "createdAt": "2026-06-25",
  "source": "PRI-467 / PR #1059 (CodeRabbit review)",
  "trailerLines": [
    "  2026-08-13 PRI-523 C1.2 review: RuleCode evaluation bounded the child but compiled untrusted source in the parent with per-rule timeouts (N rules = N×gate) — move compile+evaluate into one bounded child batch with one total deadline; storage-side recurrence (full artifact JSON materialized before envelope check, provider timers surviving early settlement) fixed with metadata-only byte preflight + bounded second fetch + timer cleanup in `finally`. C1.1 review: prompt kernel budgeted pre-render lines then XML-escaped them — select only whole directives whose rendered escaped block fits. 2026-08-12 PR #1302 (semantic-canonicalization flavor): demo RuleCode exemplar checked raw `paramsSummary.path` before `normalizedPath`, so `/project/../../etc/passwd` bypassed the `/etc` block — swap to `normalizedPath ?? paramsSummary.path` precedence + traversal regression. (Full texts → ERROR_ARCHIVE.md.)"
  ]
}
-->

**Recurrence**: 2026-09-12 PRI-754 / PR #1633 Codex review (derived-form flavors): (1) an AI-User navigate action validated the RAW model-supplied path with a `/`-prefix check, but the value is later resolved via `new URL(value, baseUrl)` — protocol-relative `//evil.example/path` passes the prefix check and resolves to a foreign origin, so the browser would snapshot internal pages for the configured LLM; fixed by comparing the RESOLVED URL's origin against the console origin before goto. (2) a scenario `id` flowed into the run-directory `join()` with no filename-safety check — `../../escape` escapes the output root; fixed with `^[A-Za-z0-9][A-Za-z0-9._-]*$` at parse time.
