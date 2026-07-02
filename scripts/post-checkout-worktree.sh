#!/bin/sh
# scripts/post-checkout-worktree.sh
# Worktree auto-setup hook fragment — appended to .git/hooks/post-checkout
# after the graphify hook block (if present).
#
# Purpose: automatically run setup-worktree.ps1 when a new worktree is created
# or a branch is checked out inside a worktree (not the main repo).
#
# Idempotent: safe to run multiple times; setup-worktree.ps1 itself is idempotent.
# CI-safe: only runs in interactive terminals (skipped when $CI is set).
#
# Installed by: scripts/install-hooks.ps1
# Markers: pd-worktree-hook-start / pd-worktree-hook-end

# post-checkout hook receives 3 args: PREV_HEAD NEW_HEAD BRANCH_SWITCH
PREV_HEAD=$1
NEW_HEAD=$2
BRANCH_SWITCH=$3

# Only run on branch switches (BRANCH_SWITCH=1), not file checkouts
if [ "$BRANCH_SWITCH" != "1" ]; then
    exit 0
fi

# Detect if we are inside a worktree (not the main repo)
# In a worktree, --git-common-dir points to the main repo's .git,
# which differs from --git-dir (the worktree's private .git).
common_dir=$(git rev-parse --git-common-dir 2>/dev/null || echo "")
git_dir=$(git rev-parse --git-dir 2>/dev/null || echo "")

# Main repo: common_dir == git_dir → skip (avoid noise on every checkout)
if [ -z "$common_dir" ] || [ "$common_dir" = "$git_dir" ]; then
    exit 0
fi

# Find repo root
repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
if [ -z "$repo_root" ]; then
    exit 0
fi

# Check setup script exists
setup_script="$repo_root/scripts/setup-worktree.ps1"
if [ ! -f "$setup_script" ]; then
    exit 0
fi

# Skip in CI / non-interactive contexts (avoid noise)
if [ -n "$CI" ] || [ ! -t 1 ]; then
    exit 0
fi

# Skip during rebase/merge/cherry-pick (same guards as graphify hook)
[ -d "$git_dir/rebase-merge" ] && exit 0
[ -d "$git_dir/rebase-apply" ] && exit 0
[ -f "$git_dir/MERGE_HEAD" ] && exit 0
[ -f "$git_dir/CHERRY_PICK_HEAD" ] && exit 0

echo "[pd-worktree] Running setup-worktree.ps1..."
# On Windows: invoke PowerShell to run the setup script
# -SkipBuild: hook context, build verification deferred to user
# -FromHook: skip PATH fix (hook inherits git's environment which has PATH)
if command -v powershell >/dev/null 2>&1; then
    powershell -NoProfile -File "$setup_script" -SkipBuild -FromHook || {
        echo "[pd-worktree] setup-worktree.ps1 failed. Run manually: scripts/setup-worktree.ps1"
    }
elif command -v pwsh >/dev/null 2>&1; then
    pwsh -NoProfile -File "$setup_script" -SkipBuild -FromHook || {
        echo "[pd-worktree] setup-worktree.ps1 failed. Run manually: scripts/setup-worktree.ps1"
    }
fi
