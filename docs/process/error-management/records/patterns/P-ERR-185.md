<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-185",
  "displayId": "ERR-185",
  "title": "Frozen evidence package binds its producer source; editing lab lib/*.mjs without rerunning the rebinder leaves main CI red",
  "status": "active",
  "category": "Missing Tests & Verification",
  "ep": "EP-06",
  "createdAt": "2026-11-01",
  "source": "PR #2257 post-merge (P1-3.1 b7cc2dca8 edited lib/challenge-behavior-report.mjs after the last rebind c4956990a); reproduced on origin/main as 10 OFFLINE_PACKAGE_DRIFT failures"
}
-->

The v4 offline evidence package is byte-frozen: `package-manifest.json` embeds `challengeImplementationManifest()`, which hashes EVERY `scripts/dev/principle-learning-lab/lib/*.mjs`. That binding is the point — a reviewer can tell exactly which implementation produced the frozen executions. But it also means any PR that edits a lib file invalidates the frozen package, and P1-3.1 (`b7cc2dca8`, `lib/challenge-behavior-report.mjs`) landed after the previous rebind (`c4956990a`) without re-running the rebinder.

`verifyOfflinePackage()` therefore threw `OFFLINE_PACKAGE_DRIFT` in 10 cases across 2 test files on `origin/main` (`Test shared runtime & adapters`: `Test Files 2 failed | 96 passed`). The gate did its job — the escape was the process step it protects: the PR was merged without the rebind, so every later PR started from a red base.

The rebind itself is outcome-neutral by construction: `rebind-exm-v4-freeze.mjs` refuses if `executionsHash` changes, if any report row moves, if mappingHash/goldHash drift, or if a non-derived package file moves. After the rebind, `executionsHash` stayed `97e2d4e78710616a18945fcbb9d823420a3cd716d2e58de67e1c817d15844751` and every report row was unchanged; only the implementation binding (and the derived hashes that embed it) moved.

Must check: a PR that touches `scripts/dev/principle-learning-lab/lib/*.mjs` must run `node scripts/dev/principle-learning-lab/rebind-exm-v4-freeze.mjs --record-evidence` in that same PR and commit the derived artifacts, then prove the invariant held (`executionsHash` and report rows unchanged) before committing. Because this class has now recurred across several lib edits, the drift failure must stay blocking, its message must name the drifted files and the exact rebind command, and the acceptance document must state the obligation where the frozen hashes live — never silence the check by editing the baseline or the package bytes.
