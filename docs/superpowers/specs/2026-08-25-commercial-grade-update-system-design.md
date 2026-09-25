# Commercial-Grade PD Update System Design

**Version:** 0.3

**Date:** 2026-09-19 (v0.3 amendments) / 2026-08-25 (v0.2 base)

**Status:** Approved direction; v0.3 amendments approved by Owner together with the 2026-09-19 update-chain remediation blueprint (PRI-847/848/849/850/851/852/853/854); integrated text awaiting final Owner review
**Supersedes:** v0.2 (2026-08-25); v0.1 in commit `fd8f83ec`

### 0. v0.3 amendment summary (2026-09-19)

Field evidence from the first real signed publication (2026-09-19, PRI-847) and the
update-chain audit (docs/audit/update-chain-expert-brief-20260919.md) resolved five
open points without changing the trust chain, atomicity, or rollback promises:

1. **§6.1** — bootstrap semantics made concrete: `bootstrapVersion` is the version of
   the actually deployed update-executor program; the installer delivers, probes, and
   registers it; registration absence/corruption/identity mismatch are distinct
   refusal reasons, never collapsed into "too old".
2. **§7 / §19-3** — supported runtime matrix resolved: assets are keyed by
   OS + CPU + Node-ABI; the matrix is Node 22 (ABI 127), Node 24 (ABI 137) and
   Node 26 (ABI 147), extended only by build-and-test evidence.
3. **§12** — version authority table fixed: the product version of a build is a
   one-time release-flow input; signed metadata, the channel pointer, the confirmed
   active record, and the running process identity are the only per-stage authorities.
   Releases never borrow a version from an npm package's `latest` tag.
4. **§12.1 (new)** — Owner-facing update state contract: ten explicit states with
   non-negotiable mapping rules (a policy refusal is never "up to date"; `no_update`
   is never "success"; a network failure is never "no new version"; deployed is not
   running; an unverifiable recovery is never "old version healthy").
5. **§10 / §13** — compatibility declarations require evidence (no decorative
   constants); publication is complete only when the public metadata URL is reachable
   and Owner-facing release notes bound to the releaseId exist; expiry maintenance is
   a new monotonic maintenance publication, never an in-place date edit.

## 1. Outcome

PD must expose one trustworthy product version and perform updates as recoverable transactions. Companion, Console, CLI, plugin, and installer must never report incompatible meanings for “current version” or write into one another's installation trees.

The system succeeds when an interrupted or failed update leaves either the last confirmed release or the new confirmed release active. A half-installed hybrid must never become active.

This is an MVP reliability repair, not a general deployment platform. It directly reduces the Owner's loss of control and distrust caused by unexplained downgrades, mixed versions, and repeated reinstalls.

## 2. Scope and MVP Gate

### 2.1 Why this cannot be skipped

Without this work, reinstalling a development checkout can overwrite a newer installed release, update history can mislabel installs as rollbacks, and `pd --version` can disagree with Console. These failures undermine the product's basic credibility and will recur within 30 days.

### 2.2 How the Owner observes success

- Console shows the active product release, channel, installation source, health, and last transaction.
- `pd --version` prints the canonical product version.
- `pd version --json` returns component, bootstrap, release, source, and health details.
- Update history distinguishes update, reinstall, migration, rollback, refusal, and recovery.

### 2.3 How it is disabled

The Console entry is registered as MVP-Quiet and can be hidden through `.pd/config.yaml`. Automatic checks and the selected channel live in the installation-level file `~/.pd/install.json`.

Signature verification, path ownership, downgrade prevention, and transaction recovery are safety invariants. Workspace feature flags cannot disable them.

### 2.4 Emotional value

The design converts “I do not know what is installed” into clarity, “an update may break my environment” into control, and “I must reinstall again” into confidence that PD can recover by itself.

## 3. Chosen Architecture

Use signed immutable releases, a stable install-owned bootstrap, a deep `ReleaseManager` module, self-contained platform assets, and dual-slot activation with automatic recovery.

Do not retain the current overlay model. In-place `npm install`, copying a development checkout over an installation, and treating plugin package versions as product versions remain prohibited.

This design avoids a permanent updater daemon in the first implementation. Companion, Console, or the installer invokes the short-lived bootstrap process when an update operation is required.

## 4. Canonical Identity and Trust Chain

### 4.1 Identity types

The product has one public `productVersion`, such as `1.221.2`. Component package versions are diagnostic details and may differ only when the release manifest explicitly declares the combination compatible.

Every build also has an immutable `releaseId`, derived from product version, source commit, platform asset identity, and release metadata digest. A release ID never changes after publication.

### 4.2 Metadata layers

The metadata model separates mutable channel selection from immutable release identity:

```text
Signed Channel Metadata
    -> Immutable Signed Release Metadata
        -> Self-contained OS / CPU / Node-ABI Asset
            -> In-archive Component Manifest
```

Signed Channel Metadata maps `stable` or `candidate` to a release metadata digest. Promotion changes only this signed pointer; it never rebuilds or mutates the release.

Signed Release Metadata records product version, release ID, source commit, asset digests, supported platforms, minimum bootstrap version, compatibility constraints, and publication sequence.

The in-archive manifest records component files and digests. It does not contain the digest of its own archive. The detached Release Metadata owns the whole-asset digest, eliminating circular hashing.

### 4.3 Trust rules

Use a standard TUF-compatible signed-metadata model rather than inventing a cryptographic protocol. The implementation must support trusted-root rotation, expiry, monotonic metadata versions, and rollback and freeze-attack protection.

Channel Metadata references the exact Release Metadata digest. Release Metadata references the exact asset digest. Activation is forbidden unless the complete chain validates against the installation's trusted root.

Informational build time is signed metadata, not an input that changes content identity. Reproducible builds use a fixed `SOURCE_DATE_EPOCH` and must produce byte-identical assets from the same source and toolchain.

## 5. Installation Ownership and Layout

Production installation state lives outside source worktrees:

```text
~/.pd/
  bootstrap/
  install.json
  trust/
  channels/
  releases/<release-id>/
  staging/<transaction-id>/
  transactions/<transaction-id>.json
  active.json
  logs/
```

`bootstrap/` and trust roots are installer-owned. A product release cannot overwrite the bootstrap that is currently coordinating its activation.

`releases/` and `staging/` must be on the same volume so final directory moves can be atomic. The stable host shim resolves `active.json` once at process start and loads all runtime components from that single release directory.

The default retention policy keeps the current confirmed release plus one superseded backup set (`runtime.backup.*` / `principles-disciple.backup.*`, trimmed by the installer on each successful apply). Lineage lives in `active.json` itself (`previousReleaseId`) and in `logs/history.jsonl` — there is no `previous.json` pointer (retired by PRI-922; its sole writer was removed on 2026-08-26 because a second pointer enabled fake same-generation rollbacks). Preflight requires space for current, backup, new, and staging data before any download begins.

## 6. Bootstrap and Deep Module Interface

### 6.1 Bootstrap contract

The official installer places a small stable bootstrap at `~/.pd/bootstrap`. Companion, Console, and installer invoke it through one strict JSON process protocol.

`bootstrapVersion` is the version of the **actually deployed update-executor program** — the short-lived process that hosts ReleaseManager operations (`inspect` / `check` / `apply`) so an update survives the death of whichever UI started it. It is never borrowed from an installer, plugin, or CLI npm version, and never filled with a placeholder value to pass a gate.

Delivery and registration are one installer transaction:

1. Verify the candidate bootstrap's identity and integrity.
2. Stage it with its dependencies under the transaction directory.
3. Start it with the real runtime and verify entrypoint, protocol round-trip, and required capabilities.
4. Activate it under the installation lock and transaction journal.
5. Write `~/.pd/bootstrap/bootstrap.json` describing the deployed executor (`bootstrapVersion`, identity digest, `installedAt`). The registration must be re-verifiable against the deployed bytes.
6. Retain the previous bootstrap until the new one is confirmed; record the outcome.

Registration failures are distinct observable refusals — `bootstrap_not_registered` (file absent), `bootstrap_manifest_corrupt` (unreadable), `bootstrap_identity_mismatch` (registration disagrees with deployed bytes) — and are never reported as "bootstrap too old".

Each release declares `minBootstrapVersion` from a real requirement: the oldest executor version that provides the capabilities this release's update path actually uses. An installed bootstrap older than that refuses the update before mutation with an official-installer next action.

Bootstrap replacement is a separate installer transaction. A product release cannot silently self-upgrade the bootstrap or trusted root. Ordinary product updates must not overwrite a bootstrap that is currently coordinating their own activation.

### 6.2 ReleaseManager

The source of truth lives in `packages/create-principles-disciple/src/update/`, avoiding another shallow package. Its external API is intentionally small:

```ts
interface ReleaseManager {
  inspect(): Promise<InstallStatus>;
  check(channel: ReleaseChannel): Promise<UpdateCheck>;
  apply(releaseId: string): Promise<UpdateResult>;
  rollback(): Promise<RollbackResult>;
}
```

Recovery is automatic at the start of every invocation and is not a public operation. The module hides metadata validation, download, extraction, staging, probes, platform activation, journaling, host control, rollback, and cleanup.

All JSON-mode responses are exactly one parseable object on stdout. Refusals and failures include a stable reason code and an Owner-visible next action. Diagnostic logs go to files or stderr, never mixed into JSON stdout.

## 7. Self-Contained Release Assets

The release pipeline produces assets per supported OS, CPU architecture, and Node ABI. Each asset contains bundled JavaScript dependencies and prebuilt native dependencies required by that target.

The Owner's machine performs no dependency resolution, `npm install`, lifecycle script, compilation, or network fetch beyond downloading signed PD assets and metadata.

The updater only validates, downloads, verifies, extracts, probes, and activates. Unsupported platform or ABI combinations fail before mutation with an installer or compatibility next action.

**Supported runtime matrix (resolved v0.3):** an asset is keyed by the complete triple `platform + arch + nodeAbi`; the published metadata may carry several assets for one platform. The supported matrix is Node 22 (ABI 127), Node 24 (ABI 137) and Node 26 (ABI 147) on the platforms the build matrix covers. The axis must at minimum cover the declared engine floor — `engines.node` is `>= 22`, the same floor better-sqlite3 declares — because a published platform that omits an ABI leaves every host on that runtime unupdateable: `selectReleaseAsset` refuses with `runtime_not_supported` at apply time while `check()` still reports the update as allowed. The matrix grows or shrinks only with build-and-test evidence, never with open-ended range claims. Asset file names embed the ABI so two runtimes on one platform cannot collide. The update path detects the runtimes actually in use by the Console, the bootstrap, and enabled hosts before selecting an asset, and selects per process.

## 8. Transaction and Atomic Activation

An update follows a persisted state machine:

```text
planned -> downloaded -> verified -> staged -> probed
        -> activated -> host_verified -> confirmed
        -> rolled_back | refused | failed
```

Every transition is appended to the transaction journal before the next side effect. On every invocation, `ReleaseManager` reconciles unfinished transactions before accepting a new operation.

Activation writes a new active record to a temporary file, flushes file contents, atomically replaces `active.json`, flushes the containing directory where supported, and rereads the record before host restart.

The active record contains a monotonically increasing generation, release ID, Release Metadata digest, previous release ID, and transaction ID. Platform adapters implement Windows and POSIX replacement semantics and document durability limitations.

Atomicity means readers see either the old or new record. Durability means the selected record survives a crash. Both are tested separately; the design does not claim that rename alone guarantees durable storage.

If `active.json` is corrupt, recovery selects the last journal-confirmed generation and validates its release digest. It never guesses based only on directory names or modification times.

Cleanup ordering (v0.3): superseded runtime material is removed only after the new release is confirmed and the retained previous release is intact. Until confirmation, every backup and staged artifact stays in place — any crash point must leave enough state to continue, roll back, or refuse explicitly, and the journal is the authority on which of the three applies.

## 9. Preflight, Probes, and Host Coordination

Preflight verifies trust metadata, downgrade policy, bootstrap compatibility, platform support, free space, path ownership, release conflicts, and data compatibility before installation state is mutated.

Staged probes verify archive containment, manifest digests, module resolution, entrypoint loading, configuration parsing, and a deterministic startup handshake without touching active user data.

The transaction records which hosts were running before activation. Only those hosts must restart and complete the handshake. Hosts that were already stopped are not treated as failures.

There is one global active release per installation. If any previously running host cannot start the same release, all affected hosts return to the prior release to avoid split-brain component combinations.

Network unavailability, empty business data, and unrelated external-service failure do not trigger automatic rollback. Only deterministic failures attributable to the new release qualify.

At most one automatic rollback is allowed per transaction. A second failure opens a circuit breaker, leaves the last confirmed release active, and requires an explicit Owner action.

## 10. Data and Configuration Compatibility

Code rollback and data compatibility are separate release properties. A release is automatically eligible only when its schema changes are backward-readable by the retained previous release.

Ordinary releases use expand-migrate-contract. The update first adds compatible structures, migrates lazily or idempotently, and postpones destructive contraction until no retained release depends on the old representation.

Compatibility is proven by tests that open new data with the previous supported release. A database backup is diagnostic protection, not an automatic rollback mechanism, because restoring it could delete Owner data created after activation.

Destructive or contract migrations require a separate explicit maintenance workflow with export, confirmation, recovery instructions, and a declared point after which code rollback is unavailable. They cannot pass through ordinary automatic update.

Configuration readers must tolerate fields written by the new and previous release within the supported window. Required incompatible configuration changes refuse activation before host restart.

Compatibility declarations carry evidence (v0.3): a release's compatibility window names the actual previous release(s) the window was proven against by tests that open newly written data with them. A constant that predates every real release, or a value repeated by default, is not evidence and must not appear in signed metadata. Declared destructive migrations refuse ordinary updates and require the separate maintenance workflow to actually exist; a refusal must never point the Owner at an unimplemented procedure.

## 11. Development Isolation and External Modification

Development commands operate only inside the selected checkout unless an explicit guarded production-install command is used. Repository package versions cannot determine or overwrite the active installed product release.

Any command targeting `~/.pd` prints the resolved target, current release, intended release, source, and operation type. Non-interactive mutation requires an explicit confirmation flag and still enforces trust and downgrade rules.

Health diagnostics distinguish three cases: harmless residual files outside the signed manifest, a manifest mismatch inside an inactive release, and corruption of the active release.

Before marking a release unhealthy, diagnostics recalculate the relevant digest. Active corruption blocks restart into that release and recovers to a journal-confirmed valid generation when available.

## 12. Owner Experience and History Semantics

Console's primary version is always the canonical product version. Component and bootstrap versions appear under diagnostics, not as competing “current versions.”

**Version authority (v0.3):** each stage has exactly one authority, and no stage borrows a version from another:

| Fact | Authority |
| --- | --- |
| Product version of a build | One-time input fixed by the release flow before any build; all build legs consume the same value and source commit |
| What a published release contains | Immutable signed release metadata |
| Newest stable version | The signed stable channel pointer |
| Currently installed version | The active release record of the last confirmed transaction |
| Version actually running in a process | The release identity that process loaded (used for post-restart verification) |
| Component package versions | Diagnostics in the release manifest |

Constraints: a release never borrows its product version from an npm package's `latest`; npm sub-package publication success does not mean a new PD stable version exists; one formal product version cannot map to two different contents — changed content publishes a new version; repair-only installer deliveries must not change the installed product version, and if a delivery actually replaces the product it is a reinstall/migration carrying the new artifact's real identity. Historical installs whose identity is insufficient are marked "historical install, migration required" instead of guessing a version from a stale manifest.

`pd --version` preserves a short stable text contract. `pd version --json` exposes `productVersion`, `releaseId`, `components`, `bootstrapVersion`, `channel`, `source`, `generation`, `health`, and last transaction.

History events use explicit kinds: `update`, `reinstall`, `channel_promotion`, `legacy_migration`, `rollback`, `refusal`, and `recovery`. Direction is derived from canonical release identity and metadata sequence, not package.json values found in a checkout.

Every failed or refused event states what happened, whether the previous release remains active, and the safest next action. Raw stack traces are available in diagnostics but are not the primary Owner message.

### 12.1 Owner-facing update state contract (v0.3)

The update surface reports one explicit state at all times. At minimum:

| State | Owner-facing meaning |
| --- | --- |
| checking | Checking for updates |
| up_to_date | PD is on the newest stable version |
| update_available | A new version exists; notes can be shown; update can start |
| update_blocked | A new version exists but a specific problem must be resolved first |
| check_failed | Cannot currently tell whether an update exists; retry possible |
| update_in_progress | The update is running; actual phase shown |
| awaiting_restart_or_verification | New version deployed; switch/verification pending |
| update_complete | The target version is confirmed running |
| failed_and_recovered | Update did not complete; previous version restored and verified |
| needs_recovery | Automatic recovery could not be proven; exact next step provided |

Non-negotiable mappings: a policy refusal never renders as "up to date"; `no_update` never renders as "update succeeded"; a network or availability failure never renders as "no new version"; a completed deployment is not "the new version is running" until verified; recovery that cannot be verified never renders as "old version healthy". The API carries structured reason codes, target version, transaction id, and next action; the page localizes from reason codes and never parses English error strings. Starting an update returns a queryable transaction id; repeated clicks, refreshes, and disconnects attach to the same unfinished operation instead of starting duplicates. The confirmed target release is pinned at start: if the channel pointer moves during an update, the running update is not silently redirected to different content.

## 13. Release and Promotion Pipeline

The pipeline performs these gated steps:

1. Verify source cleanliness, version declaration, and tag-to-commit identity.
2. Build self-contained platform assets in pinned toolchains.
3. Rebuild and compare bytes for reproducibility.
4. Generate component manifests and detached Release Metadata.
5. Sign metadata and publish assets by immutable digest.
6. Install into clean machines and run upgrade and rollback matrices.
7. Promote by updating signed Channel Metadata only.

The pipeline rejects mismatched component identities, non-reproducible assets, missing compatibility evidence, expired metadata, unsupported bootstrap requirements, and any attempt to replace an immutable release.

Publication gates (v0.3): a publication reports "complete" only after the public metadata URL serves the new channel pointer (an unreachable hosting surface — e.g. GitHub Pages not enabled — fails the run, because a successful push alone is not a publication); Owner-facing release notes exist and are bound to the releaseId as part of the signed publication; a clean-machine install leg passes without test-seeded state; concurrent publications coordinate serially on the channel, and a failed run retries with the same original inputs — never a re-resolved version or a fresh registry lookup.

Release publication and channel promotion are separate permissions. Compromising a promotion credential must not permit rewriting an already published asset.

## 14. Verification Strategy

### 14.1 Contract tests

- One canonical version across CLI, Console, Companion, and manifest.
- Strict JSON stdout and stable reason codes.
- Previous-release compatibility with newly written data.
- Real command-parser tests for confirmation and negated flags.

### 14.2 Security tests

- Reject bad signatures, expired metadata, older metadata sequence, digest mismatch, path traversal, symlink escape, and unsupported target identity.
- Verify trusted-root rotation and freeze/rollback protection.
- Prove workspace flags cannot bypass installation safety invariants.

### 14.3 Transaction tests

Inject process termination or power-loss simulation after every state transition and active-record write step. On restart, the result must be old confirmed, new confirmed, or an explicit safe refusal—never a hybrid.

Test Windows and POSIX adapters independently. Verify pointer atomicity, journal recovery, corrupt-pointer recovery, single automatic rollback, circuit breaker behavior, and multi-host rollback without split brain.

### 14.4 Release tests

Use clean-machine fixtures for every supported platform and ABI. Verify no package manager or build tool is required, assets are reproducible, and retained-release disk requirements are calculated before download.

BDD scenarios cover check, apply, reinstall, refusal, interrupted recovery, rollback, legacy migration, version display, and history classification. Observable outcomes cannot be weakened to make implementation pass.

## 15. Delivery Sequence

### Phase 0 — Immediate development guard

Block accidental writes from a checkout into `~/.pd`. Correct version display and history classification where they can be fixed without changing installation layout.

### Phase 1 — Immutable signed identity

Define canonical version, Release Metadata, Channel Metadata, trust-root handling, signature verification, expiry, and monotonic sequence rules.

### Phase 2 — Self-contained assets

Produce and verify per-target assets. Remove user-machine dependency installation from the supported update path.

### Phase 3 — Bootstrap and ReleaseManager shadow mode

Install the stable bootstrap and deep module. Run inspect, check, verification, and probes without activation. Compare decisions with the existing updater and collect diagnostics.

### Phase 4 — Dual-slot activation and recovery

Enable journaled staging, atomic generations, host coordination, automatic recovery, one rollback, and the circuit breaker behind a quiet Console surface flag.

### Phase 5 — Official legacy migration

Use one official installer transaction to migrate an existing overlay installation into bootstrap plus dual-slot layout. The legacy updater is not trusted to transform itself in place.

### Phase 6 — Product cutover

Route Companion and Console through the same bootstrap protocol, disable overlay writes, expose the stable UI, and retain only read-only legacy diagnostics for a bounded period.

Each phase has a separate go/no-go gate. Failure disables its surface or restores the prior confirmed release without weakening signature, ownership, or downgrade protections.

## 16. Error-Pattern Controls

This design explicitly addresses the following recurring classes:

- **ERR-041:** one release identity and one build output prevent runtime/build-source drift.
- **ERR-042:** bootstrap ownership and host-neutral paths prevent installation-tree coupling.
- **ERR-083:** version, source, release, and transaction are separate facts; no heuristic history labels.
- **ERR-090:** path and platform behavior are tested through Windows and POSIX adapters.
- **ERR-097:** generated metadata is validated through the same production loader used at runtime.

Untrusted metadata remains `unknown` until runtime validation. Required fields fail loudly, array elements are validated, own-property checks are used, serialization is bounded, and every fallback emits a structured reason.

## 17. Non-Goals

- General software deployment orchestration.
- Multiple simultaneous active PD releases in one installation.
- Silent database downgrade or destructive migration rollback.
- Background daemon management in the first implementation.
- Allowing workspace configuration to weaken installation trust.
- Refactoring unrelated PD runtime or governance subsystems.

## 18. Acceptance Criteria

The revised design is implemented only when all of the following are demonstrably true:

1. Every public surface reports the same canonical product release.
2. A source checkout cannot silently mutate a production installation.
3. Assets are signed, immutable, self-contained, and reproducible.
4. An interruption at every transaction boundary recovers without a hybrid release.
5. A failed deterministic health check restores the previous confirmed release at most once.
6. Ordinary updates preserve code rollback through proven backward-readable data changes.
7. Unsupported bootstrap, platform, disk, trust, or data states refuse before activation.
8. Promotion changes signed channel metadata without rebuilding the release.
9. The official installer can migrate a supported legacy installation into the new layout.
10. Console and CLI explain the current state and next action without requiring technical interpretation.

## 19. Remaining Decisions Before Implementation Planning

The architecture is fixed, but the implementation plan must resolve three evidence-based choices without changing these contracts:

1. Select the TUF-compatible metadata library after a maintenance, platform, and auditability spike.
2. Prove the exact Windows file-replacement and directory-flush adapter on supported filesystems.
3. ~~Inventory native dependencies and define the supported OS, CPU, and Node-ABI release matrix.~~ **Resolved v0.3:** see §7 — assets keyed by `platform + arch + nodeAbi`; matrix Node 22 (ABI 127) + Node 24 (ABI 137) + Node 26 (ABI 147); growth only with build-and-test evidence.

If any spike disproves a contract above, return to Owner review before implementation. Do not silently weaken the trust chain, atomicity guarantee, or rollback promise.
