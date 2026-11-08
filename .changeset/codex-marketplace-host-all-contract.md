---
"@principles/core": minor
"create-principles-disciple": patch
---

Fix the `--host all` / Codex install contract: `CodexHostInstaller.install` now reports the Codex end state honestly (Marketplace already installed / manual Marketplace step required / state unverifiable) via the new optional `HostInstallResult.manualActionRequired` flag instead of returning a plain failure, so a pending Codex Marketplace install no longer aborts the whole install transaction — an already-successful OpenClaw install stays intact and the shared runtime is not rolled back. The aggregate result is an explicit partial completion (`success=false`, `manualActions[]` in the `--json` output, non-zero exit, per-host MANUAL ACTION REQUIRED text); a re-run after the manual `codex plugin add principles-disciple@principles` converges idempotently. `--host all` still never includes WorkBuddy.
