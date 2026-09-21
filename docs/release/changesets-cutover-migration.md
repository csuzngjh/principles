# Changesets Cutover — Baseline Migration Report

> SPEC v1.2 Final ("Changesets Cutover & Release Contract for PD"),
> implementation PR evidence. Capture date: 2026-09-20, base commit
> `8821d1b5` (origin/main after PR #1781). The registry snapshot backing
> every number below is [registry-baseline-20260920.json](./registry-baseline-20260920.json)
> (migration evidence only — nothing in the release path reads it).

## 1. Baseline alignment table (SPEC §37.2)

| Package | Main before | Registry baseline (latest) | Aligned to | Unpublished source delta |
|---|---:|---:|---:|---|
| `@principles/core` | 1.74.1 | 1.286.0 (gitHead `7e8bf2f0`) | **1.286.0** | 20 files — evaluator/owner-decision/internalization work (#1766, #1781) → first changeset: **minor** |
| `@principles/install-layout` | 0.2.0 | 0.2.6 | **0.2.6** | none |
| `@principles/host-runtime` | 0.1.0 | 0.7.7 | **0.7.7** | none |
| `@principles/codex-adapter` | 0.1.0 | 0.4.4 | **0.4.4** | range fix only (host-runtime ^0.7.7) → first changeset: **patch** |
| `@principles/pd-cli` | 1.74.1 | 1.152.10 | **1.152.10** | range fixes (plugin ^2.0.1, host-runtime ^0.7.7, codex ^0.4.4) → first changeset: **patch** |
| `principles-disciple` | 1.76.1 | 2.0.1 (gitHead `fb397452`) | **2.0.1** | 6 files — pain/llm hooks, sync script → first changeset: **patch** |
| `create-principles-disciple` | 1.74.1 | 1.143.3 | **1.143.3** | 41 files + pd-console payload (24 files) — update-chain rework (#1768) → first changeset: **minor** |

Root Product Version: **2.1.0 — untouched** by the alignment.

**Version alignment is a starting point, not a content claim.** Aligning
`package.json` to the registry latest does NOT mean main's source equals the
published artifact content; the unpublished source delta since each
registry-latest `gitHead` is accounted by the first pending changesets
above (SPEC §9.3/§9.4), which the first Version Packages PR will release
on top of the aligned baselines.

## 2. Alignment decisions

1. **Versions only, not ranges** — except three ranges that would EXCLUDE
   the aligned version and force npm to nest stale registry copies inside
   the workspace (ERR-131 single-copy violation; the 2026-09-19 train
   failure mode): pd-cli's `principles-disciple ^1.74.1 → ^2.0.1`,
   `host-runtime ^0.1.0 → ^0.7.7` (pd-cli + codex-adapter), plus the
   plugin's devDep `host-runtime ^0.1.0 → ^0.7.7`. All other ranges already
   match what the registry's own latest versions declare (snapshot field
   `internalDependencies`).
2. **Component mirror**: `openclaw.plugin.json` aligned to `2.0.1` (the one
   approved mirror, SPEC §15.1).
3. **README badge syncing dropped** — cosmetic, non-authority (§15.3); the
   old CI "Sync version to all files" also contaminated the root manifest
   and is deleted outright.
4. **Lockfile** materialized with `npm install --package-lock-only
   --ignore-scripts --no-audit --no-fund`: no node_modules writes, no
   lifecycle, no registry fetch for this internal-only change; root pin
   stayed 2.1.0 (containment held). Workspace pins verified equal to the
   aligned manifests.

## 3. Freeze of old writers (SPEC §9.1)

The adoption PR deletes, in one cutover with no fallback flags: the
commit-message bump inference and `version_bump` dispatch input
(publish-npm.yml), the same plus registry-reset-then-bump in the shared
action, the weekly auto-publish matrix, the full-product per-package bump,
and the runner-local "sync version to all files". A repository-wide sweep
for `version_bump` / `Analyze commits` / `npm version` / `bump_version` /
`Sync version to all files` finds no remaining writers (pinned by
`release-workflows.test.ts`). No in-flight publish existed at freeze time
(latest train completed 2026-09-19, all gitHeads `fb397452`).

## 4. Live verification evidence (real repo, real registry)

| Contract | Evidence |
|---|---|
| Guard passes its own adoption PR | `RELEASE_INTENT_GUARD PASS mode=normal ... intent=@principles/codex-adapter:patch,@principles/core:minor,create-principles-disciple:minor,@principles/pd-cli:patch,principles-disciple:patch` |
| Materialization round-trip on the real repo | `materialize-version-plan.mjs` produced core 1.287.0 / codex 0.4.5 / pd-cli 1.152.11 / plugin 2.0.2 + mirror / installer 1.144.0; root stayed 2.1.0; the guard then reproduced the diff and passed `mode=version-pr` with all five releases |
| `ABSENT` | `registry-exact.mjs principles-disciple 9.9.9` → exit 0 |
| `PRESENT_MATCH` | `registry-exact.mjs principles-disciple 2.0.1 --expect-git-head fb39745...` → exit 0 |
| `PRESENT_CONFLICT` | same with a wrong expectation → exit 3 |
| `LOCAL_BEHIND_REGISTRY` (T1 gate) | `registry-exact.mjs principles-disciple 1.76.1` → exit 6, "committed version is behind the registry latest (2.0.1)" |
| `REGISTRY_ERROR` handling | lib-level tests (5xx/network/malformed retried bounded, never read as absent) |
| ERR-131 / T26 | `changeset version` on a clean tree: no node_modules, no lockfile change, no network; versions land |
| Cohort resolution | no cohort in current main history → clean exit-2 no-op (T24); merge-SHA identity proven by `--is-cohort` in fixtures and by the real-repo reproduction |

## 5. Known boundaries and deviations (explicit, for Owner review)

1. **`PD_VERSION_PR_TOKEN`** — with the default `GITHUB_TOKEN`, the bot's
   Version PR will not run `pull_request` checks ("Verify Merge Gate" never
   appears; branch protection blocks merge). One secret (fine-grained PAT,
   contents:write + pull-requests:write) flips the single
   `${{ secrets.PD_VERSION_PR_TOKEN || github.token }}` fallback to the
   full path. This is an Owner-side setup action, documented in
   RELEASE_PROCESS.md.
2. **T25 (real bot E2E)** — the Version PR workflow only exists after this
   PR merges; the E2E (bot PR → checks → merge → cohort dispatch → publish)
   is the first-post-merge validation step, by construction. Everything
   short of it is proven above (reproduction, dispatch wiring, contract
   guards, publish-train shape).
3. **T13 wording vs changesets reality** — under
   `updateInternalDependencies: "patch"` with changesets v5, an internal
   dependency release does NOT auto-release dependents; the "transitive
   plugin release" case in practice is the author adding the plugin
   changeset alongside core's (a core major additionally requires the
   manual dependent range edit — covered by the T4 test). The C4 guard is
   plan-based and catches every path that lands the plugin in the plan.
4. **Baseline-alignment window** — the guard's version-field freeze admits
   exactly one exemption: a PR that ADDS a fresh
   `docs/release/registry-baseline-*.json` snapshot AND moves each version
   onto that snapshot's registry latest. After this PR merges, exploiting
   the exemption would require fabricating registry evidence that the
   publish train's `LOCAL_BEHIND_REGISTRY`/`PRESENT_CONFLICT` checks then
   contradicts.
5. **Dependabot/renovate PRs** will now fail the guard until they carry a
   changeset (dependency contract changes are release-affecting by design,
   SPEC §10.1). Operational note for reviewers of such PRs: add the
   changeset or an empty one.

## 6. Rollback reality (SPEC §35)

- **Before the first new-model npm publish**: revert this PR — the old
  workflows are gone from main but recoverable from history.
- **After any new-model npm version is published**: registry facts are
  irreversible; recovery is forward-fix or baseline reconciliation. Never
  republish a used version.
