# scripts/install-hooks.ps1
# DEPRECATED: Use scripts/install-hooks.mjs directly for cross-platform support.
# This wrapper exists for backward compat with existing docs/automation that call the .ps1 path.
# It will be removed once all references are migrated to the .mjs version.
#
# Original behavior (now in the .mjs):
#   - Installs scripts/post-checkout-worktree.sh fragment into .git/hooks/post-checkout
#   - Preserves existing graphify hook logic via marker-based block management
#   - Idempotent: skips if already installed unless -Force is given
#
# Usage:
#   .\scripts\install-hooks.ps1          # install
#   .\scripts\install-hooks.ps1 -Force   # reinstall even if up-to-date

$ErrorActionPreference = 'Stop'

# Translate PowerShell-style flags to .mjs-style flags.
$mjsArgs = @()
if ($Force) { $mjsArgs += '--force' }

& node "$PSScriptRoot\install-hooks.mjs" @mjsArgs @args
exit $LASTEXITCODE
