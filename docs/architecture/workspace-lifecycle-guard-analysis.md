# Workspace Lifecycle Guard — Current-State Analysis (PRI-691)

> Phase 0 artifact. Written before any implementation code, per the task
> directive. Evidence gathered 2026-09-06 from `origin/main` @ `bed8aedb8`.

## 1. Problem

PD runs a multi-AI development environment on one machine: one git worktree per
task (git-1), one writer per worktree (git-2), PR-based review, Owner-only
merge. Creation of lifecycle artifacts has reliable, guard-wired entries.
Cleanup does not. Measured accumulation (cleaned 2026-09-06 in an out-of-band
sweep): 39 fully-merged local branches (oldest from June), 15 stale remote
branches with closed-unmerged PRs, 10 removable worktrees, 31 deregistered
"dead shell" directories (Windows `git worktree remove` left the directory
behind while deleting the admin entry), one junction inside the primary
checkout pointing at a dead shell, and one metadata-corrupted worktree (the
2026-09-04 admin-deletion incident).

Root cause: inflow ≈ 10 merged PRs/day (peak 21) with **zero automated or
scheduled outflow**; cleanup happened only when a session noticed.

## 2. Current state (what already exists)

### Entry path (well covered)

| Step | Tool / guard | Notes |
| --- | --- | --- |
| Worktree + branch creation | `scripts/dev/create-task-worktree.mjs` (`npm run dev:worktree`) | Bases on fresh `origin/main`; branch `ai/<task>-<slug>` |
| Commit/push safety | `scripts/dev/check-dev-worktree.mjs` wired into lefthook (pre-commit/pre-push `worktree-guard`) | Fail-closed judge: primary checkout, unsafe git state, detached head, protected branch, lease validity |
| Concurrent-write guard | `scripts/dev/workspace-lease.mjs` (`npm run dev:lease`) — PRI-663, `git-9-lease-before-write` | One gitignored lease file per checkout; TTL; acquire refuses primary |
| Branch naming | `ai/<task>-<slug>` convention | Task id is embedded in the branch name — task↔branch↔PR↔Linear are derivable from git + GitHub, no extra registry needed |

The worktree tooling records an explicit design decision
(`create-task-worktree.mjs` header): **"Git itself stays the ownership
registry — this tool creates state, it does not track it in any database."**
Any lifecycle tooling must honor that: derive state at scan time from git +
GitHub, never persist a second copy of it.

### Cleanup path (the gap)

- `scripts/dev/cleanup-task-worktree.mjs` (`npm run dev:worktree:cleanup`)
  removes ONE named worktree/branch. Safety is strong (porcelain-clean check,
  ancestry-to-`origin/main` proof, junction-safe removal per ERR-098, single
  `--force` retry for ignored build output only). But:
  1. **It is per-target** — the caller must already know what to clean. There
     is no "what is cleanable?" scan.
  2. **Squash-merged tasks cannot be proven** via ancestry (its own header
     documents this fail-closed choice), so the official tool refuses a whole
     class of completed tasks — they linger until a human intervenes.
  3. **No grace period concept** — the moment a branch merges, the tool would
     remove it; there is no "keep for N days" buffer.
  4. **No visibility** — nothing reports primary-checkout drift, worktree
     health, or deregistered residue. Every finding so far required manual
     forensics.

## 3. Gap analysis → v1 scope

| Gap | v1 answer |
| --- | --- |
| No discovery of cleanable worktrees | `workspace-health` classifies every registered worktree: `ACTIVE` / `CLEANUP_PENDING` / `CLEANUP_READY` / `ORPHAN` (+ non-candidates `PRIMARY` / `MAIN_CHECKOUT`) |
| Squash-merged tasks unprovable | Completion evidence accepts **GitHub PR `MERGED` state** (authoritative for squash) **or** ancestry-to-`origin/main` (authoritative for merge commits); both are existing sources of truth, read-only |
| No grace buffer | `--grace-days N` (default 7) — merged worktrees become `CLEANUP_READY` only after the grace period |
| No safe bulk exit | `workspace-cleanup` — dry-run by default, `--apply` explicit; only `CLEANUP_READY` records produce actions |
| No health visibility | `workspace-health` reports primary drift (branch/dirty/conflict/behind-ahead) and deregistered residue shells — report only, never repairs |
| No AI-activity awareness in cleanup | An active `git-9` write lease on a candidate worktree blocks its cleanup (reuse `lib/workspace-lease.mjs`; no new lock mechanism) |

## 4. Design decisions and interpretations

1. **Stateless.** Every status is a pure function of `git worktree list`,
   `git status --porcelain`, `git merge-base`, branch refs, `gh pr list`
   JSON, file mtimes/leases — computed per run. Nothing is persisted. This
   is the repo's recorded design stance (§2), and avoids the drift failure
   mode of a manifest written by dozens of uncoordinated writers.
2. **Completion evidence (worktree removal) = PR merged OR ancestry, then
   AND clean AND grace exceeded AND not primary AND no active lease.** The
   task directive's literal "PR merged AND commit exists in main" cannot be
   satisfied simultaneously for squash merges (the squash commit *is* in
   main; the branch tip never is). We interpret "commit exists in main" as
   "merged content is provably in `origin/main`", which PR-merged state and
   ancestry each establish independently; both are Owner-controlled
   authorities (GitHub merge button / git history). A clean worktree whose
   PR was merged has no unique content — the same standard as GitHub's own
   delete-branch button. Documented here as the evidence chain.
3. **Branch deletion evidence = PR merged OR origin branch gone OR ancestry.**
   The directive states this rule as an OR; ancestry is added to match the
   existing per-target tool's proven standard.
4. **Branch-only sweep restricted to `ai/` prefixed branches** (the git-1
   task-branch convention). `main`, `fix/*`, release and other refs are
   never touched by the sweep; unknown-looking branches simply fall outside
   the candidate set. Branches checked out in any worktree are handled by
   that worktree's record only.
5. **ORPHAN is report-only.** Branch deleted / no PR / detached / unreadable
   status / unregistered residue → surfaced with a reason, never mutated.
   "No PR found" does not imply junk (e.g. deliberately kept unmerged
   branches), so only the report names them.
6. **GitHub unavailability degrades, never invents.** When `gh` is missing
   or fails, PR evidence is `UNKNOWN`; classification falls back to
   git-only proof (ancestry), and anything unprovable stays uncleanable.
   `PD_WORKSPACE_SKIP_GH=1` forces this mode (used by tests).
7. **The primary checkout is never a cleanup target** and is never repaired
   by these tools (git-3; drift is reported, fixing it is a human/session
   decision).
8. **No git workflow changes**: creation, naming, PR flow, and the existing
   per-target cleanup tool stay as-is. The new tools are additive read/
   sweep surfaces beside them.

## 5. Non-goals (per directive)

No manifest files, no workspace database, no lock files, no daemon/webhook/
background service, no PD product surface, no agent orchestration, no
ownership system, no distributed coordination, no auto-repair.

## 6. Verification plan

- Pure classifier + planner: hermetic unit tests over synthetic records —
  ACTIVE / PENDING / READY / ORPHAN derivation, and the refusal matrix
  (dirty, not merged, within grace, lease held, unknown evidence, primary).
- Real-git integration tests (existing `dev-worktree-test-utils` fixture):
  create → commit → merge → dry-run lists candidate → `--apply` removes
  worktree + branch; dirty worktree is skipped and survives; unmerged
  worktree is skipped and survives. GitHub evidence path covered by unit
  fixtures (`gh` is unavailable in fixtures by design).
