# PRI-879 — Changesets Feasibility Experiment

> Date: 2026-09-20 · Status: Experiment complete · Scope: **feasibility experiment only — nothing in this repository was changed by the tool under test.**
> Decision: **ADOPT WITH CONSTRAINTS** (§Adoption Decision).
> Reading prerequisites: `docs/architecture/version-model.md` (PRI-877),
> `docs/architecture/release-dependency-map.md` (PRI-878).
>
> Note on the task premise: `docs/research/package-release-system-audit.md`,
> listed as required reading, does not exist on `main`, on any local branch, nor
> in the private docs repo. The equivalent current facts were taken from
> `.github/workflows/publish-npm.yml`, `.github/actions/publish-npm-package/action.yml`
> and the two PRI-877/878 documents instead.

---

## Executive Summary

Changesets was tested against the four questions that decide this, in a
throwaway copy of `main`, with every file write observed rather than documented.

| Question | Verdict | Evidence in one line |
| --- | --- | --- |
| **Q1 Ghost packages** — are the installer's generated/bundled copies treated as release packages? | **PASS** | Discovery sees exactly 10 packages, `DUPLICATE NAMES: none`; the 8 nested bundle copies (`@principles/core@1.278.6`, `pd-cli@1.147.11`, …) are never read and never written. |
| **Q2 ERR-131** — does `changeset version` touch the install graph? | **PASS (LOW)** | Instrumented trace of a real version run: **one** subprocess, `git log --diff-filter=AC --follow --max-count=1 --pretty=format:%H:%p .changeset/exp-k.md`. Zero npm invocations, zero network calls, `node_modules` never created, `package-lock.json` byte-identical after a **core major** that rewrote four consumers' ranges. |
| **Q3 Independent versioning** | **PASS** | One changeset declaring `core patch` + `pd-cli patch` + `plugin minor` yields 1.74.2 / 1.74.2 / 1.77.0 — three independent numbers, no convergence. |
| **Q4 Boundary containment** | **PASS, zero custom code** | Across 16 runs the Product Version carrier (root `package.json`), `runtime-version.json`, `openclaw.plugin.json` and every installer file were never modified. No hook, wrapper or patch was needed to achieve this. |

The real gain is not the tool's features but the change of authority: today CI
**guesses** the bump from commit-message regex (`publish-npm.yml:275-301`); with
Changesets the author **declares** it in a one-line file that review can read.
The real cost is a new mandatory per-change ritual plus a new silent-failure
class (§Complexity Delta) — and it only pays off if the commit-regex inference is
deleted in the same change, otherwise PD ends up with two bump authorities,
which is worse than either one alone.

---

## Baseline

| Item | Value |
| --- | --- |
| `main` at experiment start | `f3ef3102` |
| PR #1781 (version-governance closeout) | **OPEN**, `mergedAt: null` → treated as pending, not as production fact |
| `@changesets/cli` | `3.0.2` (root `package.json:68`, devDependency, currently unwired: `grep -rln changeset .github package.json scripts` → only `package.json`) |
| `.changeset/` on main | tracked, contains only `README.md` + `config.json` — no real changesets exist |
| Root manifest | `principles-disciple-monorepo`, `version 1.76.1`, `private: true`, `workspaces: ["packages/*"]` |

`.changeset/config.json` verbatim (not modified in the real repo; the lab copy's
variants are recorded per experiment):

```json
{ "changelog": "@changesets/cli/changelog", "commit": false,
  "fixed": [], "linked": [], "access": "restricted", "baseBranch": "main",
  "updateInternalDependencies": "patch", "ignore": [] }
```

The config was **not assumed correct**: `fixed`/`linked` are empty (so no
lockstep is currently expressible — see Experiment T), `ignore` is empty (and
shown below to accept invalid entries without complaint), and
`access: "restricted"` contradicts PD's public npm packages. All three are
adoption-time config work, recorded as constraints rather than blockers.

---

## PD Boundary Being Tested

Per PRI-877/878: the candidate scope is **C3 package-release only** — the npm
component version of the 7 publishable packages, their internal dependency
ranges, and their changelogs. C1/C2 are read as inputs (which package changed,
what it depends on). C4 product-assembly, C5 runtime, C6 distribution and C7
host-integration must stay outside the tool's reach.

The specific test: does the tool ever *infer* a C4–C7 consequence? (§Private
Package Test, §Product Version Containment.)

---

## Experiment Environment

**Disposable copy, not a worktree of the Owner's checkout:**

```
C:\Users\Administrator\AppData\Local\Temp\pri879-cs-lab
```

* built with `git archive` of `main` (`f3ef3102`), committed as lab baseline **`ae3c112`**;
* **no remote**, never pushed, deleted-able wholesale;
* **no `node_modules`** — deliberately absent, see §ERR-131;
* 29 tracked `package.json`; `SNAPSHOT-BEFORE.json` recorded sha256 prefixes of
  19 protected files (root manifest, lockfile, config, `packages/*/package.json`,
  `runtime-version.json`) before any command ran.

The CLI itself was always invoked **read-only from the PRI-879 worktree**:

```bash
node "<worktree>/node_modules/@changesets/cli/bin.js" <cmd>   # cwd = lab copy
```

The Owner's working tree (`D:\Code\principles`) and the PRI-879 worktree were
never targets of any changesets command. `changeset version` has **no dry-run
flag** in 3.0.2 (`--help` lists only `--ignore`, `--snapshot`,
`--snapshot-prerelease-template`), so "verify it is read-only first" could not be
satisfied by a flag: `changeset status` was instead proven read-only by trace
(§ERR-131) and used as the planning view, and the write run was done only inside
the copy.

Every experiment ran on its own lab branch off `ae3c112`; `main` was reset
between experiments. Note the copy's default branch had to be renamed to `main`
(`git branch -m main`): with `baseBranch: "main"` and no `main`, `status` fails
loudly — `Failed to find where HEAD diverged from "main"` — which is itself a
CI-wiring fact.

### Lab-only instrumentation (declared per the task's disclosure rule)

`tmp-cs-trace.cjs`, loaded via `NODE_OPTIONS=--require`, hooked
`child_process.{spawn,exec,execFile,fork,spawnSync,execFileSync}`,
`http/https.{request,get}`, `net.Socket.connect` and `fetch`, appending every hit
to a log file. **It never patched a production script**; it sat in the worktree
and observed the CLI process only. Sentinel evidence for install side effects did
not need a fabricated lifecycle hook: the lab had no `node_modules` and no
remote, so any `npm install`/registry access would have been both traceable and
visible as a new directory.

---

## Package Discovery

`@manypkg/get-packages` against the lab (probe deleted before commit):

```
toolType=undefined (npm/yarn workspaces) count=10
duplicate names: none
  @principles/codex-adapter         packages/codex-adapter@0.1.0
  create-principles-disciple        packages/create-principles-disciple@1.74.1
  @principles/host-runtime          packages/host-runtime@0.1.0
  @principles/install-layout        packages/install-layout@0.2.0
  principles-disciple               packages/openclaw-plugin@1.76.1
  @principles/pd-cli                packages/pd-cli@1.74.1
  @principles/pd-companion          packages/pd-companion@0.1.2        (private)
  @principles/pd-console            packages/pd-console@0.1.0          (private)
  @principles/core                  packages/principles-core@1.74.1
  @principles/website               packages/website@1.0.0             (private)
ghost core on disk exists: true        ← packages/create-principles-disciple/core/package.json
```

Two facts the workspace glob alone cannot tell you:

1. Discovery is **depth-1 `packages/*`**. The installer's bundled copies are
   depth-2 and are invisible — `@principles/core` appears exactly once even
   though a second manifest with the same name sits on disk at `1.278.6`.
2. The **root** manifest is not in the list. Changesets reads it only for
   `workspaces`, never as a versionable package — which is why the Product
   Version carrier is structurally out of reach (§Product Version Containment).

`plugins/principles-disciple/**`, `tests/**` and the fixture manifests are
likewise outside the glob: fixtures are invisible to the tool, so the
Canonical/Generated/Fixture split from PRI-878 needs no encoding for the tool to
respect it.

---

## Ghost Package Test

**Default behaviour: safe, no configuration required.**

| Run | What was dirtied | Ghost copies after `changeset version` |
| --- | --- | --- |
| Exp A/F (core patch) | `@principles/core` → 1.74.2 | `create-principles-disciple/core/package.json` still `1.278.6`; `.../pd-cli` still `1.147.11`; `git diff -- 'packages/create-principles-disciple/**'` → **empty** |
| Exp E (core major, 5 packages rewritten) | consumer ranges rewritten | installer directory still **absent** from the changed-file list |
| Exp AB (ghost copy itself edited to `9.9.9`, committed, plus a real core changeset) | ghost deliberately mutated by hand | `changeset version` left the ghost at `9.9.9` (it does not restore either) and bumped only the canonical core |

**Residual risk — path-prefix change attribution (the actual finding).** In Exp AB,
`changeset status --since main` exited 1 with *"Some packages have been changed
but no changesets were found"*. Ghost files live **under**
`packages/create-principles-disciple/`, so the tool attributes a bundle change to
the installer package and demands a changeset for it. Structurally that is the
right instinct — a bundle change does mean the installer must republish (the
PRI-558 class of bug CI guards today) — but the tool cannot distinguish
`core/` (real payload) from `dist/`, `tests/`, `release-locks/`, `console/` or a
README edit, so in CI this check fires on **any** installer-directory commit and
teaches everyone to add a meaningless empty changeset. This is a wiring decision
(keep it out of required checks, or scope the path filter), not a tool defect,
and it is the one ghost-related cost worth naming.

**Official mitigation attempted and judged:** none is needed for Q1 (exclusion is
the default). `ignore` was tested as the official exclusion lever and found
unreliable for that purpose — see §Private Package Test.

```
Default behavior   : ghosts invisible to discovery, never written
Official mitigation: not required
Residual risk      : LOW — path-prefix change attribution lumps generated files
                     with the installer package (exit 1 if enforced in CI)
```

---

## Version Mutation Test

Exp A — a single `@principles/core: patch` changeset, real `changeset version`,
complete filesystem diff (whole worktree, no filtering):

```
 D .changeset/exp-a-core.md
 M packages/principles-core/CHANGELOG.md
 M packages/principles-core/package.json     1.74.1 → 1.74.2
```

| File | Expected | Unexpected | Reason |
| --- | ---: | ---: | --- |
| `packages/principles-core/package.json` | ✅ | — | declared bump, 1.74.1 → 1.74.2 |
| `packages/principles-core/CHANGELOG.md` | ✅ | — | new `## 1.74.2` section |
| `.changeset/exp-a-core.md` | ✅ | — | consumed (deleted) by design |
| `packages/pd-cli/package.json` (depends on core `^1.74.1`) | ❓ | ✅ **untouched** | `1.74.2` satisfies the existing range → no rewrite, no indirect bump (Exp Z1) |
| root `package.json` (Product Version carrier) | ✅ | ✅ untouched | not a workspace member package |
| nested generated package copies | ✅ | ✅ untouched | depth-2, invisible |
| `package-lock.json` | ✅ | ✅ untouched | md5 unchanged (see below) |
| `runtime-version.json` / `openclaw.plugin.json` / `plugins/**` | ✅ | ✅ untouched | never in any diff |
| anything under `packages/create-principles-disciple/` | ✅ | ✅ untouched | — |

Exp E (core **major**) widened the mutation to exactly the npm-visible graph:

```
packages/principles-core/package.json      1.74.1 → 2.0.0
packages/host-runtime/package.json         0.1.0  → 0.1.1   dep: core → ^2.0.0
packages/codex-adapter/package.json        0.1.0  → 0.1.1   deps: core → ^2.0.0, host-runtime → ^0.1.1
packages/pd-cli/package.json               1.74.1 → 1.74.2   deps: core → ^2.0.0, +2 more
packages/openclaw-plugin/package.json      1.76.1 → 1.76.2  dep: host-runtime → ^0.1.1
```

Still nothing outside `packages/*/package.json` + their `CHANGELOG.md`.
`create-principles-disciple` — which *does* depend on `@principles/install-layout`
— was untouched because install-layout was not bumped.

---

## ERR-131 Side Effect Test

Traced with the `--require` probe (lab has no `node_modules`, no remote):

```
--- probe loaded pid=76672 argv=… node …/@changesets/cli/bin.js version
child_process.spawn: git log --diff-filter=AC --follow --max-count=1 --pretty=format:%H:%p .changeset/exp-k.md
```

That is the entire subprocess inventory of a multi-package version run. For
`changeset status --verbose --since main` (the read-only planning view):

```
child_process.spawn: git merge-base main HEAD
child_process.spawn: git diff --name-only --diff-filter=d --no-relative ae3c112a…
child_process.spawn: git merge-base main HEAD
child_process.spawn: git diff --name-only --no-relative ae3c112a…
child_process.spawn: git rev-parse --show-cdup
```

| Checked | Result |
| --- | --- |
| `npm install` / `npm ci` | **not called** (0 npm subprocesses; `node_modules` still absent after the run) |
| npm lifecycle (`preinstall`/`install`/`postinstall`/`prepare`) | **cannot fire** — no npm process is ever spawned, so PD's `pd-setup`-style scripts are never entered |
| package scripts / build | not called |
| lockfile re-resolution | **no** — `package-lock.json` md5 `bad673627a71baa5243c51a64da29fe3` before *and* after Exp E (core major rewriting 4 consumers' ranges) |
| registry interaction | **no** for `status`/`version`. Only `publish-plan`/`publish` reach the network (`getPublishPlan.mjs` shells `npm view`), and those are out of scope per §Required Constraints |
| workspace mutation | no `node_modules` links, no `.package-lock`, no directory created |
| git writes | none — `git log`/`git diff`/`git merge-base` only; Exp P confirmed `git log` after a version run still shows exactly the pre-run commits (config `commit: false`) |
| tags | **version ignores tags entirely** — Exp R placed an annotated tag `@principles/core@9.9.9` on the baseline and the plan was still `1.74.2` |

The last row matters for PRI-877's rule *"git tag ≠ product version, never
derive one from the other"*: Changesets' bump arithmetic reads
`packages/*/package.json` and no tag at all, so it cannot reproduce the
`sync-version.sh` class of drift where a tag value leaked into the root manifest
(`publish-npm.yml:483-487` still does this today; #1781 removes it).

**`ERR-131 recurrence risk: LOW.`**
Evidence: zero npm processes across 16 runs including a major bump; lockfile
byte-stable; `node_modules` never materialised in a copy that had none. The
residual is *operator* error — running `changeset publish` (which does
`npm view` + `npm publish` + git tags) or pairing `changeset version` with a
manual `npm install` in the shared worktree. Both are excluded by constraint, not
by the tool.

---

## Internal Dependency Propagation

`pd-cli ──depends on──▶ @principles/core` (`^1.74.1`), the real C1/C3 edge.

| Experiment | Declared | core | pd-cli version | pd-cli `@principles/core` range |
| --- | --- | --- | --- | --- |
| A / Z1 | core **patch** | 1.74.1 → 1.74.2 | 1.74.1 (unchanged) | `^1.74.1` (**unchanged** — range already admits 1.74.2) |
| L | core **minor** | 1.74.1 → 1.75.0 | 1.74.1 (unchanged) | `^1.74.1` (unchanged) |
| E / M | core **major** | 1.74.1 → 2.0.0 | 1.74.1 → **1.74.2** | `^1.74.1` → **`^2.0.0`** |
| K | core patch **and** pd-cli patch | 1.74.2 | 1.74.2 (own declaration) | → **`^1.74.2`** (refreshed because it is in the plan) |

Three rules fall out, and they are semver-correct but *not* what PD's release
train assumes:

1. **A dependency bump alone does not republish consumers.** Patch and minor
   bumps of `core` leave every consumer untouched, because their ranges still
   match. Changesets assumes the npm consumer re-resolves at install time — true
   for npm, false for the installer bundle, which **copies** core at build time.
2. **Only a range-breaking bump propagates** (major), and then it bumps consumers
   as `patch` with an `### Patch Changes / - Updated dependencies -
   @principles/core@1.74.2` changelog note.
3. **A consumer's range is refreshed only if it is being released anyway**
   (config `updateInternalDependencies: "patch"`; with `"minor"` the refresh in
   row K is suppressed while row E's rewrite still happens — verified in Exp N/N2,
   which is the one place the docs' phrasing is genuinely confusing).

**Fit with PD's release train:** this is the correct tool for C3 and the wrong
authority for the two forced-release edges PD actually depends on —
`plugin → installer re-publish` and `pd-console → installer`
(`publish-npm.yml:203-238`). Those must stay CI-owned. See next section for the
proof the tool does not even see them.

---

## Independent Version Test

Exp C — one changeset file declaring three different bump levels:

```
- minor
  - principles-disciple -> 1.77.0
- patch
  - @principles/core -> 1.74.2
  - @principles/pd-cli -> 1.74.2
```

No convergence, no shared "train number". `installer` (`create-principles-disciple`)
stayed at `1.74.1` throughout — i.e. *"needs to be released together"* is not
implied by the tool.

**Current config expresses lockstep, but PD has not configured it.** Exp T set
`fixed: [["principles-disciple", "create-principles-disciple"]]` and a plugin-only
patch then produced **both** packages at `1.76.2` — the installer jumping from
1.74.1 in one step. That is the mechanically available answer to PRI-878's
forced-release edge, and it is *wrong for PD* per PRI-877: "publish together" ≠
"same version". Conclusion: keep `fixed: []` and `linked: []` empty; do not model
C4 assembly with a version-lock group.

---

## Private Package Test

`pd-console`, `pd-companion`, `website` are `private: true` workspace members.

| Check | Result |
| --- | --- |
| Changeset naming a private package (Exp D) | `status` prints **"Packages to be bumped:"** with an **empty list**; `version` deletes the changeset file and changes **no other file** (Exp D/W: `git status --short` → only ` D .changeset/exp-x.md`) |
| Bumped / changelog / in release status / can enter publish | **no / no / no / no** — `getPublishPlan.mjs:581` filters `!pkg.packageJson.private` before any registry comparison |
| Listing them in `ignore` (Exp O) | accepted; `status` plan unchanged. `privatePackages.version` defaults to `false` (`@changesets/config/dist/index.mjs:779-785`), so `ignore` is **redundant** for private packages. The config validator's only skip-related rule is `alsoSkipDependentsOfSkipped` (`:838-861`), which errors when a *skipped* package still has a non-skipped **non-private** dependent — private packages never trigger it |
| Does a console change make Changesets infer an installer release? | **No.** Exp Q (plugin patch) and Exp Z1 (core patch) never produced an installer row; the console→installer edge lives only in `publish-npm.yml:225-238` + `bundle-plugin.mjs`, and Changesets has no concept of it |

The silent consumption in row 1 is a real trap for an AI agent: writing a
console changeset **deletes the file and does nothing else**, so the change looks
"released" in the diff. A guard should reject changesets whose only target is a
private package (one `jq` check in CI).

This non-behaviour is the important architecture evidence the task asked for:
Changesets is **C3-blind to C4**, and that blindness is a *feature* here — it is
why the tool cannot accidentally own product assembly.

---

## Product Version Containment

Adoption-blocker-level check. Protected paths and their state after the runs
that mutated the most (Exp E core-major, Exp K multi-package, Exp V snapshot,
Exp AB dirty ghost):

```
git diff --name-only -- package.json package-lock.json \
    plugins/ '_release' 'packages/create-principles-disciple'   → (empty, every experiment)
```

* **root `package.json`** (`1.76.1`, the Product Version authority per
  `scripts/resolve-product-version.mjs`) — **never touched**; it is `private` and
  excluded from the package list.
* **`plugins/principles-disciple/runtime-version.json`** — **never touched**; the
  pins (`core: "1.284.13"`, `hostRuntime: "0.7.4"`) remained exactly the baseline
  bytes. Note the file's own `note` field documents that the npm component line
  (`core` was `1.74.1` in the working tree) and the published pin line (`1.250+`)
  are different numbers — precisely the separation Changesets preserved.
* **`openclaw.plugin.json`** — untouched. Contrast with today's CI, which
  `sed`s the plugin version into `openclaw.plugin.json`, `dist/openclaw.plugin.json`,
  **root `package.json`** and both READMEs (`publish-npm.yml:464-499`). Adopting
  Changesets for C3 removes the need for that whole step.
* **`_release/**`, ReleaseManager, channel metadata, `active.json`** — outside the
  workspaces glob; never scanned, never written.
* **installer logic** (`create-principles-disciple/**`) — never written.

**No custom hook, wrapper or patch was required to obtain containment.**
Complexity Cost for Q4: **zero**.

The single escape hatch found: **prerelease modes are not contained.** Exp V
(`version --snapshot pr-test`) and the `pre enter next` run rewrote
**private** package manifests — `pd-console` and `website` dependency ranges went
from `"*"` to exact `1.74.2-pr-test-20260920110903` strings, and pre-mode created
`.changeset/pre.json` + `.changeset/pre/` state. These modes are therefore banned
outright (§Required Constraints 5).

---

## Changelog Test

**Fact.** Output is **per-package only** (`packages/<pkg>/CHANGELOG.md`); no root
changelog is ever written. Content = the changeset's summary text, prefixed with
the short commit hash of the commit that added the changeset file:

```
## 1.75.0

### Minor Changes

- 72ef459: lab-exp-L core minor only
```

Indirect consumers get an auto-generated dependency note (Exp K):

```
### Patch Changes

- Updated dependencies
  - @principles/core@1.74.2
```

Prepends to an existing file and preserves whatever header was there; creates the
file when absent (Exp Z2 created `packages/host-runtime/CHANGELOG.md`). Format is
not configurable without replacing the generator (`changelog: "@changesets/cli/changelog"`,
or `false`).

**Evaluation.**

| Question | Assessment |
| --- | --- |
| Is it readable? | Yes — one line per declared intent, grouped by bump level, with a traceable hash. Strictly better than today, where per-package changelogs are **abandoned**: `principles-core/CHANGELOG.md` top entry is `## [0.1.0]`, plugin's is `## 1.10.0` against manifest `1.76.1`, and `pd-cli`/`host-runtime`/`codex-adapter`/`install-layout` had none at all. |
| Where does today's changelog actually go? | Only into the GitHub Release body, generated by commit-regex (`publish-npm.yml:502-535`). Root `CHANGELOG.md` has no writer in CI or scripts and is stale since 2026-06-21. |
| Does AI have to write a summary every time? | **Yes** — that is the cost, and also the point: it converts guessing into a reviewable claim. It can be a one-line sentence; no Keep-a-Changelog prose needed. |
| Better than conventional-commit inference for Owner + AI? | For **bump level**, clearly yes (declared vs. regex over `feat!:`). For **text**, comparable: today's release notes come from commit subjects, which the AI writes anyway. |
| What it does not fix | Root/aggregate changelog and the Product-Version release narrative — those belong to C6 and stay a ReleaseManager/gh-release concern. |

---

## Current PD vs Changesets

| Current PD mechanism | Evidence | Changesets equivalent | Full replacement? | Keep? |
| --- | --- | --- | --- | --- |
| Conventional-commit → bump inference | `publish-npm.yml:275-301` (grep `feat`/`!:` over `git log v<npm-latest>..HEAD`) | `.changeset/*.md` declaration | **Yes** | Delete on adoption |
| Per-package `package.json` bump | `publish-npm.yml:422-461` (`npm view` + `npm version` + reset-to-npm dance) | `changeset version` | **Yes**, and it removes the npm-registry read from the version step | Delete |
| Internal dependency range update | `action.yml:91-130` preflight + `publish-npm.yml:191-199` | automatic on range-breaking bumps | **Yes** for C3 | Delete the hand-rolled range logic; keep the *publish-order* preflight |
| Version sync into plugin manifest / root / READMEs | `publish-npm.yml:464-499`, `scripts/sync-version.sh:57-90` | **no equivalent, by design** | **No — must not** | Replace with the PRI-877 rule "component version ≠ product version"; #1781 already removes the root write |
| Changelog | `publish-npm.yml:502-535` (GitHub Release body only) | per-package `CHANGELOG.md` | Partial (per-package yes, root/product no) | Keep release notes generation; drop nothing else |
| Registry preflight (dep must exist before publish) | `action.yml:91-130`, `publish-npm.yml:370-391` | `publish-plan` (3.0.2, network) | Not needed | **Keep — PD-specific and correct** |
| Publish order (1/7 → 7/7 sequential train) | `publish-npm.yml:92, 706-732` | Changesets `publish` does *not* order PD's train | **No** | **Keep** |
| Installer forced release (plugin/console → installer) | `publish-npm.yml:203-238` | **invisible to Changesets** (proved above) | **No** | **Keep in CI** |
| Runtime pins | `runtime-version.json` + `npm run check:runtime-pin` | never touched | **No** | **Keep, human-only** |
| Distribution / ReleaseManager / signing | `release-metadata.yml`, installer ReleaseManager | never touched | **No** | **Keep** |

Net: Changesets replaces exactly the version-**planning** layer (rows 1–3, plus
the changelog), which is the part that was both hand-rolled and wrong most often.
It replaces nothing in the publish/distribute layers — and per the task's
guidance, the fact that it *can* publish is a reason to forbid it, not to adopt
more.

---

## Complexity Delta

| New thing | Size | Notes |
| --- | --- | --- |
| `.changeset/*.md` files | 1 per release-affecting change | **New mandatory AI/developer ritual** — the largest real cost |
| `.changeset/config.json` | existing, needs 4 corrections | `access` → `public`; keep `fixed/linked` empty; add explicit `privatePackages` (or rely on default `false`); pin `baseBranch` |
| Version step in CI | replaces 84 lines of CI bash (`publish-npm.yml:267-301` npm-view + commit-regex, `:413-461` bump + reset-to-npm dance) with `changeset version` | Net **negative** complexity if rows 1–3 above are deleted |
| A "version PR" concept | needs a decision | `commit: false` means Changesets writes files and stops; PD's push-to-main-then-publish flow needs an explicit commit+push owner, or `commit: true`. Not evaluated here (out of the C3 write sandbox) |
| Guard: reject private-only changesets | ~10 lines | Exp D silent no-op |
| Guard: keep ghost-path commits from being forced into changesets | CI path-filter scoping | §Ghost Package Test |
| New failure modes | 4 | (a) private-only changeset silently consumed; (b) `ignore` accepts **non-existent package names and arbitrary paths** without a word (Exp AC/AD: `ignore: ["packages/create-principles-disciple/core", "@principles/ghost-not-real"]` → clean status, no error, while `ignore: ["@principles/core"]` *does* error with a precise "depends on the skipped package" message) — so config typos are silently inert; (c) `version` exits **1** when there is nothing to do (Exp H) — must not be treated as failure in CI; (d) prerelease/snapshot modes mutate private manifests |
| New dependency | 0 | `@changesets/cli` already in `package.json:68` |

Owner-cognitive-load verdict (the task's actual question): today the Owner must
trust that a regex over commit subjects picked the right bump for 7 packages, and
the AI must remember an undocumented reset-to-npm-latest convention. After
adoption, the Owner reads one line per package in a diff — "core patch" — and the
AI states intent instead of being guessed at. That is **less** load, provided the
ritual is enforced by the existing PR template rather than by memory. It becomes
**more** load if Changesets is added *on top of* the commit-regex inference.

---

## Adoption Decision

### **ADOPT WITH CONSTRAINTS**

Against the task's own gates:

* ghost packages cause no problem and need no configuration — **PASS**;
* `changeset version` triggers no install/lifecycle side effect — **PASS**
  (traced, 1 subprocess, all git-read-only);
* independent versions work naturally — **PASS**;
* internal dependency bumps behave correctly — **PASS for C3**, with the explicit
  finding that patch/minor bumps do **not** propagate, so PD's forced-release
  edges cannot be delegated to it;
* Product Version and runtime pins are never touched, with zero custom code —
  **PASS**;
* the tool is not required to understand C4–C7, and demonstrably does not —
  **PASS**;
* complexity: reduces the version-planning layer (deletes 84 lines of CI bash plus
  the four stale/absent per-package changelogs) at the price of one new file per
  change — **net negative, but only if the old inference is deleted**.

**Not plain ADOPT** because four of its own features must be disabled
(`publish`, `git-tag`, `pre`, `--snapshot`), it cannot carry PD's forced-release
semantics, its `ignore`/config validation is partly silent, and adoption requires
a CI re-plumbing decision PD has not made (who commits the version PR).

**Not DO NOT ADOPT** because every hard boundary test passed with real traces and
required no wrapper, fork or patch — the disqualifiers would have been
unfixable, whereas these are constraints.

### Required Constraints

1. **C3 only.** `changeset version` may write `packages/<publishable>/package.json`
   version + its `CHANGELOG.md` + consumer ranges. Nothing else.
2. **Never run `changeset publish` / `changeset git-tag`.** Publishing, tag
   creation and ordering stay with `publish-npm.yml` + `action.yml` (sequential
   1/7→7/7 train, registry preflight).
3. **Never run `pre enter|exit` or `version --snapshot`.** Proven to mutate private
   package manifests and to create `.changeset/pre.json` state.
4. **Keep `fixed: []` and `linked: []` empty.** Plugin↔installer lockstep must not
   be expressed as a shared version; forced release stays a CI publish decision.
5. **`ignore` must stay empty** (installer is publishable and has dependents;
   Exp G showed ignoring `@principles/core` errors with a precise message, but
   invalid *names/paths* are accepted silently — so the safe setting is `[]`).
6. **Set `access: "public"`** — the current `"restricted"` contradicts PD's public
   packages.
7. **Changesets must not coexist with the commit-regex bump inference.** Adopting
   without deleting `publish-npm.yml:275-301` + `422-461` creates two bump
   authorities.
8. **Guard: reject a PR whose changeset targets only private packages** (Exp D's
   silent no-op).
9. **Do not make `changeset status` exit-0 a required check on installer paths**
   until ghost-path attribution is scoped (§Ghost Package Test); `version`'s
   exit 1 on "nothing to do" is normal, not failure.
10. **Runtime pins, root `package.json`, `_release/**`, `~/.pd/**` remain
    human/ReleaseManager-only** — unchanged from PRI-877 rules; this experiment
    confirms Changesets neither knows nor reaches them.

### Is ten constraints too many to still be worth adopting?

Ten constraints is a lot, so they were split by what they actually cost, because
a long list is not automatically a heavy list:

| Kind | Constraints | Ongoing cost |
| --- | --- | --- |
| **Already PD policy** — true whether or not Changesets is adopted; the tool simply never violates them | 1, 2, 3, 10 | zero — PD's train already owns publish, tags and pins. Changesets is asked to do *less* than PD's current CI does today. |
| **A config value, set once** | 4, 5, 6 | one-time — three fields in `.changeset/config.json`, then never revisited. |
| **Requires deleting an existing mechanism, not adding one** | 7 | negative — the whole point. |
| **Genuinely new code** | 8 (private-only guard), 9 (status path scoping) | ~10 lines of CI + one path-filter decision |

Judged on that split, the list is not what makes adoption expensive: **four of the
ten restate rules PD already enforces by other means, three are a config value, and
only two need new code.** The genuinely heavy part is constraint 7's *sequencing* —
adoption is worth nothing unless the commit-regex inference is deleted in the same
change, and deleting it is a release-behaviour change that deserves its own SPEC and
its own verification, which this experiment explicitly does not perform.

So the honest reading is: **the tool clears every safety bar, and what remains is
a migration decision, not a suitability question.** If the Owner is unwilling to
give up "every push to main auto-publishes with an inferred bump", the answer
becomes **DO NOT ADOPT** — not because Changesets is unsafe (it measured safe on
all four questions) but because both mechanisms together are strictly worse than
either alone.

---

## Unknowns

1. **Who commits and pushes the version bump.** `commit: false` leaves the bump as
   working-tree changes; PD's train publishes from a `main` push. A release-PR
   bot, `commit: true`, or a "version then publish" job are all viable and none
   was evaluated — it is CI design, beyond this feasibility scope.
2. **CI runner npm availability.** All runs used the worktree's installed CLI;
   `changeset version` was never proven to work under `npm ci --ignore-scripts`
   on a runner (expected to be fine: it needs no `node_modules` of the target repo).
3. **Interaction with #1781** (OPEN, `mergedAt: null`): it deletes the root-manifest
   write from `sync-version.sh`/CI and adds fail-closed identity guards. It changes
   *nothing* in the four verdicts — Changesets never touched those files anyway —
   but it **increases** the value of adoption, since it removes the last
   competing Product-Version writer. Re-check §Current PD vs Changesets rows 1–4
   after it merges.
4. **`publish-plan` correctness for PD's train** — untested (out of the no-network,
   no-publish sandbox).
5. **Prerelease OpenClaw channel**: `pre` mode is the natural fit for a `next`
   channel but is banned by constraint 3; if PD ever wants a prerelease channel,
   that needs its own experiment.
6. **Ghost-path attribution at scale** — only one deliberate ghost edit (Exp AB)
   was tested; the real-world frequency of installer-directory commits that are
   not payload changes was not measured.

---

## Raw Evidence Summary

| # | Command (in lab) | Outcome |
| --- | --- | --- |
| A | `version` with `core: patch` | 3 files changed, nothing else in worktree |
| B | `version --require=trace` with `core: minor` | core 1.74.1→1.75.0; trace = 1 `git log`; no node_modules |
| C | `status` with core patch + pd-cli patch + plugin minor | three independent targets, installer absent |
| D, W | `status`/`version` on `@principles/pd-console: patch` | empty plan; changeset deleted, no file changed |
| E, M | `version` with `core: major` | 5 manifests + 2 changelogs; ranges → `^2.0.0`; consumers patch-bumped; lockfile md5 unchanged |
| G | `config.ignore = ["@principles/core"]` | loud config error naming all 4 dependents, exit 1 |
| AC, AD | `config.ignore = ["packages/create-principles-disciple/core", "@principles/ghost-not-real"]` | **silently accepted**, no error, normal behaviour |
| H | `version` on `main` with no changeset | "No unreleased changesets found", **exit 1** |
| I, J | changeset merged to `main`, then `version` | bump applied; `status` afterwards warns "changed but no changesets" until committed |
| K | multi-package `version` under full trace | 1 subprocess total; dependent changelog note generated |
| N, N2 | `updateInternalDependencies: "minor"` | suppresses range refresh for a minor dep change; major still rewrites |
| O | `ignore` = the 3 private packages | accepted, plan unchanged (redundant with `private`) |
| P | `version` then `git log` | no commits created by the tool |
| Q | plugin-only patch | installer **not** touched, not bumped |
| R | annotated tag `@principles/core@9.9.9` present | plan computed from `package.json` only — tags ignored |
| T | `fixed: [[plugin, installer]]` + plugin patch | both jump to 1.76.2 (proof lockstep is expressible — and wrong for PD) |
| U | changeset naming `@principles/nonexistent-pkg` | hard error "not in the workspace", exit 1, no file touched |
| V | `version --snapshot pr-test` | private manifests rewritten to exact snapshot ranges — **banned** |
| AB | ghost copy hand-edited + core changeset | ghost untouched; `status` demands a changeset for the installer path |
| AE | core patch, then compare lines | canonical 1.74.2 / ghost 1.278.6 / installer 1.74.1 / `runtime-version.json` byte-identical |

Lab copy and its branches were deleted after the run; `tmp-cs-trace.cjs`,
`tmp-probe-discovery.mjs` and `tmp-probe2.cjs` were removed from the PRI-879
worktree before commit. No changeset, tag, commit or push was made to any
non-lab branch; no CI file, production script, package version, runtime pin or
Product Version was modified in this repository.
