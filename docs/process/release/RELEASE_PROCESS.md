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
release cohort = that landing commit SHA (merge or squash — identity is
                    the reproduction, never the commit shape)
        ↓
publish train (dispatched automatically, or daily reconciliation window)
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
- **Release cohort** = the Version PR landing SHA (merge commit, squash or
  rebase — identity is the first-parent reproduction, never the shape).
  Retries and the daily window build that exact SHA; later main changes
  cannot leak into a release.
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
component version, hand-edit Codex runtime pins (the Version PR generates
them), or make versions equal "because they ship together".

### Release Triggers

- **Cohort merge**: merging the Version Packages PR automatically dispatches
  the publish train bound to that landing SHA, whatever the merge shape
  (merge commit / squash / rebase) — `version-packages.yml` proves the
  cohort by reproduction.
- **Recovery / manual**: Actions → Publish to npm → Run, optionally pinning
  `cohort_sha` (empty = auto-detect the latest cohort).
- **Daily window** (04:00 UTC): reconciliation ONLY — pending cohort
  publishes, incomplete closing steps; no versions are ever created. No
  cohort AND every committed version already on the registry → success
  no-op; no cohort but a committed version missing from the registry →
  CHAIN-BREAK ALARM (exit 1 + `::error::`; PRI-922: squash merges silently
  stalled the whole npm chain). PRI-986: the window used to be weekly, which
  left a Monday cohort unpublished for four days.
- **Daily channel preflight** (06:00 UTC, `release-metadata.yml`): a
  scheduled full-matrix DRY RUN of the signed channel — it proves the
  publish path is alive without publishing. Publishing stays a human
  decision: the workflow refuses `mode=publish` on a schedule, and a
  scheduled run derives `data_schema_forward_readable_from` from the live
  channel pointer (an operator dispatch must still pass it explicitly,
  PRI-853).
- **Signed-channel asset publication** (`release-metadata.yml`, manual
  `mode=publish`): since PRI-1103 the build commit is NOT the dispatched
  `ref` — the workflow asks the registry which cohort
  `create-principles-disciple` actually shipped for that product version and
  builds that commit, so the console-update channel and the fresh-install
  channel cannot ship different bytes under one version number. `ref` picks
  the release tooling; `cohort_sha` is an explicit identity assertion that
  this commit IS the commit npm `latest` currently points at — legal for a
  deterministic rebuild, a repeat publication of the unchanged channel, or a
  key-rotation re-sign of that same cohort. It is NOT a historical selector:
  once `latest` has moved to another commit, an older published cohort is
  refused (`EXPLICIT_NOT_LATEST`) because it would ship different bytes than
  a fresh npm install receives. If the npm side has not shipped yet, a publish
  dispatch refuses and a preflight rehearses the ref with a warning.
- **Publication mutex and cohort re-checks** (PRI-1103, race hardening):
  npm `latest` is one global fact, so `publish-npm.yml` and
  `release-metadata.yml` `mode=publish` share the single Actions concurrency
  group `pd-release-publication-global` (`cancel-in-progress: false`, stable
  and candidate alike). Release-metadata dry-runs and `publish-preflight`
  keep their own groups and never take the production lock.
  **Actions concurrency is NOT a queue**: it keeps one running plus at most
  one pending run per group; a newer pending run REPLACES the older pending
  one (which is cancelled). Serialisation is guaranteed, delivery of every
  queued publication is not — a replaced pending run must be re-dispatched.
  No persistent lock service is introduced; the repository has none, and a
  second lock would become a competing truth. The legacy manual
  `scripts/release.sh` publishes outside Actions and therefore cannot be
  serialised by a concurrency group: operators must not run it while a
  publication workflow is in flight (a drift it causes is still caught by
  the cohort gates before the pointer push).
- **Cohort re-verification gates** (`scripts/release/verify-publication-cohort.mjs`,
  same script at both points): gate 1 runs after every platform asset is
  built/downloaded/identity-verified and BEFORE any side effect; gate 2 runs
  INSIDE the `Publish to metadata source` shell, after `git commit` and
  immediately before `git push origin gh-pages` — nothing else executes
  between the gate and the push. Both re-read npm through the existing
  resolver and registry client and require the full `productVersion` +
  40-char `gitHead` to still equal what the run built.
  **Every cohort query is force-revalidated**: the registry client appends
  npm's documented `?write=true` marker (the npm client's "give me the
  current value" mechanism before a write) plus `Cache-Control: no-cache`
  as a complement — a repeated query is not a fresh query, and a cached
  packument would make both gates no-ops. Initial resolution, gate 1 and
  gate 2 are separate processes, so each issues its own revalidated request
  and never reuses an earlier result. Ordinary (non-cohort) registry reads
  keep the default behaviour.
  Auto mode (`cohort_sha` empty) and explicit mode apply the SAME rule: the
  commit must be the one npm `latest` currently serves, with a readable
  manifest whose root product version equals the expected version. Explicit
  mode may only name that current commit (repeat build / re-sign); it can
  never revive an older published cohort, and `allow_version_drift` does not
  change the npm latest commit identity. 404 / 503 / timeout / network failure
  / malformed JSON / missing `gitHead` / version or commit drift / unreadable
  commit all fail closed, reporting expected vs actual identity, the mode, and
  whether external side effects (asset bytes) already happened. A dry-run
  result is advisory only and is explicitly labelled NOT publication
  evidence, and a dry-run never executes the mode=publish shell;
  `mode=publish` never takes that fallback.

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

### Component Mirrors and the Codex Runtime Pin (Version PR scope)

- `packages/openclaw-plugin/openclaw.plugin.json` — synced to the plugin
  version by the Version PR materialization (the one approved mirror).
- `plugins/principles-disciple/runtime-version.json` +
  `plugins/principles-disciple/.codex-plugin/plugin.json` — the Codex runtime
  pin, materialized by the same Version PR from the four workspace versions
  (`@principles/codex-adapter`, `@principles/host-runtime`,
  `@principles/core`, `@principles/pd-mcp-server`). The pin is exact-only
  (three-part versions, never a range or `latest`), never downgrades, and
  requires all four components. Whenever the pin changes, the Codex cache
  version in `.codex-plugin/plugin.json` increases by one patch in the SAME
  commit — Codex keys its installed plugin cache by that number, so a payload
  change without a bump would never reach an existing install.
- `README.md` / `README_ZH.md` badges — no longer auto-synced by anything;
  update them in the release-notes PR if desired (cosmetic, non-authority).
- Root `package.json` — NEVER (containment; the product version plane is not
  release material).

#### Why the Codex pin moved into the Version PR (Owner decision, 2026-11-11)

The pin used to be written by a separate "runtime pins maintenance PR" opened
AFTER the publish train finished. It worked, but it cost a second PR per
release (review + CI + a cohort-visibility reconcile wait), and it left a
window where `main` and the shipped plugin disagreed about which runtime the
plugin pins — exactly where "the plugin is published but still pins the
previous runtime" could hide.

Now the pin is one more deterministic output of the Version PR, next to
`changeset version` and the component mirrors. `materialize-version-plan.mjs`
composes it from the same commit it bumps, and the release-intent guard
reproduces that composition byte for byte, so a hand-edited pin fails CI the
same way a hand-edited version does.

**Risk: the pin lands on `main` before the packages exist on npm.** That is
inherent to shipping the pin with the cohort, and it is contained by publish
ORDER rather than by a second PR: the train publishes the four runtime
packages and `pd-mcp-server` BEFORE the plugin that embeds the pin, so a
downloadable plugin version never carries unpublished pins. If the train fails
before the plugin leg, no user has the pin yet.

**Failure fallback (never a silent pass):**

1. `codex-plugin-delivery-verify` runs after `publish-full-product` and
   re-checks the shipped pin against that cohort's manifests AND the registry
   (exact identity per package, with the same propagation budget, then a hard
   failure). It also re-runs `npm run check:runtime-pin`, which installs the
   published bytes at the pinned versions and probes them.
2. A mismatch turns the publish run RED, naming the offending package and the
   measured wait time. It is never downgraded to a warning.
3. The repair is a normal Version Packages PR (the pin is regenerated from the
   workspace manifests). `sync-codex-runtime-pins.mjs --cohort <sha>` remains
   as a manual recovery path, but it only writes files and opens no PR.

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

### Marketplace artifact provenance (hard rule)

The ClawHub artifact for `principles-disciple` **must be the exact tarball published to npm** — never a rebuild from a working tree:

```bash
npm pack principles-disciple@<version> --pack-destination "$TMPDIR/marketplace"
shasum -a 256 "$TMPDIR/marketplace/principles-disciple-<version>.tgz"
clawhub package publish "$TMPDIR/marketplace/principles-disciple-<version>.tgz" \
  --family code-plugin --name principles-disciple --version <version> \
  --source-repo csuzngjh/principles --source-commit <cohort-sha> --source-path packages/openclaw-plugin
```

- Compare the SHA-256 reported by `clawhub package inspect principles-disciple --version <version>` with the npm tarball; if they differ, abort the sync.
- ClawHub versions are immutable and permanently reserved: a published version can never be replaced with different bytes. A mismatch can only be corrected by the next version, so getting it right the first time is the only cheap path.
- Do not `npm pack` the repo (main, a feature branch, or a worktree) for a marketplace upload. That publishes an artifact that no npm user can reproduce.

> Incident 2026-11-12: `principles-disciple@3.3.0` was uploaded to ClawHub from a `main` build (`sha256 adc90861…d8ff5f`) instead of the npm tarball (`sha256 1556CC82…ECF660`). The version is reserved, `clawhub package delete --version` only accepts non-latest versions, so the mismatch cannot be replaced — the fix must ship as the next version.

### Troubleshooting

| Issue | Fix |
|-------|-----|
| CI: `N-2 ... declares private package` | A private package is never an npm version target: declare the intent on the package that actually ships it (e.g. pd-console → `create-principles-disciple`), never on the private package itself. Declaring it also trips `N-plan` (ignored + non-ignored mix) |
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
