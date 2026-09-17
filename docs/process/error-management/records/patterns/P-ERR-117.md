<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-117",
  "displayId": "ERR-117",
  "title": "A trust boundary with two resolution chains (hook vs command) for the same concept diverges silently — and the divergence is masked on dev machines by the host machine's real config",
  "status": "active",
  "category": "Missing Tests & Verification",
  "ep": "EP-03",
  "createdAt": "2026-09-05",
  "source": "PRI-686 live incident (2026-09-05) + PR #1518"
}
-->

**Recurrence**: 2026-09-05 PR #1518 review R1 (CodeRabbit) — the divergence warning shipped as an OPTIONAL logger parameter with zero real-chain callers: /pd-pain invoked the resolver without a logger, so the PR's own rc-9 guarantee held only in unit tests. An observability contract must be exercised through the production command path, not just the resolver's parameter list. Same round caught the `ctx.config.workspaceDir` `as string` cast (rc-2 flavor). Fixed in af2ab7a5a with a real-path regression test.
