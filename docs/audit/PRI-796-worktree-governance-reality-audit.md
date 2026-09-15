# PRI-796 Reality Audit — Windows 多 AI Worktree 治理 v2

Status: Phase 0 deliverable (read-only reconnaissance)
Date: 2026-09-14
Base commit: `e782141c` (`origin/main` @ 2026-09-14T21:10+08:00)
Author: implementation agent (WorkBuddy), on behalf of Owner
Method: repository reading only — no mutation of the primary checkout, no mutation of any inventoried directory.

> P1 Evidence Over Assumption: every claim below was verified against current `main`,
> the live `D:\Code` filesystem, and (where the SPEC depended on a Git behaviour)
> a throwaway fixture under `D:/pd-probe-*`. Claims that could not be verified are
> marked **[UNVERIFIED]**.

---

## 1. Executive summary

The SPEC's design is **implementable as written with two material deviations and one
newly-discovered hard constraint**:

1. **`git worktree repair` cannot recover the incident class we actually have.**
   The SPEC (§3, §4) assumes repair is a usable recovery mutation. Empirically it is
   not: when the *whole* `admin` directory (`<git-common-dir>/worktrees/<name>/`) is
   gone, repair aborts. Therefore the 10 broken directories on this machine are
   **terminal UNKNOWN** — report-and-ack only, exactly as SPEC §15.2/§16 prescribe.
   This is a *stronger* justification for D6 than the SPEC anticipated.
2. **The existing lease file is the only surviving owner of the `branch` fact** for
   those broken worktrees. This turns 8 of 10 from "nothing known" into
   `RESIDUE_KNOWN`-grade evidence without violating §26 (no hand-editing of
   `.git/worktrees`). This is a *reuse* win: `scripts/dev/lib/workspace-lease.mjs`
   already records `workspace` + `branch` + `owner` + TTL.
3. **Naming**: the repository's existing classifier already ships
   `CLEANUP_PENDING` / `CLEANUP_READY` / `ORPHAN` and those strings are asserted by
   `scripts/__tests__/workspace-lifecycle.test.ts`. SPEC §12 calls the same state
   `PENDING`. Per `AGENTS.md` P4 (One Source of Truth) and SPEC §28 (repo facts win,
   record the deviation) the repository name is preserved and `PENDING` is documented
   as an alias rather than introduced as a second status token.

Everything else in the SPEC maps onto existing mechanisms. **No new subsystem,
registry, database, daemon or watcher is required** — consistent with the SPEC's own
Non-goals (§26).

---

## 2. Inventory of `D:\Code` (the actual Owner problem)

### 2.1 Registered worktrees

```
$ git worktree list --porcelain     # run in D:\Code\principles
worktree D:/Code/principles
HEAD a5e9842bd500340e21aa46bfa8fda69fbeb9f820
branch refs/heads/main
```

**Only the primary is registered.** `.git/worktrees/` is an **empty directory**.

### 2.2 Sibling directories carrying the PD repo name

10 directories match `<primary-basename>-*` and every one is a **broken worktree shell**:
its working-tree `.git` file points at an admin directory that no longer exists.

| # | Directory (`D:\Code\…`) | `.git` target exists | `node_modules` | files | lease file |
|---|---|---|---|---|---|
| 1 | `principles-PRI-758-replay-repair-routing` | NO (dead) | yes | 50,206 | yes |
| 2 | `principles-PRI-758-scribe-maxtokens` | NO (dead) | yes | 54,772 | yes |
| 3 | `principles-PRI-773-telemetry-guard` | NO (dead) | yes | 50,203 | yes |
| 4 | `principles-PRI-775-barrel-freeze` | NO (dead) | yes | 50,208 | yes |
| 5 | `principles-PRI-775-barrel-freeze-fix` | NO (dead) | yes | 50,204 | **no** |
| 6 | `principles-PRI-778-cnb-github-bridge` | NO (dead) | yes | 7,759 | yes |
| 7 | `principles-PRI-783-pain-session-degrade` | NO (dead) | yes | 50,204 | yes |
| 8 | `principles-PRI-786-doc-truth-r2` | NO (dead) | yes | 50,202 | yes |
| 9 | `principles-PRI-788-correction-signal-optimization` | NO (dead) | yes | 50,216 | yes |
| 10 | `principles-PRI-793-console-token-persist` | NO (dead) | yes | 50,204 | **no** |

Total ≈ **475,000 files** across 10 unremovable-looking directories.

`D:\Code\principles-private` is a **separate repository** (not a PD worktree) and is
out of scope. `D:\Code\_worktrees\` did not exist before this task.

### 2.3 Per-directory evidence collected (read-only)

`branch` was recovered from the surviving `.workspace-lease.json` where present.
Merge evidence was gathered from `git merge-base --is-ancestor` and `gh pr list --state all --head`.

| Directory | recovered branch | lease state | ancestry to `origin/main` | PR evidence |
|---|---|---|---|---|
| PRI-758-replay-repair-routing | `ai/PRI-758-replay-repair-routing` | expired 2026-09-13T03:47Z | not ancestor | **#1661 MERGED**, #1654 MERGED |
| PRI-758-scribe-maxtokens | `ai/PRI-758-scribe-maxtokens` | expired 2026-09-14T07:14Z | **merged** | — |
| PRI-773-telemetry-guard | `ai/PRI-773-telemetry-guard` | expired 2026-09-14T04:01Z | **merged** | — |
| PRI-775-barrel-freeze | `ai/PRI-775-barrel-freeze` | expired 2026-09-13T19:53Z | **merged** | — |
| PRI-775-barrel-freeze-fix | *unknown* (no lease) | — | n/a | none found |
| PRI-778-cnb-github-bridge | `ai/cnb-dev/issue-13` | expired 2026-09-13T07:12Z | **merged** | — |
| PRI-783-pain-session-degrade | `ai/PRI-783-pain-session-degrade` | expired 2026-09-13T19:52Z | not ancestor | none found |
| PRI-786-doc-truth-r2 | `ai/PRI-786-doc-truth-r2` | expired 2026-09-13T20:12Z | **merged** | — |
| PRI-788-correction-signal-optimization | `ai/PRI-788-correction-signal-optimization` | expired 2026-09-14T03:57Z | not ancestor | **#1673 MERGED** |
| PRI-793-console-token-persist | *unknown* (no lease) | — | **merged** | **#1674 MERGED** |

All 10 branches still exist as **local refs** in the primary. **None** exists on the remote
(their PR branches were deleted after merge / never pushed under that name).

**All leases are EXPIRED ⇒ no active writer anywhere. No directory is currently in use.**

### 2.4 Empirically established Git behaviour (`D:/pd-probe-repair`, throwaway fixture)

Fixture: real repository + real worktree + one staged file (`wip.txt`), then
`rm -rf primary/.git/worktrees`. Result:

```
$ git -C wt-broken status --porcelain        → exit 128
$ git -C primary worktree list               → only "D:/…/primary"  (worktree vanished)
$ git -C primary worktree repair D:/…/wt-broken
  error: unable to locate repository; .git file does not reference a repository
  → exit 1
  → admin directory NOT re-created
  → worktree still unusable; wip.txt still on disk
```

**Conclusion:** `git worktree repair` repairs the *pointer* direction (a moved directory,
a wrong `gitdir` file). It cannot *synthesise* the lost `HEAD` / `branch` / `index`
admin state. There is **no sanctioned Git recovery** for a fully deleted admin entry.

Consequence for D6: for this class there is nothing to "repair" — the only safe
operation is explicit-ack removal, which makes D6 the load-bearing rule rather than a
cautious default.

The fixture directory was deleted after the probe. No test touched `D:\Code`.

---

## 3. Existing mechanisms (reuse map)

Everything the SPEC asks for in §3 exists and is high quality. Reuse-first plan:

| SPEC capability | Existing owner | Plan |
|---|---|---|
| git plumbing, Windows path normalization (incl. 8.3 / case / separator), `worktree list` parsing | `scripts/dev/lib/git.mjs` | **reuse unchanged** |
| global-prune safety (block when any existing-dir worktree is unreadable) — PRI-712 | `git.mjs` `assessWorktreePruneSafety` | **reuse unchanged** — already satisfies SPEC §18 |
| primary-checkout identification | `git.mjs` `findPrimaryWorktree`, `getGitContext` | **reuse unchanged** |
| atomic lease create (`wx` = `O_EXCL`), TTL expiry, renewal, malformed-file detection with mid-write retry | `scripts/dev/lib/workspace-lease.mjs` | **reuse**; add writer identity on top |
| lease evaluation at commit time (invalid / branch-mismatch) | `workspace-lease.mjs` `evaluateLeaseForGuard` | **reuse unchanged** |
| dirty detection, merge-ancestry proof, GitHub `PR MERGED` evidence (squash-safe), residue scan, branch-only sweep, conflict codes | `scripts/dev/lib/workspace-lifecycle.mjs` | **reuse**; extend with UNKNOWN + residue taxonomy |
| lifecycle state machine (`ACTIVE` / `CLEANUP_PENDING` / `CLEANUP_READY` / `ORPHAN`) | `workspace-lifecycle.mjs` `classifyRecord` | **reuse**; add `PENDING` alias doc + UNKNOWN split |
| create task worktree CLI | `scripts/dev/create-task-worktree.mjs` | **modify** |
| single-target cleanup with completion proof + one `--force` retry only after clean | `scripts/dev/cleanup-task-worktree.mjs` | **modify** |
| dry-run-by-default sweep + re-verify-at-apply | `scripts/dev/workspace-cleanup.mjs` | **modify** |
| read-only health report | `scripts/dev/workspace-health.mjs` | **reuse**; keep as a lower-level view under `snapshot` |
| bootstrap (PATH repair for the Trae IDE bug, private-docs check, `npm install`, `npm run build`, toolchain health) | `scripts/setup-worktree.mjs` | **reuse** — do NOT write a second build/order authority (SPEC §7.2 Connection Before Creation) |
| root `npm run build` as the dependency-ordering authority | root `package.json` | **reuse unchanged** |
| write guard (judge-only, fails closed) | `scripts/dev/check-dev-worktree.mjs` | **reuse unchanged** |
| real-git test fixtures (bare origin + primary clone) | `scripts/__tests__/dev-worktree-test-utils.ts` | **reuse + extend** |

Confirmed **absent** (genuinely new work, each narrow):

* repo mutation mutex for shared Git metadata;
* Git LFS preflight;
* post-fetch ref-consistency assertion;
* error taxonomy (`TOOLCHAIN_MISSING` / `ENVIRONMENT_INVALID` / `REF_INCONSISTENT` / `NOT_READY` / `CHECK_FAILED`);
* readiness probes L1/L2/L3 and `PRIMARY_LEAKAGE` detection;
* stable writer identity + `git worktree lock` integration;
* Owner-facing snapshot with `LOCK` / `READY` / `CAN DELETE` columns and `--size`;
* migration tool;
* `check:workspace-tools` merge gate.

---

## 4. SPEC ↔ repository contradictions (recorded, per SPEC §28)

### C1 — `PENDING` vs the shipped `CLEANUP_PENDING`

SPEC §12 names four Owner-visible states; the repository already ships
`CLEANUP_PENDING` and `scripts/__tests__/workspace-lifecycle.test.ts` asserts it, and
`docs/architecture/workspace-lifecycle-guard-analysis.md` documents it.

**Decision:** keep `CLEANUP_PENDING` as the single authoritative token; `PENDING` in the
SPEC means the same state. Adding a second token for one state would violate P4.
Recorded in `AGENTS.md §23A` so nobody introduces a third name.

**Owner goal preserved:** the snapshot renders exactly the four SPEC states
(`ACTIVE` / `CLEANUP_PENDING` / `CLEANUP_READY` / `UNKNOWN`) plus `PRIMARY` / `BARE`.

### C2 — `git worktree repair` is not a recovery path (see §2.4)

SPEC §4 lists `repair` among the mutations to serialise; it stays in the mutex's scope,
but it must **not** be advertised as UNKNOWN recovery.

**Decision:** the mutex serialises it; the residue tool documents that repair cannot
help a fully-deleted admin entry.

### C3 — new path convention conflicts with the existing create tool

`create-task-worktree.mjs:117` computes
`path.join(path.dirname(primary.path), basename + '-' + taskPart + '-' + slug)`
and `:129` **fails if the parent directory does not exist**.

**Decision:** introduce a single root resolver (`lib/worktree-root.mjs`) that derives
`<parent>/_worktrees/<repo-basename>` and creates it on demand. No path may hardcode
`D:\Code`; `PD_WORKTREE_ROOT` overrides. Existing tests that assert the old sibling
layout must be updated together with the tool (they are the same change).

### C4 — `scanResidue` scope

`workspace-lifecycle.mjs:224` scans `path.dirname(primary)` for `<basename>-*`.
With the pool in place, residue can also appear inside the pool.

**Decision:** keep the existing sibling scan (it is what finds the 10 real directories)
and add a pool scan. Classification stays separate: a broken shell is `UNKNOWN` in both
locations; a broken shell inside the pool is never treated as better-known.

### C5 — post-checkout hook runs heavy work

`scripts/post-checkout-worktree.sh:66` runs `setup-worktree.mjs --skip-build`, which can
perform `npm install` on **every branch switch**. SPEC §9 explicitly forbids turning a
branch switch into a minute-scale operation.

**Decision:** replace the invocation with a cheap readiness probe; on `NOT_READY` print
the bootstrap command instead of running it.

### C6 — `defaultOwner()` embeds the pid

`workspace-lease.mjs:45` returns `user@host pid=<pid>`. SPEC §10.1 wants the pid demoted
to debug metadata and identity to be `task + writer`.

**Decision:** writer identity is a separate, explicit `writer` field; the lease `owner`
string becomes `writer:task` when claimed through the new CLI, with pid/host kept as
metadata. The legacy `dev:lease` CLI and `evaluateLeaseForGuard` keep working unchanged.

### C7 — `verify:merge` composition

`verify:merge` is a single long `&&` chain in root `package.json`. Adding a gate means
editing that chain (as PRI-788 did for `check:telemetry-events`). No structural change.

---

## 5. Implementation plan (mapped to SPEC phases)

### Phase 1 — Foundation

* `scripts/dev/lib/worktree-root.mjs` — `resolveWorktreeRoot()` (primary-derived, `PD_WORKTREE_ROOT` override, no hardcoded drive), `taskDirName()`, `adhocDirName()` (`adhoc-YYYYMMDD-<slug>-<rand6>`).
* `scripts/dev/lib/git-mutation-lock.mjs` — `acquireMutationLock()` / `releaseMutationLock()` / `withMutationLock()`. File `<git-common-dir>/pd-worktree-mutation.lock`, created with `flag:'wx'`, JSON body per SPEC §4.2. Existing lock ⇒ fail loud printing operation/pid/host/createdAt/target. Never auto-deletes; offers recovery text.
* `scripts/dev/lib/preflight.mjs` — LFS detection from `.gitattributes`; `assertRefFreshness()` (fetch → `FETCH_HEAD` → compare `refs/remotes/origin/<branch>`); error taxonomy constants.

### Phase 2 — Create / bootstrap / readiness

* modify `create-task-worktree.mjs`: new root, `--offline` freshness labelling, LFS preflight, ref assertion, branch/path conflict taxonomy, mutation mutex around `git worktree add` only, `CREATED_NOT_READY` + exact `nextAction` on bootstrap failure.
* `scripts/dev/bootstrap-worktree.mjs` — delegates to the existing `scripts/setup-worktree.mjs` (build order authority) then runs readiness; `--skip-install` / `--skip-build` passthrough.
* `scripts/dev/lib/readiness.mjs` + `scripts/dev/worktree-ready.mjs` — L1 dependency readiness, L2 build readiness, L3 real runtime resolution; `PRIMARY_LEAKAGE` hard gate naming package / actual path / expected root. Read-only, `--json`.

### Phase 3 — Claim / release / snapshot

* `scripts/dev/lib/worktree-lock.mjs` — `git worktree lock/unlock` wrappers + `STALE_LOCK` detection (expired lease + still locked ⇒ report, never auto-unlock).
* `scripts/dev/worktree-claim.mjs` (`--writer`), `scripts/dev/worktree-release.mjs` (idempotent).
* `scripts/dev/worktree-snapshot.mjs` — Owner table (`TASK WRITER STATE DIRTY PR LOCK READY CLEANUP`), `--json`, `--size` on demand.

### Phase 4 — Cleanup safety

* `scripts/dev/lib/residue.mjs` — residue taxonomy, junction/reparse-point-safe deletion (enumerate without traversal, detach link, assert external target survives, then remove contents), progress output every N files.
* modify `cleanup-task-worktree.mjs` and `workspace-cleanup.mjs`: identical lease/lock/DIRTY refusal, mutation mutex around removal + branch deletion, residue reporting, `--ack-unknown` gate.

### Phase 5 — Migration

* `scripts/dev/workspace-migrate.mjs` — dry-run by default (`WOULD MOVE` / `WOULD SKIP` / `UNKNOWN` / `ACTIVE`), `--apply` moves only registered + safe + inactive via `git worktree move` under the mutex.

### Phase 6 — Gate + docs

* `scripts/check-workspace-tools.cjs` — asserts the tool surface, the npm script wiring, the root-resolver contract (no hardcoded drive), the junction-safety guarantee, and that `verify:merge` includes the gate. Wired into `verify:merge`.
* `AGENTS.md §23A` — extend the stable-ID series to `git-10`…`git-14`.
* `docs/architecture/` — worktree governance reference.

### Acceptance / verification (SPEC §23)

New tests in `scripts/__tests__/`: writer identity & PID-independence, centralized root
derivation, concurrent Git mutation mutex, LFS refusal, `PRIMARY_LEAKAGE`, fresh
bootstrap→ready, active-lease cleanup refusal, locked-worktree cleanup refusal, UNKNOWN
residue refusal + explicit ack, junction safety (external target survives), migration
(dry-run + apply + ACTIVE/UNKNOWN skip), ref inconsistency.

---

## 6. Residual risks and explicit non-goals

* **The 10 existing broken directories cannot be migrated.** They are not registered
  worktrees, so `git worktree move` is not applicable; and repair cannot help (§2.4).
  They will be reported as `UNKNOWN` with full forensic evidence and remain until the
  Owner explicitly acks removal. This is the SPEC's intended outcome (D6/§15.2), not a
  shortfall.
* **My own implementation worktree is created at the new convention**
  (`D:\Code\_worktrees\principles\PRI-796-worktree-governance-v2`), with a stable lease
  `workbuddy:worktree-governance-v2` (SPEC §29).
* **No second build-order authority** is introduced; `npm run build` stays authoritative.
* Out of scope by SPEC §26 and intentionally untouched: workspace database, registry
  service, daemon, watcher, webhook, distributed lock service, IDE plugin, Console UI,
  PD product runtime, shared full `node_modules`, auto reset/stash/`clean -fdx`,
  automatic UNKNOWN deletion, hand-edited `.git/worktrees`, per-entry prune.
