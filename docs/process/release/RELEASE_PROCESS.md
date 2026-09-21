# Release Process

[English](RELEASE_PROCESS.md) | [中文](RELEASE_PROCESS_ZH.md)

---

## 🌟 The One Paragraph That Matters (PRI-874 + Changesets Cutover)

The product has **ONE version**: the ROOT `package.json` (`version` field).
It is the single authority read by `scripts/resolve-product-version.mjs` for
every release entry point (npm train, signed channel, installer identity
stamp). Component package versions (`@principles/*`, `principles-disciple`,
`create-principles-disciple`) are **diagnostics** — they are never the
product version.

Component versions have their OWN authority now (Changesets cutover, SPEC
v1.2): a normal PR declares release intent with `.changeset/*.md`; a rolling
**Version Packages PR** materializes versions/changelogs/lockfile onto main;
the publish train distributes **exact committed versions** bound to the
Version PR's merge SHA. Nothing bumps a version "in CI" anymore.

### How a Component Release Works Now

```
feature PR  =  code  +  .changeset/*.md  (declared intent; guard blocks missing intent)
        ↓  merge to main
Version Packages PR (bot, changesets/action)
        =  versions + CHANGELOGs + internal ranges + lockfile + plugin mirror
        ↓  Owner reviews + merges        ← the ONLY version materialization path
release cohort = that merge SHA
        ↓
publish train (dispatched automatically, or weekly reconciliation window)
        =  checkout cohort SHA → exact name@version registry check
           → publish exact committed version, or skip if present+verified
        ↓  idempotent closing steps
tag vX.Y.Z (plugin semantics) / GitHub Release / ClawHub
```

Key contracts (enforced by `scripts/release/*` guards + tests):

- **Release intent authority** = `.changeset/*.md` only. No commit-message
  guessing, no manual bump inputs, no registry-reset-then-bump. Deleted with
  the cutover; no legacy fallback exists.
- **Version materialization** = the Version Packages PR only. A normal PR
  may not edit any `packages/*/package.json` `version` field.
- **Release cohort** = the Version PR merge SHA. Retries and the weekly
  window build that exact SHA; later main changes cannot leak into a
  release.
- **Exact-version publish** = the registry is queried for the exact
  `name@version`; absent → publish, present + matching provenance
  (gitHead = cohort SHA) → skip upload and reconcile closing steps,
  conflict / behind-registry / registry-error → FAIL LOUD.
- **C4 product assembly** = a plugin release (direct or alongside a core
  change) requires an installer release in the final plan; a pd-console
  change requires an installer release — unless the PR carries the official
  empty changeset (conservative path-rule hit waived exactly like N-3; a
  plan-triggered edge is never waived). The guard fails, it never invents
  the missing version.

### How the Product Version Advances (unchanged, PRI-874)

```
Explicit version-advancement commit on main (root package.json, + lockfile)
        ↓  (guards: publish runs refuse a version BELOW the live channel)
npm train / signed release workflow read the root manifest
        ↓
installer payloads carry the identity stamp (_release/product-identity.json)
        ↓
installed runtimes report exactly that identity
```

- **Bump the product version** = a deliberate PR changing root
  `package.json` **and** the root lockfile entry. There is no auto-bump of
  the root — a product version is an Owner decision. The Version Packages PR
  can never touch it (containment is part of its contract).
- **Land that commit on main.** An advancement that only ever exists on a
  feature branch does not count (`79226910`, PRI-849: the authority stayed
  at 1.76.1 while the live channel advanced to 2.1.0 for a day).

---

## 🤖 For AI Agents

### Does my change need a changeset?

Ask: **does this affect a publishable artifact?** (bug fix, runtime
behavior, public API, dependency contract, backward-compatible feature,
breaking change, published artifact content — for ANY of the seven
publishable packages, including private-code changes that ship inside them,
e.g. pd-console → `create-principles-disciple` patch.)

- Yes → add `.changeset/<slug>.md` with an honest bump (`patch`/`minor`/
  `major`) and a summary that says WHAT changed and WHY it needs a release
  ("fix"/"update"/"misc" are rejected by review).
- Docs/tests/fixtures only, and the conservative path rule still flagged
  you? → add an **empty changeset** (`---\n---\n` with a one-line reason) —
  that is the official "explicitly no release" declaration, not a waiver.
- A plugin release requires an installer changeset in the same PR (C4).

Never: edit all package versions, derive the product version from a tag or
component version, touch runtime pins for cosmetic alignment, or make
versions equal "because they ship together".

### Release Triggers

- **Cohort merge**: merging the Version Packages PR automatically dispatches
  the publish train bound to that merge SHA (`version-packages.yml`).
- **Recovery / manual**: Actions → Publish to npm → Run, optionally pinning
  `cohort_sha` (empty = auto-detect the latest cohort).
- **Weekly window** (Fri 04:00 UTC): reconciliation ONLY — pending cohort
  publishes, incomplete closing steps; no versions are ever created; no
  cohort → success no-op.

The Version PR bot (`changesets/action`, pinned) requires the
`PD_VERSION_PR_TOKEN` secret (a fine-grained PAT with contents:write +
pull-requests:write). Without it the workflow SKIPS Version PR creation
with a setup warning — this repository does not permit GITHUB_TOKEN to
create pull requests at all (observed at the first post-cutover run),
and even where permitted its PRs would not trigger the required
"Verify Merge Gate" check (GitHub suppresses recursive triggers).

### Hard Gates (timing differs per entry point — unchanged by the cutover)

1. **Monotonic** — before that entry point's first publish; consults the
   remote channel pointer; refuses below, allows equal.
2. **Stamp** — at the installer package's publish: the payload tarball
   carries `_release/product-identity.json` (train product version + cohort
   SHA).
3. **Install-time** — the installer validates the payload identity before
   any mutation on the target machine.

### Component Mirrors (Version PR scope)

- `packages/openclaw-plugin/openclaw.plugin.json` — synced to the plugin
  version by the Version PR materialization (the one approved mirror).
- `README.md` / `README_ZH.md` badges — no longer auto-synced by anything;
  update them in the release-notes PR if desired (cosmetic, non-authority).
- Root `package.json` / runtime pins — NEVER (containment).

---

## 🛠️ For Geeks & Developers

### Local Operations

```bash
# The three version planes (product = root manifest)
node scripts/resolve-product-version.mjs          # product version
npm view principles-disciple version              # plugin stream (diagnostic)
npm view create-principles-disciple version       # installer stream (diagnostic)

# Guard self-checks (what CI runs on every PR / release)
node scripts/release/check-pr-release-intent.mjs  # PR intent guard (needs PR_BASE_SHA or falls back)
node scripts/release/check-release-plan.mjs       # C4 guard on the final plan
node scripts/release/registry-exact.mjs <pkg> <exact-version> --expect-git-head <sha> --json
node scripts/release/resolve-release-cohort.mjs   # what the train would publish

# One-shot migration evidence tool (read-only; not a runtime authority)
node scripts/release/snapshot-registry-baseline.mjs --out docs/release/<date>.json
```

> `scripts/release.sh` is DEACTIVATED (PRI-874). `./scripts/sync-version.sh`
> is superseded by the Version PR mirror sync (kept only as a local
> diagnostic).

### Troubleshooting

| Issue | Fix |
|-------|-----|
| CI: `N-3 ... without a changeset` | Add `.changeset/*.md` declaring the package (or an empty changeset if genuinely non-release) |
| CI: `C4 ... requires create-principles-disciple` | Add an installer changeset — the guard never invents it; for a genuinely non-release-affecting console dev-config/test change, the official empty changeset declares "no release" instead |
| CI: `N-version ... version field in a normal PR` | Revert the hand edit; versions only land via the Version Packages PR |
| Publish: `LOCAL_BEHIND_REGISTRY` | main is behind the registry (unplanned versions above yours) — reconcile the baseline before releasing |
| Publish: `PRESENT_CONFLICT` | The exact version exists with different provenance — investigate before anything else; never overwrite |
| Train re-run after partial failure | Just re-run: npm skips verified-present versions, tag/release/ClawHub reconcile idempotently |
| Version PR has no checks / cannot merge | `PD_VERSION_PR_TOKEN` secret missing — see Release Triggers above |
| Installer refuses: "no embedded product identity" | The payload is not a train/asset build — install a stamped payload |

### Required Setup

1. [npmjs.com → Access Tokens](https://www.npmjs.com/settings/tokens)
2. Create "Automation" token
3. GitHub → Secrets → `NPM_TOKEN`
4. (Version PR checks) GitHub → Secrets → `PD_VERSION_PR_TOKEN` — fine-grained PAT, contents:write + pull-requests:write
