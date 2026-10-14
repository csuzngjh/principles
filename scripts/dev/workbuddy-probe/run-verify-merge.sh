#!/bin/sh
# verify:merge with an 8GB heap — the full-repo eslint pass OOMs at the
# default 4GB on this machine (documented in the remediation STATE).
export NODE_OPTIONS="--max-old-space-size=8192"
cd /d/Code/_worktrees/principles/adhoc-20261012-workbuddy-spec-review-a5c1ad
exec npm run verify:merge
