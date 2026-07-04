# scripts/setup-worktree.ps1
# DEPRECATED: Use scripts/setup-worktree.mjs directly for cross-platform support.
# This wrapper exists for backward compat with existing docs/automation that call the .ps1 path.
# It will be removed once all references are migrated to the .mjs version.
#
# Original behavior (now in the .mjs):
#   - One-shot worktree bootstrap: PATH fix (Windows Trae bug), private docs junction,
#     npm install, npm run build, health check
#   - Idempotent, fail-loud, with [ok]/[skip]/[fail] status reporting
#
# Usage (mapped to .mjs flags):
#   .\scripts\setup-worktree.ps1                  → node setup-worktree.mjs
#   .\scripts\setup-worktree.ps1 -SkipInstall     → node setup-worktree.mjs --skip-install
#   .\scripts\setup-worktree.ps1 -SkipBuild       → node setup-worktree.mjs --skip-build
#   .\scripts\setup-worktree.ps1 -SkipPrivateDocs → node setup-worktree.mjs --skip-private-docs
#   .\scripts\setup-worktree.ps1 -WhatIf          → node setup-worktree.mjs --dry-run
#   .\scripts\setup-worktree.ps1 -FromHook       → node setup-worktree.mjs --from-hook

$ErrorActionPreference = 'Stop'

# Translate PowerShell-style flags to .mjs-style flags.
$mjsArgs = @()
if ($SkipInstall)     { $mjsArgs += '--skip-install' }
if ($SkipBuild)       { $mjsArgs += '--skip-build' }
if ($SkipPrivateDocs) { $mjsArgs += '--skip-private-docs' }
if ($FromHook)        { $mjsArgs += '--from-hook' }
if ($WhatIfPreference -or $WhatIf) { $mjsArgs += '--dry-run' }

& node "$PSScriptRoot\setup-worktree.mjs" @mjsArgs @args
exit $LASTEXITCODE
