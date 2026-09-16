# Release Metadata Publishing Contract

**Status:** Implemented by PRI-727
**Applies to:** `packages/create-principles-disciple/src/update/release-metadata-publisher.ts`, `packages/create-principles-disciple/scripts/publish-release-metadata.mjs`, `.github/workflows/release-metadata.yml`
**Read-side counterpart:** `docs/architecture/PRI-709-release-metadata-source-contract.md`
**Date:** 2026-09-11

---

## 1. Problem

PRI-709 closed the read side of "where does signed release metadata come
from?" and explicitly deferred the write side: no component produced or
published the TUF repository, the signed channel pointer, the release
metadata, or the artifact target that ReleaseManager
(`release-manager.ts` / `trust-metadata.ts` / `apply-payload.ts`) already
consumes. Every real install therefore degraded to
`metadata_source_unconfigured` and the legacy updater.

## 2. What the publisher emits

For one release, exactly the byte set the consumer contract defines (no new
schema, no second release identity — `releaseId` comes from the existing
`deriveReleaseId`/`buildReleaseMetadata`):

| Served path | Content |
| --- | --- |
| `root.json` / `timestamp.json` / `snapshot.json` / `targets.json` | TUF chain, one ed25519 key signs all four roles |
| `targets/channels/<channel>.json` | Channel pointer payload (strict `ChannelMetadata`) |
| `targets/releases/<releaseId>/metadata.json` | Release metadata payload (strict `ReleaseMetadata`) |
| `targets/releases/<releaseId>/release-asset-<platform>-<arch>.tar.gz` | The gzip'd release archive; its sha256 is bound into the release metadata |

The gzip step matters: `build-self-contained-release.mjs` emits an
UNCOMPRESSED `asset.tar` (its `.sha256` sidecar guards those bytes), while
the consumer extracts with `tar xzf` — the publisher wraps deterministically
(Node zlib, no header mtime) and binds the digest of the PUBLISHED bytes.

## 3. Authority and truth

- The published metadata repository is the single publication ledger.
  Monotonic counters (channel `version`, `publicationSequence`, TUF
  metadata versions) are read from it and advanced by one; the publisher
  refuses any non-advancing value, so the workflow cannot move a pointer
  backwards or collide a sequence.
- Re-publishing one `releaseId` is legitimate only as an exact byte-level
  no-op (same pointer content, same TUF versions). Any content change under
  the same releaseId is `publication_conflict` — release metadata is
  immutable after publication.
- The channel pointer is produced only together with the artifact target it
  digests: there is no API shape that advances the pointer without the
  verifiable artifact in the same publication.

## 4. CI pipeline (`release-metadata.yml`, workflow_dispatch)

Three jobs, one publication (PRI-733 multi-platform matrix):

1. `resolve-inputs` (ubuntu): resolve the product version/commit identity
   (fail-closed version guard), read the previously published state from
   `gh-pages`, and derive `publicationSequence`/pointer version (previous + 1)
   and expiry (dispatch input; `auto` = now + 90d with a loud warning that
   reproducible re-publication needs an explicit value). Derived ONCE so the
   channel pointer advances exactly once per publication.
2. `build-asset` (matrix: linux/x64 on ubuntu-latest, win32/x64 on
   windows-latest, darwin/arm64 on macos-latest — Node 24): build the payload
   components (same order as the installer path in `publish-npm.yml`), then
   `build:release-asset` with the SHARED `SOURCE_DATE_EPOCH` from
   resolve-inputs (same source + same epoch + same triple → same bytes).
   Each leg uploads `asset.tar` + `asset.tar.sha256` + `asset-meta.json`
   (`{platform, arch, nodeAbi}` written from the runner's own runtime).
3. `assemble-publish` (ubuntu): download all legs, then
   `publish-release-metadata.mjs --assets-dir` verifies each archive against
   its digest sidecar AND cross-checks the tar's stamped `_release/asset.json`
   against the leg's claimed triple, signs ONCE, and emits the file set.
   Dry-run uploads the publication as a workflow artifact and publishes
   nothing; without the `PD_RELEASE_SIGNING_KEY` secret (held ONLY by this
   job) it signs with an ephemeral key labeled UNTRUSTED (pipeline smoke
   only).
4. Publish mode pushes the tree to `gh-pages` as ONE atomic git commit —
   consumers never observe a channel pointer whose artifact is missing.
   Published releases are preserved (append-and-advance); pruning stale
   releases is a separate bounded cleanup decision, never automatic.

The metadata base URL stays operator-configured
(`PD_RELEASE_METADATA_URL` / `install.json releaseMetadataUrl`). This
pipeline bakes no URL into the product (contract I-1 of the read-side doc).

Same-source determinism note: per-platform `asset.tar` bytes are EXPECTED to
differ across platforms (each tar stamps its own `_release/asset.json`
platform/arch/abi). Determinism means: same (source, epoch, triple) yields
the same bytes, and the same multi-archive inputs re-emit identical
publication bytes (archive order normalized by platform/arch/abi sort).

## 5. Trust material

- One ed25519 key signs the whole repository (the shape the ReleaseManager
  test suite verifies against). The private key lives only in the
  `PD_RELEASE_SIGNING_KEY` GitHub secret.
- Installs pin the matching public `root.json` as the trust anchor. The
  publisher never rotates the root (root version stays 1); rotation and
  offline-root ceremony are separate governance work.

## 6. Verification

`packages/create-principles-disciple/tests/release-metadata-publisher.test.ts`:

- metadata contract: emitted documents pass the same strict consumer
  parsers; missing/invalid inputs fail loud (channel, commit, sequence,
  version, expiry, empty archive, bad key);
- monotonicity & immutability: backward sequence / pointer version refused;
  same-release content mutation refused; corrupt previous state refused;
- determinism: identical inputs re-emit identical bytes (AC2);
- signature: a real TUF client accepts the emitted chain and refuses
  tampered signed metadata (refresh) and tampered served payloads
  (verified download);
- ReleaseManager integration: served publication → pinned root →
  `check()` ready with the published candidate → `downloadReleaseAsset`
  passes the digest cross-check against the manifest.

## 7. Out of scope (owned elsewhere / follow-up)

- Install-side provisioning of `~/.pd/trust/root.json` (the pinned trust
  anchor) — separate production precondition, tracked on Linear.
- Multi-platform release assets: DONE by PRI-733 (one publication covers
  linux/x64, win32/x64, darwin/arm64 on Node 24; `archives[]` input,
  per-platform bytes-vs-sidecar verification plus tar-stamp cross-check).
  Follow-ups: darwin/x64 + linux/arm64 legs, Node 22/26 ABI legs (requires
  artifact path naming that includes the ABI — `release-asset-<platform>-<arch>`
  collides across ABIs — plus the consumer `releaseAssetTargetPath` change).
- Key rotation, offline root ceremony, publishing approval UI.
- Stale-release pruning in the metadata repository.
