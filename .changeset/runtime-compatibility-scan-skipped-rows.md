---
"@principles/core": patch
"@principles/pd-cli": patch
---

`pd runtime compatibility-scan`: skipped activation rows are now counted and attributable (2B-a).

The scan reads ACTIVE activations and derives their rule implementation from
`pi_artifacts.content_json`. Rows that could not be parsed were silently
`continue`d, so `status: clean` could be reported while some active rules were
never actually inspected.

- `ActivationCompatibilityScanResult` gains `skipped: [{ reason, count, sampleActivationIds }]`
  (`reason` ∈ `row_not_record | missing_artifact_id | missing_content_json |
  invalid_content_json | content_not_object | missing_implementation_code`,
  up to 5 attributable activation ids per reason). Empty array = every active
  row was scanned.
- `pd runtime compatibility-scan` prints a one-line `skipped: N active row(s)
  could not be scanned — <reason>=<count>` summary when anything was skipped,
  and `--json` carries the full breakdown.
- `status` and `ok` semantics are deliberately unchanged: a skipped row does
  not fail the scan. Redefining `clean` to account for skips is a separate
  decision tracked with 5B.
