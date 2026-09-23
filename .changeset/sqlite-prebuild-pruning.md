---
"create-principles-disciple": patch
---

build: prune unused better-sqlite3 platform binaries from release assets

Self-contained release assets now keep only the better-sqlite3 prebuild for
the asset's own platform+arch (linux: musl detected from the build machine,
which is also the target since cross-builds are refused). Foreign-platform
`.node` files are removed from every materialized copy after staging and
before `_release/manifest.json` is generated, so the signed manifest always
describes the pruned tree. Saves ~125 MiB unpacked per platform asset;
installer dependency resolution, package topology and runtime behavior are
unchanged.
