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
the shared `<commonDir>/modules` area is never deleted.

**Owner review hardening (PRI-1143, 2026-11-09)** — three gaps the round-3
text understated, now closed:

- *Writers that have not written yet.* A second status cannot see a process
  that holds a handle but has not written. Verified on Windows too: libuv opens
  files with FILE_SHARE_DELETE, so unlinking a held file SUCCEEDS and later
  writes through the old handle are lost. Deletion now requires a positive
  quiescence proof taken immediately before it (`scripts/dev/lib/quiescence.mjs`):
  Linux scans every `/proc/<pid>/{fd,cwd,root,maps}`; Windows renames the
  private quarantine parent out and back (Windows refuses that rename while
  ANY handle is open anywhere in the subtree — verified for file, directory
  and working-directory handles at any depth); every other platform has no
  mechanism and is refused. No proof ⇒ nothing deleted (`QUIESCENCE_UNPROVEN`).
- *Rollbacks.* No rollback ever invokes `git worktree move` (an earlier note
  claiming this was only true for one of two rollback paths). One rollback
  restores the original marker and pointer bytes captured before the move,
  compensates each step, and reports the outcome derived from disk:
  `RESTORE_COMPLETED`, `QUARANTINE_PRESERVED`, or `RESTORE_FAILED` with the
  tree's real location and `git worktree repair` as the relink step. While any
  tree needs relinking the batch sweep skips its global prune — a prune deletes
  exactly the admin entry of a tree Git no longer locates.
- *Exact identity.* dev/ino are compared as bigints; NTFS file ids exceed 2^53
  and rounded to JS numbers two different entries could compare equal.

**Accepted safety boundary — REQUIRES EXPLICIT OWNER ACCEPTANCE.** These are
the limits of what Node's filesystem API can prove; they are stated, not hidden:

1. *Identity-check-to-unlink window.* Node has no `unlinkat(dirfd)` primitive,
   so every unlink is path-based: the identity check and the unlink are two
   syscalls. A process that swaps an ancestor between them can redirect ONE
   unlink. Only a process with the invoking user's (or higher) privileges can
   restructure the private quarantine, and such a process can already delete
   whatever that unlink could reach — the race grants no privilege, and the
   accidental interference of ordinary tools is caught by the checks.
2. *Quiescence is a point-in-time proof.* A process that opens a NEW handle
   after the proof must first discover the freshly created private quarantine
   path.
3. *Linux inspection boundary.* Processes of other users — and non-dumpable or
   setuid processes, whose `/proc` entry is owned by root — cannot be inspected
   without privileges; they are counted (`uninspectedProcesses`) and reported,
   not proven absent. A process of the invoking user that cannot be inspected
   fails the proof. Processes in other PID namespaces are invisible.
4. *Unsupported platforms* (macOS, BSD) never prove quiescence, so cleanup
   always refuses there until an inspection mechanism exists.
