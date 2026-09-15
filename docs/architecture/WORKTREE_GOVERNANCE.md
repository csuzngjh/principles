# Worktree Governance (PRI-796)

> **Status**: Active
> **Owner**: repository control plane (`AGENTS.md` §23A)
> **Normative source**: [`AGENTS.md`](../../AGENTS.md) §23A `git-1` … `git-14`. This document explains the *why* and the operating model; where the two disagree, `AGENTS.md` wins.
> **Phase 0 evidence**: [`../audit/PRI-796-worktree-governance-reality-audit.md`](../audit/PRI-796-worktree-governance-reality-audit.md)
> **Predecessor analysis (point-in-time, PRI-691)**: [`workspace-lifecycle-guard-analysis.md`](./workspace-lifecycle-guard-analysis.md)

## 1. The problem this solves

PD is developed on one Windows workstation by several AI agents (WorkBuddy,
Codex, ZCode, TRAE) plus a human, concurrently. The rules for that mode already
existed (`git-1` … `git-9`): one worktree per task, one writer per worktree, the
primary checkout is read-only, cleanup only after merge.

What was missing was **shape, observability and serialisation**:

* worktrees were created as siblings named `<repo>-<task>-<slug>`, so the
  workstation accumulated `D:\Code\principles-*` with no grouping and no way to
  tell a live task slot from an abandoned directory;
* the Owner could not answer "who is using this, is its PR merged, does it hold
  uncommitted work, may I delete it" without running five different tools;
* every worktree carried its own ~50k files, and nothing prevented a worktree
  from silently resolving the primary checkout's build output;
* `git worktree add/move/remove/prune` all rewrite shared Git metadata with no
  cross-process exclusion;
* an environmental problem (missing git-lfs, stale npm tree) and a real problem
  (a change that breaks a rule) both surfaced as the same generic failure, which
  teaches agents to bypass gates with `--no-verify`.

Measurement at the start (2026-09-14): `git worktree list` showed only the
primary; `.git/worktrees/` was empty; **10 directories** under `D:\Code` were
broken worktree shells holding ~475,000 files, invisible to git.

## 2. The model

```
one task
  = one branch
  = one worktree
  = one current writer
  = one decidable lifecycle
```

```
                     D:\Code\principles
                     PRIMARY / READ ONLY
                            │
                    Git common metadata
                            │
                  repo mutation mutex
                            │
              ┌─────────────┴─────────────┐
              │                           │
     lifecycle derivation          lifecycle mutation
              │                           │
      workspace snapshot        create / move / remove
              │                           │
              └─────────────┬─────────────┘
                            │
                D:\Code\_worktrees\principles
                            │
          ┌─────────────────┼────────────────┐
          │                 │                │
       PRI-788           PRI-789          PRI-790
          │                 │                │
       WorkBuddy           TRAE             Codex
```

Three invariants carry the design:

1. **Git remains the ownership truth.** Nothing here is a registry, database or
   daemon: every state is derived per run from git, GitHub, and the lease/lock
   files. The tools create state; they do not track it.
2. **PD is the only lifecycle writer.** The four AI IDEs are *consumers* of a
   slot. They do not each maintain their own worktree bookkeeping.
3. **Unprovable means preserved.** Anything that cannot be proven safe to delete
   stays on disk. Disk space is recoverable; someone else's uncommitted work is
   not.

## 3. Where things live

```
primary            D:\Code\principles                                        (control plane, read-only)
pool root          D:\Code\_worktrees\principles                             (derived, not hardcoded)
task worktree      D:\Code\_worktrees\principles\PRI-790-signal-confirmations
```

The pool root is **derived** as `<parent(primary)>/_worktrees/<basename(primary)>`
and overridable with `PD_WORKTREE_ROOT`. No tool may hardcode a drive or a
workstation path — `check:workspace-tools` fails the build if one reappears.

Directory names do not repeat the repository name or the branch namespace: the
pool path already encodes the repository, and `git-11` keeps the directory equal
to the task identity so `Task → Branch → Worktree` stays a single stable mapping.

## 4. Operating model

### 4.1 Create

```bash
npm run dev:worktree -- PRI-790 signal-confirmations
#   -> CREATED / BOOTSTRAPPED / READY
#   -> D:\Code\_worktrees\principles\PRI-790-signal-confirmations
```

Before anything touches the filesystem the tool checks the toolchain (Git LFS,
when `.gitattributes` routes content through it) and proves the base ref is
fresh: it fetches one explicit refspec and requires `FETCH_HEAD` to equal the
remote-tracking ref. A disagreement is `REF_INCONSISTENT` — an unexplainable ref
must not become the base of a claim. Only `git worktree add` runs under the
mutation mutex; the mutex is released before the multi-minute bootstrap.

A bootstrap failure reports `CREATED_NOT_READY` and **never deletes the
worktree**: a half-built worktree is recoverable, a deleted one is not.

### 4.2 Claim / release

```bash
npm run dev:worktree:claim -- --writer workbuddy
npm run dev:worktree:release
```

Ownership has two halves, and both are needed:

| Half | Mechanism | Covers |
| --- | --- | --- |
| PD write lease | `.workspace-lease.json` | other PD sessions see the write intent *before* files change |
| Git worktree lock | `git worktree lock` | git itself refuses `move` / `remove` / `prune` |

The lease alone cannot stop a git command run by a tool that never reads PD
state; the git lock alone carries no writer identity. Identity is
`<writer>:<task>` (`workbuddy` | `codex` | `zcode` | `trae` | `human` | `other`);
pid and host are debug metadata only, so a claim renews across processes.

A git lock whose lease is gone is reported as `STALE_LOCK` and is **never**
unlocked automatically — unlocking is the first step of destroying a claim.
Release is idempotent.

### 4.3 Readiness

```bash
npm run dev:worktree:ready [-- --json]
```

Three levels, each requiring that the resolved absolute path stay **inside** the
worktree:

| Level | Question |
| --- | --- |
| L1 dependencies | does the worktree resolve its OWN workspace packages? |
| L2 build | did the build authority emit the artifacts its manifests promise? |
| L3 runtime | do real specifiers (`@principles/core`, `@principles/core/runtime-v2`, `principles-disciple`, CLI bins) resolve to those artifacts? |

A package resolving to the primary checkout is `PRIMARY_LEAKAGE` and a hard
failure. This is the single most dangerous failure mode in the whole system: the
worktree *looks* like it is testing its own code while exercising the control
plane's `dist`. Every worktree therefore installs its **own** `node_modules`; a
full `node_modules` junction to the primary is forbidden, while sharing the npm
*download* cache is fine.

The probe set is derived from the manifests (workspace glob, then each covered
package's `exports` and `bin`), not hardcoded, so adding a package extends
coverage automatically. L2/L3 are scoped to the packages the root `npm run build`
covers, because that script is the one dependency-ordering authority; a worktree
bootstrapped the supported way must not be failed for an artifact the authority
never promised.

### 4.4 Observe

```bash
npm run dev:workspace:snapshot            # one table: everything the Owner asks
npm run dev:workspace:snapshot -- --size  # add file counts and disk usage
```

```
TASK      WRITER     STATE          DIRTY  PR          LOCK    READY   CLEANUP
PRI-788   workbuddy  ACTIVE         yes    #1673       yes     yes     NO
PRI-790   -          CLEANUP_READY  no     MERGED      no      yes     YES
PRI-755   unknown    UNKNOWN        ?      ?           ?       ?       REVIEW
```

STATE is the Owner-facing vocabulary (SPEC §12). The internal status tokens are
unchanged and authoritative; the projection lives in one function
(`toOwnerState`) and is documented in `AGENTS.md §23A git-14`:

| Owner-facing | Internal |
| --- | --- |
| `ACTIVE` | `ACTIVE` |
| `PENDING` | `CLEANUP_PENDING` |
| `CLEANUP_READY` | `CLEANUP_READY` |
| `UNKNOWN` | `ORPHAN`, and every residue row |

`--size` is on demand: a recursive scan of several hundred thousand files is
never the default.

### 4.5 Clean up

```bash
npm run dev:worktree:cleanup -- ai/PRI-790-signal-confirmations --delete-branch
npm run dev:workspace:cleanup            # sweep, dry-run by default
npm run dev:workspace:cleanup -- --apply
```

Removal requires PROVEN completion — GitHub `PR MERGED` first (the only evidence
that covers a squash merge, where the branch tip can never be an ancestor), else
ancestry to `origin/main` — plus: clean, not primary, no active lease, not
Git-locked, and status readable. Every one of those is re-checked at apply time,
because a snapshot from minutes ago is not evidence. An open PR is never swept.

### 4.6 Migrate

```bash
npm run dev:workspace:migrate            # dry-run: WOULD MOVE / WOULD SKIP / UNKNOWN / ACTIVE
npm run dev:workspace:migrate -- --apply
```

Moves existing, still-registered worktrees from the legacy sibling layout into the
pool. A slot with an active claim is never moved — yanking a working directory out
from under a live writer is exactly the harm this governance exists to prevent.
UNKNOWN residue is not even a candidate: `git worktree move` requires a registered
worktree.

## 5. Residue and UNKNOWN

A **residue shell** is a directory whose worktree admin metadata
(`.git/worktrees/<name>/`) is gone. Its `.git` file points at a path that no
longer exists; git cannot read its status, HEAD, or branch.

Established empirically during Phase 0 (see the Reality Audit §2.4):
**`git worktree repair` cannot recover this class.** It repairs the *pointer*
direction (a moved directory, a wrong `gitdir` file); it cannot synthesise the
lost `HEAD` / `branch` / `index`. There is no sanctioned git recovery.

Consequences, all of them deliberate:

* every residue shell is `UNKNOWN` — never automatically swept, because its
  **dirtiness is unprovable** and `CLEANUP_READY` requires a readable status;
* classification distinguishes `RESIDUE_KNOWN` (task and completion recoverable,
  usually from the surviving lease file) from `UNKNOWN` (nothing recoverable), but
  **both require the same explicit acknowledgement** — a weaker gate for
  `RESIDUE_KNOWN` would claim a proof that does not exist;
* the only deletion path is explicit and triply gated:

```bash
npm run dev:workspace:cleanup -- --residue "<path>" --ack-unknown --apply
```

  1. the path must be a residue shell **this tool's own scan discovered** — so
     `--ack-unknown` cannot be aimed at an arbitrary directory;
  2. `--ack-unknown` must be present;
  3. `--apply` must be present (dry-run is the default).

### 5.1 Junction safety

Windows is a first-class platform here, and a directory junction is exactly how a
shared `node_modules` appears. The residue deleter therefore never hands the tree
to a recursive remover:

* entries are inspected with `lstat` (never `stat`, which follows the link);
* a reparse point is **detached** with `unlink` — verified on this platform to
  remove only the link;
* each detached link's external target is re-checked afterwards, and a target
  that disappeared fails the run loudly.

Acceptance criterion: a residue directory containing a junction to important data
is removed, and the target is bit-for-bit intact. This is covered by a test.

### 5.2 Observability of long deletions

Deleting 50k+ files on Windows takes minutes. The walk prints progress inline —
counts and elapsed time every ~10s and every few thousand files — so an operator
never has to guess whether the process is stuck. No daemon, no watcher, no
background service: progress comes from the deletion loop itself.

## 6. The repo mutation mutex

`git worktree add | move | remove | repair | prune` and branch deletion all
read-modify-write the **shared** git directory. The per-worktree lease is scoped
to one checkout and cannot serialise that layer.

The mutex is one file, `<git-common-dir>/pd-worktree-mutation.lock`, created with
`O_EXCL`. It is deliberately *not* a registry, ownership database, or persistent
truth — it is a short-lived cross-process critical section.

* an existing lock is never overwritten and never auto-deleted: a crashed holder
  blocks mutations until a human removes the file, which is strictly better than
  guessing that a holder is gone;
* a lock that cannot be parsed still blocks (fail closed);
* the acquire error prints the holder's operation, pid, host, target and age, plus
  the exact recovery command;
* it is **never** held across `npm install`, a build, or a test run.

`git worktree prune` is invoked only when every existing-dir worktree probes
readable (the PRI-712 / PRI-710 guard): on Windows a lock race can make a live
worktree transiently unreadable, and git would then classify it as gone and drop
its admin metadata. A few stale metadata entries cost far less than a wrongly
deleted live one.

## 7. Bypass table

| Temptation | Why it is refused | What to do instead |
| --- | --- | --- |
| Share `node_modules` with the primary to save time | readiness would report `PRIMARY_LEAKAGE`; tests would exercise the wrong build | `npm run dev:worktree:bootstrap` (npm cache is shared automatically) |
| `git worktree remove --force` on a dirty tree | destroys unknown work (git-4) | commit a WIP commit, or remove the files yourself |
| unlock + remove a locked worktree | the lock means an active claim | `npm run dev:worktree:release`, after confirming the writer is gone |
| delete a residue directory to reclaim ~800 MB | its dirtiness is unprovable | review the snapshot, then `--residue <path> --ack-unknown --apply` |
| hand-write `.git/worktrees/<name>/` to "repair" it | unsupported; git's own state must stay git's | report it as UNKNOWN and decide with `--ack-unknown` |
| delete the mutation lock when it is "obviously stale" | it may be a live holder | check pid/host/age in the error, then remove it as a human |
| `--no-verify` because a gate failed | the failure is usually environmental, and the taxonomy now says so | read the code: `TOOLCHAIN_MISSING` / `ENVIRONMENT_INVALID` / `REF_INCONSISTENT` / `NOT_READY` / `CHECK_FAILED` |

## 8. Non-goals

Explicitly out of scope, per PRI-796 §26: workspace database, registry service,
daemon, webhook, background monitor, distributed lock service, IDE plugin, Console
UI, PD product runtime; shared full `node_modules`; automatic `reset` / `stash` /
`clean -fdx`; automatic deletion of UNKNOWN; hand-editing `.git/worktrees`;
per-entry `prune`.

## 9. Verification

`check:workspace-tools` runs inside `verify:merge` and protects the invariants
above structurally: the documented npm surface exists and points at real files,
`verify:merge` still includes the gate, no hardcoded workstation path, the
junction-safe deleter keeps its `lstat`/detach/verify decisions, the
`--ack-unknown` gate still precedes the delete, every shared-Git-metadata
mutation still runs under the mutex, no background service, and the governance
IDs are documented. The gate's own test breaks each invariant in a fixture and
requires the gate to name it — a gate that cannot fail is decoration.
