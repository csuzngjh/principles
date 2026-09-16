# Install-Side Trust Root Provisioning Contract

**Status:** Implemented by PRI-732
**Applies to:** `packages/create-principles-disciple/src/update/trust-root-provisioning.ts`, `packages/create-principles-disciple/trust/root.json`, `packages/create-principles-disciple/scripts/generate-trust-root.mjs`, `packages/create-principles-disciple/scripts/publish-release-metadata.mjs`, `packages/create-principles-disciple/scripts/bundle-plugin.mjs`
**Read-side counterpart:** `docs/architecture/PRI-727-release-metadata-publishing.md`, `docs/architecture/PRI-709-release-metadata-source-contract.md`
**Date:** 2026-09-15

---

## 1. Problem

The ReleaseManager verifies signed release metadata through tuf-js, which
requires a pinned trust anchor (`trust/root.json`) in the installation's
trust directory before any refresh. Before PRI-732 no production component
wrote that anchor — only test fixtures did. Every real install therefore
degraded at `metadata_refresh_failed` back to the legacy updater even with a
configured metadata source, and the live machine did not even have a `trust/`
directory.

## 2. Supply chain (single production writer)

```text
ed25519 key ceremony (scripts/generate-trust-root.mjs)
  ├── packages/create-principles-disciple/trust/root.json   (PUBLIC, committed)
  │     ├── npm package ("files": trust/root.json)
  │     └── self-contained release asset (bundle-plugin.mjs copies it to the
  │           payload root; the asset manifest digests it like every payload file)
  └── private key → GitHub secret PD_RELEASE_SIGNING_KEY (NEVER in the repo)
        └── release-metadata.yml publish mode signs publications with it

installer transaction (install(), next to persistReleaseMetadataSource)
  └── provisionBootstrapTrustRoot({ pdHome, payloadRoot })
        payload trust/root.json → strict validation → atomic write
        → <pdHome>/trust/root.json
        → ReleaseManager (tuf-js) refresh / verify
```

- The **official installer transaction is the only production writer** of the
  installation's trust root (this is the boundary `legacy-migration.ts` already
  documents: a product release or the legacy updater may never write the
  bootstrap/trust tier).
- There is deliberately **no environment override**: the payload asset is the
  single supply path. Tests and CI control the anchor by building a payload
  with the trust root they want pinned — the same production mechanism, not a
  second entry point.

## 3. Validation contract (fail loud)

A candidate anchor is persisted only if it passes `validateTrustRoot`:

- valid JSON TUF metadata envelope, `signed._type === "root"`;
- all four roles (`root`, `timestamp`, `snapshot`, `targets`) with threshold
  ≥ 1 and at least one key id;
- every referenced key is carried, is `ed25519`/`ed25519`, and its PEM public
  material parses;
- the root is unexpired;
- the root is validly **self-signed** (its own signatures verify against its
  own root-role keys — a tampered root fails here).

An invalid candidate throws `TrustRootValidationError` and the install
transaction fails (rolling back to the previous runtime) — an install must
never claim success while pinning a broken anchor.

## 4. Persistence semantics

| Installed state | Action |
| --- | --- |
| no anchor | validate + persist atomically (staging file + rename) |
| identical anchor | no-op (idempotent re-install) |
| different anchor | keep the EXISTING anchor, report loudly — replacing a trust anchor is key rotation (separate governance work), never a side effect of re-running an installer |

The pinned anchor and the served repository root **do not need to be
byte-identical**: tuf-js verifies the chain against the pinned root's keys, so
a long-lived pinned root (same key, version 1) verifies publications whose
per-release roots carry shorter expiries (verified against tuf-js 3.1.0).

## 5. Publish-side guard

`verifySigningKeyMatchesPinnedRoot` (release-metadata-publisher.ts) refuses a
real (non-dry-run) publication whose signing key is not authorized for **all
four roles** (`root`, `timestamp`, `snapshot`, `targets`) of the committed
pinned root at **threshold 1**. The current publisher signs every role with the
single key and emits one signature per role, so a key that can merely sign root
would still produce timestamp/snapshot/targets metadata no existing install can
verify — the guard enforces the full threshold-1 publishing contract, not just
the root role. The guard runs in `scripts/publish-release-metadata.mjs` publish
mode; dry-run/ephemeral output is explicitly untrusted and skips it.

## 6. Key ceremony runbook (Owner)

One-time bootstrap:

```bash
cd packages/create-principles-disciple
node scripts/generate-trust-root.mjs \
  --private-key-output <ABSOLUTE_PATH_OUTSIDE_THE_REPOSITORY> \
  --expires 2036-09-15T00:00:00Z
```

1. The script writes the public `trust/root.json` (commit it) and the private
   key to the given path (never inside the repo).
2. Store the private key as the GitHub secret `PD_RELEASE_SIGNING_KEY`
   (Repository Settings → Secrets and variables → Actions).
3. Delete the local private key file.
4. `release-metadata.yml` publish mode now verifies against the pinned root
   (fail-closed without the secret).

**2026-09-15 (this PR):** the ceremony was executed; the committed anchor's
key id is `028c56311eccc4260449f7f9e75c62b45825cd746cd17e7fef0fdd93791e3641`
(expiry 2036-09-15). The private key awaits the Owner's secret upload at
`%USERPROFILE%\.pd-secrets\pd-release-signing-key.private.pem` — delete that
file after storing the secret.

Rotation and offline-root ceremony remain separate governance work (out of
scope; root version stays 1).

## 7. Verification

`packages/create-principles-disciple/tests/trust-root-provisioning.test.ts`:

- validator contract: the full refusal taxonomy (not JSON, wrong type,
  missing role, threshold 0, missing key material, non-ed25519, bad PEM,
  expired, tampered self-signature) and acceptance of the COMMITTED
  production anchor;
- provisioning semantics: fresh pin is byte-identical + atomic; identical
  no-op; different-existing retained; payload without the asset stays
  unconfigured; invalid candidate fails loud with nothing written;
- end-to-end: an anchor provisioned by this module lets the REAL
  ReleaseManager verify a REAL signed publication (different root bytes, same
  key — the committed-anchor shape); an anchor from a different key refuses
  with the trust failure;
- publish guard: key match accepted, mismatch refused, corrupt pinned root
  refused.

The full install-level proof (install() pins the anchor during a real
self-contained install, then a real Console `/apply-full` upgrades through it)
lives in the PRI-671 upgrade gate
(`tests/release-upgrade-gate.test.ts`).
