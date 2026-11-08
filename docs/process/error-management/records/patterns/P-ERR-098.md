<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-098",
  "displayId": "ERR-098",
  "title": "Destructive cleanup followed junctions and deleted files outside the target — no delete may traverse a link pointing outside what it deletes, `git worktree remove` included; scan reparse points, refuse or detach first, and never silence errors on critical cleanup",
  "status": "active",
  "category": "Process & Workflow",
  "ep": null,
  "createdAt": "2026-08-16",
  "source": "PRI-538 (pr-review session 2026-08-16, PRs #1332-1335 verification cleanup)"
}
-->

**Recurrence**: Yes — shared-repo reparse-point hazard re-encountered (caught before damage this time).

**Prevention rule (corrected 2026-11-06, OCC-20261106T025529Z-g9kvsgn43c / PRI-1143)**: the invariant is
"deletion never traverses reparse points", not "use a git command to delete". `git worktree remove`
violates it on Windows: it recursed through a MERGED, porcelain-clean worktree's gitignored fixture
junctions and deleted real files of the global install, on the first non-forced removal, exit 0.
Before any deletion: enumerate reparse points (`classifyReparsePoints` in
`scripts/dev/lib/residue-delete.mjs`) and check each link's direction — a link whose target is inside
the tree being deleted and is not a self/ancestor cycle is safe for the recursive walk. A verified
self/ancestor cycle is unsafe to traverse, but may be detached as a link because its target is proven
inside the same tree. A link whose target is outside it means STOP (an unresolvable target counts as
outside: unknown direction is never trusted, git-14). Removal proceeds only after external links are
detached one at a time with their targets re-verified
(`detachExternalLinks`, opt-in `--detach-external-links`), and the tool re-checks every external
target after the delete. Recursive filesystem deletes (`Remove-Item -Recurse`, `rm -rf`) and
`git clean -fdx` remain forbidden on such trees, and cleanup steps must still never silence errors.

**Review hardening (PRI-1143, 2026-11-08)**: the preflight must FAIL CLOSED, not
merely classify the links it happened to see. An unreadable directory, an
unresolvable target, a relative target containing `..`, or a case-mismatched path on a
case-sensitive Windows directory is UNKNOWN and refuses the deletion (`SCAN_INCOMPLETE` /
`EXTERNAL_LINKS_PRESENT`). A self/ancestor cycle whose target is proven inside the same tree is
not UNKNOWN: it is detached as a link (never traversed), both by per-worktree cleanup and by the
batch sweep. Direction is decided from `realpath` on BOTH sides and compared case-sensitively. The scan,
the refusal decision, quarantine move, no-follow deletion and Git metadata
unregistration must share ONE mutation lock. A mutex alone cannot stop a writer
that does not use that mutex: never hand a live directory to recursive Git
removal. Rename it to a private quarantine sibling and use the no-follow
`removeResidueTree` walker; only unregister Git metadata after the tree is gone.
Verified internal links and ancestor cycles are detached as links, not traversed.
External and unresolvable targets still fail closed without explicit approval. After deletion, compare a content-level fingerprint of
each external target (not `existsSync`: the incident deleted files INSIDE a target
that was still present); targets already missing before the run are not "lost".

**Concurrency hardening (PRI-1143 review round 3, 2026-11-08)**: a cooperative
mutex is not an OS-level exclusive lock. The quarantine move does not stop a
process that already holds an open handle from committing bytes, so a single
pre-move `git status` is never proof the tree is quiet: the quarantine is
re-checked with a SECOND status after the move, and any change appearing there
(restore-able) restores the worktree intact and refuses the deletion. Every
path-based unlink re-verifies the recorded dev/ino identity of its ancestor
chain first — a parent swapped for a junction mid-deletion fails closed instead
of redirecting the unlink outside the tree. Worktrees containing initialized
submodules are quarantined via a verified manual rename with re-anchored
submodule admin pointers (git refuses `git worktree move` for them outright);
the shared `<commonDir>/modules` area is never deleted. Rollbacks trust
verified disk state over the error text and complete moves git itself refuses
(relative gitdir markers fail git's move-time validation). Undetectable
residual risk, recorded honestly: a writer holding an unlinked file descriptor
can keep writing into a deleted inode on POSIX — Node has no handle-enumeration
primitive, so that class is documented here instead of being silently ignored.
