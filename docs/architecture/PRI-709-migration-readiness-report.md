# PRI-709 Migration Readiness Report — ReleaseManager Authority

**Status:** three P0 blockers closed (P0-1 / P0-2 / P0-3)
**Date:** 2026-09-08
**Origin:** PRI-698 Phase 0 Architecture Audit (findings F-1 / F-2 / F-3 / F-4)
**Parent:** PRI-698 · **Issue:** PRI-709

---

## 1. Executive summary

The PRI-698 audit judged the ReleaseManager **NOT READY** to be the sole
mutation authority, on three state-truth gaps. PRI-709 closes all three with
the smallest coherent change per gap:

| Blocker | Gap | Closed by |
| --- | --- | --- |
| F-4 / P0-1 | `PD_RELEASE_METADATA_URL` had no supply side at all | release metadata **source contract** + durable `install.json` tier |
| F-1 / F-2 / P0-2 | installer never wrote `active.json`; the version it would have written was wrong (pd-cli vs product) | **active record commit point** at `confirmed`, identity from the product/artifact manifest |
| F-3 / P0-3 | console updater mutated the runtime with **zero** journal writes | legacy apply / apply-full / rollback now write the **shared** transaction journal |

What is **not** done, by explicit scope decision: a signed-metadata publishing
pipeline. The contract consumes a source; it does not create one. Operational
readiness therefore still requires an actual signed metadata repository to
exist (see §5).

## 2. Acceptance criteria

### ① After a successful RM apply, `active.json` is correct

- `install()` writes `~/.pd/active.json` at the confirmed commit point
  (`commitInstallerActiveRecord`), **journal-first** — after the `confirmed`
  append, never before, so a crash in between is recoverable from the journal.
- Identity comes from the transaction, not a second computation: the journal
  was opened with the payload's own identity (asset-manifest digest when the
  self-contained asset ships one), and active.json must agree with the journal
  of the transaction that produced it.
- **F-1 fixed:** productVersion is now the PRODUCT manifest
  (`pluginDir/package.json`), not `pd-cli/package.json`. Owner-machine evidence:
  plugin `1.230.2` vs pd-cli `1.147.5`; every confirmed journal recorded
  `1.147.5` — a version no runtime state could ever match.
- Generation continuity: `max(journal.generation, previous.generation + 1)` — a
  standalone install can no longer silently reset an existing deployment's
  generation backwards; an RM-adopted generation is preserved.
- Tier-2 failure policy: the commit point runs after the backup was discarded,
  so a write failure is logged loud and returned, never thrown — it cannot
  brick a committed install.
- Tests: `tests/installer-active-record.test.ts` (9), including the exact
  Owner-machine version-mismatch shape.

### ② `check` no longer reports a false "update available"

- `ReleaseManager.check` evaluates the candidate against the **current**
  deployment read from `active.json`. Before P0-2, `active.json` was never
  written by the installer, so `evaluateCandidateDecision` always ran the
  `current: null` branch — every check claimed an update, even for the release
  already deployed.
- With a real active record, `current.releaseId === candidate.releaseId`
  resolves to `direction: 'reinstall'` (`release-policy.ts`), not an upgrade.
- **Residual (documented, not silently accepted):** an install produced by the
  plain installer carries a `bundled-…` releaseId with no cached
  `releases/<id>/metadata.json`, so the strict current-release comparison
  cannot resolve and check conservatively reports an update. This state is only
  reachable once a metadata source is configured, and it is immaterial while
  the legacy updater is the serving authority. Closing it belongs to the
  activation rollout (map the bundled releaseId to its metadata), not to P0.

### ③ Every runtime mutation has journal evidence

- Installer paths (existing, PRI-664) — planned → … → confirmed, Tier-1
  refusal before any mutation.
- ReleaseManager apply — orchestrates the installer, so it inherits the same
  journal; **no second transaction is created**.
- Console legacy paths (P0-3) — apply / apply-full / rollback now write the
  SAME journal (`~/.pd/transactions/<txId>.jsonl`), reusing
  `transaction-journal` (no new journal implementation). `planned` lands after
  request validation, so a rejected request leaves no transaction.
- Transition strategy: legacy `rollback` terminates in `confirmed`, not
  `rolled_back` — a rollback is a forward transition to a known-good
  deployment; `rolled_back` means "this transaction was undone".
- No fabricated digests: the legacy updater verifies no signed metadata, so
  provenance is `fallback` (marker sha256, readable but explicitly not
  verifiable). It never claims `manifest` / `signed_channel`.
- Explicit degradation, never a blocked mutation: a missing journal module or a
  failing append is reported loud and the Owner's mutation still runs.
- Tests: `tests/server/update/legacy-mutation-journal.test.ts` (8).

### ④ The legacy updater is still a safe fallback

- The authority reason vocabulary is unchanged. `metadataBaseUrl === undefined`
  still yields `metadata_source_unconfigured`, and the Console still routes to
  the legacy updater — nothing guesses an endpoint.
- `invalid` short-circuits instead of falling through: an operator's broken
  override is reported, never silently bypassed in favour of install state.
- The new `metadataSource` field is diagnostic only; no routing depends on it.
- Console wiring suites green: `tests/server/update` 38/38,
  `tests/server/routes/update*` 98/98.

## 3. Commits and reviews

| Sub-goal | Commit | PR (stacked) |
| --- | --- | --- |
| P0-1 metadata source contract | `0a721a3d3` | [#1563](https://github.com/csuzngjh/principles/pull/1563) ← main |
| P0-2 active record commit point | `09b0ee263` | [#1572](https://github.com/csuzngjh/principles/pull/1572) ← #1563 |
| P0-3 legacy mutation journal | `a272e3618` | see PRI-709 ← #1572 |

Stacked on purpose: each sub-goal is an independently reviewable diff
(P0-2 adds 2 files + 1 modified, P0-3 adds 2 files + 1 modified), and each PR's
diff contains only its own change.

## 4. Incident during implementation (disclosed)

While implementing P0-3, a concurrent process on this machine deleted large
parts of the task worktree (at one point the whole `packages/pd-console` tree)
and repeatedly SIGTERM'd long-running git commands. One P0-3 commit
(`1bf31acec`, briefly pushed) accidentally recorded 54 of those deletions via
`git add -A`.

That commit was **replaced** with `a272e3618`, rebuilt with git plumbing
(read-tree / update-index / commit-tree) directly from the intact P0-2 tree so
that the P0-3 diff contains exactly the three intended files and zero
deletions. The branch was force-pushed over the bad commit. P0-1 and P0-2 were
verified intact (file counts 2787 / 2788, key files present) and were never
affected.

Follow-up worth an Owner decision: the worktree-eating process is still
unidentified. Running installers, agents or cleanup tools against a task
worktree concurrently with git operations can silently destroy work.

## 5. What remains before the ReleaseManager is the sole authority

1. **A signed metadata repository must actually exist.** No publishing step in
   CI produces `channels/<channel>.json` or signed release targets today. Until
   it does, `metadata_source_unconfigured` is the honest state for every
   install, and the legacy updater keeps serving.
2. **Operator supply path:** set `PD_RELEASE_METADATA_URL` at install time (the
   installer persists it into `~/.pd/install.json`) or export it per-process.
3. **Phase 2 rollback** (`ROLLBACK_AVAILABLE = false`) and the plugin-diff
   `apply` kind remain structurally not-ready — unchanged by PRI-709.
4. **Residual ②** above: map installer-only `bundled-…` releaseIds to cached
   metadata before the activation rollout flips the serving authority.
