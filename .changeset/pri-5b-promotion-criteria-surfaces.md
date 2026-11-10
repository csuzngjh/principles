---
"@principles/pd-cli": minor
"create-principles-disciple": minor
---

`pd runtime activation promote` and the Console activation page now show why a
promotion is not ready, check by check (5B).

- CLI text output prints a `Criteria:` block: `[PASS]` / `[FAIL]` / `[----]`
  per check id with its reason code, plus evidence rows such as
  `shadow_observed: 19 / 20 (shortfall 1)`. `[----]` is used for
  `not_evaluated`, so an unrun check is never displayed as a pass.
- CLI `--json` output includes the same `criteria[]` array on both the
  `would_promote` and refusal payloads.
- Console renders the hard checks and an "evidence shortfall" block from the
  same read-only projection; the UI does not compute thresholds itself and no
  new write path is introduced. Missing `criteria` remains valid for older
  payloads, and malformed entries are rejected rather than rendered.
- zh-CN and en-US strings are added for `not_evaluated` and the evidence rows.

Minor: the CLI machine-readable payload grows a field and the command's text
output changes. No exit code or readiness threshold changes.
