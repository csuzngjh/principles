<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-068",
  "displayId": "ERR-068",
  "title": "Used the wrong package manager (pnpm) in a repo whose CI runs `npm ci`, leaving `package-lock.json` out of sync",
  "status": "active",
  "category": "Process & Workflow",
  "ep": "EP-06",
  "createdAt": "2026-06-16",
  "source": "unknown"
}
-->

**Recurrence**: Yes — a lockfile the consuming `npm ci` reads was not the one updated (wrong package manager; or auxiliary/release lockfiles outside the bump author's view).
