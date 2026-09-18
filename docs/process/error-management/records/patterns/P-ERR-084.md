<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-084",
  "displayId": "ERR-084",
  "title": "shell:true in spawn() + immediate process.exit() in signal handlers orphans child processes; GitHub Actions not pinned to SHA",
  "status": "active",
  "category": "Process & Workflow",
  "ep": "EP-06",
  "createdAt": "2026-06-26",
  "source": "PR #1068"
}
-->

**Recurrence**: 2026-08-28 release-pipeline recovery PR #1439 round 3 (composite-action execution semantics, never exercised by PR CI): a new composite action consumed by the publish train read `secrets.*` directly (GitHub does not expose the secrets context to composite steps — every token empty, train dies mid-publish) and the job built host-runtime before install-layout (TS2307 on clean checkout). Fixed by declaring token inputs + explicit `${{ secrets.* }}` pass-through and core → install-layout → host-runtime order in BOTH publish paths, each with a contract test. Lesson: composite-action execution semantics (context availability, clean-checkout filesystem state) cannot be validated by the package test suite alone — pin them with contract assertions CI cannot execute, and grep sibling build paths, not just flagged lines. (Full text → ERROR_ARCHIVE.md.)
