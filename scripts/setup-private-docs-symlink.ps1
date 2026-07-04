# scripts/setup-private-docs-symlink.ps1
# DEPRECATED: Use scripts/setup-private-docs-symlink.mjs directly for cross-platform support.
# This wrapper exists for backward compat with existing docs/automation that call the .ps1 path.
# It will be removed once all references are migrated to the .mjs version.
#
# Original behavior (now in the .mjs):
#   - Resolves private docs target via PD_PRIVATE_DOCS_DIR env or ~/principles-private/docs
#   - Creates a Junction (Windows) / symlink (Unix) at docs/.private in every git worktree
#   - Idempotent: existing correct links are skipped; wrong links fail loud (no auto-delete)
#
# Usage:
#   .\scripts\setup-private-docs-symlink.ps1
#   $env:PD_PRIVATE_DOCS_DIR = "C:\path\to\docs"; .\scripts\setup-private-docs-symlink.ps1

$ErrorActionPreference = 'Stop'
& node "$PSScriptRoot\setup-private-docs-symlink.mjs" @args
exit $LASTEXITCODE
