---
"@principles/core": minor
---

`ActivationCompatibilityScanResult.status` gains `incomplete` (5B-A).

`clean` previously meant only "no retired-contract findings", so a workspace
whose ACTIVE rows were all unreadable (invalid `content_json`, missing
`implementationCode`, …) was reported as `clean` even though no rule was
actually inspected.

- `clean` ⇔ `findings` empty **and** `skipped` empty.
- `incomplete` ⇔ `findings` empty **and** `skipped` non-empty.
- `legacy_dependency` / `scan_failed` / `no_state_db` are unchanged, and
  `legacy_dependency` still dominates: findings are never merged into
  `incomplete`.
- `incomplete` carries `reason: 'unscannable_active_rows'` + `nextAction`.
- `ok` is unchanged: it still means "the scan finished without crashing", so
  `incomplete` is `ok: true`. It is not an upgrade-blocking gate.

Minor, not patch: the `status` field is a public cross-package enum. Adding a
member is source-compatible for `switch` defaults but breaks machine consumers
that parse the enum exhaustively (the installer's strict `(ok, status)`
protocol is one; anything that only accepts `clean | no_state_db` as a pass
would now fail closed on a previously `clean` payload). Consumers that must
keep accepting `incomplete` are updated in the same release.
