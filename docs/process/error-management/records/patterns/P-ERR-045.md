<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-045",
  "displayId": "ERR-045",
  "title": "Shell interpolation of user-provided paths enables command injection",
  "status": "active",
  "category": "Architecture Boundary Violations",
  "ep": "EP-08",
  "createdAt": "2026-05-26",
  "source": "PRI-247 / PR #721"
}
-->

**Recurrence**: Same class as ERR-024 (security mechanism exists but is bypassed). Recurred 2026-08-17 (PRI-543 / PR #1349): `resolveGitUserEmail` in `create-principles-disciple/src/installer.ts` used `execSync(\`git -C "${workspaceDir}" config user.email\`, { shell: 'cmd' })` — CodeQL flagged it as command injection; fixed with `execFileSync('git', ['-C', workspaceDir, 'config', 'user.email'])`. Lesson: the argv-array rule applies even for "internal-looking" paths (installer workspace dirs), and any new `execSync`+`shell:` in a diff is a P1 review blocker.
