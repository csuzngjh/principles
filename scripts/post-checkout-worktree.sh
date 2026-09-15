#!/bin/sh
# scripts/post-checkout-worktree.sh
# Worktree readiness hint — appended to .git/hooks/post-checkout by
# scripts/install-hooks.mjs.
#
# PRI-796 (SPEC §9) changed this hook's CONTRACT, deliberately:
#
#   before — ran setup-worktree.mjs on every branch switch. That could trigger a
#            full `npm install` (tens of minutes on this monorepo), turning a
#            branch switch into a heavy operation. A hook that can stall a
#            checkout for half an hour gets disabled by the humans who need it.
#
#   now    — runs a CHEAP READINESS PROBE only, and prints the bootstrap command
#            when the worktree is not ready. It never installs, never builds, and
#            never mutates anything.
#
# Idempotent and CI-safe: skipped when $CI is set, and in non-interactive shells.
# Markers: pd-worktree-hook-start / pd-worktree-hook-end

# post-checkout hook receives 3 args: PREV_HEAD NEW_HEAD BRANCH_SWITCH
PREV_HEAD=$1
NEW_HEAD=$2
BRANCH_SWITCH=$3

# Only run on branch switches (BRANCH_SWITCH=1), not file checkouts
if [ "$BRANCH_SWITCH" != "1" ]; then
    exit 0
fi

# Detect if we are inside a worktree (not the main repo).
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

# Skip in CI / non-interactive contexts (avoid noise)
if [ -n "$CI" ] || [ ! -t 1 ]; then
    exit 0
fi

# Skip during rebase/merge/cherry-pick (same guards as the graphify hook)
[ -d "$git_dir/rebase-merge" ] && exit 0
[ -d "$git_dir/rebase-apply" ] && exit 0
[ -f "$git_dir/MERGE_HEAD" ] && exit 0
[ -f "$git_dir/CHERRY_PICK_HEAD" ] && exit 0

ready_script="$repo_root/scripts/dev/worktree-ready.mjs"

if command -v node >/dev/null 2>&1 && [ -f "$ready_script" ]; then
    if node "$ready_script" --json >/dev/null 2>&1; then
        exit 0  # ready — stay silent; this is the common case
    fi
    echo "[pd-worktree] This worktree is NOT ready (dependencies/build missing, or packages resolving outside it)."
    echo "[pd-worktree] Run: npm run dev:worktree:bootstrap"
    exit 0
fi

# No probe available (older checkout) — hint only; never install from a hook.
echo "[pd-worktree] Note: readiness probe unavailable here. Verify with: npm run dev:worktree:ready"
exit 0
