# Release Metadata Source Contract

**Status:** Proposed → implemented by PRI-709 P0-1
**Applies to:** `packages/create-principles-disciple/src/update/release-metadata-source.ts`
**Driving finding:** PRI-698 Phase 0 Architecture Audit, finding F-4
**Date:** 2026-09-08

---

## 1. Problem

PRI-698 Phase 0 Audit established that the ReleaseManager is **NOT READY** to be
the sole mutation authority. One of the three P0 blockers (F-4) is that the
signed release metadata repository had **no source of truth at all**:

- `PD_RELEASE_METADATA_URL` was read directly by three Console call sites
  (`packages/pd-console/src/server/routes/update.ts:1874/1939/2028`).
- No component in the repository ever *supplied* the value: no publishing
  pipeline produces signed metadata, and no install-time state records where it
  would come from.
- Consequence: a ReleaseManager install could only become ready inside the one
  shell that exported the variable. Every other process resolved
  `metadata_source_unconfigured` and fell back to the legacy updater. This is
  the structural reason the ReleaseManager serves **zero** mutations in
  production.

## 2. Scope boundary

This contract is **read-side only**. It answers *"where does signed release
metadata come from?"* It does not:

- publish, sign, mirror or cache release metadata;
- introduce a default/ baked-in metadata URL (that would be guessing, and the
  audit explicitly forbids it);
- change the publishing pipeline (tracked separately — there is currently no
  signed-metadata release step in `.github/workflows/`).

## 3. Resolution order

| Precedence | Tier            | Source                                            | Durability              |
| ---------- | --------------- | ------------------------------------------------- | ----------------------- |
| 1          | `explicit`      | caller-supplied option (Console passes process env) | per-process override    |
| 2          | `env`           | `PD_RELEASE_METADATA_URL`                          | per-shell               |
| 3          | `install_config`| `~/.pd/install.json` → `releaseMetadataUrl`        | **durable per install** |
| 4          | `unconfigured`  | none — `metadataBaseUrl` is `undefined`            | —                       |

`invalid` is a fifth outcome that **short-circuits**: if a candidate source
exists but is not a usable `http(s)` URL, resolution stops there and reports
`detail: '<tier>_url_invalid'`. An operator who misconfigures the override must
see the misconfiguration, not a surprising silent fallback to install state
(ADR-0024 §2.4 — refusal over silent degradation).

### 3.1 Invariants

- **I-1** `metadataBaseUrl === undefined` ⟺ `kind ∈ {invalid, unconfigured}`.
  A resolved source is never a guessed or repaired URL.
- **I-2** `unconfigured` ⇒ the caller's fallback semantics are **unchanged**.
  `createReleaseManagerAuthority` still emits `metadata_source_unconfigured`
  and the Console still routes to the legacy updater.
- **I-3** The value is trimmed but not otherwise transformed — callers receive
  exactly what was configured, so TUF target path construction is unaffected.
- **I-4** Validation accepts only `http:` and `https:`. Anything else
  (`file:`, `ftp:`, bare paths, empty strings) is `invalid`.

## 4. Supply path

The installer is the only component that legitimately knows the metadata
repository at install time, so it persists the value:

`installer.ts → persistReleaseMetadataSource()` runs immediately after
`writeInstallManifest()` and merges `releaseMetadataUrl` into
`~/.pd/install.json` when `PD_RELEASE_METADATA_URL` is set.

- Env absent ⇒ **no-op**. An install with no metadata source stays
  `unconfigured`; nothing is invented.
- Env present but malformed ⇒ **warn and skip**. A malformed URL must never be
  written into `install.json`, where the strict reader would subsequently fail
  loud and mark the whole install `install_state_corrupt`.

## 5. `~/.pd/install.json` is merge-owned

Implementing the durable tier exposed a pre-existing defect that would have
destroyed it: **the file had two writers with disjoint schemas, each
wholesale-clobbering the other.**

| Writer                              | Wrote                                     |
| ----------------------------------- | ----------------------------------------- |
| `installer.ts::writeInstallManifest` | `{layoutVersion, mode, hosts, workspaces}` |
| `install-layout.ts::writeInstallConfig` | `{channel, autoCheck}`                 |
| `uninstaller.ts` (partial uninstall) | `{layoutVersion, mode, hosts}`            |

Evidence from this machine: `~/.pd/install.json` contains only the
installer shape — `channel` / `autoCheck` are already gone, and
`readInstallConfig` silently degrades them to `stable` / `false`. The clobber is
also bidirectional: after a `writeInstallConfig`, `parseInstallManifest` fails
with `install_manifest_unsupported_version` (no `layoutVersion`), so the next
install would throw `install_manifest_malformed`.

**Rule adopted:** every writer of this file merges into the existing record.
`writeInstallConfig` and the new `mergeIntoInstallJson` preserve fields they do
not own; `writeInstallManifest` and the uninstaller write through the merge
helper. A corrupt (unparseable) `install.json` still fails loud — overwriting
state we cannot read would destroy it.

## 6. Observability

`createReleaseManagerAuthority()` now returns `metadataSource` alongside the
readiness matrix. It is purely diagnostic: `metadataBaseUrl === undefined` is
the same condition that produces the `metadata_source_unconfigured` readiness
reason, so no routing behaviour depends on the new field.

## 7. Verification

`packages/create-principles-disciple/tests/release-metadata-source.test.ts`
(14 tests):

- normalization accepts `http(s)` and trims; rejects empty / non-string /
  `file:` / `ftp:` / unparseable;
- resolution order explicit > env > install_config > unconfigured;
- empty override is absent, not an empty URL;
- `invalid` short-circuits instead of falling through;
- `install.json` merge round-trip in both directions, and the merged shape is
  still accepted by the manifest parser;
- a pre-PRI-709 `install.json` without `releaseMetadataUrl` round-trips with the
  field absent (not an empty string);
- a malformed `releaseMetadataUrl` throws `InstallLayoutError('releaseMetadataUrl')`;
- the authority becomes `check`-ready from `install.json` alone with **no
  environment variable set**, and an explicit override still wins;
- a malformed install.json URL yields `install_state_corrupt` +
  `metadata_source_unconfigured`, never a silent fallback.

Regression baseline: the pre-existing 10 failures in
`release-manager*.test.ts` / `legacy-migration.test.ts` are unchanged
(TUF fixture / network timeouts in the local environment), verified by
re-running the same suite against the unmodified base commit.
