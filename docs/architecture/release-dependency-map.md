# PD Release Dependency Map

> Provenance: delivered by the Changesets cutover (SPEC v1.2 §32) from the
> audited dependency-graph work in Linear **PRI-878** (In Review — content
> carried into `main` by the implementation PR). The C-layers below are the
> dependency model the SPEC governs; the guard rules encode the two
> confirmed hard C4 edges, deliberately NOT the whole C4 universe (the
> guard structure extends incrementally).

## The seven dependency layers

| Layer | Meaning | Where it lives |
|---|---|---|
| **C1 code** | source-level imports between packages | `packages/*/package.json` dependency ranges |
| **C2 build** | build-order dependencies (types must exist before dependents compile) | workflow build steps; documented ordering |
| **C3 package-release** | which npm packages release, in what order | Changesets final plan + publish train step order |
| **C4 product-assembly** | implicit assembly edges the npm graph cannot see (bundling, payload shipping) | this document + `scripts/release/lib/workspace.mjs` rules |
| **C5 runtime** | installed runtime update/rollback chain | ReleaseManager, channel metadata, TUF |
| **C6 distribution** | signed assets, dist-tags, ClawHub marketplace | release-metadata pipeline, publish train closing steps |
| **C7 host-integration** | OpenClaw/Codex host boundaries | host adapters |

The Changesets cutover owns **C3** only. C5/C6/C7 are untouched
(ReleaseManager, signed distribution, host integration all keep their own
authorities).

## Current C1 graph (internal, publishable packages)

```
@principles/core            (no internal deps)
@principles/install-layout  (no internal deps)
@principles/host-runtime    -> core ^1.74.1, install-layout ^0.2.0
@principles/codex-adapter   -> core ^1.74.1, host-runtime ^0.7.7, install-layout ^0.2.0
principles-disciple (plugin)-> core ^1.74.1        [devDeps: host-runtime ^0.7.7]
@principles/pd-cli          -> core ^1.74.1, codex-adapter ^0.4.4, host-runtime ^0.7.7,
                               install-layout ^0.2.0, principles-disciple ^2.0.1
create-principles-disciple  -> install-layout ^0.2.0
```

Private packages (not npm version targets):

```
@principles/pd-console      -> core *, host-runtime *, install-layout ^0.2.0, plugin *
@principles/pd-companion    -> install-layout ^0.2.0
@principles/website         -> core * (dev)
```

**Changesets propagation reality** (verified against
`@changesets/get-release-plan` v5): an internal dependency release does NOT
auto-release dependents under `updateInternalDependencies: "patch"` — the
author adds the dependent's changeset alongside; internal MAJOR/MINOR bumps
additionally require the dependent's range edit in the same PR (the train's
preflight fails a committed range that resolves to nothing).

## C4 product-assembly edges (confirmed hard rules)

| Edge | Rule |
|---|---|
| `principles-disciple` → `create-principles-disciple` | a plugin release in the final plan REQUIRES an installer release (the installer bundles the plugin; publishing the plugin alone breaks `/check` vs `/apply-full`) |
| `packages/pd-console/**` → `create-principles-disciple` | the console ships ONLY inside the installer bundle — a console change REQUIRES an installer release |

Both are enforced by `scripts/release/check-pr-release-intent.mjs` /
`check-release-plan.mjs` on the **Changesets final release plan** (not on
source paths), so they catch direct changes AND any path that lands the
plugin in the plan. Missing intent FAILS; the guard never creates versions.

Other known-but-not-yet-hard C4 observations live in the PRI-878 audit and
are intentionally NOT encoded here (SPEC §14.5: extend incrementally with
evidence, do not write "two rules" as "the whole world").

## C2 build order (workflow-encoded)

`install-layout` before `host-runtime` (types), `host-runtime` before
`codex-adapter`/`pd-cli`, `principles-disciple` before `pd-cli` (types) and
before the installer (`bundle-plugin.mjs`), installer before `pd-console`
(dist types). The publish train's step sequence IS the dependency order;
skipped (already-published) packages do not break it.

## C6 note: bundle reproducibility

`bundle-plugin.mjs` stamps bundled payload versions. In release-cohort
builds it preserves SOURCE versions (`PD_BUNDLE_PRESERVE_SOURCE_VERSIONS=1`)
so the artifact's component identity equals the cohort's committed versions;
the registry-`latest` stamping path remains only for non-cohort (dev) flows.
