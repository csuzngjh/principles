# Release Process

[English](RELEASE_PROCESS.md) | [中文](RELEASE_PROCESS_ZH.md)

---

## 🌟 The One Paragraph That Matters (PRI-874)

The product has **ONE version**: the ROOT `package.json` (`version` field).
It is the single authority read by `scripts/resolve-product-version.mjs` for
every release entry point (npm train, signed channel, installer identity
stamp). Component package versions (`@principles/*`, `principles-disciple`,
`create-principles-disciple`) are **diagnostics** — they are never the
product version, and since PRI-874 every path that could promote them has
been removed or guarded.

### How the Product Version Advances

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
  `package.json` **and** the root lockfile entry. There is no auto-bump of the
  root — a product version is an Owner decision, and the
  [product-version-drift](../../.github/workflows/product-version-drift.yml)
  monitor fails when a published version never lands on main.
- **Land that commit on main.** An advancement that only ever exists on a
  feature branch does not count — and nothing used to notice. `79226910`
  (`align product version to 2.1.0`, PRI-849) was committed to
  `ai/PRI-854-option-a` **after** that branch's PR had already merged, so it
  never reached main: the authority stayed at `1.76.1` while the live channel
  advanced to `2.1.0`, and the released channel was ahead of the repository
  for a day. The same one-line change then had to be re-landed as the explicit
  version-advancement commit of the version-governance work. That is precisely
  the drift class this monitor now fails on.
- **Component versions** advance inside release CI only (tag-only; never
  written back to main).

---

## 🤖 For AI Agents

### Release Triggers

- **Auto**: pushes/merges to `main` touching release-relevant paths trigger
  the npm train (`.github/workflows/publish-npm.yml`). The train resolves
  the product identity from the root manifest and REFUSES to publish if it
  is lower than the live channel pointer.
- **Manual**: Actions → Publish to npm → Run (`package` input), or the
  signed release workflow (`release-metadata.yml`, `product_version: auto`).

### Hard Gates (timing differs per entry point)

These three are **not** one checkpoint that completes before any publish side
effect. Each runs where its entry point can actually enforce it:

1. **Monotonic** — *before that entry point's first publish*. The signed-release
   workflow runs it while resolving publication inputs, before any byte is
   emitted; the npm train runs it as a step before `Publish 1/7`. It always
   consults the **remote** channel pointer — never only the local snapshot, and
   a channel it cannot read is a refusal rather than a skip — and refuses when
   the resolved version is below any live pointer. Equal is allowed (a
   same-version republish advances the counters).
2. **Stamp** — *at the installer package's own publish*. The payload is stamped
   with the resolved identity (`_release/product-identity.json`) and the **packed
   TARBALL** is verified, not the working directory. In the full train this
   happens after the earlier packages have been published, and the job matrix
   does not order the installer against the plugin — so a stamp failure can be
   observed after some packages are already out.
3. **Install-time** — *on the Owner's machine; not a publish gate at all*. The
   installer resolves and validates the payload identity **before** it stops the
   gateway or creates the workspace, and refuses an unstamped payload
   (`install_failed_before_mutation`) without entering the install flow.

### Version Sync Scope (release CI, runner-local only — never pushed to main)

- `packages/openclaw-plugin/openclaw.plugin.json` (component)
- `README.md` / `README_ZH.md` badges
- **NOT** the root `package.json` — the product authority advances only via
  explicit commits.

---

## 🛠️ For Geeks & Developers

### Local Operations

```bash
# Check the three version planes (product = root manifest)
node scripts/resolve-product-version.mjs          # product version
npm view principles-disciple version              # product/plugin stream (diagnostic)
npm view create-principles-disciple version       # installer stream (diagnostic)

# Component version sync (never touches the root manifest)
./scripts/sync-version.sh           # From tag
./scripts/sync-version.sh 1.5.6     # Specify
```

> `scripts/release.sh` is DEACTIVATED (PRI-874): it derived a release from a
> component version and bypassed every guard above.

### Troubleshooting

| Issue | Fix |
|-------|-----|
| Publish refuses: "LOWER than the live channel pointer" | Advance root `package.json` on main first (explicit commit) |
| Installer refuses: "no embedded product identity" | The payload is not a train/asset build — install a stamped payload |
| Drift monitor red: main < channel | The published version never landed on main — land the version-advancement commit |
| Drift monitor notice: main > channel | Normal pending-publish state (version advanced, release not out yet) |

### Required Setup

1. [npmjs.com → Access Tokens](https://www.npmjs.com/settings/tokens)
2. Create "Automation" token
3. GitHub → Secrets → `NPM_TOKEN`
