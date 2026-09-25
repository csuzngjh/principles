# PD Version Model

> Provenance: delivered by the Changesets cutover (SPEC v1.2 §32) from the
> reviewed model work in Linear **PRI-877** (In Review — its content is
> carried here into `main` by the implementation PR, per the SPEC's
> documentation rule: one authoritative document, no second conflicting
> copy). Amends: PRI-849 (product version authority), PRI-874 (version
> governance closeout), the Changesets cutover itself.

## The four version planes

PD has FOUR distinct version concepts. Confusing them is the root of every
version-incident class this repository has recorded:

| Plane | What it is | Authority | Examples |
|---|---|---|---|
| **Product Version** | The version of the product the Owner ships and users install | root `package.json` `version`, read ONLY by `scripts/resolve-product-version.mjs` | `2.1.0` |
| **Component Package Version** | npm package versions of the publishable workspace packages | `.changeset/*.md` intent → Version Packages PR (Changesets) | `@principles/core@1.286.0` |
| **Runtime Capability Version** | Versioned capability contracts inside the runtime (schemas, protocols, store formats) | their own declared schema/contract constants | `runtime-v2`, store schema numbers |
| **Installed Product Version** | What a given machine actually runs | `active.json` product stamp, derived from the payload's embedded `_release/product-identity.json` | local install state |

Invariants:

1. **No plane may masquerade as another.** Component versions are
   diagnostics; the plugin version is never the product version; a product
   version never implies equal component versions ("四张皮" is the
   symptom of violating this, PRI-849).
2. **Product Version advances only by explicit Owner-decided commits**
   (root manifest + lockfile), never automatically, never by a release
   pipeline, never by the Version Packages PR.
3. **Component versions advance only through the Version Packages PR.**
   Nothing else may write a `packages/*/package.json` `version` field (the
   PR guard enforces this, with the one-time baseline-alignment window).
4. **Runtime pins (release locks, host-runtime pins) are never derived
   from any package version** — neither for alignment nor for release.

## Component version governance (Changesets, SPEC v1.2)

- Independent versions (no `fixed`/`linked` groups); `updateInternalDependencies: "patch"`.
- Release intent lives in `.changeset/*.md`; an empty changeset is the
  explicit "no release" declaration.
- The Version Packages PR materializes versions, CHANGELOGs, internal
  ranges, the lockfile, and the single approved component mirror
  (`openclaw.plugin.json` ← plugin version). Its diff is reproducible from
  the pending changesets (identity by proof, not by branch name/actor).
- A release cohort binds to the Version PR landing SHA (merge or squash —
  identity is the first-parent reproduction, never the commit shape); the
  publish train distributes exact committed versions and reconciles closing
  steps idempotently. See [RELEASE_PROCESS](../process/release/RELEASE_PROCESS.md).

## Approved mirrors and forbidden propagations

| File | Status |
|---|---|
| `packages/openclaw-plugin/openclaw.plugin.json` | approved mirror of the plugin package version (Version PR syncs it) |
| root `package.json` version | FORBIDDEN target of any component-version propagation |
| runtime pins / release locks | FORBIDDEN target of any component-version propagation |
| README badges | cosmetic, non-authority, not auto-synced |

## Git tag semantics

`vX.Y.Z` tags mark the **plugin (principles-disciple) release** and have
never represented the other packages' independent versions. The cutover
keeps that semantics (documented, not "fixed" by shoving package versions
into a product tag model) and binds each tag to its release cohort SHA.
